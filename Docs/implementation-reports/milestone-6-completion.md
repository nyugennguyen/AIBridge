# Milestone 6 — Rules, Automation, and Reusable Workflows: Gate Report

**Date:** 2026-10-02
**Branch:** `aibr-v2`
**Plan:** `Docs/implementation-plans/milestone-6-rules-and-workflows.md`
**Architecture:** `Docs/adr/0007-rule-language-and-evaluation.md` (1,959 lines, amended twice: 2026-10-01 A1–A8, 2026-10-02 A9–A13)
**Security review:** `Docs/implementation-reports/milestone-6-security-review.md` (1,282 lines; §0 is the 2026-10-02 revision and supersedes §3 where they disagree)

**Verdict: DO NOT SIGN as complete. SIGN AS A LIBRARY, with conditions. Unchanged by this
revision, for a different reason than the one the first revision gave.** The engineering is
complete, the tests are green under the runner the plan names, and the safety floor is
un-widenable. What is not true is the milestone's headline claim. Every Completion Criterion
that concerns pre-approval safety is met **inside the library and vacuously on the shipped
path**, because nothing wires the library in (§5). That is now the *only* structural reason.
The HIGH-severity vacuity defect this report called NEW-2 is fixed (§0, §8.1), and the
timing finding NEW-3 is withdrawn as unreproducible (§0, §1.3).

**Revision 2 — 2026-10-02, correcting revision 1 of the same day.** Two of the three reasons
revision 1 gave for withholding signature are gone. The verdict is unchanged; the reasoning
beneath it has been replaced. The before/after is in §0 and is itself part of the evidence.

This report replaces the 2026-10-01 draft in full. Its numbers were wrong (it predated the
HIGH-1 fix and the M6.10 dispositions) and its conclusion was reached on a suite that was
red at the time. Nothing below is carried over from it unless re-measured.

---

## 0. Correction, 2026-10-02 (revision 2)

Revision 1 of this report made three claims that bore on the verdict. Two of them do not
survive re-measurement and are corrected here. The corrections are recorded as corrections
rather than applied silently, because the change of position is the substance.

### 0.1 NEW-2 was not a disclosure artefact, and it is now fixed

**Revision 1 said:** NEW-2 — the vacuity check reading only an `any`'s *direct* arms for a
negation — was OPEN and HIGH. A pre-approval disclosed as scoped to `roles = ["role-1"]`
matched every role and returned kernel `allow / outstandingApprovals: []`.

**Revision 1 also said, in §8.1, that this was the half that mattered** — that the projects
axis over-report was harmless because `classifyRule` independently refuses a foreign
`projectId`, while the roles axis had no such independent gate. **That specific claim was
correct and is retained.** The error in revision 1 was one of characterisation: I filed the
defect as a *disclosure* mismatch and ranked it below the matcher defects, when it was in
fact **fail-open** — it granted an approval nobody authorised, which is the same class as
MED-2 and the same family as HIGH-1.

**Now:** fixed in `src/rules/compile.ts` by a new `subtreeContainsNegation`
(`compile.ts:678-682`, called at `:729`), which reads the **whole subtree** for a `not` at any
depth instead of an `any`'s direct children. My own measurement through the real
`compileRuleSet`, run again for this revision (`/tmp/m6-gate/new2.ts`):

```
REFUSED   any(A, not A)                DEPTH1  rule.universal_pre_approval
REFUSED   any(R, any(A, not A))        DEPTH2  rule.universal_pre_approval
REFUSED   any(A, any(A, not A))        DEPTH2  rule.universal_pre_approval
REFUSED   any(any(A, not A), A)        DEPTH2  rule.universal_pre_approval
REFUSED   any(R, any(any(A, not A)))   DEPTH3  rule.universal_pre_approval
COMPILES  CONTROL any(R, P) no negation
COMPILES  CONTROL all(R, not P) beside a real sibling

the adversarial rule, end to end:
  compileRuleSet -> REFUSED rule.universal_pre_approval
  => the rule cannot exist, so no role the author never named can be approved.
```

`MAX_PREDICATE_DEPTH` is 6, so depth 3 was comfortably expressible and the family is now
closed at every depth the language admits.

**Red/green, and a number that differs from the one I was handed.** I reproduced the proof by
reverting **only** `subtreeContainsNegation` to its one-level form, measuring, and restoring.
The file was restored byte-identically (sha256 `74a7ae8ffcf58becce65fbc28f5d14c372331d8527a62482203c31bbdd86b262`
before and after; `git status` unchanged).

```
one-level check, tests/unit/rules/vacuity.test.ts :  16 pass /  3 fail
one-level check, tests/unit/rules (whole dir)     : 786 pass /  3 fail
subtree check,   tests/unit/rules (whole dir)     : 789 pass /  0 fail
```

**The three failures are exactly the three tests that exist to hold this fix down**, all in
`tests/unit/rules/vacuity.test.ts`: the two reversed tests below, plus the end-to-end
assertion *"a nested tautology cannot reach the kernel at all, so no role the author never
named can be approved"*. **I was told 11 pass / 8 fail for the one-level check; I measured
16 / 3.** The direction and the conclusion are the same and I have used my own figures
throughout. Five of the "failures" in the figure I was given do not exist in this tree.

### 0.2 Two pinned tests changed direction, deliberately — and were changed, not deleted

This is the most important thing in this correction and it is recorded here rather than
folded into §8.1. In `tests/unit/rules/vacuity.test.ts`, two tests that previously asserted
`compiled.ok === true` now assert refusal with code `rule.universal_pre_approval`. **Both
tests still exist; the file is 432 lines and still runs 19 tests, the same count as before
the fix.** Their current names, verbatim:

1. `"REFUSED, and deliberately so: \`any(A∧B, A∧¬B)\` is satisfiability-equivalent to \`A\`, but the check cannot see that and refuses it"`
   (`:209`) — previously asserted `ok === true`.
2. `"CLOSED, not documented: an \`any\` arm containing a \`not\` BELOW a combinator is now refused, so the fail-open it enabled can no longer be written"`
   (`:277`) — previously asserted `ok === true` and argued the shape was fail-closed because
   `any(all(A, not A))` is unsatisfiable and matches nothing.

Both reversals are argued in comments inside the test file, which is the correct place for
them. Neither is a test deleted to make a suite green; they are assertions inverted, in the
same file, with the reasoning attached.

**Test 1 is an over-refusal of a genuinely SOUND rule.** `A∧B ∨ A∧¬B` is exactly `A`, so its
true reach *is* the set the disclosure would report. The subtree check cannot distinguish it
from a tautology and refuses it anyway.

**Test 2's reversal is a correction of my own earlier reasoning, and the original argument
was wrong in an instructive way.** It was sound about evaluation — `any(all(A, not A))` is
unsatisfiable and matches nothing — and wrong about risk. The same syntactic gap also admits
**satisfiable** tautological arms, which *do* fire. The unsatisfiable shape and the
tautological one are indistinguishable to a syntactic check, so the check now refuses both.

**I accept the over-refusal and both reversals as a deliberate trade, not a workaround.**
Refusing a sound rule costs an author a rewrite. Admitting a tautology clears the safety
floor for dispatches nobody authorised. This is the same conservative-by-refusal posture the
milestone already applies to empty enums and domain-edge ranges, extended to a case the
syntax cannot resolve. **A test flipped silently to keep a suite green is exactly how HIGH-1
and MED-3 survived in the first place** (§7.3), so the reversal is surfaced here rather than
left to be discovered by whoever reads the diff.

**The fix is narrow on purpose.** An intersection-over-arms approach to the same problem was
tried and **rejected**: it refused `any(projectId eq p, roleId eq r)`, which genuinely
excludes dispatches and must compile. Unioning arm axes is correct because the test asks
whether the rule *excludes anything*, not whether its reach is a product set. I re-measured
both sides for this revision (`/tmp/m6-gate/overrefuse.ts`):

```
COMPILES  any(P, Q)          two projects
COMPILES  any(P, C)          two different axes
COMPILES  any(P, R)          <- the shape intersection-over-arms would have refused
REFUSED   any(P, not S)      different axes, genuinely excludes most projects
REFUSED   not(all(C, D))     a real exclusion
REFUSED   not(P)             a real exclusion
REFUSED   any(A&B, A&not B)  sound, over-refused by the subtree check
COMPILES  all(R, any(A,not A))   tautology under a CONJUNCTION - correct, `all` cannot be widened
COMPILES  all(R, not P)          CONTROL: a `not` beside a real sibling contributes nothing
```

### 0.3 NEW-3 does not reproduce and is withdrawn

**Revision 1 said:** `tests/unit/rules/tui-keyboard.test.ts:902`, *"answers every key on every
screen and overlay with an intent, and never throws"*, measured 5232 ms and 6087 ms under
`bun run test` against a 5,000 ms default, and was recorded as an M6 flake introduced by M6.

**It does not reproduce. Withdrawn as a finding.** Re-measured for this revision, one command
at a time:

```
bun test, whole file, 3 runs                     : 72 pass, 2.83 / 3.47 / 3.85 s
bunx vitest run, whole file, 3 runs              : 72 passed, duration 3.02 / 3.75 / 3.79 s
bun test, the test alone, 3 runs                 : 798.07 / 834.96 / 956.09 ms
bunx vitest run, the test alone, 5 runs          : 691 / 738 / 776 / 787 / 849 ms
bunx vitest run tests/unit/rules/, 3 runs        : tui-keyboard 72 tests in 3741 / 3887 / 4060 ms
bunx vitest run (whole suite), 4 runs            : tui-keyboard PASSED in all 4
```

The assertion under test takes **under one second** — roughly 5× under the default — and the
full `bunx vitest run` passes it every time, including under the parallel load that produced
the original failure.

**What I record instead of the finding:** the original 5232/6087 ms measurement was taken and
is not reproducible on the sign-off machine; **cause unknown, possibly load-dependent on the
machine it was taken on.** That is the whole claim and it is not a finding.

**And a disclosure about how the one >5 s number I produced got that way.** My first
`bunx vitest run` of the single test measured **6113 ms and FAILED on timeout**. It was my
own error: I had issued two vitest invocations concurrently in one tool batch and they
competed for the machine. Re-run serially, the same command returns 691–849 ms. The
existence of a reproducible 6 s measurement *when the machine is loaded* is the strongest
evidence available for the load-dependence hypothesis, and it is evidence for it rather than
against it: **the test has a wall-clock budget with roughly no headroom under load.** That
is worth one sentence in §1.3. It is not a defect in the code and it is not a gate finding.

### 0.4 What did *not* change

Reachability (§5) is untouched and was re-verified for this revision. **The verdict does not
change**: the milestone's central safety property remains unreached, and that is now the
sole structural reason to withhold signature. Details in §10.

---

## 1. Command output

All run from the repository root on this branch. Verbatim, not summarised.

### 1.1 The plan's Gate Verification block

Re-measured for revision 2. Verbatim, not summarised.

```
$ bun test tests/unit/rules
 789 pass
 0 fail
Ran 789 tests across 17 files. [4.07s]

$ bun test tests/unit/workflows
 257 pass  0 fail

$ bun test tests/unit/budgets
 193 pass  0 fail

$ bun test tests/integration/rule-preview.test.ts
 21 pass  0 fail

$ bun test tests/integration/dry-run.test.ts
 23 pass  0 fail

$ bun test tests/integration/automation-safety.test.ts
 47 pass  0 fail

$ bun run typecheck
$ tsc -p tsconfig.json --noEmit
exit=0

$ bun test
 5079 pass
 4 skip
 0 fail
 93648 expect() calls
Ran 5083 tests across 218 files. [21.25s]

$ bun run build
$ rm -rf dist && tsc -p tsconfig.build.json
exit=0

$ git diff --check
exit=0 (clean)
```

All ten of the plan's gate commands name files that exist and all ten pass. The three
cross-module integration files the plan names were written late; the superseded draft reported
them as missing, and that was true when it was written and is false now.

**The gate total is unchanged by revision 2: 5079 pass / 4 skip / 0 fail, 5083 tests across
218 files, `tests/unit/rules` 789.** Revision 1 flagged that a concurrent agent was adding
tests to `tests/unit/rules/` while it was verifying, and that the total had moved
5063 → 5079 across its runs. That movement has stopped.

**It stopped before the NEW-2 fix, not after it, which is worth stating plainly: the vacuity
fix changed no test count.** It reversed two assertions and added one; `vacuity.test.ts` is
still 19 tests and `tests/unit/rules` is still 789. A HIGH fix that adds no test is normally a
warning sign, and here it is accounted for by §0.2 — the tests that cover it already
existed and had to change direction, and the end-to-end kernel assertion was added to an
existing file rather than a new one. I note it so that nobody later reads a flat test count as
evidence that the fix was small.

Nothing failed at any point in either revision. The total must still be re-taken by whoever
signs.

### 1.2 The frozen M0 contract

```
$ ./scripts/m0-contract-signoff.sh
------------------------------------------------------------
M0 CONTRACT SIGN-OFF EVIDENCE
baseline:  e39461a
head:      e613a16
digest:    83f9a5e0f2c6f827b0435a28519b1312f9d1000b839b151958efaaece42ee0c1
------------------------------------------------------------
[1/4] M0 contract suite
       69 pass
       0 fail
...
RESULT: GREEN - contract drifted but a recorded re-approval covers it.
exit=0
```

Digest `83f9a5e0…ee0c1` is the one `Docs/implementation-reports/m0-contract-reapproval.md`
records and the M4 and M5 gates both cite. M6 edited nothing under `src/orchestration/`.
`git status --porcelain src/orchestration src/application src/server src/tui src/mesh
src/cli.ts` is empty.

Re-run for revision 2: `baseline: e39461a`, `head: e613a16`, the same digest
`83f9a5e0f2c6f827b0435a28519b1312f9d1000b839b151958efaaece42ee0c1`, 69 pass / 0 fail,
`RESULT: GREEN - contract drifted but a recorded re-approval covers it.`, exit 0. The M0
freeze is unmoved by either revision of this report.

### 1.3 `bun run test` (vitest) — not green, and only partly this milestone's fault

The plan does not name vitest, but `package.json` binds `test` to `vitest run` and a reader
will run it. **Re-measured for revision 2: four complete runs, one command at a time.**

| Run | Files failed | Which |
| --- | --- | --- |
| 1 | 2 | `tests/unit/host/runtime.test.ts` (7) + `tests/integration/terminal-websocket.test.ts` (1) |
| 2 | 1 | `tests/unit/host/runtime.test.ts` only |
| 3 | 2 | `tests/unit/host/runtime.test.ts` (7) + `tests/integration/terminal-websocket.test.ts` (1) |
| 4 | 1 | `tests/unit/host/runtime.test.ts` only |

```
Test Files  1 failed | 216 passed | 1 skipped (218)
     Tests  7 failed | 5072 passed | 4 skipped (5083)
  Duration  31.09s
```

Two things, and they must not be conflated:

1. **`tests/unit/host/runtime.test.ts` — 7 failures, deterministic under vitest, pre-existing,
   not M6.** Failed in **4 of 4** runs. All seven are `BunProcessRunner` spawning a real child
   process (`executes a real process`, `captures stderr separately from stdout`, `returns
   non-zero exit code`, `trims trailing whitespace`, `respects the cwd option`, `does not
   invoke a shell`, `passes env variables to the child process`). Under `bun test` the same
   file is green. The runner difference, not the code, is the cause: vitest's worker does not
   give the spawned `bun` the environment it expects. Tracked at `62c1682`, unchanged since
   before this milestone. Re-confirmed for revision 2: under `bun test` the same file is
   **28 pass / 0 fail**.

2. **`tests/integration/terminal-websocket.test.ts` — intermittent 5 s timeout, pre-existing,
   M4.** *"streams node A's pty to a client connected through node B, over a real HTTP hop"*
   failed in 2 of 4 runs. M4's surface, unchanged by M6. Re-confirmed for revision 2: in
   isolation under `bun test` the file is **20 pass / 0 fail**.

**`tests/unit/rules/tui-keyboard.test.ts` did not fail once in four full-suite runs, and its
worst-case assertion does not come close to the timeout.** NEW-3 is withdrawn; the full
measurement is in §0.3 and the reasons are in §1.3.1.

Under the runner the plan names, the suite is green. Under vitest it is red with 7
deterministic pre-existing failures plus an intermittent M4 timeout. **Neither belongs to M6,
and neither is a gate finding.**

#### 1.3.1 The one thing NEW-3 leaves behind, recorded because it is not a finding

`tests/unit/rules/tui-keyboard.test.ts:902` is a triple loop over
`RULE_TUI_SCREENS × RULE_TUI_OVERLAYS × KEYS` on a freshly populated state each time. It
measures 691–849 ms in isolation, so the 5,000 ms default is not a constraint on any machine
I measured. **But I produced a 6,113 ms measurement and a real timeout failure from it on
demand**, by running two vitest invocations concurrently in one batch; re-run serially the
same command returns 691–849 ms.

So the accurate statement is: *this test has a wall-clock budget with roughly no headroom
under load, and it will fail on a busy or contended machine.* That is a property of a
test-only triple loop, not of shipped code, and `vitest.config.ts` sets no `testTimeout`.
Anyone who cares has two cheap fixes — hoist `populatedState` out of the inner loop, or set an
explicit per-test timeout. **I am not recording it as a finding and it is not a reason to
withhold anything.** It is recorded because it is the most likely explanation for how
revision 1 obtained a number that does not reproduce, and an unexplained 6 s measurement is
worse than a boring one.

### 1.4 Canonical simulation

The plan requires the gate report to carry canonical simulations. Two runs of the shipped
fixtures through `simulateDryRun`, digested with the shipped `computeDryRunPlanDigest`:

```
dispatchCount: 2
everyDispatchRequiresApproval: true
decision: [{"dispatchId":"disp:build","stepId":"build","outstanding":["dispatch_approval"],"required":true},
           {"dispatchId":"disp:ship","stepId":"ship","outstanding":["dispatch_approval"],"required":true}]
digestA: sha256:42102fc1c5161114c656e3779954230d69b2f8b40b2d27d7a3f40c1c6ddf9471
digestB: sha256:42102fc1c5161114c656e3779954230d69b2f8b40b2d27d7a3f40c1c6ddf9471
```

Byte-identical across runs, `digestJson` input is 16 keys, every dispatch requires approval,
zero rules enabled.

**Re-run for revision 2** (`/tmp/m6-gate/sim.ts`, driving the shipped fixtures through the
shipped `planFor` and digesting with the shipped `computeDryRunPlanDigest`). The digest
reproduces **exactly**, which is the point of re-running it:

```
dispatchCount: 2
everyDispatchRequiresApproval: true
matchedPreApprovals: []
digestJson input keys: 16
digestA: sha256:42102fc1c5161114c656e3779954230d69b2f8b40b2d27d7a3f40c1c6ddf9471
digestB: sha256:42102fc1c5161114c656e3779954230d69b2f8b40b2d27d7a3f40c1c6ddf9471
byte-identical: true
```

**The digest is unchanged by the NEW-2 fix, and it should be.** The fix changes which rules
*compile*, and this canonical simulation runs with zero rules, so it does not enter the
computation. That is a null result rather than evidence of correctness, and I record it as
such. The meaningful determinism evidence remains `dry-run.test.ts:536`, which asserts one
byte-identical plan and digest across fifty invocations with shuffled snapshot arrays.

---

## 2. Size

`wc -l`, current tree. Re-measured for revision 2.

| Module | src | unit `.test.ts` |
| --- | --- | --- |
| `src/rules` (language) | 7,132 | 9,588 |
| `src/rules/tui` (M6.8) | 3,592 | 2,787 |
| `src/workflows` | 2,101 | 3,052 |
| `src/budgets` | 3,345 | 4,327 |
| `src/routing` | 1,376 | 1,774 |
| `src/simulation` | 3,460 | 2,055 |
| `src/notifications` | 2,656 | 4,018 |
| **Six modules** | **23,662** | **27,601** |

Plus 3,445 lines across the three named gate files (`rule-preview` 1,044, `dry-run` 873,
`automation-safety` 1,528), and 1,959 lines of ADR. Test-to-source ratio 1.17:1.

`src/rules` grew 44 lines and its tests 59 between the two revisions. That is `compile.ts`
going from 1,403 to 1,447 — the subtree check plus the reasoning for it, rejected approach,
and the measured case, in comments — and the two reversed tests plus one added assertion in
`vacuity.test.ts`.

Growth across the milestone: 3,201 passing tests at the M5 gate
(`Docs/implementation-reports/milestone-5-completion.md:754`) to 5,079 now — 1,878 net new
tests, of which 1,789 are in the seven new test directories.

---

## 3. The ten parts

Each with what was built, where, how many tests, and which plan criterion or guardrail it
carries. No padding.

### M6.1 — Rule language and evaluation ADR

`Docs/adr/0007-rule-language-and-evaluation.md`, 1,959 lines, **Accepted for Milestone 6
implementation**, amended twice. A1–A8 (2026-10-01) reconcile the document with the shipped
code. A9–A13 (2026-10-02) are forced by the M6.10 findings and supersede one decision: §8's
*"a `not` counts as constraining"* is **marked superseded in place** rather than rewritten, and
**§8.2 is the normative text**. That is the right handling and it is worth naming as a practice.

The ADR fixes the module graph (§1), the separate language version (§2), one compiled
artifact (§3), the kernel projection's sound-under-approximation property (§3.1), who applies
the four unprojectable restriction members and in what order (§3.2, new), bounded patterns
(§4), eighteen predicate fields (§6), six actions (§7), the "match all" restriction (§8, §8.1,
§8.2), twenty named limits (§9), precedence and conflict (§10), the disclosure (§11), budgets
(§13, §13.3), routing (§14), dry run (§16), notifications (§17), defaults (§18), six stop
conditions, and the residual risk of the 2026-10-02 amendment.

Carries Completion Criteria 2, 3, 5 and Guardrails 1–5.

**Code/ADR disagreements I found by re-deriving rather than reading:**

- **§1674's residual-risk bullet 3 names only the projects axis, and the roles axis is the
  one with no independent gate.** The note is correct that the shape
  `any(roleId eq "role-1", any(projectId eq "proj-1", not projectId eq "proj-1"))` *"compiles,
  grants, and reports `reach.projects = ["proj-1"]`."* My measurement showed the disclosure is
  **also** wrong on the roles axis, and that this is the half that matters: the same document
  reports `reach.roles = {kind: "constrained", values: ["role-1"]}`, and the rule matches
  `role-2`, `role-anything-at-all`, and anything else, returning kernel
  `allow / outstandingApprovals: []` against a control of
  `require_approval / ["dispatch_approval"]`. The projects-axis over-report is harmless because
  `classifyRule` (`src/rules/evaluate.ts:784-793`) independently refuses any dispatch whose
  `projectId` is not the rule's own. **The roles axis has no such gate**, so on that axis the
  rule was strictly *wider* than what was displayed — ADR Stop Condition 5 — and a reader who
  worked from the note's projects-axis framing would have concluded the residual was a
  disclosure-only artefact. **It was not, and revision 1 said so while still filing it as one.**
  Both axes are now closed by the subtree fix (§0.1); the *note* is still wrong about which
  axis matters, and that is what the outstanding ADR amendment has to fix.
- **§8.2.4 concedes the check *"can be fooled into crediting scope the rule does not have —
  with the one exception recorded in the amendment's residual-risk note"* (`:1064`)**, which is
  an accurate concession, but §8.2.3 states its rule as if it were total and gives a
  justification (*"a disjunction containing a negation cannot be stated as a reachable set"*)
  that is a property of the **disclosure**, not of soundness. The construct the rule admitted —
  a negation nested one level below the branch — was precisely what §8.2.3 did not catch.
  **This disagreement was correct and is now resolved in the code.** The subtree fix
  (`compile.ts:678-682`) closes exactly the construct §8.2.3 admits and §8.2.4 concedes it
  cannot catch, and the fix is justified on the *soundness* ground §8.2.3's own text failed to
  state: a tautological arm fires, and a rule that fires on every dispatch must not clear the
  floor. The refusal remains conservative-by-refusal, and §0.2 records the sound rules it now
  costs.
  **The ADR documents are still unamended for this and must be** — see §8.1 and the
  outstanding item in §10. §8.2.3's rule is still written as total rather than as
  depth-transitive, and §8.2.4's concession still points at a residual that no longer exists.
- **§7.2 still says `require_approval` *"Projects into `kernelRule` as a `restrict` effect, so
  the M3 engine enforces it with its existing approval accounting"* (`Docs/adr/0007…:660-662`).**
  That is false for two of the four members and §3.2 says so at length, but §7.2 carries no
  cross-reference and no supersede marker. A reader who stops at §7.2 has the wrong model of
  where a `require_approval` is enforced.
- **§8's six-failure table (§8.1) cites `src/rules/compile.ts:446-450` for the pass-placement
  rationale**, which is docblock text; the actual `checkUnsatisfiable` body starts at `:452` and
  the caller is `:1153-1156`. Minor.
- Every one of the ADR's 126 distinct `file:line` citations resolves inside the file. Several
  were stale at the moment I first read them (§3's `types.ts:1074`, `compile.ts:1089`,
  `types.ts:921`, §8's `compile.ts:543-557`) and had been corrected by the time I finished
  reading — **the ADR was being amended concurrently with this report**, and its length grew
  from 1,875 to 1,959 lines while I verified it. Every line number I cite in this report is
  from the final state. The two bullets above were re-checked against that final state.

### M6.2 — Rules compiler and evaluator

`src/rules/{types,compile,evaluate,explain,limits,index}.ts`, 7,088 lines. **789 unit tests**
in `tests/unit/rules`, of which 172 are the M6.8 TUI files; 617 are the language.

| File | Lines | Role |
| --- | --- | --- |
| `src/rules/evaluate.ts` | 2,009 | `evaluateRules` (`:1231`) is the sole evaluation entry point |
| `src/rules/preview.ts` | 1,470 | `previewCompiledRuleSet` (`:908`), calls `evaluateRules` at `:928` |
| `src/rules/compile.ts` | 1,447 | `compileRuleSet` (`:1297`) — the only producer of `CompiledRuleSet` |
| `src/rules/types.ts` | 1,368 | Zod source of truth; `ruleLanguageVersion = 2` (`:114`) |
| `src/rules/explain.ts` | 543 | `buildPreApprovalDisclosure` (`:399`), normalized predicate, traces |

**Language surface, measured:** 18 predicate fields in `rulePredicateSchema`'s discriminated
union (`src/rules/types.ts`), 6 action kinds (`ruleActionKindSchema`, `:785-792`), 20 exported
limits (`src/rules/limits.ts`), language version 2 with
`rule.language_version_unsupported` as the refusal for any other.

**Compiler passes, in order** (`compileRule`, `src/rules/compile.ts`): parse → canonical limits
→ per-rule limits → bounded pattern compilation → `checkUnsatisfiable` (`:452`) →
`checkNotUniversal` (`:708`) → action sort → M0 projection. `checkNotUniversal` is a named
compiler pass, not a `.superRefine`, so the four restriction actions may still be universal.

**Carries Completion Criteria 2, 3, 5; Guardrails 1, 3; ADR Stop Conditions 1, 4, 5.**

Per-file test counts, measured individually: `compile` 114, `truth-tables` 121, `evaluate` 70,
`schema` 61, `invalid-inputs` 50, `preview` 47, `limits` 45, `explain` 34, `barrel` 25,
`vacuity` 19, `kernel-restrictions` 16, `dedupe-membership` 13, `preview-divergence` 2 — and
`fixtures.ts` carries none.

### M6.3 — Preview and impact analysis

`src/rules/preview.ts`, 1,470 lines; **47 tests** in `tests/unit/rules/preview.test.ts` plus
**2** in `preview-divergence.test.ts` and **21** in `tests/integration/rule-preview.test.ts`.

The criterion *"Preview and runtime use the identical compiled rule representation"* is
structural, not behavioural: there is one `compileRuleSet`, one `CompiledRuleSet`, one
`evaluateRules`, and `preview.ts` has no branch that decides whether a rule matches — it calls
`evaluateRules(compiled, context)` at `:928` and renders the result. There is no second parser
to diverge. The integration gate builds its own fixtures and its own context from a history
entry by hand rather than sharing a helper, because a helper on both sides would make the
comparison a tautology.

**Carries Completion Criteria 3, 4; Guardrail 3; ADR Stop Condition 1.**

### M6.4 — Role packs and run templates

`src/workflows/{types,repository,instantiate,index}.ts`, 2,101 lines. **257 unit tests**:
`schema` 65, `instantiate` 61, `repository` 44, `parameters` 39, `barrel` 29, `immutability` 19.

`InMemoryRunTemplateRepository` deep-freezes on write (`repository.ts:308`) and returns a fresh
`structuredClone` on every read. `instantiateTemplate` (`:461`) produces a snapshot with its
own digest. `immutability.test.ts` asserts the digest is unchanged after edits, still verifies
after edits, does not drift across ten successive edits, shares no object at any depth, and
still verifies after every mutation attempt. Cross-project instantiation is refused in
`src/simulation/expand.ts:252-259` — not in `instantiateTemplate`, which has no `projectId`
parameter at all (`instantiate.ts:461`). **A caller invoking `instantiateTemplate` directly
would get no scope check.** Named here because the plan's criterion is about immutability, and
the scope check living in a caller is a fact the next caller needs.

**Carries Completion Criterion 6.**

### M6.5 — Budgets and admission control

`src/budgets/{types,compose,ledger,recovery,index}.ts`, 3,345 lines. **193 unit tests**:
`compose` 46, `recovery` 41, `reservation` 35, `ledger` 33, `adversarial` 20, `barrel` 18.

Eligibility is *defined* as holding a `held` reservation (`ADR §13.2`), and `reserve` is a
single compare-and-set inside one store transaction, so there is no check-then-act window.
`recoverLeaked` (`recovery.ts:320`) is the crash sweep;
`replayDurableReservations` (`:629`) is the rebuild, and it is a **second admission decision**
that classifies rather than totals (§13.3, and MED-5 in §7 below).

**Carries Completion Criterion 7; Guardrail 4; ADR Stop Condition 3.**

### M6.6 — Routing preferences

`src/routing/{types,rank,snapshot,index}.ts`, 1,376 lines. **108 unit tests**:
`eligibility` 24, `ranking` 23, `determinism` 16, `explanation` 16, `snapshot` 15, `barrel` 14.

Three ordered stages (`ADR §14`): hard eligibility, then deterministic preference, then
lowest `nodeId` by UTF-16 code unit. `localeCompare` appears nowhere in the module and the
reason is recorded at `rank.ts:68` and `types.ts:65-66`. Every exclusion carries a reason.
A `select_routing_preference` can only reorder the eligible set; it cannot introduce a node.

**Carries Completion Criterion 9.**

### M6.7 — Dry-run simulator

`src/simulation/{types,plan,expand,sinks,index}.ts`, 3,460 lines. **113 unit tests**
(`plan` 42, `no-side-effects` 20, `sinks` 17, `expand` 13, `barrel` 11, `determinism` 10)
plus **23** in `tests/integration/dry-run.test.ts`.

`simulateDryRun` (`plan.ts:306`) composes the same `evaluateRules`, `rankNodes`,
`composeBudgets` and `instantiateTemplate` production uses, and replaces every command sink
with a fail-closed fake whose only implementation throws. The budget sink is the exception and
the exception is argued: the gate is *entered* and the ledger's own compare-and-set runs,
because a dry run that refused to enter would report no saturation for any dispatch, and
"would be refused: concurrency 2 is full" is one of the answers a plan exists to give. It
cannot reserve, because it holds no map — `read` and `heldUnitsFor` return `null`/`0`
unconditionally, so after a dry run every dispatch is still ineligible *by definition*.

**Limitation, asserted rather than hidden:** a dry run cannot simulate budget saturation,
because the probe retains nothing and the ledger is therefore asked what it would decide
against an empty scope. `dry-run.test.ts:823-838` states this and asserts
`plan.rejected === []` and `everyDispatchRequiresApproval` for a ceiling of 1 over two
dispatches. A live-snapshot capacity value would have to arrive on the request (ADR §16 S3).

**Carries Completion Criterion 8.**

### M6.8 — Pure rules TUI

`src/rules/tui/{types,state,builder,view-model,index}.ts`, 3,592 lines. **172 unit tests**:
`tui-keyboard` 72, `tui-builder` 50, `tui.test` 36, `tui-barrel` 14.

`reduceRuleTui` (`state.ts:175`), `routeRuleTuiKey` (`:582`), `buildRuleTuiView`
(`view-model.ts:308`). `src/rules/tui/index.ts:19-61` names the three attachment points in
`src/tui/shell.ts` that an integrator must make.

**This layer is implemented and tested and is not attached to anything.** `grep -c rules
src/tui/shell.ts` is `0`. `grep -rn "rules/tui" src/` outside `src/rules/tui/` returns
nothing — the module is imported by nobody, including its own test suite's target surface.
`RuleTuiSimulationReport` and `RuleTuiTemplateCapture` (`types.ts:297,328`) are declared ports
with **no producer**: `simulation-reported` and `templates-loaded` are dispatched nowhere in
`src/` outside the reducer that consumes them. A user cannot reach any of this.

**Carries Guardrails 2 and 3 (activation confirmation, no match-all), on the compiler side
only.**

### M6.9 — Notifications

`src/notifications/{types,bus,store,tui-adapter,index}.ts`, 2,656 lines. **327 unit tests**:
`tui-adapter` 81, `isolation` 71, `no-secrets` 49, `quieting` 39, `ack` 31, `barrel` 30,
`dedupe` 26.

`createNotificationBus` (`bus.ts:224`), `DEFAULT_NOTIFICATION_RETENTION_WINDOW_MS = 900_000`
(`store.ts:221`), 6 categories, 3 severities, a closed four-member reason code set.
`src/notifications/**` has **no upward import edge**: `grep 'from "../' src/notifications/*.ts`
returns nothing, and every occurrence of the word "orchestration" in the module is prose. The
in-TUI adapter is the only implementation shipped, and it does not mutate.

**Carries Completion Criterion 10; Guardrail 5; ADR Stop Condition 6.**

### M6.10 — Policy-bypass review

`Docs/implementation-reports/milestone-6-security-review.md`, 1,282 lines, 31 attack claims in
§2 and five substantive findings. §0 is a dated revision (2026-10-02) that re-dispositioned §3
against the code as it then stood. **Its §0 findings on HIGH-1 and MED-3 are superseded by
work done after it was written**; §7 below records both what it found and what is now true.
The review itself states that no file under `src/` or `tests/` was touched, and that no failing
test was committed — HIGH-1, MED-2, MED-3, MED-4 and MED-5 were all *assertions the milestone
currently failed*. That was the right call at the time; it also meant that for two of five
findings the suite could not see the fix either way, which is the lesson §7 tells.

**Carries Completion Criterion 11 — not met. See §4 and §10.**

---

## 4. Security findings and dispositions

One table. Severity is the reviewer's, corrected where the review corrected itself.

| Finding | Original | Now | Status | Fix | Proven by |
| --- | --- | --- | --- | --- | --- |
| HIGH-1 — vacuous pre-approval, nine named shapes | HIGH | HIGH | **fixed** | `src/rules/compile.ts:569-600` (`CONSTRUCTIVE_FORMS`), `:615-651` (`excludesDispatch`), `:684-750` (`constrainingScopeAxes`) | `tests/unit/rules/vacuity.test.ts` |
| **HIGH-1′ — `any(A, not A)` tautology** | HIGH (new in §0) | HIGH | **fixed, then re-broken and re-closed** | first `compile.ts:697-698` (**pre-fix numbering**; that range is comment text today); after the +44 line fix, `compile.ts:729` — an `any` branch containing a `not` **anywhere in its subtree** contributes nothing | `vacuity.test.ts:60-355`. See §0.1 and §0.2: the first version read only the direct arms and is what NEW-2 was |
| **HIGH-1″ — `taskLabel hasAll []`** | HIGH (new in §0) | HIGH | **fixed** | `compile.ts:463-472` — `taskLabel` added to the `rule.empty_enum` branch, `has` excluded | `vacuity.test.ts:297-338`; my probe: `hasAll []` and `hasAny []` both → `rule.empty_enum` |
| MED-2 — `capability all` with a duplicate | MED | **HIGH** | **fixed** | `src/rules/evaluate.ts:470-484` — `present`/`missing` built over the **deduped** `declared` set; `all` tests `missing.length === 0` | `tests/unit/rules/dedupe-membership.test.ts` (13) |
| MED-3 — four restriction members never applied | MED | MED | **fixed, after two further breakages** | `src/rules/evaluate.ts:1895` (destructure out), `:1930-1950` (narrow), `:1975-1979` (digest base) | `tests/unit/rules/kernel-restrictions.test.ts` (16); my probe |
| MED-3′ — a pre-approval suppressed a rule's dispatch demand | MED (latent) | MED | **fixed** | `evaluate.ts:1947` — the test is whether a layer other than `safety_floor` demanded it, replacing `!preApprovalClearedDefault` | `kernel-restrictions.test.ts:366-483` |
| MED-4 — store handed adapters the live envelope | MED | MED | **fixed** | `src/notifications/store.ts:451` (clone+freeze on write), `bus.ts:284` (fresh deep-frozen clone per adapter, inside `deliverOne`'s `try`) | `tests/unit/notifications/isolation.test.ts` "N14" describes |
| MED-5 — replay over-admission | MED | MED | **fixed** | `src/budgets/recovery.ts:629-797` — classify each occupying row, install refused rows as `expired` | `tests/unit/budgets/recovery.test.ts`, `adversarial.test.ts:464` |
| MED-5b — `releasedUnits` on `held → committed` | LOW | LOW | **fixed** | `src/budgets/ledger.ts:463` — `occupiesCapacity(current) && !occupiesCapacity(next)` | review G3 |
| MED-5c — a store that reports success and moves nothing | MED | MED | **fixed** | `src/budgets/recovery.ts:383-429` — R18 reads the ledger back into `RecoveryReport.unverified` (`types.ts:751`) | review G4 |
| LOW-6 — `eligible()` ignores `leaseExpiresAt` | LOW | LOW | accepted, documented | `ledger.ts` — L1 stated as a definition; lease reclamation is `recoverLeaked`'s job | — |
| LOW-7 — two `pre_approve` actions in one rule | LOW | LOW | accepted, unreported | `compile.ts:1018-1019` takes `preApprovalActions[0]`; `preApprovalBasis` cannot say which granted | — |
| LOW-8 — `.strict()` accepts own `__proto__` | LOW | LOW | accepted, upstream | Zod 4.4.3 behaviour; no escalation and no digest change | — |
| LOW-9 — no production caller | LOW | LOW | **STILL OPEN** | none — §5 | source scan, §5 |
| NEW-1 — `ReplayRequest.now` required, typed, unread | LOW | LOW | recorded, not fixed | `recovery.ts:634` `void request.now`; `types.ts:499-505` | review G5 |
| **NEW-2 — vacuity test is not depth-transitive** | — | **HIGH** | **FIXED** | `src/rules/compile.ts:678-682` (`subtreeContainsNegation`), called at `:729` — reads the **whole subtree** for a `not` at any depth | `tests/unit/rules/vacuity.test.ts` (19). My probe `/tmp/m6-gate/new2.ts`: all five depth-1/2/3 shapes refused, both controls still compile. Red/green in §0.1. The ADR amendment it implies is **still outstanding** — §8.1, §10 |

**Five of five of the review's original findings are closed, and the one new HIGH-severity
defect this report raised is now fixed. NEW-2 is the same family as HIGH-1 and it was
fail-open, not a disclosure artefact; revision 1 filed it as the latter (§0.1).**

---

## 5. Reachability — the most important paragraph in this report

**Nothing outside `src/simulation/` and `src/rules/tui/` imports any M6 module, and
`src/rules/tui/` is itself imported by nobody.** Re-derived from source, not from the review,
and **re-derived again for revision 2 with the same result**:

```
$ for m in rules budgets routing workflows simulation notifications; do … done
  src/rules       <- only src/simulation/types.ts:158 and src/simulation/plan.ts:137
  src/budgets     <- 0 importers outside itself, src/simulation, src/rules/tui
  src/routing     <- 0
  src/workflows   <- 0
  src/simulation  <- 0
  src/notifications <- 0
  src/rules/tui   <- 0 importers anywhere

$ grep -rn "rules/\|budgets/\|routing/\|workflows/\|simulation/\|notifications/" src/server src/cli.ts
  (none)

$ grep -c rules src/tui/shell.ts
  0

$ grep -n ruleSnapshots src/application/local-project-registry.ts
  124:        ruleSnapshots: [],
```

`tests/unit/rules/barrel.test.ts:350-386` asserts the same shape from the other direction —
`src/simulation/` is the one *sanctioned* consumer, named in a `PERMITTED_CONSUMERS` list so
that adding a second one is a decision rather than a byproduct.

**The consequence, stated without hedging:** `POST /approve` → `start` reads
`ruleSnapshots: []`. No M6 rule is compiled, evaluated, previewed, or enforced anywhere on the
shipped dispatch path. Every one of the eleven Completion Criteria that concerns
pre-approval, disclosure, budgets, routing, or notifications is therefore **vacuously held on
the shipped path** — the same structural finding as M5's isolation audit S-1, and the second
milestone in a row to produce it.

**The M6 guarantee is not held on the shipped approval path. A reader must not come away from
this report thinking it is.** The library is correct to the extent measured in §7; the wiring
does not exist.

**This paragraph is unchanged by the NEW-2 fix, and that is the point.** The fix is in
`compile.ts`; reachability is in the import graph and in one literal, `ruleSnapshots: []`. They
do not touch. §0 closes a defect in a check that no shipped code path runs.

**What it would take to change that,** in order:

1. A real rule store behind the seam: `ProfileLocalProjectRegistry` currently has no rules to
   return, and `ruleSnapshots: []` is not a placeholder, it is the whole value.
2. A composition caller that threads `evaluateRules` → `evaluateWithKernel` and passes
   `ruleRestrictions`, so MED-3's four members are actually applied. `simulation/plan.ts`
   already does this and can be read as the reference.
3. Inverting the M5/M6 isolation assertion. `tests/unit/rules/barrel.test.ts` currently *fails*
   if a non-simulation module imports `src/rules`. Whoever wires the seam must add that module
   to `PERMITTED_CONSUMERS` **and** amend ADR §1, and should invert the test as the review's
   residual-risk note recommends: assert that the first non-simulation caller of `src/rules` is
   one that also applies `narrowWithRuleRestrictions`.
4. Deciding who resolves `ceilings` for replay, and what a wrong answer costs (§8.2).
5. ~~Fix NEW-2 before a pre-approval can be activated by anyone.~~ **DONE** — `compile.ts:678-682`,
   closed at every depth, red/green in §0.1. This was the ordering constraint I put on the
   wiring and it has been honoured: the vacuity check is sound before anything reaches it.

Doing 1–3 now wires a **correct** library into the approval path rather than a live vacuity bug.
That was the point of the ordering and it is discharged. **It does not move the milestone.**
Correct-and-unreached and broken-and-unreached reach the operator identically: nothing. §5's
conclusion is untouched by §0, and I want that stated plainly so the NEW-2 fix is not read as
partial progress on reachability. It is not. It removes a reason *not* to wire the seam, and
that is all it does.

---

## 6. The plan's Completion Criteria

The plan lists eleven. Verdict, then the test that carries it.

| # | Criterion | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Default installations still require approval for every dispatch | **MET in the library, vacuous in production** | `tests/unit/simulation/plan.test.ts:78`; `tests/integration/automation-safety.test.ts:211`; `compileRuleSet([])` yields `rules: []` with a real digest (`automation-safety.test.ts:1515`). My canonical simulation: `everyDispatchRequiresApproval: true`, both dispatches `outstanding: ["dispatch_approval"]`. No production caller (§5). |
| 2 | User rules are versioned, deterministic, bounded, explainable, and cannot execute code | **MET** | Version 2 with `rule.language_version_unsupported` (`types.ts:114-116`). Determinism: `evaluate.test.ts:184`, and my two-run digest match. Limits: `limits.test.ts`, 45 tests over 15 describes, one per ADR §9 row. No execution: `invalid-inputs.test.ts:552`; `barrel.test.ts` scans `src/rules/**` for `eval`, `require`, `Date.now`, `new Date()`, `Math.random`, `node:fs`, `node:child_process`. Explainable: seven distinct non-match outcomes (`ruleMatchOutcomeSchema`, `types.ts:1155-1164`) plus `matched`. |
| 3 | Preview and runtime use the identical compiled rule representation | **MET** | Structural: one `compileRuleSet` (`:1297`), one `CompiledRuleSet`, one `evaluateRules` (`:1231`), and `preview.ts:928` calls it with no matching branch of its own. `preview-divergence.test.ts`; `rule-preview.test.ts` test 1 compares against a hand-built context, not a shared helper. |
| 4 | Pre-approval is restricted to the exact displayed bounds | **MET in the library, vacuous in production** (was NOT MET in revision 1) | The bound half was always met: `allowDestructiveEffects`/`allowExternalEffects` are `z.literal(false)`, the timeout is capped at the floor's 3600, and the disclosure is asserted item by item (`preview.test.ts:403`). The display half was not, and **NEW-2 was the violation**: a pre-approval disclosed as `reach.roles = ["role-1"]` matched every role and returned kernel `allow / outstandingApprovals: []`. **Both halves are now met inside the library** — the subtree check refuses that rule at compile time, so it cannot exist (§0.1), and the disclosure cannot over-report on a live rule. Re-derived against the fixed tree, not flipped: the criterion says the pre-approval is *restricted to* what was displayed, and a rule that will not compile is trivially so restricted. **The caveat is unchanged and is the reason this is not a plain MET: there is still no production caller, so the restriction is never exercised on the shipped path (§5). And one sound shape is now over-refused** (`any(A∧B, A∧¬B)`, §0.2), which costs an author a rewrite and is not a soundness violation. |
| 5 | Safety-floor and role restrictions cannot be weakened | **MET** | Review §2 block 1, claims 1.1–1.11, all pass: escalation fields refused by the **parser** as `z.literal(false)` violations, not by a handler; `SAFETY_FLOOR` deep-frozen; `narrowPolicyState` records widening attempts rather than applying them. `evaluate.test.ts:692` "the KERNEL decides". `kernel-restrictions.test.ts:326` — the composition cannot widen. |
| 6 | Run/role template edits do not mutate instantiated snapshots | **MET** | `tests/unit/workflows/immutability.test.ts`, 3 describes / 19 tests: digest unchanged after edit, still verifiable, no drift across ten edits, no shared object at any depth, frozen at every level, still verifies after every mutation attempt. |
| 7 | Fan-out, concurrency, retry, and wall-time budgets survive restart and replay | **PARTIALLY MET** | Replay of a durable **log** into a fresh ledger is tested and now classifies rather than totals (`recovery.test.ts:825`, `adversarial.test.ts:464`). **No process restart is exercised, because there is no durable store to restart from** — `ledger.ts:120-138` records this. Every atomicity result is a property of `InMemoryBudgetLedgerStore`. |
| 8 | Dry run produces no persistent or external side effect | **MET** | `no-side-effects.test.ts:196`, `sinks.test.ts`, and `dry-run.test.ts` tests 1–3 counting **at** the sinks: 0 event appends, 0 network calls, 0 process launches, 0 filesystem writes, 0 notifications, 0 retained reservations — with `budgetReservationAttempts === plan.dispatches.length` proving the one sink that must be entered was. All 16 throwing sink methods are individually called and required to throw, so the zeros are not unfalsifiable. |
| 9 | Routing is deterministic for the same registry snapshot and excludes unauthorized/unhealthy nodes | **MET** | `determinism.test.ts:79,201,240` — byte-identical answer, code-unit comparator, frozen result; `eligibility.test.ts:53,193` — every exclusion carries a reason; review §2 block 10 including determinism over 50 permutations. Not tested: cross-machine (ADR §6.2 tzdata is version-dependent; one machine here). |
| 10 | Notifications are deduplicated and contain no secret prompt/context content | **MET** | `dedupe.test.ts:61,110,159` — by key never by content, exact window boundary, invisible to the producer; `no-secrets.test.ts` — 49 tests, canaries in every field, the schema refuses what the audit would find, and the audit reports a path and a kind but never the content. |
| 11 | Security review finds no approval, mutation, or budget bypass | **NOT MET** | The review found one HIGH and four MEDIUM. All five are fixed. **A sixth HIGH (NEW-2), which this report raised against the review's code rather than the review's findings, was open in revision 1 and is now fixed** (§0.1). So the honest position is that this report found one HIGH the review did not, and it took a second pass to close it. **The criterion still says NOT MET, and it is worth being precise about why, because the reason is not a code defect any more:** the review and this report together found six bypass-class defects, the review said up front that it touched no file under `src/` or `tests/`, and every one of the six is now fixed by someone else. A criterion reading *"finds no bypass"* is satisfied by a clean review, not by six findings plus six fixes. What it should read is closer to *"every bypass the review found is fixed and independently re-verified"*, and **that is now true** — I re-ran all of them for revision 2. I am not going to reinterpret a criterion to make a milestone sign, so it stays NOT MET with the re-interpretation recorded as a recommendation for the next milestone's plan. |

**Nine of eleven met inside the library, one partially, one not met — and nine of those nine
are vacuous on the shipped path (§5).**

**Changed in revision 2:** #4 moved **NOT MET → MET in the library, vacuous in production**
(NEW-2 fixed; §0.1). #11 stays **NOT MET**, but for a different reason — no bypass is open and
the criterion's wording, not the tree, is what fails (§6, #11). Neither was simply flipped;
both were re-derived against the fixed tree. Criterion 11 is the one the plan's Stop
Conditions care about, and it is the one I would most want rewritten before M7.

---

## 7. The five findings that changed severity, or were worse than first reported

### 7.1 HIGH-1, vacuous pre-approval — the first fix was itself defective

The original finding was that `checkNotUniversal` asked whether a scope field was **mentioned**
rather than whether a predicate **constrains** anything, so seven vacuous shapes compiled and
cleared the floor. The first fix replaced presence with a per-axis `CONSTRUCTIVE_FORMS` table
plus bound inspection on the two range axes (`roleVersion` `1..1000`, a four-rung sensitivity
lattice), which closed all nine.

**That fix was not sufficient, and it failed in the direction that costs most.** The
`constrainingScopeAxes` recursion counted any constructive descendant under an `any` while
skipping every `not` node it met. So `any(A, not A)` — a tautology — counted `A` as
constraining, and the disclosure affirmatively reported
`reach.projects = {kind: "constrained", values: ["proj-1"]}` **citing the very atom whose
negation was its sibling**. The review measured 15 of 19 constructive atoms producing a grant
with `preApprovalClearedDefault: true`. Separately, `taskLabel hasAll []` compiled because the
empty-enum guard enumerated three set fields and four identifier fields and simply omitted
`taskLabel`, and `hasAll []` is in `CONSTRUCTIVE_FORMS` and vacuously satisfied.

Both are now refused. **My own re-measurement through the real compiler:** all **19** of 19
constructive atoms in `any(A, not A)` are refused (`/tmp/m6-gate/probe.test.ts`), and
`taskLabel hasAll []` and `hasAny []` both return `rule.empty_enum`. The fix is at
`compile.ts:729` (a `not` arm makes the whole disjunctive branch unusable as a scope, read over
the branch's **whole subtree** — see §0.1) and `compile.ts:463-472` (`taskLabel` joins the
empty-enum branch, `has` excluded because it takes
a single label and has no empty-array spelling).

The rule the fix installs is not complement reasoning and does not need to be: *a disjunction
containing a negation cannot be stated as a reachable set on any axis*, and a reachable set is
what the disclosure is required to render per axis.

**Revision 1 ended that paragraph with “And it is not depth-transitive — see §8.1
(NEW-2).” That was true then and is the whole of what NEW-2 was. The second fix reads the whole
subtree and closes the family at every depth the language admits; §0.1 has the measurement and
§0.2 has what it cost.**

### 7.2 MED-2, `capability all` with a duplicate — recorded as a disclosure mismatch, was a fail-open

The original finding described a disclosure mismatch: the disclosure de-duplicates
(`explain.ts:375`) and the normalized predicate does not, so the reach displayed was narrower
than the reach enforced. That is true and it is the smaller half.

`evaluateSetPredicate` built `present` by filtering the **raw array** and compared
`present.length` to a **deduped `Set` size**. A duplicate therefore counted a member twice and
the `all` comparison inverted. Measured before the fix:

```
capability all ["fs.read","net.fetch","fs.read"]
  request ["fs.read"]             -> matched        (intended: not_matched)
  request ["fs.read","net.fetch"] -> not_matched    (intended: matched)
```

A pre-approval written for "requests that need both `fs.read` and `net.fetch`" was **granted**
to a request needing only `fs.read`, and **refused** the request it was written for. That is
fail-open on a grant, not an audit artefact. **Reclassified MEDIUM → HIGH.**

Fixed at `evaluate.ts:470-484`: `present` and `missing` are built over the deduped `declared`
set and `all` tests `missing.length === 0`. Verified on all three set axes, which share
`SET_SUBJECT` and the evaluator — `tests/unit/rules/dedupe-membership.test.ts`, 13 tests,
including the equality property that a duplicated declaration matches exactly the dispatches
its deduped twin matches, over every duplicate placement and every request, per axis, per
operator.

### 7.3 MED-3, `evaluateWithKernel` never applied the restrictions — found broken twice more

`requireApprovalForDispatch` and `requireApprovalForCapabilities` have **no field in the frozen
M0 `restrict` effect**, which has exactly three members. They travel in
`RuleEvaluationResult.restrictions` alongside `add_restrictions.allowedCapabilities` and
`maximumTimeoutSeconds`. `evaluateWithKernel` — the module's only composition entry point —
**exported `narrowWithRuleRestrictions` and never called it.** Four members of a
`require_approval` or `add_restrictions` action compiled, were digested, were named in
`unprojectedNarrowing`, and were silently discarded. A rule that says "require approval for
`net.fetch`" appeared to work and did nothing, which is worse than refusing the action: an
inert rule is indistinguishable from a rule that matched nothing.

**Three stages, all measured:**

| Stage | State | Measured |
| --- | --- | --- |
| 0 | adapter exported, never called | `restrictions.allowedCapabilities: ["fs.read"]`, `unprojected: ["allowedCapabilities"]`, kernel effective `["fs.read","net.fetch"]`. A rule weaker than it reads. |
| 1 | first fix spread the M6-only `ruleRestrictions` key into the kernel's `.strict()` three-key input | **every call returned `Err`** — `rule.evaluation_failed: Unrecognized key: "ruleRestrictions"` — including calls passing `null` and calls passing nothing. The narrowing was unreachable. |
| 2 | second fix set `decisionDigest: undefined` in the digest base | **every call threw** — `digestJson` refuses to canonicalize `undefined`. Verified: `digestJson({a:1,b:undefined})` throws `Canonical JSON cannot encode undefined`. The narrowing was still unreachable, one line further down. |
| 3 | current | `requireApprovalForCapabilities: ["net.fetch"]` → `outstandingApprovals: ["capability:net.fetch","dispatch_approval"]`. `add_restrictions.allowedCapabilities: ["fs.read"]` → effective `["fs.read"]`. A call with no `ruleRestrictions` → `require_approval / ["dispatch_approval"]`. |

**The lesson, and it is the most transferable thing in this milestone:**

> **A safety feature that cannot execute looks exactly like a safety feature that works, and a
> green suite proves nothing about it.**

At stage 1 and stage 2 the suite was green — 5,000-plus passing tests — because
`grep -rn ruleRestrictions tests/` returned **zero hits**. The parameter was documented as
required (*"Omitting this argument reproduces the M6.10 MED-3 defect"*) and no test supplied it.
The suite could not see the feature because the suite never called it. `kernel-restrictions.test.ts`
(16 tests) exists for that reason, and its first three cases are the shapes that failed before
the fix, **including the two that supply nothing at all**, because a suite testing only the
documented shape would let `null` and omitted regress silently again.

The same lesson, independently, in §7.4's MED-5c: a store reporting success while moving
nothing defeated every recovery check, because they all trusted return values. The fix reads
the ledger back into `RecoveryReport.unverified`.

The ordering is also now normative rather than incidental. The narrowing runs **after** the
kernel's pre-approval pass, so a demand a rule adds is not something that pass has already
considered; and a demand added by a rule is not clearable by a pre-approval, tested by whether
a layer **other than `safety_floor`** appears in `dispatchApprovalDemands`
(`evaluate.ts:1947`). The earlier guard was `!preApprovalClearedDefault`, which is the sign
flipped — it let a rule set carrying both a matching `pre_approve` and a matching
`require_approval` have the pre-approval suppress the rule's own demand, i.e. adding the demand
was free in the one case where it must not be. That defect was latent and unreachable while
stage 1 was live; it is fixed and tested (`kernel-restrictions.test.ts:366-483`).

### 7.4 MED-4, the store handed adapters the live envelope

`publish` deliberately stored the **original object** rather than Zod's copy — the rule was
"the envelope is stored verbatim" — and the same object went to every adapter, unfrozen. An
adapter could rewrite `summary`, `runId`, `taskId`, `dispatchId`, `nodeId`, `ruleId`,
`reasonCode`, `category`, `severity` and `createdAt` in the operator's inbox: retitle a
"blocked by rule X" as "nothing happened", re-attribute it to a different run, or date it past
the retention window so `expire()` drops it silently. Rewriting `dedupeKey` also
desynchronised the dedupe index from the entries, so `findByDedupeKey` answered about a key
the inbox no longer held while the next notification with the original key was stored as a
second entry rather than deduplicated.

Fixed on **write**, which is the correct side of the boundary: `publish` stores
`deepFreezeNotificationValue(structuredClone(envelope))` (`store.ts:451`), because `list()` runs
per TUI keystroke and a clone-on-read is the copy that costs. `deliverOne` (`bus.ts:284`) gives
each adapter a **fresh** deep-frozen clone, inside its own `try` so a clone failure cannot abort
the fan-out. Three of three adapters receive distinct objects, so one adapter's failure cannot
affect another's.

**`structuredClone` was chosen over `schema.parse` deliberately:** parse output is a function
of the *schema*, so a future default or transform would silently change what the inbox holds at
rest; `structuredClone` is a function of the *value*.

**What the fix does not close:** prototype pollution. Freezing blocks a write to the envelope,
not to a shared prototype. Measured (`/tmp/m6-gate/proto4.test.ts`):

```
envelope write threw (frozen); Object.prototype.m6proto=yes
```

That is inherent to running attacker code in-process, is not reachable from a notification
payload, and is the same observation the review recorded. It is listed in §8.3.

---

### 7.5 MED-5, budget replay over-admission — recorded as over-admission, was a wedge

`InMemoryBudgetLedgerStore.restore` is a public method on an exported class and
`replayDurableReservations` called it with no ceiling check at all. The recorded argument was
that a verbatim replay cannot over-admit, because the log "is exactly the reservations the
crashed process admitted and no others." That argument holds for a log this ledger wrote —
`reserveInTransaction` is a single synchronous frame, so a log it wrote cannot already be over
the ceiling — and fails for every log that matters: a hand-assembled one, one shipped twice and
concatenated, one from another store, one edited on disk.

**The recorded impact was wrong in a way that inverted the fix.** Five `held` rows against a
ceiling of one replayed to `held: 5`, `eligible: true` for all five. It was reported as
over-admission. It is not: the budget is not bypassed. `reserveInTransaction` computes
`5 + 1 > 1` and refuses, and **refuses every future reserve too**. The budget has stopped
being a budget, at the worst possible moment, and the operator sees a saturated scope with no
saturation to show for it. That is a **wedge** — an availability failure wearing a safety
costume — and a fix that simply refused harder would have been the wrong fix.

The fix is a second admission decision. Each **occupying** row is assigned exactly one named
verdict, checked in the order `duplicate_dispatch` → `ceiling_undeclared` → `over_ceiling`
(`src/budgets/recovery.ts:725-729`; three reasons at `src/budgets/types.ts:772`). A rejected row
is installed as **`expired`**, never `released`: `released` asserts a terminal *dispatch state*,
which is a fact replay has no evidence for, because the process that would know is the one that
died. `expired` asserts only that the row holds no capacity, which is true.

**Re-measured at the gate:**

```
five held rows, ceiling 1        -> held=1  rejected=4  reasons=[over_ceiling]
three held rows, ceiling: null   -> held=0  rejected=3  reasons=[ceiling_undeclared]
```

Two properties make the composition safe rather than merely reasonable, and the second is the
one that separates the fix from the wedge: **refusal is never total**
(`restored.length + collapsedRecords === recordCount`) and **refusal returns capacity**
(`expired` is non-occupying, so the recovered ledger still answers a reserve from the ceiling
rather than from a total nothing can account for). A malformed ceiling — non-integer, negative,
`NaN`, `Infinity` — throws a `RangeError` naming the scope.

**Two further defects surfaced while fixing it, and both are the same species as MED-3:**

1. **The ledger's maintained `releasedUnits` index under-released on `held → committed`.**
   Both states occupy capacity, so a commit is a move *within* the occupying set and must return
   nothing. The index computed the subtraction from "was occupying" alone, so every commit
   looked like a release and the index under-reported the held total by exactly the units of
   everything that had ever launched. **Admission was never affected** —
   `reserveInTransaction` recomputes from the reservation *list*, and `Math.max(0, …)` floored
   the drift rather than exposing it. What was wrong was the number a caller reads to render
   "3 of 5 held". Fixed at `src/budgets/ledger.ts:463`.

2. **A store that reports success while moving nothing defeated every recovery check**,
   because every one of them trusted return values. A store that delegates each call to the
   real one and restores the prior state underneath makes the sweep report two reclaimed and
   one retained when the truth is one reclaimed and two retained — all three wrong, in the
   over-release direction of unit conservation. Fixed by R18: the sweep **reads the ledger
   back** into `RecoveryReport.unverified` (`recovery.ts:383-429`, field declared at
   `types.ts:751`).

The second defect is the same lesson as §7.3 from a different direction: **a component that
agrees with itself is not evidence.** The first defect is the same lesson from a third: a value
that is floored rather than exposed cannot fail loudly, so nothing downstream ever learned it
was wrong.

---

## 8. Residual risk, honestly

### 8.1 The vacuity check is a per-atom syntactic test, not a satisfiability solver — and the depth hole in it is closed

The check decides whether a rule *contains a claim that can exclude*, never whether the rule as
a whole is satisfiable or whether its clauses contradict one another. **That limit is
permanent and I still hold it.** What changed in revision 2 is that one hole *inside* that
limit — the branch test reading only an `any`'s direct arms — is fixed, and what the fix
cost is now a known, bounded class of sound rules that will be refused.

**NEW-2 is closed.** `subtreeContainsNegation` (`compile.ts:678-682`, called at `:729`) reads
the **whole subtree** for a `not` at any depth. The family is refused at every depth
`MAX_PREDICATE_DEPTH` = 6 admits; measured at depths 1, 2 and 3 in §0.1. The adversarial
rule that motivated the finding — `any(roleId eq "role-1", any(projectId eq "proj-1", not
projectId eq "proj-1"))` — no longer compiles, so `role-9` can never be approved by it.

**It is conservative by refusal, and the class it refuses is knowable in advance.** Re-measured
for revision 2 (`/tmp/m6-gate/overrefuse.ts`; full output in §0.2):

```
COMPILES  any(P, Q)          two projects
COMPILES  any(P, C)          two different axes
COMPILES  any(P, R)          the shape an intersection-over-arms fix would have refused
REFUSED   any(P, not S)      different axes, genuinely excludes most projects
REFUSED   not(all(C, D))     a real exclusion
REFUSED   not(P)             a real exclusion
REFUSED   any(A&B, A&not B)  sound, and refused anyway
COMPILES  all(R, any(A,not A))   a tautology under a CONJUNCTION - correct, `all` cannot be widened
```

An author who writes "everything except requests needing both `fs.read` and `net.fetch`" is
still told their rule is universal. Fail-closed, and the message is still wrong. That is
unchanged, was true before the fix, and remains true after it.

**The one sound shape the fix newly refuses.** `any(A∧B, A∧¬B)` is satisfiability-equivalent
to `A`: its true reach is exactly the set the disclosure would report, so refusing it is a
pure cost with no safety return. Distinguishing it from `any(R, any(A, ¬A))` requires deciding
satisfiability over a language with no vocabulary for it. §0.2 records the trade as accepted
rather than worked around, and records that **two pinned tests changed direction to make it**,
by name, with the argument in the test file.

**Why the fix is narrow: unioning, not intersecting.** An intersection-over-arms approach was
tried and rejected, because it refuses `any(projectId eq "p", roleId eq "r")`, which genuinely
excludes dispatches and must compile. Unioning is the right operator **for the question being
asked**: *does this rule exclude anything?* — not *is its reach a product set?* A rule that
excludes nothing must not clear the safety floor; a rule that excludes something may. Pinned
as a CONTROL by the test *"the sibling CONTROL still holds: `any(A, B)` with no negation
anywhere still compiles"*.

**The test that used to document this as a boundary now closes it.** Revision 1 pointed at
`tests/unit/rules/vacuity.test.ts:241` as documenting a fail-closed boundary, and separately
said no test in the tree constructed the worst member. Both were true of revision 1's tree.
Both tests have since changed direction, and the end-to-end assertion that the nested
tautology cannot reach the kernel was added. **The family now has a worst-member test rather
than a family-name test.**

**What is still outstanding, and it is a documentation defect: ADR 0007 has not been amended
for this.** The ADR is still 1,959 lines and still says three things that are now false:

1. **§8.2.3 (`:1034`) states its rule as total** — *"An `any` branch containing any `not` arm
   contributes nothing"* — without saying the test is over the branch's **whole subtree**. The
   code is now depth-transitive and the ADR does not say so.
2. **§8.2.4 (`:1057`) concedes the check *"can be fooled into crediting scope the rule does
   not have — with the one exception recorded in the amendment's residual-risk note."*** That
   exception no longer exists, so the concession is now stricter than the truth.
3. **The residual-risk bullet at `:1674` is a live defect report for a defect that is closed**,
   it still names only the projects axis when the roles axis is the one that mattered
   (§3, M6.1), and **its prescribed fix is half wrong**: *"consult the whole subtree rather
   than the direct arms, **and** to intersect rather than union within a conjunctive arm."* The
   intersection half was tried and rejects `any(projectId eq "p", roleId eq "r")` (§0.2).

An ADR that describes a closed defect as live is the same failure mode the document exists to
prevent, and an ADR that prescribes a fix known to over-refuse will be implemented by whoever
reads it next. **This is the one thing about NEW-2 I would still block on, and it is a
follow-up amendment, not a code change.**

### 8.2 Replay's ceiling check is only as good as the `ceilings` its caller resolves

`replayDurableReservations(target, records, { now, ceilings })` guarantees `held <= ceiling`
**relative to the ceilings it was given**. Replay cannot re-derive the budget in force at crash
time, and a caller that resolves `ceiling: null` for a scope that in fact had a maximum is not
second-guessed. That caller's arithmetic, not replay's, is where an over-admission enters. The
refusal to guess is loud where it can be — a non-integer, negative, `NaN` or `Infinity` ceiling
throws a `RangeError` naming the scope — and the trust boundary is named so a reviewer of a
*caller* knows what it is being asked to be right about. There is no caller, so today the
guarantee is untested against a wrong one.

### 8.3 Prototype pollution is not closed in the notification store

Freezing blocks a write to the envelope. `Object.prototype.x = "y"` from inside an adapter
still lands, measured (§7.4). Inherent to running attacker code in-process, unreachable from a
notification payload, and not fixable by freezing. Recorded so nobody later reads the freeze as
closing it.

### 8.4 `ReplayRequest.now` is required, typed, and deliberately unread

`recovery.ts:634` is `void request.now`. The argument (ADR R16, "replay never restamps and
never invents") is correct: a replay should not rewrite the log's timestamps, and the review
verified reports with `now=2026` and `now=1999` are byte-identical. But a required, documented,
permanently-unread parameter is a trap for the next caller and will be used to smuggle
clock-dependent behaviour in. Making it optional, or removing it, costs nothing. **Not fixed.**

### 8.5 The M6.8 TUI layer is implemented, tested, and attached to nothing

`src/rules/tui/` is 3,592 lines and 172 tests with **zero importers**. `src/tui/shell.ts` names
`rules` zero times. Two of its ports (`RuleTuiSimulationReport`, `RuleTuiTemplateCapture`) have
no producer anywhere in `src/`. The integration points are documented
(`src/rules/tui/index.ts:19-61`) and nothing has used them. A user cannot reach the rules
experience this milestone claims to deliver.

### 8.6 Everything is in memory

`InMemoryBudgetLedgerStore`, `InMemoryNotificationStore`, `InMemoryRunTemplateRepository`,
`CompiledRuleSet` held and recompiled on change. Each is a recorded deferral with the seam
named (`BudgetLedgerStore`, `reserveInTransaction(draft, decide)` for `BEGIN IMMEDIATE`), and
each is why Criterion 7 is only partially met: there is no durable store to restart from, so no
restart is exercised.

### 8.7 Not tested, and named

- **Cross-machine routing determinism.** Determinism is verified in-process over 50
  permutations. `Intl.DateTimeFormat` for a schedule window is host-tzdata-dependent; ADR §6.2
  records the zone as written and the computed instant so a reader can tell which
  interpretation produced a decision. One machine here.
- **A durable `BudgetLedgerStore`.** Every atomicity result is a property of the in-memory
  store. `reserveInTransaction(draft, decide)` is the seam that would carry `BEGIN IMMEDIATE`
  and it is untested because no durable store exists.
- **Restart of a real process.** No restart path for budget state is shipped.
- **A notification adapter that reaches the network.** The claim that an external adapter cannot
  mutate orchestration state rests on the import graph, not on a test — and MED-4 is the
  reminder that the graph is not the only surface.
- **Preview/runtime divergence under *change*.** The present-state half is structural. The
  future half cannot be proved, because a future divergence is not a present-state fact. What
  catches it: `preview.ts` has no branch that decides whether a rule matches, so there is
  nothing there to change out of step.

---

## 9. Guardrails and Stop Conditions

### 9.1 The plan's eight

| # | Guardrail / stop condition | Verdict | Evidence |
| --- | --- | --- | --- |
| G1 | Do not create a general-purpose scripting language | **MET** | 18 predicate fields, 6 actions, no expression form, no function form, no inter-rule reference. `barrel.test.ts` source-scans `src/rules/**` for `eval`, `require`, `Date.now`, `new Date()`, `Math.random`, `node:fs`, `node:child_process`. `invalid-inputs.test.ts:552`. |
| G2 | Do not enable a broad pre-approval rule without an explicit activation confirmation | **MET in the library, unreachable by a user** | `classifyRule` refuses `activation.state === "draft"` with `not_activated` (`evaluate.ts:794`). The TUI has an `activation-confirm` overlay with an armed-confirmation gate (`tui/state.ts:320,334-340,571`), and the module is not attached (§8.5). |
| G3 | Do not support "match all projects/nodes/capabilities" pre-approval in the initial release | **MET in the library, vacuous in production** (was NOT MET in revision 1) | Re-derived against the fixed tree. `checkNotUniversal` (`compile.ts:752`) refuses the nine original shapes, the 19-atom tautology family, **and now the depth-2 and depth-3 forms that NEW-2 admitted** — measured at §0.1, all five shapes `rule.universal_pre_approval`, with both no-negation controls still compiling. The guardrail is enforced **by name**, for both halves of it: the nine match-all shapes are refused, and a match-all **disguised as a scope** is refused too, which is what NEW-2 was. Two things keep this off a plain MET, and both are honest rather than hedging: it is **vacuous on the shipped path** (§5), and the enforcement **over-refuses one sound disjunctive shape** (`any(A∧B, A∧¬B)`, §0.2). Over-refusal is the safe direction for this guardrail — the plan forbids supporting a match-all pre-approval, and a rule that will not compile is not a supported match-all pre-approval. |
| G4 | Do not claim provider cost enforcement when usage data is missing or delayed | **MET** | `enforceability` is computed from adapter-reported usage, never from a budget being set. `adversarial.test.ts:177` — enforceable only when a measurement supports it, and **neither failure mode is silent**; `:283` — an absent budget and an unenforced budget are reported differently. `dry-run.test.ts` test 7. |
| G5 | Do not let notification delivery affect orchestration state | **MET** | `grep 'from "../' src/notifications/*.ts` → nothing; `isolation.test.ts:144` asserts it by source scan. `emit` is total against a throwing adapter, a throwing `available`, a rejection, an `undefined` result, and a malformed request (`:234-460`). `:594` — the bus is handed observations and cannot act on them. `:413` — the producer cannot branch on anything `emit` returns. |
| S1 | Stop if preview and production evaluation can diverge | **Not tripped, structurally** | One `compileRuleSet`, one `CompiledRuleSet`, one `evaluateRules`; `preview.ts:928` calls it. `preview-divergence.test.ts`, `rule-preview.test.ts` test 1, `dry-run.test.ts` test 4. The *future* half is not provable (§8.7). |
| S2 | Stop if a rule edit can retroactively affect an active dispatch or approval | **Not tripped** | Digest-bound `ruleSnapshots`; the open-proposal fingerprint invalidates rather than re-evaluates. `workflows/immutability.test.ts`; `automation-safety.test.ts` describe 6. |
| S3 | Stop if budget reservation is not atomic with dispatch eligibility | **Not tripped** | Eligibility is *defined* as holding a `held` reservation; `reserve` is one compare-and-set. `reservation.test.ts:64` over 200 interleaved trials with `N ≫ ceiling`; re-entrancy throws. `automation-safety.test.ts` describe 4. |

### 9.2 The ADR's six stop conditions

| # | Condition | Verdict |
| --- | --- | --- |
| 1 | Preview and production evaluation able to diverge | **Not tripped** (structural; future half unprovable) |
| 2 | A rule edit able to retroactively affect an active dispatch or approval | **Not tripped** |
| 3 | Budget reservation not atomic with dispatch eligibility, including by crash or replay | **Not tripped**, and replay is now a second admission decision rather than a restore (§13.3) |
| 4 | A user rule able to grant a capability removed by the safety floor or a role restriction | **Not tripped** — 11/11 escalation claims refused at the parser |
| 5 | A compiled rule set able to admit an action whose bounds are wider than the bounds the disclosure displayed | **NOT TRIPPED** (was TRIPPED in revision 1). MED-2 was this condition and was fixed. NEW-2 was this condition again — in the vacuity check rather than the matcher, and **fail-open** rather than disclosure-only, which is what revision 1 got wrong about it — and is now fixed: the family is refused at every depth (`compile.ts:678-682`, §0.1), so no compiled rule set can admit an action whose bounds exceed what the disclosure displayed. |
| 6 | A notification able to affect orchestration state | **Not tripped** |

**None of six ADR stop conditions is tripped**, which is a change from revision 1 and is the
substantive reason the picture improved. The ADR's own Stop Conditions say implementation halts
and returns to the ADR when one becomes true, so with the trip cleared the code side of that
clause is satisfied.

**Two things remain open and neither is a stop condition.** ADR 0007 is unamended for the
vacuity fix and its residual-risk bullet now describes a closed defect as live, with half a fix
prescription in it that is known to over-refuse (§8.1). That is a documentation defect, not a
tripped condition, and it is the one item from §0 I would still block on.

---

## 10. Verdict

**I would still not sign M6 as complete, and I would sign it as a library with two conditions
rather than three.** The verdict has not changed between the two revisions. The reasons have.

Revision 1 withheld signature for three reasons. **Two are gone.**

| Reason in revision 1 | Now |
| --- | --- |
| One HIGH-severity defect in the vacuity check is open (NEW-2) | **Gone.** Fixed; §0.1, §8.1 |
| `tui-keyboard.test.ts:902` exceeds a 5 s timeout under `bun run test` (NEW-3) | **Gone.** Withdrawn as unreproducible; §0.3, §1.3 |
| The milestone's safety property is not reached | **Unchanged, and now the only reason** |

So:

**First, and now alone: the milestone's safety property is not reached.** M6 exists to let a
user stop approving every dispatch without turning an approval-gated system into an unguarded
one. Every mechanism for that is built, tested, and unreachable: `POST /approve` → `start`
reads `ruleSnapshots: []`, nothing in `src/server/**`, `src/cli.ts` or `src/tui/shell.ts` names
an M6 module, and `src/rules/tui/` has zero importers. Re-verified for revision 2, unchanged:

```
$ grep -rn "rules/\|budgets/\|routing/\|workflows/\|simulation/\|notifications/" src/server src/cli.ts
  (none)
$ grep -c rules src/tui/shell.ts
  0
$ grep -n ruleSnapshots src/application/local-project-registry.ts
  124:        ruleSnapshots: [],
```

Nine of the eleven Completion Criteria are met *in the library* and vacuously on the shipped
path. This is the second milestone running to produce this result (M5's isolation audit S-1).
**A gate report that says "all green, ready" when the central safety property is unreached is
worse than no report.** The defect is not a bug; it is an unwired seam, and **it will be live
the moment anyone wires it** — which is now a different and smaller problem than it was, because
the vacuity check is sound, but not a smaller problem.

**Why the two corrections do not move this.** They are both real and both necessary, and
neither of them touches the shipped path by a single line. Closing NEW-2 removes a reason *not*
to wire the seam; it does not wire it. I want to be explicit about this because a HIGH finding
closing is the kind of event that reads as progress on the milestone, and here it is progress on
the *library*, which was never the thing in doubt. **The finding that remains is not a code
defect and cannot be closed by a code fix in this milestone** — it is a wiring decision for M7.

**Second: the ADR is unamended for a fix that has landed.** §8.2.3 states its rule as total
rather than depth-transitive, §8.2.4's concession now points at a residual that no longer
exists, and the residual-risk bullet at `:1674` describes a closed defect as live, names the
wrong axis as the one that mattered, and prescribes a fix whose second half (intersect rather
than union) over-refuses `any(projectId eq "p", roleId eq "r")`. An ADR that reports a closed
defect as live is the failure mode the ADR exists to prevent, and one that prescribes a known-
over-refusing fix will be implemented by whoever reads it next.

**Third: the report the plan asked for is not the report that exists.** The plan's gate report
is to include "the rule language version, supported predicate/action table, safety-bypass test
results, canonical simulations, and all enabled-by-default behavior." §1.4, §3 and §6 carry
those. What no green suite can supply is the one number that matters here: **the fraction of
dispatches on the shipped path that pass through an M6 rule. It is zero**, and it was zero
before the fix and is zero after it.

**What I would sign today, as a library:** the six modules, the compiler's refusal discipline
(including the deliberate over-refusal in §0.2), the structural properties that hold by
construction rather than by review (one compiled artifact, one evaluator, eligibility defined
as a held reservation, no upward notification edge, escalation fields unrepresentable), the six
security fixes, and the canonical simulation. All of that is real work and it is well tested.

**What would change the verdict:**

1. **Wire the seam, in the right order.** A real rule store behind
   `local-project-registry.ts:124`; a composition caller that threads `evaluateRules` →
   `evaluateWithKernel` **with** `ruleRestrictions`; and the barrel test's
   `PERMITTED_CONSUMERS` inverted so the first non-simulation caller of `src/rules` must be one
   that also applies `narrowWithRuleRestrictions`. **The vacuity constraint that made this
   conditional is discharged; the wiring itself is now the whole of item 1.**
2. **Amend ADR 0007** for the subtree fix: make §8.2.3 depth-transitive, retire §8.2.4's
   concession, rewrite the `:1674` bullet to name the roles axis and to describe a closed
   defect, and **delete the intersection half of its prescribed fix**.
3. **Correct ADR §7.2** — it still says `require_approval` projects as a `restrict` effect,
   which is false for two of the four members — and add the cross-reference §3.2 already
   provides.
4. **Attach `src/rules/tui/` to `src/tui/shell.ts`** at the three named points, or say plainly
   that M6.8 is a library and defer the experience.
5. **Make `ReplayRequest.now` optional**, and add a durable `BudgetLedgerStore` test or record
   Criterion 7 as permanently partial.
6. **Rewrite Criterion 11** so that it tests whether the findings were fixed rather than whether
   any were made (§6, #11).

I would not sign M6 as "the shipped approval path is now protected by M6 rules," because it is
not — and that is now the *whole* of the objection, with nothing else outstanding behind it.

---

## 11. Numbers I could not verify

Recorded because a gate report that presents unverified figures as verified is worse than one
that admits the gap. **Everything else in this report was run, in this revision, and the output
is quoted verbatim.**

- **Whether revision 1's `tui-keyboard.test.ts` measurement was real on the machine that took
  it.** I cannot reproduce 5232 ms or 6087 ms; I measure 691–849 ms for the same test in
  isolation and it passes in 4 of 4 full-suite runs. I could produce a 6113 ms timeout failure
  on demand by loading the machine (§1.3.1), so load-dependence is the available
  explanation, but I cannot confirm it and I am not asserting it. **The original measurement is
  neither confirmed nor explained.**
- **The ad-hoc probes cited in revision 1 are gone.** `/tmp/m6-gate/` had been cleared before
  this revision began — `probe.test.ts`, `residual.test.ts` and `proto4.test.ts` no longer
  exist and I could not re-run them. I re-created the ones that carry load-bearing claims
  (`new2.ts`, `overrefuse.ts`, `sim.ts`, `proto3.ts`) and every number in this revision comes
  from those. **The claims that now rest only on the pinned test suite rather than on a probe I
  ran are the 19-of-19 constructive-atom count for HIGH-1′ and the `hasAll []`/`hasAny []`
  empty-enum results in §4.** Both are covered by `vacuity.test.ts` (19 tests, green), but I
  did not re-run the specific sweep, so I have attributed them to the tests rather than to a
  measurement. The prototype-pollution result in §7.4 — the one figure from that family I
  did re-run — reproduces exactly.
- **The security review's own probe methodology.** I did not re-run the M6.10 review's probes;
  I re-verified its five findings against the code and the pinned tests that now cover them.
  I have not independently re-derived its 31 attack claims, and I make no claim about them
  beyond what §4 attributes.
- **The ADR's 126 `file:line` citations.** Revision 1 reported that all resolve. I did **not**
  re-run that sweep in this revision. What I did re-verify is every `src/` citation in this
  report, individually, against the final tree — and four of them had gone stale under the
  +44 line `compile.ts` change and are corrected here. **Treat the 126-citation claim as
  revision 1's, not re-confirmed.**
- **Per-file test counts outside `tests/unit/rules/`.** I re-verified the 17 `tests/unit/rules`
  files individually (and corrected my own first attempt, which was contaminated by `bun test`
  substring-matching `barrel.test.ts` across the repo). The per-file breakdowns quoted for
  `workflows`, `budgets`, `routing`, `simulation` and `notifications` in §3 are **revision
  1's**; I re-verified only their aggregates (257 / 193 / 108 / 113 / 327), which are
  unchanged and consistent with a flat 5079.
- **Cross-machine routing determinism.** Unchanged from revision 1 and still untested — one
  machine, and `Intl.DateTimeFormat` is host-tzdata-dependent (§8.7).
- **Whether the pre-fix red/green counts I was handed (11 pass / 8 fail) were ever measured.**
  I measured **16 pass / 3 fail**. I have used my own figures throughout (§0.1) and have not
  tried to reconstruct where the other five failures would have come from, because in this tree
  they do not exist.

## 12. Sign-off

| Role | Required | Status |
| --- | --- | --- |
| `milestone-lead` (`gpt-6-astra high`) | Yes | **Signature withheld, revision 2.** Reasons in §10. Evidence in §1–§9. The two reasons that were code defects are closed (\S0.1, \S0.3); the one that remains is unreachability, which is not a code defect. |
| `security-reviewer` (`gpt-6-astra xhigh`) | Yes (M6.10) | Delivered §0 and §3 of the security review. Its §0 dispositions on HIGH-1 and MED-3 are **superseded** by the work in §7; its LOW-6/7/8 and LOW-9 dispositions stand; NEW-1 stands. NEW-2 was mine, not theirs, and is now fixed. |
| `independent-reviewer` (`gpt-6-astra high`) | Yes (README §7) | **Not run on the integrated diff.** This report is the lead's own account and has not been reviewed by a party that did not write the code. **This matters more in revision 2 than it did in revision 1**: two corrections were made by the party that made the original errors, and an independent reviewer is the only check on that. |
| Root agent | Yes | — |

**Nothing in this report has been committed. The only file written is this one.** During
revision 2 I temporarily reverted `subtreeContainsNegation` to measure the red half of the
red/green proof (\S0.1) and restored it in the same session. The file was restored
**byte-identically** \u2014 sha256 `74a7ae8ffcf58becce65fbc28f5d14c372331d8527a62482203c31bbdd86b262`
before and after, `git status` unchanged, and `bun test tests/unit/rules` back to 789 pass /
0 fail. No file under `src/` or `tests/` is modified by this report.