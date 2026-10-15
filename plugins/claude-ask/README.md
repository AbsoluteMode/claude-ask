# Claude Ask

A personal Codex plugin that exposes locally authenticated Claude Code models as persistent asynchronous MCP jobs.

`claude-opus-5` with `high` effort is the default, preserving the existing personal installation. Model aliases and full model IDs such as `claude-sonnet-5-5` are accepted. Each job can select `low`, `medium`, `high`, `xhigh`, or `max` effort, set a human-readable name, and enforce a `max_budget_usd` ceiling.

## Tools

| Tool | Purpose |
|---|---|
| `ask` | Start an advisory, read-only review, or workspace-agent job |
| `ask_followup` | Resume a completed job's Claude session and fork an independent branch |
| `ask_status` | Wait for progress or retrieve the terminal result |
| `list_jobs` | List recent jobs and recover lost IDs |
| `cancel_ask` | Explicitly cancel a running job and its process tree |

`ask` returns a `job_id` immediately. Poll `ask_status` until the status is `completed`, `error`, or `cancelled`. There is no elapsed-time or idle-time deadline; unchanged output means the job is still waiting. Progress includes output bytes, estimated thinking tokens, tool-call count, elapsed time, and the last event type.

Completed sessions remain resumable in Claude Code's normal session storage, outside the plugin job directory and its 24-hour cleanup. `ask_followup` inherits the parent model, workspace, mode, and effort unless effort is overridden. It uses Claude Code resume-and-fork semantics, so the parent remains unchanged. A budget applies only to the new call.

## Access modes

With an absolute `workspace`, full `mode: "agent"` is the default for repository
assistance, including implementation, investigation, and code reviews. Claude can
run shell commands, inspect Git, edit files, and run tests. It inherits normal
user/project instructions, hooks, network access, and configured MCP servers,
skills, and plugins. Interactive permission prompts are bypassed because a
detached job cannot answer them.

Without `workspace`, advisory mode receives only the question and has no tools.

`mode: "review"` is an optional restriction for an explicit read-only request.
It exposes only Read, Glob, and Grep and disables shell, file writes,
customizations, and MCP servers. It cannot run Git or tests. Follow-ups preserve
the selected mode.

The workspace is Claude's actual working directory and intended task scope, not a hard operating-system sandbox. Claude runs as the current user and can technically access other paths and the network. Only pass trusted workspaces and prompts.

Example:

```json
{
  "question": "Investigate the failure, implement a fix, run the relevant tests, and summarize the result.",
  "model": "claude-sonnet-5-5",
  "mode": "agent",
  "workspace": "/absolute/path/to/repository",
  "name": "implement and verify a fix",
  "effort": "high",
  "max_budget_usd": 5
}
```

## Persistence and diagnostics

Jobs survive MCP server restarts and remain queryable by ID. Boot-aware recovery distinguishes a live detached runner from an interrupted job. Cancellation signals Claude's whole process group on POSIX systems, with a direct-child fallback on Windows.

If an MCP request fails, reconnect and query the same `job_id`; use `list_jobs` if the start response was lost. Do not start a duplicate job or cancel a waiting job merely because output has not grown.

Errors return structured `error_code`, `next_action`, `stderr_tail`, and `stderr_truncated` fields. Claude stderr is stored privately up to 1 MiB; only a bounded 4 KiB tail is returned. Output-limit errors warn that workspace changes may already exist.

Job directories use mode 0700; state, result, stream, stderr, and cancellation files use mode 0600. Prompts never appear in argv, environment variables, state, or diagnostic logs: they travel over stdin. Completed data is retained for 24 hours by default. Up to four jobs run concurrently.

## Requirements and tests

- Claude Code on `PATH` or at `~/.local/bin/claude`; alternatively set `CLAUDE_ASK_CLI`.
- A working Claude Code login (`claude auth status`).

Run the no-usage test suite:

```bash
node scripts/test-server.mjs
```

An authenticated paid/limited-usage smoke test is opt-in:

```bash
CLAUDE_ASK_LIVE=1 node scripts/test-server.mjs
```

To review a real change and verify recovery during an MCP restart, prepare a
workspace containing `change.patch` and the affected source and test files:

```bash
CLAUDE_ASK_LIVE=1 \
CLAUDE_ASK_LIVE_REVIEW_WORKSPACE=/absolute/path/to/review-snapshot \
CLAUDE_ASK_LIVE_MODEL=claude-sonnet-5-5 \
node scripts/test-server.mjs
```

This checks the actual resolved model, read-only tool calls, discovery after
restart, and a follow-up that recalls the earlier context. Set
`CLAUDE_ASK_LIVE_RESULT_PATH` to save the answers and verification metadata.
On a live-test failure, diagnostics and running jobs are retained for recovery.

Optional controls are `CLAUDE_ASK_JOB_DIR`, `CLAUDE_ASK_MAX_CONCURRENT_JOBS`, `CLAUDE_ASK_MAX_OUTPUT_BYTES`, and `CLAUDE_ASK_COMPLETED_RETENTION_MS`. None sets a wall-clock or idle deadline.
