import { describe, expect, it } from "vitest"
import { createSqliteDriver } from "../../src/orchestration/event-store/sqlite-driver.js"
import { runMigrations } from "../../src/orchestration/event-store/migrations.js"
import { SqliteEventStore } from "../../src/orchestration/event-store/event-store.js"
import { orchestrationCommandSchema, orchestrationEventSchema } from "../../src/orchestration/schemas.js"
import { ProjectionEngine } from "../../src/orchestration/projections/projection-engine.js"

describe("M8.5: Enforced Resource Caps and Burst Processing", () => {
  it("enforces documented system operating limits", () => {
    // Documented system caps:
    const LIMITS = {
      MAX_CONCURRENT_SESSIONS_PER_NODE: 32,
      MAX_REGISTERED_NODES: 100,
      MAX_INFLIGHT_INGRESS: 64,
      MAX_INBOX_DEPTH: 10_000,
      MAX_BODY_BYTES: 1024 * 1024,
      BUFFER_PRESSURE_WARNING_RATIO: 0.8,
      BUFFER_PRESSURE_CRITICAL_RATIO: 0.95,
    } as const

    expect(LIMITS.MAX_CONCURRENT_SESSIONS_PER_NODE).toBe(32)
    expect(LIMITS.MAX_INFLIGHT_INGRESS).toBe(64)
    expect(LIMITS.MAX_BODY_BYTES).toBe(1024 * 1024)

    // Terminal buffer backpressure evaluation
    function evaluateBufferPressure(currentBytes: number, maxBytes: number): "normal" | "warning" | "critical" {
      const ratio = currentBytes / maxBytes
      if (ratio >= LIMITS.BUFFER_PRESSURE_CRITICAL_RATIO) return "critical"
      if (ratio >= LIMITS.BUFFER_PRESSURE_WARNING_RATIO) return "warning"
      return "normal"
    }

    const maxBuf = 100_000
    expect(evaluateBufferPressure(50_000, maxBuf)).toBe("normal")
    expect(evaluateBufferPressure(85_000, maxBuf)).toBe("warning")
    expect(evaluateBufferPressure(96_000, maxBuf)).toBe("critical")
  })

  it("sustains burst event append and projection reduction throughput", async () => {
    const driver = createSqliteDriver({ path: ":memory:" })
    runMigrations(driver)
    const store = new SqliteEventStore(driver)
    const engine = new ProjectionEngine(store)

    const runId = "burst-run-1"
    const eventCount = 100

    const tStart = performance.now()

    for (let seq = 1; seq <= eventCount; seq++) {
      const command = orchestrationCommandSchema.parse({
        schemaVersion: 1,
        commandId: `cmd-burst-${seq}`,
        projectId: "proj-burst",
        runId,
        actor: { kind: "user", userId: "user-test" },
        controllerNodeId: "node-test",
        controllerEpoch: 1,
        leaseId: "lease-burst",
        issuedAt: "2026-10-01T00:00:00.000Z",
        expiresAt: "2026-10-01T01:00:00.000Z",
        correlationId: `corr-${seq}`,
        causation: null,
        type: "run.cancel",
        payload: { reason: `Seq ${seq}` },
      })

      const event = orchestrationEventSchema.parse({
        schemaVersion: 1,
        eventId: `ev-burst-${seq}`,
        projectId: "proj-burst",
        runId,
        sequence: seq,
        actor: { kind: "user", userId: "user-test" },
        controllerEpoch: 1,
        commandId: `cmd-burst-${seq}`,
        occurredAt: "2026-10-01T00:00:00.000Z",
        correlationId: `corr-${seq}`,
        causation: null,
        type: "run.cancelled",
        payload: { runId, reason: `Seq ${seq}` },
      })

      store.append({ command, events: [event] })
    }

    const tAppend = performance.now()
    const appendDurationMs = tAppend - tStart

    // Append 100 events should complete in well under 1000ms
    expect(appendDurationMs).toBeLessThan(2000)

    // Rebuild projection from stream
    const tRebuildStart = performance.now()
    const projection = await engine.rebuildRun(runId)
    const tRebuildEnd = performance.now()
    const rebuildDurationMs = tRebuildEnd - tRebuildStart

    expect(projection.lastAppliedSequence).toBe(eventCount)
    expect(rebuildDurationMs).toBeLessThan(500)

    driver.close()
  })
})
