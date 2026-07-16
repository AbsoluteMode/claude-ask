#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
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
}

async function fakeTests() {
  let client = new McpClient({
    CLAUDE_ASK_MAX_CONCURRENT_JOBS: "2",
    FAKE_CLAUDE_DELAY_MS: "300",
  });
  await client.initialize();
  const listed = await client.request("tools/list");
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ["ask", "ask_status", "cancel_ask"],
  );
  assert.match(listed.result.tools[0].description, /no elapsed-time/i);
  assert.ok(listed.result.tools[0].inputSchema.properties.workspace);

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
    model: "fable",
    workspace: workspaceRoot,
  });
  const workspaceJobId = remember(workspaceStarted);
  const workspaceResult = await waitForTerminal(client, workspaceJobId);
  assert.equal(workspaceResult.result.isError, false);
  assert.equal(workspaceResult.result.content[0].text, "WORKSPACE_OK");
  assert.equal(workspaceResult.result.structuredContent.workspace, workspaceRoot);
  rmSync(workspaceRoot, { recursive: true, force: true });

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
  assert.equal(
    exactResult.result.structuredContent.resolved_model,
    "claude-opus-fake",
  );

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

  let sawPartialThinking = false;
  let sawPartialText = false;
  let previousBytes = unchanged.result.structuredContent.output_bytes;
  for (;;) {
    status = await client.call("ask_status", {
      job_id: idleJobId,
      previous_output_bytes: previousBytes,
      wait_ms: 250,
    });
    previousBytes = status.result.structuredContent.output_bytes;
    if (status.result.structuredContent.partial_thinking_chars > 0) {
      sawPartialThinking = true;
    }
    if (status.result.structuredContent.partial_text_chars > 0) {
      sawPartialText = true;
    }
    if (status.result.structuredContent.status === "completed") break;
  }
  assert.equal(sawPartialThinking, true);
  assert.equal(sawPartialText, true);

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
  await client.stop();

  client = new McpClient({ CLAUDE_ASK_MAX_CONCURRENT_JOBS: "2" });
  await client.initialize();
  await cancelAndWait(client, holdOneId);
  await cancelAndWait(client, holdTwoId);

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
  assert.match(interrupted.result.content[0].text, /runner exited/i);

  const auth = await client.call("ask", {
    question: "authentication-error",
    model: "fable",
  });
  const authResult = await waitForTerminal(client, remember(auth));
  assert.equal(authResult.result.isError, true);
  assert.match(authResult.result.content[0].text, /authentication was rejected/i);

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
      model: "fable",
    });
    const jobId = remember(started);
    const completed = await waitForTerminal(client, jobId);
    assert.equal(completed.result.isError, false);
    assert.equal(completed.result.content[0].text, "CLAUDE_ASK_LIVE_OK");
    assert.equal(completed.result.structuredContent.requested_model, "fable");
    assert.match(completed.result.structuredContent.resolved_model, /fable/i);
    const stream = readFileSync(join(jobRoot, jobId, "stream.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(stream.some((event) => event.type === "result"));
    assert.ok(stream.some((event) => event.type === "stream_event"));

    const workspaceStarted = await client.call("ask", {
      question:
        "Use the read-only file tools to read workspace-marker.txt in the current workspace. Reply with exactly its single-line content and nothing else.",
      model: "fable",
      workspace: workspaceRoot,
    });
    const workspaceCompleted = await waitForTerminal(
      client,
      remember(workspaceStarted),
    );
    assert.equal(workspaceCompleted.result.isError, false);
    assert.equal(
      workspaceCompleted.result.content[0].text,
      "CLAUDE_ASK_WORKSPACE_READ_OK",
    );
    assert.equal(
      workspaceCompleted.result.structuredContent.workspace,
      workspaceRoot,
    );
  } finally {
    await client.stop();
    rmSync(workspaceRoot, { recursive: true, force: true });
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

try {
  if (live) await liveTest();
  else await fakeTests();
  process.stdout.write(`claude-ask MCP ${live ? "live " : ""}test passed\n`);
} finally {
  await cleanup();
}
