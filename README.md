# Claude Ask

Claude Ask is an open-source Codex plugin that runs a locally authenticated
Claude Code model as an independent second opinion or full autonomous coding
agent.

It provides five persistent asynchronous MCP tools:

- `ask` starts an advisory, read-only review, or workspace-agent job;
- `ask_followup` resumes a completed Claude session and forks a new branch;
- `ask_status` waits for progress or returns the final result;
- `list_jobs` lists recent jobs and recovers lost IDs;
- `cancel_ask` explicitly cancels a job and its process tree.

Jobs support a human-readable name, `low | medium | high | xhigh | max` effort
(`high` by default), and an optional `max_budget_usd` ceiling.

## Install in Codex

Add this Git repository as a marketplace and install the plugin:

```bash
codex plugin marketplace add AbsoluteMode/claude-ask
codex plugin add claude-ask@absolutmode
```

Start a new Codex task after installing or updating so the skill and MCP tool
schemas are reloaded.

## Requirements

- Codex with plugin support;
- Node.js 22 or newer;
- Claude Code on `PATH` or at `~/.local/bin/claude`;
- an authenticated Claude Code session.

## Access modes

Use a model alias or a full model ID such as `claude-sonnet-5-5`. The default
is `claude-opus-5`, matching the existing personal installation.

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

The workspace is Claude's working directory and intended task scope, not a
hard operating-system sandbox. Only pass trusted workspaces and prompts.

## Reliability and privacy

- Prompts travel over stdin, never argv, environment variables, state, or logs.
- Job directories use mode `0700`; private files use mode `0600`.
- Jobs survive MCP server restarts and remain discoverable through `list_jobs`.
- Boot-aware recovery avoids trusting reused PIDs after a machine restart.
- Cancellation terminates Claude's POSIX process group with
  `SIGTERM → SIGKILL`.
- Stderr is capped at 1 MiB; failures expose at most a 4 KiB diagnostic tail.
- There is no automatic elapsed-time or idle-time cancellation.
- Completed plugin job data is retained for 24 hours by default; resumable
  Claude sessions use Claude Code's normal session storage.

See [the plugin documentation](plugins/claude-ask/README.md) for the complete
protocol and configuration reference.

## Development

```bash
npm test
npm run check
```

The default suite uses a fake Claude executable and consumes no model usage.
It checks exact model IDs, low effort, read-only review, inherited restrictions,
and job recovery after an MCP server restart.
An authenticated paid/limited-usage smoke test is explicit:

```bash
npm run test:live
```

## License

MIT
