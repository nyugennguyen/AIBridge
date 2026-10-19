# Maintainability Audit — Phase 2: Verification & Safety

> **v2 note:** this report preserves the v1 evidence. Classification corrections (e.g.
> MNT-205 NEED EVIDENCE → SIMPLIFY) and reconciled finding IDs live in
> `audit-changelog.md` (C1–C7) and `findings-register.md` (v2).

**Date:** 2026-10-19 · **Commit:** `6dc9b04` · Sources: `TestsMap` scout (reviewed),
`RustContractsMap` scout (reviewed), lead-reviewer measurements. Claims marked
[Verified] were re-checked first-hand in this session.

## 1. Test inventory & runners (measured)

| Runner | Command | Result | Duration |
|---|---|---|---|
| Bun built-in 1.3.14 (what CI + `release:check` run) | `bun test` | **5,977 pass / 5 skip / 0 fail**, 5,982 tests, 278 files | 21.8s |
| Vitest 4.1.9 on Node (what `bun run test` runs) | `bun run test` | **7 failed / 5,970 passed / 5 skipped**, same 5,982 tests, 278 files | 20.5s |

Structure (verified counts): `tests/unit` 264 TS files (~233 `*.test.ts` + fixtures, 38
subdirs; largest `mesh/` 58, `orchestration/` 25, `rules/` 18), `tests/integration` 26,
`tests/contracts` 19, `tests/load` 4, `tests/recovery` 3, `tests/security` 3
(plus `tests/unit/security/` 3 — security tests live in two places).

### MNT-201 — The two runners disagree at HEAD; the CI-green runner hides 7 failures [Verified]

- `bun run test` (documented in `CONTRIBUTING.md:91` as "Vitest test suite") fails 7× in
  `tests/unit/host/runtime.test.ts > ProcessRunner > BunProcessRunner`
  (`exitCode` null, empty stdout/stderr).
- Root cause verified in `src/host/runtime.ts`: `BunProcessRunner.exec` calls `Bun.spawn`;
  under Node `Bun` is undefined, the `catch` returns `{exitCode: null, stdout: "",
  stderr: <error message>}` — a silent no-op result shape instead of a loud failure.
- CI (`ci.yml:45`) and `release:check` run `bun test`, so the failure never blocks anything.
- Production exposure is limited (verified): `BunProcessRunner` consumers are
  `src/cli.ts`, `src/cli/verify.ts`, `src/cli/update.ts`; CLI shebang is `#!/usr/bin/env bun`.
  But `bun run dev` = `tsx src/index.ts` runs the engine on Node where the class silently
  no-ops.
- Additionally the runners do not cover identical behavior: `tests/unit/event-store/outbox-helpers.ts`
  (`BACKENDS = ["node","bun"]`) `describe.skip`s the `bun:sqlite` driver under vitest —
  bun-only SQLite paths are exercised only by `bun test`.
- Docs disagree about which runner is authoritative: `AGENTS.md:19` ("bun test … vitest is
  `bun run test`") vs `CONTRIBUTING.md:91` ("bun test # Vitest test suite"). [Verified]

### MNT-202 — Test noise: discovery UI prints to stdout during test runs [Verified]

"Tailnet Agent Discovery" interactive output is printed ~7× per run under both runners
(captured in the timing log). Tests exercising `src/` discovery print operator UI; output
hides real failures and implies live tailscale probing during tests.

## 2. Verification matrix (subsystem → evidence → invariant protected)

Condensed from the reviewed `TestsMap` matrix; representative invariant names retained.

| Subsystem | Key suites | Invariants protected |
|---|---|---|
| Orchestration kernel | `coordinator`, `command-matrix-conformance`, `invariants`, `transitions`, `audit-{replay,crash-safety,authorization}`, `scheduler/*` | Command+event bound together; `COMMAND_EVENT_ALLOWLIST` derived from Zod (anti-drift); idempotent duplicate commands; runtime effects outside the event transaction; crash-before-append commits nothing; digest-bound approval; controller epoch/lease |
| Charter & immutable core | `charter*`, `immutable-core`, `roles`, `workflows/*` | `charter_core_violation` refusal pre-pending; six-item core refusal + digest; append-only role versions; instantiated workflow snapshots immutable |
| Roundtable (advisory) | `roundtable*`, `budgets/roundtable-fanout`, `integration/remote-roundtable`, `mesh/fault/roundtable-relay` | `roundtable.closed` in zero allowlist entries; `roundtable_required` dispatch gate; memory write-back exactly-once with post-id provenance; gapless relayed total order |
| Rules engine | `rules/{compile,evaluate,truth-tables,vacuity,limits,kernel-restrictions,…}` | Deep-frozen compiled sets; byte-identical recompilation; "not" fails closed; universal-pre-approval vacuity refusal; rules cannot grant beyond floor/role |
| Mesh | `mesh/{fault,lease,inbox,outbox,identity,registry,gateway/*}`, `integration/{mesh-flow,controller-takeover,terminal-websocket}` | Five retransmissions → one session/execution/inbox row; restart preserves rows+session; lower-epoch command persists nothing; F1 input-ownership exclusivity; WS auth-before-upgrade; revocation closes sockets |
| Ingress/router | `ingress/*`, `load/ingress-limits`, `router/tests/{fixtures,backoff,gates,crash_matrix}.rs` | Commit-before-202; 1 MiB body cap; inflight 64; admission ≠ authorization; accept/reject parity with TS |
| Budgets | `budgets/{reservation,ledger,recovery,adversarial,…}` | No oversubscription (200 trials); atomic reservation; crash between reserve/release recoverable without double counting |
| Memory | `memory/*`, `memory/redaction/*`, `context-isolation` | Closed ontology; scope isolation refuses cross-project queries; supersession never mutates bytes; SF-1…SF-9 regression corpus; deterministic context assembly |
| Notifications (advisory) | `notifications/{ack,dedupe,quieting,isolation,no-secrets,…}` | Adapter failures never throw into orchestration; content-immutable observations; canary audit over every populated field |
| Security | `tests/security/{canary-token-audit,golden-logs,redaction-audit}`, `contracts/runtime/sanitizer` | Canaries never leak into logs/signals/bundles; bearer never forwarded to unlisted origins (F-02); child-env secret stripping |
| Contracts | `tests/contracts/*`, `router/tests/fixtures.rs` | Zod ⇄ JSON Schema ⇄ (ajv/serde) acceptance **and** rejection parity; committed cross-language vector |
| Release/CI workflows | `unit/release/{ci,publish}-workflow`, `unit/packaging-ci`, `integration/package-smoke` | Exactly one publishing workflow; tag↔version; gitHead preflight; exact dependency pins |
| Docs/installer | `unit/documentation/*`, `unit/installer/*`, `docs:check` | Doc commands exist; safe-uninstall alerts; installer file contract |
| Recovery | `recovery/kill-restart-1000-cycles`, `database-integrity`, `failure-modes` | 1,000 real fsync'd WAL cycles zero-loss; M8.2 repair tooling |

**Conclusion:** the critical invariants (kernel authority, immutable core, advisory-only
deliberation, budget ceilings, secret handling, contract parity) are each backed by named,
anti-vacuous tests. This is the repo's strongest area.

## 3. Contract parity review (from `RustContractsMap`, spot-verified)

Canonical source = Zod (`src/config/{config,schemas}`, `src/orchestration/schemas.ts`,
`src/ipc/schemas.ts`) → `contracts/v1/*.schema.json` (48) → typify →
`router/src/contracts.rs` (35-file partition) + `crates/aibr-ipc/src/contracts.rs` (13-file
partition). All four generated outputs committed and diff-gated (`contracts:check`, CI).
A stale `bridge-config.schema.json` once shipped before the gate existed
(`package.json:_contractsCheckWhy`) — the gate is incident-driven and load-bearing.

Gaps (keep as findings):

- **Parity vector covers one closure only.** The 15 fixtures in `tests/contracts/examples/`
  are the sole cross-language accept/reject vector (orchestration closure). Ingress (12)
  and IPC (13) schema families have no cross-language fixtures; charter/roundtable closure
  (8 schemas) is TS-only (`charter-roundtable-parity.test.ts`). [Scout evidence; consistent
  with file inventory — Verified]
- **`PROTOCOL_VERSION` ↔ `IPC_PROTOCOL_VERSION` untested.** `crates/aibr-ipc/src/lib.rs:78`
  claims `tests/protocol_version.rs` checks the mirror; **the file does not exist** (tests
  dir: `frame_cap_parity.rs`, `frame_codec.rs`, `server_listener.rs`), and no test asserts
  the constant. Same comment block names `tests/socket_path_parity.rs`; those assertions
  actually live in `frame_cap_parity.rs`. [Verified this session]
- **`z.literal` constraints lost in generated Rust.** `StateSnapshot`/`StateDiff` render
  `protocol_version: f64`, `type_: String` while `src/ipc/schemas.ts:76` pins
  `z.literal(1)`; the tag is enforced only by `message.rs::peek_tag`. [Scout evidence;
  inference that a Rust peer accepts protocol-mismatched frames — NEED EVIDENCE]
- **`ingress_outbox` row schema is outside the contract chain** (handwritten DDL
  `router/src/outbox.rs:1263-1318`, consumed by handwritten SQL in
  `src/ingress/drainer.ts`). Drift caught only by tests. [Scout evidence]
- **Backoff/queue policy constants exist in 3+ copies** (`src/mesh/outbox/policy.ts`,
  `router/src/policy.rs`, `router/src/outbox.rs`) with a hand-committed
  `backoff-parity-vector.json` that has **no generator** (unlike `parity-vector.json`).
  [Scout evidence]
- Dual IPC codec implementations (Rust `frame.rs` vs TS `encodeFrame`/`FrameDecoder`) are a
  deliberate 4-line protocol but maintained by convention; the Rust listener currently has
  no production consumer (TUI retired). [Verified consumer grep]

## 4. Safety & reliability: guarantees any simplification MUST preserve

| # | Guarantee | Where enforced | Evidence |
|---|---|---|---|
| G1 | Immutable core: charter cannot relax safety floor, fencing, security perimeter, advisory-roundtable invariant, budgets, kernel authority | `orchestration` immutable-core validator + `immutable-core.test.ts`, `charter*.test.ts` | tests named in §2 |
| G2 | Advisory-only deliberation/notifications: `roundtable.closed` never a command event; notification failures never branch orchestration | `COMMAND_EVENT_ALLOWLIST`, notifications isolation tests | `roundtable.test.ts`, `notifications/isolation.test.ts` |
| G3 | Kernel single source of truth: presentation consumes SSE projections only | event store + reducer; `audit-replay` pure-reduce tests | `reduction` purity tests |
| G4 | Commit-before-202 admission; router admission ≠ authorization (Tier 2 sole authority) | `router/src/outbox.rs`, `src/ingress/worker.ts`, `router/src/lib.rs:22-45` | `router/tests/gates.rs`, `ingress-limits.test.ts` |
| G5 | Constant-time bearer compare; auth per-route; project allowlist + source authorization | `router/src/auth.rs` (subtle), `src/security/*`, server routes | `auth-mode.test.ts`, `unit/security/*` |
| G6 | Secrets: write-once files 0600, never in argv, redacted in logs/signals/bundles | `src/host/profile-store.ts`, `src/host/tmux.ts` env-only, redaction pipeline | `tests/unit/host/tmux.test.ts:192`, canary/redaction audits |
| G7 | Capability envelope = allowed ∩ roleAllowed ∖ denied; prompt digest binding | `runtime/` capability intersection, binder | `capability-envelope.test.ts`, `binder.test.ts` |
| G8 | Budget ceilings non-widening; crash-recoverable reservation | `budgets/*` | `recovery.test.ts`, `adversarial.test.ts` |
| G9 | WS terminal: auth before upgrade, single input owner, revocation closes sockets | `mesh/gateway/terminal` | `terminal-websocket.test.ts`, F1 tests |
| G10 | Cross-language contract parity on committed artifacts | `contracts:check` + CI diff + parity vector | `ingress-parity.test.ts`, `router/tests/fixtures.rs` |

## 5. Failure-handling observations (runtime reliability)

- **Swallowed errors in the OpenCode wait loop** [Verified `src/opencode/monitor.ts:40-43,64-65`]:
  event-stream failure and poll errors are ignored ("Stream failed; polling timer continues"),
  and everything lands on `Timed out waiting for OpenCode session <id>`; the original error
  is discarded. Debugging cost documented in the `debugging-aibr-v2` skill. Reliability
  finding: error attribution is lost at the most common failure point.
- **"Fake success" fallback** [Verified `src/opencode/client.ts:53-64`]: `getSessionStatus`
  returns `state?.type ?? "idle"` in both the status and `session.get` paths — an unknown or
  malformed session reads as `idle`, which can complete a job with zero messages. Silent
  wrong-answer risk (correctness), not just DX.
- `aibr bundle` hardcodes parts of its output (`health.overallOk`, `bindPreflight.ok`,
  `agentId: "unknown-agent"` per skill; CHANGELOG notes `--preview` fixed in 3.0.0).
  [NEED EVIDENCE — not re-verified this session]
- `scripts/tmux-start.sh:16` starts `opencode serve --hostname 0.0.0.0` while
  `AGENTS.md:135` says "Never expose opencode serve publicly", and interpolates
  `OPENCODE_SERVER_PASSWORD` into the tmux command string (visible in process argv),
  while `tests/unit/host/tmux.test.ts:192` enforces "never places secrets in argv" for the
  programmatic backend. The ops script is outside the tested surface. [Verified]

## 6. Testing weaknesses (evidence of maintenance cost)

1. **Fakes remove the seam under test**: `FakeOpencodeClient` in `tests/integration/fixtures.ts`
   means `src/opencode/client.ts`/`monitor.ts` (the §5 failure paths) have almost no direct
   tests (`tests/unit/opencode/` holds one 930-byte file). Runtime adapters are validated
   against fake/scripted adapters; real CLI processes never run.
2. **Source-text assertions as behavior** (break on cosmetic refactors):
   `unit/simulation/determinism.test.ts:177` "no file under `src/simulation/` calls `Date.now`";
   `unit/notifications/tui-adapter.test.ts:60` reads `tui-adapter.ts` source to assert
   interface member order; `unit/notifications/barrel.test.ts` compares regex text for
   schema drift. [Verified]
3. **Barrel/wiring tests copy-pasted 8×** (`unit/*/barrel.test.ts`) — export reachability +
   import-edge + comment-stripper checks; architecture tests, not behavior.
4. **Tests of test scaffolding**: `unit/host/prompter.test.ts`, `unit/host/runtime.test.ts`
   assert fakes satisfy interfaces (`expect(runner).toBeDefined()`).
5. **Giant suites**: `integration/m6-fixtures.ts` 76.6KB, `automation-safety.test.ts`
   1,528 lines, `rules/compile.test.ts` 1,520, `budgets/recovery.test.ts` 1,404 — each
   interleaves 10–20 invariants; failure triage cost is high.
6. **Coverage thin spots** (by file inventory [Verified by directory listing]):
   `src/opencode` (250 lines, 1 small test), `src/upgrade` (1 test), `src/sdk` (1 test),
   `src/observability` (610 lines, no unit suite — covered indirectly by security tests),
   `src/host/daemonizer.ts` (referenced only from `setup-wizard.test.ts`), `src/tasks`,
   `src/planning`, `src/registry/config-registry.ts`.
7. **Mixed eras, no tiering**: everything is `*.test.ts` in one run; no unit/audit/smoke
   separation, no flaky-test quarantine. Slow suite `recovery/kill-restart-1000-cycles`
   documents its own cost (1,000 fsyncs) but runs in the default suite.

## 7. Phase 2 risk register (top items)

| ID | Finding | Confidence | Impact | Class |
|---|---|---|---|---|
| MNT-201 | Runner duality: `bun run test` red at HEAD; CI green | High (measured) | High — silent regressions on the non-CI runner; contributor confusion | SIMPLIFY |
| MNT-203 | `getSessionStatus` silent `idle` fallback can fake success | High (code) | High — wrong "completed" state | NEED EVIDENCE (impact path) → likely fix |
| MNT-204 | Monitor swallows root-cause errors → all failures look like timeouts | High (code) | Medium — recovery/debugging cost | SIMPLIFY |
| MNT-205 | `tmux-start.sh` exposes opencode on 0.0.0.0 + password in argv | High (code) | High if used in production | NEED EVIDENCE (is script used?) |
| MNT-206 | Protocol-version mirror untested; doc names non-existent tests | High (verified) | Medium — drift risk on IPC | SIMPLIFY |
| MNT-207 | Backoff/queue constants in 3+ copies, vector without generator | High (scout) | Medium | SIMPLIFY |
| MNT-208 | Parity vector covers 1 of 4 schema closures cross-language | Medium | Medium | NEED EVIDENCE |
| MNT-209 | Source-text/wiring tests brittle against refactors | High (verified) | Medium — slows safe simplification | SIMPLIFY |
| MNT-210 | OpenCode/monitor untested behind fakes; thin suites in sdk/upgrade/observability | High | Medium | NEED EVIDENCE |

## 8. Verification performed this session

- `bun run typecheck` ✅ 6s · `bun test` ✅ 21.8s · `bun run test` ❌ 7 failures (§1) ·
  `bun run docs:check` ✅ <1s · `bun run build` ✅ 3s · `bun run contracts:check` ✅ 4s ·
  `cargo fmt --all --check` ✅ · `cargo clippy --workspace --all-targets -- -D warnings` ✅ ·
  `cargo test --workspace` ✅ 51s. Full log: `/tmp/audit-timings.log` (this host, warm caches).
