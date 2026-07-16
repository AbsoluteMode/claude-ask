# Claude Ask

A personal Codex plugin exposing asynchronous MCP tools backed by the local
Claude Code CLI.

The caller supplies the complete prompt and chooses `fable` or `opus`. For
ordinary consultations Claude runs with `--safe-mode` and no tools. For a code
review, the caller may pass an explicit absolute `workspace`; Claude then runs
with that directory as its real working directory and receives only the
built-in `Read`, `Glob`, and `Grep` tools. It cannot edit files or run shell
commands.

`ask` starts a detached background job and immediately returns a `job_id`.
Claude uses streaming JSON with partial messages and writes model output to a
private progress file. Poll `ask_status` until the file-backed job completes;
each response reports byte growth plus recent stream-event, partial-text, and
partial-thinking counters. There is no elapsed-time or idle-time deadline. An
unchanged file is a waiting job, never an automatic cancellation signal.

This asynchronous contract keeps every MCP `tools/call` short. The detached
runner survives an MCP server restart and the same `job_id` remains queryable.
A machine reboot or runner crash is reported explicitly as an interrupted job;
it is never presented as a model answer. Only explicit `cancel_ask`, the output
safety limit, Claude/runner failure, or operating-system termination ends work.

Job directories are mode 0700 and every state, result, cancel, and stream file
is mode 0600. The prompt is never put in argv, environment variables, state, or
diagnostic logs: it goes directly to the runner and Claude over stdin. Claude's
private output stream and completed result are retained for 24 hours, then
removed. At most four jobs run concurrently by default.

## Requirements

- Claude Code available at `~/.local/bin/claude`, or set `CLAUDE_ASK_CLI`.
- A working Claude Code login (`claude auth status`).

## Test

```bash
node scripts/test-server.mjs
```

The test uses a fake Claude executable and does not consume model usage.

After authenticating Claude Code, an explicit paid/limited-usage smoke test is available with `CLAUDE_ASK_LIVE=1 node scripts/test-server.mjs`.

Optional controls are `CLAUDE_ASK_JOB_DIR`,
`CLAUDE_ASK_MAX_CONCURRENT_JOBS`, `CLAUDE_ASK_MAX_OUTPUT_BYTES`, and
`CLAUDE_ASK_COMPLETED_RETENTION_MS`. None of them is a wall-clock or idle
deadline.

## Workspace reviews

The `ask` input accepts:

```json
{
  "question": "Review the current implementation and report blockers.",
  "model": "fable",
  "workspace": "/absolute/path/to/repository"
}
```

The workspace must already exist and be an absolute directory. It is
canonicalized before the job starts, recorded in private job state for audit,
and returned by `ask_status`. Workspace access is opt-in per job; no global
working-directory environment variable is used.
