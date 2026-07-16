import { randomUUID, createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export const SUPPORTED_MODELS = new Set(["fable", "opus"]);
export const MAX_QUESTION_CHARS = 200_000;
export const MAX_OUTPUT_BYTES = boundedInteger(
  process.env.CLAUDE_ASK_MAX_OUTPUT_BYTES,
  64 * 1024 * 1024,
  1024,
  64 * 1024 * 1024,
);
export const MAX_CONCURRENT_JOBS = boundedInteger(
  process.env.CLAUDE_ASK_MAX_CONCURRENT_JOBS,
  4,
  1,
  32,
);
export const COMPLETED_JOB_RETENTION_MS = boundedInteger(
  process.env.CLAUDE_ASK_COMPLETED_RETENTION_MS,
  24 * 60 * 60 * 1000,
  60_000,
  7 * 24 * 60 * 60 * 1000,
);
export const JOB_DIR =
  process.env.CLAUDE_ASK_JOB_DIR ||
  join(tmpdir(), `claude-ask-${process.getuid?.() ?? "user"}`);
export const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateWorkspace(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 4096 || !isAbsolute(value)) {
    throw new Error("Workspace must be an absolute directory path.");
  }
  const canonical = realpathSync(value);
  const current = lstatSync(canonical);
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw new Error("Workspace must be a real directory.");
  }
  return canonical;
}

function boundedInteger(raw, fallback, minimum, maximum) {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `Invalid integer configuration; expected ${minimum}..${maximum}.`,
    );
  }
  return parsed;
}

export function ensurePrivateDirectory(path) {
  try {
    const current = lstatSync(path);
    if (!current.isDirectory() || current.isSymbolicLink()) {
      throw new Error("Claude Ask job path must be a real directory.");
    }
    if (
      typeof process.getuid === "function" &&
      current.uid !== process.getuid()
    ) {
      throw new Error("Claude Ask job directory is owned by another user.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  chmodSync(path, 0o700);
}

export function createPrivateJobDirectory() {
  ensurePrivateDirectory(JOB_DIR);
  for (;;) {
    const id = randomUUID();
    const path = join(JOB_DIR, id);
    try {
      mkdirSync(path, { mode: 0o700 });
      chmodSync(path, 0o700);
      return { id, path };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

export function jobPaths(jobPath) {
  return {
    state: join(jobPath, "state.json"),
    result: join(jobPath, "result.json"),
    stream: join(jobPath, "stream.jsonl"),
    cancel: join(jobPath, "cancel.request"),
  };
}

export function atomicWriteJson(path, value) {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, path);
  chmodSync(path, 0o600);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function questionDigest(question) {
  return createHash("sha256").update(question, "utf8").digest("hex");
}

export function openPrivateFile(path) {
  const fd = openSync(path, "wx", 0o600);
  chmodSync(path, 0o600);
  return fd;
}

export function safeClose(fd) {
  if (fd === null || fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // File descriptors are best-effort during process error/close races.
  }
}

export function fileProgress(path, startedAt) {
  try {
    const stat = statSync(path);
    return {
      bytes: stat.size,
      lastGrowthAt: stat.mtimeMs,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { bytes: 0, lastGrowthAt: startedAt };
  }
}

function jsonEvents(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Claude Code returned no JSON output.");

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const events = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // Claude occasionally writes a diagnostic line. A final result event is
        // still authoritative, so ignore diagnostics without echoing them.
      }
    }
    if (events.length === 0) {
      throw new Error("Claude Code output was not valid stream JSON.");
    }
    return events;
  }
}

export function parseClaudeStream(stdout) {
  const events = jsonEvents(stdout);
  const resultEvent = events.findLast((event) => event?.type === "result");
  if (!resultEvent) {
    throw new Error("Claude Code stream did not contain a result event.");
  }
  const initEvent = events.find(
    (event) => event?.type === "system" && event?.subtype === "init",
  );
  return {
    event: resultEvent,
    result: {
      answer:
        typeof resultEvent.result === "string"
          ? resultEvent.result
          : JSON.stringify(resultEvent.result ?? ""),
      requested_model: null,
      resolved_model: initEvent?.model || null,
      session_id: resultEvent.session_id || initEvent?.session_id || null,
      total_cost_usd: resultEvent.total_cost_usd ?? null,
      usage: resultEvent.usage || null,
      model_usage: resultEvent.modelUsage || resultEvent.model_usage || null,
    },
  };
}

export function streamSummary(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        json_events: 0,
        partial_text_chars: 0,
        partial_thinking_chars: 0,
        last_event_type: null,
      };
    }
    throw error;
  }

  let jsonEventsCount = 0;
  let partialTextChars = 0;
  let partialThinkingChars = 0;
  let lastEventType = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    jsonEventsCount += 1;
    const event = item?.type === "stream_event" ? item.event : item;
    lastEventType = event?.type || item?.type || lastEventType;
    const delta = event?.delta;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      partialTextChars += delta.text.length;
    }
    if (
      delta?.type === "thinking_delta" &&
      typeof delta.thinking === "string"
    ) {
      partialThinkingChars += delta.thinking.length;
    }
  }
  return {
    json_events: jsonEventsCount,
    partial_text_chars: partialTextChars,
    partial_thinking_chars: partialThinkingChars,
    last_event_type: lastEventType,
  };
}

export function isAuthenticationError(parsedEvent) {
  return (
    parsedEvent?.api_error_status === 401 ||
    /authenticate|authentication credentials/i.test(parsedEvent?.result || "")
  );
}
