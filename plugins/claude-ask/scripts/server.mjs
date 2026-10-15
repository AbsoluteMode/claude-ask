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
import { uptime } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  atomicWriteJson,
  COMPLETED_JOB_RETENTION_MS,
  createPrivateJobDirectory,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  ensurePrivateDirectory,
  fileProgress,
  isAuthenticationError,
  JOB_DIR,
  JOB_ID_PATTERN,
  jobPaths,
  MAX_CONCURRENT_JOBS,
  MAX_QUESTION_CHARS,
  MODEL_PATTERN,
  parseClaudeStream,
  questionDigest,
  readJson,
  streamSummary,
  validateBudget,
  validateEffort,
  validateJobName,
  validateModel,
  validateMode,
  validateWorkspace,
} from "./lib.mjs";

const SERVER_NAME = "claude-ask";
const SERVER_VERSION = "0.3.0";
const RUNNER_PATH = fileURLToPath(new URL("./job-runner.mjs", import.meta.url));
const TERMINAL_STATUSES = new Set(["completed", "error", "cancelled"]);
const SERVER_BOOT_STARTED_AT = Date.now() - uptime() * 1_000;
const BOOT_TIME_TOLERANCE_MS = 60_000;
const STARTUP_GRACE_MS = 5_000;

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

function codedToolError(errorCode, message, nextActionText, extra = {}) {
  return toolError(message, {
    ...extra,
    error_code: errorCode,
    message,
    next_action: nextActionText,
    stderr_tail: null,
    stderr_truncated: false,
  });
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

function isValidJobState(state, expectedId) {
  return Boolean(
    state &&
      typeof state === "object" &&
      state.id === expectedId &&
      typeof state.model === "string" &&
      state.model.length <= 128 &&
      MODEL_PATTERN.test(state.model) &&
      ["starting", "running", "completed", "error", "cancelled"].includes(
        state.status,
      ) &&
      Number.isFinite(state.startedAt) &&
      (state.completedAt === null ||
        state.completedAt === undefined ||
        Number.isFinite(state.completedAt)),
  );
}

function recoverOrphanedJob(jobPath, state) {
  if (TERMINAL_STATUSES.has(state.status)) return state;
  const recordedBoot = Number(state.bootStartedAt);
  const sameBoot =
    !Number.isFinite(recordedBoot) ||
    Math.abs(recordedBoot - SERVER_BOOT_STARTED_AT) <= BOOT_TIME_TOLERANCE_MS;
  const withinStartupGrace =
    state.status === "starting" &&
    Number.isFinite(state.startedAt) &&
    Date.now() - state.startedAt < STARTUP_GRACE_MS;
  if (sameBoot && withinStartupGrace) return state;
  if (sameBoot && processExists(state.runnerPid)) return state;

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
      parsed.result.requested_effort = state.effort || DEFAULT_EFFORT;
      atomicWriteJson(paths.result, parsed.result);
      const recovered = {
        ...state,
        status: "completed",
        sessionId: parsed.result.session_id || null,
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
    const storedState = readJson(jobPaths(path).state);
    if (!isValidJobState(storedState, jobId)) return null;
    const state = recoverOrphanedJob(path, storedState);
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

async function waitForRunnerStart(paths, timeoutMs = 2_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const state = readJson(paths.state);
      if (
        state.status === "running" ||
        TERMINAL_STATUSES.has(state.status)
      ) {
        return;
      }
    } catch {
      // The runner may be between atomic state-file updates.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startClaudeJob({
  question,
  model,
  workspace,
  mode = validateMode(undefined, workspace),
  name = null,
  effort = DEFAULT_EFFORT,
  maxBudgetUsd = null,
  parentJobId = null,
  resumeSessionId = null,
}) {
  if (runningJobCount() >= MAX_CONCURRENT_JOBS) {
    return codedToolError(
      "concurrency_limit",
      `Claude Ask already has ${MAX_CONCURRENT_JOBS} concurrent jobs.`,
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
    name,
    model,
    effort,
    maxBudgetUsd,
    parentJobId,
    sessionId: null,
    resumable: true,
    status: "starting",
    startedAt,
    completedAt: null,
    bootStartedAt: SERVER_BOOT_STARTED_AT,
    runnerPid: null,
    claudePid: null,
    launcherPid: process.pid,
    workspace,
    mode,
  });

  const runner = spawn(
    process.execPath,
    [RUNNER_PATH, job.path, job.id, model, effort],
    {
      cwd: job.path,
      env: process.env,
      detached: true,
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
    },
  );
  atomicWriteJson(paths.state, {
    ...readJson(paths.state),
    bootStartedAt: SERVER_BOOT_STARTED_AT,
    runnerPid: Number.isSafeInteger(runner.pid) ? runner.pid : null,
  });
  await new Promise((resolve, reject) => {
    runner.once("error", reject);
    runner.stdin.once("error", reject);
    runner.stdin.cork();
    runner.stdin.write(
      `${JSON.stringify({
        bytes: questionBytes,
        digest,
        workspace,
        mode,
        maxBudgetUsd,
        resumeSessionId,
      })}\n`,
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
  await waitForRunnerStart(paths);

  const loaded = loadJob(job.id);
  return TERMINAL_STATUSES.has(loaded.state.status)
    ? finalJobResult(loaded)
    : runningResult(loaded, 0);
}

function progressFor(job) {
  return fileProgress(job.paths.stream, job.state.startedAt);
}

function elapsedFor(job) {
  const end = job.state.completedAt || Date.now();
  return Math.max(0, Math.round(end - job.state.startedAt));
}

function publicStatus(state) {
  return state.status === "starting" ? "running" : state.status;
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
    name: job.state.name || null,
    model: job.state.model,
    parent_job_id: job.state.parentJobId || null,
    status: publicStatus(job.state),
    progress,
    output_bytes: progressState.bytes,
    delta_bytes: deltaBytes,
    last_growth_ms_ago: Math.max(0, Date.now() - progressState.lastGrowthAt),
    started_at: new Date(job.state.startedAt).toISOString(),
    elapsed_ms: elapsedFor(job),
    workspace: job.state.workspace || null,
    mode: job.state.mode || (job.state.workspace ? "agent" : "advisory"),
    effort: job.state.effort || DEFAULT_EFFORT,
    max_budget_usd: job.state.maxBudgetUsd ?? null,
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

function nextAction(errorCode) {
  const actions = {
    authentication_failed: "Run `claude auth login`, then retry the job.",
    output_limit_exceeded:
      "Inspect the workspace because Claude may have changed files before its output was stopped.",
    workspace_invalid: "Pass an existing absolute workspace directory.",
    spawn_failed:
      "Set `CLAUDE_ASK_CLI` to a working Claude executable or add `claude` to PATH.",
    invalid_stream:
      "Review stderr_tail and verify that the installed Claude CLI supports stream-json output.",
    prompt_transfer_failed:
      "Retry the job; if the error repeats, verify that the plugin server and runner files are from the same version.",
    runner_spawn_failed:
      "Verify the Node.js runtime and plugin files, then retry the job.",
    runner_interrupted:
      "Inspect the workspace for partial changes, then retry the job.",
    runner_failed:
      "Verify the plugin files and runtime, then retry the job.",
  };
  return actions[errorCode] || "Review stderr_tail, correct the cause, and retry.";
}

function stderrTail(job, maximumBytes = 4096) {
  try {
    const stderr = readFileSync(job.paths.stderr);
    const decoded = stderr
      .subarray(Math.max(0, stderr.length - maximumBytes))
      .toString("utf8");
    if (Buffer.byteLength(decoded, "utf8") <= maximumBytes) return decoded;

    let low = 0;
    let high = decoded.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (Buffer.byteLength(decoded.slice(middle), "utf8") > maximumBytes) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return decoded.slice(low);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return null;
  }
}

function finalJobResult(job) {
  const progressState = progressFor(job);
  const base = {
    job_id: job.state.id,
    name: job.state.name || null,
    model: job.state.model,
    parent_job_id: job.state.parentJobId || null,
    status: job.state.status,
    output_bytes: progressState.bytes,
    started_at: new Date(job.state.startedAt).toISOString(),
    workspace: job.state.workspace || null,
    mode: job.state.mode || (job.state.workspace ? "agent" : "advisory"),
    effort: job.state.effort || DEFAULT_EFFORT,
    max_budget_usd: job.state.maxBudgetUsd ?? null,
    completed_at: job.state.completedAt
      ? new Date(job.state.completedAt).toISOString()
      : null,
    elapsed_ms: elapsedFor(job),
    recovered_after_restart: Boolean(job.state.recoveredAfterRestart),
    ...streamSummary(job.paths.stream),
  };
  if (job.state.status === "completed") {
    let answer;
    try {
      answer = readJson(job.paths.result);
    } catch {
      return codedToolError(
        "result_unavailable",
        "Claude result file is unavailable.",
        "Retry the job because its completed result cannot be read.",
        base,
      );
    }
    return {
      content: [{ type: "text", text: answer.answer }],
      structuredContent: { ...base, ...answer },
      isError: false,
    };
  }
  if (job.state.status === "cancelled") {
    return codedToolError(
      "cancelled",
      `Claude job ${job.state.id} was cancelled.`,
      "Start a new job if the work is still needed.",
      base,
    );
  }
  const errorCode = job.state.errorCode || "unknown_error";
  const message = errorMessage(errorCode);
  return toolError(message, {
    ...base,
    error_code: errorCode,
    message,
    next_action: nextAction(errorCode),
    stderr_tail: stderrTail(job),
    stderr_truncated: Boolean(job.state.stderrTruncated),
  });
}

async function handleToolCall(params) {
  const toolName = params?.name;
  const args = params?.arguments || {};

  if (toolName === "ask") {
    const question = args.question;
    let model;
    let mode;
    let workspace;
    let name;
    let effort;
    let maxBudgetUsd;
    if (typeof question !== "string" || question.trim().length === 0) {
      return codedToolError(
        "invalid_request",
        "`question` must be a non-empty string.",
        "Pass a non-empty `question`.",
      );
    }
    if (question.length > MAX_QUESTION_CHARS) {
      return codedToolError(
        "invalid_request",
        `Question exceeds the ${MAX_QUESTION_CHARS}-character limit.`,
        "Shorten the question and retry.",
      );
    }
    try {
      model = validateModel(args.model);
      workspace = validateWorkspace(args.workspace);
      mode = validateMode(args.mode, workspace);
      name = validateJobName(args.name);
      effort = validateEffort(args.effort);
      maxBudgetUsd = validateBudget(args.max_budget_usd);
    } catch (workspaceError) {
      return codedToolError(
        "invalid_request",
        workspaceError instanceof Error
          ? workspaceError.message
          : "Invalid workspace path.",
        "Correct the request options and retry.",
      );
    }
    try {
      return await startClaudeJob({
        question,
        model,
        workspace,
        mode,
        name,
        effort,
        maxBudgetUsd,
      });
    } catch {
      return codedToolError(
        "job_start_failed",
        "Claude Ask could not start the background job.",
        "Verify the plugin runtime and retry.",
      );
    }
  }

  if (toolName === "ask_followup") {
    const parent = loadJob(args.job_id);
    if (!parent) {
      return codedToolError(
        "session_unavailable",
        "Unknown or expired parent Claude job ID.",
        "Start a new Claude job with `ask`.",
      );
    }
    if (parent.state.status !== "completed") {
      return codedToolError(
        "parent_not_completed",
        "Parent Claude job must be completed successfully.",
        "Wait for a successful completed parent or start a new job.",
      );
    }
    if (parent.state.resumable !== true) {
      return codedToolError(
        "session_unavailable",
        "Parent Claude session is unavailable for follow-up.",
        "Start a new Claude job with `ask`.",
      );
    }

    let parentResult;
    try {
      parentResult = readJson(parent.paths.result);
    } catch {
      return codedToolError(
        "session_unavailable",
        "Parent Claude result is unavailable.",
        "Start a new Claude job with `ask`.",
      );
    }
    if (
      typeof parentResult.session_id !== "string" ||
      parentResult.session_id.length === 0
    ) {
      return codedToolError(
        "session_unavailable",
        "Parent Claude session is unavailable for follow-up.",
        "Start a new Claude job with `ask`.",
      );
    }

    const question = args.question;
    if (typeof question !== "string" || question.trim().length === 0) {
      return codedToolError(
        "invalid_request",
        "`question` must be a non-empty string.",
        "Pass a non-empty `question`.",
      );
    }
    if (question.length > MAX_QUESTION_CHARS) {
      return codedToolError(
        "invalid_request",
        `Question exceeds the ${MAX_QUESTION_CHARS}-character limit.`,
        "Shorten the question and retry.",
      );
    }

    let name;
    let effort;
    let maxBudgetUsd;
    try {
      name = validateJobName(args.name);
      effort = validateEffort(args.effort, parent.state.effort || DEFAULT_EFFORT);
      maxBudgetUsd = validateBudget(args.max_budget_usd);
    } catch (validationError) {
      return codedToolError(
        "invalid_request",
        validationError instanceof Error
          ? validationError.message
          : "Invalid follow-up options.",
        "Correct the follow-up options and retry.",
      );
    }

    try {
      return await startClaudeJob({
        question,
        model: parent.state.model,
        workspace: parent.state.workspace || null,
        mode: parent.state.mode || validateMode(undefined, parent.state.workspace),
        name,
        effort,
        maxBudgetUsd,
        parentJobId: parent.state.id,
        resumeSessionId: parentResult.session_id,
      });
    } catch {
      return codedToolError(
        "job_start_failed",
        "Claude Ask could not start the follow-up job.",
        "Verify the plugin runtime and retry.",
      );
    }
  }

  if (toolName === "ask_status") {
    let job = loadJob(args.job_id);
    if (!job) {
      return codedToolError(
        "job_not_found",
        "Unknown or expired Claude job ID.",
        "Use `list_jobs` to recover a recent job ID or start a new job.",
      );
    }
    const waitMs = Number.isInteger(args.wait_ms)
      ? Math.max(0, Math.min(args.wait_ms, 30_000))
      : 10_000;
    const currentBytes = progressFor(job).bytes;
    const previousBytes = Number.isInteger(args.previous_output_bytes)
      ? Math.max(0, args.previous_output_bytes)
      : currentBytes;
    await waitForProgress(job, previousBytes, waitMs);
    job = loadJob(args.job_id);
    if (!job) {
      return codedToolError(
        "job_not_found",
        "Claude job expired while checking status.",
        "Use `list_jobs` or start a new job.",
      );
    }
    return TERMINAL_STATUSES.has(job.state.status)
      ? finalJobResult(job)
      : runningResult(job, previousBytes);
  }

  if (toolName === "list_jobs") {
    const limit =
      args.limit === undefined
        ? 20
        : Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= 100
          ? args.limit
          : null;
    if (limit === null) {
      return codedToolError(
        "invalid_request",
        "`limit` must be an integer from 1 through 100.",
        "Pass a `limit` from 1 through 100.",
      );
    }
    const allowedStatuses = new Set([
      "running",
      "completed",
      "error",
      "cancelled",
    ]);
    if (
      args.status !== undefined &&
      (typeof args.status !== "string" || !allowedStatuses.has(args.status))
    ) {
      return codedToolError(
        "invalid_request",
        "`status` must be `running`, `completed`, `error`, or `cancelled`.",
        "Choose one of the supported status filters.",
      );
    }

    const jobs = [];
    for (const entry of readdirSync(JOB_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || !JOB_ID_PATTERN.test(entry.name)) continue;
      const job = loadJob(entry.name);
      if (!job) continue;
      const status = publicStatus(job.state);
      if (args.status !== undefined && status !== args.status) continue;

      const summary = {
        job_id: job.state.id,
        name: job.state.name || null,
        status,
        model: job.state.model,
        effort: job.state.effort || DEFAULT_EFFORT,
        mode: job.state.mode || (job.state.workspace ? "agent" : "advisory"),
        workspace: job.state.workspace || null,
        parent_job_id: job.state.parentJobId || null,
        started_at: new Date(job.state.startedAt).toISOString(),
        completed_at: job.state.completedAt
          ? new Date(job.state.completedAt).toISOString()
          : null,
        elapsed_ms: elapsedFor(job),
      };
      if (status === "completed") {
        try {
          const completed = readJson(job.paths.result);
          if (Number.isFinite(completed.total_cost_usd)) {
            summary.total_cost_usd = completed.total_cost_usd;
          }
        } catch {
          // A corrupt result does not make the rest of the job list unusable.
        }
      }
      jobs.push({ startedAt: job.state.startedAt, summary });
    }
    jobs.sort((left, right) => right.startedAt - left.startedAt);
    const summaries = jobs.slice(0, limit).map((job) => job.summary);
    return {
      content: [
        {
          type: "text",
          text: `Found ${summaries.length} recent Claude jobs.`,
        },
      ],
      structuredContent: { jobs: summaries },
      isError: false,
    };
  }

  if (toolName === "cancel_ask") {
    const job = loadJob(args.job_id);
    if (!job) {
      return codedToolError(
        "job_not_found",
        "Unknown or expired Claude job ID.",
        "Use `list_jobs` to recover a recent job ID.",
      );
    }
    if (!TERMINAL_STATUSES.has(job.state.status)) {
      try {
        const fd = openSync(job.paths.cancel, "wx", 0o600);
        chmodSync(job.paths.cancel, 0o600);
        closeSync(fd);
      } catch (error) {
        if (error?.code !== "EEXIST") {
          return codedToolError(
            "cancel_request_failed",
            "Could not request Claude job cancellation.",
            "Check job-directory permissions and retry.",
          );
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

  return codedToolError(
    "unknown_tool",
    `Unknown tool: ${toolName || "<missing>"}`,
    "Call one of the tools returned by `tools/list`.",
  );
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    result(id, {
      protocolVersion: params?.protocolVersion || "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        "Start Claude with ask and poll ask_status until a terminal result. Use mode=review with workspace for Read, Glob, and Grep only; agent mode enables full autonomous tools and writes. Without workspace, advisory mode has no tools. Use a full model ID to pin a version. ask_followup inherits the model, workspace, mode, and session; list_jobs recovers lost IDs. Detached jobs survive MCP server restart and have no elapsed/idle deadline; cancellation is explicit. A request failure does not cancel the job: reconnect and query its ID.",
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
            "Start a persistent background Claude Code job using Opus 5 at high effort by default. Accepts Claude Code model aliases and full model IDs. Use mode=review with workspace for Read, Glob, and Grep only, with shell, edits, customizations, and MCP disabled. With workspace and no explicit mode, Claude runs as a full autonomous coding agent with default tools, shell commands, file editing, inherited user/project instructions and hooks, configured MCP servers, skills, and plugins, network access, and permission to modify files. Without workspace it receives only the question and no tools. Workspace is the working directory and intended task scope, not a hard OS sandbox. Returns a job ID immediately; poll ask_status. There is no elapsed-time or idle-time deadline.",
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
                pattern: MODEL_PATTERN.source,
                maxLength: 128,
                default: DEFAULT_MODEL,
                description: "Claude Code alias or full model ID, for example sonnet or claude-sonnet-5-5.",
              },
              mode: {
                type: "string",
                enum: ["advisory", "review", "agent"],
                description: "Review uses only Read, Glob, and Grep and requires workspace. Agent allows shell and writes. Defaults to agent with workspace, advisory without it.",
              },
              workspace: {
                type: "string",
                minLength: 1,
                maxLength: 4096,
                description:
                  "Absolute existing working directory for review or agent mode. Omit for advisory questions. This is the intended task scope, not a hard OS sandbox.",
              },
              name: {
                type: "string",
                minLength: 1,
                maxLength: 120,
                description: "Optional human-readable job name.",
              },
              effort: {
                type: "string",
                enum: ["low", "medium", "high", "xhigh", "max"],
                default: DEFAULT_EFFORT,
                description: "Claude Code reasoning effort.",
              },
              max_budget_usd: {
                type: "number",
                minimum: 0.01,
                maximum: 1000,
                description: "Optional Claude Code cost ceiling for this job.",
              },
            },
            required: ["question"],
            additionalProperties: false,
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        {
          name: "ask_followup",
          title: "Continue Claude Job",
          description:
            "Start a persistent follow-up from a completed Claude job. It inherits the parent model, workspace, mode, and full session context while creating an independent session branch.",
          inputSchema: {
            type: "object",
            properties: {
              job_id: { type: "string", minLength: 1 },
              question: {
                type: "string",
                minLength: 1,
                maxLength: MAX_QUESTION_CHARS,
              },
              name: {
                type: "string",
                minLength: 1,
                maxLength: 120,
              },
              effort: {
                type: "string",
                enum: ["low", "medium", "high", "xhigh", "max"],
              },
              max_budget_usd: {
                type: "number",
                minimum: 0.01,
                maximum: 1000,
              },
            },
            required: ["job_id", "question"],
            additionalProperties: false,
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
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
          name: "list_jobs",
          title: "List Claude Jobs",
          description:
            "List recent persistent Claude jobs newest first so lost job IDs can be recovered.",
          inputSchema: {
            type: "object",
            properties: {
              limit: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                default: 20,
              },
              status: {
                type: "string",
                enum: ["running", "completed", "error", "cancelled"],
              },
            },
            additionalProperties: false,
          },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
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
