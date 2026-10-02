# Milestone 6 — Rules, Automation, and Reusable Workflows: Gate Report

**Date:** 2026-10-02
**Branch:** `aibr-v2`
**Plan:** `Docs/implementation-plans/milestone-6-rules-and-workflows.md`
**Architecture:** `Docs/adr/0007-rule-language-and-evaluation.md` (**2,090 lines**, amended three times: 2026-10-01 A1–A8, 2026-10-02 A9–A13, 2026-10-02 **A14** at `a73f2a3`)
**Security review:** `Docs/implementation-reports/milestone-6-security-review.md` (1,282 lines; §0 is the 2026-10-02 revision and supersedes §3 where they disagree)
**Independent review:** `Docs/implementation-reports/milestone-6-independent-review.md` (469 lines; diff under review `c1d9f50` → `a73f2a3`)
**Tree measured:** `8714a9f` ("fix(rules): refuse a cross-axis disjunction…")

**Verdict: DO NOT SIGN — as complete, and now also not as a library. This is one notch more
severe than revision 2 of this report, and I am adopting the independent reviewer's
position rather than my own.**

Revision 2 said *"DO NOT SIGN as complete. SIGN AS A LIBRARY, with conditions,"* and
certified ADR **Stop Condition 5 as NOT TRIPPED**. **That certification was false.** The
independent reviewer found F-1 (HIGH) — a cross-axis disjunction whose arms pin different
axes, which the §11 disclosure renders as a per-axis **product** while the rule computes a
**union**, granting a pre-approval to a role or node no author named. It was fixed in
`8714a9f`. **And the fix is not sufficient: I have now measured a second grant-class
defect of the same family, F-3, still live in this tree.** Stop Condition 5 is TRIPPED
right now, by a shape that contains a negation, and no test in the suite constructs it.

I am not the signatory; the user is. §10 states what I would sign and on what conditions,
and what would change my mind.

**Revision 3 — 2026-10-02, correcting revision 2 of the same day.** Revision 2's verdict was
reached on a false central claim and on three sections written against a superseded commit,
and **four of the six corrections here are of my own errors** — two stale ADR claims, one
over-generous certification, and one correct earlier finding that revision 2 withdrew on too
small a sample (NEW-3, §1.3.1). Both are corrected here. **Revision 2 is retained in full at
§0A rather than rewritten**, because a verdict that went TRIPPED → NOT TRIPPED → TRIPPED is
the evidence, and hiding it would make this document less trustworthy than the defect it
certifies. §0 is this revision's correction.

This report replaces the 2026-10-01 draft in full. Nothing below is carried over from it
unless re-measured.

---

## 0. Revision 3 correction, 2026-10-02

### 0.1 The headline: this report certified Stop Condition 5 as NOT TRIPPED while it was tripped

**Revision 2 said, in §9.2, verbatim:**

> | 5 | A compiled rule set able to admit an action whose bounds are wider than the bounds the disclosure displayed | **NOT TRIPPED** (was TRIPPED in revision 1) … is now fixed: the family is refused at every depth (`compile.ts:678-682`, §0.1), so no compiled rule set can admit an action whose bounds exceed what the disclosure displayed. |

**And in §6, Criterion 4: "Both halves are now met inside the library." And in §9.1, G3:
"MET in the library, vacuous in production … Re-derived against the fixed tree."**

Every one of those was wrong. Revision 2 was written after the `subtreeContainsNegation`
fix closed the **negation** family, and it generalised that closure to the vacuity family
as a whole. The independent reviewer's F-1 is the counterexample: the negation rule is
invisible to it because there is no `not` in the shape.

**The before/after, stated plainly because it is the evidence:**

| | revision 1 | revision 2 | revision 3 |
| --- | --- | --- | --- |
| ADR SC5 | TRIPPED (correct) | **NOT TRIPPED (false)** | **TRIPPED** |
| Why | `any(A, not A)` compiled and granted | `subtreeContainsNegation` fixed the negation family | the family has more than one shape |
| Bypass-class defects known | 6 | 7 | **11**, of which 1 is open |

**F-1, as I measured it myself, pre-fix, through the real compiler and the real kernel**
(clone at `/tmp/m6-lead/rev`, `8714a9f` with only the cross-axis branch reverted;
`src/rules/compile.ts` sha256 `2d01dbf2…5015e3` against the shipped `bd13edca…abf`):

```
predicate: any(roleId eq "role-1", targetNodeId eq "node-1")
normalizedPredicate: (roleId == "role-1" or targetNodeId == "node-1")

disclosure:  reach.roles = {kind:"constrained", values:["role-1"], sources:["predicates[0].any[0]"]}
             reach.nodes = {kind:"constrained", values:["node-1"], sources:["predicates[0].any[1]"]}
             which reads as role-1 AND node-1 — a much smaller set than the rule computes

role=role-1 node=node-1 -> decision=allow  outstandingApprovals=[]
role=role-9 node=node-1 -> decision=allow  outstandingApprovals=[]   <- role-9 was never named
role=9/node-9            -> decision=require_approval  outstandingApprovals=["dispatch_approval"]
```

This reproduces the reviewer's table exactly, from my own probe. **`projectId` is the only
axis independently gated downstream** (`classifyRule`, `src/rules/evaluate.ts:788`, refuses
a foreign project), so on every other axis the over-report is a grant.

**Breadth, my own sweep** (`/tmp/m6-lead/rev/probe/fuzz.ts`; 8 constructive atoms, all 56
ordered axis pairs, each pair probed by violating one disclosed axis and asking the kernel):

```
PRE-FIX  (cross-axis branch reverted)   axis pairs swept 56 | COMPILE 42 | kernel ALLOW wider than disclosed 36
FIXED    (8714a9f, shipped)             axis pairs swept 56 | COMPILE  0 | kernel ALLOW wider than disclosed  0
```

The reviewer reported **21 of 56**. Mine is **36 of 56**. These are not in conflict: the
metric differs. The reviewer enumerated three ungated id axes × 7 partners = 21 and stopped
there; my sweep also treats `capability`, `toolCategory`, `runtimeKind` and
`nodeAdvertisedCapability` as axes with no downstream gate, which adds 15 more. **I am
adding to the reviewer's finding, not correcting it.**

### 0.2 F-3 (HIGH, mine, OPEN): a tautological conjunct is still reported as a real bound

**This is the finding nobody has flagged. It is the same root cause as F-1 and the
reviewer's F-2, and `8714a9f` does not close it.** I found it while re-deriving §8.1.

The reviewer's F-2 recorded `all([any(A, not A), roleId eq "role-1"])` reporting
`reach.projects = ["proj-1"]` and rated it **LOW, disclosure**, reasoning that "the projects
axis is gated by `classifyRule`." **That rating is correct for the shape they probed and
wrong for the shape's siblings.** Move the tautology onto any other disclosed axis and the
same mechanism is a grant, because no other disclosed axis has a downstream gate.

Minimum shape, measured on `8714a9f` as shipped:

```
predicate: all([ any(roleId eq "role-1", not roleId eq "role-1") ,
                 targetNodeId eq "node-1" ])
normalizedPredicate: ((roleId == "role-1" or (not roleId == "role-1")) and targetNodeId == "node-1")
                  -- satisfiability-equivalent to `targetNodeId == "node-1"`, nothing else

compileRuleSet -> COMPILES
disclosure:     reach.roles = {constrained, ["role-1"], sources:["predicates[0].all[0].any[0]"]}
                reach.nodes = {constrained, ["node-1"]}
                which reads as role-1 AND node-1

role=role-9 node=node-1 -> decision=allow  outstandingApprovals=[]   <- role-9 was never named
CONTROL  all([roleId eq "role-1", targetNodeId eq "node-1"])
role=role-9 node=node-1 -> decision=require_approval  outstandingApprovals=["dispatch_approval"]
```

**Breadth** (`/tmp/m6-lead/f3sweep.ts`; 7 atoms, every ordered pair, rule =
`all([any(A, not A)], B)`, probed by violating `A`):

```
pairs swept 42 | COMPILE 42 | kernel ALLOW on a value the disclosure called constrained: 24
```

All 42 compile. 24 of them grant. The affected tautology axes are `roleId`,
`targetNodeId`, `projectPathId` and `capability`. The other three (`toolCategory`,
`runtimeKind`, `nodeAdvertisedCapability`) do not appear because `collectReach` has no slot
for them, so the disclosure reports them as `unknown` — which for those rules is the honest
reading and is why they are not defects.

**Why it survives the F-1 fix.** The F-1 fix changed `constrainingScopeAxes`
(`src/rules/compile.ts:761-764`), which is the *check*. It did not touch `collectReach`
(`src/rules/explain.ts:314-363`), which is the *disclosure*. And the compiler is right here
and the disclosure is wrong: `constrainingScopeAxes` correctly declines to let the
tautological branch scope anything, so the sibling's axis carries the rule. But
`collectReach` walks `all` and `any` unconditionally (`explain.ts:349-351`) and skips only
`not` (`:353-355`), so it descends **into** the dead branch and cites the tautology's
positive atom as the source of a bound the rule does not have.

**This is the structural cause, and it is now the third distinct instance of it.**
`collectReach` and `constrainingScopeAxes` are two independent walks of the same predicate
tree with **no shared notion of which nodes are meaningful**, two separate implementations
of "a `not` contributes nothing", and **no test anywhere asserting that they agree.**
HIGH-1′, NEW-2, F-1 and F-3 are all disagreements between those two walks. The independent
reviewer named this in its §6 as a design risk rather than two bugs; on this evidence it
is the finding.

**The fix the reviewer preferred, and why it is the right one.** Its §3.1 option 1 was to
change the *disclosure*: mark an axis `unknown` unless every arm of every enclosing `any`
constrains it. That is one change, it would have closed F-1 **and** F-2/F-3 together,
`explain.ts` already has the `unknown` machinery and its warning text
(`explain.ts:413-419`) written for exactly this, and it preserves every rule that compiles
today. The fix that landed took option 2 — refuse the cross-axis case in the compiler —
which is sound and fail-closed for F-1 and leaves the disclosure path exactly as
unexamined as it was. **That is the reviewable lesson of this whole correction, and it is
now a measured outcome rather than a hypothesis: the milestone spent its fix budget on the
refusal and left the disclosure alone.**

**The report's own pinned control is one axis-swap from this defect.**
`tests/unit/rules/vacuity.test.ts:187` is titled *"CONTROL: still compiles a tautological
`any` sitting under an `all` beside a real sibling, because a conjunction cannot be widened
by a tautology"*. **Its assertion is correct** — the rule does compile, and that is the
right compiler behaviour. **Its stated justification is wrong:**

> "The sibling scopes the rule, and the disclosure that reports `B`'s reach is therefore
> CORRECT rather than optimistic."

On `projectId` the disclosure is *not* correct — it reports `reach.projects = ["proj-1"]`
for a rule that matches every project. The test only passes because `classifyRule` gates
that axis downstream. **Swapping the tautology axis from `projectId` to `roleId` turns this
pinned control into a live grant**, and my sweep is exactly that swap, run over every pair.
Revision 2 quoted this same control as evidence (`COMPILES all(R, any(A,not A)) tautology
under a CONJUNCTION - correct, all cannot be widened`) and in doing so recorded the
distinction that produced the hole: *correct about the compiler, wrong about the
disclosure.* F-1 was produced by the identical move in §8.1.

### 0.3 The three test changes, and the pattern they add up to

`8714a9f` touched three tests. None was deleted; none was loosened; the assertions are
`toBe(false)` with the refusal code named, or `toBe(true)` on a *narrower* shape than before.

| Test | Before | After | Why |
| --- | --- | --- | --- |
| `vacuity.test.ts` — *"the sibling CONTROL still holds: `any(A, B)` with no negation anywhere still compiles"* | `expect(compiled.ok).toBe(true)` on `any(projectId eq "p", roleId eq "r")`, as **the control that must never regress** | `expect(compiled.ok).toBe(false)` + `expect(compiled.error.code).toBe("rule.universal_pre_approval")`, renamed *"CLOSED, and it was a grant"* | **The control was the defect.** That shape is F-1 with `projectId` substituted for `targetNodeId`. It was pinned as correct by the independent reviewer, by revision 2 of this report, and by a source comment in `compile.ts` that I wrote — and all three were wrong. The test now asserts the refusal and its reasoning is attached in place. |
| `vacuity.test.ts` — new, *"no cross-axis disjunction reaches the kernel with a role or node it did not name"* | — | compile-refusal over **every pair of the four ungated axes**, plus an unreachable branch asserting the kernel would refuse | A compile-refusal test alone does not say what the failure cost. The failure was a kernel `allow`; this walks the whole path for every pair rather than spot-checking the pair the reviewer happened to find. The `projectId` axis is deliberately absent from the sweep and the reason is recorded: it is gated downstream. |
| `vacuity.test.ts` — the re-targeted control, *"a SAME-axis `any` is a real union, so it compiles"* | folded into the old control | `expect(compiled.ok).toBe(true)` over `any(projectId eq "p", projectId eq "p-other")` **and** `any(roleId eq "r", roleId eq "r-other")` | A refusal with no passing control is a refusal nobody can tell apart from an over-refusal. The new control is the *narrowest* shape that is genuinely a set operation, and the disclosure renders it truthfully: `reach.roles = {constrained, ["role-1","role-2"]}`. |
| `preview-divergence.test.ts` — breadth assertion | `expect(comparedOutcomes).toBeGreaterThan(750)` | `> 700` | **A fixture was supplying the defect a divergence sweep exists to catch.** The generator's `PREDICATE_SHAPES[5]` was `any(projectId eq "p", roleId eq "r")`. Once the compiler refused it, fewer generated sets compiled and fewer outcomes got compared, and the threshold had to move rather than be deleted. The reasoning is recorded at the assertion, including the count history 970 → 807 → 733. |

**Net effect on counts:** `tests/unit/rules/vacuity.test.ts` 432 → 520 lines, **19 → 21
tests**; `preview-divergence.test.ts` still 2 tests; `tests/unit/rules` **789 → 791**; the
suite **5079 → 5081**. The two extra vacuity tests are the additions above; one test changed
direction.

### 0.4 The verification-method finding, stated once

**This milestone found eleven bypass-class defects. On several occasions a fully green
suite of ~5,000 tests did not detect them, and twice the suite's own fixtures helped
create them.** This is a finding about how M6 was verified, not a list of bugs, and a
reader deciding whether to trust M6 needs it in one place. Three mechanisms, each measured:

1. **The disclosure was never reviewed as a pair with the check.** Five of the eleven
   bypasses are disagreements between `collectReach` and `constrainingScopeAxes`. Both were
   written by the milestone, both are load-bearing, and **there is still no test asserting
   they agree about anything.** The independent reviewer's §7 item 3 asks for exactly that
   test; it does not exist. Until it does, the next divergence is found by an adversary
   rather than by the suite.
2. **A suite can only see a defect some test constructs.** MED-3 survived **three separate
   fix attempts** — one exported the narrowing and never called it, one spread
   `ruleRestrictions` into a three-key `.strict()` input and made every call throw, one set
   `decisionDigest: undefined` in the digest base and made every call throw — against
   ~5,000 green tests, because `grep -rn ruleRestrictions tests/` returned **zero hits**.
   The parameter was documented as required and no test supplied it. **F-3 is the same
   failure in a new place**: the vacuity suite constructs every `any(A, not A)` shape
   under a top-level `any` and not one under an `all` with a sibling on a *different*
   disclosed axis.
3. **A fixture fed the sweep the shape the sweep was for.** `PREDICATE_SHAPES[5]`. The
   sweep compared preview against evaluator on rule sets the compiler should have refused,
   which is precisely the wrong class of input for a divergence sweep, and it cost 74
   compared outcomes before anyone noticed. Fixing the compiler rather than the generator
   then *lowered the sweep's own breadth threshold* — so the number that was supposed to
   detect the generator going quiet moved because the defect was fixed, and the two events
   are indistinguishable from the assertion alone.

**What would actually change this**, beyond fixing F-3: assert `collectReach` and
`constrainingScopeAxes` agree on a generated sweep of the predicate language; and treat a
divergence sweep as required to run over *rule sets that compile*, with the refused fraction
asserted separately — which the file now does, and which is the only reason the third
drop in point 3 is explicable rather than alarming.

### 0.5 What did *not* change

Reachability (§5) is untouched and was re-verified for this revision. The M0 freeze is
unmoved. Criteria 1, 2, 3, 5, 6, 8, 9, 10 and 7 are unchanged in verdict. Plan stop
conditions S1–S3 are unchanged. **§7's account of HIGH-1, MED-2, MED-3, MED-4 and MED-5 is
unchanged and the independent reviewer confirmed every one of those fixes is load-bearing,
with red/green re-measured for all six.** Details in §10.

**One thing that is not in §1's clean output and belongs here rather than buried:** while
re-taking the gate for this revision, `bun test tests/unit/rules` came back **789 pass / 2
fail** on one run and **791 / 0** on the next four. The two failures were
`tui-keyboard.test.ts:902` timing out at 8,003 ms. **That is NEW-3 reproducing, and it
reverses revision 2's withdrawal of it.** It is measured in full at §1.3.1 and it is not a
finding against the tree — but it is the reason §1.1's block is annotated rather than quoted
clean, and any reader re-taking this gate should expect to see it once in a while and should
not read it as a regression from `8714a9f`.

**Four corrections in this revision are of my own errors: two stale ADR claims (§3, §8.1),
one over-generous certification of the vacuity family (§0.1), and one correct earlier finding
that revision 2 withdrew on too small a sample (NEW-3, §1.3.1) — plus one new defect in my own
reasoning, at the pinned control in `vacuity.test.ts:187` (§0.2), which is what F-3 is.**
§10 states what that pattern is and what it implies for how much of this document a reader
should take on trust.

### 0.6 What the independent reviewer could not verify — carried into §11

The reviewer stated prominently that it could not falsify the milestone's most load-bearing
number or its central structural claim. Both concessions are load-bearing and I adopt them:

- **It could not falsify the suite total.** It reproduced `5079 pass / 4 skip / 0 fail` and
  called the figure exact. The total is now **5081** (`8714a9f`); I re-took it (§1.1).
- **It could not verify the reachability claim** — and that is the criterion it most
  expected to overturn. It tried and could not: `src/rules/tui/` has zero importers,
  `grep -c rules src/tui/shell.ts` is `0`, `local-project-registry.ts:124` is
  `ruleSnapshots: []`. **It confirms the reason this report withholds signature is sound.**
- **It could not re-verify the M6.10 review's 31 attack claims** (the probe files are gone),
  the ADR's 126-citation sweep, cross-machine routing determinism, or any durable-store or
  restart claim. Neither could I. §11 lists all of them.

---

## 0A. Revision 2's correction, retained in full (2026-10-02)

*Retained verbatim in substance so the change of position is auditable. Revision 2's
verdict was **DO NOT SIGN as complete; SIGN AS A LIBRARY**, on the reasoning below. **That
reasoning is superseded: §0.1 and §0.2 show SC5 was tripped when this section certified it
not tripped.** The measurements in this section are still correct and are re-confirmed where
they bear on §1–§2; the conclusions drawn from them are not.*

### 0A.1 NEW-2 was not a disclosure artefact, and it is now fixed

**Revision 2 said:** NEW-2 — the vacuity check reading only an `any`'s *direct* arms for a
negation — was OPEN and HIGH. A pre-approval disclosed as scoped to `roles = ["role-1"]`
matched every role and returned kernel `allow / outstandingApprovals: []`.

**Revision 2 also said, in §8.1, that this was the half that mattered** — that the projects
axis over-report was harmless because `classifyRule` independently refuses a foreign
`projectId`, while the roles axis had no such independent gate. **That specific claim was
correct and is retained.** The error in revision 1 was one of characterisation: it filed the
defect as a *disclosure* mismatch and ranked it below the matcher defects, when it was in
fact **fail-open**.

**Now:** fixed in `src/rules/compile.ts` by `subtreeContainsNegation` (`compile.ts:678-682`,
called at `:729`), which reads the **whole subtree** for a `not` at any depth instead of an
`any`'s direct children. **Re-verified on `8714a9f`** (`/tmp/m6-lead/probe.ts`):

```
REFUSED   any(A, not A)                DEPTH1  rule.universal_pre_approval
REFUSED   any(R, any(A, not A))        DEPTH2  rule.universal_pre_approval
REFUSED   any(R, any(any(A, not A)))   DEPTH3  rule.universal_pre_approval
COMPILES  CONTROL any(R, P) no negation          <- was CROSS-AXIS; now REFUSED by 8714a9f (F-1)
COMPILES  CONTROL all(R, not P) beside a real sibling

the adversarial rule, end to end:
  compileRuleSet -> REFUSED rule.universal_pre_approval
  => the rule cannot exist, so no role the author never named can be approved.
```

`MAX_PREDICATE_DEPTH` is 6, so depth 3 was comfortably expressible and the **negation**
family is closed at every depth the language admits. **The vacuity family as a whole is
not** — see §0.2.

**Red/green, and a number that differs from the one I was handed.** Revision 2 reverted
**only** `subtreeContainsNegation` to its one-level form and measured:

```
one-level check, tests/unit/rules/vacuity.test.ts :  16 pass /  3 fail
one-level check, tests/unit/rules (whole dir)     : 786 pass /  3 fail
subtree check,   tests/unit/rules (whole dir)     : 789 pass /  0 fail
```

**The three failures are exactly the three tests that exist to hold this fix down.** **I was
told 11 pass / 8 fail; I measured 16 / 3.** The direction and the conclusion are the same
and I have used my own figures throughout. **The independent reviewer re-measured this
independently, got 16 / 3, and recorded that revision 2's figure is correct and the figure
it was handed is wrong.** Revision 2's statement of this dispute is confirmed and is
repeated here without hedging.

### 0A.2 Two pinned tests changed direction, deliberately — and were changed, not deleted

In `tests/unit/rules/vacuity.test.ts`, two tests that previously asserted
`compiled.ok === true` now assert refusal with code `rule.universal_pre_approval`. Both still
exist, both still argue themselves in comments inside the test file, and neither was deleted
to make a suite green.

1. *"REFUSED, and deliberately so: `any(A∧B, A∧¬B)` is satisfiability-equivalent to `A`,
   but the check cannot see that and refuses it"* (`:209`) — previously asserted `ok === true`.
2. *"CLOSED, not documented: an `any` arm containing a `not` BELOW a combinator is now
   refused, so the fail-open it enabled can no longer be written"* (`:277`) — previously
   asserted `ok === true` and argued the shape was fail-closed because `any(all(A, not A))`
   is unsatisfiable and matches nothing.

**Test 1 is an over-refusal of a genuinely SOUND rule.** `A∧B ∨ A∧¬B` is exactly `A`, so its
true reach *is* the set the disclosure would report.

**Test 2's reversal is a correction of my own earlier reasoning, and the original argument
was wrong in an instructive way.** It was sound about evaluation — `any(all(A, not A))` is
unsatisfiable and matches nothing — and wrong about risk. The same syntactic gap also admits
**satisfiable** tautological arms, which *do* fire.

**I accept the over-refusal and both reversals as a deliberate trade, not a workaround.**
Refusing a sound rule costs an author a rewrite. Admitting a tautology clears the safety
floor for dispatches nobody authorised. **The independent reviewer reached the same
conclusion and added a check I had not made: it inspected the committed diff and confirmed
the assertions are `toBe(false)` with the refusal code named, not loosened.** Its one
addition — record that the pre-fix versions asserted `ok === true`, with a pointer to the
diff — is fair and is now recorded here.

**The third test to change direction came later, and it invalidated the argument revision 2
made to justify keeping the first two.** See §0.3. **The over-refusal trade accepted above
survives all of this**: refusing a sound rule costs a rewrite, and every refusal in this
family — the `any(A∧B, A∧¬B)` case and the cross-axis case alike — is on the same side of the
line. What did not survive is the claim that the family was closed.

### 0A.3 NEW-3 does not reproduce and is withdrawn — **WITHDRAWN IN ERROR; it reproduces**

> **Revision 3 corrects this.** Revision 2 withdrew NEW-3 as unreproducible on the strength of
> **three** runs. **Thirteen is too few a sample and the finding was real.** The measurement
> is in §1.3.1 and it is stated there in full. **This is the fourth correction of my own
> reasoning in this milestone and the second one that turned on too small a sample.** The
> original finding, its disposition and its reasoning were all correct; revision 2's
> *re-measurement* was the thing that was wrong, and §0A.3's verdict — that the finding was
> unreproducible — was a claim I had not earned.

**Revision 2 said:** `tests/unit/rules/tui-keyboard.test.ts:902` measured 5232 ms and 6087
ms under `bun run test` against a 5,000 ms default, and was recorded as an M6 flake.

**Revision 2 concluded it does not reproduce, and withdrew it. That conclusion was wrong; see
§1.3.1 for the measurement and for why a three-run sample was not enough.** Revision 2's
underlying measurements were themselves accurate:

```
bun test, whole file, 3 runs                     : 72 pass, 2.83 / 3.47 / 3.85 s
bunx vitest run, whole file, 3 runs              : 72 passed, duration 3.02 / 3.75 / 3.79 s
bun test, the test alone, 3 runs                 : 798.07 / 834.96 / 956.09 ms
bunx vitest run, the test alone, 5 runs          : 691 / 738 / 776 / 787 / 849 ms
bunx vitest run tests/unit/rules/, 3 runs        : tui-keyboard 72 tests in 3741 / 3887 / 4060 ms
bunx vitest run (whole suite), 4 runs            : tui-keyboard PASSED in all 4
```

Every one of those numbers is 0.7–4 s, and revision 2 read the sample as a refutation. **It is
a refutation of "5232 ms is typical", not of "this test times out".** Thirteen serial runs of
the test alone for this revision put the observed range at **1,893 ms to 8,003 ms** — a 4.2×
spread on a nominal ~2,300 ms test, against a 5,000 ms budget, failing at roughly 1 in 6 to 1
in 7 (§1.3.1). **A three-run sample drawn from the fast end of a 4.2× spread cannot refute a
claim about the slow end.** Revision 1's finding was right and revision 2's withdrawal was the
error; the difference between them is sample size, not analysis.

**One of revision 2's own disclosures turns out to be the mechanism, and it read it correctly
at the time:** its first `bunx vitest run` of the single test measured **6113 ms and FAILED on
timeout**, caused by issuing two vitest invocations concurrently in one tool batch. That is
load, and load is the cause. **What revision 2 got wrong was concluding that the load had to be
self-inflicted** — my thirteen runs were serial, one command at a time, on an otherwise idle
machine, and two of them failed anyway.

---

## 1. Command output

All run from the repository root on this branch at `8714a9f`. Verbatim, not summarised.

### 1.1 The plan's Gate Verification block

Re-measured for revision 3, one command at a time.

```
$ bun test tests/unit/rules
 791 pass
 0 fail
 (four consecutive runs, all 791/0 — see §1.3.1, which records the one flake this
  directory produces when the same test is run alone instead)

$ bun test tests/unit/workflows
 257 pass  0 fail

$ bun test tests/unit/budgets
 193 pass  0 fail

$ bun test tests/unit/routing
 108 pass  0 fail

$ bun test tests/unit/simulation
 113 pass  0 fail

$ bun test tests/unit/notifications
 327 pass  0 fail

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
 5081 pass
 4 skip
 0 fail
 93337 expect() calls
Ran 5085 tests across 218 files. [18.94s]

$ bun run build
$ rm -rf dist && tsc -p tsconfig.build.json
exit=0

$ git diff --check
exit=0 (clean)
```

All ten of the plan's gate commands name files that exist and all ten pass.

**The gate moved 5079 → 5081 and the shape of the movement is the point.** `tests/unit/rules`
789 → 791 and `vacuity.test.ts` 19 → 21, from the two tests `8714a9f` added. **The F-1 fix
added no test that would have caught F-3**, and one of the two it did add is a
direction-change on a pinned control. A HIGH fix that adds two tests, both of which sit in
the file that already had the defect's family name, is a warning sign; §0.4 is what it is a
warning sign *of*.

**`expect()` calls went down, 93648 → 93337**, while tests went up. That is the divergence
sweep losing 74 compared outcomes (`PREDICATE_SHAPES[5]` now refuses, §0.3) and it is
consistent with the recorded `comparedOutcomes` 807 → 733. It is also the one number in this
revision that I did not measure directly — see §11.

**One environment-dependent test flaked once during this revision, outside the workspace:** in
the revert clone, `ClaudeCodeRuntimeAdapter > Installed Claude Binary Smoke Test (credential-free)`
failed on one run and passed on the next. It is a probe of an installed `claude` binary, is
not an M6 module, and is green in the workspace. Noted because it is the only non-green I
saw anywhere and a reader comparing runs should not be surprised by it.

**Red/green for `8714a9f`, reproduced by me independently** (clone at `/tmp/m6-lead/rev` at
`8714a9f`, reverting **only** the cross-axis branch `compile.ts:761-764` back to the union,
restoring nothing else):

```
baseline, unmodified 8714a9f                     : 5081 pass / 4 skip / 0 fail
cross-axis branch reverted to the union          : 5079 pass / 4 skip / 2 fail

the two failures, named:
  (fail) ... > CLOSED, and it was a grant: a CROSS-axis `any` is refused, because the
         disclosure renders it as a product
  (fail) ... > no cross-axis disjunction reaches the kernel with a role or node it did not name
```

That reproduces the fix commit's own claim (5079/2 → 5081/0) from an independent checkout.
**Both failures are the two F-1 tests, which is what a load-bearing fix should look like.**
The workspace was not modified to obtain this; the clone is in `/tmp` and
`git status --porcelain --untracked-files=all` in the workspace is empty (§12).

### 1.2 The frozen M0 contract

```
$ ./scripts/m0-contract-signoff.sh
baseline:  e39461a
head:      8714a9f
digest:    83f9a5e0f2c6f827b0435a28519b1312f9d1000b839b151958efaaece42ee0c1
...
       69 pass
RESULT: GREEN - contract drifted but a recorded re-approval covers it.
exit=0
```

Digest `83f9a5e0…ee0c1` is the one `Docs/implementation-reports/m0-contract-reapproval.md`
records and the M4, M5 and M6 gates all cite. M6 edited nothing under `src/orchestration/`.
The `head` line now reads `8714a9f` rather than the `e613a16` of revision 2 because the
script reports the current HEAD; **the digest is identical across all four readings**, which
is the frozen thing.

### 1.3 `bun run test` (vitest) — not green, and only partly this milestone's fault

The plan does not name vitest, but `package.json` binds `test` to `vitest run` and a reader
will run it. Revision 2 measured four complete runs: `tests/unit/host/runtime.test.ts`
failed in 4 of 4 (seven `BunProcessRunner` child-process tests, deterministic under vitest,
green under `bun test`, tracked at `62c1682`, pre-M6) and
`tests/integration/terminal-websocket.test.ts` failed in 2 of 4 (a 5 s timeout, M4's
surface).

**I did not re-run the four vitest sweeps for this revision**, and that is recorded in §11
rather than glossed. Nothing in `8714a9f` touches either file, and the `bun test` runs above
are green. A reader deciding on the vitest result should re-take it.

#### 1.3.1 NEW-3, re-measured: it reproduces, and revision 2's withdrawal was wrong

`tests/unit/rules/tui-keyboard.test.ts:902` — *"answers every key on every screen and overlay
with an intent, and never throws"* — is a triple loop over
`RULE_TUI_SCREENS × RULE_TUI_OVERLAYS × KEYS` on a freshly populated state each time, against
the runner's **5,000 ms** default. `vitest.config.ts` sets no `testTimeout`.

**Thirteen serial runs of that one test, one command at a time, on an otherwise idle machine,
for this revision:**

```
run  1  pass  3157.18 ms      run  7  pass  2826.89 ms
run  2  pass  4047.75 ms      run  8  pass  2335.23 ms
run  3  pass  3201.17 ms      run  9  pass  1893.67 ms
run  4  FAIL  6744.91 ms      run 10  pass  2072.83 ms
run  5  pass  2354.91 ms      (a further 3 runs: 3089.14 / 2854.31 ms pass, 8003.49 ms FAIL)
run  6  pass  2674.81 ms

observed range 1893.67 ms – 8003.49 ms   budget 5000 ms   11 pass / 2 fail
```

**And in directory context, four consecutive runs of the whole directory:**

```
$ bun test tests/unit/rules        (4 runs)     791 pass / 0 fail, every run
```

So the honest characterisation, and it is narrower than revision 1's and broader than
revision 2's:

- **It is a real, intermittent, wall-clock failure, not a one-off.** Roughly 1 in 6 to 1 in 7
  when the test runs alone; 0 in 4 when it runs inside the directory.
- **The 4.2× spread is the finding.** A nominal ~2,300 ms test against a 5,000 ms budget with
  an observed ceiling of 8,003 ms has no meaningful headroom. Whatever the cause — GC, the
  runner, thermal state, a background process — the budget is inside the noise.
- **The failure is at the slow end, which points at contention, and that matches revision 2's
  own accidental reproduction** (6,113 ms, two vitest invocations in one tool batch). **But
  revision 2 concluded the load had to be self-inflicted, and that is what thirteen serial
  idle-machine runs refute.**
- **Revision 1's original measurement (5,232 / 6,087 ms) sits inside the range I measured, and
  revision 1's finding was right.** Revision 2 withdrew it on three runs drawn from the fast
  end. **The withdrawal was the error, and it is the second time in this milestone that a
  re-measurement of mine overturned a correct earlier finding on too small a sample.**

**What it is not:** it is not a defect in shipped code, it does not belong to M6's gate
(`bun test` on the whole directory and on the full suite was green in every run for this
revision except the isolated ones), and **it is not a reason to withhold signature.** It is a
test-only triple loop with an under-budgeted wall clock.

**Two cheap fixes, unchanged from revision 2 and still correct:** hoist `populatedState` out
of the inner loop, or set an explicit per-test timeout. **I am not making them — I may write
only this report** — but a maintainer reading this can, and either one turns a 1-in-6 flake
into a non-event.

### 1.4 Canonical simulation

Re-run for revision 3 (`/tmp/m6-lead/sim.ts` in revision 2; the digest is a pure function of
the shipped fixtures and the fix does not enter it — see below):

```
dispatchCount: 2
everyDispatchRequiresApproval: true
matchedPreApprovals: []
digestJson input keys: 16
digestA: sha256:42102fc1c5161114c656e3779954230d69b2f8b40b2d27d7a3f40c1c6ddf9471
digestB: sha256:42102fc1c5161114c656e3779954230d69b2f8b40b2d27d7a3f40c1c6ddf9471
byte-identical: true
```

**The digest is unchanged by either the NEW-2 fix or the F-1 fix, and it should be.** Both
fixes change which rules *compile*, and this canonical simulation runs with zero rules, so
neither enters the computation. **That is a null result rather than evidence of correctness,
and I record it as such rather than as a determinism win.** The meaningful determinism
evidence remains `dry-run.test.ts:536`, which asserts one byte-identical plan and digest
across fifty invocations with shuffled snapshot arrays.

---

## 2. Size

`wc -l`, current tree. Re-measured for revision 3.

| Module | src | unit `.test.ts` |
| --- | --- | --- |
| `src/rules` (language) | 7,153 | 9,686 |
| `src/rules/tui` (M6.8) | 3,592 | 2,787 |
| `src/workflows` | 2,101 | 3,052 |
| `src/budgets` | 3,345 | 4,327 |
| `src/routing` | 1,376 | 1,774 |
| `src/simulation` | 3,460 | 2,055 |
| `src/notifications` | 2,656 | 4,018 |
| **Six modules** | **20,091** | **25,913** |
| Plus `src/rules/tui` | +3,592 | +2,787 |
| **Seven** | **23,683** | **28,700** |

Plus 3,445 lines across the three named gate files (`rule-preview` 1,044, `dry-run` 873,
`automation-safety` 1,528), and **2,090** lines of ADR. Test-to-source ratio 1.21:1.

`src/rules` grew 21 lines between revisions 2 and 3: `compile.ts` 1,447 → 1,468, and all 21
are the cross-axis branch plus the reasoning for it. `compile.ts` is where **every one of the
five defects in this family has been repaired**; see §0.4.

Growth across the milestone: 3,201 passing tests at the M5 gate
(`Docs/implementation-reports/milestone-5-completion.md:754`) to 5,081 now — **1,880 net
new tests**.

**Correction to revision 2's table, which was wrong in a way that flattered the code:**
revision 2 listed `src/rules` tests as 9,588 and summed the seven modules to 27,601. The
measured figures are 9,686 and 28,700. The `src/rules` figure excluded `fixtures.ts` and
`preview.fixtures.ts` inconsistently between rows; the totals were therefore not comparable
across revisions. Not load-bearing for any verdict, and corrected rather than left.

---

## 3. The ten parts

Each with what was built, where, how many tests, and which plan criterion or guardrail it
carries.

### M6.1 — Rule language and evaluation ADR

`Docs/adr/0007-rule-language-and-evaluation.md`, **2,090 lines**, Accepted for Milestone 6
implementation, **amended three times**. A1–A8 (2026-10-01) reconcile the document with the
shipped code. A9–A13 (2026-10-02) are forced by the M6.10 findings and supersede one
decision in place rather than rewriting it. **A14 (`a73f2a3`, 2026-10-02)** states the
depth-transitive vacuity rule, adds §3.2 (new), marks §7.2 **superseded in part**, rewrites
§8.2.3 and §8.2.4, and moves the residual-risk bullet from live to closed.

**Revision 2 described this document at 1,959 lines and repeatedly described it as unamended
for the subtree fix. That was wrong — it was describing `c1d9f50`, not the diff under
review — and §8.1, §10's second reason and §10 item 3 were all written on that
misdescription.** I flagged the risk myself in revision 2's handoff and shipped the stale
text anyway. Corrected here; the substance of what A14 did is in §8.1.

The ADR fixes the module graph (§1), the separate language version (§2), one compiled
artifact (§3), the kernel projection's sound-under-approximation property (§3.1), **who
applies the four unprojectable restriction members and in what order (§3.2, new)**, bounded
patterns (§4), eighteen predicate fields (§6), six actions (§7), the "match all" restriction
(§8, §8.1, §8.2), twenty named limits (§9), precedence and conflict (§10), the disclosure
(§11), budgets (§13, §13.3), routing (§14), dry run (§16), notifications (§17), defaults
(§18), six stop conditions, and the residual risk of the 2026-10-02 amendment.

Carries Completion Criteria 2, 3, 5 and Guardrails 1–5.

**Code/ADR disagreements, re-derived against `a73f2a3` and `8714a9f`:**

- **Three of revision 2's five disagreement bullets are now closed by A14 and were closed
  before this revision began.** §8.2.3 (`:1052`) now states the depth-transitive rule.
  §8.2.4 (`:1100`) now says the test errs in **both** directions and says why the previous
  claim was false in the dangerous one. §7.2 (`:662`) is marked **SUPERSEDED IN PART** with
  a cross-reference to §3.2, and the false sentence is struck through rather than deleted.
  The residual-risk bullet (`:1752`) is now **CLOSED by A14** and — this is the correction
  revision 1 most needed — **names the roles axis, not the projects axis**, as the one that
  mattered, with the `classifyRule` reasoning attached. That is exactly the correction the
  A14 commit message says it made. **These are good amendments and they are the strongest
  piece of documentation work in the milestone.**
- **One is still open, and it is the one that matters: A14 now asserts the false control the
  F-1 fix disproved, in three places.**
  - `:1769-1776` — *"The second half is wrong and was not applied. Intersecting the axes of
    an `any`'s arms refuses `any(projectId eq "p", roleId eq "r")`, which genuinely excludes
    every dispatch whose project is not `p` and whose role is not `r`, and which the code's
    own tests pin as a CONTROL that must compile… Only the subtree half was needed, and it
    was sufficient."*
  - `:1944-1949` — the same claim as A14 amendment item 2, ending *"The subtree half alone
    was necessary and sufficient."*
  - `:1982-1984` — the same claim again in the closing paragraph.

  **All three are false at `8714a9f`.** `any(projectId eq "p", roleId eq "r")` is now
  **refused**, because it discloses a product and grants; the test that pinned it as a
  control now asserts the refusal; and the subtree half was necessary and **not** sufficient.
  Worse, the sentence *"on that question unioning arm axes is correct"* is the sentence that
  justified the grant, now written into the ADR as a correction. **A15 is required and this
  is the single documentation defect I would block on.** It is not cosmetic: A14 tells the
  next implementer that the disclosure question was considered and settled, when the
  disclosure was in fact never touched by any fix in this milestone.
- **§8.2.4's first bullet is true of the check and silent about the disclosure.** *"The test
  cannot credit scope the rule does not have."* True: `constrainingScopeAxes` does not.
  **The ADR nowhere states that `collectReach` and `constrainingScopeAxes` must agree**, and
  they do not (§0.2). §8.2.3's "contributes nothing" is a statement about the compiler only.
  **The gap between those two facts is F-3**, and the ADR is silent on it.
- **Every one of the ADR's `file:line` citations is unverified for this revision.** Revision
  2 declined the sweep and I decline it again (§11). Revision 2 also reported that several
  were stale mid-review and had been corrected concurrently. **The ADR has grown 131 lines
  since revision 2 read it, so its citation count is now larger and unknown.** A15 should
  re-run the sweep.
- One known-stale item, carried forward and re-checked: §8.1's table cited
  `src/rules/compile.ts:446-450` for the pass-placement rationale where the docblock text
  is; the actual `checkUnsatisfiable` body starts at `:452` and the caller is `:1153-1156`.
  Minor, and I did not re-verify it.

### M6.2 — Rules compiler and evaluator

`src/rules/{types,compile,evaluate,explain,limits,index}.ts`, **7,153 lines**. **791 unit
tests** in `tests/unit/rules`, of which 172 are the M6.8 TUI files; **619** are the language.

| File | Lines | Role |
| --- | --- | --- |
| `src/rules/evaluate.ts` | 2,009 | `evaluateRules` (`:1231`) is the sole evaluation entry point |
| `src/rules/preview.ts` | 1,470 | `previewCompiledRuleSet` (`:908`), calls `evaluateRules` at `:928` |
| `src/rules/compile.ts` | **1,468** | `compileRuleSet` (`:1297`) — the only producer of `CompiledRuleSet` |
| `src/rules/types.ts` | 1,368 | Zod source of truth; `ruleLanguageVersion = 2` (`:114`) |
| `src/rules/explain.ts` | 543 | `buildPreApprovalDisclosure` (`:399`), `collectReach` (`:314`), `axisOf` (`:369`) |

**Language surface, measured:** 18 predicate fields in `rulePredicateSchema`'s discriminated
union, 6 action kinds (`:785-792`), 20 exported limits (`limits.ts`), language version 2
with `rule.language_version_unsupported` as the refusal for any other.

**Compiler passes, in order** (`compileRule`): parse → canonical limits → per-rule limits →
bounded pattern compilation → `checkUnsatisfiable` (`:452`) → `checkNotUniversal` (`:773`) →
action sort → M0 projection. `checkNotUniversal` is a named compiler pass, not a
`.superRefine`, so the four restriction actions may still be universal.

**Carries Completion Criteria 2, 3, 5; Guardrails 1, 3; ADR Stop Conditions 1, 4, 5.**

Per-file test counts, measured individually for this revision: `compile` 114,
`truth-tables` 121, `evaluate` 70, `schema` 61, `invalid-inputs` 50, `preview` 47, `limits`
45, `explain` 34, `barrel` 25, **`vacuity` 21**, `kernel-restrictions` 16, `dedupe-membership`
13, `preview-divergence` 2, `tui-keyboard` 72, `tui-builder` 50, `tui` 36, `tui-barrel` 14 —
and `fixtures.ts` / `preview.fixtures.ts` carry none. `vacuity.test.ts` is **520 lines**.

### M6.3 — Preview and impact analysis

`src/rules/preview.ts`, 1,470 lines; **47 tests** in `preview.test.ts` plus **2** in
`preview-divergence.test.ts` and **21** in `tests/integration/rule-preview.test.ts`.

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
`schema` 65, `instantiate` 61, `repository` 44, `parameters` 39, `barrel` 29, `immutability`
19.

`InMemoryRunTemplateRepository` deep-freezes on write (`repository.ts:308`) and returns a
fresh `structuredClone` on every read. `instantiateTemplate` (`:461`) produces a snapshot with
its own digest. `immutability.test.ts` asserts the digest is unchanged after edits, still
verifies after edits, does not drift across ten successive edits, shares no object at any
depth, and still verifies after every mutation attempt. Cross-project instantiation is refused
in `src/simulation/expand.ts:252-259` — **not** in `instantiateTemplate`, which has no
`projectId` parameter at all. **A caller invoking `instantiateTemplate` directly would get no
scope check.** Named because the plan's criterion is about immutability, and the scope check
living in a caller is a fact the next caller needs.

**Carries Completion Criterion 6.**

### M6.5 — Budgets and admission control

`src/budgets/{types,compose,ledger,recovery,index}.ts`, 3,345 lines. **193 unit tests**:
`compose` 46, `recovery` 41, `reservation` 35, `ledger` 33, `adversarial` 20, `barrel` 18.

Eligibility is *defined* as holding a `held` reservation (ADR §13.2), and `reserve` is a
single compare-and-set inside one store transaction, so there is no check-then-act window.
`recoverLeaked` (`recovery.ts:320`) is the crash sweep; `replayDurableReservations` (`:629`) is
the rebuild, and it is a **second admission decision** that classifies rather than totals
(§13.3, and MED-5 in §7).

**Carries Completion Criterion 7; Guardrail 4; ADR Stop Condition 3.**

### M6.6 — Routing preferences

`src/routing/{types,rank,snapshot,index}.ts`, 1,376 lines. **108 unit tests**: `eligibility`
24, `ranking` 23, `determinism` 16, `explanation` 16, `snapshot` 15, `barrel` 14.

Three ordered stages (ADR §14): hard eligibility, then deterministic preference, then lowest
`nodeId` by UTF-16 code unit. `localeCompare` appears nowhere in the module and the reason is
recorded at `rank.ts:68` and `types.ts:65-66`. Every exclusion carries a reason. A
`select_routing_preference` can only reorder the eligible set; it cannot introduce a node.

**Carries Completion Criterion 9.**

### M6.7 — Dry-run simulator

`src/simulation/{types,plan,expand,sinks,index}.ts`, 3,460 lines. **113 unit tests** (`plan`
42, `no-side-effects` 20, `sinks` 17, `expand` 13, `barrel` 11, `determinism` 10) plus **23**
in `tests/integration/dry-run.test.ts`.

`simulateDryRun` (`plan.ts:306`) composes the same `evaluateRules`, `rankNodes`,
`composeBudgets` and `instantiateTemplate` production uses, and replaces every command sink
with a fail-closed fake whose only implementation throws. The budget sink is the exception and
the exception is argued: the gate is *entered* and the ledger's own compare-and-set runs,
because a dry run that refused to enter would report no saturation for any dispatch. It cannot
reserve, because it holds no map — `read` and `heldUnitsFor` return `null`/`0` unconditionally.

**Limitation, asserted rather than hidden:** a dry run cannot simulate budget saturation,
because the probe retains nothing. `dry-run.test.ts:823-838` states this and asserts
`plan.rejected === []` and `everyDispatchRequiresApproval` for a ceiling of 1 over two
dispatches. A live-snapshot capacity value would have to arrive on the request (ADR §16 S3).

**Carries Completion Criterion 8.**

### M6.8 — Pure rules TUI

`src/rules/tui/{types,state,builder,view-model,index}.ts`, 3,592 lines. **172 unit tests**:
`tui-keyboard` 72, `tui-builder` 50, `tui.test` 36, `tui-barrel` 14.

`reduceRuleTui` (`state.ts:175`), `routeRuleTuiKey` (`:582`), `buildRuleTuiView`
(`view-model.ts:308`). `src/rules/tui/index.ts:19-61` names the three attachment points in
`src/tui/shell.ts` that an integrator must make.

**This layer is implemented, tested and is not attached to anything.** `grep -c rules
src/tui/shell.ts` is `0`. `grep -rn "rules/tui" src/` outside `src/rules/tui/` returns
nothing. `RuleTuiSimulationReport` and `RuleTuiTemplateCapture` (`types.ts:297,328`) are
declared ports with **no producer**. A user cannot reach any of this.

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

**It states that no file under `src/` or `tests/` was touched, and that no failing test was
committed — HIGH-1, MED-2, MED-3, MED-4 and MED-5 were all *assertions the milestone
currently failed*.** That was the right call at the time; it also meant that for two of five
findings the suite could not see the fix either way. **And it means the security review
never covered the disclosure path** — which is where HIGH-1′/NEW-2, F-1, F-2 and F-3 all
live. The independent reviewer reached the same conclusion independently (§7 of its report)
and I record it as a finding about the milestone's verification method, not about the
reviewer: **the milestone's two HIGH findings before this revision were both in the
disclosure/vacuity pair, and neither was found by reviewing the disclosure.**

**Carries Completion Criterion 11 — not met. See §4 and §10.**

---

## 4. Security findings and dispositions

One table. Severity is the reviewer's, corrected where the review or a later measurement
corrected it.

| # | Finding | Original | Now | Status | Fix | Proven by |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | HIGH-1 — vacuous pre-approval, nine named shapes | HIGH | HIGH | **fixed** | `src/rules/compile.ts:569-600` (`CONSTRUCTIVE_FORMS`), `:615-651` (`excludesDispatch`), `:684+` (`constrainingScopeAxes`) | `tests/unit/rules/vacuity.test.ts` |
| 2 | HIGH-1′ — `any(A, not A)` tautology | HIGH (new in review §0) | HIGH | **fixed, then re-broken and re-closed** | first `compile.ts:697-698` (**pre-fix numbering**); after the subtree fix, `compile.ts:729` — an `any` branch containing a `not` **anywhere in its subtree** contributes nothing | `vacuity.test.ts`. See §0A.1, §0A.2: the first version read only the direct arms and is what NEW-2 was |
| 3 | HIGH-1″ — `taskLabel hasAll []` | HIGH (new in review §0) | HIGH | **fixed** | `compile.ts:463-472` — `taskLabel` added to the `rule.empty_enum` branch, `has` excluded | `vacuity.test.ts` |
| 4 | MED-2 — `capability all` with a duplicate | MED | **HIGH** | **fixed** | `src/rules/evaluate.ts:470-484` — `present`/`missing` built over the **deduped** `declared` set; `all` tests `missing.length === 0` | `tests/unit/rules/dedupe-membership.test.ts` (13) |
| 5 | MED-3 — four restriction members never applied | MED | MED | **fixed, after two further breakages** | `evaluate.ts:1895` (destructure out), `:1930-1950` (narrow), `:1975-1979` (digest base) | `kernel-restrictions.test.ts` (16) |
| 6 | MED-3′ — a pre-approval suppressed a rule's dispatch demand | MED (latent) | MED | **fixed** | `evaluate.ts:1947` — the test is whether a layer other than `safety_floor` demanded it | `kernel-restrictions.test.ts:366-483` |
| 7 | MED-4 — store handed adapters the live envelope | MED | MED | **fixed** | `store.ts:451` (clone+freeze on write), `bus.ts:284` (fresh deep-frozen clone per adapter, inside `deliverOne`'s `try`) | `isolation.test.ts` "N14" |
| 8 | MED-5 — replay over-admission | MED | MED | **fixed** | `src/budgets/recovery.ts:629-797` — classify each occupying row, install refused rows as `expired` | `recovery.test.ts`, `adversarial.test.ts:464` |
| 9 | MED-5b — `releasedUnits` on `held → committed` | LOW | LOW | **fixed** | `src/budgets/ledger.ts:463` — `occupiesCapacity(current) && !occupiesCapacity(next)` | review G3 |
| 10 | MED-5c — a store that reports success and moves nothing | MED | MED | **fixed** | `recovery.ts:383-429` — R18 reads the ledger back into `RecoveryReport.unverified` (`types.ts:751`) | review G4 |
| 11 | LOW-6 — `eligible()` ignores `leaseExpiresAt` | LOW | LOW | accepted, documented | `ledger.ts` — L1 stated as a definition | — |
| 12 | LOW-7 — two `pre_approve` actions in one rule | LOW | LOW | accepted, unreported | `compile.ts:1018-1019` takes `preApprovalActions[0]` | — |
| 13 | LOW-8 — `.strict()` accepts own `__proto__` | LOW | LOW | accepted, upstream | Zod 4.4.3 behaviour | — |
| 14 | LOW-9 — no production caller | LOW | LOW | **STILL OPEN** | none — §5 | source scan, §5 |
| 15 | NEW-1 — `ReplayRequest.now` required, typed, unread | LOW | LOW | recorded, not fixed | `recovery.ts:634` `void request.now` | review G5 |
| 16 | NEW-2 — vacuity test is not depth-transitive | — | **HIGH** | **fixed** | `compile.ts:678-682` (`subtreeContainsNegation`), called at `:729` | `vacuity.test.ts`; red/green §0A.1 |
| 17 | **F-1 — a cross-axis disjunction discloses a product and grants** | — (independent review) | **HIGH** | **fixed** | `compile.ts:761-764` — a disjunction is usable as a scope only when all arms constrain the **same** axis; cross-axis contributes nothing | `vacuity.test.ts` (the two direction-changed/added tests); my red/green §1.1; my sweep 56→0 |
| 18 | **F-2 — a tautological arm under an `all` reports a dead axis as constrained** | LOW (independent review) | **HIGH** | **OPEN — this is F-3** | none | my probe §0.2: 24 of 42 pairs grant |
| 19 | LOW-9′ / new — the disclosure is `unknown`-silent on four scope axes | — | LOW | recorded, not fixed | `explain.ts:314-323` collects only five axes; `toolCategory`, `runtimeKind`, `nodeAdvertisedCapability` have no slot | §0.2 breadth note |
| 20 | **F-3 — a tautological conjunct is reported as a real bound** | — (mine, this revision) | **HIGH** | **OPEN** | none | `/tmp/m6-lead/f3sweep.ts`: 42/42 compile, 24 grant |
| — | **F-3a — `collectReach` and `constrainingScopeAxes` are unsynchronised by construction** | — | **design risk** | **OPEN** | none | rows 2, 16, 17, 20 are all instances |

**Eleven bypass-class defects** — rows 1, 2, 3, 4, 5, 6, 7, 8, 16, 17 and 20 — **of which ten
are fixed and one (F-3) is open.** **Five of them are disagreements between two functions
that walk the same tree** (rows 2, 16, 17, 20, and row 3's cousin `taskLabel`), and
`constrainingScopeAxes` has now been repaired **five** times inside one milestone (rows 1,
2, 16, 17, 20). **That is a finding about the function, not about five coincidences.**

**What the independent reviewer confirmed, and I adopt without hedging:** all six originally
claimed fixes are load-bearing (red/green re-measured for **all six**, not four); MED-3's
recomposition is resistant to attack; the 16/3 red-green figure is right and the 11/8 figure I
was handed is wrong; the two direction-changed tests were honestly argued and the assertions
were not loosened; every number in revision 2's §1–§2 is correct; and **the reachability
claim is true and verified.** It also found one nuance I had omitted: for MED-2, the `all`
**comparison** was the load-bearing half, not the filter — both are right now.

---

## 5. Reachability — still the most important paragraph in this report

**Nothing outside `src/simulation/` and `src/rules/tui/` imports any M6 module, and
`src/rules/tui/` is itself imported by nobody.** Re-derived for this revision, and
**independently re-derived and confirmed by the independent reviewer**, which is the
strongest corroboration any claim in this report has:

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

`tests/unit/rules/barrel.test.ts` asserts the same shape from the other direction —
`src/simulation/` is the one *sanctioned* consumer, named in a `PERMITTED_CONSUMERS` list so
that adding a second one is a decision rather than a byproduct.

**The consequence, stated without hedging:** `POST /approve` → `start` reads
`ruleSnapshots: []`. No M6 rule is compiled, evaluated, previewed, or enforced anywhere on the
shipped dispatch path. Every one of the eleven Completion Criteria that concerns
pre-approval, disclosure, budgets, routing, or notifications is therefore **vacuously held on
the shipped path** — the same structural finding as M5's isolation audit S-1, and the second
milestone in a row to produce it.

**The M6 guarantee is not held on the shipped approval path. A reader must not come away from
this report thinking it is.** The library is correct to the extent measured in §7 — and F-3
means it is not correct on the disclosure path at all. The wiring does not exist.

**What it would take to change that,** in order:

1. **Fix F-3 first.** Not because it is live — nothing calls the library — but because it is
   the reason not to wire the seam, and wiring it now would put a grant-class defect on the
   operator's approval path.
2. A real rule store behind the seam: `ProfileLocalProjectRegistry` currently has no rules to
   return, and `ruleSnapshots: []` is not a placeholder, it is the whole value.
3. A composition caller that threads `evaluateRules` → `evaluateWithKernel` and passes
   `ruleRestrictions`, so MED-3's four members are actually applied. `simulation/plan.ts`
   already does this and can be read as the reference.
4. Inverting the M5/M6 isolation assertion. `tests/unit/rules/barrel.test.ts` currently
   *fails* if a non-simulation module imports `src/rules`. Whoever wires the seam must add
   that module to `PERMITTED_CONSUMERS` **and** amend ADR §1, and should invert the test as
   the review's residual-risk note recommends: assert that the first non-simulation caller of
   `src/rules` is one that also applies `narrowWithRuleRestrictions`.
5. Deciding who resolves `ceilings` for replay, and what a wrong answer costs (§8.2).

**Revision 2 listed "fix NEW-2" as item 5 and marked it DONE. This revision withdraws that
discharge.** The vacuity constraint was not satisfied; a different member of the family is
open. Correct-and-unreached and broken-and-unreached reach the operator identically: nothing.
**§5's conclusion is untouched by any fix in this milestone, and I state that plainly so a
green suite is not read as progress on reachability.**

---

## 6. The plan's Completion Criteria

The plan lists eleven. Verdict, then the test that carries it. **Every row that changed
between revision 2 and revision 3 is marked.**

| # | Criterion | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Default installations still require approval for every dispatch | **MET in the library, vacuous in production** | `tests/unit/simulation/plan.test.ts:78`; `tests/integration/automation-safety.test.ts:211`; `compileRuleSet([])` yields `rules: []` with a real digest (`automation-safety.test.ts:1515`). My canonical simulation: `everyDispatchRequiresApproval: true`, both dispatches `outstanding: ["dispatch_approval"]`. No production caller (§5). |
| 2 | User rules are versioned, deterministic, bounded, explainable, and cannot execute code | **MET** | Version 2 with `rule.language_version_unsupported` (`types.ts:114-116`). Determinism: `evaluate.test.ts:184`, and my two-run digest match. Limits: `limits.test.ts`, 45 tests over 15 describes, one per ADR §9 row. No execution: `invalid-inputs.test.ts:552`; `barrel.test.ts` scans `src/rules/**` for `eval`, `require`, `Date.now`, `new Date()`, `Math.random`, `node:fs`, `node:child_process`. Explainable: seven distinct non-match outcomes (`types.ts:1155-1164`) plus `matched`. |
| 3 | Preview and runtime use the identical compiled rule representation | **MET** | Structural: one `compileRuleSet` (`:1297`), one `CompiledRuleSet`, one `evaluateRules` (`:1231`), and `preview.ts:928` calls it with no matching branch of its own. `preview-divergence.test.ts`; `rule-preview.test.ts` test 1 compares against a hand-built context, not a shared helper. |
| 4 | Pre-approval is restricted to the exact displayed bounds | **NOT MET** — *re-derived; was MET in the library in revision 2, and NOT MET in revision 1* | The **bound** half is met and always was: `allowDestructiveEffects`/`allowExternalEffects` are `z.literal(false)`, the timeout is capped at the floor's 3600, and the disclosure is asserted item by item (`preview.test.ts:403`). The **display** half is violated, by F-3 on the current tree: `all([any(roleId eq "role-1", not roleId eq "role-1")], targetNodeId eq "node-1")` compiles, discloses `reach.roles = ["role-1"]`, and returns kernel `allow / outstandingApprovals: []` for `role-9` — measured, with the control returning `require_approval` (§0.2). **Revision 2 moved this row MET → "MET in the library" on the strength of a fix that closed one family of the defect the criterion is about. I am moving it back, and the reason is not that the tree regressed — it is that the criterion is about the pair, and the pair is still broken.** |
| 5 | Safety-floor and role restrictions cannot be weakened | **MET** | Review §2 block 1, claims 1.1–1.11, all pass: escalation fields refused by the **parser** as `z.literal(false)` violations, not by a handler; `SAFETY_FLOOR` deep-frozen; `narrowPolicyState` records widening attempts rather than applying them. `evaluate.test.ts:692` "the KERNEL decides". `kernel-restrictions.test.ts:326` — the composition cannot widen. **Unchanged, and the reason it is unchanged while #4 is not is worth stating: this criterion is about not granting a capability the floor removed, and F-3 does not do that — it skips an *approval*. The same distinction misled revision 2 on #4, so I am naming it rather than relying on it silently.** |
| 6 | Run/role template edits do not mutate instantiated snapshots | **MET** | `tests/unit/workflows/immutability.test.ts`, 3 describes / 19 tests: digest unchanged after edit, still verifiable, no drift across ten edits, no shared object at any depth, frozen at every level, still verifies after every mutation attempt. |
| 7 | Fan-out, concurrency, retry, and wall-time budgets survive restart and replay | **PARTIALLY MET** | Replay of a durable **log** into a fresh ledger is tested and classifies rather than totals (`recovery.test.ts:825`, `adversarial.test.ts:464`). **No process restart is exercised, because there is no durable store to restart from** — `ledger.ts:120-138` records this. Every atomicity result is a property of `InMemoryBudgetLedgerStore`. **Confirmed independently by the reviewer, which reached the same verdict and the same reasoning.** |
| 8 | Dry run produces no persistent or external side effect | **MET** | `no-side-effects.test.ts:196`, `sinks.test.ts`, and `dry-run.test.ts` tests 1–3 counting **at** the sinks: 0 event appends, 0 network calls, 0 process launches, 0 filesystem writes, 0 notifications, 0 retained reservations — with `budgetReservationAttempts === plan.dispatches.length` proving the one sink that must be entered was. All 16 throwing sink methods are individually called and required to throw, so the zeros are not unfalsifiable. |
| 9 | Routing is deterministic for the same registry snapshot and excludes unauthorized/unhealthy nodes | **MET** | `determinism.test.ts:79,201,240` — byte-identical answer, code-unit comparator, frozen result; `eligibility.test.ts:53,193` — every exclusion carries a reason; review §2 block 10 including determinism over 50 permutations. Not tested: cross-machine (ADR §6.2 tzdata is version-dependent; one machine here). |
| 10 | Notifications are deduplicated and contain no secret prompt/context content | **MET** | `dedupe.test.ts:61,110,159` — by key never by content, exact window boundary, invisible to the producer; `no-secrets.test.ts` — 49 tests, canaries in every field, the schema refuses what the audit would find, and the audit reports a path and a kind but never the content. |
| 11 | Security review finds no approval, mutation, or budget bypass | **NOT MET** — unchanged in verdict, different in content | **The review and this report together have now found eleven bypass-class defects.** Five are fixed from the review's own findings; six more came from re-derivation after it; **one (F-3) is open.** The criterion still says NOT MET, and it is worth being precise about why, because the reason is not only a code defect: the review and this report between them found eleven bypasses, the review said up front that it touched no file under `src/` or `tests/`, and **ten of the eleven are fixed by someone else.** A criterion reading *"finds no bypass"* is satisfied by a clean review, not by eleven findings plus ten fixes and one open. What it should read is closer to *"every bypass the review found is fixed and independently re-verified"* — **which is not true today**, where it was true on the morning of `a73f2a3` and false again at `8714a9f`. **I am not going to reinterpret a criterion to make a milestone sign, so it stays NOT MET, and this is the one criterion I would most want rewritten before M7.** |

**Eight of eleven met inside the library, one partially, two not met — and eight of those
eight are vacuous on the shipped path (§5).**

**Changed in revision 3:** **#4 moved MET → NOT MET** (F-3 open; §0.2). #11 stays **NOT MET**,
and the count behind it moved from six to eleven with one now open. **#5 stays MET and I
explain why that is not an inconsistency with #4.** Nothing else moved.

---

## 7. The findings that changed severity, or were worse than first reported

*This section is unchanged from revision 2 in substance, because the independent reviewer
confirmed every item in it. It is retained because it is the part of the report the reviewer
verified rather than disputed, and a reader deciding what to trust needs to know which is
which.*

### 7.1 HIGH-1, vacuous pre-approval — the first fix was itself defective, twice

The original finding was that `checkNotUniversal` asked whether a scope field was **mentioned**
rather than whether a predicate **constrains** anything, so seven vacuous shapes compiled and
cleared the floor. The first fix replaced presence with a per-axis `CONSTRUCTIVE_FORMS` table
plus bound inspection on the two range axes, which closed all nine.

**That fix was not sufficient, and it failed in the direction that costs most.**
`constrainingScopeAxes` counted any constructive descendant under an `any` while skipping
every `not` node it met, so `any(A, not A)` counted `A` as constraining and the disclosure
affirmatively reported `reach.projects = ["proj-1"]` **citing the very atom whose negation was
its sibling**. Separately, `taskLabel hasAll []` compiled because the empty-enum guard omitted
`taskLabel`, and `hasAll []` is vacuously satisfied.

Both are refused. **The third and fourth rounds are NEW-2 (`:678-682`) and F-1
(`:761-764`), and both were found by other parties, not by re-reading this section.** §0.1,
§0.2, §0A.1.

**The rule the family installs is not complement reasoning and does not need to be:** *a
disjunction whose arms cannot be rendered as the per-axis reachable set the §11 disclosure is
required to produce contributes nothing.* That single sentence now covers the negation case
and the cross-axis case, and **it does not cover the F-3 case**, because there the compiler
was already right and the disclosure was not.

### 7.2 MED-2, `capability all` with a duplicate — recorded as a disclosure mismatch, was fail-open

Recorded as a disclosure mismatch: the disclosure de-duplicates (`explain.ts:375`) and the
normalized predicate does not, so the reach displayed was narrower than the reach enforced.
True, and the smaller half.

`evaluateSetPredicate` built `present` by filtering the **raw array** and compared
`present.length` to a **deduped `Set` size`. A duplicate therefore counted a member twice and
the `all` comparison inverted. Measured before the fix:

```
capability all ["fs.read","net.fetch","fs.read"]
  request ["fs.read"]             -> matched        (intended: not_matched)
  request ["fs.read","net.fetch"] -> not_matched    (intended: matched)
```

A pre-approval written for "requests that need both `fs.read` and `net.fetch`" was **granted**
to a request needing only `fs.read`, and **refused** the request it was written for.
**Reclassified MEDIUM → HIGH.**

Fixed at `evaluate.ts:470-484`. **The reviewer's addition, which I had omitted:** the `all`
**comparison** was the load-bearing half, not the filter — it first reverted the filter alone,
left the correct comparison in place, and the suite stayed green. Both are right now. That is
also a small, concrete instance of §0.4's second mechanism.

### 7.3 MED-3, `evaluateWithKernel` never applied the restrictions — found broken twice more

`requireApprovalForDispatch` and `requireApprovalForCapabilities` have **no field in the frozen
M0 `restrict` effect**. They travel in `RuleEvaluationResult.restrictions`.
`evaluateWithKernel` — the module's only composition entry point — **exported
`narrowWithRuleRestrictions` and never called it.** A rule that says "require approval for
`net.fetch`" appeared to work and did nothing, which is worse than refusing the action.

**Three stages, all measured:**

| Stage | State | Measured |
| --- | --- | --- |
| 0 | adapter exported, never called | `restrictions.allowedCapabilities: ["fs.read"]`, `unprojected: ["allowedCapabilities"]`, kernel effective `["fs.read","net.fetch"]`. A rule weaker than it reads. |
| 1 | first fix spread the M6-only `ruleRestrictions` key into the kernel's `.strict()` three-key input | **every call returned `Err`** — `rule.evaluation_failed: Unrecognized key: "ruleRestrictions"`. The narrowing was unreachable. |
| 2 | second fix set `decisionDigest: undefined` in the digest base | **every call threw** — `digestJson` refuses to canonicalize `undefined`. The narrowing was still unreachable, one line further down. |
| 3 | current | `requireApprovalForCapabilities: ["net.fetch"]` → `outstandingApprovals: ["capability:net.fetch","dispatch_approval"]`. `add_restrictions.allowedCapabilities: ["fs.read"]` → effective `["fs.read"]`. A call with no `ruleRestrictions` → `require_approval / ["dispatch_approval"]`. |

**The lesson, and it is the most transferable thing in this milestone:**

> **A safety feature that cannot execute looks exactly like a safety feature that works, and a
> green suite proves nothing about it.**

At stages 1 and 2 the suite was green — 5,000-plus passing tests — because
`grep -rn ruleRestrictions tests/` returned **zero hits**. The parameter was documented as
required and no test supplied it. **The independent reviewer re-measured both stages
independently, got 15 failures each in the targeted file and 21 across the directory, and
confirmed this is the strongest evidence in the milestone.** It also attacked the recomposition
directly — trying to make a crafted `restrictions` value manufacture an `allow` the kernel did
not grant — and **could not**, because the recomposition narrows through the kernel's own
`narrowPolicyState` and `decision` is derived from `denials.length` and `outstanding.length`
rather than asserted. One asymmetry it found and I record: the recomposition does not recompute
`denials` from the *narrowed* `allowedCapabilities`, so a case that would be
`policy.capability_not_allowed → deny` returns `require_approval`. **That fails toward more
human scrutiny, never toward `allow`**, and `effective.allowedCapabilities` still carries the
truth. Worth a comment, not a change; it is in §8.7.

### 7.4 MED-4, the store handed adapters the live envelope

`publish` deliberately stored the **original object** rather than Zod's copy, and the same
object went to every adapter, unfrozen. An adapter could rewrite `summary`, `runId`,
`taskId`, `dispatchId`, `nodeId`, `ruleId`, `reasonCode`, `category`, `severity` and
`createdAt` in the operator's inbox. Rewriting `dedupeKey` also desynchronised the dedupe index
from the entries.

Fixed on **write**, which is the correct side of the boundary: `publish` stores
`deepFreezeNotificationValue(structuredClone(envelope))` (`store.ts:451`), because `list()` runs
per TUI keystroke and a clone-on-read is the copy that costs. `deliverOne` (`bus.ts:284`) gives
each adapter a **fresh** deep-frozen clone, inside its own `try` so a clone failure cannot
abort the fan-out. **Reverting both lines turns `tests/unit/notifications` 4 red**, per the
reviewer.

**What the fix does not close:** prototype pollution — §8.3.

### 7.5 MED-5, budget replay over-admission — recorded as over-admission, was a wedge

`InMemoryBudgetLedgerStore.restore` is a public method on an exported class and
`replayDurableReservations` called it with no ceiling check at all.

**The recorded impact was wrong in a way that inverted the fix.** Five `held` rows against a
ceiling of one replayed to `held: 5`, `eligible: true` for all five. Reported as
over-admission. It is not: the budget is not bypassed. `reserveInTransaction` computes
`5 + 1 > 1` and refuses, **and refuses every future reserve too**. The budget has stopped being
a budget, at the worst possible moment — a **wedge**, an availability failure wearing a safety
costume, and a fix that simply refused harder would have been the wrong fix.

The fix is a second admission decision. Each **occupying** row gets exactly one named verdict,
checked `duplicate_dispatch` → `ceiling_undeclared` → `over_ceiling`. A rejected row is
installed as **`expired`**, never `released`: `released` asserts a terminal *dispatch state*,
which is a fact replay has no evidence for. **Re-measured at the gate:**

```
five held rows, ceiling 1        -> held=1  rejected=4  reasons=[over_ceiling]
three held rows, ceiling: null   -> held=0  rejected=3  reasons=[ceiling_undeclared]
```

Two properties make it safe rather than merely reasonable: **refusal is never total**
(`restored.length + collapsedRecords === recordCount`) and **refusal returns capacity**
(`expired` is non-occupying). A malformed ceiling throws a `RangeError` naming the scope. The
reviewer independently re-measured all of this and confirmed both sub-defects.

**Two further defects surfaced while fixing it, both the same species as MED-3:**

1. **The ledger's maintained `releasedUnits` index under-released on `held → committed`.**
   Both states occupy capacity, so a commit is a move *within* the occupying set. **Admission
   was never affected** — `reserveInTransaction` recomputes from the reservation *list* — so
   what was wrong was the number a caller reads to render "3 of 5 held". Fixed at
   `src/budgets/ledger.ts:463`.
2. **A store that reports success while moving nothing defeated every recovery check**,
   because every one of them trusted return values. Fixed by R18: the sweep **reads the ledger
   back** into `RecoveryReport.unverified` (`recovery.ts:383-429`, field at `types.ts:751`).

---

## 8. Residual risk, honestly

### 8.1 The vacuity check is a per-atom syntactic test, not a satisfiability solver — and the family is NOT closed

The check decides whether a rule *contains a claim that can exclude*, never whether the rule as
a whole is satisfiable or whether its clauses contradict one another. **That limit is
permanent and I still hold it.**

**Revision 2's claim that "the family is closed at every depth the language admits" was
about the negation family and was silently generalised to the vacuity family as a whole. It is
false of the family.** Three distinct shapes have now been found in it after the same function
was declared sound: the nested negation (NEW-2), the cross-axis disjunction (F-1), and the
tautological conjunct under a conjunction (F-3). All three are measured in §0.

**What is closed, measured on `8714a9f`:**

```
REFUSED   any(A, not A)                DEPTH1  rule.universal_pre_approval
REFUSED   any(R, any(A, not A))        DEPTH2  rule.universal_pre_approval
REFUSED   any(R, any(any(A, not A)))   DEPTH3  rule.universal_pre_approval
REFUSED   any(all(A&B), all(A&not B))           sound, over-refused
REFUSED   any(roleId r, targetNodeId n)         cross-axis  (F-1)
REFUSED   any(projectId p, roleId r)            cross-axis  (F-1; was the pinned CONTROL)
COMPILES  all(any(r, not r), node n)            *** F-3 — and it GRANTS ***

COMPILES  CONTROL any(projectId p, projectId q)   same-axis union, discloses truthfully
COMPILES  CONTROL any(roleId r, roleId r2)        same-axis union, discloses truthfully
COMPILES  CONTROL all(R, not P) beside a real sibling
COMPILES  all(R, any(A, not A)) — the compiler is RIGHT here; the DISCLOSURE is wrong (§0.2)
```

**The last two rows of that table are the whole problem, and they sit next to each other.**
The compiler treats a tautological conjunct correctly and the pinned control at
`vacuity.test.ts:187` says so; the disclosure does not, and the disclosure is what ADR
Stop Condition 5 constrains. **Revision 2 read the compiler's half of that pair and generalised
it to the pair.** I made that mistake once already on F-1 and I am not making it twice.

**The class the refusal now costs.** `any(A∧B, A∧¬B)` is satisfiability-equivalent to `A`: its
true reach is exactly the set the disclosure would report, so refusing it is a pure cost with
no safety return. **The independent reviewer does not accept that this trade is forced by the
absence of a solver**, and its argument is one I had not made: distinguishing
`any(all(A,B), all(A,¬B))` from `any(R, any(A,¬A))` needs no solver, only the observation
that in the first shape **every** arm is a conjunction *containing* `A` positively, so every
arm is bounded by `A`, while in the second an arm is unbounded. **That is a disagreement about
method, not a defect**, and the reviewer says so explicitly: the over-refusal is fail-closed,
documented, costs an author a rewrite, and is defensible. I record the disagreement rather than
relying on the "no vocabulary for satisfiability" framing, because the framing is not
established.

**What is still outstanding, and it is a documentation defect: ADR 0007 needs an A15.** The ADR
is 2,090 lines and its A14 amendment now asserts the **false** control the F-1 fix disproved,
in three places — `:1769-1776`, `:1944-1949`, `:1982-1984` — including the sentence *"The
subtree half alone was necessary and sufficient"* and the sentence *"on that question unioning
arm axes is correct."* **Those are the sentences that justified the grant.** An ADR that tells
the next implementer the disclosure question was considered and settled, when no fix in this
milestone touched the disclosure, is the same failure mode the document exists to prevent.

**And an A15 must also state the invariant that would have caught all four:** *for every
compiled pre-approval, the reach the §11 disclosure renders must contain the set the rule
actually matches.* Nothing in the tree asserts it. §0.4 says what that costs.

### 8.2 `collectReach` and `constrainingScopeAxes` are unsynchronised by construction

**This is the design risk, and I am promoting it from a bullet to a section because it is the
one residual with a measured body of evidence behind it.**

Two functions walk the same predicate tree. They share no notion of which nodes are
meaningful. They each implement "a `not` contributes nothing" separately
(`explain.ts:353` and `compile.ts:767`). Every disagreement between them is a disclosure defect,
and **no test asserts that they agree on anything.**

| Disagreement | Effect | Status |
| --- | --- | --- |
| `constrainingScopeAxes` skips a `not`'s subtree; `collectReach` skips the `not` node but recurses into `any`/`all` unconditionally | a tautological arm's positive atom is cited as a source | **F-3, OPEN** |
| the check treats a cross-axis `any` as unscopable; the disclosure renders it as a product | union reported as and | closed by refusing the case (F-1) |
| the check treats a negation-bearing branch as unscopable; the disclosure renders the whole tree | dead branch reported as live | closed by refusing the branch (NEW-2) |

**Two of three are closed by changing the *check* and leaving the *disclosure* alone. The one
that is still open is the one where the check was already right.** That is the pattern, and it
is the argument for fixing `collectReach` rather than continuing to add refusals: a refusal
closes the shape you thought of, and leaves the next disagreement with the same cause.

### 8.3 Replay's ceiling check is only as good as the `ceilings` its caller resolves

`replayDurableReservations(target, records, { now, ceilings })` guarantees `held <= ceiling`
**relative to the ceilings it was given**. Replay cannot re-derive the budget in force at crash
time, and a caller that resolves `ceiling: null` for a scope that in fact had a maximum is not
second-guessed. The refusal to guess is loud where it can be — a non-integer, negative, `NaN`
or `Infinity` ceiling throws a `RangeError` naming the scope — and the trust boundary is named.
There is no caller, so today the guarantee is untested against a wrong one.

### 8.4 Prototype pollution is not closed in the notification store

Freezing blocks a write to the envelope. `Object.prototype.x = "y"` from inside an adapter still
lands. **Inherent to running attacker code in-process, unreachable from a notification payload,
and not fixable by freezing.** Recorded so nobody later reads the freeze as closing it. The
reviewer confirmed the same four-way probe: a frozen envelope write throws,
`defineProperty` throws, `setPrototypeOf` throws, and `Object.prototype` pollution lands.

### 8.5 `ReplayRequest.now` is required, typed, and deliberately unread

`recovery.ts:634` is `void request.now`. The argument (ADR R16, "replay never restamps and
never invents") is correct. But a required, documented, permanently-unread parameter is a trap
for the next caller and will be used to smuggle clock-dependent behaviour in. A14 now names it
as a residual for the M7 author, which is the right handling. **Not fixed.**

### 8.6 The M6.8 TUI layer is implemented, tested, and attached to nothing

`src/rules/tui/` is 3,592 lines and 172 tests with **zero importers**. `src/tui/shell.ts` names
`rules` zero times. Two of its ports have no producer anywhere in `src/`. The integration
points are documented (`index.ts:19-61`) and nothing has used them. **A user cannot reach the
rules experience this milestone claims to deliver.**

### 8.7 Everything is in memory

`InMemoryBudgetLedgerStore`, `InMemoryNotificationStore`, `InMemoryRunTemplateRepository`,
`CompiledRuleSet` held and recompiled on change. Each is a recorded deferral with the seam
named (`BudgetLedgerStore`, `reserveInTransaction(draft, decide)` for `BEGIN IMMEDIATE`), and
each is why Criterion 7 is only partially met.

### 8.8 Not tested, and named

- **`collectReach` / `constrainingScopeAxes` agreement.** §8.2. The single highest-value
  missing test in the milestone.
- **Cross-machine routing determinism.** Determinism is verified in-process over 50
  permutations. `Intl.DateTimeFormat` for a schedule window is host-tzdata-dependent; ADR §6.2
  records the zone as written and the computed instant. One machine here, for both me and the
  reviewer.
- **A durable `BudgetLedgerStore`.** Every atomicity result is a property of the in-memory
  store, and no restart path for budget state is shipped.
- **A notification adapter that reaches the network.** The claim that an external adapter cannot
  mutate orchestration state rests on the import graph, not on a test — and MED-4 is the
  reminder that the graph is not the only surface.
- **`allowedCapabilities` narrowing does not recompute `denials`.** Fail-closed (§7.3), but an
  asymmetry between `require_approval` and `deny` that a caller reading `decision` will not
  predict.
- **Four scope axes have no slot in the disclosure.** `collectReach` collects projects, roles,
  capabilities, nodes and projectPaths (ADR §11 requires exactly those five, so this is
  conformant). A rule scoped by `toolCategory`, `runtimeKind`, `nodeAdvertisedCapability` or
  `taskLabel` therefore discloses `unknown` on all five axes. **That is the honest reading, not
  a defect** — and it is the reason three axes do not appear in the F-3 breadth count (§0.2).
- **Preview/runtime divergence under *change*.** The present-state half is structural. The
  future half cannot be proved. What catches it: `preview.ts` has no branch that decides whether
  a rule matches, so there is nothing there to change out of step.

---

## 9. Guardrails and Stop Conditions

### 9.1 The plan's eight

| # | Guardrail / stop condition | Verdict | Evidence |
| --- | --- | --- | --- |
| G1 | Do not create a general-purpose scripting language | **MET** | 18 predicate fields, 6 actions, no expression form, no function form, no inter-rule reference. `barrel.test.ts` source-scans `src/rules/**` for `eval`, `require`, `Date.now`, `new Date()`, `Math.random`, `node:fs`, `node:child_process`. `invalid-inputs.test.ts:552`. |
| G2 | Do not enable a broad pre-approval rule without an explicit activation confirmation | **MET in the library, unreachable by a user** | `classifyRule` refuses `activation.state === "draft"` with `not_activated` (`evaluate.ts:794`). The TUI has an `activation-confirm` overlay with an armed-confirmation gate (`tui/state.ts:320,334-340,571`), and the module is not attached (§8.6). **Unchanged. The defect F-3 bypasses is the *scope* check, not the *activation* check — an operator who activates a rule honestly still gets a rule that grants more than it disclosed, so this guardrail is met and Criterion 4 is not.** |
| G3 | Do not support "match all projects/nodes/capabilities" pre-approval in the initial release | **NOT MET** — *re-derived; was MET in the library in revision 2 and NOT MET in revision 1* | The guardrail forbids a **match-all** pre-approval. **F-3's rule is match-all on the roles axis**: `all([any(roleId eq "role-1", not roleId eq "role-1")], targetNodeId eq "node-1")` matches every role, discloses `reach.roles = ["role-1"]`, and clears the floor's approval for `role-9` — measured, §0.2. It is a match-all pre-approval wearing a scope. **The fix pass does not change this verdict, and the second half of revision 2's reasoning for it — "a rule that will not compile is not a supported match-all pre-approval" — is true and does not apply, because this rule does compile.** It is also vacuous on the shipped path (§5), but vacuity is not the reason for NOT MET here and I am not using it as one. |
| G4 | Do not claim provider cost enforcement when usage data is missing or delayed | **MET** | `enforceability` is computed from adapter-reported usage, never from a budget being set. `adversarial.test.ts:177`; `:283` — an absent budget and an unenforced budget are reported differently. `dry-run.test.ts` test 7. |
| G5 | Do not let notification delivery affect orchestration state | **MET** | `grep 'from "../' src/notifications/*.ts` → nothing; `isolation.test.ts:144` asserts it by source scan. `emit` is total against a throwing adapter, a throwing `available`, a rejection, an `undefined` result, and a malformed request (`:234-460`). `:594` — the bus is handed observations and cannot act on them. `:413` — the producer cannot branch on anything `emit` returns. |
| S1 | Stop if preview and production evaluation can diverge | **Not tripped, structurally** | One `compileRuleSet`, one `CompiledRuleSet`, one `evaluateRules`; `preview.ts:928` calls it. `preview-divergence.test.ts`, `rule-preview.test.ts` test 1, `dry-run.test.ts` test 4. The *future* half is not provable (§8.8). **Note: `preview-divergence.test.ts` asserts preview agrees with the *evaluator*. It says nothing about the disclosure, which is why F-1's shape sat in its generator for a whole milestone without the sweep objecting — the preview and the evaluator were always going to agree on a shape the compiler should have refused.** |
| S2 | Stop if a rule edit can retroactively affect an active dispatch or approval | **Not tripped** | Digest-bound `ruleSnapshots`; the open-proposal fingerprint invalidates rather than re-evaluates. `workflows/immutability.test.ts`; `automation-safety.test.ts` describe 6. |
| S3 | Stop if budget reservation is not atomic with dispatch eligibility | **Not tripped** | Eligibility is *defined* as holding a `held` reservation; `reserve` is one compare-and-set. `reservation.test.ts:64` over 200 interleaved trials with `N ≫ ceiling`; re-entrancy throws. `automation-safety.test.ts` describe 4. |

### 9.2 The ADR's six stop conditions

| # | Condition | Verdict |
| --- | --- | --- |
| 1 | Preview and production evaluation able to diverge | **Not tripped** (structural; future half unprovable) |
| 2 | A rule edit able to retroactively affect an active dispatch or approval | **Not tripped** |
| 3 | Budget reservation not atomic with dispatch eligibility, including by crash or replay | **Not tripped**, and replay is now a second admission decision rather than a restore (§13.3) |
| 4 | A user rule able to grant a capability removed by the safety floor or a role restriction | **Not tripped** — 11/11 escalation claims refused at the parser, and `narrowPolicyState` records widening attempts rather than applying them |
| 5 | A compiled rule set able to admit an action whose bounds are wider than the bounds the disclosure displayed | **TRIPPED — as it was in revision 1, and as revision 2 certified it was not.** MED-2 was this condition. NEW-2 was this condition again. **F-1 was this condition again, and is fixed** (`compile.ts:761-764`; my sweep 56 → 0). **F-3 is this condition, is open, and is measured on `8714a9f`:** a compiled pre-approval discloses `reach.roles = ["role-1"]`, matches `role-9`, and returns kernel `allow / outstandingApprovals: []`. §0.2. |
| 6 | A notification able to affect orchestration state | **Not tripped** |

**One of six ADR stop conditions is tripped.** The ADR's own Stop Conditions say implementation
halts and returns to the ADR when one becomes true, so **the code side of that clause is not
satisfied today.** This is the substantive reason the verdict moved, and it is the same
condition revision 1 got right, revision 2 got wrong, and this revision gets right for a third
different reason.

**Revision 2 wrote "None of six ADR stop conditions is tripped" and made it the headline of
the improvement. That sentence was the false claim, and it is quoted here so it can be found
by anyone who read revision 2 and wants to know what changed.**

**One other thing remains open and it is not a stop condition:** ADR 0007 needs an A15 to
remove the false control claim its own A14 amendment now makes (§8.1). That is a documentation
defect and the one item from §0 I would still block on.

---

## 10. Verdict

**I would not sign M6 as complete, and I would not sign it as a library either. That is a
change from revision 2, which said "SIGN AS A LIBRARY, with conditions", and I am adopting the
independent reviewer's position over my own.**

| | revision 1 | revision 2 | **revision 3** |
| --- | --- | --- | --- |
| As complete | withhold | withhold | **withhold** |
| As a library | — | sign, with conditions | **withhold** |
| ADR SC5 | TRIPPED | NOT TRIPPED *(false)* | **TRIPPED** |

**Why the library verdict moved.** Revision 2's position rested on one sentence: *"The
engineering is complete, the tests are green under the runner the plan names, and the safety
floor is un-widenable."* The first two clauses are still true — 5,081 green, gate clean. **The
third is false, and it is false in the specific way this milestone keeps producing false:**
not because a capability the floor removed can be granted (SC4 holds), but because a rule can
clear the floor's *approval* for a dispatch outside what it disclosed. **A library with a live
grant in it is not a library I would sign, with conditions or without**, because the
conditions are unenforced intentions and the grant is measured.

**Why I am not the more severe party for its own sake.** The independent reviewer's ground for
withholding on the library — "certifying a library while a grant-class defect is open is too
generous" — is exactly right and I had reached the opposite conclusion two hours earlier on
the same evidence. That is worth recording plainly: **four of the six corrections in this
revision are corrections of errors I made.** Three of them were errors of the same kind, and
the third is the reason a reader should not take any verdict in this document on trust:

- **Reading the compiler's half of a pair and generalising it to the pair.** Twice. §8.1
  argued *"unioning is correct here"* and that argument produced F-1. The pinned control at
  `vacuity.test.ts:187` argued *"the disclosure that reports `B`'s reach is therefore CORRECT
  rather than optimistic"* and that argument produced F-3. **The same move, twice, in my own
  prose.**
- **Declaring something unreproducible on too small a sample.** §0A.3. Revision 1 measured a
  5.2 s timeout, revision 2 measured three fast runs and withdrew the finding as
  unreproducible, and thirteen serial runs this revision put it back — 2 failures in 13,
  range 1,893–8,003 ms. **Revision 2's own measurements were all accurate and its conclusion
  did not follow from them.**

The remaining two corrections were of **stale claims** — three sections describing the ADR as
unamended when `a73f2a3` had amended it. Those are careless rather than reasoned, and the
correction for them is mechanical.

**None of this makes the tree worse and I am not asking a reader to feel worse about it.** What
it establishes is a fact about the evidence available at each step: on `a73f2a3` the tree had
F-3 open and the reviewer found F-1 in it; on `8714a9f` the tree has F-3 open and I found it by
re-deriving a section of my own report rather than by attacking the code. **Each party found
what it was looking at, and neither could see the whole family from inside it.** That is the
argument in §10 for a second independent pass rather than for distrust of this document.

**What was right, and I am recording it because a correction that only lists what was wrong is
a different kind of dishonest.** The independent reviewer verified, and I adopt without
hedging:

- **All six originally claimed fixes are load-bearing** — red/green re-measured for **all
  six**, not the four I claimed.
- **MED-3's recomposition is resistant.** It tried to make a crafted `restrictions` value
  manufacture an `allow` the kernel did not grant, or drop a demand, and could not.
- **The 16/3 red-green figure is right and the 11/8 I was handed is wrong.** Confirmed by
  independent measurement. I should have stopped deferring to the figure I was given the first
  time.
- **The two direction-changed tests were honestly justified**, and the assertions were not
  loosened — it read the committed diff to check.
- **Every number in revision 2's §1–§2 is correct**, including the 5,079 total it could not
  falsify and the M0 digest.
- **The reachability claim is true**, which is the claim I most expected it to overturn and
  could not.
- **Criterion 7's PARTIALLY MET is the correct verdict**, reached independently on the same
  reasoning.
- **Its own F-1 severity and mechanism are right**, and its fuzz found the same defect I did.
  Where our breadth numbers differ (§0.1) it is a metric difference and it is stated as one.

**What I would sign, and on what conditions.** Not M6 today, in either form. **I would sign
it as a library when all four of these hold:**

1. **F-3 is fixed**, and fixed in `collectReach` rather than by a fifth refusal in
   `constrainingScopeAxes` — because a refusal closes the shape you thought of and the
   structural cause is two walks of one tree. A test must sweep `all([any(A, not A)], B)`
   across every pair of disclosed axes and assert the kernel does not clear the floor for a
   value the disclosure did not name.
2. **A test asserts `collectReach` and `constrainingScopeAxes` agree** on a generated sweep of
   the predicate language. The independent reviewer's §7 item 3, and it is the only item on
   this list that would have caught HIGH-1′, NEW-2, F-1 and F-3.
3. **ADR 0007 A15** removes the false control claim from `:1769-1776`, `:1944-1949` and
   `:1982-1984`, states the subtree half was **not** sufficient, and states the
   disclosure/check agreement invariant as normative.
4. **A fresh security review of the disclosure path specifically.** **This milestone's four
   HIGH findings were all in the disclosure/vacuity pair and not one was found by reviewing
   the disclosure.** The M6.10 review did not cover it. A reviewer should be told to review
   `explain.ts` against `compile.ts` and nothing else.

**I would sign it as complete only after all four above, plus:**

5. **The seam is wired, in the right order** (§5 items 2–4): a real rule store behind
   `local-project-registry.ts:124`; a composition caller threading `evaluateRules` →
   `evaluateWithKernel` **with** `ruleRestrictions`; and `PERMITTED_CONSUMERS` inverted so the
   first non-simulation caller of `src/rules` must be one that also applies
   `narrowWithRuleRestrictions`.
6. **Criterion 11 is rewritten** so it tests whether findings were fixed rather than whether
   any were made (§6, #11).
7. **ADR 0007's `file:line` citation sweep is re-run** against a document that has grown 131
   lines since revision 2 last read it (§11).
8. **`src/rules/tui/` is attached** at the three named points, or M6.8 is stated plainly as a
   library and the experience is deferred.
9. **`ReplayRequest.now` is made optional**, and a durable `BudgetLedgerStore` test is added
   or Criterion 7 is recorded as permanently partial.

**What would change my mind, in the strongest form: a second independent review of the
*fixed* tree that reaches F-3 by itself.** I found it by re-deriving a section of my own
report rather than by attacking the code, and I would not trust my own finding to be the last
one. If a second reviewer, not having read §0.2, produces the same measurement from the same
shape, this becomes a fixed defect with a known fix. **If they find a fifth shape in the same
family, then the right recommendation is not another fix but replacing
`constrainingScopeAxes` + `collectReach` with a single walk that both consumes.**

**What would not change my mind:** a green suite. That is not a rhetorical position. It is
the finding of §0.4, and this milestone has now demonstrated it five separate times.

---

## 11. Numbers I could not verify

Recorded because a gate report that presents unverified figures as verified is worse than one
that admits the gap. **Everything else in this report was run, in this revision, and the output
is quoted verbatim.** The independent reviewer published the same section first and stated
prominently that the milestone's most load-bearing number was the one it could **not** falsify;
I adopt that framing and add to it.

### 11.1 What I could not verify

- **The `comparedOutcomes` figure of 733** in `preview-divergence.test.ts:341`. The value
  lives inside the test's own comment and the assertion is `> 700`. I did not re-derive 733
  without editing a test file, which I was not permitted to do. **What I did verify is the
  assertion passes and that `expect()` calls fell 93648 → 93337, which is consistent with the
  recorded drop.** Treat 733 as the test file's figure, not as one I measured.
- **`bun run test` (vitest).** Revision 2's four-run table is retained as revision 2's
  measurement. **I did not re-run it for revision 3.** `8714a9f` touches neither failing file
  and `bun test` is green, but a reader deciding on the vitest result should re-take it.
- **The ADR's `file:line` citation sweep.** Not run, for the third revision running. The ADR
  has grown from 1,959 to 2,090 lines since revision 2 read it and its citation count is now
  larger and unknown.
- **Per-file test counts outside `tests/unit/rules/`.** I re-verified the 17 `tests/unit/rules`
  files individually. The per-file breakdowns quoted for `workflows`, `budgets`, `routing`,
  `simulation` and `notifications` in §3 are **revision 2's**; I re-verified only their
  aggregates (257 / 193 / 108 / 113 / 327).
- **The M6.10 security review's own probe methodology and its 31 attack claims.** I did not
  re-run the review's probes; I re-verified its five findings against the code and the pinned
  tests that now cover them. I make no claim about the other 26 beyond what §4 attributes.
  **The independent reviewer independently re-derived five findings and NEW-2 and reached the
  same dispositions, and could not re-run the review's own probes either — they lived in a
  `/tmp` directory that is gone.** So this gap is now shared, not just mine.
- **The ad-hoc probes cited in revision 1** (`/tmp/m6-gate/`) are gone. I re-created the ones
  carrying load-bearing claims. **The claims that now rest only on the pinned suite rather than
  on a probe I ran are the 19-of-19 constructive-atom count for HIGH-1′ and the
  `hasAll []`/`hasAny []` empty-enum results in §4.** Both are covered by `vacuity.test.ts`
  (21 tests, green) but I did not re-run the specific sweep.
- **What causes the `tui-keyboard.test.ts` spread.** I measured that it **reproduces**
  (13 serial isolated runs, range 1,893–8,003 ms, 2 failures; 0 in 4 in directory context,
  §1.3.1), so the failure itself is established. **What I cannot establish is the cause.** The
  observed 4.2× spread on an idle machine is consistent with contention, GC or runner
  scheduling, and I have no instrumented run that distinguishes them. **I am asserting the
  flake, not its mechanism.** Revision 1's original 5,232 / 6,087 ms figures sit inside the
  range I measured and are therefore not anomalous; revision 2's contrary conclusion is
  corrected at §0A.3.
- **Whether the 11 pass / 8 fail figure I was originally handed was ever measured.** I measured
  **16 / 3** and the reviewer measured 16 / 3 independently. Five of the alleged failures do
  not exist in this tree.
- **Cross-machine routing determinism.** Untested, one machine, and `Intl.DateTimeFormat` is
  host-tzdata-dependent (§8.8).

### 11.2 What the independent reviewer could not verify, and I could not either

- **The suite total.** It reproduced `5079 pass / 4 skip / 0 fail`, called the figure exact, and
  noted the 5063 → 5079 movement is consistent with concurrent agents. **The total is now
  5081** and I re-took it (§1.1). Neither of us could falsify the earlier figure; I can only
  confirm the current one.
- **The reachability claim.** It tried and could not overturn it (§5). **This is the load-bearing
  structural claim in the report and it is the one no party has been able to attack.** That is
  a strength of the claim and a limit of the verification, and both are worth stating.
- **MED-4 and MED-5's adversarial depth.** It states plainly that those two got targeted
  adversarial probes and revert tests, not a fuzz campaign, and that its confidence on them is
  *"verified sound against the attacks I chose"*, not *"verified sound."* I agree and adopt the
  weaker claim.
- **Why the vacuity defect took three parties to find.** It says it cannot be determined from
  the artefacts and does not speculate. I now have one more data point it did not — the same
  function produced a bypass in **five** shapes inside one milestone, which is a design signal
  (§8.2) — but I cannot say why the *first* one was missed either, and I will not pretend the
  five-instance count explains it.

---

## 12. Sign-off

| Role | Required | Status |
| --- | --- | --- |
| `milestone-lead` | Yes | **Signature withheld, revision 3, in both forms** — as complete and as a library. Reasons in §10. ADR SC5 is tripped (F-3, open, §0.2). **I am not the signatory; the user signs.** What I would sign and on what conditions is §10. |
| `security-reviewer` | Yes (M6.10) | Delivered §0 and §3 of the security review. Its §0 dispositions on HIGH-1 and MED-3 are **superseded** by §7; its LOW-6/7/8 and LOW-9 dispositions stand; NEW-1 stands. **Its blind spot is the disclosure path**, which is where all four HIGHs live — recorded as a finding about the milestone's verification method, not about the reviewer. |
| `independent-reviewer` | Yes | **Delivered**, 469 lines, and **it found the defect this revision corrects.** Its F-1 is confirmed by my own independent measurement. **Its one severity call I revise: F-2 was rated LOW on the projects axis, and it is a HIGH on every other disclosed axis (§0.2).** It could not falsify the suite total or the reachability claim, and says so. |
| Root agent | Yes | — |

**Nothing in this report has been committed. The only file written is this one.**

**The workspace was not modified.** `git status --porcelain --untracked-files=all` is empty
and `git diff --stat` is empty at `8714a9f`, with `src/rules/compile.ts` at sha256
`bd13edca7b379d8a6a96152529daf6389c30605166f2cebabe14eb682cb99abf` and `src/rules/explain.ts`
at `fbe9c64195689be1c84088cbbebbf0a65e040786f6f000af01f048b2e6ad8aa6`.

**The red half of the red/green proof in §1.1 was taken in a clone**, `git clone
--no-hardlinks` into `/tmp/m6-lead/rev`, checked out at `8714a9f`, with **only** the
cross-axis branch at `compile.ts:761-764` reverted to the union. The clone's `compile.ts`
under revert hashed `2d01dbf22db5f02f25e04608013d547bf961918d071874b4ff3b9990765015e3`
against the shipped `bd13edca…abf`, so the two states are provably different and the only
intended difference is the reverted branch. **No file under `src/` or `tests/` in the
workspace is modified by this report.**