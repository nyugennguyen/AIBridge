# ADR 0007: Rule Language, Evaluation, Budgets, and Simulation

Status: Accepted for Milestone 6 implementation
Date: 2026-10-01
Deciders: Core Architecture Team, Advisor & Reviewer
Amended: 2026-10-02 — see "Amendment — 2026-10-02". Section 8's non-universality
wording is SUPERSEDED by section 8.2; the original text is left in place and marked.

## Context

Milestone 6 lets a user stop approving the same dispatch shape over and over. That is a
real productivity win and it is also the single easiest way to turn an approval-gated
system into an unguarded one, so this ADR is written under the assumption that the
value of the feature is entirely conditional on it being *explainable* and *bounded*.
Every decision below is chosen so that the unsafe outcome is not prevented by care but
by construction.

The Milestones 3 to 5 milestones already built the pieces this milestone composes, and
the composition constraints are what make a narrow design possible rather than a
preferred one.

### Empirical Verification Evidence

The following are existing, tested facts in this repository, cited by file and line.
They are the reason several decisions below are *reuse* decisions.

- **The safety floor is structurally un-relaxable.** `safetyFloorSchema`
  (`src/orchestration/policy/types.ts:70-81`) declares every behavioural field as
  `z.literal()`: `requireApprovalForDispatch: true`, `allowDestructiveEffects: false`,
  `allowExternalEffects: false`. `SAFETY_FLOOR` and `SAFETY_FLOOR_NARROWING`
  (`src/orchestration/policy/floor.ts:30-53`) are built from those literals *outside any
  caller-supplied input surface* and are `deepFreeze`d. There is no code path by which a
  caller can hand the floor a value.
- **Widening is impossible by construction, and attempts are audited.**
  `narrowPolicyState` (`src/orchestration/policy/floor.ts:101`) is the single narrowing
  primitive. Every output field is an intersection, a union, a `min`, or a logical AND
  of the previous state and the layer. Rejected widening attempts are recorded in
  `wideningAttempts` and surface in the explanation tree with the outcome
  `widening_rejected`, deliberately distinct from `unchanged`
  (`src/orchestration/policy/types.ts:154-166`).
- **Pre-approval is already re-checked against the post-narrowing state.** The second
  pass in `evaluatePolicy` (`src/orchestration/policy/evaluate.ts:520-618`) re-derives
  every `pre_approve` grant from the fully narrowed state and refuses the grant when the
  floor denies the effect, when the declared timeout exceeds the rule's own maximum, or
  when the rule does not cover every effectively allowed capability.
- **Rule versions are append-only and supersession is already implemented.**
  `orderRuleSnapshots` (`src/orchestration/policy/evaluate.ts:107-115`) makes only the
  highest `templateVersion` of a `ruleId` effective and records the rest as `superseded`.
- **A bounded regular-expression analyser already exists and is the only one.**
  `compileSafePattern` (`src/mesh/protocol/safe-pattern.ts:742`) returns a
  `SafePatternRefusal` rather than a partially-valid pattern, with
  `MAX_RULE_PATTERN_LENGTH = 128` (`src/mesh/protocol/bounds.ts:35`) and
  `MAX_BOUNDED_NESTING_DEPTH = 2` (`src/mesh/protocol/safe-pattern.ts:410`).
- **Compile-once, keep-raw-for-audit is already the precedent for untrusted rule text.**
  `src/mesh/protocol/rules.ts` (`authorizeRuleWrite`, `PreparedRule`, `toKernelRule`)
  compiles a remote rule write once, keeps the source only for the audit record, and
  hands the kernel a pure re-shaping of the compiled form.
- **Versioned templates with immutable, digested snapshots already exist.**
  `RoleRepository.createSnapshot` (`src/orchestration/roles/repository.ts`) freezes and
  digests a role version; `verifySnapshot` re-checks the digest.
- **A rule edit already cannot retroactively affect an open proposal.** The dispatch
  envelope's `ruleSnapshots` are digest-bound
  (`digestDispatchEnvelope`, `src/orchestration/digest.ts`), and
  `InMemoryLocalApplicationService` includes the definition's rule snapshots in
  `#materialDefinitionFingerprint` (`src/application/service.ts:996`), so changing a rule
  invalidates an open approval with `application.proposal.configuration_changed`
  (`src/application/service.ts:961-976`) instead of silently altering it. The seam is
  already wired: `ProfileLocalProjectRegistry` currently returns `ruleSnapshots: []`
  (`src/application/local-project-registry.ts:124`).
- **Context manifests are already deterministic and previewable,** carry a
  `sensitivity` per item and a `destination.clearance`
  (`src/context/types.ts`), and have a proven no-secret audit in
  `src/context/isolation.ts` that audits a *structurally typed* preview rather than
  trusting the renderer (`src/context/isolation.ts:94-122`).
- **A side-effect-free simulator precedent exists.** `dryRunLegacyMigration`
  (`src/orchestration/legacy/migration.ts:822`) builds a plan through the *same* pure
  planner as the real migration and gates the write behind an explicit commit flag.
- **The mesh registry must not grow scheduling fields.**
  `tests/unit/mesh/registry/no-scheduling-edges.test.ts:40` refuses any member matching
  `/(depend|block|prereq|precondition|retry|retries|failure|backoff|reschedul|eligible|eligib|waits?_for|upstream|downstream|critical_?path)/i`
  on `nodeRecordSchema`, `capabilitySnapshotSchema`, `capabilityRequestSchema`,
  `registryRevocationSchema`, the wire heartbeat, and every physical SQLite column, and
  additionally asserts exact key lists.
- **Dependency direction is enforced by source scan, not by the type checker.**
  `tests/unit/context/barrel.test.ts:106-137` reads every `.ts` file under `src/memory`
  and `src/context` and asserts one-way edges, because an import cycle is exactly what a
  type checker will happily accept.

### The problems this ADR has to solve

1. The M0 contract (`src/orchestration/schemas.ts`, `src/orchestration/types.ts`,
   `src/orchestration/transitions.ts`) is frozen and signed off through
   `scripts/m0-contract-signoff.sh`, whose recorded approval is bound to a digest of that
   surface. The current `ruleSchema` (`src/orchestration/schemas.ts:294`) supports only
   three predicate fields (`taskTitlePattern`, `requestedCapabilitiesAny`,
   `runtimeKinds`) and two action kinds (`restrict`, `pre_approve`). The plan requires
   ten predicate families and six actions; the language as implemented carries
   **eighteen** predicate fields (section 6) and the same six action kinds.
2. The plan forbids divergence between preview and runtime evaluation, retroactive
   effect of a rule edit, and non-atomic budget reservation. Each of those is a property
   of the module layout, not of a code review.
3. The plan forbids "match all projects/nodes/capabilities" pre-approval in the initial
   release, but a rule language that can express a universal predicate is one editing
   mistake away from exactly that.

## Decision

### 1. Module boundaries

Milestone 6 introduces six new top-level modules and edits none of the existing ones:

```
src/rules/          - rule language v2: schemas, compile, evaluate, explain, preview, repository
src/workflows/      - run templates and role packs
src/budgets/        - budget algebra, ledger, transactional reservation, admission
src/routing/        - deterministic eligible-node ranking with explanation
src/simulation/     - side-effect-free dry run
src/notifications/  - advisory notification bus, dedupe, acknowledgement, quieting
```

Dependency direction is strictly downward:

```
simulation  ->  rules, workflows, budgets, routing, orchestration, context
routing     ->  orchestration, mesh/registry
budgets     ->  orchestration
workflows   ->  rules, orchestration
rules       ->  orchestration, mesh/protocol/safe-pattern, memory/ontology
notifications -> (no orchestration, mesh, memory, or runtime imports)
```

`rules -> memory/ontology` exists for one reason: `Sensitivity` and `SENSITIVITY_RANK`
(`src/memory/ontology.ts:210-222`) are the canonical owners of the four-rung sensitivity
lattice that predicate 17 and the `pre_approve_within_bounds` bounds are expressed in. The
alternative is a second ladder of context sensitivity names in `src/rules/`, which is a
second thing that can drift from the first. This edge matches the existing
`context -> memory` edge and is subject to the same one-way source-scan assertion.

Nothing under `src/orchestration/` may import from any of the six. This is enforced by a
source-scan test of the same shape as `tests/unit/context/barrel.test.ts:106`, because a
reverse import would give the M6 rule engine a way to reach into the kernel that the
kernel does not know about.

The `notifications` module deliberately has no upward edge. A notification is an
observation of orchestration state, and a notification subsystem that could read or write
orchestration state would be a second control path.

### 2. The rule language is a new, separately versioned contract

Milestone 6 does not edit `ruleSchema`. It defines a new language version whose documents
carry `languageVersion: 2` and which is negotiated through the same mechanism as
`src/orchestration/versioning.ts`.

The reason is that `ruleSchema` is inside the digest-bound M0 surface, and the M0
re-approval procedure is a document attestation by three named reviewers. Spending that
attestation on widening a predicate enum would spend it on the least consequential part of
this milestone, and would leave the far more consequential decisions (the action
vocabulary, the universal-predicate restriction, the reserved literals) unreviewed by the
people who attested to the original surface.

`CompiledRule.kernelRule` is the bridge: a `restrict`/`pre_approve` projection into the
M0 `Rule` shape so the existing kernel policy engine remains the enforcement point for
the actions it already understands, with no change to that engine.

### 3. The compiled rule set is the one representation

```ts
function compileRuleSet(sources: readonly unknown[]): Result<CompiledRuleSet>

interface CompiledRuleSet {
  readonly languageVersion: 2
  readonly rules: readonly CompiledRule[]   // deep-frozen, in evaluation order
  readonly limits: RuleLimits               // the table in section 9
  readonly digest: Digest                   // digestJson over the canonical form
}

interface CompiledRule {
  readonly ruleId: RuleId
  readonly templateVersion: number
  readonly projectId: ProjectId
  readonly name: string
  readonly description: string
  readonly enabled: boolean
  readonly activation: RuleActivation
  readonly expiresAt: Timestamp | null
  readonly predicates: readonly RulePredicate[]   // declared order, preserved
  readonly normalizedPredicate: string             // canonical text form, section 11
  readonly actions: readonly RuleAction[]         // in action-kind rank order
  readonly patterns: readonly SafePattern[]        // compiled, never raw source
  readonly kernelRule: Rule | null                 // M0 projection, or null
  readonly unprojectedNarrowing: readonly string[] // M0 effect field names the projection cannot carry
  readonly source: RuleSourceDocument              // authored text, kept for the audit record only
  readonly digest: Digest
}
```

Every name in that block is an export a reader can import. `CompiledRuleSet` and
`CompiledRule` are declared at `src/rules/types.ts:1074` and `src/rules/types.ts:1047`,
`compileRuleSet` at `src/rules/compile.ts:1089`, `RuleLimits` at `src/rules/limits.ts:229`,
and `RuleAction` at `src/rules/types.ts:921`; `RuleId`, `ProjectId`, `Timestamp`, `Digest`,
`RuleSourceDocument`, `SafePattern`, and the M0 `Rule` are re-exported from the module
barrel so a caller never needs a second import path (`src/rules/index.ts:51-66`).

`compileRuleSet` is the only way to produce a `CompiledRuleSet`, and a `CompiledRuleSet`
is the only input to evaluation, preview, and simulation. This is the structural answer to
the plan's stop condition *"Stop if preview and production evaluation can diverge"*: there
is one artifact and one entry point, so the two cannot drift by construction. A preview
that re-parsed the source would be a second parser.

`CompiledRuleSet.rules` is deep-frozen. A preview that mutated the artifact to mark
"what matched" would corrupt the runtime evaluation; there is nowhere to put that state.

#### 3.1 The kernel projection is a sound under-approximation, not `{}`

`CompiledRule.kernelRule.match` is **not** an empty object.
`projectKernelMatch` (`src/rules/compile.ts:899`) projects the M0-expressible subset
of the M6 predicate's **top level** into it, and `projectToKernelRule`
(`src/rules/compile.ts:955`) attaches the same projection to both effects it emits:
the `restrict` form at `src/rules/compile.ts:1024` and the `pre_approve` form at
`src/rules/compile.ts:991`. The subset is exactly three predicate forms, read from
the top-level `predicates` array and from nowhere else, because those are the three
criteria `ruleMatchSchema` (`src/orchestration/schemas.ts:267-273`) has:

| M6 top-level predicate | M0 `match` field |
| --- | --- |
| `{ field: "capability", operator: "any", value: [...] }` | `requestedCapabilitiesAny` |
| `{ field: "runtimeKind", operator: "eq" \| "in", value: [...] }` | `runtimeKinds` |
| `{ field: "taskTitlePattern", pattern: "..." }` | `taskTitlePattern` |

Why this is not `{}`: `matchRule` returns `matched: true` for a rule whose `match`
declares no criteria (`src/orchestration/policy/evaluate.ts:44`, reaching
`src/orchestration/policy/evaluate.ts:90`). A `{}` projection therefore applies the
effect **unconditionally**, and correctness rests entirely on the M6 evaluator having
gated the rule out through `matchedRules` first. With the subset above, the kernel
independently re-checks whatever the M0 language can state. The property this buys is
stated in the shipped code and is the reason the subsection exists:

> **The kernel is a second, independent, fail-closed authority, not an effect
> applicator that trusts the list it was handed.**

Three rules define the projection, and all three move in the same direction.

1. **The projection is a sound under-approximation in every case: weaker than the M6
   predicate, never different.** A rule the kernel cannot match is skipped with a
   reason; a rule the kernel *can* match still has to clear the kernel's own
   post-narrowing pre-approval re-check before any grant exists. Weaker is the safe
   direction because M6 remains the authority on *which rules apply*: an
   over-approximation would let the kernel act where M6 said not to, and no
   downstream check could see the substitution.
2. **`capability all` and `capability none` contribute nothing.** M0's
   `requestedCapabilitiesAny` is checked with `some()`
   (`src/orchestration/policy/evaluate.ts:74`), which is an ANY over the dispatch's
   requested capabilities. Projecting an `all` through it would silently weaken
   "the dispatch asks for every one of these" into "the dispatch asks for one of
   these", and both sides of that substitution are just a list of strings, so nothing
   downstream could see it. `none` has no M0 counterpart at all, and inventing one
   would be a second M0 shape, which is the thing section 2 exists to prevent. Where
   several top-level predicates of the same field are declared, their members are unioned
   (`src/rules/compile.ts:911-923`), which is strictly weaker than the conjunction of
   the disjunction each one states.
3. **Nesting is not descended.** `all` / `any` / `not` are combinators and M0 has no
   combinator, so an M0 `match` is a flat conjunction of at most three criteria and
   an M6 predicate list is a tree. The only sound projection of a nested predicate is
   the empty one, for a reason that has nothing to do with difficulty: flattening
   `(a or b)` or `not a` into a conjunction is not a widening of the kernel's check,
   it is a different claim about what the rule means. A projection that cannot be
   checked against the M6 tree by reading the M6 tree is a projection nobody can
   audit, so the top-level list is the whole of the projection's input.

`match` therefore legitimately stays `{}` for a rule built from the other fifteen
fields. That is the under-approximation, not a gap in the projection: a manufactured
non-empty match would be worse than none, because a reader could not tell which M6
predicate it came from. A projected value the frozen `ruleSchema` cannot hold is
refused at **compile** time with `rule.invalid_source`
(`src/rules/compile.ts:1001-1010` for the `pre_approve` form and
`src/rules/compile.ts:1041-1050` for the `restrict` form), not projected and then
rejected by the kernel at dispatch time where the author is not watching.

**The residual limitation, stated rather than hidden.** `RuleEvaluationResult.kernelRules`
is dispatch-bound by construction and **not** by the type system. A caller that
caches it and attaches it to a different dispatch's envelope would attach a rule
whose M6 predicate was never evaluated for that dispatch. The projection bounds the
blast radius of that caller bug: a mis-attached rule must still satisfy whatever part
of its predicate the M0 language can express, instead of applying unconditionally. The
projection does **not** close it. The one related check in the shipped
code is a membership check, not a binding: `evaluateWithKernel` refuses a kernel rule
whose `ruleId@templateVersion` is not a member of the compiled set
(`src/rules/evaluate.ts:1874-1885`), which does not establish that the rule matched
*this* dispatch. Closing the hole needs a digest-bound binding from a compiled rule
set to a dispatch, which is a change to the M0 envelope and therefore outside this
milestone.

#### 3.2 The four members the M0 `restrict` effect cannot carry are applied by the caller, after the kernel's pre-approval pass

The M0 `restrict` effect is frozen and has exactly **three** members
(`src/orchestration/schemas.ts:275-282`): `deniedCapabilities`,
`requireApprovalForDestructiveEffects`, `requireApprovalForExternalEffects`. A
`require_approval` or `add_restrictions` action has **four** more that the frozen
effect has no field for, and `unprojectedNarrowingMembers`
(`src/rules/compile.ts:1054-1067`) names them:

| Action | Member with no M0 `restrict` field |
| --- | --- |
| `require_approval` | `requireApprovalForDispatch` |
| `require_approval` | `requireApprovalForCapabilities` |
| `add_restrictions` | `allowedCapabilities` |
| `add_restrictions` | `maximumTimeoutSeconds` |

They travel in `RuleEvaluationResult.restrictions`
(`RuleRestrictionComposition`, `src/rules/types.ts:1311-1324`, carried at
`src/rules/types.ts:1349`) because the projection cannot carry them, and therefore
**only the caller can apply them.**

**One projection is deliberately stronger than what the author wrote, and it is
recorded here rather than left to be discovered.** The M0 `restrict` effect has no
"disable an effect" member, so `add_restrictions`'s `allowDestructiveEffects: false`
and `allowExternalEffects: false` — which exist to state a restriction explicitly and
whose only legal value is the disabling one (section 7.4) — are projected as
`requireApprovalForDestructiveEffects: true` and
`requireApprovalForExternalEffects: true` (`src/rules/compile.ts:1025-1035`). That is a
**different claim** from the one the action makes, and it is the safe direction: an
approval demand is strictly stronger than an already-false permission flag, and the
safety floor already holds both flags at `false`, so the only observable effect is that
the rule contributes an approval demand its author did not write. A projection that
under-approximates here would be the one worth refusing, and it is not what the code
does; a projection that over-approximates is recorded here so an operator who notices
an extra approval can find the reason in one place.

`narrowWithRuleRestrictions`
(`src/rules/evaluate.ts:1815-1831`) is the adapter that does, and it is a **thin
adapter over the kernel's own `narrowPolicyState`, not a second implementation of the
algebra**: it re-shapes the composition into a `PermissionNarrowing` and calls
`narrowPolicyState(state, "rule", narrowing)`. That is the whole reason the
composition lives in one exported function rather than in each caller's head — a
hand-rolled intersection in a caller could diverge from the floor's monotonicity
guarantees, and the ADR's section 7.7 invariant rests on there being exactly one
narrowing algebra.

**`evaluateWithKernel` applies them, and in this order.** `KernelCompositionInput`
(`src/rules/evaluate.ts:1834-1850`) carries `ruleRestrictions?: RuleRestrictionComposition | null`,
and `evaluateWithKernel` (`src/rules/evaluate.ts:1869`) does three things in a fixed
sequence:

1. **It validates the kernel rules' provenance first** — every supplied kernel rule
   must be a member of the compiled set (`src/rules/evaluate.ts:1874-1885`).
2. **It runs the kernel's own `evaluatePolicy`**, which includes the kernel's
   pre-approval pass and its post-narrowing re-check.
3. **Only then does it narrow**, by calling `narrowWithRuleRestrictions` on
   `validated.data.effective` — that is, on the state the kernel produced, *after*
   the pre-approval pass has already run (`src/rules/evaluate.ts:1930-1947`).

Two consequences of that order are normative, and both are the safe direction:

- **The rule narrowing runs after the kernel's pre-approval pass.** A demand a rule
  adds is therefore not something the kernel's pre-approval pass has already
  considered and cleared.
- **A demand added by a rule is not clearable by a pre-approval**, exactly as the
  kernel already decides for its own layers: `evaluatePolicy` grants only when
  `onlyFloorDemands`, i.e. when every recorded demand is the floor's own. The rule
  layer is held to the same test, and the test is whether a layer **other than
  `safety_floor`** appears in `dispatchApprovalDemands`
  (`src/rules/evaluate.ts:1947`). If it does, `dispatch_approval` is added to
  `outstandingApprovals` and the composed decision cannot be `allow`.

**Why this subsection exists: the function used to not call the adapter it exported.**
`narrowWithRuleRestrictions` was exported, and `evaluateWithKernel` — the one function
whose entire reason for existing is "make the composition ONE CALL rather than a
convention" — never called it. The four members above compiled, were digested, were
named in `unprojectedNarrowing`, and were then **silently discarded**. A rule that said
"require approval for `net.fetch`" appeared to work and did nothing, which is worse
than refusing the action outright: an inert rule is indistinguishable from a rule that
matched nothing. A second defect compounded it — `ruleRestrictions` was spread into the
kernel's own input, and `policyEvaluationInputSchema` is `.strict()`, so every call
including one passing `null` returned `rule.evaluation_failed: Unrecognized key:
"ruleRestrictions"` and the narrowing was unreachable. The member is now destructured
out before the spread (`src/rules/evaluate.ts:1895`).

The composed result is re-validated against the kernel's own
`policyEvaluationSchema` and its `decisionDigest` is recomputed over the recomposed
value, so a caller receives a kernel-shaped evaluation rather than an M6-shaped one
with extra fields (`src/rules/evaluate.ts:1957-1985`). A widening attempt inside the
rule layer is reported the same way the floor reports one — through
`narrowPolicyState`'s `wideningAttempts`, never silently.

Every clause of this subsection is asserted in
`tests/unit/rules/kernel-restrictions.test.ts`, and the assertions are chosen so that
none of them is vacuous: the "accepts a call that supplies `null`" case is paired with a
"still refuses a genuinely unknown input key" case, because a suite that only asserted
the accepting cases would also have passed against the pre-fix code that refused
*everything*.

**The residual limitation is unchanged and still stated by section 3.1:** applying
the unprojectable members requires the caller to *pass* them. `ruleRestrictions` is
optional so a caller with no M6 restrictions can pass nothing, and a caller **with**
restrictions must pass them or those restrictions do not take effect. `evaluateWithKernel`
is the composition this ADR requires, and the type system does not make it the only
one.

### 4. Patterns are compiled through the existing bounded analyser

Every pattern-valued predicate value is compiled with `compileSafePattern`
(`src/mesh/protocol/safe-pattern.ts:742`). No second regular-expression implementation is
introduced anywhere in Milestone 6, and `new RegExp` on rule text does not appear in
`src/rules/`.

Two rules govern failures:

- **A pattern that fails to compile makes the whole rule invalid at compile time.** The
  current kernel behaviour is that a malformed `taskTitlePattern` never matches
  (`src/orchestration/policy/evaluate.ts:56-63`), which is safe for a narrowing effect
  and *unsafe* to inherit here: under the same rule a mistyped pre-approval pattern would
  silently never pre-approve, and a user debugging that would not be told their rule is
  broken. A compile refusal is reported, not absorbed.
- **Pattern predicates fail closed on a missing subject.** A pattern predicate evaluated
  against a `null` subject reports `unsatisfied` with a reason, never `unknown` and never
  `satisfied`.

### 5. Serialization is JSON only in the initial release

No YAML parser is added. The schema is authored so that the YAML *subset* of scalars,
sequences, and mappings maps onto it one to one, and anchors, aliases, tags, merge keys,
and multi-document streams are outside the schema. This is recorded as a deferral with a
named condition for revisiting, not as an oversight: the language is specified as data,
and a subset mapping is cheap to add later. A YAML front end would add a parser to the
untrusted-input surface of a language whose defining property is that it cannot execute
anything, and would change `tests/unit/package/manifest.test.ts` and `release:check`
coverage for no milestone-visible benefit.

### 6. Predicate vocabulary

`RulePredicate` is a recursive schema discriminated on a single key `field`. Boolean
combinators reuse the same discriminator so the whole language is one discriminated union
and one traversal. Recursion uses `z.lazy`, following
`policyExplanationNodeSchema` (`src/orchestration/policy/types.ts:146`).

Every predicate carries an optional `note` of 0 to 512 characters for human annotation.
A note is display-only, is never evaluated, and never widens a predicate: a rule whose
predicates are all `all([])` plus notes is still a universal rule and is still subject to
section 8.

| # | `field` | Operators | Value shape | Bound | Normalized form | Fails closed |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `projectId` | `eq`, `in` | `ProjectId` \| `ProjectId[]` | 64 members | `projectId == "p"` / `projectId in ["a","b"]` | `in []` is a **compile error**, not a match-nothing |
| 2 | `roleId` | `eq`, `in` | `RoleId` \| `RoleId[]` | 64 | `roleId == "r"` | absent role is `unsatisfied` |
| 3 | `roleVersion` | `eq`, `lt`, `lte`, `gt`, `gte`, `between` | integer \| `{min,max}` | 1..1000, `min<=max` | `roleVersion between 1 and 3` | `between` with `min>max` is a compile error |
| 4 | `capability` | `any`, `all`, `none` | `string[]` | 64 | `capability any ["fs.read"]` | `any` over a request with no capabilities is `unsatisfied` |
| 5 | `toolCategory` | `any`, `all`, `none` | `string[]` | 64 | `toolCategory any ["shell"]` | as above |
| 6 | `runtimeKind` | `eq`, `in` | `string` \| `string[]` | 128 chars, 64 members | `runtimeKind == "opencode"` | absent runtime is `unsatisfied` |
| 7 | `targetNodeId` | `eq`, `in` | `NodeId` \| `NodeId[]` | 64 | `targetNodeId in ["n1"]` | absent node (local dispatch) is `unsatisfied` |
| 8 | `nodeAdvertisedCapability` | `any`, `all`, `none` | `string[]` | 64 | `nodeAdvertisedCapability any ["gpu"]` | a node with no capability snapshot is `unsatisfied` for `any` and `all`, `satisfied` for `none` |
| 9 | `projectPathId` | `eq`, `in` | `ProjectPathId` \| `ProjectPathId[]` | 64 | `projectPathId == "path-1"` | an un-allowlisted path is `unsatisfied`; see below |
| 10 | `taskLabel` | `has`, `hasAny`, `hasAll`, `lacks` | `string[]` | 32 members | `taskLabel has "release"` | a task with no labels is `unsatisfied` for `has*`, `satisfied` for `lacks` |
| 11 | `dependencyOutcome` | `anySucceeded`, `anyFailed`, `allSucceeded`, `allFailed`, `none` | *(no value)* | - | `dependencyOutcome anyFailed` | a task with no dependencies is `unsatisfied` for every operator except `none` |
| 12 | `fanOut` | `eq`, `lt`, `lte`, `gt`, `gte`, `between` | integer \| `{min,max}` | 1..`MAX_FAN_OUT`(256) | `fanOut <= 4` | an unknown fan-out is `unsatisfied`, never `satisfied` |
| 13 | `concurrency` | same as 12 | integer \| `{min,max}` | 1..256 | `concurrency <= 2` | as above |
| 14 | `retryLimit` | same as 12 | integer \| `{min,max}` | 0..`MAX_RETRY_LIMIT`(16) | `retryLimit <= 1` | as above |
| 15 | `timeoutSeconds` | same as 12 | integer \| `{min,max}` | 1..`SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS` | `timeoutSeconds <= 900` | as above |
| 16 | `scheduleWindow` | *(no operator)* | `{ windows: ScheduleWindow[] }` | 8 windows | `scheduleWindow in [Mon-Fri 09:00-17:00 America/New_York]` | see below |
| 17 | `contextSensitivity` | `any`, `none`, `maxRankAtMost`, `maxRankAtLeast` | `Sensitivity[]` \| integer rank | 4 lattice rungs | `contextSensitivity maxRankAtMost restricted` | an absent manifest is `unsatisfied` for `any` and `maxRankAtLeast`, and `satisfied` for `none`; it is **never** treated as rank 0 |
| 18 | `taskTitlePattern` | *(no operator)* | `{ pattern: string }` | `MAX_RULE_PATTERN_LENGTH`(128) via `compileSafePattern` | `taskTitlePattern matches "^deploy"` | a `null` title is `unsatisfied`, never `unknown`; a pattern the bounded analyser refuses is a compile error |
| A | `all` | *(no operator)* | `{ predicates: RulePredicate[] }` | 1..`MAX_COMBINATOR_NODES_PER_RULE` | `(a and b and c)` | empty `all([])` is the universal predicate; it parses and is refused by the section 8 check rather than by the schema |
| N | `any` | *(no operator)* | `{ predicates: RulePredicate[] }` | 1..`MAX_COMBINATOR_NODES_PER_RULE` | `(a or b)` | empty `any([])` is unsatisfiable and is a **compile error** under `rule.empty_enum` (section 8.1) |
| X | `not` | *(no operator)* | `{ predicate: RulePredicate }` | depth bound applies | `(not a)` | an unevaluable operand is `unsatisfied`, so `not` of it is also `unsatisfied` |

The combinator rows state `1..MAX_COMBINATOR_NODES_PER_RULE` members, and the shipped schema
permits **zero**, so `all([])` parses (`src/rules/types.ts:608`; the only array bound
there is the parse-shape guard `PARSE_SHAPE_ARRAY_GUARD`
(`src/rules/limits.ts:194`), set two orders of magnitude above every real limit so it
can never be the limit that fires). The asymmetry with `any([])` is deliberate:
`any([])` is unsatisfiable by definition and is refused outright, while `all([])` is a
*defined* universal predicate that only the two scope-bearing action kinds may not
carry, so it must compile before section 8 can refuse it
(`src/rules/compile.ts:543-557`, code `rule.universal_pre_approval`). Both halves are
asserted: that `all([])` parses at `tests/unit/rules/schema.test.ts:167` and compiles at
`tests/unit/rules/compile.test.ts:1034`, and that a pre-approval whose only predicate is
`all([])` is then refused as universal at `tests/unit/rules/compile.test.ts:895-899`. A
schema error and a policy refusal are different diagnostics: the first says the
document is malformed, the second says the document is well-formed and expresses
something this release will not do, and only the second tells an author what to
change.

#### 6.1 Project path predicates reference a path ID, never a path string

Predicate 9 compares `projectPathId`, an opaque identifier from
`projectPathSchema` (`src/orchestration/schemas.ts`). It never compares a filesystem
path, a prefix, a glob, or a regular expression over a path.

Three reasons, in order of severity. A prefix match would make the rule's blast radius
depend on the *filesystem layout*, so the same rule text would mean different things on
two machines and the displayed match set would be wrong on at least one of them. A
`..`-relative path would make a rule able to name a directory that is not on the
allowlist, which is an allowlist widening expressed as a string comparison. And a regex
over a path would put the unbounded-regex problem back into the one predicate family
where a mistake leaks data rather than merely failing to match.

A dispatch whose project path is not on the allowlist is `unsatisfied` for `projectPathId`
predicates and is additionally refused upstream by
`ProfileLocalProjectRegistry.authorizeLaunchPath`
(`src/application/local-project-registry.ts:149-166`), which re-`realpath`s on every call
and compares against a constructor-time pin. The predicate is a filter over an
already-authorized set; it is not the authorization.

#### 6.2 Schedule windows require an explicit timezone

```ts
interface ScheduleWindow {
  readonly daysOfWeek: readonly number[]          // 0=Sunday..6=Saturday, 1..7 members, unique
  readonly startMinuteOfDay: number               // 0..1439
  readonly endMinuteOfDay: number                 // 0..1439, > start (wrap not supported)
  readonly timeZone: string | { readonly fixedOffsetMinutes: number }  // IANA id or -840..840
}
```

The host's local time is never consulted implicitly. `timeZone` is either an IANA
identifier validated against `Intl.supportedValuesOf("timeZone")` at compile time, or an
explicit fixed UTC offset in minutes. Evaluation takes an injected clock; the window is
computed with `Intl.DateTimeFormat` under the declared zone.

Three reasons. An implicit local zone makes a rule's meaning depend on the machine that
evaluates it, which breaks the determinism requirement and makes a dry run on a laptop
disagree with the controller. A wrapping window (`22:00` to `03:00`) would need either a
second-day flag or a wrap convention, and both are places to put an off-by-one that
grants a window nobody displayed. And `Intl` timezone data is version-dependent, so the
normalized form records the zone *as written* and the evaluation result records the
computed UTC instant, so a reader can always tell which interpretation produced a
decision.

A rule with an unsatisfiable window set (every window empty) is a **compile error**, not a
rule that never matches.

#### 6.3 `taskTitlePattern` is a predicate field, and it is deliberately not a scope field

Row 18 is in the table even though the original text of this section did not carry it,
because sections 4 and 9 both require a pattern path in the M6 compiler and this
section had nowhere to put one. Section 4 states two rules (a pattern that fails to
compile makes the whole rule invalid at compile time, and a pattern predicate evaluated
against a `null` subject reports `unsatisfied`) and section 9 lists
`MAX_RULE_PATTERN_LENGTH` and `MAX_RULE_PATTERN_NESTING_DEPTH` among the limits the
compiler applies. Neither has anywhere to act without a field. The omission was an
internal inconsistency in this ADR, not a decision, and it is closed here.

The shape is `{ field, pattern, note? }` and **no `operator` and no `value`**
(`src/rules/types.ts:487-493`), unlike every other field in the table. The field's own
bound is `.min(1)` and nothing more: the length bound is not restated in the schema
because `compileSafePattern` is what reports the analyser's own `too_long` refusal
(`src/mesh/protocol/safe-pattern.ts:746-751`), and restating it would turn a
`rule.pattern_refused` carrying that detail into a generic shape error.

Everything else about it is the M0 surface, deliberately. It carries the M0 name
`taskTitlePattern`; its subject is the M0 subject `RuleMatchContext.taskTitle`
(`src/orchestration/policy/types.ts:275`), which is `z.nullable()`; it is compiled
**only** by `compileSafePattern` (`src/mesh/protocol/safe-pattern.ts:742`, called from
`src/rules/compile.ts:410-424` under code `rule.pattern_refused`); and it is matched
**only** by `matchesBounded` (`src/mesh/protocol/safe-pattern.ts:843`, called from
`src/rules/evaluate.ts:607`). There is one pattern path in the system, as section 4
requires, and this field is it. A `null` title is `unsatisfied` with a reason
(`src/rules/evaluate.ts:598-603`).

#### 6.4 Set membership is computed over the DEDUPED declared members

`capability`, `toolCategory`, and `nodeAdvertisedCapability` share one evaluator,
`evaluateSetPredicate` (`src/rules/evaluate.ts:436-487`), and its semantics are stated
here rather than left to the `all` / `any` / `none` words.

> **A declared member set is a SET. `all S` holds if and only if every member of
> `deduped(S)` is present in the subject; `any S` if and only if at least one is;
> `none S` if and only if none is. A duplicate in `S` MUST NOT change any of the
> three verdicts.**
`evaluateSetPredicate` builds `declared` as a `Set` (`membersOf`,
`src/rules/evaluate.ts:293-295`, applied at `src/rules/evaluate.ts:460`) and then builds
**both** `present` and `missing` by filtering that set, never the raw declared array
(`src/rules/evaluate.ts:470-471`). Every count the operator can read — "the request
includes 1 of the declared values", "the request is missing 2 of the declared values" —
is therefore a count over distinct members. The invariant is asserted on **every axis and
every operator** in `tests/unit/rules/dedupe-membership.test.ts`, including the property
that a duplicated declaration produces the **same digest and the same normalized
predicate** as its deduped twin — so a duplicate is invisible to the artifact an auditor
reads as well as to the matcher, which is what makes "duplicates are semantically inert"
a statement about the whole rule rather than about one function.

This is a **fail-open matcher bug that the review found in the previous version**, and
it is worth recording in the ADR rather than only in a commit message, because the shape
of it is not obvious. The previous code filtered the **raw** `predicate.value` to build
`present` and compared `present.length` against `declared.size` from a **deduped**
`Set`. One operand counted a duplicated member twice, the other counted it once, and the
`all` comparison inverted:

| Declared | Request | Correct | Previous |
| --- | --- | --- | --- |
| `capability all ["fs.read", "net.fetch", "fs.read"]` | `["fs.read"]` | `unsatisfied` — `net.fetch` is missing | **satisfied** |
| `capability all ["fs.read", "net.fetch", "fs.read"]` | `["fs.read", "net.fetch"]` | `satisfied` | **unsatisfied** |

A pre-approval scoped `all ["fs.read", "net.fetch", "fs.read"]` was therefore satisfied by
a dispatch asking for `fs.read` alone and **refused** a dispatch that genuinely carried
both. That is a pre-approval matcher that grants on a narrower request than the rule
says and denies on the exact request the rule was written for, which is the more
dangerous half: the granted case is invisible, because a rule that fires on a dispatch
nobody was watching is indistinguishable from a rule that fires correctly.

The disclosure was never wrong about this, and that is the tell. `renderList`
(`src/rules/types.ts:695-697`) sorts and de-duplicates when it renders a member list, so
the normalized form of the rule above is `capability all ["fs.read","net.fetch"]` — the
`declared` set — which is exactly what the correct semantics compares. The text, the
digest, and the disclosure all said one thing; only the matcher said another.

**`taskLabel` is a different code path and the same invariant.**
`evaluateTaskLabelPredicate` (`src/rules/evaluate.ts:488-516`) iterates the declared
array rather than a set, so its counting is over array positions. The invariant still
holds, and for a different reason: a `filter` over a repeated member yields a repeated
present member, so `hasAll ["release","release"]` finds two present entries from the one
label the task carries and is satisfied, exactly as `hasAll ["release"]` is. **A
duplicate in a `taskLabel` declaration is therefore also semantically inert**, and the
ADR states the invariant once for both paths because the observable behaviour is the
same.

**It is not in section 8's `NON_UNIVERSAL_PREDICATE_FIELDS` list, and that is a
refusal, not an oversight.** A pre-approval whose *only* predicate is a
`taskTitlePattern` is refused as universal with
`rule.universal_pre_approval` (`src/rules/compile.ts:708-723` against
`src/rules/types.ts:292-305`, which lists the same twelve fields section 8 names, and
whose treatment of each axis is section 8.2). The
reason is that a title is unbounded free text chosen by whoever wrote the task: it does
not scope the blast radius to a *known set* of projects, roles, nodes, or capabilities,
it scopes it to whatever someone typed in a subject line. Every field on the list names
an enumerated or bounded axis, so a rule scoped by one has a reachable match set a
reader can audit. A rule scoped by a title pattern has a match set that is a property of
human phrasing, and the disclosure would have to render it as `unknown` in every other
column, which is exactly the shape the plan restricts. An author who wants a title
pattern in a pre-approval rule therefore has to scope it by at least one enumerated
field as well.

### 7. Action vocabulary

`RuleAction` is discriminated on `kind`. Between 1 and `MAX_ACTIONS_PER_RULE` actions per
rule.

#### 7.1 `deny_with_reason`

```ts
{ kind: "deny_with_reason", reason: string /* 1..4096 */ }
```

Enforced by the M6 evaluator as a hard deny on the whole dispatch. It composes with the
kernel as `deny if (kernel denies) or (any effective rule denies)`, which is monotone in
both directions and cannot turn a kernel deny into an allow.

#### 7.2 `require_approval`

```ts
{
  kind: "require_approval",
  requireApprovalForDispatch?: boolean,
  requireApprovalForCapabilities?: string[],
  requireApprovalForDestructiveEffects?: boolean,
  requireApprovalForExternalEffects?: boolean
}
```

Field-for-field a `PermissionNarrowing` subset (`src/orchestration/policy/types.ts:90-102`).
At least one field must be present. Projects into `kernelRule` as a `restrict` effect,
so the M3 engine enforces it with its existing approval accounting and its existing
`outstandingApprovals` list.

#### 7.3 `pre_approve_within_bounds`

```ts
{
  kind: "pre_approve_within_bounds",
  approvedCapabilities: string[],        // 1..64
  maximumTimeoutSeconds: number,        // 1..SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS
  allowDestructiveEffects: false,       // z.literal(false)
  allowExternalEffects: false,          // z.literal(false)
  maximumFanOut?: number,               // 1..256
  maximumConcurrency?: number,          // 1..256
  maximumRetryLimit?: number,           // 0..16
  maximumSensitivity?: Sensitivity      // one of the four lattice rungs
}
```

`allowDestructiveEffects` and `allowExternalEffects` are `z.literal(false)` rather than
`z.boolean()`. The kernel already refuses a rule that tries to enable an effect the floor
denies (`src/orchestration/policy/evaluate.ts:537-548`), so this is not the only line of
defence; but making the escalation *unrepresentable* means the refusal path cannot be
reached by a schema-valid document at all, and a test can assert the absence rather than
the handling. The kernel re-check stays as defence in depth for the M0 `pre_approve`
effect, which remains a `z.boolean()`.

The four optional bounds exist because the plan's pre-approval disclosure requires the
maximum fan-out, concurrency, retry, and sensitivity to be shown, not only the timeout.
A pre-approval whose bounds are wider than the dispatch's actual values still grants, but
the disclosure then over-states the reach, which is why section 10 requires the display to
show the declared bounds and not a computed narrowing.

**The kernel projection bounds `maximumTimeoutSeconds` down to
`min(declared, dispatch.timeoutSeconds)`, and only downward.** The M0 re-check treats a
rule maximum *above* the EFFECTIVE state ceiling as a widening attempt
(`src/orchestration/policy/evaluate.ts:549-553`), and the dispatch layer narrows that
ceiling to the dispatch's own timeout (`src/orchestration/policy/floor.ts:80`). Without
the clamp, a rule declaring 900 seconds attached to a 600-second dispatch would be
refused outright for declaring a ceiling above the dispatch it is attached to. That is a
false negative that would make every pre-approval with a generous declared bound silently
never fire, which is the exact failure mode section 4's compile-refusal rule exists to
prevent. The clamp therefore happens in the projection, in
`boundKernelRuleToDispatch` (`src/rules/evaluate.ts:1488-1499`, the `min` at
`src/rules/evaluate.ts:1493`), and there is no branch anywhere in that function that
raises a ceiling.

The clamp only ever makes the grant **stricter**, never wider: the M6 side still requires
`dispatch.timeoutSeconds <= declared` before the action is even a candidate
(`src/rules/evaluate.ts:1591-1595`), so the bound the kernel sees can only be a value
the grant already had to satisfy. The **declared** bound, not the clamped one, is what
appears in the trace (`src/rules/evaluate.ts:1583`) and in the section 11 disclosure
(`src/rules/explain.ts:440-442`), because the disclosure's job is to show the rule as
authored and section 10.4's conflict rules are computed against the declared values.

#### 7.3.1 A narrowing action and a pre-approval may not share a rule

A rule that carries a narrowing action (`require_approval` or `add_restrictions`)
together with `pre_approve_within_bounds` is **refused at compile time** with the code
`rule.conflicting_action_effects` (`src/rules/compile.ts:801-808`). The compiler directs
the author to write two rules, which section 10.4's conflict rules already resolve; two
rules also get two explanation nodes and two sort keys.

The reason is that the M0 `Rule` shape holds exactly **one** `effect`, so a projection
of both would silently drop one. A silent drop is worse than a refusal, and the two
possible drops are not equally bad:

- a dropped **narrowing** action makes the rule *weaker* than it reads. The author
  believes a restriction applies and it does not.
- a dropped **pre-approval** action makes the rule *inert*. Nothing happens, which
  looks identical to a rule that matched nothing.

Only the weakening would ever be noticed, and only indirectly. An inert rule produces no
symptom at all, which is indistinguishable from a rule that matched nothing; a weakened
rule produces a symptom, but one that points at the policy engine rather than at the
rule. A refusal reports both possibilities in one message, before either can take
effect. This composition is representable in M6 and is refused by the M6 compiler rather
than made unrepresentable in the M0 surface, because section 2 exists to avoid editing
`ruleSchema`.

#### 7.4 `add_restrictions`

```ts
{
  kind: "add_restrictions",
  deniedCapabilities?: string[],          // 0..64
  allowedCapabilities?: string[],         // 0..64
  maximumTimeoutSeconds?: number,
  allowDestructiveEffects?: false,        // z.literal(false) when present
  allowExternalEffects?: false            // z.literal(false) when present
}
```

Again a `PermissionNarrowing` subset. `allowDestructiveEffects` and `allowExternalEffects`
are `z.literal(false)` for the same reason as in 7.3: the only legal value is the
disabling one, so the field exists to state a restriction explicitly and cannot state the
opposite.

Projects into `kernelRule` as a `restrict` effect.

#### 7.5 `select_routing_preference`

```ts
{
  kind: "select_routing_preference",
  preference: {
    preferredNodeIds?: string[],          // ordered, most preferred first, 0..64
    requiredRuntimeKind?: string,
    requiredProjectPathId?: string,
    excludedNodeIds?: string[]
  }
}
```

At least one member must be present. `preferredNodeIds` is an **ordered list, not a
score**. A numeric weight would be a hidden priority that no screen can render as an
ordering a user can reason about, and two weights that tie produce an ordering that
depends on evaluation order rather than on the rule.

Consumed by `src/routing/`. It is a *preference* and never overrides hard eligibility: a
rule cannot route to a node that lacks authorization, a project path, a runtime
capability, or health (plan, "Budgets and Routing"). See section 13.

#### 7.6 `set_stricter_budget`

```ts
{
  kind: "set_stricter_budget",
  budget: {
    maximumFanOut?: number,
    maximumConcurrency?: number,
    maximumRetryLimit?: number,
    maximumWallClockSeconds?: number,
    maximumUsageUnits?: number,
    usageUnit?: "tokens" | "bytes" | "provider_cost_micros"
  }
}
```

At least one member must be present. Composition against the effective budget is
elementwise `min`. A declared value *greater* than the current budget is a widening
attempt: recorded in the trace as `rejected_widening`, ignored, and never applied. This
is the same monotone discipline as `narrowPolicyState`, applied to a different algebra.

`maximumWallClockSeconds` is locally enforceable. `maximumUsageUnits` is enforceable only
when the runtime adapter reports reliable usage for the run in progress; when it does not,
the budget decision reports `not_enforceable` and a warning names the budget. The plan
forbids claiming provider cost enforcement when usage data is missing or delayed, so
"we set a cost budget" is not a claim this system is permitted to make without a
measurement behind it.

#### 7.7 The invariant

> **No action can grant a capability removed by the system safety floor or by a role
> restriction.**

The mechanism is threefold and none of the three depends on discipline:

1. **Representability.** The four action fields that could ever relax a floor value are
   `z.literal(false)` or are absent by construction (`allowDestructiveEffects`,
   `allowExternalEffects`, and the same pair in `add_restrictions`). A schema-valid action
   cannot express the escalation.
2. **Monotone composition.** Everything that narrows goes through `narrowPolicyState`
   (`src/orchestration/policy/floor.ts:101`), which cannot produce a wider state. The
   `set_stricter_budget` action uses the same elementwise `min` discipline over budgets.
3. **Post-narrowing re-check.** `pre_approve_within_bounds` and `select_routing_preference`
   are resolved against the *post-narrowing* state, and `select_routing_preference` is
   additionally filtered through hard eligibility, so a rule's routing choice is a
   reordering of already-eligible nodes rather than an admission.

A widening attempt is never silently dropped. It appears in the trace with
`rejected_widening` and in the rendered explanation with the attempted values, because a
rule that *tried* to escalate is an audit event whether or not it succeeded.

### 8. Universal predicates and the "match all" restriction

A rule whose predicate is empty or `all([])` matches every dispatch. The plan forbids
"match all projects/nodes/capabilities" pre-approval in the initial release, and that
forbids a rule that constrains nothing *while pre-approving*.

**A rule carrying `pre_approve_within_bounds` or `select_routing_preference` must have
at least one predicate that constrains one of:** `projectId`, `roleId`, `roleVersion`,
`capability`, `toolCategory`, `runtimeKind`, `targetNodeId`,
`nodeAdvertisedCapability`, `projectPathId`, `taskLabel`, `dependencyOutcome`,
`contextSensitivity`. A document that violates it is refused at compile time with a named
code, `rule.universal_pre_approval`, by the compiler pass `checkNotUniversal`
(`src/rules/compile.ts:708-723`), against the same twelve fields exported as
`NON_UNIVERSAL_PREDICATE_FIELDS` at `src/rules/types.ts:292-305`. The list is exhaustive,
and `taskTitlePattern` is **not** on it; section 6.3 gives the reason.

> **AMENDED 2026-10-02. The paragraph above states the *axes*; section 8.2 states what
> it takes to constrain one.** Naming a field is no longer sufficient: a predicate only
> counts if it is a **constructive form** for that axis, and a `not` counts for nothing.
> Section 8.2 is normative and supersedes the "at least one predicate that constrains"
> wording above, which is retained for the axis list it gets right.

**This is a named compiler pass, not a Zod `.superRefine`, and the distinction is what
makes the restriction expressible.** The check is not attached to the action schema,
because a `.superRefine` there could only express "no action may *ever* be universal" —
which would forbid the four action kinds for which a universal rule is the safe and
correct thing to write (`deny_with_reason`, `require_approval`, `add_restrictions`,
`set_stricter_budget`). Separating it into a compiler pass is what allows the
restriction to apply to exactly the two permissive action kinds
(`pre_approve_within_bounds`, `select_routing_preference`) and to no others: the pass
first filters the rule's actions to the two scope-bearing kinds it names in its own
module-private `SCOPE_BOUND_ACTION_KINDS` (`src/rules/compile.ts:536-539`), returns
immediately if there are none (`src/rules/compile.ts:709-710`), and only then evaluates
the predicate list. The same reasoning is recorded at the declaration
(`src/rules/types.ts:275-291`).

A `not` counts as constraining. `not(projectId eq "p")` cannot be satisfied by every
dispatch, so the rule is not universal and the disclosure can state exactly what it
excludes (`src/rules/compile.ts:532-542`). Counting only positive occurrences would
refuse that rule for a reason that does not apply to it, and a refusal an author cannot
understand is a refusal they work around with a narrower, less comprehensible rule.

> **SUPERSEDED 2026-10-02. The paragraph above is wrong, and the shipped code does not
> implement it.** A `not` contributes **nothing** to the scope test; the citation
> `src/rules/compile.ts:532-542` no longer names that code. The pass is now
> `constrainingScopeAxes` (`src/rules/compile.ts:668-706`), and a rule whose only
> constraint is a `not` is refused as universal. This paragraph is left visible rather
> than rewritten, because an ADR that silently replaces a decision is an ADR nobody can
> audit. **Section 8.2 is the normative text, and it supersedes this one.**

A universal rule is permitted for `deny_with_reason`, `require_approval`,
`add_restrictions`, and `set_stricter_budget`, because a restriction that applies
everywhere is the safe direction and refusing it would push users toward writing
narrower, less comprehensible rules for a genuinely global concern.

**There is no `default_action`.** A catch-all action with a permissive body is the
"match all" pre-approval with an extra step, and it would be evaluated by the same
machinery that is supposed to make it impossible. Exhaustiveness is provided instead by
the check above.

### 8.1 Six refusal families, not two: everything that can never match

The other compile-time refusals are collected by `checkUnsatisfiable`
(`src/rules/compile.ts:452`), and it refuses **six** families under the single code
`rule.empty_enum` (`src/rules/compile.ts:476`, `:483`, `:490`, `:498`, `:514`, `:523`).
Every one of them is the same shape: an enumeration, a member set, an interval, or a
window list that is empty, which is a predicate that can never be satisfied.

Listed in the order the branches appear in the function, so the table and the source read
together:

| # | Refused shape | Fields it covers | Branch |
| --- | --- | --- | --- |
| 1 | `in` / `hasAny` / `hasAll` with no members | `projectId`, `roleId`, `targetNodeId`, `projectPathId`, `runtimeKind`, **`taskLabel`** — six identifier- and label-valued predicates | `src/rules/compile.ts:457-479` |
| 2 | `any([])` — the disjunctive combinator with no operands | *(combinator)* | `src/rules/compile.ts:480-486` |
| 3 | `scheduleWindow` with no windows | `scheduleWindow` | `src/rules/compile.ts:487-493` |
| 4 | A set predicate with no members, under **any** of `any` / `all` / `none` | `capability`, `toolCategory`, `nodeAdvertisedCapability` | `src/rules/compile.ts:494-502` |
| 5 | `between` whose `min` exceeds its `max` — an empty interval by construction | `roleVersion`, `fanOut`, `concurrency`, `retryLimit`, `timeoutSeconds` — all five bounded-integer predicates | `src/rules/compile.ts:503-519` |
| 6 | `contextSensitivity` with an empty member array | `contextSensitivity` | `src/rules/compile.ts:520-526` |

**`taskLabel` is in row 1, and it was not.** The branch condition
(`src/rules/compile.ts:457-473`) reads `predicate.field === "taskLabel" &&
predicate.operator !== "has"` alongside the five identifier fields, and the reason is
the same one as every other row: `taskLabel hasAll []` and `taskLabel hasAny []` are
**vacuously satisfied by every labelled dispatch**. A task carrying any label at all
satisfies a conjunction over no labels and a disjunction over no labels, so the
predicate matched everything while naming a label set no author wrote — and being a
scope field, it cleared the section 8 safety floor on the way past. It was accepted
before this amendment because the branch enumerated the five `in`-valued fields and
forgot the field that also takes a member set.

The `operator !== "has"` exclusion is a shape distinction, not an exemption: `has` takes
a **single** label, not a member set, so `taskLabel has` has no empty-array spelling and
nothing to refuse. Every array-valued `taskLabel` operator — `hasAny`, `hasAll` — is
refused when empty.

All six are asserted branch by branch: rows 1 (the five identifier fields) and 2 to 6 at
`tests/unit/rules/compile.test.ts` in the "an unsatisfiable predicate is a compile error"
block, and the `taskLabel` half of row 1 at `tests/unit/rules/vacuity.test.ts` in the
"an empty task-label enumeration is refused as an unsatisfiable predicate" block — which
also carries the control that `taskLabel has` with a real label still compiles, because a
refusal with no passing control is a refusal nobody can tell apart from an over-refusal.
Two of the six are worth calling out because the previous form of this section named only
the `capability any []` case of row 4 and the `roleVersion` case of row 5, and a reader
following it would author the others and be refused for a reason the document never
mentioned:

- **`capability all []` and `capability none []` are refused, not just
  `capability any []`.** `all []` and `none []` are vacuously universal, and allowing
  them next to a refused `any []` would give a pre-approval two spellings of "constrain
  nothing" where one is refused and one is not.
- **`roleVersion between 5 and 3`, `fanOut between 4 and 2`, and the same on
  `concurrency`, `retryLimit`, and `timeoutSeconds` are all refused**, not just the
  `roleVersion` case the section 6 table names. An inverted interval is an empty set of
  integers written in a way that does not look empty.

**The rationale is one property behind all six: a rule that matches nothing is
indistinguishable, from the outside, from a rule that was never loaded.** Both present to
an operator watching a dispatch go un-pre-approved as the same observation — a rule that
was supposed to fire and did not. A refusal produces a named code, a message naming the
field and the offending value, and an artifact at compile time. A silent no-op produces
none of those, and there is nothing to go looking for: the compiled set reports a rule
present and enabled, the disclosure renders its (empty) reach, and the only symptom is an
absence. **A silent no-op is worse than a refusal precisely because it leaves no
artifact**, which is the same argument that makes section 7.3.1 refuse a conflicting
action pair rather than drop one, and that makes the `set_stricter_budget` widening
attempt an audited `rejected_widening` rather than a silent ignore.

These six are refused in a **compiler pass**, not by the schema, and that placement is
deliberate: enforcing them in the schema would report them as `rule.invalid_source`,
which is indistinguishable from a typo, and would put the same policy in two places
(`src/rules/compile.ts:446-450`). The check runs as pass 6 of `compileRule`, after
parsing, limits, and pattern compilation and before the universal-predicate check
(`src/rules/compile.ts:1153-1160`; the universal check is pass 7, immediately after).

The schema still permits the *parse* of an empty array, exactly as it permits the parse of
`all([])`; `PARSE_SHAPE_ARRAY_GUARD` (`src/rules/limits.ts:194`) is a shape guard two
orders of magnitude above every real limit, not a policy. So every row in this table is a
**named refusal with a diagnostic an author can act on**, not a shape error — which is the
distinction section 6 draws under the table.

### 8.2 Constructive scope: naming a field is not constraining it

**This section supersedes the "at least one predicate that constrains one of the twelve"
wording in section 8, and the "a `not` counts as constraining" paragraph there.** The
twelve *axes* are unchanged and `NON_UNIVERSAL_PREDICATE_FIELDS`
(`src/rules/types.ts:292-305`) is still the exhaustive list. What changed is the test
applied to a predicate on one of those axes, and it is the difference between a check
that can be satisfied by a spelling and a check that can only be satisfied by a claim.

The previous test was **syntactic**: recurse the tree, count every arm, and treat a
`not` as constraining. It admitted several shapes that are the match-all pre-approval
wearing a different hat, each of which compiled, cleared the safety floor, and produced
a disclosure that disagreed with what the rule actually did. The test now is
**constructive**: a predicate contributes a scope axis only if it can *exclude at least
one dispatch* on that axis, and the three subsections below are the three corrections
that closed the holes.

#### 8.2.1 A field predicate must be a constructive form for its axis

`excludesDispatch` (`src/rules/compile.ts:615-651`) is the whole test, and
`CONSTRUCTIVE_FORMS` (`src/rules/compile.ts:569-600`) is its table of which operators
can name a value from a bounded vocabulary. Naming a field is not enough:

| Axis | Constructive operators | Refused, and why |
| --- | --- | --- |
| `projectId`, `roleId`, `projectPathId`, `runtimeKind`, `targetNodeId` | `eq`, `in` | — closed identifier vocabularies; any operator that does not name a value excludes nothing |
| `capability`, `toolCategory`, `nodeAdvertisedCapability` | `any`, `all` | **`none`** — it names a value's *absence*, so a dispatch that never requests the capability satisfies it, and a rule scoped only by `none` matches every dispatch that does not have the capability |
| `taskLabel` | `has`, `hasAny`, `hasAll` | **`lacks`** — same argument: it names an absence |
| `roleVersion` | `eq`, `lt`, `lte`, `gt`, `gte`, `between`, **with the bounds inspected** | a comparison pinned to an edge of the declared range `1..1000` excludes nothing: `gte 1`, `lte 1000`, and `between 1 and 1000` are all satisfied by every dispatch the schema admits |
| `dependencyOutcome` | `anySucceeded`, `anyFailed`, `allSucceeded`, `allFailed` | `none` — same absence argument |
| `contextSensitivity` | `any`, `maxRankAtMost`, `maxRankAtLeast`, **with the bounds inspected** | `none`, and a rank comparison pinned to an extreme: over a four-rung lattice, `maxRankAtMost 3` and `maxRankAtLeast 0` are satisfied by every rung |

This is why the check inspects **bounds** and not just operator names on the two
bounded axes: `roleVersion eq 3` excludes, `roleVersion gte 1` does not, and both name
the field with a member of the same operator set. The bounds come from the field's own
declared range — `ROLE_VERSION_MINIMUM` / `ROLE_VERSION_MAXIMUM` (1 and 1000,
`src/rules/compile.ts:600-601`) and `SENSITIVITY_RANKS` (4,
`src/rules/compile.ts:604`) — so a change to either schema range cannot leave the scope
test asserting a range the language no longer has.

#### 8.2.2 A `not` contributes nothing

**A `not` arm contributes no scope axis, at any depth.** `constrainingScopeAxes`
(`src/rules/compile.ts:668-706`) inspects the tree *below* a `not` and credits nothing
to the `not` itself.

This reverses the previous text, and the reason is a correction rather than a
tightening for its own sake. The superseded paragraph argued that
`not(projectId eq "p")` "cannot be satisfied by every dispatch". It cannot — but it
cannot be satisfied by the dispatch that *names* `p`, which is the dispatch the rule's
own disclosure says it applies to, and in a system with one project every other dispatch
satisfies it. So a rule whose entire predicate was `not(projectId eq "p")` counted as
scoped, cleared the floor's per-dispatch approval, and told the operator it excluded one
project. The reasoning is: a `not` inverts the predicate it wraps and therefore can only
ever **discard** exclusions established below it. The exclusions below it are what
count; a rule whose *only* constraint is a `not` is the match-all pre-approval this
release refuses, and is now refused as one with `rule.universal_pre_approval`.

#### 8.2.3 An `any` branch containing any `not` arm contributes nothing

**A disjunctive branch that contains a `not` arm is not usable as a scope, and
contributes nothing — the whole branch, not just the `not` arm.** This is the specific
defect the review found in the first version of this pass, and it is worth stating
precisely because the fix is *not* complement reasoning.

`any(A, not A)` **compiled**. The two arms are complementary, so the branch holds for
every dispatch — it is a tautology, and the branch is satisfied whatever the dispatch is.
The previous test recursed into the `any`, counted the positive arm `A`, and skipped the
`not` (per 8.2.2), so it declared the rule scoped. The rule then cleared the safety
floor's approval while the section 11 disclosure reported a **one-project reach citing
the very atom whose negation is its sibling**: an operator reading the disclosure would
believe the pre-approval was confined to `p`, and it was not confined to anything.

The general rule needs no complement analysis. **A disjunction containing a negation
cannot be stated as a reachable SET on any axis**, and a reachable set is exactly what
the section 11 disclosure is required to render per axis; it would have to render
`unknown` for a rule whose entire purpose is to scope. That is the same reason a bare
`not` is refused, so this is one rule applied twice rather than a special case for
`any(A, not A)`. The branch contributes nothing and the enclosing `all` decides whether
some *other* arm scopes the rule. Fail-closed, and consistent with 8.2.2.

#### 8.2.4 What this test is, and what it is not

It is a **per-atom syntactic test over the predicate tree, not a satisfiability
solver.** It decides whether a rule *contains a claim that can exclude*, never whether
the rule as a whole is satisfiable or whether its clauses contradict each other. That is
a deliberate limit and it is conservative in one direction only: the test can be fooled
into crediting scope the rule does not have, and it cannot be fooled into refusing scope
the rule does have — with the one exception recorded in the amendment's residual-risk
note. The consequences of being a syntactic test rather than a solver are stated there
rather than here, because they are a property of the approach and not of any one
predicate family.

### 9. Complexity limits

Every value below is a named export, every one is applied by the compiler, and a test
asserts each one is enforced. A limit that only exists inside a handler is a limit nobody
can assert; this mirrors the reasoning already recorded in
`src/mesh/protocol/bounds.ts`.

| Constant | Value | Rationale |
| --- | --- | --- |
| `MAX_PREDICATES_PER_RULE` | 64 | A rule a person cannot read on one screen is a rule nobody audits |
| `MAX_PREDICATE_DEPTH` | 6 | Bounds recursion; deep trees are for encoding, not for matching |
| `MAX_COMBINATOR_NODES_PER_RULE` | 256 | Bounds traversal cost independently of the surface predicate count |
| `MAX_RULES_PER_SET` | 512 | Bounds compile and evaluation time linearly |
| `MAX_ACTIONS_PER_RULE` | 16 | Actions compose into four different subsystems |
| `MAX_ENUMERATED_MEMBERS` | 64 | Bounds every `in`/`any`/`all`/`none` set |
| `MAX_LABEL_MEMBERS` | 32 | Labels are free-form and would otherwise dominate the bound |
| `MAX_SCHEDULE_WINDOWS_PER_RULE` | 8 | A schedule with more windows than this is not a schedule |
| `MAX_RULE_PATTERN_LENGTH` | 128 | Reuses `MAX_RULE_PATTERN_LENGTH` (`src/mesh/protocol/bounds.ts:35`) |
| `MAX_RULE_PATTERN_NESTING_DEPTH` | 2 | Reuses `MAX_BOUNDED_NESTING_DEPTH` (`src/mesh/protocol/safe-pattern.ts:410`) |
| `MAX_RULE_NAME_LENGTH` | 256 | Matches `shortTextSchema` elsewhere in the kernel |
| `MAX_RULE_REASON_LENGTH` | 4_096 | A reason must fit an audit view; see `TEXT_MAX` at `src/orchestration/policy/types.ts:26` |
| `MAX_RULE_NOTE_LENGTH` | 512 | Notes are annotations, not content |
| `MAX_COMPILED_RULE_SET_CANONICAL_BYTES` | 262_144 | Reuses `MAX_ENVELOPE_BYTES` (`src/mesh/protocol/bounds.ts:17`), so the size the limit is checked against and the size the digest covers are the same size |
| `MAX_EXPLANATION_TEXT_CHARS` | 65_536 | Reuses the kernel's bound at `src/orchestration/policy/types.ts:254` |
| `MAX_FAN_OUT` | 256 | Ceiling on any fan-out value a predicate or budget may name |
| `MAX_CONCURRENCY` | 256 | Ceiling on any concurrency value |
| `MAX_RETRY_LIMIT` | 16 | A retry limit above this is a defect, not a policy |
| `MAX_RULE_EXPIRY_DAYS` | 3_655 | Bounds how long a no-expiry rule may be expressed as a date; `"no expiry"` remains `null` and is warned about |

Limits are measured against **canonical JSON**, for the reason already recorded at `src/mesh/protocol/bounds.ts:11-15`: a limit defined against one serializer's framing is a
limit the next serializer silently evades, and canonical bytes are what the digest covers.

**The rule-count limit and the byte limit are both enforced, and they are in tension.**
`MAX_RULES_PER_SET` is applied to the input count (`src/rules/compile.ts:1105-1111`,
value at `src/rules/limits.ts:81`) and `MAX_COMPILED_RULE_SET_CANONICAL_BYTES` is applied
to the canonical projection of the compiled set (`src/rules/compile.ts:1156-1163`, value
at `src/rules/limits.ts:147`), and both refusals carry `rule.limit_exceeded`. 256 KiB
divided by 512 rules is 512 canonical bytes per rule. A set at the count limit is
reachable only with the smallest rule the language accepts: a draft with no predicates
and a one-character name and deny reason (`tests/unit/rules/limits.test.ts:307-322`). A
set of 512 rules carrying a readable name, a described purpose and a real predicate does
not fit in 256 KiB, so **the byte
limit binds first** for any rule that is more than a placeholder, and a reader must not
assume the two rows are independently reachable. This tension is the design, not a defect:
the count limit bounds how many rules there are and the byte limit bounds how much text
they carry (`tests/unit/rules/limits.test.ts:295-306`). The byte bound is measured over
the compiled projection rather than over a list of per-rule digests precisely so it stays
a real ceiling: a digest list is roughly 200 bytes per rule no matter how large the rule
is, which would make a 256-KiB bound unreachable in practice and the limit a comment
(`src/rules/compile.ts:1176-1190`).

### 10. Precedence, ordering, and conflict

#### 10.1 Layer precedence is unchanged

The M6 rule layer sits inside the existing five-layer precedence
`src/orchestration/policy/types.ts:49`:
`safety_floor > project > role > rule > dispatch`. M6 adds no layer. A rule is a
narrowing input to layer 4, not a new layer, because a layer that could both narrow and
route would need its own precedence relation against routing and there would be no
principled answer.

#### 10.2 Deterministic rule order

Rules are evaluated in this total order, computed from identity alone and never from
mutable state:

1. `ruleId` ascending, by **UTF-16 code unit** comparison.
2. `templateVersion` ascending.

Within one rule: predicates in declared order (declaration order is part of the normalized
form and is therefore visible to the user), then actions in **action-kind rank** order:

```
deny_with_reason(0) < require_approval(1) < add_restrictions(2)
  < set_stricter_budget(3) < select_routing_preference(4) < pre_approve_within_bounds(5)
```

Restrictive before permissive. The rationale is auditability: the dispositions a reader
must understand before they can judge a grant are computed and recorded first, so the
explanation reads "here is what is forbidden, here is what is capped, and *therefore*
here is what was granted".

**Code-unit ordering, not `localeCompare`.** The M3 kernel orders rule snapshots with
`localeCompare` (`src/orchestration/policy/evaluate.ts:113`). Milestone 6 does not change
that line, because editing it is an M3 kernel change outside this milestone's scope. The
two orderings can differ for identifiers that differ by case or contain non-ASCII
characters. This is safe and the reason is structural rather than lucky: supersession
selects the maximum version and is order-independent, and every conflict rule below is
decided by restrictiveness rather than by position. The only observable difference is the
order of independent sibling nodes in the explanation tree, which carries no decision.
This is recorded as a known divergence rather than left for a reviewer to discover.

#### 10.3 Supersession

For each `ruleId`, only the highest `templateVersion` among enabled, activated,
unexpired rules is effective. Lower versions are recorded `superseded` and are never
evaluated. This reuses `orderRuleSnapshots` semantics exactly.

An edit therefore never retroactively affects anything: a dispatch already carries an
immutable, digest-bound `ruleSnapshots` array
(`src/application/local-project-registry.ts:124` into
`src/application/service.ts:825`), and an open proposal is invalidated rather than
silently re-evaluated when its rule snapshots change
(`src/application/service.ts:961-976`).

#### 10.4 Conflict resolution

Given the effective rule set, for one dispatch:

| Conflict | Resolution | Recorded as |
| --- | --- | --- |
| `deny_with_reason` and `pre_approve_within_bounds` both match | **Deny wins.** | `conflict: { kind: "deny_overrides_pre_approval", ruleIds: [...] }` |
| Two or more `deny_with_reason` match | Lowest sort key reports the reason; all are recorded | `conflict: { kind: "multiple_deny", ruleIds: [...] }` |
| Two or more `pre_approve_within_bounds` match | The lowest sort key whose bounds are fully satisfied grants; the others are recorded as shadowed | `conflict: { kind: "multiple_pre_approval", grantedBy, shadowed }` |
| Two or more `select_routing_preference` match | Preferences are unioned in rule sort order; the first non-empty `preferredNodeIds` wins, later ones extend the tail | `conflict: { kind: "multiple_routing_preference", ruleIds }` |
| Two or more `set_stricter_budget` match | Elementwise `min` | no conflict; each contribution is traced |

Restrictive-wins is not a heuristic. A grant and a deny over the same dispatch has exactly
one safe answer, and choosing the other one because it was cheaper to implement would mean
the rule language could express an unsafe state.

#### 10.5 Shadowing detection (for preview)

Rule A **shadows** rule B when both are effective, A's predicate is a proven logical
superset of B's, and A's actions are a superset of B's actions.

Superset is *proven* structurally on the normalized AST, or not at all:
`all([])` is top, `all` is intersection, `any` is union, `not` is complement; two field
predicates are comparable only when they name the same `field` and their operator sets are
subset-comparable. Where superset cannot be proven, the preview reports
`possible_overlap`, never `shadowed`.

This distinction is the point. A preview that reported `shadowed` for two rules that
merely *might* co-match would train the user to ignore the field, and the one time it
mattered would be the time they ignored it.

### 11. Normalized form and the pre-approval disclosure

Every compiled rule carries `normalizedPredicate`, a canonical single-line string built
from the normalized AST: field name, operator, members sorted by code unit, combinators
parenthesized, no whitespace variance. It is the form the pre-approval disclosure displays
and the form the compiler digests, so the thing a user reads and the thing that is hashed
cannot differ.

A pre-approval disclosure must show, and each item names where its value comes from:

| Required by the plan | Field |
| --- | --- |
| Exact predicate and normalized form | `normalizedPredicate` (section 11) |
| Projects, roles, capabilities, nodes, and paths it can match | `reach.projects`, `reach.roles`, `reach.capabilities`, `reach.nodes`, `reach.projectPaths`, each a sorted de-duplicated set, each annotated `unknown` when the predicate is unconstrained on that axis |
| Maximum fan-out, concurrency, retry, timeout, sensitivity | `bounds`, from the action's declared values, **not** a computed narrowing |
| Historical dispatches it would have matched | `historicalMatches`, from the supplied proposal/finished history |
| Conflicts or shadowing by other rules | `conflicts`, from section 10.4 and 10.5 |
| Expiry or "no expiry" warning | `expiresAt`, with the literal text "no expiry" when `null` |
| Creator identity, version, activation time | `author`, `templateVersion`, `activation.activatedAt`, `activation.activatedBy` |

An `unknown` reach on a pre-approval axis is itself a warning: a pre-approval that is
unconstrained on projects or capabilities is the shape the plan restricts, and the
disclosure says so in words rather than leaving a blank set to be read as an empty one.

### 12. What must never appear in an explanation or a notification

Rendered explanations, traces, disclosures, and notification payloads contain identifiers,
enum values, numbers, digests, rule metadata, and reason strings authored by a user for
the purpose of explaining a decision.

They never contain: prompt text, task descriptions, context manifest item content, memory
record content, capability payload bytes, terminal output, environment values, bearer
tokens, or provider credentials.

This is enforced, not documented. `src/context/isolation.ts` already audits a
*structurally typed* preview rather than trusting the renderer it is checking
(`src/context/isolation.ts:94-122`), because a redaction check that imported the renderer
it was checking could be defeated by a change to the renderer. Milestone 6 extends that
audit to rule previews and notification payloads, and the audit input type is declared
structurally in the audit module, never imported from the view model.

### 13. Budgets

#### 13.1 The algebra

```ts
interface BudgetLimits {
  maximumFanOut?: number
  maximumConcurrency?: number
  maximumRetryLimit?: number
  maximumWallClockSeconds?: number
  maximumUsageUnits?: number
  usageUnit?: "tokens" | "bytes" | "provider_cost_micros"
}

type BudgetEnforceability = "enforceable" | "not_enforceable"

interface BudgetDecision {
  readonly limits: BudgetLimits
  readonly enforceability: Readonly<Record<keyof BudgetLimits, BudgetEnforceability>>
  readonly warnings: readonly string[]
}
```

Composition is elementwise `min` over present keys. A declared value greater than the
current budget is a widening attempt, recorded and ignored (section 7.6). Enforceability is
computed from whether the adapter reported reliable usage for this run, never from whether
a budget was set.

#### 13.2 Reservation is atomic with eligibility

```ts
type ReservationState = "held" | "released" | "committed" | "expired"

interface BudgetReservation {
  readonly reservationId: string
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly taskId: TaskId
  readonly dispatchId: DispatchId
  readonly scope: "concurrency" | "fan_out"
  readonly units: number
  readonly state: ReservationState
  readonly leaseExpiresAt: Timestamp
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}
```

The invariant is stated as a definition rather than as a check:

> **A dispatch is eligible to launch if and only if it holds a `reservationId` whose
> reservation is in state `held`.**

The ceiling invariant that the compare-and-set below maintains, and that section 13.3
restores after a replay, is:

> **For every `(projectId, scope)`, the total units held by `held` and `committed`
> reservations never exceeds the resolved ceiling for that scope.**

(`held` and `committed` are the two occupying states and no others —
`OCCUPYING_RESERVATION_STATES`, `src/budgets/types.ts:429`, behind
`occupiesCapacity` at `src/budgets/types.ts:442-444`. The two terminal states are
`released` and `expired` (`src/budgets/types.ts:434`), and section 13.3 depends on that
split.)

`BudgetLedger.reserve` performs the compare-and-set against the current held-unit total
inside a single store transaction, and returns the new reservation or a refusal. Because
eligibility is *defined* as holding the reservation, there is no window in which the
check has run and the reservation has not been taken, and no ordering of two operations
that produces an unreserved dispatch. Checking a budget and then reserving is the shape
this design exists to prevent.

Release happens on any terminal dispatch state. Replay recovery reclaims a `held`
reservation whose owning dispatch reached a terminal state, or whose `leaseExpiresAt`
passed, so a crash between reserve and release cannot leak capacity permanently. That is
`recoverLeaked` (`src/budgets/recovery.ts:320`), and it is a *sweep* of a live ledger.

Rebuilding a ledger from a durable log is a different operation with a different
obligation, and section 13.3 is about it.

#### 13.3 Replay is a second admission decision, and it classifies rather than totals

```ts
function replayDurableReservations(
  target: ReplayTarget,
  records: readonly BudgetReservation[],
  request: { readonly now: string; readonly ceilings: readonly ReplayCeiling[] },
): ReplayReport
```

(`src/budgets/recovery.ts:629-637`; `ReplayCeiling` at `src/budgets/recovery.ts:492-497`.)

**Replay is not a restore.** It is a second admission decision, made against the
ceilings the caller resolved, and it is the reason the argument "a verbatim replay
cannot over-admit, because the log is exactly what the crashed process admitted" is
wrong in the two cases that matter:

1. **A log is not necessarily a faithful history.** A writer that re-emits rows, a log
   shipped twice and concatenated, a writer that minted a fresh `reservationId` per
   attempt, a log truncated at the wrong offset — each describes more held units than any
   budget allowed, and verbatim replay installs all of them.
2. **The budget is not necessarily the same budget.** `ceilings` is a caller-resolved
   value, and the caller may have *narrowed* the ceiling since the crash — a rule
   contribution that did not exist then.

And the consequence of over-admitting is **not a bypass.** It is a **wedge**, and the
distinction is the whole point of this subsection. With `held = 5` against a `ceiling`
of `1`, `reserveInTransaction` computes `5 + 1 > 1` and refuses — and refuses every
future reserve too. The budget is not exceeded; it has stopped being a budget, at the
worst possible moment, and the operator sees a saturated scope with no saturation to
show for it. A wedge is an availability failure wearing a safety costume, which is why
a fix that simply refused harder would have been the wrong fix.

**Each OCCUPYING row is assigned exactly one named verdict, and the checks are applied
in this order** (`src/budgets/recovery.ts:722-731`; the reason vocabulary is
`REPLAY_REJECTION_REASONS`, `src/budgets/types.ts:772`, and there are exactly three):

| Order | Verdict | Fires when | Why it is here and not later |
| --- | --- | --- | --- |
| 1 | `duplicate_dispatch` | this is not the **first** row for this `dispatchId` in `reservationId` order | a duplicate consumed no capacity the first row did not already consume, so refusing it is free; refusing the *first* would discard a real reservation. Checked first because it fires on the first **seen** dispatch rather than the first **admitted** one, which is what catches the terminal-then-occupying pair |
| 2 | `ceiling_undeclared` | the caller resolved **no** ceiling for this `(projectId, scope)` | "no budget declares a maximum" is not "unlimited" (invariant L8). Refusing is the fail-closed reading of an absent fact |
| 3 | `over_ceiling` | the rows are all distinct dispatches and `admittedHere + units > ceiling` | this is the genuine over-limit history, and it is the only verdict that means it |

A **terminal** row (`released` or `expired`) occupies nothing, so it cannot breach any
ceiling and is installed without consulting one (invariant R17,
`src/budgets/recovery.ts:693-707`). A log of a hundred terminal rows against a project
with no budget declared replays intact, and is not a special case.

**A rejected row is installed as `expired`, never `released`.** `expired` is chosen over
`released` because `released` asserts a terminal *dispatch state* — a fact replay has no
evidence for, since the process that would know is the one that died — while `expired`
asserts only that this reservation is not holding capacity, which is exactly true
(`src/budgets/recovery.ts:737-753`). The row is still installed rather than dropped, so
it remains auditable, reachable by `read`, and present in `list()`; `previousState` in
the report is the log's word and `restoredState` is replay's.

**Two properties make the composition safe rather than merely reasonable, and they are
the difference between this and a wedge:**

- **Refusal is never total (R13).** Every row read is either installed or collapsed into
  a row already installed, so
  `restored.length + collapsedRecords === recordCount` holds for every log. A replay
  cannot lose a reservation, because losing one is how a log stops describing history at
  all.
- **Refusal RETURNS capacity (R14).** `expired` is non-occupying, so
  `admittedUnits + rejectedUnits === occupiedUnits` per scope and the recovered ledger
  still answers a reserve from the ceiling rather than from a total nobody can account
  for. A refusal that merely *recorded* the refusal would satisfy the first property and
  fail the second, and would wedge exactly as before.

**The `held <= ceiling` invariant of section 13.2 holds after ANY replay** (R12,
`src/budgets/recovery.ts:581-584`). It is stated as an equality of obligation: it must
hold for every log, including logs the implementation has never seen. The per-scope
arithmetic in `ReplayReport` is published precisely so the property is *checkable* rather
than asserted.

Three further invariants hold alongside it, and each is a place a second implementation
would have diverged: replay is a **function of the set of records, not their order**
(R15 — rows are reduced to one canonical row per `reservationId` and walked in code-unit
order, so two replays of the same rows in any order produce byte-identical reports);
`now` is **accepted and applied to nothing** (R16 — timestamps are the log's, and a
refusal changes exactly one member, `state`); and **one dispatch gets one reservation,
first row wins** (R19).

The five-rows-against-a-ceiling-of-one case is asserted directly in
`tests/unit/budgets/recovery.test.ts` ("installs at most the ceiling when a log holds five
reservations against a ceiling of one"), the ceiling invariant is additionally held across
**400 seeded log-and-ceiling pairs** in the same file and **300 adversarially-named logs**
in `tests/unit/budgets/adversarial.test.ts`, and the non-wedging property is asserted as
its own case ("lets a ledger over a replayed state fill exactly the remaining capacity and
then refuses with the numbers") rather than left implied by the ceiling case — because
"the ceiling holds" and "the ledger still works" are different properties, and only the
first is obvious from reading the code.

**The two defects found while fixing this, recorded because both are the kind that a
green suite does not catch.**
1. **The maintained `releasedUnits` index subtracted on `held -> committed`.** Both
   states occupy capacity, so a commit is a move *within* the occupying set and must
   return nothing; the index computed the subtraction from "was occupying" alone, so
   every commit looked like a release and the index under-reported the held total by
   exactly the units of everything that had ever launched
   (`src/budgets/ledger.ts:463`). Admission was never affected — `reserveInTransaction`
   recomputes the total from the reservation **list** rather than reading the index — so
   what was wrong was the number a caller reads to render "3 of 5 held", which is the
   over-release direction of unit conservation, floored to zero rather than exposed.
2. **A store that reported success while moving nothing defeated every recovery check,
   because they all trusted return values.** `recoverLeaked` now reads the ledger back
   **once** and demotes any claim the ledger does not corroborate, moving the entry from
   `reclaimed` to `retained`, decrementing its reason count, returning its units to
   `retainedUnits`, and naming the reservation in `RecoveryReport.unverified`
   (`src/budgets/recovery.ts:399-429`; the field at `src/budgets/types.ts:751`). This is
   the defence in the direction that had none, and it keeps unit conservation an equality
   in the demoted case rather than letting it become an over-count. The read-back is
   asserted in `tests/unit/budgets/recovery.test.ts` ("reports an unverified reclamation
   as retained rather than as reclaimed, because a claim the ledger does not corroborate
   is not a claim"), and the held-unit index is asserted separately ("recomputes the
   held-unit index from the restored records rather than trusting a stored total") —
   two checks on two different trusts, because a store that lies about the state and a
   store that lies about the total are different failures with the same consequence.

**The residual limitation, stated rather than hidden.** The ceiling check in replay is
**only as good as the `ceilings` a caller resolves.** Replay cannot re-derive the budget
that was in force at crash time — a caller that re-resolved rule contributions would be
performing a second derivation, and against the *wrong* budget — so it applies the
budget in force *now* and refuses anything that exceeded it. That is the correct choice
and it is also a trust boundary: a caller that resolves a ceiling of `null` for a scope
that in fact had a maximum is not second-guessed, and a caller that resolves a ceiling
larger than the true one reproduces, in the caller's own arithmetic, the over-admission
this function exists to bound. The refusal to guess is deliberate and loud — an invalid
ceiling throws a `RangeError` naming the scope rather than being coerced
(`src/budgets/recovery.ts:636-643`) — but a *valid but wrong* `null` is the caller's
accountability and cannot be discharged here.

### 14. Routing

`src/routing/` accepts an immutable `RoutingNodeSnapshot[]`, built by an adapter from
`RegisteredNode` plus the capability snapshot and verdicts. Nothing in `src/mesh/registry/`
is modified, which keeps `tests/unit/mesh/registry/no-scheduling-edges.test.ts` green by
construction rather than by argument.

Selection is three ordered stages:

1. **Hard eligibility.** A node is excluded if it is revoked or unauthorized for the
   project, if the project path is not among its advertised `projectPathIds`, if it lacks
   a required runtime capability, if it is unhealthy by
   `deriveLiveness` (`src/mesh/registry/registry.ts`), if its `maxConcurrentSessions` is
   already reached, or if a `CapabilityVerdict` declines to authorize. Exclusions are
   recorded with a reason, never silently dropped.
2. **Deterministic preference.** The ordered preferences from `select_routing_preference`
   actions, applied in rule sort order. A preference can only reorder the eligible set.
3. **Stable tie-break.** Lowest `nodeId` by code-unit order.

Same registry snapshot plus same compiled rules plus same preferences gives the same
selection. The explanation records, per candidate, the stage that excluded it or the rank
that selected it, so the choice is auditable without re-running the filter.

### 15. Run and role templates

A template is a versioned, parameterized document. Instantiation produces an immutable
snapshot with its own digest, in the same shape and for the same reason as
`RoleRepository.createSnapshot`: editing a template must not mutate a run or a role that
was already created from it. The plan's criterion "template edits do not mutate
instantiated snapshots" is therefore a property of the snapshot being a separate frozen
value with its own digest, not of a convention about how templates are updated.

### 16. Dry run

The simulator receives immutable snapshots of the registry, roles, rules, memory metadata,
and the proposed workflow. It returns the expanded task and dependency graph, candidate
and selected targets with reasons, effective role/policy/context manifest summaries,
required and matched pre-approvals, budget reservations and rejected work, and warnings
for unavailable, unknown, or unenforceable capabilities.

The simulator is composed of the *same* pure planners and evaluators as production, with
every command sink replaced by a fail-closed fake whose only implementation throws. There
is no "dry-run mode" flag threaded through production code, because a flag is a second
code path and a second code path is where divergence starts. The tests assert zero event
appends, zero network calls, zero process launches, and zero reservations by counting at
the fake sinks.

### 17. Notifications

Notifications are advisory. Delivery never affects orchestration state: a notification is
emitted strictly after the state write, inside a `try`/`catch` whose only effect is
incrementing a counter. A subscriber that throws, an adapter that is unavailable, and a
delivery that is deduplicated away are all indistinguishable to the orchestrator, because
none of them can reach it.

Deduplication is by `dedupeKey` within a retention window. Acknowledgement removes an
entry from the inbox. Quieting is by category and severity. An optional adapter interface
exists so that a future external sink can be added without a schema change; the in-TUI
adapter is the only implementation in this milestone.

Payloads carry identifiers and reason codes only (section 12). A notification about a
blocked run names the run, the task, the rule that blocked it, and the denial code. It
never carries what the run was asked to do.

**The inbox at rest is an object the store owns, and every adapter gets its own
deep-frozen copy of it.** This subsection is normative and it corrects the previous
state of the module, in which the store held the producer's object *by identity* and
`bus.ts` handed each adapter the live stored envelope. That made the operator's inbox
writable by anything that could reach a reference to it — including every adapter, and
therefore including a future external sink, which is the participant section 17
explicitly invites. Rewriting `dedupeKey` through such a reference desynchronised the
dedupe index from the entries, so a rewritten key made `findByDedupeKey` answer about a
key the inbox no longer held while the next notification carrying the original key was
stored as a second entry rather than deduplicated.

Three rules, all in the shipped code:

1. **Clone on WRITE.** `publish` stores `deepFreezeNotificationValue(structuredClone(envelope))`
   (`src/notifications/store.ts:451`), so the record at rest is an object this module
   owns. A producer that mutates its own envelope after the call cannot reach the inbox.
   The dedupe key is read from the value being kept, not from the caller's object, for
   the reason above.
2. **Share the frozen record on READ.** `list()` and `entries()` are the same function
   (`ordered`, `src/notifications/store.ts:396`, wired at `src/notifications/store.ts:472`),
   `findByDedupeKey` returns the stored entry itself
   (`src/notifications/store.ts:509-513`), and the array each read returns is frozen.
   The entries are **shared, not cloned**, and that is the deliberate half of the
   decision: they are deep-frozen at publish, so there is nothing a caller can mutate,
   and **sharing an immutable value is not aliasing mutable state.** Cloning the inbox
   on every read would be `O(entries)` per call, and `list()` runs on **every TUI
   keystroke** with an inbox bounded only by the retention window — so clone-on-read is
   precisely the copy that would cost, and clone-on-write is the one that costs
   `O(1)` per notification.
3. **A FRESH deep-frozen clone per adapter, made inside `deliverOne`'s own `try`**
   (`src/notifications/bus.ts:275-286`). Freezing alone would suffice today; a clone per
   adapter means the store's integrity does not *depend* on the freeze still being there
   — if a later edit drops the freeze, or a different `NotificationStore`
   implementation is substituted, the worst case stays one adapter corrupting one
   adapter's view rather than the inbox. The placement inside the `try` is load-bearing
   rather than cosmetic: `structuredClone` throws on a value it cannot copy, and if that
   line sat *above* the `catch` a future unclonable field would reject out of
   `deliverOne`, abort the fan-out loop, and leave the remaining adapters unattempted —
   the delivery-safety property broken by a line whose whole purpose was to make
   delivery safer. Inside the `try`, the same failure is one more `adapter_error` and the
   loop carries on.

**`structuredClone` deliberately, and not `schema.parse`.** The schema is still the
**gate** — `notificationEnvelopeSchema.safeParse` runs first and a refusal throws
before anything is stored, because a payload this build cannot read is a payload the
no-secret audit cannot reason about and the TUI cannot render
(`src/notifications/store.ts:437-443`). But the object that becomes the record is
`structuredClone` of the *input*, never Zod's output, and the reason is that the two
are functions of different things. `structuredClone` is a function of the **VALUE**, so
the envelope at rest is the envelope emitted whatever the schema does next. `parse`
output is a function of the **SCHEMA**, so a future default, transform, or `.catch()`
would silently change what "at rest" means and would break the audit's
`inbox_at_rest` and `envelope_payload` paths meaning the same thing — a change to a
schema default would rewrite history that had already been recorded, with no diff in
the notification module to point at it. The cost of the choice is that the store no
longer holds the producer's object, which is the entire point.

**What this corrects.** The previous text in this ADR recorded only that a payload is
"stored verbatim" and said nothing about identity, so it was compatible with a store
that handed out a live, mutable, shared object. "Verbatim" now means **equal in content
and distinct in reference**, and the ADR states it that way because that is the property
the audit and the adapters depend on.

Every clause of this subsection is asserted in
`tests/unit/notifications/isolation.test.ts` in the "N14" blocks, and the assertions are
paired so that none of them is a no-op probe: "leaves the inbox byte-identical after an
adapter rewrites every field" is paired with "hands the adapter the original values, so
the unchanged inbox is not an empty inbox", and "hands two adapters two different
objects" is paired with "gives a second adapter the ORIGINAL values after the first
adapter has attacked the envelope". An unchanged inbox is only a *defence* if the
adapters were really holding something worth attacking, and an assertion that does not
establish that is an assertion that passes against a store which simply never calls an
adapter.

### 18. Defaults

A default installation ships **zero** enabled rules and
`requireApprovalForDispatch: true` remains the floor. `pre_approve_within_bounds` requires
`activation.state` to be `activated`, and activation requires an explicit confirmation
that displays the section 11 disclosure. A pre-approval rule that is merely `enabled` does
not pre-approve.

This is asserted by a test that loads the shipped defaults and evaluates a representative
dispatch, not by documentation.

## Consequences

### Positive

- The unsafe outcomes are unreachable by construction rather than reviewed away. The floor
  cannot be edited through a rule because the escalation fields are `z.literal(false)`; a
  dispatch cannot launch without a held reservation because that is the definition of
  eligible; preview cannot disagree with runtime because there is one artifact and one
  evaluator; a universal pre-approval cannot be written because the compiler refuses it.
- The rule language is data. Every value in it is inspectable, diffable, and
  digest-stable, and a rule set is a reviewable artifact.
- Reuse rather than reinvention: the bounded-pattern analyser, the monotone narrowing
  primitive, the supersession ordering, the snapshot-digest precedent, and the
  side-effect-free-planner precedent all already existed and are used unchanged.
- `src/mesh/registry/` is untouched, so the Milestone 3 R5/R6 structural guarantee is
  preserved without argument.

### Negative

- The language is narrower than a user might want. There are no computed values, no
  arithmetic beyond comparisons, no references between rules, and no conditional
  precedence. This is the intended cost and it is paid deliberately.
- Every limit in section 9 will eventually be hit by someone legitimate, and each one that
  is raised is a change to what a rule can do, not a performance tuning.
- `CompiledRuleSet` is held in memory and recompiled on change. Compilation cost is linear
  in the set, and the byte limit bounds it.
- The reserved literals make some documents impossible to write. A user who genuinely
  wants to pre-approve an operation with external effects cannot, in this release, and
  will be refused with a reason rather than silently ignored.
- M6 does not unify `src/tui/` and `src/mesh/tui/`. The Milestone 6 experience extends the
  local surface and follows the `src/context/tui/memory-view.ts` structured-view-model
  precedent rather than the bare-string `src/tui/view-model.ts` one.

### Consequences and residual risk of the 2026-10-02 amendment

The five decisions in this amendment all move in the same direction — each replaces a
check that could be satisfied by a *spelling* with one that requires a *claim* — and
each has a cost that is stated here rather than discovered later.

- **The vacuity check is a per-atom syntactic test, not a satisfiability solver.** It
  decides whether a rule *contains a claim that can exclude*, never whether the rule as a
  whole is satisfiable or whether its clauses contradict one another. It is therefore
  **conservative by refusal**: it will refuse some legitimate rules, and the class it
  refuses is knowable in advance. Section 8.2.3 refuses **every** disjunction containing
  a negation, including ones that are perfectly well behaved — `any(projectId eq "p",
  projectId eq "q")` is fine and compiles, but `any(projectId eq "p", not
  (projectPathId eq "r"))` is refused even though it genuinely excludes most projects.
  The reason is stated in 8.2.3 and is not revisited here: a disjunction containing a
  negation cannot be rendered as a reachable set on any axis, and the disclosure is
  required to render a set. The author-facing answer is the same one the compiler gives
  — express the concern as a restriction, or scope it positively — and the cost is
  accepted rather than engineered away, because the alternative is a satisfiability
  solver in the compile path of a language whose defining property is that it cannot
  execute anything.

- **The ceiling check in replay is only as good as the `ceilings` a caller resolves.**
  Section 13.3's guarantee (`held <= ceiling` after any replay) is a guarantee about the
  reconstructed state *relative to the ceilings it was given*. Replay cannot re-derive
  the budget in force at crash time, so a caller that resolves `ceiling: null` for a
  scope that in fact had a maximum is not second-guessed — and that caller's arithmetic,
  not replay's, is where an over-admission would enter. The refusal to guess is loud where
  it can be (a malformed ceiling throws a `RangeError` naming the scope), and the trust
  boundary is named here so that a reviewer of a *caller* knows what it is being asked to
  be right about.

- **The negation test is not depth-transitive, and a disjunction arm that is a
  conjunction is credited with the union of its members' axes.** This is a real, verified
  residual in the shipped check, found while verifying this amendment and recorded here
  rather than left for a reviewer to find. `constrainingScopeAxes` tests an `any` branch's
  **direct** arms for a `not` and then recurses, so a negation buried one level down
  escapes the branch test, and the union it computes for an arm that is an `all` is a
  union of axes where the arm requires *all* of them. Verified through the real
  `compileRuleSet` and `buildPreApprovalDisclosure`: a pre-approval whose predicate is
  `any(roleId eq "role-1", any(projectId eq "proj-1", not projectId eq "proj-1"))` is a
  tautology on the projects axis, and it **compiles, grants, and reports
  `reach.projects = ["proj-1"]`** — the same disclosure mismatch 8.2.3 was written to
  close, reachable by one extra level of nesting (`MAX_PREDICATE_DEPTH` is 6, so it is
  comfortably expressible). The same applies to `any(roleId eq "role-1", all(projectId eq
  "proj-1", not projectId eq "proj-1"))`, where the arm is unsatisfiable.

  **This is distinct from, and worse than, the boundary the code's own tests already
  document.** `tests/unit/rules/vacuity.test.ts` records that `any(all(A, not A))`
  compiles, and argues it is fail-closed because the resulting rule is unsatisfiable and
  therefore matches nothing — a disclosure that over-reports on a rule that never fires.
  The case above is the opposite shape: the arm is a **tautology**, so the rule is
  *satisfiable*, it **matches and grants**, and the disclosure over-reports on a rule
  that is live. Over-reporting on a rule that never fires cannot clear the floor;
  over-reporting on a rule that fires on every dispatch is the grant-side half of the bug
  8.2.3 exists to prevent. **This is a defect in the implementation, not in this ADR.**
  The fix is to make the branch test consult the whole subtree rather than the direct
  arms, and to intersect rather than union within a conjunctive arm. It is recorded here
  because an ADR that describes a check as sound while it is not is the failure mode this
  document exists to prevent, and because the residual is bounded, reproduced, and named
  rather than open.

### Risks and the structural mechanism that addresses each

| Risk | Mechanism |
| --- | --- |
| Preview diverges from runtime evaluation | One `compileRuleSet`, one `evaluateRules`, one `CompiledRuleSet`; preview is not a second parser |
| A rule edit affects an active dispatch or approval | Envelopes carry immutable digest-bound snapshots; the open-proposal fingerprint invalidates rather than re-evaluates (`src/application/service.ts:961-976`) |
| Budget reservation is not atomic with eligibility | Eligibility is *defined* as holding a held reservation; `reserve` is one compare-and-set |
| A cost budget is claimed without usage data | `enforceability` is computed from adapter-reported usage, never from the budget being set |
| A rule widens the safety floor | `z.literal(false)` escalation fields, monotone `min`/`narrowPolicyState` composition, and the kernel's existing post-narrowing re-check |
| A universal pre-approval is written | The compiler pass `checkNotUniversal` refuses a `pre_approve_within_bounds` or `select_routing_preference` carrying no **constructive** form on any of the twelve scope axes (section 8.2): a vacuous edge comparison, a `none`/`lacks`, or a bare `not` does not count, an `any` branch containing a `not` contributes nothing, and one scoped only by `taskTitlePattern` is refused. It is a compiler pass rather than a `.superRefine` so the four restriction actions may still be universal, and there is no `default_action` |
| A rule restriction the M0 effect cannot carry is silently dropped | Four members travel in `RuleEvaluationResult.restrictions`; `evaluateWithKernel` applies them through the kernel's own `narrowPolicyState`, after the kernel's pre-approval pass, and a demand a rule adds is not clearable by a pre-approval (section 3.2) |
| Replay over-admits and wedges the budget | Replay is a second admission decision: every occupying row gets one of three named verdicts, refusals install as `expired` and therefore return capacity, refusal is never total, and `held <= ceiling` holds after any replay (section 13.3) |
| An adapter or a producer rewrites the operator's inbox | The store clones on write and deep-freezes; each adapter gets a fresh deep-frozen clone made inside `deliverOne`'s `try`, so a clone failure cannot abort the fan-out (section 17) |
| Notification delivery changes orchestration state | `notifications` has no upward import edge; emission is post-write and wrapped |
| An unbounded regular expression re-enters the system | Every pattern compiles through `compileSafePattern`; a failure is a compile error, not an absorbed no-match |
| Rule code executes anything | The language has no expression form, no function form, and no string evaluation; the only operation on text is a bounded pattern match |

## Non-goals

- A general-purpose scripting language.
- Evaluating JavaScript, shell, or any user-supplied expression.
- Regular expressions without complexity bounds.
- User-defined functions, references between rules, or computed values.
- Implicit local timezones.
- "Match all projects/nodes/capabilities" pre-approval in the initial release.
- Provider cost enforcement without reliable usage reporting.
- A `default_action`, for the reason in section 8.
- Unifying `src/tui/` with `src/mesh/tui/`.

## Stop conditions

Implementation halts and returns to this ADR if any of the following becomes true:

1. Preview and production evaluation are found able to diverge, including by a change to
   one of them that does not touch the other.
2. A rule edit is found able to retroactively affect an active dispatch or an existing
   approval.
3. Budget reservation is found not to be atomic with dispatch eligibility, including by
   crash or replay between the check and the reservation.
4. A user rule is found able to grant a capability removed by the safety floor or a role
   restriction.
5. A compiled rule set is found to admit an action whose bounds are wider than the bounds
   the disclosure displayed.
6. A notification is found able to affect orchestration state.

## Amendment — 2026-10-02

**This ADR is amended.** The original section 8 wording on what makes a rule
non-universal — both the "at least one predicate that constrains one of the twelve"
paragraph and, in particular, the "**a `not` counts as constraining**" paragraph — is
**SUPERSEDED** by section 8.2. The superseded text has been **left in place and marked
in place** rather than rewritten, so a reader can see what changed and why; section 8.2
is the normative statement, and every other section that referenced the old rule now
points at it.

The amendment follows a security review that attacked this ADR and found three real
defects, **two of them in the fix written for the original HIGH-1** — that is, in code
this document already described as shipped. Every claim below was re-verified against
the code through the real entry points (`compileRuleSet`, `evaluateRules`,
`evaluateWithKernel`, `replayDurableReservations`, `createNotificationStore`,
`createNotificationBus`) rather than asserted from reading it, and the reasoning is
recorded in the sections cited so a future reader can re-run it.

The five decisions:

- **A9 — Constructive scope replaces syntactic non-universality (section 8.2).** A
  predicate now contributes a scope axis only if it is a *constructive form* for that
  axis — one that can exclude at least one dispatch — so a `none`, a `lacks`, a
  comparison pinned to an edge of its declared range, and a bare `not` no longer count;
  a `not` contributes **nothing** at any depth, and an `any` branch containing **any**
  `not` arm contributes **nothing** as a whole, because `any(A, not A)` is a tautology
  that compiled, cleared the safety floor, and produced a one-project disclosure citing
  the very atom whose negation was its sibling. `taskLabel` is added to the
  `rule.empty_enum` set (`hasAll []` / `hasAny []` are vacuously satisfied and matched
  every labelled dispatch), excluding the single-label `has` operator, which is a
  different shape.

- **A10 — Set membership compares over DEDUPED declared members (section 6.4).** For
  `capability`, `toolCategory`, and `nodeAdvertisedCapability` — which share one
  evaluator — and for `any` / `all` / `none`, `present` and `missing` are built over the
  deduped declared set, so `all S` means *every member of deduped `S` is present*; a
  duplicate must not change a verdict. The previous version filtered the raw array and
  compared against a deduped `Set`, which **inverted** the `all` match: a duplicate made
  a too-narrow request pass and the exactly-right request fail. That was a fail-open
  **matcher** bug on a pre-approval, not a disclosure mismatch, and the disclosure had
  been right all along — which is what identified it.

- **A11 — `evaluateWithKernel` applies the rule restrictions, after the kernel's
  pre-approval pass, and a rule's demand is not clearable by a pre-approval (section
  3.2).** The frozen M0 `restrict` effect has three members; four members of a
  `require_approval` / `add_restrictions` action have no field in it, travel in
  `RuleEvaluationResult.restrictions`, and can only be applied by the caller. The module
  exported `narrowWithRuleRestrictions` as the adapter — and **the function that
  exported it never called it**, so all four compiled, were digested, appeared in
  `unprojectedNarrowing`, and were silently discarded. (This ADR was previously *silent*
  on the whole question of who applies them; section 3.2 is therefore a new subsection
  rather than a correction to a wrong statement, and a document silent on it is a
  document that permits the omission.) `KernelCompositionInput` now
  takes `ruleRestrictions` and `evaluateWithKernel` narrows through the kernel's own
  `narrowPolicyState` — a thin adapter, not a second algebra, so the rule layer cannot
  diverge from the floor's monotonicity guarantees — **after** the kernel's pre-approval
  pass, and a demand added by a rule is not clearable by one, exactly as the kernel
  already decides for its own layers. The test is whether a layer other than
  `safety_floor` appears in `dispatchApprovalDemands`.

- **A12 — Notification envelopes are cloned on write and deep-frozen per adapter
  (section 17).** `publish` stores `deepFreezeNotificationValue(structuredClone(envelope))`,
  because `list()` runs per TUI keystroke, so clone-on-read is the copy that would cost
  and clone-on-write is the one that does not; reads share the frozen record, which is
  safe because a frozen object cannot be mutated. Each adapter gets a **fresh**
  deep-frozen clone made inside `deliverOne`'s own `try`, so a clone failure cannot abort
  the fan-out and skip the remaining adapters — delivery never affects orchestration
  state. `structuredClone` was chosen over `schema.parse` deliberately: parse output is
  a function of the **schema**, so a future default or transform would silently change
  what the inbox holds at rest; `structuredClone` is a function of the **value**. Where
  this ADR previously recorded only that a payload is "stored verbatim" — compatible with
  a store handing out a live shared object — it now says "equal in content and distinct
  in reference", and says why.

- **A13 — Budget replay classifies over-admission and never wedges (section 13.3).**
  `replayDurableReservations` now takes `{ now, ceilings }` and assigns each OCCUPYING
  row exactly one named verdict, checked in the order `duplicate_dispatch` →
  `ceiling_undeclared` → `over_ceiling`; rejected rows are installed as `expired`
  (terminal, non-occupying) rather than `released`, which would assert a terminal
  dispatch state replay has no evidence for. It previously accepted five `held` rows
  against a ceiling of one and reported `eligible: true` for all five — not a bypass but
  a **wedge**, because the recovered ledger then refused every subsequent reserve for a
  total nothing can account for. The two properties that make the composition safe are
  stated normatively: **refusal is never total**
  (`restored.length + collapsedRecords === recordCount`) and **refusal returns capacity**
  (`expired` is non-occupying, so the recovered ledger still accepts reserves — this is
  what separates the fix from the wedge). The `held <= ceiling` invariant of section 13.2 now
  holds after **any** replay. Two further defects found while fixing it are recorded in
  the same section: the ledger's maintained `releasedUnits` index subtracted on
  `held → committed` because both states occupy, and a store reporting success while
  moving nothing defeated every recovery check because they all trusted return values
  (the sweep now reads the ledger back into `RecoveryReport.unverified`).

Three smaller reconciliations accompany these. Citations in sections 3.1, 6.3, 7.3, 8,
and 8.1 were re-read against the files and the ones that had drifted were corrected
(`projectKernelMatch` 735 → 899, `projectToKernelRule` 791 → 955, the two projected
effects 858/825 → 1024/991, `checkNotUniversal` 543-557 → 708-723,
`NON_UNIVERSAL_PREDICATE_FIELDS` 280-293 → 292-305, `boundKernelRuleToDispatch`
1488-1499 → 1496-1506, and the `rule.empty_enum` branch table in 8.1). The 8.1 table's
test citation was generalised, because the branch-by-branch assertions no longer live at
a single fixed line range. And section 3.2 is a **new** subsection rather than an edit
to an existing one: the ADR was previously *silent* on who applies the four unprojectable
members and in what order, and a document silent on that is a document that permits the
omission A11 describes.

One **defect in the implementation, not in this ADR**, was found while verifying A9 and
is recorded in "Consequences and residual risk of the 2026-10-02 amendment": the
`any`-contains-`not` test is not depth-transitive, and a disjunction arm that is a
conjunction is credited with the union of its members' axes. A pre-approval that is a
tautology on the projects axis therefore still compiles, grants, and reports
`reach.projects = ["proj-1"]`. It is the same disclosure mismatch A9 closes, reachable
by one extra level of nesting, and the ADR states the shipped behaviour and the gap
rather than the behaviour the code was meant to have.

## Amendment record

> Entries A1 to A8 below record the **2026-10-01** amendment and are unchanged. The
> **2026-10-02** amendment (A9 to A13) is in "Amendment — 2026-10-02" above, and it
> **does supersede one decision**: section 8's "a `not` counts as constraining". The
> "no decision was weakened" claim in this record is therefore true of A1 to A8 and
> **not** of the document as a whole.

Amended 2026-10-01 to match the shipped Milestone 6 code, in two passes. A1 to A4 are
the first pass and A5 to A8 the second; every entry is forced by the implementation
rather than chosen by it. No decision, invariant, stop condition, or refusal was
weakened, softened, or removed. Where the shipped code is *less* constraining than the
original text implied, the text now says so and names the residual gap (A4); where it is
*more* constraining, the text now says that too, because a document describing a more
permissive language than the compiler implements is the failure mode this repository's
documentation culture exists to prevent (A5, A6, A7, A8).

- **A1: Eighteen predicate fields, not seventeen.** Sections 4 and 9 both require a
  pattern path in the M6 compiler and section 6's table had nowhere to put one, so the
  compiler added `taskTitlePattern` (row 18, section 6.3). The original table was
  internally inconsistent, not restrictive. The field is deliberately absent from
  section 8's scope list, so a pre-approval scoped only by a title pattern is refused as
  universal.
- **A2: A narrowing action and `pre_approve_within_bounds` may not share a rule.** The
  M0 `Rule` holds exactly one `effect`, so projecting both would silently drop one; the
  compiler refuses the combination with `rule.conflicting_action_effects` (section 7.3.1)
  rather than pick one. A silent drop is worse than a refusal because only one of the two
  drops produces any symptom at all: a dropped narrowing action is weaker than it reads,
  a dropped pre-approval is inert, and an inert rule is indistinguishable from a rule that
  matched nothing.
- **A3: `all([])` parses, and the universal-predicate refusal is a named refusal.** The
  schema permits the empty conjunction so section 8 can refuse it with
  `rule.universal_pre_approval` instead of a shape error (section 6, under the table). A
  schema error and a policy refusal are different diagnostics and only the second tells an
  author what to change.
- **A4: The kernel projection is no longer `match: {}`.** `projectKernelMatch` projects
  the M0-expressible subset of the predicate's top level, making the kernel a second,
  independent, fail-closed authority rather than an effect applicator that trusted the
  list it was handed (section 3.1). The projection is a sound under-approximation,
  weaker than the M6 predicate and never different, and `capability all`/`none` and all
  nesting are omitted to keep it that way. The residual gap is stated in the same
  subsection: `RuleEvaluationResult.kernelRules` is dispatch-bound by construction and not
  by the type system, and the projection bounds that caller bug's blast radius without
  closing it.
- **A5: Section 8 named three refusals in two bullets; the compiler refuses six families.**
  The text listed `any([])`, an empty `scheduleWindow`, and `capability any []`, which left
  a reader to believe `capability all []`, `capability none []`, `roleId in []` (and the
  other three identifier fields), an inverted `between` on the four numeric fields other
  than the one section 6 names, and `contextSensitivity any []` all compile — the compiler
  refuses every one of them under `rule.empty_enum` (new section 8.1, with a `file:line`
  per branch). The document was describing a *more permissive* language than the one
  shipped, so an author following it would write a rule the compiler refuses for a reason
  the document never mentions. Naming the pattern behind all six matters as much as the
  enumeration: a rule that matches nothing is indistinguishable from a rule that was never
  loaded, and a silent no-op is worse than a refusal because it leaves no artifact to go
  looking for.
- **A6: "enforced as a `superRefine`" named the wrong mechanism, in two places.** The
  universal-predicate restriction is a named compiler pass, `checkNotUniversal`
  (`src/rules/compile.ts:543`), not a Zod `.superRefine` (section 8 and the risk table).
  The distinction is not cosmetic: a `.superRefine` on the action schema could only
  express "no action may ever be universal", which would forbid the four action kinds for
  which a universal rule is safe and correct. Making it a compiler pass is what allows the
  restriction to apply to exactly the two permissive kinds. The prose named a mechanism
  that, if implemented as written, would have refused strictly more than the shipped
  compiler does.
- **A7: `CompiledAction` does not exist.** Section 3 declared
  `actions: readonly CompiledAction[]`; the real type is `RuleAction`
  (`src/rules/types.ts:921`, field at `src/rules/types.ts:1061`). A reader implementing
  from this ADR would have had a dangling type name and no way to discover it. Every other
  name in the `CompiledRuleSet` / `CompiledRule` declarations was re-checked against
  `src/rules/types.ts` and the module barrel and either confirmed or corrected, and three
  fields the shipped `CompiledRule` carries were added to the block so it is the shipped
  declaration rather than a subset of it.
- **A8: Constant names drifted between sections.** Section 6 named
  `MAX_COMBINATOR_NODES` and `MAX_RETRIES`; the exports are
  `MAX_COMBINATOR_NODES_PER_RULE` and `MAX_RETRY_LIMIT` (`src/rules/limits.ts`), which is
  what section 9 already used. Section 6 was internally inconsistent with section 9 in the
  same document, and neither name was greppable in the module.

Two smaller reconciliations, neither of which changes a decision. Section 9 now states
plainly that `MAX_RULES_PER_SET` and `MAX_COMPILED_RULE_SET_CANONICAL_BYTES` are both
enforced and in tension, so that the byte limit binds first for large rules. Section 7.3
now records the downward-only `min(declared, dispatch.timeoutSeconds)` clamp applied to
the kernel projection's `maximumTimeoutSeconds`, and that the *declared* bound is what
appears in the trace and the section 11 disclosure.

Every `file:line` citation in this document was re-read against the file after the
amendments above were written. Four pre-existing citations were wrong and are corrected
here: the kernel's `explanationText` bound (`src/orchestration/policy/types.ts:254`,
previously `:255`), the `ruleSnapshots` member of `#materialDefinitionFingerprint`
(`src/application/service.ts:996`, previously `:997`), the `PARSE_SHAPE_ARRAY_GUARD`
declaration (`src/rules/limits.ts:194`, previously `:191`), and the analyser's `too_long`
refusal (`src/mesh/protocol/safe-pattern.ts:746-751`, previously `:810`, which is the
same refusal in `checkSafePattern` rather than the one `compileSafePattern` raises). No
decision rests on any of the four. One citation that had drifted from the thing it names
was split rather than moved: section 6's `all([])` assertion now cites the schema test
that proves it parses *and* the compile test that proves the universal refusal follows.
