# Milestone 0: Architecture and Migration Contracts

## Objective

Establish the domain language, versioned schemas, subsystem interfaces, security invariants, persistence decision, and legacy migration path needed by every later milestone. This milestone produces compilable contracts and contract tests, not production orchestration behavior.

## Prerequisites

- The current AIBridge tests, typecheck, and build pass or all pre-existing failures are recorded.
- The product brainstorm is approved.
- Current config, trigger/report, job, task, memory, registry, security, host, and OpenCode interfaces have been inventoried.

## Agent Plan

| Task | Dependency | Sub-agent and model | Deliverable | Verification |
| --- | --- | --- | --- | --- |
| M0.1 Baseline and architecture inventory | None | `fixture-worker` — `gpt-5.6-luna medium` | Current-state map of schemas, state files, routes, trust boundaries, and compatibility obligations | Every public/persisted current type maps to a source path and owner |
| M0.2 Canonical vocabulary and aggregate boundaries | M0.1 | `architect` — `gpt-6-astra xhigh` | ADR defining Mesh, Node, Project, Run, Task, Dispatch, Approval, Session, Role, Rule, Memory, Artifact, and Controller Lease | Independent terminology review; no ambiguous reuse of current “agent” or “job” |
| M0.3 Versioned orchestration schemas | M0.2 | `subsystem-builder` — `gpt-5.6-sol high` | Zod-first schemas and inferred types for identifiers, events, aggregates, commands, and envelopes | Schema tests cover valid forms, rejected forms, and version discrimination |
| M0.4 Runtime and terminal contracts | M0.2 | `feature-builder` — `gpt-5.6-terra high` | `AgentRuntimeAdapter`, `TerminalBackend`, capability, lifecycle, and error contracts | Type-only fake adapters compile and pass shared contract fixtures |
| M0.5 Event store and controller lease ADRs | M0.2, M0.3 | `architect` — `gpt-6-astra xhigh` | Decisions for SQLite/WAL, event ordering, command idempotency, projections, lease epochs, expiry, and manual takeover | Failure tables cover crash points, duplicate delivery, stale epoch, and partial writes |
| M0.6 Threat model and safety floor | M0.2–M0.5 | `security-reviewer` — `gpt-6-astra xhigh` | Assets, actors, boundaries, threats, mitigations, non-overridable invariants, and security test backlog | Every remote or persisted input has validation/authentication ownership |
| M0.7 Legacy compatibility and migration map | M0.1, M0.3, M0.5 | `subsystem-builder` — `gpt-5.6-sol high` | Mapping of current config/jobs/triggers/reports/tasks/memory into new versions, including rollback and unsupported cases | Fixture-based migration dry runs preserve current authorization and status semantics |
| M0.8 Contract test harness and examples | M0.3, M0.4, M0.7 | `feature-builder` — `gpt-5.6-terra high` | Shared test helpers, canonical JSON examples, fake clock/ID source, adapter fake, and schema round-trip tests | Deterministic tests pass without network, tmux, or real agents |
| M0.9 Integrated architecture audit | All | `independent-reviewer` — `gpt-6-astra high` | Findings ranked blocker/high/medium/low and a gate recommendation | All blocker/high findings resolved or explicitly rejected with rationale |

## Task Details

### M0.1 Baseline and Inventory

- Record `bun run typecheck`, `bun test`, and `bun run build` output.
- Trace data ownership and mutation from `POST /trigger` through job persistence, OpenCode execution, callback reporting, task synchronization, and memory storage.
- Identify every JSON file format and configuration field that may need migration.
- Produce a compatibility table: keep, translate, deprecate, or replace.

The agent is read-only except for the inventory document. It must not “clean up” current code while investigating.

### M0.2–M0.5 Contract Freeze

- Use opaque branded string IDs at domain boundaries; do not overload one ID type for nodes, runs, tasks, or sessions.
- Define event and command envelopes with `schemaVersion`, stable IDs, actor, timestamps, correlation/causation, and controller epoch where relevant.
- Keep domain events provider-neutral; OpenCode-specific data belongs in adapter metadata.
- Define typed error categories: validation, unsupported capability, policy denied, approval required, conflict, stale epoch, transient transport, timeout, runtime failure, and internal failure.
- Decide transaction boundaries before choosing repository methods.

The architect owns these decisions serially. Implementation agents may challenge a decision through a written issue but may not fork the contract.

### M0.6 Threat Model

At minimum, analyze:

- Forged node/controller identity
- Replay and duplicate command delivery
- Stale-controller split brain
- Project-path traversal and symlink escape
- Approval-envelope mutation
- Terminal input hijack and attachment takeover
- Malicious or compromised agent output
- Secret leakage through logs, events, memory, artifacts, or prompts
- Oversized events/artifacts and resource exhaustion
- Corrupt or downgraded persisted state

Translate mitigations into testable invariants with an owning milestone.

### M0.7 Migration

- Preserve existing profile readability.
- Treat existing bearer-token security as a compatibility mode, not the future node identity scheme.
- Map one legacy trigger to one run, one task, and one dispatch attempt.
- Keep original job IDs as external correlation IDs where they cannot become canonical run/task IDs.
- Define backup, forward migration, failure recovery, and rollback behavior before writing a migrator.

## Expected Code and Documentation Areas

- `src/orchestration/` for domain schemas and interfaces
- `src/runtime/` for provider-neutral runtime contracts
- `src/terminal/` for terminal contracts
- `tests/contracts/` for conformance fixtures
- `Docs/adr/` for decisions
- `Docs/security/` for the threat model

Exact filenames are chosen during M0.2, then frozen for the rest of the milestone.

## Completion Criteria

- Canonical terms and aggregate ownership are documented without unresolved blockers.
- All new persisted/API shapes are versioned Zod schemas with inferred TypeScript types.
- Runtime and terminal fakes compile against their contracts.
- Event ordering, idempotency, lease epoch, and transaction semantics are explicit.
- The system safety floor is expressed as testable invariants.
- Every current persisted format and external endpoint has a migration/compatibility decision.
- Canonical fixtures round-trip and invalid fixtures fail deterministically.
- Full existing test, typecheck, and build suites still pass.
- Independent architecture and security reviews approve the milestone.

## Guardrails and Stop Conditions

- Do not implement the TUI, event-store engine, remote protocol, or new runtime adapters here.
- Do not delete or rewrite current configs/jobs.
- Do not add an automatic-election algorithm.
- Do not expose provider-specific concepts in orchestration events.
- Stop fan-out if M0.2 or M0.5 changes; dependent tasks must be rebased on the new contract.
- Stop the milestone if a safe legacy migration cannot preserve source authorization or project allowlisting.
- A passing compiler is not enough; the contract audit and threat model are required gate artifacts.

## Gate Verification

```bash
bun run typecheck
bun test tests/contracts
bun test
bun run build
git diff --check
```

The milestone lead writes `Docs/implementation-reports/milestone-0-completion.md` and identifies the exact contract versions Milestone 1 must consume.

