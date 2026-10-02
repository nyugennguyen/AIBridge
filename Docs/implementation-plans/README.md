# AIBridge Orchestrator Implementation Plans

## Purpose

This directory turns the product direction in [`Docs/aibridge-tui-agent-orchestrator-brainstorm.md`](../aibridge-tui-agent-orchestrator-brainstorm.md) into executable milestone plans. Each milestone has its own dependency-ordered tasks, Codex model and sub-agent assignments, verification steps, completion criteria, and guardrails.

The plans are designed for a root Codex agent coordinating isolated implementation sub-agents. The root agent remains accountable for scope, integration, final verification, and the milestone gate. Sub-agents own bounded tasks; they do not independently change product contracts or declare a milestone complete.

## Milestone Index

| Milestone | Plan | Outcome |
| --- | --- | --- |
| 0 | [Architecture and migration contracts](./milestone-0-architecture-and-migration.md) | Versioned domain contracts, ADRs, migration map, and threat model |
| 1 | [Single-node TUI vertical slice](./milestone-1-single-node-tui.md) | One approved OpenCode task operated completely through `aibr tui` |
| 2 | [Multi-runtime adapter layer](./milestone-2-runtime-adapters.md) | OpenCode, Claude Code, and Codex behind one conformance-tested interface |
| 3 | [Orchestration kernel](./milestone-3-orchestration-kernel.md) | Event-sourced runs, task graph, roles, policy, approvals, and retries |
| 4 | [Distributed Tailscale mesh](./milestone-4-distributed-mesh.md) | Secure, recoverable multi-node orchestration with manual takeover |
| 5 | [Shared memory and context](./milestone-5-memory-and-context.md) | Scoped, attributable, redacted memory and deterministic context manifests |
| 6 | [Rules, automation, and workflows](./milestone-6-rules-and-workflows.md) | Safe pre-approval, reusable workflows, budgets, simulation, and notifications |
| 7 | [Polyglot ingress and durable admission](./milestone-7-polyglot-ingress.md) | Native Rust ingress router, durable admission before acknowledgement, Fastify removed from the engine |
| 8 | [Hardening and ecosystem](./milestone-8-hardening-and-ecosystem.md) | Recovery, diagnostics, plugin SDK, upgrades, limits, and ecosystem readiness |

Milestones are sequential release gates. Research spikes for a later milestone may run early, but production code for milestone `N+1` must not become a dependency of milestone `N`.

## Codex Model Strategy

These recommendations are defaults for the implementation period and must be rechecked when work begins. Current official OpenAI guidance describes GPT-6 Astra as the flagship for the hardest reasoning and coding work, GPT-5.6 Terra as the balance of intelligence and cost, and GPT-5.6 Luna as the cost-sensitive high-volume option ([OpenAI model catalog](https://developers.openai.com/api/docs/models)). Official guidance also recommends explicitly directing when and how a model should delegate to sub-agents ([GPT-6 Astra model guidance](https://developers.openai.com/api/docs/guides/latest-model#subagent-delegation)).

| Model | Default effort | Use in these plans | Do not use as |
| --- | --- | --- | --- |
| `gpt-6-astra` | `high`; `xhigh` for security/protocol review | Architecture, security boundaries, distributed correctness, cross-cutting integration, milestone audit | A routine formatter or repetitive fixture writer |
| `gpt-5.6-sol` | `high` | Complex subsystem implementation, adversarial tests, recovery logic, independent review | The owner of multiple competing schema designs in parallel |
| `gpt-5.6-terra` | `medium` or `high` | Normal TypeScript implementation, adapters, routes, stores, TUI components, integration tests | Final authority for safety or protocol decisions |
| `gpt-5.6-luna` | `medium` | Focused fixtures, mechanical migrations, documentation, compatibility tables, deterministic test matrices | Independent architecture or security decisions |

Use the lowest tier that reliably satisfies the task. Escalate a task one tier when it crosses two or more subsystem boundaries, changes a security invariant, involves concurrency/recovery, or has failed review twice. Do not downgrade final security, migration, or milestone-gate review below `gpt-6-astra high`.

## Standard Sub-Agent Team

The names below are reusable roles, not long-lived agents. Spawn a fresh sub-agent for a bounded task unless continuity is necessary for the same subsystem.

| Sub-agent | Model | Responsibility |
| --- | --- | --- |
| `milestone-lead` | `gpt-6-astra high` | Own task graph, freeze contracts, sequence work, integrate, and prepare the gate report |
| `architect` | `gpt-6-astra xhigh` | Resolve domain, protocol, persistence, and failure semantics before code fans out |
| `security-reviewer` | `gpt-6-astra xhigh` | Threat-model and review trust boundaries; normally read-only |
| `subsystem-builder` | `gpt-5.6-sol high` | Implement a complex isolated subsystem with its tests |
| `feature-builder` | `gpt-5.6-terra high` | Implement a normal feature slice with unit/integration tests |
| `test-engineer` | `gpt-5.6-sol high` | Build adversarial, concurrency, recovery, and end-to-end tests independently |
| `fixture-worker` | `gpt-5.6-luna medium` | Add fixtures, schema examples, compatibility matrices, and focused documentation |
| `independent-reviewer` | `gpt-6-astra high` | Review the integrated diff against scope, contracts, safety, and acceptance criteria |

## Required Execution Protocol

1. **Start cleanly.** The root agent records the current branch, worktree status, baseline test result, and milestone prerequisites. Existing user changes are never overwritten or silently included.
2. **Freeze shared contracts first.** The milestone lead completes schema and interface decisions before implementation sub-agents begin. Contract changes after fan-out require stopping affected agents and explicitly rebasing their tasks.
3. **Isolate write ownership.** Parallel sub-agents use separate git worktrees or mutually exclusive file ownership. Two agents must never edit the same schema, barrel export, migration, lockfile, or shared fixture concurrently.
4. **Keep tasks bounded.** Each task prompt includes objective, allowed paths, forbidden changes, dependencies, tests, acceptance criteria, and required handoff format.
5. **Require a handoff.** Every sub-agent returns changed files, commands run, results, known limitations, and any contract assumption. “Tests pass” without command output is insufficient.
6. **Integrate centrally.** Only the milestone lead/root agent resolves cross-task conflicts, updates shared exports, changes dependencies, and runs the milestone test matrix.
7. **Review independently.** The independent reviewer receives the milestone specification and integrated diff, not the implementation conversation. Security-sensitive milestones also require the security reviewer.
8. **Close the gate.** The root agent documents evidence for every completion criterion and guardrail before starting the next milestone.

## Global Guardrails

- Preserve ESM and `.js` local import extensions.
- Keep Zod schemas as the source of truth for external and persisted data types.
- Wrap external services and process behavior behind interfaces with injected dependencies.
- Keep OpenCode loopback-only and bind AIBridge only to the configured Tailscale address or loopback.
- Never persist or log bearer tokens, provider credentials, raw environment values, or unredacted secrets.
- Resolve and validate project paths before process launch; never widen allowlists implicitly.
- Remote commands must be idempotent before retries are enabled.
- Unknown runtime state must remain `unknown`; adapters may not infer successful completion from silence.
- Approved dispatch content is immutable. Any material change creates a new digest and requires reevaluation.
- Running roles and policies are snapshots; template edits affect future dispatches only.
- New persistence formats require a version, migration path, rollback story, and corrupt-data test.
- No automatic controller election is introduced by these milestones.
- Do not add a second programming language unless a milestone plan explicitly changes this decision through an ADR. Rust is permitted under [ADR 0008](../adr/0008-polyglot-ingress-and-admission.md), within `router/` only, for ingress admission. The guardrail stands unchanged for `src/`.
- A sub-agent may not perform release, publish, deployment, credential rotation, node enrollment, or destructive cleanup.

## Common Verification Commands

Run the narrowest relevant tests during task work, then use the complete gate suite before milestone completion:

```bash
bun run typecheck
bun test
bun run build
git diff --check
```

When dependency or packaging behavior changes, also run:

```bash
bun run release:check
```

Milestone-specific test commands supplement this list. A flaky test is a failure until its cause is understood; rerunning until green is not acceptance evidence.

## Milestone Gate Report

Each milestone closes with a short report in `Docs/implementation-reports/` containing:

- Scope delivered and intentionally deferred
- Task IDs and owning sub-agents/models
- Contract or schema versions introduced
- Migration and rollback notes
- Test commands and results
- Security-review findings and dispositions
- Known limitations and risks accepted
- Evidence for every completion criterion
- Exact prerequisites handed to the next milestone

The report filename is `milestone-<N>-completion.md`. The root agent, independent reviewer, and—where required—security reviewer must all sign off in the document.

