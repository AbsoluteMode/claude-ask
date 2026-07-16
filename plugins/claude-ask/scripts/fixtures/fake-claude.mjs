#!/usr/bin/env node

import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const modelIndex = args.indexOf("--model");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "missing";
const requiredFlags = [
  "-p",
  "--safe-mode",
  "--disable-slash-commands",
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
const toolsIndex = args.indexOf("--tools");
const allowedToolsIndex = args.indexOf("--allowedTools");
const noToolsInvocation = toolsIndex >= 0 && args[toolsIndex + 1] === "";
const readOnlyInvocation =
  toolsIndex >= 0 &&
  args[toolsIndex + 1] === "Read,Glob,Grep" &&
  allowedToolsIndex >= 0 &&
  args[allowedToolsIndex + 1] === "Read,Glob,Grep";
const safeInvocation =
  requiredFlags.every((flag) => args.includes(flag)) &&
  (noToolsInvocation || readOnlyInvocation);

let question = "";
for await (const chunk of process.stdin) question += chunk;

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const init = {
  type: "system",
  subtype: "init",
  model: `claude-${model}-fake`,
  session_id: "fake-session",
};
emit(init);

if (!safeInvocation) {
  emit({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "unsafe test invocation",
    session_id: "fake-session",
  });
  process.exitCode = 2;
} else if (question === "hold-for-cancel") {
  await new Promise((resolve) => setInterval(resolve, 60_000));
} else if (question === "large-output") {
  emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "x".repeat(16 * 1024) },
    },
  });
  await delay(5_000);
} else {
  if (question === "idle-progress" || question === "restart-progress") {
    await delay(Number(process.env.FAKE_CLAUDE_DELAY_MS || 250));
    emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "considering" },
      },
    });
    await delay(Number(process.env.FAKE_CLAUDE_DELAY_MS || 250));
    emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "answering" },
      },
    });
    await delay(Number(process.env.FAKE_CLAUDE_DELAY_MS || 250));
  }
  if (question === "authentication-error") {
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      api_error_status: 401,
      result: "authentication credentials rejected",
      session_id: "fake-session",
    });
    process.exitCode = 1;
  } else if (question.startsWith("workspace-probe:")) {
    const expectedWorkspace = question.slice("workspace-probe:".length);
    const workspaceOkay =
      readOnlyInvocation && process.cwd() === expectedWorkspace;
    emit({
      type: "result",
      subtype: workspaceOkay ? "success" : "error_during_execution",
      is_error: !workspaceOkay,
      result: workspaceOkay ? "WORKSPACE_OK" : "workspace invocation mismatch",
      session_id: "fake-session",
    });
    if (!workspaceOkay) process.exitCode = 2;
  } else {
    const digest = createHash("sha256").update(question).digest("hex");
    emit({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "fake complete" }],
      },
      session_id: "fake-session",
    });
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: `fake:${model}:${digest}`,
      session_id: "fake-session",
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {
        [`claude-${model}`]: { inputTokens: 1, outputTokens: 1 },
      },
    });
  }
}
