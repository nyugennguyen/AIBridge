# AIBridge current-state inventory (M0.1)

Status: baseline inventory only. This records the pre-orchestration implementation and migration obligations; it introduces no new contracts or behavior.

## Baseline and scope

- Branch: `aibr-v2`.
- Pre-existing untracked user files: `.github/workflows/publish.yml` and `tests/unit/release/`; neither was changed.
- `bun run typecheck`: exit 0 (`tsc -p tsconfig.json --noEmit`).
- `bun test`: exit 0; `457 pass`, `0 fail`, `826 expect() calls`, 30 files (Bun 1.3.14).
- `bun run build`: exit 0 (`rm -rf dist && tsc -p tsconfig.build.json`).
- Product context: the successor is a Tailscale-private terminal-native orchestrator. Current bearer-token and project authorization must remain compatible during migration.

## Current ownership map

| Current type/shape | Source path (owner) | Exposure or persistence |
| --- | --- | --- |
| `BridgeConfig`, `AgentConfig`, `AllowedSource`, `ProjectConfig`, `PlanMetadata`, `RemoteDependency`, `TriggerRequest`, `TriggerResponse` | `src/config/schemas.ts` (Zod); aliases in `src/config/types.ts` | Config JSON, HTTP request/response, job trigger snapshot |
| `JobStatus`, `JobRecord`, dependency/report/callback state types | `src/jobs/types.ts`; lifecycle owner `src/jobs/manager.ts` | One JSON file per job under `<stateDir>/jobs/<job-id>.json` |
| `JobStore`, `JsonFileJobStore` | `src/jobs/store.ts` | File-backed job repository |
| `TaskStatus`, `TaskEntry`, `TaskGraphSyncer` | `src/tasks/types.ts` | Parsed/rewritten `<stateDir>/tasks.md` |
| `Decision`, `Handoff`, `MemoryStore`, private `MemoryData` | `src/memory/types.ts`, `src/memory/store.ts` | `memory.json` with project ID and arrays |
| OpenCode session, status, permission, event, policy, and client interfaces | `src/opencode/types.ts` | OpenCode adapter/event boundary; no AIBridge session file |
| `ReportCallback` | `src/callback/types.ts` (inferred from schema) | Outbound `POST /report` JSON |
| `AgentRegistry`, `CapabilityRouter` | `src/registry/types.ts`, `src/registry/router.ts` | In-memory registry sourced from config `agents` |
| `AuthProvider`, bearer validation | `src/security/auth-provider.ts` | Authorization boundary for `/trigger` and `/report` |
| Source and project authorization decisions | `src/security/source-authorization.ts`, `src/security/allowlist.ts` | Config `allowed_sources` and `projects` |
| `ProfilePaths`, profile config/secrets | `src/host/paths.ts`, `src/host/profile-store.ts` | XDG directories; config/secrets are 0600 |
| `AppDependencies`, `BridgeOptions`, `BridgeInstance` | `src/server/app.ts`, `src/bridge.ts` | Dependency/startup composition; not persisted |

## Configuration and state formats

### Profile/config JSON

`src/config/schemas.ts` requires: `agent_id`; `bridge.host`, `bridge.port`, `bridge.public_url`; `opencode.base_url`, `server_port`, defaulted `username`, `password_env`; `security.auth_mode` (currently literal `bearer-token`) and `allowed_sources[]` (`source_agent_id`, `capabilities[]`, `requires_plan_approval[]`); `permissions.default_response`, `allow_tools[]`, `require_plan_approval_for_tools[]`; `projects[]` (`id`, `path`, `capabilities[]`); `agents[]` (`id`, `url`, `capabilities[]`); `timeouts.default_job_seconds`, `callback_retry_attempts`; `planning.plan_annotator_enabled`, `require_approval_for[]`. Examples: `config/dev-main.example.json`, `config/test-vps.example.json`.

`loadConfig()` parses with Zod. `writeConfig()` validates and atomically writes 0600 JSON without secrets. `AIBRIDGE_CONFIG` selects the file; `AIBRIDGE_BEARER_TOKEN` is required at startup, while OpenCode password is injected from the configured environment key. XDG profile paths and symlink/traversal checks are owned by `src/host/paths.ts` and `src/host/profile-store.ts`; directories are 0700 and secret files are separate write-once 0600 files.

### Job JSON

`JsonFileJobStore` persists `JobRecord` verbatim as pretty JSON at `<stateDir>/jobs/<id>.json`; it loads every `*.json` file and performs no runtime schema/version validation. A record contains `id`, complete `trigger` (including prompt and callback URL), `status`, optional OpenCode session ID/error, local `depends_on[]`, `remoteDependencies[]`, callback delivery state, blocked timestamp, and ISO creation/update timestamps. Writes use temp-file then rename; there is no event history or optimistic concurrency.

### Task Markdown

`FileTaskGraphSyncer` owns `<stateDir>/tasks.md`. It parses headings `## #N Title [agent:X] [status:...] [needs: #M]` and `- key: value` metadata, then rewrites the whole file. Watching is a no-op. This is a compatibility projection, not an audit log.

### Memory JSON

`FileMemoryStore` owns `memory.json` with `{projectId, decisions, constraints, handoffs}`. Decisions are `{id,timestamp,agent,content}`; handoffs are `{id,from,to,context,status,createdAt}`; constraints are strings. Missing, malformed, or unreadable data is broadly caught and replaced by empty in-memory defaults. Writes are whole-file, non-atomic, and unversioned. This store is not wired into `startBridge()`.

## POST /trigger flow and trust boundaries

1. `src/server/app.ts` creates Fastify with a 1 MiB body limit and injected managers/adapters. `/trigger` authenticates `Authorization: Bearer ...` with constant-time comparison.
2. `triggerRequestSchema.safeParse()` validates source/target IDs, capability, project path, prompt, callback URL, timeout, optional client job ID, dependencies, task ID, and plan metadata.
3. The target must equal local `config.agent_id`; `assertSourceAuthorized()` checks source/capability; `assertProjectAllowed()` requires exact resolved-path equality; plan review checks configured gated capabilities. These are the remote-input authorization boundary.
4. OpenCode health is checked before state creation. Examples bind OpenCode to loopback and AIBridge to a Tailscale address.
5. `JobManager.createJob()` chooses supplied `job_id` or `job_<randomUUID>`, rejects duplicates, and persists the complete trigger. This is the first durable mutation.
6. Dependencies are resolved. Missing local dependency IDs return 400. Incomplete/remote dependencies mark the job and task `blocked`, return 202, and create no session.
7. Immediate jobs create an OpenCode session, persist its ID, send the prompt, persist `running`, sync task `running` with Job/Session metadata, and return 202. Detached monitor errors mark the job failed.
8. `src/bridge.ts` monitor waits for idle via events or polling, replies to permission requests through `StaticPermissionPolicy`, marks completed/failed, syncs task done/failed, unblocks and launches dependents, then reports terminal status.
9. Terminal reports are sent to the original callback URL with the bearer token and configured retries; delivery state is persisted separately. `POST /report` authenticates/validates a remote report, checks source allowlisting, records matching remote dependency status, and may launch unblocked jobs.

Ownership consequence: job JSON is the workflow source of truth; task Markdown is a projection; OpenCode session state is external; callbacks are outbound best-effort side effects; memory is separate and currently unwired.

## Compatibility decisions

| Legacy surface | Decision | Migration obligation |
| --- | --- | --- |
| Profile config JSON/fields | **Keep readable; translate** | Add explicit version and diagnostics later; never widen allowlists implicitly. |
| Bearer token and `auth_mode: bearer-token` | **Keep compatibility mode; deprecate** | Preserve source and project checks; never persist/log token values. |
| Job JSON and original `job_id` | **Keep readable; translate** | Map one legacy job to one run, task, and dispatch attempt; retain job ID as external correlation ID. |
| Imperative `JobStatus` | **Translate** to versioned events/projections | Preserve terminal and callback-delivery semantics; retries become new dispatch attempts. |
| `POST /trigger`, `POST /report` | **Keep behind translation; deprecate** | Preserve authorization, correlation, and practical 401/403/404/409/202 behavior. |
| `GET /jobs/:id` | **Keep legacy query; translate** | Resolve original ID through canonical run/task projection during migration. |
| Task Markdown and `task_id` | **Keep temporarily; translate** | Preserve `#N` IDs/status metadata; do not treat rewrites as audit history. |
| `memory.json` | **Keep readable; translate** | Add versioning, validation, provenance, redaction, retention, and visible corruption handling. |
| OpenCode SDK/session IDs | **Keep behind adapter; replace as domain vocabulary** | Distinct opaque canonical dispatch/session IDs; preserve legacy correlation. |
| Static permission policy/plan metadata | **Translate and narrow** | New safety floor can only deny/restrict; approvals must bind immutable content/digest. |
| Config registry/router | **Keep compatibility source; translate** | Map agent entries to node/runtime capability inventory; retain Tailscale boundary. |
| tmux/profile state and local sessions | **Keep; wrap** in TerminalBackend | Preserve durable sessions; terminal streams remain separate from orchestration history. |

## Known gaps and assumptions

- Current persisted JSON has no schema version, event sequence, actor/correlation/causation, controller epoch, idempotency key, or migration marker.
- Job persistence and OpenCode/callback side effects are not transactional; crash and duplicate-delivery semantics are implicit.
- Current exact lexical path equality narrows the API surface, but it does not resolve symlinks and therefore is not a complete filesystem authorization check; canonical execution must use realpath containment and symlink-escape defenses.
- `/report` validates source existence but does not verify a known job or capability relation.
- `waitForIdle()` falls back on any subscription error; unknown status is not treated as success.
- Memory corruption is silently treated as empty state; migration needs backup/rollback and visible corruption.
- Default terminal reports contain empty findings/artifacts; richer provenance is future work.
- No automatic controller election exists or is assumed; future leases must be explicit and reject stale epochs.
