---
name: claude-ask
description: Ask a local Claude Code Fable or Opus model for a second opinion when the user explicitly requests Claude, Fable, or Opus, or when an independent Claude perspective is useful.
---

# Claude Ask

Use the `ask`, `ask_status`, and when explicitly needed `cancel_ask` tools
exposed by the `claude-ask` MCP server.

Compose the complete question on the Codex side. Include the relevant context,
requested role, output format, and constraints directly in `question`; the MCP
server does not add a task preset.

When Claude needs to inspect repository files, always pass the current workspace
root as the absolute `workspace` argument. Do not merely mention the path inside
the question. The server validates and canonicalizes the directory, starts
Claude with that directory as its actual working directory, and enables only
the built-in `Read`, `Glob`, and `Grep` tools. Claude cannot edit files or run
shell commands. Include any test output, git diff facts, or command-derived
evidence that Claude also needs directly in the question.

Choose `fable` by default. Choose `opus` when the user asks for Opus or when the question needs the strongest available Claude reasoning.

Without `workspace`, Claude runs in safe mode with no tools and receives only
the supplied question. Use this mode for ordinary advisory consultations that
do not require repository access.

`ask` is asynchronous and returns a `job_id` immediately. Poll `ask_status`
with that job ID, the previous `output_bytes`, and `wait_ms=30000` until status
is `completed`, `error`, or `cancelled`. The detached job survives an MCP server
restart, so keep the job ID and resume polling it. There is no job deadline. A
growing `output_bytes` value confirms streamed model activity; the partial text
and thinking counters provide additional progress evidence. An unchanged value
is not an error and must not cause cancellation. Keep polling while the user
wants the answer, and share concise progress updates during long consultations.

Call `cancel_ask` only when the user explicitly cancels the consultation or the
active request has clearly been replaced. Do not cancel merely because output
has been idle or the model is taking a long time.

Treat Claude's response as advisory input. Check it against the repository and user requirements before acting on it.
