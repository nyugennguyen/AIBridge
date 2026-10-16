# Current architecture guide

> **Status:** Current
> **Applies to:** AIBridge 3.0.0
> **Last verified:** 2026-10-15 against commit d012119
> **Owner:** maintainers

## 1. Purpose and status

This document defines the as-built architecture of AIBridge 3.0.0. Every statement in this guide describes running code in the repository; planned extensions or historical prototypes are explicitly labeled as such.

For historical design notes and earlier recovery surface proposals, see [`Docs/archive/failure-modes-and-recovery.md`](../archive/failure-modes-and-recovery.md) (marked with status *Archived*). For executable command syntax, see the generated [`Docs/reference/cli-reference.md`](../reference/cli-reference.md).

## 2. Component responsibilities and trust boundaries

AIBridge separates admission, orchestration, local execution, and networking across four decoupled components:

```text
               ┌────────────────────────────────────────────────────────┐
               │              Tailnet Private Network (WireGuard)       │
               └───────────┬────────────────────────────────┬───────────┘
                           │                                │
                           ▼                                ▼
       ┌──────────────────────────────────────┐   ┌───────────────────┐
       │ Ingress Router (aibr-router, Rust)   │   │ Bridge Server     │
       │   - Port: bridge.port (default 8787) │   │ (Fastify Engine)  │
       │   - Bound to Tailnet IP only         │   │                   │
       │   - Memory cap: MemoryMax=32M        │   └─────────┬─────────┘
       │   - Inflight cap: 64                 │             │
       │   - Body limit: 1 MiB                │             │
       └───────────────────┬──────────────────┘             │
                           │ Commit-before-202 WAL          │
                           ▼                                │
       ┌──────────────────────────────────────┐             │
       │ SQLite Ingress Outbox Store          │             │
       │ (AIBRIDGE_INGRESS_OUTBOX)            │             │
       └───────────────────┬──────────────────┘             │
                           │ Claim lease (30s)              │
                           ▼                                │
       ┌──────────────────────────────────────┐             │
       │ Ingress Worker (aibr worker)         │             │
       └───────────────────┬──────────────────┘             │
                           │                                │
                           ├────────────────────────────────┘
                           ▼
       ┌────────────────────────────────────────────────────────────────┐
       │ Execution Runtimes & Adapters                                  │
       │   - OpenCode Serve Daemon: 127.0.0.1:4096 (OPENCODE_PORT)      │
       │   - Terminal backends: tmux (default) / herdr                  │
       │   - Project path containment (realpath allowlist)              │
       │   - Jobs Store: ~/.local/state/aibridge/<profile>/jobs/        │
       └────────────────────────────────────────────────────────────────┘
```

### Component responsibilities

1. **Polyglot Ingress Admission Router (`aibr-router`):**
   - Implemented in Rust under `router/` (MSRV 1.94, pinned toolchain 1.99.0).
   - Serves as the admission gate when `bridge.ingress_mode` is set to `"router"` (`src/config/schemas.ts:55`).
   - Validates incoming HTTP requests against schema contracts (`contracts/v1/`), checks bearer authentication tokens (`router/src/auth.rs`), enforces body limits (`router/src/validate.rs:72`), and bounds concurrency (`router/src/routes.rs:279`).
   - Commits accepted admissions to a local SQLite write-ahead log (`ingress_outbox`) before returning HTTP 202 (`router/src/outbox.rs:5-13`).
   - Runs in a memory-bounded envelope (`MemoryMax=32M`, `router/src/validate.rs:70`).

2. **Bridge Engine (`src/server/app.ts`, `src/bridge.ts`):**
   - Implemented in TypeScript/Bun using Fastify.
   - Serves incoming HTTP requests directly when `bridge.ingress_mode` is set to `"engine"` (`src/config/schemas.ts:55`).
   - Registers core routes: `/health`, `/trigger`, `/jobs`, `/report`, and orchestration endpoints (`src/server/app.ts:80-86`).
   - Enforces a 1 MiB body limit (`src/server/app.ts:80`).

3. **Ingress Worker Daemon (`src/ingress/worker.ts`, `aibr worker`):**
   - Polls and drains admitted jobs from `AIBRIDGE_INGRESS_OUTBOX`.
   - Acquires durable leases (30,000 ms claim lease, `router/src/policy.rs:32`) to prevent duplicate processing.
   - Evaluates project containment and security allowlists before invoking execution adapters.
   - Dispatches jobs to execution backends and reports outcomes back to caller callback endpoints.

4. **Local Execution Daemon (`opencode serve`):**
   - Manages language model agent tools and workspace modifications.
   - Bound strictly to localhost (`127.0.0.1`), on port `OPENCODE_PORT` (default 4096, `src/cli.ts:1147-1150`).
   - Authenticated via `OPENCODE_SERVER_PASSWORD` environment variable or `${secretsDir}/opencode_password` file (`src/cli.ts:901-904,1140-1145`).
   - Supervised in headless sessions using tmux (`src/host/tmux.ts`) or Herdr (`src/terminal/herdr-terminal-backend.ts`).

### Trust boundaries

- **Tailnet boundary:** Ingress endpoints (`bridge.host`:`bridge.port`, default 8787) must bind only to a provisioned CGNAT tailnet IP (100.64.0.0/10). Layer-1 bind preflight (`router/src/bind.rs:5-8`) inspects local OS network interfaces and aborts with `EX_CONFIG` (exit code 78) if `bridge.host` is not present, refusing to bind wildcards (`0.0.0.0`, `::`) or exposed LAN interfaces.
- **Loopback execution boundary:** The OpenCode server listens exclusively on `127.0.0.1:4096` (`src/cli.ts:1150`). It is never reachable from the network or tailnet directly.
- **Admission credential boundary:** All incoming HTTP requests require a valid bearer token matching `AIBRIDGE_BEARER_TOKEN` (`router/src/auth.rs`, `src/bridge.ts:94`). Unauthenticated requests are rejected immediately with HTTP 401.
- **Project file system containment:** Target projects must match canonical paths configured in `config.projects` (`src/config/schemas.ts:37-41`). The router resolves symlinks at startup via `realpath` (`router/src/config.rs:126,157-172`) and rejects path traversal outside configured roots.
- **Kernel safety floor:** Implemented in `src/orchestration/policy/immutable-core.ts:50-56`, immutable security invariants (project allowlist, terminal state authority, budget ceilings, advisory-only roundtables) cannot be overridden by dynamic policies or agent instructions.

## 3. Deployment and topology

AIBridge supports two operational topologies:

```text
Two-Machine Starter Topology:
┌────────────────────────────┐              ┌────────────────────────────┐
│ Developer Workstation      │              │ Execution Node             │
│ (Client / Caller)          │              │ (Runner / Worker)          │
│                            │   Tailscale  │                            │
│ POST /trigger (curl)       ├─────────────►│ aibr-router (port 8787)    │
│                            │  (WireGuard) │   │                        │
│ Callback listener          │◄─────────────┤   ▼                        │
│                            │              │ opencode serve (127.0.0.1) │
└────────────────────────────┘              └────────────────────────────┘

Distributed N-Node Mesh Topology (src/mesh/):
┌────────────────┐     Heartbeats & Leases      ┌────────────────┐
│ Mesh Node A    │◄────────────────────────────►│ Mesh Node B    │
│ (Controller)   │                              │ (Worker)       │
│                │     SSE State Gateway (SSE)  │                │
│ Ed25519 Keys   ├─────────────────────────────►│ Ed25519 Keys   │
│ Leases & Epochs│     Durable Outbox / Inbox   │ Mesh Inbox     │
│ Registry Store │◄─────────────────────────────┤ Terminal GW    │
└────────────────┘                              └────────────────┘
```

### Two-machine starter topology
- **Client/Caller Node:** Initiates jobs using HTTP POST to `/trigger` on the execution node's tailnet address. Receives completion callbacks at a configured callback URL.
- **Execution Node:** Runs `aibr-router` (or `aibr serve`) listening on `bridge.host:8787`, accompanied by `aibr worker` and `opencode serve` on `127.0.0.1:4096`.

### N-node distributed mesh topology (`src/mesh/*`)
- **Node identity and enrollment (`src/mesh/identity/`):** Each node generates an Ed25519 identity key (`crypto.ts`). Nodes join via time-limited enrollment codes (`enrollment-code.ts`). Cross-node requests are signed and verified with replay guards (`request-signature.ts`, `replay-guard.ts`).
- **Registry and heartbeats (`src/mesh/registry/`):** Peer nodes register their capabilities and announce presence with periodic heartbeats (`src/mesh/protocol/heartbeat.ts`). Stale nodes expire automatically.
- **Distributed controller leases and epochs (`src/mesh/lease/`, ADR 0004):** Coordination uses monotonic epoch counters and durable controller leases to guarantee single-master execution for task graphs and avoid split-brain states (`command-gate.ts`, `sqlite-lease-store.ts`).
- **Mesh inbox and outbox (`src/mesh/inbox/`, `src/mesh/outbox/`):** Commands are dispatched through durable outboxes and received by target inboxes, decoupling inter-node latency from execution.
- **Real-time gateways (`src/mesh/gateway/`):** Server-Sent Events (SSE) gateways (`gateway/events/sse.ts`) stream state projections to remote consumers, while terminal gateways (`gateway/terminal/gateway.ts`) stream PTY sessions.
- **Orchestration charter and advisory roundtables (`src/orchestration/`):** Multi-agent coordination supports deliberation sessions (`roundtable/aggregate.ts`). Deliberations and charter proposals are strictly advisory (`src/orchestration/policy/immutable-core.ts:53,95`): deliberation outcomes (`RoundtableOutcome`) never mutate external task lifecycles directly.

## 4. Request and event flow

### Ingress admission sequence (`POST /trigger`)

```text
Caller                 aibr-router                SQLite Outbox            Worker
  │                         │                           │                    │
  │─── POST /trigger ──────►│                           │                    │
  │    (Bearer auth)        │── Verify auth & body      │                    │
  │                         │── Acquire inflight slot   │                    │
  │                         │   (cap: 64)               │                    │
  │                         │                           │                    │
  │                         │─── INSERT INTO outbox ───►│                    │
  │                         │    (PRAGMA sync=FULL)     │                    │
  │                         │◄── COMMIT Ok ─────────────│                    │
  │                         │                           │                    │
  │◄── 202 Accepted ────────│                           │                    │
  │    {job_id, status_url} │                           │                    │
  │                         │                           │◄── Claim lease ────│
  │                         │                           │    (30s lease)     │
  │                         │                           │─── Job record ────►│
  │                         │                           │                    │── Dispatch to OpenCode
```

1. **Client submission:** Caller issues `POST /trigger` with bearer authorization header and job payload.
2. **Preflight checks:** `aibr-router` enforces:
   - Bearer authentication matching `AIBRIDGE_BEARER_TOKEN` (`router/src/auth.rs`).
   - Request body limit of 1,048,576 bytes (`router/src/validate.rs:72`).
   - Concurrency guard: increments atomic counter. If inflight requests exceed 64, request is rejected with HTTP 429 Too Many Requests and `Retry-After: 1` (`router/src/routes.rs:279-291`).
   - Schema validation against `contracts/v1/triggerInputSchema.json`.
3. **Commit-before-202 WAL insertion:**
   - The router prepares an admission row and writes it to `ingress_outbox` (`router/src/outbox.rs:570-575`).
   - SQLite executes with `PRAGMA synchronous = FULL` in WAL mode.
   - If SQLite write or commit fails, router returns HTTP 503 Service Unavailable (`router/src/routes.rs:14`). Under no circumstances is HTTP 202 returned without a committed database row.
4. **Admission response:**
   - Once commit succeeds, the router returns HTTP 202 Accepted containing `job_id`, `target_agent_id`, `status_url`, and `schemaVersion`.
5. **Worker pickup and dispatch:**
   - `aibr worker` acquires a 30-second claim lease on the row (`router/src/policy.rs:32`).
   - Worker verifies project path containment, updates local job state in `${stateDir}/jobs/<job-id>.json`, and executes agent commands through `opencode serve`.

## 5. Persistence, consistency, retries, and recovery boundaries

AIBridge separates persistence into distinct durable stores with explicit invariants:

| Store | Implementation | Location | Invariant |
|---|---|---|---|
| Ingress outbox | SQLite (WAL mode, `synchronous=FULL`) | `AIBRIDGE_INGRESS_OUTBOX` | Commit-before-202: HTTP 202 requires committed WAL row (`router/src/outbox.rs:5`) |
| Mesh inbox | SQLite table `mesh_inbox_commands` | `src/mesh/inbox/migrations.ts:64` | Durable effect state: `not_started`, `runtime_accepted`, `result_recorded` (`src/mesh/inbox/types.ts:66`) |
| Event store | SQLite `SqliteEventStore` | `src/orchestration/event-store/` | Append-only event sequence, immutable monotonic revisions (ADR 0003) |
| Controller leases | SQLite `SqliteLeaseStore` | `src/mesh/lease/sqlite-lease-store.ts` | Monotonic epoch fencing; split-brain prevention (ADR 0004) |
| Jobs store | `JsonFileJobStore` | `${stateDir}/jobs/${job.id}.json` | Atomic write via temporary file (`.json.tmp` rename, `src/jobs/store.ts:36-40`) |

### Profile directory resolution

Local state directories are resolved via `resolveProfilePaths` (`src/host/paths.ts:95-113`):
- Configuration: `${XDG_CONFIG_HOME:-~/.config}/aibridge/<profile>/`
- Data: `${XDG_DATA_HOME:-~/.local/share}/aibridge/<profile>/`
- Secrets: `${XDG_DATA_HOME:-~/.local/share}/aibridge/<profile>/secrets/`
- State: `${XDG_STATE_HOME:-~/.local/state}/aibridge/<profile>/`
- Jobs: `${stateDir}/jobs/<job-id>.json`

### Retries, backoff, and recovery

- **Outbox retry policy (`router/src/policy.rs:21-29`):**
  - Maximum delivery attempts: 8 (`MESH_OUTBOX_MAX_ATTEMPTS = 8`).
  - Exponential backoff schedule: `[1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, 300s]` (`DELIVERY_BACKOFF_MS`).
  - Backoff ceiling: 300,000 ms (5 minutes).
  - Jitter: Full jitter drawn uniformly in `0..=backoff_delay_ms(attempts)`.
- **Claim lease recovery:** Stale claims with leases older than 30,000 ms (`MESH_OUTBOX_CLAIM_LEASE_MS`) are automatically released by `recover_stale` for redelivery.
- **Job execution timeouts:** Configured via `timeouts.default_job_seconds` (default 1800 seconds / 30 minutes, `src/config/schemas.ts:76`). Expired jobs are transitioned to terminal status and reported.
- **Callback retry attempts:** Configured via `timeouts.callback_retry_attempts` (default 3, `src/config/schemas.ts:77`).

## 6. Authentication and authorization path

```text
Request ──► Bearer Check ──► Allowed Sources ──► Project Allowlist ──► Safety Floor
            (Token == Env)   (Agent in config)   (Canonical path)      (Immutable core)
```

1. **Authentication modes (`src/config/schemas.ts:23,65`):**
   - Configured via `security.auth_mode`: enum `["bearer-token", "none"]`, defaulting to `"bearer-token"`.
   - Bearer token is loaded from `AIBRIDGE_BEARER_TOKEN` (`router/src/config.rs:34`). The router verifies tokens in constant time to prevent timing side channels (`router/src/auth.rs`).
2. **Caller authorization (`src/config/schemas.ts:25-29`):**
   - Senders must match an entry in `security.allowed_sources`. Each allowed source specifies permitted capabilities and whether plan approval is required.
3. **Operator credentials (`src/bridge.ts:99`):**
   - Sourced from `AIBRIDGE_OPERATOR_TOKEN`.
   - Authorizes human operator `actor` claims for charter approval or direct intervention. If absent, operator-privileged actions fail closed.
4. **OpenCode daemon authentication (`src/cli.ts:901-904,1140-1145`):**
   - Sourced from `OPENCODE_SERVER_PASSWORD` environment variable.
   - Fallback: reads password directly from `${secretsDir}/opencode_password`.
5. **Secret scrubbing and redaction:**
   - Secret redaction pipelines (`src/security/`, `src/memory/redaction/`) scrub sensitive tokens, passwords, and private keys before logging, state serialization, or diagnostics bundle export.

## 7. Supported limits and platform assumptions

### Numerical and operational limits

| Parameter | Limit | Enforcing Anchor |
|---|---|---|
| HTTP request body ceiling | 1 MiB (1,048,576 bytes) | `src/server/app.ts:80`, `router/src/validate.rs:72` |
| Maximum inflight requests | 64 concurrent | `router/src/routes.rs:279` |
| Router process memory cap | 32 MiB (`MemoryMax=32M`) | `router/src/validate.rs:70` |
| Outbox delivery attempts | 8 attempts | `router/src/policy.rs:29` |
| Outbox backoff ceiling | 300,000 ms (5 minutes) | `router/src/policy.rs:26` |
| Outbox claim lease duration | 30,000 ms | `router/src/policy.rs:32` |
| Peer discovery probe timeout | 2000 ms per peer | `src/cli/setup-step-widgets.ts:999` |
| Default job duration timeout | 1800 seconds (30 minutes) | `src/config/schemas.ts:76` |
| Callback delivery retries | 3 attempts | `src/config/schemas.ts:77` |

### Toolchain versions

- **Rust Minimum Supported Rust Version (MSRV):** Rust 1.94 (`router/Cargo.toml:18`).
- **Rust CI and release pinned toolchain:** Rust 1.99.0 (`rust-toolchain.toml`, `.github/workflows/ci.yml:68`).
- **JavaScript / TypeScript runtime:** Bun 1.3.14 pinned (`.github/workflows/ci.yml:23`, `.github/workflows/publish.yml:26`).

### Platform build matrix

Five binary targets are compiled by `scripts/build-matrix.sh:31-37`:
1. `x86_64-unknown-linux-musl`
2. `aarch64-unknown-linux-musl`
3. `x86_64-unknown-linux-gnu`
4. `x86_64-apple-darwin`
5. `aarch64-apple-darwin`

### Platform assumptions

- **Operating system:** Linux (systemd with glibc or musl) or macOS (Darwin 64-bit arm64/x64).
- **Network infrastructure:** Tailscale daemon running locally (`/var/run/tailscaled.sock` or `tailscale` CLI in PATH).
- **Supervision:** Headless sessions require `tmux` in system PATH (`scripts/tmux-start.sh`) or Herdr terminal backend integration.

## 8. External dependencies and known limitations

### External dependencies

1. **Tailscale:** Provides private WireGuard mesh networking. `aibr-router` requires an active Tailscale IP on the interface named by `bridge.host`.
2. **OpenCode (`opencode` or `opencode2` in PATH):** Required execution runtime for code modifications and workspace interactions.
3. **SQLite 3:** Embedded statically in `aibr-router` (via `rusqlite`) and in the engine (via `bun:sqlite`).
4. **tmux:** Default terminal multiplexer for background session persistence.

### Known limitations and discrepancies

1. **`aibr-router` CLI arguments:** The router binary implements only `--preflight` and `--init-store` arguments (`router/src/main.rs:95-108`). It has no `--version` mode and rejects unrecognized arguments with exit code 78 (`EX_CONFIG`).
2. **Diagnostics bundle router version probe:** Because `aibr-router` lacks `--version`, `aibr bundle` diagnostics probe (`src/diagnostics/bundle.ts:47-58`) fails to obtain a version string and records `routerVersion: null`.
3. **Arm64 GNU Linux platform packaging:** The platform package `@nyugennguyen/aibridge-linux-arm64-gnu` is defined in `src/host/binaries.ts:24-27,96-99`, but `scripts/build-matrix.sh:31-37` does not compile `aarch64-unknown-linux-gnu` (it builds `aarch64-unknown-linux-musl`).
4. **Setup wizard port 4095 probe:** Setup step network probing (`src/cli/setup-step-widgets.ts:127`) defaults to checking port 4095 as an old router probe default; in production, no service binds 4095. Bridge binds 8787 and OpenCode binds 4096.
5. **Historical recovery runbooks:** The operational runbook at [`Docs/archive/failure-modes-and-recovery.md`](../archive/failure-modes-and-recovery.md) documents an intended recovery surface (`aibr db`, `aibr sessions`, `aibr lease`) that is not implemented in the current CLI. It is retained as a historical design record.

## 9. Source files and tests validating architectural claims

| Architectural Claim | Source File Reference | Validating Test Reference |
|---|---|---|
| Ingress bind preflight & address validation | `router/src/bind.rs:5-8`, `router/src/config.rs:146-148` | `router/tests/bind.rs`, `tests/unit/host/preflight.test.ts` |
| Ingress body ceiling (1 MiB) & inflight cap (64) | `router/src/validate.rs:72`, `router/src/routes.rs:279-291`, `src/server/app.ts:80` | `router/tests/bounds.rs`, `tests/unit/server/route-boundary.test.ts` |
| Commit-before-202 WAL persistence | `router/src/outbox.rs:5-13`, `router/src/routes.rs:10-21` | `router/tests/crash_matrix.rs`, `tests/unit/mesh/outbox/crash-boundaries.test.ts` |
| Outbox delivery retries & backoff schedule | `router/src/policy.rs:21-29` | `router/tests/backoff.rs`, `tests/unit/mesh/outbox/backoff-parity.test.ts` |
| Bearer token authentication & security | `router/src/auth.rs`, `src/config/schemas.ts:23`, `src/bridge.ts:94-99` | `router/tests/auth.rs`, `tests/integration/auth-mode.test.ts`, `tests/unit/security/auth-provider.test.ts` |
| Secret redaction and scrubbing | `src/security/`, `src/memory/redaction/` | `tests/security/redaction-audit.test.ts`, `tests/security/golden-logs.test.ts` |
| Mesh inbox command states & effect boundaries | `src/mesh/inbox/migrations.ts:64`, `src/mesh/inbox/types.ts:66` | `tests/unit/mesh/inbox/inbox-store.test.ts`, `tests/unit/mesh/inbox/launch-outcome.test.ts` |
| Controller leases and epoch fencing | `src/mesh/lease/lease.ts`, `src/mesh/lease/sqlite-lease-store.ts` | `tests/unit/mesh/lease/claim-renew-release.test.ts`, `tests/unit/mesh/lease/split-brain.test.ts` |
| Advisory roundtable deliberation invariant | `src/orchestration/policy/immutable-core.ts:53,95`, `src/orchestration/roundtable/aggregate.ts:19` | `tests/unit/orchestration/roundtable.test.ts`, `tests/unit/orchestration/immutable-core.test.ts` |
| Jobs file store atomic persistence | `src/jobs/store.ts:12-60`, `src/host/paths.ts:95-113` | `tests/unit/jobs/manager.test.ts` |
| Router CLI modes & argument validation | `router/src/main.rs:95-117` | `router/tests/cli_modes.rs` |
| Support bundle diagnostic router version probe | `src/diagnostics/bundle.ts:47-58` | `tests/unit/diagnostics/bundle.test.ts` |
| Platform packages & binary resolution | `src/host/binaries.ts:21-28`, `scripts/build-matrix.sh:31-37` | `tests/unit/host/binaries.test.ts` |
| Toolchain pinning & compilation matrix | `router/Cargo.toml:18`, `rust-toolchain.toml`, `.github/workflows/ci.yml` | `tests/unit/release/ci-workflow.test.ts` |
