# M4.1 — Mesh Wire Protocol: Normative Specification

**Status:** specification of record. M4.1's deliverable is code that conforms to this
document plus the sequence diagrams in `sequence-diagrams.md`.

**Why this document exists.** Milestone 4 introduces nine new record families that cross
a trust boundary between machines. A wire shape that is not written down first is a wire
shape that gets invented twice. Everything below is binding; an implementation that
deviates must change this document, not silently differ.

## 0. Fixed decisions inherited from the plan

- HTTP APIs stay on Fastify. Ordered orchestration events stream over SSE. Terminal
  streaming uses `@fastify/websocket`.
- Node identity is application-level and revocable, **in addition to** Tailscale
  reachability. Enrollment exchanges a one-time code over an already-authenticated local
  or admin flow and pins a generated node key.
- Controller takeover is user-initiated and run-scoped. There is no election, no quorum,
  no gossip, no consensus.
- Tailscale reachability is never sufficient authentication.
- The shared bearer token is never a permanent per-node identity.

## 1. Module layout

```
src/mesh/
  protocol/            # THIS TASK. Pure: no I/O, no clock, no network.
    identifiers.ts     # wire-only id/value schemas
    envelope.ts        # the common envelope every family is wrapped in
    registry.ts        # recordType -> { version -> schema }; the ONLY parse entry point
    enrollment.ts
    heartbeat.ts
    command.ts
    ack.ts
    event.ts
    lease.ts
    reconciliation.ts
    terminal.ts
    negotiation.ts     # protocol version comparison + capability of a node
    types.ts
    index.ts
  identity/            # M4.2
  registry/            # M4.3
  lease/               # M4.4
  inbox/ outbox/       # M4.5
  gateway/             # M4.6 (SSE) and M4.7 (WebSocket)
  ...
```

`src/mesh/protocol/` must depend on `src/orchestration/` (identifiers, schemas,
transitions, invariants, versioning, digest) and on **nothing else**. No clock, no
`node:fs`, no network, no `Date.now()`. Every time field is supplied by the caller. This
is what makes the retry/partition/restart matrix testable without sleeping.

## 2. The envelope

Every record on the wire, in both directions, is a `MeshEnvelope`:

```
recordType      string, one of the nine families below
schemaVersion   1 | 2   (see §3)
messageId       string  stable, unique per envelope
correlationId   string  the command/event this answers or belongs to
causation       null | { kind: "command", commandId } | { kind: "event", eventId }
                | { kind: "enrollment", enrollmentId }
senderNodeId    string
recipientNodeId string | null   (null only on a broadcast such as a heartbeat fan-in)
protocolVersion positive int   (the MESH protocol version, frozen at M4.10)
issuedAt        timestamp
expiresAt       timestamp  MUST be strictly later than issuedAt
payload         the family record
```

`expiresAt` is a **replay window**, not a lease. A receiver refuses a record whose
`issuedAt` is in the future beyond a small clock skew allowance, or whose `expiresAt` is
already past. A replayed record inside the window is still subject to per-family
idempotency, so the window bounds exposure rather than providing idempotency.

All objects are `.strict()`. An unknown field is a rejection, not an ignore — an ignored
field is how a future field that changes meaning gets silently dropped by an old reader.

## 3. Versioning (M4-V dependency — read this before writing a family)

- `schemaVersion` comes from `src/orchestration/identifiers.ts`:
  `SCHEMA_VERSIONS = [1, 2]`, `CURRENT_SCHEMA_VERSION = 2`. A M4 wire family is written
  at version 2.
- The frozen M0 domain aggregates keep writing `FROZEN_DOMAIN_SCHEMA_VERSION = 1`.
- **The one and only way to parse a wire record is `parseVersioned` from
  `src/orchestration/versioning.ts`, dispatched through `registry.ts`.** A family that
  exports a bare `zod` object and expects callers to `parse` it directly has defeated
  the mechanism and is a review failure.
- `registry.ts` exposes:
  - `MESH_RECORD_TYPES` — the exhaustive `recordType` union.
  - `MESH_RECORD_SHAPES: Record<recordType, VersionedShapes>`.
  - `parseMeshEnvelope(value): MeshEnvelope` — reads `recordType`, then dispatches to
    that family's `parseVersioned`. An unknown `recordType` is rejected loudly
    (`protocol.unknown_record_type`); it is never parsed as a generic object.
  - `safeParseMeshEnvelope(value): VersionedParseResult<MeshEnvelope>` — same, but
    returns a `ContractError` with `versionError: true/false` so a gateway can answer
    "upgrade me" differently from "your record is malformed".
- A record whose `schemaVersion` is outside `SCHEMA_VERSIONS`, is absent, or names a
  version the family never declared raises `UnsupportedSchemaVersionError` /
  `UnversionedRecordError`. It is **never** coerced, defaulted, or partially read.
- The DATABASE version (`CURRENT_DATABASE_VERSION`, currently also 2) is a different
  axis and must not appear in any wire record.

## 4. The nine families

Each entry states what it must carry and the invariant that makes it safe. Names are
normative for the `recordType` string.

### 4.1 `mesh.enrollment.request` (M4.2)
`meshId`, `enrollmentId`, `enrollmentCodeHash` (sha256 of the one-time code — the raw
code is never transmitted twice), `nodePublicKey` (ed25519, base64url), `nodeDisplayName`,
`requestedAt`, `codeExpiresAt`.
*Invariant:* a code is single-use, expires, and is bound to exactly one `meshId`. The
controller's response pins the *exact* key submitted; a later request presenting the same
code with a different key is refused.

### 4.2 `mesh.enrollment.response` (M4.2)
`enrollmentId`, `outcome: "accepted" | "rejected"`, `nodeId`, `nodeKeyId`, `peerKeyPins`
(the controller's own pinned key plus the pins for the joining node), `meshId`,
`decidedAt`, `rejectionReason` (when rejected).
*Invariant:* an accepted response is the only thing that makes a node addressable. There
is no path to "enrolled" that does not traverse one of these.

### 4.3 `mesh.heartbeat` (M4.3)
`meshId`, `nodeId`, `observedAt`, `sequence` (per-node monotonic, starts at 1),
`liveness` (`"live"`), `runtimeKinds[]`, `capabilities[]`, `projectPathIds[]`,
`maxConcurrentSessions`, `protocolVersions: number[]`, `agentCount`, `load`.
*Invariant:* a heartbeat is a **claim, not a grant**. It never confers authorization. A
capability a node advertises is not a capability the controller must honour; the
project allowlist and `dispatchEnvelope.permissionEnvelope` remain authoritative.
*No* cross-agent dependency may be expressed here (Milestone 3 R5: those are compatibility
references, not canonical scheduling edges).

### 4.4 `mesh.command` (M4.5, authorized at M4.4's seam)
Carries, per the plan's "Commands" requirements:
`meshProtocolVersion`, `commandId`, `projectId`, `runId`, `dispatchId` (nullable for
run-scoped commands), `targetNodeId`, `controllerNodeId`, `controllerEpoch`, `leaseId`,
`issuedAt`, `expiresAt`, `commandType`, `payloadDigest` (sha256 over the canonical
payload), and the canonical `OrchestrationCommand` payload.
*Invariants:*
1. `payloadDigest` is recomputed by the receiver and must match. A mismatch is
   `protocol.payload_digest_mismatch` and is **not** persisted.
2. A repeated `commandId` with an **identical** digest returns the **stored result**.
3. A repeated `commandId` with a **different** digest is `conflict.command_digest_conflict`.
4. Authorization resolves against **the recorded log**, never against the payload. A
   payload-supplied approval, dispatch or lease is a *pointer*; the grant is whatever the
   event log recorded.
5. Authorization additionally resolves against `COMMAND_MATRIX` (M4-M). The matrix is the
   single source of allowed states.
6. The command is authenticated and authorized **before persistence**, and persisted
   **before** acknowledgement.
7. A command is minted against **one specific lease window**, and may not outlive it:
   `command.expiresAt > lease.expiresAt` is refused as `command.expiry_exceeds_lease`.
   The rule is absolute rather than "must still be valid when it is checked", so it
   binds retroactively — a renewal that shortens the window invalidates a command
   that was minted legally under the longer one, and the controller has to re-mint.
   Rejecting a command that was valid a moment ago is the cheap direction; the
   alternative is applying work whose authority has already lapsed.

### 4.5 `mesh.ack` (M4.5)
`acksCommandId?`, `acksEventId?`, `ackKind: "command" | "event" | "heartbeat"`,
`acknowledgedThroughLocalSequence` (events only), `acknowledgedAt`, `outcome:
"accepted" | "rejected" | "duplicate"`, `rejectionCode?`.
*Invariant:* an ack is the only thing that retires an outbox record. Absent an ack, the
record is redelivered.

### 4.6 `mesh.event` (M4.5)
`meshProtocolVersion`, `eventId`, `sourceNodeId`, `commandCorrelation` (the `commandId`
this event answers), `localSequence` (per source node, monotonic, gapless from the
controller's point of view), `observedAt`, `runProjectScope` (`projectId`, `runId`),
`eventType`, and the canonical `OrchestrationEvent` payload.
*Invariants:* the event enters a durable outbox **before** transmission and remains there
until the ack is persisted; resend is allowed; controller ingestion is idempotent on
`eventId`; a gap in `localSequence` is reported, not silently skipped.

### 4.7 `mesh.lease` (M4.4)
`leaseId`, `projectId`, `runId`, `controllerNodeId`, `epoch` (monotonic, strictly
increasing for a takeover), `operation: "claim" | "renew" | "release" | "takeover"`,
`issuedAt`, `expiresAt`, `durationSeconds`, `predecessorLeaseId?`,
`predecessorEpoch?`, `takeoverReason?`, `acknowledgedUnreconciledNodeIds[]`.
*Invariants:*
1. Scoped to one run and one monotonically increasing epoch.
2. Renewal must arrive before `expiresAt`; an un-renewed lease expires.
3. Expiry prevents **new** dispatch, retry and policy mutation. It does **not** kill
   running agents. (Plan guardrail: "Do not terminate agents because a controller or
   network disappeared.")
4. A `takeover` requires `epoch > currentEpoch` **and** the user having inspected
   unreconciled nodes and either accepted them explicitly or waited for them. The
   `acknowledgedUnreconciledNodeIds` list is the record of that inspection; a takeover
   with an empty list while unreconciled nodes exist is refused.
5. A higher epoch is **never** accepted without the explicit takeover operation.

### 4.8 `mesh.reconciliation` (M4.6)
Request: `reconcileId`, `projectId`, `runId`, `controllerNodeId`, `controllerEpoch`,
`peerNodeId`, `peerProtocolVersions[]`, `controllerLastAcknowledgedInboxSequence`,
`controllerLastAcknowledgedOutboxSequence`, `observedAt`, `activeSessionInventory[]`
(`sessionId`, `dispatchId`, `startedAt`).
Response: `reconcileId`, `outcome`, `acceptedControllerEpoch`,
`resendCommandIds[]`, `resendEventIds[]`, `unreconciled[]` (`nodeId`, `reason`,
`detail`), `snapshotFallback?` (`runId`, `lastAppliedSequence`, `stateDigest`).
*Invariant:* step 6 of the plan's reconciliation — "Mark unexplained differences for user
review; do not silently adopt or terminate" — is enforced structurally: the response
type has no member that could adopt or terminate a session. If you find yourself adding
one, the design is wrong.

### 4.9 `mesh.terminal` (M4.7)
Control frames and data frames are **separate schemas**, never a union with an ambiguous
discriminator.
- `mesh.terminal.control`: `terminalId`, `projectId`, `sessionId`, `nodeId`,
  `clientId`, `operation: "attach" | "detach" | "resize" | "request_input" |
  "release_input" | "takeover_input"`, `reason?`, `rows?`, `cols?`, `epoch`.
- `mesh.terminal.data`: `terminalId`, `clientId`, `direction: "to_runtime" |
  "to_viewer"`, `encoding: "base64"`, `chunk` (base64), `sequence` (per client, monotonic).
*Invariants:* **terminal content is never carried in an orchestration event, never in a
`ContractError` message, and never written to the structured log.** The data frame is the
only place terminal bytes exist, and the gateway must never log `chunk`. Frame size and
per-client frame rate are bounded (§6).

## 5. Protocol version negotiation

`protocolVersion` is an integer, distinct from `schemaVersion`. `negotiation.ts` provides
`selectProtocolVersion(offered: number[], supported: number[]): number | null` and
`negotiationMismatch(...)`. A node that offers no version in common is refused at
enrollment-time capability exchange with `protocol.no_common_version` — never silently
downgraded, and never allowed to proceed on "the newest one I happen to parse".

## 6. Resource bounds (named constants, all asserted by tests)

| Bound | Value | Rationale |
| --- | --- | --- |
| `MAX_ENVELOPE_BYTES` | 262 144 | A dispatch envelope with a 64 KiB prompt plus role/rules/manifest fits; beyond this is abuse. |
| `MAX_TERMINAL_FRAME_BYTES` | 65 536 | One terminal chunk. |
| `MAX_TERMINAL_BUFFER_BYTES` | 1_048 576 | Per-client buffer before frames are dropped. |
| `MAX_TERMINAL_FRAMES_PER_SECOND` | 512 | Per client. |
| `MAX_VIEWERS_PER_TERMINAL` | 16 | Many viewers, one input owner. |
| `MAX_COMMAND_PAYLOAD_BYTES` | 131 072 | |
| `MAX_EVENT_PAYLOAD_BYTES` | 131 072 | |
| `REPLAY_WINDOW_MS` | 300 000 | Clock-skew allowance on `issuedAt`. |
| `MAX_HEARTBEAT_AGE_MS` | 90 000 | Beyond this a node is `stale`. |
| `MAX_RULE_PATTERN_LENGTH` | 128 | R7, see §7. |

Every one of these is a named export. A magic number in a handler is a review failure.

## 7. R7 — the `taskTitlePattern` ReDoS decision (owed to M4.1)

**Decision.** `ruleMatchSchema.taskTitlePattern` is compiled **at rule-write time** into a
`SafePattern` and stored with the rule; matching uses the compiled form. A pattern is
refused at compile time when any of the following holds:

1. length > `MAX_RULE_PATTERN_LENGTH` (128, down from 256);
2. it does not compile;
3. it contains a **nested quantifier**: a quantified group whose body is itself
   quantified, e.g. `(a+)+`, `(a*)*`, `(a|a)*`, or a backreference inside a quantifier;
4. it contains a lookbehind (`(?<=`, `(?<!`), which combined with a bounded subject is a
   known quadratic-backtracking shape;
5. any sub-expression can match the empty string while being quantified.

Additionally the *subject* is bounded: matching only ever runs against a task title, and
`shortTextSchema` already caps that at 256 characters, so a linear-time matcher is bounded
work by construction.

**Residual risk, stated honestly.** Rules 3–5 are structural heuristics, not a proof;
a pattern can be pathological without tripping them. The plan's requirement is a *bound or
a timeout*, and this supplies a bound (128 chars × 256-char subject × linear matching)
plus compile-time refusal of the known catastrophic shapes. A future replacement may swap
in a RE2-style engine; the seam is `SafePattern`.

**Remote authoring.** Until a node is enrolled AND its operator has granted
`policy.ruleAuthor`, `ruleWriteSchema` refuses a rule carrying a `taskTitlePattern` at
all. Tailscale reachability is not authoring authority.

## 8. What this task does NOT build

M4.1 is pure protocol. It does not open a socket, read a clock, touch a database, or
wiring into Fastify. The seam each later task consumes is named explicitly:

- **M4.2** consumes `mesh.enrollment.*`, and pins keys.
- **M4.3** consumes `mesh.heartbeat` and the project allowlist.
- **M4.4** consumes `mesh.lease` and gates `mesh.command` at the command seam.
- **M4.5** persists `mesh.command` / `mesh.event` and emits `mesh.ack`.
- **M4.6** streams `mesh.event` over SSE and drives `mesh.reconciliation`.
- **M4.7** streams `mesh.terminal.*` over WebSocket.

If a change here would require one of those tasks to change a shape, the shape is wrong.

## 9. Required tests (`tests/unit/protocol/`)

- `version-mismatch.test.ts` — **one test per record family**: a record at an unknown
  version is rejected loudly, not coerced; a record at a supported-but-undeclared version
  for that family is rejected; an unversioned record is rejected; `parseMeshEnvelope` is
  the only entry point and an unknown `recordType` is refused.
- `envelope.test.ts` — strictness, `expiresAt > issuedAt`, replay window, causation
  closure, and that every family is reachable through the registry.
- `negotiation.test.ts` — no common version is refused; never silently downgraded.
- `command.test.ts` — payload digest recomputation; repeat-with-same-digest;
  repeat-with-different-digest is a conflict; authorization fields present and bound.
- `event.test.ts` — local sequence monotonicity, stable ids, correlation.
- `lease.test.ts` — epoch monotonicity, renewal window, expiry, takeover requires a
  higher epoch AND an explicit acknowledgement of unreconciled nodes.
- `reconciliation.test.ts` — all six plan steps; the response type provably cannot adopt
  or terminate a session.
- `terminal.test.ts` — control frames and data frames are separate types; a data frame is
  rejected by the control schema and vice versa; frame size bound.
- `safe-pattern.test.ts` — R7: the catastrophic patterns are refused at compile time,
  ordinary patterns still match, and the legacy shapes still work.
- `bounds.test.ts` — every bound in §6 is exported, is the stated value, and is applied.
