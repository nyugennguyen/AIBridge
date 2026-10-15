# CLI reference

> **Status:** Current
> **Applies to:** the CLI built from this tree
> **Owner:** maintainers

## Purpose

Executable reference for the `aibr` command. The command table below is
generated from `aibr --help`; regenerate it with:

```bash
bun scripts/docs/generate-cli-reference.ts
```

If this file and the CLI disagree, the CLI wins and `bun run docs:check` fails.

## Commands and options

```text
aibr — AIBridge CLI

Usage:
  aibr <command> [options]

Commands:
  setup    Interactive host setup (profile optional)
  start    Start opencode + bridge in tmux
  serve    Run the bridge server
  worker   Drain the router's admission queue (no listener)
  status   Check tmux session and bridge health
  verify   Validate dependencies, SSL token, and config format
  update   Check and update to the latest version
  tui      Open the interactive manager (Herdr plugin)
  bundle   Generate diagnostic support bundle
  discover List tailnet peers and probe their /health (read-only)

Options:
  --profile, -p <name>   Profile name (required for start/serve/worker/status/tui)
  --check, -c            Check for updates without installing (for update)
  --yes, -y              Automatic yes to prompts (for update)
  --json                 Emit one JSON document and nothing else (for discover)
  --help, -h             Show this help
  --version, -v          Show version
  --shadow-mode          Run in shadow mode (mirroring ingress to router)
  --ipc-publish          Serve the local IPC bus (worker only)
```
