/**
 * M6.7 GATE — the dry run, against the real planners it composes.
 *
 * ================================ WHAT THIS FILE IS FOR ================================
 *
 * ADR 0007 section 16 makes a claim about a COMPOSITION: "the simulator is composed
 * of the same pure planners and evaluators as production, with every command sink
 * replaced by a fail-closed fake whose only implementation throws." Both halves are
 * checkable and neither is checkable by reading the source:
 *
 *   - the COMPOSITION half is checked by asking each owning module the same question
 *     the plan claims to have asked it, and comparing digests. A plan that re-derived
 *     a routing answer, a policy decision or a rule verdict would produce a different
 *     digest, because `rankNodes`, `evaluatePolicy` and `evaluateRules` all digest
 *     their own stable members;
 *   - the SINK half is checked by counting calls AT the sinks. `readSinkCounters`
 *     counts the boundary, and the five throwing sinks are exercised directly to
 *     prove they are throwers rather than no-ops — a sink that quietly returned would
 *     leave every counter at zero and the claim would be unfalsifiable.
 *
 * ## Completion criteria this file carries
 *
 *   - "Dry run produces no persistent or external side effect." Tests 1-3.
 *   - "Preview and runtime use the identical compiled rule representation," read here as
 *     "the dry run's verdicts are `evaluateRules`' verdicts." Test 4.
 *   - "Routing is deterministic for the same registry snapshot." Test 6.
 *   - The plan's guardrail: "Do not claim provider cost enforcement when usage data is
 *     missing or delayed." Test 7.
 *   - "Fan-out, concurrency, retry, and wall-time budgets survive restart and replay"
 *     shares its machinery with `automation-safety.test.ts`, which asserts the
 *     ledger's half; this file asserts the simulator's half — the gate is ENTERED and
 *     nothing is RETAINED.
 *
 * ## What is deliberately NOT asserted here
 *
 * The template expander, the budget algebra and the notification bus each have their
 * own gate files. What belongs here is only the property that could be true of every
 * one of them at once and false of their sum: a plan whose side effects are zero.
 *
 * ## Discipline
 *
 * One injected clock (`FIXED_NOW`), one seeded generator (`shuffled`), no `Date.now`,
 * no `Math.random`, no filesystem, no network, no subprocess. Every identifier is
 * either a fixture literal or derived by the shipped `derivedTaskId`/`derivedDispatchId`.
 */

import { describe, expect, it } from "vitest"
import {
  SimulationSideEffectError,
  assertNoRetainedSideEffects,
  createFailClosedSinks,
  emptySinkTally,
  readSinkCounters,
  simulateDryRun,
  type SimulationResult,
} from "../../src/simulation/index.js"
import { BudgetLedger, composeBudgets, NO_BUDGET_OBSERVATION, reportedUsageObservation } from "../../src/budgets/index.js"
import { EMPTY_ROUTING_PREFERENCE, rankNodes } from "../../src/routing/index.js"
import { evaluateRules } from "../../src/rules/index.js"
import { evaluatePolicy } from "../../src/orchestration/policy/index.js"
import {
  absentManifestDigest,
  auditForCanaries,
  budgetLedger,
  canariedRequest,
  canariedTemplateInput,
  CANARIES,
  compiledFrom,
  contextManifest,
  denyDocument,
  FIXED_NOW,
  NODE_A,
  planFor,
  preApprovalDocument,
  PROJECT_ID,
  registryNode,
  reserveRequestFor,
  roleSnapshot,
  routingDocument,
  routingRequestForFirstStep,
  shuffled,
  simulationPorts,
  simulationRequest,
  simulatorEnvelope,
  simulatorRuleContext,
  templateRepository,
  twoEligibleNodes,
  NODE_B,
  NODE_UNAUTHORIZED,
  NODE_UNHEALTHY,
  budgetDocument,
} from "./m6-fixtures.js"

// ===========================================================================
// Helpers
// ===========================================================================

/** The plan for the DEFAULT INSTALLATION: two steps, zero rules, one node pair. */
async function defaultPlan() {
  return planFor(simulationRequest());
}

/** A simulation result, without throwing — for the tests that want a refusal. */
async function simulated(request: unknown, ports = simulationPorts()): Promise<SimulationResult<never>> {
  return simulateDryRun(request, ports) as Promise<SimulationResult<never>>;
}

// ===========================================================================
// 1. The sinks are real sinks
// ===========================================================================

describe("M6.7 — the command sinks are fail-closed, and a dry run reaches none of them", () => {
  it("counts zero calls at every sink, and reports no retained side effect", async () => {
    const ports = simulationPorts()
    const plan = await planFor(simulationRequest(), ports)
    const counters = readSinkCounters(ports.tally)

    // The five write sinks, each named by the shipped `SIMULATION_SINK_NAMES`-shaped
    // counter, at zero. A count of zero is a count of CALLS, so this is a statement
    // about the boundary rather than about the text of any source file.
    expect(counters.eventAppends, "the dry run appended an event").toBe(0)
    expect(counters.networkCalls, "the dry run opened a connection").toBe(0)
    expect(counters.processLaunches, "the dry run launched a process").toBe(0)
    expect(counters.filesystemWrites, "the dry run wrote a file").toBe(0)
    expect(counters.notificationsEmitted, "the dry run emitted a notification").toBe(0)
    // And the shipped helper's own verdict, so a sink added later appears here.
    expect(assertNoRetainedSideEffects(counters)).toEqual([])
    // `refusedCalls` is the counter that proves the counters above are not vacuous:
    // a sink that HAD been reached would have incremented it on the way to throwing.
    expect(counters.refusedCalls, "a sink was reached and refused").toBe(0)

    // The budget gate is the ONE sink the composition must enter (ADR 0007 section
    // 13.2 makes the ledger's answer part of what a plan must carry), so its attempt
    // count is EXPECTED to be non-zero while its retained count is zero. Both halves
    // are asserted, because "zero" alone would be true of a simulator that never
    // asked the only question that matters.
    expect(counters.budgetReservationAttempts, "the gate was never entered").toBe(plan.dispatches.length)
    expect(counters.retainedReservations).toBe(0)
    expect(ports.probe.counters.admitted).toBe(plan.dispatches.length)
    expect(ports.probe.counters.refused).toBe(0)
    expect(ports.probe.counters.retained).toBe(0)
    expect(ports.probe.counters.transitionAttempts, "a reservation was moved").toBe(0)
  })

  it("throws `SimulationSideEffectError` naming the sink, from every member of every throwing sink", () => {
    // The counter assertions in the test above are only meaningful if these sinks
    // actually throw. A sink that returned `undefined` would leave every counter at
    // zero and the whole "zero side effects" claim would be unfalsifiable — so each
    // one is CALLED here and required to throw, and the error is required to name
    // the sink and the member.
    const tally = emptySinkTally()
    const sinks = createFailClosedSinks(tally)
    const cases: readonly (readonly [string, string, () => unknown])[] = [
      ["event_log", "append", () => sinks.events.append({ type: "would-have-been-appended" })],
      ["event_log", "readSince", () => sinks.events.readSince(null)],
      ["event_log", "close", () => sinks.events.close()],
      ["network", "send", () => sinks.network.send("peer-m6", { payload: "x" })],
      ["network", "connect", () => sinks.network.connect("endpoint-m6")],
      ["network", "fetch", () => sinks.network.fetch("https://example.invalid")],
      ["process", "launch", () => sinks.process.launch("opencode", ["--flag"])],
      ["process", "spawn", () => sinks.process.spawn("opencode")],
      ["process", "terminate", () => sinks.process.terminate("pid-1")],
      ["filesystem", "writeFile", () => sinks.filesystem.writeFile("/tmp/m6", "x")],
      ["filesystem", "appendFile", () => sinks.filesystem.appendFile("/tmp/m6", "x")],
      ["filesystem", "createDirectory", () => sinks.filesystem.createDirectory("/tmp/m6")],
      ["filesystem", "unlink", () => sinks.filesystem.unlink("/tmp/m6")],
      ["notifier", "emit", () => sinks.notifier.emit({ summary: "x" })],
      ["notifier", "acknowledge", () => sinks.notifier.acknowledge("ntf-000001")],
      ["notifier", "quiet", () => sinks.notifier.quiet("run_blocked")],
    ]

    expect(cases.length, "a new sink method must be added to this sweep").toBe(16)
    for (const [sink, call, invoke] of cases) {
      let thrown: unknown = null
      try {
        invoke()
      } catch (error) {
        thrown = error
      }
      expect(thrown, `${sink}.${call} returned instead of throwing`).toBeInstanceOf(SimulationSideEffectError)
      const sideEffect = thrown as SimulationSideEffectError
      expect(sideEffect.sink, `${call} must name its sink`).toBe(sink)
      expect(sideEffect.call).toBe(call)
      expect(sideEffect.message).toContain("simulation.sink_invoked")
    }
    // Every call was refused, and refusing is the ONLY effect any of them had.
    expect(readSinkCounters(tally).refusedCalls).toBe(cases.length)
    // And the refusal did not increment a write counter either: refusing a sink is
    // not performing it, and a counter that moved on refusal would make the
    // zero-assertions above unfalsifiable in the other direction.
    expect(assertNoRetainedSideEffects(readSinkCounters(tally))).toEqual([])
  })

  it("performs no mutation on the template repository it was given", async () => {
    // `simulationPorts` supplies a `CountedTemplateRepository`, which counts at the
    // METHOD rather than by inspecting the repository afterwards. A simulator that
    // wrote a template would show up here as a create/update/clear count above zero.
    const templates = templateRepository()
    expect(templates.mutations).toEqual({ create: 0, update: 0, clear: 0 })
    const before = templates.count()

    await planFor(simulationRequest(), simulationPorts({ templates }))

    expect(templates.mutations, "the dry run mutated the template repository").toEqual({
      create: 0,
      update: 0,
      clear: 0,
    })
    expect(templates.count()).toBe(before)
  })
});

// ===========================================================================
// 2. §13.2 — after the dry run, every dispatch is still ineligible
// ===========================================================================

describe("M6.7 — every dispatch is still ineligible after a dry run, because nothing was reserved", () => {
  it("reports a reservation for every dispatch and retains none of them", async () => {
    const ports = simulationPorts()
    const plan = await planFor(simulationRequest(), ports)

    // The plan REPORTS what the ledger would have written — one reservation per
    // dispatch, in state `held`, with the ledger's own ids. That is the answer the
    // plan exists to carry.
    for (const dispatch of plan.dispatches) {
      const reservation = dispatch.budget.reservation
      expect(reservation, `${dispatch.task.dispatchId} has no reservation`).not.toBeNull()
      expect(reservation?.state, "a reported reservation is the only state that makes a dispatch eligible").toBe("held")
      expect(reservation?.dispatchId).toBe(dispatch.task.dispatchId)
      expect(reservation?.units).toBe(1)
      // The `reserved` member is a `z.literal(false)`, so it is a TYPE-level claim
      // and this assertion is a value-level one.
      expect(dispatch.budget.reserved).toBe(false)
      expect(dispatch.budget.refusal).toBeNull()
    }
    // The SET-level member is present so "a caller looking for the reservations a
    // plan took finds a list, and the list is empty" is a value rather than an
    // omission.
    expect(plan.budgets.reserved).toEqual([])

    // Now the DEFINITION, asked of a real ledger over the same store. Eligibility is
    // `reservationState(dispatchId) === "held"` and nothing else
    // (`src/budgets/ledger.ts:676`), so a ledger built over the probe answers it
    // without any further check.
    const ledger = new BudgetLedger({ store: ports.budgetStore, resolveLimits: () => plan.budgets.base })
    for (const dispatch of plan.dispatches) {
      expect(
        ledger.eligible(dispatch.task.dispatchId),
        `${dispatch.task.dispatchId} is eligible after a dry run, which means the dry run reserved capacity`,
      ).toBe(false)
      expect(ledger.reservationState(dispatch.task.dispatchId)).toBeNull()
      expect(ledger.reservationForDispatch(dispatch.task.dispatchId)).toBeNull()
    }
    // And the scope is empty, which is the reason: a capacity total of zero is the
    // only state from which `false` follows for every dispatch.
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
    expect(ledger.heldUnits(PROJECT_ID, "fan_out")).toBe(0)
    expect(ledger.list()).toEqual([])
    expect(ledger.listHeld()).toEqual([])
  })

  it("the same ledger still ADMITS a real reserve after the dry run, so the gate was not wedged", async () => {
    // The stronger half of "nothing was retained": a store that counted reservations
    // and then refused to forget them would report `eligible === false` for every
    // dispatch AND refuse every future reserve, which is an availability failure
    // wearing a dry-run's clothes. A real ledger over the probe must still decide.
    const ports = simulationPorts()
    const plan = await planFor(simulationRequest(), ports)
    const ledger = new BudgetLedger({ store: ports.budgetStore, resolveLimits: () => plan.budgets.base })
    const after = await ledger.reserve({
      reservationId: "res-after-dry-run",
      projectId: PROJECT_ID,
      runId: "run-m6-1",
      taskId: "task-after",
      dispatchId: "disp-after",
      scope: "concurrency",
      units: 1,
      now: FIXED_NOW,
    })
    // ADMITTED: the ledger's compare-and-set ran and its own decision callback said
    // yes, against a scope reporting zero held units. A wedged gate would refuse.
    expect(after.ok, "a store that cannot reserve after a dry run has wedged the budget").toBe(true)
    if (!after.ok) return
    // The reservation the ledger would have written is the shape production writes.
    expect(after.value.state).toBe("held")
    expect(after.value.dispatchId).toBe("disp-after")

    // And it is STILL NOT ELIGIBLE, which is the point stated as strongly as this
    // design allows: the probe holds no map, so `reservationForDispatch` is the
    // literal `null` and eligibility — which is DEFINED as holding a held
    // reservation — is false. Nothing a caller does through this store can make a
    // dispatch launchable, which is a stronger property than "the plan cleaned up
    // after itself" and is why the write is unrepresentable rather than undone.
    expect(ledger.eligible("disp-after")).toBe(false)
    expect(ledger.reservationState("disp-after")).toBeNull()
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
    expect(ledger.list()).toEqual([])

    // The gate was ENTERED, not skipped: the attempt counter moved even though the
    // retained count did not.
    expect(ports.probe.counters.attempts).toBe(plan.dispatches.length + 1)
    expect(ports.probe.counters.admitted).toBe(plan.dispatches.length + 1)
    expect(ports.probe.counters.retained).toBe(0)
  })
});

// ===========================================================================
// 3. The plan is ACCEPTED by the real evaluators
// ===========================================================================

describe("M6.7 — the plan carries the real `evaluateRules` and `evaluatePolicy` answers", () => {
  it("agrees with a direct `evaluatePolicy` over an envelope this file builds itself", async () => {
    const plan = await defaultPlan()
    const role = roleSnapshot()
    const manifest = contextManifest()

    for (const [index, step] of (["build", "ship"] as const).entries()) {
      const reported = plan.dispatches[index]!
      expect(reported, `the plan has no dispatch for step '${step}'`).toBeDefined()
      expect(reported.policy, `${step}: the plan reported no policy evaluation`).not.toBeNull()

      // The envelope, built HERE from the fixture values. `buildEnvelope` is private
      // in `src/simulation/plan.ts`, so this is a genuine second construction: a field
      // the simulator set wrongly produces a different envelope and therefore a
      // different `envelopeDigest`.
      const manifestDigest = step === "build" ? manifest.digest : absentManifestDigest(`disp:${step}`)
      const envelope = simulatorEnvelope(step, { role, manifestDigest, targetNodeId: NODE_A })
      const policy = evaluatePolicy({ envelope, taskTitle: step === "build" ? "Build the release" : "Ship the release" })

      expect(reported.policy?.envelopeDigest, `${step}: the envelope the plan evaluated`).toBe(policy.envelopeDigest)
      expect(reported.policy?.decisionDigest, `${step}: the kernel's own decision digest`).toBe(policy.decisionDigest)
      // And the members a reader acts on, so a plan that copied the digest but not
      // the decision would fail here. `allowed` is `false` on the default
      // installation for every dispatch, and the kernel's own `decision` carries the
      // same fact, so the expected value comes from the product rather than from the
      // plan.
      expect(reported.policy?.decision).toBe(policy.decision)
      expect(policy.decision, "the default installation reached a decision other than require_approval").toBe("require_approval")
      expect(reported.policy?.allowed).toBe(false)
      expect([...reported.policy?.allowedCapabilities ?? []].sort()).toEqual([...policy.effective.allowedCapabilities ?? []].sort())
      expect([...reported.policy?.deniedCapabilities ?? []].sort()).toEqual([...policy.effective.deniedCapabilities ?? []].sort())
      expect([...reported.policy?.outstandingApprovals ?? []]).toEqual([...policy.outstandingApprovals])
      expect(reported.policy?.maximumTimeoutSeconds).toBe(policy.effective.maximumTimeoutSeconds)
      // `dispatchApprovalDemands` lives on the EFFECTIVE STATE, not on
      // `PolicyEvaluation` itself. Reading it off the evaluation is the shape of
      // mistake that silently becomes `[...]` on both sides and compares `[]` to
      // `[]`, passing forever — so the assertion states where the value is.
      expect([...reported.policy?.dispatchApprovalDemands ?? []]).toEqual([...policy.effective.dispatchApprovalDemands])
      expect(policy.effective.dispatchApprovalDemands, "the safety floor's per-dispatch demand must be present").toContain("safety_floor")
    }
  })

  it("agrees with a direct `evaluateRules` over a context this file builds itself", async () => {
    // A rule set that MATCHES, so the comparison is not vacuous over an empty
    // verdict list: a project-scoped deny, which the plan reports as a rejection.
    const compiled = compiledFrom(denyDocument({ ruleId: "rule-m6-plan-deny" }))
    const plan = await planFor(simulationRequest({ rules: compiled }))

    for (const [index, step] of (["build", "ship"] as const).entries()) {
      const reported = plan.dispatches[index]!
      const context = simulatorRuleContext(compiled, {
        role: roleSnapshot(),
        nodeCapabilities: [...registryNode({ nodeId: NODE_A }).capabilities],
        // The `build` step is alone in stage 0 and `ship` alone in stage 1, so the
        // stage width — which the plan reports as both fan-out and concurrency — is
        // 1 for each. Read off the plan rather than assumed.
        stageWidth: reported.task.stage === 0 ? stageWidthAt(plan, 0) : stageWidthAt(plan, 1),
        manifestSensitivity: reported.context?.maximumSensitivity ?? null,
      })
      const direct = evaluateRules(compiled, context)

      expect(reported.rules.decisionDigest, `${step}: evaluateRules' own decision digest`).toBe(direct.decisionDigest)
      expect(reported.rules.ruleSetDigest, "the plan names the compiled set it decided from").toBe(compiled.digest)
      expect(reported.rules.verdicts.map((verdict) => [verdict.ruleId, verdict.matchOutcome, verdict.reason])).toEqual(
        direct.traces.map((trace) => [trace.ruleId, trace.matchOutcome, trace.reason]),
      )
      // And the composition, which is what a plan reader acts on: a matched deny
      // blocks the dispatch at the `rules` stage.
      expect(reported.rules.denied?.ruleIds).toEqual([...(direct.deny?.ruleIds ?? [])])
      expect(reported.rejection?.stage).toBe("rules")
      expect(reported.rejection?.code).toBe("rule.denied")
      void context
    }
  })
});

/** How many planned tasks share a stage. Read off the plan, not assumed. */
function stageWidthAt(plan: { readonly dispatches: readonly { readonly task: { readonly stage: number } }[] }, stage: number): number {
  return plan.dispatches.filter((dispatch) => dispatch.task.stage === stage).length;
}

// ===========================================================================
// 4. The plan carries what section 16 requires
// ===========================================================================

describe("M6.7 — the plan reports expansion, routing, budgets, approvals and warnings", () => {
  it("reports the expanded task graph, the selected targets, the effective roles, the required approvals and the budget decisions", async () => {
    const plan = await defaultPlan()

    // --- expanded tasks and dependency graph (section 16, first item) ---
    expect(plan.expansion.templateId).toBe("tmpl_m6")
    expect(plan.expansion.tasks.map((task) => task.stepId)).toEqual(["build", "ship"])
    // The ids are DERIVED from the step ids, which is what makes the plan's ids
    // correlatable with a real run's without claiming to be the real run's.
    expect(plan.expansion.tasks.map((task) => task.dispatchId)).toEqual(["disp:build", "disp:ship"])
    expect(plan.expansion.graph.order).toEqual(["build", "ship"])
    expect(plan.expansion.graph.stages).toEqual([["build"], ["ship"]])
    expect(plan.expansion.graph.edges).toEqual([{ from: "build", to: "ship" }])
    expect(plan.expansion.graph.cycleDetected).toBe(false)
    expect(plan.expansion.snapshotDigest).toMatch(/^sha256:/)
    // Label KEYS, never values: the bound parameter value is content.
    expect(plan.expansion.tasks.map((task) => task.labelKeys)).toEqual([["env"], ["env"]])
    expect(plan.expansion.tasks[0]?.dependsOn).toEqual([])
    expect(plan.expansion.tasks[1]?.dependsOn).toEqual(["build"])

    // --- candidate and selected targets with reasons (second item) ---
    for (const dispatch of plan.dispatches) {
      const routing = dispatch.routing
      expect(routing, `${dispatch.task.dispatchId} reported no routing`).not.toBeNull()
      // EVERY node in the snapshot appears, eligible or not, with its exclusions.
      expect(routing?.candidates.map((candidate) => candidate.nodeId).sort()).toEqual(
        twoEligibleNodes().map((node) => node.nodeId).sort(),
      )
      expect(routing?.eligibleCount).toBe(2)
      expect(routing?.excludedCount).toBe(0)
      expect(routing?.consideredCount).toBe(2)
      // Lowest `nodeId` by code unit, because nothing else separated the two.
      expect(routing?.selectedNodeId).toBe(NODE_A)
      expect(routing?.tieBreakApplied).toBe(true)
      expect(routing?.preferenceApplied).toBe(false)
      expect(routing?.digest).toMatch(/^sha256:/)
    }
    // And the set-level node summary, which names the health of each node and NO
    // display name (the one free-text field on a snapshot).
    expect(plan.nodes.map((node) => node.nodeId)).toEqual([NODE_A, NODE_B].sort())
    for (const node of plan.nodes) {
      expect(node.healthy).toBe(true)
      expect(node.healthReason).toBe("liveness_live")
      expect(node.excludedBy).toBeNull()
    }
    expect(plan.explanationText).not.toContain("fixture node")

    // --- effective role summaries (third item) ---
    expect(plan.roles).toHaveLength(1)
    expect(plan.roles[0]?.roleId).toBe("role-m6")
    expect(plan.roles[0]?.allowedCapabilities).toEqual(["fs.read", "fs.write", "shell.run"])
    expect(plan.roles[0]?.deniedCapabilities).toEqual([])

    // --- effective context manifest summaries (fourth item) ---
    // Bound to `disp:build` by the fixture, and ABSENT for `disp:ship` — which is
    // reported rather than invented.
    expect(plan.dispatches[0]?.context?.manifestId).toBe("manifest-m6-1")
    expect(plan.dispatches[0]?.context?.itemCount).toBe(1)
    expect(plan.dispatches[0]?.context?.categories).toEqual(["project_constraints"])
    expect(plan.dispatches[0]?.context?.budgetUnit).toBe("tokens")
    expect(plan.dispatches[1]?.context).toBeNull()
    expect(plan.warnings.some((warning) => warning.kind === "context_manifest_absent" && warning.subject === "disp:ship")).toBe(true)

    // --- required approvals (fifth item) ---
    expect(plan.approvals.required.map((entry) => entry.dispatchId)).toEqual(["disp:build", "disp:ship"])
    for (const entry of plan.approvals.required) {
      expect(entry.required).toBe(true)
      expect(entry.outstanding).toEqual(["dispatch_approval"])
    }
    expect(plan.approvals.everyDispatchRequiresApproval).toBe(true)
    expect(plan.approvals.matchedPreApprovals).toEqual([])
    expect(plan.approvals.preApprovalDisclosures).toEqual([])
    expect(plan.approvals.activationRequired).toEqual([])

    // --- budget reservations and rejected work (sixth item) ---
    expect(plan.rejected).toEqual([])
    expect(plan.budgets.base).toEqual({ maximumConcurrency: 4, maximumFanOut: 4 })
    expect(plan.budgets.decision.limits).toEqual({ maximumConcurrency: 4, maximumFanOut: 4 })
    expect(plan.budgets.observation).toEqual(NO_BUDGET_OBSERVATION)

    // --- warnings (seventh item) ---
    expect(plan.warnings.length).toBeGreaterThan(0)
    // Sorted and de-duplicated, so two plans diff.
    const keys = plan.warnings.map((warning) => `${warning.kind}|${warning.subject ?? ""}|${warning.detail.join(",")}`)
    expect([...keys].sort()).toEqual(keys)
    expect(new Set(keys).size).toBe(keys.length)
    expect(plan.lines.length).toBeGreaterThan(0)
    expect(plan.explanationText).toBe(plan.lines.join("\n"))
    expect(plan.digest).toMatch(/^sha256:/)
    // The plan is frozen, so "it performed nothing" is not a convention.
    expect(Object.isFrozen(plan)).toBe(true)
  })

  it("agrees with a direct `rankNodes`, digest for digest, over the same request and preference", async () => {
    // A routing rule, so the comparison is over a case where the preference actually
    // changed the answer: without it both sides would be comparing two tie-breaks.
    const compiled = compiledFrom(routingDocument())
    const plan = await planFor(simulationRequest({ rules: compiled }))
    const reported = plan.dispatches[0]?.routing
    expect(reported).not.toBeNull()

    const direct = rankNodes(twoEligibleNodes(), routingRequestForFirstStep(), {
      preferredNodeIds: [NODE_B],
      excludedNodeIds: [],
      requiredRuntimeKind: null,
      requiredProjectPathId: null,
    })
    expect(direct.ok).toBe(true)
    if (!direct.ok) return

    // The digest covers every stable member of `RoutingResult`, so equal digests mean
    // equal answers — the selection, the whole candidate list, and every exclusion.
    expect(reported?.digest, "the plan's routing is not rankNodes' answer").toBe(direct.value.digest)
    expect(reported?.selectedNodeId).toBe(direct.value.selectedNodeId)
    expect(reported?.candidates).toEqual(direct.value.candidates)
    expect(reported?.preferenceIgnored).toEqual(direct.value.preferenceIgnored)
    expect(reported?.demotedNodeIds).toEqual(direct.value.demotedNodeIds)
    expect(reported?.preferenceApplied).toBe(true)
    expect(reported?.tieBreakApplied).toBe(false)
    // The preference moved the selection off the code-unit winner, which is the whole
    // point of a preference that is allowed to reorder.
    expect(reported?.selectedNodeId).toBe(NODE_B)
    expect(direct.value.selectedNodeId).not.toBe(direct.value.candidates[1]?.nodeId === NODE_B ? "unreachable" : NODE_A)
  })

  it("routes with the neutral preference and the same answer as an EMPTY preference, so no rule means no preference", async () => {
    const plan = await defaultPlan()
    const direct = rankNodes(twoEligibleNodes(), routingRequestForFirstStep(), EMPTY_ROUTING_PREFERENCE)
    expect(direct.ok).toBe(true)
    if (!direct.ok) return
    expect(plan.dispatches[0]?.routing?.digest).toBe(direct.value.digest)
    expect(plan.dispatches[0]?.routing?.preferenceApplied).toBe(false)
  })
});

// ===========================================================================
// 5. Determinism
// ===========================================================================

describe("M6.7 — fifty dry runs over shuffled snapshots produce one artifact", () => {
  it("produces one byte-identical plan and digest across fifty invocations with shuffled snapshot arrays", async () => {
    // A three-node registry and two manifests, so the arrays being shuffled are
    // actually unsorted rather than already in the order the product sorts them into.
    const nodes = [
      ...twoEligibleNodes(),
      registryNode({ nodeId: "node-m6-c", capabilities: ["fs.read", "fs.write", "shell.run"] }),
    ]
    const manifests = [
      contextManifest({ manifestId: "manifest-m6-a", dispatchId: "disp:build" }),
      contextManifest({ manifestId: "manifest-m6-b", dispatchId: "disp:ship" }),
    ]
    const roles = [roleSnapshot()]
    const rules = compiledFrom(preApprovalDocument(), budgetDocument({ ruleId: "rule-m6-plan-budget" }))

    const baseline = await planFor(simulationRequest({ nodes, roles, manifests, rules }))
    const baselineLines = [...baseline.lines]
    const firstTally = { ...(await simulationPorts()).tally }

    for (let attempt = 0; attempt < 50; attempt += 1) {
      // A DIFFERENT shuffle each time, from a seeded generator. `Math.random` would
      // make a determinism failure unreproducible, which is the one thing a
      // determinism gate must not produce.
      const plan = await planFor(
        simulationRequest({
          nodes: shuffled(nodes, attempt + 1),
          roles: shuffled(roles, attempt + 10_001),
          manifests: shuffled(manifests, attempt + 20_001),
          rules,
        }),
      )
      expect(plan.digest, `invocation ${attempt} produced a different digest`).toBe(baseline.digest)
      expect(plan.lines, `invocation ${attempt} produced different rendered lines`).toEqual(baselineLines)
      expect(plan.expansion.graph.order).toEqual(["build", "ship"])
      expect(plan.dispatches.map((dispatch) => dispatch.task.dispatchId)).toEqual(["disp:build", "disp:ship"])
      // And the counters are per-invocation, so a plan built from a fresh probe
      // reports the same gate arithmetic every time.
      expect(plan.dispatches.every((dispatch) => dispatch.budget.reserved === false)).toBe(true)
    }
    // A fresh probe's tally is zeroed, which is what "the counters are per-invocation"
    // means; asserted so a future shared probe would fail here rather than making
    // the loop's per-invocation assertions depend on accumulation.
    expect(firstTally.retainedReservations).toBe(0)
  })

  it("binds the injected clock into the digest, so two instants are two artifacts", async () => {
    const atFixed = await planFor(simulationRequest({ now: FIXED_NOW }))
    const atLater = await planFor(simulationRequest({ now: "2026-07-04T12:00:00Z" }))
    expect(atFixed.generatedAt).toBe(FIXED_NOW)
    expect(atLater.generatedAt).toBe("2026-07-04T12:00:00Z")
    expect(atFixed.digest).not.toBe(atLater.digest)
  })
});

// ===========================================================================
// 6. An unenforceable cost budget is a warning
// ===========================================================================

describe("M6.7 — a cost budget the adapter cannot measure is warned about, never claimed and never refused", () => {
  it("reports a provider-cost budget as `not_enforceable`, admits the work, and refuses nothing", async () => {
    // No observation at all — the pessimistic default. The plan's base budget
    // declares a provider-cost ceiling the runtime cannot measure.
    const plan = await planFor(
      simulationRequest({
        baseBudget: { maximumConcurrency: 4, maximumFanOut: 4, maximumUsageUnits: 5_000, usageUnit: "provider_cost_micros" },
      }),
    )

    // The DECISION says not enforceable, for the usage field AND the unit field, and
    // says so about the two fields this build does enforce.
    const enforceability = plan.budgets.decision.enforceability
    expect(enforceability.maximumUsageUnits).toBe("not_enforceable")
    expect(enforceability.usageUnit).toBe("not_enforceable")
    expect(enforceability.maximumConcurrency).toBe("enforceable")
    expect(enforceability.maximumFanOut).toBe("enforceable")
    // The DECISION is relayed from `composeBudgets`; the plan did not compute it.
    const composed = composeBudgets(plan.budgets.base, [], NO_BUDGET_OBSERVATION)
    expect(plan.budgets.decision.limits).toEqual(composed.limits)
    expect(plan.budgets.decision.enforceability).toEqual(composed.enforceability)
    expect(plan.budgets.decision.warnings).toEqual(composed.warnings)

    // The budget is RECORDED. "Not enforceable" is not "not set": the limit is
    // reported with its value so a reader can see what was asked for.
    expect(plan.budgets.decision.limits.maximumUsageUnits).toBe(5_000)
    expect(plan.budgets.decision.limits.usageUnit).toBe("provider_cost_micros")

    // A WARNING naming the field, per dispatch — never a refusal. No dispatch is
    // rejected, and the plan exists, which is the whole of the claim: an
    // unenforceable budget produces a warning rather than a decision the simulator
    // is not entitled to make.
    expect(plan.rejected, "an unenforceable cost budget refused work").toEqual([])
    const costWarnings = plan.warnings.filter(
      (warning) => warning.kind === "budget_not_enforceable" && warning.detail.includes("maximumUsageUnits"),
    )
    expect(costWarnings.length, "the unenforceable budget was not warned about, per dispatch").toBe(plan.dispatches.length)
    for (const warning of costWarnings) {
      expect(warning.subject).not.toBeNull()
      expect(warning.message).toContain("NOT enforceable")
      expect(warning.message).toContain("no work is refused for it")
    }
    // And the usage admission is `admitted: true` with a reason that says why.
    for (const dispatch of plan.dispatches) {
      expect(dispatch.budget.usage.admitted).toBe(true)
      expect(dispatch.budget.usage.enforceability).toBe("not_enforceable")
      expect(dispatch.budget.usage.reason).toBe("usage_not_reported")
      expect(dispatch.budget.refusal).toBeNull()
      expect(dispatch.budget.reservation).not.toBeNull()
    }
    // The approvals are untouched: an unenforceable budget is not an approval
    // demand, and turning it into one would be a second, invented gate.
    expect(plan.approvals.everyDispatchRequiresApproval).toBe(true)
    for (const entry of plan.approvals.required) {
      expect(entry.outstanding).toEqual(["dispatch_approval"])
    }
  })

  it("reports an UNRELIABLE usage figure the same way, and an enforceable one differently", async () => {
    const budget = { maximumConcurrency: 4, maximumFanOut: 4, maximumUsageUnits: 5_000, usageUnit: "provider_cost_micros" as const }

    // `reported: true, reliable: false` — the shape the ADR names: a figure that is
    // estimated or delayed. Reported, not believed.
    const unreliable = await planFor(
      simulationRequest({ baseBudget: budget, observation: reportedUsageObservation(1_200, "provider_cost_micros", { reliable: false }) }),
    )
    expect(unreliable.budgets.decision.enforceability.maximumUsageUnits).toBe("not_enforceable")
    expect(unreliable.rejected).toEqual([])
    expect(unreliable.dispatches[0]?.budget.usage.reason).toBe("usage_unreliable")
    expect(unreliable.warnings.some((warning) => warning.kind === "usage_not_measurable" && warning.detail.includes("usage_unreliable"))).toBe(true)

    // `reported: true, reliable: true` — the same budget, now measurable, and the
    // warning is GONE. This is the half that makes the warning a statement about the
    // measurement rather than about the budget: identical limits, opposite verdicts.
    const reliable = await planFor(
      simulationRequest({ baseBudget: budget, observation: reportedUsageObservation(1_200, "provider_cost_micros") }),
    )
    expect(reliable.budgets.decision.enforceability.maximumUsageUnits).toBe("enforceable")
    expect(reliable.budgets.decision.limits.maximumUsageUnits).toBe(5_000)
    expect(reliable.warnings.some((warning) => warning.kind === "budget_not_enforceable")).toBe(false)
    expect(reliable.dispatches[0]?.budget.usage.reason).toBe("usage_within_budget")

    // And over the ceiling with a RELIABLE figure, the work is refused — which is
    // what makes the unenforceable case a measurement claim rather than a permanent
    // exemption. The usage refusal is reported as an admission refusal, and the
    // dispatch is admitted with the budget decision visible, so a reader sees both.
    const overCeiling = await planFor(
      simulationRequest({ baseBudget: budget, observation: reportedUsageObservation(5_000, "provider_cost_micros") }),
    )
    expect(overCeiling.dispatches[0]?.budget.usage.admitted).toBe(false)
    expect(overCeiling.dispatches[0]?.budget.usage.reason).toBe("usage_budget_exceeded")
    if (overCeiling.dispatches[0]?.budget.usage.admitted === false) {
      expect(overCeiling.dispatches[0]?.budget.usage.refusal.code).toBe("budget.usage_exceeded")
    }
  })

  it("does not warn about a budget nobody declared", async () => {
    // An absent field is `not_enforceable` by construction — there is no limit in
    // force, so there is nothing to enforce — and warning about it would say
    // "declared but not enforceable" about a budget nobody declared.
    const plan = await defaultPlan()
    expect(plan.budgets.decision.enforceability.maximumUsageUnits).toBe("not_enforceable")
    expect(plan.budgets.decision.limits.maximumUsageUnits).toBeUndefined()
    expect(plan.warnings.some((warning) => warning.kind === "budget_not_enforceable")).toBe(false)
    expect(plan.warnings.some((warning) => warning.kind === "usage_not_measurable")).toBe(false)
  })
});

// ===========================================================================
// 7. The plan carries no secret
// ===========================================================================

describe("M6.7 — a plan with a canary in every free-text field of every snapshot carries none of it", () => {
  it("finds no seeded content in the plan value or in any rendered line", async () => {
    // The canaries live in the FIXTURES, never in the module under audit: an audit
    // whose canary list is produced by the code it audits agrees with whatever that
    // code happens to carry. Every free-text field of every snapshot is seeded — the
    // role's name, purpose and instructions, the template's name and description,
    // both step titles, the bound parameter value, and both node display names.
    const rules = compiledFrom(preApprovalDocument())
    const ports = simulationPorts({ templates: templateRepository([canariedTemplateInput()]) })
    const plan = await planFor(
      canariedRequest(rules),
      ports,
    )

    // The plan is not vacuous: it expanded, routed, budgeted and demanded approvals
    // over the canaried snapshots, so "no canary found" is a statement about a real
    // plan rather than about a refusal or an empty artifact.
    expect(plan.dispatches.length).toBeGreaterThan(0)
    expect(plan.expansion.tasks.map((task) => task.stepId)).toEqual(["build", "ship"])
    expect(plan.dispatches[0]?.routing?.selectedNodeId).toBe(NODE_A)
    expect(plan.approvals.required.length).toBeGreaterThan(0)

    const findings = auditForCanaries({ artifact: plan, renderedText: plan.lines, seededCanaries: Object.values(CANARIES) })
    expect(findings, `a canary reached the plan: ${findings.join("; ")}`).toEqual([])

    // The specific fields the plan does carry, named: an identifier, an enum member,
    // a number, a digest, a count and a reason code. A step title, a role name, a
    // template name, a bound parameter value and a node display name are all absent.
    const serialized = JSON.stringify(plan)
    for (const canary of Object.values(CANARIES)) {
      expect(serialized.includes(canary), `the plan serialized the canary '${canary}'`).toBe(false)
      for (const line of plan.lines) {
        expect(line.includes(canary), `a rendered line carried the canary '${canary}'`).toBe(false)
      }
    }
    // Label VALUES are withheld even though label KEYS are not: `env` is a
    // parameter NAME and appears; the bound value does not.
    expect(plan.expansion.tasks[0]?.labelKeys).toEqual(["env"])
    expect(serialized.includes("env")).toBe(true)
    expect(serialized.includes(CANARIES.parameterValue)).toBe(false)
  })
});

// ===========================================================================
// 8. The refusals are values
// ===========================================================================

describe("M6.7 — a malformed request is refused as a value, never thrown", () => {
  it("refuses a request that does not satisfy the schema, naming the member", async () => {
    const refused = await simulated({ ...simulationRequest(), now: "not a timestamp" })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.refusal.code).toBe("simulation.input_invalid")
    expect(refused.refusal.message).toContain("now")
  })

  it("refuses to plan without a budget store rather than falling back to a real one", async () => {
    // `BudgetLedger`'s own default is a REAL store that really reserves, so a caller
    // who forgot the port would get a plan whose `reserved: false` is a lie. The
    // refusal is the runtime half of the port's type, and it is the failure this
    // milestone claims cannot happen.
    const result = await simulateDryRun(simulationRequest(), {
      templates: templateRepository(),
    } as never)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe("simulation.input_invalid")
    expect(result.refusal.message).toContain("createBudgetLedgerProbe")
  })

  it("refuses a template the workflow module will not instantiate, relaying its own code", async () => {
    // A template id nobody holds. The refusing module is `src/workflows`, and its
    // code is carried beside the simulator's rather than flattened, because "the dry
    // run refused" and "the dry run refused because the template does not exist" are
    // different answers.
    const refused = await simulated(simulationRequest({ templateId: "tmpl_absent" }))
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.refusal.code).toBe("simulation.template_not_instantiable")
    expect(refused.refusal.origin).toContain("workflow.")
  })

  it("refuses a rule set that is not shaped like a compiled one, rather than re-parsing rule sources", async () => {
    // The guard is a SHAPE guard, documented as such at `src/simulation/types.ts:471`,
    // and the reason it is not a parser is ADR 0007 section 3: `compileRuleSet` is the
    // only way to produce a compiled set, and re-parsing rule sources here would be
    // the second parser that section forbids. So what is asserted is the refusal, and
    // the message names the module that owns the real thing.
    for (const rules of [
      // Not an object at all.
      "rule sources, not a compiled set",
      // Right language version, no limits table.
      { languageVersion: 2, rules: [], digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" },
      // Right language version, no digest.
      { languageVersion: 2, rules: [], limits: {} },
      // Right language version, limits is not a table.
      { languageVersion: 2, rules: "sources", limits: {}, digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" },
      // A FUTURE language version this build does not implement.
      { languageVersion: 3, rules: [], limits: {}, digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" },
    ]) {
      const refused = await simulated({ ...simulationRequest(), rules })
      expect(refused.ok, `${JSON.stringify(rules).slice(0, 60)} was planned`).toBe(false)
      if (refused.ok) continue
      expect(refused.refusal.code).toBe("simulation.input_invalid")
      // The message names the type the guard demands and says WHY it will not parse
      // sources: a second parser is the divergence ADR 0007 stop condition 1 exists to
      // prevent.
      expect(refused.refusal.message).toContain("CompiledRuleSet")
      expect(refused.refusal.message).toContain("second parser")
    }
  })
});

// ===========================================================================
// 9. A saturated gate is a refusal of the dispatch, not of the plan
// ===========================================================================

describe("M6.7 — a budget the run cannot meet refuses the DISPATCH, and still produces a plan", () => {
  it("reports a ceiling of one over two dispatches as a plan, because the gate is asked against an empty scope", async () => {
    // A concurrency ceiling of one and two dispatches. The probe holds nothing, so
    // the ledger's compare-and-set is asked what it would decide against an EMPTY
    // scope — which is exactly the state a dry run leaves the ledger in — and both
    // are admitted. That is the honest answer for a plan, and asserting it states
    // the limitation rather than hiding it: a dry run cannot see live capacity, and
    // ADR 0007 section 16 S3 requires such a fact to arrive on the request as a
    // snapshot value rather than be asked of a live system.
    const plan = await planFor(simulationRequest({ baseBudget: { maximumConcurrency: 1, maximumFanOut: 1 } }))
    expect(plan.rejected).toEqual([])
    expect(plan.dispatches.every((dispatch) => dispatch.budget.reservation !== null)).toBe(true)
    expect(plan.dispatches.every((dispatch) => dispatch.budget.refusal === null)).toBe(true)
    expect(plan.budgets.decision.limits.maximumConcurrency).toBe(1)
    // And the plan says which snapshot facts it was given rather than implying it
    // consulted a live system.
    expect(plan.budgets.observation).toEqual(NO_BUDGET_OBSERVATION)
  })

  it("the real ledger refuses the over-ceiling reserve, with `src/budgets`' own code and numbers", async () => {
    // The refusal itself, against a REAL store rather than the probe — because a store
    // that retains nothing cannot saturate, and the claim worth making is that the
    // code the simulator relays is the code production raises.
    const { ledger } = budgetLedger({ maximumConcurrency: 1, maximumFanOut: 1 })
    const first = await ledger.reserve(reserveRequestFor(1))
    expect(first.ok, "the first reserve against a ceiling of 1 must be admitted").toBe(true)
    expect(ledger.eligible("disp-m6-1")).toBe(true)

    const second = await ledger.reserve(reserveRequestFor(2))
    expect(second.ok, "a second unit against a ceiling of 1 must be refused").toBe(false)
    if (second.ok) return
    expect(second.refusal.code).toBe("budget.scope_saturated")
    expect(second.refusal.limit).toBe(1)
    expect(second.refusal.heldUnits).toBe(1)
    expect(second.refusal.requestedUnits).toBe(1)
    // A refusal left the store byte-identical: the first reservation is intact and
    // the second dispatch holds nothing.
    expect(ledger.eligible("disp-m6-2")).toBe(false)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(1)
    expect(ledger.list()).toHaveLength(1)
  });

  it("refuses to reserve against a scope with no declared ceiling, because no budget is not an unlimited budget", async () => {
    const { ledger } = budgetLedger({ maximumFanOut: 4 })
    const refused = await ledger.reserve(reserveRequestFor(1))
    expect(refused.ok, "an undeclared scope is not an unlimited scope").toBe(false)
    if (refused.ok) return
    expect(refused.refusal.code).toBe("budget.scope_unbounded")
    expect(refused.refusal.limit).toBeNull()
    expect(refused.refusal.message).toContain("no budget")
  });
});
