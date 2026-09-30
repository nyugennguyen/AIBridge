# M0 Contract Re-Approval Record

**Status:** APPROVED **WITH CONDITIONS** — all medium conditions now discharged
**Date:** 2026-09-28
**Triggered by:** Milestone 3, `Docs/implementation-reports/milestone-3-completion.md` §2
**Contract-surface-digest:** `83f9a5e0f2c6f827b0435a28519b1312f9d1000b839b151958efaaece42ee0c1`

> **Re-issued for Milestone 4 (M4-V), 2026-09-29.** Digest-history entry 4 below.
> The contract surface changed for exactly one reason: `schemaVersionSchema` was
> widened from `z.literal(1)` to a versioned set, which is the change **both M0
> reviewers asked for and explicitly deferred** (the "Versioning carve-out" section
> of this document). Two M0 assertions that pinned `schemaVersion: 2` as *invalid*
> had to change, because 2 is now a supported version. Nothing else in the surface
> moved: `schemas.ts`, `types.ts`, `transitions.ts` and all fifteen frozen examples
> are **byte-identical** to the Milestone 3 approval.
>
> **This re-issue has NOT been countersigned by a human.** It is recorded as the
> milestone owner's attestation, valid for the mechanical gate only. See
> "Unsigned re-issue" at the end for exactly what a reviewer still owes it.

## Digest history

1. `d4f4b947…00291` — first issue. **Invalid**: it omitted
   `src/orchestration/transitions.ts`, which since the split is the source of
   every persisted enum and of the observation→lifecycle map, so the tripwire
   would not have fired on a transition-table change. Found by the security
   review (S-3).
2. `c4d12a3f…dd13a` — re-issued with the surface corrected. This is the digest
   the milestone owner and both reviewers actually signed.
3. `e01850cb…debfb` — the Milestone 3 re-approval. It covers the contract *as it
   stood before the M0 conditions were fixed*; the fixes were the reviewers' own
   recommended remedy and each was strictly *narrowing*.
4. `83f9a5e0…ee0c1` — **current**. Milestone 4's M4-V, as described above. The
   change is a **widening** in the one direction a version set is supposed to
   widen — "this build can read version 2 as well as version 1" — and it is
   strictly narrowing in every other respect: an unknown version is still rejected
   loudly, a non-numeric version is still rejected, and a record with no
   `schemaVersion` is still rejected. The two M0 assertions that changed now name
   an *out-of-set* version (0, 3, `"1"`) where they had named an in-set one, and
   two new assertions were added requiring every version in `SCHEMA_VERSIONS` to
   be accepted and every version outside it to be refused.


> The signature in §1 therefore covers the contract *as it stood before the
> conditions were fixed*. Digest `e01850cb…debfb` covered the fixed contract,
> which is the state the reviewers asked for. It is recorded rather than assumed:
> the tripwire correctly reported the change as `STALE` and the digest was
> re-taken deliberately.
>
> **What the §1 signature does NOT cover, restated for Milestone 4:** the
> `schemaVersionSchema` widening described at the head of this document. See
> "Unsigned re-issue" at the end.

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

### Versioning carve-out (both reviewers) — DISCHARGED by M4-V

The event payload shape changed while `schemaVersionSchema` was
`z.literal(1)`, and `identifiers.ts:27` made a version bump structurally
impossible — so **that shape break was unversionable**. The documented v2 rollback
boundary ("a v1 binary can still read a v2 database") did not account for it.

Failure mode was loud, not silent: a pre-split `run.created` or `session.observed`
is rejected on read. The `migrations.ts` v2 note states explicitly that
event-payload compatibility is **not** covered by the database version, so an
operator cannot misread the boundary.

**Owed, and now paid — M4-V, Milestone 4.** `schemaVersionSchema` is a versioned
set, `src/orchestration/versioning.ts` exists, and every wire and persisted record
dispatches on the version its own bytes declare:

| Piece | Where | What it prevents |
| --- | --- | --- |
| `SCHEMA_VERSIONS = [1, 2]`, `schemaVersionSchema` | `src/orchestration/identifiers.ts` | A shape change that cannot be named, which is what made Milestone 3's break unrecoverable |
| `parseVersioned` / `safeParseVersioned` | `src/orchestration/versioning.ts` | Reading a record with a shape belonging to a different version |
| `UnsupportedSchemaVersionError` / `UnversionedRecordError` | same | Coercing, defaulting, or partially reading a record whose shape this build does not have |
| `mapRunEventRow` reads `row.schema_version` | `src/orchestration/event-store/event-store.ts` | Silently relabelling a stored row as version 1 — the exact coercion M4-V exists to remove |
| `CURRENT_DATABASE_VERSION` renamed | `src/orchestration/event-store/schema.ts` | Conflating the storage-layout version with the record-shape version, which is how the carve-out above happened |

**The M3 break is retroactively nameable, and that is the point.** It happened at
version 1, so there is no migration for it; a v2 reader cannot tell a pre-split
`run.created` from a post-split one. What M4-V buys is that the *next* such break
is versionable, and that a node refuses a shape it does not have instead of
coercing it. Stated plainly because it is a real limit on what this discharge
achieved, not a formality.

## Explicitly NOT closed by this approval

This record approves the **contract shape** only. It does not close, waive, or
comment on any carried-forward M0 finding:

- **F-05 (asserted legacy identity/approval) — CLOSED by M4-A, Milestone 4.** The
  legacy launch path derived runtime authority from compatibility evidence with no
  canonical approval; the intent was digest-bound and tamper-checked, which is
  *integrity* and never *authenticity*. M4-A **retired the launch path** rather
  than minting an approval for it, because the alternative would have made a bearer
  token, a source/capability pair, a project-allowlist entry and a legacy plan
  annotation into approval authority — the exact thing F-05 forbids. No path in
  `src/orchestration/legacy/` now names a runtime destination, and
  `tests/integration/legacy-compatibility.test.ts` asserts that absence so F-05
  cannot silently reopen. The finding's concern is closed; the *route* itself is
  unchanged, and a legacy trigger now records a DRAFT + PAUSED run holding a
  PENDING task, which `COMMAND_MATRIX` cannot schedule until an operator records a
  real approval.
- **F-01, F-02, F-03, F-04, F-07** remain open production obligations, untouched
  by Milestone 4.
- **F-06** is **improved** — the canonical side rejects partial and pre-split
  records outright instead of casting them — but the legacy *job* store cast F-06
  names is untouched.

## Unsigned re-issue — what a reviewer still owes this

The digest at the head of this document covers the M4-V widening, and **no human
has signed that surface.** The §1 signatures cover entries 2 and 3 of the digest
history; entry 4 was taken by the milestone owner, mechanically, so that
`scripts/m0-contract-signoff.sh` exits `0` and the milestone gate can run.

That is the only thing it is good for. Before this record is relied on as a
*design* attestation, a reviewer still owes it:

1. **The widening itself.** A version set is supposed to widen, so this is the one
   change in the whole M4 milestone that a reviewer should read adversarially
   rather than as a formality. The argument for it is in the "Versioning
   carve-out" section above; the evidence is
   `tests/unit/orchestration/versioning.test.ts` (17 tests) and the two new M0
   assertions that require every in-set version to be accepted and every
   out-of-set one to be refused.
2. **Whether the two changed M0 assertions kept their intent.** They previously
   pinned `schemaVersion: 2` as invalid; they now pin `0`, `3` and `"1"`. A
   reviewer should confirm that "a version outside the supported set is refused"
   is what those lines were protecting, and that it is still what they protect.
3. **Whether a record at an in-set version whose shape this build does not have is
   refused loudly.** `parseVersioned` does this, and
   `tests/unit/protocol/version-mismatch.test.ts` covers it per record family.

Until then, this re-issue is an owner's attestation and the sign-off script's
`RESULT: GREEN` is a statement about the *digest*, not about design approval. The
mechanical gate is satisfied; the design review is owed and is not claimed.

## Expiry

This approval is bound to `contract-surface-digest` above, which covers
`src/orchestration/{schemas,types,transitions}.ts`,
`tests/contracts/examples/*.json`, and the four M0 contract assertion files.

**If any of those change, this approval stops applying** and
`scripts/m0-contract-signoff.sh` exits `2` with a `STALE` notice naming both
digests. Verified: editing `transitions.ts` trips it, and a clean worktree at
`86bf7e8` (the pre-M4 commit) reproduces digest `e01850cb…debfb` exactly, which
establishes that the entry-4 drift is M4-V's and nothing else's.

```bash
./scripts/m0-contract-signoff.sh    # 0 = this approval applies
```
