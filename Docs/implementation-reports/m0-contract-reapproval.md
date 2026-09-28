# M0 Contract Re-Approval Record

**Status:** APPROVED **WITH CONDITIONS**
**Date:** 2026-09-28
**Triggered by:** Milestone 3, `Docs/implementation-reports/milestone-3-completion.md` §2
**Contract-surface-digest:** `c4d12a3feaa3eaeb8128e2bc7ac9a9269373f620ea20f1404599add11b0dd13a`

> **Digest history.** This record was first issued against digest
> `d4f4b947…00291`, which **omitted `src/orchestration/transitions.ts`**. The
> security review found that omission (finding S-3): since the
> lifecycle/observation split, `transitions.ts` is the source of every persisted
> enum and of the observation→lifecycle map, so the approval's tripwire would not
> have fired on a transition-table change. The surface was corrected and this
> record re-issued against a digest that includes it. The *contract shape* under
> review is unchanged; only the coverage of the tripwire changed, and it changed
> in the strictly more conservative direction.

## Sign-off

| Role | Verdict | Basis |
| --- | --- | --- |
| Milestone owner (root) | **APPROVE** | Mechanical evidence: contract suite green, six-line frozen-example diff, vocabulary alignment proved |
| Independent reviewer | **APPROVE WITH CONDITIONS** | Design sound; could not break it. Four medium conditions (F1–F4) |
| Security reviewer | **APPROVE WITH CONDITIONS** | SF-13 and SF-14 hold; no laundering path found. Three medium conditions (S-1–S-3) |

The owner's original approval was, in the independent reviewer's words,
**correct in direction but under-evidenced** — it rested on test counts and diff
size, with no soundness proof of the enum derivation and no adversarial test of
the two constraints the change added. That is now supplied by the two reviews
below. The corrected digest supersedes it.

## What was approved

The M0 canonical domain contracts as they stand after Milestone 3's
lifecycle/observation split (`24b9aef`).

| Contract | Change | Approved as |
| --- | --- | --- |
| `runSchema` | gains required `paused: boolean`; `paused` removed as a lifecycle state | Correct — a pause is a run-level gate, not lifecycle |
| `taskSchema` | gains required `failurePolicy`; accepts `draft` and `skipped`; `blocked` removed as persisted | Correct — blocked-ness is a function of the graph; persisting it creates two sources of truth |
| `sessionSchema` | `state` replaced by required `lifecycleState` + `observedState` | Correct — the kernel must not conflate "the provider said it is working" with "this dispatch is running" |
| `dispatchSchema` | `queued` removed as a persisted state | Correct — `queued` is derived (approved, awaiting a slot) |
| `approvalSchema` | gains required `state`, constrained against `decision` | Correct — without it, "approval becomes invalid after any envelope mutation" was unreachable |

Frozen examples changed by 6 lines across five aggregates. Persisted enums now
derive from `transitions.ts`, so future drift is a compile error rather than a
cast. The drift class is **structurally dead**: `z.enum(RUN_STATES)` consumes the
same `const` array the machine iterates, and `types.ts` no longer re-exports the
unions, so the old hiding place no longer typechecks.

## Verified not lost

No fact became inexpressible. `blocked`, `queued` and `paused` are all still
derivable (`tui-adapter` derives `blocked` from the dependency graph); the
provider vocabulary survives intact on `observedState`, including `blocked` and
`unknown`; and no example or assertion was quietly weakened — `examples.test.ts`
and `conformance.test.ts` are **unchanged** since baseline, and the exact 15-name
frozen set is still asserted.

## Conditions (must be discharged)

Confirmed by direct probe; each reproduces.

| id | Sev | Condition | Status |
| --- | --- | --- | --- |
| **F4** | Med | **ADR 0001 was not updated.** Lines 39–42 still declare `paused`/`blocked`/`queued` and the provider session vocabulary as *canonical*. Line 96 requires a canonical-vocabulary change to update the ADR. **The ADR now contradicts the code.** | **OPEN** |
| **S-3** | Med | The re-approval digest omitted `transitions.ts`, the source of every persisted enum. | **FIXED** — surface corrected, record re-issued |
| **S-1** | Med | The pause gate is clearable by re-emitting `run.created`. Nothing owns `paused`: no command, no event, no un-pause path. A second `run.create` for an existing `runId` (fresh `commandId`, so neither the command receipt nor the sequence unique-index catches it) is accepted, and the reducer overwrites `paused` unconditionally. | **OPEN** |
| **F1** | Med | `approvalSchema` accepts `decision:"approved"` + `state:"pending"`, yet `decision` and `decidedAt` are both required — so the only way to build a pending `Approval` is to fabricate a decision that was never taken. ADR 0001:43 says an undecided dispatch has no decision record. | **OPEN** |
| **F2** / **S-4** | Med/Low | `paused: true` is accepted with **every** run state, including terminal `completed`/`failed`/`cancelled`. The old `state:"paused"` enum made this unrepresentable; the boolean decomposition gave up mutual exclusivity. | **OPEN** |
| **S-2** | Med | `sessionSchema` does not bind `lifecycleState` to `observedState`. All 49 pairs parse, including terminal-lifecycle-with-non-terminal-observation. The same commit added exactly this class of `superRefine` to `approvalSchema` and omitted it on the session. Audit/UI lie, not authority. | **OPEN** |
| **F3** / **S-7** | Med | **How is a run resumed? It isn't.** `paused` is written once and never cleared. A paused run is a permanent tombstone (`scheduler` yields no schedulable task). Fail-closed, so security-positive, but an operational dead end. | **OPEN** |
| **S-6** | Low | The read/replay path does not consult the machine: an illegal session regression (`running → launching`) is accepted silently. Pre-existing, but the split made `canTransitionSession` reachable from the payload, so it is now a one-assertion fix. | **OPEN** |
| **F5** | Low | The new `approvalSchema.superRefine` has zero coverage in `tests/contracts`. Not a live risk — covered in `tests/unit/orchestration/{policy,policy-adversarial}.test.ts` — but the M0 suite does not assert the constraint the change introduced. | **OPEN** |
| **F6** | Info | `RunProjection` encodes one fact three ways (`lifecycleState`, `state`, `paused`). Two sites defensively undo the conflation. | Accepted |

### Smallest safe fixes, per the reviewers

- **F4** — amend ADR 0001 §39–43, or supersede it.
- **S-1** — in `DispatchCoordinator.#createRun`, reject a `run.create` whose `readRun(runId) !== undefined`; and/or give `paused` an owning event so no `run.created` can rewrite it.
- **S-2** — `sessionSchema.superRefine`: a terminal `lifecycleState` requires `observedState ∈ {completed, failed, unknown}`. Compatible with every in-repo producer.
- **F1** — forbid `decision:"approved"` with `state:"pending"` in the existing `superRefine`.
- **F2/S-4** — `runSchema.superRefine`: `paused` implies a non-terminal state.
- **S-6** — assert `canTransitionSession(previous, recorded)` in the `session.observed` reducer arm and quarantine rather than accept.
- **F3/S-7** — document `paused` as a create/import-time hold, or add `run.resume`.

### Versioning carve-out (both reviewers)

The event payload shape changed while `schemaVersionSchema` remains
`z.literal(1)`, and `identifiers.ts:27` makes a version bump structurally
impossible — so **this shape break is unversionable**. The documented v2 rollback
boundary ("a v1 binary can still read a v2 database") does not account for it.
Failure mode is loud, not silent: a pre-split `run.created` or `session.observed`
is rejected on read. The documentation is what is wrong. Resolve by widening
`schemaVersionSchema` before the next shape change, or by amending the
`migrations.ts` v2 note to state that event-payload compatibility is not covered
by the database version.

## Explicitly NOT closed by this approval

This record approves the **contract shape** only. It does not close, waive, or
comment on any carried-forward M0 finding:

- **F-05 (asserted legacy identity/approval) is LIVE.** The legacy launch path
  still derives runtime authority from compatibility evidence with no canonical
  approval. The intent is now digest-bound and tamper-checked, which is
  *integrity*; it is not *authenticity*, and F-05 forbids treating compatibility
  evidence as approval authority. Tracked as **R1** in the Milestone 3 completion
  report. The security reviewer assessed this change as **unchanged** for F-05,
  with a caveat: the "do not resume" fact now rests entirely on a field that S-1
  can clear and S-7 can never legitimately clear.
- **F-01, F-02, F-03, F-04, F-07** remain open production obligations, untouched.
- **F-06** is **improved** by this change — the canonical side now rejects partial
  and pre-split records outright instead of casting them — but the legacy *job*
  store cast F-06 names is untouched.

## Expiry

This approval is bound to `contract-surface-digest` above, which covers
`src/orchestration/{schemas,types,transitions}.ts`,
`tests/contracts/examples/*.json`, and the four M0 contract assertion files.

**If any of those change, this approval stops applying** and
`scripts/m0-contract-signoff.sh` exits `2` with a `STALE` notice naming both
digests. Verified: editing `transitions.ts` trips it.

```bash
./scripts/m0-contract-signoff.sh    # 0 = this approval applies
```
