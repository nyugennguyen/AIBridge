# Operational Guide 05: Multi-Agent Orchestration & Governance

> **Topic:** Versioned Charters, Immutable Core policy, composite roles, advisory roundtables, and budget ledgers.  
> **Source of Truth:** `src/orchestration/`, `src/orchestration/policy/immutable-core.ts`, `src/rules/limits.ts`.

---

## 1. Charter Governance & The Immutable Core

All multi-agent behavior is governed by a versioned, digest-stamped document called the **Charter**.

### 1.1 Charter Document Structure
* **Global Rules (`globalRules`):** Universal directives applied to all agents.
* **Communication Policy:** Rules governing turn-taking, escalation, and required deliberation before actions.
* **Role Catalog:** Definitions of permitted primary and secondary roles.

### 1.2 The Proposal Lifecycle
Changes to the charter must pass an audited lifecycle:

```
[Agent / Operator]
       │
       ▼ charter.propose (rationale, evidenceRefs)
[Immutable Core Check] ──(Relaxation Violation)──► Rejected (charter_core_violation)
       │
       ▼ Passed
[Pending Proposal Queue]
       │
       ▼ charter.approve / charter.reject (requires AIBRIDGE_OPERATOR_TOKEN)
[charter.revise Event] ──► New digest stamped ──► Active Charter v(N+1)
```

### 1.3 The Six Inviolable Core Constraints
The function `assertCharterDoesNotRelaxCore` strictly refuses any proposal attempting to modify or relax:
1. **Safety Floor:** Baseline command execution protections.
2. **Input Fencing:** Pane ownership locks (Herdr Primitive F1).
3. **Security Perimeter:** `security.allowed_sources` and project allowlists.
4. **Advisory Invariant:** The rule that roundtables are non-executing.
5. **Budget Ceilings:** Global maximum concurrency and fan-out limits.
6. **Kernel Authority:** Kernel event store as the single source of truth.

---

## 2. Dynamic Roles & Deterministic Prompts

Agents do not execute raw prompts; prompts are deterministically compiled and cryptographically digest-stamped by `RoleBinder`.

### 2.1 Composite Role Assignments (`RoleAssignment`)
* **Primary Role:** Exactly one primary role per agent defining baseline behavioral instructions.
* **Secondary Roles:** Zero or more secondary roles contributing bounded addenda (`addendum`).

### 2.2 Strict Capability Intersection
Capability permissions are resolved via strict intersection by default:
$$\text{effectivePermissions} = \text{allowed} \cap \text{roleAllowed} \cap \neg\text{denied}$$

*An agent combining multiple roles never gains permissions that any single assigned role denies.*

### 2.3 Deterministic Prompt Compilation Formula
$$\text{Compiled Prompt} = \text{Charter}.\text{globalRules} + \text{primaryRole} + \sum \text{secondaryRole}.\text{addenda} + \text{communicationPolicy} + \text{taskPrompt}$$

Dispatches lock the exact snapshot digests of the charter, roles, and rules active at initiation.

---

## 3. Governed Deliberation (Advisory Roundtable)

Before executing high-impact workflows, agents participate in structured debate via the **Roundtable**.

### 3.1 Roundtable Lifecycle
```
roundtable.open ──► roundtable.post (N turns) ──► roundtable.close ──► roundtable.outcome_recorded
```

* **Relay Transport:** Posts travel over `mesh.event` envelopes and are relayed by the controller.
* **Total Order:** Determined exclusively at the central SSE event gateway.
* **Outcome Recording:** Deliberation summarizes agreements, recommendations, and addressed/unresolved objections.

### 3.2 The Advisory-Only Invariant
> **`roundtable.closed` is present in zero `COMMAND_EVENT_ALLOWLIST` entries.**
* Roundtables produce advisory recommendations and audit trails.
* Roundtables **never** automatically initiate task execution or state transitions.

### 3.3 Execution Gating (`objectionRequiredBefore`)
* Communication policies can mandate prior debate for sensitive tasks.
* If an execution dispatch is attempted without a concluded roundtable, the kernel rejects it with error code `roundtable_required`.

---

## 4. Fan-Out Schedulers & Budget Ledgers

Parallel execution is constrained by dual budget ledgers:
* **Concurrency Counter:** Limits total simultaneous active agent sessions.
* **Fan-Out Counter:** Limits maximum branching width for $N$-sibling subtasks.
* **Cascading Cancellation:** If a parent task fails or aborts, all spawned fan-out sibling tasks receive immediate termination signals.
* **Hard Ceilings:** Exceeding thresholds throws `maximum_fan_out_exceeded` or `budget_exhausted`.

---

## 5. Operator Credential Authority

High-privilege orchestration operations require verified operator credentials:
* **Token:** Set via `AIBRIDGE_OPERATOR_TOKEN` in the environment or secrets store.
* **Actor Claim:** Emits `actor.kind: "user"`.
* **Required For:**
  - Approving or rejecting charter revisions (`charter.approve` / `charter.reject`).
  - Injecting human operator comments into active roundtables.
  - Emergency task abortion or manual lease revocation.
