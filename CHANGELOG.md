# Changelog

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
