# ADR 0003: Event store, transactions, and command idempotency

Status: accepted for the Milestone 0 contract freeze (M0.5).

Depends on [ADR 0001](0001-canonical-domain-and-module-boundaries.md), [ADR 0002](0002-versioned-contracts-and-adapter-boundaries.md), and the completed [version-1 orchestration schemas](../../src/orchestration/schemas.ts). Lease authority and recovery are specified in [ADR 0004](0004-controller-leases-and-recovery.md).

## Decision and scope

Use a local SQLite database in WAL mode for each node's durable orchestration records. A run has one fixed authority service and one authoritative store that serialize its event stream, command decisions, and lease epochs. The current controller submits changes to that authority, including when it runs on another node. Worker nodes keep their own durable inbox, effect journal, session bindings, fencing state, and observation outbox. Replicated event history is a read model; it cannot become a second writer by losing contact with the authority.

This ADR decides persistence behavior before repository interfaces. It does not add a database dependency, SQL implementation, repository API, route, lease service, or production adapter in M0. Internal receipt, transport, migration-journal, and lease-control records described below require versioned schemas when implemented; they are not additional variants accepted by the frozen version-1 domain parser.

Set and verify `journal_mode=WAL`, use `synchronous=FULL` for durable control records, enable foreign-key enforcement on each connection, and bound busy waits and transaction sizes. SQLite permits concurrent readers but serializes writers; the WAL and database must reside on a local supported filesystem, not a shared network mount. These durability choices depend on the filesystem and hardware honoring synchronization. [SQLite WAL documentation](https://www.sqlite.org/wal.html).

Use short `BEGIN IMMEDIATE` write transactions with bounded retry on contention; never keep one open across a network request, runtime call, artifact transfer, terminal operation, or user approval. A failed commit is not an acknowledgment: resolve its result by reopening/checking the durable idempotency record before retrying the logical operation. [SQLite transaction documentation](https://www.sqlite.org/lang_transaction.html).

## Durable records and constraints

The following are logical records and uniqueness requirements, not a prescribed SQL table API:

| Record | Required invariant |
| --- | --- |
| Run stream head | One project binding and one committed last sequence per run. The authority binding is fixed and authenticated. |
| Run event | Unique `eventId`; unique `(runId, sequence)`; immutable parsed event and canonical content fingerprint. Its project must match the run. |
| Command receipt | Unique `(projectId, runId, commandId)` with full command fingerprint, authenticated issuer, decision/status, result or safe typed error, and associated event sequence range. |
| Worker inbox/effect journal | Same scoped command key; immutable fingerprint and intended target; durable execution phase, allocated session identity, provider correlation when available, and evidence of the outcome. |
| Observation inbox | Unique `(sourceNodeId, observationId)` plus scope and normalized content fingerprint; links each accepted observation to the committed run events. |
| Outbox | Stable delivery ID and destination, immutable payload/fingerprint, originating transaction reference, acknowledgment and bounded retry metadata. |
| Critical projection | Run/task/dispatch/session state and cross-record indexes updated at the same committed stream position as their source events. |
| Lease and worker fence | Authority lease/epoch/control state and worker's highest authenticated accepted epoch are durable safety records; see ADR 0004. |
| Migration journal | Stable import identity, source digest, mapping, disposition and committed sequence range; exact reruns reuse the same result. |

Cross-record checks enforce project/run ownership, task graph validity, immutable dispatch IDs/attempts, one canonical session per dispatch in version 1, and consistent approval digest/dispatch identity. A schema-valid record is still subject to authorization and state-transition checks. No unique constraint substitutes for those checks.

## Authoritative append transaction

For an authenticated proposed mutation, the authority performs one transaction:

1. Read the run/project binding, current lease/control state, expected stream head, and existing command or observation receipt. Validate version, size, relationships, authorization, transition and current controller authority. An expected-head mismatch returns `conflict` and requires recomputation from current state.
2. Resolve duplicates as described below. For a new accepted mutation, allocate the next contiguous per-run sequence range from the locked head. Sequences start at 1, remain positive safe integers, and never derive from wall-clock time or SQLite row IDs. Abort before overflow. Rolled-back allocations are not externally visible.
3. Append the complete event batch, update the stream head and critical projections, record the receipt/result and source-observation mapping, and insert all required command/notification outbox rows.
4. Commit before acknowledging or releasing an outbox effect. Return the stored result and committed sequence range. If any step fails, none of these records becomes committed independently.

All events in the batch use the authenticated current epoch. Lease acquisition is the authority's administrative transaction defined in ADR 0004, not a request authorized by an expired controller. Initial run creation and its first lease are committed together, with epoch 1 and consistent `run.created`/`controller.lease.changed` events. No epoch-zero placeholder is emitted.

Committed sequences order only that run. Independent runs have no total order. A node observation's timestamp describes when it was observed; the authority assigns sequence when it accepts the observation. Late observations from executions begun under an earlier epoch may be accepted by the current controller after reconciliation, using the current event epoch and retaining original command/epoch/source evidence in the observation journal. They cannot reactivate an old command or silently overwrite a newer terminal outcome.

## Fingerprints and duplicate behavior

For a canonical command, parse with `orchestrationCommandSchema`, then fingerprint the complete parsed object using `digestJson` and the canonical JSON rules from ADR 0002. The fingerprint version is stored with the receipt. Version 1 fingerprinted every serialized field; version 2 (current, `CURRENT_COMMAND_FINGERPRINT_VERSION`) fingerprints the **semantic** fields and excludes three:

- `commandId` is already the receipt key, so including it adds no discrimination.
- `issuedAt` / `expiresAt` are the client's clock window. A client retrying a command whose answer it never received legitimately regenerates them, and fingerprinting them turns an ordinary at-least-once retry into a false `FingerprintConflictError` — the defect behind the Milestone 3 criterion "duplicate commands cannot launch duplicate sessions".

Everything else stays in: `type` + `payload` (the requested change), `projectId`/`runId` (authority scope), `actor`, `controllerNodeId`/`controllerEpoch`/`leaseId` (who issued it), `correlationId`/`causation`, and `schemaVersion`. A genuinely mutated command under a reused `commandId` still conflicts: changing the payload, the actor, the epoch or the scope all change the digest. Transport credentials, retry counters and transport envelopes are outside this object entirely.

Excluding the time window does **not** let a client extend a live command: a same-key retry returns the *stored* outcome and never admits new work, so a re-issued command with a longer `expiresAt` observes the original result rather than gaining a fresh effect. Obtaining NEW authority by extending an expiry or replacing a lease is still a different logical operation and must use a new `commandId`. Version-1 receipts remain resolvable because a v1 whole-command digest is also computed and accepted for legacy comparison.

After authenticating the caller and authorizing receipt visibility:

- Same scoped key and same fingerprint: return the stored accepted, in-progress, completed or rejected result. Never append another decision or invoke another effect merely because delivery repeats.
- Same scoped key and different fingerprint: return `conflict`; preserve the original receipt and audit the conflicting attempt safely.
- No receipt: validate current lease, expiry, approval, project path, capabilities, source authorization and state before admitting work. An old key does not grant new authority.
- An expired/stale exact duplicate may return existing evidence as a read. It cannot resume a queued or uncertain effect without current authorization. A retryable transport error is not proof that the command was rejected or unexecuted.

Deterministic rejected decisions for authenticated, correctly scoped commands may be stored as receipts so retries observe the same answer. An unauthenticated request cannot reserve another principal's command key. A fresh command ID does not evade dispatch uniqueness, immutable approval binding, permission-request consumption, or session-operation ordering.

Receipts/fingerprints and dispatch uniqueness tombstones must outlive every possible replay window. Version 1 retains them for the retained run lifetime; archiving a run cannot erase the safety records while any node could still deliver its commands. Future compaction needs an explicit retention protocol, not time-based deletion of completed receipts.

## Worker effects and reliable delivery

Controller outbox delivery and worker observations are at-least-once. The receiver acknowledges only after committing its receipt. Sender acknowledgment bookkeeping occurs in a later local transaction; losing that acknowledgment therefore causes a safe duplicate delivery.

The worker authenticates the authority/controller and resolves canonical scope, verifies the dispatch digest and approval, rechecks project realpath and policy, and durably admits a new command to its inbox before attempting a runtime effect. It allocates and records the canonical session identity before launch, with a unique dispatch-to-session binding. Local serialization prevents concurrent handlers from invoking the same command or conflicting operations on the same session.

The effect journal distinguishes `prepared` (not yet invoked), `invoking` (invocation may have happened), `completed`, `rejected`, and `uncertain`. These are future internal journal phases, not domain dispatch/session states. Immediately before crossing the effect boundary, recheck fencing/expiry and current policy, then commit `invoking`. A prepared command that expires is rejected without an effect. A crash after committing `invoking` is ambiguous even if the call might not have begun.

After a confirmed runtime outcome, atomically commit its receipt, canonical/provider session mapping, safe result and observation outbox entry in the worker database. No SQLite transaction can atomically commit a remote provider or process effect. Thus version 1 promises deduplicated durable admission and conservative recovery, not universal exactly-once external execution.

For recovery from `invoking`/`uncertain`, query the runtime by stable command/session correlation where supported. Restore the proven existing session or record the proven prior result. Retry an effect only when the provider's idempotency contract or authoritative evidence proves that it cannot repeat an effect; require valid current authority as well. For ambiguous launch, prompt submission, or permission response without such evidence, block automatic replay and require reconciliation. Absence from a best-effort process listing, a missing callback, idle terminal text, or a transport timeout is insufficient proof of non-execution. This applies to fakes as a contract expectation and later production adapters as an implementation requirement.

Each worker observation receives a durable stable observation ID before sending. Reusing that ID with different content is a conflict. The authority commits observation deduplication, resulting events/projections, receipt, and resulting outbox effects together. A received observation may yield no new domain event if already reflected; it still receives a durable disposition. Raw terminal output/provider metadata remains outside domain events.

## Projections, artifacts, and migration

The immutable accepted event log is the source for reconstructible domain views. Critical projections used to authorize scheduling advance in the append transaction. TUI/search/reporting projections may lag, but expose their last applied sequence and apply each event idempotently. Rebuild into a separate projection generation from sequence 1 or a verified versioned snapshot plus suffix, validate its contiguous position, then atomically switch readers. Replay never sends commands or reconstructs an outbox for already-delivered effects. A projection corruption can be rebuilt; lease fences, command receipts and effect uncertainty cannot be discarded as mere caches.

Artifact bytes live outside the database. Stage bounded content, verify its digest and length, and durably finalize it before committing `artifact.registered`. A crash before registration leaves an unreferenced object eligible for later garbage collection; registration must never acknowledge incomplete bytes. Garbage collection checks durable references and retention. External locators remain references whose availability must be revalidated, not claims that bytes were locally committed.

Legacy migration is an explicit dry-run/commit workflow. Read source records without modifying them, back up the source and target, validate authorization preservation, and allocate deterministic mappings. A single source record's mapping, inert domain records, import journal and `legacy.imported` events commit together. Larger imports use resumable per-record transactions, never claim all-record atomicity, and do not send execution outbox entries. Active legacy jobs become paused evidence pending reconciliation and fresh authorization. Imported plan approval text does not become canonical approval. Source changes under the same import key conflict rather than overwrite history. M0.7 defines exact mappings and rollback.

Use SQLite's supported backup mechanism for live databases; copying only the main file while writes continue is not a consistent backup. Restore is a controlled offline operation subject to ADR 0004's fence rules. [SQLite Backup API](https://www.sqlite.org/backup.html).

## Failure table and implementation gates

| Failure/crash point | Durable evidence | Required recovery |
| --- | --- | --- |
| Before append transaction or before commit | No committed receipt/events | Revalidate and retry same command; no acknowledgment or effect was permitted. |
| Partial event/projection/outbox write; disk full; failed constraint | Entire transaction rolls back or commit result is uncertain | Resolve durable receipt on recovery; never repair by appending only missing members of the batch. |
| Commit succeeds, response is lost | Complete receipt/event/projection/outbox batch | Exact retry returns stored result; no new sequences or effects. |
| Concurrent duplicate or changed command content | Unique key and original fingerprint | One admission; matching retry returns receipt, changed retry conflicts. |
| Outbox send succeeds, sender crashes before acknowledgment | Receiver has durable inbox receipt | Resend unchanged payload; receiver deduplicates. |
| Worker crashes while `prepared` | Command admitted, no invocation recorded | Revalidate authority; invoke once only if still valid. |
| Worker crashes after `invoking`, before outcome commit | Effect may already exist | Query evidence/restore; ambiguous launch or prompt remains blocked. Never blind replay. |
| Outcome commits, worker response is lost | Receipt and observation outbox both durable | Return receipt and resend observation; do not invoke again. |
| Duplicate/out-of-order worker observations | Stable source ID/fingerprint and stream head | Deduplicate; reconcile transitions; assign sequence only on acceptance. |
| Stale controller or expired queued command | Lease/fence plus original command | Reject effects as `stale_epoch` or `timeout`; retain existing outcome evidence. |
| Crash during projection rebuild or WAL checkpoint | Previous committed generation/SQLite recovery state | Use last committed view and resume verified replay; never replay effects. |
| Missing/corrupt store or rollback to an older backup | Completeness/fence cannot be established | Fail closed for mutation; preserve evidence and follow ADR 0004 recovery. |

M1 implements local event/receipt storage and restart tests; M3 implements kernel transition/projection and side-effect gates; M4 implements authenticated inbox/outbox, fencing and partition tests. Before those implementations are accepted, fault injection must exercise every row, concurrent duplicates, mismatched fingerprints, gap/overflow rejection, import interruption, and ambiguous provider outcomes. M0 tests remain contract/fake tests and do not claim SQLite crash durability has been implemented.
