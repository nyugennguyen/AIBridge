# AIBridge Runbooks & Operational Guides Index

> **AIBridge v3.0.0** — Distributed multi-agent orchestration runtime connecting OpenCode, Claude Code, and Codex agents across machines via Tailscale mesh networking, governed by an event-sourced kernel, versioned charters, immutable safety policies, and Herdr workspace presentation.

---

## Operational Guides by Topic

1. [**01. Installation & Host Setup**](file:///Users/mac/Projects/AIBrigde/Docs/runbooks/01-installation-and-setup.md)
   * Platform prerequisites, Bun, Tailscale, tmux, runtimes.
   * Automated one-liner installer and manual Bun installations.
   * XDG profile directory layout (`config/`, `secrets/`, `state/`).
   * Interactive 5-step onboarding wizard (`aibr setup`).
   * Authentication modes (`"bearer-token"` vs `"none"`), CGNAT guardrails, and write-once secret management.

2. [**02. Service Operations & Supervision**](file:///Users/mac/Projects/AIBrigde/Docs/runbooks/02-service-operations.md)
   * Two-tier architecture: Rust `aibr-router` (Tier 1) + Bun `aibr worker` (Tier 2).
   * Background headless supervision with tmux (`aibr start`).
   * Direct daemon commands (`aibr serve`, `aibr worker --ipc-publish`, `aibr-router --init-store`).
   * Supervisor service units (`launchd` on macOS, `systemd` on Linux).

3. [**03. Peer Discovery & Mesh Networking**](file:///Users/mac/Projects/AIBrigde/Docs/runbooks/03-peer-discovery-and-mesh.md)
   * Tailscale peer discovery (`aibr discover` and `--json`).
   * Discovery boundary principles: reachability vs authentication.
   * Dual-enrolment in `agents[]` and `security.allowed_sources[]`.
   * Unauthenticated `/health` projection details.
   * Safe cross-host authentication verification via probe requests.

4. [**04. Herdr Workspace Presentation**](file:///Users/mac/Projects/AIBrigde/Docs/runbooks/04-herdr-workspace-presentation.md)
   * Architectural separation: *"Herdr owns the terminal; AIBridge owns the intent"*.
   * `aibr tui` CLI cutover and `aibr-manager` plugin (Role Grid, Charter Editor, Roundtable Live Transcript).
   * Thin Herdr fork primitives: F1 input-ownership fencing (`pane.claim_input` / `pane.release_input`) and F2 first-class role tagging.
   * Multi-node remote federation via `aibr-herdr-bridge`.

5. [**05. Multi-Agent Orchestration & Governance**](file:///Users/mac/Projects/AIBrigde/Docs/runbooks/05-orchestration-and-governance.md)
   * Versioned Charters & Proposal Lifecycle (`charter.propose`, `approve`, `reject`, `revise`).
   * The 6 Immutable Core constraints (`assertCharterDoesNotRelaxCore`).
   * Composite roles (`RoleAssignment`) & deterministic prompt compilation (`RoleBinder`).
   * Governed deliberation: Advisory Roundtable lifecycle (`roundtable.open`, `post`, `close`).
   * Execution gating (`objectionRequiredBefore`) and fan-out budget ledgers.
   * Operator credential model (`AIBRIDGE_OPERATOR_TOKEN` / `actor.kind: "user"`).

6. [**06. Verification, Diagnostics & Logs**](file:///Users/mac/Projects/AIBrigde/Docs/runbooks/06-verification-and-diagnostics.md)
   * Triage ladder: `aibr verify`, `aibr status`, and `aibr bundle`.
   * True meaning of `healthy` status (unauthenticated `/health` caveat).
   * Where runtime logs actually live (tmux pane captures, OpenCode logs; no phantom worker log files).
   * Safe token rotation procedure for write-once secrets.

7. [**07. CLI Command & Flag Reference**](file:///Users/mac/Projects/AIBrigde/Docs/runbooks/07-cli-command-reference.md)
   * Full matrix of implemented commands: `setup`, `start`, `serve`, `worker`, `status`, `verify`, `update`, `tui`, `bundle`, `discover`.
   * Complete global and command-specific flag reference.
   * Non-existent commands to avoid (`aibr db`, `aibr sessions`, `aibr logs`, etc.).
   * HTTP status code root-cause mapping (`400`, `401`, `403`, `404`, `409`, `503`).

---

## Additional References

* [**Unified Full User Guide**](file:///Users/mac/Projects/AIBrigde/Docs/runbooks/user-guide.md) — Single-document reference consolidating all operational topics.
* [**Failure Mode Recovery Inventory**](file:///Users/mac/Projects/AIBrigde/Docs/architecture/failure-modes-and-recovery.md) — 16 incident recovery architectures (FM-01 through FM-16) covering crashes, WAL recovery, projection rebuilds, and poison message isolation.

