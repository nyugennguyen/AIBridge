# Milestone 5: Shared Memory and Context Engineering

## Objective

Create structured, scoped, attributable memory and deterministic context assembly so agents receive relevant continuity without uncontrolled transcript sharing. Extend the current decision/constraint/handoff store through compatibility migration rather than silently replacing it.

## Prerequisites

- Milestone 3 provides versioned event storage and immutable dispatch envelopes.
- Milestone 4 provides authenticated node identity and secure payload transport.
- Project, run, task, dispatch, session, role, and actor identities are stable.
- Secret-handling and project-isolation invariants are part of the enforced safety floor.

## Agent Plan

| Task | Dependency | Sub-agent and model | Deliverable | Verification |
| --- | --- | --- | --- | --- |
| M5.1 Memory ontology and trust model | M3–M4 | `architect` — `gpt-6-astra xhigh` | Record kinds, scopes, provenance, trust, sensitivity, retention, supersession, conflict semantics | Sample decisions/handoffs/findings map without ambiguous ownership |
| M5.2 Memory schemas and repository | M5.1 | `subsystem-builder` — `gpt-5.6-sol high` | Versioned records, append/supersede/query APIs, event integration, indexes | Scope, chronology, supersession, migration, and replay tests |
| M5.3 Legacy memory migration | M5.1–M5.2 | `feature-builder` — `gpt-5.6-terra high` | Import current decisions, constraints, and handoffs with source provenance | Golden fixtures preserve content/status and remain rollback-safe |
| M5.4 Redaction and sensitivity pipeline | M5.1 | `security-reviewer` + `subsystem-builder` — `gpt-6-astra xhigh` / `gpt-5.6-sol high` | Pluggable detectors, explicit labels, redacted derivatives, no-secret logging | Seeded-secret and false-positive/negative test corpus |
| M5.5 Deterministic context assembler | M5.1–M5.4 | `subsystem-builder` — `gpt-5.6-sol high` | Policy-driven selection, stable ordering, budgets, hashes, manifest, rendered prompt sections | Same inputs/config yield identical manifest and digest |
| M5.6 Agent-proposed memory workflow | M5.2–M5.5 | `feature-builder` — `gpt-5.6-terra high` | Proposed/untrusted records, accept/reject/supersede commands, audit events | Agent cannot directly create trusted project facts |
| M5.7 Handoff and result summarization | M5.5–M5.6 | `feature-builder` — `gpt-5.6-terra high` | Structured dependency results and handoff packets with artifact references | Downstream context excludes unrelated transcript/output |
| M5.8 TUI memory/context views | M5.2–M5.7 | `feature-builder` — `gpt-5.6-terra high` | Browse/filter/provenance/sensitivity/supersession and dispatch-context preview | UI tests show exact included/excluded items and reasons |
| M5.9 Isolation and leakage audit | All | `independent-reviewer` — `gpt-6-astra high` | Cross-project/node/role attack review and data-flow findings | No unauthorized record, secret, or artifact reference crosses boundary |

## Memory Record Contract

Each record includes:

- Stable record ID and schema version
- Project ID and optional run/task/dispatch/session scopes
- Record kind
- Structured payload plus optional human-readable summary
- Author actor and source event/artifact references
- Created time and content hash
- Trust status: proposed, accepted, rejected, or system-derived
- Sensitivity: public-to-project, restricted, secret-reference-only, or prohibited
- Retention policy and optional expiry
- Supersedes/superseded-by references
- Redaction status and derivative source reference

Records are append-only. Corrections supersede earlier records; they do not mutate or erase history. Physical deletion for an explicit retention/privacy operation must leave a non-sensitive tombstone event and is designed separately from ordinary supersession.

## Context Manifest

The assembler produces an immutable manifest before rendering text:

```ts
interface ContextManifest {
  manifestId: string
  schemaVersion: number
  projectId: string
  runId: string
  taskId: string
  dispatchId: string
  roleSnapshotHash: string
  items: ContextManifestItem[]
  excluded: ContextExclusion[]
  budget: { maximum: number; estimated: number; unit: "tokens" | "bytes" }
  policyVersion: string
  digest: string
}
```

Each included item records source ID, source hash, rendered hash, scope, reason, sensitivity decision, and ordering key. Exclusions record a reason without leaking prohibited content.

Context assembly order is fixed:

1. System safety instructions
2. Approved dispatch and role snapshot
3. Active project constraints and decisions
4. Direct dependency results and handoffs
5. Explicit task file/artifact references
6. Bounded run summary

Within a category, sort by configured priority, then stable source ID. Budget pruning removes lowest-priority optional items and records every exclusion.

## Redaction Design

- Redaction runs before persistence when input is prohibited and before transmission when destination restrictions apply.
- Store references to secrets, never secret values, when agents need to know that a credential exists.
- Combine deterministic patterns, configured sensitive paths/keys, and explicit labels. Do not promise perfect automatic secret detection.
- Users can mark a false positive, but unredacting restricted content requires an explicit authorized action and a new derived record.
- Diagnostic messages identify record IDs and rules, not matched secret text.
- Artifact readers enforce the same project/node/role policy as memory records.

## Completion Criteria

- Every memory record has scope, provenance, trust, sensitivity, retention, and hash metadata.
- Legacy decisions, constraints, and handoffs migrate without content or status loss.
- Agents can propose but cannot directly trust project memory.
- Supersession preserves history and active-view queries choose the correct record.
- Context assembly is deterministic and dispatch approval binds to the manifest digest.
- Every included item is explainable; every excluded item has a non-sensitive reason.
- Cross-project, role-restricted, and node-restricted access tests pass.
- Seeded secrets never appear in event logs, application logs, context sent to unauthorized nodes, or exported audit fixtures.
- The TUI previews the exact context before approval.

## Guardrails and Stop Conditions

- Do not store complete raw transcripts as memory by default.
- Do not use semantic/vector retrieval until deterministic scoped retrieval is correct and measurable.
- Do not let an LLM's summary become trusted fact without provenance and acceptance policy.
- Do not mutate prior records to “fix” history.
- Do not transmit restricted content merely because a target node is inside Tailscale.
- Stop if context rendering can differ without a manifest/digest change.
- Stop if migration cannot distinguish legacy trusted user content from agent-generated content; default uncertain imports to proposed/review-needed.

## Gate Verification

```bash
bun test tests/unit/memory
bun test tests/unit/context
bun test tests/integration/memory-migration.test.ts
bun test tests/integration/context-isolation.test.ts
bun run typecheck
bun test
bun run build
git diff --check
```

The gate report includes the ontology version, migration counts, redaction corpus results, deterministic manifest hashes, and isolation-audit disposition.

