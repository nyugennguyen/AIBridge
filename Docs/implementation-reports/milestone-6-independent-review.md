# Milestone 6 — Independent Review

**Reviewer:** `independent-reviewer`
**Date:** 2026-10-02
**Branch:** `aibr-v2`
**Diff under review:** `c1d9f50` (implementation) → `a73f2a3` (ADR amendment A14)
**Documents attacked:** `Docs/implementation-reports/milestone-6-completion.md` (1,304 lines),
`Docs/implementation-reports/milestone-6-security-review.md` (§0 revision)
**Scratch probes:** `/tmp/m6-ind/`, revert copy at `/tmp/m6rev/`

I wrote none of the code under review. Every claim below was re-measured in this session;
where I quote a figure it is one I took myself, not one I inherited. **Where a document and
the code disagree, the code wins and the disagreement is a finding.**

---

## 0. Verdict

**I would not sign M6 as complete, and I would not sign it as a library either.** The lead's
verdict ("sign as a library, with conditions") is one notch too generous, and the reason is
specific rather than a matter of taste: the report certifies as **"NOT TRIPPED"** an ADR stop
condition that **is tripped, right now, by a shape containing no negation at all** — the exact
class of shape the milestone's flagship fix claims to have closed. A cross-axis disjunction
`any(roleId eq "role-1", targetNodeId eq "node-1")` compiles, is disclosed to the operator as
`reach.roles = ["role-1"]`, and the kernel returns `allow` / `outstandingApprovals: []` for a
dispatch whose role is `role-9` — a role no author ever named. That is ADR Stop Condition 5 by
name, it is fail-open, and it is invisible to the `subtreeContainsNegation` fix because there
is no `not` in it. Worse, the shape the ADR and the test suite single out as the **control that
must never regress** — `any(projectId eq "p", roleId eq "r")` — is itself an instance of this
defect on the roles axis. The fix's central justification is that unioning "cannot see" the
tautology; unioning cannot see this either, and the report's own §8.1 reasoning
("unioning is correct here") is the reasoning that produces the grant. Everything else I
checked held: all four gate commands reproduce exactly, all six claimed fixes are load-bearing
(red/green confirmed for **all six**, not four), the reachability claim is true, the 16/3 vs
11/8 dispute resolves in the lead's favour, and the two direction-changed tests are honestly
argued. This is a good tree with one live bypass-class hole in the middle of it, and the hole
is in the same function the milestone's headline fix touched.

---

## 1. What I could not verify, stated first

The instruction to report this prominently is right, and the honest answer is that the
milestone's most load-bearing claim is the one I could **not** falsify.

- **I could not reproduce the 5,079 total being wrong.** `bun test` gives
  `5079 pass / 4 skip / 0 fail`, `93648 expect() calls`, `Ran 5083 tests across 218 files
  [22.39s]`. The lead's figure is exact. The five-way movement the lead describes
  (5063→5079) is consistent with concurrent agents, and the count is now stable across my
  runs. **The lead's total is correct.**
- **I could not verify the M6.10 review's 31 attack claims.** I re-derived the five findings
  and NEW-2 against the code; I did not re-run the review's own probes (they lived in
  `/tmp/m6-v2/`, which is gone). The lead makes the same concession (§11) and it is the
  right one.
- **I could not verify the ADR's `file:line` citation sweep** (the lead's §11 also declines
  it). I spot-checked roughly a dozen and found no stale citation in the files I touched.
- **Cross-machine routing determinism is untested and I did not test it.** One machine;
  `Intl.DateTimeFormat` is host-tzdata-dependent. The lead is right that this is a real gap.
- **I could not determine *why* the vacuity defect took three agents to find, and I do not
  think it can be determined from the artefacts.** What I can say is that the same
  *function* has now produced a bypass in three separate shapes, and that is a design
  signal, not a luck signal. See §6.
- **I did not attempt to break the notification bus, budget ledger, or workflow repository
  as hard as I broke the vacuity check.** MED-4 and MED-5 got targeted adversarial probes
  and revert tests, not a fuzz campaign. My confidence on those is "verified sound against
  the attacks I chose", not "verified sound".

---

## 2. Ground truth, re-taken

| Command | Lead's claim | Mine | Agree |
| --- | --- | --- | --- |
| `bun test` | 5079 pass / 4 skip / 0 fail | **5079 / 4 / 0**, 5083 tests, 218 files, 22.39 s | yes |
| `bun run typecheck` | exit 0 | **exit 0** | yes |
| `bun run build` | exit 0 | **exit 0** | yes |
| `./scripts/m0-contract-signoff.sh` | GREEN, digest `83f9a5e0…ee0c1` | **GREEN**, same digest, exit 0 | yes |
| `git diff --check` | clean | **clean** | yes |
| `tests/unit/rules` | 789 | **789** | yes |
| `workflows` / `budgets` / `routing` / `simulation` / `notifications` | 257 / 193 / 108 / 113 / 327 | **257 / 193 / 108 / 113 / 327** | yes |

**The lead's numbers are all correct.** I could not find a single wrong figure in §1 or §2.
The M0 digest is unmoved by the M6 work, as claimed.

---

## 3. The finding the milestone does not have

### 3.1 F-1 (HIGH) — a cross-axis disjunction discloses each axis narrowly and fires on the union

**This is the same defect family as HIGH-1′/NEW-2, in the same function, reachable without a
negation, and it is not closed.**

`constrainingScopeAxes` decides whether a rule constrains anything by **unioning** the axes of
an `any`'s arms (`src/rules/compile.ts:743`, justified in the comment at `:730-742`). The
disclosure's `collectReach` (`src/rules/explain.ts:314`) walks the **whole tree** and reports a
**per-axis value set** — `axisOf` at `src/rules/explain.ts:369`. Those two are answering
different questions with different operators, and nothing reconciles them.

A disjunction's arms are alternatives, so the rule matches when **either** arm holds. The
disclosure renders **each axis independently**, so on any axis that only *one* arm constrains,
it reports that arm's values as though they were a bound on the axis. The rule is then strictly
**wider than disclosed** on that axis.

**Minimal reproduction** (`/tmp/m6-ind/control.test.ts`, through `compileRuleSet` →
`evaluateRules` → `evaluateWithKernel`, no fakes):

```ts
rawPreApprovalDocument({
  ruleId: "ctl",
  predicates: [{ field: "any", predicates: [
    { field: "projectId",   operator: "eq", value: "proj-1" },
    { field: "roleId",      operator: "eq", value: "role-1" },
  ]}],
})
```

```
compiles: true
disclosed roles: {"kind":"constrained","values":["role-1"],"sources":["predicates[0].any[1]"]}
ctx role-9 (never named), project proj-1: match=matched kernel=allow outstanding=[]
ctx role-1, FOREIGN project:            match=project_scope_mismatch
```

The operator activates a pre-approval shown as scoped to `roles = ["role-1"]`. It then clears
the safety floor's per-dispatch approval for **every role in the project**, against a control of
`require_approval / ["dispatch_approval"]`.

This is the exact shape `a73f2a3` and the report both name as the **control that must never
regress** — `any(projectId eq "p", roleId eq "r")`
(`Docs/adr/0007-rule-language-and-evaluation.md:1946`, `:1983`;
`tests/unit/rules/vacuity.test.ts:259`). **The control is the bug.**

**The projects axis is gated; roles is not.** The lead's axis correction is right and I
confirmed it: `classifyRule` refuses a foreign project independently of any predicate
(`src/rules/evaluate.ts:788`, `rule.projectId !== context.projectId`), and my probe shows
`project_scope_mismatch` for a foreign project. Nothing performs the equivalent check for
`roleId`, `targetNodeId`, or `projectPathId`. So on those three axes the over-report is a grant.

**Breadth.** `/tmp/m6-ind/fuzz.test.ts` sweeps all 56 ordered pairs of eight constructive
atoms. **21 pairs allow a dispatch that violates the disclosed value on an axis the disclosure
reported as constrained.** All three ungated axes are affected:

```
any(roleId, X)        disclosed roles=["role-1"]      but ALLOWS   X ∈ {node, path, cap, tool, runtime, nodeAdvCap, label}   (7)
any(targetNodeId, X)  disclosed nodes=["node-1"]      but ALLOWS   X ∈ {role, path, cap, tool, runtime, nodeAdvCap, label}   (7)
any(projectPathId, X) disclosed projectPaths=["path-1"] but ALLOWS X ∈ {role, node, cap, tool, runtime, nodeAdvCap, label}  (7)
```

A second live shape, nested — `any(all(roleId eq "role-1", capability any ["fs.read"]),
targetNodeId eq "node-1")` — discloses `roles=["role-1"], nodes=["node-1"],
capabilities=["fs.read"]` and allows `role-9` (`/tmp/m6-ind/probe7.test.ts` S3).

**Why the `not` fix cannot see it, and why the report's reasoning produced it.** The fix reads
the subtree for a `not` (`compile.ts:678-682`) and refuses any `any` branch containing one. F-1
has no `not`. The report argues (§0.2, §8.1) that unioning is the right operator "for the
question being asked — *does this rule exclude anything?*", and that intersecting "refuses
`any(projectId eq p, roleId eq r)`, which genuinely excludes dispatches and must compile." Both
halves are correct **as statements about the refusal test** and wrong **as statements about
safety**, because the disclosure is the thing Stop Condition 5 constrains, and a per-axis reach
set is a *product*, not a union. The report's §8.1 reasoning is the reasoning that keeps the
grant in the tree. Note the asymmetry the report itself flags elsewhere and then does not apply
here: a disjunction *containing a negation* is refused because it "cannot be stated as a
reachable set"; a disjunction *across two axes* cannot be stated as a per-axis reachable set
either, and is admitted.

**This is not the `any(A∧B, A∧¬B)` over-refusal.** That one is sound-direction and documented.
F-1 is the opposite: the check is too permissive, and the report explicitly claims the family is
closed at "every depth the language admits" (§0.1, §8.1). It is not.

**Cheaper fix, and it does not break the control.** The refusal test need not change at all.
Two options, both fail-closed:

1. In `collectReach` (`explain.ts:314`), mark an axis `unknown` unless **every** arm of every
   enclosing `any` constrains it. `any(projectId eq p, roleId eq r)` then discloses *both* axes
   as `unknown` — honest, and the rule still compiles, so the ADR's control is preserved. The
   disclosure's existing `unknown` machinery and its warning text
   (`explain.ts:413-419`) already exist for exactly this.
2. Or refuse a cross-axis disjunction outright. That is stricter and would regress the ADR's
   control, so option 1 is better.

Either way the fix is a change to the **disclosure**, not to the vacuity check — which is
itself the reviewable lesson: this milestone spent its fix budget on the *refusal* and left the
*disclosure* unexamined, and Stop Condition 5 is a statement about the pair.

### 3.2 F-2 (LOW, disclosure) — a tautological arm under an `all` reports a dead axis as constrained

`all([any(A, not A), roleId eq "role-1"])` **must** compile and does — that is the
deliberate, correct, and test-pinned control at `vacuity.test.ts:212`. The predicate is
satisfiability-equivalent to `roleId eq "role-1"`. But the disclosure reports:

```
reach.projects: {"kind":"constrained","values":["proj-1"],"sources":["predicates[0].all[0].any[0]"]}
```

`src/rules/explain.ts:353-355` skips a `not` node but still collects the **positive arm nested
inside it** (`all`/`any` are walked unconditionally at `:349-351`). So the disclosure cites
`predicates[0].all[0].any[0]` — the atom of a tautological branch — as the source of a projects
reach the rule does not have.

This one is **not** a grant: the projects axis is gated by `classifyRule`, and the
`role-1` sibling genuinely scopes the rule. It is a disclosure over-report on a dead branch, and
it is the same root cause as F-1 — `collectReach` and `constrainingScopeAxes` disagree about
which nodes are meaningful. **A fix for F-1 option 1 fixes this too**, because the tautological
branch constrains the projects axis on no arm that actually holds.

---

## 4. The six claimed fixes, attacked individually

### 4.1 HIGH-1 / NEW-2 — the vacuity check: **partially fixed**

**What is true now.** The nested-tautology family is closed. I re-measured through the real
`compileRuleSet`:

| Shape | Result |
| --- | --- |
| `any(A, not A)` (identifier axes) | `rule.universal_pre_approval` |
| `any(A, not A)` (set, label, range, sensitivity axes) | `rule.universal_pre_approval` |
| `any(R, any(A, not A))` — depth 2 | `rule.universal_pre_approval` |
| `any(R, any(any(A, not A)))` — depth 3 | `rule.universal_pre_approval` |
| `not(any(A, not A))`, `not(all(A, not A))` | refused |
| `any(all(A, not A))` — unsatisfiable | `rule.universal_pre_approval` |
| `taskLabel hasAll []` / `hasAny []` | `rule.empty_enum` |
| **CONTROL** `any(projectId eq p, roleId eq r)` | **compiles** — but is F-1 |
| **CONTROL** `all(R, not P)` beside a real sibling | **compiles** |

**The lead's 16/3 figure is correct and the sub-agent's 11/8 is wrong.** I reverted
`subtreeContainsNegation` to its one-level form in `/tmp/m6rev` and measured:

```
one-level check, tests/unit/rules/vacuity.test.ts :  16 pass / 3 fail
one-level check, tests/unit/rules (whole dir)     : 786 pass / 3 fail
subtree check,    tests/unit/rules (whole dir)     : 789 pass / 0 fail
```

Byte-identical to the lead's §0.1. The three failures are the three tests that exist to hold
this fix down. **The lead was right and should stop deferring to the number it was handed.**

**What is not closed:** F-1 and F-2, above. The claim that the family is "closed at every depth
the language admits" is true of the *negation* family and false of the vacuity family
considered as a whole.

### 4.2 The `any(A∧B, A∧¬B)` over-refusal — **the claim is overstated**

The report says distinguishing it from a tautology "requires deciding satisfiability over a
language with no vocabulary for it" and that the trade is therefore forced. **I do not accept
that this is unavoidable.** A syntactic check that distinguishes
`any(all(A,B), all(A, not B)) ≡ A` from `any(R, any(A, not A)) ≡ TRUE` does not need a solver:
it needs the observation that in the first shape **every** arm is a conjunction *containing* `A`
positively, so each arm is bounded by `A`, while in the second an arm is unbounded. That is the
same "a disjunction can only be as constraining as its least-constraining arm" reasoning the
code already performs, applied one level down. The lead's own §0.2 rejects intersection
*between arms* and I agree that is too blunt — but this is not intersection between arms.

**This is a disagreement about method, not a defect**, and I want to be clear about that: the
over-refusal is fail-closed, it is documented, it costs an author a rewrite, and refusing it is
defensible. My point is narrower — the report presents it as *forced by the absence of a
solver*, and that framing is not established. It is one heuristic among several.

### 4.3 MED-2 — deduped set membership: **fixed, and genuinely load-bearing**

I first reverted it *unfaithfully* (I changed the filter but left the correct `all` comparison)
and the suite stayed green — a useful reminder that a revert must reproduce the original defect,
not merely touch the same lines. Reverted faithfully (`all` comparing
`present.length === declared.size` against the deduped set size), the fail-open reproduces
exactly as the report describes:

```
capability all ["fs.read","net.fetch","fs.read"]
  request ["fs.read"]             -> matched        (intended: not_matched)
  request ["fs.read","net.fetch"] -> not_matched    (intended: matched)
```

`tests/unit/rules/dedupe-membership.test.ts` 8/13, whole rules dir 784/5. `present` and `missing`
are built over the deduped `declared` set and `all` tests `missing.length === 0`
(`src/rules/evaluate.ts:470-484`). One nuance the report omits: the `all` **comparison** was the
load-bearing half, not the filter. Both are now right.

### 4.4 MED-3 — `evaluateWithKernel` applies rule restrictions: **fixed, and the strongest evidence in the milestone**

Both historical stages are now covered by tests, which I verified by reintroducing each:

| Reverted stage | Result |
| --- | --- |
| Stage 1 — spread `ruleRestrictions` into the kernel's `.strict()` input | `kernel-restrictions` 1 pass / **15 fail**; whole rules dir **21 fail** |
| Stage 2 — set `decisionDigest: undefined` in the digest base | `kernel-restrictions` 1 pass / **15 fail** |

**Attacking the recomposition, as instructed.** I tried to make a crafted `restrictions` value
manufacture an `allow` the kernel did not grant, or drop a demand. **I could not.** The
recomposition is monotone by construction: it narrows through the kernel's own
`narrowPolicyState` (`evaluate.ts:1830`), so it cannot widen; `decision` is derived from
`denials.length` and `outstanding.length` rather than asserted; and the demand attribution at
`evaluate.ts:1947` tests for a layer **other than** `safety_floor`, which is the correct sign.
Probing `allowedCapabilities` and `deniedCapabilities` narrowing:

```
A: rule allows only fs.read, dispatch requests fs.read+fs.write
   decision=require_approval  outstanding=["dispatch_approval"]
   effective.allowedCapabilities=["fs.read"]
B: rule denies net.fetch, dispatch requests it
   decision=deny  denials=["policy.capability_denied"]
C: maximumTimeoutSeconds=60 -> effectiveTimeoutSeconds=60
```

All three are correct and fail-closed. **One observation, not a defect:** the recomposition does
not recompute `denials` from the *narrowed* `allowedCapabilities`, so case A returns
`require_approval` where the kernel's own logic would have produced `policy.capability_not_allowed`
→ `deny`. It fails toward more human scrutiny, never toward `allow`, and `effective.allowedCapabilities`
still carries the truth. Worth a comment, not a change.

### 4.5 MED-4 — notification envelope isolation: **fixed; residual correctly disclosed**

```
1 envelope write threw (frozen); summary unchanged
2 Object.defineProperty  -> threw (frozen)
3 Object.setPrototypeOf  -> threw
4 Object.prototype.m6pwn = yes   (NOT closed by freeze)
```

The report's §8.3 is accurate and the claim that this is "inherent to running attacker code
in-process" is fair. `publish` clones on write (`store.ts:451`) and reads the dedupe key from
the **stored** value rather than the caller's object — the specific desync MED-4 created.
`deliverOne` gives each adapter a fresh deep-frozen clone inside its own `try` (`bus.ts:284`),
so a `structuredClone` failure cannot abort the fan-out. Reverting both lines turns
`tests/unit/notifications` 4 red. **Sound.**

### 4.6 MED-5 — budget replay, and MED-5b/5c: **fixed**

Reverting the classification and the `expired` install turns `tests/unit/budgets` 8 red.
Reverting MED-5b's `occupiesCapacity(next.state)` guard turns it 3 red. The refusal is never
total and returns capacity (`expired` is non-occupying), and a malformed ceiling throws a
`RangeError` naming the scope. MED-5c reads the ledger back into `unverified`
(`recovery.ts:399-429`, declared `types.ts:751`) — the right defence, and the same lesson as
MED-3 from the opposite direction. **Sound.**

---

## 5. Claims in the existing reports that are FALSE

1. **§9.2 / §8.1: "ADR Stop Condition 5 — NOT TRIPPED … no compiled rule set can admit an
   action whose bounds exceed what the disclosure displayed"**
   (`milestone-6-completion.md:1141`, `:1027`). **False.** F-1: 21 axis pairs admit dispatches
   wider than disclosed, and the ADR's own control shape is one of them. `code`:
   `compile.ts:743` + `explain.ts:314/369`; `repro`: `/tmp/m6-ind/control.test.ts`.

2. **§6 Criterion 4: "Pre-approval is restricted to the exact displayed bounds — MET in the
   library"** (`:748`). **False as written.** The *bound* half is met; the *display* half is
   violated by F-1, which is the same violation NEW-2 was. The criterion was moved
   NOT MET → MET on the strength of a fix that closed one family of a defect the criterion is
   about.

3. **§6 Criterion 5 verdict "MET", §8.1 "the family is now closed at every depth the language
   admits"** (`:749`, `:990-994`). **False** for the vacuity family as a whole. True for the
   negation family.

4. **§8.1: "The ADR is unamended for this" / "still 1,959 lines" / "§8.2.3 states its rule as
   total" / "§8.2.4's concession now points at a residual that no longer exists" / "the
   residual-risk bullet at `:1674` describes a closed defect as live"** (`:1036-1054`), and
   **§10 second reason: "the ADR is unamended for a fix that has landed" — "the one thing about
   NEW-2 I would still block on"** (`:1200-1206`), and **§10 item 3: "Correct ADR §7.2 — it
   still says `require_approval` projects as a `restrict` effect"** (`:1232`). **All false at
   `a73f2a3`.** The ADR is **2,090 lines**; `a73f2a3` amends all three items, marks §7.2
   **superseded in part** with a cross-reference to §3.2 (`ADR:662`), rewrites §8.2.3 as
   depth-transitive (`ADR:1052`), and rewrites §8.2.4 to state that the test errs in **both**
   directions (`ADR:1097-1124`). The report is describing `c1d9f50`, not the diff under review.
   This removes one of the lead's three reasons for withholding signature — and it means the
   report's §10 reasoning, like its §0.1 axis framing, was overtaken by events it describes as
   outstanding.

5. **§7.1: "`src/rules` grew 44 lines"; §2 size table "ADR 1,959 lines"** — stale for the same
   reason.

**Not false, and worth saying so:** §5 (reachability), §0.1 (16/3), §0.2 (the two reversed
tests), §0.3 (NEW-3 withdrawn), §7.5 (the wedge reclassification), §8.2, §8.3, §8.4, §8.6, and
every number in §1–§2. The lead's *measurements* are excellent. The failures are in two
places: **one live code defect the report's own reasoning created** (F-1), and **one section
written against a superseded commit** (the ADR claims).

---

## 6. Assessment of the specific questions put to me

**Reachability — the lead is right, and it is verified.** Nothing outside
`src/simulation/` and `src/rules/tui/` imports an M6 module; `src/rules/tui/` has **zero**
importers anywhere in `src/`; `grep -c rules src/tui/shell.ts` is `0`; and
`src/application/local-project-registry.ts:124` is `ruleSnapshots: [],`. No dynamic imports.
`tests/unit/rules/barrel.test.ts:370` pins `PERMITTED_CONSUMERS = ["src/simulation/"]` and fails
if a second consumer appears. **The milestone's central criterion is genuinely unmet, and the
lead's stated reason for withholding signature is sound.** This is the finding I most expected
to overturn and could not.

**The two direction-changed tests — honestly justified.** Both still exist, the file is still
432 lines and still 19 tests, and the reasoning is attached in the test file where a maintainer
will actually read it (`vacuity.test.ts:209`, `:277`). Test 1's argument — that
`any(A∧B, A∧¬B) ≡ A` is sound and is refused anyway — is correct as far as it goes. Test 2's
reversal is a genuine correction of the lead's own earlier reasoning, and the correction is
*in the direction of more refusal*, which is the safe direction for a check whose failure mode
is fail-open. **These are not tests flipped to make a suite green.** I checked the committed
diff: the assertions are `toBe(false)` with the refusal code asserted, not loosened. The one
thing I would add is a note recording that the *pre-fix* versions asserted `ok === true` — the
report asserts this in prose (§0.2) but the test file's comments say "previously asserted
`compiled.ok === true`" without a pointer to the diff, and the whole file landed in one commit
(`c1d9f50`), so a reader cannot verify the reversal from history.

**Who was right on 16/3 vs 11/8 — the lead, and I measured it myself.** See §4.1. The lead
should state this without hedging.

**Criterion 7 ("budgets survive restart") — the lead is right that it is unfixable as written.**
`InMemoryBudgetLedgerStore` holds reservations in a plain `Map`; there is no SQLite table, no
migration, no file format, and nothing in the module touches the event store
(`src/budgets/ledger.ts:112-138` names this as a recorded deferral with the
`reserveInTransaction(draft, decide)` seam). No restart can be exercised because there is nothing
to restart from. **PARTIALLY MET is the correct verdict and the reasoning is correct.**

**Material omissions from the residual-risk list.** F-1 and F-2, obviously. Three smaller ones:

- The `allowedCapabilities` narrowing does not recompute `denials` (§4.4). Fail-closed, but an
  asymmetry between `require_approval` and `deny` that a caller reading `decision` will not
  predict.
- `collectReach` and `constrainingScopeAxes` are two independent walks of the predicate tree
  with **no shared notion of which nodes are meaningful**. The `not`-skip in `collectReach`
  (`explain.ts:353`) and the `not`-skip in `constrainingScopeAxes` are separate
  implementations of the same rule. Every disagreement between them is a disclosure defect, and
  there is no test that asserts they agree. **This is the structural cause of F-1 and F-2 and
  belongs in the residual list as a design risk, not just as two bugs.**
- `constrainingScopeAxes` has now been the site of **three** bypass-class defects (HIGH-1′,
  NEW-2, F-1) and has been repaired three times. A function that needs three fixes in one
  milestone is evidence about the function.

---

## 7. What would change my mind

I would move to **"sign as a library"** on:

1. **F-1 fixed** — either the `collectReach` per-axis fix (option 1, preferred: it keeps the
   ADR's control compiling) or a refusal, with a test that walks `any(A_axis1, B_axis2)` for
   every pair of constructive axes and asserts the disclosure does not report a bounded reach
   the rule does not have. A fuzz over the axis pairs is the right shape for that test; I wrote
   one in an afternoon.
2. **F-2 fixed** by the same change.
3. A test asserting `collectReach` and `constrainingScopeAxes` agree on which nodes constrain
   — so the next divergence is caught by construction rather than by an adversary.

I would still withhold **"complete"** until the seam is wired (`local-project-registry.ts:124`),
and I would want a fresh security review of the disclosure path specifically, because **this
milestone's two HIGH findings were both in the disclosure/vacuity pair and neither was found by
reviewing the disclosure.**

---

## 8. Housekeeping

- **No existing file was modified.** All probes live in `/tmp/m6-ind/`; the revert copy is
  `/tmp/m6rev/`. Verified after all experiments: `git status --porcelain` is **empty**,
  `git diff --stat` is **empty**, and `git status --porcelain --untracked-files=all` reports
  nothing.
- **Nothing was committed.**
- This report is the only file written.

## 9. Sign-off

| Role | Status |
| --- | --- |
| `milestone-lead` | **Withheld** — one live bypass-class defect (F-1); report stale against `a73f2a3` |
| `security-reviewer` | Delivered; its five findings verified closed. **Its disclosure path was not covered**, which is where F-1 lives |
| `independent-reviewer` | **This report.** **I do not sign M6 as complete and I do not sign it as a library**, on the strength of F-1 |
| Root agent | — |
