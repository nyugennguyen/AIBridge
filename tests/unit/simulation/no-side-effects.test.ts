/**
 * M6.7 — zero side effects, and no seeded content in the plan.
 *
 * # What this file is FOR
 *
 * The two claims a dry run has to earn before anyone may act on its output.
 *
 * ## 1. The dry run performs nothing
 *
 * Every assertion is a COUNT observed AT A SINK, and the plan under test is a
 * large, representative one: several rules, a routing preference, a pre-approval, a
 * budget rule, an unenforceable cost budget, an unavailable capability, a missing
 * manifest, and dispatches that are rejected at the rule layer, at routing, and at
 * the budget gate. Testing purity on a plan where nothing could have gone wrong
 * would be testing the easy half.
 *
 * The counts are: zero event appends, zero network calls, zero process launches,
 * zero filesystem writes, zero notifications, and — the one that matters most —
 * **zero retained reservations**, with the budget gate demonstrably ENTERED
 * (`attempts > 0`). A gate that was never asked would report the same zeros as a
 * gate that was asked and answered, which is why the test asserts both directions.
 *
 * The strongest statement available is also asserted, and it is not a count: after
 * the plan, every dispatch is still **ineligible**, because ADR 0007 section 13.2
 * defines eligibility as holding a held reservation and the probe holds none. Not
 * "we cleaned up" — there was nothing to clean up.
 *
 * ## 2. The plan carries no seeded content
 *
 * A canary is planted in EVERY free-text field of EVERY snapshot — the role's name,
 * purpose and instructions, the template's name and description, every step title,
 * the bound parameter value, and the node display names — and the finished plan, its
 * `lines` and its `explanationText` are searched for all of them, in every encoding a
 * value could plausibly arrive in (ADR 0007 section 12, following
 * `src/context/isolation.ts:145-154`).
 *
 * The audit's INPUT TYPE is declared STRUCTURALLY, in this test file, and never
 * imported from the module under audit. That is the discipline
 * `src/context/isolation.ts:94-122` records and `src/rules/preview.ts:531-548`
 * repeats: a redaction check that imported the view model it was checking could be
 * defeated by a change to the view model, because the check would be re-shaped by
 * exactly the edit it was supposed to catch. Naming only `unknown` means this audit
 * survives a new field on `DryRunPlan` — the new field is walked.
 */

import { describe, expect, it } from "vitest"
import {
  assertNoRetainedSideEffects,
  createFailClosedSinks,
  emptySinkTally,
  readSinkCounters,
  simulateDryRun,
  type DryRunPlan,
  type SimulationSinkCounters,
  type SimulationSinkTally,
} from "../../../src/simulation/index.js"
import { BudgetLedger } from "../../../src/budgets/index.js"
import { SENSITIVITY_LEVELS } from "../../../src/memory/ontology.js"
import { CONTEXT_SENSITIVITY_LEVELS } from "../../../src/simulation/index.js"
import {
  aBudgetDocument,
  aDenyDocument,
  aManifest,
  aNode,
  aPreApprovalDocument,
  aRequest,
  aRoutingDocument,
  canariedRequest,
  canariedTemplateInput,
  compiledFrom,
  everyCanary,
  NODE_REVOKED,
  ProbedRunTemplateRepository,
  simulatedPorts,
  type SimulatedPorts,
} from "./fixtures.js"

// ===========================================================================
// The audit's input, declared STRUCTURALLY
// ===========================================================================

/**
 * What this audit reads.
 *
 * `unknown`, on purpose. See the module docblock: a typed input would import the
 * plan type, and then adding a field carrying content to `DryRunPlan` would
 * re-shape this check into silence instead of into a failure.
 */
interface DryRunPlanAuditInput {
  readonly plan: unknown
  /** Any text a consumer rendered from the plan, checked in addition to the value. */
  readonly renderedText?: readonly string[]
  /** Literals that must not appear anywhere, in any encoding. */
  readonly seededCanaries: readonly string[]
}

/** Every encoding a value could plausibly arrive in. Mirrors `src/context/isolation.ts`. */
function encodingsOf(value: string): readonly string[] {
  return [
    value,
    Buffer.from(value, "utf8").toString("base64"),
    Buffer.from(value, "utf8").toString("base64url"),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
  ]
}

/** Canonical JSON, or a marker when the value cannot be encoded. */
function canonical(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, member: unknown) =>
      member === undefined || typeof member === "function" || typeof member === "bigint" ? null : member,
    )
  } catch {
    return "<<unencodable>>"
  }
}

/**
 * Walks the whole artifact and every rendered line, in every encoding.
 *
 * Returns FINDINGS rather than a boolean, for the reason
 * `verifyPreviewMatchesManifest` gives: a boolean tells a reviewer that something
 * was wrong and not what, which is the same objection as a check that cannot be
 * acted on. An empty list means "checked every canary in every encoding against the
 * whole value and found nothing", not "found nothing to check".
 */
function audit(input: DryRunPlanAuditInput): readonly string[] {
  const haystacks: readonly { label: string; text: string }[] = [
    { label: "plan", text: canonical(input.plan) },
    ...(input.renderedText ?? []).map((text, index) => ({ label: `renderedText[${index}]`, text })),
  ]
  const findings: string[] = []
  for (const canary of input.seededCanaries) {
    for (const encoding of encodingsOf(canary)) {
      if (encoding.length === 0) continue
      for (const haystack of haystacks) {
        if (haystack.text.includes(encoding)) findings.push(`canary of ${encoding.length} chars in ${haystack.label}`)
      }
    }
  }
  return findings
}

// ===========================================================================
// A large, representative dry run
// ===========================================================================

/**
 * The plan every purity assertion is made against.
 *
 * Deliberately messy. It has: a deny rule, a budget rule, a routing preference and
 * a pre-approval all compiled together; a three-node registry with one revoked node;
 * a cost budget the adapter cannot measure; a step whose capability no node
 * advertises; one manifest present and one dispatch without; and — because the
 * concurrency ceiling is one — a budget gate that ADMITS one reservation and REFUSES
 * the next. A representative plan that only ever took the happy path would leave most
 * of these code paths untested against a purity claim.
 */
function representativeRequest(): Record<string, unknown> {
  const rules = compiledFrom(aBudgetDocument(), aDenyDocument(), aRoutingDocument(), aPreApprovalDocument())
  return aRequest({
    rules,
    nodes: [
      aNode({ nodeId: "node-a" }),
      aNode({ nodeId: "node-b", capabilities: ["fs.read", "fs.write", "shell.run"] }),
      aNode({ nodeId: NODE_REVOKED, revoked: true }),
    ],
    baseBudget: { maximumConcurrency: 1, maximumUsageUnits: 1_000, usageUnit: "tokens" },
    manifests: [aManifest({ dispatchId: "disp:build" })],
  })
}

interface Observed {
  readonly plan: DryRunPlan
  readonly counters: SimulationSinkCounters
  readonly probeCounters: { attempts: number; admitted: number; refused: number; retained: number }
  readonly ledgerWasEligibleFor: (dispatchId: string) => boolean
}

async function observeRepresentative(ports: SimulatedPorts): Promise<Observed> {
  const result = await simulateDryRun(representativeRequest(), ports)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`the representative dry run refused: ${result.refusal.code} — ${result.refusal.message}`)
  // A SECOND ledger over the same probe, built after the plan, so eligibility can be
  // asked about each of the plan's dispatches through the production definition.
  const ledger = new BudgetLedger({ store: ports.budgetStore, resolveLimits: () => ({ maximumConcurrency: 99 }) })
  return {
    plan: result.value,
    counters: readSinkCounters(ports.tally),
    probeCounters: ports.probe.counters,
    ledgerWasEligibleFor: (dispatchId) => ledger.eligible(dispatchId),
  }
}

describe("a dry run performs nothing", () => {
  it("a large representative dry run appends no event, opens no connection, launches no process, writes no file and emits no notification", async () => {
    const { counters } = await observeRepresentative(simulatedPorts())
    expect(counters.eventAppends).toBe(0)
    expect(counters.networkCalls).toBe(0)
    expect(counters.processLaunches).toBe(0)
    expect(counters.filesystemWrites).toBe(0)
    expect(counters.notificationsEmitted).toBe(0)
  })

  it("the same dry run retains no budget reservation, and says so at the sink", async () => {
    const { counters, probeCounters } = await observeRepresentative(simulatedPorts())
    expect(counters.retainedReservations).toBe(0)
    expect(probeCounters.retained).toBe(0)
    // And the plan agrees with the sink, in two places a reader would look.
    const plan = (await observeRepresentative(simulatedPorts())).plan
    expect(plan.budgets.reserved).toEqual([])
    expect(plan.dispatches.every((dispatch) => dispatch.budget.reserved === false)).toBe(true)
  })

  it("the budget gate was ENTERED for every dispatch, so the zero reservations are an answer and not an absence of a question", async () => {
    const { probeCounters, plan } = await observeRepresentative(simulatedPorts())
    expect(probeCounters.attempts).toBe(plan.dispatches.length)
    expect(probeCounters.attempts).toBeGreaterThan(0)
    expect(probeCounters.admitted).toBeGreaterThan(0)
  })

  it("after the dry run every dispatch is still INELIGIBLE, because eligibility is holding a held reservation", async () => {
    const ports = simulatedPorts()
    const { plan, ledgerWasEligibleFor } = await observeRepresentative(ports)
    for (const dispatch of plan.dispatches) {
      expect(ledgerWasEligibleFor(dispatch.task.dispatchId)).toBe(false)
    }
  })

  it("the plan's reservations are a report of the gate's decision, not a claim that capacity was taken", async () => {
    const { plan } = await observeRepresentative(simulatedPorts())
    const admitted = plan.dispatches.filter((dispatch) => dispatch.budget.reservation !== null)
    expect(admitted.length).toBeGreaterThan(0)
    // Admitted means "would have been admitted", and the reservation the ledger
    // would have written is reported in full — including the state that makes a
    // dispatch launchable — so the reader can see exactly what was NOT kept.
    for (const dispatch of admitted) {
      expect(dispatch.budget.reservation?.state).toBe("held")
      expect(dispatch.budget.reserved).toBe(false)
    }
  })

  it("the gate REFUSES when the scope is unbounded, and the probe reports the ledger's own refusal", async () => {
    // The one budget refusal a dry run CAN reach. Saturation against capacity that
    // already exists is not knowable from a snapshot of the world, so the probe
    // answers every admission against an empty scope and the "concurrency N is full"
    // refusal is not simulated — a stated limitation, asserted here so a future edit
    // that starts claiming otherwise is a failure. What IS reachable is a scope with
    // no ceiling at all, and that refusal is `src/budgets`' own.
    const ports = simulatedPorts()
    const result = await simulateDryRun(aRequest({ baseBudget: { maximumConcurrency: undefined } }), ports)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.dispatches.every((dispatch) => dispatch.budget.refusal?.code === "budget.scope_unbounded")).toBe(true)
    expect(result.value.budgets.reserved).toEqual([])
    // The unbounded-scope refusal is raised by the LEDGER before it enters the
    // store — there is no compare-and-set to run when there is no ceiling — so the
    // probe is never reached, and its counters stay at zero. That is the right
    // place for the check, and the plan reports the refusal either way.
    expect(ports.probe.counters.attempts).toBe(0)
    expect(ports.probe.counters.retained).toBe(0)
    expect(ports.tally.budgetReservationAttempts).toBe(0)
  })

  it("no failing sink was reached, counted at the sinks themselves", async () => {
    const ports = simulatedPorts()
    await observeRepresentative(ports)
    // `refusedCalls` is the count of calls a fail-closed sink turned away. Zero
    // means no sink was reached at all, which is the same fact as the five zero
    // counters above and is asserted here so a future sink added to the tally is
    // covered without editing this test.
    expect(ports.tally.refusedCalls).toBe(0)
    expect(assertNoRetainedSideEffects(readSinkCounters(ports.tally))).toEqual([])
  })

  it("a dry run mutates no template, counted at the repository's own methods", async () => {
    const ports = simulatedPorts()
    await observeRepresentative(ports)
    expect(ports.templates.mutations).toEqual({ createTemplate: 0, updateTemplate: 0, clear: 0 })
    expect(ports.templates.count()).toBe(1)
    expect(ports.templates.listTemplateIds()).toEqual(["tmpl_sim"])
  })

  it("the fail-closed sinks a caller may wire are unreachable from the composition, and one wired in would throw", async () => {
    // The composition takes no sink parameters at all, so the five command sinks
    // cannot be reached by construction. Wiring one in by hand proves the throw is
    // real rather than a type-level claim: if a future edit ever threaded a sink
    // through, this is the assertion that would fail first.
    const tally: SimulationSinkTally = emptySinkTally()
    const sinks = createFailClosedSinks(tally)
    expect(() => sinks.events.append({ type: "run.started" })).toThrow()
    expect(tally.refusedCalls).toBe(1)
  })

  it("two dry runs over the same inputs are equally inert, so purity is not a first-run accident", async () => {
    for (const _ of [1, 2, 3]) {
      const ports = simulatedPorts()
      const { counters } = await observeRepresentative(ports)
      expect(assertNoRetainedSideEffects(counters)).toEqual([])
      expect(counters.refusedCalls).toBe(0)
    }
  })
})

describe("a plan carries no seeded content", () => {
  it("no canary planted in any free-text field of any snapshot appears in the plan, its lines, or its rendered text", async () => {
    const rules = compiledFrom(aBudgetDocument(), aRoutingDocument())
    const ports = simulatedPorts({ templates: new ProbedRunTemplateRepository([canariedTemplateInput()]) })
    const result = await simulateDryRun(canariedRequest(rules), ports)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const findings = audit({
      plan: result.value,
      renderedText: [...result.value.lines, result.value.explanationText],
      seededCanaries: everyCanary(),
    })
    expect(findings).toEqual([])
  })

  it("the audit would have caught a leak, which is what makes the empty finding meaningful", async () => {
    // A negative control. An audit that returns an empty list because it looked at
    // nothing is indistinguishable from one that looked and found nothing, and this
    // is the assertion that tells the two apart.
    const canary = everyCanary()[0]!
    const leaky = { lines: [`dry-run: leaked ${canary}`] }
    expect(audit({ plan: leaky, seededCanaries: everyCanary() }).length).toBeGreaterThan(0)
    expect(audit({ plan: { safe: true }, seededCanaries: everyCanary() })).toEqual([])
  })

  it("the audit walks the artifact generically, so a field the plan does not have today is still walked", async () => {
    // The input is `unknown`. Adding a member to `DryRunPlan` cannot narrow this
    // check, and planting a canary in a member the plan does not have today proves
    // the walk is generic rather than a hand-listed field check.
    const canary = everyCanary()[0]!
    const future: Record<string, unknown> = { languageVersion: 1, aMemberThatDoesNotExistYet: { nested: [canary] } }
    expect(audit({ plan: future, seededCanaries: everyCanary() }).length).toBeGreaterThan(0)
  })

  it("a base64-encoded canary is caught, because a transport or a log formatter will encode one", async () => {
    const canary = everyCanary()[0]!
    const encoded = Buffer.from(canary, "utf8").toString("base64")
    const findings = audit({ plan: { note: encoded }, seededCanaries: everyCanary() })
    expect(findings.some((finding) => finding.includes("64 chars") || finding.includes("chars"))).toBe(true)
  })

  it("a node's display name never reaches the plan, though it is the one free-text field on a registry snapshot", async () => {
    const result = await simulateDryRun(canariedRequest(), simulatedPorts())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(JSON.stringify(result.value)).not.toContain("canary-node-display-name-1c34")
    // The node is still reported — by id, health and capabilities.
    expect(result.value.nodes.length).toBe(2)
  })

  it("a role's name, purpose and instructions never reach the plan, though the role itself is reported", async () => {
    const result = await simulateDryRun(canariedRequest(), simulatedPorts())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.roles).toHaveLength(1)
    expect(result.value.roles[0]?.roleId).toBe("role-sim")
    expect(JSON.stringify(result.value.roles)).not.toContain("canary-role")
  })

  it("a step's title and a bound parameter value never reach the plan, though the step and its label NAMES do", async () => {
    const result = await simulateDryRun(canariedRequest(), simulatedPorts())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const build = result.value.dispatches.find((dispatch) => dispatch.task.stepId === "build")
    expect(build?.task.labelKeys).toEqual(["env"])
    expect(JSON.stringify(result.value)).not.toContain("canary-step-title-6d90")
    expect(JSON.stringify(result.value)).not.toContain("canary-parameter-value-b702")
  })

  it("the template's name and description never reach the plan, though its id and version do", async () => {
    const ports = simulatedPorts({ templates: new ProbedRunTemplateRepository([canariedTemplateInput()]) })
    const result = await simulateDryRun(aRequest(), ports)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.expansion.templateId).toBe("tmpl_sim")
    expect(JSON.stringify(result.value)).not.toContain("canary-template")
  })

  it("a refusal-free plan is the one that must be clean, so the audit runs on the successful path", async () => {
    const ports = simulatedPorts({ templates: new ProbedRunTemplateRepository([canariedTemplateInput()]) })
    const result = await simulateDryRun(canariedRequest(), ports)
    // The canaried template declares a required `target_env` parameter and the
    // canaried request supplies it, so this plan succeeds — which is the point: a
    // plan an operator would act on is the plan that must carry no content.
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(audit({ plan: result.value, seededCanaries: everyCanary() })).toEqual([])
  })
})

describe("the restated sensitivity lattice is the real one", () => {
  it("the lattice `src/simulation/types.ts` declares is exactly `sensitivitySchema`'s, member for member", () => {
    // The two guards on that declaration: this runtime equality, and the compile-time
    // annotation `CONTEXT_SENSITIVITY_MEMBERS satisfies readonly
    // ContextManifestV2["destination"]["clearance"][]`. ADR 0007 section 1 gives
    // `simulation` the edge `context` and not `memory`, so the members are spelled
    // out rather than imported — and these two checks are what stop the spelling from
    // drifting.
    expect([...CONTEXT_SENSITIVITY_LEVELS]).toEqual([...SENSITIVITY_LEVELS])
  })
})
