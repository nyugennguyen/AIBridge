# M0 Contract Re-Approval Record

**Status:** APPROVED
**Date:** 2026-09-28
**Approver:** Milestone owner (root), on review of the mechanical evidence
**Triggered by:** Milestone 3, `Docs/implementation-reports/milestone-3-completion.md` §2
**Contract-surface-digest:** `d4f4b947603b4cfa60c43c3b6a575a5047460decbe0305580e7974bf5ec00291`

## What was approved

The M0 canonical domain contracts as they stand at commit `6387a04`, after Milestone 3's lifecycle/observation split (`24b9aef`). Specifically:

| Contract | Change | Approved as |
| --- | --- | --- |
| `runSchema` | gains required `paused: boolean`; `paused` removed as a lifecycle state | Correct — a pause is a run-level gate, not lifecycle |
| `taskSchema` | gains required `failurePolicy`; accepts `draft` and `skipped`; `blocked` removed as persisted | Correct — blocked-ness is a function of the graph, and persisting it creates two sources of truth |
| `sessionSchema` | `state` replaced by required `lifecycleState` + `observedState` | Correct — the kernel must not conflate "the provider said it is working" with "this dispatch is running" |
| `dispatchSchema` | `queued` removed as a persisted state | Correct — `queued` is derived (approved, awaiting a slot) |
| `approvalSchema` | gains required `state`, constrained against `decision` | Correct — without it, "approval becomes invalid after any envelope mutation" was unreachable |

Frozen examples changed by 6 lines across five aggregates. Persisted enums now derive from `transitions.ts`, so future drift is a compile error rather than a cast.

## Mechanical evidence at time of approval

```
tests/contracts .................................... 67 pass, 0 fail
M0 contract assertions modified since e39461a ..... 2 files (6 + 12 lines)
Frozen example diff ............................... 6 lines, 5 aggregates
Full suite ........................................ 1203 pass, 4 skip, 0 fail
bun run typecheck ................................. 0 errors
```

## Explicitly NOT approved or closed by this record

This record approves the **contract shape** only. It does not close, waive, or comment on any carried-forward M0 finding. In particular:

- **F-05 (asserted legacy identity/approval) is LIVE.** The legacy launch path still derives runtime authority from compatibility evidence with no canonical approval. The intent is now digest-bound and tamper-checked, which is *integrity*; it is not *authenticity*, and F-05 forbids treating compatibility evidence as approval authority. Tracked as **R1** in the Milestone 3 completion report and still requiring an explicit M3.8 decision.
- **F-01, F-02, F-03, F-04, F-07** remain open production obligations, untouched by Milestone 3.
- **F-06** (unvalidated/corrupt persisted state) is partially addressed by the event-store migrations, but remains an open obligation for live cutover.

## Expiry

This approval is bound to `contract-surface-digest` above, which covers
`src/orchestration/schemas.ts`, `src/orchestration/types.ts`,
`tests/contracts/examples/*.json`, and the four M0 contract assertion files.

**If any of those change, this approval stops applying** and
`scripts/m0-contract-signoff.sh` will exit `2` with a `STALE` notice, naming
both digests. Re-approval requires a fresh review of the new diff.

Verify at any time:

```bash
./scripts/m0-contract-signoff.sh    # 0 = this approval applies
```
