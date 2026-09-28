# M0 Contract Re-Approval Record

**Status:** APPROVED **WITH CONDITIONS** — all medium conditions now discharged
**Date:** 2026-09-28
**Triggered by:** Milestone 3, `Docs/implementation-reports/milestone-3-completion.md` §2
**Contract-surface-digest:** `e01850cbf8a01d790aca8164bdd73dd7902bd539221f3a4a4837629e821debfb`

> **Digest history — read this before relying on any signature below.**
>
> 1. `d4f4b947…00291` — first issue. **Invalid**: it omitted
>    `src/orchestration/transitions.ts`, which since the split is the source of
>    every persisted enum and of the observation→lifecycle map, so the tripwire
>    would not have fired on a transition-table change. Found by the security
>    review (S-3).
> 2. `c4d12a3f…dd13a` — re-issued with the surface corrected. This is the digest
>    the milestone owner and both reviewers actually signed.
> 3. `e01850cb…debfb` — **current**. The contract changed *after* that approval, to
>    discharge the conditions below. Every fix was the reviewers' own recommended
>    remedy, and each is strictly *narrowing* — new `superRefine` constraints, one
>    added precondition, one added event pair, one tightened reducer check. No fix
>    loosened an invariant or widened what a valid record may express.
>
> The signature in §1 therefore covers the contract *as it stood before the
> conditions were fixed*. This re-issue covers the fixed contract, which is the
> state the reviewers asked for. It is recorded rather than assumed: the tripwire
> correctly reported the change as `STALE` and the digest was re-taken deliberately.

## Sign-off

| Role | Verdict | Basis |
| --- | --- | --- |
| Milestone owner (root) | **APPROVE** | Mechanical evidence: contract suite green, six-line frozen-example diff, vocabulary alignment proved |
| Independent reviewer | **APPROVE WITH CONDITIONS** | Design sound; could not break it. Conditions F1–F4 raised |
| Security reviewer | **APPROVE WITH CONDITIONS** | SF-13 and SF-14 hold; no laundering path found. Conditions S-1–S-3 raised |

All medium conditions have since been discharged by the reviewer-recommended fixes; see the disposition table. The signing verdicts above are unchanged — the fixes implement what those reviews asked for.

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

## Conditions — all medium conditions discharged

Every fix below is the reviewer's own recommended remedy, and each is strictly
*narrowing*. Reproduced-then-fixed in
`tests/unit/orchestration/contract-invariants.test.ts` (13 tests); each invariant
was verified load-bearing by disabling it and observing the test fail.

| id | Sev | Condition | Fix | Status |
| --- | --- | --- | --- | --- |
| **F4** | Med | **ADR 0001 was not updated** — it still declared `paused`/`blocked`/`queued` and the provider vocabulary as canonical, contradicting the code, in violation of its own line 96. | ADR 0001 §"Lifecycle and authority" rewritten: aggregate lifecycle separated from readiness/observation, with the derivation rule and the approval-state rule stated. | **FIXED** |
| **S-1** | Med | The pause gate was clearable by re-emitting `run.created`: nothing owned `paused`, so a second `run.create` for an existing `runId` (fresh `commandId` evades the receipt; the sequence index constrains position, not identity) was accepted and overwrote the gate. | `#createRun` now refuses an existing run (`coordinator.run_already_exists`), mirroring `dispatch.propose`. Plus `paused` gained an owning event pair. | **FIXED** |
| **F3** / **S-7** | Med | **How is a run resumed? It wasn't** — `paused` was written once and never cleared, making a paused run a permanent tombstone. | `run.paused` / `run.resumed` events and `run.pause` / `run.resume` commands. The gate is now evented, idempotent, and refusable on a terminal run. `COMMAND_MATRIX` entries added (the exhaustive matrix enforced this). | **FIXED** |
| **F1** | Med | `approvalSchema` accepted `decision:"approved"` + `state:"pending"`, whose only construction is fabricating a decision never taken. | `approvalSchema.superRefine` now rejects `state: "pending"` on any record: `decision` and `decidedAt` are required, so a record has necessarily been decided. | **FIXED** |
| **F2** / **S-4** | Med | `paused: true` parsed with terminal states; the old enum made this unrepresentable and the boolean decomposition gave up mutual exclusivity. | `runSchema.superRefine`: `paused` implies a non-terminal state. | **FIXED** |
| **S-2** | Med | `sessionSchema` did not bind `lifecycleState` to `observedState` — all 49 pairs parsed, including terminal-lifecycle-with-live-observation. | `sessionSchema.superRefine`: a terminal lifecycle requires `observedState ∈ {completed, failed, unknown}`. The reducer now also reconciles the stale observation when `dispatch.finished` sets a terminal lifecycle — this surfaced a real projection that had been lying. | **FIXED** |
| **S-3** | Med | The digest omitted `transitions.ts`, the source of every persisted enum. | `transitions.ts` added to `CONTRACT_SRC`; record re-issued. Verified: editing it trips the check. | **FIXED** |
| **S-6** | Low | The replay path did not consult the machine: an illegal session regression was accepted silently. | `reduceEvent` now throws `SessionLifecycleRegressionError` on an illegal session transition rather than writing it. | **FIXED** |
| **F5** | Low | The new `superRefine` had zero coverage in `tests/contracts`. | `tests/unit/orchestration/contract-invariants.test.ts` — 13 tests covering every constraint above, plus the legitimate-value matrix for each. | **FIXED** |
| **F6** | Info | `RunProjection` encodes one fact three ways (`lifecycleState`, `state`, `paused`). | Accepted. Two sites collapse `paused → active` explicitly and document why. | Accepted |

### Smallest safe fixes, per the reviewers — all applied

- **F4** — amend ADR 0001 §39–43. **Done.**
- **S-1** — reject a `run.create` whose `readRun(runId) !== undefined`; and/or give `paused` an owning event. **Both done.**
- **S-2** — `sessionSchema.superRefine`: a terminal `lifecycleState` requires `observedState ∈ {completed, failed, unknown}`. **Done**, and compatible with every in-repo producer.
- **F1** — forbid `decision:"approved"` with `state:"pending"`. **Done.**
- **F2/S-4** — `runSchema.superRefine`: `paused` implies a non-terminal state. **Done.**
- **S-6** — assert `canTransitionSession(previous, recorded)` in the `session.observed` reducer arm and quarantine rather than accept. **Done.**
- **F3/S-7** — add `run.resume`. **Done** (`run.pause` / `run.resume`, evented).

### Versioning carve-out (both reviewers) — DOCUMENTED, widening still owed

The event payload shape changed while `schemaVersionSchema` remains
`z.literal(1)`, and `identifiers.ts:27` makes a version bump structurally
impossible — so **this shape break is unversionable**. The documented v2 rollback
boundary ("a v1 binary can still read a v2 database") did not account for it.

Failure mode is loud, not silent: a pre-split `run.created` or `session.observed`
is rejected on read. The `migrations.ts` v2 note now states explicitly that
event-payload compatibility is **not** covered by the database version, so an
operator cannot misread the boundary.

**Still owed:** widen `schemaVersionSchema` to a versioned enum *before the next*
persisted-record shape change, so this becomes an ordinary versioned migration.
That is a contract change with repo-wide reach (~30 schemas) and is deliberately
not bundled into a blocker fix.

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
