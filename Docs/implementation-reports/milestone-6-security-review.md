# Milestone 6 — M6.10 Adversarial Policy-Bypass Review

Reviewer: `security-reviewer` (adversarial, read-only on `src/` and `tests/`)
Date: 2026-10-01
Branch: `aibr-v2`
Specification: `Docs/implementation-plans/milestone-6-rules-and-workflows.md`
Contract under review: `Docs/adr/0007-rule-language-and-evaluation.md`

Scope reviewed: `src/rules/**`, `src/budgets/**`, `src/routing/**`, `src/workflows/**`,
`src/simulation/**`, `src/notifications/**`, and `src/orchestration/policy/{floor,evaluate,
approval,types}.ts` as consumed. `src/application/**` was read to establish reachability.

All throwaway proof tests live in `/tmp/m6-audit/` and were run with `bun test <path>`.
No file under the repository was created, edited, or deleted by this review except this
report. `git status --porcelain` shows no modification to any tracked file.

> **REVISION 2026-10-02 — read §0 first.** Every finding in §3 was dispositioned against
> the code as it now stands. Three of the five fixes verify clean (MED-2, MED-4, MED-5).
> HIGH-1 is fixed for the nine shapes it was reported against and **still open in a new
> shape that is worse**: a predicate that is a logical tautology compiles, is described by
> the disclosure as *scoped to one project*, and clears the safety floor (§0.2). MED-3 is
> **not fixed**: the new `ruleRestrictions` parameter makes `evaluateWithKernel` return
> `Err` on every call it is supplied to, and has zero test coverage (§0.3). The
> reachability statement in §0.4 is unchanged and is still the most important sentence in
> this report. The original findings are left below unrewritten; §0 supersedes them where
> they disagree. Revision probes live in `/tmp/m6-v2/`.

---

## 0. Revision — 2026-10-02

### 0.1 Revised verdict

**DO NOT SIGN. Two of five findings are not closed, and one of them closed in a way that
is more dangerous than the defect it replaced.**

The safety floor itself is unchanged and still holds: nothing I tried widens
`allowDestructiveEffects`, `allowExternalEffects`, the timeout ceiling, or
`requireApprovalForDispatch: false`, and every escalation route through the parser remains
refused. That part of the deliverable is still met.

What changed is the compiler's universal-scope check. `checkNotUniversal` no longer asks
whether a scope field is *mentioned*; it now asks whether one is *constructively*
constrained, via a per-axis `CONSTRUCTIVE_FORMS` table plus bound inspection for the two
range axes, and a `not` contributes nothing. That is the right shape of fix and it closes
all nine vacuous forms I reported. It is not sufficient, because the check is a **per-atom
syntactic test with no satisfiability reasoning**, and the space it does not cover is
reachable with ordinary-looking predicates:

> **HIGH-1′ — `any(A, not A)` compiles, is disclosed as `projects: {kind: "constrained",
> values: ["proj-1"]}`, and clears the safety floor for the whole project.**

Fifteen of the nineteen constructive atoms in `CONSTRUCTIVE_FORMS` produce this. The
disclosure is the aggravating part: the original HIGH-1's disclosure said `{kind:
"unknown"}`, which is a warning the author can act on. This one's disclosure **affirmatively
asserts a narrow reach it does not have**, and cites the very atom whose negation is its
sibling as the source. That is ADR Stop Condition 5 verbatim — *"a compiled rule set is
found to admit an action whose bounds are wider than the bounds the disclosure
displayed."*

MED-3 is not fixed at all. The fix added `KernelCompositionInput.ruleRestrictions` and
documented it as required ("Omitting this argument reproduces the M6.10 MED-3 defect"), and
the very first line of the implementation spreads that key into `evaluatePolicy`, whose
input schema is `.strict()`. Every call that supplies the documented argument returns
`rule.evaluation_failed: Unrecognized key: "ruleRestrictions"`. The four members are still
unenforced; the difference is that the composition entry point now refuses to answer
whenever you try to enforce them. **No test in `tests/` supplies `ruleRestrictions` at
all** (`grep` returns zero hits in `tests/`), which is why 5032 passing tests do not
notice.

I record both as still open. I would not sign the milestone on HIGH-1′ and I would not
sign it on MED-3.

### 0.2 HIGH-1′ — the tautology: reproduction and scope

`src/rules/compile.ts:660-671` (`constrainingScopeAxes`) recurses into `all`/`any` and
counts any constructive descendant, while skipping every `not` node it meets. So a `not`
nested *inside* a positive sibling contributes its atom to the constraining set but
contributes nothing to the semantics that would make the predicate non-vacuous.

```ts
predicates: [{
  field: "any",
  predicates: [
    { field: "projectId", operator: "eq", value: "proj-1" },        // counts as constraining
    { field: "not", predicate: { field: "projectId", operator: "eq", value: "proj-1" } },  // skipped
  ],
}]
```

`/tmp/m6-v2/h1-final.test.ts`, through the real compiler, evaluator and `evaluatePolicy`:

```
  compile: OK (accepted)
  evaluate against proj-1             -> matched
  evaluate against no role            -> matched
  evaluate against roleVersion 1000   -> matched
  kernel: allow cleared=true outstanding=[]
  control (no rules): require_approval outstanding=["dispatch_approval"]
  evaluateRules preApproval.grantedBy: rule-t | boundsSatisfied: true
```

One authored rule, one activation, zero further edits: the floor's per-dispatch approval
stops applying to every dispatch in the project. Identical impact to the original HIGH-1.

**Breadth.** `/tmp/m6-v2/b4-tautology.test.ts` runs the shape against every constructive
atom the fix defines. 19 atoms × 2 shapes = 38 documents; 36 compiled; **15 granted
`allow` with `preApprovalClearedDefault: true`**:

```
*** GRANT  any(A,not A) TAUTOLOGY  of projectId eq proj-1                kernel=allow cleared=true
*** GRANT  any(A,not A) TAUTOLOGY  of roleId eq role-1                  kernel=allow cleared=true
*** GRANT  any(A,not A) TAUTOLOGY  of projectPathId eq path-1            kernel=allow cleared=true
*** GRANT  any(A,not A) TAUTOLOGY  of runtimeKind eq opencode            kernel=allow cleared=true
*** GRANT  any(A,not A) TAUTOLOGY  of targetNodeId eq node-1             kernel=allow cleared=true
*** GRANT  any(A,not A) TAUTOLOGY  of capability any [fs.read]           kernel=allow cleared=true
*** GRANT  any(A,not A) TAUTOLOGY  of capability all [fs.read]           kernel=allow cleared=true
*** GRANT  any(A,not A) TAUTOLOGY  of nodeAdvertisedCapability all [..]  kernel=allow cleared=true
*** GRANT  any(A,not A) TAUTOLOGY  of roleVersion gt 1                   kernel=allow cleared=true
*** GRANT  any(A,not A) TAUTOLOGY  of roleVersion lt 1000                kernel=allow cleared=true
*** GRANT  any(A,not A) TAUTOLOGY  of roleVersion eq 500                 kernel=allow cleared=true
*** GRANT  any(A,not A) TAUTOLOGY  of roleVersion between 2 and 999       kernel=allow cleared=true
*** GRANT  any(A,not A) TAUTOLOGY  of taskLabel hasAny [release]          kernel=allow cleared=true
*** GRANT  any(A,not A) TAUTOLOGY  of ctxSens maxRankAtMost 2             kernel=allow cleared=true
*** GRANT  any(A,not A) TAUTOLOGY  of ctxSens maxRankAtLeast 1            kernel=allow cleared=true

B4 TAUTOLOGY FAMILY: 19 atoms x 2 shapes; compiled=36 granted=15
```

The `all(A, not A)` mirror compiles for all 36 and matches nothing (fail-closed), and
`toolCategory any`, `dependencyOutcome *`, and `taskLabel has` do not grant — the last
three because their `A` is not satisfied on my probe set, not because the compiler caught
them. That distinction matters: `all(A, not A)` is a rule that never fires, which is the
benign direction, but it is the *same* missing reasoning.

**Nested forms also work.** `/tmp/m6-v2/b1-vacuous.test.ts` (46 shapes) confirms
`any([all(A,B), all(A, not B)])` — the disjunctive tautology `A∧B ∨ A∧¬B ≡ A` — compiles,
and `any([not(all(A,B)), A])` compiles. `not(any(A, not A))` and `not(all(A, not A))` *are*
refused, because a `not` at the top contributes nothing. So the escape is specifically
"a positive atom anywhere under an `any`, plus its own negation elsewhere under the same
`any`".

**A second, independent hole in the same family: `taskLabel hasAll []`.**
`src/rules/compile.ts:457-518` has a `rule.empty_enum` branch for
`capability`/`toolCategory`/`nodeAdvertisedCapability` (`[]` refused) and for
`projectId in []`, but **none for `taskLabel`**. `hasAll []` is in `CONSTRUCTIVE_FORMS`
(compile.ts:582) and is vacuously satisfied:

```
  COMPILED taskLabel hasAll [] -> labelled dispatch: matched, kernel=allow cleared=true
  refused  taskLabel has []     -> rule.invalid_source
  refused  taskLabel lacks []   -> rule.universal_pre_approval
  refused  capability any []    -> rule.empty_enum
  refused  capability all []    -> rule.empty_enum
  refused  toolCategory all []  -> rule.empty_enum
  refused  projectId in []      -> rule.empty_enum
```

**What the fix did get right, and I confirmed each.** All nine originally-reported shapes
are now `rule.universal_pre_approval` (`/tmp/m6-audit/a6b.test.ts`, re-run):

```
[refused] roleVersion >= 1 (whole legal range): rule.universal_pre_approval
[refused] roleVersion between 1 and 1000: rule.universal_pre_approval
[refused] roleVersion lte 1000: rule.universal_pre_approval
[refused] contextSensitivity maxRankAtMost prohibited (rank 3, the top): rule.universal_pre_approval
[refused] contextSensitivity maxRankAtLeast public_to_project (rank 0, the bottom): rule.universal_pre_approval
[refused] not(projectId eq a-project-that-never-existed): rule.universal_pre_approval
[refused] not(not(projectId eq a-project-that-never-existed)): rule.universal_pre_approval
[refused] taskLabel lacks [a-label-nobody-sets]: rule.universal_pre_approval
[refused] capability none [a-capability-nobody-requests]: rule.universal_pre_approval
[refused] nodeAdvertisedCapability none [gpu]: rule.universal_pre_approval
[refused] timeoutSeconds <= 3600 (whole floor ceiling): rule.universal_pre_approval
[refused] dependencyOutcome none: rule.universal_pre_approval
```

Numeric edges are all closed, including out-of-domain and wider-than-domain ranges
(`gt 1000`, `lt 1`, `between 0 and 2000`, `between -1 and 1001`, `lte 1001`, `gte 0`,
`eq 0`, `eq 1001`, `maxRankAtMost 4`, `maxRankAtLeast -1` — all refused, the last ten as
`rule.invalid_source` at the schema). `all([])` and `all([all([])])` are refused;
`any([])` is refused as `rule.empty_enum`; `capability any []`/`all []`,
`toolCategory all []` and `projectId in []` are refused as `rule.empty_enum`. **No
remaining vacuous shape outside the `any(A, not A)` family and `taskLabel hasAll []`.**

**Two over-refusals introduced by the fix, both fail-closed, both worth recording.**
`not(all([capability any [fs.read], capability any [net.fetch]]))` and
`not(all([A,B]))` generally are refused as `rule.universal_pre_approval` even though they
genuinely exclude dispatches requesting both. The `not` skip at compile.ts:667 is applied
without asking whether the `not` wraps an *exclusion*. That is the right default and the
wrong message: an author who writes "everything except requests that need both `fs.read`
and `net.fetch`" is told their rule is universal.

**Severity.** HIGH, unchanged. Same impact, same reachability class, and the disclosure
component makes it a Stop Condition 5 hit rather than a plain unenforced guardrail.

**Direction.** The fix belongs in `constrainingScopeAxes` and needs the ADR amendment the
Stop Conditions require. Two candidate directions, both beyond this review's authority:
(a) refuse any `any` branch set in which an atom and its negation co-occur anywhere
beneath it (a syntactic fix, cheap, and covers the family I found — it does not cover
general non-satisfiability); or (b) refuse any pre-approval whose predicate has no model
over the declared domains, which requires the satisfiability reasoning the language
currently has no vocabulary for. Add `taskLabel` to the `rule.empty_enum` branch
regardless; that one is unambiguous.

### 0.3 MED-3 — the fix is dead code, and its activation is a denial of service

**`src/rules/evaluate.ts:1888`:**

```ts
const evaluation = evaluatePolicy({ ...input, envelope: { ...input.envelope, ruleSnapshots: [...kernelRules] } })
```

`input` is a `KernelCompositionInput`, which now carries `ruleRestrictions`. The spread
forwards it into `evaluatePolicy`, whose parameter is validated by
`policyEvaluationInputSchema` — `src/orchestration/policy/types.ts:261-267`, a
**`.strict()`** object with exactly `envelope`, `taskTitle`, `projectPolicy`. Zod refuses
the unknown key, `evaluateWithKernel`'s `catch` converts the throw, and the function
returns `Err`. The narrowing code at :1920-1962 is unreachable.

Tightest repro (`/tmp/m6-v2/h1-final.test.ts`, H3) — a rule with **no restrictions at
all**, so there is nothing to apply:

```
  all-empty restrictions: {"allowedCapabilities":null,"deniedCapabilities":[],
    "requireApprovalForDispatch":false,"requireApprovalForCapabilities":[],
    "requireApprovalForDestructiveEffects":false,"requireApprovalForExternalEffects":false,
    "allowDestructiveEffects":true,"allowExternalEffects":true,"maximumTimeoutSeconds":null,
    "unprojected":[]}
  WITHOUT ruleRestrictions: allow
  WITH    ruleRestrictions: ERR: rule.evaluation_failed: kernel composition threw instead of
          returning a contract error: [ { "code": "unrecognized_keys", ...
```

`null` and `undefined` both fail identically (the key is *present* on the object literal,
which is all `.strict()` inspects). Ten hand-built attacks — all-false, `{}`, a garbage
string, `allowDestructiveEffects: true`, `maximumTimeoutSeconds: 999999`,
`allowedCapabilities: []`, and a prototype-inherited object — **all** return `Err`
(`/tmp/m6-v2/d1-med3.test.ts`, D4). **So the answer to the question I was asked is no: a
crafted `restrictions` value cannot produce an `allow` the kernel did not, because the
function throws before it narrows anything.** The recomposition is not exploitable. It is
also not operational.

**Test coverage: none.** `grep -rn "ruleRestrictions" tests/` returns **zero hits**.
`evaluateWithKernel` appears in `tests/unit/rules/{barrel,evaluate}.test.ts` and both call
it without the argument. The 5032-test suite cannot see this.

**The ordering question you asked me to argue.** I read the intent at evaluate.ts:1917-1919
— *"It runs AFTER the kernel's pre-approval pass on purpose: a demand added here must not
be clearable by a pre-approval the kernel already considered, or adding the demand would
be free."* The intent is right and the reasoning is sound. **The implementation does not
achieve it, and fails in the unsafe direction.** At :1929:

```ts
if (narrowed.state.dispatchApprovalDemands.length > 0 && !validated.data.preApprovalClearedDefault) {
  if (!outstanding.includes("dispatch_approval")) outstanding.push("dispatch_approval")
}
```

A `require_approval { requireApprovalForDispatch: true }` rule adds a demand *after* the
pre-approval pass, but `dispatch_approval` is only re-added when the pre-approval did
**not** clear the default. A rule set carrying both a matching `pre_approve` and a matching
`require_approval` therefore lets the pre-approval suppress the rule's demand — which is
precisely "adding the demand is free", just with the sign flipped: the demand is added to
the state and then discarded on the way out. The capability demands at :1925-1928 have no
such guard and are handled correctly; only the dispatch demand does. **If the MED-3 fix is
completed, this line needs to drop `&& !validated.data.preApprovalClearedDefault` and
instead distinguish "cleared by a pre-approval that the kernel already accounted for" from
"cleared by a pre-approval this rule set's own `require_approval` should have survived."
**Today it is unreachable, so this is a latent defect in an unexecuted path, not a live
bypass.** I am recording it now because it is exactly the shape that becomes live the
moment the strict-spread bug is fixed.

**Severity.** MEDIUM, still open, and reclassified in substance: the four members remain
unenforced (unchanged impact), plus the composition entry point is now unusable for any
caller that follows its own documentation. Not a confidentiality issue — it fails toward
`Err`, not toward `allow`.

**Direction.** Destructure rather than spread at :1888
(`evaluatePolicy({ envelope: …, taskTitle: input.taskTitle, projectPolicy: input.projectPolicy })`),
and add the test that does not exist: one assertion per member of
`RuleRestrictionComposition`, through `evaluateWithKernel`, that the member takes effect.

### 0.4 Reachability — re-verified, unchanged, still the most important sentence

Nothing has been wired. Re-derived from source rather than from the original report:

```
$ for m in rules budgets routing workflows simulation notifications; do … done
  src/rules  <- 0 real importers outside src/rules, src/simulation, src/rules/tui
  src/budgets  <- 0 …      src/routing  <- 0 …      src/workflows  <- 0 …
  src/simulation  <- 0 …      src/notifications  <- 0 …

$ grep -rn "from \"../rules/index.js\"" src/ | grep -v "^src/rules/"
src/simulation/types.ts:158:import type { CompiledRuleSet } from "../rules/index.js"
src/simulation/plan.ts:137:} from "../rules/index.js"

$ grep -n "ruleSnapshots" src/application/local-project-registry.ts
124:        ruleSnapshots: [],

$ grep -rn "rules/\|budgets/\|routing/\|workflows/\|simulation/\|notifications/" src/server src/cli.ts
  (none)
```

**The M6 guarantee is still vacuously held on the shipped approval path, for the same
reason M5's was.** `POST /approve` → `start` reads `ruleSnapshots: []`, so none of HIGH-1′,
MED-2, MED-3 or MED-5 is reachable from the production dispatch path today. Every hit for
every M6 entry point is either prose in a docblock or a call from `src/simulation/**` and
`src/rules/tui/**`. HIGH-1′ and MED-3 are reachable from the simulator and from any caller
that composes a rule set. This is the same structural twin as the M5 isolation audit's
S-1, and it is reported at the same severity as in §1: the deliverable is a claim about
the rule language, and a language defect is a live defect the moment the seam is wired. It
does not lower HIGH-1′ or MED-3; it is an argument about *when*, not *whether*.

### 0.5 MED-2 — fixed on all three axes, and reclassified upward

The brief is right that this was worse than I recorded. My original finding described a
disclosure mismatch (the disclosure de-duplicates, the normalised predicate does not) and
missed that `src/rules/evaluate.ts:460-471` built `present` from the raw array with
multiplicity and compared `present.length` to a deduped `declared.size`, **inverting** the
match. A pre-approval scoped to a conjunction fired on a request for one capability.

The fix builds `present` and `missing` over the deduped `declared` set and the `all` branch
now tests `missing.length === 0`. Verified on `capability`, `toolCategory` **and**
`nodeAdvertisedCapability`, which share `SET_SUBJECT` and `evaluateSetPredicate`
(`/tmp/m6-v2/c1-med2.test.ts`):

```
=== capability ===
  capability all [A,B,A]  request one member -> not_matched   (want not_matched)
  capability all [A,B,A]  request BOTH       -> matched       (want matched)
  capability all [A,A,A,B,B,B] request one member -> not_matched
  capability all [A,A,A,B,B,B] request BOTH       -> matched
  capability any [A,A]    request one member -> matched
  capability any [A,A]    request neither    -> not_matched
=== toolCategory ===          (identical six rows)
=== nodeAdvertisedCapability === (identical six rows)
C2 PASS: no inverted `all` on any set axis
```

Deduplicated and duplicated rows now agree on all three axes. The `actual === null`
snapshot path short-circuits before `membersOf`, so it is unaffected and still resolves
`none` to satisfied as documented.

**Reclassification: MEDIUM → HIGH.** My original MED-2 was an audit-integrity defect. What
the code actually did was fail **open** on a pre-approval matcher, which is a grant defect:
a pre-approval written for "requests that need both `fs.read` and `net.fetch`" was granted
to a request needing only `fs.read`, and refused the request it was written for. That is
the same class as HIGH-1 and it sits on the same object. **Status: fixed.** The severity I
recorded was wrong; the fix is right.

### 0.6 MED-4 — fixed, and the freeze survives every mutation vector I tried

`publish` now does `deepFreezeNotificationValue(structuredClone(envelope))` at
`src/notifications/store.ts:451` — clone and freeze on **write**, which is the correct side
of the boundary, since `list()` runs per keystroke and a clone-on-read would be the copy
that costs. `deliverOne` (`src/notifications/bus.ts:284`) produces a fresh deep-frozen
clone per adapter inside its own `try`. `byDedupeKey` is keyed on the clone, not the
caller's object.

`/tmp/m6-v2/f1-med4.test.ts`, F1–F7, against a hostile adapter:

```
  plain assignment .summary                  TypeError
  plain assignment .runId                    TypeError
  plain assignment .createdAt (retention dodge) TypeError
  plain assignment .dedupeKey                TypeError
  delete .summary                            TypeError
  Object.defineProperty rewrite              TypeError
  Object.defineProperty add key              TypeError
  Object.setPrototypeOf                      TypeError
  Object.assign onto the target              TypeError
  write through the prototype                NO THROW   (writes Object.prototype, not the envelope)

STORE UNCHANGED: true
identity store.envelope === what the adapter got: false
adapter's object frozen: true | store envelope frozen: true
prototype reached? undefined
```

Every value the module hands out is frozen (`list()`, the entry, the envelope, the `emit`
result, `findByDedupeKey`, and the nested arrays inside). Each of three adapters received a
**distinct** object (3/3), so one adapter's failure cannot affect another's. The producer's
own object is not aliased in either (`F2`). The dedupe index cannot desynchronise:

```
rewrite threw: TypeError
found by original key after rewrite attempt: true
found by forged key: false
second publish, same dedupeKey -> duplicate: true | inbox size: 1 (want 1)
```

The one line that does not throw writes `Object.prototype` — global pollution, which is
inherent to running attacker code in-process and is not reachable from a notification
payload. **Status: fixed.** MED-4 is closed.

The `structuredClone`-throws theory in the bus docblock is defensive rather than reachable:
by the time `deliverOne` runs, the envelope has already passed
`notificationEnvelopeSchema`, whose members are all strings, so the clone cannot fail. The
`try` costs nothing and the argument is right; I record it only so nobody later reads the
clone as a live failure mode it has to test for.

### 0.7 MED-5 — fixed, plus both additional defects are fixed and verified

`replayDurableReservations(target, records, { now, ceilings })` is now a second admission
decision (`src/budgets/recovery.ts:629-797`), assigning each occupying row one of
`duplicate_dispatch` / `ceiling_undeclared` / `over_ceiling` and installing rejected rows as
`expired`. `heldUnits` is recomputed from the *installed* set at :784, so a refusal returns
capacity. Thirteen adversarial logs (`/tmp/m6-v2/g2-med5.test.ts`, G1/G2):

```
  one row, units=99, ceiling=1                   occupyingInstalled=0 held=0 rejected=1 over_ceiling:1      freshReserve=admitted
  one row, NO ceiling declared for the scope     occupyingInstalled=0 held=0 rejected=1 ceiling_undeclared:1 freshReserve=admitted
  one row, ceilings list is EMPTY                occupyingInstalled=0 held=0 rejected=1 ceiling_undeclared:1 freshReserve=admitted
  one row, ceiling belongs to a DIFFERENT project occupyingInstalled=0 held=0 rejected=1 ceiling_undeclared:1 freshReserve=admitted
  one row, ceiling 0                             occupyingInstalled=0 held=0 rejected=1 over_ceiling:1      freshReserve=admitted
  a COMMITTED row (occupies too)                 occupyingInstalled=0 held=0 rejected=1 over_ceiling:1      freshReserve=admitted
  terminal row then occupying row, one dispatch  occupyingInstalled=0 held=0 rejected=1 duplicate_dispatch:1 freshReserve=admitted
  occupying row then terminal row, one dispatch  occupyingInstalled=0 held=0 rejected=1 over_ceiling:1      freshReserve=admitted
  same reservationId twice, second one huge      occupyingInstalled=0 held=0 rejected=1 over_ceiling:1      freshReserve=admitted
  terminal row only, no ceiling                  occupyingInstalled=1 held=0 rejected=0                       freshReserve=admitted
  ceiling exactly equal to occupancy (3 of 3)    occupyingInstalled=1 held=3 rejected=0                       freshReserve=admitted
  fan_out row with no ceiling + a concurrency row occupyingInstalled=1 held=1 rejected=1 duplicate_dispatch:1 freshReserve=admitted
  200 rows of 1 unit against ceiling 3           occupyingInstalled=3 held=3 rejected=197 over_ceiling:197   freshReserve=admitted

  G2 over-ceiling installs: NONE on 13 attacks
  G2 wedges:                NONE
```

**Can over-ceiling rows still be installed? No.** Not on any of the thirteen, including the
terminal-then-occupying ordering (which the ceiling check alone would miss and the
first-row-wins dispatch index catches) and 200 rows against a ceiling of 3. And no wedge:
freeing the one admitted unit makes the next `reserve` succeed, which is what separates
this fix from the DoS a total refusal would be. A non-integer, negative, `NaN`,
`Infinity` or string ceiling throws `RangeError` (G6). **Status: fixed.**

**The `releasedUnits` defect is fixed and I verified the index independently.**
`src/budgets/ledger.ts:463` now reads
`occupiesCapacity(current.state) && !occupiesCapacity(next.state) ? current.units : 0`, so a
move *within* the occupying set (`held → committed`) returns nothing. Cross-checked
against the reservation list — not against the ledger's own port, which recomputes — at
every transition (G3):

```
  after 5 reserves           list=5 index=5 port=5 agree
  after 3 commits (still occupying) list=5 index=5 port=5 agree
  after 2 releases            list=3 index=3 port=3 agree
  after 1 expire              list=2 index=2 port=2 agree
```

The brief's measurement — index reading `2` where the list said `5` — reproduces on the
pre-fix code and does not reproduce now. **Status: fixed.** Note this was a *rendered*
value, not an admission one: `reserveInTransaction` recomputes from the list, and
`Math.max(0, …)` floored the drift rather than exposing it. Correct characterisation, and
the severity was rightly low.

**The lying-store defect is fixed and the new `unverified` list works.** I built a store
that delegates every call to the real one and reports success from `transition` while
restoring the prior state underneath (`g2-med5.test.ts`, G4):

```
  reclaimed : []
  unverified: ["res-1","res-2"]
  retained  : ["res-1","res-2","res-3"]
  reclaimedUnits: 0 retainedUnits: 3 sum: 3 (occupancy was 3)
  states in the LYING store: res-1=held res-2=held res-3=held
```

Without R18 the report would have claimed two reclaimed and one retained — all three wrong,
in the over-release direction of unit conservation. R6 stays an equality in the demoted
case. **Status: fixed.**

**One interface observation, not a defect.** `ReplayRequest.now` is required and typed and
then explicitly discarded: `void request.now` at `recovery.ts:634`, argued at R16 (*"Replay
never restamps and never invents"*). Confirmed to have no observable effect (G5: reports
with `now=2026` and `now=1999` are byte-identical). The argument is correct — a replay
should not rewrite the log's timestamps — but a required, documented, permanently-unread
parameter is a trap for the next caller and will be used to smuggle clock-dependent
behaviour in. Making it optional, or removing it, costs nothing. Recorded as LOW.

### 0.8 Disposition table

| Finding | Severity (original → now) | Status | Fix at | Proven by |
| --- | --- | --- | --- | --- |
| HIGH-1 vacuous pre-approval — nine named shapes | HIGH → HIGH | **fixed** | `src/rules/compile.ts:561-686` (`CONSTRUCTIVE_FORMS`, `excludesDispatch`, `constrainingScopeAxes`) | `/tmp/m6-audit/a6b.test.ts` re-run: 12/12 `rule.universal_pre_approval`; `/tmp/m6-v2/b1-vacuous.test.ts` 46 shapes |
| **HIGH-1′ vacuous pre-approval — `any(A, not A)` tautology** | **HIGH (new)** | **STILL OPEN** | *(none — `constrainingScopeAxes:663-668` counts the positive atom and skips the `not`)* | `/tmp/m6-v2/b4-tautology.test.ts` — 15/19 atoms grant; `/tmp/m6-v2/h1-final.test.ts` H1 |
| **HIGH-1″ `taskLabel hasAll []`** | **HIGH (new)** | **STILL OPEN** | *(none — no `rule.empty_enum` branch for `taskLabel`; `compile.ts:457-518`)* | `/tmp/m6-v2/b4-tautology.test.ts` B5; `/tmp/m6-v2/b1-vacuous.test.ts` B6 |
| MED-2 `capability all` fails open on a duplicate | MED → **HIGH** | **fixed** | `src/rules/evaluate.ts:460-485` (`present`/`missing` over the deduped set) | `/tmp/m6-v2/c1-med2.test.ts` C1/C2 — all three set axes |
| MED-3 four restriction members never applied | MED → MED | **STILL OPEN (fix is unreachable)** | `src/rules/evaluate.ts:1888` — `...input` spreads `ruleRestrictions` into a `.strict()` schema | `/tmp/m6-v2/h1-final.test.ts` H3; `/tmp/m6-v2/e1-med3diag.test.ts` E1; `grep -rn ruleRestrictions tests/` → **0 hits** |
| MED-3′ `preApprovalClearedDefault` suppresses a rule's dispatch demand | MED (latent) | **STILL OPEN (unreachable today)** | `src/rules/evaluate.ts:1929` | by inspection; unreachable until MED-3 is completed |
| MED-4 store hands adapters the live envelope | MED → MED | **fixed** | `src/notifications/store.ts:451`; `src/notifications/bus.ts:284` | `/tmp/m6-v2/f1-med4.test.ts` F1–F7 |
| MED-5 replay installs caller state over ceiling | MED → MED | **fixed** | `src/budgets/recovery.ts:629-797` | `/tmp/m6-v2/g2-med5.test.ts` G1/G2 — 13 attacks, no over-install, no wedge |
| MED-5b `releasedUnits` on `held → committed` | LOW → LOW | **fixed** | `src/budgets/ledger.ts:463` | `/tmp/m6-v2/g2-med5.test.ts` G3 — index agrees with list at 4 checkpoints |
| MED-5c a store that reports success but moves nothing | MED → MED | **fixed** | `src/budgets/recovery.ts:399-420` (R18, `RecoveryReport.unverified`) | `/tmp/m6-v2/g2-med5.test.ts` G4 |
| LOW-6 `eligible()` ignores `leaseExpiresAt` | LOW | accepted (documented) | — | §3 LOW-6, unchanged |
| LOW-7 two `pre_approve` actions in one rule | LOW | **accepted, unreported** | `src/rules/compile.ts:810-846` | §3 LOW-7, unchanged |
| LOW-8 `.strict()` accepts own `__proto__` | LOW | accepted (upstream) | — | §3 LOW-8, unchanged |
| LOW-9 no production caller (LOW-9 / S-1) | LOW | **STILL OPEN** | — | §0.4 — re-verified this revision |
| NEW-1 `ReplayRequest.now` required, typed, unread | LOW (new) | recorded | `src/budgets/recovery.ts:634` | `/tmp/m6-v2/g2-med5.test.ts` G5 |

No LOW finding from the original report changed status. LOW-6/7/8 were reported as
documented consequences rather than defects and are not re-litigated here; I re-ran no
attack against them because the fixes did not touch their code.

### 0.9 What I could not test this revision

1. **Whether the tautology survives the full `simulateDryRun` plan.** I confirmed it
   produces a granted pre-approval candidate from `evaluateRules` (H2), which is what the
   plan consumes, but I did not drive `src/simulation/plan.ts` end to end with it. The
   ports are the obstacle, not the finding.
2. **`evaluateWithKernel` under restrictions, working.** Untestable — the path throws
   (§0.3). Every statement I make about the ordering guard and the recomposition is a
   statement about unreachable code, read from source.
3. **The three LOW findings.** Not re-attacked; the fixes did not touch `compile.ts:810-846`,
   `ledger.ts:676-678`, or the Zod version.
4. **Cross-machine routing determinism, a durable `BudgetLedgerStore`, and restart of a real
   process.** Carried forward unchanged from §4. Every atomicity result above is a property
   of `InMemoryBudgetLedgerStore`.

### 0.10 Revision command output

```
$ bun test

 5032 pass
 4 skip
 0 fail
 92829 expect() calls
Ran 5036 tests across 216 files. [16.50s]

$ bun run typecheck
$ tsc -p tsconfig.json --noEmit
exit=0

$ bun run build
$ rm -rf dist && tsc -p tsconfig.build.json
exit=0

$ git diff --check
exit=0 (clean)
```

`5032 pass / 0 fail` is the same count as before this revision and is **not** evidence for
any fix in §0. Two of the five fixes have no test that touches them. Revision probes, all
outside the repository:

```
$ for f in /tmp/m6-v2/*.test.ts; do bun test "$f"; done
b1-vacuous.test.ts                  1 pass  0 fail
b2-kernel.test.ts                   3 pass  0 fail
b4-tautology.test.ts                3 pass  0 fail
b7-disclosure.test.ts               1 pass  0 fail
c1-med2.test.ts                     2 pass  0 fail
d1-med3.test.ts                     5 pass  0 fail
e1-med3diag.test.ts                 3 pass  0 fail
f1-med4.test.ts                     7 pass  0 fail
g2-med5.test.ts                     6 pass  0 fail
h1-final.test.ts                    3 pass  0 fail
```

All assertions are written to *expect the defect* where one remains (`expect(set.ok).toBe(true)`
on the tautology; `expect(withIt.ok).toBe(false)` on MED-3), so a future fix turns them red
rather than silently passing. The original `/tmp/m6-audit/` probes were re-run unchanged
where a finding was revisited, so the before/after rows above are the same assertions.

---

## 1. Verdict (ORIGINAL, 2026-10-01 — superseded where §0 disagrees)

**PASS WITH FINDINGS. The safety floor itself holds; the pre-approval restriction does not.**

Every escalation the milestone claims is unrepresentable is unrepresentable, and I could
not break it by any route I tried: prototype inheritance (own key absent, value on the
prototype chain), `__proto__` smuggling, `constructor`/`prototype` keys, numeric strings,
`NaN`, `Infinity`, `-0`, floats past the bound, duplicate JSON keys, and a hostile
`PermissionNarrowing` fed straight into `narrowPolicyState`. `allowDestructiveEffects` and
`allowExternalEffects` are refused as `z.literal(false)` violations by the *parser*, not by
a handler; `SAFETY_FLOOR` is `deepFreeze`d and `safetyFloorSchema.parse` refuses both
escalation flags and `requireApprovalForDispatch: false`. **No user-authored rule can widen
the safety floor.** That part of the deliverable is met.

The completion criterion "Security review finds no approval, mutation, or budget bypass" is
**not** met, and neither is the plan's Guardrail *"Do not support 'match all
projects/nodes/capabilities' pre-approval in the initial release."* The compiler's
universal-predicate check counts whether a scope field **appears** in the predicate tree, not
whether the predicate **constrains** anything. Seven scope-bearing shapes that are vacuous
over their entire legal domain compile and grant: `not(projectId eq <a project that does not
exist>)`, `roleVersion gte 1`, `contextSensitivity maxRankAtMost prohibited`,
`taskLabel lacks [<a label nobody sets>]`, `capability none [<a capability nobody requests>]`,
`nodeAdvertisedCapability none [gpu]`, and `dependencyOutcome none`. I ran each through
`evaluateRules` and then through the kernel's own `evaluatePolicy` via `evaluateWithKernel`:
**all five return `allow` with `outstandingApprovals: []`.** One authored rule, one activation,
zero further edits: the safety floor's `requireApprovalForDispatch` stops applying to every
dispatch in the project. **This is HIGH-1 below, and it is the finding that matters.**

Three more real defects sit behind it: a fail-open in `capability all` that a duplicated
member turns into a *wider* pre-approval than the disclosure displays (MED-2); four members
of `require_approval`/`add_restrictions` that the compiler computes, digests, and names in
`unprojectedNarrowing` and that the shipped composition then never applies (MED-3); and a
notification store that hands adapters the live stored envelope, so an adapter rewrites the
operator's inbox (MED-4). Budget atomicity, routing eligibility, template immutability, the
dry-run sinks, ReDoS bounds, and notification totality all hold under test — the reasons are
in the table.

One framing caveat that belongs in the verdict rather than in residual risk: **nothing in
`src/` outside `src/simulation/**` and `src/rules/tui/**` imports any of the six M6 modules.**
`src/application/local-project-registry.ts:124` still returns `ruleSnapshots: []`, and
`src/server/routes/**` and `src/cli.ts` name none of them. So HIGH-1 and MED-2/MED-3 are
reachable from a future caller and from the simulator today, and **not** from the shipped
`POST /approve` → `start` path. The M6 guarantee is vacuously held on the production path for
the same reason M5's was (M5 isolation audit §S-1). I am reporting the language defects at
their real severity and flagging the reachability, because the deliverable is a claim about
the rule language and a language defect is a live defect the moment the seam is wired.

---

## 2. Attack surface tested

> **Verdict column as of 2026-10-01, retained unchanged.** Rows 6.6, 6.7, 11.1 and 12.1
> still read FAIL and are still FAIL in substance: the same attacks still succeed. What
> changed is *why*. 6.6/6.7 now fail on `any(A, not A)` and `taskLabel hasAll []` rather
> than on the nine shapes named in HIGH-1; 11.1 fails because the fix throws rather than
> because it is absent; 12.1 is closed. See §0.8.

31 claims. PASS = I attempted the attack and it was refused; FAIL = the attack succeeded.

| # | Claim | Verdict | Evidence |
| --- | --- | --- | --- |
| **1. Safety-floor bypass** | | | |
| 1.1 | `pre_approve.allowDestructiveEffects` cannot be set to `true`/`1`/`"true"`/`null`/`{}`/`[]` | PASS | `a1-floor.test.ts` "A1.1 escalation fields are literals, by attempt" — 14/14 refused; `src/rules/types.ts:834-835` |
| 1.2 | `add_restrictions.allow*Effects` cannot be set to `true`/`1`/`"true"` | PASS | `a1-floor.test.ts` "A1.2"; `src/rules/types.ts:859-860` |
| 1.3 | `maximumTimeoutSeconds` above `SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS` (3600) | PASS | `a1b.test.ts` "timeout bound is 3600, and 3601 is refused"; `src/rules/types.ts:833` |
| 1.4 | Timeout as string / `null` / `undefined` / `true` / array / `{valueOf}` | PASS | `a1-floor.test.ts` "A1.4 timeout as a coercion" — 7/7 refused |
| 1.5 | Escalation via **prototype inheritance** (own key absent, `true` on the chain) | PASS | `a1b.test.ts` "REFUTE: escalation via PROTOTYPE INHERITANCE" — `ruleActionSchema.safeParse` fails; Zod reads the inherited `true` and `z.literal(false)` refuses it |
| 1.6 | `__proto__` smuggling an escalation at document or action level | PASS (value dropped) | `a1d-proto.test.ts` — compiled action is `allowDestructiveEffects: false`, `kernelRule.effect` unchanged, `Object.prototype` not polluted |
| 1.7 | `constructor` / `prototype` keys | PASS | `a1-floor.test.ts` "A1.5" — `rule.invalid_source` |
| 1.8 | Duplicate JSON keys smuggling `allowDestructiveEffects: true` | PASS | `a1-floor.test.ts` "A1.6" — last-wins `true` refused |
| 1.9 | Numeric overflow / `NaN` / `±Infinity` / `-0` / `0.5` / `2^53` on all four bound fields | PASS | `a1c.test.ts` — 0 accepted out of 64 attempts (the one acceptance in an earlier run was `maximumRetryLimit: 0`, which is legal) |
| 1.10 | `SAFETY_FLOOR` is frozen and `safetyFloorSchema` refuses `requireApprovalForDispatch: false` | PASS | `a1-floor.test.ts` "A1.7"; `src/orchestration/policy/floor.ts:30-39` |
| 1.11 | `narrowPolicyState` cannot widen from a hostile layer | PASS | `a1-floor.test.ts` "A1.8" — `allowDestructiveEffects`/`allowExternalEffects` stay `false`, ceiling stays 900, 3 `wideningAttempts` recorded; `src/orchestration/policy/floor.ts:165-195` |
| **2. Approval bypass by mutation** | | | |
| 2.1 | A hand-built approval with a wrong digest does not bind | PASS | `a2.test.ts` "REFUTE: forged approval with wrong digest" → `invalidated` |
| 2.2 | An approval whose `basis` names a rule absent from the envelope | PASS | `a2.test.ts` — `approval.unknown_rule_basis`; `src/orchestration/policy/approval.ts:37-44` |
| 2.3 | An approval whose `basis` names a `restrict` rule present on the envelope | PASS | `a2.test.ts` — `approval.ineligible_rule_basis`; `src/orchestration/policy/approval.ts:45-51` |
| 2.4 | A rule edit invalidates an existing rule-basis approval | PASS | `a2.test.ts` "REFUTE: rule-snapshot swap invalidates…" → `["approval.digest_mismatch","approval.unknown_rule_basis"]` |
| 2.5 | `createApproval` refuses `approved` for a `require_approval` evaluation | PASS | `a2.test.ts` — `policy.approval_not_satisfiable`; `src/orchestration/policy/approval.ts:69-76` |
| **3. Preview/runtime divergence (Stop Condition 1)** | | | |
| 3.1 | No second matcher / parser / conflict resolver exists | PASS | `grep` for `satisfaction` outside `src/rules/{evaluate,types}.ts` returns one line, a render call in `src/rules/explain.ts:166`; `preview.ts:930-932` calls `evaluateRules`; `src/rules/evaluate.ts:1223` is the sole entry point. `1672 pass` across `tests/unit/{rules,budgets,workflows,routing,simulation,notifications}` including `preview-divergence.test.ts` |
| 3.2 | Default installation still requires approval for every dispatch | PASS | `a3d-defaults.test.ts` — `everyDispatchRequiresApproval: true`; `src/simulation/plan.ts:1198-1201` |
| 3.3 | Draft / disabled / expired / superseded rules never reach `kernelRules` | PASS | `a3d-defaults.test.ts` — 4 cases, `kernelRules.length === 0`; a *disabled* v2 does not supersede a live v1 (`src/rules/evaluate.ts:812-832`) |
| **4. Retroactive edit (Stop Condition 2)** | | | |
| 4.1 | Template edits do not mutate an instantiated snapshot | PASS | `a4b.test.ts` — snapshot byte-identical after two `updateTemplate` calls, digest unchanged, frozen, mutation `TypeError`; `src/workflows/repository.ts:20-27` |
| 4.2 | `getTemplate` returns a clone, so caller mutation cannot reach the store | PASS | `a4b.test.ts` — store title still `Build` |
| 4.3 | Cross-project instantiation refused | PASS | `a4b.test.ts` — `src/simulation/expand.ts:252-259` |
| 4.4 | Role containment refuses a step asking for a capability the role lacks | PASS | `a4b.test.ts` — `workflow.capability_exceeds_role` |
| **5. Budget atomicity (Stop Condition 3)** | | | |
| 5.1 | Zero / negative / fractional / `NaN` / `±Infinity` / `"1"` units refused before any state read | PASS | `a5-ledger.test.ts` "REFUTE: L3"; `src/budgets/ledger.ts:599-605` |
| 5.2 | 40 concurrent reserves against a ceiling of 4 admit exactly 4 | PASS | `a5-ledger.test.ts` — `heldUnits === 4` |
| 5.3 | 2 000-reserve interleaved storm never overshoots and always drains to 0 | PASS | `a5-ledger.test.ts` — admitted 1000 / refused 1000, held 0 |
| 5.4 | Re-entering the critical section throws and leaves state untouched | PASS | `a5-ledger.test.ts` — `InvariantViolationError`, `store.list().length === 0`; `src/budgets/ledger.ts:352-357` |
| 5.5 | One reservation per dispatch, across `reservationId`s | PASS | `a5-ledger.test.ts` — `budget.dispatch_already_reserved` |
| 5.6 | An unbounded scope is refused, not treated as unlimited | PASS | `a5-ledger.test.ts` — `budget.scope_unbounded`; `src/budgets/ledger.ts:619-626` |
| 5.7 | Reservation objects are frozen | PASS | `a5-ledger.test.ts` — mutation `TypeError`; `deepFreezeBudgets` |
| 5.8 | Transitions are idempotent and cannot resurrect `held` | PASS | `a5-ledger.test.ts` — `release` twice reports `changed:false`; `commit` after `release` leaves state `released` |
| 5.9 | Recovery retains a running dispatch with a valid lease; reclaims only on terminal state or expired lease; sweep is idempotent | PASS | `a5b-recovery.test.ts` — 3 cases; `src/budgets/recovery.ts:192-210` |
| 5.10 | Replaying the same durable log twice does not double-count | PASS | `a5c.test.ts` — held stays 2, further reserve `budget.scope_saturated` |
| **6. Universal pre-approval (Stop Condition: no "match all")** | | | |
| 6.1 | Empty predicate list, `all([])`, nested `all(all(all([])))`, `not(all())`, `not(not(all()))` | PASS | `a6-universal.test.ts` — all `rule.universal_pre_approval` |
| 6.2 | Shape-only predicates (`timeoutSeconds <= 3600`, `taskTitlePattern`, `fanOut/concurrency/retry`) | PASS | `a6-universal.test.ts` — all refused |
| 6.3 | Empty-string identifier, `*` wildcard as capability/projectId | PASS | `a6-universal.test.ts` — `rule.invalid_source` (token alphabet) |
| 6.4 | `not(not(projectId eq p))` | PASS | `a6-universal.test.ts` — compiles; evaluate-side involutivity on unknowns holds (`src/rules/evaluate.ts:701-703`) |
| 6.5 | Universal rule permitted for the four restriction kinds | PASS | `a6-universal.test.ts` — all four compile |
| 6.6 | **A scope-bearing but vacuous pre-approval is refused** | **FAIL** | **HIGH-1** — `a6b.test.ts` "VACUOUS-SCOPE PRE-APPROVALS" |
| 6.7 | **A vacuous pre-approval actually clears the floor** | **FAIL** | **HIGH-1** — `a6c.test.ts`: kernel `allow`, `outstanding: []` for 5 of 5 shapes |
| **7. Code execution / unbounded regex** | | | |
| 7.1 | 12 catastrophic-backtracking patterns refused at compile | PASS | `a7-redos.test.ts` — `(a+)+$`, `(a\|aa)*$`, `(x+x+)+y` all `rule.pattern_refused` |
| 7.2 | Patterns over `MAX_RULE_PATTERN_LENGTH` (128) refused | PASS | `a7-redos.test.ts` — 128 accepted, 129 refused |
| 7.3 | An *accepted* nested-bounded-quantifier pattern cannot hang | PASS | `a7b.test.ts` — `(a{1,50}){1,50}` evaluates in 1.4 ms; subject capped at 256 (`rule.match_subject_too_long`) |
| 7.4 | 20 000-deep `not` chain, 50 000-deep array nesting, and a cyclic predicate object are contract errors, not stack overflows | PASS | `a7-redos.test.ts` — 3 cases, all `rule.limit_exceeded`, none threw; `src/rules/compile.ts:159-222` |
| 7.5 | 200-member set / 600-rule set refused | PASS | `a7-redos.test.ts` — `rule.limit_exceeded` |
| 7.6 | No `new RegExp` on rule text outside the bounded analyser | PASS | `grep` — the only hit in `src/rules/**` is a docblock at `src/rules/preview.ts:92` |
| **8. Secret leakage (Stop Condition)** | | | |
| 8.1 | Six canaries absent from `renderRuleExplanation`, the disclosure, and the preview; audit returns `[]` | PASS | `a8-secrets.test.ts`; negative control returns 3 findings |
| 8.2 | Canaried dry run: every snapshot canary absent from the plan | PASS | `a8b.test.ts` — all sink counters 0 except `budgetReservationAttempts: 2`; `retainedReservations: 0` |
| 8.3 | The step title that reaches the M0 envelope `prompt` field does not reach the plan | PASS | `a8b.test.ts` "STEP TITLE reaches the M0 envelope prompt field" — canary absent from `JSON.stringify(plan) + explanationText`; `src/simulation/plan.ts:1007` |
| 8.4 | Node `displayName` never reaches a routing explanation | PASS | `a10-routing.test.ts` — `describeExclusion` reads no node free text; `src/routing/rank.ts:169-202` |
| 8.5 | The notification envelope schema refuses an unknown content field | PASS | `a9-notifications.test.ts` "unknown keys are refused (strict)"; `src/notifications/types.ts:305-320` |
| 8.6 | The notification audit's credential-shape detectors fire on unseeded secrets | PASS | `a9c.test.ts` — 4/4 shapes flagged `credential_shape` |
| **9. Notification side effects (Stop Condition 6)** | | | |
| 9.1 | `emit` is total against a throwing adapter, a throwing `available`, an `undefined` result, a rejection, and a malformed request | PASS | `a9-notifications.test.ts` "emit is total" — 4 results, no throw, malformed → `[]`; `src/notifications/bus.ts:185-224` |
| 9.2 | Dedupe is by `dedupeKey`, and a duplicate is not re-delivered | PASS | `a9-notifications.test.ts` — `delivered: ["same","different"]` |
| 9.3 | `src/notifications/**` has no upward import edge | PASS | source scan: zero `from "../` specifiers in the module; every `orchestration` mention is prose |
| 9.4 | **A notification payload cannot reach a place that could mutate it** | **FAIL** | **MED-4** — `a9b.test.ts` "an adapter can rewrite the envelope the STORE holds" |
| **10. Routing bypass** | | | |
| 10.1 | A preference naming revoked / unauthorized / path-less / capability-less / unhealthy / declined / full nodes selects none of them | PASS | `a10-routing.test.ts` — selects `node-good`, 7 `preferenceIgnored`; `src/routing/rank.ts:392-397` |
| 10.2 | `excludedNodeIds` is a hard exclusion | PASS | `a10-routing.test.ts` |
| 10.3 | Determinism over 50 permutations | PASS | `a10-routing.test.ts` — one digest, always `n1` |
| 10.4 | A rule's `select_routing_preference` cannot route to an ineligible node | PASS | `a10-routing.test.ts` — `requiredRuntimeKind`/`requiredProjectPathId` demote rather than exclude (`src/routing/rank.ts:289-300`) |
| **11. Rules the evaluator does not enforce** | | | |
| 11.1 | **Four `require_approval`/`add_restrictions` members are enforced** | **FAIL** | **MED-3** — `a3-unenforced.test.ts` |
| **12. Predicate correctness** | | | |
| 12.1 | **`capability all` fails open on a duplicated member** | **FAIL** | **MED-2** — `a3b-all.test.ts` |

---

## 3. Findings

### HIGH-1 — A "match all" pre-approval compiles and clears the safety floor

> **Disposition 2026-10-02 — PARTIALLY FIXED, HIGH-1 STILL OPEN. The nine shapes named
> below are all refused at compile (`src/rules/compile.ts:561-686`). A predicate that is a
> logical tautology — `any(A, not A)` — compiles, is DISCLOSED as scoped to one project,
> and clears the safety floor identically. See §0.2.**

**`src/rules/compile.ts:543-557`** (`checkNotUniversal`), with the contradiction at
**`src/rules/explain.ts:353-355`**.

`checkNotUniversal` builds a `Set` of every `field` name in the predicate tree and refuses
only if *none* of ADR §8's twelve scope fields appears:

```ts
const fields = new Set(walkPredicates(document.predicates).map((predicate) => predicate.field))
const constraining = NON_UNIVERSAL_PREDICATE_FIELDS.filter((field) => fields.has(field))
if (constraining.length > 0) return { ok: true, value: true }
```

The ADR text says the rule must "have at least one predicate that **constrains** one of"
those fields. The code asks whether one **mentions** one. Seven legal predicates mention a
scope field and constrain nothing over its entire legal domain, because the domain's
interior or complement is what they name:

| Authored predicate | Why it constrains nothing | Value range |
| --- | --- | --- |
| `not(projectId eq "proj-does-not-exist")` | excludes one id nobody holds | all `ProjectId` |
| `roleVersion gte 1` | names the bottom of the range | `1..1000` |
| `roleVersion between 1 and 1000` | names the whole range | `1..1000` |
| `contextSensitivity maxRankAtMost 3` | `prohibited` is the top rung | 4 rungs |
| `contextSensitivity maxRankAtLeast 0` | `public_to_project` is the bottom rung | 4 rungs |
| `taskLabel lacks ["never-set"]` | asserts absence | any labels |
| `capability none ["never-requested"]` | asserts absence | any capabilities |
| `nodeAdvertisedCapability none ["gpu"]` | asserted absence, and `satisfied` when the snapshot is `null` (`src/rules/evaluate.ts:449-453`) | any |
| `dependencyOutcome none` | true of every dependency-free task | any |

**Reproduction** (`/tmp/m6-audit/a6c.test.ts`, five of five grant):

```ts
const doc = (preds) => ({
  languageVersion: 2, ruleId: "rule-u", templateVersion: 1, projectId: "proj-1",
  name: "n", description: "d", enabled: true,
  activation: { state: "activated", activatedAt: "2026-01-01T00:00:00Z", activatedBy: { kind: "user", userId: "user-1" } },
  predicates: preds,
  actions: [{ kind: "pre_approve_within_bounds", approvedCapabilities: ["fs.read"],
              maximumTimeoutSeconds: 3600, allowDestructiveEffects: false,
              allowExternalEffects: false, maximumSensitivity: "prohibited" }],
  expiresAt: null, author: { kind: "user", userId: "user-1" }, createdAt: "2026-01-01T00:00:00Z",
})
const set  = compileRuleSet([doc([{ field: "not", predicate: { field: "projectId", operator: "eq", value: "proj-does-not-exist" } }])])
const ev   = evaluateRules(set.value, context)                       // traces[0].matchOutcome === "matched"
const composed = evaluateWithKernel({ envelope, taskTitle: "t" }, set.value, ev.kernelRules)
// composed.value.decision === "allow", composed.value.outstandingApprovals === []
```

Control: the same envelope with `compileRuleSet([])` returns `require_approval`,
`outstandingApprovals: ["dispatch_approval"]`. One activated rule is the whole delta.

The kernel grants because its own re-check (`src/orchestration/policy/evaluate.ts:527-618`)
is answering a *different* question — "is this dispatch inside the rule's declared
bounds?" — and the M6 predicate is invisible to it. `projectKernelMatch`
(`src/rules/compile.ts:735`) reads only the top-level `capability any`, `runtimeKind`, and
`taskTitlePattern`; none of the nine shapes above projects anything, so `match` is `{}` and
the kernel independently "confirms" a rule whose predicate it cannot read. The projection's
under-approximation is sound by construction and correct; the gap is that the *only* thing
standing between a vacuous predicate and a fleet-wide grant is a `Set.has(field)`.

**Compounding it: the module disagrees with itself.** `src/rules/compile.ts:532-542`
deliberately counts a `not` as constraining and argues the refusal would be unintelligible
otherwise. `src/rules/explain.ts:353-355` says the opposite about the same construct:

```ts
case "not":
  // A negation constrains nothing to a known set.
  break
```

So the disclosure the plan requires before activation reports `reach.projects` as
`{ kind: "unknown" }` — a correct warning — while the compiler that gates the activation
already said yes. A rule author reading the disclosure is told the reach is unbounded; a
rule author reading the ADR is told `not` counts. The stricter of the two statements is the
one in the disclosure, and it is the one with no enforcement behind it.

**Impact.** One user-authored, explicitly activated, non-expiring rule replaces the safety
floor's per-dispatch approval requirement for every dispatch in a project. Plan Guardrail:
*"Do not support 'match all projects/nodes/capabilities' pre-approval in the initial
release."* ADR §8: *"A document that violates it is refused at compile time with a named
code."* Neither holds. This is the single most valuable finding in this review: it is an
ADR claim the shipped compiler does not enforce, and it is not a hardening suggestion — it
is the milestone's headline automation safety property.

**Reachability.** Not reachable from the shipped dispatch path: nothing outside
`src/simulation/**` imports `src/rules`, and `src/application/local-project-registry.ts:124`
returns `ruleSnapshots: []`. Reachable today from the simulator, and from any caller that
composes a rule set. **Disposition: report, do not fix.** The fix belongs in
`checkNotUniversal` and needs the ADR amendment the Stop Conditions require.

---

### MED-2 — `capability all` fails open on a duplicated member, and the disclosure under-reports the reach

> **Disposition 2026-10-02 — FIXED. The severity below is wrong and is corrected upward:
> this was a fail-open pre-approval matcher (MED → HIGH), not a disclosure defect. Fixed at
> `src/rules/evaluate.ts:460-485` and verified on `capability`, `toolCategory` and
> `nodeAdvertisedCapability`. See §0.5.**

**`src/rules/evaluate.ts:468`**, enabled by **``src/rules/types.ts:151-153`**.

```ts
const declared = membersOf(predicate.value)          // new Set(value) — de-duplicated
const present  = predicate.value.filter((m) => actual.includes(m))   // counted WITH multiplicity
…
case "all":
  return present.length === declared.size
```

`memberList` applies no uniqueness refinement, so `["fs.read", "net.fetch", "fs.read"]` is
schema-valid. Then `present.length` can reach `declared.size` (2) with `fs.read` matching
twice and **`net.fetch` absent entirely**.

**Reproduction** (`/tmp/m6-audit/a3b-all.test.ts`), against
`capability all ["fs.read","net.fetch","fs.read"]`:

```
request ["fs.read"]              -> match=matched        <-- intended: not_matched
request ["fs.read","net.fetch"]  -> match=not_matched    <-- intended: matched
request ["net.fetch"]            -> match=not_matched
request []                       -> match=not_matched
```

Control, without the duplicate, behaves correctly: `[fs.read] → not_matched`,
`[fs.read,net.fetch] → matched`. The same defect is reachable on `toolCategory all` and
`nodeAdvertisedCapability all`. `taskLabel hasAll` is **not** affected — it compares
`present.length === wanted.length`, both arrays with multiplicity — which is the control
that shows the bug is in the `Set`/`array` mismatch and not in the concept.

**Impact.** A pre-approval whose disclosed scope is "requests that ask for both `fs.read`
and `net.fetch`" fires on requests that ask for `fs.read` only, and refuses the requests it
was written for. `buildPreApprovalDisclosure` reports
`reach.capabilities = { kind: "constrained", values: ["fs.read","net.fetch"] }` — it
de-duplicates (`src/rules/explain.ts:374`), so the disclosure states a *narrower* reach than
the rule has. That is ADR Stop Condition 5's shape: *"a compiled rule set is found to admit
an action whose bounds are wider than the bounds the disclosure displayed."* `normalizedPredicate`
does show the raw list including the duplicate, so the information exists — but the field
the plan's disclosure table names for "capabilities it can match" does not carry it.

**Disposition: report, do not fix.** One-line fix in the evaluator (compare sets, not
lengths) or a uniqueness refinement in `memberList`; either changes accepted documents, so
it needs the same review the ADR requires.

---

### MED-3 — Four restriction members are compiled, digested, named in `unprojectedNarrowing`, and then never applied

> **Disposition 2026-10-02 — NOT FIXED. The `ruleRestrictions` parameter added to
> `evaluateWithKernel` is spread into a `.strict()` schema and every call that supplies it
> returns `Err`. The four members are still unenforced; zero tests touch the parameter.
> See §0.3.**

**`src/rules/evaluate.ts:1849`** (`evaluateWithKernel`) versus
**`src/rules/evaluate.ts:1807`** (`narrowWithRuleRestrictions`), with the omission named at
**`src/rules/compile.ts:890-903`**.

`evaluateWithKernel` is the module's only composition entry point. It passes
`kernelRules` into `evaluatePolicy` and never reads `result.restrictions` — so it never calls
the adapter it exports for exactly that purpose. The four members the M0 `restrict` effect
cannot carry are computed and carried (`RuleRestrictionComposition`) but inert:

| Action member | In `restrictions` | Named `unprojected` | Enforced by `evaluateWithKernel` |
| --- | --- | --- | --- |
| `require_approval.requireApprovalForDispatch` | yes | yes | **no** |
| `require_approval.requireApprovalForCapabilities` | yes | yes | **no** |
| `add_restrictions.allowedCapabilities` | yes | yes | **no** |
| `add_restrictions.maximumTimeoutSeconds` | yes | yes | **no** |
| `require_approval.requireApprovalForDestructiveEffects` | yes | no | yes (projects to the M0 effect) |

**Reproduction** (`/tmp/m6-audit/a3-unenforced.test.ts`): a rule with
`actions: [{ kind: "add_restrictions", allowedCapabilities: ["fs.read"] }]`, a dispatch
requesting `["fs.read","net.fetch"]`:

```
restrictions.allowedCapabilities: [ "fs.read" ]
unprojected:                     [ "allowedCapabilities" ]
kernelRule.effect:               { kind:"restrict", deniedCapabilities: [] }   // the field has no M0 home
kernel effective allowedCapabilities after evaluateWithKernel: [ "fs.read", "net.fetch" ]
```

Control: calling `narrowWithRuleRestrictions(base.effective, result.restrictions)` by hand
does reduce the state to `["fs.read"]` — the adapter works, it is simply never called.

**Impact.** This is the failure mode ADR §7.3.1 refuses by design — *"a dropped narrowing
action makes the rule weaker than it reads"* — arriving through a different door. A user
writes "allow only `fs.read` here", the rule compiles, is digested, appears in the preview,
and the kernel dispatches `net.fetch` anyway. ADR §7.2's claim that `require_approval`
"projects into `kernelRule` as a `restrict` effect, so the M3 engine enforces it with its
existing approval accounting" is false for the two `require_approval` members named above;
`compile.ts:779-789` documents the limitation, `explain.ts:102-106` renders it into the
explanation as `restrictionsNotProjectedIntoTheKernel:` — and then nothing acts on it.

**Direction.** Not a floor bypass. `SAFETY_FLOOR_NARROWING` demands dispatch approval
unconditionally and `dispatchApprovalDemands` is a monotone union
(`src/orchestration/policy/floor.ts:159-161`), so dropping a rule's `requireApprovalForDispatch`
cannot clear the floor's demand, and `mayClearDefault` requires
`onlyFloorDemands` (`src/orchestration/policy/evaluate.ts:571`). Verified: a rule declaring
`requireApprovalForCapabilities: ["net.fetch"]` still yields
`outstanding: ["dispatch_approval"]`. The impact is a user-authored restriction being
unenforced — a rule weaker than it reads — which is availability and audit-integrity, not
confidentiality.

**Disposition: report, do not fix.** Wiring `narrowWithRuleRestrictions` into
`evaluateWithKernel` is a composition decision the ADR did not make and this review will not
make unilaterally.

---

### MED-4 — The notification store hands adapters the live stored envelope

> **Disposition 2026-10-02 — FIXED. `publish` clones and deep-freezes on write
> (`src/notifications/store.ts:451`) and `deliverOne` gives each adapter its own frozen clone
> (`src/notifications/bus.ts:284`). All nine mutation vectors I tried, including
> `Object.defineProperty` and `setPrototypeOf`, throw. See §0.6.**

**`src/notifications/store.ts:288-317`** (`publish`), **`:273-285`** (`ordered`, returned by
`list`/`entries`), **`:344-346`**; reached from **`src/notifications/bus.ts:201`** and
**`:295`**.

`publish` validates with `notificationEnvelopeSchema.safeParse` and then deliberately stores
the **original object** rather than Zod's copy — N4, "the envelope is stored verbatim", argued
at `store.ts:290-297`. The same object is then handed to every adapter. Nothing in
`src/notifications/**` freezes an envelope, an entry, or an array it returns; the only
`Object.freeze` calls in the module are on constant lookup tables
(`store.ts:225,402-405`, `tui-adapter.ts:128,138,185,602,696`).

**Reproduction** (`/tmp/m6-audit/a9b.test.ts`):

```
before: {... "runId":"run-real","ruleId":"rule-real","reasonCode":"policy.denied","summary":"original" ...}
adapter sets env.runId="run-forged"; env.ruleId="rule-forged"; env.reasonCode="silent.ok";
        env.summary="nothing happened"; env.createdAt="2099-01-01T00:00:00.000Z"
after : {... "runId":"run-forged","ruleId":"rule-forged","reasonCode":"silent.ok","summary":"nothing happened","createdAt":"2099-01-01..."}

store.list()[0].envelope === the object handed to the adapter   ->  true
Object.isFrozen(that envelope)                                 ->  false
```

A second consequence of the same aliasing: `byDedupeKey` is keyed on
`envelope.dedupeKey` at publish time (`store.ts:305,308`). Rewriting `dedupeKey` through an
adapter desynchronises the index from the entries, so `findByDedupeKey` answers about a key
the inbox no longer holds and the next notification with the original key is stored as a
second entry rather than deduplicated.

**Impact.** The operator's inbox — what they are told was blocked, which run, which rule —
is writable by any adapter. `summary`, `runId`, `taskId`, `dispatchId`, `nodeId`, `ruleId`,
`reasonCode`, `category`, `severity` and `createdAt` are all reachable. A notification can be
retitled "nothing happened", re-attributed to a different run or rule, or dated forward
past the retention window so `expire()` (`store.ts:263-271`) drops it silently.

**What this is not.** It cannot reach orchestration state. N1 holds: `src/notifications/**`
imports nothing at all (`grep` finds zero `from "../` specifiers; every occurrence of
"orchestration" in the module is prose), `emit` is total (claim 9.1), and the bus is handed a
store and adapters and no orchestrator. It is also inconsistent with the rest of the
milestone's own discipline: `src/workflows/repository.ts:20-27` deep-freezes on write *and*
clone-on-read for exactly this hazard, and `src/budgets/ledger.ts` `deepFreezeBudgets` every
reservation it returns. The notification store is the one M6 store that hands out live
mutable objects.

**Reachability.** No adapter is shipped but one: `src/notifications/tui-adapter.ts`, the
in-TUI renderer, which does not mutate. The attack needs a future external adapter — which
ADR §17 explicitly invites ("an optional adapter interface exists so that a future external
sink can be added"). Severity is calibrated to that: the interface that makes the attack
possible is shipped, and nothing in the store defends against it.

**Disposition: report, do not fix.** The fix is a `structuredClone` on publish or a deep
freeze, and it changes N4's stated contract — the milestone lead's call.

---

### MED-5 — `restore` and `replayDurableReservations` install caller state with no ceiling re-check

> **Disposition 2026-10-02 — FIXED, plus the two further defects the fix surfaced are also
> fixed. `replayDurableReservations` is now a second admission decision that refuses
> over-ceiling, duplicate and undeclared rows and RETURNS capacity. Verified on 13
> adversarial logs. See §0.7.**

**`src/budgets/ledger.ts:495-497`** and **`src/budgets/recovery.ts:387-403`**.

`InMemoryBudgetLedgerStore.restore(state)` replaces `#state` wholesale and is a public method
on an exported class. `replayDurableReservations(target, records, now)` parses each durable
record, recomputes `heldUnits` from the records, and calls `target.restore(...)`. Neither
consults `resolveLimits`, so neither can notice that the restored total exceeds the ceiling
the ledger would have enforced.

**Reproduction** (`/tmp/m6-audit/a5c.test.ts`): a ledger whose `resolveLimits` returns
`{ maximumConcurrency: 1 }`, replayed with five `held` records:

```
replayed 5 against a ceiling of 1 -> held: 5   eligible(d-4): true
index agrees with a recomputed sum? [["proj-1 concurrency", 5]]
```

A further `reserve` is refused (`budget.scope_saturated`), so the ledger is internally
consistent — it simply believes it holds five units against a ceiling of one and reports four
dispatches eligible that its own admission path would never have admitted.

`src/budgets/recovery.ts:53-58` states the assumption rather than enforcing it: *"the
rebuild cannot invent capacity, because it restores the same reservations the crashed
process admitted and no others."* For a log this ledger produced, that is true and the
invariant is safe: `reserveInTransaction` is a single synchronous frame (claim 5.2/5.3
confirm it over 2 040 concurrent attempts), so a log it wrote cannot already be over the
ceiling. For a log assembled by hand, restored from another store, or edited on disk, nothing
checks. ADR §13.2's stop condition is *"Stop if the held total for a `(projectId, scope)` can
be observed above its ceiling, by any interleaving, crash, or replay."* Replay is reachable;
the ceiling is not.

**Impact.** Over-admission after recovery, bounded by the size of the durable log. Requires
a caller to hand the ledger a log the ledger did not write.

**Disposition: report, do not fix.** A ceiling re-check at replay time is a design decision
about whether a durable log is trusted input; `restore` is documented as existing for the
crash/replay test and is on a public exported class.

---

### LOW-6 — `eligible()` ignores `leaseExpiresAt`

**`src/budgets/ledger.ts:676-678`.**

```ts
eligible(dispatchId: string): boolean {
  return this.reservationState(dispatchId) === "held"
}
```

A `held` reservation whose lease expired ten minutes ago still reports `eligible: true`
(verified, `/tmp/m6-audit/a5d.test.ts`). This is L1 stated as a definition and argued at
`ledger.ts:74-78` — adding a check there "would reintroduce exactly the check-then-act gap
the design forbids" — and lease reclamation is `recoverLeaked`'s job
(`src/budgets/recovery.ts:192-210`, verified). So it is a documented consequence, not an
oversight. Recorded because "eligible" and "may launch" are not the same predicate, and a
future caller reading only `eligible` inherits the difference. Reclaiming a reservation
whose lease passed while its dispatch is mid-flight is also a capacity-vs-correctness
trade-off that no code path currently makes explicit.

---

### LOW-7 — Two `pre_approve_within_bounds` actions in one rule are permitted

**`src/rules/compile.ts:810-846`** (`projectToKernelRule` takes `preApprovalActions[0]`),
**`src/orchestration/policy/evaluate.ts:601`** (`preApprovalBasis = { ruleId, ruleVersion }`).

ADR §7.3.1 refuses a narrowing action sharing a rule with a pre-approval because *"the M0
`Rule` shape holds exactly one `effect`, so a projection of both would silently drop one."*
The same argument applies to two pre-approvals and is not applied: both compile, both become
`RulePreApprovalCandidate`s, only the first reaches the kernel, and
`preApprovalBasis` cannot record which of the two granted. A recorded approval is therefore
ambiguous about the bounds it was taken under.

Direction is fail-closed in the case I could construct (a narrower first action makes the
kernel's `coversEverything` check fail and the second is never consulted), so this is an
audit-clarity defect rather than a grant defect.

---

### LOW-8 — Zod `.strict()` does not reject an own enumerable `__proto__` key

**Zod 4.4.3.** `src/rules/types.ts:1003-1007` claims an unknown key in a rule document "is a
compile error with a named code, not a field silently dropped on the floor", and that claim
is what makes "I wrote `allowDestructiveEffects: true`" and "I wrote nothing" different
documents. `constructor` and `prototype` are refused (`rule.invalid_source`); an own
enumerable `__proto__` is accepted at both the document and action level and silently
discarded.

Not an escalation. Verified: the compiled action keeps `allowDestructiveEffects: false`,
`kernelRule.effect` is unchanged, `Object.prototype` is not polluted, and the document with
the `__proto__` key **digests identically** to the document without it — so the audit trail
is not fooled either. It is a one-key hole in a strictness property the schema advertises.

---

### LOW-9 — The M6 rule engine has no production caller

> **Disposition 2026-10-02 — STILL OPEN, re-verified from source this revision. Nothing has
> been wired; `local-project-registry.ts:124` still returns `ruleSnapshots: []`; `src/server/**`
> and `src/cli.ts` still name none of the six M6 modules. See §0.4 — this is the most
> important sentence in the report.**

**`src/application/local-project-registry.ts:124`** (`ruleSnapshots: []`);
`grep` across `src/` finds `src/rules/index.js` imported only by `src/simulation/{types,plan}.ts`
and `src/rules/tui/**`; `src/budgets`, `src/routing`, `src/workflows`, `src/simulation` and
`src/notifications` are imported only from within `src/simulation/**` and `src/rules/tui/**`;
`src/server/routes/**` and `src/cli.ts` name none of them. `compileRuleSet`,
`previewCompiledRuleSet`, `simulateDryRun`, `new BudgetLedger`, `rankNodes`,
`createNotificationBus` and `instantiateTemplate` have **no caller in `src/` outside their own
module**.

ADR 0007's Context section records the `ruleSnapshots: []` seam honestly
("`ProfileLocalProjectRegistry` currently returns `ruleSnapshots: []`"), and the digest-binding
machinery that would catch a retroactive edit is genuinely present and tested
(`src/application/service.ts:961-976`, `:986-1004`). The consequence for this review is that
every M6 finding above is a **language and library** finding, not a live bypass of the shipped
approval path. Recorded as S-1's structural twin: the guarantee is vacuously held because
nothing wires the module in.

### Non-findings worth recording

- **Numeric strings are coerced.** `{"maximumTimeoutSeconds": "257"}` compiles to `257`, and
  `{"maximumRetryLimit": "0"}` to `0`. Zod coerces before the bound check, so the coerced
  value is always inside the range and no widening results, and the digest covers the coerced
  number. Cosmetic, but a rule document authored with quoted numbers normalizes to something
  the author did not write.
- **`approvalSchema.parse` returns a mutable object.** A caller holding the returned
  `Approval` can rewrite `envelopeDigest` (rebinding it to an envelope it was never decided
  against) or flip `decision` `rejected → approved`; both verified
  (`/tmp/m6-audit/a2b.test.ts`). This is M0 surface, unchanged by M6, and it is not
  exploitable through the coordinator: `src/orchestration/coordinator/coordinator.ts:643-700`
  re-verifies against the recorded log, checks `recordedDispatch.envelopeDigest` against the
  computed digest, and requires the approval to be one `'approval.decided'` actually decided.
  **Naming the upstream guard, as this review is required to.**
- **`instantiateTemplate` performs no project check.** It has no `projectId` parameter
  (`src/workflows/instantiate.ts:459-466`); `runTemplateSnapshotSchema` carries no `projectId`
  member. The check lives in `src/simulation/expand.ts:252-259` and fires. Noted because a
  future caller invoking `instantiateTemplate` directly would get no scope check at all.

---

## 4. Claims I could not test, and why

1. **Preview/runtime divergence under *change*, not just under test.** Stop Condition 1 says
   halt if the two "are found able to diverge, **including by a change to one of them that
   does not touch the other**." I proved the structural half: one compiler, one
   `CompiledRuleSet`, one `evaluateRules`, one `evaluateCompiledRule` over one
   `evaluatePredicateTree`, no second matcher (source scan), and
   `tests/unit/rules/preview-divergence.test.ts` asserting equality against a direct
   `evaluateRules` call. I cannot prove the *future* half, because a future divergence is not
   a present-state fact. What catches it: `preview.ts` has no branch that decides whether a
   rule matches, so there is nothing there to change out of step.
2. **Cross-machine routing determinism.** Determinism is verified over 50 permutations
   in-process. `Intl.DateTimeFormat` behaviour for a schedule window is version-dependent on
   the host's tzdata — ADR §6.2 anticipates this by recording the zone *as written* and the
   computed instant — but I have one machine and cannot test a second.
3. **A durable-store `BudgetLedgerStore`.** `src/budgets/ledger.ts:120-138` records that the
   production store is in-memory and that a durable implementation is a deferral. The
   `reserveInTransaction(draft, decide)` seam is what would carry `BEGIN IMMEDIATE`, and that
   claim is untested because no durable store exists. Every atomicity result above is a
   property of `InMemoryBudgetLedgerStore`.
4. **Restart and replay of a real process.** Claim 5.10 replays a durable *log* into a fresh
   ledger. I did not kill a process mid-`reserve` and did not exercise a restart path, because
   there is no restart path for budget state in the shipped code.
5. **A notification adapter that reaches the network.** All adapters in these tests are
   in-process. The claim that an external adapter cannot mutate orchestration state rests on
   the import graph, not on a test of a network adapter — and MED-4 is the reminder that the
   graph is not the only surface.
6. **Whether `__proto__` strictness is a Zod bug or a Zod choice.** LOW-8 is reported against
   the observable behaviour, which is what the rule schema depends on. Whether Zod intends to
   fix it is outside this review.

---

## 5. Residual risk

> **Revised 2026-10-02.** The first bullet below predicted HIGH-1 would re-open in a new
> shape, and it did — not through a new scope field, but through the same presence-based
> reasoning applied to a predicate *tree*. MED-2 and MED-4's bullets are now closed as
> written. MED-3's bullet has inverted: the adapter is wired, but into a call that throws.
> §0.8 carries the full status per item.

**What a future change could plausibly break, and what would catch it.**

- **A new scope field on `NON_UNIVERSAL_PREDICATE_FIELDS` re-opens HIGH-1 in a new shape.**
  Any field added to that list is a field whose *vacuous* instances are accepted, because the
  check is presence-based. A field named for a *rank* or an *interval* rather than an
  enumeration is vacuous at its extremes by construction. *Caught by:* a test that asserts a
  pre-approval scoped by each list member is refused when that member's predicate is
  vacuous — the family HIGH-1 belongs to, and which does not exist today.
- **Any future change that de-duplicates `memberList` re-opens MED-2 in a different shape
  rather than closing it.** The bug lives in an evaluator that compares a `Set` size to an
  array length; the same mistake in `compareFieldPredicates`' superset proof would make the
  preview report a `shadowed` that is not one. *Caught by:* the divergence test
  (`tests/unit/rules/preview-divergence.test.ts`) and by the shadowing suite, both of which
  use duplicate-free fixtures.
- **Wiring `evaluateWithKernel` without wiring `narrowWithRuleRestrictions` propagates
  MED-3.** The day a production caller is added, the four unenforced members become live. The
  `unprojectedNarrowing` list is already the right place to hang a check.
  *Caught by:* an assertion that every member of `RuleRestrictionComposition` is either
  projected into `kernelRule` or applied by the composition entry point.
- **A future external notification adapter inherits MED-4 immediately.** ADR §17 invites one.
  *Caught by:* freezing or cloning at `publish`, or by making `NotificationInboxEntry`
  readonly in a way that survives a `structuredClone` at the read boundary.
- **The next M6 module wired into `src/application/` inherits the same vacuity M5 recorded.**
  Nothing forces the wiring to pass a `CompiledRuleSet` through `compileRuleSet`.
  *Caught by:* the source-scan shape already used in `tests/unit/rules/barrel.test.ts` —
  inverted, to assert that the *first* non-simulation caller of `src/rules` is one that also
  applies `narrowWithRuleRestrictions`.
- **The budget ceiling is resolved outside the transaction and is never re-checked**
  (`src/budgets/ledger.ts:616-618`, L9). Verified: a resolver that tightens the budget during
  its own `await` does not affect the in-flight reserve. This is stated and argued, and it is
  a stale-config read rather than a capacity race — but a caller that tightens a budget
  concurrently will over-admit by up to one reservation per in-flight `reserve`.
  *Caught by:* nothing today.
- **`eligible()` and "may launch" diverge once a lease expires** (LOW-6). *Caught by:* a
  caller-side check, or by making `recoverLeaked` part of the launch path rather than a
  startup sweep.

---

## 6. Command output (ORIGINAL, 2026-10-01)

> Superseded by §0.10 for the current suite state. Retained because the before/after test
> counts are the point: `4877 pass` then, `5032 pass` now, `0 fail` in both.

```
$ bun test
 4877 pass   4 skip   0 fail   71833 expect() calls
Ran 4881 tests across 212 files. [24.29s]

$ bun run typecheck
$ tsc -p tsconfig.json --noEmit
exit 0

$ bun run build
$ rm -rf dist && tsc -p tsconfig.build.json
exit 0

$ bun test tests/unit/rules tests/unit/budgets tests/unit/workflows \
           tests/unit/routing tests/unit/simulation tests/unit/notifications
 1672 pass   0 fail   37377 expect() calls
Ran 1672 tests across 45 files. [3.18s]

$ git status --porcelain
(untracked M6 sources and tests only; no tracked file modified by this review)
```

Throwaway proof tests, all outside the repository:

```
$ bun test /tmp/m6-audit/a1-floor.test.ts       8 tests   5 pass  3 fail*   (*assertion bugs in the probe, corrected in a1b/a1c)
$ bun test /tmp/m6-audit/a1b.test.ts            5 pass
$ bun test /tmp/m6-audit/a1c.test.ts            2 pass
$ bun test /tmp/m6-audit/a1d-proto.test.ts      4 pass
$ bun test /tmp/m6-audit/a2.test.ts             6 pass
$ bun test /tmp/m6-audit/a2b.test.ts            2 pass  1 fail*   (*fixture schema error in the probe)
$ bun test /tmp/m6-audit/a3-unenforced.test.ts  5 pass
$ bun test /tmp/m6-audit/a3b-all.test.ts        4 pass
$ bun test /tmp/m6-audit/a3c.test.ts            2 pass
$ bun test /tmp/m6-audit/a3d-defaults.test.ts   5 pass
$ bun test /tmp/m6-audit/a3e.test.ts            1 pass
$ bun test /tmp/m6-audit/a4b.test.ts            4 pass
$ bun test /tmp/m6-audit/a5-ledger.test.ts     13 pass
$ bun test /tmp/m6-audit/a5b-recovery.test.ts   3 pass  2 fail*   (*wrong call signature in the probe; corrected in a5c)
$ bun test /tmp/m6-audit/a5c.test.ts            3 pass
$ bun test /tmp/m6-audit/a5d.test.ts            4 pass
$ bun test /tmp/m6-audit/a6-universal.test.ts   3 pass  1 fail*   (*wrong sensitivity rung name in the probe)
$ bun test /tmp/m6-audit/a6b.test.ts            2 pass
$ bun test /tmp/m6-audit/a6c.test.ts            2 pass
$ bun test /tmp/m6-audit/a7-redos.test.ts       7 pass  1 fail*   (*"a{1,100000}" is bounded, not catastrophic; re-probed in a7b)
$ bun test /tmp/m6-audit/a7b.test.ts            4 pass
$ bun test /tmp/m6-audit/a8-secrets.test.ts     3 pass  1 fail*   (*malformed hand-built dry-run request; re-probed against the shipped fixtures in a8b)
$ bun test /tmp/m6-audit/a8b.test.ts            3 pass
$ bun test /tmp/m6-audit/a8c-tui.test.ts        2 pass
$ bun test /tmp/m6-audit/a9-notifications.test.ts 3 pass  2 fail* (*wrong store constructor; corrected)
$ bun test /tmp/m6-audit/a9b.test.ts            2 pass  2 fail*   (*wrong audit-input key name; corrected in a9c)
$ bun test /tmp/m6-audit/a9c.test.ts            4 pass
$ bun test /tmp/m6-audit/a10-routing.test.ts    5 pass
```

Every `*` failure is a defect in the probe — a wrong fixture field name, a wrong enum
member, a wrong call signature — not a defect in the milestone. Every probe failure was
diagnosed, corrected, and re-run; the four failures that survived diagnosis are HIGH-1,
MED-2, MED-3 and MED-4, and each was reproduced with a second independent probe before being
reported.

No test file was added to `tests/security/m6/`. HIGH-1, MED-2, MED-3, MED-4 and MED-5 are
**assertions the milestone currently fails**, so committing them would turn a green suite
red; each is reproduced in `/tmp/m6-audit/` and cited above with the file and line where the
remedy belongs. That is a deliberate choice: a security review that lands its own failing
tests without the milestone lead's decision on the fix is a review that has made the
decision.