# ADR 0014: Claude Code with the AIBridge Plugin Is the Operator Interface; the TUI/Herdr Layer Is Removed

- **Status:** Accepted
- **Date:** 2026-11-26
- **Related:** [3.1.1 slimming review](../implementation-plans/v3.1.1-slimming-review.md); [ADR 0013](./0013-operator-approval-ledger.md); [Claude Code as Orchestrator](../guides/claude-code-orchestrator.md). Supersedes [ADR 0009](./0009-herdr-terminal-backend-evaluation.md), [ADR 0010](./0010-tui-daemon-modernization.md), [ADR 0011](./0011-herdr-orchestration-architecture.md).

## Context

The day-to-day workflow moved to Claude Code with the AIBridge plugin (MCP server and skills), shipped in 3.1.0: Claude dispatches jobs to workers, follows them and reads results. ADRs 0009 to 0011 described a different front end: a standalone TUI, then a Herdr workspace with an external `aibr-manager` plugin, backed by a local IPC bus, a terminal WebSocket gateway and PTY crates.

That layer never gained a production consumer. `aibr tui` only launched an out-of-repo Herdr plugin, nothing in `aibr serve` or `aibr worker` depended on the IPC bus or the terminal gateway, and the tmux backend was the only one used on real nodes. It cost roughly 54k lines, two Rust crates and two dependencies to maintain.

## Decision

1. Claude Code with the AIBridge plugin is the main interface for dispatching and following work.
2. Human-only actions stay in the `aibr` CLI on the worker and are never exposed to Claude: `aibr jobs pending`, `aibr approve` / `aibr reject`, `aibr stop --all-jobs` (kill switch) and `aibr logs`. This keeps ADR 0013's boundary: an agent cannot approve its own job.
3. There is no TUI and no Herdr integration. Terminal supervision on a node is tmux (or the user service from `aibr start`).

## Consequences

Removed in 3.1.1: the TUI view models and the `aibr tui` launcher, the Herdr terminal backend and its preflight/verify checks, `src/terminal/`, the terminal WebSocket gateway and `mesh.terminal.*` records, the TUI application service, the IPC bus, `crates/aibr-ipc`, `crates/aibr-pty`, 13 IPC-only contract schemas, and the `@opentui/core` and `@fastify/websocket` dependencies. `/trigger`, `/report`, `/jobs` and the plugin are unchanged.

Deprecated, accepted until 3.2.0 and then removed: `aibr tui` (stub that prints replacements and exits 1), `aibr worker --ipc-publish` (ignored, warns), config `terminal.backend: "herdr"` (loads, uses tmux, warns).

Breaking for external tooling: the `aibr-manager` and `aibr-herdr-bridge` Herdr plugins no longer work against AIBridge 3.1.1.

Not decided here: what to do with the kernel, mesh, rules, budgets and workflow code that is built and tested but not wired into `aibr serve` (review section 4): keep it as roadmap, or remove it in 3.2.0.
