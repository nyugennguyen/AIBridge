import { describe, expect, it } from "vitest"
import { digestDispatchEnvelope } from "../../../src/orchestration/digest.js"
import { launchAgentRequestSchema, nodeContextSchema, promptRequestSchema, runtimeOperationContextSchema } from "../../../src/runtime/schemas.js"
import { approvalIdSchema, eventIdSchema } from "../../../src/orchestration/identifiers.js"
import { OpencodeRuntimeAdapter } from "../../../src/runtime/opencode-adapter.js"
import type { OpencodeClient, OpencodeEvent, OpencodePromptPolicy, PermissionDecision, SessionStatus } from "../../../src/opencode/types.js"
import { describeAdapterConformance } from "../../contracts/runtime/conformance-suite.js"

class FakeClient implements OpencodeClient {
  healthResult = true
  status: SessionStatus = "idle"
  events: OpencodeEvent[] = []
  creates = 0
  prompts = 0
  policies: Array<OpencodePromptPolicy | undefined> = []
  aborts = 0
  replies: Array<{ sessionId: string; permissionId: string; response: PermissionDecision }> = []

  async health() { return this.healthResult }
  async createSession() { this.creates += 1; return { id: `provider-${this.creates}` } }
  async sendPromptAsync(_sessionId: string, _prompt: string, _directory: string, policy?: OpencodePromptPolicy) { this.prompts += 1; this.policies.push(policy) }
  async subscribeEvents(): Promise<AsyncIterable<OpencodeEvent>> {
    const events = [...this.events]
    return (async function* () { yield* events })()
  }
  async getSessionStatus() { return this.status }
  async replyPermission(sessionId: string, permissionId: string, response: PermissionDecision) { this.replies.push({ sessionId, permissionId, response }) }
  async abortSession() { this.aborts += 1 }
}

function setup(baseUrl = "http://127.0.0.1:4096") {
  const client = new FakeClient()
  let number = 0
  const adapter = new OpencodeRuntimeAdapter({
    client,
    baseUrl,
    nodeId: "node-local",
    installationId: "installation-local",
    projects: {
      async resolve(scope) {
        if (scope.projectId !== "project-local") {
          return {
            ok: false,
            error: {
              schemaVersion: 1,
              category: "policy_denied",
              code: "runtime.launch.project_scope",
              message: "Foreign project rejected",
              retryable: false,
            },
          }
        }
        return { ok: true as const, value: "/workspace/local" }
      },
    },
    now: () => "2026-09-17T00:00:00.000Z",
    nextId: (kind) => `${kind}-${++number}`,
  })
  return { adapter, client }
}

function launch(commandId = "command-launch") {
  const envelope = {
    schemaVersion: 1 as const,
    dispatchId: "dispatch-local",
    attempt: 1,
    projectId: "project-local",
    runId: "run-local",
    taskId: "task-local",
    targetNodeId: "node-local",
    installationId: "installation-local",
    runtimeKind: "opencode",
    projectPathId: "path-local",
    prompt: "Inspect the local project.",
    roleSnapshot: {
      schemaVersion: 1 as const,
      roleId: "role-local",
      templateVersion: 1,
      projectId: "project-local",
      name: "Local role",
      purpose: "Perform a local task.",
      instructions: "Use only the local project.",
      requiredCapabilities: ["filesystem.read"],
      preferredRuntimeKinds: ["opencode"],
      contextSelectionPolicyReference: { namespace: "test", id: "local" },
      permissionRestrictions: {
        allowedCapabilities: ["filesystem.read"],
        deniedCapabilities: ["network.external"],
        approvalRequirements: { destructiveEffects: true, externalEffects: true, capabilities: [] },
      },
      author: { kind: "system" as const, name: "test" },
      createdAt: "2026-09-17T00:00:00.000Z",
    },
    ruleSnapshots: [],
    contextManifest: { references: [], manifestDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" },
    requestedCapabilities: ["filesystem.read"],
    permissionEnvelope: {
      allowedCapabilities: ["filesystem.read"],
      deniedCapabilities: ["network.external"],
      approvalRequirements: { destructiveEffects: true, externalEffects: true, capabilities: [] },
    },
    dependencies: [],
    timeoutSeconds: 60,
    controllerEpoch: 1,
  }
  return launchAgentRequestSchema.parse({
    schemaVersion: 1,
    operation: operation(commandId),
    dispatchEnvelope: envelope,
    dispatchEnvelopeDigest: digestDispatchEnvelope(envelope),
    approvalId: "approval-local",
  })
}

function operation(commandId: string) {
  return runtimeOperationContextSchema.parse({
    schemaVersion: 1,
    commandId,
    correlationId: "correlation-local",
    projectId: "project-local",
    runId: "run-local",
    dispatchId: "dispatch-local",
    nodeId: "node-local",
    controllerNodeId: "node-local",
    controllerEpoch: 1,
    leaseId: "lease-local",
  })
}

describe("OpencodeRuntimeAdapter", () => {
  it("detects only a healthy literal-loopback OpenCode server", async () => {
    const { adapter } = setup()
    const node = nodeContextSchema.parse({ schemaVersion: 1, nodeId: "node-local", meshId: "mesh-local", platform: "test", architecture: "test" })
    const found = await adapter.detect(node)
    expect(found).toMatchObject({ ok: true })
    if (found.ok) expect(found.value[0]).toMatchObject({ runtimeKind: "opencode", capabilities: { reliableCompletion: false } })

    const remote = setup("http://localhost:4096")
    const notFound = await remote.adapter.detect(node)
    expect(notFound).toEqual({ ok: true, value: [] })
    expect(await remote.adapter.launch(launch())).toMatchObject({ ok: false, error: { code: "runtime.launch.non_loopback" } })
    expect(remote.client.creates).toBe(0)
  })

  it("launches a dispatch once and never replays the initial prompt", async () => {
    const { adapter, client } = setup()
    const request = launch()
    const [first, repeated] = await Promise.all([adapter.launch(request), adapter.launch(request)])
    expect(first).toEqual(repeated)
    expect(client.creates).toBe(1)
    expect(client.prompts).toBe(1)
    expect(client.policies[0]).toMatchObject({
      system: expect.stringContaining("Role: Local role"),
      tools: { bash: false, edit: false, write: false, webfetch: false },
    })

    const changed = launch("command-launch")
    changed.approvalId = approvalIdSchema.parse("approval-different")
    const conflict = await adapter.launch(changed)
    expect(conflict).toMatchObject({ ok: false, error: { category: "conflict" } })
    expect(client.creates).toBe(1)
  })

  it("normalizes lifecycle and permission events, then accepts a tracked permission reply", async () => {
    const { adapter, client } = setup()
    client.events = [
      { type: "session.status", properties: { sessionID: "provider-1", status: { type: "idle" } } },
      { type: "permission.asked", properties: { sessionID: "provider-1", permissionID: "permission-1", permission: "read" } },
    ]
    const launched = await adapter.launch(launch())
    if (!launched.ok) throw new Error("launch failed")
    client.status = "busy"
    await new Promise((resolve) => setTimeout(resolve, 0))
    const observed = []
    for await (const event of adapter.observe(launched.value, operation("command-observe"))) observed.push(event)
    expect(observed).toMatchObject([
      { ok: true, value: { type: "permission_requested", permission: "OpenCode requests read", requestId: "permission-1" } },
    ])

    const responded = await adapter.respond(launched.value, {
      schemaVersion: 1,
      operation: operation("command-respond"),
      responseId: eventIdSchema.parse("permission-1"),
      kind: "permission",
      value: "allow_once",
    })
    expect(responded).toEqual({ ok: true, value: undefined })
    expect(client.replies).toEqual([{ sessionId: "provider-1", permissionId: "permission-1", response: "once" }])
  })

  it("fails closed for unknown restores and never upgrades idle to success", async () => {
    const { adapter } = setup()
    const launched = await adapter.launch(launch())
    if (!launched.ok) throw new Error("launch failed")
    const result = await adapter.collectResult(launched.value, operation("command-result"))
    expect(result).toMatchObject({ ok: true, value: { outcome: "unknown" } })

    const restored = await adapter.restore({ ...launched.value, adapterMetadata: { handle: "provider-incorrect", projectPathId: "path-local" } }, operation("command-restore"))
    expect(restored).toMatchObject({ ok: false, error: { category: "policy_denied", code: "runtime.restore.reference_mismatch" } })
  })

  it("deduplicates follow-up prompts and maps the SDK abort control for interrupt and terminate", async () => {
    const { adapter, client } = setup()
    const launched = await adapter.launch(launch())
    if (!launched.ok) throw new Error("launch failed")
    const prompt = promptRequestSchema.parse({ schemaVersion: 1, operation: operation("command-prompt"), prompt: "Continue with the approved task." })
    await Promise.all([adapter.prompt(launched.value, prompt), adapter.prompt(launched.value, prompt)])
    expect(client.prompts).toBe(2)

    await Promise.all([adapter.interrupt(launched.value, operation("command-interrupt")), adapter.interrupt(launched.value, operation("command-interrupt"))])
    await adapter.terminate(launched.value, operation("command-terminate"))
    expect(client.aborts).toBe(2)
  })

  it("binds the approved timeout to the exact tmux-hosted terminal session", async () => {
    const { adapter } = setup()
    const launched = await adapter.launch(launch())
    if (!launched.ok) throw new Error("launch failed")
    expect(adapter.terminalBinding(launched.value.sessionId)).toMatchObject({ ok: true, value: { providerSessionId: "provider-1", timeoutSeconds: 60 } })
  })

  it("enforces the most restrictive role and dispatch permission floor", async () => {
    const { adapter, client } = setup()
    const request = launch()
    request.dispatchEnvelope.requestedCapabilities = ["filesystem.read", "filesystem.write"]
    request.dispatchEnvelope.permissionEnvelope.allowedCapabilities = ["filesystem.read", "filesystem.write"]
    request.dispatchEnvelope.roleSnapshot.permissionRestrictions.allowedCapabilities = ["filesystem.read"]
    request.dispatchEnvelope.roleSnapshot.permissionRestrictions.deniedCapabilities = ["filesystem.write"]
    request.dispatchEnvelopeDigest = digestDispatchEnvelope(request.dispatchEnvelope)
    client.events = [{ type: "permission.asked", properties: { sessionID: "provider-1", permissionID: "permission-denied", permission: "filesystem.write" } }]
    const launched = await adapter.launch(request)
    if (!launched.ok) throw new Error("launch failed")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.policies[0]?.tools).toMatchObject({ write: false, edit: false, patch: false })
    const observed = []
    for await (const event of adapter.observe(launched.value, operation("command-denied-observe"))) observed.push(event)
    expect(observed).toMatchObject([{ ok: true, value: { type: "permission_requested", requestId: "permission-denied" } }])
    const denied = await adapter.respond(launched.value, {
      schemaVersion: 1,
      operation: operation("command-denied-response"),
      responseId: eventIdSchema.parse("permission-denied"),
      kind: "permission",
      value: "allow_once",
    })
    expect(denied).toMatchObject({ ok: false, error: { code: "runtime.respond.permission_denied" } })
    expect(client.replies).toEqual([])
  })

  it("exposes rich capability report and distinguishes SSE from polling observation provenance", async () => {
    const { adapter, client } = setup()
    expect(adapter.capabilityReport).toMatchObject({
      structuredPermissions: { status: "supported", evidenceSource: "api" },
      nativeSessionRestore: { status: "unsupported" },
      reliableCompletion: { status: "unsupported" },
    })

    const node = nodeContextSchema.parse({ schemaVersion: 1, nodeId: "node-local", meshId: "mesh-local", platform: "test", architecture: "test" })
    const detected = await adapter.detect(node)
    expect(detected.ok).toBe(true)
    if (detected.ok) {
      expect(detected.value[0].capabilityReport).toBeDefined()
      expect(detected.value[0].capabilityReport?.structuredPermissions.status).toBe("supported")
    }

    client.events = [
      { type: "session.status", properties: { sessionID: "provider-1", status: { type: "busy" } } },
    ]
    const launched = await adapter.launch(launch())
    if (!launched.ok) throw new Error("launch failed")

    // Polling fallback observation
    const polledEvents = []
    for await (const event of adapter.observe(launched.value, operation("cmd-poll"))) {
      if (event.ok) polledEvents.push(event.value)
    }
    expect(polledEvents[0]).toMatchObject({
      type: "lifecycle",
      source: "polling",
      confidence: "inferred",
    })
  })

  describeAdapterConformance("OpencodeRuntimeAdapter", () => setup().adapter, {
    nodeId: "node-local",
    projectId: "project-local",
    installationId: "installation-local",
    runtimeKind: "opencode",
    getSessionReference: (session) => ({
      ...session,
      adapterMetadata: { handle: "provider-1", projectPathId: "project-path-contract" },
    }),
  })
})

