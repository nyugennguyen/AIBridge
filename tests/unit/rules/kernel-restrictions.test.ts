/**
 * The kernel composition's `ruleRestrictions` path, and the ordering rule that
 * makes a rule's demand survive a pre-approval.
 *
 * WHY THIS FILE EXISTS AS A REGRESSION SUITE RATHER THAN AS PART OF
 * `evaluate.test.ts`. The M6.10 security review found that four members of
 * `require_approval` / `add_restrictions` had no field in the FROZEN M0
 * `restrict` effect and therefore could not reach the kernel through
 * `ruleSnapshots`. The fix added `KernelCompositionInput.ruleRestrictions` — and
 * then the very first line of the implementation spread that M6-only key into
 * `evaluatePolicy`, whose input schema is `.strict()` with exactly three keys.
 * So:
 *
 *   - every call that supplied the documented argument returned
 *     `rule.evaluation_failed: Unrecognized key: "ruleRestrictions"`, and so did
 *     every call that supplied `null` and every call that supplied nothing, and
 *     - `grep -rn "ruleRestrictions" tests/` returned ZERO hits, so 5032 passing
 *     tests could not see it.
 *
 * A green suite is not evidence. These tests are. The first three are the ones
 * that matter most, because all three shapes failed before the fix — including
 * the two that supply nothing at all — and a suite that only tested the
 * "documented" shape would have let the `null` and omitted shapes regress
 * silently again.
 *
 * The second defect is subtler and lives one line further down. A demand added
 * by a rule must not be clearable by a pre-approval the kernel already
 * considered, or "adding the demand is free" in the one case where it must not
 * be. The guard was written with its sign flipped, so a rule set carrying BOTH a
 * matching `pre_approve` and a matching `require_approval` let the pre-approval
 * suppress the rule's own demand. It was unreachable while the strict-spread bug
 * was live, and it is the exact shape that becomes live the moment that bug is
 * fixed — which is why it is tested here rather than in a follow-up.
 *
 * EVERY CLAIM GOES THROUGH THE REAL ENTRY POINTS: `compileRuleSet` →
 * `evaluateRules` → `evaluateWithKernel`. No unit-level fake of the kernel
 * appears in this file, because a fake would answer the question this suite
 * exists to answer ("what does the kernel decide") with the test's own opinion.
 */

import { describe, expect, it } from "vitest"
import {
  compileRuleSet,
  evaluateRules,
  evaluateWithKernel,
  type CompiledRuleSet,
  type KernelCompositionInput,
  type PolicyEvaluation,
  type Result,
  type RuleEvaluationResult,
} from "../../../src/rules/index.js"
import { dispatchEnvelope, rawPreApprovalDocument, rawRuleDocument, validContext } from "./fixtures.js"

// ===========================================================================
// Helpers
// ===========================================================================

/** Compiles a set, or throws with the compiler's own reason. A silent `null` here is how a test starts lying. */
function compiledSet(documents: readonly unknown[]): CompiledRuleSet {
  const compiled = compileRuleSet(documents)
  if (!compiled.ok) throw new Error(`fixture failed to compile: ${compiled.error.code} ${compiled.error.message}`)
  return compiled.value
}

/** The refusal text, or `""` for a success. Surfaced on every failure message so a red test says WHY. */
function refusalText(result: Result<PolicyEvaluation>): string {
  return result.ok ? "" : `${result.error.code}: ${result.error.message}`
}

/** The evaluation, or a thrown error carrying the refusal — a `Result` union is not readable at a call site. */
function decisionOf(result: Result<PolicyEvaluation>): PolicyEvaluation {
  if (!result.ok) throw new Error(`expected a decision, got ${refusalText(result)}`)
  return result.value
}

/**
 * A `require_approval` rule scoped to this project, so it matches the fixture
 * context and the fixture envelope.
 */
function requireApprovalDocument(ruleId: string, action: Record<string, unknown>): Record<string, unknown> {
  return rawRuleDocument({
    ruleId,
    predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }],
    actions: [{ kind: "require_approval", ...action }],
  })
}

/** A pre-approval rule that covers every capability the envelope allows, so it clears the floor's default. */
function preApprovalDocument(ruleId: string, approvedCapabilities: readonly string[]): Record<string, unknown> {
  return rawPreApprovalDocument({
    ruleId,
    actions: [
      {
        kind: "pre_approve_within_bounds",
        approvedCapabilities: [...approvedCapabilities],
        maximumTimeoutSeconds: 900,
        allowDestructiveEffects: false,
        allowExternalEffects: false,
        maximumSensitivity: "restricted",
      },
    ],
  })
}

/**
 * The sentinel for "the caller passes no `ruleRestrictions` key at all".
 *
 * Distinct from `null` on purpose: `.strict()` inspects whether the key is
 * PRESENT on the object literal, not what it holds, so `undefined` under a
 * present key is a third shape the defect broke and the suite has to be able to
 * state.
 */
const OMIT_RESTRICTIONS = Symbol("omit-ruleRestrictions")

/**
 * The whole pipeline for one document set: compile, evaluate, compose.
 *
 * `ruleRestrictions` defaults to the composition `evaluateRules` computed,
 * because that is what a real caller has; `null` and `OMIT_RESTRICTIONS` state
 * the other two shapes explicitly.
 */
function compose(
  documents: readonly unknown[],
  options: {
    readonly ruleRestrictions?: KernelCompositionInput["ruleRestrictions"] | typeof OMIT_RESTRICTIONS
    readonly capabilities?: readonly string[]
    readonly contextOverrides?: Record<string, unknown>
  } = {},
): Result<PolicyEvaluation> {
  const capabilities = options.capabilities ?? ["fs.read"]
  const set = compiledSet(documents)
  const evaluation: RuleEvaluationResult = evaluateRules(
    set,
    validContext({ requestedCapabilities: [...capabilities], ...options.contextOverrides }),
  )
  const base = { envelope: dispatchEnvelope({}, [...capabilities]), taskTitle: "deploy the api" }
  const chosen = "ruleRestrictions" in options ? options.ruleRestrictions : evaluation.restrictions
  const input: KernelCompositionInput =
    chosen === OMIT_RESTRICTIONS ? base : { ...base, ruleRestrictions: chosen }
  return evaluateWithKernel(input, set, evaluation.kernelRules)
}

// ===========================================================================
// Fix 1 — `ruleRestrictions` reaches the kernel instead of being refused by it
// ===========================================================================

describe("the kernel composition accepts the rule restriction layer rather than refusing it as an unknown key", () => {
  it("accepts a call that supplies a composed rule restriction, because the M6-only member is destructured out before the kernel's strict input schema", () => {
    // THIS IS THE REGRESSION. Before the fix the composition spread the whole
    // `input` into `evaluatePolicy`, whose `policyEvaluationInputSchema` is
    // `.strict()` with exactly `envelope`, `taskTitle` and `projectPolicy`. Zod
    // refused the extra key, the `catch` converted the throw, and the function
    // returned `Err` — so the four members of `require_approval` /
    // `add_restrictions` that the M0 `restrict` effect cannot carry were
    // compiled, digested, named in `unprojectedNarrowing`, and then discarded,
    // on every call.
    const composed = compose([requireApprovalDocument("rule-require", { requireApprovalForDispatch: true })], {
      ruleRestrictions: {
        allowedCapabilities: null,
        deniedCapabilities: [],
        requireApprovalForDispatch: true,
        requireApprovalForCapabilities: [],
        requireApprovalForDestructiveEffects: false,
        requireApprovalForExternalEffects: false,
        allowDestructiveEffects: true,
        allowExternalEffects: true,
        maximumTimeoutSeconds: null,
        unprojected: ["requireApprovalForDispatch"],
      },
    })
    expect(refusalText(composed), "a supplied ruleRestrictions must not be refused").toBe("")
    // Explicit rather than implied: the failure mode being regressed is a named
    // Zod message, and naming it makes the red test legible instead of a bare
    // `expected true, got false`.
    expect(refusalText(composed)).not.toContain("Unrecognized key")
  })

  it("accepts a call that supplies `null` for the rule restrictions, because the key's PRESENCE is what the strict schema inspected", () => {
    // `null` and `undefined` both failed identically before the fix, because
    // `.strict()` inspects whether the key is present on the object literal and
    // not what it holds. A suite that only tested the documented object shape
    // would have missed this one.
    const composed = compose([requireApprovalDocument("rule-require", { requireApprovalForDispatch: true })], {
      ruleRestrictions: null,
    })
    expect(refusalText(composed), "an explicit null ruleRestrictions must not be refused").toBe("")
    expect(refusalText(composed)).not.toContain("Unrecognized key")
  })

  it("accepts a call that omits the rule restrictions key entirely, because a caller with no M6 restrictions may pass nothing", () => {
    const composed = compose([requireApprovalDocument("rule-require", { requireApprovalForDispatch: true })], {
      ruleRestrictions: OMIT_RESTRICTIONS,
    })
    expect(refusalText(composed), "an omitted ruleRestrictions must not be refused").toBe("")
    expect(refusalText(composed)).not.toContain("Unrecognized key")
  })

  it("accepts a call that passes `undefined` under the rule restrictions key, because `.strict()` inspects the key's PRESENCE and not its value", () => {
    // The fourth shape, and the one that makes the three above a set rather than
    // a sample. A caller that builds its input by spreading a partial
    // configuration writes `ruleRestrictions: config.ruleRestrictions` and gets
    // a key whose value is `undefined` — which is NOT the same object as one
    // without the key, and is exactly what the pre-fix spread carried into the
    // kernel's `.strict()` schema.
    const composed = compose([requireApprovalDocument("rule-require", { requireApprovalForDispatch: true })], {
      ruleRestrictions: undefined,
    })
    expect(refusalText(composed), "an explicitly undefined ruleRestrictions must not be refused").toBe("")
    expect(refusalText(composed)).not.toContain("Unrecognized key")
  })

  it("still refuses a genuinely unknown input key, which is what proves the four assertions above are not vacuous", () => {
    // The control. If nothing could produce "Unrecognized key" through this
    // entry point, then `expect(refusalText).toBe("")` on the four shapes above
    // would be asserting that a thing that cannot happen does not happen. This
    // test pins the failure mode as REACHABLE, so those four assertions have
    // teeth.
    //
    // A variable rather than an inline literal on purpose: TypeScript's excess
    // property check applies to fresh object literals, so an inline `{ ...,
    // unexpectedKey: true }` would not compile. Assignability does not care about
    // the extra member, which is exactly the gap this control walks through.
    const set = compiledSet([requireApprovalDocument("rule-require", { requireApprovalForDispatch: true })])
    const evaluation = evaluateRules(set, validContext())
    const inputWithAnUnknownKey = {
      envelope: dispatchEnvelope(),
      taskTitle: "deploy the api",
      unexpectedKey: true,
    }
    const composed = evaluateWithKernel(inputWithAnUnknownKey, set, evaluation.kernelRules)
    expect(composed.ok).toBe(false)
    expect(refusalText(composed)).toContain("Unrecognized key")
  })

  it("turns `requireApprovalForCapabilities` into an outstanding capability approval, so a rule that says 'require approval for net.fetch' is not a rule that does nothing", () => {
    const composed = compose(
      [requireApprovalDocument("rule-require", { requireApprovalForCapabilities: ["net.fetch"] })],
      { capabilities: ["fs.read", "net.fetch"] },
    )
    const decision = decisionOf(composed)
    expect(decision.outstandingApprovals).toContain("capability:net.fetch")
    expect(decision.decision).toBe("require_approval")
    // And the member really narrowed the state, rather than only being reflected
    // in the outstanding list.
    expect(decision.effective.approvalRequiredCapabilities).toEqual(["net.fetch"])
  })

  it("turns `requireApprovalForDispatch` into an outstanding dispatch approval attributed to the rule layer", () => {
    // This is the shape a caller takes when it has one: the composition handed
    // to `evaluateWithKernel` is the one `evaluateRules` computed, and it names
    // the member as unprojected. The claim is about the EFFECT — see Fix 2
    // below for the same member under a pre-approval.
    const set = compiledSet([requireApprovalDocument("rule-require", { requireApprovalForDispatch: true })])
    const evaluation = evaluateRules(set, validContext())
    expect(evaluation.restrictions.unprojected).toContain("requireApprovalForDispatch")
    const decision = decisionOf(
      evaluateWithKernel(
        {
          envelope: dispatchEnvelope(),
          taskTitle: "deploy the api",
          ruleRestrictions: evaluation.restrictions,
        },
        set,
        evaluation.kernelRules,
      ),
    )
    expect(decision.outstandingApprovals).toContain("dispatch_approval")
    expect(decision.decision).toBe("require_approval")
    // The demand is attributed to a layer OTHER than the safety floor, which is
    // the fact Fix 2 turns on.
    expect(decision.effective.dispatchApprovalDemands).toEqual(["safety_floor", "rule"])
  })

  it("applies `deniedCapabilities` and `maximumTimeoutSeconds`, the two members the composition recomputes into the effective state", () => {
    const set = compiledSet([
      rawRuleDocument({
        ruleId: "rule-restrict",
        predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }],
        actions: [{ kind: "add_restrictions", deniedCapabilities: ["fs.write"], maximumTimeoutSeconds: 300 }],
      }),
    ])
    const evaluation = evaluateRules(set, validContext())
    const decision = decisionOf(
      evaluateWithKernel(
        { envelope: dispatchEnvelope(), taskTitle: "deploy the api", ruleRestrictions: evaluation.restrictions },
        set,
        evaluation.kernelRules,
      ),
    )
    expect(decision.effective.deniedCapabilities).toEqual(["fs.write"])
    // The recomposition lowers the effective ceiling to the `min` of the
    // dispatch's declared timeout and the narrowed state, which is the same
    // discipline the kernel applies.
    expect(decision.effectiveTimeoutSeconds).toBe(300)
    expect(decision.effective.maximumTimeoutSeconds).toBe(300)
  })

  it("keeps the safety floor intact when a rule set carries NO rules, so the composition cannot be a route to `allow`", () => {
    // The floor. With no rules, `requireApprovalForDispatch` is the floor's own
    // demand and there is no `rule` layer to add one, so the dispatch approval
    // must still be outstanding and nothing may reach `allow` — with a rule
    // restriction supplied, with `null`, and with nothing supplied.
    const set = compiledSet([])
    const evaluation = evaluateRules(set, validContext())
    for (const [label, ruleRestrictions] of [
      ["a composed restriction", evaluation.restrictions],
      ["null", null],
    ] as const) {
      const decision = decisionOf(
        evaluateWithKernel(
          { envelope: dispatchEnvelope(), taskTitle: "deploy the api", ruleRestrictions },
          set,
          evaluation.kernelRules,
        ),
      )
      expect(decision.outstandingApprovals, label).toEqual(["dispatch_approval"])
      expect(decision.decision, label).toBe("require_approval")
      expect(decision.allowed, label).toBe(false)
      expect(decision.effective.dispatchApprovalDemands, label).toEqual(["safety_floor"])
    }
    const omitted = decisionOf(evaluateWithKernel({ envelope: dispatchEnvelope(), taskTitle: "deploy the api" }, set, evaluation.kernelRules))
    expect(omitted.outstandingApprovals).toEqual(["dispatch_approval"])
    expect(omitted.decision).toBe("require_approval")
  })

  it("cannot be widened by a rule restriction, because the narrowing runs through the kernel's own `narrowPolicyState`", () => {
    // `allowDestructiveEffects: true` is a legal member of the composition shape
    // (an unrestricted rule contributes `true`), and the adapter must translate
    // that into the absence of a narrowing rather than into an escalation. The
    // floor's `false` survives.
    const set = compiledSet([])
    const evaluation = evaluateRules(set, validContext())
    const decision = decisionOf(
      evaluateWithKernel(
        {
          envelope: dispatchEnvelope(),
          taskTitle: "deploy the api",
          ruleRestrictions: {
            allowedCapabilities: null,
            deniedCapabilities: [],
            requireApprovalForDispatch: false,
            requireApprovalForCapabilities: [],
            requireApprovalForDestructiveEffects: false,
            requireApprovalForExternalEffects: false,
            allowDestructiveEffects: true,
            allowExternalEffects: true,
            maximumTimeoutSeconds: 999_999,
            unprojected: [],
          },
        },
        set,
        evaluation.kernelRules,
      ),
    )
    expect(decision.effective.allowDestructiveEffects).toBe(false)
    expect(decision.effective.allowExternalEffects).toBe(false)
    expect(decision.effective.maximumTimeoutSeconds).toBeLessThan(999_999)
  })
})

// ===========================================================================
// Fix 2 — a rule's dispatch demand is not clearable by a pre-approval
// ===========================================================================

describe("a dispatch approval demanded by a rule is not clearable by a pre-approval", () => {
  it("does NOT let a matching pre-approval suppress a matching `requireApprovalForDispatch`, so adding the demand is not free", () => {
    // THE REGRESSION. `evaluatePolicy`'s pre-approval pass runs BEFORE the rule
    // restrictions are applied — deliberately, so that a demand added afterwards
    // cannot be cleared by a grant that predates it. But the guard that put the
    // demand back was `!preApprovalClearedDefault`, and that is the sign FLIPPED:
    // the pre-approval is exactly the thing that set that flag, so in the one
    // case where a rule set carries BOTH a matching pre-approval and a matching
    // demand, the demand was added to the state and then discarded on the way
    // out. The composition reported `allow` for a rule set whose own author wrote
    // "require approval for every dispatch".
    const set = compiledSet([
      preApprovalDocument("rule-pre", ["fs.read"]),
      requireApprovalDocument("rule-require", { requireApprovalForDispatch: true }),
    ])
    const evaluation = evaluateRules(set, validContext())
    // The pre-approval really did clear the floor's default. Without this the
    // test would pass for the wrong reason: the floor's own demand would still
    // be outstanding and the rule's demand would never be exercised.
    expect(evaluation.restrictions.requireApprovalForDispatch).toBe(true)

    const decision = decisionOf(
      evaluateWithKernel(
        {
          envelope: dispatchEnvelope(),
          taskTitle: "deploy the api",
          ruleRestrictions: evaluation.restrictions,
        },
        set,
        evaluation.kernelRules,
      ),
    )
    // The kernel's own view, first, so the claim is about what CHANGED.
    const kernelOnly = decisionOf(evaluateWithKernel({ envelope: dispatchEnvelope(), taskTitle: "deploy the api" }, set, evaluation.kernelRules))
    expect(kernelOnly.decision).toBe("allow")
    expect(kernelOnly.outstandingApprovals).toEqual([])
    expect(kernelOnly.preApprovalClearedDefault).toBe(true)

    // And the composed view, which must not be `allow`.
    expect(decision.decision).toBe("require_approval")
    expect(decision.allowed).toBe(false)
    expect(decision.outstandingApprovals).toEqual(["dispatch_approval"])
    // The demand is attributed to the rule layer, which is the fact the guard
    // now tests rather than the pre-approval flag.
    expect(decision.effective.dispatchApprovalDemands).toEqual(["safety_floor", "rule"])
  })

  it("STILL lets a rule set with only a matching pre-approval clear the floor, because that is the feature", () => {
    // The control for the test above, and the reason the guard cannot be a blanket
    // refusal. A pre-approval with no rule demand must clear the floor's own
    // demand exactly as the kernel alone would.
    const set = compiledSet([preApprovalDocument("rule-pre", ["fs.read"])])
    const evaluation = evaluateRules(set, validContext())
    expect(evaluation.restrictions.requireApprovalForDispatch).toBe(false)

    const decision = decisionOf(
      evaluateWithKernel(
        {
          envelope: dispatchEnvelope(),
          taskTitle: "deploy the api",
          ruleRestrictions: evaluation.restrictions,
        },
        set,
        evaluation.kernelRules,
      ),
    )
    expect(decision.decision).toBe("allow")
    expect(decision.allowed).toBe(true)
    expect(decision.outstandingApprovals).toEqual([])
    expect(decision.preApprovalBasis).toEqual({ ruleId: "rule-pre", ruleVersion: 1 })
    // The floor's demand is still RECORDED in the effective state; it was
    // cleared, not removed.
    expect(decision.effective.dispatchApprovalDemands).toEqual(["safety_floor"])
  })

  it("STILL lets a rule set with only a matching pre-approval clear the floor when the rule restriction layer is absent", () => {
    // The same control with `null` supplied rather than a composition, so the
    // "clearing works" claim does not depend on the rule layer being present.
    const set = compiledSet([preApprovalDocument("rule-pre", ["fs.read"])])
    const evaluation = evaluateRules(set, validContext())
    for (const ruleRestrictions of [null, evaluation.restrictions]) {
      const decision = decisionOf(
        evaluateWithKernel(
          { envelope: dispatchEnvelope(), taskTitle: "deploy the api", ruleRestrictions },
          set,
          evaluation.kernelRules,
        ),
      )
      expect(decision.decision).toBe("allow")
      expect(decision.outstandingApprovals).toEqual([])
    }
  })

  it("leaves a capability demand standing under the same combination, because capability demands have no pre-approval guard at all", () => {
    // The counterpart claim. `requireApprovalForCapabilities` is applied to the
    // outstanding list unconditionally, so a pre-approval that cleared the floor
    // cannot swallow it. The review recorded the dispatch demand as the one with
    // the sign-flipped guard; this is the row that was already correct and must
    // not regress while it is fixed.
    const set = compiledSet([
      preApprovalDocument("rule-pre", ["fs.read", "net.fetch"]),
      requireApprovalDocument("rule-require", { requireApprovalForCapabilities: ["net.fetch"] }),
    ])
    const evaluation = evaluateRules(set, validContext({ requestedCapabilities: ["fs.read", "net.fetch"] }))
    const decision = decisionOf(
      evaluateWithKernel(
        { envelope: dispatchEnvelope({}, ["fs.read", "net.fetch"]), taskTitle: "deploy the api", ruleRestrictions: evaluation.restrictions },
        set,
        evaluation.kernelRules,
      ),
    )
    // The pre-approval really was granted, so the demand is not outstanding
    // merely because the grant failed.
    expect(decision.preApprovalClearedDefault).toBe(true)
    expect(decision.outstandingApprovals).toContain("capability:net.fetch")
    expect(decision.decision).toBe("require_approval")
  })

  it("demands approval for every dispatch and grants nothing when a rule set requires dispatch approval and carries no pre-approval", () => {
    // The safety floor plus a rule demand, with no pre-approval anywhere: one
    // outstanding `dispatch_approval`, one `require_approval` decision, and no
    // path to `allow`. This is the state the whole suite protects.
    const set = compiledSet([requireApprovalDocument("rule-require", { requireApprovalForDispatch: true })])
    const evaluation = evaluateRules(set, validContext())
    const decision = decisionOf(
      evaluateWithKernel(
        { envelope: dispatchEnvelope(), taskTitle: "deploy the api", ruleRestrictions: evaluation.restrictions },
        set,
        evaluation.kernelRules,
      ),
    )
    expect(decision.outstandingApprovals).toEqual(["dispatch_approval"])
    expect(decision.decision).toBe("require_approval")
    expect(decision.allowed).toBe(false)
  })

  it("keeps the rule's demands outstanding when the dispatch is DENIED by the kernel, because a deny and a demand are independent facts", () => {
    // The recomposition builds its outstanding list from the kernel's list plus
    // the rule's, and its decision from denials first. A deny must not erase the
    // fact that the rule demanded an approval: the two are separate facts, and
    // the explanation tree is read by a person deciding whether to write one.
    //
    // The denial comes from the KERNEL — the role removes `fs.write` and the
    // dispatch asks for it — because an M6 `deny_with_reason` has no M0 effect
    // and never reaches the kernel at all. So this is a claim about the kernel's
    // own denials interacting with the recomposition, which is the only place
    // the `deny` branch of the recomposed decision can be taken.
    const set = compiledSet([
      requireApprovalDocument("rule-require", { requireApprovalForDispatch: true, requireApprovalForCapabilities: ["fs.write"] }),
    ])
    const evaluation = evaluateRules(set, validContext({ requestedCapabilities: ["fs.read", "fs.write"] }))
    const decision = decisionOf(
      evaluateWithKernel(
        {
          envelope: dispatchEnvelope({}, ["fs.read", "fs.write"], ["fs.write"]),
          taskTitle: "deploy the api",
          ruleRestrictions: evaluation.restrictions,
        },
        set,
        evaluation.kernelRules,
      ),
    )
    expect(decision.decision).toBe("deny")
    expect(decision.denials.map((denial) => denial.code)).toContain("policy.capability_denied")
    expect(decision.outstandingApprovals).toContain("dispatch_approval")
    expect(decision.outstandingApprovals).toContain("capability:fs.write")
  })
})
