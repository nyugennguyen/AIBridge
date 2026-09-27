import { describe, expect, it } from "vitest"
import { createLifecycleScript } from "./lifecycle-dsl.js"
import { ScriptedAgentRuntimeAdapter } from "./scripted-adapter.js"
import { createTestLaunchRequest, createTestOperationContext } from "./conformance-helpers.js"

describe("Lifecycle Script DSL & Scripted Adapter", () => {
  it("builds a scripted lifecycle timeline with source and confidence metadata", () => {
    const script = createLifecycleScript("standard-progression")
      .starting("Initializing environment")
      .working("Running tests")
      .blocked("perm-101", "filesystem.write")
      .completed("All tests passed cleanly")
      .build()

    expect(script.name).toBe("standard-progression")
    expect(script.steps.length).toBe(6) // starting, working, blocked (state+req), completed (result+state)
    expect(script.steps[0]).toMatchObject({ type: "state", state: "starting", source: "hook", confidence: "authoritative" })
    expect(script.steps[1]).toMatchObject({ type: "state", state: "working" })
  })

  it("yields scripted events and reports completion evidence through the runtime adapter contract", async () => {
    const script = createLifecycleScript("success-scenario")
      .starting("Starting up")
      .working("Compiling source")
      .completed("Build succeeded")
      .build()

    const adapter = new ScriptedAgentRuntimeAdapter({ script })
    const request = await createTestLaunchRequest({ commandId: "script-cmd-1" })
    const launched = await adapter.launch(request)
    expect(launched.ok).toBe(true)
    if (!launched.ok) return

    const op = createTestOperationContext("script-op-1")
    const observedEvents = []
    for await (const eventResult of adapter.observe(launched.value, op)) {
      expect(eventResult.ok).toBe(true)
      if (eventResult.ok) {
        observedEvents.push(eventResult.value)
      }
    }

    expect(observedEvents.length).toBe(4) // starting, working, result_available, completed
    const firstEvent = observedEvents[0]
    expect(firstEvent.type).toBe("lifecycle")
    if (firstEvent.type === "lifecycle") {
      expect(firstEvent.state).toBe("starting")
      expect(firstEvent.source).toBe("hook")
      expect(firstEvent.confidence).toBe("authoritative")
    }

    const result = await adapter.collectResult(launched.value, op)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.outcome).toBe("succeeded")
      expect(result.value.summary).toBe("Build succeeded")
    }
  })

  it("degrades to unknown on simulated disconnect and never fabricates completed", async () => {
    const script = createLifecycleScript("disconnect-scenario")
      .starting("Starting up")
      .working("Fetching dependencies")
      .disconnect()
      .build()

    const adapter = new ScriptedAgentRuntimeAdapter({ script })
    const request = await createTestLaunchRequest({ commandId: "script-cmd-disconnect" })
    const launched = await adapter.launch(request)
    expect(launched.ok).toBe(true)
    if (!launched.ok) return

    const op = createTestOperationContext("script-op-2")
    const observedEvents = []
    for await (const eventResult of adapter.observe(launched.value, op)) {
      expect(eventResult.ok).toBe(true)
      if (eventResult.ok) observedEvents.push(eventResult.value)
    }

    const lastEvent = observedEvents[observedEvents.length - 1]
    expect(lastEvent.type).toBe("lifecycle")
    if (lastEvent.type === "lifecycle") {
      expect(lastEvent.state).toBe("unknown")
      expect(lastEvent.detail).toContain("disconnect")
    }

    // collectResult must remain unknown
    const result = await adapter.collectResult(launched.value, op)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.outcome).toBe("unknown")
    }
  })
})
