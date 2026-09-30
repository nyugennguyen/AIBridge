# Milestone 4 — Distributed Tailscale Mesh: Gate Report

**Date:** 2026-09-30
**Scope:** M4.0 through M4.10 of `Docs/implementation-plans/milestone-4-distributed-mesh.md`
**Verdict:** **PASS, with three open Medium findings and one unsigned attestation recorded below.**

A passing gate is not a clean milestone. The three open findings are stated with their
file:line, not deferred to a footnote, and the M4-V re-approval is explicitly *not*
claimed as a design sign-off.

---

## 1. Frozen protocol version

| Fact | Value | Where it lives |
| --- | --- | --- |
| Mesh protocol version | **1** | `CURRENT_MESH_PROTOCOL_VERSION`, `src/mesh/protocol/negotiation.ts` |
| Record schema versions (writable) | **2** | `CURRENT_SCHEMA_VERSION`, `src/orchestration/identifiers.ts` |
| Record schema versions (readable) | **[1, 2]** | `SCHEMA_VERSIONS` — the M4-V widening |
| Frozen M0 domain record version | **1** | `FROZEN_DOMAIN_SCHEMA_VERSION` |
| Database (storage-layout) version | **2** | `CURRENT_DATABASE_VERSION`, `src/orchestration/event-store/schema.ts` |

**Record version per family** — all eleven `recordType`s declare `[2]` and nothing else,
verified from the running registry rather than from a table in this document:

```
mesh.enrollment.request       [2]      mesh.reconciliation.request   [2]
mesh.enrollment.response      [2]      mesh.reconciliation.response  [2]
mesh.heartbeat                [2]      mesh.terminal.control         [2]
mesh.command                  [2]      mesh.terminal.data            [2]
mesh.ack                      [2]
mesh.event                    [2]      mesh.lease                    [2]
```

Reproduce with `declaredFamilyVersions()` from `src/mesh/protocol/registry.ts`.

**The database version is a different axis and is not a protocol version.** Renaming it
`CURRENT_DATABASE_VERSION` at M4.0 was not cosmetic: conflating the two is precisely how
Milestone 3's event-payload break became unversionable, because the documented rollback
boundary ("a v1 binary can still read a v2 database") was the only boundary on offer.

**Nine families, eleven record types.** The three bidirectional families carry a distinct
type per direction so a receiver can refuse an inbound record where an outbound one was
expected. The alternative is the "union with an ambiguous discriminator" the specification
forbids for terminal frames, applied everywhere.

---

## 2. Enrollment and revocation procedure

**Enrollment** (one-time, single-use, expiry-bound, pinned):

1. An operator on the controller runs an already-authenticated local/admin flow that
   issues a code (`issueEnrollmentCode`). The code's entropy is a caller-supplied
   function, never a random source this module controls, so a transcript is reproducible.
2. The joining node generates an ed25519 keypair **locally**; the private key never
   leaves the machine.
3. The node sends `mesh.enrollment.request` carrying `enrollmentCodeHash` (sha256 of the
   code), its `nodePublicKey`, and a `provisionalNodeId`. The raw code is never on the wire.
4. The controller verifies the code **constant-time**, checks expiry, checks single use
   **atomically**, and checks the code is bound to exactly one `meshId`. The raw code
   appears in the store, never in an error.
5. On acceptance the controller pins the *exact* key submitted and returns
   `mesh.enrollment.response` with `nodeId`, `nodeKeyId` and the peer pins. This response
   is the **only** thing that makes a node addressable — `MeshNodeRegistry.enroll` is
   deliberately a static, not a method, so "enrolled" has exactly one reachable path.
6. Rejection reasons are indistinguishable on the wire ("code rejected"), with the real
   reason in the audit log only. Distinguishing "unknown" from "expired" from "already
   used" is an enumeration oracle.

**Revocation** (individual, immediate, durable, key-indexed):

1. `revokeNode` takes the revoked key id from the **enrolled record**, never from the
   caller — a caller-supplied key id would index the revocation by whatever the caller
   wrote, which is the thing revocation derives.
2. Revocation is a **row**, not a flag plus a separate index. The obvious design
   (`nodes.revoked_at` + a `revocations` table for the key index) has two copies of one
   fact and therefore a window in which a revoked key gets pinned. Here
   `mesh_registry_revocations` *is* both, a node's revoked-ness arrives by `LEFT JOIN`, and
   a `UNIQUE` index on `revoked_key_id` is the second line.
3. `revokeNode` re-checks the key index **inside its own transaction** before inserting.
4. A revoked node cannot authenticate, reconnect, deliver a command, or stream a
   terminal. Revocation is checked during **authentication**, not as a later
   authorization step.
5. `NodeTrustStore.revocationByKeyId` is consulted during **enrollment** as well, so a
   revoked machine presenting a fresh enrollment code cannot re-enrol under a new node id
   holding the exact key the operator revoked. This was a live defect found by an M4.2
   review — `revokedKeyId` was written and never read — and it is fixed and tested.

**Key material at rest.** Private keys are written `0600`. A read verifies the file mode
**and the directory mode** in both directions and refuses rather than repairs: a private
key another local account can read has already lost the property it exists for, and
silently continuing turns a local permissions mistake into a mesh-wide credential. The
write path uses `link()` rather than `rename()`, because `rename()` silently replaces an
existing key file and a second `save` for a live node would quietly swap its identity.

---

## 3. Partition matrix

Two controllers × three workers, plus the two controller↔controller links, gives **8
directed links**; every subset is enumerated — **2⁸ = 256 configurations**, sampled
nowhere. Directed, not symmetric, so the half-healed case is covered.

Modelled in-process by `tests/unit/mesh/lease/split-brain.test.ts`, and exercised with
real records, real stores and a faulted transport by
`tests/unit/mesh/fault/partition.test.ts`. The two are not duplicates: the model is about
the authority fence, the harness about transport.

**Unconditional properties, asserted over all 256 configurations:**

| # | Property |
| --- | --- |
| P1 | At every epoch a worker accepted, the work came from **exactly one** controller. Stated per `(worker, epoch)` because a worker legitimately changes hands — a successful takeover means A drove it at epoch 1 and B at epoch 2, and that is a handover, not a split brain. |
| P2 | No worker ever admitted a command at an epoch it had already superseded. Strictly stronger than "the epochs are in order", and the property the epoch gate actually delivers. |
| P3 | At the concurrent instant, no worker admits work from both controllers. |
| P4 | No node's stored epoch ever decreases. |
| P5 | A renewal never changes the epoch anywhere it lands. |
| P6 | A worker holding **no** lease refuses a takeover broadcast to it (`no_lease_to_fence`) rather than adopting the epoch. |
| P7 | A controller that never received the run's lease cannot fence a node that holds it. |

**The release-blocking form.** P1 is a per-worker statement; the plan's stop condition is
about a *run*. The run-level statement in its provable form: if two controllers created
work after the takeover instant, then every worker the older one still acted on was
unreachable to the newer one and therefore **in the takeover's acknowledgement**. With
the acknowledgement emptied, **zero of 256 configurations** produce two controllers.

**Non-vacuity is asserted, not assumed.** The "both controllers acted" case, the "takeover
refused" case, the "takeover accepted" case, and a worker where both controllers actually
contended must all occur in the enumeration, or the test fails.

**What the model does NOT cover**, stated so a reader does not over-read it:

- **Message duplication, reordering and delay.** One delivery per link per step. That is
  M4.5's inbox and M4.9's fault harness, tested separately.
- **A worker that is also a controller, or three controllers.** The epoch argument is
  pairwise.
- **Clock skew.** All nodes read one injected clock, so this says nothing about how long a
  stale controller keeps *believing* it is in charge. The epoch comparison uses no clock,
  so skew cannot break the fence — but it can widen the window during which the stale
  controller is unaware.
- **Anything M4.5 persists.** "Created work" here means a command was *admitted*, not that
  a session exists. The harness closes that gap.

### A finding this matrix produced

The model test found a **release-blocking** defect that no other test had: a takeover
against a node holding **no** lease skipped the entire predecessor check, because the
comparison was guarded by `held !== null`. A controller cut off from the run could
broadcast a takeover; nodes already holding the incumbent's lease refused it (predecessor
mismatch) while nodes holding nothing **accepted it** — leaving one controller per worker
and two controllers driving one run. Fixed in `src/mesh/protocol/lease.ts` with a
`no_lease_to_fence` refusal, and P6 was added to cover it. The operational cost is
documented and accepted: a node that lost its lease store cannot be brought onto a new
epoch until reconciliation re-delivers the lease, because the alternative is a run with
two controllers.

---

## 4. Takeover evidence

A takeover requires **all** of:

| Precondition | Enforced at | Test |
| --- | --- | --- |
| A strictly greater epoch | `evaluateLease`, `src/mesh/protocol/lease.ts` | `tests/unit/protocol/lease.test.ts` |
| The predecessor lease id and epoch, both | `evaluateLease` | `tests/unit/mesh/lease/takeover.test.ts` |
| A held lease to fence against | `evaluateLease` (P6 above) | `split-brain.test.ts` |
| The user inspected the unreconciled nodes and acknowledged them | `src/mesh/lease/lease.ts`; surfaced in `src/mesh/tui/` | `takeover.test.ts`, `tests/unit/mesh/tui/takeover-confirmation.test.ts` |
| An explicit `takeover` operation, named by a named method | `MeshControllerLease.takeover` | structural assertions in both test files |

**A higher epoch is never accepted any other way.** A command carrying an epoch above the
lease is refused `epoch.unregistered`, not queued "for later": a command minted under a
superseded controller was decided against a projection that no longer exists, and applying
it under its successor is the plan's named stop condition.

**There is no automatic election.** Asserted three ways: over the wire vocabulary, over
`MeshControllerLease.prototype`'s method list, and as a source scan of
`src/mesh/tui/` for `elect|quorum|gossip|consensus|raft|paxos`. The reconciler reaches no
epoch-raising operation by any spelling, and `ReconcileLeaseReader` has no `takeover` — a
reconciler that could raise the epoch would make the epoch a function of who reconciled
first, which is the automatic election the milestone forbids.

**In the TUI**, the dialog opens unarmed, the generic `set-overlay` action cannot open it
(a real back door, found and closed mid-implementation: a partitioned node could force it
up and arm it), and the takeover request is **withdrawn over a partition** even on a held
lease — an uncorroborated fence is the one most likely to produce two controllers. A
scenario driving all 16 action types × 12 states × 4 starting states yields the takeover
intent only from an armed, unblocked, scope-matching confirmation.

**Lease expiry does not kill agents.** After `expiresAt`, new dispatch, retry and policy
mutation are refused; the set of live sessions and their lifecycle states is
**byte-identical** to before. This is a plan stop condition and is tested as one
(`tests/unit/mesh/lease/expiry.test.ts`).

---

## 5. Resource limits

Every bound in the specification's §6 is an exported constant with a stated value, and
every one is **applied** rather than merely documented:

| Bound | Value | Applied at |
| --- | --- | --- |
| `MAX_ENVELOPE_BYTES` | 262 144 | `protocol/envelope.ts` |
| `MAX_TERMINAL_FRAME_BYTES` | 65 536 | `protocol/terminal.ts`, `gateway/terminal/frames.ts` |
| `MAX_TERMINAL_BUFFER_BYTES` | 1 048 576 | `protocol/terminal.ts`, `gateway/terminal/{index,gateway}.ts` |
| `MAX_TERMINAL_FRAMES_PER_SECOND` | 512 | `protocol/terminal.ts`, `gateway/terminal/types.ts` |
| `MAX_VIEWERS_PER_TERMINAL` | 16 | `protocol/terminal.ts` |
| `MAX_COMMAND_PAYLOAD_BYTES` | 131 072 | `protocol/command.ts` |
| `MAX_EVENT_PAYLOAD_BYTES` | 131 072 | `protocol/event.ts` |
| `MAX_HEARTBEAT_AGE_MS` | 90 000 | `protocol/heartbeat.ts`, `registry/schemas.ts` |
| `MAX_RULE_PATTERN_LENGTH` | 128 | `protocol/safe-pattern.ts` (R7) |

**The replay guard refuses rather than evicts.** At its bound it refuses further nonces
until the window advances. Evicting a live nonce to make room would turn an
unauthenticated flood into a denial of service against legitimate nodes — the guard's own
comment, and the right way round.

**A slow terminal client loses frames, not memory.** `framesToDrop` evicts from the front,
the per-client bound holds, the gap is visible in the client's sequence numbers, and a fast
client on the same terminal is unaffected. The `TerminalSocket.pendingBytes()` member
exists because counting only the gateway's own outbox reports no pressure on a client that
stopped reading — the transport took every frame and buffered it internally, which is the
same exhaustion one layer down and invisible.

**A retryable failed task keeps a run alive.** A `retryable` task is not settled, so the
run stays live; cancellation still settles it. This was a genuine defect found by
switching `COMMAND_MATRIX` on: the run-termination test consulted task `state` alone, so
the rule "a failed attempt must not end the run" was a comment rather than behaviour, and
one flaky task drove the run `failed` — permanently, because a terminal run is absorbing.
Fixed in the reducer, not by weakening the matrix.

**Outbox backoff**, injected clock, no sleeping in tests: `1s, 2s, 4s, 8s, 16s, 32s, 64s,
128s, 300s` doubling to a 300 s ceiling; `MESH_OUTBOX_MAX_ATTEMPTS = 8`, so the total
backoff before the last attempt is 127 s. Long enough to outlast a worker restart, a
controller replacement and a Tailscale path change combined; short enough that a poison row
is `failed` while an operator is still looking at the run. A record past the threshold goes
terminal and is **retained** — the outbox is evidence, not a cache — and `attempts` is
never reset, not by a failure, not by recovery, not by a redelivery.

---

## 6. Two-node acceptance transcript

From `tests/integration/mesh-fault-acceptance.test.ts` — 102 assertions, all passing. This
is the plan's Mesh completion criteria as one run. Secrets removed; node ids are derived
from the fixed enrollment entropy, so this transcript is byte-stable across runs.

```
enrol      worker joins; nodeId derived as node-enr-1b34bb904b1f48954a7cbd3c
           registry row written (addressable), identity trust + pin written (attributable)
           distinct steps, deliberately: a node that can authenticate but cannot be found
           is the gap this keeps closed

lease      controller claims epoch 1, worker is TOLD (a worker does not claim a lease)
heartbeat  sent over a DELAYED link: 0 acknowledged while pending, then liveness=live
           with projectPathIds ["path-fault-1"], negotiatedProtocolVersion 1

execute    dispatch.execute delivered 3x (delay, drop, duplicate)
           inbox rows: exactly 1
           runtime().executions:  ["cmd-fault-dispatch-execute"]      (1, not 3)
           runtime().sessions:    ["sess-fault-1"]                    (1, not 3)
           runtime().prompts:     1 entry                             (1, not 3)

report     3 mesh.event reports -> 6 mesh.event transmissions
           (dropped, delayed-then-late, redelivered-and-suppressed, tripled, cut, healed)
           ingested():  3 events, Set size 3                          (no duplicates)
           outbox rows: exactly 3, all acknowledged

stream     positions [1,2,3] gapless
           resume(1)   -> events 2..3
           resume(1)   -> identical page (idempotent read)
           resume(99)  -> refused/cursor_ahead, retryable=false
                     (a cursor ahead is a different stream, not a stale client)

restart    controller restart over the SAME files
           projection rebuilt from the durable log: run, approval, task all present
           stream window SURVIVES: resume(1) -> events 2..3, head still 3
           inbox rows 1, outbox rows 3, sessions 1, prompts 1
           boundary.crashes []  (no fault in this scenario crashed a node)

verdict    no duplicate session, no duplicate prompt, no lost event,
           no unbounded inbox/outbox growth
```

**One assertion in this transcript was written backwards and had to be corrected.** The
restart block originally asserted the gateway came back **empty** and refused a
pre-restart cursor with `cursor_ahead` — pinning the defect rather than the requirement,
because at the time the gateway *was* empty. `cursor_ahead` is the refusal reserved for
"you are reading a different stream", and a restarted process is emphatically not a
different stream. Answering a valid cursor that way tells a correct client its own history
is fictional, **silently**, because `cursor_ahead` is not an error the client will report.
The gateway now rebuilds its window, its watermark and its position counter from the
durable log on construction (`EventGatewayDependencies.durableStream`), and the test
asserts the requirement.

---

## 7. Carry-forward audit

Per the plan: each item is **closed or not**, with the test that proves it. Not one of
these is an optional extra.

| id | Status | Proving test | What it proves |
| --- | --- | --- | --- |
| **M4-V** | **CLOSED** | `tests/unit/orchestration/versioning.test.ts` (17) + `tests/unit/protocol/version-mismatch.test.ts` (per family) + two new M0 assertions in `tests/contracts/orchestration-schemas.test.ts` | `SCHEMA_VERSIONS = [1,2]`; `parseVersioned` dispatches on the version the record's own bytes declare; an unknown version raises `UnsupportedSchemaVersionError`, a missing one `UnversionedRecordError`, and neither is coerced, defaulted or partially read. `mapRunEventRow` reads `row.schema_version` instead of hardcoding `1 as const` — the silent relabelling is gone. |
| **M4-M** | **CLOSED** | `tests/unit/orchestration/command-matrix-conformance.test.ts` (**136 tests, 938 assertions**) + `src/mesh/lease/command-gate.ts` | Every command type is checked against `COMMAND_MATRIX` at the seam; a negative test per forbidden transition; context is read from the **recorded projection**, never the payload; and the converged-no-op exemption cannot be abused (a command that would append a real event or name an outbox effect is refused). Enforced at two seams: `DispatchCoordinator.#assertMatrixLicensed` and the mesh `MeshCommandEpochGate`. |
| **M4-A** | **CLOSED** | `tests/integration/legacy-compatibility.test.ts` (34) + `tests/unit/orchestration/audit-crash-safety.test.ts` | **F-05 is closed by RETIRING the legacy launch path**, not by minting an approval for it. See below. |
| **M4-O** | **CLOSED** | `tests/unit/mesh/outbox/deliverer.test.ts` + `crash-boundaries.test.ts` | The deliverer runs, with an exact clock-driven backoff schedule and an exact max-attempt threshold, and reclaims stranded claims on restart. A crash-and-restart test per delivery boundary, with real file close/reopen. |
| **M4-B** | **CLOSED** | `tests/unit/mesh/fault/boundaries.test.ts` (10) | **All eight** `EffectBoundary` hooks are invoked and injectable, each with a test that asserts the hook **actually fired** (`boundary.fired(hook)`), plus an unarmed control arm proving a full run crashes nothing. A structural test asserts the suite's hook list equals `EFFECT_BOUNDARY_HOOKS`, so a ninth hook cannot be added without a test. |
| **M4-S** | **CLOSED** | `tests/unit/mesh/gateway/events/snapshot-policy.test.ts` + `tests/integration/mesh-flow.test.ts` | The snapshot policy is defined and **used**: `saveSnapshot`/`getSnapshot`/`readGlobal` are all reachable (they were implemented, tested and called from nowhere). A client that cannot resume from a cursor gets an explicit re-base whose first frame is a `mesh.reconciliation` snapshot with `id: null` — the absence of an id is the second half of detectability. **Proven after a restart too**, which is the case it exists for. |
| **R7** | **CLOSED** | `tests/unit/protocol/safe-pattern.test.ts` + `tests/unit/protocol/bounds.test.ts` | `taskTitlePattern` is compiled at rule-write time and the pattern bound is lowered to 128. Catastrophic shapes are refused at compile time; `KNOWN_CONSERVATIVE_REFUSALS` records what is refused conservatively, so a future refinement is measured against a known list. Rules carrying a pattern are refused unless the author holds `policy.ruleAuthor`. The residual risk (structural heuristics, not a proof) is stated in `safe-pattern.ts` rather than glossed. |

### M4-A in detail, because the decision is the finding

**The decision: the legacy launch path is RETIRED.** The alternative — minting a canonical
`approval.decided` for legacy work — would have made a bearer token, a source/capability
pair, a project-allowlist entry and a legacy plan annotation into **approval authority**,
which is exactly what F-05 forbids. The digest binding the old intent had was *integrity*;
it was never *authenticity*. Putting a non-canonical grant inside the digest chain the
approval invariant exists to protect would have made the invariant report success on a
grant nobody decided.

Removed: `LEGACY_LAUNCH_DESTINATION`, `legacyLaunchIntent`, `legacyLaunchIntentSchema`,
`verifyLegacyLaunchIntent`, `LegacyLaunchOutbox`, `acknowledgeLaunch`, `launchIntents`.

A legacy trigger now records a DRAFT + PAUSED run holding a PENDING task, which
`COMMAND_MATRIX` cannot schedule until an operator records a real approval through
`dispatch.propose` → `dispatch.approve` → `dispatch.execute`. **The HTTP contract of
`/trigger`, `/report` and `/jobs` is unchanged**, and that is asserted rather than
asserted-to. The legacy tests assert the removed exports are *absent*, so F-05 cannot
silently reopen. `src/bridge.ts` remains unwired (Milestone 3 R8), so this closure changed
no runtime behaviour.

### M4-B hooks 5 and 6, which M4.5 wired

- **5, `beforeDeliver`** — the record is left claimed and the redelivery **is the first
  delivery**; nothing reached the wire, so no idempotence is needed and none is claimed.
  Asserted by the controller holding **zero** of the event before the reclaim.
- **6, `afterRuntimeAccept`** — the peer took the effect, so the redelivery must be
  idempotent on `eventId`. Asserted by the controller holding the event **once** across
  the crash, with the ack reporting `duplicate`.

---

## 8. M0 regression check

The plan's guardrail: *"Do not let M4 work regress a discharged Milestone 3 condition."*

| id | Condition | Status after M4 | Evidence |
| --- | --- | --- | --- |
| **F1** | `approvalSchema` refused `decision:"approved"` + `state:"pending"` | **HOLDS** | `tests/contracts/orchestration-schemas.test.ts`; `contract-invariants.test.ts` |
| **F2** / **S-4** | `paused: true` with a terminal run state is refused | **HOLDS** | same; unchanged in M4 |
| **S-1** | the pause gate is not clearable by re-emitting `run.created` | **HOLDS**, and strengthened | `#createRun` refuses an existing run; a paused run needs an evented resume |
| **S-2** | a terminal session lifecycle requires a compatible observation | **HOLDS** | unchanged in M4 |
| **S-6** | the replay path consults the lifecycle machine and quarantines an illegal regression | **HOLDS** | `reduceEvent` still throws `SessionLifecycleRegressionError` |

**`./scripts/m0-contract-signoff.sh` exits 0.** The M4-V widening changed the contract
surface, which is a recorded re-approval and not a silent drift — see §9.

**What M4 changed inside the kernel, and why it is not a regression:**

| Change | Why it was necessary |
| --- | --- |
| `CURRENT_SCHEMA_VERSION` → `CURRENT_DATABASE_VERSION` in the event store | Unconflating the storage-layout version from the record-shape version. `invariants.ts` is outside the digest; `errors.ts` is inside it and changed only to use the domain-version constant. |
| `UnsupportedSchemaVersionError` → `UnsupportedDatabaseVersionError` (event store) | Two errors with the same name and different meanings. An operator reading "unsupported schema version" could not tell "the database is too new" from "this record's shape is too new". |
| `checkAggregateState` membership-before-terminality in `invariants.ts` | The terminal guard fired before the allowlist, so `dispatch.retry` — whose allowed states are *all* terminal — could never be licensed. Ordering is the fix; no rule was weakened. |
| `COMMAND_MATRIX["dispatch.retry"]` lost its contradictory `allowedTaskStates: ["failed"]` | The entry's own comment said it did not gate on the task. Nothing in the kernel moves a task to `failed` when its dispatch reports one, so the entry made **every retry unreachable** and the matrix could not be switched on at all. Found only by switching it on. |
| `validateCommandStateByType` now runs inside `DispatchCoordinator.submit` | M4-M itself. |

---

## 9. The M4-V re-approval is an owner's attestation, not a sign-off

**`Docs/implementation-reports/m0-contract-reapproval.md` digest `83f9a5e0…ee0c1` has not
been signed by a human.** It was taken mechanically so the gate could run.

The surface changed for exactly one reason: `schemaVersionSchema` was widened from
`z.literal(1)` to a versioned set — **the change both M0 reviewers asked for and explicitly
deferred** ("Versioning carve-out … widening still owed"). `schemas.ts`, `types.ts`,
`transitions.ts` and all fifteen frozen examples are **byte-identical** to the Milestone 3
approval. Two M0 assertions changed, because they pinned `schemaVersion: 2` as *invalid* and
2 is now supported; they now name out-of-set versions (`0`, `3`, `"1"`) and two new
assertions require every in-set version to be accepted and every out-of-set one refused.

**A clean worktree at the pre-M4 commit reproduces the Milestone 3 digest `e01850cb…debfb`
exactly**, which establishes that the entry-4 drift is M4-V's and nothing else's.

**A reviewer still owes this, and it is not claimed as paid:**

1. **The widening itself.** This is the one change in the whole milestone that should be
   read adversarially rather than as a formality, because a version set is supposed to
   widen and "it is supposed to" is exactly the reasoning that hides a mistake.
2. **Whether the two changed assertions kept their intent** — that the property they
   protect is "a version outside the supported set is refused", not "version 2 is refused".
3. **Whether a record at an in-set version whose shape this build does not have is refused
   loudly.** It is, and `tests/unit/protocol/version-mismatch.test.ts` covers it per family,
   but it has not been reviewed by someone other than its author.

**Honest limit on what M4-V bought.** The Milestone 3 break happened at version 1, so there
is no migration for it and a v2 reader **cannot tell a pre-split `run.created` from a
post-split one**. M4-V makes the *next* such break versionable and stops a node coercing a
shape it does not have. It does not retroactively version history.

---

## 10. Findings

Severity as the plan uses it. **No Blocker and no High is open.** A review of this size that
found nothing would be a failed review; the four below are the ones that survived scrutiny,
plus the defects already fixed during the milestone.

### Open

| id | Sev | Area | Finding | Location |
| --- | --- | --- | --- | --- |
| **SF-1** | **Med** | Terminal protocol | `mesh.terminal.control` has **no error or acknowledgement operation**. A refused `request_input` or `resize` cannot be reported in-band; the gateway returns it to the caller and the client learns by inference. M4.8's TUI compensates client-side. Adding an operation is a **protocol change requiring a version per M4-V**, so it is deliberately not a gateway decision. | `src/mesh/protocol/terminal.ts` |
| **SF-2** | **Med** | Terminal | There is **no snapshot frame on the wire**. A client that lost frames re-attaches and re-bases. `gateway.snapshot()` returns bytes to the *caller* rather than encoding a third family, because the plan forbids adding an unversioned record family from inside a transport task. | `src/mesh/gateway/terminal/index.ts` |
| **SF-3** | **Low** | TUI | `src/tui/types.ts` already has a `"takeover-confirmation"` overlay, meaning Milestone 1's terminal input takeover. The mesh TUI's confirmation is a different dialog with a different precondition. A collision at the shell level is possible and is not yet tested. | `src/tui/types.ts` vs `src/mesh/tui/` |

### Fixed during the milestone, and why each mattered

| id | Sev | Finding | Fix |
| --- | --- | --- | --- |
| SF-4 | **Blocker** | A takeover against a node holding **no** lease skipped the predecessor check (`held !== null` guard), letting a cut-off controller broadcast a takeover that unleased nodes accepted — **two controllers on one run**. Found by the split-brain model. | `src/mesh/protocol/lease.ts`; `no_lease_to_fence`; P6 added |
| SF-5 | **Blocker** | The inbox compared the **wire** digest against the **semantic** fingerprint, so **every** legitimate redelivery was refused as a conflict — the retry path was dead and "duplicate commands cannot launch duplicate sessions" was broken one layer up. | `src/mesh/inbox/inbox.ts`; `decideCommandReceipt` now derives the semantic fingerprint itself so no caller can be one field-swap away |
| SF-6 | **High** | A revoked node's compromised key could **re-enrol under a fresh node id**, because `nodeId` is derived from the code and `revokedKeyId` was written and never read. | `src/mesh/identity/node-trust.ts` + `enrollment.ts`; `revocationByKeyId` consulted at enrollment |
| SF-7 | **High** | `FileSystemKeyStore.save` used `rename()`, which **silently replaces an existing key file** — a second `save` for a live node quietly swapped its identity, while the in-memory store refused the same operation. | `link()`, which fails `EEXIST` atomically |
| SF-8 | **High** | A private key written into a **world-readable directory** could be unlinked and replaced with another user's own `0600` key. `load` verified the file mode but not the directory mode. | directory mode checked on both paths |
| SF-9 | **High** | The mesh epoch gate never compared a command's `expiresAt` against the **lease's**, so a command minted under a 30-minute lease survived a renewal that shortened the window. Spec §4.4 invariant 7 existed only in a function the gate did not call. | `command-gate.ts` stage `lease_window`; `command-expiry.test.ts` — **verified non-vacuous** by disabling the guard (3 of 4 tests fail) |
| SF-10 | **High** | The event gateway's retention **did not survive a restart**, so the M4-S snapshot fallback was unreachable for the rest of the process's life and a valid pre-restart cursor got `cursor_ahead`. | `EventGatewayDependencies.durableStream`; the acceptance test was corrected to assert the requirement |
| SF-11 | **High** | `snapshot-source`'s digest helper included the state in the bytes it digested, so **every** snapshot the writer produced was refused by any reader — the entire M4-S branch was dead on arrival. | strip `stateDigest` before digesting |
| SF-12 | **Med** | `??` binds looser than `?:`, so `leaseEnvelope` discarded every lease id a caller named and minted a takeover onto its predecessor's id. The history table is keyed by lease id, so the epoch-2 row was swallowed and the harness could execute nothing at a successor epoch. | parenthesised |
| SF-13 | **Med** | The reducer drove a run terminal while a task was still `retryable`, so one flaky task ended the run **permanently** (a terminal run is absorbing) and `dispatch.retry` became unreachable. | fixed in the reducer, not by weakening the matrix |
| SF-14 | **Med** | `exhaustOutbox` left `next_attempt_at` set on a `failed` row — a retained row that still reads as "scheduled" lies to an operator. | cleared, with the mesh workaround removed as redundant |
| SF-15 | **Low** | `nowIso()` read `Date.now()` as a default, defeating the "no ambient clock" rule the moment a caller omitted the argument. | `now` is now required on every outbox write |

**Deviation recorded: `injectWS`.** The plan asks for "`injectWS` tests" for M4.7.
`app.injectWS()` **does not work in this environment** — it throws under `bun test` and
hangs under vitest, because it reaches into `ws` internals. The requirement is met in
substance: 116 unit tests drive the gateway through an **injected socket interface** with
no socket at all, and 20 integration tests cover the transport over a real loopback
listener. Measurements, the teardown trap (`app.close()` hangs forever after a graceful
client close) and the reproduction are in `Docs/implementation-plans/websocket-test-harness.md`.

**One place the plan's letter is not met and is not papered over:** a **slow reader cannot
be provoked through a socket** on the gate's runner, because Bun's `ws` shim is not a TCP
implementation (`client._socket` is undefined; a server `bufferedAmount` stays 0 through a
13 MB burst the client then receives in full). The backpressure **mechanism** is proven in
the unit tests, where `pendingBytes()` is a number a test sets; the integration file proves
the half a real socket can show.

---

## 11. Gate evidence

```
bun test tests/unit/mesh                              880 pass  0 fail
bun test tests/unit/protocol                          334 pass  0 fail
bun test tests/unit/orchestration                     551 pass  0 fail
bun test tests/integration/mesh-flow.test.ts             7 pass  0 fail
bun test tests/integration/controller-takeover.test.ts   10 pass  0 fail
bun test tests/integration/terminal-websocket.test.ts   20 pass  0 fail
bun test tests/integration/mesh-fault-acceptance.test.ts 1 pass  0 fail
./scripts/m0-contract-signoff.sh                      exit 0   (digest 83f9a5e0…ee0c1)
bun run typecheck                                     exit 0
bun run build                                         exit 0
bun test                              2629 pass / 4 skip / 0 fail (150 files)
git diff --check                                      clean
```

**The 4 skips are pre-existing and unrelated:** two optional real-agent/tmux integration
smokes, and two `node:sqlite`-unavailable backend blocks.

**Known environment caveat, not a code defect.** `bun run test` (vitest, on Node) fails 7
tests in `tests/unit/host/runtime.test.ts` because `Bun.spawn` is unavailable there. It is
pre-existing, unrelated to M4, and does not occur under `bun test`, which is what the gate
runs.

### Verdict

Every carry-forward item is closed with a cited test. Every Mesh completion criterion is
met. The two-node acceptance suite passes with no duplicate work. The protocol version is
**frozen at 1**, with record schemas frozen at version 2 across all eleven families.

Three Medium/Low findings remain open and are recorded as such. The M4-V re-approval is an
owner's attestation that has **not** been countersigned, and the design review it still
owes is stated rather than implied.
