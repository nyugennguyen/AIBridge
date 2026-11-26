# ADR 0016: Keep Selected Unwired Code With Deadlines; Remove the Rest

- **Status:** Proposed (becomes Accepted when block D1 of the 3.2.0 plan merges)
- **Date:** 2026-11-26
- **Related:** [3.2.0 plan](../implementation-plans/v3.2.0-plan.md) (sections 2, 5.1 to 5.6); [ADR 0003](./0003-event-store-and-idempotency.md); [ADR 0004](./0004-controller-leases-and-recovery.md); [ADR 0007](./0007-rule-language-and-evaluation.md); [ADR 0013](./0013-operator-approval-ledger.md); [ADR 0014](./0014-claude-is-the-operator-interface.md); [ADR 0015](./0015-orchestrator-is-chosen-per-project.md). Supersedes ADR 0004 and ADR 0007. Resolves the question ADR 0014 left open.

## Context

Measured from the two runtime entry points (`src/cli.ts`, `src/index.ts`) following every relative `import`, `export ... from` and `import()`, about 55,700 of 98,700 lines in `src/` can never run. They arrived as large milestone commits (kernel, rules, workflows, simulation, budgets and routing; memory and context; mesh) and were never connected to `aibr serve`. Examples: the coordinator writes outbox rows to a destination nothing reads; the mesh has no network transport outside its fault-injection harness; the orchestration routes are registered but `aibr serve` never passes them data.

The product direction (3.2.0 plan section 2) is an orchestrator per project, memory shared by project and session, budgets and limits per worker, and `aibr` following jobs instead of agents polling. Part of the unwired code is the base for that; part belongs to the old kernel architecture and duplicates what an orchestrator agent now does.

## Decision

1. **Remove** (blocks D1 to D5): rules, workflows, simulation, budgets, routing, registry, sdk and upgrade; the dead part of mesh; the kernel (coordinator, scheduler, projections, charter and roundtable runtime) and `routes/orchestration.ts`; `notifications/consumer.ts`.
2. **Keep, with a wire deadline and a delete deadline** (a release by which the code must be reachable, and one by which it is deleted if it is not):

   | Path | Serves | Wire by | Delete by |
   |---|---|---|---|
   | `src/memory` (without `migration.ts`) | V4 handoff, V3 project memory | 3.3.0 | 3.4.0 |
   | `src/orchestration/event-store` | V4 job event log | 3.3.0 | 3.4.0 |
   | `src/runtime/codex-adapter.ts`, `src/runtime/discovery.ts` | V1 Codex runtime | 3.3.0 | 3.4.0 |
   | `src/context` | V3 context snapshot | 3.4.0 | 3.5.0 |
   | `src/notifications` (without `consumer.ts`) | V5 Discord and Telegram | 3.5.0 | 3.6.0 |

   `src/memory/redaction` is wired in 3.2.0 (secret filter on job results) and needs no entry.
3. Tag the last commit that still contains the removed kernel and mesh as `archive/kernel-mesh-3.1.1`, so the design can be recovered.
4. Add a reachability check (`bun run docs:reachability`, part of `docs:check`) with an exemption list in `scripts/docs/reachability-exemptions.json`. It warns when a directory has 500 or more unreachable lines that no exemption covers. It fails when an exemption is past its wire deadline (compared with the `package.json` version) and its code is still unreachable: wire it, extend the deadline with a reason, or delete it.

## Consequences

- ADR 0004 (controller leases) and ADR 0007 (rule language) become `Superseded by ADR 0016`. Leases solved several controllers competing for one run; the product now has one orchestrator per project, and transport between nodes is `/trigger`, `/report`, the egress outbox and signed requests.
- ADR 0003 (event store and idempotency) stays `Accepted`, with a note that it is not yet wired, deadline 3.3.0. Wiring it to jobs needs job and handoff event types, which changes `contracts/v1`; that is 3.3.0 work.
- ADR 0013 is unchanged.
- `AGENTS.md` and `README.md` describe what actually runs, plus a "Not yet wired" section listing the kept code and its deadlines.
- Kept code was never exercised in production and is reviewed again when it is wired.

## Alternatives

- Keep everything as roadmap. Rejected: it keeps the kernel and mesh, which the new direction does not use.
- Remove everything unwired in phases. Rejected: memory, context and the event store would be deleted and then rewritten in 3.3.0 for V3 and V4.
