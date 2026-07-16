# Claude Ask

Claude Ask is an open-source Codex plugin that asks a locally authenticated
Claude Code model for an independent second opinion.

It provides three MCP tools:

- `ask` starts a persistent asynchronous Claude Fable or Opus job;
- `ask_status` reports progress and returns the final answer;
- `cancel_ask` explicitly cancels a job.

For repository reviews, `ask` accepts an explicit absolute `workspace`. Claude
runs from that directory with only the built-in `Read`, `Glob`, and `Grep`
tools. It cannot run shell commands or edit files. Without `workspace`, Claude
receives no tools.

## Install in Codex

Add this Git repository as a marketplace and install the plugin:

```bash
codex plugin marketplace add AbsoluteMode/claude-ask
codex plugin add claude-ask@absolutmode
```

Start a new Codex thread after installation so the new skill and MCP tool
schema are loaded.

## Requirements

- Codex with plugin support;
- Node.js 22 or newer;
- Claude Code installed at `~/.local/bin/claude`, or `CLAUDE_ASK_CLI` set to
  another executable;
- an authenticated Claude Code session.

## Security model

- The prompt is transferred over stdin, never argv or environment variables.
- Job directories use mode `0700`; job files use `0600`.
- Workspace access is explicit per job and canonicalized before launch.
- Workspace jobs expose only `Read`, `Glob`, and `Grep`.
- There is no automatic elapsed-time or idle timeout.
- Jobs survive an MCP server restart and are retained for 24 hours by default.
- At most four jobs run concurrently by default.

See [the plugin documentation](plugins/claude-ask/README.md) for protocol and
configuration details.

## Development

```bash
npm test
```

The default test uses a fake Claude executable and consumes no model usage. An
explicit live smoke test is available after Claude authentication:

```bash
npm run test:live
```

## License

MIT
