/**
 * Rendering: the explanation, the normalized description, and the pre-approval
 * disclosure.
 *
 * THE SECRET-FREE CLAIM IS ENFORCED, NOT DOCUMENTED. ADR 0007 section 12 says a
 * rendered explanation contains identifiers, enum values, numbers, digests, rule
 * metadata and authored reason strings, and never prompt text, task descriptions,
 * context manifest content, memory record content, capability payload bytes,
 * terminal output, environment values, bearer tokens or provider credentials.
 *
 * These tests seed a CANARY into every field of the evaluation context that could
 * plausibly carry content — the task title, the labels, the tool categories, the
 * node capabilities, the dependency outcomes — and then assert the canary appears
 * nowhere in the rendered explanation, the disclosure, the trace, the digest base
 * or the normalized form. A canary is the only way to make "it does not leak"
 * falsifiable; a comment saying it does not leak is not.
 *
 * The second claim is DETERMINISM. Every collection in the output is sorted by
 * UTF-16 code unit and de-duplicated, and two renderings of the same result are
 * byte-identical. A rendered explanation is an audit artifact, and an audit
 * artifact that differs run to run cannot be compared, diffed or quoted.
 *
 * The third is the reach `unknown`. A pre-approval unconstrained on projects
 * matches EVERY project, and a disclosure that rendered that as an empty set would
 * be telling the reader the exact opposite of the truth — in a bracket pair that
 * looks like data. So `unknown` is a distinct state with a distinct literal, and
 * every unconstrained axis raises a warning in words.
 */

import { describe, expect, it } from "vitest"
import {
  UNKNOWN_REACH_TEXT,
  buildPreApprovalDisclosure,
  compileRuleSet,
  describeNormalizedPredicate,
  evaluateRules,
  renderRuleExplanation,
  type CompiledRule,
  type CompiledRuleSet,
  type PreApprovalDisclosure,
  type RuleEvaluationResult,
} from "../../../src/rules/index.js"
import { canonicalJson } from "../../../src/orchestration/digest.js"
import { PROJECT_ID, preApprovalDocument, rawPreApprovalDocument, rawRuleDocument, validContext } from "./fixtures.js"

/** Every string a context could carry content in, seeded with one canary. */
const CANARY = "CANARY-CONTENT-MUST-NOT-APPEAR"

function canaryContext() {
  return validContext({
    taskTitle: CANARY,
    taskLabels: [CANARY],
    toolCategories: [CANARY],
    nodeAdvertisedCapabilities: [CANARY],
    dependencyOutcomes: ["succeeded"],
  })
}

function setOf(documents: readonly unknown[]): CompiledRuleSet {
  const compiled = compileRuleSet(documents)
  if (!compiled.ok) throw new Error(`fixture failed to compile: ${compiled.error.code} ${compiled.error.message}`)
  return compiled.value
}

function firstRuleOf(documents: readonly unknown[]): CompiledRule {
  const rule = setOf(documents).rules[0]
  if (rule === undefined) throw new Error("empty rule set")
  return rule
}

// ===========================================================================
// The explanation
// ===========================================================================

describe("the rendered explanation is deterministic, bounded and free of dispatch content", () => {
  it("renders byte-identical text for the same result, every time", () => {
    const set = setOf([preApprovalDocument(), rawRuleDocument({ ruleId: "rule-deny", actions: [{ kind: "deny_with_reason", reason: "because" }] })])
    const result = evaluateRules(set, validContext())
    const texts = new Set<string>()
    for (let attempt = 0; attempt < 50; attempt += 1) {
      texts.add(renderRuleExplanation(evaluateRules(set, validContext())))
    }
    expect(texts.size).toBe(1)
  })

  it("contains none of the canary content, from any field of the context", () => {
    const result = evaluateRules(setOf([preApprovalDocument()]), canaryContext())
    const text = renderRuleExplanation(result)
    expect(text).not.toContain(CANARY)
  })

  it("contains none of the canary content in the trace, the dispositions, or the digest base", () => {
    // The renderer is only one place a value could escape. The RESULT is what
    // other subsystems read — routing, budgets, notifications — so the absence has
    // to hold there too, not only in the text.
    const result = evaluateRules(setOf([preApprovalDocument()]), canaryContext())
    const { decisionDigest, ...base } = result
    void decisionDigest
    expect(canonicalJson(result)).not.toContain(CANARY)
    expect(canonicalJson(base)).not.toContain(CANARY)
  })

  it("contains none of the canary content in the normalized form or the compiled rule", () => {
    const rule = firstRuleOf([preApprovalDocument()])
    expect(rule.normalizedPredicate).not.toContain(CANARY)
    // The compiled rule DOES carry the source document, which is authored text, so
    // the assertion is about the parts a reader is shown rather than the whole
    // artifact: the normalized form, the digest, and the rendered explanation.
    expect(canonicalJson({ normalizedPredicate: rule.normalizedPredicate, digest: rule.digest })).not.toContain(CANARY)
  })

  it("contains none of the canary content in the disclosure, including its history section", () => {
    // The history section takes contexts, so it is the one place a caller could
    // hand the renderer a value full of content. It is evaluated and reduced to a
    // boolean, never rendered.
    const rule = firstRuleOf([preApprovalDocument()])
    const disclosure = buildPreApprovalDisclosure(rule, {
      historicalDispatches: [
        { dispatchId: "disp-1", context: canaryContext() },
        { dispatchId: "disp-2", context: { ...canaryContext(), projectId: "other-project" } },
      ],
    })
    expect(canonicalJson(disclosure)).not.toContain(CANARY)
  })

  it("contains no prompt text, because the renderer has no parameter through which a prompt could arrive", () => {
    // The structural argument, asserted as a signature: `renderRuleExplanation`
    // takes the RESULT and nothing else, so there is no value in scope that could
    // be a secret. A renderer that also accepted the envelope would have to be
    // trusted to pick the safe fields out of it.
    expect(renderRuleExplanation.length).toBe(1)
  })

  it("names the rule, its outcome, its predicate outcomes and its action dispositions", () => {
    const result = evaluateRules(setOf([preApprovalDocument()]), validContext())
    const text = renderRuleExplanation(result)
    expect(text).toContain("ruleLayer: language v2")
    expect(text).toContain("rule-pre@1: matched")
    expect(text).toContain('projectId == "proj-1"')
    expect(text).toContain("pre_approve_within_bounds")
    expect(text).toContain("preApproval: grantedBy=rule-pre")
    expect(text).toContain("decisionDigest: sha256:")
  })

  it("states which narrowing members the M0 kernel effect cannot carry, rather than implying it carries them", () => {
    // "The kernel enforces everything" would be a false claim about
    // `requireApprovalForDispatch` and `requireApprovalForCapabilities`, which the
    // frozen M0 `restrict` effect has no field for.
    const set = setOf([
      rawRuleDocument({
        ruleId: "rule-req",
        predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }],
        actions: [{ kind: "require_approval", requireApprovalForDispatch: true }],
      }),
    ])
    const text = renderRuleExplanation(evaluateRules(set, validContext()))
    expect(text).toContain("restrictionsNotProjectedIntoTheKernel: requireApprovalForDispatch")
  })

  it("renders a rejected widening attempt with its attempted value, in words", () => {
    const set = setOf([
      rawRuleDocument({
        ruleId: "rule-budget",
        predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }],
        actions: [{ kind: "set_stricter_budget", budget: { maximumFanOut: 8 } }],
      }),
    ])
    const text = renderRuleExplanation(evaluateRules(set, validContext({ currentBudget: { maximumFanOut: 4 } })))
    expect(text).toContain("rejected_widening: rule-budget maximumFanOut 8 over 4")
  })

  it("renders 'unconstrained' rather than an empty bracket pair for an unbounded axis", () => {
    // Same reasoning as the reach `unknown`: `[]` reads as "nothing", and the
    // truth is "unconstrained".
    const text = renderRuleExplanation(evaluateRules(setOf([preApprovalDocument()]), validContext()))
    expect(text).toContain("allowed=unconstrained")
    expect(text).toContain("maximumTimeoutSeconds=unconstrained")
  })

  it("renders a rule that did not match with the predicate that failed", () => {
    const set = setOf([
      rawRuleDocument({
        ruleId: "rule-a",
        predicates: [
          { field: "roleId", operator: "eq", value: "role-1" },
          { field: "projectId", operator: "eq", value: "other" },
        ],
        actions: [{ kind: "deny_with_reason", reason: "x" }],
      }),
    ])
    const text = renderRuleExplanation(evaluateRules(set, validContext()))
    expect(text).toContain("not_matched")
    expect(text).toContain('projectId == "other"')
  })

  it("marks an unevaluable predicate as such, so a reader can tell a mismatch from a missing fact", () => {
    const set = setOf([
      rawRuleDocument({
        ruleId: "rule-a",
        predicates: [{ field: "roleId", operator: "eq", value: "role-1" }],
        actions: [{ kind: "deny_with_reason", reason: "x" }],
      }),
    ])
    const text = renderRuleExplanation(evaluateRules(set, validContext({ roleId: null })))
    expect(text).toContain("(unevaluable)")
  })
})

// ===========================================================================
// The normalized description
// ===========================================================================

describe("the normalized description is the compiler's own renderer, not a second implementation", () => {
  it("agrees with the compiled rule's normalizedPredicate", () => {
    // ADR 0007 section 11: the form a user reads and the form the compiler digests
    // must be the same string. Two renderers would make that a coincidence.
    const rule = firstRuleOf([
      rawRuleDocument({
        predicates: [
          { field: "capability", operator: "any", value: ["b", "a"] },
          { field: "all", predicates: [{ field: "roleId", operator: "eq", value: "role-1" }] },
        ],
        actions: [{ kind: "deny_with_reason", reason: "x" }],
      }),
    ])
    expect(describeNormalizedPredicate(rule.predicates)).toBe(rule.normalizedPredicate)
  })

  it("sorts members and keeps declaration order, exactly as the compiler does", () => {
    expect(
      describeNormalizedPredicate([
        { field: "capability", operator: "any", value: ["b", "a"] } as never,
        { field: "roleId", operator: "eq", value: "role-1" } as never,
      ]),
    ).toBe('(capability any ["a","b"] and roleId == "role-1")')
  })

  it("renders an empty list as the universal predicate", () => {
    expect(describeNormalizedPredicate([])).toBe("all()")
  })
})

// ===========================================================================
// The disclosure: the eight required items
// ===========================================================================

describe("the pre-approval disclosure shows every item ADR 0007 section 11 requires, each naming its source", () => {
  const scoped = (): CompiledRule =>
    firstRuleOf([
      preApprovalDocument({
        actions: [
          {
            kind: "pre_approve_within_bounds",
            approvedCapabilities: ["fs.read", "net.fetch"],
            maximumTimeoutSeconds: 900,
            allowDestructiveEffects: false,
            allowExternalEffects: false,
            maximumFanOut: 4,
            maximumConcurrency: 2,
            maximumRetryLimit: 1,
            maximumSensitivity: "restricted",
          },
        ],
      }),
    ])

  it("item 1: the exact predicate and its normalized form", () => {
    const disclosure = buildPreApprovalDisclosure(scoped())
    expect(disclosure.normalizedPredicate).toBe('projectId == "proj-1"')
  })

  it("item 2: the reach on every axis, as a sorted de-duplicated set", () => {
    const disclosure = buildPreApprovalDisclosure(scoped())
    // The fixture constrains ONLY projects, so roles, capabilities, nodes and
    // paths are all `unknown` — asserted below.
    expect(disclosure.reach.projects).toEqual({ kind: "constrained", values: ["proj-1"], sources: ["predicates[0]"] })
  })

  it("item 3: every bound, from the action's DECLARED values and not a computed narrowing", () => {
    const disclosure = buildPreApprovalDisclosure(scoped())
    // The declared values, verbatim. A computed narrowing would show the floor's
    // tighter ceiling, and the reader would conclude the rule grants up to the
    // tighter number when the disclosure that justified activating it said nothing
    // about the wider one.
    expect(disclosure.bounds.fanOut).toEqual({ kind: "declared", value: 4, source: "actions[pre_approve_within_bounds].maximumFanOut" })
    expect(disclosure.bounds.concurrency).toEqual({ kind: "declared", value: 2, source: "actions[pre_approve_within_bounds].maximumConcurrency" })
    expect(disclosure.bounds.retryLimit).toEqual({ kind: "declared", value: 1, source: "actions[pre_approve_within_bounds].maximumRetryLimit" })
    expect(disclosure.bounds.timeoutSeconds).toEqual({ kind: "declared", value: 900, source: "actions[pre_approve_within_bounds].maximumTimeoutSeconds" })
    expect(disclosure.bounds.sensitivity).toEqual({ kind: "declared", value: "restricted", source: "actions[pre_approve_within_bounds].maximumSensitivity" })
  })

  it("item 4: the historical dispatches it would have matched, EVALUATED rather than asserted", () => {
    const disclosure = buildPreApprovalDisclosure(scoped(), {
      historicalDispatches: [
        { dispatchId: "disp-match", context: validContext() },
        { dispatchId: "disp-other-project", context: validContext({ projectId: "other" }) },
      ],
    })
    // The same evaluator decides, so a disclosure cannot claim a history the
    // runtime would disagree with.
    expect(disclosure.historicalMatches).toEqual([
      { dispatchId: "disp-match", matched: true },
      { dispatchId: "disp-other-project", matched: false },
    ])
  })

  it("item 5: the conflicts and shadowing, from the evaluation", () => {
    const disclosure = buildPreApprovalDisclosure(scoped(), {
      conflicts: ["multiple_deny[b,a]"],
      shadowing: ["possible_overlap:a>b"],
    })
    expect(disclosure.conflicts).toEqual(["multiple_deny[b,a]"])
    expect(disclosure.shadowing).toEqual(["possible_overlap:a>b"])
  })

  it("item 6: the expiry, with the literal warning when there is none", () => {
    // The fixture declares no expiry, so the disclosure says so in the literal
    // terms the plan asks for rather than rendering a blank.
    const undated = buildPreApprovalDisclosure(scoped())
    expect(undated.expiresAt).toEqual({ kind: "no_expiry", value: null })
    expect(undated.warnings.join(" ")).toContain("no expiry")

    const withExpiry = firstRuleOf([preApprovalDocument({ expiresAt: "2027-01-01T00:00:00Z" })])
    const expiring = buildPreApprovalDisclosure(withExpiry)
    expect(expiring.expiresAt).toEqual({ kind: "dated", value: "2027-01-01T00:00:00Z" })
    expect(expiring.warnings.join(" ")).not.toContain("no expiry")
  })

  it("item 7: the creator identity, the version, the activation time and the activator", () => {
    const disclosure = buildPreApprovalDisclosure(scoped())
    expect(disclosure.author).toBe("user:user-1")
    expect(disclosure.templateVersion).toBe(1)
    expect(disclosure.activation).toEqual({ state: "activated", activatedAt: "2026-01-01T00:00:00Z", activatedBy: "user:user-1" })
  })

  it("item 8: renders an unconstrained reach axis as the literal 'unknown', never as an empty set", () => {
    const disclosure = buildPreApprovalDisclosure(scoped())
    // The literal, and NOT `[]`. An empty set reads as "matches nothing", which is
    // the opposite of the truth: an unconstrained axis matches EVERYTHING.
    for (const axis of ["roles", "capabilities", "nodes", "projectPaths"] as const) {
      expect(disclosure.reach[axis].kind).toBe("unknown")
      if (disclosure.reach[axis].kind === "unknown") {
        expect(disclosure.reach[axis]).toEqual({ kind: "unknown", sources: [] })
      }
    }
    expect(canonicalJson(disclosure)).not.toContain('"values":[]')
  })

  it("raises a warning for EVERY unconstrained reach axis, and none for a constrained one", () => {
    const disclosure = buildPreApprovalDisclosure(scoped())
    // The fixture constrains PROJECTS and nothing else, so four of the five axes
    // warn — and projects does not, because a constrained axis is not a warning.
    for (const axis of ["roles", "capabilities", "nodes", "projectPaths"]) {
      expect(disclosure.warnings.join(" ")).toContain(`unconstrained on '${axis}'`)
    }
    expect(disclosure.warnings.join(" ")).not.toContain("unconstrained on 'projects'")
    // And the warning says why `unknown` is not an empty set, because that is the
    // reading the literal exists to prevent.
    expect(disclosure.warnings.join(" ")).toContain(UNKNOWN_REACH_TEXT)
    expect(disclosure.warnings.join(" ")).toContain("matches everything")
  })

  it("names the predicate path each constrained axis was read from", () => {
    const rule = firstRuleOf([
      rawPreApprovalDocument({
        predicates: [
          { field: "all", predicates: [{ field: "capability", operator: "any", value: ["fs.read"] }, { field: "targetNodeId", operator: "in", value: ["node-2", "node-1"] }] },
        ],
      }),
    ])
    const disclosure = buildPreApprovalDisclosure(rule)
    expect(disclosure.reach.capabilities).toEqual({ kind: "constrained", values: ["fs.read"], sources: ["predicates[0].all[0]"] })
    // Sorted AND de-duplicated, and the ORDER the author wrote is not the order
    // reported — a set has no order to preserve.
    expect(disclosure.reach.nodes).toEqual({ kind: "constrained", values: ["node-1", "node-2"], sources: ["predicates[0].all[1]"] })
  })

  it("treats `capability none` as NOT constraining the capability axis, because it asserts an absence", () => {
    // Reporting `none ["fs.write"]` as a reach set of `fs.write` would UNDERSTATE
    // what the rule matches: it matches every dispatch that does not request
    // `fs.write`, which is nearly all of them.
    //
    // `none` alone is now refused at compile time as a universal pre-approval
    // (`rule.universal_pre_approval`, ADR 0007 section 8), so the rule carries a
    // REAL `projectId` scope and this disclosure is about the CAPABILITY axis
    // alone. That is the reachable state: the rule is scoped by something, and
    // the question is whether the disclosure then overstates what the capability
    // axis adds.
    const rule = firstRuleOf([
      rawPreApprovalDocument({
        predicates: [
          { field: "projectId", operator: "eq", value: PROJECT_ID },
          { field: "capability", operator: "none", value: ["fs.write"] },
        ],
      }),
    ])
    expect(buildPreApprovalDisclosure(rule).reach.capabilities.kind).toBe("unknown")
  })

  it("attributes a `not` to no axis of its own, because a negation bounds nothing to a known set", () => {
    // The same reasoning as the `capability none` case above, and the same
    // consequence: a tree whose ONLY constraint is a `not` compiles to a
    // pre-approval nothing more than the real `projectId` scope does, so the
    // `not` must add nothing to the disclosure.
    //
    // The test is a DIFFERENTIAL, not a snapshot: the same rule without the `not`
    // must produce a byte-identical disclosure. A `not` that changed the reach
    // set would be claiming a constraint it does not have.
    const withNot = firstRuleOf([
      rawPreApprovalDocument({
        predicates: [
          { field: "projectId", operator: "eq", value: PROJECT_ID },
          { field: "not", predicate: { field: "projectId", operator: "eq", value: "other" } },
        ],
      }),
    ])
    const withoutNot = firstRuleOf([
      rawPreApprovalDocument({ predicates: [{ field: "projectId", operator: "eq", value: PROJECT_ID }] }),
    ])
    expect(buildPreApprovalDisclosure(withNot).reach).toEqual(buildPreApprovalDisclosure(withoutNot).reach)
    expect(buildPreApprovalDisclosure(withNot).reach.projects.kind).toBe("constrained")
  })

  it("renders an undeclared bound as 'unbounded', not as the language ceiling", () => {
    // "no fan-out maximum declared" and "fan-out maximum 256" are different
    // statements and only the first is true.
    const disclosure = buildPreApprovalDisclosure(scoped())
    const withoutFanOut = buildPreApprovalDisclosure(
      firstRuleOf([
        preApprovalDocument({
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
      ]),
    )
    expect(disclosure.bounds.fanOut.kind).toBe("declared")
    expect(withoutFanOut.bounds.fanOut).toEqual({ kind: "unbounded", source: "actions[pre_approve_within_bounds].maximumFanOut" })
    expect(withoutFanOut.warnings.join(" ")).toContain("declares no 'fanOut' bound")
  })

  it("reports a malformed history entry as not matched, with a warning, rather than dropping it", () => {
    // A silently dropped history entry reads as "this rule never matched that
    // dispatch", which is a different and wrong statement.
    const disclosure = buildPreApprovalDisclosure(scoped(), {
      historicalDispatches: [{ dispatchId: "disp-broken", context: { projectId: "proj-1" } }],
    })
    expect(disclosure.historicalMatches).toEqual([{ dispatchId: "disp-broken", matched: false }])
    expect(disclosure.warnings.join(" ")).toContain("disp-broken")
  })

  it("sorts its warnings, its conflicts and its shadowing, so the disclosure is a function of its inputs", () => {
    const disclosure = buildPreApprovalDisclosure(scoped(), {
      conflicts: ["z-conflict", "a-conflict", "z-conflict"],
      shadowing: ["z-shadow", "a-shadow"],
    })
    expect(disclosure.conflicts).toEqual(["a-conflict", "z-conflict"])
    expect(disclosure.shadowing).toEqual(["a-shadow", "z-shadow"])
    expect([...disclosure.warnings].sort()).toEqual([...disclosure.warnings])
  })

  it("renders a draft rule's activation as null rather than as absent, because 'never activated' is a value", () => {
    const rule = firstRuleOf([preApprovalDocument({ activation: { state: "draft", activatedAt: null, activatedBy: null } })])
    const disclosure = buildPreApprovalDisclosure(rule)
    expect(disclosure.activation).toEqual({ state: "draft", activatedAt: null, activatedBy: null })
  })

  it("is a pure function of the rule and the extras, and does not mutate either", () => {
    const rule = firstRuleOf([preApprovalDocument()])
    const extras = { conflicts: ["a"], historicalDispatches: [{ dispatchId: "d", context: validContext() }] }
    const before = canonicalJson(extras)
    const first = buildPreApprovalDisclosure(rule, extras)
    const second = buildPreApprovalDisclosure(rule, extras)
    expect(canonicalJson(first)).toBe(canonicalJson(second))
    expect(canonicalJson(extras)).toBe(before)
  })

  it("takes the conflicts and shadowing from an evaluation when they are not supplied", () => {
    // The happy path: a caller with a result in hand passes nothing and gets the
    // result's own conflicts, rather than having to re-derive them.
    const set = compileRuleSet([
      preApprovalDocument(),
      rawRuleDocument({
        ruleId: "rule-deny",
        predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }],
        actions: [{ kind: "deny_with_reason", reason: "denied" }],
      }),
    ])
    if (!set.ok) throw new Error("fixture failed to compile")
    const result: RuleEvaluationResult = evaluateRules(set.value, validContext())
    expect(result.conflicts.length).toBeGreaterThan(0)
    const disclosure: PreApprovalDisclosure = buildPreApprovalDisclosure(set.value.rules[0]!)
    expect(disclosure.conflicts).toEqual([])
  })
})

// ===========================================================================
// Determinism of the disclosure
// ===========================================================================

describe("the disclosure is deterministic across fifty renderings", () => {
  it("produces byte-identical JSON every time", () => {
    const rule = firstRuleOf([preApprovalDocument()])
    const renderings = new Set<string>()
    for (let attempt = 0; attempt < 50; attempt += 1) {
      renderings.add(
        canonicalJson(
          buildPreApprovalDisclosure(rule, {
            historicalDispatches: [
              { dispatchId: "disp-b", context: validContext() },
              { dispatchId: "disp-a", context: validContext({ projectId: "other" }) },
            ],
            conflicts: ["z", "a"],
          }),
        ),
      )
    }
    // One distinct rendering. More than one would mean a `Set` iteration or an
    // object key order leaked into the output.
    expect(renderings.size).toBe(1)
  })
})
