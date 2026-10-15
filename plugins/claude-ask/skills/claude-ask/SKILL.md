---
name: claude-ask
description: Use when, and only when, the user explicitly asks Codex to consult or delegate work to Claude, Sonnet, Fable, or Opus. Do not use for mere mentions or because a second opinion might help.
---

# Claude Ask

Use Claude only when the user explicitly asks for consultation or delegation. Verify its conclusions and edits independently.

## Request and access

Send the desired result, observed facts, and material constraints. For an independent review, omit Codex's suspected cause and preferred fix from the initial request.

- With an absolute `workspace`, use full `mode: "agent"` by default for repository help, including investigation and reviews. Claude can run shell commands, inspect Git, edit files, and run tests. It inherits user/project instructions, hooks, network access, and configured MCP servers, skills, and plugins. Interactive permission prompts are bypassed. Workspace is the intended task scope, not an OS sandbox.
- Without `workspace`, advisory mode has no tools and receives only the question. Include all required evidence in the question.
- Use `mode: "review"` only when the user explicitly asks to restrict Claude to reading. This optional mode exposes Read, Glob, and Grep and disables shell, writes, hooks, skills, plugins, project customizations, and MCP servers.

Describe the concrete work Claude should perform and the relevant constraints. A code review can use the full agent's Git and test tools; it does not require the restricted review mode.

## Model and effort

Model aliases (`sonnet`, `opus`, `fable`, `haiku`) track Claude Code's configured targets. To honor a requested version, pass its full ID, for example `claude-sonnet-5-5` for Sonnet 5.5. Check `resolved_model` and `model_usage` in the result rather than relying on the requested name. The default remains `claude-opus-5` with `high` effort.

Effort supports `low`, `medium`, `high`, `xhigh`, and `max`. Use `name` to identify jobs and `max_budget_usd` when a cost ceiling is wanted.

## Finish the conversation

1. Call `ask` and retain `job_id`; the response may already be terminal.
2. Poll `ask_status` with `previous_output_bytes` and `wait_ms=30000` until `completed`, `error`, or `cancelled`. Idle output is not failure and is never a reason to cancel.
3. If the MCP connection fails, reconnect and query the same job. Use `list_jobs` to recover a lost ID before starting another request. Detached jobs survive MCP restarts.
4. Use `ask_followup` after successful completion to retain the model, workspace, access mode, effort, and session context. It forks an independent session; the budget is per call.
5. On errors, inspect `error_code`, `next_action`, and `stderr_tail`; report a terminal failure instead of claiming success. Cancel only for an explicit cancellation or a clearly replaced request.
