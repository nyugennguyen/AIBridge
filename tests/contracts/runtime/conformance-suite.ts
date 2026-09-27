import { describe, expect, it } from "vitest"
import { digestDispatchEnvelope } from "../../../src/orchestration/digest.js"
import { digestSchema } from "../../../src/orchestration/identifiers.js"
import {
  agentInstallationSchema,
  agentRuntimeEventSchema,
  launchAgentRequestSchema,
  promptRequestSchema,
  runtimeSessionReferenceSchema,
  type RuntimeSession,
  type RuntimeSessionReference,
} from "../../../src/runtime/schemas.js"
import type { AgentRuntimeAdapter } from "../../../src/runtime/types.js"
import {
  createTestLaunchRequest,
  createTestNodeContext,
  createTestOperationContext,
  createTestPromptRequest,
  createTestSessionReference,
  requireFailure,
} from "./conformance-helpers.js"

export interface ConformanceSuiteOptions {
  allowUnload?: boolean
  supportsStructuredPermissions?: boolean
  nodeId?: string
  projectId?: string
  installationId?: string
  runtimeKind?: string
  getSessionReference?: (session: RuntimeSession) => RuntimeSessionReference
}

export function describeAdapterConformance(
  suiteName: string,
  factory: () => Promise<AgentRuntimeAdapter> | AgentRuntimeAdapter,
  options: ConformanceSuiteOptions = {},
): void {
  const defaultNodeId = options.nodeId ?? "node-contract"
  const defaultProjectId = options.projectId ?? "project-contract"
  const defaultInstallationId = options.installationId ?? "installation-contract"
  const defaultRuntimeKind = options.runtimeKind ?? "contract-fake"

  const launchReq = (overrides: Partial<Parameters<typeof createTestLaunchRequest>[0]> = {}) =>
    createTestLaunchRequest({
      nodeId: defaultNodeId,
      projectId: defaultProjectId,
      installationId: defaultInstallationId,
      runtimeKind: defaultRuntimeKind,
      ...overrides,
    })

  describe(`Adapter Conformance: ${suiteName}`, () => {
    it("detects valid installation matching node scope and rejects foreign node", async () => {
      const adapter = await factory()
      const localNode = createTestNodeContext({ nodeId: defaultNodeId })
      const detected = await adapter.detect(localNode)
      expect(detected.ok).toBe(true)
      if (detected.ok) {
        expect(detected.value.length).toBeGreaterThan(0)
        for (const inst of detected.value) {
          expect(() => agentInstallationSchema.parse(inst)).not.toThrow()
          expect(inst.runtimeKind).toBe(adapter.kind)
          expect(inst.capabilities).toBeDefined()
        }
      }

      const foreignNode = createTestNodeContext({ nodeId: "node-foreign-scope-check" })
      const foreignDetected = await adapter.detect(foreignNode)
      if (foreignDetected.ok) {
        expect(foreignDetected.value).toEqual([])
      } else {
        expect(foreignDetected.error.category).toBe("policy_denied")
      }
    })

    it("deduplicates exact launch command and returns cached session", async () => {
      const adapter = await factory()
      const request = await launchReq({ commandId: "cmd-dedup-1" })

      const first = await adapter.launch(request)
      expect(first.ok).toBe(true)
      if (!first.ok) throw new Error("first launch failed")

      const second = await adapter.launch(structuredClone(request))
      expect(second.ok).toBe(true)
      if (!second.ok) throw new Error("second launch failed")

      expect(second.value.sessionId).toBe(first.value.sessionId)
      expect(second.value.dispatchId).toBe(first.value.dispatchId)
    })

    it("rejects duplicate command ID when content changes", async () => {
      const adapter = await factory()
      const request = await launchReq({ commandId: "cmd-conflict-1", prompt: "Original prompt" })
      const first = await adapter.launch(request)
      expect(first.ok).toBe(true)

      const changedEnvelope = {
        ...request.dispatchEnvelope,
        prompt: "Tampered prompt content with same command ID",
      }
      const changed = launchAgentRequestSchema.parse({
        ...request,
        dispatchEnvelope: changedEnvelope,
        dispatchEnvelopeDigest: digestDispatchEnvelope(changedEnvelope),
      })

      const duplicate = await adapter.launch(changed)
      expect(duplicate.ok).toBe(false)
      if (!duplicate.ok) {
        expect(duplicate.error.category).toBe("conflict")
      }
    })

    it("rejects fresh command ID when dispatch is already bound", async () => {
      const adapter = await factory()
      const request = await launchReq({
        commandId: "cmd-first-1",
        dispatchId: "dispatch-bound-1",
      })
      const first = await adapter.launch(request)
      expect(first.ok).toBe(true)

      const rebind = await launchReq({
        commandId: "cmd-rebind-2",
        dispatchId: "dispatch-bound-1",
      })
      const second = await adapter.launch(rebind)
      expect(second.ok).toBe(false)
      if (!second.ok) {
        expect(second.error.category).toBe("conflict")
        expect(second.error.code).toBe("runtime.launch.dispatch_already_bound")
      }
    })

    it("rejects launch with foreign project ID", async () => {
      const adapter = await factory()
      const foreign = await launchReq({
        commandId: "cmd-foreign-proj",
        projectId: "project-foreign-rejected",
      })
      const result = await adapter.launch(foreign)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.category).toBe("policy_denied")
      }
    })

    it("rejects launch when envelope digest does not match content", async () => {
      const adapter = await factory()
      const request = await launchReq({ commandId: "cmd-bad-digest" })
      const tampered = {
        ...request,
        dispatchEnvelopeDigest: digestSchema.parse("sha256:0000000000000000000000000000000000000000000000000000000000000000"),
      }
      const result = await adapter.launch(tampered)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.category).toBe("validation")
      }
    })

    it("restores known session reference and rejects unknown or mismatched handle", async () => {
      const adapter = await factory()
      const request = await launchReq({ commandId: "cmd-restore-1" })
      const launched = await adapter.launch(request)
      expect(launched.ok).toBe(true)
      if (!launched.ok) return

      const session = launched.value
      const reference = options.getSessionReference
        ? options.getSessionReference(session)
        : createTestSessionReference(session)
      const restored = await adapter.restore(reference, request.operation)
      expect(restored.ok).toBe(true)
      if (restored.ok) {
        expect(restored.value.sessionId).toBe(session.sessionId)
      }

      const unknownRef = runtimeSessionReferenceSchema.parse({
        ...reference,
        sessionId: "session-unknown-999",
        adapterMetadata: { handle: "handle-unknown-999" },
      })
      const unknownRestored = await adapter.restore(unknownRef, request.operation)
      expect(unknownRestored.ok).toBe(false)
      if (!unknownRestored.ok) {
        expect(unknownRestored.error.category).toBe("policy_denied")
        expect(unknownRestored.error.code).toBe("runtime.restore.unknown_session")
      }

      const tamperedRef = runtimeSessionReferenceSchema.parse({
        ...reference,
        adapterMetadata: { handle: "forged-handle" },
      })
      const tamperedRestored = await adapter.restore(tamperedRef, request.operation)
      expect(tamperedRestored.ok).toBe(false)
      if (!tamperedRestored.ok) {
        expect(tamperedRestored.error.category).toBe("policy_denied")
        expect(tamperedRestored.error.code).toBe("runtime.restore.reference_mismatch")
      }
    })

    it("deduplicates prompt submission and rejects conflict on altered prompt", async () => {
      const adapter = await factory()
      const request = await launchReq({ commandId: "cmd-prompt-base" })
      const launched = await adapter.launch(request)
      expect(launched.ok).toBe(true)
      if (!launched.ok) return

      const promptReq = createTestPromptRequest(launched.value, "Initial follow-up prompt", "cmd-prompt-1")
      const first = await adapter.prompt(launched.value, promptReq)
      expect(first.ok).toBe(true)

      const duplicate = await adapter.prompt(launched.value, structuredClone(promptReq))
      expect(duplicate.ok).toBe(true)

      const conflictPrompt = promptRequestSchema.parse({
        ...promptReq,
        prompt: "Altered prompt text under same commandId",
      })
      const conflictResult = await adapter.prompt(launched.value, conflictPrompt)
      expect(conflictResult.ok).toBe(false)
      if (!conflictResult.ok) {
        expect(conflictResult.error.category).toBe("conflict")
      }
    })

    it("observes normalized lifecycle events and attaches valid schemas", async () => {
      const adapter = await factory()
      const request = await launchReq({ commandId: "cmd-obs-1" })
      const launched = await adapter.launch(request)
      expect(launched.ok).toBe(true)
      if (!launched.ok) return

      const op = createTestOperationContext("cmd-obs-op", {
        projectId: launched.value.projectId,
        nodeId: launched.value.nodeId,
        dispatchId: launched.value.dispatchId,
        runId: launched.value.runId,
      })

      const events = []
      for await (const eventResult of adapter.observe(launched.value, op)) {
        expect(eventResult.ok).toBe(true)
        if (eventResult.ok) {
          expect(() => agentRuntimeEventSchema.parse(eventResult.value)).not.toThrow()
          events.push(eventResult.value)
        }
      }
      expect(events.length).toBeGreaterThan(0)
    })

    it("does not upgrade idle or missing result evidence to succeeded", async () => {
      const adapter = await factory()
      const request = await launchReq({ commandId: "cmd-res-idle" })
      const launched = await adapter.launch(request)
      expect(launched.ok).toBe(true)
      if (!launched.ok) return

      const op = createTestOperationContext("cmd-res-op", {
        projectId: launched.value.projectId,
        nodeId: launched.value.nodeId,
        dispatchId: launched.value.dispatchId,
        runId: launched.value.runId,
      })

      const result = await adapter.collectResult(launched.value, op)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.outcome).not.toBe("succeeded")
      }
    })

    it("supports interrupt and terminate as distinct operations", async () => {
      const adapter = await factory()
      const request = await launchReq({ commandId: "cmd-control-1" })
      const launched = await adapter.launch(request)
      expect(launched.ok).toBe(true)
      if (!launched.ok) return


      const interruptOp = createTestOperationContext("cmd-interrupt-op", {
        projectId: launched.value.projectId,
        nodeId: launched.value.nodeId,
        dispatchId: launched.value.dispatchId,
        runId: launched.value.runId,
      })
      const interrupted = await adapter.interrupt(launched.value, interruptOp)
      expect(interrupted.ok).toBe(true)

      const terminateOp = createTestOperationContext("cmd-terminate-op", {
        projectId: launched.value.projectId,
        nodeId: launched.value.nodeId,
        dispatchId: launched.value.dispatchId,
        runId: launched.value.runId,
      })
      const terminated = await adapter.terminate(launched.value, terminateOp)
      expect(terminated.ok).toBe(true)
    })
  })
}
