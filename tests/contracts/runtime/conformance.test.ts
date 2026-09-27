import { describe, expect, it } from "vitest"
import type { LaunchAgentRequest, RuntimeOperationContext, RuntimeSession, RuntimeSessionReference } from "../../../src/runtime/schemas.js"
import type { AgentRuntimeAdapter } from "../../../src/runtime/types.js"
import { FakeAgentRuntimeAdapter } from "../fakes.js"
import { BrokenAgentRuntimeAdapter } from "./broken-adapter.js"
import { describeAdapterConformance } from "./conformance-suite.js"
import {
  createTestLaunchRequest,
  createTestOperationContext,
  createTestSessionReference,
} from "./conformance-helpers.js"

// Invariant verification assertions
async function assertCompletionEvidenceInvariant(
  adapter: AgentRuntimeAdapter,
  session: RuntimeSession,
  op: RuntimeOperationContext,
): Promise<void> {
  const result = await adapter.collectResult(session, op)
  if (result.ok && result.value.outcome === "succeeded") {
    throw new Error("Invariant Violation: Adapter claimed succeeded without verified completion evidence")
  }
}

async function assertRestoreScopeInvariant(
  adapter: AgentRuntimeAdapter,
  reference: RuntimeSessionReference,
  op: RuntimeOperationContext,
): Promise<void> {
  const restored = await adapter.restore(reference, op)
  if (restored.ok) {
    throw new Error("Invariant Violation: Adapter restored unknown session reference")
  }
}

async function assertProjectScopeInvariant(
  adapter: AgentRuntimeAdapter,
  foreignRequest: LaunchAgentRequest,
): Promise<void> {
  const launched = await adapter.launch(foreignRequest)
  if (launched.ok) {
    throw new Error("Invariant Violation: Adapter permitted launch outside authorized project boundary")
  }
}

async function assertDispatchBindingInvariant(
  adapter: AgentRuntimeAdapter,
  first: LaunchAgentRequest,
  second: LaunchAgentRequest,
): Promise<void> {
  await adapter.launch(first)
  const duplicate = await adapter.launch(second)
  if (duplicate.ok) {
    throw new Error("Invariant Violation: Adapter permitted rebinding already-bound dispatch")
  }
}

describe("M2 Provider-Neutral Adapter Conformance", () => {
  // 1. Verify FakeAgentRuntimeAdapter passes the complete conformance suite
  describeAdapterConformance("FakeAgentRuntimeAdapter", () => new FakeAgentRuntimeAdapter())

  // 2. Negative testing: Verify broken adapters fail each required invariant
  describe("Flaw Injection on Broken Adapters", () => {
    it("fails when an adapter claims success on idle/exit without completion evidence", async () => {
      const broken = new BrokenAgentRuntimeAdapter({ fakeSuccessOnIdle: true })
      const request = await createTestLaunchRequest({ commandId: "broken-cmd-1" })
      const launched = await broken.launch(request)
      expect(launched.ok).toBe(true)
      if (!launched.ok) return

      const op = createTestOperationContext("broken-op-1")
      await expect(assertCompletionEvidenceInvariant(broken, launched.value, op)).rejects.toThrow(
        "Invariant Violation: Adapter claimed succeeded without verified completion evidence",
      )
    })

    it("fails when an adapter allows restoring an unknown session reference", async () => {
      const broken = new BrokenAgentRuntimeAdapter({ allowUnknownRestore: true })
      const request = await createTestLaunchRequest({ commandId: "broken-cmd-2" })
      const launched = await broken.launch(request)
      expect(launched.ok).toBe(true)
      if (!launched.ok) return

      const unknownRef = createTestSessionReference(launched.value, "completely-unknown-session-handle")
      const op = createTestOperationContext("broken-op-2")
      await expect(assertRestoreScopeInvariant(broken, unknownRef, op)).rejects.toThrow(
        "Invariant Violation: Adapter restored unknown session reference",
      )
    })

    it("fails when an adapter ignores project scope boundaries", async () => {
      const broken = new BrokenAgentRuntimeAdapter({ ignoreProjectScope: true })
      const foreignRequest = await createTestLaunchRequest({
        commandId: "broken-cmd-3",
        projectId: "foreign-unauthorized-project",
      })
      await expect(assertProjectScopeInvariant(broken, foreignRequest)).rejects.toThrow(
        "Invariant Violation: Adapter permitted launch outside authorized project boundary",
      )
    })

    it("fails when an adapter allows rebinding an already-bound dispatch", async () => {
      const broken = new BrokenAgentRuntimeAdapter({ allowRebindDispatch: true })
      const first = await createTestLaunchRequest({
        commandId: "broken-first",
        dispatchId: "dispatch-bound-shared",
      })
      const second = await createTestLaunchRequest({
        commandId: "broken-second",
        dispatchId: "dispatch-bound-shared",
      })
      await expect(assertDispatchBindingInvariant(broken, first, second)).rejects.toThrow(
        "Invariant Violation: Adapter permitted rebinding already-bound dispatch",
      )
    })
  })
})
