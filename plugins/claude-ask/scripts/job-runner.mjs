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
  validateBudget,
  validateEffort,
  validateMode,
  validateWorkspace,
} from "./lib.mjs";

const [jobPath, expectedJobId, model, requestedEffort] = process.argv.slice(2);
const paths = jobPaths(jobPath || "");
let child = null;
let childProcessGroupId = null;
let outputFd = null;
let stderrFd = null;
let outputBytes = 0;
let outputTooLarge = false;
let stderrBytes = 0;
let stderrTruncated = false;
let cancelRequested = false;
let shutdownRequested = false;
let spawnError = null;
let completed = false;
let cancelPoll = null;
let stopPromise = null;
const MAX_STDERR_BYTES = 1024 * 1024;
const USE_PROCESS_GROUPS = process.platform !== "win32";
const TERMINATION_GRACE_MS = 5_000;

function writeState(patch) {
  let previous = {};
  try {
    previous = readJson(paths.state);
  } catch {
    // Initial or recoverable partial state; the new atomic state is canonical.
  }
  atomicWriteJson(paths.state, { ...previous, ...patch });
}

function signalChildTree(signal) {
  if (USE_PROCESS_GROUPS && Number.isSafeInteger(childProcessGroupId)) {
    try {
      process.kill(-childProcessGroupId, signal);
      return;
    } catch (error) {
      if (error?.code === "ESRCH") return;
    }
  }
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    // The process may have exited between the state check and the signal.
  }
}

function childTreeExists() {
  if (USE_PROCESS_GROUPS && Number.isSafeInteger(childProcessGroupId)) {
    try {
      process.kill(-childProcessGroupId, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  }
  return Boolean(
    child && child.exitCode === null && child.signalCode === null,
  );
}

async function waitForChildTreeExit(timeoutMs = null) {
  const deadline =
    timeoutMs === null ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
  while (childTreeExists() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !childTreeExists();
}

function requestChildStop() {
  if (!child) return Promise.resolve();
  if (!stopPromise) {
    stopPromise = (async () => {
      signalChildTree("SIGTERM");
      if (await waitForChildTreeExit(TERMINATION_GRACE_MS)) return;
      signalChildTree("SIGKILL");
      await waitForChildTreeExit();
    })();
  }
  return stopPromise;
}

function finishState(status, patch = {}) {
  if (completed) return;
  completed = true;
  if (cancelPoll) clearInterval(cancelPoll);
  safeClose(outputFd);
  outputFd = null;
  safeClose(stderrFd);
  stderrFd = null;
  writeState({
    status,
    completedAt: Date.now(),
    outputBytes,
    stderrTruncated,
    ...patch,
  });
}

async function readPrompt() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function main() {
  if (!jobPath || !expectedJobId || !model || !requestedEffort) process.exit(2);
  const effort = validateEffort(requestedEffort);
  writeState({
    id: expectedJobId,
    model,
    effort,
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
  let mode;
  let maxBudgetUsd;
  let resumeSessionId;
  try {
    workspace = validateWorkspace(transferHeader?.workspace);
    mode = validateMode(transferHeader?.mode, workspace);
    maxBudgetUsd = validateBudget(transferHeader?.maxBudgetUsd);
    resumeSessionId =
      typeof transferHeader?.resumeSessionId === "string" &&
      transferHeader.resumeSessionId.length > 0 &&
      transferHeader.resumeSessionId.length <= 128
        ? transferHeader.resumeSessionId
        : null;
    if (
      transferHeader?.resumeSessionId !== null &&
      transferHeader?.resumeSessionId !== undefined &&
      resumeSessionId === null
    ) {
      throw new Error("Invalid resume session.");
    }
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
  stderrFd = openPrivateFile(paths.stderr);
  const localExecutable = `${homedir()}/.local/bin/claude`;
  const executable =
    process.env.CLAUDE_ASK_CLI ||
    (existsSync(localExecutable) ? localExecutable : "claude");
  const commonArgs = [
    "-p",
    "--model",
    model,
    "--effort",
    effort,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--input-format",
    "text",
  ];
  if (resumeSessionId) {
    commonArgs.push("--resume", resumeSessionId, "--fork-session");
  } else {
    commonArgs.push("--session-id", expectedJobId);
  }
  if (maxBudgetUsd !== null) {
    commonArgs.push("--max-budget-usd", String(maxBudgetUsd));
  }
  const args = mode === "agent"
    ? [
        ...commonArgs,
        "--tools",
        "default",
        "--dangerously-skip-permissions",
        "--append-system-prompt",
        "Treat the current working directory as the task scope. Do not access or modify paths outside it unless the user's request explicitly requires that.",
      ]
    : [
        ...commonArgs,
        "--safe-mode",
        "--disable-slash-commands",
        "--tools",
        mode === "review" ? "Read,Glob,Grep" : "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--allowedTools",
        mode === "review" ? "Read,Glob,Grep" : "",
        "--permission-mode",
        "dontAsk",
      ];
  child = spawn(executable, args, {
    cwd: workspace || jobPath,
    env: mode === "agent"
      ? process.env
      : { ...process.env, CLAUDE_CODE_SAFE_MODE: "1" },
    shell: false,
    detached: USE_PROCESS_GROUPS,
    stdio: ["pipe", "pipe", "pipe"],
  });
  childProcessGroupId = USE_PROCESS_GROUPS ? child.pid || null : null;
  writeState({
    id: expectedJobId,
    model,
    effort,
    status: "running",
    mode,
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
  child.stderr.on("data", (chunk) => {
    if (stderrFd === null || stderrTruncated) return;
    const remaining = MAX_STDERR_BYTES - stderrBytes;
    if (remaining > 0) {
      const value = chunk.subarray(0, remaining);
      writeSync(stderrFd, value);
      stderrBytes += value.length;
    }
    if (chunk.length > remaining) stderrTruncated = true;
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

  child.on("close", async (code, signal) => {
    safeClose(outputFd);
    outputFd = null;
    safeClose(stderrFd);
    stderrFd = null;

    if (cancelRequested || existsSync(paths.cancel)) {
      await requestChildStop();
      finishState("cancelled", { exitCode: code, signal: signal || null });
      return;
    }
    if (shutdownRequested) {
      await requestChildStop();
      finishState("error", {
        errorCode: "runner_interrupted",
        exitCode: code,
        signal: signal || null,
      });
      return;
    }
    if (outputTooLarge) {
      await requestChildStop();
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
    parsed.result.requested_effort = effort;
    atomicWriteJson(paths.result, parsed.result);
    finishState("completed", {
      sessionId: parsed.result.session_id || null,
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
