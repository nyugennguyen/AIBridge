# Milestone 0 legacy compatibility and migration map

Status: M0.7 contract and dry-run design. This document defines migration behavior before a file reader, SQLite importer, route adapter, or destructive upgrade command exists.

Depends on [ADR 0001](../adr/0001-canonical-domain-and-module-boundaries.md), [ADR 0002](../adr/0002-versioned-contracts-and-adapter-boundaries.md), [ADR 0003](../adr/0003-event-store-and-idempotency.md), [ADR 0004](../adr/0004-controller-leases-and-recovery.md), and the [current-state inventory](./milestone-0-current-state-inventory.md).

## Scope and invariants

`dryRunLegacyMigration()` is a pure planner over already-read values. It does not inspect the filesystem, rewrite a profile, modify JSON jobs, rewrite `tasks.md` or `memory.json`, open the target database, create an event, enqueue work, contact OpenCode, or send a callback. M0.7 intentionally provides no commit implementation.

The following invariants are mandatory for a later importer:

- Existing unversioned profiles remain readable through the separately named legacy schemas. Canonical parsers continue to reject missing versions.
- `auth_mode: bearer-token` remains a compatibility-only transport check. Token material is neither an input to nor an output from the plan and is never copied into canonical records.
- Possessing the shared bearer token never proves `source_agent_id`. The exact legacy `allowed_sources` entries and capabilities remain authoritative compatibility evidence until authenticated node identity replaces them.
- Project authorization remains exact resolved-path equality. An import mapping must preserve the configured path and bind it to the explicitly mapped local node; it cannot broaden a path to a parent directory or wildcard.
- One valid legacy job maps deterministically to exactly one Run, one Task, and dispatch attempt 1. Original job, task, agent-label, remote-job, callback, and provider-session strings remain namespaced external evidence; none is cast to a canonical branded ID.
- No imported record is executable. Active jobs are paused evidence and every planned dispatch has `executionPolicy: inert`. Resume requires reconciliation, current source/project/capability checks, a current controller lease and fence, and a fresh digest-bound approval where policy requires one.
- Legacy `approved_by`, `approved_at`, and `plan_status` fields do not produce an Approval. They are evidence only.
- Local and remote legacy job dependencies remain explicit compatibility references. They do not become canonical Task edges because one legacy job maps to one Task in its own Run, and canonical Task dependencies cannot cross Runs. A missing or self-referential local dependency stops the plan; a present dependency is retained with a diagnostic for later compatibility projection/reconciliation.
- Callback delivery is not task outcome. A completed job with a failed callback stays completed and retains the failed delivery record. The ambiguous legacy `callback_failed` job status becomes paused/blocked/proposed evidence pending operator reconciliation.
- Memory agent/from/to strings remain unverified `legacy.agent-label` references. Imported memory is `proposed`, never automatically trusted.

## Inputs and explicit mappings

The source bundle contains the parsed legacy profile config, an array representing the individual job JSON files, raw task Markdown, and legacy memory JSON. The future filesystem reader must retain each original file path, metadata, and byte digest in its import journal; the M0 fixture bundle only supplies content contracts.

The operator supplies an explicit context containing:

- a stable source-profile ID, distinct from a filesystem path or display name;
- mesh, controller node, epoch, and import timestamp;
- the historical path-resolution base used by the legacy service;
- one-to-one legacy-agent to Node/Installation/runtime mappings; and
- one-to-one legacy-project to Project/ProjectPath mappings with the exact configured path and target node.

Node identity is never inferred from an agent spelling, URL, IP address, Tailscale hostname, token, or reachability. Project identity is never inferred from a directory basename. Missing, duplicate, path-changing, or node-changing mappings stop the plan.

Deterministic Run, Task, Dispatch, Role, and Memory IDs and job import keys are SHA-256-derived from a fixed migration namespace plus the stable source profile, legacy local-node label, legacy project ID, record kind, and stable record key. They do not depend on record content or `importedAt`. Thus identical job IDs in different profiles/projects do not collide, while content edits and a later dry-run timestamp retain identity.

The plan separately calculates a material mapping fingerprint from the stable source-profile ID, legacy configuration digest (including the authorization snapshot), mesh/controller/epoch, normalized path-resolution base, and order-normalized agent/project mappings. It excludes `importedAt`. The import journal must compare both source digest and mapping fingerprint: changed source content, compatibility policy, or canonical mapping under the same stable import key conflicts instead of silently rewriting prior mappings. Reordering equivalent explicit mapping arrays or rerunning at a later wall-clock time does not create a false mapping change.

## Surface mapping

| Legacy surface | Canonical mapping | Preserved compatibility evidence |
| --- | --- | --- |
| Profile `agent_id` and `agents[]` | Explicit Node and Installation mappings | Original labels, URLs and capabilities remain legacy config evidence; they grant no node identity. |
| `security.auth_mode` | Compatibility transport mode only | Literal `bearer-token`; token bytes are not imported. |
| `security.allowed_sources[]` | Compatibility authorization snapshot | Exact source labels, capabilities, and `requires_plan_approval` arrays; no wildcard/default grant. |
| `projects[]` | Explicit Project/ProjectPath mapping | Original and resolved configured path plus capability list. Exact path equality is required. |
| Trigger/job | One Run, one Task, one Dispatch attempt | Complete job digest, original job ID, source/target/capability/path/prompt, plan annotations, callback URL, timeout, status, error and timestamps. Sensitive callback credentials are unsupported. |
| Local dependency | No canonical edge across per-job Runs | Original `legacy.job` reference and compatibility diagnostic. Missing/self dependencies stop the plan. |
| Remote dependency/report | No canonical local Task edge | `legacy.remote-job` reference, terminal report status, and reported time. |
| OpenCode session ID | Provider correlation only | `opencode.session` external reference; a future reconciler allocates/restores a distinct canonical Session. |
| `tasks.md` entry | Link to the job-created canonical Task | Original `#N`, title, status, dependencies, agent label and metadata remain projection evidence. Unmatched or ambiguous tasks stop the plan rather than invent a Run/Project owner. |
| Memory decision | Proposed project-scoped `MemoryRecord(kind=decision)` | Original decision ID, timestamp, content, and unverified agent label. |
| Memory constraint | Proposed project-scoped `MemoryRecord(kind=constraint)` | Original array position and content. Legacy constraints are not silently promoted to system-floor policy. |
| Memory handoff | Proposed project-scoped `MemoryRecord(kind=handoff)` | Original ID, from/to labels, status, context and creation time. |
| `/trigger` | Later compatibility adapter to the same one-task run mapping | Preserve practical validation and 401/403/404/409/202 behavior; recheck source, exact project path, capability, approval policy and target before any effect. |
| `/report` | Later compatibility observation adapter | Authenticate, preserve source/job correlation and report status, deduplicate durably, and never infer task success from callback delivery. |
| `GET /jobs/:id` | Later legacy projection lookup through `legacy.job` | Preserve the original job view and callback state without making job ID canonical. |

## Status translation

Status translation preserves historical meaning while separately preventing execution:

| Legacy job status | Run | Task | Dispatch | Import disposition | Reason |
| --- | --- | --- | --- | --- | --- |
| `received` | `paused` | `pending` | `proposed` | `paused` | No durable execution evidence. |
| `accepted` | `paused` | `ready` | `proposed` | `paused` | Acceptance was not digest-bound approval. |
| `blocked` | `paused` | `blocked` | `proposed` | `paused` | Dependency state is retained; no effect is scheduled. |
| `session_created` | `paused` | `running` | `running` | `paused` | Provider session may exist and requires reconciliation. |
| `running` | `paused` | `running` | `running` | `paused` | Work may still exist on its owning node. |
| `reporting` | `paused` | `running` | `running` | `paused` | Runtime outcome and callback stage require reconciliation. |
| `completed` | `completed` | `completed` | `completed` | `historical` | Terminal runtime outcome is preserved. Callback delivery remains separate. |
| `failed` | `failed` | `failed` | `failed` | `historical` | Terminal runtime failure is preserved. |
| `timed_out` | `failed` | `failed` | `timed_out` | `historical` | Timeout remains distinct at Dispatch level. |
| `callback_failed` | `paused` | `blocked` | `proposed` | `paused` | The legacy spelling cannot prove a runtime outcome; callback failure is preserved separately. |

An authorization mismatch changes the disposition to `rejected`, leaves the Run paused and Task blocked, and gives the requested capability an explicit deny in the inert envelope. It does not erase the source record. A migration dry run containing any error has `canCommit: false`.

## Forward migration protocol

A later commit implementation must use this order:

1. Stop legacy mutations or capture a consistent point-in-time source snapshot. Record file paths, permissions, owners where relevant, lengths, and cryptographic byte digests. Never follow an unapproved symlink or read outside the selected profile/state roots.
2. Back up the entire legacy profile/state set before any target write. Back up any existing target SQLite database using SQLite's supported online backup mechanism, including consistency verification; copying only its main file while WAL writes continue is not a backup.
3. Parse through the frozen legacy schemas and run this dry plan. Require an explicit operator review of warnings, mappings, source digests, mapping fingerprint, rejected/unsupported records and the authorization snapshot. `canCommit: false` cannot be overridden by a force flag.
4. Open the authoritative target store under ADR 0003/0004 fencing rules. Verify no conflicting import key exists. Exact source and mapping fingerprints return the recorded prior result; a changed source digest or material mapping fingerprint under the same key is a conflict.
5. Import one source record per short transaction. Atomically commit its deterministic mapping, inert domain records/projections, migration-journal entry, and corresponding `legacy.imported` evidence with its sequence range. Do not create an execution outbox entry. Larger imports are resumable per record and never claim whole-import atomicity.
6. Re-read and verify committed records, sequence continuity, journal digests, external references, authorization snapshot, and counts. Keep compatibility reads pointed at legacy state until verification succeeds.
7. Switch reads through an explicit, reversible profile marker only after verification. Keep legacy files read-only and retained for the documented rollback window. Removing compatibility mode is a separate reviewed migration.
8. Reconcile paused sessions and ambiguous outcomes on the owning node. Only a new, currently authorized command under a current lease may cause an effect. Never replay a legacy prompt merely because the imported projection is incomplete.

## Failure recovery and rollback

| Failure point | Recovery |
| --- | --- |
| Source read or validation fails | Do not write target state. Preserve source and diagnostics. Repair or explicitly exclude an unsupported record in a newly reviewed plan. |
| Backup cannot be verified | Stop. Migration is not allowed without a restorable source and target backup. |
| Crash before a per-record transaction commits | No record is imported. Rerun the same plan and import key. |
| Commit result is uncertain | Reopen the authoritative store and resolve the migration-journal key/digest before retrying. Never append only the apparently missing event. |
| Exact record delivered twice | Return the stored mapping and sequence range. Do not allocate new IDs or events. |
| Same import key with changed source digest or mapping fingerprint | Report conflict and retain the first immutable import. Correct the source/mapping or use a separately reviewed superseding migration; never overwrite history. |
| Crash between records | Resume from verified journal entries. Already committed records remain inert and are not replayed. |
| Verification fails before cutover | Leave compatibility reads on legacy state, quarantine the partial target generation, and resume or restore the target backup. Source files remain unchanged. |
| Failure after read cutover but before any new canonical mutation | Revert the profile marker and reopen the verified legacy files; retain target records for diagnosis. |
| Failure after canonical commands/events, a higher lease epoch, or worker effects exist | Do not roll back by restoring an old database or decrementing an epoch. Freeze mutations and follow ADR 0004 recovery/reconciliation. Legacy files may be used as evidence, not promoted to a new authority. |

Rollback is therefore a read-path/profile switch only while the verified pre-cutover fence remains valid and no newer authoritative mutation exists. Filesystem replacement, deleting migration receipts, truncating events, restoring a stale authority database, resetting an epoch, or relaunching a legacy job are forbidden rollback techniques.

## Unsupported and corrupt cases

The dry run fails closed for:

- unknown auth modes, schema versions, job statuses, task statuses, callback statuses, or unrecognized record fields;
- malformed JSON supplied to the future reader, invalid URLs/timestamps, impossible timestamp order, duplicate job/task IDs, or a trigger job ID that differs from its file record ID;
- missing/duplicate agent or project mappings, changed project paths, changed target-node bindings, or memory scoped to an unmapped project;
- jobs whose target is not the local legacy agent, whose source/capability is not allowed, whose exact resolved project path is absent, or whose required legacy plan annotation is not approved;
- missing/self-referential local dependency jobs, ambiguous task-to-job links, and task entries that cannot be scoped to an imported job/run;
- oversized fields/collections, and source or material-mapping changes under an already committed import key;
- credentials in callback URLs, bridge/OpenCode URLs, or registry agent URLs, including URL userinfo and known credential-bearing query/fragment keys; diagnostics identify only the field path and never echo the URL or secret;
- active/ambiguous work that a caller attempts to mark executable, legacy plan annotations offered as canonical Approval, or remote dependencies offered as local Task edges.

Malformed `memory.json` must be surfaced as corruption. The current memory store's behavior of silently replacing unreadable content with empty arrays is not valid migration behavior because it would lose evidence.

## Contract verification

`tests/contracts/legacy-migration.test.ts` reads the four frozen fixtures and verifies:

- legacy formats remain readable;
- one job produces one valid Run/Task/Dispatch with distinct deterministic canonical IDs and `legacy.job` correlation;
- the exact allowed-source and project-path policy is retained while bearer material is absent;
- active and ambiguous work remains inert, terminal outcomes remain distinguishable, and callback delivery remains separate;
- local and remote dependencies remain compatibility references rather than invalid cross-Run Task edges, while provider session references retain their boundary;
- memory imports as proposed evidence with unverified legacy labels;
- exact reruns are deterministic, identities remain stable across content/time changes, stable source namespaces prevent profile collisions, and mapping changes alter a separate fingerprint; and
- unauthorized, credential-bearing, corrupt, unsupported, malformed, self-dependent, out-of-bounds, or incompletely mapped input returns non-committable diagnostics without throwing.

Passing these contract tests demonstrates mapping behavior only. It does not demonstrate filesystem snapshotting, SQLite transaction durability, event append atomicity, command fencing, route compatibility, or a production rollback implementation; those remain later milestone gates.
