# Milestone 4: Distributed Tailscale Mesh

## Objective

Extend the orchestration kernel across trusted Tailscale-connected nodes with revocable node identity, capability heartbeats, controller leases, idempotent command delivery, durable worker outboxes, authenticated event/terminal streams, reconnect reconciliation, and manual controller takeover.

## Prerequisites

- Milestone 3 passes replay and crash-boundary tests.
- Local runtime dispatch is idempotent by stable dispatch/command ID.
- Current Tailscale-only binding and project allowlist protections remain enforced.
- The threat model has assigned mitigations for identity, replay, stale controller, terminal takeover, and resource exhaustion.
- The Milestone 3 carry-forward items below are read and owned. M4.0 exists because three of them block M4.1.

## Milestone 3 Carry-Forward

Milestone 3 closed with two gate conditions and several deferred items still open. They are **owed to this milestone**, not merely noted by it. Sources: `Docs/implementation-reports/milestone-3-completion.md` §1 and §8, and `Docs/implementation-reports/m0-contract-reapproval.md`.

### Blocking — must land before M4.1 defines a wire shape

| id | Item | Why it blocks M4 | Owner |
| --- | --- | --- | --- |
| **M4-V** | Widen `schemaVersionSchema` from `z.literal(1)` to a versioned enum. | Milestone 3 changed the **event payload shape** (run gained `paused`, task gained `failurePolicy`, session replaced `state` with `lifecycleState` + `observedState`) while the version stayed `1`, so that break was unversionable. M4.1 introduces a whole family of new wire records (enrollment, heartbeat, command, ack, event, lease, reconciliation, terminal-stream). If the version is still a literal, **every M4 protocol shape is born unversionable**, and the M4.1 requirement to handle "version mismatch" has nothing to mismatch on. | M4.0 |
| **M4-M** | Wire `COMMAND_MATRIX` into the command seam. | The matrix is exhaustive and a new command type is already a compile error until an entry is stated, but nothing *reads* it in production. M4.4 makes controller epochs gate dispatch, retry, and policy mutation; that gate must be the matrix, not a parallel hand-maintained set of checks. Add `allowedDispatchStates: ["proposed", "approved"]` for `dispatch.approve`, which currently cannot re-approve a revised envelope under the lifecycle-only vocabulary. | M4.0 |
| **M4-A** | Close **F-05** (asserted legacy identity/approval). | `legacy.runtime.launch` still reaches a runtime with no canonical approval; the intent is digest-bound and tamper-checked, which is *integrity*, but compatibility evidence must never become approval authority. The decision owed since M3.8: either give legacy work a canonical approval, or retire the legacy launch path. This is a **High** carried-forward threat-model finding, so it must not wait for M4.10 to raise it. | M4.0 |

### Deferred — land in their natural homes

| id | Item | Lands in | Note |
| --- | --- | --- | --- |
| **M4-O** | Outbox deliverer. | M4.5 | `claimPendingOutbox` / `markOutboxAcknowledged` / `markOutboxFailed` / `recoverStaleOutbox` exist as storage primitives. Nothing pumps them, and the retry/backoff *policy* and max-attempt threshold do not exist. The clock is already injected, so the policy stays deterministic. |
| **M4-B** | `EffectBoundary` hooks 5–8. | M4.5, M4.6 | Declared and typed but never invoked: before-deliver, after-runtime-accept, during-projection, during-translation. M4.5's deliverer and M4.6's projection updater are what make them meaningful. M4.9's fault harness should exercise all eight. |
| **M4-S** | Snapshot policy. | M4.6 | `saveSnapshot` / `getSnapshot` / `readGlobal` are implemented, tested, and called from nowhere. M4.6 already requires a snapshot fallback for SSE resume, so the policy is in scope there. |

### Known limitations carried forward

These are not defects to fix but facts M4 must not contradict. Full text in the M3 report §8.

- **R3** A same-`dispatchId` revision replaces the envelope, so the superseded envelope is not rebuildable (its digest, outcome and decision survive). M4.6's snapshot fallback must therefore not promise per-attempt envelope history.
- **R4** `launchAdmission` can never be `unknown`/`failed`, because no event records a launch-command outcome. M4.1 should either add that event type or state explicitly that an ambiguous launch is unrepresentable in projections.
- **R5** Cross-agent dependencies have no canonical equivalent and are preserved as compatibility references. M4.3's capability model must not imply they have become canonical scheduling edges.
- **R6** `taskSchema.failurePolicy` and per-task retry eligibility are projection facts. Nothing else may infer them.
- **R7** `ruleMatchSchema.taskTitlePattern` is matched as a regex with only a 256-character bound; a catastrophic-backtracking pattern from an untrusted rule author is a possible ReDoS vector. It fails closed today. **M4.1 should decide a bound or timeout** before rules can be authored remotely.
- **R8** `bridge.ts` is intentionally unwired, so the kernel is absent at runtime. Turning it on is a deployment decision, and M4.0's M4-A decision interacts with it.

### Carry-forward audit

M4.10 must re-audit these in addition to the M4 protocol surface, and must confirm the M3 kernel conditions recorded in `m0-contract-reapproval.md` were not regressed by M4 work.

## Fixed Protocol Choices

- Keep Fastify for HTTP APIs.
- Use SSE for ordered orchestration events and `@fastify/websocket` for terminal streaming. WebSocket authentication runs in Fastify request hooks before upgrade; message validation and output transformation remain handler responsibilities after upgrade ([Fastify WebSocket documentation](https://github.com/fastify/fastify-websocket)).
- Use application-level node identity and revocation in addition to Tailscale reachability. Initial enrollment exchanges a one-time code over an already authenticated local/admin flow and pins a generated node key.
- Use user-initiated, run-scoped controller takeover; do not implement automatic election.

## Agent Plan

| Task | Dependency | Sub-agent and model | Deliverable | Verification |
| --- | --- | --- | --- | --- |
| M4.0 Milestone 3 carry-forward closure | M3 | `architect` — `gpt-6-astra xhigh` | **M4-V** versioned `schemaVersionSchema`; **M4-M** `COMMAND_MATRIX` enforced at the command seam; **M4-A** F-05 decided and closed (canonical approval for legacy work, or the legacy launch path retired) | M4-V: a shape change is versionable and a wrong version fails loudly; M4-M: every command type is checked against the matrix and a forged/unlicensed command is refused; M4-A: no path reaches a runtime without a canonical, recorded, digest-bound approval |
| M4.1 Wire protocol and failure semantics | M4.0 | `architect` — `gpt-6-astra xhigh` | Versioned enrollment, heartbeat, command, ack, event, lease, reconciliation, and terminal-stream protocols | Sequence diagrams cover retries, partitions, restart, stale epoch, and version mismatch |
| M4.2 Node identity and enrollment | M4.1 | `subsystem-builder` — `gpt-5.6-sol high` | Key generation/storage, one-time enrollment, peer pinning, revocation, and identity middleware | Forgery, replay, expiry, revocation, and permission tests |
| M4.3 Node registry and capabilities | M4.1–M4.2 | `feature-builder` — `gpt-5.6-terra high` | Health/runtime/project capability heartbeat with TTL and stale state | Clock-controlled expiration and reconnect tests |
| M4.4 Controller lease and epoch enforcement | M4.1–M4.2 | `subsystem-builder` — `gpt-5.6-sol high` | Claim, renew, expire, pause, higher-epoch takeover, worker rejection | Partition and stale-controller model tests |
| M4.5 Durable command inbox/event outbox | M4.1, M4.4 | `subsystem-builder` — `gpt-5.6-sol high` | Worker persistence, dedupe, ordered ack, retry/backoff, poison handling, **plus M4-O** the outbox deliverer and its backoff/max-attempt policy | Crash at every persistence/delivery boundary; **M4-B** boundary hooks 5 and 6 are invoked and injectable |
| M4.6 SSE event gateway and reconciliation | M4.3–M4.5 | `feature-builder` — `gpt-5.6-terra high` | Cursor-based event streaming, resume, bounded retention, snapshot fallback, **plus M4-S** the snapshot policy using the already-implemented `saveSnapshot`/`getSnapshot`/`readGlobal` | Disconnect/gap/out-of-order/version tests; **M4-B** boundary hook 7 is invoked; snapshot fallback is proven, not merely present |
| M4.7 Terminal WebSocket gateway | M4.2, M4.4 | `subsystem-builder` — `gpt-5.6-sol high` | Authenticated attach, binary frames, resize, ownership, takeover, limits, cleanup | `injectWS` tests plus two-node terminal smoke test |
| M4.8 TUI mesh and takeover UX | M4.3–M4.7 | `feature-builder` — `gpt-5.6-terra high` | Node health, remote sessions, degraded state, reconciliation, takeover confirmation | Reducer scenarios for every lease/network state |
| M4.9 Two-node fault harness | M4.4–M4.8 | `test-engineer` — `gpt-5.6-sol high` | Deterministic proxy/fault injection for delay, drop, duplicate, reorder, partition, restart | Acceptance scenario succeeds without duplicate work |
| M4.10 Protocol/security audit | All | `security-reviewer` — `gpt-6-astra xhigh` | Identity, crypto use, replay, authorization, terminal, DoS, and logging review | All blocker/high findings closed; protocol version frozen |

## Protocol Requirements

### Commands

- Carry protocol version, command ID, project/run/dispatch IDs, target node, controller node, controller epoch, issued/expiry times, and payload digest.
- Are authenticated and authorized before persistence, **and authorized against `COMMAND_MATRIX`** so the matrix is the single source of allowed states rather than a parallel set of hand-maintained checks (M4-M).
- Are persisted before acknowledgement.
- Return the stored result when command ID repeats with identical digest.
- Are rejected as conflict when the same command ID has a different digest.
- **A command is authorized against the recorded log, never against its own payload.** A caller-supplied approval, dispatch or lease is a *pointer*; the grant is whatever the event log recorded. Milestone 3 closed two blockers of exactly this shape and M4 must not reintroduce it across the node boundary.

### Versioning

- Every wire and persisted record carries a **versioned** schema version, not a literal. Milestone 3's shape break was unversionable because `schemaVersionSchema` was `z.literal(1)`; M4-V fixes that before any M4 shape is defined, and M4.1 must not introduce a new record family without it.
- A record whose version is unknown or unsupported is **rejected loudly**. It is never coerced, defaulted, or partially read — a node must not guess at a shape it does not understand.
- The database version tracks the storage layout and does **not** cover event-payload compatibility; a payload shape change requires a record version bump, not a store migration.

### Worker Events

- Carry stable event ID, source node, command correlation, local sequence, observed time, and schema version.
- Enter a durable outbox before transmission.
- Remain until controller acknowledgement is persisted.
- May be resent; controller ingestion is idempotent.

### Controller Lease

- Is scoped to one run and one monotonically increasing epoch.
- Requires periodic renewal before expiry.
- Prevents new dispatch/retry/policy mutation after expiry.
- Does not kill existing agents on expiry.
- Takeover requires the user to inspect unreconciled nodes and explicitly accept degraded nodes or wait for them.

### Reconciliation

1. Authenticate node and compare protocol versions.
2. Exchange controller epoch and last acknowledged inbox/outbox positions.
3. Reject stale-controller traffic.
4. Resend unacknowledged commands/events idempotently.
5. Compare active session inventory against dispatch projections.
6. Mark unexplained differences for user review; do not silently adopt or terminate.

## Terminal Stream Guardrails

- Authenticate and authorize before WebSocket upgrade.
- Revalidate project/session access and controller epoch when granting input ownership.
- Separate control frames from terminal data and cap frame size/rate.
- Allow multiple viewers but one input owner.
- Require explicit takeover and notify the displaced client.
- Apply backpressure and bounded buffers; slow clients lose frames or reconnect from snapshots rather than exhausting memory.
- Never write terminal content into structured application logs.
- Close ownership on disconnect, revocation, lease expiry, or session termination.

## Completion Criteria

### Mesh

- At least two nodes can enroll, advertise capabilities, and execute a run over Tailscale.
- Node identity is individually revocable; a revoked node cannot reconnect or stream a terminal.
- Duplicate/reordered commands and events converge without duplicate sessions/prompts.
- Worker restart preserves inbox/outbox and active-session references.
- Lease expiry pauses new orchestration but preserves existing processes.
- Manual takeover uses a higher epoch and stale controllers are rejected.
- SSE resumes from a cursor or uses an explicit snapshot fallback.
- Remote terminal attach, resize, read-only viewing, input ownership, and takeover work under bounded resources.
- The two-node fault-injection acceptance suite passes.
- Security review approves identity, authorization, replay defense, and logging behavior.

### Milestone 3 carry-forward (from the Carry-Forward section)

These are **not** optional extras. Each maps to an owed item, and each must be evidenced in the gate report.

- **M4-V** — a persisted or wire record shape can be changed and version-bumped; a record carrying an unknown version is rejected loudly rather than coerced. Evidence: a version-mismatch test per record family.
- **M4-M** — every command type is checked against `COMMAND_MATRIX` at the seam, and a command attempting a state its matrix entry forbids is refused. Evidence: a matrix-conformance test that enumerates all command types, plus a negative test per forbidden transition. This criterion is what stops the matrix from becoming decorative again.
- **M4-A** — **F-05 is closed.** No path reaches a runtime without a canonical, recorded, digest-bound approval. If the chosen answer is to retire the legacy launch path, the legacy endpoints are proven to be unaffected. Evidence: the tamper tests carried forward from M3 plus an explicit statement of which option was taken and why.
- **M4-O** — the outbox deliverer runs, with a tested backoff and max-attempt policy, and reclaims stranded claims on restart. Evidence: a crash-and-restart test per delivery boundary.
- **M4-B** — all eight `EffectBoundary` hooks are invoked, and M4.9's fault harness exercises each of the plan's eight failure boundaries.
- **M4-S** — the snapshot policy is defined and used: a client that cannot resume from a cursor gets an explicit snapshot fallback rather than a silent gap.
- **R7** — a decision is recorded on the `taskTitlePattern` regex bound or timeout, so rules cannot be a remote ReDoS vector.

## Guardrails and Stop Conditions

- Tailscale reachability is not sufficient authentication.
- Do not reuse the current shared bearer token as permanent per-node identity.
- Do not implement auto-election, quorum, gossip, or consensus.
- Do not accept a higher controller epoch without the explicit takeover flow.
- Do not terminate agents because a controller or network disappeared.
- Do not retry remote launch until worker-side command persistence and dedupe are proven.
- **Do not authorize a remote command against its own payload.** Authorization resolves against durable recorded state; a payload is a claim, not a grant.
- **Do not add a wire record family without a version.** A literal `schemaVersion` is how Milestone 3's shape break became unversionable, and repeating it across eight protocol families would be unrecoverable.
- **Do not let M4 work regress a discharged Milestone 3 condition.** The invariants in `Docs/implementation-reports/m0-contract-reapproval.md` (F1, F2, S1, S2, S6) are kernel-wide; M4.10 re-audits them.
- **Do not leave F-05 open past M4.0.** It is a High carried-forward finding, and the decision to give legacy work a canonical approval or retire the legacy launch path is a prerequisite for M4.1, not a follow-up.
- Stop if terminal output can enter logs, events, or another project stream.
- Stop release if any partition test permits two controllers to create new work for the same run.

## Gate Verification

```bash
bun test tests/unit/mesh
bun test tests/unit/protocol
bun test tests/unit/orchestration          # M4-M matrix conformance, M4-A authorization
bun test tests/integration/mesh-flow.test.ts
bun test tests/integration/controller-takeover.test.ts
bun test tests/integration/terminal-websocket.test.ts
./scripts/m0-contract-signoff.sh           # must exit 0: M4 did not regress the M0 contract
bun run typecheck
bun test
bun run build
git diff --check
```

`scripts/m0-contract-signoff.sh` is included deliberately. It is digest-bound to the M0 contract surface (schemas, types, transitions, the frozen examples, and the M0 assertions), so it exits `2` with a `STALE` notice if M4 changes any of them without a recorded re-approval. A passing M4 gate that silently reshapes the canonical domain is not a passing gate.

The gate report contains the protocol version, enrollment/revocation procedure, partition matrix, takeover evidence, resource limits, and two-node acceptance transcript with secrets removed. It must additionally state, per carry-forward id, whether **M4-V, M4-M, M4-A, M4-O, M4-B, M4-S, and R7** are closed and cite the test that proves each.

