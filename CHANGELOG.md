# Changelog

## [3.0.0] - 2026-10-14

### Herdr-Orchestrated Multi-Agent Architecture (Part A)

#### Orchestration Commands & Kernel Governance (Phase 0 & Phase 1)
- **Charter Governance (`src/orchestration/charter/`)**: Introduced orchestration-wide system prompt governance via versioned `Charter` documents stamped with cryptographic snapshot digests (`computeCharterSnapshotDigest`).
- **Charter Proposal Lifecycle**: Added `charter.propose`, `charter.approve`, `charter.reject`, and `charter.revise` orchestration commands. Proposals remain pending with full audit trails (`rationale`, `evidenceRefs`) until operator approval.
- **The Immutable Core (`src/orchestration/policy/immutable-core.ts`)**: `assertCharterDoesNotRelaxCore` blocks any proposal from relaxing the safety floor, input fencing, security perimeter (`allowed_sources`, project allowlist), advisory roundtable invariant, budget limits, or kernel authority before entering the pending queue.
- **Audited Kernel Commands**: All charter revisions are executed exclusively through kernel commands (`charter.revise`), preventing files or external UIs from becoming competing sources of truth.
- **Multi-Role Assignment (`RoleAssignment`)**: Agents can now hold composite roles with exactly one primary role and bounded secondary addenda (`addendum`).
- **Capability Envelope Intersection**: Multi-role execution enforces strict capability intersection by default ($\text{allowed} \cap \text{roleAllowed} \cap \neg\text{denied}$), preventing permission escalation across combined roles.
- **Deterministic Prompt Compilation (`RoleBinder`)**: System prompts are deterministically compiled from `Charter(v).globalRules + primaryRole.instructions + Σ secondaryRole.addenda + communicationPolicy + taskPrompt` with cryptographic digest stamping.
- **Session Prompting**: Implemented `session.prompt` command driving runtime clients with idle monitoring and event recording.

#### Governed Deliberation & Roundtable (Phase 1 & Phase 5)
- **Roundtable Deliberation (`src/orchestration/roundtable/`)**: Introduced advisory pre-execution debate modeled via `roundtable.open`, `roundtable.post`, `roundtable.close`, and `roundtable.outcome_recorded`.
- **Controller Relay Transport**: Discussion posts travel over `mesh.event` envelopes and are relayed by the controller to all participating member nodes. Total event order is established uniquely at the SSE event gateway without requiring direct worker-to-worker connections.
- **Advisory-Only Invariant**: Deliberation produces recommendations and audited transcripts (`RoundtableOutcome`) as inputs to dispatch. `roundtable.closed` is present in zero `COMMAND_EVENT_ALLOWLIST` entries, guaranteeing roundtables never trigger automated state transitions.
- **Roundtable Execution Gating**: Communication policies enforce `objectionRequiredBefore`, rejecting un-deliberated execution dispatch attempts with `roundtable_required`.
- **Memory Write-Back**: Roundtable outcomes automatically write back to scoped memory stores with provenance linking to discussion post IDs.

#### Fan-Out Scheduler & Budget Ledgers (Phase 1 & Phase 5)
- **N-Sibling Fan-Out Dispatch**: Implemented fan-out task execution with cascading cancellation on parent failure.
- **Budget Gating**: Extended budget ledgers to track concurrency and fan-out limits as distinct counters; parallel roundtable discussions and fan-out dispatches are gated against hard budget ceilings (`maximum_fan_out_exceeded`, `budget_exhausted`).

#### Herdr Fork Integration & Terminal Backend (Phase 2 & Phase 3)
- **Herdr Fork Integration (`herdrdev/herdr` branch `aibr-orchestration`)**: Thin fork satisfying ADR 0009 Revisit Condition #1:
  - **F1 Input-Ownership Fencing**: Added `pane.claim_input` / `pane.release_input` socket API with epoch fencing, rejecting unheld writes with `input_fenced` to prevent keystroke interleaving between humans and agents.
  - **F2 First-Class Role**: Native `role` field on pane and agent records that survives pane moves and workspace re-identification, linking to the kernel's `RoleSnapshot` digest.
  - **Schema Conformance**: Verified against `herdr api schema --json`.
- **`HerdrTerminalBackend`**: Added production `HerdrTerminalBackend` alongside `TmuxTerminalBackend` in `src/terminal/`, selectable via `terminal.backend: "tmux" | "herdr"` in configuration (defaulting to `"tmux"` for headless safety).

#### Herdr Plugins & Remote Federation (Phase 3 & Phase 4)
- **`aibr-manager` Plugin (Bun + OpenTUI)**: Interactive management pane providing Role Grid (agents $\times$ roles with live capability envelope preview), Charter Editor (with inline immutable core validation), Roundtable Live Transcript (SSE streaming, human post injection), Multi-Machine Grid, and Approval Queue.
- **`aibr-herdr-bridge` Plugin (Bun)**: Subscribes to remote Tailscale mesh nodes and projects remote agent state into local Herdr workspaces with `$node`, `$role`, and `$run` tokens.
- **Dual-Path Remote Federation**: Herdr SSH machine federation handles remote terminal presentation over Tailscale, while AIBridge mesh projection handles distributed orchestration state.

#### TUI Retirement & CLI Cutover (Phase 6)
- **Retirement of `aibr-tui` and `src/tui/`**: Retired the standalone Rust `aibr-tui` binary and the OpenTUI fallback shell in favor of Herdr workspace presentation. Retained `crates/aibr-pty` and `crates/aibr-ipc` as headless substrates.
- **`aibr tui` Cutover**: CLI command `aibr tui` now detects Herdr installation and launches/links the `aibr-manager` plugin, exiting with clear remediation steps if Herdr is absent.

#### Operator-Credential Security Model & Authz Tiers (ADR 0008 §4 / ADR 0011)
- **Operator Token Authority**: Introduced `AIBRIDGE_OPERATOR_TOKEN` and user-kind actor claims (`actor.kind: "user"`). High-privilege governance actions (charter proposal approval/rejection, human roundtable injection, emergency execution abort) require verified operator credentials.
- **Advisory-Only Notifications (ADR 0007 §17)**: Event-driven notification bus and consumer operating strictly advisory and out-of-band with zero upward imports into orchestration, rules, or budgets.

## [2.2.0] - 2026-10-14

### Setup, Peer Discovery, & Security (Part B)

#### Added
- **Optional bearer authentication.** `security.auth_mode` accepts `"bearer-token"` (default, unchanged behaviour) or `"none"`. In `none` mode `/trigger` and `/report` accept unauthenticated requests, no `bearer_token` secret is written, and callbacks are delivered with the `Authorization` header omitted rather than sent as a malformed one. `aibr setup` gains a third option at Step 2 (`none`), and refuses to author it unless the bridge is bound to a Tailscale CGNAT address (`100.64.0.0/10`) with the backend running, or when a `bearer_token` secret is already on disk that would be silently ignored. A bare `n` at Step 2 keeps its existing meaning (paste your own token); only an explicit `none` disables authentication.
- **Fail-closed auth selection.** `createAuthProvider(mode, token)` in `src/security/auth-provider.ts` throws rather than degrading when a `bearer-token` profile has no secret, so a missing token file cannot become an open bridge. `BearerAuthProvider` now also refuses an empty token at construction.
- **`aibr verify` distinguishes warnings from failures.** A missing bearer secret on a `none`-mode profile is a standing `warn`, not a `fail`, and `ok` is now "nothing failed" instead of "everything passed" — a node in the mode the operator chose should not report FAILED.
- **Tailscale peer discovery.** `discoverTailscalePeers` in `src/host/tailscale-discovery.ts` enumerates the tailnet from the local daemon, drops this machine from its own peer list, and degrades to an empty list on every failure mode (absent daemon, malformed output, no peers) because discovery is advisory. `probeDiscoveredAgents` in `src/cli/setup-step-widgets.ts` then asks each peer's unauthenticated `/health` who it is, keeping the daemon's `online` verdict, the HTTP `reachable` answer, and the peer's self-reported `agentId`/`capabilities` as separate fields because they answer different questions and fail independently.
- **`aibr discover`.** A read-only, state-free tailnet query: it writes nothing, starts nothing, and treats an empty tailnet as success. `--json` emits exactly one document on stdout with a pinned top-level shape (`schemaVersion`, `ok`, `enrolledSource`, `peersFound`, `reachableCount`, `enrolledCount`, `peers`, `notice`) and stable per-peer field names — this is the surface the Herdr manager plugin codes against, so a rename is a breaking change. `null` is preserved for facts discovery never learned rather than being collapsed to `false`.
- **`aibr setup` peer proposal.** Setup uses the same probe to *offer* discovered peers. The operator selects one explicitly and chooses its capabilities; a peer that is not selected is not enrolled, and there is no code path from a reachable `/health` to a config write. Enrolling writes the peer into **both** `agents[]` and `security.allowed_sources[]` from a single in-memory object, with the same id and the same capabilities, because `assertSourceAuthorized` authorizes on `source_agent_id` **and** capability membership and answers `403` to a source present in one array but not the other; selecting nobody enrols nobody, leaving both arrays empty and consistent. Config authoring, not a trust decision.
- **Identity fields on `/health`.** The route now also returns `agent_id` and `capabilities` alongside `ok` and `opencode`. `capabilities` is the flattened, sorted union of `security.allowed_sources[].capabilities` rather than `agents[]`, so a probe learns what work the node accepts and not which tailnet peers it has authorised; the source identities, `requires_plan_approval`, and the `agents[]` registry are deliberately still not exposed. `/health` remains unauthenticated by design — it is the discovery endpoint, and this is additive.
- **Informational discovery check in `aibr verify`.** A new `tailscale-discovery` check reports "N peers reachable, M enrolled", with enrolled peers named in the detail string (capped at five). It is never a `fail`: no Tailscale, an empty tailnet, or all peers offline all pass, because a machine alone on its tailnet is a normal single-machine install. It is a `warn` only when reachable peers are none of them enrolled, or when the probe could not run at all.
- **Reachability is not authentication, stated at every surface.** Every discovery projection — the wizard widget, `aibr discover`, and the `verify` check — carries an explicit caveat that a peer answering `/health` is not enrolled or trusted. Real trust stays on the mesh identity path (`src/mesh/identity/`: ed25519 node keys, enrollment codes, peer pins), and no route accepts a caller-supplied `agent_id` as proof of identity. `tailscale status --json` is never printed raw, and no `tskey-` node-enrollment credential is surfaced by any of these paths — a peer whose only self-description is a credential-shaped string is reported as unidentified.

#### Fixed
- **`aibr bundle --preview` was rejected as an unknown flag.** `parseArgs` pushed `--preview` onto both `knownFlags` and `unknownFlags`, so the unknown-flag guard rejected the flag before the bundle branch could read it — a documented, implemented flag that was unreachable in every released version. Genuinely unknown flags are still rejected.
- **The `tskey-` guard had two copies.** `aibr discover` and `aibr setup` each carried their own `TSKEY_PREFIX` and scrub function. Duplicated redaction logic reads as deliberate in either copy, which is what makes it likely one is edited and the other is not. The rule now lives once in `src/cli/discovery-safety.ts` and is imported by both.

#### Changed
- `bearerToken` is nullable across `AppDependencies`, `RuntimeOptions`, `CallbackReporter.send`/`drainPending`, and `EgressOutboxStore.deliverClaimedRow`. Backwards compatible: every existing config and test still passes a real token.
- `src/index.ts` no longer requires `AIBRIDGE_BEARER_TOKEN`, so the legacy agent-face entrypoint serves whatever `security.auth_mode` the profile declares.

## [2.1.6] - 2026-10-09

### Fixed

- **Cross-platform binary format validation**: `isExecutable` in `src/host/binaries.ts` now inspects executable magic headers, rejecting incompatible binary formats (e.g. Darwin Mach-O on Linux) to prevent `posix_spawn` / `ENOEXEC` failures.
- **TUI daemon socket awareness & OpenTUI fallback**: `aibr tui` now checks daemon socket activity before invoking `aibr-tui` and catches any IPC connection failures, gracefully falling back to the built-in OpenTUI shell when the background IPC daemon is not active.
## [2.1.4] - 2026-10-09

### Added

- **Automatic OpenCode v2 detection**: CLI and profile supervisor now automatically detect and launch `opencode2` when present in `PATH`, with `OPENCODE_BIN` environment variable override support.

## [2.1.3] - 2026-10-09

### Fixed

- **Bundled native binaries**: Shipped compiled `aibr-tui` and `aibr-router` binaries directly inside the npm package under `bin/`, registered them in package `bin` executables, and removed external `optionalDependencies` to prevent 404 installation warnings.

## [2.1.2] - 2026-10-09

### Fixed

- **Native TUI and Router binary availability in npm package**: Resolved issue where global npm/bun installations only shipped JavaScript (`dist/`) without compiled Rust binaries, causing `aibr tui` to always fall back to the legacy OpenTUI shell.
- **Per-platform optional dependencies**: Added `@nyugennguyen/aibridge-<platform>` optional dependencies for prebuilt `aibr-tui` and `aibr-router` binaries (`darwin-arm64`, `darwin-x64`, `linux-x64-gnu`, `linux-x64-musl`, `linux-arm64-gnu`, `linux-arm64-musl`).
- **Native binary discovery engine** (`src/host/binaries.ts`): Implemented unified resolution prioritizing `AIBRIDGE_TUI_BIN`/`AIBRIDGE_ROUTER_BIN` overrides, optional platform packages, bundled binaries, local Cargo builds, and system PATH.
- **Build matrix & packaging automation**: Updated `scripts/build-matrix.sh` to compile and package both `aibr-router` and `aibr-tui`, including universal Darwin binaries, and added `scripts/package-binaries.ts` (`bun run package:binaries`) for automated npm platform package staging.

## [2.1.0] - 2026-10-07

> Released as tag `v2.1.0` on `aibr-v2`. The GitHub release was **not** created, so this
> version is not yet published to npm — creating the release is what triggers `publish.yml`.

### TUI control plane upgrade & onboarding wizard

Implements the second phase of ADR 0010. Full record in
[`Docs/implementation-reports/tui-deamon-update-07102026.md`](Docs/implementation-reports/tui-deamon-update-07102026.md).

#### Added

- **Dual-profile keybinding engine** (`crates/aibr-tui/src/input/`): Profile A exposes
  zero-prefix `Alt+H/J/K/L` focus, `Alt+V`/`Alt+S` splits, `Alt+Z` zoom, `Alt+1..9` workspace
  tabs, `Alt+B` inspector, and `Alt+Q` detach. Profile B arms the tmux-classic `Ctrl+B` prefix.
- **Shell chrome**: 2-row top header with Tailscale health and agent status pills, a numbered
  workspace tab bar with close/new hit-testing, and a status bar.
- **Embedded in-pane HITL approval card and colourised diff viewer**, replacing the disruptive
  full-screen takeover.
- **Universal command palette** (`Ctrl+K`) with fuzzy filtering, and an interactive keymap /
  profile-switcher modal.
- **Collapsible 28-column inspector sidebar** with node latencies, run DAG, and telemetry.
- **Brand identity**: ANSI logo, design-system colour tokens, and a 7-row CLI splash banner.
- **5-step onboarding wizard** (`aibr setup`): network probe, security, project allowlists,
  AI runtime probes, and install. Interactive keyboard and mouse parity, with a headless
  fallback for non-interactive test suites.
- **Platform supervisor generation**: launchd plist and systemd user unit.

### Fixed

- **The setup wizard no longer creates the ingress outbox.** The `ingress_outbox` table belongs
  to the Rust router and is provisioned by `aibr-router --init-store`. The wizard was creating a
  different set of columns at a path the router does not read, and reporting `walEnabled: true`
  without reading `PRAGMA journal_mode` back. `aibr worker` documents why an implicitly-created
  store is worse than none: the router refuses to serve against it, the worker drains an empty
  one, and both look healthy.
- **Supervisor units are written without being activated**, and `aibr setup` now asks before
  starting the daemon. Both units are `KeepAlive`, so activating one whose config does not match
  the router's store turns a setup mistake into a restart loop. Setup reports which of four
  states the daemon is actually in, so a unit that was never started cannot read as running.
- **Profile names and the binary path are escaped** when interpolated into a plist and a systemd
  `ExecStart`. Units are now written `0600`.
- `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` are
  clean across the workspace.
- **The version no longer drifts.** The splash banner hardcoded `aibr v2.0`, so this release
  advertised itself as 2.0 on startup, and the string was written out by hand in four places.
  It now lives in `src/version.ts` as `CLI_VERSION`, read by the banner, `--version`,
  `aibr update`, and the diagnostics bundle.

### Known limitations

Carried forward from `tui-daemon-modernization.md` and unchanged by this release:

- `approve_plan` / `reject_plan` reach the daemon and are answered `accepted: false`. The HITL
  card renders and the frame is sent, but the engine's plan-review path sits behind the job
  manager and is not wired yet.
- The PTY host has no `PtySink` wired to the listener, so pane commands from a real client are
  answered `not_allowed`. No real `opencode` has been run through the bus end to end.

### Documentation corrections

An earlier revision of the implementation report made four claims that the code did not support;
they are corrected in place rather than left to mislead:

- The `aibr_sec_<32-hex>` bearer token is **128 bits** (16 bytes), not 256. The mislabel also
  appeared in `aibr-onboarding/SKILL.md` and the wizard mockup; both now say 128.
- The `Ctrl+B` prefix window is **2000 ms**, not the 500 ms the report claimed. The longer
  window is deliberate and documented in `tui-daemon-modernization.md` §5.
- The wizard does **not** load the platform service daemon as part of a completed setup;
  activation is a separate opt-in.
- The HITL approval card does not yet produce an effective approval (`accepted: false`).

## [2.0.0] - 2026-10-05

### Major Architectural Evolution (v1 -> v2)

AIBridge v2 transforms the single-node, file-backed proof-of-concept into a resilient, distributed agent mesh platform featuring autonomous ingress, multi-agent coordination, an interactive terminal UI, and comprehensive operator workflows.

### Added

- **Autonomous Ingress & High-Performance Router (`aibr-router`)**:
  - Standalone Rust admission router (`router/`) providing sub-millisecond request validation, zero-allocation boundary enforcement, and rate limiting.
  - Polyglot contracts with JSON Schema parity vectors generated synchronously between TypeScript (Zod) and Rust (Serde).
  - Tier 2 asynchronous drain worker (`src/ingress/worker.ts`) decoupled from HTTP listener lifecycles.
  - Durable SQLite outbox store for atomic admission and reliable delivery across crashes.
  - Ingress modes: `engine` (TypeScript Fastify bridge) and `router` (autonomous native ingress router).

- **Multi-Agent Orchestration & Workflow Engine (M3 - M6)**:
  - Directed Acyclic Graph (DAG) task scheduler supporting parallel job execution, dependencies, and dynamic fanout.
  - Distributed coordination protocols with heartbeat-monitored agent leases, split-brain fencing, and automatic failover.
  - Capability-based access control with role definitions, boundary rules, and execution floor policies.
  - Expression and rule evaluation engine with compile-time vacuity and non-contradiction verification.
  - Event-sourced persistence store with migration framework, snapshotting, and transaction logs.

- **Interactive Terminal User Interface (`aibr tui`)**:
  - Full-screen dashboard built on OpenTUI for inspecting agent mesh health, real-time event logs, active leases, and task DAGs.
  - Keyboard-driven interactive views for capability verification, session management, and rule policy inspection.

- **Operator & Onboarding CLI Suite (`aibr`)**:
  - `aibr setup`: Interactive onboarding wizard with automated prerequisite checks (Bun, OpenCode, Tailscale, tmux), cryptographic bearer token generation (`openssl rand -hex 32` / 64-character hex secret), custom or default configuration paths, and secure permission handling (`0600`/`0700`).
  - `aibr verify`: Deterministic verification command checking dependencies, Tailscale network connectivity, configuration schemas, secret permissions, and project directory availability.
  - `aibr update`: Self-update command with `--check` and `--yes` flags that queries registry releases, compares semver versions, and manages global upgrades.
  - `aibr status`: Extended profile status reporting configuration summaries (Agent ID, Bridge host/URL, OpenCode URL) alongside readiness probes.
  - `aibr bundle`: Sanitized diagnostic support bundle generator for troubleshooting without leaking credentials or secret keys.

- **Security & Platform Hardening**:
  - Automated secret redaction pipeline preventing credentials, bearer tokens, or sensitive headers from leaking into logs, support bundles, or preview buffers.
  - Strict filesystem safety guarantees: atomic file writes, symlink rejection, path traversal protection, and mandatory `0600` secret permissions.
  - Network isolation via dedicated Tailscale interface binding (`tailscale0`) and nftables filtering rules.
  - System supervision templates: systemd services (`aibr-router.service`, `aibr-worker.service`) and macOS launchd daemons (`com.aibridge.router.plist`).

### Changed

- Migrated job storage from legacy flat JSON files to durable event-sourced SQLite stores with crash-recovery audit trails.
- Upgraded configuration schema to support ingress modes, multi-project mappings, timeout policies, and workflow DAG definitions.
- Enhanced process management with tmux session supervisor supporting independent opencode and bridge runtime windows.
- Upgraded testing harness with comprehensive failure-mode simulations, contract parity tests, and recovery runbooks.

## [1.1.0] - 2026-08-25

### Added

- curl|bash one-line installer at `scripts/install.sh` with OS detection, prereq prompts, and `bun install -g` for `@nyugennguyen/aibridge`.

## [1.0.1] - 2026-07-20

### Changed

- Improved bearer-token installation, verification, troubleshooting, and rotation guidance.
- Added regression coverage for authenticated invalid triggers and installation documentation.
- Made release validation build the package before CLI smoke tests and aligned the CLI version with package metadata.
- Updated the GitHub Actions checkout action to v5.
- Removed internal `.omo` workspace state from the repository.

## [1.0.0] - 2026-07-19

### Added

- First stable AIBridge release for coordinating OpenCode agents over a private Tailscale network.
- Two-host CLI profile setup, secure bearer-token authentication, remote job execution, and callback reporting.
- Release CI validation and package smoke tests.
