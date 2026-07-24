---
name: claude-ask
description: Use when the user explicitly requests Claude, Sonnet, Fable, or Opus, or when an independent Claude perspective would materially improve a coding task, review, or diagnosis.
---

# Claude Ask

Use Claude as an independent coding agent or second opinion. Treat its output as evidence to verify, not an authority to copy blindly.

## Prompt and access

Send a complete, natural request with the desired result, observed facts, and material constraints. For an independent review or diagnosis, omit Codex's suspected cause and preferred fix from the initial question.

Pass the absolute `workspace` whenever Claude needs repository context. Workspace mode is a full autonomous Claude Code session: default tools, shell, file writes, user/project instructions and hooks, network access, and configured MCP servers, skills, and plugins remain available with bypassed interactive permission prompts. The workspace is the working directory and intended scope, not an OS sandbox. If the task is review-only, explicitly tell Claude not to edit.

Without `workspace`, Claude receives only the question and has no tools. Use that mode for self-contained advice.

## Choose cost and depth

| Setting | Use |
|---|---|
| `sonnet` | Default for implementation, diagnosis, and review |
| `opus` | High-risk security, concurrency, state, or data-loss work; or explicit request |
| `fable` | Only when explicitly requested |
| `medium` effort | Quick, bounded questions |
| `high` effort | Default |
| `xhigh` effort | Difficult multi-file or ambiguous work |
| `max` effort | Exceptional cases where depth justifies the cost |

Use `name` for recognizable jobs and `max_budget_usd` when cost needs a hard ceiling.

## Job workflow

1. Call `ask`; retain its `job_id`.
2. Poll `ask_status` with `previous_output_bytes` and `wait_ms=30000` until `completed`, `error`, or `cancelled`. Idle output is not failure.
3. Use `list_jobs` to recover a lost ID or inspect recent work.
4. Use `ask_followup` only after completion when Claude should retain the parent session context. It inherits model, workspace, and effort unless overridden, then forks a new session branch. Budget is set per call. Claude stores resumable sessions outside the plugin's job directory.
5. Use `cancel_ask` only for an explicit cancellation or a clearly replaced request.

Inspect Claude's edits and verification independently before reporting success.
