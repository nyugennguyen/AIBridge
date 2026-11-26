# Changelog

## [Unreleased]

## [3.2.0] - 2026-11-26

Adds a job API and job CLI (`aibr jobs`, `aibr job`, `aibr cancel`, `aibr attach`), reconciles jobs and cleans up orphaned runtime processes after a bridge restart, and hardens security: the plan self-approval fix, `GET /jobs/:id` and job id hardening, and wider secret redaction of job results. It also removes about 45k lines of unwired code (the TUI leftovers, the rules engine, the dead part of the mesh and the orchestration kernel). The wire format of `/trigger` and `/report` does not change, apart from the new job id validation. Read **Removed** and **Upgrade notes** before upgrading a running node.

### Removed
- **BREAKING: `aibr tui`.** It was a stub since 3.1.1 and is now an unknown command (nonzero exit). Use Claude Code with the AIBridge plugin; on the worker use `aibr jobs pending`, `aibr approve`, `aibr logs -f`.
- **BREAKING: `aibr worker --ipc-publish`.** The flag is now rejected as an unknown flag, so a hand-written service unit that still passes it will not start. Delete the flag from the unit; units generated from 3.1.1 onward do not have it.
- **BREAKING: config `terminal` (`terminal.backend`).** The key is gone from the schema and from `contracts/v1/bridge-config.schema.json`. A profile that still has it keeps loading (the key is ignored) and `loadConfig` logs one warning; delete the key. The warning goes away in 3.3.0.
- These three were no-ops since 3.1.1 and were announced as removed in 3.2.0 (ADR 0014), so this ships as a minor release, not a major: nothing stops working except the failure is now noisier. `/trigger`, `/report`, `/jobs` and the plugin are unchanged.
- **BREAKING (unused): the orchestration kernel and `POST /orchestration/commands`, `POST /orchestration/capability-preview` (3.2.0 block D5, ADR 0016).** Both routes were registered on every bridge, but `aibr serve` never gave them a coordinator, so `/orchestration/commands` could only answer 503, while `/orchestration/capability-preview` did answer 200 with a computed capability envelope to any bearer or operator caller; nothing in AIBridge called either route (their client was the Herdr plugin removed in 3.1.1); they now answer 404. Gone from `src/orchestration` (32 files, about 12.4k lines): the coordinator, scheduler (DAG, fan-out), projections, policy evaluation and approval, the safety floor and immutable core (`policy/floor.ts`, `policy/immutable-core.ts`), charter proposal and repository, the roundtable runtime, the command invariants, and the legacy translation and migration (which also ends the open item of the migration still reading `metadata.plan_status` as approval evidence). Also gone: `src/server/routes/orchestration.ts`, `src/jobs/legacy-projection.ts`, `src/mesh/protocol/negotiation.ts`, `src/notifications/consumer.ts` (it mapped kernel events to notifications), and the unwired leftovers of `src/storage` (backup, restore, outbox repair, projection rebuild) and `src/observability` (structured logger, metrics, signals): 45 files, about 14.2k lines in all. `AppDependencies.orchestration`, the `orchestration` dependency of the ingress drainer, and the notification store, bus and consumer that `startBridge` built and handed to `createApp` (nothing read them) are removed, with the kernel hooks in `/trigger`, `/report`, OpenCode dispatch and the drainer that only ran when a kernel was attached. `GET /jobs/:id` loses its `orchestration.correlation` field, which only a bridge with a kernel attached ever added (never `aibr serve`); auth and the rest of the body are unchanged, and no client (MCP tools, plugin, `aibr job`) read it. Nothing running changes: `/trigger`, `/report`, `/jobs*`, the plugin and `aibr ping` wire formats are the same, and `contracts/v1` and `router/src/contracts.rs` are unchanged (`src/orchestration/schemas.ts`, which they are generated from, stays). What stays in `src/orchestration` is what the runtime reaches (schemas, identifiers, errors, digests, transitions, versioning, charter types, the role snapshot digest used by `runtime/binder.ts`, and `event-store/{schema,sqlite-driver}.ts` used by the egress outbox, the drain worker and the diagnostics integrity check) plus the event store kept for V4. `src/notifications` (bus, store, types) is now unreachable and listed in `scripts/docs/reachability-exemptions.json`: wire by 3.5.0, delete by 3.6.0. Tests of the deleted code went too (32 files, about 17.5k lines), including the integration tests `orchestration-flow`, `orchestration-routes`, `legacy-compatibility` and `notification-app-integration`, `tests/contracts/legacy-migration` and its fixtures, and `tests/security/golden-logs`; tests that also covered kept code lost only their kernel cases. The design stays in the `archive/kernel-mesh-3.1.1` tag.
- **The dead part of `src/mesh` (3.2.0 block D4, ADR 0016).** Controller leases (`lease/`), the node registry and heartbeats (`registry/`), the inbox (`inbox/`), the outbox store, deliverer and ingest (`outbox/` except `policy.ts`), the SSE event gateway and reconciler (`gateway/`), the fault-injection harness (`fault/`), the mesh record families and their registry (`protocol/` except `envelope`, `bounds`, `identifiers` and `negotiation`), and the mesh enrollment flow (`identity/enrollment.ts`, plus the `identity/index.ts` barrel and `identity/time.ts`): 68 files, about 18.9k lines. None was reachable from `aibr` or the bridge, and nothing sent a mesh record over the network. Their tests went too (57 files, about 21.2k lines), including the integration tests `mesh-flow`, `mesh-fault-acceptance`, `controller-takeover`, `remote-roundtable` and the `mesh-fixtures` helper. What stays in `src/mesh` is what pairing, request signing, the egress outbox and the ingress drainer use: `identity/` (node keys, pins, trust, request signatures, replay guard), `protocol/{envelope,bounds,identifiers}` and `outbox/policy.ts`. `protocol/negotiation.ts` stays until block D5 because the unwired kernel coordinator imports it. `contracts/v1`, `router/src/contracts.rs` and the `/trigger`, `/report`, `/jobs` and `aibr ping` wire formats are unchanged. The design stays in the `archive/kernel-mesh-3.1.1` tag.
- **`src/memory/migration.ts` and the TUI egress path (3.2.0 block D3).** The one-off `memory.json` and v1 to v2 memory migration (about 800 lines) and its tests are gone; nothing that stays imported it. The memory-context isolation audit in `src/context/isolation.ts` now lists six egress paths: the `tui_preview` path and the `preview` input of `auditMemoryContext` went with the TUI (removed in 3.1.1). `src/context/preview.ts` stays. `src/memory`, `src/context` and `src/orchestration/event-store` each gained a README that marks them as not yet wired, with their wire and delete deadlines.
- **`src/rules` (3.2.0 block D2, ADR 0016).** The layered rule engine (7.2k lines: compile, evaluate, explain, limits, preview) and `tests/unit/rules` (10.8k lines). Nothing reachable from `aibr` or the bridge imported it. Tests that shared the rules fixtures (`charter-proposal`, `notifications/surface`, `notifications/barrel`) lost only their rules-specific cases; the safety floor itself lives in `src/orchestration/policy/floor.ts` and stays. The design remains in the `archive/kernel-mesh-3.1.1` tag.
- **Unwired leaf modules (3.2.0 block D1, ADR 0016).** `src/simulation`, `src/workflows`, `src/budgets`, `src/routing`, `src/sdk`, `src/upgrade` and `src/registry` (about 11.3k lines) and their tests, plus the integration tests that existed only for them (`automation-safety`, `dry-run`, `rule-preview`, and the `m6-fixtures` helper). None was reachable from `aibr` or the bridge. The design stays in the `archive/kernel-mesh-3.1.1` tag and branch. ADR 0016 is now Accepted; ADR 0004 and ADR 0007 are Superseded by it.

### Upgrade notes
- **`GET /jobs/:id` needs credentials.** It returns 401 without the bearer token, even on nodes with `request_signing: "off"`; a signed peer sees only the jobs it requested (see **Security**). Pollers that read job status anonymously must send the bearer token.
- **`job_id` must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`** (400 otherwise). In-flight work with a caller-chosen id outside that pattern fails after the upgrade. A new id that differs only in case from an existing job gets 409 on every platform.
- **One `aibr serve` or `aibr worker` per profile** (lock file in the state directory). A second one exits with an error instead of running beside the first.
- **Graceful stop ends running Claude Code jobs** as `interrupted: bridge stopped`, and a restart ends jobs that may have started as `interrupted: bridge restarted`. Neither is retried automatically; re-dispatching is the requester's decision.
- **The new job routes and MCP tools need signed requests** (`GET /jobs`, `GET /jobs/:id/events`, `POST /jobs/:id/cancel`, `bridge_events`, `bridge_cancel`). On a node with `request_signing: "off"` only the operator (operator token, on the node) can use them.
- **OpenCode jobs that need approval wait for `aibr approve`** instead of being refused, and a caller can no longer approve its own plan with `metadata.plan_status`. With `ingress_mode: "router"` approval-gated capabilities are still refused.
- **Removed items** (`aibr tui`, `aibr worker --ipc-publish`, config `terminal`): see **Removed** for the one-line migration of each.

### Security
- **`GET /jobs/:id` is no longer anonymous (threat model F-03).** Anyone who could reach port 8787 and knew a job id got the whole record, prompt included. The route now uses the job API's rules: the operator credential (same rules as `aibr approve`, from this host by default) reads any job; a request with a verified node signature reads only the jobs that signer dispatched (`403 not_job_requester` otherwise); an unauthenticated request gets 401, before the job is looked up. An unsigned request with the bearer still reads any job where the node does not ask for signatures. By `security.request_signing`:
  - `required` (the default for new profiles): bearer plus signature; the bare bearer is refused with `401 signature_required`. Paired orchestrators (the MCP tools and `aibr send`/`aibr ping` sign automatically) are unaffected.
  - `optional`: as `required` for signed requests; an unsigned bearer holder (an orchestrator not yet paired) still reads any job.
  - **`off` (older profiles): behaviour change.** The bearer is now required; a request without it, which used to get the record, gets 401. Signatures are not verified on such a node, so any bearer holder still reads any job. Tools that poll `GET /jobs/:id` without the bearer (a hand-written `curl`, a script) must send `Authorization: Bearer <token>`. The plugin, `aibr send`, `aibr ping` and `aibr approve` already do.
  - `auth_mode: "none"` admits every request as a bearer holder, as on `/trigger`.

  The body an authorized caller gets is unchanged. The MCP tools now report a refused status lookup with the fix (`signature_required`, `forbidden`) instead of `status_failed`.
- **Job ids are a strict charset; a job id can no longer write outside the jobs directory (threat model F-01).** `job_id` was any non-empty string and became `<state>/jobs/<job_id>.json`, so a bearer holder could send `../x`. New ids must now match `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` on `/trigger`, `/report` and remote `depends_on` entries (anything else is a 400), in `contracts/v1` and in the Rust router, which now also refuses a leading `-` or `_`. Every id aibr mints matches (`job_<uuid>`, the MCP tools' `<uuid>`, `ping-<uuid>`, the router's hex ids). The job store also refuses any id whose file would leave its directory, never turns an id from a URL into a path (lookups are in memory), and refuses a new id that differs from an existing one only in letter case (`409`, "Job already exists … only in letter case"), because the two would be one file on a case-insensitive filesystem such as macOS's. Jobs stored by older releases whose ids do not match the new charset (for example `task.1`) still load, stay readable by the operator and their requester, and can still change state; a peer still on an older release that reports such an id gets a 400 from an upgraded node.
  - **In-flight work with a caller-chosen id outside the new pattern fails after the upgrade.** A remote-dependency `/report` for such an id gets 400: the sender retries until it gives up, and the dependent job fails once its grace period ends. Router outbox rows admitted before the upgrade with an id starting with `_` or `-` fail in the drainer as `SCHEMA_VALIDATION_FAILED`. Ids minted by aibr (engine, MCP tools, `aibr send`/`aibr ping`, router) are unaffected.
  - **The case-only duplicate 409 applies on every platform, Linux included**: a new id that differs only in case from an existing job is refused even on a case-sensitive filesystem, so a job store moves between machines without two jobs collapsing into one file.
  - Creating a job is atomic in the store: of two concurrent creates of one id, or of ids differing only in case, exactly one succeeds and the other gets 409. Before, both could pass the duplicate check and write the same temporary file, which on macOS could leave a corrupt job file that made every job lookup fail after the next restart. Each write now uses its own temporary file, and a job file that cannot be parsed is reported on stderr and renamed to `<name>.unreadable` instead of stopping the other jobs from loading.
- **Outbound reports to a peer time out after 15 s.** A `/report` POST to a peer that accepted the connection and never answered held the caller until the OS gave up on TCP. It now fails after 15 s (`EGRESS_TIMEOUT`); the outbox row stays `pending` for the next attempt and the job's `callbackDelivery` is `pending` (or `failed` without an outbox), so it is retried as before and never marked delivered. The MCP tools, `aibr ping`/`aibr send` and pairing already had timeouts.
- **A caller could approve its own plan on the OpenCode runtime.** On every runtime other than `claude` (including the default, `opencode`), the plan-approval gate trusted the caller-written `metadata.plan_status: "approved"` in `/trigger`: on the engine ingress, in the router drainer (`aibr worker`), and in the OpenCode tool permission policy, where it answered `always` for the tools in `permissions.require_plan_approval_for_tools`. Any enrolled peer could therefore run an approval-gated capability, and unlock `bash`/`edit`/`write`, without an operator. Approval now comes only from this node's config and an operator's `aibr approve`, recorded in the approval ledger (ADR 0013), as on the Claude runtime. `metadata.plan_status` is still accepted by the schema but grants nothing; the bridge logs a warning when a caller sends `"approved"`.
- **Job results are scrubbed for many more kinds of secret.** Redaction of the Claude result summary, errors, permission-denial previews, stderr tails and script output tails (and so of `runtimeResult`, `GET /jobs/:id` and the `/report` callback) used to catch only `sk-…` keys, `bearer …` values and the node's known secrets. It now also runs the detectors of `src/memory/redaction`: GitHub tokens, AWS access key ids and secret keys, Slack, Google API, Tailscale auth keys, JWTs, PEM private keys (including one whose `END` line was cut off), env-style assignments whose name ends in `PASSWORD`, `PASSWD`, `SECRET`, `TOKEN`, `API_KEY`, `APIKEY`, `ACCESS_KEY` or `PRIVATE_KEY` (`POSTGRES_PASSWORD=…`, `export GITHUB_TOKEN=…`, `api_key: …`; `$VAR` references and code expressions are left alone), the password in `scheme://user:password@host` connection strings, and long random-looking tokens. Only the value is replaced. Commit shas, digests, UUIDs, hex ids, file paths and URLs are left intact. Detection is best-effort: secrets with no recognisable shape (a password in prose, a bare-hex API key) still get through.

### Changed
- **OpenCode jobs that need approval wait for the operator** instead of being refused. A capability listed in `planning.require_approval_for`, or in the source's `allowed_sources[].requires_plan_approval` (which the OpenCode runtime previously ignored), answers `202 {status: "awaiting_approval"}` with an `approve_hint`; run `aibr jobs pending` then `aibr approve <job>` on the worker. `POST /jobs/:id/approve` now launches OpenCode jobs as well as Claude jobs.
- **OpenCode tool permissions follow the operator's approval of the job.** Tools in `permissions.require_plan_approval_for_tools` are allowed only for a job an operator approved. To let ungated jobs use a tool, move it to `permissions.allow_tools`, or gate the capability and approve its jobs.
- An approval-gated OpenCode trigger with `depends_on` is refused with `501 not_implemented` (as on the Claude runtime), because a dependency's report arriving while the job waits for the operator would be lost.
- With `bridge.ingress_mode: "router"` there is no operator approval path, so approval-gated capabilities are refused (`PLAN_APPROVAL_REQUIRED`) whatever the caller sends.

### Added
- **Job CLI: `aibr jobs`, `aibr job`, `aibr cancel`, `aibr attach` (3.2.0 block C).** `aibr jobs [--status s] [--limit n] [--json]` lists this node's jobs with the operator token, like `aibr approve`; `aibr jobs pending` is unchanged. `--all-nodes` asks every peer in `agents[]` with signed requests (the `aibr ping`/MCP path), merges by time with a node column (`--limit` is a total, not per node), prints one line for a peer that fails and still exits 0 unless no peer answered; it needs no local bridge, so it works on an orchestrator node. `--node <peer>` does the same for one peer. A peer lists and cancels only the jobs this node requested. `aibr jobs --watch` refreshes every 2 seconds until Ctrl-C (which also cuts a request in flight; a second Ctrl-C exits at once) (a redraw on a terminal, one line per change otherwise; no alternate screen). `aibr job <id>` shows a job, `--events` prints its events and `-f` follows them (by paging) until the job ends. `aibr cancel <id>` asks first, `--yes` skips the question; without a terminal and without `--yes` it changes nothing and exits 1; it explains 202 (stopping), 409 (`job_finished`, `awaiting_approval` with the `aibr reject` hint, `cancel_in_progress`), 403 and 404. `aibr attach <id>` is `aibr job <id> --events -f` and attaches no terminal. `aibr stop` and `aibr cancel` point at each other in `--help`; `aibr logs` is still the bridge log.
- **`GET /jobs`: list jobs (3.2.0 block B).** Newest first, with `status`, `limit` (default 50, at most 200) and `before` (the `next_before` cursor of the previous page, stable when jobs share a timestamp, or an ISO timestamp). Each line is compact: id, status, capability, source, timestamps, `error`, `awaiting_approval` and `final`; never the prompt or the runtime result. A peer sees only the jobs it dispatched, which needs a signed request (ADR 0012); the operator credential, from this host, sees every job.
- **`GET /jobs/:id/events`: what a job did, in order (3.2.0 block B).** Status changes for every job, and for Claude Code jobs also messages, tool use, script steps and the result. JSON pages `{events, next}` by default (`after`, `limit`); `Accept: text/event-stream` streams them as SSE and resumes after `Last-Event-ID`. Events are stored in `<state>/jobs/<sha256 of the job id>.events.jsonl` (hashed so that ids differing only in case never share a file; the job store never loads them as jobs), redacted like job results before they are written, and capped per job (2,000 lines, 1 MiB), the last line then being a `truncated` event. Job records are never pruned, so neither are these files. Readable by the job's requester or the operator. `final: true` only on a page that reaches the ended job's last event. Followers read only what was appended since their last read, and open streams are capped (64 per bridge, 8 per caller, 16 per job; more answer 429).
- **`POST /jobs/:id/cancel`: a requester ends its own job (3.2.0 block B).** The job ends `failed` with error `cancelled by requester` and its report is delivered as for any finished job; a running Claude Code job's process is terminated as by the kill switch, an OpenCode job's session is aborted. A job awaiting approval answers 409 (the operator rejects it); a finished job answers 409 with its status, so a second cancel is harmless. Cancel is not an approval action and writes nothing to the approval ledger; it is logged to the bridge log with the caller (ADR 0015). Only the requester (by its verified signature) or the operator may cancel (the error then reads `cancelled by operator`); any other peer gets 403. A cancel that arrives while an earlier stop is still ending the job answers 202. Local dependents (`depends_on`) of a job the cancel ends fail at once and are reported, instead of waiting for the sweep. `aibr stop --all-jobs` is unchanged.
- **MCP: `bridge_cancel` works, and `bridge_events` is new.** `bridge_cancel` calls the cancel route instead of answering `not_supported` (it still says `not_supported` for a worker running an older aibr); `bridge_events` reads a job's events a page at a time. Both are described for any MCP orchestrator (Claude Code, Codex, OpenCode). There is still no approve, reject or stop-all tool.
- **ADR 0015 and ADR 0016.** ADR 0015 records that the orchestrator is chosen per project (Claude, Codex or OpenCode, over MCP) and that every node will run `aibr serve`; it amends ADR 0014. ADR 0016 keeps the unwired memory, event store, Codex adapter, context and notifications code with wire and delete deadlines and removes the rest; it is to supersede ADR 0004 and ADR 0007 once block D1 merges, and ADR 0003 stays Accepted with a "not yet wired, deadline 3.3.0" note. No code behaviour changes.
- **Reachability check** (`bun run docs:reachability`, also run by `docs:check`). It walks the imports from `src/cli.ts` and `src/index.ts`, reports unreachable lines per directory and warns when a directory has 500 or more unreachable lines without an entry in `scripts/docs/reachability-exemptions.json`, and fails when an entry is past its wire deadline while its code is still unreachable.

### Fixed
- **A killed bridge no longer leaves Claude Code or a script step working on a job it reports interrupted.** When the bridge was SIGKILLed or crashed, its Claude Code process (and any `pre`/`script`/`post` step) kept running in the repository while the next start reported the job `interrupted: bridge restarted`. Now:
  - every runtime process is recorded right after it is spawned, until it exits: one file per process in `<state>/runtime-processes/` with the job id, the PID, its process group and the PID's start time (read as for the state lock; outside Linux it is added a moment later, without blocking the bridge on `ps`).
  - at the next start, before stale worktrees are swept, jobs are reconciled or relaunched, and before anything is served, each recorded process that is still alive **and** whose start time is read now, is of the same kind and equals the recorded one gets SIGTERM (its whole process group, if it still leads it), then SIGKILL if it is still there after 5 s; all in parallel, with every `ps` read asynchronous and limited to 1 s, so startup waits about 6 s, at most 8 s. A process whose start time cannot be verified, or differs (its PID was reused), is never signalled; the first case is logged for manual recovery (`Docs/operations/troubleshooting.md`). PID 1, the bridge itself, its process group and a record whose group is not the process itself are never signalled, and records are not acted on at all unless their directory is a real directory owned by the bridge's user (it is made private if it was not); symlinked records are ignored. Every action is logged with the job id and PID (`aibr logs`). Not supported on Windows (logged, nothing signalled).
  - Claude Code now runs as the leader of its own process group, like script steps already did, so a cancel, the kill switch, a timeout and a restart stop the tools and shells it started too, not only the `claude` process. When a process stopped this way exits, what is left of its group (a tool that ignores SIGTERM) is killed at once, instead of on a timer a closing bridge might not live to run.
  - **Behaviour change: stopping the bridge stops its running jobs.** Because the processes no longer share the bridge's process group, a Ctrl-C in `aibr start --foreground` or the service manager's stop signal does not reach them; on SIGTERM, SIGINT or SIGHUP (now also handled, by `aibr serve` and `aibr worker`: `aibr stop` ends a foreground tmux session, which hangs the bridge up) the bridge stops them itself (waiting up to 10 s) and each job ends `failed` with `interrupted: bridge stopped` and is reported at once, instead of staying `running` until the next start ended it as `interrupted: bridge restarted`.
  - Still left behind: tools that outlived a Claude Code process that had itself exited before the restart (its PID can then no longer be verified, so its group is not signalled), a process the bridge was killed in the instant after spawning (before its record was written), and, outside Linux, one killed before its start time was added (logged, not signalled).
- **A job whose dependency failed is now reported, and settling dependents can no longer swallow a report.** When an OpenCode job ended, or a remote dependency's report arrived, the `depends_on` jobs it failed were never reported to their requesters; and if another path had ended such a dependent first (a cancel, the sweep), the unguarded write threw and the ended job's own report was lost. Dependents are now settled with guarded writes (a dependent another path ended is skipped), one dependent never stops the others, the path that fails a dependent reports it, and the ended job is always reported.
- **Jobs left behind by a bridge restart are reconciled.** Before, a job that was `running` when the bridge stopped stayed `running` forever (its requester saw `still_running` forever), and an approved job that had not launched yet never ran. Now, when `aibr serve` (engine ingress) or `aibr worker` (router ingress) starts, before it serves or drains anything:
  - a job that may have started (`running`, `session_created`, or `accepted` with a launch already begun) ends as `failed` with the error `interrupted: bridge restarted`, and its requester gets the report. It is **never** retried automatically, because it may already have changed files or run commands; the orchestrator decides whether to dispatch it again. An OpenCode session it left in `opencode serve` is aborted;
  - an `accepted` job that provably never launched is launched once, but only if this node would still accept it (source, project and capability still allowlisted) and it does not bypass approval: a job that was held for approval must be operator-approved, and any other job must not need approval under the current config. Otherwise it ends as `failed` with `not relaunched after restart: <reason> (never started)`;
  - jobs `awaiting_approval` and `blocked` are kept. A job awaiting approval is never turned into a run.
  - relaunches finish before the bridge listens (or the worker drains). OpenCode's health is checked once for the whole batch (up to 15 s); if it is down, those jobs end as `not relaunched after restart: OpenCode unavailable (never started)`. On a Claude node, a cleared job that finds every `limits.max_concurrent_jobs` slot taken ends as `not relaunched after restart: no free slot … (never started)`.
- **Only one `aibr serve` or `aibr worker` runs per profile.** Each takes a lock file (`~/.local/state/aibridge/<profile>/aibridge.lock`, holding its PID and that PID's start time) for its lifetime. A second one, for example `aibr start --foreground` while the service is running, now exits with an error naming the running PID and touches no job, instead of interrupting the running bridge's jobs. A lock left by a crashed process, or by a PID that was reused after a reboot (its start time, read independently of time zone and locale, differs), is replaced automatically. A live PID whose start time cannot be verified keeps the lock; see `Docs/operations/troubleshooting.md` for manual recovery.
- A job is ended exactly once: a job that is already terminal is never written again, and the periodic sweep re-checks each job just before ending it. The sweep and a job's own runner can no longer both end the job and both report it.
- Every launch path now records `launchStartedAt` on the job before contacting the runtime (Claude Code spawn, OpenCode session and prompt, on `/trigger`, `aibr approve`, `/report` unblocking and the router drainer), which is what tells "never ran" from "may have run". A job can be launched only from `accepted`, and only once. If the launch then fails (OpenCode refuses the session or the prompt, Claude Code cannot be spawned), the job is failed at once with the launch error and its requester gets the report, instead of the job staying `accepted` until it times out.
- **Error text from OpenCode jobs is scrubbed of this node's secrets** (bearer and operator tokens, the OpenCode server password, provider keys) before it is stored on the job, so it no longer reaches `GET /jobs/:id` or the `/report` summary verbatim.
- **Job deadlines are swept every 60 seconds**, not only at startup, and a job's `timeout_seconds` now counts from when it launched (or, for an approved job not yet launched, from the operator's approval) instead of from when it was created, so time spent waiting for `aibr approve` no longer eats into the run. A job awaiting approval still lapses `timeout_seconds` after it was created. Jobs whose runner is live in the process are left to the runner's own deadline.
- The `bridge_result` MCP tool description tells orchestrators what an `interrupted: bridge restarted` failure means and that re-dispatching is their decision.

### Documentation
- `AGENTS.md` Architecture and the `README.md` architecture section describe what actually runs, and list the kept-but-unwired code and its deadlines under "Not yet wired".

## [3.1.1] - 2026-11-26

Removes the unused TUI, Herdr, terminal and IPC layer (about 54k lines, two Rust crates and two dependencies). Nothing in production depended on it: `/trigger`, `/report`, `/jobs`, the Claude Code plugin and the worker are unchanged. Claude Code with the AIBridge plugin is the operator interface, and human-only actions (approve, reject, kill switch, logs) stay in the `aibr` CLI on the worker. See [ADR 0014](Docs/adr/0014-claude-is-the-operator-interface.md).

### Deprecated
These still work in 3.1.1 and are removed in 3.2.0.
- **`aibr tui`** is a stub that prints the replacements and exits 1. Use Claude Code with the AIBridge plugin, and on the worker `aibr jobs pending`, `aibr approve` / `aibr reject`, `aibr stop --all-jobs` and `aibr logs -f`.
- **`aibr worker --ipc-publish`** is accepted but ignored, and warns. Drop the flag from hand-written service units; units generated from 3.1.1 do not pass it.
- **Config `terminal.backend: "herdr"`** still loads, uses tmux and warns. Remove the key or set `"tmux"`.

### Removed
- **Herdr terminal backend and the `aibr-manager` launcher.** The `aibr-manager` and `aibr-herdr-bridge` Herdr plugins no longer work against AIBridge.
- **The local IPC bus** (`src/ipc/`) and the effect of `--ipc-publish`.
- **Rust crates `crates/aibr-ipc` and `crates/aibr-pty`.** The Cargo workspace now contains only `router/`.
- **Terminal gateway**: the terminal WebSocket gateway and the `mesh.terminal.*` mesh records, `src/terminal/` (tmux and Herdr backends) and the TUI application service.
- **TUI view models** and the SDK terminal registration.
- **13 IPC-only contract schemas** in `contracts/v1`, and their generated Rust.
- **Dependencies** `@opentui/core` and `@fastify/websocket`.

### Changed
- tmux is no longer a required prerequisite for workers: `aibr verify`, `aibr doctor`, setup preflight and the installer treat it as optional (a warning, no install prompt). Only `aibr start --foreground` needs it, and it now fails with a clear message and the install command when tmux is missing.
- Preflight and `aibr verify` no longer probe for Herdr.
- Newly generated launchd and systemd units no longer pass `--ipc-publish`.
- TUI and Herdr documents moved to `Docs/archive/`; ADRs 0009 to 0011 are superseded by ADR 0014.

## [3.1.0] - 2026-11-26

Claude Code becomes a first-class AIBridge runtime and the main orchestrator, and a new machine can now be set up in a few commands. Configuration files, the HTTP API and the OpenCode runtime path stay backward compatible; see **Behaviour changes** before upgrading a running node.

### Behaviour changes
- **`aibr start` installs a user service by default** (launchd agent / systemd user unit running `aibr serve`) instead of starting a tmux session. The previous behaviour is `aibr start --foreground` (alias `--tmux`); scripts that `tmux attach -t aibridge-<profile>` need that flag.
- **New profiles require signed requests.** Profiles created by `aibr setup` or `aibr init` get `security.request_signing: "required"`; existing profiles keep their setting (absent means `"off"`). An unpaired peer then gets `401 signature_required` until the two nodes are paired with `aibr enroll`.
- **Re-running `aibr setup` keeps the bearer token** by default (it used to generate a new one, silently breaking peers). Rotation is an explicit choice that warns about the 401s it causes.
- **The router's static musl size bound is now 3 MiB** (was 2.25 MiB), recorded in ADR 0008 §13.

### Claude Code runtime (Claude plan, Phases 0–2)
- **Claude adapter rewritten for the real CLI protocol** (`src/runtime/claude-adapter.ts`, ADR 0005):
  - It uses `--verbose`, stream-json user turns, and the real `result` fields (`subtype`, `is_error`, `result`, `total_cost_usd`, `usage`, `num_turns`, `permission_denials`).
  - Unknown event types are ignored.
  - stdin is closed after the result, so the process exits.
  - A process killed by a signal is reported as failed.
  - It passes `--append-system-prompt`, not `--system-prompt`.
  - The fake permission round-trip is removed: permissions are decided up front under `--permission-mode dontAsk`.
  - Denied tool calls are recorded and become report findings.
- **Live harness**: `bun run test:live` (`AIBR_LIVE_CLAUDE=1`) runs the real `claude` CLI, defaulting to haiku with a 0.25 USD cap. Note that `--max-budget-usd` is a soft cap, checked after each turn.
- **`/trigger` runs Claude Code under capability profiles**:
  - New config keys: `role`, `runtime`, `capability_profiles` (allow/deny/budget/turns/timeout/model/append prompt), and `claude` (`setting_sources`, `strict_mcp_config`, `settings_path`). `opencode` is now optional for Claude workers.
  - Every launch also gets a frozen **safety floor** of deny rules (secrets, SSH/cloud credentials, AIBridge state, `curl`/`wget`/`ssh`/`sudo`) that no profile can remove.
  - An unknown capability gets `403 unknown_capability_profile`.
  - Workers created by `aibr setup` get read-only `investigate` and test-only `run-tests` profiles.
- `GET /jobs/:id` returns a Claude job's `summary`, `findings`, `cost_usd`, `num_turns`, `runtime_session_id`, and (with repositories) `sha` and `script_results`. `/health` reports `runtime: "claude"`.

### Security: signed requests, pairing, operator approval (Claude plan, Phases 3–4)
- **`security.request_signing`** (`off`/`optional`/`required`) adds ed25519 node signatures on `/trigger` and `/report`:
  - The sender's identity comes from the verified key, and a `source_agent_id` that does not match it gets 403.
  - Replays are rejected.
  - Callbacks and the MCP client sign their requests.
  - Signing is refused in router ingress mode (ADR 0012).
- **`aibr enroll issue | join | list | revoke`** pairs nodes with a one-time code, replacing manual token copying. Both sides pin each other's key and write their configs; the worker's bearer token is stored without being shown.
- **Operator approval**:
  - Approval-gated jobs (`requires_approval`) wait as `awaiting_approval`, and the caller's `metadata.plan_status` is no longer trusted.
  - Only `aibr approve` / `aibr reject` can release one. They need the operator token and must run on the same host; a peer's bearer gets 403.
  - `aibr jobs pending` lists waiting jobs.
  - Every decision goes to a hash-chained `approvals.jsonl` ledger (ADR 0013).
  - Kill switch: `aibr stop --all-jobs`.

### Jobs pinned to a commit (Claude plan, Phase 5)
- **`repo` + `ref` on `/trigger`**: the repository must be configured under `repositories`. The `ref` is resolved to a sha when the job is accepted, so an operator approves an exact commit. Each job runs in its own detached worktree, which is removed afterwards and swept at startup.
- **Deterministic steps**: profiles accept `script`, `pre` and `post`. Scripts run without a shell, contained to the job directory, with a cleaned environment; the exit code and a redacted output tail go into `script_results`.
- **Concurrency limit**: `limits.max_concurrent_jobs` (default 2). Jobs over the limit get `429 node_at_capacity`.

### Claude Code as orchestrator (Claude plan, Phase 6)
- **Claude Code plugin** in `plugins/aibridge`, with the marketplace at `.claude-plugin/marketplace.json`, shipped in the npm package:
  - an MCP server (`aibr mcp serve`) with tools `bridge_peers`, `bridge_dispatch`, `bridge_status`, `bridge_await`, `bridge_result` and `bridge_cancel` — deliberately no approve tool;
  - the `aibridge-dispatch` skill, the `/bridge-send` and `/bridge-status` commands, and a SessionStart summary hook (`aibr mcp summary`).
- **`aibr plugin install | uninstall | status claude`** registers the plugin through the official `claude plugin` CLI and never edits `~/.claude` files.

### Installation for new users (installation UX review, wave A)
- **`scripts/install.sh`**:
  - Prompts read `/dev/tty`, so `curl … | bash` no longer swallows script lines, and `--yes` covers every prompt.
  - New flags: `--role worker|orchestrator|both`, `--runtime opencode|claude|auto`, `--with-claude-plugin`, `--ingress router`.
  - Prerequisites are checked per role, and missing ones are installed with consent (official Tailscale installer).
  - It offers to fix `PATH`.
  - The router is only mentioned with `--ingress router`.
  - `--version` matches the package.
  - `AIBRIDGE_PACKAGE` installs a local tarball.
- **`aibr setup`**:
  - Secrets are entered with echo off.
  - "Save?" defaults to yes.
  - The config path and ports are asked only with `--advanced`.
  - The project defaults to the git root, and `$HOME` is refused.
  - New role and runtime questions, with a role-aware preflight, so Claude-only machines are no longer blocked on `opencode`.
  - Orchestrators get no token or project questions; they can pair by code instead.
  - Discovery output is shorter.
  - It prints next steps for the chosen role.
- `aibr status` probes the configured bridge host. Before, every correctly configured node showed as unavailable.
- Every command has its own `--help`.

### Quickstart and one run model (installation UX review, waves B–C)
- **`aibr init`**: sets up a machine in at most four questions — role, runtime (only when both or neither is installed), project directory (git root by default; `$HOME` refused), and new network (prints a one-time pairing code) or join (paste the code). Runs the setup wizard in quickstart mode and the `aibr enroll` code paths; secrets are generated and never shown; every answer has a flag for scripted installs. `aibr setup --advanced` remains the full wizard.
- **`aibr doctor`**: one ✓/✗ list merging `verify`, `status` and discovery, ending with a signed ping of every peer; every ✗ carries the command that fixes it.
- **`aibr ping <peer>`**: sends a signed no-op job (reserved capability `aibr.ping`) that the worker authenticates, completes without a runtime, and reports back; prints the round trip, whether the `/report` callback arrived, and what the peer accepts (capabilities, project directories).
- **`aibr send <peer> "<prompt>"`**: dispatches a job and waits for its summary and findings, replacing the hand-written `curl`; `--capability` and `--project` default from the peer's ping answer.
- **`aibr start` is a user service**: a per-profile launchd agent (`com.aibridge.<profile>`, `launchctl bootstrap gui/<uid>`) or systemd user unit (`aibridge-<profile>.service`) running `aibr serve` (with `--with-opencode` for OpenCode workers), restarted on failure and at login; it waits for `/health`. The tmux session is now `aibr start --foreground` (alias `--tmux`) and keeps windows open when a process exits. `aibr stop` unloads the service and the tmux session. The shared `com.aibridge.daemon` / `aibridge.service` unit is migrated on the next `aibr start`. The unit no longer caps memory (a cgroup cap killed Claude Code jobs).
- **`aibr status`** reports what runs the bridge (`launchd`, `systemd`, `tmux`, `unmanaged`) instead of `session_missing` when only the service runs it; `not_running` and `no_bridge` (orchestrator) are new states.
- **File logs**: `aibr serve` writes `<state dir>/logs/aibridge.log` (startup, listen address, one line per request without headers or bodies; the service adds stdout/stderr); `aibr logs [-f] [-n N]` prints it.
- `aibr setup` no longer writes a supervisor unit unasked: its last step offers to start the user service. Its "next steps" point at `aibr enroll` and `aibr doctor`; the installer's point at `aibr init` and offer to run it.
- A callback the durable egress outbox queued for retry is recorded as `callbackDelivery: pending` instead of `delivered`.
- CI runs a two-profile smoke test (`bun run test:smoke`: init → pair → ping → doctor on one machine).

### Operations (Claude plan, Phase 7)
- **`Docs/runbooks/claude-dev-staging.md`**: an operator runbook covering worker and orchestrator install, pairing, signed requests, the operator token, approve/reject, the kill switch, reading the approval ledger, key and token rotation, capability profile design, and troubleshooting.
- **`Docs/runbooks/tailscale-policy.example.hujson`**: an example policy. Dev may reach staging's port 8787, staging may reach dev's port 8787 for callbacks, staging has no route to prod, and Tailscale SSH is off for staging.

### Fixes
- The Milestone 7 systemd check ignores warnings from the CI runner's own system units. Messages about AIBridge's units still fail it.
- Wizard tests no longer write a launchd unit into the real `~/Library/LaunchAgents`.

## [3.0.0] - 2026-10-14

### Herdr-Orchestrated Multi-Agent Architecture (Part A)

#### Orchestration Commands & Kernel Governance (Phase 0 & Phase 1)
- **Charter Governance (`src/orchestration/charter/`)**: Introduced orchestration-wide system prompt governance via versioned `Charter` documents stamped with cryptographic snapshot digests (`computeCharterSnapshotDigest`).
- **Charter Proposal Lifecycle**: Added `charter.propose`, `charter.approve`, `charter.reject`, and `charter.revise` orchestration commands. Proposals remain pending with full audit trails (`rationale`, `evidenceRefs`) until operator approval.
- **The Immutable Core (`src/orchestration/policy/immutable-core.ts`)**: `assertCharterDoesNotRelaxCore` blocks any proposal from relaxing the safety floor, input fencing, security perimeter (`allowed_sources`, project allowlist), advisory roundtable invariant, budget limits, or kernel authority before entering the pending queue.
- **Audited Kernel Commands**: All charter revisions are executed exclusively through kernel commands (`charter.revise`), preventing files or external UIs from becoming competing sources of truth.
- **Multi-Role Assignment (`RoleAssignment`)**: Agents can now hold composite roles with exactly one primary role and bounded secondary addenda (`addendum`).
- **Capability Envelope Intersection**: Multi-role execution enforces strict capability intersection by default ($\text{allowed} \cap \text{roleAllowed} \cap \neg\text{denied}$), preventing permission escalation across combined roles.
- **Deterministic Prompt Compilation (`RoleBinder`)**: System prompts are deterministically compiled from `Charter(v).globalRules + primaryRole.instructions + Σ secondaryRole.addenda + communicationPolicy + taskPrompt` with cryptographic digest stamping.
- **Session Prompting**: Implemented `session.prompt` command driving runtime clients with idle monitoring and event recording.

#### Governed Deliberation & Roundtable (Phase 1 & Phase 5)
- **Roundtable Deliberation (`src/orchestration/roundtable/`)**: Introduced advisory pre-execution debate modeled via `roundtable.open`, `roundtable.post`, `roundtable.close`, and `roundtable.outcome_recorded`.
- **Controller Relay Transport**: Discussion posts travel over `mesh.event` envelopes and are relayed by the controller to all participating member nodes. Total event order is established uniquely at the SSE event gateway without requiring direct worker-to-worker connections.
- **Advisory-Only Invariant**: Deliberation produces recommendations and audited transcripts (`RoundtableOutcome`) as inputs to dispatch. `roundtable.closed` is present in zero `COMMAND_EVENT_ALLOWLIST` entries, guaranteeing roundtables never trigger automated state transitions.
- **Roundtable Execution Gating**: Communication policies enforce `objectionRequiredBefore`, rejecting un-deliberated execution dispatch attempts with `roundtable_required`.
- **Memory Write-Back**: Roundtable outcomes automatically write back to scoped memory stores with provenance linking to discussion post IDs.

#### Fan-Out Scheduler & Budget Ledgers (Phase 1 & Phase 5)
- **N-Sibling Fan-Out Dispatch**: Implemented fan-out task execution with cascading cancellation on parent failure.
- **Budget Gating**: Extended budget ledgers to track concurrency and fan-out limits as distinct counters; parallel roundtable discussions and fan-out dispatches are gated against hard budget ceilings (`maximum_fan_out_exceeded`, `budget_exhausted`).

#### Herdr Fork Integration & Terminal Backend (Phase 2 & Phase 3)
- **Herdr Fork Integration (`herdrdev/herdr` branch `aibr-orchestration`)**: Thin fork satisfying ADR 0009 Revisit Condition #1:
  - **F1 Input-Ownership Fencing**: Added `pane.claim_input` / `pane.release_input` socket API with epoch fencing, rejecting unheld writes with `input_fenced` to prevent keystroke interleaving between humans and agents.
  - **F2 First-Class Role**: Native `role` field on pane and agent records that survives pane moves and workspace re-identification, linking to the kernel's `RoleSnapshot` digest.
  - **Schema Conformance**: Verified against `herdr api schema --json`.
- **`HerdrTerminalBackend`**: Added production `HerdrTerminalBackend` alongside `TmuxTerminalBackend` in `src/terminal/`, selectable via `terminal.backend: "tmux" | "herdr"` in configuration (defaulting to `"tmux"` for headless safety).

#### Herdr Plugins & Remote Federation (Phase 3 & Phase 4)
- **`aibr-manager` Plugin (Bun + OpenTUI)**: Interactive management pane providing Role Grid (agents $\times$ roles with live capability envelope preview), Charter Editor (with inline immutable core validation), Roundtable Live Transcript (SSE streaming, human post injection), Multi-Machine Grid, and Approval Queue.
- **`aibr-herdr-bridge` Plugin (Bun)**: Subscribes to remote Tailscale mesh nodes and projects remote agent state into local Herdr workspaces with `$node`, `$role`, and `$run` tokens.
- **Dual-Path Remote Federation**: Herdr SSH machine federation handles remote terminal presentation over Tailscale, while AIBridge mesh projection handles distributed orchestration state.

#### TUI Retirement & CLI Cutover (Phase 6)
- **Retirement of `aibr-tui` and `src/tui/`**: Retired the standalone Rust `aibr-tui` binary and the OpenTUI fallback shell in favor of Herdr workspace presentation. Retained `crates/aibr-pty` and `crates/aibr-ipc` as headless substrates.
- **`aibr tui` Cutover**: CLI command `aibr tui` now detects Herdr installation and launches/links the `aibr-manager` plugin, exiting with clear remediation steps if Herdr is absent.

#### Operator-Credential Security Model & Authz Tiers (ADR 0008 §4 / ADR 0011)
- **Operator Token Authority**: Introduced `AIBRIDGE_OPERATOR_TOKEN` and user-kind actor claims (`actor.kind: "user"`). High-privilege governance actions (charter proposal approval/rejection, human roundtable injection, emergency execution abort) require verified operator credentials.
- **Advisory-Only Notifications (ADR 0007 §17)**: Event-driven notification bus and consumer operating strictly advisory and out-of-band with zero upward imports into orchestration, rules, or budgets.

## [2.2.0] - 2026-10-14

### Setup, Peer Discovery, & Security (Part B)

#### Added
- **Optional bearer authentication.** `security.auth_mode` accepts `"bearer-token"` (default, unchanged behaviour) or `"none"`. In `none` mode `/trigger` and `/report` accept unauthenticated requests, no `bearer_token` secret is written, and callbacks are delivered with the `Authorization` header omitted rather than sent as a malformed one. `aibr setup` gains a third option at Step 2 (`none`), and refuses to author it unless the bridge is bound to a Tailscale CGNAT address (`100.64.0.0/10`) with the backend running, or when a `bearer_token` secret is already on disk that would be silently ignored. A bare `n` at Step 2 keeps its existing meaning (paste your own token); only an explicit `none` disables authentication.
- **Fail-closed auth selection.** `createAuthProvider(mode, token)` in `src/security/auth-provider.ts` throws rather than degrading when a `bearer-token` profile has no secret, so a missing token file cannot become an open bridge. `BearerAuthProvider` now also refuses an empty token at construction.
- **`aibr verify` distinguishes warnings from failures.** A missing bearer secret on a `none`-mode profile is a standing `warn`, not a `fail`, and `ok` is now "nothing failed" instead of "everything passed" — a node in the mode the operator chose should not report FAILED.
- **Tailscale peer discovery.** `discoverTailscalePeers` in `src/host/tailscale-discovery.ts` enumerates the tailnet from the local daemon, drops this machine from its own peer list, and degrades to an empty list on every failure mode (absent daemon, malformed output, no peers) because discovery is advisory. `probeDiscoveredAgents` in `src/cli/setup-step-widgets.ts` then asks each peer's unauthenticated `/health` who it is, keeping the daemon's `online` verdict, the HTTP `reachable` answer, and the peer's self-reported `agentId`/`capabilities` as separate fields because they answer different questions and fail independently.
- **`aibr discover`.** A read-only, state-free tailnet query: it writes nothing, starts nothing, and treats an empty tailnet as success. `--json` emits exactly one document on stdout with a pinned top-level shape (`schemaVersion`, `ok`, `enrolledSource`, `peersFound`, `reachableCount`, `enrolledCount`, `peers`, `notice`) and stable per-peer field names — this is the surface the Herdr manager plugin codes against, so a rename is a breaking change. `null` is preserved for facts discovery never learned rather than being collapsed to `false`.
- **`aibr setup` peer proposal.** Setup uses the same probe to *offer* discovered peers. The operator selects one explicitly and chooses its capabilities; a peer that is not selected is not enrolled, and there is no code path from a reachable `/health` to a config write. Enrolling writes the peer into **both** `agents[]` and `security.allowed_sources[]` from a single in-memory object, with the same id and the same capabilities, because `assertSourceAuthorized` authorizes on `source_agent_id` **and** capability membership and answers `403` to a source present in one array but not the other; selecting nobody enrols nobody, leaving both arrays empty and consistent. Config authoring, not a trust decision.
- **Identity fields on `/health`.** The route now also returns `agent_id` and `capabilities` alongside `ok` and `opencode`. `capabilities` is the flattened, sorted union of `security.allowed_sources[].capabilities` rather than `agents[]`, so a probe learns what work the node accepts and not which tailnet peers it has authorised; the source identities, `requires_plan_approval`, and the `agents[]` registry are deliberately still not exposed. `/health` remains unauthenticated by design — it is the discovery endpoint, and this is additive.
- **Informational discovery check in `aibr verify`.** A new `tailscale-discovery` check reports "N peers reachable, M enrolled", with enrolled peers named in the detail string (capped at five). It is never a `fail`: no Tailscale, an empty tailnet, or all peers offline all pass, because a machine alone on its tailnet is a normal single-machine install. It is a `warn` only when reachable peers are none of them enrolled, or when the probe could not run at all.
- **Reachability is not authentication, stated at every surface.** Every discovery projection — the wizard widget, `aibr discover`, and the `verify` check — carries an explicit caveat that a peer answering `/health` is not enrolled or trusted. Real trust stays on the mesh identity path (`src/mesh/identity/`: ed25519 node keys, enrollment codes, peer pins), and no route accepts a caller-supplied `agent_id` as proof of identity. `tailscale status --json` is never printed raw, and no `tskey-` node-enrollment credential is surfaced by any of these paths — a peer whose only self-description is a credential-shaped string is reported as unidentified.

#### Fixed
- **`aibr bundle --preview` was rejected as an unknown flag.** `parseArgs` pushed `--preview` onto both `knownFlags` and `unknownFlags`, so the unknown-flag guard rejected the flag before the bundle branch could read it — a documented, implemented flag that was unreachable in every released version. Genuinely unknown flags are still rejected.
- **The `tskey-` guard had two copies.** `aibr discover` and `aibr setup` each carried their own `TSKEY_PREFIX` and scrub function. Duplicated redaction logic reads as deliberate in either copy, which is what makes it likely one is edited and the other is not. The rule now lives once in `src/cli/discovery-safety.ts` and is imported by both.

#### Changed
- `bearerToken` is nullable across `AppDependencies`, `RuntimeOptions`, `CallbackReporter.send`/`drainPending`, and `EgressOutboxStore.deliverClaimedRow`. Backwards compatible: every existing config and test still passes a real token.
- `src/index.ts` no longer requires `AIBRIDGE_BEARER_TOKEN`, so the legacy agent-face entrypoint serves whatever `security.auth_mode` the profile declares.

## [2.1.6] - 2026-10-09

### Fixed

- **Cross-platform binary format validation**: `isExecutable` in `src/host/binaries.ts` now inspects executable magic headers, rejecting incompatible binary formats (e.g. Darwin Mach-O on Linux) to prevent `posix_spawn` / `ENOEXEC` failures.
- **TUI daemon socket awareness & OpenTUI fallback**: `aibr tui` now checks daemon socket activity before invoking `aibr-tui` and catches any IPC connection failures, gracefully falling back to the built-in OpenTUI shell when the background IPC daemon is not active.
## [2.1.4] - 2026-10-09

### Added

- **Automatic OpenCode v2 detection**: CLI and profile supervisor now automatically detect and launch `opencode2` when present in `PATH`, with `OPENCODE_BIN` environment variable override support.

## [2.1.3] - 2026-10-09

### Fixed

- **Bundled native binaries**: Shipped compiled `aibr-tui` and `aibr-router` binaries directly inside the npm package under `bin/`, registered them in package `bin` executables, and removed external `optionalDependencies` to prevent 404 installation warnings.

## [2.1.2] - 2026-10-09

### Fixed

- **Native TUI and Router binary availability in npm package**: Resolved issue where global npm/bun installations only shipped JavaScript (`dist/`) without compiled Rust binaries, causing `aibr tui` to always fall back to the legacy OpenTUI shell.
- **Per-platform optional dependencies**: Added `@nyugennguyen/aibridge-<platform>` optional dependencies for prebuilt `aibr-tui` and `aibr-router` binaries (`darwin-arm64`, `darwin-x64`, `linux-x64-gnu`, `linux-x64-musl`, `linux-arm64-gnu`, `linux-arm64-musl`).
- **Native binary discovery engine** (`src/host/binaries.ts`): Implemented unified resolution prioritizing `AIBRIDGE_TUI_BIN`/`AIBRIDGE_ROUTER_BIN` overrides, optional platform packages, bundled binaries, local Cargo builds, and system PATH.
- **Build matrix & packaging automation**: Updated `scripts/build-matrix.sh` to compile and package both `aibr-router` and `aibr-tui`, including universal Darwin binaries, and added `scripts/package-binaries.ts` (`bun run package:binaries`) for automated npm platform package staging.

## [2.1.0] - 2026-10-07

> Released as tag `v2.1.0` on `aibr-v2`. The GitHub release was **not** created, so this
> version is not yet published to npm — creating the release is what triggers `publish.yml`.

### TUI control plane upgrade & onboarding wizard

Implements the second phase of ADR 0010. Full record in
[`Docs/implementation-reports/tui-deamon-update-07102026.md`](Docs/implementation-reports/tui-deamon-update-07102026.md).

#### Added

- **Dual-profile keybinding engine** (`crates/aibr-tui/src/input/`): Profile A exposes
  zero-prefix `Alt+H/J/K/L` focus, `Alt+V`/`Alt+S` splits, `Alt+Z` zoom, `Alt+1..9` workspace
  tabs, `Alt+B` inspector, and `Alt+Q` detach. Profile B arms the tmux-classic `Ctrl+B` prefix.
- **Shell chrome**: 2-row top header with Tailscale health and agent status pills, a numbered
  workspace tab bar with close/new hit-testing, and a status bar.
- **Embedded in-pane HITL approval card and colourised diff viewer**, replacing the disruptive
  full-screen takeover.
- **Universal command palette** (`Ctrl+K`) with fuzzy filtering, and an interactive keymap /
  profile-switcher modal.
- **Collapsible 28-column inspector sidebar** with node latencies, run DAG, and telemetry.
- **Brand identity**: ANSI logo, design-system colour tokens, and a 7-row CLI splash banner.
- **5-step onboarding wizard** (`aibr setup`): network probe, security, project allowlists,
  AI runtime probes, and install. Interactive keyboard and mouse parity, with a headless
  fallback for non-interactive test suites.
- **Platform supervisor generation**: launchd plist and systemd user unit.

### Fixed

- **The setup wizard no longer creates the ingress outbox.** The `ingress_outbox` table belongs
  to the Rust router and is provisioned by `aibr-router --init-store`. The wizard was creating a
  different set of columns at a path the router does not read, and reporting `walEnabled: true`
  without reading `PRAGMA journal_mode` back. `aibr worker` documents why an implicitly-created
  store is worse than none: the router refuses to serve against it, the worker drains an empty
  one, and both look healthy.
- **Supervisor units are written without being activated**, and `aibr setup` now asks before
  starting the daemon. Both units are `KeepAlive`, so activating one whose config does not match
  the router's store turns a setup mistake into a restart loop. Setup reports which of four
  states the daemon is actually in, so a unit that was never started cannot read as running.
- **Profile names and the binary path are escaped** when interpolated into a plist and a systemd
  `ExecStart`. Units are now written `0600`.
- `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` are
  clean across the workspace.
- **The version no longer drifts.** The splash banner hardcoded `aibr v2.0`, so this release
  advertised itself as 2.0 on startup, and the string was written out by hand in four places.
  It now lives in `src/version.ts` as `CLI_VERSION`, read by the banner, `--version`,
  `aibr update`, and the diagnostics bundle.

### Known limitations

Carried forward from `tui-daemon-modernization.md` and unchanged by this release:

- `approve_plan` / `reject_plan` reach the daemon and are answered `accepted: false`. The HITL
  card renders and the frame is sent, but the engine's plan-review path sits behind the job
  manager and is not wired yet.
- The PTY host has no `PtySink` wired to the listener, so pane commands from a real client are
  answered `not_allowed`. No real `opencode` has been run through the bus end to end.

### Documentation corrections

An earlier revision of the implementation report made four claims that the code did not support;
they are corrected in place rather than left to mislead:

- The `aibr_sec_<32-hex>` bearer token is **128 bits** (16 bytes), not 256. The mislabel also
  appeared in `aibr-onboarding/SKILL.md` and the wizard mockup; both now say 128.
- The `Ctrl+B` prefix window is **2000 ms**, not the 500 ms the report claimed. The longer
  window is deliberate and documented in `tui-daemon-modernization.md` §5.
- The wizard does **not** load the platform service daemon as part of a completed setup;
  activation is a separate opt-in.
- The HITL approval card does not yet produce an effective approval (`accepted: false`).

## [2.0.0] - 2026-10-05

### Major Architectural Evolution (v1 -> v2)

AIBridge v2 transforms the single-node, file-backed proof-of-concept into a resilient, distributed agent mesh platform featuring autonomous ingress, multi-agent coordination, an interactive terminal UI, and comprehensive operator workflows.

### Added

- **Autonomous Ingress & High-Performance Router (`aibr-router`)**:
  - Standalone Rust admission router (`router/`) providing sub-millisecond request validation, zero-allocation boundary enforcement, and rate limiting.
  - Polyglot contracts with JSON Schema parity vectors generated synchronously between TypeScript (Zod) and Rust (Serde).
  - Tier 2 asynchronous drain worker (`src/ingress/worker.ts`) decoupled from HTTP listener lifecycles.
  - Durable SQLite outbox store for atomic admission and reliable delivery across crashes.
  - Ingress modes: `engine` (TypeScript Fastify bridge) and `router` (autonomous native ingress router).

- **Multi-Agent Orchestration & Workflow Engine (M3 - M6)**:
  - Directed Acyclic Graph (DAG) task scheduler supporting parallel job execution, dependencies, and dynamic fanout.
  - Distributed coordination protocols with heartbeat-monitored agent leases, split-brain fencing, and automatic failover.
  - Capability-based access control with role definitions, boundary rules, and execution floor policies.
  - Expression and rule evaluation engine with compile-time vacuity and non-contradiction verification.
  - Event-sourced persistence store with migration framework, snapshotting, and transaction logs.

- **Interactive Terminal User Interface (`aibr tui`)**:
  - Full-screen dashboard built on OpenTUI for inspecting agent mesh health, real-time event logs, active leases, and task DAGs.
  - Keyboard-driven interactive views for capability verification, session management, and rule policy inspection.

- **Operator & Onboarding CLI Suite (`aibr`)**:
  - `aibr setup`: Interactive onboarding wizard with automated prerequisite checks (Bun, OpenCode, Tailscale, tmux), cryptographic bearer token generation (`openssl rand -hex 32` / 64-character hex secret), custom or default configuration paths, and secure permission handling (`0600`/`0700`).
  - `aibr verify`: Deterministic verification command checking dependencies, Tailscale network connectivity, configuration schemas, secret permissions, and project directory availability.
  - `aibr update`: Self-update command with `--check` and `--yes` flags that queries registry releases, compares semver versions, and manages global upgrades.
  - `aibr status`: Extended profile status reporting configuration summaries (Agent ID, Bridge host/URL, OpenCode URL) alongside readiness probes.
  - `aibr bundle`: Sanitized diagnostic support bundle generator for troubleshooting without leaking credentials or secret keys.

- **Security & Platform Hardening**:
  - Automated secret redaction pipeline preventing credentials, bearer tokens, or sensitive headers from leaking into logs, support bundles, or preview buffers.
  - Strict filesystem safety guarantees: atomic file writes, symlink rejection, path traversal protection, and mandatory `0600` secret permissions.
  - Network isolation via dedicated Tailscale interface binding (`tailscale0`) and nftables filtering rules.
  - System supervision templates: systemd services (`aibr-router.service`, `aibr-worker.service`) and macOS launchd daemons (`com.aibridge.router.plist`).

### Changed

- Migrated job storage from legacy flat JSON files to durable event-sourced SQLite stores with crash-recovery audit trails.
- Upgraded configuration schema to support ingress modes, multi-project mappings, timeout policies, and workflow DAG definitions.
- Enhanced process management with tmux session supervisor supporting independent opencode and bridge runtime windows.
- Upgraded testing harness with comprehensive failure-mode simulations, contract parity tests, and recovery runbooks.

## [1.1.0] - 2026-08-25

### Added

- curl|bash one-line installer at `scripts/install.sh` with OS detection, prereq prompts, and `bun install -g` for `@nyugennguyen/aibridge`.

## [1.0.1] - 2026-07-20

### Changed

- Improved bearer-token installation, verification, troubleshooting, and rotation guidance.
- Added regression coverage for authenticated invalid triggers and installation documentation.
- Made release validation build the package before CLI smoke tests and aligned the CLI version with package metadata.
- Updated the GitHub Actions checkout action to v5.
- Removed internal `.omo` workspace state from the repository.

## [1.0.0] - 2026-07-19

### Added

- First stable AIBridge release for coordinating OpenCode agents over a private Tailscale network.
- Two-host CLI profile setup, secure bearer-token authentication, remote job execution, and callback reporting.
- Release CI validation and package smoke tests.
