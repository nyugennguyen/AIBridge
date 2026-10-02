/**
 * The evaluator: ordering, the six match outcomes, conflict resolution, shadowing,
 * the safety-floor composition, and determinism.
 *
 * The properties under test are the ones ADR 0007 sections 10 and 11 make
 * structural claims about:
 *
 *   1. ORDER IS TOTAL AND IDENTITY-DERIVED. Rules are evaluated in
 *      (ruleId, templateVersion) order, so a rule set means the same thing
 *      however it was loaded. Shuffling the input and comparing the
 *      `decisionDigest` is the assertion, and it is done across 50 evaluations
 *      rather than twice, because a single comparison cannot distinguish "stable"
 *      from "stable by luck on this input".
 *
 *   2. SIX DISTINCT MATCH OUTCOMES. Disabled, unactivated, expired, revoked,
 *      superseded, out-of-scope and genuinely-not-matched are seven different
 *      facts, and an audit view that cannot tell them apart cannot answer "why did
 *      my rule not fire".
 *
 *   3. RESTRICTIVE WINS. Deny beats pre-approval; the lowest sort key reports;
 *      routing preferences union with the first non-empty list winning the head;
 *      budgets compose elementwise `min`. Each is one row of ADR section 10.4.
 *
 *   4. THE SAFETY FLOOR STILL DECIDES. M6 produces kernel `Rule`s and the kernel
 *      evaluates them; a pre-approval the floor refuses is refused by the KERNEL,
 *      and the tests below run the real `evaluatePolicy` to prove the composition
 *      rather than asserting that M6 believes it.
 *
 *   5. A WIDENING ATTEMPT IS RECORDED, NOT DROPPED. A budget wider than the one in
 *      force is `rejected_widening` with the attempted value, and changes nothing.
 */

import { describe, expect, it } from "vitest"
import {
  SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS,
  compileRuleSet,
  evaluateRules,
  evaluateWithKernel,
  narrowWithRuleRestrictions,
  renderRuleExplanation,
  ruleEvaluationContextSchema,
  seedPolicyState,
  type CompiledRuleSet,
  type RuleEvaluationContext,
  type RuleEvaluationResult,
} from "../../../src/rules/index.js"
import { SAFETY_FLOOR_NARROWING, narrowPolicyState } from "../../../src/orchestration/policy/floor.js"
import { evaluatePolicy } from "../../../src/orchestration/policy/evaluate.js"
import { policyEvaluationSchema } from "../../../src/orchestration/policy/types.js"
import { digestJson, canonicalJson } from "../../../src/orchestration/digest.js"
import {
  budgetDocument,
  clone,
  dispatchEnvelope,
  preApprovalDocument,
  rawPreApprovalDocument,
  rawRuleDocument,
  requireApprovalDocument,
  routingDocument,
  validContext,
  validRuleDocument,
} from "./fixtures.js"

// ===========================================================================
// Helpers
// ===========================================================================

function compiledSet(documents: readonly unknown[]): CompiledRuleSet {
  const compiled = compileRuleSet(documents)
  if (!compiled.ok) throw new Error(`fixture failed to compile: ${compiled.error.code} ${compiled.error.message}`)
  return compiled.value
}

function denyDocument(ruleId: string, reason: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return rawRuleDocument({ ruleId, actions: [{ kind: "deny_with_reason", reason }], ...overrides })
}

function preApprovalFor(
  ruleId: string,
  maximumTimeoutSeconds: number,
  extra: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return rawPreApprovalDocument({
    ruleId,
    actions: [
      {
        kind: "pre_approve_within_bounds",
        approvedCapabilities: ["fs.read"],
        maximumTimeoutSeconds,
        allowDestructiveEffects: false,
        allowExternalEffects: false,
        maximumSensitivity: "restricted",
        ...extra,
      },
    ],
    ...overrides,
  })
}

function routingFor(ruleId: string, preference: Record<string, unknown>): Record<string, unknown> {
  return rawRuleDocument({
    ruleId,
    predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }],
    actions: [{ kind: "select_routing_preference", preference }],
  })
}

function budgetFor(ruleId: string, budget: Record<string, unknown>): Record<string, unknown> {
  return rawRuleDocument({
    ruleId,
    predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }],
    actions: [{ kind: "set_stricter_budget", budget }],
  })
}

function outcomeOf(result: RuleEvaluationResult, ruleId: string): string | undefined {
  return result.traces.find((trace) => trace.ruleId === ruleId)?.matchOutcome
}

function dispositionOf(result: RuleEvaluationResult, ruleId: string, kind: string): string | undefined {
  const trace = result.traces.find((entry) => entry.ruleId === ruleId)
  return trace?.actions.find((action) => action.kind === kind)?.disposition
}

/** A real dispatch envelope, for the kernel-composition tests. The builder is shared: see `fixtures.ts`. */
const envelope = dispatchEnvelope

// ===========================================================================
// The result is well formed
// ===========================================================================

describe("the evaluation result is a complete, digest-bound record of the rule layer's contribution", () => {
  it("carries a trace for EVERY compiled rule, in evaluation order", () => {
    // One trace per rule, not one per matched rule. A rule that did not fire and
    // produced no trace is indistinguishable from a rule that was never loaded.
    const result = evaluateRules(compiledSet([validRuleDocument(), budgetDocument()]), validContext())
    expect(result.traces.map((trace) => trace.ruleId)).toEqual(["rule-a", "rule-budget"])
  })

  it("orders the traces by ruleId then templateVersion, whatever order the rules were supplied in", () => {
    const documents = [
      validRuleDocument({ ruleId: "rule-c" }),
      validRuleDocument({ ruleId: "rule-a", templateVersion: 2 }),
      validRuleDocument({ ruleId: "rule-a", templateVersion: 1 }),
    ]
    const result = evaluateRules(compiledSet(documents), validContext())
    expect(result.traces.map((trace) => `${trace.ruleId}@${trace.templateVersion}`)).toEqual([
      "rule-a@1",
      "rule-a@2",
      "rule-c@1",
    ])
  })

  it("records the rule set digest it evaluated, so a result names the artifact it came from", () => {
    const set = compiledSet([validRuleDocument()])
    const result = evaluateRules(set, validContext())
    expect(result.ruleSetDigest).toBe(set.digest)
  })

  it("computes the decisionDigest over everything else on the result", () => {
    // The same construction `evaluatePolicy` uses: a stable base object that
    // excludes the digest itself. Excluding `explanationText` is deliberate — it
    // is a function of the result, so including it would digest a derivation of
    // itself.
    const result = evaluateRules(compiledSet([validRuleDocument()]), validContext())
    const { decisionDigest, ...base } = result
    expect(decisionDigest).toBe(digestJson(base))
  })

  it("parses the evaluation context rather than trusting it, so a malformed one is refused loudly", () => {
    // A context that does not satisfy its schema would otherwise be evaluated field
    // by field into whatever `undefined` meant, and `undefined` is the shape a
    // fail-open bug wears.
    expect(() => evaluateRules(compiledSet([validRuleDocument()]), { projectId: "proj-1" })).toThrow(/rule\.invalid_context/)
    expect(() => evaluateRules(compiledSet([validRuleDocument()]), { ...validContext(), extra: 1 })).toThrow(/rule\.invalid_context/)
  })
})

// ===========================================================================
// Determinism
// ===========================================================================

describe("the same rule set and the same context always produce the same decision", () => {
  it("produces an identical decisionDigest across fifty evaluations", () => {
    // Fifty rather than two. A single comparison cannot distinguish "deterministic"
    // from "coincidentally equal on this input", and the things that would break
    // determinism here — an object key order, a `Set` iteration, a timestamp — are
    // exactly the things that agree twice and differ on the fiftieth run.
    const set = compiledSet([preApprovalDocument(), budgetDocument(), validRuleDocument()])
    const digests = new Set<string>()
    const texts = new Set<string>()
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = evaluateRules(set, validContext())
      digests.add(result.decisionDigest)
      texts.add(renderRuleExplanation(result))
    }
    expect(digests.size).toBe(1)
    expect(texts.size).toBe(1)
  })

  it("produces an identical decisionDigest for a SHUFFLED rule set", () => {
    // A digest that moved with input order could not be the thing an approval is
    // bound to: reloading the same rules would invalidate every open approval.
    const documents = [preApprovalDocument(), budgetDocument(), routingDocument(), validRuleDocument()]
    const forward = evaluateRules(compiledSet(documents), validContext())
    const reversed = evaluateRules(compiledSet([...documents].reverse()), validContext())
    const rotated = evaluateRules(compiledSet([documents[2]!, documents[3]!, documents[0]!, documents[1]!]), validContext())
    expect(reversed.decisionDigest).toBe(forward.decisionDigest)
    expect(rotated.decisionDigest).toBe(forward.decisionDigest)
  })

  it("produces a different digest for a different context, so the digest covers the context and not only the rules", () => {
    const set = compiledSet([validRuleDocument()])
    const matched = evaluateRules(set, validContext())
    const unmatched = evaluateRules(set, validContext({ roleId: "role-2" }))
    expect(matched.decisionDigest).not.toBe(unmatched.decisionDigest)
  })

  it("does not read a wall clock, so a rule set evaluated at two instants differs only where the instant is read", () => {
    // There is no `Date.now` in this module and the schedule-window predicate is
    // the only thing that reads the instant, so a context with no schedule window
    // produces the same digest whatever `evaluatedAt` says.
    const set = compiledSet([validRuleDocument()])
    const first = evaluateRules(set, validContext({ evaluatedAt: "2026-02-02T12:00:00Z" }))
    const second = evaluateRules(set, validContext({ evaluatedAt: "2030-06-15T03:00:00Z" }))
    // The instant IS part of the result, so the digest differs — and it differs
    // ONLY by that, which is the claim.
    const withoutInstant = (result: RuleEvaluationResult) => {
      const { evaluatedAt, decisionDigest, ...rest } = result
      void decisionDigest
      return digestJson(rest)
    }
    expect(withoutInstant(first)).toBe(withoutInstant(second))
  })
})

// ===========================================================================
// The match outcomes
// ===========================================================================

describe("a rule that did not fire says WHICH of the seven reasons it was, never a bare 'not matched'", () => {
  it("reports 'matched' for a rule that is enabled, activated, unexpired, in scope and satisfied", () => {
    const result = evaluateRules(compiledSet([validRuleDocument()]), validContext())
    expect(outcomeOf(result, "rule-a")).toBe("matched")
  })

  it("reports 'disabled' and nothing else, for a rule that is switched off", () => {
    const result = evaluateRules(compiledSet([validRuleDocument({ enabled: false })]), validContext())
    expect(outcomeOf(result, "rule-a")).toBe("disabled")
  })

  it("reports 'not_activated' for a draft", () => {
    // A rule that is merely ENABLED does not pre-approve (ADR 0007 section 18), and
    // this is where that is enforced rather than documented.
    const result = evaluateRules(
      compiledSet([validRuleDocument({ activation: { state: "draft", activatedAt: null, activatedBy: null } })]),
      validContext(),
    )
    expect(outcomeOf(result, "rule-a")).toBe("not_activated")
  })

  it("reports 'revoked' for a revoked rule", () => {
    const result = evaluateRules(
      compiledSet([
        validRuleDocument({ activation: { state: "revoked", activatedAt: "2026-01-01T00:00:00Z", activatedBy: { kind: "user", userId: "user-1" } } }),
      ]),
      validContext(),
    )
    expect(outcomeOf(result, "rule-a")).toBe("revoked")
  })

  it("reports 'expired' for an activation state of expired", () => {
    const result = evaluateRules(
      compiledSet([validRuleDocument({ activation: { state: "expired", activatedAt: null, activatedBy: null } })]),
      validContext(),
    )
    expect(outcomeOf(result, "rule-a")).toBe("expired")
  })

  it("reports 'expired' for a rule whose expiresAt has passed, and matches one whose expiry is in the future", () => {
    const past = evaluateRules(compiledSet([validRuleDocument({ expiresAt: "2026-01-15T00:00:00Z" })]), validContext())
    expect(outcomeOf(past, "rule-a")).toBe("expired")
    const future = evaluateRules(compiledSet([validRuleDocument({ expiresAt: "2027-01-15T00:00:00Z" })]), validContext())
    expect(outcomeOf(future, "rule-a")).toBe("matched")
  })

  it("reports 'superseded' for a lower version of a ruleId that has a live higher version", () => {
    const result = evaluateRules(
      compiledSet([validRuleDocument({ templateVersion: 1 }), validRuleDocument({ templateVersion: 2 })]),
      validContext(),
    )
    // Traces are in (ruleId, templateVersion) order, so the LOWER version comes
    // first — and it is the one that is superseded.
    const traces = result.traces.filter((trace) => trace.ruleId === "rule-a")
    expect(traces.map((trace) => `${trace.templateVersion}:${trace.matchOutcome}`)).toEqual(["1:superseded", "2:matched"])
  })

  it("does NOT let a DISABLED higher version supersede a live lower one", () => {
    // Supersession considers the rules that "would otherwise be effective". A raw
    // MAXIMUM version would let switching a newer rule off silently disable the
    // older one the operator had already accepted — a fail-open direction reached
    // through an off switch.
    const result = evaluateRules(
      compiledSet([validRuleDocument({ templateVersion: 1 }), validRuleDocument({ templateVersion: 2, enabled: false })]),
      validContext(),
    )
    const traces = result.traces.filter((trace) => trace.ruleId === "rule-a")
    expect(traces.map((trace) => `${trace.templateVersion}:${trace.matchOutcome}`)).toEqual(["1:matched", "2:disabled"])
  })

  it("reports 'project_scope_mismatch' for a rule authored for another project", () => {
    const result = evaluateRules(compiledSet([validRuleDocument({ projectId: "proj-2" })]), validContext({ projectId: "proj-1" }))
    // A single-rule set spanning projects is refused at compile time, so this is
    // reached with a set whose project matches the context and a rule that does
    // not — which the compiler refuses, so the observable claim is the refusal.
    expect(outcomeOf(result, "rule-a")).toBe("project_scope_mismatch")
  })

  it("reports 'not_matched' only for a genuine predicate miss, and says which predicate", () => {
    const result = evaluateRules(compiledSet([validRuleDocument()]), validContext({ roleId: "role-2" }))
    expect(outcomeOf(result, "rule-a")).toBe("not_matched")
    const trace = result.traces[0]
    expect(trace?.reason).toContain('roleId == "role-1"')
    expect(trace?.predicateOutcomes).toHaveLength(1)
  })

  it("records no predicate outcomes and no action dispositions for a rule that was not evaluated", () => {
    // A trace that carried outcomes for a rule it did not evaluate would be
    // reporting a result nobody asked for, and a reader would have to work out
    // which fields were meaningful.
    const result = evaluateRules(compiledSet([validRuleDocument({ enabled: false })]), validContext())
    expect(result.traces[0]?.predicateOutcomes).toEqual([])
    expect(result.traces[0]?.actions).toEqual([])
  })

  it("records actions in action-kind rank order, restrictively before permissively", () => {
    const result = evaluateRules(
      compiledSet([
        rawRuleDocument({
          ruleId: "rule-mixed",
          predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }],
          actions: [
            { kind: "set_stricter_budget", budget: { maximumFanOut: 4 } },
            { kind: "add_restrictions", deniedCapabilities: ["fs.write"] },
            { kind: "deny_with_reason", reason: "no" },
          ],
        }),
      ]),
      validContext(),
    )
    const trace = result.traces[0]
    expect(trace?.actions.map((action) => action.kind)).toEqual([
      "deny_with_reason",
      "add_restrictions",
      "set_stricter_budget",
    ])
    expect(trace?.actions.map((action) => action.rank)).toEqual([0, 2, 3])
  })
})

// ===========================================================================
// Conflict resolution, ADR section 10.4
// ===========================================================================

describe("ADR 0007 section 10.4, one row at a time", () => {
  it("row 1: deny_with_reason beats pre_approve_within_bounds, and the conflict is recorded", () => {
    const result = evaluateRules(
      compiledSet([preApprovalFor("rule-a-pre", 900), denyDocument("rule-b-deny", "denied for cause")]),
      validContext(),
    )
    // The deny wins: the pre-approval is not offered and the rule IDs are recorded.
    expect(result.deny?.ruleIds).toEqual(["rule-b-deny"])
    expect(result.preApproval?.grantedBy).toBeNull()
    expect(result.preApproval?.blockedBy).toBe("rule-b-deny")
    expect(dispositionOf(result, "rule-a-pre", "pre_approve_within_bounds")).toBe("conflict_denied")
    const conflict = result.conflicts.find((entry) => entry.kind === "deny_overrides_pre_approval")
    expect(conflict).toBeDefined()
    if (conflict?.kind === "deny_overrides_pre_approval") {
      expect(conflict.ruleIds).toEqual(["rule-a-pre", "rule-b-deny"])
    }
  })

  it("row 2: with two matching denies, the LOWEST sort key reports the reason and both are recorded", () => {
    const result = evaluateRules(
      compiledSet([denyDocument("rule-z-late", "the later rule's reason"), denyDocument("rule-a-early", "the earlier rule's reason")]),
      validContext(),
    )
    // The LOWEST sort key reports, not the first one evaluated and not the one
    // with the longest text.
    expect(result.deny?.reason).toBe("the earlier rule's reason")
    expect(result.deny?.ruleIds).toEqual(["rule-a-early", "rule-z-late"])
    expect(result.deny?.reasons).toHaveLength(2)
    const conflict = result.conflicts.find((entry) => entry.kind === "multiple_deny")
    expect(conflict).toBeDefined()
    if (conflict?.kind === "multiple_deny") expect(conflict.ruleIds).toEqual(["rule-a-early", "rule-z-late"])
  })

  it("row 3: with two matching pre-approvals, the lowest sort key with satisfied bounds grants and the rest are shadowed", () => {
    const result = evaluateRules(compiledSet([preApprovalFor("rule-a-pre", 900), preApprovalFor("rule-b-pre", 900)]), validContext())
    expect(result.preApproval?.grantedBy).toBe("rule-a-pre")
    expect(result.preApproval?.shadowed).toEqual(["rule-b-pre"])
    expect(dispositionOf(result, "rule-b-pre", "pre_approve_within_bounds")).toBe("shadowed")
    const conflict = result.conflicts.find((entry) => entry.kind === "multiple_pre_approval")
    expect(conflict).toBeDefined()
    if (conflict?.kind === "multiple_pre_approval") {
      expect(conflict.grantedBy).toBe("rule-a-pre")
      expect(conflict.shadowed).toEqual(["rule-b-pre"])
    }
  })

  it("row 3 again: a candidate whose bounds are NOT satisfied does not grant, and the next one does", () => {
    // The grant goes to the lowest sort key "whose bounds are fully satisfied", so
    // a higher-sort-key rule with satisfied bounds beats a lower-sort-key rule
    // whose declared bounds the dispatch already exceeds.
    const tooTight = preApprovalFor("rule-a-pre", 60)
    const result = evaluateRules(compiledSet([tooTight, preApprovalFor("rule-b-pre", 900)]), validContext({ declaredTimeoutSeconds: 600 }))
    expect(result.preApproval?.grantedBy).toBe("rule-b-pre")
    expect(dispositionOf(result, "rule-a-pre", "pre_approve_within_bounds")).toBe("bounds_exceeded")
  })

  it("row 4: two routing preferences union, and the first non-empty preferredNodeIds wins the head", () => {
    const result = evaluateRules(
      compiledSet([
        // The lower sort key declares an EMPTY list, so it contributes no head and
        // the next rule's list becomes the head.
        routingFor("rule-a-route", { excludedNodeIds: ["node-9"] }),
        routingFor("rule-b-route", { preferredNodeIds: ["node-2", "node-3"] }),
        routingFor("rule-c-route", { preferredNodeIds: ["node-1", "node-3"] }),
      ]),
      validContext(),
    )
    // `node-3` is in both, and appears ONCE, in the position the first list gave it.
    expect(result.routing.preferredNodeIds).toEqual(["node-2", "node-3", "node-1"])
    expect(result.routing.excludedNodeIds).toEqual(["node-9"])
    const conflict = result.conflicts.find((entry) => entry.kind === "multiple_routing_preference")
    expect(conflict).toBeDefined()
    if (conflict?.kind === "multiple_routing_preference") {
      expect(conflict.ruleIds).toEqual(["rule-a-route", "rule-b-route", "rule-c-route"])
    }
  })

  it("row 4 again: the later list EXTENDS the tail rather than reordering the head", () => {
    // This is the distinction that makes an ordered preference an ordered
    // preference: a union that sorted would destroy the ranking the author wrote.
    const result = evaluateRules(
      compiledSet([routingFor("rule-a-route", { preferredNodeIds: ["node-z", "node-a"] }), routingFor("rule-b-route", { preferredNodeIds: ["node-a", "node-b"] })]),
      validContext(),
    )
    expect(result.routing.preferredNodeIds).toEqual(["node-z", "node-a", "node-b"])
  })

  it("row 5: two budgets compose elementwise min, with no conflict recorded", () => {
    const result = evaluateRules(
      compiledSet([budgetFor("rule-a-budget", { maximumFanOut: 8, maximumConcurrency: 4 }), budgetFor("rule-b-budget", { maximumFanOut: 2, maximumRetryLimit: 1 })]),
      validContext(),
    )
    // `min`, per key. The keys one rule does not mention are untouched, which is
    // why the composition is per-key and not per-rule.
    expect(result.budgets.limits.maximumFanOut).toBe(2)
    expect(result.budgets.limits.maximumConcurrency).toBe(4)
    expect(result.budgets.limits.maximumRetryLimit).toBe(1)
    expect(result.conflicts.some((conflict) => conflict.kind === "multiple_routing_preference")).toBe(false)
  })

  it("records no conflict for budgets, because elementwise min has nothing to resolve", () => {
    const result = evaluateRules(compiledSet([budgetFor("rule-a-budget", { maximumFanOut: 8 }), budgetFor("rule-b-budget", { maximumFanOut: 2 })]), validContext())
    expect(result.conflicts).toEqual([])
  })
})

// ===========================================================================
// Widening attempts
// ===========================================================================

describe("a widening attempt is recorded with its attempted value, and changes nothing", () => {
  it("records a budget wider than the one in force as rejected_widening and does not apply it", () => {
    const result = evaluateRules(compiledSet([budgetFor("rule-a-budget", { maximumFanOut: 8 })]), validContext({ currentBudget: { maximumFanOut: 4 } }))
    expect(result.budgets.limits.maximumFanOut).toBe(4)
    expect(result.budgets.rejectedWidening).toEqual([
      { ruleId: "rule-a-budget", field: "maximumFanOut", attempted: 8, current: 4 },
    ])
    expect(dispositionOf(result, "rule-a-budget", "set_stricter_budget")).toBe("rejected_widening")
  })

  it("names the attempted value in the action disposition, because a rule that TRIED to escalate is an audit event", () => {
    const result = evaluateRules(compiledSet([budgetFor("rule-a-budget", { maximumFanOut: 8, maximumConcurrency: 16 })]), validContext({ currentBudget: { maximumFanOut: 4, maximumConcurrency: 4 } }))
    const trace = result.traces[0]
    const action = trace?.actions.find((entry) => entry.kind === "set_stricter_budget")
    expect(action?.details).toContain("maximumFanOut=8 over 4")
    expect(action?.details).toContain("maximumConcurrency=16 over 4")
  })

  it("applies the members of a budget that are within the bound, and refuses only the ones that are not", () => {
    // Per-key, not per-action. A rule that got three of four members right should
    // not have the right one discarded along with the wrong one.
    const result = evaluateRules(compiledSet([budgetFor("rule-a-budget", { maximumFanOut: 8, maximumConcurrency: 2 })]), validContext({ currentBudget: { maximumFanOut: 4 } }))
    expect(result.budgets.limits.maximumFanOut).toBe(4)
    expect(result.budgets.limits.maximumConcurrency).toBe(2)
    expect(result.budgets.rejectedWidening).toHaveLength(1)
  })

  it("applies a budget with no current budget in force, because there is nothing to exceed", () => {
    const result = evaluateRules(compiledSet([budgetFor("rule-a-budget", { maximumFanOut: 8 })]), validContext({ currentBudget: null }))
    expect(result.budgets.limits.maximumFanOut).toBe(8)
    expect(result.budgets.rejectedWidening).toEqual([])
  })

  it("takes the minimum across the rules as well as against the current budget", () => {
    const result = evaluateRules(
      compiledSet([budgetFor("rule-a-budget", { maximumFanOut: 8 }), budgetFor("rule-b-budget", { maximumFanOut: 3 })]),
      validContext({ currentBudget: { maximumFanOut: 16 } }),
    )
    // Three narrowing contributions compose to the smallest. Nothing here widened,
    // so nothing is reported as a widening attempt.
    expect(result.budgets.limits.maximumFanOut).toBe(3)
    expect(result.budgets.rejectedWidening).toEqual([])
  })

  it("refuses a pre-approval whose declared bounds the dispatch already exceeds, rather than offering it", () => {
    // `bounds_exceeded`, and the details name WHICH bound. The kernel's re-check is
    // authoritative and separate; this is the M6-only bounds the kernel cannot
    // know about, because fan-out, concurrency, retry limit and context
    // sensitivity are not in the M0 rule shape at all.
    // The rule DECLARES a fan-out maximum of 2 and the dispatch asks for 8. A rule
    // that declared no fan-out maximum has no fan-out bound to exceed, which is
    // why the bound has to be declared for this case to mean anything.
    const result = evaluateRules(
      compiledSet([preApprovalFor("rule-a-pre", 900, { maximumFanOut: 2 })]),
      validContext({
        declaredTimeoutSeconds: 600,
        requestedFanOut: 8,
        contextManifestSensitivity: "public_to_project",
      }),
    )
    expect(result.preApproval?.grantedBy).toBeNull()
    const action = result.traces[0]?.actions.find((entry) => entry.kind === "pre_approve_within_bounds")
    expect(action?.disposition).toBe("bounds_exceeded")
  })

  it("refuses a pre-approval whose declared timeout the dispatch exceeds", () => {
    const result = evaluateRules(compiledSet([preApprovalFor("rule-a-pre", 60)]), validContext({ declaredTimeoutSeconds: 600 }))
    const action = result.traces[0]?.actions.find((entry) => entry.kind === "pre_approve_within_bounds")
    expect(action?.disposition).toBe("bounds_exceeded")
    expect(action?.details.join(" ")).toContain("declared timeout 600s exceeds the declared maximum 60s")
  })

  it("refuses a pre-approval whose declared sensitivity maximum the manifest exceeds", () => {
    const result = evaluateRules(
      compiledSet([preApprovalFor("rule-a-pre", 900)]),
      validContext({ contextManifestSensitivity: "prohibited", requestedFanOut: 1, declaredTimeoutSeconds: 600 }),
    )
    const action = result.traces[0]?.actions.find((entry) => entry.kind === "pre_approve_within_bounds")
    expect(action?.disposition).toBe("bounds_exceeded")
    expect(action?.details.join(" ")).toContain("sensitivity")
  })

  it("refuses a pre-approval for a capability the dispatch does not request", () => {
    const result = evaluateRules(
      compiledSet([preApprovalFor("rule-a-pre", 900)]),
      validContext({ requestedCapabilities: ["net.fetch"], contextManifestSensitivity: "public_to_project", declaredTimeoutSeconds: 600 }),
    )
    const action = result.traces[0]?.actions.find((entry) => entry.kind === "pre_approve_within_bounds")
    expect(action?.disposition).toBe("bounds_exceeded")
    expect(action?.details.join(" ")).toContain("does not request 'fs.read'")
  })

  it("refuses a pre-approval when the dispatch's fan-out is UNKNOWN, rather than treating unknown as within bounds", () => {
    // "I do not know" and "it is within bounds" are different answers and only one
    // of them is safe to act on.
    const result = evaluateRules(
      compiledSet([preApprovalFor("rule-a-pre", 900, { maximumFanOut: 2 })]),
      validContext({ requestedFanOut: null, declaredTimeoutSeconds: 600 }),
    )
    const action = result.traces[0]?.actions.find((entry) => entry.kind === "pre_approve_within_bounds")
    expect(action?.disposition).toBe("bounds_exceeded")
    expect(action?.details.join(" ")).toContain("fan-out is unknown")
  })
})

// ===========================================================================
// The restriction composition
// ===========================================================================

describe("the restriction composition is monotone, and the kernel's own primitive is what applies it", () => {
  it("collects the demands of every matched narrowing action", () => {
    const result = evaluateRules(
      compiledSet([
        rawRuleDocument({
          ruleId: "rule-a-req",
          predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }],
          actions: [{ kind: "require_approval", requireApprovalForDispatch: true, requireApprovalForCapabilities: ["fs.write"] }],
        }),
        rawRuleDocument({
          ruleId: "rule-b-add",
          predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }],
          actions: [{ kind: "add_restrictions", deniedCapabilities: ["net.fetch"], maximumTimeoutSeconds: 300, allowDestructiveEffects: false }],
        }),
      ]),
      validContext(),
    )
    expect(result.restrictions.requireApprovalForDispatch).toBe(true)
    expect(result.restrictions.requireApprovalForCapabilities).toEqual(["fs.write"])
    expect(result.restrictions.deniedCapabilities).toEqual(["net.fetch"])
    expect(result.restrictions.maximumTimeoutSeconds).toBe(300)
    expect(result.restrictions.allowDestructiveEffects).toBe(false)
  })

  it("takes the SMALLER of two declared timeouts, so composition can only ever narrow", () => {
    const result = evaluateRules(
      compiledSet([
        rawRuleDocument({ ruleId: "rule-a", predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }], actions: [{ kind: "add_restrictions", maximumTimeoutSeconds: 900 }] }),
        rawRuleDocument({ ruleId: "rule-b", predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }], actions: [{ kind: "add_restrictions", maximumTimeoutSeconds: 300 }] }),
      ]),
      validContext(),
    )
    expect(result.restrictions.maximumTimeoutSeconds).toBe(300)
  })

  it("INTERSECTS two allowed-capability sets rather than unioning them", () => {
    const result = evaluateRules(
      compiledSet([
        rawRuleDocument({ ruleId: "rule-a", predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }], actions: [{ kind: "add_restrictions", allowedCapabilities: ["fs.read", "net.fetch"] }] }),
        rawRuleDocument({ ruleId: "rule-b", predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }], actions: [{ kind: "add_restrictions", allowedCapabilities: ["fs.read"] }] }),
      ]),
      validContext(),
    )
    // The intersection is the narrower of the two, which is the whole point: a rule
    // cannot widen another rule's restriction by naming a superset.
    expect(result.restrictions.allowedCapabilities).toEqual(["fs.read"])
  })

  it("leaves an axis unconstrained when no matched rule constrains it", () => {
    // `null`, not `[]`. An empty allowed set would mean "no capability is allowed",
    // which is the opposite of "this axis is unconstrained", and the distinction is
    // the difference between a restriction and a total lockout.
    const result = evaluateRules(compiledSet([validRuleDocument()]), validContext())
    expect(result.restrictions.allowedCapabilities).toBeNull()
    expect(result.restrictions.maximumTimeoutSeconds).toBeNull()
  })

  it("narrows the kernel's own effective state, through narrowPolicyState rather than a second implementation", () => {
    // The composition is fed to the KERNEL's primitive. If this module had its own
    // intersection, the rule layer could diverge from the floor's monotonicity
    // guarantee, and that guarantee is what the whole design rests on.
    const result = evaluateRules(
      compiledSet([
        rawRuleDocument({
          ruleId: "rule-a-req",
          predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }],
          actions: [{ kind: "require_approval", requireApprovalForDispatch: true, requireApprovalForCapabilities: ["fs.read"] }],
        }),
      ]),
      validContext(),
    )
    const state = narrowPolicyState(seedPolicyState(envelope()), "safety_floor", SAFETY_FLOOR_NARROWING, { baseline: true })
    const narrowed = narrowWithRuleRestrictions(state.state, result.restrictions)
    expect(narrowed.state.dispatchApprovalDemands).toContain("rule")
    expect(narrowed.state.approvalRequiredCapabilities).toContain("fs.read")
  })

  it("can only ever NARROW the state it is given, for every input the language admits", () => {
    // The invariant as a property rather than as a claim: for a spread of narrowing
    // shapes, nothing about the result is wider than the input.
    const documents = [
      rawRuleDocument({ ruleId: "rule-a", predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }], actions: [{ kind: "add_restrictions", deniedCapabilities: ["fs.write"] }] }),
      rawRuleDocument({ ruleId: "rule-b", predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }], actions: [{ kind: "require_approval", requireApprovalForDispatch: true }] }),
      rawRuleDocument({ ruleId: "rule-c", predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }], actions: [{ kind: "add_restrictions", allowDestructiveEffects: false, allowExternalEffects: false }] }),
    ]
    const result = evaluateRules(compiledSet(documents), validContext())
    const state = narrowPolicyState(seedPolicyState(envelope()), "safety_floor", SAFETY_FLOOR_NARROWING, { baseline: true })
    const before = state.state
    const after = narrowWithRuleRestrictions(before, result.restrictions).state

    // A subset relation on every axis, plus the two ceilings which can only fall.
    expect(after.allowedCapabilities.every((capability) => before.allowedCapabilities.includes(capability))).toBe(true)
    expect(after.deniedCapabilities.length).toBeGreaterThanOrEqual(before.deniedCapabilities.length)
    expect(after.approvalRequiredCapabilities.length).toBeGreaterThanOrEqual(before.approvalRequiredCapabilities.length)
    // The third rule declares `allowExternalEffects: false`, so both effect flags
    // are off after the composition — the floor had both ON, and the composition
    // only ever turns them off.
    expect(after.allowDestructiveEffects).toBe(false)
    expect(after.allowExternalEffects).toBe(false)
    expect(after.maximumTimeoutSeconds).toBeLessThanOrEqual(before.maximumTimeoutSeconds)
  })
})

// ===========================================================================
// Safety-floor composition through the real kernel
// ===========================================================================

describe("the KERNEL decides, and a rule cannot grant what the floor or the role removes", () => {
  it("hands the kernel exactly the rules that matched, and no others", () => {
    // The M0 `match` shape cannot express twelve of the eighteen M6 fields, so the
    // M6 evaluation is the matching authority and `kernelRules` is dispatch-bound:
    // it is a field of a per-dispatch result and the only sanctioned way to obtain
    // kernel rules from a compiled set.
    const result = evaluateRules(compiledSet([preApprovalDocument(), validRuleDocument({ ruleId: "rule-no-match", predicates: [{ field: "roleId", operator: "eq", value: "role-9" }] })]), validContext())
    expect(result.kernelRules.map((rule) => rule.ruleId)).toEqual(["rule-pre"])
  })

  it("does NOT hand the kernel a rule M6 did not match, even when the projection's match would have accepted the dispatch", () => {
    // The gate on `kernelRules` is the M6 evaluator. This asserts the gate directly:
    // the context below satisfies `capability any [fs.read]`, so the rule's PROJECTED
    // M0 `match` would accept this dispatch on its own — and the rule is still absent
    // from `kernelRules`, because M6 refused it on a field the projection cannot
    // carry (`runtimeKind` here names a kind the dispatch is not on).
    //
    // Both halves matter. If the projection's match were the authority, this rule
    // would be handed over; if the projection were `match: {}` the gate would be the
    // only thing standing between an M6 miss and a kernel grant. The projection is
    // the second check, never the first.
    const set = compiledSet([
      preApprovalFor("rule-pre", 900, {}, { predicates: [{ field: "runtimeKind", operator: "eq", value: "opencode" }] }),
    ])
    // The projection carries `runtimeKinds: ["opencode"]`, so a context on `opencode`
    // would satisfy it.
    expect(set.rules[0]?.kernelRule?.match.runtimeKinds).toEqual(["opencode"])

    // M6 evaluates against a dispatch on a DIFFERENT runtime kind: no match.
    const missed = evaluateRules(set, validContext({ runtimeKind: "claude" }))
    expect(missed.kernelRules).toEqual([])
    expect(outcomeOf(missed, "rule-pre")).toBe("not_matched")

    // And the matched case, so the assertion is about the miss and not about a rule
    // that could never have been handed over.
    const matched = evaluateRules(set, validContext({ runtimeKind: "opencode" }))
    expect(matched.kernelRules.map((rule) => rule.ruleId)).toEqual(["rule-pre"])
  })

  it("makes this finding non-recoverable: a MIS-ATTACHED kernel rule is refused by the KERNEL, not only by the M6 gate", () => {
    // THE END-TO-END PROOF. Take the kernel rules M6 produced for one dispatch and
    // feed them to `evaluatePolicy` attached to an envelope that does NOT satisfy
    // the rule's predicate. Before the match projection existed this was an
    // UNCONDITIONAL pre-approval: `match: {}` declares no criteria, `matchRule`
    // returns `matched: true`, and the kernel grants on its own post-narrowing
    // re-check. With the projection the kernel independently re-checks the part of
    // the predicate M0 can state and refuses.
    //
    // THE ENVELOPES ARE DELIBERATELY CHOSEN so that the ONLY reason for the refusal
    // is the match. Each mismatching envelope is otherwise one the pre-approval
    // WOULD have cleared on its own re-check — it requests exactly the capabilities
    // the rule approves, and its own permission envelope grants them — so the
    // kernel's `coversEverything` and `denials` checks all pass and the match is
    // left as the single remaining gate. A mismatching envelope that also happened
    // to trip `coversEverything` would make this test pass with `match: {}` too,
    // which would prove nothing.
    const set = compiledSet([
      preApprovalFor(
        "rule-pre",
        900,
        { approvedCapabilities: ["fs.read", "fs.write"] },
        {
          predicates: [
            { field: "capability", operator: "any", value: ["fs.read"] },
            { field: "runtimeKind", operator: "eq", value: "opencode" },
          ],
        },
      ),
    ])

    const matched = evaluateRules(set, validContext({ requestedCapabilities: ["fs.read"], runtimeKind: "opencode" }))
    expect(matched.kernelRules).toHaveLength(1)

    // The rule node carries BOTH projections, and the one the rule was NOT scoped to
    // is the one each refusal below turns on.
    expect(matched.kernelRules[0]?.match).toEqual({ requestedCapabilitiesAny: ["fs.read"], runtimeKinds: ["opencode"] })

    // --- Axis 1: the runtime kind. The envelope asks for `fs.read`, which the rule
    // approves, and its permission envelope grants it, so `coversEverything` holds.
    const directAllowed = evaluatePolicy({
      envelope: { ...envelope({}, ["fs.read"]), ruleSnapshots: [...matched.kernelRules] },
      taskTitle: "deploy",
    })
    expect(directAllowed.decision).toBe("allow")
    expect(directAllowed.preApprovalBasis).toEqual({ ruleId: "rule-pre", ruleVersion: 1 })

    const wrongRuntime = evaluatePolicy({
      envelope: { ...envelope({ runtimeKind: "claude" }, ["fs.read"]), ruleSnapshots: [...matched.kernelRules] },
      taskTitle: "deploy",
    })
    expect(wrongRuntime.decision).toBe("require_approval")
    expect(wrongRuntime.preApprovalBasis).toBeNull()
    expect(wrongRuntime.grantedPreApprovals).toEqual([])
    // Named in the kernel's OWN explanation tree, so an auditor can see the refusal
    // was the rule's match and not some later check.
    expect(wrongRuntime.explanationText).toContain("runtimeKinds did not include")

    // --- Axis 2: the requested capability. The envelope asks for `fs.write` alone,
    // which the rule approves, so `coversEverything` holds on it too.
    const wrongCapability = evaluatePolicy({
      envelope: { ...envelope({}, ["fs.write"]), ruleSnapshots: [...matched.kernelRules] },
      taskTitle: "deploy",
    })
    expect(wrongCapability.decision).toBe("require_approval")
    expect(wrongCapability.preApprovalBasis).toBeNull()
    expect(wrongCapability.grantedPreApprovals).toEqual([])
    expect(wrongCapability.explanationText).toContain("requestedCapabilitiesAny did not intersect")

    // Both refusals survive the M6 composition helper too, so a caller going through
    // `evaluateWithKernel` rather than the kernel directly gets the same answer.
    for (const mismatched of [envelope({ runtimeKind: "claude" }, ["fs.read"]), envelope({}, ["fs.write"])]) {
      const composed = evaluateWithKernel({ envelope: mismatched, taskTitle: "deploy" }, set, matched.kernelRules)
      expect(composed.ok).toBe(true)
      if (!composed.ok) continue
      expect(composed.value.decision).toBe("require_approval")
      expect(composed.value.preApprovalBasis).toBeNull()
    }
  })

  it("grants a pre-approval the floor permits, through the kernel's own re-check", () => {
    const set = compiledSet([preApprovalFor("rule-pre", 900)])
    const result = evaluateRules(set, validContext())
    const composed = evaluateWithKernel({ envelope: envelope(), taskTitle: "deploy" }, set, result.kernelRules)
    expect(composed.ok).toBe(true)
    if (!composed.ok) return
    expect(composed.value.decision).toBe("allow")
    expect(composed.value.preApprovalBasis).toEqual({ ruleId: "rule-pre", ruleVersion: 1 })
  })

  it("refuses, in the KERNEL, a pre-approval whose rule maximum exceeds the effective timeout ceiling", () => {
    // The kernel's second pass re-derives every grant from the fully narrowed state
    // and refuses when the declared timeout exceeds the rule's own maximum. M6 does
    // not re-implement that check; it hands the kernel a correctly shaped rule and
    // the kernel refuses. The test proves it by RUNNING the kernel.
    const set = compiledSet([preApprovalFor("rule-pre", 60)])
    const result = evaluateRules(set, validContext({ declaredTimeoutSeconds: 600 }))
    const composed = evaluateWithKernel({ envelope: envelope({ timeoutSeconds: 600 }), taskTitle: "deploy" }, set, result.kernelRules)
    expect(composed.ok).toBe(true)
    if (!composed.ok) return
    expect(composed.value.decision).toBe("require_approval")
    expect(composed.value.preApprovalBasis).toBeNull()
  })

  it("refuses, in the KERNEL, a pre-approval that does not cover every effectively allowed capability", () => {
    // The role allows two capabilities and the rule approves one. The kernel's
    // `coversEverything` check refuses, and there is no M6-side substitute for it:
    // M6 does not know the effective state.
    const set = compiledSet([
      rawPreApprovalDocument({
        actions: [
          {
            kind: "pre_approve_within_bounds",
            approvedCapabilities: ["fs.read"],
            maximumTimeoutSeconds: 900,
            allowDestructiveEffects: false,
            allowExternalEffects: false,
            maximumSensitivity: "restricted",
          },
        ],
      }),
    ])
    const result = evaluateRules(set, validContext({ requestedCapabilities: ["fs.read", "net.fetch"] }))
    const composed = evaluateWithKernel(
      { envelope: envelope({}, ["fs.read", "net.fetch"]), taskTitle: "deploy" },
      set,
      result.kernelRules,
    )
    expect(composed.ok).toBe(true)
    if (!composed.ok) return
    expect(composed.value.decision).toBe("require_approval")
    expect(composed.value.preApprovalBasis).toBeNull()
  })

  it("refuses, in the KERNEL, a pre-approval that would clear a capability the ROLE removed", () => {
    // The role's `allowedCapabilities` excludes `fs.write`; the rule pre-approves
    // it anyway. The kernel denies the capability outright, and a pre-approval may
    // not clear a denial — this is the invariant of ADR 0007 section 7.7, mechanism
    // 3, exercised through the real engine.
    const set = compiledSet([
      rawPreApprovalDocument({
        actions: [
          {
            kind: "pre_approve_within_bounds",
            approvedCapabilities: ["fs.read", "fs.write"],
            maximumTimeoutSeconds: 900,
            allowDestructiveEffects: false,
            allowExternalEffects: false,
            maximumSensitivity: "restricted",
          },
        ],
      }),
    ])
    // The dispatch REQUESTS `fs.write` and the role DENIES it. That is the shape
    // that produces a kernel denial: a capability the dispatch never asks for
    // cannot be denied, and a capability the envelope does not decide on is a
    // schema error before evaluation.
    const result = evaluateRules(set, validContext({ requestedCapabilities: ["fs.read", "fs.write"] }))
    const composed = evaluateWithKernel(
      { envelope: envelope({}, ["fs.read", "fs.write"], ["fs.write"]), taskTitle: "deploy" },
      set,
      result.kernelRules,
    )
    expect(composed.ok).toBe(true)
    if (!composed.ok) return
    expect(composed.value.decision).toBe("deny")
    expect(composed.value.denials.map((denial) => denial.code)).toContain("policy.capability_denied")
    // And the pre-approval was NOT granted, which is the invariant: no rule grants
    // a capability the role removed.
    expect(composed.value.preApprovalBasis).toBeNull()
  })

  it("lowers the PROJECTED timeout to the dispatch's own, so a generous declared bound is not read as a widening", () => {
    // The M0 re-check treats a rule maximum above the effective state ceiling as a
    // widening attempt. A rule declaring 900s attached to a 600s dispatch would
    // therefore be refused for declaring a ceiling above the dispatch it is
    // attached to. The projection is bounded DOWN to the dispatch's declared
    // timeout, which is a `min` and can only narrow.
    const set = compiledSet([preApprovalFor("rule-pre", 3_600)])
    const result = evaluateRules(set, validContext({ declaredTimeoutSeconds: 300 }))
    expect(result.kernelRules[0]?.effect).toMatchObject({ kind: "pre_approve", maximumTimeoutSeconds: 300 })
    // The DECLARED bound is untouched: the disclosure and the trace still show 3600.
    expect(result.preApproval?.candidates[0]?.bounds.maximumTimeoutSeconds).toBe(3_600)
  })

  it("refuses a kernel rule that is not a member of the compiled set", () => {
    // A kernel rule from anywhere else would carry an M6 predicate that was never
    // evaluated for this dispatch, which is precisely the second evaluation path
    // ADR 0007's first stop condition forbids.
    //
    // The foreign rule is a GENUINE member of a second compiled set rather than a
    // copy of this set's own rule with one key overwritten. A hand-edited object
    // would have needed a cast to satisfy the kernel rule type, and a cast here
    // would hide exactly the mismatch the test is about: `ruleId` is half of the
    // identity this check reads.
    const set = compiledSet([preApprovalFor("rule-pre", 900)])
    const other = compiledSet([preApprovalFor("rule-other", 900)])
    const foreign = other.rules[0]?.kernelRule
    if (foreign === undefined || foreign === null) throw new Error("the second rule set produced no kernel rule to offer")
    expect(foreign.ruleId).toBe("rule-other")
    const composed = evaluateWithKernel({ envelope: envelope(), taskTitle: "deploy" }, set, [foreign])
    expect(composed.ok).toBe(false)
    if (!composed.ok) {
      expect(composed.error.code).toBe("rule.evaluation_failed")
      // And the refusal NAMES the rule it refused, so an operator can see which
      // member was rejected rather than only that something was.
      expect(composed.error.message).toContain("rule-other@1")
    }
  })

  it("produces a kernel evaluation that satisfies the kernel's own schema", () => {
    // The composition validates what the kernel produced rather than trusting it,
    // so a change to the kernel cannot hand this module a value it would then pass
    // on as if it were well formed.
    const set = compiledSet([preApprovalFor("rule-pre", 900)])
    const result = evaluateRules(set, validContext())
    const composed = evaluateWithKernel({ envelope: envelope(), taskTitle: "deploy" }, set, result.kernelRules)
    expect(composed.ok).toBe(true)
    if (composed.ok) expect(policyEvaluationSchema.safeParse(composed.value).success).toBe(true)
  })

  it("leaves the decision to the kernel, because an M6 result carries no decision field at all", () => {
    // The M6 layer is an INPUT to the kernel's decision, not a second decision
    // point. There is no `decision` on the result to disagree with.
    const result = evaluateRules(compiledSet([preApprovalFor("rule-pre", 900)]), validContext())
    expect(Object.keys(result)).not.toContain("decision")
    expect(result.preApproval?.grantedBy).toBe("rule-pre")
  })

  it("states the safety floor's timeout ceiling, which bounds every declared pre-approval", () => {
    expect(SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS).toBe(3_600)
  })
})

// ===========================================================================
// Shadowing
// ===========================================================================

describe("shadowing is reported only when PROVEN, and an unprovable overlap is never called a shadowing", () => {
  const relationsFor = (result: RuleEvaluationResult, from: string, to: string): string | undefined =>
    result.shadowing.find((entry) => entry.shadowingRuleId === from && entry.shadowedRuleId === to)?.relation

  it("reports 'shadowed' when one rule's predicate is a PROVEN superset of the other's", () => {
    // `capability any ["a","b"]` is a proven superset of `capability any ["a"]` on
    // the same field with subset-comparable operators, and `deny_with_reason`
    // covers the other's action kind.
    const result = evaluateRules(
      compiledSet([
        denyDocument("rule-b-narrow", "narrow", { predicates: [{ field: "capability", operator: "any", value: ["fs.read"] }] }),
        denyDocument("rule-a-wide", "wide", { predicates: [{ field: "capability", operator: "any", value: ["fs.read", "net.fetch"] }] }),
      ]),
      validContext(),
    )
    expect(relationsFor(result, "rule-a-wide", "rule-b-narrow")).toBe("shadowed")
  })

  it("reports 'possible_overlap' and NOT 'shadowed' when the two rules constrain DIFFERENT axes", () => {
    // `projectId` and `roleId` are independent: either can hold alone, so neither
    // is a superset of the other, and the pair MIGHT co-match. Reporting this as a
    // shadowing would train the user to ignore the field.
    const result = evaluateRules(
      compiledSet([
        denyDocument("rule-a-project", "p", { predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }] }),
        denyDocument("rule-b-role", "r", { predicates: [{ field: "roleId", operator: "eq", value: "role-1" }] }),
      ]),
      validContext(),
    )
    expect(relationsFor(result, "rule-a-project", "rule-b-role")).toBe("possible_overlap")
    expect(relationsFor(result, "rule-b-role", "rule-a-project")).toBe("possible_overlap")
    expect(result.shadowing.some((entry) => entry.relation === "shadowed")).toBe(false)
  })

  it("reports 'possible_overlap' when the two numeric bounds are not comparable", () => {
    // `fanOut <= 4` and `fanOut >= 2` overlap but neither contains the other, and a
    // containment proof that guessed here would report a shadowing that does not
    // exist.
    const result = evaluateRules(
      compiledSet([
        denyDocument("rule-a-low", "l", { predicates: [{ field: "fanOut", operator: "gte", value: 2 }] }),
        denyDocument("rule-b-high", "h", { predicates: [{ field: "fanOut", operator: "lte", value: 4 }] }),
      ]),
      validContext(),
    )
    expect(result.shadowing.every((entry) => entry.relation === "possible_overlap")).toBe(true)
    expect(result.shadowing.some((entry) => entry.relation === "shadowed")).toBe(false)
  })

  it("reports 'shadowed' for a `between` that provably CONTAINS another", () => {
    const result = evaluateRules(
      compiledSet([
        denyDocument("rule-b-narrow", "n", { predicates: [{ field: "fanOut", operator: "between", value: { min: 2, max: 3 } }] }),
        denyDocument("rule-a-wide", "w", { predicates: [{ field: "fanOut", operator: "between", value: { min: 1, max: 8 } }] }),
      ]),
      validContext(),
    )
    expect(relationsFor(result, "rule-a-wide", "rule-b-narrow")).toBe("shadowed")
  })

  it("does NOT report a shadowing when the superset rule's action kinds do not cover the other's", () => {
    // A proven superset predicate is not enough. Shadowing is a claim that the
    // second rule has no effect, and a rule whose actions the first does not carry
    // still has one.
    const result = evaluateRules(
      compiledSet([
        budgetFor("rule-b-budget", { maximumFanOut: 2 }),
        denyDocument("rule-a-deny", "d", { predicates: [{ field: "capability", operator: "any", value: ["fs.read", "net.fetch"] }] }),
      ]),
      validContext(),
    )
    expect(relationsFor(result, "rule-a-deny", "rule-b-budget")).not.toBe("shadowed")
  })

  it("reports a disjoint pair as a possible overlap, with the disjointness in the reason, rather than as a shadowing", () => {
    const result = evaluateRules(
      compiledSet([
        denyDocument("rule-a-cap", "a", { predicates: [{ field: "capability", operator: "any", value: ["fs.read"] }] }),
        denyDocument("rule-b-cap", "b", { predicates: [{ field: "capability", operator: "any", value: ["net.fetch"] }] }),
      ]),
      validContext(),
    )
    const relation = relationsFor(result, "rule-a-cap", "rule-b-cap")
    // Provably disjoint on the same axis with non-overlapping members, so they
    // cannot co-match. The relation is still not `shadowed`, because a shadowing
    // is a claim about superset and these are simply apart.
    expect(relation).not.toBe("shadowed")
    expect(result.shadowing.every((entry) => entry.relation === "possible_overlap")).toBe(true)
  })

  it("does not report a shadowing for a rule against ITSELF, or between two versions of one ruleId", () => {
    const result = evaluateRules(
      compiledSet([validRuleDocument({ templateVersion: 1 }), validRuleDocument({ templateVersion: 2 })]),
      validContext(),
    )
    // Two versions of one ruleId are a supersession question, not a shadowing
    // question, and reporting a rule as shadowing itself would be nonsense.
    expect(result.shadowing).toEqual([])
  })

  it("reports no shadowing for a single rule", () => {
    const result = evaluateRules(compiledSet([validRuleDocument()]), validContext())
    expect(result.shadowing).toEqual([])
  })
})

// ===========================================================================
// No content in the trace
// ===========================================================================

describe("the result carries identifiers and reasons, never dispatch content", () => {
  it("carries no prompt text, task title, label or capability the rule did not name", () => {
    const result = evaluateRules(compiledSet([validRuleDocument()]), validContext({ taskTitle: "CANARY-TITLE", taskLabels: ["CANARY-LABEL"] }))
    const serialized = canonicalJson({
      traces: result.traces,
      deny: result.deny,
      restrictions: result.restrictions,
      budgets: result.budgets,
      routing: result.routing,
      preApproval: result.preApproval,
    })
    expect(serialized).not.toContain("CANARY")
  })

  it("does not evaluate or mutate the context it is given", () => {
    const context = validContext()
    const before = canonicalJson(context)
    evaluateRules(compiledSet([validRuleDocument()]), context)
    expect(canonicalJson(context)).toBe(before)
  })

  it("produces the same result from a cloned context, so nothing depends on object identity", () => {
    const set = compiledSet([validRuleDocument()])
    const first = evaluateRules(set, validContext())
    const second = evaluateRules(set, clone(validContext()))
    expect(canonicalJson(first)).toBe(canonicalJson(second))
  })
})

// ===========================================================================
// The evaluation context's own contract
// ===========================================================================

describe("the evaluation context carries every axis a predicate reads, and every nullable one means something", () => {
  it("evaluates a context with every nullable field null, without throwing and without matching", () => {
    // The "no facts at all" dispatch. Every predicate against it is unsatisfied, so
    // a rule scoped to anything does not match, and the reason is stated rather
    // than assumed.
    // Built through the context schema rather than annotated by hand, so the
    // "no facts at all" dispatch is known to satisfy the same contract every other
    // context does.
    const empty: RuleEvaluationContext = ruleEvaluationContextSchema.parse({
      projectId: "proj-1",
      roleId: null,
      roleVersion: null,
      requestedCapabilities: [],
      toolCategories: [],
      runtimeKind: null,
      targetNodeId: null,
      nodeAdvertisedCapabilities: null,
      projectPathId: null,
      taskLabels: [],
      dependencyOutcomes: [],
      requestedFanOut: null,
      requestedConcurrency: null,
      requestedRetryLimit: null,
      declaredTimeoutSeconds: null,
      taskTitle: null,
      evaluatedAt: "2026-02-02T12:00:00Z",
      contextManifestSensitivity: null,
      currentBudget: null,
    })
    // `validRuleDocument` is scoped by `roleId` and `preApprovalDocument` by
    // `projectId`. The first cannot be evaluated at all against this context; the
    // second CAN, because a project id is the one axis that is never absent, which
    // is exactly why it is the axis the universal-pre-approval check names first.
    const result = evaluateRules(compiledSet([validRuleDocument(), preApprovalDocument()]), empty)
    expect(outcomeOf(result, "rule-a")).toBe("not_matched")
    expect(outcomeOf(result, "rule-pre")).toBe("matched")
    // And the pre-approval that matched is still refused, because the dispatch
    // requested no capabilities and has no manifest: bounds the rule declared
    // cannot be shown to hold.
    expect(result.preApproval?.grantedBy).toBeNull()
  })

  it("uses `currentBudget` as the budget in force, which is what makes a widening attempt detectable at all", () => {
    // Without it there is nothing to compare against and every contribution would
    // be indistinguishable from the first one.
    const withBudget = evaluateRules(compiledSet([budgetFor("rule-a-budget", { maximumFanOut: 8 })]), validContext({ currentBudget: { maximumFanOut: 4 } }))
    const withoutBudget = evaluateRules(compiledSet([budgetFor("rule-a-budget", { maximumFanOut: 8 })]), validContext({ currentBudget: null }))
    expect(withBudget.budgets.rejectedWidening).toHaveLength(1)
    expect(withoutBudget.budgets.rejectedWidening).toHaveLength(0)
  })
})
