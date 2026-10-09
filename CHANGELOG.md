# Changelog

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
