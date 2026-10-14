#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, uptime } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaudeStream } from "./lib.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(scriptsDir);
const live = process.env.CLAUDE_ASK_LIVE === "1";
const fakeClaude = join(scriptsDir, "fixtures", "fake-claude.mjs");
const jobRoot = mkdtempSync(join(tmpdir(), "claude-ask-test-"));
chmodSync(jobRoot, 0o700);
const knownJobs = new Set();

class McpClient {
  constructor(extraEnv = {}) {
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.server = spawn(process.execPath, [join(scriptsDir, "server.mjs")], {
      env: {
        ...process.env,
        CLAUDE_ASK_JOB_DIR: jobRoot,
        ...(live ? {} : { CLAUDE_ASK_CLI: fakeClaude }),
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.server.stdout.setEncoding("utf8");
    this.server.stdout.on("data", (chunk) => this.onData(chunk));
  }

  onData(chunk) {
    this.buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const callback = this.pending.get(message.id);
      if (!callback) continue;
      this.pending.delete(message.id);
      callback(message);
    }
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request did not return promptly: ${method}`));
      }, 40_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.server.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  call(name, args) {
    return this.request("tools/call", { name, arguments: args });
  }

  async initialize() {
    const initialized = await this.request("initialize", {
      protocolVersion: "2025-03-26",
    });
    assert.equal(initialized.result.serverInfo.name, "claude-ask");
    this.server.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    return initialized;
  }

  async stop() {
    if (this.server.exitCode !== null) return;
    await new Promise((resolve) => {
      this.server.once("exit", resolve);
      this.server.kill("SIGTERM");
    });
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function remember(started) {
  const id = started.result.structuredContent?.job_id;
  if (id) knownJobs.add(id);
  return id;
}

async function waitForTerminal(client, jobId, previousBytes = 0) {
  for (;;) {
    const response = await client.call("ask_status", {
      job_id: jobId,
      previous_output_bytes: previousBytes,
      wait_ms: live ? 5_000 : 250,
    });
    const state = response.result.structuredContent;
    previousBytes = state.output_bytes;
    if (["completed", "error", "cancelled"].includes(state.status)) {
      return response;
    }
  }
}

async function cancelAndWait(client, jobId) {
  const requested = await client.call("cancel_ask", { job_id: jobId });
  assert.equal(requested.result.isError, false);
  assert.equal(requested.result.structuredContent.status, "cancelling");
  const terminal = await waitForTerminal(client, jobId);
  assert.equal(terminal.result.structuredContent.status, "cancelled");
  assert.equal(terminal.result.structuredContent.error_code, "cancelled");
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processExists(pid);
}

async function fakeTests() {
  const fallbackStream = [
    { type: "system", subtype: "init", model: "claude-sonnet-5-5" },
    { type: "assistant", message: { model: "claude-sonnet-5" } },
    {
      type: "assistant",
      parent_tool_use_id: "subagent",
      message: { model: "claude-haiku-5-5" },
    },
    { type: "result", result: "answer", modelUsage: { "claude-sonnet-5": {} } },
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.equal(
    parseClaudeStream(fallbackStream).result.resolved_model,
    "claude-sonnet-5",
  );
  const skill = readFileSync(
    join(pluginRoot, "skills", "claude-ask", "SKILL.md"),
    "utf8",
  );
  assert.ok(skill.trim().split(/\s+/).length < 500);
  assert.match(skill, /ask_followup/);
  assert.match(skill, /list_jobs/);
  assert.match(skill, /medium.*high.*xhigh.*max/is);
  assert.match(skill, /MCP.*skills.*plugins/is);

  const readme = readFileSync(join(pluginRoot, "README.md"), "utf8");
  assert.match(readme, /ask_followup/);
  assert.match(readme, /list_jobs/);
  assert.match(readme, /stderr_tail/);
  assert.doesNotMatch(readme, /Every consultation runs at explicit `xhigh`/);

  const manifest = JSON.parse(
    readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
  );
  assert.equal(manifest.version, "0.3.0");
  assert.ok(
    manifest.interface.defaultPrompt.some((prompt) =>
      /without repository tools/i.test(prompt),
    ),
  );
  assert.ok(
    manifest.interface.defaultPrompt.some((prompt) =>
      /investigate and fix/i.test(prompt),
    ),
  );

  let client = new McpClient({
    CLAUDE_ASK_MAX_CONCURRENT_JOBS: "2",
    FAKE_CLAUDE_DELAY_MS: "300",
  });
  const initialized = await client.initialize();
  assert.equal(initialized.result.serverInfo.version, manifest.version);
  const listed = await client.request("tools/list");
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ["ask", "ask_followup", "ask_status", "list_jobs", "cancel_ask"],
  );
  assert.match(listed.result.tools[0].description, /no elapsed-time/i);
  assert.match(listed.result.tools[0].description, /full autonomous coding agent/i);
  assert.match(listed.result.tools[0].description, /high effort by default/i);
  assert.match(
    listed.result.tools[0].description,
    /configured MCP servers, skills, and plugins/i,
  );
  assert.match(
    listed.result.tools[0].description,
    /inherited user\/project instructions and hooks/i,
  );
  assert.equal(listed.result.tools[0].annotations.readOnlyHint, false);
  assert.equal(listed.result.tools[0].annotations.destructiveHint, true);
  assert.ok(listed.result.tools[0].inputSchema.properties.workspace);
  assert.match(
    "claude-sonnet-5-5",
    new RegExp(listed.result.tools[0].inputSchema.properties.model.pattern),
  );
  assert.equal(
    listed.result.tools[0].inputSchema.properties.model.default,
    "claude-opus-5",
  );

  const relativeWorkspace = await client.call("ask", {
    question: "must-not-start",
    workspace: "relative/path",
  });
  assert.equal(relativeWorkspace.result.isError, true);
  assert.match(relativeWorkspace.result.content[0].text, /absolute directory/i);

  const workspaceRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "claude-ask-workspace-test-")),
  );
  const workspaceStarted = await client.call("ask", {
    question: `workspace-probe:${workspaceRoot}`,
    workspace: workspaceRoot,
  });
  const workspaceJobId = remember(workspaceStarted);
  const workspaceResult = await waitForTerminal(client, workspaceJobId);
  assert.equal(workspaceResult.result.isError, false);
  assert.equal(workspaceResult.result.content[0].text, "WORKSPACE_OK");
  assert.equal(
    workspaceResult.result.structuredContent.requested_model,
    "claude-opus-5",
  );
  assert.equal(
    workspaceResult.result.structuredContent.requested_effort,
    "high",
  );
  assert.equal(workspaceResult.result.structuredContent.effort, "high");
  assert.equal(
    workspaceResult.result.structuredContent.resolved_model,
    "claude-claude-opus-5-fake",
  );
  assert.equal(workspaceResult.result.structuredContent.workspace, workspaceRoot);
  assert.equal(workspaceResult.result.structuredContent.mode, "agent");

  const review = await client.call("ask", {
    question: `review-probe:${workspaceRoot}`,
    workspace: workspaceRoot,
    mode: "review",
    model: "claude-sonnet-5-5",
    effort: "low",
  });
  const reviewJobId = remember(review);
  await client.stop();
  client = new McpClient({ CLAUDE_ASK_MAX_CONCURRENT_JOBS: "2" });
  await client.initialize();
  const reviewResult = await waitForTerminal(client, reviewJobId);
  assert.equal(reviewResult.result.isError, false);
  assert.equal(reviewResult.result.content[0].text, "REVIEW_OK");
  assert.equal(reviewResult.result.structuredContent.mode, "review");
  assert.equal(reviewResult.result.structuredContent.requested_model, "claude-sonnet-5-5");
  assert.equal(reviewResult.result.structuredContent.requested_effort, "low");
  const reviewFollowup = await client.call("ask_followup", {
    job_id: reviewJobId,
    question: "review-recall",
  });
  const reviewFollowupResult = await waitForTerminal(
    client, remember(reviewFollowup),
  );
  assert.equal(reviewFollowupResult.result.isError, false);
  assert.equal(reviewFollowupResult.result.content[0].text, "REVIEW_FOLLOWUP_OK");
  assert.equal(reviewFollowupResult.result.structuredContent.mode, "review");
  assert.equal(reviewFollowupResult.result.structuredContent.requested_model, "claude-sonnet-5-5");
  assert.equal(reviewFollowupResult.result.structuredContent.requested_effort, "low");

  const defaultEffort = await client.call("ask", {
    question: "default-effort-probe",
  });
  const defaultEffortResult = await waitForTerminal(
    client,
    remember(defaultEffort),
  );
  assert.equal(defaultEffortResult.result.isError, false);
  assert.equal(
    defaultEffortResult.result.content[0].text,
    "DEFAULT_EFFORT_OK",
  );

  const exactPrompt = "literal $(touch /tmp/nope) `whoami` $HOME; line 2\n";
  const started = await client.call("ask", {
    question: exactPrompt,
    model: "opus",
  });
  assert.equal(started.result.isError, false);
  assert.equal(started.result.structuredContent.status, "running");
  assert.equal("progress_file" in started.result.structuredContent, false);
  const exactJobId = remember(started);
  const exactResult = await waitForTerminal(client, exactJobId);
  assert.equal(exactResult.result.isError, false);
  assert.equal(
    exactResult.result.content[0].text,
    `fake:opus:${sha256(exactPrompt)}`,
  );
  assert.equal(exactResult.result.structuredContent.requested_model, "opus");
  assert.equal(exactResult.result.structuredContent.mode, "advisory");
  assert.equal(
    exactResult.result.structuredContent.resolved_model,
    "claude-opus-fake",
  );

  const configured = await client.call("ask", {
    question: "option-probe",
    name: "  useful job  ",
    effort: "medium",
    max_budget_usd: 1.25,
  });
  const configuredResult = await waitForTerminal(client, remember(configured));
  assert.equal(configuredResult.result.isError, false);
  assert.equal(configuredResult.result.content[0].text, "OPTIONS_OK");
  assert.equal(configuredResult.result.structuredContent.name, "useful job");
  assert.equal(configuredResult.result.structuredContent.effort, "medium");
  assert.equal(configuredResult.result.structuredContent.max_budget_usd, 1.25);

  for (const argumentsValue of [
    { question: "x", name: "   " },
    { question: "x", effort: "extreme" },
    { question: "x", model: "--dangerously-skip-permissions" },
    { question: "x", model: "sonnet;whoami" },
    { question: "x", model: "" },
    { question: "x", model: "sonnet\n" },
    { question: "x", mode: "review" },
    { question: "x", mode: "agent" },
    { question: "x", mode: "advisory", workspace: workspaceRoot },
    { question: "x", mode: "unknown", workspace: workspaceRoot },
    { question: "x", max_budget_usd: 0 },
    { question: "x", max_budget_usd: "1" },
  ]) {
    const rejected = await client.call("ask", argumentsValue);
    assert.equal(rejected.result.isError, true);
  }

  const parent = await client.call("ask", {
    question: "remember:alpha",
    workspace: workspaceRoot,
    name: "parent",
  });
  const parentJobId = remember(parent);
  const parentResult = await waitForTerminal(client, parentJobId);
  assert.equal(
    JSON.parse(
      readFileSync(join(jobRoot, parentJobId, "state.json"), "utf8"),
    ).sessionId,
    parentResult.result.structuredContent.session_id,
  );
  const followup = await client.call("ask_followup", {
    job_id: parentResult.result.structuredContent.job_id,
    question: "recall",
    name: "child",
    effort: "xhigh",
    max_budget_usd: 2,
  });
  const followupResult = await waitForTerminal(client, remember(followup));
  assert.equal(followupResult.result.isError, false);
  assert.equal(followupResult.result.content[0].text, "FOLLOWUP_OK");
  assert.equal(
    followupResult.result.structuredContent.parent_job_id,
    parentResult.result.structuredContent.job_id,
  );
  assert.equal(followupResult.result.structuredContent.workspace, workspaceRoot);
  assert.equal(followupResult.result.structuredContent.effort, "xhigh");
  assert.equal(followupResult.result.structuredContent.max_budget_usd, 2);
  assert.equal(followupResult.result.structuredContent.name, "child");

  const unknownParent = await client.call("ask_followup", {
    job_id: "00000000-0000-4000-8000-000000000000",
    question: "recall",
  });
  assert.equal(unknownParent.result.isError, true);
  assert.equal(
    unknownParent.result.structuredContent.error_code,
    "session_unavailable",
  );

  const runningParent = await client.call("ask", {
    question: "hold-for-cancel",
    workspace: workspaceRoot,
  });
  const runningParentId = remember(runningParent);
  const runningFollowup = await client.call("ask_followup", {
    job_id: runningParentId,
    question: "recall",
  });
  assert.equal(runningFollowup.result.isError, true);
  assert.equal(
    runningFollowup.result.structuredContent.error_code,
    "parent_not_completed",
  );
  await cancelAndWait(client, runningParentId);
  const cancelledFollowup = await client.call("ask_followup", {
    job_id: runningParentId,
    question: "recall",
  });
  assert.equal(cancelledFollowup.result.isError, true);
  assert.equal(
    cancelledFollowup.result.structuredContent.error_code,
    "parent_not_completed",
  );

  const parentStatePath = join(jobRoot, parentResult.result.structuredContent.job_id, "state.json");
  const parentState = JSON.parse(readFileSync(parentStatePath, "utf8"));
  writeFileSync(
    parentStatePath,
    `${JSON.stringify({ ...parentState, resumable: false })}\n`,
  );
  const legacyFollowup = await client.call("ask_followup", {
    job_id: parentResult.result.structuredContent.job_id,
    question: "recall",
  });
  assert.equal(legacyFollowup.result.isError, true);
  assert.equal(
    legacyFollowup.result.structuredContent.error_code,
    "session_unavailable",
  );

  const corruptJobId = randomUUID();
  const corruptJobPath = join(jobRoot, corruptJobId);
  mkdirSync(corruptJobPath, { mode: 0o700 });
  writeFileSync(join(corruptJobPath, "state.json"), "{}\n", {
    mode: 0o600,
  });
  const recentCompleted = await client.call("list_jobs", {
    limit: 2,
    status: "completed",
  });
  assert.equal(recentCompleted.result.isError, false);
  assert.equal(recentCompleted.result.structuredContent.jobs.length, 2);
  assert.ok(
    recentCompleted.result.structuredContent.jobs[0].started_at >=
      recentCompleted.result.structuredContent.jobs[1].started_at,
  );
  assert.ok(
    recentCompleted.result.structuredContent.jobs.every(
      (job) =>
        job.status === "completed" &&
        Number.isInteger(job.elapsed_ms) &&
        !("answer" in job),
    ),
  );
  const listWithCorruptState = await client.call("list_jobs", { limit: 100 });
  assert.equal(listWithCorruptState.result.isError, false);
  rmSync(corruptJobPath, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });

  assert.equal(statSync(jobRoot).mode & 0o777, 0o700);
  const exactJobPath = join(jobRoot, exactJobId);
  assert.equal(statSync(exactJobPath).mode & 0o777, 0o700);
  for (const file of readdirSync(exactJobPath)) {
    assert.equal(statSync(join(exactJobPath, file)).mode & 0o777, 0o600);
  }
  const stateText = readFileSync(join(exactJobPath, "state.json"), "utf8");
  assert.equal(stateText.includes(exactPrompt), false);

  const idle = await client.call("ask", {
    question: "idle-progress",
    model: "fable",
  });
  const idleJobId = remember(idle);
  let status;
  let initialBytes = idle.result.structuredContent.output_bytes;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    status = await client.call("ask_status", {
      job_id: idleJobId,
      previous_output_bytes: initialBytes,
      wait_ms: 100,
    });
    initialBytes = status.result.structuredContent.output_bytes;
    if (status.result.structuredContent.json_events >= 1) break;
  }
  assert.equal(status.result.structuredContent.status, "running");
  assert.equal(status.result.isError, false);
  assert.ok(status.result.structuredContent.json_events >= 1);
  const unchangedBytes = status.result.structuredContent.output_bytes;
  const unchanged = await client.call("ask_status", {
    job_id: idleJobId,
    previous_output_bytes: unchangedBytes,
    wait_ms: 50,
  });
  assert.equal(unchanged.result.structuredContent.status, "running");
  assert.equal(unchanged.result.isError, false);

  let sawPartialText = false;
  let sawEstimatedThinking = false;
  let sawToolCalls = false;
  let previousBytes = unchanged.result.structuredContent.output_bytes;
  for (;;) {
    status = await client.call("ask_status", {
      job_id: idleJobId,
      previous_output_bytes: previousBytes,
      wait_ms: 250,
    });
    previousBytes = status.result.structuredContent.output_bytes;
    if (status.result.structuredContent.partial_text_chars > 0) {
      sawPartialText = true;
    }
    if (status.result.structuredContent.estimated_thinking_tokens > 0) {
      sawEstimatedThinking = true;
    }
    if (status.result.structuredContent.tool_calls > 0) {
      sawToolCalls = true;
    }
    if (status.result.structuredContent.status === "completed") break;
  }
  assert.equal(sawPartialText, true);
  assert.equal(sawEstimatedThinking, true);
  assert.equal(sawToolCalls, true);

  const restart = await client.call("ask", {
    question: "restart-progress",
    model: "fable",
  });
  const restartJobId = remember(restart);
  await client.stop();

  client = new McpClient({
    CLAUDE_ASK_MAX_CONCURRENT_JOBS: "2",
    FAKE_CLAUDE_DELAY_MS: "300",
  });
  const reinitialized = await client.initialize();
  assert.match(reinitialized.result.instructions, /survive MCP server restart/i);

  const recoveryRaceId = randomUUID();
  const recoveryRacePath = join(jobRoot, recoveryRaceId);
  mkdirSync(recoveryRacePath, { mode: 0o700 });
  writeFileSync(
    join(recoveryRacePath, "state.json"),
    `${JSON.stringify({
      id: recoveryRaceId,
      model: "sonnet",
      effort: "high",
      status: "starting",
      startedAt: Date.now(),
      runnerPid: null,
      launcherPid: 2_147_483_647,
      bootStartedAt: Date.now() - uptime() * 1_000,
      workspace: null,
      mode: "advisory",
    })}\n`,
    { mode: 0o600 },
  );
  const startupGrace = await client.call("ask_status", {
    job_id: recoveryRaceId,
    wait_ms: 0,
  });
  assert.equal(startupGrace.result.isError, false);
  assert.equal(startupGrace.result.structuredContent.status, "running");
  rmSync(recoveryRacePath, { recursive: true, force: true });

  const liveRunnerId = randomUUID();
  const liveRunnerPath = join(jobRoot, liveRunnerId);
  mkdirSync(liveRunnerPath, { mode: 0o700 });
  writeFileSync(
    join(liveRunnerPath, "state.json"),
    `${JSON.stringify({
      id: liveRunnerId,
      model: "sonnet",
      effort: "high",
      status: "starting",
      startedAt: Date.now() - 10_000,
      runnerPid: process.pid,
      launcherPid: 2_147_483_647,
      bootStartedAt: Date.now() - uptime() * 1_000,
      workspace: null,
      mode: "advisory",
    })}\n`,
    { mode: 0o600 },
  );
  const liveRunnerStatus = await client.call("ask_status", {
    job_id: liveRunnerId,
    wait_ms: 0,
  });
  assert.equal(liveRunnerStatus.result.isError, false);
  assert.equal(liveRunnerStatus.result.structuredContent.status, "running");
  rmSync(liveRunnerPath, { recursive: true, force: true });

  const priorBootId = randomUUID();
  const priorBootPath = join(jobRoot, priorBootId);
  mkdirSync(priorBootPath, { mode: 0o700 });
  writeFileSync(
    join(priorBootPath, "state.json"),
    `${JSON.stringify({
      id: priorBootId,
      model: "sonnet",
      effort: "high",
      status: "running",
      startedAt: Date.now() - 10_000,
      runnerPid: process.pid,
      launcherPid: process.pid,
      bootStartedAt: 0,
      workspace: null,
      mode: "advisory",
    })}\n`,
    { mode: 0o600 },
  );
  const priorBootStatus = await client.call("ask_status", {
    job_id: priorBootId,
    wait_ms: 0,
  });
  assert.equal(priorBootStatus.result.isError, true);
  assert.equal(
    priorBootStatus.result.structuredContent.error_code,
    "runner_interrupted",
  );
  rmSync(priorBootPath, { recursive: true, force: true });

  const missingResultId = randomUUID();
  const missingResultPath = join(jobRoot, missingResultId);
  mkdirSync(missingResultPath, { mode: 0o700 });
  writeFileSync(
    join(missingResultPath, "state.json"),
    `${JSON.stringify({
      id: missingResultId,
      model: "sonnet",
      effort: "high",
      status: "completed",
      startedAt: Date.now() - 1_000,
      completedAt: Date.now(),
      runnerPid: null,
      launcherPid: null,
      bootStartedAt: Date.now() - uptime() * 1_000,
      workspace: null,
      mode: "advisory",
    })}\n`,
    { mode: 0o600 },
  );
  const missingResult = await client.call("ask_status", {
    job_id: missingResultId,
    wait_ms: 0,
  });
  assert.equal(missingResult.result.isError, true);
  assert.equal(
    missingResult.result.structuredContent.error_code,
    "result_unavailable",
  );
  rmSync(missingResultPath, { recursive: true, force: true });

  const afterRestart = await waitForTerminal(client, restartJobId);
  assert.equal(afterRestart.result.structuredContent.status, "completed");
  assert.equal(afterRestart.result.isError, false);

  const holdOne = await client.call("ask", {
    question: "hold-for-cancel",
    model: "fable",
  });
  const holdOneId = remember(holdOne);
  const holdTwo = await client.call("ask", {
    question: "hold-for-cancel",
    model: "opus",
  });
  const holdTwoId = remember(holdTwo);
  const overCapacity = await client.call("ask", {
    question: "should-not-start",
    model: "fable",
  });
  assert.equal(overCapacity.result.isError, true);
  assert.match(overCapacity.result.content[0].text, /concurrent jobs/i);
  assert.equal(
    overCapacity.result.structuredContent.error_code,
    "concurrency_limit",
  );
  await client.stop();

  client = new McpClient({ CLAUDE_ASK_MAX_CONCURRENT_JOBS: "2" });
  await client.initialize();
  await cancelAndWait(client, holdOneId);
  await cancelAndWait(client, holdTwoId);

  const descendantJob = await client.call("ask", {
    question: "hold-with-descendant",
    model: "fable",
  });
  const descendantJobId = remember(descendantJob);
  let descendantPid = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const streamPath = join(jobRoot, descendantJobId, "stream.jsonl");
    if (existsSync(streamPath)) {
      const events = readFileSync(streamPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      descendantPid = events.find(
        (event) => event.subtype === "descendant_pid",
      )?.pid;
      if (Number.isInteger(descendantPid)) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(Number.isInteger(descendantPid));
  try {
    await cancelAndWait(client, descendantJobId);
    assert.equal(
      await waitForProcessExit(descendantPid),
      true,
      "cancellation must terminate Claude descendants",
    );
  } finally {
    if (processExists(descendantPid)) process.kill(descendantPid, "SIGKILL");
  }

  const runnerShutdown = await client.call("ask", {
    question: "hold-for-cancel",
    model: "fable",
  });
  const runnerShutdownId = remember(runnerShutdown);
  let runnerPid;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = JSON.parse(
      readFileSync(join(jobRoot, runnerShutdownId, "state.json"), "utf8"),
    );
    runnerPid = state.runnerPid;
    if (Number.isInteger(runnerPid)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(Number.isInteger(runnerPid));
  process.kill(runnerPid, "SIGTERM");
  const interrupted = await waitForTerminal(client, runnerShutdownId);
  assert.equal(interrupted.result.isError, true);
  assert.match(interrupted.result.content[0].text, /runner (?:exited|failed)/i);
  assert.doesNotMatch(
    interrupted.result.structuredContent.next_action,
    /stderr_tail/i,
  );

  const auth = await client.call("ask", {
    question: "authentication-error",
    model: "fable",
  });
  const authJobId = remember(auth);
  const authResult = await waitForTerminal(client, authJobId);
  assert.equal(authResult.result.isError, true);
  assert.match(authResult.result.content[0].text, /authentication was rejected/i);
  const failedFollowup = await client.call("ask_followup", {
    job_id: authJobId,
    question: "recall",
  });
  assert.equal(failedFollowup.result.isError, true);
  assert.equal(
    failedFollowup.result.structuredContent.error_code,
    "parent_not_completed",
  );

  const diagnostic = await client.call("ask", {
    question: "diagnostic-error",
  });
  const diagnosticJobId = remember(diagnostic);
  const diagnosticResult = await waitForTerminal(client, diagnosticJobId);
  assert.equal(diagnosticResult.result.isError, true);
  assert.equal(
    diagnosticResult.result.structuredContent.error_code,
    "claude_failed",
  );
  assert.equal(
    diagnosticResult.result.structuredContent.message,
    "Claude Code returned an error.",
  );
  assert.match(
    diagnosticResult.result.structuredContent.stderr_tail,
    /DIAGNOSTIC_MARKER/,
  );
  assert.equal(
    typeof diagnosticResult.result.structuredContent.next_action,
    "string",
  );
  assert.equal(
    statSync(join(jobRoot, diagnosticJobId, "stderr.log")).mode & 0o777,
    0o600,
  );

  const largeStderr = await client.call("ask", {
    question: "large-stderr-error",
  });
  const largeStderrResult = await waitForTerminal(
    client,
    remember(largeStderr),
  );
  assert.equal(largeStderrResult.result.isError, true);
  assert.equal(
    largeStderrResult.result.structuredContent.stderr_truncated,
    true,
  );
  assert.ok(
    Buffer.byteLength(
      largeStderrResult.result.structuredContent.stderr_tail,
      "utf8",
    ) <= 4096,
  );

  const binaryStderr = await client.call("ask", {
    question: "binary-stderr-error",
  });
  const binaryStderrResult = await waitForTerminal(
    client,
    remember(binaryStderr),
  );
  assert.equal(binaryStderrResult.result.isError, true);
  assert.ok(
    Buffer.byteLength(
      binaryStderrResult.result.structuredContent.stderr_tail,
      "utf8",
    ) <= 4096,
  );

  const unknown = await client.call("ask_status", {
    job_id: "../../etc/passwd",
  });
  assert.equal(unknown.result.isError, true);
  await client.stop();

  const capRoot = mkdtempSync(join(tmpdir(), "claude-ask-cap-test-"));
  chmodSync(capRoot, 0o700);
  const capClient = new McpClient({
    CLAUDE_ASK_JOB_DIR: capRoot,
    CLAUDE_ASK_MAX_OUTPUT_BYTES: "1024",
  });
  await capClient.initialize();
  const large = await capClient.call("ask", {
    question: "large-output",
    model: "fable",
  });
  const largeJobId = remember(large);
  const largeResult = await waitForTerminal(capClient, largeJobId);
  assert.equal(largeResult.result.isError, true);
  assert.match(largeResult.result.content[0].text, /output safety limit/i);
  assert.equal(
    statSync(join(capRoot, largeJobId, "stream.jsonl")).size,
    1024,
  );
  await capClient.stop();
  rmSync(capRoot, { recursive: true, force: true });
}

async function liveTest() {
  const client = new McpClient();
  const workspaceRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "claude-ask-live-workspace-")),
  );
  writeFileSync(
    join(workspaceRoot, "workspace-marker.txt"),
    "CLAUDE_ASK_WORKSPACE_READ_OK\n",
    { mode: 0o600 },
  );
  try {
    await client.initialize();
    const started = await client.call("ask", {
      question: "Ответь ровно: CLAUDE_ASK_LIVE_OK",
      model: "sonnet",
    });
    const jobId = remember(started);
    const completed = await waitForTerminal(client, jobId);
    assert.equal(completed.result.isError, false);
    assert.equal(completed.result.content[0].text, "CLAUDE_ASK_LIVE_OK");
    assert.equal(completed.result.structuredContent.requested_model, "sonnet");
    assert.equal(completed.result.structuredContent.requested_effort, "high");
    assert.equal(completed.result.structuredContent.effort, "high");
    assert.equal(completed.result.structuredContent.mode, "advisory");
    assert.match(completed.result.structuredContent.resolved_model, /sonnet-5/i);
    const stream = readFileSync(join(jobRoot, jobId, "stream.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(stream.some((event) => event.type === "result"));
    assert.ok(stream.some((event) => event.type === "stream_event"));

    const memoryNonce = `CLAUDE_ASK_MEMORY_${randomUUID()}`;
    const workspaceStarted = await client.call("ask", {
      question:
        "Act as a coding agent in the current workspace. Use the shell to read workspace-marker.txt, then create agent-proof.txt containing exactly CLAUDE_ASK_AGENT_WRITE_OK followed by a newline. Use the shell to verify the written file. " +
        `Remember this nonce for a later follow-up: ${memoryNonce}. ` +
        "Then reply with exactly CLAUDE_ASK_AGENT_OK.",
      model: "sonnet",
      workspace: workspaceRoot,
    });
    const workspaceJobId = remember(workspaceStarted);
    const workspaceCompleted = await waitForTerminal(
      client,
      workspaceJobId,
    );
    assert.equal(workspaceCompleted.result.isError, false);
    assert.match(
      workspaceCompleted.result.content[0].text,
      /CLAUDE_ASK_AGENT_OK/,
    );
    assert.equal(
      workspaceCompleted.result.structuredContent.workspace,
      workspaceRoot,
    );
    assert.equal(workspaceCompleted.result.structuredContent.mode, "agent");
    assert.equal(
      readFileSync(join(workspaceRoot, "agent-proof.txt"), "utf8"),
      "CLAUDE_ASK_AGENT_WRITE_OK\n",
    );

    const followup = await client.call("ask_followup", {
      job_id: workspaceJobId,
      question:
        "Recall the nonce from my previous message without reading the test source. Use the shell to read agent-proof.txt in the inherited workspace. Reply with the nonce and the file contents.",
    });
    const followupCompleted = await waitForTerminal(
      client,
      remember(followup),
    );
    assert.equal(followupCompleted.result.isError, false);
    assert.match(followupCompleted.result.content[0].text, new RegExp(memoryNonce));
    assert.match(
      followupCompleted.result.content[0].text,
      /CLAUDE_ASK_AGENT_WRITE_OK/,
    );
    assert.equal(
      followupCompleted.result.structuredContent.parent_job_id,
      workspaceJobId,
    );
    assert.equal(
      followupCompleted.result.structuredContent.workspace,
      workspaceRoot,
    );
  } finally {
    await client.stop();
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

async function liveReviewTest() {
  const workspace = realpathSync(process.env.CLAUDE_ASK_LIVE_REVIEW_WORKSPACE);
  const model = process.env.CLAUDE_ASK_LIVE_MODEL || "claude-sonnet-5-5";
  const memoryNonce = `REVIEW_MEMORY_${randomUUID()}`;
  let client = new McpClient();
  try {
    await client.initialize();
    const started = await client.call("ask", {
      question:
        "Read change.patch, then read the affected source and tests. Review this change for correctness and regressions. Do not edit files. Report only actionable issues introduced by the patch, with file paths, line numbers, and a concrete failure scenario. If none are supported, say so. End with a short description of what you inspected and any validation limits. " +
        `Remember this nonce for a later follow-up: ${memoryNonce}.`,
      model,
      mode: "review",
      workspace,
      name: "Sonnet 5.5 review of recent change",
      effort: "high",
      max_budget_usd: 5,
    });
    assert.equal(started.result.isError, false);
    const jobId = remember(started);
    assert.equal(started.result.structuredContent.status, "running");
    process.stdout.write(`Review job started: ${jobId}; restarting MCP server\n`);
    await client.stop();
    client = new McpClient();
    await client.initialize();
    const discovered = await client.call("list_jobs", {});
    assert.ok(discovered.result.structuredContent.jobs.some(
      (job) => job.job_id === jobId,
    ));
    const completed = await waitForTerminal(client, jobId);
    assert.equal(completed.result.isError, false, JSON.stringify(completed.result));
    assert.equal(completed.result.structuredContent.mode, "review");
    assert.equal(completed.result.structuredContent.requested_model, model);
    assert.match(completed.result.structuredContent.resolved_model, /sonnet[-.]5[-.]5/i);
    assert.ok(
      Object.keys(completed.result.structuredContent.model_usage || {})
        .some((name) => /sonnet[-.]5[-.]5/i.test(name)),
      "Usage must confirm Sonnet 5.5 actually answered.",
    );
    const events = readFileSync(join(jobRoot, jobId, "stream.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const tools = events.flatMap((event) => event.type === "assistant"
      ? (event.message?.content || []).filter((block) => block.type === "tool_use").map((block) => block.name)
      : []);
    assert.ok(
      tools.includes("Read"),
      "The review must inspect the actual patch and source files.",
    );
    assert.ok(
      tools.every((tool) => ["Read", "Glob", "Grep"].includes(tool)),
      JSON.stringify(tools),
    );
    process.stdout.write(`Review completed on ${completed.result.structuredContent.resolved_model}; checking follow-up\n`);
    const followup = await client.call("ask_followup", {
      job_id: jobId,
      question: "Without reading any files, recall the nonce from my first request, then summarize the purpose of the change you just reviewed in one sentence.",
      name: "Review continuation after MCP reconnect",
      max_budget_usd: 5,
    });
    const continued = await waitForTerminal(client, remember(followup));
    assert.equal(continued.result.isError, false, JSON.stringify(continued.result));
    assert.match(continued.result.content[0].text, new RegExp(memoryNonce));
    assert.equal(continued.result.structuredContent.parent_job_id, jobId);
    assert.equal(continued.result.structuredContent.mode, "review");
    assert.equal(continued.result.structuredContent.requested_model, model);
    assert.notEqual(
      continued.result.structuredContent.session_id,
      completed.result.structuredContent.session_id,
    );
    const evidence = {
      reviewed_patch_sha256: sha256(readFileSync(join(workspace, "change.patch"))),
      review: completed.result.structuredContent,
      followup: continued.result.structuredContent,
      review_tools: tools,
      mcp_restart_survived: true,
      context_recalled: true,
    };
    if (process.env.CLAUDE_ASK_LIVE_RESULT_PATH) {
      writeFileSync(
        process.env.CLAUDE_ASK_LIVE_RESULT_PATH,
        JSON.stringify(evidence, null, 2) + "\n",
        { mode: 0o600 },
      );
    }
    process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
  } finally {
    await client.stop();
  }
}

async function cleanup() {
  if (!existsSync(jobRoot)) return;
  for (const entry of readdirSync(jobRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cancelPath = join(jobRoot, entry.name, "cancel.request");
    try {
      const fd = openSync(cancelPath, "wx", 0o600);
      closeSync(fd);
    } catch {
      // Terminal or already-cancelling jobs need no action.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 750));
  rmSync(jobRoot, { recursive: true, force: true });
}

let succeeded = false;
try {
  if (live && process.env.CLAUDE_ASK_LIVE_REVIEW_WORKSPACE) {
    await liveReviewTest();
  }
  else if (live) await liveTest();
  else await fakeTests();
  succeeded = true;
  process.stdout.write(`claude-ask MCP ${live ? "live " : ""}test passed\n`);
} finally {
  if (!live || succeeded) await cleanup();
  else process.stderr.write(
    `Live job diagnostics retained at ${jobRoot}; running jobs were not cancelled.\n`,
  );
}
