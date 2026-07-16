#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  atomicWriteJson,
  COMPLETED_JOB_RETENTION_MS,
  createPrivateJobDirectory,
  ensurePrivateDirectory,
  fileProgress,
  isAuthenticationError,
  JOB_DIR,
  JOB_ID_PATTERN,
  jobPaths,
  MAX_CONCURRENT_JOBS,
  MAX_QUESTION_CHARS,
  parseClaudeStream,
  questionDigest,
  readJson,
  streamSummary,
  SUPPORTED_MODELS,
  validateWorkspace,
} from "./lib.mjs";

const SERVER_NAME = "claude-ask";
const SERVER_VERSION = "0.3.0";
const RUNNER_PATH = fileURLToPath(new URL("./job-runner.mjs", import.meta.url));
const TERMINAL_STATUSES = new Set(["completed", "error", "cancelled"]);

ensurePrivateDirectory(JOB_DIR);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message, data) {
  const payload = { code, message };
  if (data !== undefined) payload.data = data;
  send({ jsonrpc: "2.0", id, error: payload });
}

function toolError(message, structuredContent = null) {
  return {
    content: [{ type: "text", text: message }],
    structuredContent,
    isError: true,
  };
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function jobPathById(jobId) {
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) return null;
  const path = join(JOB_DIR, jobId);
  return existsSync(path) ? path : null;
}

function recoverOrphanedJob(jobPath, state) {
  if (TERMINAL_STATUSES.has(state.status)) return state;
  if (state.status === "starting" && processExists(state.launcherPid)) {
    return state;
  }
  if (processExists(state.runnerPid)) return state;

  const paths = jobPaths(jobPath);
  if (existsSync(paths.cancel)) {
    const recovered = {
      ...state,
      status: "cancelled",
      completedAt: Date.now(),
      recoveredAfterRestart: true,
    };
    atomicWriteJson(paths.state, recovered);
    return recovered;
  }

  try {
    const parsed = parseClaudeStream(readFileSync(paths.stream, "utf8"));
    if (!parsed.event?.is_error) {
      parsed.result.requested_model = state.model;
      atomicWriteJson(paths.result, parsed.result);
      const recovered = {
        ...state,
        status: "completed",
        completedAt: Date.now(),
        recoveredAfterRestart: true,
      };
      atomicWriteJson(paths.state, recovered);
      return recovered;
    }
    const recovered = {
      ...state,
      status: "error",
      errorCode: isAuthenticationError(parsed.event)
        ? "authentication_failed"
        : "claude_failed",
      completedAt: Date.now(),
      recoveredAfterRestart: true,
    };
    atomicWriteJson(paths.state, recovered);
    return recovered;
  } catch {
    const recovered = {
      ...state,
      status: "error",
      errorCode: "runner_interrupted",
      completedAt: Date.now(),
      recoveredAfterRestart: true,
    };
    atomicWriteJson(paths.state, recovered);
    return recovered;
  }
}

function loadJob(jobId) {
  const path = jobPathById(jobId);
  if (!path) return null;
  try {
    const state = recoverOrphanedJob(path, readJson(jobPaths(path).state));
    return { path, paths: jobPaths(path), state };
  } catch {
    return null;
  }
}

function runningJobCount() {
  let count = 0;
  for (const entry of readdirSync(JOB_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !JOB_ID_PATTERN.test(entry.name)) continue;
    const job = loadJob(entry.name);
    if (job && !TERMINAL_STATUSES.has(job.state.status)) count += 1;
  }
  return count;
}

function cleanupExpiredJobs() {
  const cutoff = Date.now() - COMPLETED_JOB_RETENTION_MS;
  for (const entry of readdirSync(JOB_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !JOB_ID_PATTERN.test(entry.name)) continue;
    const job = loadJob(entry.name);
    if (!job || !TERMINAL_STATUSES.has(job.state.status)) continue;
    if ((job.state.completedAt || Date.now()) >= cutoff) continue;
    rmSync(job.path, { recursive: true, force: true });
  }
}

async function startClaudeJob(question, model, workspace) {
  if (runningJobCount() >= MAX_CONCURRENT_JOBS) {
    return toolError(
      `Claude Ask already has ${MAX_CONCURRENT_JOBS} concurrent jobs. ` +
        "Wait for one to finish or cancel one explicitly.",
    );
  }

  const job = createPrivateJobDirectory();
  const paths = jobPaths(job.path);
  const startedAt = Date.now();
  const questionBytes = Buffer.byteLength(question, "utf8");
  const digest = questionDigest(question);
  atomicWriteJson(paths.state, {
    id: job.id,
    model,
    status: "starting",
    startedAt,
    completedAt: null,
    runnerPid: null,
    claudePid: null,
    launcherPid: process.pid,
    workspace,
  });

  const runner = spawn(
    process.execPath,
    [RUNNER_PATH, job.path, job.id, model],
    {
      cwd: job.path,
      env: process.env,
      detached: true,
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
    },
  );
  await new Promise((resolve, reject) => {
    runner.once("error", reject);
    runner.stdin.once("error", reject);
    runner.stdin.cork();
    runner.stdin.write(
      `${JSON.stringify({ bytes: questionBytes, digest, workspace })}\n`,
    );
    runner.stdin.end(question, "utf8", resolve);
  }).catch((spawnError) => {
    atomicWriteJson(paths.state, {
      ...readJson(paths.state),
      status: "error",
      completedAt: Date.now(),
      errorCode: "runner_spawn_failed",
    });
    throw spawnError;
  });
  runner.unref();

  const loaded = loadJob(job.id);
  return TERMINAL_STATUSES.has(loaded.state.status)
    ? finalJobResult(loaded)
    : runningResult(loaded, 0);
}

function progressFor(job) {
  return fileProgress(job.paths.stream, job.state.startedAt);
}

function waitForProgress(job, initialBytes, waitMs) {
  if (
    waitMs <= 0 ||
    TERMINAL_STATUSES.has(job.state.status) ||
    progressFor(job).bytes > initialBytes
  ) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const current = loadJob(job.state.id);
      if (
        !current ||
        TERMINAL_STATUSES.has(current.state.status) ||
        progressFor(current).bytes > initialBytes ||
        Date.now() - started >= waitMs
      ) {
        clearInterval(timer);
        resolve();
      }
    }, Math.min(200, Math.max(25, waitMs)));
  });
}

function runningResult(job, previousBytes = 0) {
  const progressState = progressFor(job);
  const deltaBytes = Math.max(0, progressState.bytes - previousBytes);
  const progress = deltaBytes > 0 ? "growing" : "waiting";
  const summary = streamSummary(job.paths.stream);
  const structuredContent = {
    job_id: job.state.id,
    status: job.state.status === "starting" ? "running" : job.state.status,
    progress,
    output_bytes: progressState.bytes,
    delta_bytes: deltaBytes,
    last_growth_ms_ago: Math.max(0, Date.now() - progressState.lastGrowthAt),
    started_at: new Date(job.state.startedAt).toISOString(),
    workspace: job.state.workspace || null,
    ...summary,
  };
  return {
    content: [
      {
        type: "text",
        text:
          `Claude job ${job.state.id} is still running; progress=${progress}; ` +
          `output_bytes=${progressState.bytes}; delta_bytes=${deltaBytes}; ` +
          `stream_events=${summary.json_events}.`,
      },
    ],
    structuredContent,
    isError: false,
  };
}

function errorMessage(errorCode) {
  const messages = {
    authentication_failed:
      "Claude Code authentication was rejected. Run `claude auth login`, then try again.",
    claude_failed: "Claude Code returned an error.",
    invalid_stream: "Claude Code ended without a valid final stream result.",
    output_limit_exceeded: "Claude Code exceeded the output safety limit.",
    prompt_transfer_failed: "Claude Ask could not transfer the complete prompt to its job runner.",
    runner_spawn_failed: "Claude Ask could not start its job runner.",
    spawn_failed: "Claude Ask could not start Claude Code.",
    runner_interrupted:
      "The detached Claude job runner exited before producing a final result.",
    runner_failed: "The detached Claude job runner failed.",
    workspace_invalid: "Claude Ask received an invalid workspace directory.",
  };
  return messages[errorCode] || "Claude job failed.";
}

function finalJobResult(job) {
  const progressState = progressFor(job);
  const base = {
    job_id: job.state.id,
    status: job.state.status,
    output_bytes: progressState.bytes,
    started_at: new Date(job.state.startedAt).toISOString(),
    workspace: job.state.workspace || null,
    completed_at: job.state.completedAt
      ? new Date(job.state.completedAt).toISOString()
      : null,
    recovered_after_restart: Boolean(job.state.recoveredAfterRestart),
  };
  if (job.state.status === "completed") {
    let answer;
    try {
      answer = readJson(job.paths.result);
    } catch {
      return toolError("Claude result file is unavailable.", base);
    }
    return {
      content: [{ type: "text", text: answer.answer }],
      structuredContent: { ...base, ...answer },
      isError: false,
    };
  }
  if (job.state.status === "cancelled") {
    return toolError(`Claude job ${job.state.id} was cancelled.`, base);
  }
  return toolError(errorMessage(job.state.errorCode), base);
}

async function handleToolCall(params) {
  const toolName = params?.name;
  const args = params?.arguments || {};

  if (toolName === "ask") {
    const question = args.question;
    const model = args.model || "fable";
    let workspace;
    if (typeof question !== "string" || question.trim().length === 0) {
      return toolError("`question` must be a non-empty string.");
    }
    if (question.length > MAX_QUESTION_CHARS) {
      return toolError(
        `Question exceeds the ${MAX_QUESTION_CHARS}-character limit.`,
      );
    }
    if (!SUPPORTED_MODELS.has(model)) {
      return toolError("`model` must be `fable` or `opus`.");
    }
    try {
      workspace = validateWorkspace(args.workspace);
    } catch (workspaceError) {
      return toolError(
        workspaceError instanceof Error
          ? workspaceError.message
          : "Invalid workspace path.",
      );
    }
    try {
      return await startClaudeJob(question, model, workspace);
    } catch {
      return toolError("Claude Ask could not start the background job.");
    }
  }

  if (toolName === "ask_status") {
    let job = loadJob(args.job_id);
    if (!job) return toolError("Unknown or expired Claude job ID.");
    const waitMs = Number.isInteger(args.wait_ms)
      ? Math.max(0, Math.min(args.wait_ms, 30_000))
      : 10_000;
    const currentBytes = progressFor(job).bytes;
    const previousBytes = Number.isInteger(args.previous_output_bytes)
      ? Math.max(0, args.previous_output_bytes)
      : currentBytes;
    await waitForProgress(job, previousBytes, waitMs);
    job = loadJob(args.job_id);
    if (!job) return toolError("Claude job expired while checking status.");
    return TERMINAL_STATUSES.has(job.state.status)
      ? finalJobResult(job)
      : runningResult(job, previousBytes);
  }

  if (toolName === "cancel_ask") {
    const job = loadJob(args.job_id);
    if (!job) return toolError("Unknown or expired Claude job ID.");
    if (!TERMINAL_STATUSES.has(job.state.status)) {
      try {
        const fd = openSync(job.paths.cancel, "wx", 0o600);
        chmodSync(job.paths.cancel, 0o600);
        closeSync(fd);
      } catch (error) {
        if (error?.code !== "EEXIST") {
          return toolError("Could not request Claude job cancellation.");
        }
      }
      return {
        content: [
          { type: "text", text: `Cancellation requested for ${job.state.id}.` },
        ],
        structuredContent: { job_id: job.state.id, status: "cancelling" },
        isError: false,
      };
    }
    return finalJobResult(job);
  }

  return toolError(`Unknown tool: ${toolName || "<missing>"}`);
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    result(id, {
      protocolVersion: params?.protocolVersion || "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        "Start Claude with ask, explicitly pass workspace for repository reviews, then poll ask_status until the final answer. Workspace jobs get read-only file discovery tools. Detached jobs survive MCP server restart and have no elapsed/idle deadline; cancellation is explicit.",
    });
    return;
  }

  if (method === "ping") {
    result(id, {});
    return;
  }

  if (method === "tools/list") {
    result(id, {
      tools: [
        {
          name: "ask",
          title: "Ask Claude",
          description:
            "Start a persistent background Claude Code Fable or Opus consultation. Pass an absolute workspace path when Claude should inspect a repository; only Read, Glob, and Grep are enabled for that job. Returns a job ID immediately; poll ask_status. There is no elapsed-time or idle-time deadline.",
          inputSchema: {
            type: "object",
            properties: {
              question: {
                type: "string",
                minLength: 1,
                maxLength: MAX_QUESTION_CHARS,
                description: "Complete question or prompt to send to Claude.",
              },
              model: {
                type: "string",
                enum: ["fable", "opus"],
                default: "fable",
                description: "Claude Code model alias.",
              },
              workspace: {
                type: "string",
                minLength: 1,
                maxLength: 4096,
                description:
                  "Absolute existing workspace directory. Enables read-only Read, Glob, and Grep tools scoped by Claude Code permissions to this directory.",
              },
            },
            required: ["question"],
            additionalProperties: false,
          },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        {
          name: "ask_status",
          title: "Claude Answer Status",
          description:
            "Check a persistent Claude job. Optionally waits up to 30 seconds for its private stream file to grow or finish. An unchanged file never cancels the job.",
          inputSchema: {
            type: "object",
            properties: {
              job_id: { type: "string", minLength: 1 },
              previous_output_bytes: {
                type: "integer",
                minimum: 0,
                description: "output_bytes from the previous status response.",
              },
              wait_ms: {
                type: "integer",
                minimum: 0,
                maximum: 30000,
                default: 10000,
              },
            },
            required: ["job_id"],
            additionalProperties: false,
          },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
        {
          name: "cancel_ask",
          title: "Cancel Claude Answer",
          description:
            "Explicitly cancel a running Claude consultation. Jobs are never cancelled for elapsed or idle time.",
          inputSchema: {
            type: "object",
            properties: {
              job_id: { type: "string", minLength: 1 },
            },
            required: ["job_id"],
            additionalProperties: false,
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
      ],
    });
    return;
  }

  if (method === "tools/call") {
    result(id, await handleToolCall(params));
    return;
  }

  if (id !== undefined) error(id, -32601, "Method not found", method);
}

cleanupExpiredJobs();
const cleanupTimer = setInterval(cleanupExpiredJobs, 60 * 60 * 1000);
cleanupTimer.unref();

let inputBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  let newlineIndex;
  while ((newlineIndex = inputBuffer.indexOf("\n")) >= 0) {
    const line = inputBuffer.slice(0, newlineIndex).trim();
    inputBuffer = inputBuffer.slice(newlineIndex + 1);
    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch (parseError) {
      error(null, -32700, "Parse error", parseError.message);
      continue;
    }
    if (message.id === undefined) continue;
    void handleRequest(message).catch(() => {
      error(message.id, -32603, "Internal error");
    });
  }
});

function shutdown() {
  // Detached job runners intentionally outlive this MCP server process.
  process.exit(0);
}
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
