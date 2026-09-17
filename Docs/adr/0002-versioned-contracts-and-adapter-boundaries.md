# ADR 0002: Versioned wire contracts and adapter boundaries

Status: accepted for the Milestone 0 contract freeze (M0.2).

Depends on [ADR 0001](0001-canonical-domain-and-module-boundaries.md).

Purpose: provide a common schema/interface target for M0.3 and M0.4 without implementing orchestration, persistence, or process behavior.

## Scalars, versions, and parsing

Every independently persisted or API-exchanged object has literal `schemaVersion: 1`. Nested value objects inherit their containing version unless they are independently addressable records. Version 2 or a missing version fails a version-1 parser; legacy input has a separately named parser. All canonical object schemas reject unknown keys. No default may turn missing authorization, controller authority, or approval evidence into a grant.

Use `z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).brand<"NodeId">()` and corresponding distinct brands for `MeshId`, `NodeId`, `ProjectId`, `ProjectPathId`, `RunId`, `TaskId`, `DispatchId`, `ApprovalId`, `SessionId`, `RoleId`, `RuleId`, `MemoryId`, `ArtifactId`, `LeaseId`, `InstallationId`, `TerminalId`, `TerminalClientId`, `UserId`, `EventId`, `CommandId`, and `CorrelationId`. Export each lower-camel schema (for example `nodeIdSchema`) and the inferred PascalCase type from `identifiers.ts`. IDs are opaque: no semantic prefix parsing, path construction, or authorization follows from their spelling. Brands separate TypeScript domains; runtime existence/ownership checks are still required.

Other shared scalars exported there are `schemaVersionSchema` (literal 1), `timestampSchema` (RFC 3339 UTC timestamp), `digestSchema` (`sha256:` followed by 64 lowercase hexadecimal characters), `epochSchema` (positive safe integer), and `capabilitySchema` (bounded nonempty token). Sequences, attempts, and template versions are positive safe integers. Byte counts are nonnegative safe integers. Timestamps must describe real calendar instants; expiry must be later than issue time. Bounded strings/arrays are required at input boundaries; implementations document their selected caps in tests. Authentication, secret scanning, realpath checks, existence checks, graph cycles, and state transitions require services in addition to Zod.

Namespaced `ExternalReference` is `{ namespace, id }`, both bounded strings. Legacy strings are external references and are never cast into canonical ID brands. `Actor` is a discriminated union: `{ kind: "user", userId }`, `{ kind: "node", nodeId }`, `{ kind: "session", sessionId }`, or `{ kind: "system", name }`. The brainstorm's ambiguous `actor.kind: "agent"` is deliberately replaced by `session`. An actor record is an audit assertion, not authentication proof.

## Schema exports and minimum content

M0.3 owns these exact public schema/type names. Implementations may add supporting schemas within the same file, but must not rename or redefine these shared exports:

| Schema / inferred type | Required information and relations |
| --- | --- |
| `actorSchema` / `Actor` | The discriminated identities above. |
| `externalReferenceSchema` / `ExternalReference` | Namespaced correlation with a legacy or external system. |
| `meshSchema` / `Mesh` | Version, mesh ID, display name, creation time. |
| `nodeSchema` / `Node` | Version, node ID, mesh ID, display name, enrollment/revocation state, external references. Endpoint/health declarations cannot establish trust. |
| `projectPathSchema` / `ProjectPath` | Version, project-path ID, project ID, node ID, absolute configured path, allowed capabilities. The path is re-resolved and authorized at execution. |
| `projectSchema` / `Project` | Version, project ID, mesh ID, name, explicit path bindings. Reject mismatched nested project IDs. |
| `runSchema` / `Run` | Version, run ID, project ID, goal, state, created/updated times, external references. |
| `taskDependencySchema` / `TaskDependency` | Canonical task ID and explicit failure policy (`block` or `fail`). |
| `taskSchema` / `Task` | Version, task ID, run ID, project ID, title, description, state, dependencies, external references. No self-dependency or duplicate dependency. |
| `roleTemplateSchema` / `RoleTemplate` | Version, role ID, template version, project ID, name, purpose, instructions, required capabilities, preferred runtime kinds, context-selection policy reference, permission restrictions, author/time. |
| `ruleSchema` / `Rule` | Version, rule ID, template version, project ID, enabled state, declarative match data, restrictive effect or bounded pre-approval, author/time. No arbitrary executable code. |
| `permissionEnvelopeSchema` / `PermissionEnvelope` | Explicit allowed/denied capabilities and approval requirements for destructive/external effects; no implicit wildcard grants. |
| `contextManifestSchema` / `ContextManifest` | Ordered bounded references with source kind/ID, content digest, sensitivity and size; manifest digest. No unbounded raw transcripts. |
| `dispatchEnvelopeSchema` / `DispatchEnvelope` | Exact fields in the envelope section below. |
| `dispatchSchema` / `Dispatch` | Version, immutable envelope, envelope digest, state, creation time, external references. |
| `approvalSchema` / `Approval` | Version, approval ID, project/run/dispatch IDs, envelope digest, decision, actor/time, and rule ID/version when rule-approved. |
| `sessionSchema` / `Session` | Version, session ID, project/run/task/dispatch IDs, node/installation IDs, runtime kind, normalized state, optional terminal ID. Provider handle/SDK payload is excluded. |
| `memoryRecordSchema` / `MemoryRecord` | Version, memory ID, project ID, kind, content/hash, scope, author/time, source references, trust state, sensitivity, retention, optional supersedes ID. |
| `artifactSchema` / `Artifact` | Version, artifact ID, project/run/dispatch IDs, optional session ID, name/media type, digest, byte count, source provenance and locator/reference. No artifact bytes. |
| `controllerLeaseSchema` / `ControllerLease` | Version, lease ID, project/run IDs, controller node ID, epoch, issued/expiry timestamps. |
| `orchestrationEventSchema` / `OrchestrationEvent` | Strict discriminated event union with common envelope below. |
| `orchestrationCommandSchema` / `OrchestrationCommand` | Strict discriminated command union with common envelope below. |

Every nested project/run/task/dispatch identity which is available within the same parsed value must agree. Schema tests reject mismatches where observable; cross-record checks belong to the future kernel/store. M0.3 may choose details internal to a single schema, but must communicate any field choice consumed by M0.4/M0.7/M0.8 to the lead; supporting types must be inferred rather than duplicated.

## Immutable dispatch and approval digest

`DispatchEnvelope` fields are `schemaVersion`, `dispatchId`, `attempt`, `projectId`, `runId`, `taskId`, `targetNodeId`, `installationId`, `runtimeKind`, `projectPathId`, `prompt`, `roleSnapshot`, `ruleSnapshots`, `contextManifest`, `requestedCapabilities`, `permissionEnvelope`, `dependencies`, `timeoutSeconds`, and `controllerEpoch`. `roleSnapshot` is a complete `RoleTemplate`; `ruleSnapshots` contains complete effective `Rule` versions. Optional `model` is a bounded provider-neutral selection string. The role/rules must belong to the dispatch project. Dependencies and task must belong to the enclosing run when resolved.

`digestDispatchEnvelope(envelope)` in `src/orchestration/digest.ts` parses the versioned envelope and returns a `Digest` derived from SHA-256 of canonical UTF-8 JSON: recursively sort object keys lexicographically, preserve array order, use JSON scalar encoding, and reject non-JSON/nonfinite values. Export `canonicalJson(value)` and `digestJson(value)` as supporting deterministic helpers. Unknown envelope keys fail validation rather than being silently omitted from the digest. Dates are serialized strings; absent optional fields are absent. These helpers hash contract data, not credentials or raw runtime output.

All envelope content, including identity, epoch, target, model, prompt, role/rule snapshots, context, permissions, timeout, dependencies, and attempt, participates in the digest. The digest field is outside the envelope and therefore not self-referential. Approval records are separately authenticated and bind dispatch ID plus digest. A changed proposal receives a new dispatch ID/attempt and fresh evaluation/approval. A changed controller epoch therefore requires reevaluation of any not-yet-executed proposal; takeover must not silently reuse an old envelope under a new epoch.

M0.3 verifies content hashing and observable consistency; the later execution gate verifies digest/approval equality, actor authority, current rule validity where applicable, lease validity, source authorization, project path, capabilities, and policy floor before effects. Schema validity alone never means approved or executable.

## Event and command envelopes

Run events include `schemaVersion`, `eventId`, `sequence`, `projectId`, `runId`, `type`, typed `payload`, `actor`, `occurredAt`, `correlationId`, `causation` (null, `{ kind: "command", commandId }`, or `{ kind: "event", eventId }`), and `controllerEpoch`. Optional `commandId` records the accepted command that generated an event. `sequence` is authoritative only inside that run; wall-clock timestamps never determine ordering. Worker observations are not authoritative sequenced events until accepted by the controller.

Version-1 event variants cover at least `run.created`, `task.created`, `dispatch.proposed`, `approval.decided`, `dispatch.started`, `dispatch.finished`, `session.observed`, `memory.proposed`, `memory.accepted`, `artifact.registered`, `controller.lease.changed`, and `legacy.imported`. Use strict typed payload schemas for each discriminant; a generic arbitrary JSON payload does not satisfy this contract. Controller lease change event epoch must equal the embedded lease epoch. Session observations contain normalized fields, never an OpenCode SDK event or raw terminal stream. Administrative mesh/project records are versioned records in M0; a future administrative event stream is outside this run-event schema.

Commands include `schemaVersion`, `commandId`, `projectId`, `runId`, `type`, typed `payload`, `actor`, `controllerNodeId`, `controllerEpoch`, `leaseId`, `issuedAt`, `expiresAt`, `correlationId`, and `causation` with the same tagged/null shape. The stable command ID is the idempotency key. A retry preserves it and its semantic content; reusing it with changed content is a conflict. Relevant payload identities must agree with the envelope. Version-1 variants cover `dispatch.execute`, `session.prompt`, `session.respond`, `session.interrupt`, `session.terminate`, and `run.cancel`. Proposal/approval records are also explicit schemas; M0 does not expose HTTP command routes or implement handlers.

M0.5 decides atomic append/receipt/projection behavior, command fingerprinting, durable worker side-effect recovery, authority checks and expiry, and how legacy historical import receives safe provenance. M0.3 does not implement event ordering, event replay, command execution, or lease acquisition. Imported active jobs are inert historical/paused records until later reconciliation and fresh authorization.

## Shared errors and runtime interface

`errors.ts` exports `errorCategorySchema`, `contractErrorSchema`, inferred `ErrorCategory`/`ContractError`, and `Result<T> = { ok: true; value: T } | { ok: false; error: ContractError }`. Categories are exactly `validation`, `unsupported_capability`, `policy_denied`, `approval_required`, `conflict`, `stale_epoch`, `transient_transport`, `timeout`, `runtime_failure`, and `internal_failure`. A serialized error has version, category, bounded stable code, safe message, retryable flag, and optional correlation ID. Do not serialize an Error stack, credential, raw command environment, or unbounded provider exception. Authorization failures, unsupported operations, and stale epochs are not retried automatically. Transport retries still require the same command ID and unexpired authority.

`src/runtime/types.ts` exports `AgentRuntimeAdapter`, `NodeContext`, `AgentInstallation`, `RuntimeCapabilities`, `LaunchAgentRequest`, `RuntimeSession`, `RuntimeSessionReference`, `PromptRequest`, `AgentResponse`, `AgentRuntimeEvent`, and `AgentResult`. Serialized data types are inferred from lower-camel schemas in `src/runtime/schemas.ts`. M0.4 consumes the ID/error exports above. Capability booleans include `structuredPermissions`, `nativeSessionRestore`, `reliableCompletion`, `modelSelection`, `usageData`, `hooks`, and `transcriptExport`; unsupported optional operations return `unsupported_capability` explicitly.

Interface methods follow the brainstorm: `detect`, `launch`, `restore`, `prompt`, `observe`, `respond`, `interrupt`, `terminate`, and `collectResult`. Promise methods return `Promise<Result<T>>` rather than throwing for expected failures; `observe` returns `AsyncIterable<Result<AgentRuntimeEvent>>`. Contract violations/internal programmer failures may throw, but expected runtime failures must use the shared taxonomy. Mutating requests carry stable command ID, canonical identity, project/node scope, and controller authority; use a shared runtime operation context argument for methods whose brainstorm signature otherwise lacks those fields. Launch receives the complete approved envelope and digest/approval reference, not an unscoped prompt. Adapter capabilities cannot authorize a capability omitted from that envelope.

`RuntimeSessionReference` contains canonical scope plus bounded adapter metadata needed to restore a provider handle. Runtime metadata is confined to runtime schemas and is sanitized before persistence; orchestration Session/events omit it. An `AgentRuntimeEvent` has stable observation identity, canonical scope, timestamp, and normalized typed state/permission/result data. Terminal-derived ambiguity must produce `unknown`. A result cannot claim success without a declared reliable completion mechanism or explicit trusted evidence.

## Terminal interface and identity boundary

`src/terminal/types.ts` exports `TerminalBackend`, `CreateTerminalRequest`, `TerminalReference`, `TerminalChannel`, `TerminalSnapshot`, and `TerminalOperationContext`. Serializable data types come from lower-camel schemas in `src/terminal/schemas.ts`; live streams/functions belong only in interfaces. Every reference carries terminal ID, node ID, project ID, and canonical session ID; a backend-native handle stays inside adapter metadata. Creation/termination uses command/epoch authority. Attachment uses an authenticated client identity, explicit project/node scope, and authorization separate from controller liveness so existing sessions remain inspectable after controller loss.

Methods are `create`, `attach`, `resize`, `snapshot`, `detach`, `terminate`, and `recover`, returning typed `Result` values. Add operation context/options where required to carry scope and requested access. `TerminalChannel` exposes bounded byte reads, a write operation, and explicit input-ownership request/release or takeover operations; writes by read-only/non-owner clients return `policy_denied` or `conflict`. At most one current input owner exists per terminal; attachment defaults to read-only and takeover is explicit and auditable. `detach` never terminates the terminal. Dimensions are positive bounded integers. Snapshot/buffer byte caps are explicit. Recover is scoped to the owning node/project and never returns another project's terminals.

No terminal bytes, escape sequences, provider credentials, or raw transcript are put in domain event payloads. Attach/detach/input ownership changes can become typed audit facts in later milestones. M0.4 defines contracts and in-memory contract fakes only, and does not spawn tmux/PTYs or implement WebSocket transport.

## Contract test obligations and freeze

M0.3 tests version discrimination, opaque brand separation with compile-time negative cases, strict unknown-key rejection, bounds, invalid timestamps and unsafe numeric counters, identifier mismatches, deterministic digest encoding, and digest changes for material envelope changes. Tests demonstrate that a schema cannot establish live authorization by itself.

M0.4 supplies compiling fakes and focused tests for typed errors, explicit unsupported capabilities, unknown state, canonical identity scope, and terminal ownership. M0.8 adds reusable deterministic clock/ID sources, complete examples, round trips, duplicate-command/no-duplicate-side-effect fake behavior, and cross-project rejection scenarios. These tests specify required future adapter behavior; they do not claim production idempotency or filesystem security exists in Milestone 0.

The exported boundary names, version rules, ID brands, error categories, immutable digest coverage, and file ownership above are frozen for downstream work. No unresolved blocker remains in this contract definition. Implementer questions about unenumerated internal fields are resolved through one written architect/lead clarification, with affected consumers informed before continuation. M0.5 and M0.9 remain mandatory gates for persistence/failure semantics and independent review.
