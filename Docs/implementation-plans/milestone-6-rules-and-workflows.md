# Milestone 6: Rules, Automation, and Reusable Workflows

## Objective

Allow users to reduce repetitive approvals safely through explainable bounded rules, reusable roles and run templates, fan-out/concurrency/cost/time budgets, deterministic dry-run simulation, and attention notifications. The default remains approval required for every dispatch.

## Prerequisites

- Milestone 3 policy/approval semantics and immutable dispatch digests are stable.
- Milestone 5 context manifests are deterministic and previewable.
- Mesh identities and capability reports are trustworthy enough for routing predicates.
- The system safety floor is separately implemented and cannot be edited through project rules.

## Agent Plan

| Task | Dependency | Sub-agent and model | Deliverable | Verification |
| --- | --- | --- | --- | --- |
| M6.1 Rule language and evaluation ADR | M3, M5 | `architect` — `gpt-6-astra xhigh` | Declarative predicates/actions, precedence, determinism, versioning, conflict, explanation, and limits | Example rules cover every supported field without arbitrary code execution |
| M6.2 Rule parser/validator/evaluator | M6.1 | `subsystem-builder` — `gpt-5.6-sol high` | Zod schema, normalized AST, evaluator, trace, and safety-floor composition | Truth tables, fuzzed invalid inputs, complexity limits, deterministic output |
| M6.3 Rule preview and impact analysis | M6.2 | `feature-builder` — `gpt-5.6-terra high` | Match current proposals/history, future-scope summary, conflicts, and pre-approval warning | Preview and runtime evaluator use the same compiled rule artifact |
| M6.4 Role packs and run templates | M6.1–M6.2 | `feature-builder` — `gpt-5.6-terra high` | Versioned reusable templates with parameters and immutable instantiation snapshots | Template edits do not mutate created runs/roles |
| M6.5 Budgets and admission control | M6.2, M6.4 | `subsystem-builder` — `gpt-5.6-sol high` | Fan-out, concurrent session, retry, wall-time, and optional usage budgets | Reservation/release/crash tests prevent limit bypass |
| M6.6 Routing preferences | M6.2, M6.5 | `feature-builder` — `gpt-5.6-terra high` | Deterministic eligible-node/runtime ranking with explanation | Same registry snapshot gives same choice; unhealthy nodes excluded |
| M6.7 Dry-run simulator | M6.3–M6.6 | `subsystem-builder` — `gpt-5.6-sol high` | Side-effect-free expansion of tasks, routing, policies, approvals, contexts, and budgets | Assert no event append, network call, process launch, or reservation |
| M6.8 TUI rule/workflow experience | M6.3–M6.7 | `feature-builder` — `gpt-5.6-terra high` | Builder, raw view, preview, conflict/explanation, enable/disable, template creation, simulation | Keyboard-only flows and dangerous-rule warnings tested |
| M6.9 Notifications | M4, M6.5 | `feature-builder` — `gpt-5.6-terra medium` | In-TUI notifications for blocked/failed runs and lease expiry; optional adapter interface | Deduplication, acknowledgement, quieting, and no-secret payload tests |
| M6.10 Policy-bypass review | All | `security-reviewer` — `gpt-6-astra xhigh` | Adversarial rules/templates/budgets review | No user rule expands the safety floor or bypasses approval by mutation |

## Rule Language Boundaries

Use a declarative, versioned JSON/YAML-compatible schema. Do not evaluate JavaScript, shell, regular expressions without complexity bounds, or arbitrary user functions.

Initial predicates may reference only:

- Project ID
- Role ID/version
- Capability and tool category
- Target node/runtime and advertised capabilities
- Allowlisted project path ID, not arbitrary raw path matching
- Task labels and dependency outcomes
- Fan-out, retry, concurrency, and timeout values
- User-defined schedule window with explicit timezone
- Context sensitivity classes

Initial actions:

- Deny with reason
- Require approval
- Pre-approve within explicit bounds
- Add restrictions
- Select routing preference
- Set a stricter budget

No action can grant a capability removed by the system floor or role restriction.

## Pre-Approval Requirements

A pre-approval rule must show:

- Exact predicate and normalized form
- Projects, roles, capabilities, nodes, and paths it can match
- Maximum fan-out, concurrency, retry, timeout, and sensitivity
- Historical dispatches it would have matched
- Conflicts or shadowing by other rules
- Expiry or “no expiry” warning
- Creator identity, version, and activation time

Changing an enabled rule creates a new version and disables the old version only for future proposals. Existing approvals and active dispatch snapshots remain unchanged.

## Budgets and Routing

- Reserve concurrency/fan-out budget transactionally before dispatch becomes eligible.
- Release on terminal dispatch state and recover leaked reservations after replay.
- Wall-time is locally enforceable. Provider cost/token budgets are optional and only enforced when the adapter reports reliable usage; otherwise show “not enforceable.”
- Routing first filters by hard eligibility, then applies deterministic user preferences, then stable tie-breaking.
- A rule cannot route to a node that lacks authorization, project path, runtime capability, or health.

## Dry-Run Requirements

The simulator receives immutable snapshots of registry, roles, rules, memory metadata, and proposed workflow. It returns:

- Expanded tasks and dependency graph
- Candidate and selected targets with reasons
- Effective role/policy/context manifest summaries
- Required approvals and matched pre-approvals
- Budget reservations and rejected work
- Warnings for unavailable, unknown, or unenforceable capabilities

Dry-run code must use pure planners/evaluators shared with production while replacing all command sinks with fail-closed fakes.

## Completion Criteria

- Default installations still require approval for every dispatch.
- User rules are versioned, deterministic, bounded, explainable, and cannot execute code.
- Preview and runtime use the identical compiled rule representation.
- Pre-approval is restricted to the exact displayed bounds.
- Safety-floor and role restrictions cannot be weakened.
- Run/role template edits do not mutate instantiated snapshots.
- Fan-out, concurrency, retry, and wall-time budgets survive restart and replay.
- Dry run produces no persistent or external side effect.
- Routing is deterministic for the same registry snapshot and excludes unauthorized/unhealthy nodes.
- Notifications are deduplicated and contain no secret prompt/context content.
- Security review finds no approval, mutation, or budget bypass.

## Guardrails and Stop Conditions

- Do not create a general-purpose scripting language.
- Do not enable a broad pre-approval rule without an explicit activation confirmation.
- Do not support “match all projects/nodes/capabilities” pre-approval in the initial release.
- Do not claim provider cost enforcement when usage data is missing or delayed.
- Do not let notification delivery affect orchestration state.
- Stop if preview and production evaluation can diverge.
- Stop if a rule edit can retroactively affect an active dispatch or approval.
- Stop if budget reservation is not atomic with dispatch eligibility.

## Gate Verification

```bash
bun test tests/unit/rules
bun test tests/unit/workflows
bun test tests/unit/budgets
bun test tests/integration/rule-preview.test.ts
bun test tests/integration/dry-run.test.ts
bun test tests/integration/automation-safety.test.ts
bun run typecheck
bun test
bun run build
git diff --check
```

The gate report includes the rule language version, supported predicate/action table, safety-bypass test results, canonical simulations, and all enabled-by-default behavior.

