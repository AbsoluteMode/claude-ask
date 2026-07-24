#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const modelIndex = args.indexOf("--model");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "missing";
const effortIndex = args.indexOf("--effort");
const effort = effortIndex >= 0 ? args[effortIndex + 1] : "missing";
const budgetIndex = args.indexOf("--max-budget-usd");
const budget = budgetIndex >= 0 ? args[budgetIndex + 1] : null;
const sessionIndex = args.indexOf("--session-id");
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : null;
const resumeIndex = args.indexOf("--resume");
const resumeSessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : null;
const forksSession = args.includes("--fork-session");
const requiredFlags = [
  "-p",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--input-format",
  "text",
];
const toolsIndex = args.indexOf("--tools");
const noToolsInvocation =
  toolsIndex >= 0 &&
  args[toolsIndex + 1] === "" &&
  args.includes("--safe-mode") &&
  args.includes("--disable-slash-commands") &&
  args.includes("--permission-mode") &&
  args.includes("dontAsk");
const agentInvocation =
  toolsIndex >= 0 &&
  args[toolsIndex + 1] === "default" &&
  args.includes("--dangerously-skip-permissions") &&
  args.includes("--append-system-prompt") &&
  !args.includes("--safe-mode") &&
  !args.includes("--disable-slash-commands");
const safeInvocation =
  requiredFlags.every((flag) => args.includes(flag)) &&
  (noToolsInvocation || agentInvocation);

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
  session_id:
    sessionId || (resumeSessionId ? "fake-followup-session" : "fake-session"),
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
} else if (question === "hold-with-descendant") {
  const descendant = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 60_000)",
    ],
    { stdio: "ignore" },
  );
  emit({
    type: "system",
    subtype: "descendant_pid",
    pid: descendant.pid,
    session_id: sessionId || "fake-session",
  });
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
      type: "system",
      subtype: "thinking_tokens",
      estimated_tokens: 75,
      estimated_tokens_delta: 75,
      session_id: sessionId || "fake-session",
    });
    emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "considering" },
      },
    });
    await delay(Number(process.env.FAKE_CLAUDE_DELAY_MS || 250));
    emit({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "fake-tool-use",
            name: "Read",
            input: { file_path: "fake.txt" },
          },
        ],
      },
      session_id: sessionId || "fake-session",
    });
    emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "answering" },
      },
    });
    await delay(Number(process.env.FAKE_CLAUDE_DELAY_MS || 250));
  }
  if (question === "option-probe") {
    const optionInvocation =
      effort === "medium" &&
      budget === "1.25" &&
      /^[0-9a-f-]{36}$/i.test(sessionId || "") &&
      !args.includes("--no-session-persistence");
    emit({
      type: "result",
      subtype: optionInvocation ? "success" : "error_during_execution",
      is_error: !optionInvocation,
      result: optionInvocation ? "OPTIONS_OK" : "option invocation mismatch",
      session_id: sessionId || "fake-session",
    });
    if (!optionInvocation) process.exitCode = 2;
  } else if (question === "default-effort-probe") {
    const defaultEffortInvocation = effort === "high";
    emit({
      type: "result",
      subtype: defaultEffortInvocation ? "success" : "error_during_execution",
      is_error: !defaultEffortInvocation,
      result: defaultEffortInvocation
        ? "DEFAULT_EFFORT_OK"
        : "default effort mismatch",
      session_id: sessionId || "fake-session",
    });
    if (!defaultEffortInvocation) process.exitCode = 2;
  } else if (question === "recall") {
    const followupInvocation =
      agentInvocation &&
      effort === "xhigh" &&
      budget === "2" &&
      /^[0-9a-f-]{36}$/i.test(resumeSessionId || "") &&
      forksSession &&
      sessionId === null;
    emit({
      type: "result",
      subtype: followupInvocation ? "success" : "error_during_execution",
      is_error: !followupInvocation,
      result: followupInvocation ? "FOLLOWUP_OK" : "follow-up invocation mismatch",
      session_id: "fake-followup-session",
    });
    if (!followupInvocation) process.exitCode = 2;
  } else if (question === "authentication-error") {
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      api_error_status: 401,
      result: "authentication credentials rejected",
      session_id: sessionId || "fake-session",
    });
    process.exitCode = 1;
  } else if (question === "diagnostic-error") {
    process.stderr.write("DIAGNOSTIC_MARKER\n");
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "diagnostic failure",
      session_id: sessionId || "fake-session",
    });
    process.exitCode = 1;
  } else if (question === "large-stderr-error") {
    process.stderr.write("e".repeat(1024 * 1024 + 8192));
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "large stderr failure",
      session_id: sessionId || "fake-session",
    });
    process.exitCode = 1;
  } else if (question === "binary-stderr-error") {
    process.stderr.write(Buffer.alloc(8192, 0xff));
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "binary stderr failure",
      session_id: sessionId || "fake-session",
    });
    process.exitCode = 1;
  } else if (question.startsWith("workspace-probe:")) {
    const expectedWorkspace = question.slice("workspace-probe:".length);
    const workspaceOkay =
      agentInvocation && process.cwd() === expectedWorkspace;
    emit({
      type: "result",
      subtype: workspaceOkay ? "success" : "error_during_execution",
      is_error: !workspaceOkay,
      result: workspaceOkay ? "WORKSPACE_OK" : "workspace invocation mismatch",
      session_id: sessionId || "fake-session",
    });
    if (!workspaceOkay) process.exitCode = 2;
  } else {
    const digest = createHash("sha256").update(question).digest("hex");
    emit({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "fake complete" }],
      },
      session_id: sessionId || "fake-session",
    });
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: `fake:${model}:${digest}`,
      session_id: sessionId || "fake-session",
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {
        [`claude-${model}`]: { inputTokens: 1, outputTokens: 1 },
      },
    });
  }
}
