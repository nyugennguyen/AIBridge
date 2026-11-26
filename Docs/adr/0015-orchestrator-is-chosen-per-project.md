# ADR 0015: The Orchestrator Is Chosen per Project, and Every Node Runs `aibr serve`

- **Status:** Accepted
- **Date:** 2026-11-26
- **Related:** [3.2.0 plan](../implementation-plans/v3.2.0-plan.md) (sections 2, 5.7, 6.5, 7.0, 7.1); [ADR 0013](./0013-operator-approval-ledger.md); [ADR 0014](./0014-claude-is-the-operator-interface.md). Amends ADR 0014.

## Context

ADR 0014 made Claude Code with the AIBridge plugin the operator interface. Users do not all have that setup: some run Codex or OpenCode as their daily agent. `aibr mcp` is already a general MCP server that does not depend on Claude, so the dispatch tools work from any MCP-capable agent.

Today a node has a `role` (`orchestrator`, `worker` or `both`). A node with `role: orchestrator` does not run the bridge (`aibr start` prints "Nothing to start"), so it cannot receive `/report` or events, cannot hold memory and cannot be woken when a job finishes. The product direction (an orchestrator per project, memory shared by project and session, and `aibr` following jobs instead of agents polling) needs a server on the orchestrator's machine too.

## Decision

1. Each project declares one orchestrator: `claude`, `codex` or `opencode`. The orchestrator talks to `aibr` through MCP.
2. Human-only actions stay as in ADR 0014 decision 2 and ADR 0013: `aibr jobs pending`, `aibr approve` / `aibr reject`, `aibr stop --all-jobs` and `aibr logs` run on the worker and are never exposed to an orchestrator. No orchestrator can approve a job, including through request metadata (the 3.1.2 `plan_status` fix).
3. An orchestrator may cancel an individual job it dispatched for its own project. The node-wide kill switch (`aibr stop --all-jobs`) stays operator-only.
4. **Every node runs `aibr serve`** (roadmap V0). The node `role` is dropped. Whether a node accepts jobs is decided by its runtime and capabilities, through an `accept_jobs` setting (default `true`). Which agent orchestrates is project configuration, not node configuration. A node with `accept_jobs: false` rejects `/trigger` with a distinct error but still receives `/report` and events.

### Cancel by the requester is not an approval action

Decision 3 is implemented in 3.2.0 (block B) as `POST /jobs/:id/cancel` and the MCP tool `bridge_cancel`:

- A requester's cancel only reduces what runs: it ends one job (`failed`, error `cancelled by requester`) and can never start, widen or approve anything. It is therefore **not an approval action**: it does not go through the approval ledger (ADR 0013), and it is recorded in the bridge log (`aibr logs`) with the caller's identity instead.
- Only the requester may cancel: the peer whose verified node signature (ADR 0012) names the job's `source_agent_id`. Any other peer gets 403. The operator credential, under the same rules as `aibr approve` (including `approval_from_loopback_only`), may cancel any job. Without a signature there is no caller identity, so an unsigned peer cannot cancel (or list, or follow) jobs, even on a node with `request_signing: "off"`.
- A job awaiting approval cannot be cancelled (409): it has not started, and ending it is the operator's decision (`aibr reject`).
- The node-wide kill switch (`aibr stop --all-jobs`, `POST /operator/stop-all-jobs`) stays operator-only, and `aibr approve` / `aibr reject` are not exposed through MCP or any route a peer can use, for every kind of orchestrator.
- A cancel ends the job through the same end-once path as the runner, the periodic sweep and the kill switch: one terminal write, one report.

## Consequences

- ADR 0014 becomes `Amended by ADR 0015`. Its Claude-as-interface decision stands for the default setup; it is no longer the only one.
- Codex and OpenCode need plugin or MCP configuration to act as orchestrators (3.3.0, roadmap V1).
- A machine used only as an orchestrator (typically a laptop) now opens a bridge port. It must bind to its Tailscale address and enable `security.request_signing`; operator routes keep accepting requests from the machine itself only.
- Profiles with `role` keep loading: `orchestrator` is read as `accept_jobs: false` with a warning, `worker` and `both` as `true`. The change is listed as BREAKING in the CHANGELOG when it ships (3.3.0).

This ADR records the direction. The code changes land with the roadmap items above, not with the documentation block that introduces this ADR.
