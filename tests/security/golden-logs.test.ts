import { describe, expect, it } from "vitest"
import { StructuredLogger } from "../../src/observability/logger.js"
import type { LogEventName, StructuredLogEntry } from "../../src/observability/types.js"

describe("Golden Logs Contract and Correlation Fields (M8.3)", () => {
  it("enforces stable event names and required correlation fields across log lifecycle", () => {
    const entries: StructuredLogEntry[] = []
    const rootLogger = new StructuredLogger({
      writer: (line) => entries.push(JSON.parse(line) as StructuredLogEntry),
      context: {
        nodeId: "node-primary-01",
        controllerEpoch: 3,
      },
    })

    // Child logger inherits correlation context and appends dispatch/job specifics
    const runLogger = rootLogger.child({
      runId: "run-golden-100",
      projectId: "proj-golden-alpha",
    })

    const jobLogger = runLogger.child({
      jobId: "job-golden-42",
      correlationId: "corr-trace-999",
      dispatchId: "disp-seq-1",
    })

    // 1. Ingress event
    jobLogger.info("ingress.admitted", {
      durationMs: 12,
      result: "success",
    })

    // 2. Outbox event
    jobLogger.info("outbox.claimed", {
      durationMs: 5,
      result: "success",
    })

    // 3. Outbox delivery
    jobLogger.info("outbox.delivered", {
      durationMs: 45,
      result: "success",
    })

    // 4. Rule denial event
    jobLogger.warn("rule.denied", {
      durationMs: 2,
      result: "denied",
      errorCode: "RULE_DENIAL_APPROVAL_REQUIRED",
    })

    expect(entries.length).toBe(4)

    const expectedEvents: LogEventName[] = [
      "ingress.admitted",
      "outbox.claimed",
      "outbox.delivered",
      "rule.denied",
    ]

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!
      expect(entry.event).toBe(expectedEvents[i])
      expect(entry.timestamp).toBeTruthy()

      // Mandatory correlation tracing fields
      expect(entry.nodeId).toBe("node-primary-01")
      expect(entry.controllerEpoch).toBe(3)
      expect(entry.runId).toBe("run-golden-100")
      expect(entry.projectId).toBe("proj-golden-alpha")
      expect(entry.jobId).toBe("job-golden-42")
      expect(entry.correlationId).toBe("corr-trace-999")
      expect(entry.dispatchId).toBe("disp-seq-1")

      // Metadata
      expect(entry.durationMs).toBeGreaterThan(0)
      expect(entry.result).toBeTruthy()
    }
  })

  it("retains recent errors in ring buffer for diagnostics bundle inspection", () => {
    const logger = new StructuredLogger({ bufferCapacity: 10 })

    logger.info("inbox.received", { jobId: "job-1" })
    logger.error("outbox.failed", { jobId: "job-1", errorCode: "PEER_TIMEOUT" })
    logger.warn("rule.denied", { jobId: "job-2", errorCode: "RULE_CEILING" })
    logger.info("outbox.delivered", { jobId: "job-3" })

    const recentErrors = logger.getRecentErrors()
    expect(recentErrors.length).toBe(2)
    expect(recentErrors[0]?.event).toBe("outbox.failed")
    expect(recentErrors[1]?.event).toBe("rule.denied")
  })
})
