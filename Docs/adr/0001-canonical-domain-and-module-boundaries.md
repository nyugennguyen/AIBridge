# ADR 0001: Canonical domain language and module boundaries

Status: accepted for the Milestone 0 contract freeze (M0.2).

Contract family: `aibridge.orchestration`, schema version `1`.

Inputs: [product brainstorm](../aibridge-tui-agent-orchestrator-brainstorm.md), [M0 plan](../implementation-plans/milestone-0-architecture-and-migration.md), and [baseline inventory](../architecture/milestone-0-current-state-inventory.md).

## Context and decision

The existing bridge uses “agent” for a configured remote endpoint and “job” for a combined request, execution, dependency, and callback record. Reusing either term in the new domain would hide the distinction between a machine, an installed runtime, requested work, and an execution attempt. New contracts use the terms below. Existing public endpoints, files, and TypeScript modules retain their legacy vocabulary behind explicit translation.

The orchestration domain is provider-neutral and independent of a TUI, HTTP server, runtime SDK, terminal backend, and storage engine. Zod schemas own every new serialized shape; TypeScript data types are inferred from those schemas. Service interfaces may be handwritten, but cannot create competing data definitions.

## Vocabulary, ownership, and consistency boundaries

| Canonical term | Meaning and identity | Owner and boundary |
| --- | --- | --- |
| Mesh | An administratively enrolled collection of AIBridge nodes in one private tailnet; `MeshId`. Reachability is not enrollment. | Mesh membership/identity service. Enrollment, revocation, and authenticated identity belong here. A mesh grants no implicit project access. |
| Node | One enrolled daemon identity; `NodeId`. A node can host worker functions, controller functions, or both. Hostnames, IP addresses, URLs, and legacy agent names are attributes or external references. | Node daemon owns local installation discovery, project-path validation, session/process ownership, terminal access, inbox/outbox, and secrets. |
| Project | A security and context boundary; `ProjectId`, scoped to one mesh. A project maps to explicit `ProjectPathId` bindings on particular nodes. | Project configuration owns path bindings, role/rule versions, memory visibility, and authorization. A run cannot widen this boundary. |
| Run | One attempt to achieve a user goal within one project; `RunId`. | The current controller owns the task graph and authoritative event order. A run is the transaction/stream consistency boundary for orchestration changes. Completed history is immutable; cloning creates a new run. |
| Task | Desired work and dependency requirements inside exactly one run; `TaskId`. | Run-owned entity. Dependencies refer to canonical task identities in that run. Legacy cross-run/remote dependencies remain explicit compatibility references until safely resolved; they must not silently become local task edges. |
| Dispatch | One immutable execution proposal/attempt for a task, one installation, one node, one project path, and one approved envelope; `DispatchId`. | Run-owned entity. Attempt numbers are positive, monotonic within a task, and never reused. Retries and changed proposals receive new dispatch IDs/attempts; rejected or unlaunched attempts may consume numbers. |
| Approval | An auditable decision bound to a specific dispatch ID and exact envelope digest; `ApprovalId`. | Run-owned entity. Records the authenticated user or explicitly enabled project rule/version, decision, time, and digest. Imported legacy plan annotations are evidence, not canonical approval authority. |
| Session | The canonical identity of a live or recoverable runtime execution instance; `SessionId`. | Run owns its normalized projection and dispatch relation; the target node exclusively owns the process and runtime handle. Restoring the same execution retains its session ID. New execution/retry receives a new session ID. Version 1 permits at most one session per dispatch. |
| Role | A versioned instruction/capability/context-selection template; `RoleId` plus positive version. | Project configuration owns immutable versions. A dispatch embeds the complete effective role snapshot; changes affect future proposals. A role is not a runtime, user, node, or running session. |
| Rule | A versioned predicate and restrictive policy/approval effect; `RuleId` plus positive version. | Project configuration owns immutable versions. Evaluation intersects restrictions in order: system floor, project rules, role, dispatch. Only an explicitly enabled project rule may pre-approve permitted work. Version 1 has no general script evaluator. |
| Memory | A scoped, attributable context record; `MemoryId`. Kinds: decision, constraint, finding, handoff, summary, artifact reference, user correction, run outcome. | Project memory service owns records and acceptance/supersession. Every record has a project; optional run/task/session scope narrows visibility. Agent proposals start untrusted. Supersession preserves earlier records. Run events reference the accepted versions used as context. |
| Artifact | Metadata identifying an immutable produced content object; `ArtifactId`, content digest, size, media type, and provenance. | Project artifact service owns indexing/access/retention; a producing run/dispatch/session supplies provenance. Local paths or download locators do not grant authority. Bytes are stored outside orchestration events. |
| Controller Lease | A run-scoped fencing record naming the controller node, monotonically increasing epoch, issuance, and expiry; `LeaseId`. | Run authority service owns atomic epoch/lease changes. Workers durably enforce the accepted epoch and expiry. A controller is a temporary role of a node, never another “agent” identity. No automatic election. |

Auxiliary identities are `InstallationId` (runtime installation on a node), `TerminalId` (durable terminal on a node), `TerminalClientId` (authenticated attachment client), `UserId`, `EventId`, `CommandId`, and `CorrelationId`. A runtime kind is an extensible capability selector such as `opencode`, not an identity or a domain union locked to current providers.

The run consistency boundary does not make the controller the owner of worker processes or project administration. Worker observations enter a durable outbox, are authenticated/reconciled, and then receive a run sequence when accepted. Cross-service operations use explicit references and later durable side-effect delivery; there is no implied distributed transaction. M0.5 defines exact transaction, receipt, epoch, and recovery semantics before introducing repository interfaces. M0.3 must not invent an event-store repository API.

## Lifecycle and authority

- Run states: `draft`, `active`, `paused`, `completed`, `failed`, `cancelled`.
- Task states: `pending`, `blocked`, `ready`, `running`, `completed`, `failed`, `cancelled`.
- Dispatch states: `proposed`, `approved`, `rejected`, `queued`, `running`, `completed`, `failed`, `timed_out`, `cancelled`.
- Runtime/session states: `starting`, `idle`, `working`, `blocked`, `completed`, `failed`, `unknown`.
- Approval decisions: `approved`, `rejected`. An undecided dispatch has no decision record; changing content makes earlier approvals inapplicable.

These are vocabulary/schema contracts, not a Milestone 0 state-machine implementation. Reliable completion evidence is required before translating a session observation into task success. `idle`, disconnect, timeout, missing metadata, and terminal screen matching never imply success. Callback delivery is a separate compatibility status, not a runtime lifecycle state. Existing terminal sessions survive TUI/controller disconnection; an expired lease prevents new orchestration effects but does not automatically kill processes.

System-floor restrictions cannot be relaxed by roles, rules, migration, adapter capabilities, terminal input, or approvals. Project authorization and resolved path checks happen again on the worker immediately before any process operation. Approval is necessary where required but is not sufficient authorization.

## Legacy vocabulary and migration rules

| Legacy spelling | Canonical interpretation | Required preservation |
| --- | --- | --- |
| `agent_id`, `source_agent_id`, `target_agent_id`, registry `agents[]` | Legacy endpoint identity resolved through an explicit mapping to a node | Keep the original strings and original allowed-source/capability restrictions; never equate possessing a token with being the claimed node. |
| `job_id`, `JobRecord` | One source record maps to one run, one task, and one dispatch attempt | Keep the job ID in a namespaced external reference and keep the complete authorization/status/callback evidence. Never cast it to `RunId` or `TaskId`. |
| OpenCode session ID | Provider-local handle in runtime adapter metadata | Assign a distinct canonical `SessionId`; preserve provider handle for restore/correlation only. |
| Markdown `task_id` such as `#3` | Legacy task projection identity | Preserve as an external reference, not a canonical task ID or event sequence. |
| Memory `agent`, `from`, `to` | Unverified legacy author/recipient labels | Preserve provenance as legacy evidence; do not invent authenticated users/nodes. |
| Plan `approved_by`/`approved_at` | Legacy plan review annotation | Do not manufacture a digest-bound approval or permission expansion. Imported execution history may be represented without granting permission to resume. |

New domain exports must not define `AgentId`, generic `Job`, or another unqualified `TaskStatus` shared with the legacy module. UI copy may say “agents” collectively, but code must distinguish installations and sessions. `AgentRuntimeAdapter` remains the explicitly provider-neutral interface name from the brainstorm.

## Frozen file layout and task ownership

This is the exact M0.2–M0.8 layout. A listed directory is not permission to create alternative modules. Tests import direct module paths with `.js` extensions; no new barrel exports or package dependency changes are required. Any additional file or shared export requires a recorded lead/architect amendment before affected tasks continue.

| Task | Exact files owned |
| --- | --- |
| M0.2 | `Docs/adr/0001-canonical-domain-and-module-boundaries.md`; `Docs/adr/0002-versioned-contracts-and-adapter-boundaries.md` |
| M0.3 | `src/orchestration/identifiers.ts`; `src/orchestration/schemas.ts`; `src/orchestration/types.ts`; `src/orchestration/errors.ts`; `src/orchestration/digest.ts`; `tests/contracts/orchestration-schemas.test.ts` |
| M0.4 | `src/runtime/schemas.ts`; `src/runtime/types.ts`; `src/terminal/schemas.ts`; `src/terminal/types.ts`; `tests/contracts/runtime-terminal-contracts.test.ts` |
| M0.5 | `Docs/adr/0003-event-store-and-idempotency.md`; `Docs/adr/0004-controller-leases-and-recovery.md` |
| M0.6 | `Docs/security/milestone-0-threat-model.md` |
| M0.7 | `src/orchestration/legacy/schemas.ts`; `src/orchestration/legacy/types.ts`; `src/orchestration/legacy/migration.ts`; `tests/contracts/legacy-migration.test.ts`; `tests/contracts/fixtures/legacy/config.json`; `tests/contracts/fixtures/legacy/jobs.json`; `tests/contracts/fixtures/legacy/tasks.md`; `tests/contracts/fixtures/legacy/memory.json`; `Docs/architecture/milestone-0-legacy-migration.md` |
| M0.8 | `tests/contracts/helpers.ts`; `tests/contracts/fakes.ts`; `tests/contracts/conformance.test.ts`; `tests/contracts/examples.test.ts`; the exact example files in the following paragraph |

M0.8 canonical example files are `tests/contracts/examples/mesh.v1.json`, `node.v1.json`, `project.v1.json`, `run.v1.json`, `task.v1.json`, `dispatch.v1.json`, `approval.v1.json`, `session.v1.json`, `role.v1.json`, `rule.v1.json`, `memory.v1.json`, `artifact.v1.json`, `controller-lease.v1.json`, `event.v1.json`, and `command.v1.json`, all in that same `examples/` directory. The root owns the final `Docs/implementation-reports/milestone-0-completion.md` and integration; M0.9 supplies independent findings to the root. M0.4's initial type/fake smoke cases stay local to its own test file; M0.8 owns reusable fake adapters and conformance fixtures later.

`identifiers.ts` owns branded ID schemas/types and scalar version/time/digest validation. `schemas.ts` owns domain serialized data; `types.ts` infers/re-exports its types. `errors.ts` owns the shared typed error schema and `Result<T>` interface used by both adapters. `digest.ts` owns canonical JSON encoding and dispatch-envelope hashing only. Runtime/terminal schemas own their own serialized boundary data and may import domain scalars; domain files cannot import runtime/terminal files. Legacy translation may import domain contracts, but domain modules never depend on legacy modules.

## Terminology review and unresolved issues

This is an explicit terminology self-review, separate from the later independent M0.9 audit:

1. Machine/endpoint identity is always Node, installed product is Installation, and one execution is Session. No canonical “agent” ID remains.
2. Goal, requested work, and concrete attempt have separate Run/Task/Dispatch IDs. Retries do not rewrite task identity or a prior attempt.
3. Approval authorizes one immutable envelope, not a mutable task or role template. Imported approval text cannot become execution authority.
4. Run-owned session projection and node-owned runtime process are different ownership responsibilities; restore does not transfer process ownership.
5. Project is the cross-node authorization boundary, while a node-specific project path is an explicit binding. A shared project name does not authorize an arbitrary path.
6. Controller is a leased role, so takeover changes lease/epoch, not the meaning of node/session identity.
7. Legacy “job” retains only compatibility meaning. Callback success/failure stays distinguishable from task outcome.

No blocking terminology or aggregate-ownership issue remains. Detailed durable transaction mechanics and safe manual takeover are assigned to M0.5; concrete authentication/enrollment and streaming transport are later milestone implementations under these boundaries. The independent reviewer must still validate this vocabulary at the M0.9 gate. This document does not claim that a self-review satisfies that independent gate.

## Downstream contract freeze

M0.3 and M0.4 may implement the definitions in this ADR and ADR 0002 in parallel under exclusive path ownership. M0.5 must consume the completed M0.3 schemas; M0.6 and M0.7 follow their declared dependencies. Written challenges go to the lead and architect. A change to canonical vocabulary, serialized fields used across modules, transaction assumptions, or these filenames requires stopping affected work, updating the ADR, and explicitly rebasing dependent tasks. No implementation agent may create a competing contract.
