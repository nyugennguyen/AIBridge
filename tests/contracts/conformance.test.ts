import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, expectTypeOf, it } from "vitest"
import { digestDispatchEnvelope } from "../../src/orchestration/digest.js"
import type { Result } from "../../src/orchestration/errors.js"
import {
  launchAgentRequestSchema,
  runtimeOperationContextSchema,
  runtimeSessionReferenceSchema,
  type LaunchAgentRequest,
} from "../../src/runtime/schemas.js"
import type { AgentRuntimeAdapter } from "../../src/runtime/types.js"
import { FakeAgentRuntimeAdapter } from "./fakes.js"
import { DeterministicClock, DeterministicIdSource, requireSuccess } from "./helpers.js"

const examplesDirectory = fileURLToPath(new URL("./examples/", import.meta.url))

async function readExample(name: string): Promise<unknown> {
  return JSON.parse(await readFile(`${examplesDirectory}${name}.v1.json`, "utf8"))
}

async function canonicalLaunchRequest(commandId = "command-contract"): Promise<LaunchAgentRequest> {
  const dispatch = await readExample("dispatch") as { envelope: unknown; envelopeDigest: unknown }
  const approval = await readExample("approval") as { approvalId: unknown }
  return launchAgentRequestSchema.parse({
    schemaVersion: 1,
    operation: {
      schemaVersion: 1,
      commandId,
      correlationId: "correlation-contract",
      projectId: "project-contract",
      runId: "run-contract",
      dispatchId: "dispatch-contract",
      nodeId: "node-contract",
      controllerNodeId: "node-contract",
      controllerEpoch: 1,
      leaseId: "lease-contract",
    },
    dispatchEnvelope: dispatch.envelope,
    dispatchEnvelopeDigest: dispatch.envelopeDigest,
    approvalId: approval.approvalId,
  })
}

function requireFailure<T>(result: Result<T>) {
  if (result.ok) throw new Error("Expected a typed contract failure")
  return result.error
}

describe("M0 contract conformance harness", () => {
  it("exposes deterministic test-only clock and opaque ID sources", () => {
    const clock = new DeterministicClock("2026-09-17T00:00:00.000Z")
    const ids = new DeterministicIdSource()

    expect(clock.now()).toBe("2026-09-17T00:00:00.000Z")
    expect(clock.advance(1_000)).toBe("2026-09-17T00:00:01.000Z")
    expect(ids.next("session")).toBe("session-0001")
    expect(ids.next("session")).toBe("session-0002")
  })

  it("provides a reusable provider-neutral adapter fake", () => {
    const fake: AgentRuntimeAdapter = new FakeAgentRuntimeAdapter()
    expectTypeOf(fake).toMatchTypeOf<AgentRuntimeAdapter>()
    expect(fake.kind).toBe("contract-fake")
  })

  it("deduplicates an exact command without duplicating its launch side effect", async () => {
    const fake = new FakeAgentRuntimeAdapter()
    const request = await canonicalLaunchRequest()

    const first = requireSuccess(await fake.launch(request))
    const retry = requireSuccess(await fake.launch(structuredClone(request)))

    expect(retry).toEqual(first)
    expect(fake.launchSideEffectCount).toBe(1)
  })

  it("rejects a changed duplicate command before it can launch another side effect", async () => {
    const fake = new FakeAgentRuntimeAdapter()
    const request = await canonicalLaunchRequest()
    requireSuccess(await fake.launch(request))

    const changedEnvelope = {
      ...request.dispatchEnvelope,
      prompt: "Changed content under a reused command ID.",
    }
    const changed = launchAgentRequestSchema.parse({
      ...request,
      dispatchEnvelope: changedEnvelope,
      dispatchEnvelopeDigest: digestDispatchEnvelope(changedEnvelope),
    })
    expect(requireFailure(await fake.launch(changed)).category).toBe("conflict")
    expect(fake.launchSideEffectCount).toBe(1)
  })

  it("rejects a syntactically valid request outside the adapter project boundary", async () => {
    const fake = new FakeAgentRuntimeAdapter()
    const request = await canonicalLaunchRequest("command-foreign-project")
    const foreignProjectId = "project-foreign"
    const foreignEnvelope = {
      ...request.dispatchEnvelope,
      projectId: foreignProjectId,
      roleSnapshot: { ...request.dispatchEnvelope.roleSnapshot, projectId: foreignProjectId },
      ruleSnapshots: request.dispatchEnvelope.ruleSnapshots.map((rule) => ({ ...rule, projectId: foreignProjectId })),
    }
    const foreign = launchAgentRequestSchema.parse({
      ...request,
      operation: { ...request.operation, projectId: foreignProjectId },
      dispatchEnvelope: foreignEnvelope,
      dispatchEnvelopeDigest: digestDispatchEnvelope(foreignEnvelope),
    })

    expect(requireFailure(await fake.launch(foreign)).category).toBe("policy_denied")
    expect(fake.launchSideEffectCount).toBe(0)
  })

  it("ADR 0003 / SF-07 / SEC-10: rejects a fresh command ID for an already-bound dispatch", async () => {
    const fake = new FakeAgentRuntimeAdapter()
    const request = await canonicalLaunchRequest()
    const first = requireSuccess(await fake.launch(request))
    const freshCommand = launchAgentRequestSchema.parse({
      ...request,
      operation: { ...request.operation, commandId: "command-contract-fresh" },
    })

    const rejected = requireFailure(await fake.launch(freshCommand))
    expect(rejected).toMatchObject({ category: "conflict", code: "runtime.launch.dispatch_already_bound" })
    expect(fake.launchSideEffectCount).toBe(1)
    expect(first.dispatchId).toBe(request.dispatchEnvelope.dispatchId)
  })

  it("ADR 0001 / SF-02 / SEC-11: restores only a known, exact, in-scope session reference", async () => {
    const fake = new FakeAgentRuntimeAdapter()
    const request = await canonicalLaunchRequest()
    const session = requireSuccess(await fake.launch(request))
    const reference = runtimeSessionReferenceSchema.parse({
      ...session,
      adapterMetadata: { handle: session.sessionId },
    })

    expect(requireSuccess(await fake.restore(reference, request.operation))).toEqual(session)

    const unknown = runtimeSessionReferenceSchema.parse({
      ...reference,
      sessionId: "session-not-recorded",
      adapterMetadata: { handle: "session-not-recorded" },
    })
    expect(requireFailure(await fake.restore(unknown, request.operation))).toMatchObject({
      category: "policy_denied",
      code: "runtime.restore.unknown_session",
    })

    const forged = runtimeSessionReferenceSchema.parse({
      ...reference,
      adapterMetadata: { handle: "forged-provider-handle" },
    })
    expect(requireFailure(await fake.restore(forged, request.operation))).toMatchObject({
      category: "policy_denied",
      code: "runtime.restore.reference_mismatch",
    })

    const foreignReference = runtimeSessionReferenceSchema.parse({ ...reference, projectId: "project-foreign" })
    const foreignOperation = runtimeOperationContextSchema.parse({ ...request.operation, projectId: "project-foreign" })
    expect(requireFailure(await fake.restore(foreignReference, foreignOperation))).toMatchObject({
      category: "policy_denied",
      code: "runtime.restore.reference_mismatch",
    })
    expect(fake.launchSideEffectCount).toBe(1)
  })
})
