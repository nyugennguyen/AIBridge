# Milestone 3: Orchestration Kernel

## Objective

Replace imperative job coordination for new runs with an event-sourced orchestration kernel: durable runs, dependency-aware tasks, immutable dispatch attempts, versioned role snapshots, deterministic policy evaluation, digest-bound approvals, retry, timeout, cancellation, and replayable projections.

## Prerequisites

- Milestone 0 event, command, role, policy, and persistence contracts are approved.
- Milestone 2 runtime adapters expose stable provider-neutral events.
- The current JSON job store remains available for legacy compatibility.
- SQLite behavior required by the ADR has been proven in a small isolated spike.

## Agent Plan

| Task | Dependency | Sub-agent and model | Deliverable | Verification |
| --- | --- | --- | --- | --- |
| M3.1 Aggregate invariants and command matrix | M0 | `architect` — `gpt-6-astra xhigh` | Allowed commands/events/transitions for run, task, dispatch, approval, and session | Model-based transition tests generated from the matrix |
| M3.2 SQLite event store | M3.1 | `subsystem-builder` — `gpt-5.6-sol high` | WAL setup, append transaction, optimistic sequence check, read stream, snapshots/metadata, schema migration | Crash/duplicate/concurrent-writer/corruption tests |
| M3.3 Projection engine | M3.1–M3.2 | `feature-builder` — `gpt-5.6-terra high` | Deterministic run/task/dispatch/approval/session projections and rebuild command | Fresh replay equals incrementally updated projections byte-for-byte |
| M3.4 Task graph scheduler | M3.1, M3.3 | `subsystem-builder` — `gpt-5.6-sol high` | DAG validation, readiness, dependency failure policy, concurrency eligibility | Cycle, diamond, fan-in/out, cancel, retry, and failure property tests |
| M3.5 Role/version repository | M3.1–M3.3 | `feature-builder` — `gpt-5.6-terra high` | Versioned templates, immutable snapshots/hashes, compatibility validation | Editing template cannot change active or historical dispatch |
| M3.6 Policy and approval engine | M3.1, M3.5 | `subsystem-builder` — `gpt-5.6-sol high` | Safety floor, project/role/dispatch restrictions, explanation tree, digest-bound approval | Truth-table and mutation tests cover precedence and invalidation |
| M3.7 Dispatch coordinator | M3.2–M3.6 | `subsystem-builder` — `gpt-5.6-sol high` | Create/approve/start/retry/cancel/timeout commands and runtime effects via outbox | Duplicate command and crash-boundary tests prove exactly-once intent |
| M3.8 Legacy API translation | M3.3, M3.7 | `feature-builder` — `gpt-5.6-terra high` | `/trigger`, `/report`, and job query translation/compatibility policy | Existing integration tests pass; new correlation fixtures pass |
| M3.9 TUI run/audit integration | M3.3–M3.7 | `feature-builder` — `gpt-5.6-terra high` | Task graph, history, role, policy explanation, attempts, and artifact placeholders | Reducer tests from recorded event fixtures |
| M3.10 Adversarial kernel review | All | `security-reviewer` + `independent-reviewer` — `gpt-6-astra xhigh/high` | Consistency, authorization, replay, and crash-safety audit | All blocker/high findings closed before gate |

## Storage Design Requirements

The event store must provide:

- One append transaction per accepted command, containing all domain events for that command.
- Unique `event_id` and `command_id` constraints.
- Monotonic sequence within a run and optimistic expected-sequence validation.
- Schema version on every event and database migration.
- Read by run and by global insertion position for projection/outbox work.
- Durable command result lookup so duplicate commands return the original outcome.
- Explicit startup checks for unsupported future schema versions and failed migrations.
- Backup before destructive migration and a documented rollback boundary.

Do not claim “exactly once” transport. The kernel provides at-least-once delivery with idempotent command processing and exactly-once accepted intent inside the event transaction.

## Aggregate Rules

### Run

- Starts as draft, becomes active after its first approved dispatch, and ends completed, failed, or cancelled.
- Cannot be edited after terminal state; clone creates a new run.
- Owns the controller epoch placeholder even before distributed use.

### Task

- Has immutable identity and dependency IDs within a run.
- Dependency edits are allowed only while draft and require graph revalidation.
- Readiness derives from dependency projections and explicit failure policy.
- A retry adds a dispatch attempt; it does not erase failure history.

### Dispatch and Approval

- Dispatch envelope is immutable after proposal; edits create a revision/new digest.
- Approval references exact digest, actor, policy result, and time.
- One approved attempt can start once. Duplicate start commands return the recorded session/result.
- Timeout and cancel requests are events; runtime termination outcome is observed separately.

### Roles and Policy

- Role versions are append-only.
- Effective restrictions can only narrow capability as precedence is applied.
- Policy output includes machine-readable decision and human-readable explanation tree.
- The shipped default is approval required for every dispatch.

## Failure and Recovery Tests

Inject failure at each boundary:

1. Before command validation
2. After validation but before append
3. During multi-event append
4. After commit but before response
5. Before runtime outbox delivery
6. After runtime accepted launch but before acknowledgement
7. During projection update
8. During callback/legacy translation

Restart after every injected failure and assert one coherent outcome, no duplicate prompt, and replay-equivalent projections.

## Completion Criteria

- New runs are fully represented by events and rebuilt projections.
- Incremental and full-replay projections are identical.
- Dependency cycles are rejected before activation.
- Retry, timeout, cancel, and dependency failure have explicit tested semantics.
- Role changes cannot mutate existing dispatch snapshots.
- Approval becomes invalid after any envelope mutation.
- Duplicate commands cannot launch duplicate sessions or submit duplicate prompts.
- Legacy endpoint compatibility is proven or a documented breaking decision is approved.
- Corrupt/newer databases fail safely with actionable diagnostics.
- Security and independent reviewers approve the integrated kernel.

## Guardrails and Stop Conditions

- One sub-agent owns migrations and event-store schema; no parallel edits to them.
- Do not mix terminal bytes or full transcripts into the event log.
- Do not perform external runtime effects inside the event transaction.
- Do not overwrite or delete historical events in normal operation.
- Do not allow projections to become an alternative source of truth.
- Stop integration if event replay is nondeterministic.
- Stop if retry can reach a runtime without a stable command/dispatch idempotency key.
- Do not remove the legacy JSON state reader until migration support is released and tested.

## Gate Verification

```bash
bun test tests/unit/orchestration
bun test tests/unit/event-store
bun test tests/integration/orchestration-flow.test.ts
bun test tests/integration/legacy-compatibility.test.ts
bun run typecheck
bun test
bun run build
git diff --check
```

The completion report includes the schema version, migration/rollback procedure, invariant matrix, replay hashes for canonical fixtures, and resolved audit findings.

