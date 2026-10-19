# AIBridge Pre-Refactoring Verification Audit — Findings Validation & Implementation Readiness

**Status:** FINAL — Audit Complete
**Report path:** `Docs/implementation-reports/maintainability-audit/pre-refactor-verification-report.md`
**Audit target / source revision:** `e7dd900dd8a21bd7246142d1016c530bbb8b21a5`
**Report publication revision:** `a3b8b16e4d45133fc28965a4d14aa7fc35c844b7`
(finalization metadata edit applied afterwards — see `audit-changelog.md` C9 for the
exact commit and changed paths)
**Revision note:** all source evidence, verdicts, and test results in this report were
captured **against the audit target `e7dd900`**. The publication revision `a3b8b16` is
docs-only (`git diff e7dd900..a3b8b16 -- src tests router crates scripts config
package.json .github` is empty — verified), so the evidence describes the same code, but
**no command was re-executed at `a3b8b16`**; nothing here should be read as a test
result for any revision other than `e7dd900` (§D).
**Auditor role:** lead auditor; sub-agent scouts gathered source evidence which the
auditor re-verified before inclusion. (Note: the harness exposes `scout`/`task`
sub-agents; a specific "Gemini 3.8 flash" model selector is not available in this
environment — read-only `scout` agents were used instead.)
**Scope limit honored:** audit + report only. No production code, tests, configs,
binaries, or package artifacts were modified. Changed paths are listed in §Appendix B.

---

## 0. Baseline (verified)

| Item | Value |
|---|---|
| Branch | `asset-project-maintainability` |
| Commit | `e7dd900dd8a21bd7246142d1016c530bbb8b21a5` ("docs: update audit", 2026-10-19 08:21 +0700) |
| Working tree at start | clean (no uncommitted changes) |
| Code drift | `git diff 6dc9b04..HEAD -- src tests router crates scripts config package.json .github` is **empty** — commit `e7dd900` is docs-only (adds the prior audit artifacts). All source evidence from the prior audit describes the current code; all historical test results were nevertheless RE-RUN (§D) |
| History | 180 commits; prior audit commit `6dc9b04` |
| Toolchain | Bun 1.3.14 (= CI pin), Cargo 1.99.0 (= `rust-toolchain.toml` pin), Node v26.10.0 (unused by project scripts) |
| Test runners | `bun test` (Bun built-in; what CI + `release:check` run) and `bun run test` = `vitest run` (the `test` script) |
| CI workflows | `ci.yml` (validation-only), `publish.yml` (sole publisher), `milestone-7.yml` (musl matrix) |
| Existing audit artifacts read | `final-report.md`, `findings-register.md` (v2), `audit-changelog.md` (C1–C7), `implementation-backlog.md` (B1–B17), `phase-0..3-*.md`, `Docs/implementation-plans/aibridge-maintainability-audit-plan.md` |
| Report path collision | none — `pre-refactor-verification-report.md` did not exist |
| Test safety | tree clean; all runs non-destructive (`contracts:check` re-generates and diffs — verified tree clean after; `bun pm pack --dry-run` writes nothing) |

Prior findings → backlog mapping already recorded in `findings-register.md`
(prerequisites/acceptance columns) and `implementation-backlog.md` (B-items with
decision gates and rollback). This report adds per-finding verification STATUS
(Deliverable B) and does not replace those artifacts; corrections are appended to
`audit-changelog.md` (§Appendix B).

---

## D. Test and CI evidence (current commit `e7dd900`, executed 2026-10-19)

All commands below were actually executed on this host (macOS arm64) during this
audit, **against the audit target `e7dd900dd8a21bd7246142d1016c530bbb8b21a5`** — not
against the report-publication revision `a3b8b16` or any later commit. (`a3b8b16` is
code-identical to the target — empty diff verified — but the suite was not re-run
there.) Exit codes and summaries are copied from the run log
(captured to a temporary log `/tmp/prerefactor-audit-evidence.log`, summarized below;
the log and its runner script were deleted after capture per the audit's cleanup rule —
Appendix B). This is
**current-commit evidence**, not historical carry-over.

| # | Command | Exit | Duration | Outcome |
|---|---|---|---|---|
| 1 | `bun run typecheck` | 0 | 7s | clean |
| 2 | `bun test` (full) | **1** | 28s | 5,976 pass / 5 skip / **1 fail** — `tests/integration/terminal-websocket.test.ts` "the two-node smoke test … over a real HTTP hop" (`pty.input` expected 1, got 0 at line 1201) |
| 3 | `bun run test` (vitest full) | **1** | 53s | 8 failed / 5,969 passed / 5 skipped (5,982) — the 7 `BunProcessRunner` failures (`tests/unit/host/runtime.test.ts`) + the same WS smoke test failure as #2 |
| 4 | `bun test tests/unit/mesh/identity` | 0 | <1s | pass (focused) |
| 5 | `bun test tests/unit/mesh/registry` | 0 | 1s | pass (focused) |
| 6 | `bun run docs:check` | 0 | <1s | clean |
| 7 | `bun run build` | 0 | 6s | clean |
| 8 | `bun run contracts:check` | 0 | 6s | regenerate + `git diff --exit-code` clean (contracts reproducible at this commit) |
| 9 | `cargo fmt --all --check` | 0 | 1s | clean |
| 10 | `cargo clippy --workspace --all-targets -- -D warnings` | 0 | <1s (warm) | clean |
| 11 | `cargo test --workspace` | 0 | 11s (warm) | all Rust suites pass (incl. `router/tests/fixtures.rs` contract parity) |
| 12 | `bun pm pack --dry-run` | 0 | <1s | 317 files listed (see packaging findings) |
| 13 | `bun test tests/integration/terminal-websocket.test.ts` (isolation re-run) | 0 | 1.9s | **20/20 pass** |

Failure classification (per audit rules):

- WS smoke failure (#2, #3): **existing flaky test — timing-sensitive**, not a code
  regression. Evidence: (a) zero source drift between this commit and the prior
  audit's fully-green `bun test` run; (b) the test synchronizes with fixed wall-clock
  sleeps (`await setTimeout(40)`, `await setTimeout(120)` at
  `tests/integration/terminal-websocket.test.ts:1196-1201`, and ~20 similar fixed
  sleeps across the file) over a real two-node HTTP hop; (c) passes 20/20 in
  isolation in 1.9s while failing under the full-suite + concurrent scout load;
  (d) the assertion (pty input length after a fixed wait) is inherently
  scheduling-dependent. Recorded as new finding **N-01** (test reliability).
- `BunProcessRunner` failures (#3): **known existing failure** — the historical
  MNT-201 finding (vitest runs the Bun-only class under Node; `Bun.spawn` is
  undefined and the catch branch returns `{exitCode: null, …}`). Confirmed still
  present at this commit; unchanged.
- No environment/tooling failures; no failures related to the ID-/REG- candidate set.

CI status: **not checked / not accessible** — GitHub Actions run state was not
queried in this audit. Nothing in this report infers CI success from local results.

Historical results (prior audit, same source, recorded for contrast only):
`bun test` 5,977 pass/0 fail (6dc9b04, 2026-10-19 earlier); vitest 7 failures.

---

## C. Detailed findings — auditor-traced (Part 1)

Each entry below was traced first-hand by the lead auditor at `e7dd900`. Scout
sub-agent reports were cross-checked against these traces before inclusion in the
matrix (Deliverable B). Statuses use the §2.1 vocabulary.

### N-01 · WS two-node smoke test is timing-flaky under load — CONFIRMED_BUG (test reliability)

1. **Summary.** `tests/integration/terminal-websocket.test.ts` "the two-node smoke
   test … over a real HTTP hop" fails under full-suite load and passes in isolation.
2. **Evidence.** Failure at `tests/integration/terminal-websocket.test.ts:1196-1201`
   (`expect(pty.input).toHaveLength(1)` → 0) in `bun test` (exit 1) and vitest
   (exit 1) at `e7dd900`; isolation re-run `bun test tests/integration/terminal-websocket.test.ts`
   → 20/20 pass in 1.93s. The test synchronizes with fixed wall-clock sleeps
   (`await new Promise(setTimeout)` 5–120 ms at lines 653, 917-979, 1197, 1200).
3. **Preconditions/repro.** Run the full suite while the host is busy (during this
   audit: 3 concurrent scout processes). No code change needed; reproducible by
   running `bun test` under CPU load.
4. **Expected vs actual.** Expected: deterministic pass/fail. Actual: pass/fail
   depends on scheduler timing across a real two-node HTTP hop.
5. **Root cause.** Wall-clock sleeps used as synchronization instead of awaiting an
   observable state (e.g. poll `pty.input` until length 1 with a deadline).
6. **Scope/impact.** CI signal reliability only; no production code implicated
   (zero source drift vs the fully-green historical run). A red CI from this flake
   will train reviewers to ignore red.
7. **Remediation direction.** Replace fixed sleeps with bounded eventual assertions
   in this file (all ~20 sleep sites are candidates); do not merely raise timeouts.
8. **Regression tests.** After remediation: 10 consecutive full-suite runs green
   under artificial load (e.g. `yes > /dev/null` workers), documented.
9. **Related.** MNT-202 (test output noise) shares the "test hygiene" theme;
   MNT-201 (runner duality) amplified the triage cost (two runners, two failures).
10. **Rollback.** Test-only change; revert safe.

### ID-08 · "Recorded in the controller's audit log" — the audit log does not exist — CONFIRMED_BUG

1. **Summary.** Security-critical refusal paths deliberately withhold detail from the
   wire "because the reason is recorded in the controller's audit log"
   (`src/mesh/identity/enrollment-code.ts:509`, `:588`; `src/mesh/identity/node-trust.ts:220,269,420`).
   No audit-log writer exists anywhere in `src/`.
2. **Evidence.** (a) Comment claims at the lines above. (b) Repo-wide search for an
   audit sink (`AuditLog`, `auditSink`, `appendAudit`, audit file/table writers) →
   none; `src/observability/` and `src/storage/` contain no audit facility. The only
   implemented "audit trail" is the lease history
   (`src/mesh/lease/sqlite-lease-store.ts:32-33,213` — different domain) and the
   kernel event log (different domain). (c) `Fastify({ logger: false })`
   (`src/server/app.ts:80`) — no request/refusal logging in the HTTP layer either
   (consistent with the debugging skill's "there are no log files").
   (d) Wire-level refusal for enrollment codes returns deliberately vague errors:
   "whether a code is unknown, expired, already used, or bound elsewhere is exactly
   the distinction an attacker enumerates for" (`enrollment-code.ts:509`).
3. **Preconditions.** Any enrollment or identity refusal (bad code, expired code,
   revoked node, store failure). Attacker preconditions: none — this is the
   operator's view of normal failures.
4. **Expected vs actual.** Expected (per code comments): specific reason lands in a
   controller audit log. Actual: the reason is computed, then dropped — the wire gets
   a generic error and no record is written.
5. **Root cause.** The compensating control for enumeration-resistant wire errors was
   designed but never implemented; observability was left out of the milestone.
6. **Scope/impact.** Incident response and troubleshooting for the enrollment and
   identity subsystems: an operator cannot distinguish "attacker enumerating codes"
   from "my own node's clock skew" from "expired code". Directly undermines §4-ID-08's
   recovery requirement. Severity **P2** (security-relevant observability).
7. **Remediation direction.** Implement the promised audit sink (structured,
   redaction-pipeline-filtered records of `reason` codes — never code hashes or key
   material) or amend the comments and design docs to state the reasons are simply
   lost. Do not add detail to the wire error (enumeration resistance is correct).
8. **Regression tests.** After remediation: a test asserting each refusal family
   writes exactly one audit record containing the reason code and no secret (mirror
   `tests/security/canary-token-audit.test.ts` methodology).
9. **Related.** MNT-204 (swallowed root-cause errors in `opencode/monitor.ts`) —
   same theme of lost failure attribution; MNT-210 (observability untested).
10. **Rollback.** Additive; rollback = remove sink. No migration.

### REG-01 · Heartbeat ingestion does not bind the envelope to an authenticated signer — CONFIRMED_DESIGN_RISK

1. **Summary.** Command submission binds authenticated identity to the record
   (`src/mesh/inbox/inbox.ts:132-158`); heartbeat ingestion does not:
   `MeshNodeRegistry.recordHeartbeat` (`src/mesh/registry/registry.ts:206-370`)
   never compares the submitting peer's identity with `heartbeat.nodeId`, and
   `controller.receive` (`src/mesh/fault/controller.ts:365-370`) hands
   `request.record` to the registry with the signature merely stored
   (`AsyncLocalStorage`, `src/mesh/fault/transport.ts:39-47`) and never verified.
2. **Evidence.** (a) `inbox.ts:150-157` — explicit `sameId(authenticated.value.nodeId,
   verified.record.controllerNodeId)` check with comment "without it authentication
   would be a stage that ran and then contributed nothing". (b) No analogous check in
   `registry.ts` `recordHeartbeat` (grep: zero signature/authenticated references in
   the file). (c) `controller.ts:366` — `transport.withSignature(request.signature, …)`
   is the only use of the signature on that path. (d) `harness.ts:296-297` registers
   `controller.receive`/`worker.receive` directly with the in-process proxy
   (`proxy.ts:318 handler(entry.request)` — no verification at delivery).
   (e) Contrast: `gateway/terminal/route.ts:185` reads `authenticatedNodeFor(request)`.
3. **Preconditions.** A peer able to submit a `mesh.heartbeat` envelope through the
   record transport (today: any participant of the fault-harness topology; future:
   any HTTP record ingress that reuses this seam). The envelope's signature covers the
   body, so the message is *validly signed by the attacker*; nothing checks that the
   body's `nodeId` equals the signer.
4. **Expected vs actual.** Expected: authenticated signer == `heartbeat.nodeId` (as
   the inbox does for commands). Actual: any authenticated (or, in the harness,
   any proxied) sender can refresh another enrolled node's liveness and overwrite its
   `capability_json` (capabilities, `projectPathIds`, `maxConcurrentSessions`,
   `activeSessions` — `registry.ts:334`, `snapshotFor`), which `src/routing/snapshot.ts:256`
   and `src/routing/rank.ts:260-261` consume for scheduling.
5. **Root cause.** The identity binding for records is caller-side convention; the
   registry seam trusts its caller.
6. **Scope/impact.** TODAY: reachable only in the `mesh/fault` harness topology
   (imported only by tests; the engine bridge deliberately 404s `/v1/mesh/*` —
   `tests/unit/server/route-boundary.test.ts`). FUTURE: any production record ingress
   that wires `receive` without an authenticate step inherits liveness forgery,
   capacity manipulation, and project-claim spoofing. Refactor gate: any change
   touching heartbeat/registry/transport must not widen this.
7. **Remediation direction.** Bind signer→claim at the registry seam (pass the
   authenticated identity into `recordHeartbeat` and compare), mirroring
   `inbox.ts:150`; or enforce it in one transport wrapper used by every ingress.
8. **Regression tests.** After remediation: heartbeat envelope with
   `payload.nodeId = B` submitted under a signature from `A` is refused with a
   sender-mismatch code; the existing `registry-store`/`reconnect` suites stay green.
9. **Related.** REG-02 (dual revocation sources), REG-09 (self-declared load),
   C1 cross-cutting theme (auth binding). Shared root cause with the fact that
   `mesh.fault` is simultaneously "test harness" and the only full topology.
10. **Rollback.** Additive check; rollback safe. No migration.

### REG-02 · Revocation has two independent sources of truth with no synchronization — CONFIRMED_DESIGN_RISK

1. **Summary.** Node revocation exists in the identity store
   (`NodeTrustStore.revocation` + pin removal, `src/mesh/identity/node-trust.ts:224-330`)
   AND in the registry store (`mesh_registry_revocations`,
   `src/mesh/registry/migrations.ts:83-92`, written via `registry.ts:446`). No code
   path writes both; nothing reconciles them.
2. **Evidence.** (a) The two `revokeNode` implementations are separate
   (`node-trust.ts:224` vs `registry.ts:446`); the only cross-store call found in
   `src/mesh` is `enrollment.ts:229` (pin removal within the identity domain).
   (b) Enforcement reads are domain-local: `verifyNodeTrust` (`node-trust.ts:138-208`)
   consults only identity stores; `recordHeartbeat` (`registry.ts:228-256`) consults
   only the registry revocation; `deriveLiveness` (`registry.ts`) reports `revoked`
   from the registry record only.
3. **Preconditions.** An operator (or future tooling) revokes in one subsystem only —
   there is no command today that revokes in both (no production caller of either).
4. **Expected vs actual.** Expected: one logical revocation decision. Actual:
   divergence matrix — identity-revoked but registry-not: node cannot authenticate
   yet registry still derives `live` from its stale advertisement (and, per REG-01,
   its heartbeats keep flowing); registry-revoked but identity-not: node authenticates
   fine but its heartbeats and scheduling are refused — an unexplained half-state.
5. **Root cause.** Identity (per-key attribution) and registry (addressability) own
   separate records by design (`harness.ts:203-213` comment defends the split for
   enrollment), but revocation — the one action that must be global — has no
   coordination seam.
6. **Scope/impact.** Revocation semantics (§4 cross-cutting C2) are only as strong as
   the operator's discipline. P2 as a design risk; the concrete exploit window opens
   when revocation tooling is built.
7. **Remediation direction.** Define one revocation entry point that writes both
   stores transactionally (they can share the SQLite database) and document the
   ordering; or document that the registry revocation is derived from the identity
   one and implement that derivation.
8. **Regression tests.** After remediation: revoke via the single entry point →
   both `verifyNodeTrust` and `recordHeartbeat` refuse; kill the process between the
   two writes → the retry completes or refuses with an explicit incomplete state.
9. **Related.** REG-08 (CAS lacks revocation predicate), ID-02 (socket close
   unwired — same propagation-gap family).
10. **Rollback.** Dual-write additions are additive; if a transaction seam is added to
   SQLite stores, keep the old per-store methods until callers migrate.

### REG-04 · Legitimate sequence reset is refused forever — no recovery path exists — PARTIALLY_CONFIRMED

1. **Summary.** A node restart resets its heartbeat sequence (expected per
   `src/mesh/protocol/heartbeat.ts:30-37`), and the controller then refuses every
   subsequent heartbeat (`regressed`, `registry.ts:318-325`) — by design (forgery
   defense, tested). The documented remedy ("reconcile it",
   `heartbeat.ts` error text; `tests/unit/mesh/registry/reconnect.test.ts:16,139`)
   is not implemented: no code path resets `last_heartbeat_sequence` (single writer:
   the CAS, `src/mesh/registry/migrations.ts:380-384`) and `MeshReconciler`
   (`src/mesh/gateway/reconcile/reconciler.ts`) handles event positions and session
   inventory, not heartbeat baselines.
2. **Evidence.** Single-writer grep for `last_heartbeat_sequence` (migrations.ts:382
   only); `reconciler.ts` contains no sequence/heartbeat code; re-enrollment with the
   same `nodeId` is refused (`sqlite-registry.ts:166` "a second pin for a known node…
   Rotating a node's key is a revocation followed by a fresh enrollment").
3. **Preconditions/repro.** Enroll node; heartbeat seq 1..N; restart the node process
   so it emits seq 1; observe `mesh.heartbeat_sequence_regressed` for every later
   heartbeat and `liveness` decaying to `stale` with no recovery short of a new
   enrollment (new `nodeId`) or manual DB surgery.
4. **Expected vs actual.** Expected (per comments): restart → reconciled. Actual:
   restart → permanent refusal.
5. **Root cause.** The recovery half of the restart story was specified in comments
   and error strings but never built.
6. **Scope/impact.** Availability: a routine operational event (process restart)
   silently removes a node from scheduling. P2. The forgery defense itself is sound —
   the defect is the missing recovery.
   **Cross-check correction (scout `RegistryAudit`, verified):** recovery is not
   strictly "never" — `evaluateHeartbeatSequence` treats `incoming > previous+1` as a
   `gap` and the registry **writes** it (`registry.ts:326-335`), so a restarted node
   recovers once its own counter exceeds the stored high-water mark N (≈N refused
   heartbeats; e.g. N=10,000 at 1 beat/30 s ≈ 83 h) and a crash-looping node never
   converges. Re-enrollment converges onto the same row without clearing the baseline
   (`memory-registry.ts:73-77`). The documented "reconcile it" remedy remains
   unimplemented. Verdict unchanged: CONFIRMED_DESIGN_RISK, failure scenario refined.
7. **Remediation direction.** Implement the documented reconcile step (e.g. a
   controller-initiated baseline reset that is itself authenticated and recorded), or
   amend the protocol docs to define restart = fresh enrollment.
8. **Regression tests.** After remediation: restart-with-reset scenario recovers to
   `live` via the documented path; forged regression from a third party still refused.
9. **Related.** REG-05 (clock), REG-10 (gap rows accumulate from the same events).
10. **Rollback.** Any reset mechanism must remain authenticated (REG-01 binding) and
   audited (ID-08 sink).

### REG-05 · Liveness derives from the node's clock with zero future-skew tolerance — CONFIRMED_DESIGN_RISK

1. **Summary.** Liveness = `controller.nowMs - Date.parse(heartbeat.observedAt) < 90_000`
   (`evaluateHeartbeatFreshness`, `src/mesh/protocol/heartbeat.ts`; bound
   `MAX_HEARTBEAT_AGE_MS = 90_000`, `src/mesh/protocol/bounds.ts:33`). A heartbeat
   with `ageMs < 0` (node clock ahead of controller) is refused outright
   (`state: "future"`; `recordHeartbeat` refuses before writing).
2. **Evidence.** `heartbeat.ts` freshness function (direct read); `registry.ts:268-283`
   ("a heartbeat observed in the future is refused outright"); `deriveLiveness` maps a
   stored future to `stale`. No receive-time timestamp is recorded
   (`migrations.ts:69-80` — only `capability_json` with `observedAt`).
3. **Preconditions.** Node clock ahead of controller by more than message transit
   time (e.g. 10s skew, 50ms transit) → every heartbeat refused → node never `live`.
   Node clock behind by >90s → every heartbeat written but derived `stale`.
4. **Expected vs actual.** Expected for a TTL design: small skew absorbed. Actual:
   any positive skew beyond transit latency = permanent liveness loss until clocks
   converge; the future-refusal is deliberate (stops future-timestamp liveness
   hijack) but its cost is unmitigated.
5. **Root cause.** Remote timestamps are authoritative for liveness; the controller
   does not record receive time.
6. **Scope/impact.** Scheduling availability under clock skew (VPS fleets without
   NTP discipline). Attack side: a node cannot keep itself live with future stamps
   (good). P3.
7. **Remediation direction.** Record controller receive time and derive liveness from
   it (observedAt stays a claim), or tolerate bounded future skew with the replay
   window as the bound.
8. **Regression tests.** After remediation: ±skew matrix test (node ahead 1s/10s/60s,
   behind 1s/120s) asserting documented liveness outcomes.
9. **Related.** REG-04 (sequence restart shares the "node restarts" story).
10. **Rollback.** Derivation change alters liveness semantics — gate behind the
   behavior-equivalence protocol (Deliverable F) and version the record shape if the
   stored snapshot changes.

### REG-08 · Heartbeat CAS omits a revocation predicate (read path masks it) — PARTIALLY_CONFIRMED

1. **Summary.** `CAS_UPDATE_HEARTBEAT_SQL` (`src/mesh/registry/migrations.ts:380-384`)
   checks `node_id` + `last_heartbeat_sequence IS ?` only — no revocation condition —
   so a heartbeat whose pre-check raced a revocation write lands on a revoked row.
2. **Evidence.** SQL above; `recordHeartbeat`'s revocation check is a separate read
   (`registry.ts:246-256`) before the CAS retry loop (`registry.ts:284-335`);
   `deriveLiveness` checks `record.revocation !== null` FIRST ("the only one of the
   four that survives a fresh heartbeat", `registry.ts`) so the stale write cannot
   make a revoked node appear `live`.
3. **Preconditions.** Concurrent revocation and heartbeat for one node; interleaving
   read→revoke→CAS.
4. **Expected vs actual.** Expected (claim): transition cannot succeed post-revoke.
   Actual: the row write CAN succeed (capability_json/sequence updated on a revoked
   node); no liveness/scheduling consequence because reads are revocation-first.
5. **Root cause.** Check-then-write across two statements; the store's transaction
   covers only the CAS+gap insert.
6. **Scope/impact.** State hygiene only; P3. The claim's feared outcome (revoked node
   treated as live) is prevented by the read path.
7. **Remediation direction.** Add `AND node_id NOT IN (SELECT … revocations)` (or a
   revocation-version column) to the CAS for defense in depth.
8. **Regression tests.** After remediation: interleaving test (revoke between read
   and CAS) asserting `written: false`; existing `registry-store` CAS tests green.
9. **Related.** REG-02 (dual revocation stores make "revoked" ambiguous across
   subsystems).
10. **Rollback.** SQL change only; rollback = restore statement.

### REG-09 · `activeSessions` is self-declared and feeds scheduling — PARTIALLY_CONFIRMED (by design, scoped)

1. **Summary.** Heartbeat `load.activeSessions` is written by the node
   (`heartbeatLoadSchema`, `src/mesh/protocol/heartbeat.ts:24-29`), stored in
   `capability_json`, and consumed by routing: `snapshot.ts:256` and `rank.ts:188,260-261`
   exclude a node at `activeSessions >= maxConcurrentSessions`.
2. **Evidence.** Lines above; `rank.ts:188` explicitly frames it as "the node's own
   claim about its own machine" and distinguishes the hard bounds (M6 budget algebra,
   `SchedulerOptions.maxConcurrency`).
3. **Preconditions.** A node misreporting load. Under-report → attracts more work up
   to controller-side caps; over-report → avoids work (self-harm).
4. **Expected vs actual.** No independent measurement exists (nothing counts sessions
   against the node); the claim is advisory. Impact bounded by the controller-side
   caps the comment names — verify those exist when the scheduler is refactored.
5. **Root cause.** Distributed load is inherently self-reported; documented trade-off.
6. **Scope/impact.** P3/INFO. Becomes material only if controller-side caps are
   removed or weakened — record as a refactor invariant.
7. **Remediation direction.** Keep as-is; add a test asserting the controller-side
   cap cannot be bypassed by `activeSessions` under-reporting.
8. **Regression tests.** See 7.
9. **Related.** REG-01 (a spoofed heartbeat can also spoof load — compounding).
10. **Rollback.** n/a.

### REG-10 · Heartbeat gap rows grow without bound — CONFIRMED_BUG (P3, ops)

1. **Summary.** Every gap-recording heartbeat appends a row to
   `mesh_registry_heartbeat_gaps` (`migrations.ts:386-389`,
   `sqlite-registry.ts:267`; memory store appends to a Map,
   `memory-registry.ts:138-139`). No `DELETE`/prune exists for this table anywhere
   in `src/mesh` (grep), and `readHeartbeatGaps` (`gaps.ts`) only reads.
2. **Evidence.** Direct reads above; contrast with the event gateway, which prunes
   its dedupe marks by design (`src/mesh/gateway/events/gateway.ts:456`).
3. **Preconditions.** Ordinary packet loss (one row per gap) or a buggy/malicious
   node oscillating sequences (each write's gap range recorded). Growth is linear
   and permanent on the controller's SQLite file.
4. **Expected vs actual.** Expected: retained until reconciled, then bounded.
   Actual: retained forever; reconciliation does not consume or clear them.
5. **Root cause.** Write path designed; lifecycle/cleanup never scoped.
6. **Scope/impact.** Storage growth + reconciliation work-list growth. P3 (long-lived
   deployments with lossy links feel it first). Note `PRIMARY KEY (node_id,
   from_sequence)` turns a duplicate gap insert into a failed transaction that rolls
   back the accompanying heartbeat write (unproven trigger — INFERENCE).
7. **Remediation direction.** Retention policy (delete gaps older than the
   reconciliation window, or consumed gaps) or a bounded table.
8. **Regression tests.** After remediation: N gap inserts → size ≤ bound; consumed
   gaps are not re-reported (existing `reconnect.test.ts:96-110` covers the
   "not re-reported" read side).
9. **Related.** REG-04 (restart events generate gaps/regressions in the same store).
10. **Rollback.** Additive pruning job; disable-able.

### ID-04 · Replay guard: bounded and fail-closed; shared capacity reachable only with a valid key — PARTIALLY_CONFIRMED

1. **Summary.** `InMemoryNonceGuard` (`src/mesh/identity/replay-guard.ts:70-130`)
   caps at 100,000 tracked nonces (`DEFAULT_MAX_TRACKED_NONCES`), retention
   `MAX_REQUEST_AGE_MS + MAX_FUTURE_SKEW_MS`, refuses when full
   (`identity.replay_store_full`) instead of evicting, and `consume` is synchronous
   (no TOCTOU). Signature verification runs BEFORE `replayGuard.consume`
   (`src/mesh/identity/request-signature.ts:270-325`).
2. **Evidence.** Direct reads; `#prune` is O(n) per request (`replay-guard.ts:115`).
3. **Preconditions for exhaustion.** ~100k distinct validly-signed nonces inside one
   retention window — i.e. an enrolled key (or key compromise). Unauthenticated
   floods die at ed25519 verify and never touch the map.
4. **Expected vs actual.** The claim "untrusted requests can exhaust shared capacity"
   — untrusted cannot (verify-first); an authenticated rogue can exhaust the shared
   map and cause refusal for everyone until entries expire (bounded window). O(n)
   prune per request is minor CPU at the cap.
5. **Root cause.** Global map without per-node quotas — deliberate (comment).
6. **Scope/impact.** P3 (precondition = compromised enrolled key, which permits
   worse actions). The fail-closed-at-full design is a strength (no eviction-based
   replay window).
7. **Remediation direction.** Per-node quotas if multi-tenant meshes emerge; optional
   amortized pruning.
8. **Regression tests.** Existing tests cover refusal-at-full; add a per-node
   isolation test if quotas are adopted.
9. **Related.** ID-02/REG-02 (revocation propagation limits the window).
10. **Rollback.** n/a.

### ID-10 · Key store: strong path/mode/overwrite defenses; missing fsync — PARTIALLY_CONFIRMED

1. **Summary.** `FileKeyStore` (`src/mesh/identity/file-key-store.ts`) refuses
   traversal (`#pathFor`, :279-283), verifies directory AND file modes on write and
   read (`ensurePrivateDirectory`, :285-325), uses `link()` for atomic no-overwrite
   (:99-112) and `randomBytes` temp names. **No `fsync`** of the key file or its
   directory anywhere in the module.
2. **Evidence.** Direct reads; the comment "the link succeeded, so the key is durable
   under its real name" (:134-135) overstates: namespace atomicity ≠ data durability.
3. **Preconditions.** Crash/power loss between `writeFile`/`link` and disk flush.
4. **Expected vs actual.** Expected: enrolled key survives crash. Actual: key file
   may be lost/corrupt while the controller already holds the pin — the node can no
   longer sign; recovery = re-enrollment (old pin/registry row orphaned).
5. **Root cause.** Durability step omitted; owner-uid verification delegated to the
   operator ("once the directory's owner is confirmed", :323) — a threat-model
   concern for shared-host deployments, not a reproducible defect on single-user VPS.
6. **Scope/impact.** P3 (tiny window, availability/ops consequence, not secrecy —
   mode checks protect confidentiality).
7. **Remediation direction.** `fsync` file and directory after link; optionally verify
   `stat.uid === process.getuid()`.
8. **Regression tests.** Hard to unit-test fsync; assert call ordering via an injected
   fs seam (the module already isolates fs).
9. **Related.** ID-03 (enrollment partial-failure family).
10. **Rollback.** Additive.

---

## C. Detailed findings (Part 2) — identity candidates (scout `IdentityAudit`, cross-checked by auditor)

Scope fact (verified): `src/mesh/identity/` is library code with no production wiring —
no `src/server/` or `src/cli/` import it; in-src consumers are `src/mesh/fault/*` (test
harness) and the two gateway routes; `FileSystemKeyStore` has zero non-test callers.
Verdicts describe the contract any future gateway inherits.

### ID-01 · Enrollment hash is a one-time bearer credential — PARTIALLY_CONFIRMED (P3)

1. **Summary.** `consume` redeems on `codeHash` alone (`src/mesh/identity/enrollment-code.ts:584-599`);
   the raw code is never compared. Possession of the hash pre-redemption is possession
   of the credential. The comment "the raw code never crosses the mesh" (`:16-20`) is
   not a security property.
2. **Evidence.** Generation `randomBytes(32)` (`:287-291`); storage is SHA-256 only
   (`:299-315`); constant-time compare via `constantTimeEqual` (`:548-558`,
   `src/mesh/identity/crypto.ts:20-23`); TTL 10 min default / 24 h cap (`:38,:48,:280-287`);
   single-use atomic (`:601-608`); **no code-revocation API** (`EnrollmentCodeStore` has
   `save`/`consume` only, `:190-237`). Not exposed in decisions, responses, diagnostics,
   or error messages (`no-secret-leak.test.ts:124-151` sweeps refusals).
3. **Preconditions.** Attacker observes `enrollmentCodeHash` (request transit, log,
   issue-response leak) before redemption and submits it with their own key first.
4. **Expected vs actual.** Expected: an observer-held value is useless; actual: it is a
   short-TTL, single-use bearer. Expected: a leaked code can be cancelled; actual: not
   until TTL.
5. **Root cause.** Hash-as-lookup-secret design; mitigations (TTL, single-use,
   `boundProvisionalNodeId` `:593-595`, Tailscale transport) bound but do not remove it.
6. **Scope/impact.** P3 — high-entropy one-time token + short TTL + transport trust.
   Design docs should stop implying a non-bearer property.
7. **Remediation direction.** Either document it as an intentional one-time bearer or
   require the raw code as the lookup secret (hash for storage equality only); add
   code cancellation to the store interface.
8. **Regression tests.** Pre-redemption theft/race test; code-cancel test.
9. **Related.** ID-03 (same code lifecycle), ID-08 (refusal opacity compounds theft
   detection).
10. **Rollback.** Store-interface additions are additive.

### ID-02 · Revocation stops new requests but not established streams — CONFIRMED_DESIGN_RISK (P2)

1. **Summary.** Per-request revocation is enforced with no cache (re-checked on every
   `authenticate`), but an already-open terminal WS keeps streaming: closure requires
   `MeshTerminalGatewayImpl.revokeNode` (`src/mesh/gateway/terminal/gateway.ts:1052-1055`),
   which has **no `src/` caller** (grep: registry store method + tests only), and the
   SSE event gateway has **no close-by-node path at all** (grep: none).
2. **Evidence.** `identity-provider.ts:117-118` re-reads trust per request;
   `node-trust.ts:224-330` revoke writes trust + removes pin;
   `tests/integration/terminal-websocket.test.ts:1096-1113` "revocation closes a real
   socket" drives `gateway.revokeNode` **by hand** — the test proves the mechanism, not
   the propagation.
3. **Preconditions.** Operator revokes a node while it holds a WS/SSE stream.
4. **Expected vs actual.** Expected ("a revoked node cannot … stream a terminal",
   `node-trust.ts:24-28`): streams close. Actual: new requests 403 in 0 ms; established
   streams continue unbounded (WS until disconnect/session end; SSE indefinitely).
5. **Root cause.** Revocation propagation was never wired: identity, registry, and
   gateway each expose their own revoke entry point (see REG-02).
6. **Scope/impact.** P2 — compromised-node containment is incomplete at the exact
   moment it matters.
7. **Remediation direction.** One revocation entry point that also kicks live streams
   (terminal gateway + SSE) and is invoked from the revocation action; define and
   document revocation latency.
8. **Regression tests.** Revoke via the real entry point → open WS closes and SSE stops;
   the existing hand-driven test remains for the gateway primitive.
9. **Related.** REG-02 (dual sources of truth), ID-08 (revocation audit).
10. **Rollback.** Additive wiring; old per-subsystem methods retained until migrated.

### ID-03 · Enrollment partial failures strand the node — CONFIRMED_BUG (P2)

1. **Summary.** `verifyEnrollmentCode` **burns** the code (commit point,
   `enrollment-code.ts:361,:601-608`) before the two non-atomic authority writes
   (`pins.pin` then `trust.enroll`, `enrollment.ts:198-223`). Each failure window has a
   broken outcome: (a) `pins.pin` fails → code spent, retry converges to
   `verifyPinnedKey` → refused `key_mismatch` (a server fault reported as the node's
   key being wrong, `enrollment.ts:120-139`); (b) `trust.enroll` fails → pin rolled
   back and the error claims "the enrollment code may be retried"
   (`:231-237`) — **false**: the code is consumed, retry dead-ends as in (a);
   (c) crash between the two writes (durable stores, the documented intent) → retry
   converges, `verifyPinnedKey` passes, and the converged branch returns
   `outcome: "accepted"` **without consulting or writing `trust`** (`:120-139`) — the
   node is told it is enrolled while every future `authenticate` fails `node_unknown`
   (`node-trust.ts:165-175`) forever; (d) rollback `pins.revoke` failure is conceded
   in-code to "brick the node id permanently" (`:166-171`).
2. **Evidence.** Auditor verified the converged branch and `pinNodeKey` bodies directly
   (reads above); scout traced `consume` burn ordering; **no test** drives
   `trust.enroll`/`pins.pin` failure or the crash window (grep in
   `tests/unit/mesh/identity` for rollback/incomplete paths → none).
3. **Preconditions.** Any store failure or crash between `consume` and the trust write.
4. **Expected vs actual.** Expected: retry converges to a completed enrollment (as the
   comments promise). Actual: over-asserts completion in both directions — refuses
   recoverable states, falsely accepts an unrecoverable one.
5. **Root cause.** The convergence marker is written before the authority writes, so it
   cannot distinguish "done" from "half-done".
6. **Scope/impact.** P2 — enrollment is the only path to identity; the (c) outcome is
   silent and permanent per `nodeId` (recovery = fresh code, new id; the wire reason
   never says so).
7. **Remediation direction.** Make the pin+trust writes one transaction (they are
   adjacent stores) or record an explicit enrollment state machine
   (`pending → trusted`) with convergence keyed on completion, not on code consumption;
   fix the false "may be retried" message regardless.
8. **Regression tests.** Fault-injection tests for each window (a)–(d) asserting the
   retry converges or fails with an accurate, actionable reason.
9. **Related.** ID-01 (code lifecycle), ID-08 (reasons lost),
   REG-02 (enrollment writes only identity; registry row written separately — the same
   split, at enrollment).
10. **Rollback.** State-machine addition is additive; migrate by treating absence of the
   state record as `pending` on read.

### ID-05 · Middleware has no rejection handler and collapses internal faults to 401 — CONFIRMED_BUG (P2)

1. **Summary.** `createMeshIdentityHook` runs
   `void authenticateForRequest(...).then(...)` with **no `.catch`** and `done` called
   only on success (`src/mesh/identity/middleware.ts:167-182`): any thrown error is an
   unhandled rejection (process-terminating under default Node/Bun modes) and/or a hung
   request. Separately, `statusForIdentityRefusal` maps only `node_revoked`→403 and
   **everything else to 401** (`:139-146`) — a store outage
   (`trust_store_failure`, `node-trust.ts:143-156`) is answered 401, identical to a bad
   signature.
2. **Evidence.** Auditor confirmed `.then(` without `catch` and the status mapping;
   `Result`-returning stores mostly swallow their own errors (e.g.
   `file-key-store.ts` try/catch blocks), so the throw path is latent — but the
   contract is documentation, not enforcement, and one concrete thrower exists on the
   default body-digest path (ID-06).
3. **Preconditions.** Any thrown error inside `extractSignature`, the route-supplied
   `signedPath`/`bodyDigest` hooks (`:230,:310`), a store that throws, or `canonicalJson`
   on hostile JSON (ID-06).
4. **Expected vs actual.** Expected: 5xx-class refusal, distinct from 401; actual:
   hang/crash, and 401 for internal faults.
5. **Root cause.** Fire-and-forget promise chain; refusal-status mapping has no
   internal-fault class.
6. **Scope/impact.** P2 — an outage indistinguishable from an attack, plus a crash/hang
   primitive on the identity boundary.
7. **Remediation direction.** `.catch` → 5xx `internal_failure` refusal; map
   `internal_failure` category to 500/503; never call `done()` after `reply.send`.
8. **Regression tests.** Throwing provider/store test asserting no unhandled rejection
   and a 5xx; status-matrix test for `trust_store_failure` ≠ `signature_invalid`.
9. **Related.** ID-06 (concrete thrower), ID-08 (diagnostics), MNT-204 (same theme).
10. **Rollback.** Additive.

### ID-06 · Body-digest edge cases — PARTIALLY_CONFIRMED (P3)

1. **Summary.** `meshBodyDigest(body) = digestJson(body ?? null)`
   (`middleware.ts:339-341`): absent body and JSON `null` sign identically, while
   `arrivedBodyDigest` skips the check for `undefined` but checks `null`
   (`:313-317`); an empty raw body (`""`) digests differently than `null`;
   `canonicalJson` **throws** on non-finite numbers etc.
   (`src/orchestration/digest.ts:12-14`, verified), and `JSON.parse("1e400")` yields
   `Infinity` — a legal JSON body that crashes the digest path (feeds ID-05).
2. **Evidence.** Auditor verified `digest.ts` throw behavior and the middleware
   digest helpers; scout established the absent/null/`""` conflation matrix and that
   **no test covers `body_digest_mismatch`** (grep: zero) — the body-substitution
   defense is untested.
3. **Preconditions.** Substitution vector: a relay rewriting absent-body to null-body
   (impact low today — schema-parsed routes reject `null` later). Crash vector: a
   body-carrying request with `1e400` to a hook-registered route (today's registrations
   are GET SSE + WS upgrade, bodies typically absent → latent).
4. **Expected vs actual.** Expected: one digest per body shape; a checker that
   distinguishes unchecked from checked. Actual: conflations + a thrower.
5. **Root cause.** `null`-coalescing default; canonicalizer is partial on
   JSON-reachable values.
6. **Scope/impact.** P3 (latent), rising with any future POST route on the hook.
7. **Remediation direction.** Reject non-encodable values as `validation` refusals
   instead of throwing; decide absent-vs-null semantics explicitly; add the missing
   `body_digest_mismatch` tests.
8. **Regression tests.** Body-substitution matrix (absent/null/`""`/JSON/raw) and a
   hostile-JSON case per fix.
9. **Related.** ID-05 (interlock).
10. **Rollback.** n/a.

### ID-07 · nodeId derivation — NOT_A_BUG

`nodeIdForCodeHash` = `node-enr-` + 24 hex chars (96 bits) of the code's SHA-256
(`enrollment-code.ts:462-481`); code = 32 CSPRNG bytes (`:287-291`); an unmatched hash
is refused before derivation matters; retry converges to the same id; the key is pinned
exact and its id derived from key bytes (`node-key.ts:37-41`). Collision ≈
$2^{-96}n^2$ (≈$10^{-12}$ at $10^6$ codes). Safe by construction; caller-chosen ids
only via the operator issuance path.

### ID-09 · `expectedNodeId` is a static single-peer seam — CONFIRMED_DESIGN_RISK (P3)

1. **Summary.** Each hook registration pins exactly one peer identity
   (`middleware.ts:73-78`; enforced `request-signature.ts:249-258`); the two gateway
   routes pass a fixed value at fixed paths (`gateway/events/route.ts:66`,
   `gateway/terminal/route.ts:220`). Multi-peer serving needs N mounts (path collision)
   or a resolver that does not exist; failover/takeover requires manually rewriting the
   seam — the takeover protocol raises an epoch but updates no identity pins.
2. **Evidence.** Auditory + scout call-site sweep; `middleware.test.ts:307` asserts the
   seam-decides design ("a header cannot choose which node this is") — correct as an
   anti-spoofing property; the cost is topology rigidity.
3. **Preconditions.** Multi-worker mesh or controller failover.
4. **Expected vs actual.** Expected: peer set resolvable from recorded state; actual:
   one static peer per seam.
5. **Root cause.** Spoofing defense implemented as a literal pin instead of a
   trust-store lookup keyed by recorded state.
6. **Scope/impact.** P3 today (harness/few-peer topologies); blocks multi-node
   operation when the mesh transport ships.
7. **Remediation direction.** Resolve `expectedNodeId` from the trust store (enrolled
   set) at request time; keep header-disambiguation impossible by keying on
   route/socket identity.
8. **Regression tests.** Two-peer seam test; failover identity test (successor
   accepted after recorded takeover).
9. **Related.** REG-01/REG-02 (same missing composition of identity + registry).
10. **Rollback.** Pin mode retained as a strict fallback.

---

## C. Detailed findings (Part 3) — existing audit revalidation + packaging + new findings

Revalidation of the MNT series against `e7dd900` (scout `MntPackagingAudit` output
cross-checked by the auditor; auditor-verified claims marked [AV]).

### MNT revalidation summary

| Item | Status at e7dd900 | Evidence |
|---|---|---|
| MNT-108 (BudgetLedgerStore deferral) | **Still valid — but qualified by N-02 below** | Deferral rationale intact (`src/budgets/ledger.ts:120-138`); only `InMemoryBudgetLedgerStore` implements the store; `new BudgetLedger(` only at `src/simulation/plan.ts:1062` in `src/` [AV via scout + grep] |
| MNT-205/307 (`tmux-start.sh`) | **Still valid — fix not implemented** | `scripts/tmux-start.sh:18-19` unchanged: `OPENCODE_SERVER_PASSWORD` in the tmux command string + `--hostname 0.0.0.0`; violates the invariants test-enforced only for `src/host/tmux.ts` (`tests/unit/host/tmux.test.ts:165-190,192-229`). Bridge window runs `bun run dev` → `tsx` (detail c) [AV: file read earlier + scout] |
| MNT-305/201 (runner duality) | **Still valid** | `package.json:35` `test: vitest run`; CI + `release:check` run `bun test`; vitest in neither gate. `CONTRIBUTING.md:91` mislabels `bun test` as "Vitest test suite" (AGENTS.md:19 is correct). Vitest red at e7dd900 re-confirmed by execution (§D) [AV] |
| MNT-308 (gate asymmetry) | **Still valid** | CI-only: `docs:check`, cargo fmt/clippy/test; release-only: frozen install ordering (scout + §D evidence) |
| MNT-310 (platform-package pipeline) | **Still valid — decision gate B13 unaddressed** | `src/host/binaries.ts:21-28` 6 packages; `scripts/package-binaries.ts:25-72` 6 configs; `build-matrix.sh:33-38` 5 targets (no `aarch64-unknown-linux-gnu`); no `optionalDependencies`; publish.yml `packages/*` loops (`:133-138,:163-171`) with no staging step; `/packages/`, `/dist-bin/` gitignored; local remnant `packages/aibridge-darwin-arm64` still at 2.1.1 naming retired `aibr-tui` |
| MNT-315 (duplicate router binary) | **Still valid** | `bin/` holds `aibr`, `aibr-router`, `aibr-router-darwin-arm64`; both router files packed (`files: ["dist","bin",…]`); zero code references the `-darwin-arm64` name; resolution reads only `bin/aibr-router` (`src/host/binaries.ts`; `scripts/install.sh:160-164`; `packaging/systemd/aibr-router.service:29-31`). Prior `shasum` (identical SHA256 `0aa66db6…`, 1,661,680 B each) stands [AV: prior executed + scout] |
| MNT-316 (broken `bin/aibr`) | **Still valid — failure mode now precise** | Installed `aibr` command is unaffected: `package.json` `bin.aibr` → `./dist/cli.js`, so npm links `dist/cli.js`. The file `bin/aibr` is inert in the tarball; direct execution fails loudly (`exec bun <pkgroot>/src/cli.ts` where `src/` is not shipped → module-not-found, or exit 127 if bun absent). `tests/integration/package-smoke.test.ts:145-167,228-233` would not trip on deletion |

### E-1 · `config/*.example.json` topology consistency — NOT_A_BUG (with validation gap)

`config/test-vps.example.json:2-8` sets `"ingress_mode": "router"` (matches
`Docs/guides/configuration.md:34`, `Docs/operations/deployment.md:17`);
`config/dev-main.example.json` omits it → default `"engine"`
(`src/config/schemas.ts:55`, `contracts/v1/bridge-config.schema.json:32-33`) matching
`configuration.md:33`. Gap: `check-docs.ts:215-232` schema-parses examples but never
cross-checks documented topology vs fields — deleting the field keeps docs:check green
while the documented topology silently flips. [INFERENCE on the failure mode; schema
behavior verified]. Related: `Docs/adr/0008-…:345` rollout step "Default `router` for
new installs" is unapplied (schema default still `engine`) with no status marker.

### E-2 · XDG/uninstall/profile — coverage verified, three named gaps

`src/host/paths.ts:62-86,101-123` (XDG resolution, frozen paths, absolute-path
post-check) and `tests/unit/host/paths.test.ts` verified by scout reads;
`scripts/docs/check-docs.ts:300-316,441-465` uninstall rule + thorough tests
(`tests/unit/documentation/uninstall-safety-check.test.ts` Cases A–E). Gaps: (a) only
`rm`-family root deletions recognized (`find -delete`, `rsync --delete`, non-XDG paths
escape); (b) self-declared `Status:` markers bypass the check entirely
(`check-docs.ts:65,445`); (c) markdown-only scan set (shell/packaging sources excluded
— spot-checked clean). P3.

### E-3 · External-consumer posture (unchanged from audit C7, restated per §4-E.6/7)

Inspected: this repository (grep), sibling repos `aibr-manager`, `aibr-herdr-bridge`,
`herdr` on disk (prior session, read-only). Not inspected / unknown: npm download and
deep-import telemetry (unavailable offline), any consumer outside these four repos.
Therefore deletion proposals (MNT-301/302/315/316, orphan modules) remain
**evidence-gated with move-before-delete** (backlog B10–B12); the compatibility-safe
plan is: publish a deprecation note + one release with re-export shims, then remove.
No deletion is authorized by this audit.

### N-02 · Budget enforcement is fail-open in the only production coordinator wiring — CONFIRMED_DESIGN_RISK (P1/P2, refactor-blocking for kernel work)

1. **Summary.** The budget ledger port is optional and is **not** wired in the only
   production `CoordinatorDependencies` builder; both enforcement points silently
   skip reservations when it is absent. Tests inject a real ledger, so the ceiling
   suites pass while production parallel fan-out runs unbounded by budgets.
2. **Evidence.** [AV — auditor-verified] `src/orchestration/coordinator/types.ts:137-138`
   (`budgetLedger?: BudgetLedgerPort`, optional); `src/orchestration/coordinator/coordinator.ts:1415-1416`
   (`if (discussion.roundtable.mode === "parallel" && this.#deps.budgetLedger)`);
   `src/orchestration/scheduler/fan-out.ts:117-121` (`if (options.budgetLedger)`);
   the only `CoordinatorDependencies` builder in `src/` is
   `src/mesh/fault/controller.ts:251-325` — `budgetLedger` occurs nowhere in
   `src/mesh/fault/`, `src/application/`, `src/server/` (grep). Tests do inject it
   (`tests/unit/orchestration/scheduler/fan-out.test.ts:255-264,496-502`).
3. **Preconditions/repro.** Any parallel roundtable fan-out or sibling dispatch issued
   through the production coordinator wiring. Repro plan (no code change): instrument
   `BudgetLedger.reserve` call counts in a test-configured run vs the production
   builder — expect zero in the latter.
4. **Expected vs actual.** Expected (invariant G8, `phase-2-verification-safety.md` §4):
   ceilings enforced on every fan-out. Actual: enforcement exists only when a caller
   opts in; the shipped wiring opts out.
5. **Root cause.** Optional port + skip-if-absent consumers = fail-open default; the
   kernel's invariant was validated in tests against a configuration production never
   builds.
6. **Scope/impact.** Budget ceilings (`maxFanOut`, concurrency) are advisory at
   runtime today. Directly qualifies MNT-108 ("deferral" covers the durable store;
   this shows even the in-memory enforcement is unwired) and weakens guarantee G8.
   P1 severity for kernel correctness claims; refactor-blocking for anything touching
   coordinator/scheduler.
7. **Remediation direction.** Wire the ledger in the production builder (in-memory
   store is sufficient for enforcement) or make the port mandatory with a fail-closed
   `RefusingBudgetLedger` default (mirroring `RefusingNonceGuard` precedent).
8. **Regression tests.** A test constructing the production dependency builder and
   asserting `reserve` is called on parallel fan-out; a fail-closed test when the
   store is unavailable.
9. **Related.** MNT-108, MNT-101 (coordinator refactor must not cement fail-open),
   REG-09 (self-declared capacity vs controller-side caps — this was the controller-side
   cap).
10. **Rollback.** Wiring is additive; fail-closed default has the `RefusingNonceGuard`
    "visibly broken instead of silently disabled" precedent.

### N-03 · `milestone-7.yml` bound commentary contradicts its own enforcement — CONFIRMED_MAINTAINABILITY_ISSUE (P3)

`milestone-7.yml:87-89` comment: "The bound is currently MISSED (2,222,768 bytes on
x86_64 musl)" — the same step emits `size_bound_bytes=2359296` (amended per ADR 0008 §12)
and the final gate enforces the amended bound (`:102`). The binary (2,222,768) satisfies
the amended bound; the comment predates the amendment and reads as a failing gate.
[AV: file read]. Fix = comment update; no behavior.

### N-04 · `contracts:check` requires `rg` without declaring it — CONFIRMED_MAINTAINABILITY_ISSUE (P3)

`package.json:42` pipes `git status --porcelain … | rg '^\?\?'`; `release:check` →
publish.yml "Validate release package" therefore needs ripgrep on the machine; a
missing `rg` fails the release gate with a broken-pipeline error, not a diagnostic.
Noted in `phase-3-tooling-docs.md` §3 but previously unregistered.

### N-05 · Documented headless path runs the Node dev entry — CONFIRMED_MAINTAINABILITY_ISSUE (P3)

`scripts/tmux-start.sh:22-23` runs `bun run dev` = `tsx src/index.ts`
(`package.json:29`), not the built artifact (`start` → `bun dist/index.js`): the
documented production headless path exercises neither `dist/` nor the Bun runtime —
the exact Node/Bun duality behind MNT-201/204 (`BunProcessRunner` silent no-op under
Node is reachable here in spirit; the engine path itself avoids `BunProcessRunner`,
but `src/host/runtime.ts` consumers are CLI-only — nuance preserved).

---

## C. Detailed findings (Part 4) — remaining registry candidates (condensed; evidence verified)

### REG-03 · Capability envelope direction — NOT_A_BUG (checked and cleared)

What was checked: `canScheduleOn` (`src/mesh/registry/capability.ts:263-467`) against the
documented protocol contract (`capability.ts:9-45`, `schemas.ts:21-34`): the remote
advertisement must cover the request (`requested ⊆ advertised`, `:347-387`) and local
authorities only refuse (`deniedCapabilities` `:374-407`, envelope under-use `:409-433`,
allowlist `:436-448`); negotiation takes the highest common version with no downgrade
(`src/mesh/protocol/negotiation.ts:31-48,70-87`). Both directions tested
(`capability-verdict.test.ts:95,119,147`). The "reversed" hypothesis is contradicted by
the contract. Residual (INFO): `projectPathAllowedCapabilities: null` skips the
allowlist check (`:436-448`) although the module comment calls a missing allowlist
"absence of evidence"; visible in the verdict's `authoritative` field. Action: monitor.

### REG-06 · displayName/enrolledAt write-vs-read validation — CONFIRMED_BUG (P2)

1. **Summary.** `NodeEnrollmentInput.displayName: string` / `enrolledAt: number` are
   unvalidated (`src/mesh/registry/types.ts:33-35`); `enrollNode` stores them raw
   (`memory-registry.ts:47-100`, `sqlite-registry.ts:119-205` binding at `:193-194`),
   while every read re-parses through `nodeRecordSchema` (trimmed 1..256,
   non-negative int — `schemas.ts:178-183`) and **one unreadable row fails the whole
   `nodes()` read** (`sqlite-registry.ts:221-233`, deliberate per comment).
2. **Evidence.** Auditor verified the type, the read schema, and the whole-list failure
   directly (reads above); no test covers invalid displayName/enrolledAt
   (`registry-store.test.ts` fixtures use safe values).
3. **Preconditions/repro.** `enrollNode({ displayName: " padded ", … })` (or `""`,
   >256 chars, `enrolledAt: -1`) → row persists → `node()`/`nodes()` return
   `registry.node_record_unreadable`; the mesh listing is bricked.
4. **Expected vs actual.** Write refuses what the read schema refuses; actual: writes
   accept, reads refuse.
5. **Root cause.** Validation lives only on the read side; wire schema
   (`protocol/enrollment.ts:46`) allows untrimmed names — a third variant.
6. **Scope/impact.** P2 correctness: durable registry can be poisoned into total read
   failure. Latent today (production enrollment writes the identity trust store, not the
   registry) but the store API is public.
7. **Remediation.** Validate on write through the same schema; align the wire variant.
8. **Regression tests.** Invalid-name/`enrolledAt` write refusals; adversarial-row
   tests (REG-11).
9. **Related.** REG-07 (memory store would accept what SQLite later rejects),
   REG-11 (no CHECK constraints).
10. **Rollback.** Migration note needed for any existing untrimmed rows.

### REG-07 · Adapter parity — PARTIALLY_CONFIRMED (P3)

Shared contract tests exist and pass for well-formed records
(`registry-store.test.ts:55-123,438`; `heartbeat-expiry.test.ts:209`;
`reconnect.test.ts:228`), but three concrete divergences were verified: (1) SQLite
re-parses rows on read (`sqlite-registry.ts:60-64,415`) while memory returns Map values
raw (`memory-registry.ts:82-90`); (2) SQLite refuses inverted gaps
(`sqlite-registry.ts:244-246`) while memory appends them (`memory-registry.ts:137-141`);
(3) `nodes()` ordering differs (SQL `ORDER BY node_id` `migrations.ts:339` vs insertion
order). Impact: same input, adapter-dependent answers under invalid input/ordering.
Action: V12 parity tests + align. Rollback: test-only.

### REG-11 · Casts and DB constraints — PARTIALLY_CONFIRMED (P3)

What was checked: the single `{ … } as MeshHeartbeat` (`registry.ts:119-121`) is narrowed
to one schema-validated field (`observedAt`) and is safe; other casts are result
widening. The DDL (`migrations.ts:68-101`) is plain `TEXT`/`INTEGER` — no `STRICT`, no
`CHECK` — and the one migration checks object presence only (`:196-210`). Malformed
values reach persistence only via REG-06's write gap (heartbeat snapshots are Zod-gated
at write — `registry-store.test.ts:416`). Action: constraints as defense-in-depth under
V11. Rollback: additive migration.

## Cross-cutting themes (§4.C) — disposition

Each mandated theme was investigated; where evidence supported it, a finding ID was
created (none presumed a defect a priori). No theme produced a finding beyond those in
the matrix.

| Theme | Disposition | Findings |
|---|---|---|
| C1 Authentication→authorization binding | **Gap confirmed** at the heartbeat ingest seam; command path binds correctly | REG-01 (contrast: `inbox.ts:150-157`) |
| C2 Revocation propagation | **Gap confirmed**: per-request enforced; streams unwired; two stores unsynchronized | ID-02, REG-02, REG-08 |
| C3 Enrollment recovery | **Gap confirmed**: partial-failure dead ends, misleading retry claim | ID-03 |
| C4 Replay defense | **Sound** (bounded 100k, verify-before-consume, fail-closed at full); shared-capacity caveat | ID-04 (PARTIALLY_CONFIRMED) |
| C5 Clock & sequence semantics | **Mixed**: remote-clock liveness with zero future tolerance; restart recovery absent | REG-04, REG-05 |
| C6 Persistence parity | **Mixed**: happy-path parity tested; invalid-input/ordering divergences | REG-06, REG-07, REG-11 |
| C7 Fail-closed behavior | **Mixed**: stores fail closed by contract (`Result`), but the middleware lacks a rejection handler and maps internal faults to 401 | ID-05 |
| C8 Protocol canonicalization | **Shared canonicalizer confirmed**; absent≡null conflation and a thrower on hostile JSON | ID-06 |

---

# Deliverables A, B, E, F (consolidation)

Section order note: §0 baseline and §D test evidence were produced first; §C contains
the detailed findings (Parts 1–3); this final block contains the executive summary,
verification matrix, backlog proposal, readiness gate, and appendices.

## A. Executive summary

**Commit:** `e7dd900dd8a21bd7246142d1016c530bbb8b21a5`, branch
`asset-project-maintainability`. Working tree at start: **clean**. Code drift vs the
prior audit's commit `6dc9b04`: **none** (docs-only commits between). Tree at report
time: clean except this report and the changelog entry (Appendix B).

**Findings examined: 35 rows** (21 mandated candidates ID-01…ID-10, REG-01…REG-11;
5 new findings N-01…N-05; 7 MNT-series revalidations; 2 packaging/compatibility items).

| Status | Count |
|---|---|
| CONFIRMED_BUG | 6 (ID-03, ID-05, ID-08, REG-06, N-01, MNT-201/305) |
| CONFIRMED_SECURITY_RISK | 1 (MNT-205/307) |
| CONFIRMED_DESIGN_RISK | 9 (ID-02, ID-09, REG-01, REG-02, REG-04, REG-09, REG-10, N-02, MNT-310) |
| CONFIRMED_MAINTAINABILITY_ISSUE | 6 (MNT-308, MNT-315, MNT-316, N-03, N-04, N-05) |
| PARTIALLY_CONFIRMED | 11 (ID-01, ID-04, ID-06, ID-10, REG-05, REG-07, REG-08, REG-11, MNT-108, E-1, E-2) |
| NOT_A_BUG | 2 (ID-07, REG-03) |
| STALE / NOT_REPRODUCED / UNVERIFIABLE | 0 |

E-1 is dual-classified in the matrix (`NOT_A_BUG` for the topology claim,
`PARTIALLY_CONFIRMED` for the validator gap) and is counted once, under
PARTIALLY_CONFIRMED, in the table above.

| Severity | Count |
|---|---|
| P1 | 2 (N-02 budget fail-open in production wiring; MNT-205/307 secrets-in-argv + wildcard bind on the documented headless path) |
| P2 | 10 (ID-02, ID-03, ID-05, ID-08, REG-01, REG-02, REG-04, REG-06, MNT-201/305, MNT-308) |
| P3 | 20 |
| INFO | 3 (ID-07, REG-03, MNT-108) |

**Top risks that must be resolved (or explicitly accepted by the owner) before
refactoring:**

1. **N-02 (P1) — budget enforcement is fail-open in the only production coordinator
   wiring.** The `budgetLedger` port is optional and unset in
   `src/mesh/fault/controller.ts`; both enforcement points skip when absent while tests
   inject a real ledger. Any kernel/scheduler refactor built on this wiring would cement
   ceilings that exist only in tests.
2. **MNT-205/307 (P1) — `scripts/tmux-start.sh`**: serve password in process argv +
   `--hostname 0.0.0.0` on the documented headless path, contradicting the loopback
   execution boundary (`Docs/architecture/current-state.md:85`).
3. **Identity/registry composition gaps (P2): REG-01** (heartbeat ingestion never binds
   the authenticated signer to the record), **REG-02** (two unsynchronized revocation
   sources of truth), **ID-02** (revocation does not reach established streams; SSE has
   no close path), **REG-04** (documented restart recovery does not exist).
4. **Enrollment failure handling (P2): ID-03** (partial-failure dead ends incl. a
   silent false-accept), **ID-05** (no `.catch` on the identity hook; internal faults
   answered 401), **ID-08** (the promised audit log does not exist).
5. **Verification integrity (P2): MNT-201/305** (the documented `bun run test` is red at
   HEAD — re-confirmed by execution; CI's `bun test` hides it), **N-01** (WS smoke test
   flaky under load — reproduced).

**Areas with insufficient evidence:** npm registry consumer telemetry (deletion
compatibility), CI platform status (not queried), live multi-node mesh behavior
(identity/registry module is library code without production wiring — all verdicts are
contract-level), crash-window ID-03(c) reproduction (needs durable stores that do not
ship), `milestone-7.yml` CI minutes.

**Refactoring readiness recommendation: `OWNER_APPROVAL_REQUIRED`** — with the explicit
note that **kernel, identity, registry, and ingest refactors are
`BLOCKED_BY_CONFIRMED_FINDINGS`** until the named Phase-1 items (V16, V0/B4, V1, V3,
and the V2/V7/V9 decisions — Deliverable E) are resolved or the owner
records acceptance of the risk, and that test-infrastructure and documentation work
(N-01/N-03/N-04, B7–B9) is unblocked. Rationale: the codebase's invariant story is
strong where tested, but four P1/P2 findings (N-02, MNT-205, REG-01/02, ID-03) sit
directly under the areas a refactor would touch, and the behavioral-equivalence
baseline (Deliverable F) cannot be trusted while the documented test command is red and
a suite is flaky.

**Deliverable-A refactoring recommendation: `CONDITIONAL GO`** — proceed ONLY with
Phase 0 (test baseline), Phase 2 (gates), and evidence-gated Phase 3 items; the kernel /
identity / registry / transport refactors are **`NO-GO`** until the named P1/P2 blockers
are fixed or explicitly risk-accepted in writing by the owner.

## B. Finding verification matrix

| Finding ID | Original claim | Status | Sev | Affected areas | Evidence (current rev) | Impact | Confidence | Action | Backlog | Gate |
|---|---|---|---|---|---|---|---|---|---|---|
| ID-01 | Enrollment hash may act as bearer credential | PARTIALLY_CONFIRMED | P3 | identity/enrollment; code issuance trust | `enrollment-code.ts:584-599` (hash-only redeem), `:16-20` (mislabeled comment), `:190-237` (no cancel API); `no-secret-leak.test.ts:124-151` | Pre-redemption theft = identity hijack within TTL; single-use+TTL bound it | High (traced) | Fix docs; add cancel API | V4 | NON-BLOCKING |
| ID-02 | Revocation may not terminate active sessions | CONFIRMED_DESIGN_RISK | P2 | identity ↔ terminal/SSE gateways | `identity-provider.ts:117-118` (per-request), `gateway/terminal/gateway.ts:1052-1055` (revokeNode, no src caller), SSE has no close path (grep); `terminal-websocket.test.ts:1096-1113` hand-drives close | Compromised node keeps streaming after revoke | High | Fix (wire propagation) | V2 | BLOCKING (gateway work) |
| ID-03 | Enrollment retry may deadlock after partial failure | CONFIRMED_BUG | P2 | identity/enrollment state machine | `enrollment.ts:86-140,198-243` (auditor-verified): burn-before-writes; (a)(b) dead ends, (c) false `accepted` without trust write; no fault-injection tests | Node permanently un-enrollable or silently half-enrolled | High (trace; (c) needs durable stores) | Fix (transaction/state machine) | V1 | BLOCKING (identity work) |
| ID-04 | Nonce capacity/pruning DoS | PARTIALLY_CONFIRMED | P3 | identity replay guard | `replay-guard.ts:48,70-130` (100k cap, fail-closed, O(n) prune), `request-signature.ts:270-325` (verify-before-consume) | Shared-capacity refusal by one enrolled key for ≤330s window; unauthenticated floods die at verify | High | Monitor; per-node quotas if multi-tenant | V7 (opt) | NON-BLOCKING |
| ID-05 | Middleware mishandles async errors | CONFIRMED_BUG | P2 | identity middleware → HTTP boundary | `middleware.ts:167-182` (`.then` without `.catch`), `:139-146` (internal faults → 401) | Unhandled rejection/hung request; outage indistinguishable from attack | High (code); trigger reachability medium | Fix | V3 | BLOCKING (gateway work) |
| ID-06 | Empty-body digest inconsistency | PARTIALLY_CONFIRMED | P3 | digest canonicalization | `middleware.ts:313-341` (absent≡null, `""`≠null), `digest.ts:12-14` (throws on non-finite → ID-05); zero `body_digest_mismatch` tests | Substitution defense untested; hostile-JSON crash vector (latent) | High | Fix + tests | V3 | NON-BLOCKING |
| ID-07 | nodeId derived unsafely from enrollment code | NOT_A_BUG | INFO | identity/enrollment | `enrollment-code.ts:287-291,462-481`; 96-bit prefix of CSPRNG-code hash; convergence + exact-key pinning | Collision ≈2⁻⁹⁶n²; not plausible | High | Close | NONE | NON-BLOCKING |
| ID-08 | Rejection reasons discarded | CONFIRMED_BUG | P2 | identity/registry diagnostics | `enrollment-code.ts:509,588`, `node-trust.ts:220,269,420` promise an audit log; **no audit sink exists in `src/`** (grep); `app.ts:80` logger off | Operators cannot distinguish probing vs stale code vs clock skew | High | Fix (sink) or amend claims | V4 | BLOCKING (identity work) |
| ID-09 | Static expectedNodeId wrong for dynamic topologies | CONFIRMED_DESIGN_RISK | P3 | identity seam ↔ topology | `middleware.ts:73-78`, `request-signature.ts:249-258`, route registrations `events/route.ts:66`, `terminal/route.ts:220` | Multi-peer/failover needs manual seam rewrite; blocks multi-node mesh | High | Fix (trust-store resolution) | V5 | BLOCKING (mesh transport) |
| ID-10 | Key store durability/ownership insufficient | PARTIALLY_CONFIRMED | P3 | identity key store | `file-key-store.ts:97-140` (link no-overwrite, modes) vs missing fsync/uid checks (grep; `:335-368` defers owner to operator) | Crash can lose a "saved" key; foreign-owned tight-mode dir trusted | High | Fix (fsync, uid) | V6 | NON-BLOCKING |
| REG-01 | Heartbeat identity not bound to authenticated caller | CONFIRMED_DESIGN_RISK (security-leaning at seam) | P2 | registry ingest ↔ identity | `registry.ts:206-370` (no signer check), `fault/controller.ts:365-370`, `transport.ts:39-47`; contrast `inbox.ts:150-157`; `heartbeat.ts:89-111` claim-vs-claim only | Liveness/capability/sequence forgery for any record ingress reusing the seam | High (trace); medium (exploitability — harness-only today) | Fix (bind signer→claim) | V7 | BLOCKING (ingest/registry/transport) |
| REG-02 | Identity/registry sources of truth inconsistent | CONFIRMED_DESIGN_RISK | P2 | identity stores ↔ registry stores | dual `revokeNode` (`node-trust.ts:224-330`, `registry.ts:446`); `registry/schemas.ts:130-141` admits duplication; only `harness.ts:202-212` writes both | Revoked node accepted by one subsystem; controller may dispatch to revoked node | High | Fix (single revocation entry) | V8 | BLOCKING (identity/registry) |
| REG-03 | Capability envelope validation reversed/incomplete | NOT_A_BUG | INFO | registry/capability | `capability.ts:263-467` direction = requested ⊆ advertised, authorities refuse-only; `capability-verdict.test.ts` both directions | None demonstrated; minor `null`-allowlist asymmetry documented | High | Close; monitor asymmetry | NONE | NON-BLOCKING |
| REG-04 | Sequence regression may not recover | CONFIRMED_DESIGN_RISK | P2 | registry sequencing ↔ restart semantics | `registry.ts:306-324` refusal by design; **no reset path** (single writer `migrations.ts:380-384`; reconciler writes nothing); recovery only at counter > N (`heartbeat.ts:183`); `memory-registry.ts:73-77` re-enroll keeps baseline | Restart → long-lived `stale` + scheduling exclusion; crash-loop never converges | High | Fix (documented recovery) | V9 | BLOCKING (registry refactors) |
| REG-05 | Liveness trusts node clock | PARTIALLY_CONFIRMED | P3 | registry liveness | `heartbeat.ts:131-158` (remote `observedAt` vs controller now; zero future tolerance), `bounds.ts:33` (90s) | Skewed clocks → permanently unliveable/`stale`; future-stamps cannot fake liveness | High | Fix (receive-time basis) | V10 | NON-BLOCKING |
| REG-06 | displayName write/read validation inconsistent | CONFIRMED_BUG | P2 | registry persistence | `types.ts:33-35` unvalidated input; `schemas.ts:178-183` strict read; `sqlite-registry.ts:221-233` one bad row fails whole listing (verified) | Invalid data persists; durable registry listing bricks | High | Fix (write validation) | V11 | BLOCKING (registry refactors) |
| REG-07 | SQLite vs in-memory semantics differ | PARTIALLY_CONFIRMED | P3 | registry adapters | `registry-store.test.ts:55-123,438` parity on happy path; divergences: read re-validation (memory returns raw `memory-registry.ts:82-90`), gap inversion (`:137-141` vs `sqlite-registry.ts:244-246`), ordering | Adapter-dependent behavior under invalid input | High | Tests + align | V12 | NON-BLOCKING |
| REG-08 | CAS may not atomically check revocation | PARTIALLY_CONFIRMED | P3 | registry CAS | `migrations.ts:380-384` (sequence-only WHERE), `registry.ts:284-335` TOCTOU; read path revocation-first (`registry.ts:88-95`) contains impact | Post-revoke row write possible; no liveness/scheduling corruption | High (code) | Defense-in-depth fix | V8 | NON-BLOCKING |
| REG-09 | activeSessions self-declared, influences dispatch | CONFIRMED_DESIGN_RISK | P3 | registry → routing/scheduling | `heartbeat.ts:22-27,66-87` (self-declared, self-bounded), `capability.ts:450-460`, `routing/rank.ts:259-263` | Node can dodge/attract work up to controller-side caps | High | Test the caps; monitor | V13 | NON-BLOCKING |
| REG-10 | Heartbeat gap tracking unbounded | CONFIRMED_DESIGN_RISK | P3 | registry persistence | gap inserts `sqlite-registry.ts:266-271`/`memory-registry.ts:137-139`; no DELETE/prune anywhere (grep); scout quantification ≈1M rows/yr/node at +2 oscillation | Unbounded controller DB growth | High | Fix (retention) | V14 | NON-BLOCKING |
| REG-11 | Unsafe casts / missing SQLite constraints | PARTIALLY_CONFIRMED | P3 | registry schema | cast is narrowed+validated (`registry.ts:119-121`); DDL no STRICT/CHECK (`migrations.ts:68-101`); REG-06 lets invalid columns persist | DB-level defense absent; app-side validation asymmetric | High | Constraints + V11 | V11 | NON-BLOCKING |
| N-01 (new) | — (WS smoke test flaky under load) | CONFIRMED_BUG | P3 | test reliability | full-suite fail + isolation 20/20 pass (§D); fixed sleeps `terminal-websocket.test.ts:1196-1201` | Red-herring CI failures | High (reproduced twice) | Fix (eventual assertions) | V15 | NON-BLOCKING |
| N-02 (new) | — (budget fail-open in production wiring) | CONFIRMED_DESIGN_RISK | **P1** | coordinator/scheduler wiring | `coordinator/types.ts:137-138` optional port; `coordinator.ts:1415-1416`, `fan-out.ts:117-121` skip-if-absent; `fault/controller.ts` sets none [AV] | Budget ceilings unenforced at runtime; tests prove a configuration production never builds | High | Fix (wire or fail-closed) | V16 | **BLOCKING (kernel refactors)** |
| N-03 (new) | — (milestone-7 bound comment self-contradictory) | CONFIRMED_MAINTAINABILITY_ISSUE | P3 | CI docs | `milestone-7.yml:87-89` vs `:102` | Misleading gate status | High | Doc fix | V17 | NON-BLOCKING |
| N-04 (new) | — (`contracts:check` needs undeclared `rg`) | CONFIRMED_MAINTAINABILITY_ISSUE | P3 | release tooling | `package.json:42` | Release gate fails opaquely without ripgrep | High | Fix | V17 | NON-BLOCKING |
| N-05 (new) | — (headless path runs Node dev entry) | CONFIRMED_MAINTAINABILITY_ISSUE | P3 | ops scripts | `tmux-start.sh:22-23` → `package.json:29` (`tsx`) | Documented prod path tests neither `dist/` nor Bun | High | Fix | V18 | NON-BLOCKING |
| MNT-108 | Durable BudgetLedgerStore absent | PARTIALLY_CONFIRMED | INFO | budgets | deferral documented `ledger.ts:120-138`; simulation-only instantiation `plan.ts:1062`; real gap is N-02 | Deferral itself is sound and documented | High | Close as deferred; fix via V16 | V16 | NON-BLOCKING |
| MNT-205/307 | tmux-start.sh secrets/0.0.0.0 | CONFIRMED_SECURITY_RISK | **P1** | ops script ↔ security boundary | `tmux-start.sh:18-19` (verified); invariant `tmux.test.ts:165-190,192-229` covers only `src/host/tmux.ts` | Password visible in argv; opencode exposed on shared hosts | High | Fix | B4/V0 | BLOCKING (ops path changes) |
| MNT-201/305 | Two runners; vitest red at HEAD | CONFIRMED_BUG | P2 | verification | re-executed: `bun run test` 8-fail at e7dd900 (7 BunProcessRunner + N-01), `bun test` 1-flake-fail; `runtime.ts:94-106` silent no-op | Documented command red; CI-green ≠ suite-green | High | Fix | B1 | BLOCKING (baseline trust) |
| MNT-308 | release:check ≠ CI | CONFIRMED_MAINTAINABILITY_ISSUE | P2 | release gates | CI-only docs/cargo steps; release omits them (workflows + package.json) | Releases can ship failing cargo tests/docs | High | Fix | B7 | NON-BLOCKING |
| MNT-310 | Platform-package pipeline unwired | CONFIRMED_DESIGN_RISK | P3 | packaging supply chain | `binaries.ts:21-28`, `package-binaries.ts:25-72` vs `build-matrix.sh:33-38`; no optionalDependencies; publish loop unreachable | Platform packages cannot publish from CI | High | Decision gate | B13 | NON-BLOCKING |
| MNT-315 | Duplicate router binary in tarball | CONFIRMED_MAINTAINABILITY_ISSUE | P3 | packaging | prior `shasum` identical; no code references `bin/aibr-router-darwin-arm64`; packed via `files` | 1.66 MB/install dead weight | High | Remove (evidence-gated) | B10 | NON-BLOCKING |
| MNT-316 | `bin/aibr` broken in package | CONFIRMED_MAINTAINABILITY_ISSUE | P3 | packaging | failure mode precise: installed `aibr` unaffected (`bin.aibr`→`dist/cli.js`); file inert; direct exec fails loudly | Confusion only | High | Remove/relocate | B10 | NON-BLOCKING |
| E-1 | config examples inconsistent with topology | NOT_A_BUG (topology) / PARTIALLY_CONFIRMED (validator gap) | P3 | config/docs validation | `test-vps.example.json:2-8` `router`, `dev-main` default `engine` — both match docs; `check-docs.ts:215-232` no topology cross-check | Future field deletion flips topology silently | High | Test (validator) | V17 | NON-BLOCKING |
| E-2 | XDG/uninstall/profile safety | PARTIALLY_CONFIRMED (gaps) | P3 | docs validation | `paths.ts:62-123` + tests verified; `check-docs.ts:300-316,441-465` rm-family only; status-marker bypass `:65,445` | Non-rm destructive docs escape the checker | High (scout reads) | Monitor/extend | B9 | NON-BLOCKING |

## E. Updated implementation backlog proposal (not implemented)

Phase mapping per the suggested structure. **V-items are new** (from this verification);
**B-items reference `implementation-backlog.md`** (prior audit) and keep their
prerequisites/acceptance/rollback there. Every V-item: acceptance = named regression
test(s) green + the verification command listed.

### Phase 0 — Evidence and test baseline
| Item | Content | Acceptance | Deps | Rollback |
|---|---|---|---|---|
| V15 | Fix N-01 flake (eventual assertions in `terminal-websocket.test.ts`) | 10 consecutive full-suite runs green under CPU load | none | test-only revert |
| V19 | Record current failing state of `bun run test` as the known baseline (do not paper over): track MNT-201 | classified failure list in repo docs | none | n/a |
| B1 | Runner unification (MNT-201/305) — recommend `bun test` canonical | both documented commands green on identical set | V15 first (clean signal) | revert package.json+docs |

### Phase 1 — Security and correctness
| Item | Content | Acceptance | Deps | Rollback |
|---|---|---|---|---|
| V0/B4 | Fix `tmux-start.sh`: 127.0.0.1 default, env-not-argv password, Node→Bun entry (covers N-05) | grep-test passes; matches `tmux.test.ts` invariants | none | script revert |
| V16 | Budget wiring fail-closed: wire `budgetLedger` in production builder or mandatory port + `RefusingBudgetLedger` | production-builder test asserts `reserve` called on parallel fan-out | none | additive |
| V1 | Enrollment state machine: transactional pin+trust or `pending→trusted` states; fix false "retryable" message (ID-03) | fault-injection tests (a)–(d) | none | keep old methods until callers migrate |
| V3 | Middleware `.catch` + 5xx internal-fault class + digest non-throw (ID-05/ID-06) | throwing-store test; status-matrix test; body-substitution matrix incl. `body_digest_mismatch` | none | additive |
| V2 | Revocation propagation: single entry point writing both stores + kicking WS/SSE streams (ID-02/REG-02/REG-08) | revoke-via-entry-point test closes streams; cross-store consistency test | V16 (kernel state) for scheduling correctness | dual-write then migrate |
| V4 | Audit sink for identity/registry refusals (ID-08) + enrollment-code cancel API (ID-01) | one redacted audit record per refusal family; cancel test | V3 (error paths) | additive |
| V7 | REG-01 signer→claim binding at the ingest seam | spoofed-heartbeat refusal test (A-signed, B-claimed) | V2 (same composition area) | additive |
| V9 | REG-04 recovery: documented reconcile/baseline reset (authenticated, audited) | restart-recovery test + forged-regression-still-refused test | V7 (reset must be authenticated) | additive |
| V11 | REG-06/REG-11: write validation parity + STRICT/CHECK constraints | invalid-displayName write refused; adversarial row tests | migration note for existing rows | migration + rollback plan |

### Phase 2 — Verification gates
| Item | Content | Acceptance | Deps |
|---|---|---|---|
| B7 | `verify:all` ≙ CI (MNT-308) | one command reproduces CI; deliberate-failure demos | B1 |
| V12 | Adapter parity: invalid-input + ordering + gap-inversion parity tests (REG-07) | both stores agree on named cases | V11 |
| V13 | Controller-side cap test: `activeSessions` under-report cannot bypass caps (REG-09) | adversarial load-report test | V16 |
| V17 | Doc/validator sweep: N-03 comment, N-04 `rg` dependency, E-1 topology cross-check, E-2 coverage notes | drift table empty; new checks green | B1/V0 |

### Phase 3 — Evidence-gated cleanup
Existing B10–B15 unchanged (MNT-315/316 verified still valid; deletion standard unchanged: move-before-delete, npm telemetry unknown). MNT-310 stays a **decision gate** (B13).

### Phase 4 — Structural refactoring (only after Phases 0–2)
B16 `DispatchCoordinator` extraction — now additionally gated on **V16** (the refactor
must not cement budget fail-open) and V7/REG-01 (ingest seam decisions). Differential
behavior gates unchanged (event-sequence byte-compare, projection snapshots,
side-effect counters).

### Closed/deferred with justification
- ID-07, REG-03: closed (NOT_A_BUG).
- MNT-108: closed as intentionally deferred; superseded by V16.
- ID-04: deferred/monitor (precondition = compromised enrolled key); revisit with V7.
- REG-05 (V10) and REG-10 (V14) are real but non-blocking; schedule after Phase 1.

## F. Refactoring readiness gate

**Current state: `OWNER_APPROVAL_REQUIRED`.** (Upper bound per mandate; implementation
is not authorized by this task.)

Per-area gate:

| Refactor area | State | Blocking findings (aligned to matrix `Refactor gate`) |
|---|---|---|
| Kernel (`DispatchCoordinator`, scheduler, budgets) | BLOCKED_BY_CONFIRMED_FINDINGS | N-02 (P1) — the only finding whose gate is `BLOCKING (kernel refactors)` |
| Identity/enrollment/registry | BLOCKED_BY_CONFIRMED_FINDINGS | ID-03, ID-05, ID-08, REG-01, REG-02, REG-04, REG-06 |
| Gateways/transport | BLOCKED_BY_CONFIRMED_FINDINGS | ID-02, ID-05, ID-09, REG-01 (its gate also names transport) |
| Test infrastructure, docs, packaging | OWNER_APPROVAL_REQUIRED (unblocked technically) | N-01, MNT-201/305 (baseline trust), N-03/04, B7–B10; MNT-205/307 blocks ops-script changes specifically (`BLOCKING (ops path changes)`) |
| `DispatchCoordinator` structural split (B16) | BLOCKED | N-02 (V16) + Phase 0/2 items; REG-01/REG-02 appear here as **B16 dependencies** (Deliverable E: the extraction consumes registry/revocation contracts via V7/V8), not as kernel-area blockers |

Scope note (per evidence, not broadened): REG-04/REG-06 block **registry** refactors
(their matrix gate labels) and are listed only there; REG-01/REG-02 block their
named areas and additionally constrain B16's contracts, which is a dependency of that
one refactor, not a general kernel blocker.

**Transition conditions to `READY_TO_IMPLEMENT` (exact):**
1. V16, V0/B4, V1, V3 resolved (or explicitly risk-accepted in writing by the owner).
2. V2/V7/V9 decision recorded: either fixed or the transport scope is frozen so the
   ingest seam cannot be widened without the binding.
3. Phase 0 baseline green: `bun test` and the documented dev-test command pass at one
   commit; N-01 flake fixed; known failures (if any) documented and classified.
4. `verify:all` (B7) exists and reproduces CI locally.
5. Behavior-equivalence gates defined per refactor: byte-identical event-sequence
   replays (`tests/unit/orchestration/fixtures/recorded-events.ts` consumers),
   projection snapshots, side-effect counters (`FakeOpencodeClient.createdSessions`/
   `sentPrompts`, notification-consumer counts). **Any unexplained behavioral
   difference blocks the refactor.**
6. Compatibility/rollback reviewed: move-before-delete for all deletions; npm deep-import
   telemetry still unknown → deprecation shim protocol (audit C7) applies.
7. Owner approval recorded.

## Appendix A — Files inspected / not inspected

**Inspected (this audit):** `src/mesh/identity/{middleware,identity-provider,node-trust,enrollment,enrollment-code,file-key-store,request-signature,replay-guard,crypto,node-key}.ts`;
`src/mesh/registry/{registry,sqlite-registry,memory-registry,migrations,schemas,types,gaps,capability}.ts`;
`src/mesh/protocol/{heartbeat,bounds}.ts`; `src/mesh/fault/{controller,worker,transport,proxy,harness}.ts`;
`src/mesh/gateway/{events/route,terminal/route,terminal/gateway,reconcile/reconciler}.ts`;
`src/mesh/inbox/inbox.ts`; `src/orchestration/{coordinator/types,coordinator/coordinator,scheduler/fan-out}.ts`;
`src/orchestration/digest.ts`; `src/server/app.ts`; `src/host/{runtime,binaries,paths}.ts`;
`scripts/{tmux-start.sh,install.sh,build-matrix.sh,package-binaries.ts,docs/check-docs.ts}`;
`package.json`, `.github/workflows/{ci,publish,milestone-7}.yml`, `config/*.example.json`;
`tests/` (identity, registry, event-store, terminal-websocket, release, documentation,
host, package-smoke, reconnect, capability-verdict, inbox); audit artifacts in
`Docs/implementation-reports/maintainability-audit/`; sibling repos
`aibr-manager`, `aibr-herdr-bridge`, `herdr` (read-only, prior pass, for consumer
evidence).

**Not inspected:** `@opencode-ai/sdk` internals; `bench/`, `spike/` bodies; `packaging/`
unit bodies beyond the cited lines; `src/cli/setup-*` widgets; `src/simulation` beyond
the budget probe; `router/src/*` beyond `contracts.rs` headers (Rust logic reviewed in
the prior audit only); GitHub Actions run history; npm registry telemetry; live
multi-node runtime (no production mesh transport exists to exercise).

## Appendix B — Changed paths (this audit)

- `Docs/implementation-reports/maintainability-audit/pre-refactor-verification-report.md` (created).
- `Docs/implementation-reports/maintainability-audit/audit-changelog.md` (appended entries C8, C9).

Revision provenance: audit evidence targets `e7dd900dd8a21bd7246142d1016c530bbb8b21a5`;
the report was published in `a3b8b16e4d45133fc28965a4d14aa7fc35c844b7` (docs-only, code
identical); the finalization metadata edit (status → FINAL, revision distinction,
readiness alignment) is recorded in `audit-changelog.md` C9 with its commit.

No other paths modified. No tests, production code, configs, package artifacts, or
workflows were changed; no pushes made. The only commits attributable to this audit are
documentation commits of these two files (latest: see `audit-changelog.md` C9). Temporary artifacts created during
the audit (`/tmp/prerefactor-audit-evidence.sh`, `/tmp/prerefactor-audit-evidence.log`)
held the raw command output cited in §D and were **deleted after capture**; the §D table
is the surviving record.



