import { describe, expect, expectTypeOf, it } from "vitest"
import { canonicalJson, digestDispatchEnvelope, digestJson } from "../../src/orchestration/digest.js"
import { contractErrorSchema } from "../../src/orchestration/errors.js"
import {
  nodeIdSchema,
  projectIdSchema,
  timestampSchema,
  type NodeId,
} from "../../src/orchestration/identifiers.js"
import {
  approvalSchema,
  artifactSchema,
  contextManifestSchema,
  controllerLeaseSchema,
  dispatchEnvelopeSchema,
  dispatchSchema,
  memoryRecordSchema,
  meshSchema,
  nodeSchema,
  orchestrationCommandSchema,
  orchestrationEventSchema,
  permissionEnvelopeSchema,
  projectPathSchema,
  projectSchema,
  roleTemplateSchema,
  ruleSchema,
  runSchema,
  sessionSchema,
  taskSchema,
} from "../../src/orchestration/schemas.js"
import type { OrchestrationCommand, OrchestrationEvent } from "../../src/orchestration/types.js"

const DIGEST = `sha256:${"0".repeat(64)}`
const SECOND_DIGEST = `sha256:${"1".repeat(64)}`
const NOW = "2026-09-16T00:00:00Z"
const LATER = "2026-09-16T00:05:00Z"
const actor = { kind: "user", userId: "user-1" } as const
const reference = { namespace: "legacy.job", id: "job-1" }

const permission = {
  allowedCapabilities: ["read"],
  deniedCapabilities: ["write"],
  approvalRequirements: {
    destructiveEffects: true,
    externalEffects: true,
    capabilities: ["read"],
  },
}

const role = {
  schemaVersion: 1,
  roleId: "role-1",
  templateVersion: 1,
  projectId: "project-1",
  name: "Implementer",
  purpose: "Implement one bounded subsystem.",
  instructions: "Stay within the assigned file ownership.",
  requiredCapabilities: ["read"],
  preferredRuntimeKinds: ["opencode"],
  contextSelectionPolicyReference: { namespace: "policy", id: "least-context-v1" },
  permissionRestrictions: permission,
  author: actor,
  createdAt: NOW,
}

const rule = {
  schemaVersion: 1,
  ruleId: "rule-1",
  templateVersion: 1,
  projectId: "project-1",
  enabled: true,
  match: { requestedCapabilitiesAny: ["read"] },
  effect: {
    kind: "restrict",
    deniedCapabilities: ["write"],
    requireApprovalForDestructiveEffects: true,
    requireApprovalForExternalEffects: true,
  },
  author: actor,
  createdAt: NOW,
}

const contextManifest = {
  references: [
    {
      sourceKind: "memory",
      sourceId: "memory-1",
      contentDigest: DIGEST,
      sensitivity: "internal",
      byteCount: 42,
    },
  ],
  manifestDigest: SECOND_DIGEST,
}

const dispatchEnvelope = {
  schemaVersion: 1,
  dispatchId: "dispatch-1",
  attempt: 1,
  projectId: "project-1",
  runId: "run-1",
  taskId: "task-1",
  targetNodeId: "node-1",
  installationId: "installation-1",
  runtimeKind: "opencode",
  projectPathId: "path-1",
  prompt: "Implement the assigned contract.",
  roleSnapshot: role,
  ruleSnapshots: [rule],
  contextManifest,
  requestedCapabilities: ["read"],
  permissionEnvelope: permission,
  dependencies: [{ taskId: "task-0", failurePolicy: "block" }],
  timeoutSeconds: 600,
  controllerEpoch: 1,
  model: "provider/model",
}

const run = {
  schemaVersion: 1,
  runId: "run-1",
  projectId: "project-1",
  goal: "Complete Milestone 0 contracts.",
  state: "active",
  createdAt: NOW,
  updatedAt: LATER,
  externalReferences: [reference],
}

const task = {
  schemaVersion: 1,
  taskId: "task-1",
  runId: "run-1",
  projectId: "project-1",
  title: "Build orchestration schemas",
  description: "Implement strict version-one schemas.",
  state: "running",
  dependencies: [{ taskId: "task-0", failurePolicy: "block" }],
  externalReferences: [reference],
}

const dispatch = {
  schemaVersion: 1,
  envelope: dispatchEnvelope,
  envelopeDigest: DIGEST,
  state: "approved",
  createdAt: NOW,
  externalReferences: [reference],
}

const approval = {
  schemaVersion: 1,
  approvalId: "approval-1",
  projectId: "project-1",
  runId: "run-1",
  dispatchId: "dispatch-1",
  envelopeDigest: DIGEST,
  decision: "approved",
  basis: { kind: "rule", ruleId: "rule-1", ruleVersion: 1 },
  actor: { kind: "system", name: "policy-engine" },
  decidedAt: NOW,
}

const session = {
  schemaVersion: 1,
  sessionId: "session-1",
  projectId: "project-1",
  runId: "run-1",
  taskId: "task-1",
  dispatchId: "dispatch-1",
  nodeId: "node-1",
  installationId: "installation-1",
  runtimeKind: "opencode",
  state: "working",
  terminalId: "terminal-1",
}

const memory = {
  schemaVersion: 1,
  memoryId: "memory-1",
  projectId: "project-1",
  kind: "finding",
  content: "The contract is strict.",
  contentDigest: DIGEST,
  scope: { kind: "run", runId: "run-1" },
  author: actor,
  createdAt: NOW,
  sourceReferences: [reference],
  trustState: "proposed",
  sensitivity: "internal",
  retention: "project",
}

const artifact = {
  schemaVersion: 1,
  artifactId: "artifact-1",
  projectId: "project-1",
  runId: "run-1",
  dispatchId: "dispatch-1",
  sessionId: "session-1",
  name: "report.json",
  mediaType: "application/json",
  digest: DIGEST,
  byteCount: 42,
  source: { kind: "session", sessionId: "session-1" },
  location: { kind: "external_reference", reference: { namespace: "object-store", id: "report-1" } },
}

const lease = {
  schemaVersion: 1,
  leaseId: "lease-1",
  projectId: "project-1",
  runId: "run-1",
  controllerNodeId: "node-controller",
  epoch: 1,
  issuedAt: NOW,
  expiresAt: LATER,
}

function cloneEnvelope(): Record<string, unknown> {
  return structuredClone(dispatchEnvelope)
}

describe("version 1 orchestration records", () => {
  it("parses every aggregate as a strict versioned record", () => {
    const projectPath = {
      schemaVersion: 1,
      projectPathId: "path-1",
      projectId: "project-1",
      nodeId: "node-1",
      configuredPath: "/srv/project",
      allowedCapabilities: ["read"],
    }

    const records: Array<[string, { parse(value: unknown): unknown }, unknown]> = [
      ["mesh", meshSchema, { schemaVersion: 1, meshId: "mesh-1", displayName: "Private mesh", createdAt: NOW }],
      [
        "node",
        nodeSchema,
        {
          schemaVersion: 1,
          nodeId: "node-1",
          meshId: "mesh-1",
          displayName: "Worker",
          enrollment: { status: "enrolled", enrolledAt: NOW },
          externalReferences: [reference],
        },
      ],
      ["project path", projectPathSchema, projectPath],
      ["project", projectSchema, { schemaVersion: 1, projectId: "project-1", meshId: "mesh-1", name: "AIBridge", pathBindings: [projectPath] }],
      ["run", runSchema, run],
      ["task", taskSchema, task],
      ["role", roleTemplateSchema, role],
      ["rule", ruleSchema, rule],
      ["permissions", permissionEnvelopeSchema, permission],
      ["context", contextManifestSchema, contextManifest],
      ["dispatch envelope", dispatchEnvelopeSchema, dispatchEnvelope],
      ["dispatch", dispatchSchema, dispatch],
      ["approval", approvalSchema, approval],
      ["session", sessionSchema, session],
      ["memory", memoryRecordSchema, memory],
      ["artifact", artifactSchema, artifact],
      ["controller lease", controllerLeaseSchema, lease],
    ]

    for (const [name, schema, value] of records) {
      expect(schema.parse(value), name).toBeDefined()
    }
  })

  it("rejects missing, future, and unknown record fields", () => {
    expect(meshSchema.safeParse({ meshId: "mesh-1", displayName: "Mesh", createdAt: NOW }).success).toBe(false)
    expect(meshSchema.safeParse({ schemaVersion: 2, meshId: "mesh-1", displayName: "Mesh", createdAt: NOW }).success).toBe(false)
    expect(meshSchema.safeParse({ schemaVersion: 1, meshId: "mesh-1", displayName: "Mesh", createdAt: NOW, trusted: true }).success).toBe(false)
  })

  it("enforces bounded strings, arrays, timestamps, and safe counters", () => {
    expect(meshSchema.safeParse({ schemaVersion: 1, meshId: "mesh-1", displayName: "x".repeat(257), createdAt: NOW }).success).toBe(false)
    expect(runSchema.safeParse({ ...run, goal: "x".repeat(65_537) }).success).toBe(false)
    expect(
      nodeSchema.safeParse({
        schemaVersion: 1,
        nodeId: "node-1",
        meshId: "mesh-1",
        displayName: "Worker",
        enrollment: { status: "enrolled", enrolledAt: NOW },
        externalReferences: Array.from({ length: 129 }, (_, index) => ({ namespace: "test", id: `ref-${index}` })),
      }).success,
    ).toBe(false)
    expect(timestampSchema.safeParse("2026-02-30T00:00:00Z").success).toBe(false)
    expect(timestampSchema.safeParse("2026-09-16T07:00:00+07:00").success).toBe(false)
    expect(dispatchEnvelopeSchema.safeParse({ ...dispatchEnvelope, attempt: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false)
    expect(dispatchEnvelopeSchema.safeParse({ ...dispatchEnvelope, timeoutSeconds: 86_401 }).success).toBe(false)
    expect(contextManifestSchema.safeParse({ references: [], manifestDigest: "SHA256:BAD" }).success).toBe(false)
  })

  it("rejects observable identity and temporal mismatches", () => {
    const mismatchedPath = {
      schemaVersion: 1,
      projectPathId: "path-1",
      projectId: "project-other",
      nodeId: "node-1",
      configuredPath: "/srv/project",
      allowedCapabilities: [],
    }
    expect(projectSchema.safeParse({ schemaVersion: 1, projectId: "project-1", meshId: "mesh-1", name: "Project", pathBindings: [mismatchedPath] }).success).toBe(false)
    expect(taskSchema.safeParse({ ...task, dependencies: [{ taskId: "task-1", failurePolicy: "block" }] }).success).toBe(false)
    expect(taskSchema.safeParse({ ...task, dependencies: [{ taskId: "task-0", failurePolicy: "block" }, { taskId: "task-0", failurePolicy: "fail" }] }).success).toBe(false)
    expect(dispatchEnvelopeSchema.safeParse({ ...dispatchEnvelope, roleSnapshot: { ...role, projectId: "project-other" } }).success).toBe(false)
    expect(controllerLeaseSchema.safeParse({ ...lease, expiresAt: NOW }).success).toBe(false)
    expect(artifactSchema.safeParse({ ...artifact, source: { kind: "session", sessionId: "session-other" } }).success).toBe(false)
  })

  it("does not mistake schema validity for live authorization", () => {
    const syntacticallyValidUnknownNode = nodeSchema.parse({
      schemaVersion: 1,
      nodeId: "not-present-in-any-live-registry",
      meshId: "mesh-1",
      displayName: "Unverified assertion",
      enrollment: { status: "enrolled", enrolledAt: NOW },
      externalReferences: [],
    })

    expect(syntacticallyValidUnknownNode.enrollment.status).toBe("enrolled")
    expect(syntacticallyValidUnknownNode.nodeId).toBe("not-present-in-any-live-registry")
  })
})

describe("strict event and command unions", () => {
  const eventCommon = {
    schemaVersion: 1,
    eventId: "event-1",
    sequence: 1,
    projectId: "project-1",
    runId: "run-1",
    actor,
    occurredAt: NOW,
    correlationId: "correlation-1",
    causation: null,
    controllerEpoch: 1,
  }

  it("accepts all required event variants with typed payloads", () => {
    const events = [
      { ...eventCommon, type: "run.created", payload: { run } },
      { ...eventCommon, type: "task.created", payload: { task } },
      { ...eventCommon, type: "dispatch.proposed", payload: { dispatch } },
      { ...eventCommon, type: "approval.decided", payload: { approval } },
      { ...eventCommon, type: "dispatch.started", payload: { session } },
      { ...eventCommon, type: "dispatch.finished", payload: { dispatchId: "dispatch-1", sessionId: "session-1", outcome: "completed", summary: "Done" } },
      { ...eventCommon, type: "session.observed", payload: { session } },
      { ...eventCommon, type: "memory.proposed", payload: { memory } },
      { ...eventCommon, type: "memory.accepted", payload: { memory: { ...memory, trustState: "accepted" } } },
      { ...eventCommon, type: "artifact.registered", payload: { artifact } },
      { ...eventCommon, type: "controller.lease.changed", payload: { lease } },
      { ...eventCommon, type: "legacy.imported", payload: { recordKind: "job", reference, disposition: "historical" } },
    ]

    for (const event of events) expect(orchestrationEventSchema.parse(event)).toBeDefined()
    expectTypeOf(orchestrationEventSchema.parse(events[0])).toEqualTypeOf<OrchestrationEvent>()
  })

  it("rejects generic, mismatched, and wrong-version event payloads", () => {
    expect(orchestrationEventSchema.safeParse({ ...eventCommon, type: "task.created", payload: { arbitrary: true } }).success).toBe(false)
    expect(orchestrationEventSchema.safeParse({ ...eventCommon, schemaVersion: 2, type: "run.created", payload: { run } }).success).toBe(false)
    expect(orchestrationEventSchema.safeParse({ ...eventCommon, projectId: "project-other", type: "task.created", payload: { task } }).success).toBe(false)
    expect(orchestrationEventSchema.safeParse({ ...eventCommon, controllerEpoch: 2, type: "controller.lease.changed", payload: { lease } }).success).toBe(false)
  })

  const commandCommon = {
    schemaVersion: 1,
    commandId: "command-1",
    projectId: "project-1",
    runId: "run-1",
    actor,
    controllerNodeId: "node-controller",
    controllerEpoch: 1,
    leaseId: "lease-1",
    issuedAt: NOW,
    expiresAt: LATER,
    correlationId: "correlation-1",
    causation: { kind: "event", eventId: "event-1" },
  }

  it("accepts all required command variants with typed payloads", () => {
    const commands = [
      { ...commandCommon, type: "dispatch.execute", payload: { dispatch, approval } },
      { ...commandCommon, type: "session.prompt", payload: { sessionId: "session-1", prompt: "Continue." } },
      { ...commandCommon, type: "session.respond", payload: { sessionId: "session-1", requestId: "request-1", decision: "allow_once" } },
      { ...commandCommon, type: "session.interrupt", payload: { sessionId: "session-1", reason: "Pause now." } },
      { ...commandCommon, type: "session.terminate", payload: { sessionId: "session-1", reason: "Stop now." } },
      { ...commandCommon, type: "run.cancel", payload: { reason: "User cancelled." } },
    ]

    for (const command of commands) expect(orchestrationCommandSchema.parse(command)).toBeDefined()
    expectTypeOf(orchestrationCommandSchema.parse(commands[0])).toEqualTypeOf<OrchestrationCommand>()
  })

  it("rejects expired authority and mismatched execution evidence", () => {
    expect(orchestrationCommandSchema.safeParse({ ...commandCommon, expiresAt: NOW, type: "run.cancel", payload: { reason: "Cancel" } }).success).toBe(false)
    expect(
      orchestrationCommandSchema.safeParse({
        ...commandCommon,
        type: "dispatch.execute",
        payload: { dispatch, approval: { ...approval, envelopeDigest: SECOND_DIGEST } },
      }).success,
    ).toBe(false)
    expect(orchestrationCommandSchema.safeParse({ ...commandCommon, type: "session.prompt", payload: { sessionId: "session-1", arbitrary: true } }).success).toBe(false)
  })
})

describe("canonical JSON and immutable dispatch digest", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(canonicalJson({ z: 1, a: { y: true, x: [3, 2, 1] } })).toBe('{"a":{"x":[3,2,1],"y":true},"z":1}')
    expect(digestJson({ b: 2, a: 1 })).toBe(digestJson({ a: 1, b: 2 }))
    expect(digestJson({ values: [1, 2] })).not.toBe(digestJson({ values: [2, 1] }))
  })

  it("rejects values outside the JSON data model", () => {
    expect(() => canonicalJson({ missing: undefined })).toThrow(TypeError)
    expect(() => canonicalJson({ invalid: Number.NaN })).toThrow(TypeError)
    expect(() => canonicalJson(new Date(NOW))).toThrow(TypeError)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => canonicalJson(cyclic)).toThrow(TypeError)
    expect(() => canonicalJson(new Array(1))).toThrow(TypeError)
  })

  it("rejects unknown envelope keys instead of omitting them from the digest", () => {
    expect(() => digestDispatchEnvelope({ ...dispatchEnvelope, credential: "must-not-be-hashed" })).toThrow()
  })

  it("changes when each material envelope area changes", () => {
    const baseline = digestDispatchEnvelope(dispatchEnvelope)
    const mutations: Array<(value: any) => void> = [
      (value) => { value.dispatchId = "dispatch-2" },
      (value) => { value.attempt = 2 },
      (value) => {
        value.projectId = "project-2"
        value.roleSnapshot.projectId = "project-2"
        value.ruleSnapshots[0].projectId = "project-2"
      },
      (value) => { value.runId = "run-2" },
      (value) => { value.taskId = "task-2" },
      (value) => { value.targetNodeId = "node-2" },
      (value) => { value.installationId = "installation-2" },
      (value) => { value.runtimeKind = "other-runtime" },
      (value) => { value.projectPathId = "path-2" },
      (value) => { value.prompt = "A changed prompt." },
      (value) => { value.roleSnapshot.name = "Reviewer" },
      (value) => { value.ruleSnapshots[0].enabled = false },
      (value) => { value.contextManifest.references[0].byteCount = 43 },
      (value) => { value.requestedCapabilities = ["read", "write"] },
      (value) => { value.permissionEnvelope.approvalRequirements.destructiveEffects = false },
      (value) => { value.dependencies[0].failurePolicy = "fail" },
      (value) => { value.timeoutSeconds = 601 },
      (value) => { value.controllerEpoch = 2 },
      (value) => { value.model = "provider/other-model" },
    ]

    for (const mutate of mutations) {
      const changed = cloneEnvelope()
      mutate(changed)
      expect(digestDispatchEnvelope(changed)).not.toBe(baseline)
    }
  })
})

describe("branded identifiers and shared errors", () => {
  it("keeps identifier domains separate at compile time", () => {
    const nodeId = nodeIdSchema.parse("same-spelling")
    const projectId = projectIdSchema.parse("same-spelling")
    const acceptsNodeId = (value: NodeId): NodeId => value

    expect(acceptsNodeId(nodeId)).toBe("same-spelling")
    // @ts-expect-error A ProjectId must never be assignable to NodeId.
    acceptsNodeId(projectId)
  })

  it("parses only the frozen bounded error taxonomy", () => {
    expect(
      contractErrorSchema.parse({
        schemaVersion: 1,
        category: "unsupported_capability",
        code: "runtime.restore.unsupported",
        message: "Restore is not supported by this runtime.",
        retryable: false,
      }).category,
    ).toBe("unsupported_capability")
    expect(contractErrorSchema.safeParse({ schemaVersion: 1, category: "unknown", code: "bad", message: "Bad", retryable: true }).success).toBe(false)
    expect(contractErrorSchema.safeParse({ schemaVersion: 1, category: "stale_epoch", code: "stale", message: "Stale", retryable: true }).success).toBe(false)
    expect(contractErrorSchema.safeParse({ schemaVersion: 1, category: "validation", code: "bad", message: "Bad", retryable: false, stack: "secret" }).success).toBe(false)
  })
})
