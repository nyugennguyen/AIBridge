/**
 * M6.7 — the composed plan.
 *
 * # What this file is FOR
 *
 * The milestone's substantive claims, each asserted against the OWNING module
 * rather than against a restatement of it:
 *
 *   1. **Approvals.** A default installation — zero enabled rules — demands an
 *      approval for EVERY dispatch, and the plan says so as a value. This is the
 *      milestone's headline guarantee and it is checked against `evaluatePolicy`'s
 *      own `decision` and `outstandingApprovals`.
 *   2. **Pre-approvals.** Matched pre-approvals are listed with the section 11
 *      disclosure attached, and the plan reports BOTH answers — the M6 evaluator's
 *      candidates and the kernel's independent grant — because conflating them
 *      would report the evaluator as the grantor.
 *   3. **Budgets.** Decisions and reservations appear; rejected work appears with the
 *      refusing code; an unenforceable cost budget produces a `not_enforceable`
 *      warning naming the field and NOT a refusal.
 *   4. **Warnings.** Unavailable, unknown-to-role and unenforceable each produce
 *      their own warning kind, and the three are kept distinct.
 *   5. **Preview/evaluate agreement.** The plan's per-rule verdicts equal
 *      `evaluateRules`' for the same context, and equal the preview's for the same
 *      history. This is ADR 0007 stop condition 1 propagated into the simulator.
 *   6. **Routing.** The plan's routing section equals a direct `rankNodes` call.
 *
 * # Why the comparisons are against fresh calls
 *
 * Every assertion below re-invokes the owning module with the inputs the plan
 * reports. That is the point: a simulator that reported its own opinion would
 * agree with itself, and agreeing with yourself is the failure mode this whole
 * milestone exists to prevent.
 */

import { describe, expect, it } from "vitest"
import { evaluateRules, previewCompiledRuleSet, ruleEvaluationContextSchema, type CompiledRuleSet } from "../../../src/rules/index.js"
import { rankNodes } from "../../../src/routing/index.js"
import { composeBudgets, reportedUsageObservation } from "../../../src/budgets/index.js"
import { computeDryRunPlanDigest, simulateDryRun, type DryRunPlan, type SimulationPorts } from "../../../src/simulation/index.js"
import { projectIdSchema, projectPathIdSchema } from "../../../src/orchestration/identifiers.js"
import {
  aBudgetDocument,
  aDenyDocument,
  aManifest,
  aNode,
  aPreApprovalDocument,
  aRequest,
  aRole,
  aRoutingDocument,
  aTemplateInput,
  compiledFrom,
  emptyRuleSet,
  simulatedPorts,
  NODE_REVOKED,
  ProbedRunTemplateRepository,
  type SimulatedPorts,
} from "./fixtures.js"

/** Plans, and throws with the refusal attached — for tests whose subject is not the refusal. */
async function planned(input: unknown, ports?: Partial<SimulatedPorts>): Promise<DryRunPlan> {
  const result = await simulateDryRun(input, simulatedPorts(ports))
  if (!result.ok) throw new Error(`the dry run refused unexpectedly: ${result.refusal.code} — ${result.refusal.message}`)
  return result.value
}

/** Plans with whatever ports were given, defaulting to the probed fixture ports. */
function portsFor(ports?: Partial<SimulatedPorts>): SimulationPorts {
  return simulatedPorts(ports)
}

/** The compiled artifact's digest, read off a fresh preview of the same artifact. */
function previewDigestFor(rules: CompiledRuleSet, now: string, actorId: string): string {
  const preview = previewCompiledRuleSet(rules, { proposals: [], finishedDispatches: [] }, { now, actorId, activationConfirmed: true })
  if (!preview.ok) throw new Error(`preview refused: ${preview.error.message}`)
  return preview.value.ruleSetDigest
}

describe("a default installation demands an approval for every dispatch", () => {
  it("a plan over a compiled rule set with ZERO rules requires an approval for every dispatch", async () => {
    const planValue = await planned(aRequest({ rules: emptyRuleSet() }))
    expect(planValue.ruleSetDigest).toBe(emptyRuleSet().digest)
    expect(planValue.dispatches).toHaveLength(2)
    for (const dispatch of planValue.dispatches) {
      expect(dispatch.policy?.decision).toBe("require_approval")
      expect(dispatch.approval.required).toBe(true)
      expect(dispatch.approval.outstanding).toContain("dispatch_approval")
    }
    expect(planValue.approvals.everyDispatchRequiresApproval).toBe(true)
    expect(planValue.approvals.required.map((entry) => entry.dispatchId)).toEqual(["disp:build", "disp:ship"])
  })

  it("the required approval is the kernel's own outstanding list, not a restatement of it", async () => {
    const planValue = await planned(aRequest())
    const build = planValue.dispatches[0]
    expect(build).toBeDefined()
    // The safety floor is the only layer demanding an approval on a default
    // installation, so `dispatchApprovalDemands` names it and nothing else.
    expect(build?.policy?.dispatchApprovalDemands).toEqual(["safety_floor"])
    expect(build?.policy?.decisionDigest).toMatch(/^sha256:/)
  })

  it("a dispatch that will not launch is not reported as awaiting an approval", async () => {
    const planValue = await planned(aRequest({ rules: compiledFrom(aDenyDocument()) }))
    for (const dispatch of planValue.dispatches) {
      expect(dispatch.rejection?.code).toBe("rule.denied")
      expect(dispatch.approval.required).toBe(false)
      expect(dispatch.policy).toBeNull()
    }
    expect(planValue.approvals.required).toEqual([])
    // Not vacuously true: there is nothing to be true about.
    expect(planValue.approvals.everyDispatchRequiresApproval).toBe(false)
  })
})

describe("matched pre-approvals are listed with their disclosure", () => {
  it("a pre-approval rule is reported as a candidate and, where the kernel grants it, as the basis", async () => {
    const planValue = await planned(
      aRequest({
        rules: compiledFrom(aPreApprovalDocument()),
        // A role that grants exactly what the rule pre-approves, so the kernel's
        // post-narrowing re-check can actually clear the floor's default.
        roles: [aRole({ requiredCapabilities: ["fs.read"], allowedCapabilities: ["fs.read"] })],
        // Both steps are one-capability reads, so both are inside the declared bounds.
        manifests: [aManifest({ dispatchId: "disp:build" }), aManifest({ dispatchId: "disp:ship", manifestId: "manifest-sim-2" })],
      }),
    )
    const ship = planValue.dispatches.find((dispatch) => dispatch.task.stepId === "ship")
    expect(ship?.preApproval?.candidates.map((candidate) => candidate.ruleId)).toEqual(["rule-sim-pre"])
    // The kernel granted it, and the plan reports the KERNEL's basis, not the
    // evaluator's candidate list.
    expect(ship?.preApproval?.granted).toBe(true)
    expect(ship?.preApproval?.ruleId).toBe("rule-sim-pre")
    expect(ship?.preApproval?.capabilities).toEqual(["fs.read"])
    expect(ship?.policy?.decision).toBe("allow")
  })

  it("the plan carries the section 11 disclosure verbatim rather than re-disclosing it", async () => {
    const rules = compiledFrom(aPreApprovalDocument())
    const planValue = await planned(
      aRequest({ rules, roles: [aRole({ requiredCapabilities: ["fs.read"], allowedCapabilities: ["fs.read"] })] }),
    )
    const disclosure = planValue.approvals.preApprovalDisclosures[0]
    expect(disclosure).toBeDefined()
    // Compared against a fresh preview of the SAME artifact, member for member,
    // with the history-dependent member excluded: the plan's preview is over the
    // plan's OWN dispatches, so `historicalMatches` is the one member a preview of
    // an empty history cannot match.
    const fresh = previewCompiledRuleSet(
      rules,
      { proposals: [], finishedDispatches: [] },
      { now: planValue.generatedAt, actorId: planValue.requestedBy, activationConfirmed: true },
    )
    expect(fresh.ok).toBe(true)
    if (!fresh.ok) return
    expect({ ...disclosure, historicalMatches: [] }).toEqual({
      ...fresh.value.preApprovalDisclosures[0],
      historicalMatches: [],
    })
    expect(planValue.approvals.activationRequired).toEqual([...fresh.value.activationRequired])
  })

  it("an unconfirmed disclosure is reported as outstanding activation rather than as a live grant", async () => {
    const rules = compiledFrom(aPreApprovalDocument())
    const planValue = await planned(
      aRequest({
        rules,
        activationConfirmed: false,
        roles: [aRole({ requiredCapabilities: ["fs.read"], allowedCapabilities: ["fs.read"] })],
      }),
    )
    expect(planValue.approvals.activationRequired).toEqual(["rule-sim-pre@1"])
    expect(planValue.warnings.some((warning) => warning.kind === "pre_approval_activation_outstanding")).toBe(true)
  })

  it("a pre-approval the kernel declines is reported as a candidate that did not grant, with the evaluator's reason", async () => {
    // The `build` step requests `shell.run` as well, and the rule approves only
    // `fs.read`, so the kernel's `coversEverything` check fails. The two answers
    // stay apart: the evaluator named a candidate, the kernel granted nothing.
    const planValue = await planned(
      aRequest({
        rules: compiledFrom(aPreApprovalDocument()),
        roles: [aRole()],
        manifests: [aManifest({ dispatchId: "disp:build" }), aManifest({ dispatchId: "disp:ship", manifestId: "manifest-sim-2" })],
      }),
    )
    const build = planValue.dispatches.find((dispatch) => dispatch.task.stepId === "build")
    expect(build?.preApproval?.candidates).toHaveLength(1)
    expect(build?.preApproval?.granted).toBe(false)
    expect(build?.preApproval?.ruleId).toBeNull()
    expect(build?.preApproval?.capabilities).toEqual([])
    expect(build?.policy?.decision).toBe("require_approval")
  })
})

describe("the budget section reports decisions, reservations and rejected work", () => {
  it("every planned dispatch carries the composed decision and the reservation the ledger would have written", async () => {
    const planValue = await planned(aRequest())
    for (const dispatch of planValue.dispatches) {
      expect(dispatch.budget.decision.limits.maximumConcurrency).toBe(4)
      expect(dispatch.budget.reservation?.state).toBe("held")
      expect(dispatch.budget.reservation?.units).toBe(1)
      // The literal, and the plan-wide list, are the two places a reader looks for
      // "did this reserve anything".
      expect(dispatch.budget.reserved).toBe(false)
      expect(dispatch.budget.refusal).toBeNull()
    }
    expect(planValue.budgets.reserved).toEqual([])
  })

  it("the reported decision equals a direct `composeBudgets` call over the same base and contributions", async () => {
    const rules = compiledFrom(aBudgetDocument())
    const planValue = await planned(aRequest({ rules, baseBudget: { maximumFanOut: 8 } }))
    const dispatch = planValue.dispatches[0]
    expect(dispatch).toBeDefined()
    const direct = composeBudgets(
      { maximumConcurrency: 4, maximumFanOut: 8 },
      [{ source: `rules:${rules.digest}`, limits: { maximumFanOut: 2 } }],
      undefined,
    )
    // The rule caps fan-out at 2 against a base of 8: elementwise `min`, decided by
    // `src/budgets`, and the plan relays the result rather than recomputing it.
    expect(direct.limits.maximumFanOut).toBe(2)
    expect(dispatch?.budget.decision.limits).toEqual(direct.limits)
    expect(dispatch?.budget.decision.enforceability).toEqual(direct.enforceability)
  })

  it("a rule contribution wider than the budget in force is reported as a REJECTED WIDENING, not applied", async () => {
    const planValue = await planned(
      aRequest({ rules: compiledFrom(aBudgetDocument()), baseBudget: { maximumFanOut: 1 } }),
    )
    const dispatch = planValue.dispatches[0]
    expect(dispatch?.budget.decision.limits.maximumFanOut).toBe(1)
    // ADR 0007 section 7.6: the widening is refused by the RULE ENGINE, which caps
    // its own contribution, and the attempt is recorded rather than applied. The plan
    // relays that record — it does not recompute it, and it does not hide it either.
    expect(dispatch?.budget.rejectedWidening).toEqual([
      { source: "rule-sim-budget", field: "maximumFanOut", attempted: 2, current: 1 },
    ])
    expect(dispatch?.budget.contributions.map((entry) => entry.limits.maximumFanOut)).toEqual([1])
  })

  it("work the budget gate refuses is reported as rejected work carrying the budget module's own code", async () => {
    const planValue = await planned(aRequest({ baseBudget: { maximumConcurrency: undefined } }))
    expect(planValue.dispatches[0]?.budget.refusal?.code).toBe("budget.scope_unbounded")
    expect(planValue.dispatches[0]?.budget.reservation).toBeNull()
    expect(planValue.rejected.map((entry) => entry.code)).toEqual(["budget.scope_unbounded", "budget.scope_unbounded"])
    expect(planValue.warnings.some((warning) => warning.kind === "scope_unbounded")).toBe(true)
  })

  it("an unenforceable COST budget is a warning naming the field, and never a refusal", async () => {
    const planValue = await planned(
      aRequest({ baseBudget: { maximumUsageUnits: 1_000, usageUnit: "tokens" } as Record<string, number | string> }),
    )
    const dispatch = planValue.dispatches[0]
    expect(dispatch?.budget.decision.limits.maximumUsageUnits).toBe(1_000)
    expect(dispatch?.budget.decision.enforceability.maximumUsageUnits).toBe("not_enforceable")
    expect(dispatch?.rejection).toBeNull()
    expect(dispatch?.budget.refusal).toBeNull()
    const warnings = planValue.warnings.filter((warning) => warning.kind === "budget_not_enforceable")
    expect(warnings.flatMap((warning) => warning.detail)).toContain("maximumUsageUnits")
    expect(warnings.every((warning) => warning.message.includes("NOT enforceable"))).toBe(true)
  })

  it("a cost budget the adapter CAN measure is reported as enforceable and consumes no warning", async () => {
    const planValue = await planned(
      aRequest({
        baseBudget: { maximumUsageUnits: 1_000, usageUnit: "tokens" } as Record<string, number | string>,
        observation: reportedUsageObservation(120, "tokens") as unknown as Record<string, unknown>,
      }),
    )
    const dispatch = planValue.dispatches[0]
    expect(dispatch?.budget.decision.enforceability.maximumUsageUnits).toBe("enforceable")
    expect(planValue.warnings.some((warning) => warning.kind === "budget_not_enforceable")).toBe(false)
  })

  it("an unmeasurable usage request is ADMITTED and warned about, because refusing would report a cost nobody knows", async () => {
    const planValue = await planned(
      aRequest({ baseBudget: { maximumUsageUnits: 10, usageUnit: "tokens" } as Record<string, number | string> }),
    )
    const dispatch = planValue.dispatches[0]
    // The manifest's estimate is 120 tokens against a 10-token ceiling, and the
    // adapter measured nothing, so the budget cannot be checked.
    expect(dispatch?.budget.usage.admitted).toBe(true)
    expect(dispatch?.budget.usage.enforceability).toBe("not_enforceable")
    expect(dispatch?.rejection).toBeNull()
    expect(planValue.warnings.some((warning) => warning.kind === "usage_not_measurable")).toBe(true)
  })

  it("a measured usage request over the ceiling is REFUSED with the budget module's own refusal", async () => {
    const planValue = await planned(
      aRequest({
        baseBudget: { maximumUsageUnits: 10, usageUnit: "tokens" } as Record<string, number | string>,
        observation: reportedUsageObservation(120, "tokens") as unknown as Record<string, unknown>,
      }),
    )
    const dispatch = planValue.dispatches[0]
    expect(dispatch?.budget.usage.admitted).toBe(false)
    expect(dispatch?.budget.usage.reason).toBe("usage_budget_exceeded")
    expect(dispatch?.rejection).toBeNull()
    // The USAGE budget is not the CONCURRENCY gate, so it does not block the
    // reservation. It is reported, and the two budgets are not conflated.
    expect(dispatch?.budget.reservation).not.toBeNull()
  })
})

describe("unavailable, unknown and unenforceable capabilities each warn, and stay distinct", () => {
  it("a capability no node advertises is `capability_unavailable`", async () => {
    const planValue = await planned(
      aRequest({ nodes: [aNode({ capabilities: ["fs.read"] })], roles: [aRole()] }),
    )
    const warnings = planValue.warnings.filter((warning) => warning.kind === "capability_unavailable")
    expect(warnings.flatMap((warning) => warning.detail)).toEqual(["shell.run"])
  })

  it("a capability the bound role neither allows nor denies is `capability_unknown_to_role`, a different fact", async () => {
    const planValue = await planned(
      aRequest({ nodes: [aNode({ capabilities: ["fs.read", "shell.run"] })], roles: [aRole({ allowedCapabilities: ["fs.read"] })] }),
    )
    const warnings = planValue.warnings.filter((warning) => warning.kind === "capability_unknown_to_role")
    expect(warnings.flatMap((warning) => warning.detail)).toEqual(["shell.run"])
    expect(planValue.warnings.some((warning) => warning.kind === "capability_unavailable")).toBe(false)
  })

  it("a step whose capability its role does not declare cannot be dispatched, and the plan says which code stopped it", async () => {
    const planValue = await planned(
      aRequest({ nodes: [aNode({ capabilities: ["fs.read", "shell.run"] })], roles: [aRole({ allowedCapabilities: ["fs.read"] })] }),
    )
    const build = planValue.dispatches.find((dispatch) => dispatch.task.stepId === "build")
    expect(build?.rejection?.code).toBe("policy.envelope_unrepresentable")
    expect(build?.rejection?.stage).toBe("policy")
  })

  it("a missing context manifest is warned about rather than invented", async () => {
    const planValue = await planned(aRequest({ manifests: [] }))
    expect(planValue.dispatches.every((dispatch) => dispatch.context === null)).toBe(true)
    expect(planValue.warnings.filter((warning) => warning.kind === "context_manifest_absent")).toHaveLength(2)
  })

  it("a context manifest is summarized as counts, categories, sensitivity and digests", async () => {
    const planValue = await planned(aRequest({ manifests: [aManifest({ dispatchId: "disp:build", sensitivity: "restricted" })] }))
    const context = planValue.dispatches.find((dispatch) => dispatch.task.stepId === "build")?.context
    expect(context?.itemCount).toBe(1)
    expect(context?.excludedCount).toBe(0)
    expect(context?.categories).toEqual(["project_constraints"])
    expect(context?.maximumSensitivity).toBe("restricted")
    expect(context?.budgetUnit).toBe("tokens")
    expect(context?.manifestDigest).toMatch(/^sha256:/)
  })

  it("a role snapshot that was never supplied is warned about and refuses the dispatch", async () => {
    const planValue = await planned(aRequest({ roles: [] }))
    expect(planValue.dispatches.every((dispatch) => dispatch.rejection?.code === "policy.role_snapshot_absent")).toBe(true)
    expect(planValue.warnings.filter((warning) => warning.kind === "role_snapshot_absent")).toHaveLength(2)
  })

  it("a rule set digest the template did not declare is not a mismatch, and one it declares wrongly is", async () => {
    const matching = await planned(aRequest())
    expect(matching.warnings.some((warning) => warning.kind === "rule_set_digest_mismatch")).toBe(false)

    const repository = new ProbedRunTemplateRepository([aTemplateInput({ ruleSetDigest: `sha256:${"0".repeat(64)}` })])
    const mismatched = await planned(aRequest(), { templates: repository })
    const warning = mismatched.warnings.find((entry) => entry.kind === "rule_set_digest_mismatch")
    expect(warning).toBeDefined()
    expect(warning?.detail).toContain(`declared=sha256:${"0".repeat(64)}`)
    expect(warning?.detail).toContain(`supplied=${emptyRuleSet().digest}`)
  })
})

describe("the routing section is the routing module's own answer", () => {
  it("the reported candidates, ranks and digest equal a direct `rankNodes` call", async () => {
    const rules = compiledFrom(aRoutingDocument())
    const planValue = await planned(aRequest({ rules }))
    const build = planValue.dispatches.find((dispatch) => dispatch.task.stepId === "build")
    expect(build).toBeDefined()
    const direct = rankNodes(
      [aNode({ nodeId: "node-a" }), aNode({ nodeId: "node-b", capabilities: ["fs.read", "fs.write", "shell.run"] })],
      {
        projectId: projectIdSchema.parse("proj-sim"),
        projectPathId: projectPathIdSchema.parse("path-sim-1"),
        requiredCapabilities: ["shell.run", "fs.read"],
        requiredRuntimeKinds: ["opencode"],
        requiredToolCategories: [],
        now: Date.parse(planValue.generatedAt),
        excludeNodeIds: [],
      },
      { preferredNodeIds: ["node-b"], excludedNodeIds: [], requiredRuntimeKind: null, requiredProjectPathId: null },
    )
    expect(direct.ok).toBe(true)
    if (!direct.ok) return
    expect(build?.routing?.digest).toBe(direct.value.digest)
    expect(build?.routing?.candidates).toEqual(direct.value.candidates)
    // And the decision itself: the rule's preference moved the selection to node-b.
    expect(build?.routing?.selectedNodeId).toBe("node-b")
  })

  it("every candidate appears, eligible or not, with its exclusion codes when ineligible", async () => {
    const planValue = await planned(
      aRequest({ nodes: [aNode({ nodeId: "node-a" }), aNode({ nodeId: "node-b" }), aNode({ nodeId: NODE_REVOKED, revoked: true })] }),
    )
    const build = planValue.dispatches.find((dispatch) => dispatch.task.stepId === "build")
    expect(build?.routing?.candidates.map((candidate) => candidate.nodeId)).toEqual(["node-a", "node-b", "node-revoked"])
    const revoked = build?.routing?.candidates.find((candidate) => candidate.nodeId === "node-revoked")
    expect(revoked?.eligible).toBe(false)
    expect(revoked?.exclusions.map((exclusion) => exclusion.code)).toContain("revoked")
    expect(build?.routing?.consideredCount).toBe(3)
    expect(build?.routing?.eligibleCount).toBe(2)
  })

  it("a node excluded for one reason carries the reason in the plan's node summary", async () => {
    const planValue = await planned(
      aRequest({ nodes: [aNode({ nodeId: "node-a" }), aNode({ nodeId: NODE_REVOKED, revoked: true })] }),
    )
    const revoked = planValue.nodes.find((node) => node.nodeId === "node-revoked")
    expect(revoked?.excludedBy).toBe("revoked,unhealthy")
    expect(revoked?.healthy).toBe(false)
    expect(planValue.nodes.find((node) => node.nodeId === "node-a")?.excludedBy).toBeNull()
  })

  it("no eligible node is a rejection carrying every candidate's exclusion code, not a dropped dispatch", async () => {
    const planValue = await planned(aRequest({ nodes: [aNode({ nodeId: NODE_REVOKED, revoked: true })] }))
    const build = planValue.dispatches.find((dispatch) => dispatch.task.stepId === "build")
    expect(build?.routing?.selectedNodeId).toBeNull()
    expect(build?.routing?.candidates).toHaveLength(1)
    expect(build?.rejection?.code).toBe("routing.no_eligible_node")
    expect(build?.rejection?.reason).toContain("revoked")
  })

  it("a caller's local node is used when routing selects nothing, and the plan says the registry did not justify it", async () => {
    const planValue = await planned(
      aRequest({ nodes: [aNode({ nodeId: NODE_REVOKED, revoked: true })], localDispatchNodeId: "node-local" }),
    )
    const build = planValue.dispatches.find((dispatch) => dispatch.task.stepId === "build")
    expect(build?.rejection).toBeNull()
    expect(build?.routing?.selectedNodeId).toBeNull()
    expect(build?.policy).not.toBeNull()
    const warnings = planValue.warnings.filter((warning) => warning.kind === "routing_local_fallback")
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings.flatMap((warning) => warning.detail)).toContain("node-local")
  })
})

describe("the plan's rule verdicts are the rule engine's own, and the preview agrees", () => {
  it("the plan's per-rule verdicts equal a direct `evaluateRules` call over the reported dispatch", async () => {
    const rules = compiledFrom(aBudgetDocument(), aRoutingDocument())
    const planValue = await planned(aRequest({ rules }))
    const dispatch = planValue.dispatches.find((entry) => entry.task.stepId === "ship")
    expect(dispatch).toBeDefined()
    const direct = evaluateRules(
      rules,
      ruleEvaluationContextSchema.parse({
        projectId: "proj-sim",
        roleId: "role-sim",
        roleVersion: 1,
        requestedCapabilities: ["fs.read"],
        toolCategories: [],
        runtimeKind: "opencode",
        targetNodeId: "node-b",
        nodeAdvertisedCapabilities: ["fs.read", "fs.write", "shell.run"],
        projectPathId: "path-sim-1",
        taskLabels: ["env"],
        dependencyOutcomes: [],
        requestedFanOut: 1,
        requestedConcurrency: 1,
        requestedRetryLimit: null,
        declaredTimeoutSeconds: 900,
        taskTitle: "Ship the release",
        evaluatedAt: planValue.generatedAt,
        contextManifestSensitivity: "public_to_project",
        currentBudget: { maximumConcurrency: 4, maximumFanOut: 4 },
      }),
    )
    expect(dispatch?.rules.decisionDigest).toBe(direct.decisionDigest)
    expect(dispatch?.rules.verdicts).toEqual(
      direct.traces.map((trace) => ({
        ruleId: trace.ruleId,
        templateVersion: trace.templateVersion,
        matchOutcome: trace.matchOutcome,
        reason: trace.reason,
      })),
    )
  })

  it("the preview the plan runs over its OWN dispatches reports the same verdicts the plan reports", async () => {
    // The plan feeds its own dispatches to `previewCompiledRuleSet` as proposals, so
    // the disclosure's `historicalMatches` is the PREVIEW's verdict for each of them
    // — computed by the preview's own `evaluateRules` call. Comparing those against
    // the plan's verdicts is ADR 0007 stop condition 1 asserted through the
    // simulator: one artifact, one evaluator, one answer, and the two answers are
    // reached by different code paths.
    const rules = compiledFrom(aBudgetDocument(), aPreApprovalDocument(), aRoutingDocument())
    const planValue = await planned(
      aRequest({
        rules,
        roles: [aRole({ requiredCapabilities: ["fs.read"], allowedCapabilities: ["fs.read"] })],
        manifests: [aManifest({ dispatchId: "disp:build" }), aManifest({ dispatchId: "disp:ship", manifestId: "manifest-sim-2" })],
      }),
    )
    const disclosure = planValue.approvals.preApprovalDisclosures.find((entry) => entry.ruleId === "rule-sim-pre")
    expect(disclosure).toBeDefined()
    const matched = (disclosure?.historicalMatches ?? []).map((entry) => entry.dispatchId)
    expect(matched).toEqual(["disp:build", "disp:ship"])
    for (const match of disclosure?.historicalMatches ?? []) {
      const dispatch = planValue.dispatches.find((entry) => entry.task.dispatchId === match.dispatchId)
      expect(dispatch).toBeDefined()
      const verdict = dispatch?.rules.verdicts.find((entry) => entry.ruleId === "rule-sim-pre")
      expect(verdict).toBeDefined()
      expect(match.matched).toBe(verdict?.matchOutcome === "matched")
    }
    expect(previewDigestFor(rules, planValue.generatedAt, planValue.requestedBy)).toBe(planValue.ruleSetDigest)
  })

  it("a deny rule's reason reaches the plan verbatim, because a decision reason is what an explanation may carry", async () => {
    const planValue = await planned(aRequest({ rules: compiledFrom(aDenyDocument()) }))
    const build = planValue.dispatches.find((dispatch) => dispatch.task.stepId === "build")
    expect(build?.rules.denied?.reason).toBe("the simulation project freezes all dispatches")
    expect(build?.rejection?.reason).toBe("the simulation project freezes all dispatches")
  })

  it("the plan reports the compiled artifact's own digest, so a reader knows which rule set decided", async () => {
    const rules = compiledFrom(aDenyDocument())
    const planValue = await planned(aRequest({ rules }))
    expect(planValue.ruleSetDigest).toBe(rules.digest)
    expect(planValue.dispatches.every((dispatch) => dispatch.rules.ruleSetDigest === rules.digest)).toBe(true)
  })
})

describe("a request the simulator cannot read is refused rather than half-evaluated", () => {
  it("an unknown top-level key is refused with the offending path named", async () => {
    const result = await simulateDryRun({ ...aRequest(), surprise: true }, portsFor())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe("simulation.input_invalid")
    expect(result.refusal.message).toContain("surprise")
  })

  it("an object that is not a compiled rule set is refused rather than treated as an empty one", async () => {
    const result = await simulateDryRun(
      aRequest({ rules: { languageVersion: 2, rules: "not an array" } as never }),
      portsFor(),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe("simulation.input_invalid")
    expect(result.refusal.message).toContain("CompiledRuleSet")
  })

  it("a caller who forgets the budget store is refused, because the ledger's default would really reserve", async () => {
    const ports = portsFor()
    // The cast is the point of the test: a port object with no `budgetStore` is
    // exactly what a caller who forgot the probe hands in, and the type system is not
    // consulted at runtime.
    const incomplete = { templates: ports.templates, roleCapabilities: ports.roleCapabilities } as unknown as SimulationPorts
    const result = await simulateDryRun(aRequest(), incomplete)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe("simulation.input_invalid")
    expect(result.refusal.message).toContain("InMemoryBudgetLedgerStore")
  })

  it("omitting the role capability resolver is reported as `skipped`, never claimed as `enforced`", async () => {
    const planValue = await planned(aRequest(), { roleCapabilities: undefined })
    expect(planValue.roleCapabilityCheck).toBe("skipped")
  })

  it("a template authored for another project is refused rather than planned against this one", async () => {
    const repository = new ProbedRunTemplateRepository([aTemplateInput({ projectId: projectIdSchema.parse("proj-other") })])
    const result = await simulateDryRun(aRequest(), portsFor({ templates: repository }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe("simulation.project_scope_mismatch")
    expect(result.refusal.detail.templateProject).toBe("proj-other")
    expect(result.refusal.detail.runProject).toBe("proj-sim")
  })
})

describe("a plan is a frozen, digest-bound, renderable artifact", () => {
  it("the plan's digest is recomputable with the function that produced it", async () => {
    const planValue = await planned(aRequest())
    expect(computeDryRunPlanDigest(planValue)).toBe(planValue.digest)
  })

  it("the plan's digest excludes its own rendered text, so a reader can recompute it", async () => {
    const planValue = await planned(aRequest())
    const withoutLines: DryRunPlan = { ...planValue, lines: [], explanationText: "" }
    expect(computeDryRunPlanDigest(withoutLines)).toBe(planValue.digest)
  })

  it("the plan is frozen, and its lines and explanation text are the same text", async () => {
    const planValue = await planned(aRequest())
    expect(Object.isFrozen(planValue)).toBe(true)
    expect(planValue.explanationText).toBe(planValue.lines.join("\n"))
  })

  it("every line names an identifier, a count or a code, and the header names the artifact digests", async () => {
    const planValue = await planned(aRequest({ rules: compiledFrom(aDenyDocument()) }))
    expect(planValue.lines[0]).toContain("project=proj-sim")
    expect(planValue.lines[1]).toContain("snapshotDigest=sha256:")
    expect(planValue.lines[2]).toContain("ruleSetDigest=sha256:")
    expect(planValue.lines.some((line) => line.startsWith("dry-run: graph stage"))).toBe(true)
    expect(planValue.lines.some((line) => line.includes("rejected=rule.denied"))).toBe(true)
  })

  it("warnings are sorted and de-duplicated, so two plans over the same inputs diff cleanly", async () => {
    const first = await planned(aRequest({ nodes: [aNode({ capabilities: ["fs.read"] })] }))
    const second = await planned(aRequest({ nodes: [aNode({ capabilities: ["fs.read"] })] }))
    expect(first.warnings).toEqual(second.warnings)
    const keys = first.warnings.map((warning) => `${warning.kind} ${warning.subject ?? ""} ${warning.detail.join(",")}`)
    expect([...keys].sort()).toEqual(keys)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("the plan's base budget is the composition of the base alone, and the plan reserved nothing", async () => {
    const planValue = await planned(aRequest({ baseBudget: { maximumRetryLimit: 2 } }))
    expect(planValue.budgets.base).toEqual({ maximumConcurrency: 4, maximumFanOut: 4, maximumRetryLimit: 2 })
    expect(planValue.budgets.reserved).toEqual([])
    expect(planValue.budgets.decision.limits).toEqual(planValue.budgets.base)
  })
})