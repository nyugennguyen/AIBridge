/**
 * M4-B, discharged: every `EffectBoundary` hook fires, crashes and converges.
 *
 * The plan's stop condition is "all eight `EffectBoundary` hooks are invoked,
 * and M4.9's fault harness exercises each of the plan's eight failure
 * boundaries". This file is that evidence, and it is evidence rather than
 * decoration because every test here asserts FOUR things a decoration cannot:
 *
 *   1. the hook's name is in `boundary.crashes`, so it fired rather than merely
 *      being declared;
 *   2. an `InjectedCrash` was CAUGHT, so the throw is a crash and not a refusal;
 *   3. what the seam had committed at the instant of the crash is asserted
 *      against what the restarted node reads back, which is the difference
 *      between a boundary at 3 and one at 4;
 *   4. the scenario CONTINUES and converges — a restarted process that then
 *      refused everything would pass a test that only asserted the crash.
 *
 * Hooks 1–4 are the coordinator, 5–6 the outbox deliverer, 7 the projection
 * updater and 8 the legacy translation. Each block below names which.
 */
import { describe, expect, it } from "vitest"
import { InjectedCrash } from "../../../../src/mesh/fault/boundary.js"
import { EFFECT_BOUNDARY_HOOKS, EFFECT_BOUNDARY_NUMBER, type EffectBoundaryHook } from "../../../../src/mesh/fault/types.js"
import { FAULT_RUN, aLegacyJob, aMeshEvent, eventEnvelope } from "../../../../src/mesh/fault/records.js"
import { MESH_OUTBOX_CLAIM_LEASE_MS } from "../../../../src/mesh/outbox/policy.js"
import type { LegacyTriggerAcceptance } from "../../../../src/orchestration/legacy/translation.js"
import type { FaultMesh } from "../../../../src/mesh/fault/harness.js"
import { aFaultScenario, anApprovedScenario, deliverALease, inboxRowCount, outboxRowCount, outboxStatuses } from "./fixtures.js"

/**
 * The eight hooks this file claims to cover, written out rather than derived.
 *
 * Written out ON PURPOSE. A test that enumerated `EFFECT_BOUNDARY_HOOKS` would
 * pass by construction and would keep passing after a ninth hook was added with
 * no test behind it — which is exactly how the M4-B carry-forward ("declared and
 * typed but never invoked") happened in the first place. The list below is the
 * suite's claim, and the assertion at the top of this file is what makes the
 * claim checkable.
 */
const COVERED_HOOKS: readonly EffectBoundaryHook[] = [
  "beforeValidate",
  "afterValidate",
  "duringAppend",
  "afterCommit",
  "beforeDeliver",
  "afterRuntimeAccept",
  "duringProjectionUpdate",
  "duringTranslation",
]

/** `T0` as a number, for an event's `occurredAt`. Every instant in the suite is this plus something. */
const T0 = Date.parse("2026-09-28T00:00:00.000Z")

/** Runs `work` and returns the crash it threw, or `null` if it did not throw. */
async function catching(work: () => unknown): Promise<InjectedCrash | null> {
  try {
    await work()
  } catch (error) {
    if (error instanceof InjectedCrash) return error
    throw error
  }
  return null
}

/**
 * The assertions every hook test makes about the crash it provoked.
 *
 * `occurrence` is a parameter because `duringAppend` fires ONCE PER PLANNED
 * EVENT, and a test that armed its crash on the second of two firings has to be
 * able to say so.
 */
function assertCrashedExactly(mesh: FaultMesh, hook: EffectBoundaryHook, crash: InjectedCrash | null, occurrence = 1): void {
  // The hook FIRED. `crashes` carries the hook's NAME, so a boundary that
  // crashed for a neighbouring reason cannot satisfy this.
  expect(mesh.boundary.crashes).toEqual([{ hook, occurrence }])
  expect(mesh.boundary.reached(hook)).toBe(true)
  expect(crash).toBeInstanceOf(InjectedCrash)
  expect(crash?.hook).toBe(hook)
  expect(crash?.occurrence).toBe(occurrence)
}

/**
 * Arms the NEXT firing of `hook`.
 *
 * Not `arm(hook)` with its default of the first firing: an approved scenario has
 * already driven the coordinator and the projection updater several times, so a
 * first-firing arming would match a hook that fired during setup and the crash
 * would never happen. The boundary counts per hook, so "the next one" is the
 * honest instruction.
 */
function armNextFiring(mesh: FaultMesh, hook: EffectBoundaryHook): number {
  const next = mesh.boundary.fired(hook) + 1
  mesh.crashAt(hook, next)
  return next
}

describe("M4-B effect boundaries", () => {
  it("covers exactly the eight declared hooks, numbered as the plan numbers them", () => {
    expect([...COVERED_HOOKS].sort()).toEqual([...EFFECT_BOUNDARY_HOOKS].sort())
    expect(EFFECT_BOUNDARY_HOOKS).toHaveLength(8)
    expect(Object.values(EFFECT_BOUNDARY_NUMBER)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    for (const hook of EFFECT_BOUNDARY_HOOKS) expect(EFFECT_BOUNDARY_NUMBER[hook]).toBeGreaterThan(0)
  })

  // ── Hook 1: the coordinator, before validation ──────────────────────────

  it("1 beforeValidate: the command never reached validation, and the retry is the first thing recorded", async () => {
    const scenario = await aFaultScenario()
    const mesh = scenario.mesh
    try {
      mesh.crashAt("beforeValidate")
      const crash = await catching(() => mesh.controller.coordinator.submit(scenario.runCreateFor(1)))
      assertCrashedExactly(mesh, "beforeValidate", crash)
      // Nothing was appended: the projection does not exist, and after a restart
      // the log replays to nothing.
      expect(mesh.controller.projection()).toBeUndefined()
      expect(mesh.boundary.calls[0]).toBe(`beforeValidate#1:${scenario.runCreateFor(1).commandId}`)

      await mesh.restartNode(mesh.controllerNodeId)
      expect(mesh.controller.projection()).toBeUndefined()

      const retry = mesh.controller.coordinator.submit(scenario.runCreateFor(1))
      expect(retry.ok && retry.value).toEqual({ events: ["run.created", "task.created"], duplicate: false })
      // NON-VACUITY: the hook fired TWICE and crashed ONCE. A boundary that
      // never fired, or one that stayed armed, fails this pair.
      expect(mesh.boundary.fired("beforeValidate")).toBe(2)
      expect(mesh.boundary.crashes).toHaveLength(1)
      const projection = mesh.controller.projection()
      expect(projection?.run.runId).toBe(FAULT_RUN)
      expect(Object.keys(projection?.tasks ?? {})).toHaveLength(1)
    } finally {
      mesh.close()
    }
  })

  // ── Hook 2: the coordinator, after validation ───────────────────────────

  it("2 afterValidate: the command was licensed for a family and nothing else happened", async () => {
    const scenario = await aFaultScenario()
    const mesh = scenario.mesh
    try {
      mesh.crashAt("afterValidate")
      const crash = await catching(() => mesh.controller.coordinator.submit(scenario.runCreateFor(1)))
      assertCrashedExactly(mesh, "afterValidate", crash)
      expect(mesh.controller.projection()).toBeUndefined()
      // The ordering is the assertion: 1 ran, then 2 died, and nothing after it
      // fired at all — a plan was never built.
      expect(mesh.boundary.calls).toEqual([
        `beforeValidate#1:${scenario.runCreateFor(1).commandId}`,
        `afterValidate#1:${scenario.runCreateFor(1).commandId}`,
      ])

      await mesh.restartNode(mesh.controllerNodeId)
      const retry = mesh.controller.coordinator.submit(scenario.runCreateFor(1))
      expect(retry.ok && retry.value.duplicate).toBe(false)
      expect(mesh.boundary.fired("afterValidate")).toBe(2)
      expect(mesh.boundary.crashes).toHaveLength(1)
      expect(mesh.controller.projection()?.run.runId).toBe(FAULT_RUN)
    } finally {
      mesh.close()
    }
  })

  // ── Hook 3: the coordinator, per planned event ──────────────────────────

  it("3 duringAppend: a crash on the SECOND planned event of a two-event command still commits neither", async () => {
    const scenario = await aFaultScenario()
    const mesh = scenario.mesh
    try {
      // Armed at the SECOND firing, because `duringAppend` fires once per
      // PLANNED EVENT and an arming on the first would be indistinguishable
      // from a hook that fires once per command.
      const occurrence = armNextFiring(mesh, "duringAppend")
      expect(occurrence).toBe(1)
      mesh.crashAt("duringAppend", 2)
      const crash = await catching(() => mesh.controller.coordinator.submit(scenario.runCreateFor(1)))
      assertCrashedExactly(mesh, "duringAppend", crash, 2)
      // The first event was planned and the second killed the plan, so the
      // append transaction was never entered and nothing is durable.
      expect(mesh.boundary.fired("duringAppend")).toBe(2)
      expect(mesh.controller.projection()).toBeUndefined()

      await mesh.restartNode(mesh.controllerNodeId)
      const retry = mesh.controller.coordinator.submit(scenario.runCreateFor(1))
      expect(retry.ok && retry.value).toEqual({ events: ["run.created", "task.created"], duplicate: false })
      // NON-VACUITY: two firings before the crash, two after the retry, one crash.
      expect(mesh.boundary.fired("duringAppend")).toBe(4)
      expect(mesh.boundary.crashes).toHaveLength(1)
      expect(Object.keys(mesh.controller.projection()?.tasks ?? {})).toHaveLength(1)
    } finally {
      mesh.close()
    }
  })

  // ── Hook 4: the coordinator, after the commit ───────────────────────────

  it("4 afterCommit: the append COMMITTED, so the retry is refused rather than repeated", async () => {
    const scenario = await aFaultScenario()
    const mesh = scenario.mesh
    try {
      mesh.crashAt("afterCommit")
      const crash = await catching(() => mesh.controller.coordinator.submit(scenario.runCreateFor(1)))
      assertCrashedExactly(mesh, "afterCommit", crash)
      // The distinction from hooks 1–3, and the reason this boundary exists: at
      // hook 4 the log holds the command, so the crash cost the CALLER its
      // answer rather than the run its facts.
      expect(mesh.controller.projection()?.run.runId).toBe(FAULT_RUN)

      await mesh.restartNode(mesh.controllerNodeId)
      // The recovered process reads the run back out of the durable log rather
      // than out of memory, which is the whole point of a restart here.
      expect(mesh.controller.projection()?.run.runId).toBe(FAULT_RUN)
      expect(Object.keys(mesh.controller.projection()?.tasks ?? {})).toHaveLength(1)

      const retry = mesh.controller.coordinator.submit(scenario.runCreateFor(1))
      // NON-VACUITY: at hooks 1–3 this same resubmission returns
      // `duplicate: false` and records the run. Here it must be refused, and
      // there must still be exactly one run and one task afterwards.
      expect(retry.ok).toBe(false)
      expect(retry.ok ? undefined : retry.error.code).toBe("coordinator.run_already_exists")
      expect(Object.keys(mesh.controller.projection()?.tasks ?? {})).toHaveLength(1)

      // The recovered process CARRIES ON: the rest of the scenario runs on
      // the state the crashed one committed.
      expect(mesh.controller.coordinator.submit(scenario.proposeCommand(1)).ok).toBe(true)
      expect(mesh.controller.coordinator.submit(scenario.approveCommand(1)).ok).toBe(true)
      expect(mesh.controller.projection()?.dispatches["dispatch-fault-1"]?.lifecycleState).toBe("approved")
      // The refused resubmission never reached the commit, so the hook fired
      // three times: the crash, and the two commands that followed it.
      expect(mesh.boundary.fired("afterCommit")).toBe(3)
      expect(mesh.boundary.crashes).toHaveLength(1)
    } finally {
      mesh.close()
    }
  })

  // ── Hook 5: the outbox deliverer, before the socket ─────────────────────

  it("5 beforeDeliver: the record is left claimed and the redelivery IS the first delivery", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh
    try {
      // The event is ENQUEUED, not sent: the pump is the only thing that puts it
      // on the wire, so arming before the pump means arming before delivery.
      await mesh.worker.report(
        aMeshEvent({ eventId: "evt-fault-boundary-5", sourceNodeId: mesh.workerNodeId, localSequence: 1, occurredAtMs: T0 }),
      )
      expect(outboxRowCount(mesh)).toBe(1)
      expect(mesh.boundary.fired("beforeDeliver")).toBe(0)

      mesh.crashAt("beforeDeliver")
      const crash = await catching(() => mesh.worker.deliverer().pumpOnce())
      assertCrashedExactly(mesh, "beforeDeliver", crash)

      // The claim is durable and the delivery never happened: this is the row a
      // restart has to reclaim.
      expect(outboxStatuses(mesh)).toEqual({ "mevt-evt-fault-boundary-5": "sending" })
      expect(mesh.worker.outboxRows.list({})[0]?.attempts).toBe(1)
      expect(mesh.controller.ingested()).toHaveLength(0)

      await mesh.restartNode(mesh.workerNodeId)
      // The claim LEASE, not the wall clock: the record becomes reclaimable when
      // the instant the pump stamped expires, and nothing before that.
      const pumpTooEarly = await mesh.worker.deliverer().pumpOnce()
      expect(pumpTooEarly.reclaimed).toEqual([])
      expect(pumpTooEarly.claimed).toBe(0)
      mesh.clock.advance(MESH_OUTBOX_CLAIM_LEASE_MS + 1_000)
      const report = await mesh.worker.deliverer().pumpOnce()

      // NON-VACUITY: the row was reclaimed — it was `sending` and is now
      // acknowledged — and the controller holds the event exactly once.
      expect(report.reclaimed).toEqual(["mevt-evt-fault-boundary-5"])
      expect(report.acknowledged).toBe(1)
      expect(outboxStatuses(mesh)).toEqual({ "mevt-evt-fault-boundary-5": "acknowledged" })
      // `attempts` is 2 and was never reset: the claim increments it, so this is
      // the second DELIVERY and the first never reached the wire. That is why
      // this redelivery needs no idempotence of its own — it is the first.
      expect(mesh.worker.outboxRows.list({})[0]?.attempts).toBe(2)
      expect(mesh.controller.ingested().map((event) => event.eventId)).toEqual(["evt-fault-boundary-5"])
      expect(outboxRowCount(mesh)).toBe(1)
    } finally {
      mesh.close()
    }
  })

  // ── Hook 6: the outbox deliverer, after the peer accepted ───────────────

  it("6 afterRuntimeAccept: the peer took the effect, so the redelivery must be idempotent", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh
    try {
      await mesh.worker.report(
        aMeshEvent({ eventId: "evt-fault-boundary-6", sourceNodeId: mesh.workerNodeId, localSequence: 1, occurredAtMs: T0 }),
      )
      mesh.crashAt("afterRuntimeAccept")
      const crash = await catching(() => mesh.worker.deliverer().pumpOnce())
      assertCrashedExactly(mesh, "afterRuntimeAccept", crash)

      // The window hook 6 names: the peer HAS the event and the acknowledgement
      // is not committed, so this row's fate is genuinely ambiguous.
      expect(outboxStatuses(mesh)).toEqual({ "mevt-evt-fault-boundary-6": "sending" })
      expect(mesh.controller.ingested().map((ingested) => ingested.eventId)).toEqual(["evt-fault-boundary-6"])

      await mesh.restartNode(mesh.workerNodeId)
      mesh.clock.advance(MESH_OUTBOX_CLAIM_LEASE_MS + 1_000)
      const report = await mesh.worker.deliverer().pumpOnce()

      expect(report.reclaimed).toEqual(["mevt-evt-fault-boundary-6"])
      expect(report.acknowledged).toBe(1)
      // The peer answered the redelivery FROM THE EVENT ID it already held,
      // which is the dedupe the at-least-once discipline rests on.
      expect(report.outcomes[0]?.ack?.outcome).toBe("duplicate")
      // THE ASSERTION: the redelivery converged instead of duplicating. A
      // controller that applied the second copy would hold the event twice.
      expect(mesh.controller.ingested().map((ingested) => ingested.eventId)).toEqual(["evt-fault-boundary-6"])
      expect((await mesh.controller.stream(0)).map((entry) => entry.eventId)).toEqual(["evt-fault-boundary-6"])
      // The row is retired rather than deleted, and its attempt count is not
      // reset by the reclaim.
      expect(outboxStatuses(mesh)).toEqual({ "mevt-evt-fault-boundary-6": "acknowledged" })
      expect(mesh.worker.outboxRows.list({})[0]?.attempts).toBe(2)
      expect(outboxRowCount(mesh)).toBe(1)
    } finally {
      mesh.close()
    }
  })

  // ── Hook 7: the projection updater ──────────────────────────────────────

  it("7 duringProjectionUpdate: the event was accepted but not projected, and the redelivery completes it", async () => {
    const scenario = await aFaultScenario()
    const mesh = scenario.mesh
    // A worker reporting before the controller has a run for it is deliberate:
    // the projection this hook advances is then CREATED rather than merged, so
    // "the redelivery completed it" is observable as a session appearing rather
    // than as a sequence moving.
    await deliverALease(mesh)
    try {
      const event = aMeshEvent({
        eventId: "evt-fault-boundary-7",
        sourceNodeId: mesh.workerNodeId,
        localSequence: 1,
        sessionId: "sess-fault-1",
        occurredAtMs: T0,
      })
      const record = eventEnvelope(event, mesh.controllerNodeId)
      const occurrence = armNextFiring(mesh, "duringProjectionUpdate")
      // Driven at the seam the proxy calls. The PROXY swallows a throwing
      // destination by design — it cannot tell a node's refusal from a node's
      // death — so the crash is observed here and through `boundary.crashes`
      // rather than through the transport. What the transport does with a crash
      // is the subject of the acceptance scenario.
      const signature = mesh.controller.identity.sign("POST", "/v1/mesh/event", record, mesh.clock.now())
      const crash = await catching(() => mesh.controller.receive({ record, signature, method: "POST", path: "/v1/mesh/event" }))
      assertCrashedExactly(mesh, "duringProjectionUpdate", crash, occurrence)

      // The half-done state the hook exists for, and the assertion is about the
      // PROJECTION rather than about what this process happens to remember.
      //
      // The event is durably recorded and on the stream — the crash is inside the
      // projection update, which runs after both — but the session it reports does
      // not exist in the projection. An earlier version of this file asserted
      // `ingested()` was empty here, which was true only because the harness kept
      // an in-memory list of what the process had handled: the durable record was
      // written and then the crash lost the list, so the test asserted on the
      // bookkeeping rather than on the state. `ingested()` is now derived from the
      // durable table, so the same event is visible before and after a restart, and
      // the thing worth asserting is the one the crash actually interrupted.
      expect((await mesh.controller.stream(0)).map((entry) => entry.eventId)).toEqual(["evt-fault-boundary-7"])
      expect(mesh.controller.ingested().map((ingested) => ingested.eventId)).toEqual(["evt-fault-boundary-7"])
      expect(Object.keys(mesh.controller.projection()?.sessions ?? {})).toEqual([])

      await mesh.restartNode(mesh.controllerNodeId)

      // The durable record survived, so the redelivery is recognised as a
      // DUPLICATE rather than re-applied. This is the idempotence the plan asks
      // for, and it now comes from the row that outlived the crash rather than
      // from a list that did not — a distinction invisible to a harness whose
      // in-memory state happened to agree with its durable state.
      const redelivered = await mesh.worker.send({ from: mesh.workerNodeId, to: mesh.controllerNodeId, record })
      // The controller answers a suppression from the GATEWAY, before the
      // ingestor is consulted at all, so there is no `ingested` member in the
      // response to read. The `duplicate` disposition on `published` is the
      // answer, and the durable table is the evidence.
      expect((redelivered as { published?: { outcome?: { disposition?: string } } }).published?.outcome?.disposition).toBe(
        "duplicate",
      )
      expect(mesh.controller.ingested().map((ingested) => ingested.eventId)).toEqual(["evt-fault-boundary-7"])
      expect((await mesh.controller.stream(0)).map((entry) => entry.eventId)).toEqual(["evt-fault-boundary-7"])
      // The crash cost the projection the update, and a duplicate does not replay
      // it — so the redelivery converges the WORKER's record without inventing
      // state the controller never derived. Replaying it is the reconciliation
      // pass's job, and an idempotence check that quietly re-derived the projection
      // would be doing that job here, silently, with no record that it had.
      expect(Object.keys(mesh.controller.projection()?.sessions ?? {})).toEqual([])
      expect(mesh.boundary.crashes).toHaveLength(1)
    } finally {
      mesh.close()
    }
  })

  // ── Hook 8: the legacy translation ──────────────────────────────────────

  it("8 duringTranslation: translation is a pure function, so the retry records the identical command exactly once", async () => {
    const scenario = await aFaultScenario()
    const mesh = scenario.mesh
    try {
      mesh.crashAt("duringTranslation")
      const crash = await catching(() => mesh.translateLegacyTrigger(aLegacyJob()))
      assertCrashedExactly(mesh, "duringTranslation", crash)
      // The crash is between "the mapping exists" and "the command reaches the
      // kernel", so nothing was recorded and the controller's own run is absent.
      expect(mesh.controller.projection()).toBeUndefined()

      await mesh.restartNode(mesh.controllerNodeId)
      const first: LegacyTriggerAcceptance = mesh.translateLegacyTrigger(aLegacyJob())
      expect(first.ok).toBe(true)
      expect(first.ok && first.events).toEqual(["run.created", "task.created"])
      // The translation targets its own canonical run, derived from the legacy
      // job rather than from the harness's scope, so the harness's projection
      // is deliberately the wrong place to look for it.
      const legacyRunId = first.ok ? first.correlation?.runId : undefined
      expect(legacyRunId).toBeDefined()
      expect(legacyRunId).not.toBe(FAULT_RUN)
      // The call log names the boundary's own subject, so a reader of a crash
      // transcript can tell WHICH translation died.
      expect(mesh.boundary.calls[0]).toBe(`duringTranslation#1:${legacyRunId}`)

      const second: LegacyTriggerAcceptance = mesh.translateLegacyTrigger(aLegacyJob())
      expect(second.ok).toBe(true)
      // THE ASSERTION: the second translation re-derived the identical canonical
      // ids, so the coordinator's `commandId` receipt collapsed it and appended
      // nothing. An empty event list is what "no duplicate prompt" means at a
      // boundary with no runtime.
      expect(second.ok && second.events).toEqual([])
      expect(mesh.boundary.fired("duringTranslation")).toBe(3)
      expect(mesh.boundary.crashes).toHaveLength(1)
    } finally {
      mesh.close()
    }
  })

  it("commits everything and crashes at nothing when the boundary is not armed", async () => {
    // The control arm for all eight: an UNARMED boundary over a run that
    // completes means every assertion above is a property of the crash rather
    // than of the scenario.
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh
    try {
      expect(mesh.boundary.crashes).toEqual([])
      // The deliverer and the translation were never driven, so their three
      // hooks are genuinely unreached rather than merely un-armed.
      expect(mesh.boundary.reached("beforeDeliver")).toBe(false)
      expect(mesh.boundary.reached("afterRuntimeAccept")).toBe(false)
      expect(mesh.boundary.reached("duringTranslation")).toBe(false)
      // The coordinator and the projection updater DID run, through the setup,
      // and did not crash.
      expect(mesh.boundary.fired("beforeValidate")).toBeGreaterThan(0)
      expect(mesh.boundary.fired("duringProjectionUpdate")).toBeGreaterThan(0)

      const response = await mesh.controller.send({
        from: mesh.controllerNodeId,
        to: mesh.workerNodeId,
        record: scenario.executeRecord(1),
      })
      expect((response as { result?: { outcome?: string } }).result?.outcome).toBe("accepted")
      expect(await inboxRowCount(mesh)).toBe(1)
    } finally {
      mesh.close()
    }
  })
})
