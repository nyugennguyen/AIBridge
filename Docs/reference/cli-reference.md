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
  init     Quickstart: set up this machine in at most four questions
  doctor   Check this node end to end (verify + status + ping), with fixes
  ping     Send a signed no-op job to a peer and wait for its result
  send     Dispatch a job to a peer and wait for its result
  logs     Print the bridge log of a profile (-f to follow)
  setup    Interactive host setup (profile optional; --advanced for all options)
  start    Start the bridge as a user service (launchd/systemd); --foreground: tmux
  serve    Run the bridge server
  worker   Drain the router's admission queue (no listener)
  status   Check the service or tmux session and bridge health
  verify   Validate role-specific dependencies, bearer token, and config
  update   Check and update to the latest version
  bundle   Generate diagnostic support bundle
  plugin   Install/remove the AIBridge plugin for Claude Code
  mcp      MCP server used by the Claude Code plugin (serve, summary)
  discover List tailnet peers and probe their /health (read-only)
  enroll   Pair nodes with a one-time code (issue, join, list, revoke)
  approve  Approve a job held for operator approval (on the worker node)
  reject   Reject a job held for operator approval
  jobs     List jobs on this node or your peers (--all-nodes, --watch); jobs pending: awaiting approval
  job      Show one job, its events (--events) or follow it until it ends (-f)
  cancel   Cancel one job (stop ends the service or, with --all-jobs, every job)
  attach   Watch a job's events until it ends (read-only; attaches no terminal)
  stop     Stop a profile's service and tmux session, or every running job (--all-jobs)

Options:
  --profile, -p <name>   Profile name (required for start/serve/worker/status)
  --config <path>        Config file to write instead of the standard path (for setup)
  --advanced             Also ask for bridge and OpenCode ports (for setup)
  --foreground, --tmux   Run in the tmux session aibridge-<profile> (for start)
  --check, -c            Check for updates without installing (for update)
  --yes, -y              Automatic yes to prompts (for update)
  --json                 Emit one JSON document and nothing else (for discover)
  --help, -h             Show this help
  --version, -v          Show version
  --shadow-mode          Run in shadow mode (mirroring ingress to router)

Run "aibr <command> --help" for help on one command.
```
