# M4.1 — Protocol Failure Semantics: Sequence Diagrams

Companion to `m4-1-mesh-protocol-spec.md`. Each diagram names the record families from
§4 of the spec. These are the five scenarios the plan requires: **retries, partitions,
restart, stale epoch, and version mismatch**. Each states the *observable* outcome, so
each can be turned directly into a test.

---

## 1. Retry — the controller retries an unanswered command

The outbox is at-least-once. The controller cannot distinguish "the worker never saw it"
from "the worker applied it and the ack was lost", so it resends. The worker must
converge, not duplicate.

```
Controller                     Worker
    |                             |
    |-- mesh.command (cmd-7) ---->|   persisted (inbox), seq 41
    |                             |   (worker crash before ack)
    |  X  no ack                 |
    |                             |
    |  lease renewed, epoch same |
    |-- mesh.command (cmd-7) ---->|   commandId seen + digest identical
    |                             |   -> return the STORED result, append nothing
    |<-- mesh.ack duplicate ------|   outbox row for the event is NOT recreated
    |                             |
    |  outbox row for the effect  |
    |  is still `pending`         |
    |  -> deliverer keeps trying  |
```

**Observable outcomes.**

- The worker's inbox has exactly **one** row for `cmd-7`.
- The second submission returns `outcome: "duplicate"` and the original stored result.
- **No second session, no second prompt.** A session count of 2 for one `commandId` is a
  failure, not a tolerance.
- A repeat with a *different* payload digest is `conflict.command_digest_conflict` and
  writes nothing.

**Convergence test:** submit the same command 5 times; assert 1 inbox row, 1 session, and
that responses 2–5 equal response 1.

---

## 2. Partition — a bidirectional network cut, both directions

```
Controller                     Worker
    |                             |
    |==== X  partition  X ========|
    |                             |
    |  outbox rows accumulate     |   inbox rows accumulate
    |  (pending, backoff)         |   (persisted, unacked)
    |  lease renewal FAILS        |   worker notices its controller is unreachable
    |                             |
    |  t > expiresAt              |
    |  lease EXPIRED              |
    |                             |
    |  no new dispatch / retry /  |   existing agents KEEP RUNNING
    |  policy mutation            |   (the plan forbids killing agents
    |                             |    because a controller vanished)
    |  in-flight commands remain  |
    |  in the outbox              |
```

**Observable outcomes.**

- After `expiresAt`, every command that would create new work is refused with
  `lease.expired`. Nothing is queued for later "just in case" — a command
  minted at epoch *E* must never be applied at epoch *E+1* after a takeover.
- The worker's sessions are untouched. Session count and their `lifecycleState` are
  unchanged by the partition. **This is a stop condition if violated.**
- On heal, the worker does not resend anything the controller has not asked for; the
  controller's reconciliation (§6 of the plan) drives the resend.

---

## 3. Restart — the worker process dies mid-flight

```
Worker
    |
    |-- inbox:  rows persisted for every accepted command
    |-- outbox: rows persisted for every event BEFORE transmission
    |-- session refs: dispatchId -> sessionId, and terminalId where bound
    |
    |  X  crash
    |
    |-- restart
    |     recoverStaleOutbox(now)      -> requeues rows stranded in `sending`
    |     reload session references   -> a reconnected client can find its sessions
    |
    |-- mesh.reconciliation (response) -> peerNodeId, controllerEpoch, positions
```

**Observable outcomes.**

- Every outbox row that was `sending` when the process died is requeued after its lease
  expires, with `attempts` preserved and never reset.
- A row already `acknowledged` is never redelivered.
- Session references survive: a reconnected terminal client finds its `terminalId`.
- Events for the same `localSequence` are **not** re-emitted with new ids. The event id is
  stable, so the controller's ingestion dedupe converges.

**Crash-boundary test:** for each of the eight `EffectBoundary` hooks, crash there, restart,
and assert convergence. Hooks 5 (before deliver) and 6 (after runtime accept, before ack) are
the two that produce a *redelivery*, and both must be idempotent.

---

## 4. Stale epoch — a second controller takes over

```
Controller A (epoch 4)        Controller B          Worker
    |                            |                     |
    |==== X  A partitioned  X ===|                     |
    |                            |-- mesh.lease ------>|  claim, epoch 5
    |                            |   takeover          |  (after user inspection)
    |                            |                     |
    |-- mesh.command (epoch 4) -->|                     |   arrives at B
    |                            |-- mesh.lease ------>|   A's epoch 4 < 5
    |                            |                     |   -> epoch.stale
    |                            |                     |   NOTHING persisted
    |-- mesh.command (epoch 4) -->|                     |   dropped, not queued
```

**Observable outcomes.**

- A command carrying an epoch lower than the accepted lease is refused with
  `stale_epoch`, and **nothing is persisted**. It is not stored "for later": a command
  minted under a superseded controller must never be applied under its successor, because
  it was decided against a projection that no longer exists.
- A command carrying a *higher* epoch is **also** refused, with
  `epoch.unregistered`. A higher epoch is only ever accepted through the explicit
  `takeover` operation. This is a plan guardrail, not a nicety.
- The takeover response records the node ids whose state the user inspected. A takeover
  offered while unreconciled nodes exist and with an empty acknowledgement list is refused.

**Split-brain test (release-blocking):** under every partition in the matrix, at most one
controller may create new work for a given run. Two controllers both creating work is a
stop condition, not a finding.

---

## 5. Version mismatch — a node speaks a shape this build does not

```
Node X (protocolVersion 3)      Node Y (protocolVersion 2)
    |                                |
    |-- mesh.heartbeat (v3) -------->|
    |                                |  readSchemaVersion -> 3
    |                                |  3 not in SCHEMA_VERSIONS
    |                                |  -> UnsupportedSchemaVersionError
    |<-- protocol.unsupported_schema_version (retryable: false)
    |
    |  Y does NOT parse the payload
    |  with the v2 shape, does NOT
    |  coerce, does NOT partially read
```

Three distinct failures, three distinct answers:

| Condition | Error code | Retryable | Operator action |
| --- | --- | --- | --- |
| `schemaVersion` outside `SCHEMA_VERSIONS` | `protocol.unsupported_schema_version` | no | upgrade the older node |
| family has no shape for a supported version | `protocol.unsupported_schema_version` | no | family was introduced later |
| no `schemaVersion` at all | `protocol.unversioned_record` | no | sender is not a conforming build |
| record satisfies its own version's support set but not its shape | `protocol.record_invalid` | no | sender bug |
| no common `protocolVersion` | `protocol.no_common_version` | no | upgrade one side |
| an **envelope** past its `expiresAt` | `protocol.record_expired` | no | replay attempt or clock skew |

None of these is retryable. A node that keeps retrying a version it will never understand
is a resource-exhaustion vector, which is why `retryable: false` is asserted rather than
assumed.

**Ordering guarantee.** The version is read from the record **before** any shape is
consulted, and a record that fails the version check is never partially parsed. A test
asserts that the failure message names the family and the versions supported, so an
operator can act on it without reading the source.

---

## 6. Reconciliation — the plan's six steps, in order

```
1. Authenticate node and compare protocol versions.
   -> mesh.reconciliation request carries peerProtocolVersions[]
   -> no common version: refuse, do not reconcile

2. Exchange controller epoch and last acknowledged inbox/outbox positions.
   -> controllerEpoch vs the lease the worker holds
   -> step 3 applies if the worker is behind

3. Reject stale-controller traffic.
   -> a request from a controller whose epoch is lower than the worker's is refused

4. Resend unacknowledged commands/events idempotently.
   -> deduped by commandId+digest and by eventId

5. Compare active session inventory against dispatch projections.
   -> the worker reports its live sessions; the controller diffs

6. Mark unexplained differences for user review.
   -> unreconciled[] entries; NOTHING is adopted and NOTHING is terminated
```

Step 6 is structurally enforced: `mesh.reconciliation`'s response schema has no member
that could adopt or terminate a session. This is not a discipline the implementer is asked
to maintain — it is a property of the type. Adding such a member is a design regression.
