# AIBridge Failure Mode Inventory and Operator Recovery Runbooks

Document version: 1.0.0 (Milestone 8 Hardening and Ecosystem)
Status: Released / Verified
Classification: Operational Architecture and Incident Response

---

## 1. Executive Summary & Recovery Principles

AIBridge is a distributed agent mesh connecting OpenCode and local execution daemons over private Tailscale networks with a native Rust ingress router (`aibr-router`) and a Bun/TypeScript engine/worker.

### 1.1 Inviolable Operational Invariants
1. **Authoritative Log Immutability:** Event stores and journal logs are append-only. Repair tooling must **never** rewrite, fabricate, or delete authoritative history to make projections "look clean".
2. **Terminal Outbox Rows are Evidence:** A failed or unroutable outbox row (in `ingress_outbox`, `egress_outbox`, or mesh outbox) is retained with its terminal error code and timestamp for forensic audit. Deleting terminal rows to clear backlogs is strictly forbidden.
3. **Conservative Mutation:** All repair and restore commands default to inspect-and-export mode. Active mutation requires explicit `--backup` validation prior to execution.
4. **Fail-Closed Admission:** If the ingress store (`ingress_outbox`) is absent, unreadable, or corrupt, `aibr-router` exits with configuration error status `78`. It never falls back to uncommitted in-memory buffering.
5. **Two-Tier Validation Security:** The router is an ingress structural gate, never an authorization authority. The engine worker re-parses and enforces source authorization, project allowlists, and plan approvals independently.

---

## 2. Failure Mode Inventory Matrix

| ID | Failure Mode | Severity | RPO | RTO | Primary Automated Guardrail |
|---|---|---|---|---|---|
| **FM-01** | TUI crash while agents continue | Low | 0s | < 5s | TUI/Engine process decoupling via tmux and headless daemon |
| **FM-02** | Node daemon crash before/after command persistence | Medium | 0s | < 15s | Idempotent inbox deduplication (`dispatch_id`, SQLite WAL) |
| **FM-03** | Controller crash before/after event commit | High | 0s | < 30s | Transactional commit barrier + lease timeout renegotiation |
| **FM-04** | SQLite WAL recovery and failed integrity check | Critical | < 1 event | < 2m | `PRAGMA integrity_check`, atomic snapshot restore, WAL replay |
| **FM-05** | Corrupt projection with intact event log | Medium | 0s | < 1m | Deterministic projection rebuild from immutable event sequence |
| **FM-06** | Corrupt / poison event or outbox item | High | 0s | < 3m | Quarantine isolation table / dead-letter status, poison skip |
| **FM-07** | Disk full during append, artifact write, or migration | Critical | 0s | < 5m | Disk space preflight check, write abort before journal corruption |
| **FM-08** | Interrupted schema migration | High | 0s | < 2m | Transactional schema migration with automatic rollback |
| **FM-09** | Lost/revoked worker and orphaned session | Medium | 0s | < 30s | Worker heartbeat timeout, session orphan reaping, lease revoke |
| **FM-10** | Expired lease with unreachable nodes | Medium | 0s | < 1m | Fencing tokens, epoch progression, lease takeover protocol |
| **FM-11** | Unsupported newer config/database/protocol version | Medium | 0s | < 30s | Strict version envelope preflight, graceful fail-stop (`VERSION_REFUSED`) |
| **FM-12** | Ingress router crash (pre/post commit, during claim) | High | 0s | < 10s | SQLite WAL `synchronous=FULL`, claim lease timeout reassignment |
| **FM-13** | `ingress_outbox` deleted or unreadable | Critical | 0s | < 30s | Router fatal exit `78` (EX_CONFIG); operator repair/restore |
| **FM-14** | `egress_outbox` destination unresolvable / origin unlisted | High | 0s | < 1m | Retained terminal row with `terminal_error`, origin pinned, no leak |
| **FM-15** | `ingress_mode` rollback mid-soak with queued rows | Medium | 0s | < 1m | Worker drains residual SQLite queue to empty before listener cutover |
| **FM-16** | Rust binary version mismatch against npm package | High | 0s | < 15s | Startup handshake verifier halts mismatch before socket bind |

---

## 3. Detailed Failure Mode Runbooks

### FM-01: TUI Crash While Agents Continue
- **Context:** Operator terminal emulator closes, crashes, or receives SIGSEGV while autonomous jobs are active.
- **Automated Behavior:** AIBridge TUI communicates with the underlying worker daemon via local IPC/socket. The worker runs inside a detached tmux session or systemd service (`aibr-worker.service`), decoupled from TUI lifecycle.
- **Detection:** TUI process disappears; `aibr status -p <profile>` reports healthy engine and active background sessions.
- **Operator Steps:**
  1. Verify background process health:
     ```bash
     aibr status -p <profile>
     ```
  2. Re-attach to the interactive session:
     ```bash
     aibr tui -p <profile>
     ```
  3. Or inspect logs directly:
     ```bash
     tail -f ~/.aibridge/profiles/<profile>/logs/worker.log
     ```
- **Verification:** Jobs continue progressing without task state loss.

---

### FM-02: Node Daemon Crash (Before/After Command Persistence)
- **Context:** Host power loss, OOM kill, or SIGKILL of the worker node executing dispatched agent tasks.
- **Automated Behavior:**
  - *Crash before persistence:* The command was not acknowledged to the mesh controller. The controller lease expires, and the command is re-dispatched to an available node.
  - *Crash after persistence:* The command is stored in `mesh_inbox.db` with state `received` or `in_progress`. Upon restart, the recovery loop inspects uncompleted commands. If state was committed, execution resumes or reports status deterministically using idempotent `dispatch_id`.
- **Operator Steps:**
  1. Restart the worker node daemon:
     ```bash
     aibr worker -p <profile>
     ```
  2. Inspect inbox status:
     ```bash
     aibr db status -p <profile> --table mesh_inbox
     ```
  3. Verify recovery log:
     ```bash
     grep "inbox_recovery" ~/.aibridge/profiles/<profile>/logs/worker.log
     ```
- **Verification:** No duplicate execution of commands; inbox state updates to terminal status.

---

### FM-03: Controller Crash (Before/After Event Commit)
- **Context:** Central mesh controller crashes during orchestration turn.
- **Automated Behavior:**
  - *Before event commit:* SQLite transaction rolls back. Event sequence number does not advance. Client retries dispatch; deduplication gate handles replay safely.
  - *After event commit:* Event is safely written in WAL/database. Upon restart, controller reloads the latest snapshot + replays events from last committed sequence number.
- **Operator Steps:**
  1. Restart controller daemon:
     ```bash
     aibr start -p <profile>
     ```
  2. Check event sequence continuity:
     ```bash
     aibr db verify -p <profile> --table event_store
     ```
- **Verification:** Projection state matches the last committed sequence number.

---

### FM-04: SQLite WAL Recovery and Failed Integrity Check
- **Context:** System crash causes SQLite database file corruption or unreadable WAL frames.
- **Automated Behavior:** On open, SQLite performs automatic WAL checkpoint recovery. If `PRAGMA integrity_check` fails, the storage driver emits `CORRUPT_DATABASE` error and refuses read/write operations.
- **Operator Steps:**
  1. Run diagnostic integrity check:
     ```bash
     aibr db check -p <profile> --all
     ```
  2. If errors are reported, perform an automatic pre-repair backup:
     ```bash
     aibr db backup -p <profile> --out ~/.aibridge/backups/pre-repair-$(date +%s).bak
     ```
  3. Run safe restore/repair:
     ```bash
     aibr db repair -p <profile> --table <database_name> --backup
     ```
  4. Verify integrity after recovery:
     ```bash
     aibr db check -p <profile> --all
     ```
- **Verification:** `PRAGMA integrity_check` returns `ok`.

---

### FM-05: Corrupt Projection with Intact Event Log
- **Context:** Projection cache or SQLite materialized view exhibits corrupted indices or stale counters while raw `event_store` is intact.
- **Automated Behavior:** AIBridge treats projections as derived caches. If a projection mismatch is detected, the projection engine stops updating and reports a degraded state.
- **Operator Steps:**
  1. Export the authoritative event log to ensure safety:
     ```bash
     aibr db export -p <profile> --table event_store --out events_dump.json
     ```
  2. Rebuild projections from genesis/snapshot:
     ```bash
     aibr db rebuild-projections -p <profile> --force
     ```
  3. Verify state alignment:
     ```bash
     aibr status -p <profile>
     ```
- **Verification:** Rebuilt projections reflect identical sequence count and state hash as the event log.

---

### FM-06: Corrupt / Poison Event or Outbox Item
- **Context:** A malformed payload passes wire deserialization but causes runtime panic or unhandled rejection in the reducer/processor.
- **Automated Behavior:**
  - Exponential backoff kicks in (capped retries).
  - After maximum attempts (e.g., 5 attempts), the item transitions to `poisoned` or `terminal_failure` and is routed to a quarantine partition.
  - The queue processing loop unblocks and proceeds to subsequent messages.
- **Operator Steps:**
  1. Inspect quarantined poison items:
     ```bash
     aibr db quarantine list -p <profile>
     ```
  2. Export the poison item for forensic investigation:
     ```bash
     aibr db quarantine export -p <profile> --id <poison_id> --out poison-sample.json
     ```
  3. Mark as acknowledged terminal failure (never delete):
     ```bash
     aibr db quarantine retain -p <profile> --id <poison_id> --reason "Investigated in INC-441"
     ```
- **Verification:** Queue processing latency returns to baseline; poison record remains archived in SQLite.

---

### FM-07: Disk Full During Append, Artifact Write, or Migration
- **Context:** Host filesystem runs out of free space (0 bytes available) during operation.
- **Automated Behavior:**
  - Preflight disk space assertions prevent start if space is < 50MB.
  - Atomic write routines write to a temporary file in the same filesystem and fsync before rename. If disk runs full, the atomic swap fails, preserving the original file.
- **Operator Steps:**
  1. Free up disk space on the partition (e.g. rotate old diagnostic logs, clean temporary artifacts):
     ```bash
     df -h ~/.aibridge
     ```
  2. Inspect database integrity:
     ```bash
     aibr db check -p <profile> --all
     ```
  3. Restart worker:
     ```bash
     aibr worker -p <profile>
     ```
- **Verification:** Databases open without corruption; pending writes resume successfully.

---

### FM-08: Interrupted Schema Migration
- **Context:** Migration interrupted mid-execution (power loss or SIGKILL).
- **Automated Behavior:** All schema migrations execute inside a single transactional block `BEGIN IMMEDIATE ... COMMIT`. If interrupted, SQLite rolls back changes atomically to `user_version` prior to migration.
- **Operator Steps:**
  1. Check current schema version:
     ```bash
     aibr db version -p <profile>
     ```
  2. Rerun pending migrations:
     ```bash
     aibr db migrate -p <profile>
     ```
- **Verification:** Schema version advances to target version cleanly.

---

### FM-09: Lost / Revoked Worker and Orphaned Session
- **Context:** Worker node disconnects permanently or has its peer key revoked while running sessions.
- **Automated Behavior:**
  - Heartbeat monitor misses 3 consecutive beats (exceeds threshold).
  - Controller marks worker as `offline` and its lease as `revoked`.
  - Active sessions transition to `orphaned` state with reason `WORKER_DISCONNECTED`.
- **Operator Steps:**
  1. Re-evaluate session status:
     ```bash
     aibr sessions list -p <profile> --state orphaned
     ```
  2. Reassign orphaned sessions to healthy nodes:
     ```bash
     aibr sessions reassign -p <profile> --session-id <session_id> --target-node <node_id>
     ```
- **Verification:** Sessions resume execution on the newly assigned node.

---

### FM-10: Expired Lease with Unreachable Nodes
- **Context:** Split-brain or network partition causes controller lease to expire while a node cannot reach peers.
- **Automated Behavior:** Nodes enforce lease fencing. When `lease_time_remaining <= 0`, the local command gate rejects any further dispatch or execution, preventing split-brain writes.
- **Operator Steps:**
  1. Verify Tailscale connectivity:
     ```bash
     tailscale status
     tailscale ping <peer_ip>
     ```
  2. Check lease status:
     ```bash
     aibr lease status -p <profile>
     ```
  3. Force lease renewal or takeover once partition resolves:
     ```bash
     aibr lease renew -p <profile>
     ```
- **Verification:** Lease acquired with incremented epoch counter; command gate unlocks.

---

### FM-11: Unsupported Newer Config / Database / Protocol Version
- **Context:** Binary was downgraded, or a database created by a newer release is opened by an older binary.
- **Automated Behavior:** Preflight reads schema version / config version. If `version > SUPPORTED_MAX_VERSION`, the process halts with `VERSION_REFUSED` exit code 78 without performing any write or migration.
- **Operator Steps:**
  1. Inspect version mismatch report:
     ```bash
     aibr preflight -p <profile>
     ```
  2. Upgrade the binary to the required version:
     ```bash
     npm install -g @nyugennguyen/aibridge@latest
     ```
- **Verification:** Binary version aligns with store version; startup succeeds.

---

### FM-12: Ingress Router Crash (Pre/Post Admission, During Claim)
- **Context:** `aibr-router` process crashes before admission commit, after commit but before HTTP 202 response, or while worker holds an outbox claim.
- **Automated Behavior:**
  - *Pre-commit crash:* Request was not committed to `ingress_outbox`. Client receives connection reset and retries.
  - *Post-commit crash before 202:* Request is safely committed to SQLite with state `pending`. Worker will drain and execute it. Idempotent client retry detects existing job ID and returns 202/status.
  - *Crash during claim:* Worker claim leases expire after claim timeout (default 60s). Unacknowledged claims revert to `pending` for re-drain.
- **Operator Steps:**
  1. Start router daemon:
     ```bash
     systemctl restart aibr-router.service # or launchctl kickstart
     ```
  2. Verify admission queue depth and oldest row age:
     ```bash
     aibr db status -p <profile> --table ingress_outbox
     ```
- **Verification:** All committed jobs drain without duplication or stuck claim locks.

---

### FM-13: `ingress_outbox` Deleted or Unreadable
- **Context:** SQLite admission file is deleted or permissions are corrupted.
- **Automated Behavior:** Router tests file presence and permissions on bind preflight. If absent or invalid, it exits immediately with code `78` (EX_CONFIG). It **never** falls back to memory buffering (ADR 0008 §2.4).
- **Operator Steps:**
  1. Provision a fresh store if initialization is desired:
     ```bash
     aibr-router --init-store --profile <profile>
     ```
  2. Or restore from the latest verified backup:
     ```bash
     aibr db restore -p <profile> --table ingress_outbox --from ~/.aibridge/backups/ingress-latest.bak
     ```
  3. Rerun preflight:
     ```bash
     aibr-router --preflight --profile <profile>
     ```
- **Verification:** Preflight returns exit 0; router starts and reports queue depth 0.

---

### FM-14: `egress_outbox` Destination Unresolvable / Origin Unlisted
- **Context:** Report callback destination URL fails DNS/origin validation or attempts to route to an unapproved network origin (F-02).
- **Automated Behavior:**
  - Egress validator checks target against allowlisted agent URLs *before* header synthesis.
  - If origin is unlisted or DNS is unresolvable, the row is marked `terminal_failure` with error code `ORIGIN_FORBIDDEN` or `DESTINATION_UNRESOLVABLE`.
  - The row is retained permanently as evidence. No credentials or payload fragments are ever dispatched.
- **Operator Steps:**
  1. Inspect terminal egress outbox records:
     ```bash
     aibr db status -p <profile> --table egress_outbox --terminal
     ```
  2. Verify origin allowlist in config:
     ```bash
     aibr config get -p <profile> agents
     ```
- **Verification:** Terminal row exists with full diagnostic metadata; zero credential leakage verified in audit log.

---

### FM-15: `ingress_mode` Rollback Mid-Soak with Queued Rows
- **Context:** Operator rolls back configuration from `ingress_mode: "router"` back to `"engine"` while admitted jobs remain in `ingress_outbox`.
- **Automated Behavior:** Worker drainer continues reading and executing queued entries from `ingress_outbox` until queue depth reaches 0. The engine HTTP server does not accept conflicting job IDs.
- **Operator Steps:**
  1. Drain remaining ingress queue:
     ```bash
     aibr worker --profile <profile> --drain-only
     ```
  2. Verify queue depth is 0:
     ```bash
     aibr db status -p <profile> --table ingress_outbox
     ```
  3. Start bridge in engine mode:
     ```bash
     aibr serve -p <profile>
     ```
- **Verification:** All queued requests are processed before engine takes over ingress port.

---

### FM-16: Rust Binary Replaced by Incompatible Build
- **Context:** Incompatible router binary placed in PATH or deployed during rolling update.
- **Automated Behavior:** Engine startup preflight invokes `aibr-router --version` and validates protocol version hash against expected contract version in npm package. If mismatched, startup halts with exit 1 and actionable error message.
- **Operator Steps:**
  1. Check versions:
     ```bash
     aibr-router --version
     aibr --version
     ```
  2. Deploy matching router binary matching the current engine distribution:
     ```bash
     scripts/build-matrix.sh
     ```
- **Verification:** Both components report identical contract schema hash and compatible semantic versions.

---

## 4. Verification and Tabletop Exercise Records

Every runbook scenario above has been exercised against packaged artifacts in deterministic tabletop simulations.
Automated coverage is verified in:
- `tests/recovery/` (unit and integration fault test suites)
- `router/tests/crash_matrix.rs` (1000-cycle kill/restart zero-loss verification)
- `tests/load/` (bound and disk space flood scenarios)
