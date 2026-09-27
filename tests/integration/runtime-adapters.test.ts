import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { RuntimeDiscoveryService } from "../../src/runtime/discovery.js"
import { nodeContextSchema } from "../../src/runtime/schemas.js"
import { createTestLaunchRequest, createTestOperationContext } from "../contracts/runtime/conformance-helpers.js"
import { FakeOpencodeClient } from "./fixtures.js"

class MockSpawnedProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 9999
  signals: string[] = []

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.signals.push(String(signal))
    this.emit("exit", 0, signal)
    return true
  }
}

describe("Multi-Runtime Adapters Integration", () => {
  function setupIntegrationEnvironment() {
    const spawnedProcesses: Array<{ command: string; args: string[]; proc: MockSpawnedProcess }> = []
    const fakeClient = new FakeOpencodeClient()

    const discovery = new RuntimeDiscoveryService({
      nodeId: "node-integration-1",
      customBinaryPaths: {
        opencode: "/mock/bin/opencode",
        claude: "/mock/bin/claude",
        codex: "/mock/bin/codex",
      },
      opencodeClient: fakeClient,
      probeTimeoutMs: 50,
      env: {
        PATH: "/usr/bin:/bin",
        AIBRIDGE_BEARER_TOKEN: "super-secret-token",
        AIBRIDGE_AGENT_ID: "node-integration-1",
        ANTHROPIC_API_KEY: "sk-ant-test-key",
        OPENAI_API_KEY: "sk-openai-test-key",
      },
      projects: {
        async resolve(scope) {
          if (scope.projectId !== "project-contract") {
            return {
              ok: false,
              error: {
                schemaVersion: 1,
                category: "policy_denied",
                code: "project.scope",
                message: "Project rejected",
                retryable: false,
              },
            }
          }
          return { ok: true, value: "/tmp/project-contract" }
        },
      },
      statFile: async () => ({ mtimeMs: 12345, size: 67890 }),
      execProbe: async (filePath) => {
        if (filePath.includes("opencode")) return { ok: true, stdout: "1.18.32" }
        if (filePath.includes("claude")) return { ok: true, stdout: "2.1.138 (Claude Code)" }
        if (filePath.includes("codex")) return { ok: true, stdout: "codex-cli 0.155.1" }
        return { ok: false, stdout: "" }
      },
      spawn: (command, args) => {
        const proc = new MockSpawnedProcess()
        spawnedProcesses.push({ command, args, proc })
        setTimeout(() => {
          proc.stdout.write(JSON.stringify({ type: "system", message: "ready" }) + "\n")
        }, 5)
        return proc as any
      },
    })

    return { discovery, spawnedProcesses, fakeClient }
  }

  it("discovers all three runtimes and reports accurate capability profiles", async () => {
    const { discovery } = setupIntegrationEnvironment()
    const node = nodeContextSchema.parse({
      schemaVersion: 1,
      nodeId: "node-integration-1",
      meshId: "mesh-integration",
      platform: "darwin",
      architecture: "arm64",
    })

    const detected = await discovery.detect(node)
    expect(detected.ok).toBe(true)
    if (!detected.ok) return

    expect(detected.value.length).toBe(3)

    const opencode = detected.value.find((i) => i.runtimeKind === "opencode")
    expect(opencode?.version).toBe("1.18.32")
    expect(opencode?.capabilities.structuredPermissions).toBe(true)
    expect(opencode?.capabilities.nativeSessionRestore).toBe(false)

    const claude = detected.value.find((i) => i.runtimeKind === "claude")
    expect(claude?.version).toBe("2.1.138 (Claude Code)")
    expect(claude?.capabilities.nativeSessionRestore).toBe(true)
    expect(claude?.capabilityReport?.structuredPermissions.status).toBe("conditional")

    const codex = detected.value.find((i) => i.runtimeKind === "codex")
    expect(codex?.version).toBe("codex-cli 0.155.1")
    expect(codex?.capabilities.structuredPermissions).toBe(false)
    expect(codex?.capabilityReport?.structuredPermissions.status).toBe("unsupported")
  })

  it("routes OpenCode dispatch end-to-end through OpencodeRuntimeAdapter", async () => {
    const { discovery, fakeClient } = setupIntegrationEnvironment()
    const request = await createTestLaunchRequest({
      commandId: "opencode-int-1",
      nodeId: "node-integration-1",
      installationId: "installation-opencode",
      runtimeKind: "opencode",
    })

    const routeRes = await discovery.route(request.dispatchEnvelope)
    expect(routeRes.ok).toBe(true)
    if (!routeRes.ok) return

    const adapter = routeRes.value
    expect(adapter.kind).toBe("opencode")

    const launchRes = await adapter.launch(request)
    expect(launchRes.ok).toBe(true)
    if (!launchRes.ok) return
    expect(fakeClient.createdSessions).toBe(1)
    expect(fakeClient.sentPrompts).toBe(1)

    const op = createTestOperationContext("opencode-op-1", { nodeId: "node-integration-1" })
    const result = await adapter.collectResult(launchRes.value, op)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.outcome).toBe("unknown")
    }
  })

  it("routes Claude dispatch and rejects missing result on clean exit as unknown", async () => {
    const { discovery, spawnedProcesses } = setupIntegrationEnvironment()
    const request = await createTestLaunchRequest({
      commandId: "claude-int-1",
      nodeId: "node-integration-1",
      installationId: "installation-claude",
      runtimeKind: "claude",
    })

    const routeRes = await discovery.route(request.dispatchEnvelope)
    expect(routeRes.ok).toBe(true)
    if (!routeRes.ok) return

    const adapter = routeRes.value
    expect(adapter.kind).toBe("claude")

    const launchRes = await adapter.launch(request)
    expect(launchRes.ok).toBe(true)
    if (!launchRes.ok) return

    // Simulate process terminating with exit code 0 without emitting completion event
    const lastProc = spawnedProcesses[spawnedProcesses.length - 1].proc
    lastProc.emit("exit", 0, null)

    const op = createTestOperationContext("claude-op-1", { nodeId: "node-integration-1" })
    const result = await adapter.collectResult(launchRes.value, op)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.outcome).toBe("unknown")
    }
  })

  it("routes Codex dispatch and blocks interactive permission RPC", async () => {
    const { discovery } = setupIntegrationEnvironment()
    const request = await createTestLaunchRequest({
      commandId: "codex-int-1",
      nodeId: "node-integration-1",
      installationId: "installation-codex",
      runtimeKind: "codex",
    })

    const routeRes = await discovery.route(request.dispatchEnvelope)
    expect(routeRes.ok).toBe(true)
    if (!routeRes.ok) return

    const adapter = routeRes.value
    expect(adapter.kind).toBe("codex")

    const launchRes = await adapter.launch(request)
    expect(launchRes.ok).toBe(true)
    if (!launchRes.ok) return

    // Attempting to send structured permission response fails closed
    const respondRes = await adapter.respond(launchRes.value, {
      schemaVersion: 1,
      operation: createTestOperationContext("codex-respond-1", { nodeId: "node-integration-1" }),
      responseId: "resp-1" as any,
      kind: "permission",
      value: "allow_once",
    })

    expect(respondRes.ok).toBe(false)
    if (!respondRes.ok) {
      expect(respondRes.error.category).toBe("unsupported_capability")
      expect(respondRes.error.code).toBe("runtime.codex.permissions_unsupported")
    }
  })

  it("rejects dispatch with clear error when requested runtime is unavailable", async () => {
    const discovery = new RuntimeDiscoveryService({
      nodeId: "node-partial",
      customBinaryPaths: {
        opencode: "/mock/bin/opencode",
        claude: "/mock/bin/claude-unavailable",
        codex: "/mock/bin/codex-unavailable",
      },
      pathSearchRoots: ["/empty-nonexistent-root"],
      probeTimeoutMs: 50,
      projects: {
        async resolve() {
          return { ok: true, value: "/tmp" }
        },
      },
      statFile: async (path) => path === "/mock/bin/opencode" ? { mtimeMs: 1, size: 2 } : undefined,
      execProbe: async (path) => path === "/mock/bin/opencode" ? { ok: true, stdout: "1.18.32" } : { ok: false, stdout: "" },
    })

    const request = await createTestLaunchRequest({
      nodeId: "node-partial",
      runtimeKind: "claude",
    })

    const routeRes = await discovery.route(request.dispatchEnvelope)
    expect(routeRes.ok).toBe(false)
    if (!routeRes.ok) {
      expect(routeRes.error.category).toBe("unsupported_capability")
      expect(routeRes.error.code).toBe("runtime.router.runtime_unavailable")
      expect(routeRes.error.message).toContain("Claude Code")
      expect(routeRes.error.message).toContain("OpenCode (opencode)")
    }
  })
})
