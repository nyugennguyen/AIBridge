# ADR 0013: Operator Approval for Approval-Gated Jobs Uses a Local Approval Ledger

- **Status:** Accepted
- **Date:** 2026-11-25
- **Related:** [Claude adapter & plugin plan](../implementation-plans/claude-adapter-and-plugin.md) Phase 4, [review](../implementation-plans/claude-adapter-and-plugin-review.md) §2 Phase 4; [ADR 0008](./0008-polyglot-ingress-and-admission.md) §4 (operator credential); [ADR 0003](./0003-event-store-and-idempotency.md)

## Context

Phase 2 refused every approval-gated capability on a `runtime.kind: "claude"` node with
`403 approval_required`, because the only existing signal, `metadata.plan_status`, is written
by the caller. Phase 4 must let such jobs run once a human on the worker approves them.

The plan suggested driving the kernel's `dispatch.propose -> dispatch.approve -> dispatch.execute`
through `POST /orchestration/commands`. Two facts make that disproportionate today:

1. `aibr serve` does not attach the orchestration kernel at all (`startBridge` is called without
   `orchestration`), so on a real worker there is no coordinator to record into.
2. Where the kernel *is* attached, a legacy `/trigger` is recorded as a held DRAFT/PAUSED run with
   a PENDING task (M4-A). Making it schedulable needs a controller lease, run activation, task
   promotion and a canonical `approval.decided`, none of which the Claude job runner consumes:
   it launches from the job record, not from a kernel effect.

(3.2.0: the kernel and `POST /orchestration/commands` were removed, [ADR 0016](0016-keep-selected-unwired-code-with-deadlines.md); this ledger is the approval record.)

## Decision

1. The worker decides whether a job needs approval from **its own config only**: the profile's
   `requires_approval`, `planning.require_approval_for`, and the source's `requires_plan_approval`.
   `metadata.plan_status` is ignored for the Claude runtime.
2. Such a job is created with status `awaiting_approval` and a pending `approval` record, the trigger
   answers `202 {status: "awaiting_approval", approve_hint}`, and nothing is launched. When the
   trigger names a `repo`, the sha is resolved **before** the job is created, so the operator
   approves an exact commit rather than a moving branch.
3. Decisions are made through `POST /jobs/:id/approve` and `POST /jobs/:id/reject`, which accept
   only `Authorization: Bearer <operator token>` (constant-time compare; the peer bearer gets 403)
   and, unless `security.approval_from_loopback_only` is `false`, only requests from the worker
   itself (loopback or one of its own interface addresses — the bridge usually binds the Tailscale
   address, so `aibr approve` arrives from that address). `aibr approve | reject | jobs pending`
   wrap them.
4. Every request, decision, expiry and kill-switch use is appended to
   `<state>/approvals.jsonl` (mode 0600) **before** it takes effect. Entries carry `seq` and the
   sha256 of the previous line, so a deleted or edited entry breaks the chain
   (`verifyApprovalLedger`). Entries hold ids, capability, source, sha and reason — never a token.
5. When the kernel is attached, `acceptTrigger` still records the job (as the same held run it
   records for every legacy trigger); the approval itself is not minted as a kernel
   `approval.decided`, for the reason M4-A gives: route checks must not be laundered into kernel
   authority.

## Consequences

- An approval is auditable and tamper-evident on the node that granted it, without a kernel.
- Approval is single-use: the job leaves `awaiting_approval` atomically with the decision, an
  in-flight guard serializes concurrent decisions, and a second approve is `409`.
- An approval request lapses after the trigger's `timeout_seconds` (also enforced by the startup
  sweep); approving it then answers `409 approval_expired` and reports the job `timed_out`.
- The ledger is local: it is not replicated across the mesh and is not part of the kernel's digest
  chain. Moving approvals into kernel events (`approval.decided` against the held run) is
  follow-up work once `aibr serve` attaches the kernel; the ledger's event shapes were chosen to
  map onto that one-to-one.
- The operator token stays out of the job's reach: the child-environment sanitizer strips every
  `AIBRIDGE_*` variable from the Claude and script children, and the safety floor denies reading
  the AIBridge data directory at its default location. A custom `XDG_DATA_HOME` is not covered by
  that deny rule; the worker's OS user remains the real boundary.

## Amendment (3.1.2): every runtime

Decision 1 originally applied to the Claude runtime only. The OpenCode runtime (the default
`runtime.kind`) and the router drainer still took the caller-written `metadata.plan_status:
"approved"` as an approval, and so did the OpenCode tool permission policy for
`permissions.require_plan_approval_for_tools`. A peer could approve its own work, which this ADR
exists to prevent. From 3.1.2:

1. The decision is one function, `approvalRequired` (`src/planning/approval.ts`), used by every
   runtime and both ingress modes. `metadata.plan_status` is not an input anywhere; the bridge only
   logs a warning when a caller sends `"approved"`.
2. On the engine ingress, a gated OpenCode job is held as `awaiting_approval` with an
   `approval.requested` ledger event, exactly like a Claude job, and `POST /jobs/:id/approve`
   launches it on the OpenCode runtime. A gated OpenCode trigger with `depends_on` is refused with
   `501`, as on the Claude runtime.
3. The router ingress has no operator approval path (the router serves no operator routes), so the
   drainer refuses gated capabilities with `PLAN_APPROVAL_REQUIRED`.
4. OpenCode tools in `require_plan_approval_for_tools` are allowed only for a job whose `approval`
   record says an operator approved it.
