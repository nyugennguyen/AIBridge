/**
 * Tests for the notification surface integration (P5 row 4 / ADR 0007 §17, §12).
 *
 * Verifies:
 * 1. Each significant orchestration moment named by ADR 0007 and the Herdr orchestration
 *    plan produces a strictly valid notification with the right payload shape.
 * 2. Deduplication operates correctly on event and refusal dedupe keys.
 * 3. The audit passes cleanly without secret leaks.
 * 4. Structural boundary isolation: orchestration, rules, and budgets never import notifications;
 *    notifications never import commands.
 * 5. Behavioral isolation (Canary test): notification state mutations (pending entries,
 *    quieting changes, throwing adapters, inbox purges) have ZERO effect on orchestration decisions.
 * 6. Push-based event-driven execution with zero polling loops.
 */

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  auditNotificationPayload,
  createNotificationBus,
  createNotificationStore,
  createOrchestrationNotificationConsumer,
  dispatchRefusalToNotification,
  notificationEnvelopeSchema,
  notificationRequestSchema,
  orchestrationEventToNotification,
  type NotificationAdapter,
  type NotificationEnvelope,
  type NotificationRequest,
} from "../../../src/notifications/index.js"
import { compileRuleSet } from "../../../src/rules/compile.js"
import { evaluateRules } from "../../../src/rules/evaluate.js"
import { validContext, validRuleDocument } from "../rules/fixtures.js"
import {
  createTestClock,
  FIXED_NOW,
  recordingAdapter,
  throwingAdapter,
} from "./fixtures.js"

const REPOSITORY_ROOT = join(import.meta.dirname, "../../..")
const NOTIFICATIONS_DIR = join(REPOSITORY_ROOT, "src/notifications")

function sourceFiles(directory: string): readonly { path: string; text: string }[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => {
      const path = join(entry.parentPath ?? directory, entry.name)
      return { path, text: readFileSync(path, "utf8") }
    })
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

function importsOf(text: string): readonly string[] {
  return [...stripComments(text).matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]!)
}

describe("P5 row 4: Significant Orchestration Moments Produce Valid Notifications", () => {
  it("moment 1: roundtable outcome recorded produces roundtable_outcome notification", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const adapter = recordingAdapter("tui")
    const bus = createNotificationBus({ store, adapters: [adapter], clock })
    const consumer = createOrchestrationNotificationConsumer(bus)

    const event = {
      schemaVersion: 1,
      eventId: "evt-roundtable-1",
      sequence: 1,
      projectId: "proj-alpha",
      runId: "run-roundtable-1",
      type: "roundtable.outcome_recorded",
      payload: {
        discussionId: "disc-arch-review",
        outcome: {
          summary: "Three members deliberated on rollout safety",
          recommendation: "Proceed with canary deployment",
          addressedObjections: ["post-1", "post-2"],
          unresolvedObjections: [],
        },
      },
    }

    const request = orchestrationEventToNotification(event)
    expect(request).not.toBeNull()
    expect(notificationRequestSchema.safeParse(request).success).toBe(true)
    expect(request?.category).toBe("roundtable_outcome")
    expect(request?.severity).toBe("info")
    expect(request?.reasonCode).toBe("outcome_recorded")
    expect(request?.dedupeKey).toBe("roundtable_outcome:disc-arch-review")
    expect(request?.runId).toBe("run-roundtable-1")
    expect(request?.summary).toContain("Roundtable discussion disc-arch-review outcome recorded")

    const results = await consumer.handleEvent(event)
    expect(results).toHaveLength(1)
    expect(results[0]?.delivered).toBe(true)
    expect(adapter.calls).toHaveLength(1)

    const deliveredEnvelope = adapter.calls[0]!
    expect(notificationEnvelopeSchema.safeParse(deliveredEnvelope).success).toBe(true)
    expect(deliveredEnvelope.category).toBe("roundtable_outcome")

    // Assert no secret leak via the no-secret audit
    const audit = auditNotificationPayload({ seededSecrets: [], envelopes: [deliveredEnvelope] })
    expect(audit.passed).toBe(true)
    expect(audit.findings).toEqual([])
  })

  it("moment 2: dispatch refused with roundtable_required produces run_blocked notification", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const adapter = recordingAdapter("tui")
    const bus = createNotificationBus({ store, adapters: [adapter], clock })
    const consumer = createOrchestrationNotificationConsumer(bus)

    const refusal = {
      runId: "run-dispatch-42",
      taskId: "task-deploy",
      ruleId: "rule-objection-gate",
      reasonCode: "roundtable_required",
      detail: "Closed deliberation required before execution dispatch",
    }

    const request = dispatchRefusalToNotification(refusal)
    expect(notificationRequestSchema.safeParse(request).success).toBe(true)
    expect(request.category).toBe("run_blocked")
    expect(request.severity).toBe("attention")
    expect(request.reasonCode).toBe("roundtable_required")
    expect(request.dedupeKey).toBe("run_blocked:run-dispatch-42:task-deploy:roundtable_required")
    expect(request.runId).toBe("run-dispatch-42")
    expect(request.taskId).toBe("task-deploy")
    expect(request.ruleId).toBe("rule-objection-gate")
    expect(request.summary).toContain("blocked: roundtable required")

    const results = await consumer.handleRefusal(refusal)
    expect(results).toHaveLength(1)
    expect(adapter.calls).toHaveLength(1)

    const delivered = adapter.calls[0]!
    expect(notificationEnvelopeSchema.safeParse(delivered).success).toBe(true)
    expect(auditNotificationPayload({ seededSecrets: [], envelopes: [delivered] }).passed).toBe(true)
  })

  it("moment 3: dispatch refused with budget-ceiling produces budget_exhausted notification", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const adapter = recordingAdapter("tui")
    const bus = createNotificationBus({ store, adapters: [adapter], clock })
    const consumer = createOrchestrationNotificationConsumer(bus)

    const refusal = {
      runId: "run-fanout-7",
      taskId: "task-parallel-eval",
      reasonCode: "maximum_fan_out_exceeded",
      detail: "Ledger ceiling of 4 fan-out siblings reached",
    }

    const request = dispatchRefusalToNotification(refusal)
    expect(notificationRequestSchema.safeParse(request).success).toBe(true)
    expect(request.category).toBe("budget_exhausted")
    expect(request.severity).toBe("critical")
    expect(request.reasonCode).toBe("budget_exhausted")
    expect(request.dedupeKey).toBe("budget_exhausted:run-fanout-7:task-parallel-eval:ceiling")
    expect(request.runId).toBe("run-fanout-7")
    expect(request.taskId).toBe("task-parallel-eval")
    expect(request.summary).toContain("budget ceiling exceeded")

    const results = await consumer.handleRefusal(refusal)
    expect(results).toHaveLength(1)
    expect(adapter.calls).toHaveLength(1)

    const delivered = adapter.calls[0]!
    expect(notificationEnvelopeSchema.safeParse(delivered).success).toBe(true)
    expect(auditNotificationPayload({ seededSecrets: [], envelopes: [delivered] }).passed).toBe(true)
  })

  it("moment 4: charter proposal awaiting human approval produces pre_approval_pending notification", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const adapter = recordingAdapter("tui")
    const bus = createNotificationBus({ store, adapters: [adapter], clock })
    const consumer = createOrchestrationNotificationConsumer(bus)

    const event = {
      schemaVersion: 1,
      eventId: "evt-charter-prop-1",
      sequence: 2,
      projectId: "proj-alpha",
      runId: "run-charter-1",
      type: "charter.proposed",
      payload: {
        proposalId: "prop-relax-rate",
        proposal: {
          charterId: "charter-default",
          version: 2,
        },
      },
    }

    const request = orchestrationEventToNotification(event)
    expect(request).not.toBeNull()
    expect(notificationRequestSchema.safeParse(request).success).toBe(true)
    expect(request?.category).toBe("pre_approval_pending")
    expect(request?.severity).toBe("attention")
    expect(request?.reasonCode).toBe("charter_proposal")
    expect(request?.dedupeKey).toBe("charter_proposal:prop-relax-rate")
    expect(request?.runId).toBe("run-charter-1")
    expect(request?.summary).toContain("Charter proposal prop-relax-rate awaiting human approval")

    const results = await consumer.handleEvent(event)
    expect(results).toHaveLength(1)
    expect(adapter.calls).toHaveLength(1)

    const delivered = adapter.calls[0]!
    expect(notificationEnvelopeSchema.safeParse(delivered).success).toBe(true)
    expect(auditNotificationPayload({ seededSecrets: [], envelopes: [delivered] }).passed).toBe(true)
  })

  it("moment 5: controller lease expired produces lease_expired notification", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const adapter = recordingAdapter("tui")
    const bus = createNotificationBus({ store, adapters: [adapter], clock })
    const consumer = createOrchestrationNotificationConsumer(bus)

    const event = {
      schemaVersion: 1,
      eventId: "evt-lease-exp-1",
      sequence: 3,
      projectId: "proj-alpha",
      runId: "run-primary",
      type: "controller.lease.changed",
      payload: {
        lease: {
          leaseId: "lease-node-1",
          controllerNodeId: "node-worker-9",
          epoch: 4,
          expiresAt: FIXED_NOW,
        },
      },
    }

    const request = orchestrationEventToNotification(event)
    expect(request).not.toBeNull()
    expect(notificationRequestSchema.safeParse(request).success).toBe(true)
    expect(request?.category).toBe("lease_expired")
    expect(request?.severity).toBe("critical")
    expect(request?.reasonCode).toBe("lease_expired")
    expect(request?.nodeId).toBe("node-worker-9")

    await consumer.handleEvent(event)
    expect(adapter.calls).toHaveLength(1)
    expect(notificationEnvelopeSchema.safeParse(adapter.calls[0]).success).toBe(true)
  })

  it("moment 6: dispatch failed produces run_failed notification", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const adapter = recordingAdapter("tui")
    const bus = createNotificationBus({ store, adapters: [adapter], clock })
    const consumer = createOrchestrationNotificationConsumer(bus)

    const event = {
      schemaVersion: 1,
      eventId: "evt-disp-fail-1",
      sequence: 4,
      projectId: "proj-alpha",
      runId: "run-failing",
      type: "dispatch.finished",
      payload: {
        dispatchId: "disp-crash-1",
        outcome: "failed",
        summary: "Process exited with code 1",
      },
    }

    const request = orchestrationEventToNotification(event)
    expect(request).not.toBeNull()
    expect(notificationRequestSchema.safeParse(request).success).toBe(true)
    expect(request?.category).toBe("run_failed")
    expect(request?.severity).toBe("critical")
    expect(request?.reasonCode).toBe("run_failed")
    expect(request?.dispatchId).toBe("disp-crash-1")

    await consumer.handleEvent(event)
    expect(adapter.calls).toHaveLength(1)
  })

  it("moment 7: general policy denial produces run_blocked notification", async () => {
    const refusal = {
      runId: "run-restricted",
      taskId: "task-auth",
      ruleId: "rule-no-root",
      reasonCode: "policy_denied",
    }
    const request = dispatchRefusalToNotification(refusal)
    expect(notificationRequestSchema.safeParse(request).success).toBe(true)
    expect(request.category).toBe("run_blocked")
    expect(request.severity).toBe("critical")
    expect(request.reasonCode).toBe("policy_denied")
  })

  it("moment 8: rule conflict detected produces rule_conflict notification", async () => {
    const refusal = {
      runId: "run-conflict",
      ruleId: "rule-conflict-pair",
      reasonCode: "rule_conflict",
    }
    const request = dispatchRefusalToNotification(refusal)
    expect(notificationRequestSchema.safeParse(request).success).toBe(true)
    expect(request.category).toBe("rule_conflict")
    expect(request.severity).toBe("attention")
    expect(request.reasonCode).toBe("rule_conflict")
  })

  it("deduplicates repeated identical moments within retention window", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const adapter = recordingAdapter("tui")
    const bus = createNotificationBus({ store, adapters: [adapter], clock })
    const consumer = createOrchestrationNotificationConsumer(bus)

    const event = {
      type: "roundtable.outcome_recorded",
      runId: "run-1",
      payload: {
        discussionId: "disc-dedupe",
        outcome: { recommendation: "Approve" },
      },
    }

    const first = await consumer.handleEvent(event)
    expect(first[0]?.delivered).toBe(true)
    expect(adapter.calls).toHaveLength(1)

    // Second identical event is deduplicated
    const second = await consumer.handleEvent(event)
    expect(second[0]?.delivered).toBe(false)
    if (second[0] && !second[0].delivered) {
      expect(second[0].reason).toBe("duplicate")
    }
    expect(bus.counters().deduplicated).toBe(1)
  })
})

describe("Event-Driven Guarantee: No Polling Loops", () => {
  it("processes events push-only without background timer loops", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const adapter = recordingAdapter("tui")
    const bus = createNotificationBus({ store, adapters: [adapter], clock })
    const consumer = createOrchestrationNotificationConsumer(bus)

    // Calling handleEvent completes immediately without advancing time
    const initialTime = clock.now()
    await consumer.handleEvent({
      type: "roundtable.outcome_recorded",
      payload: { discussionId: "disc-now", outcome: { recommendation: "ok" } },
    })

    expect(clock.now()).toBe(initialTime)
    expect(adapter.calls).toHaveLength(1)
  })

  it("structurally contains NO setInterval, setTimeout, or setImmediate in src/notifications", () => {
    const files = sourceFiles(NOTIFICATIONS_DIR)
    const timerRegex = /\b(setInterval|setTimeout|setImmediate)\s*\(/
    for (const file of files) {
      const code = stripComments(file.text)
      expect(timerRegex.test(code), `${file.path} contains timer functions (violates event-driven rule)`).toBe(false)
    }
  })
})

describe("Structural Isolation: Boundary Discipline (M4/M5 Style)", () => {
  it("orchestration modules never import from notifications", () => {
    const orchestrationFiles = sourceFiles(join(REPOSITORY_ROOT, "src/orchestration"))
    const offenders = orchestrationFiles
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => specifier.includes("/notifications/") || specifier.includes("notifications"))
    expect(offenders).toEqual([])
  })

  it("rule modules never import from notifications", () => {
    const ruleFiles = sourceFiles(join(REPOSITORY_ROOT, "src/rules"))
    const offenders = ruleFiles
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => specifier.includes("/notifications/") || specifier.includes("notifications"))
    expect(offenders).toEqual([])
  })

  it("budget modules never import from notifications", () => {
    const budgetFiles = sourceFiles(join(REPOSITORY_ROOT, "src/budgets"))
    const offenders = budgetFiles
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => specifier.includes("/notifications/") || specifier.includes("notifications"))
    expect(offenders).toEqual([])
  })

  it("notification module imports NO orchestration command schemas or types", () => {
    const notificationFiles = sourceFiles(NOTIFICATIONS_DIR)
    for (const file of notificationFiles) {
      const code = stripComments(file.text)
      expect(code).not.toContain("orchestrationCommandSchema")
      expect(code).not.toContain("OrchestrationCommand")
    }
  })
})

describe("Behavioral Canary: Notification State Changes Do Not Alter Orchestration Outcomes", () => {

  it("leaves rule evaluation verdicts and decision digest 100% byte-identical across notification mutations", async () => {
    const compiled = compileRuleSet([validRuleDocument({ ruleId: "rule-canary-1" })])
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return

    const context = validContext()

    // 1. Baseline evaluation before any notification state exists
    const baseline = evaluateRules(compiled.value, context)
    const baselineDigest = baseline.decisionDigest
    const baselineDeny = JSON.stringify(baseline.deny)

    // 2. Perform massive notification mutations:
    // - Bus emissions across all categories
    // - Multiple adapters, including throwing adapters
    // - Quieting changes
    // - Store entry accumulation and purging
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const faultyAdapter = throwingAdapter("adapter explosion")
    const recorder = recordingAdapter("recorder")
    const bus = createNotificationBus({
      store,
      adapters: [faultyAdapter, recorder],
      clock,
    })
    const consumer = createOrchestrationNotificationConsumer(bus)

    // Emit 20 notifications including errors, duplicates, and muted entries
    for (let i = 0; i < 10; i++) {
      await consumer.handleEvent({
        type: "roundtable.outcome_recorded",
        payload: { discussionId: `disc-${i}`, outcome: { recommendation: "Deliberate" } },
      })
      await consumer.handleRefusal({
        runId: `run-${i}`,
        reasonCode: "roundtable_required",
      })
    }

    // Change quieting
    bus.setQuieting({ categories: ["run_blocked"], severities: ["critical"], pairs: [] })

    // Emit more under quieting
    await consumer.handleRefusal({ runId: "run-muted", reasonCode: "roundtable_required" })

    // Verify notifications were actually stored and emitted (state is active, not empty)
    expect(store.entries().length).toBeGreaterThan(0)
    expect(bus.counters().emitted).toBeGreaterThan(0)
    expect(bus.counters().adapterErrors).toBeGreaterThan(0)

    // 3. Re-evaluate rules after notification mutations
    const afterMutation = evaluateRules(compiled.value, context)

    // INVARIANT ASSERTION:
    // No notification state change can alter rule evaluation verdict or decision digest!
    expect(afterMutation.decisionDigest).toBe(baselineDigest)
    expect(JSON.stringify(afterMutation.deny)).toBe(baselineDeny)
    expect(afterMutation.traces.length).toBe(baseline.traces.length)
  })

  it("handles throwing adapters silently without affecting caller control flow", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const broken = throwingAdapter("fatal sink crash")
    const bus = createNotificationBus({ store, adapters: [broken], clock })
    const consumer = createOrchestrationNotificationConsumer(bus)

    // Event handling must NEVER throw (N3)
    let threw = false
    try {
      const results = await consumer.handleEvent({
        type: "roundtable.outcome_recorded",
        payload: { discussionId: "disc-safe", outcome: { recommendation: "safe" } },
      })
      expect(results[0]?.delivered).toBe(false)
      if (results[0] && !results[0].delivered) {
        expect(results[0].reason).toBe("adapter_error")
      }
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })
})
