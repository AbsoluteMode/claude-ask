#!/usr/bin/env node

import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  atomicWriteJson,
  isAuthenticationError,
  jobPaths,
  MAX_OUTPUT_BYTES,
  openPrivateFile,
  parseClaudeStream,
  questionDigest,
  readJson,
  safeClose,
  validateWorkspace,
} from "./lib.mjs";

const [jobPath, expectedJobId, model] = process.argv.slice(2);
const paths = jobPaths(jobPath || "");
let child = null;
let outputFd = null;
let outputBytes = 0;
let outputTooLarge = false;
let cancelRequested = false;
let shutdownRequested = false;
let spawnError = null;
let completed = false;
let cancelPoll = null;
let forceKillTimer = null;

function writeState(patch) {
  let previous = {};
  try {
    previous = readJson(paths.state);
  } catch {
    // Initial or recoverable partial state; the new atomic state is canonical.
  }
  atomicWriteJson(paths.state, { ...previous, ...patch });
}

function requestChildStop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (!forceKillTimer) {
    forceKillTimer = setTimeout(() => {
      if (child?.exitCode === null && child?.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 5_000);
    forceKillTimer.unref();
  }
}

function finishState(status, patch = {}) {
  if (completed) return;
  completed = true;
  if (cancelPoll) clearInterval(cancelPoll);
  if (forceKillTimer) clearTimeout(forceKillTimer);
  safeClose(outputFd);
  outputFd = null;
  writeState({
    status,
    completedAt: Date.now(),
    outputBytes,
    ...patch,
  });
}

async function readPrompt() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function main() {
  if (!jobPath || !expectedJobId || !model) process.exit(2);
  writeState({
    id: expectedJobId,
    model,
    status: "starting",
    runnerPid: process.pid,
  });
  const transferred = await readPrompt();
  if (shutdownRequested) {
    transferred.fill(0);
    finishState("error", { errorCode: "runner_interrupted" });
    return;
  }
  const newline = transferred.indexOf(0x0a);
  let transferHeader;
  try {
    transferHeader = JSON.parse(transferred.subarray(0, newline).toString("utf8"));
  } catch {
    transferred.fill(0);
    finishState("error", { errorCode: "prompt_transfer_failed" });
    return;
  }
  const prompt = transferred.subarray(newline + 1);
  const expectedBytes = Number(transferHeader?.bytes);
  const expectedDigest = transferHeader?.digest;
  let workspace;
  try {
    workspace = validateWorkspace(transferHeader?.workspace);
  } catch {
    transferred.fill(0);
    finishState("error", { errorCode: "workspace_invalid" });
    return;
  }
  const actualDigest = Buffer.from(questionDigest(prompt), "hex");
  const wantedDigest = Buffer.from(
    typeof expectedDigest === "string" ? expectedDigest : "",
    "hex",
  );
  if (
    !Number.isSafeInteger(expectedBytes) ||
    prompt.length !== expectedBytes ||
    actualDigest.length !== wantedDigest.length ||
    !timingSafeEqual(actualDigest, wantedDigest)
  ) {
    transferred.fill(0);
    finishState("error", { errorCode: "prompt_transfer_failed" });
    return;
  }

  if (existsSync(paths.cancel)) {
    cancelRequested = true;
    transferred.fill(0);
    finishState("cancelled");
    return;
  }

  outputFd = openPrivateFile(paths.stream);
  const executable =
    process.env.CLAUDE_ASK_CLI || `${homedir()}/.local/bin/claude`;
  const readOnlyTools = "Read,Glob,Grep";
  const args = [
    "-p",
    "--safe-mode",
    "--disable-slash-commands",
    "--model",
    model,
    "--tools",
    workspace ? readOnlyTools : "",
    ...(workspace ? ["--allowedTools", readOnlyTools] : []),
    "--permission-mode",
    "dontAsk",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--input-format",
    "text",
    "--no-session-persistence",
  ];
  child = spawn(executable, args, {
    cwd: workspace || jobPath,
    env: { ...process.env, CLAUDE_CODE_SAFE_MODE: "1" },
    shell: false,
    stdio: ["pipe", "pipe", "ignore"],
  });
  writeState({
    id: expectedJobId,
    model,
    status: "running",
    runnerPid: process.pid,
    claudePid: child.pid || null,
  });

  child.stdin.on("error", () => {
    // Spawn/close handling below owns the terminal job state.
  });
  child.stdin.end(prompt, () => transferred.fill(0));

  child.stdout.on("data", (chunk) => {
    if (outputFd === null || outputTooLarge) return;
    const remaining = MAX_OUTPUT_BYTES - outputBytes;
    if (remaining > 0) {
      const value = chunk.subarray(0, remaining);
      writeSync(outputFd, value);
      outputBytes += value.length;
    }
    if (chunk.length > remaining) {
      outputTooLarge = true;
      requestChildStop();
    }
  });
  child.on("error", (error) => {
    spawnError = error;
  });

  cancelPoll = setInterval(() => {
    if (!existsSync(paths.cancel)) return;
    cancelRequested = true;
    requestChildStop();
  }, 200);
  cancelPoll.unref();

  child.on("close", (code, signal) => {
    safeClose(outputFd);
    outputFd = null;

    if (cancelRequested || existsSync(paths.cancel)) {
      finishState("cancelled", { exitCode: code, signal: signal || null });
      return;
    }
    if (shutdownRequested) {
      finishState("error", {
        errorCode: "runner_interrupted",
        exitCode: code,
        signal: signal || null,
      });
      return;
    }
    if (outputTooLarge) {
      finishState("error", {
        errorCode: "output_limit_exceeded",
        exitCode: code,
        signal: signal || null,
      });
      return;
    }
    if (spawnError) {
      finishState("error", { errorCode: "spawn_failed" });
      return;
    }

    let parsed;
    try {
      parsed = parseClaudeStream(readFileSync(paths.stream, "utf8"));
    } catch {
      finishState("error", {
        errorCode: "invalid_stream",
        exitCode: code,
        signal: signal || null,
      });
      return;
    }
    if (parsed.event?.is_error || code !== 0) {
      finishState("error", {
        errorCode: isAuthenticationError(parsed.event)
          ? "authentication_failed"
          : "claude_failed",
        exitCode: code,
        signal: signal || null,
      });
      return;
    }

    parsed.result.requested_model = model;
    atomicWriteJson(paths.result, parsed.result);
    finishState("completed", {
      exitCode: code,
      signal: signal || null,
    });
  });
}

process.on("SIGTERM", () => {
  shutdownRequested = true;
  cancelRequested = existsSync(paths.cancel);
  if (child) requestChildStop();
  else process.stdin.destroy();
});
process.on("SIGINT", () => {
  shutdownRequested = true;
  cancelRequested = existsSync(paths.cancel);
  if (child) requestChildStop();
  else process.stdin.destroy();
});

main().catch(() => {
  finishState("error", { errorCode: "runner_failed" });
});
