import { EventEmitter } from "node:events"
import { existsSync } from "node:fs"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { digestDispatchEnvelope } from "../../../src/orchestration/digest.js"
import { CodexRuntimeAdapter, type ProcessHandle } from "../../../src/runtime/codex-adapter.js"
import { nodeContextSchema } from "../../../src/runtime/schemas.js"
import { describeAdapterConformance } from "../../contracts/runtime/conformance-suite.js"
import { createTestLaunchRequest, createTestOperationContext } from "../../contracts/runtime/conformance-helpers.js"

class MockProcess extends EventEmitter implements ProcessHandle {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 23456
  signalsSent: string[] = []

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.signalsSent.push(String(signal))
    this.emit("exit", 0, signal)
    return true
  }
}

interface MockAdapterOptions {
  version?: string
  probeTimeout?: boolean
}

function createMockAdapter(options: MockAdapterOptions = {}) {
  const processes: MockProcess[] = []
  const spawnedArgs: Array<{ command: string; args: string[] }> = []

  const adapter = new CodexRuntimeAdapter({
    executablePath: "codex-mock",
    nodeId: "node-contract",
    installationId: "installation-contract",
    probeTimeoutMs: options.probeTimeout ? 50 : undefined,
    projects: {
      async resolve(scope) {
        if (scope.projectId !== "project-contract") {
          return {
            ok: false,
            error: {
              schemaVersion: 1,
              category: "policy_denied",
              code: "project.scope",
              message: "Foreign project rejected",
              retryable: false,
            },
          }
        }
        return { ok: true, value: "/workspace/contract" }
      },
    },
    spawn: (cmd, args) => {
      spawnedArgs.push({ command: cmd, args })
      const proc = new MockProcess()
      processes.push(proc)
      if (args.includes("-V") || args.includes("--version")) {
        if (options.probeTimeout) {
          // Never emits exit to trigger timeout
        } else {
          setTimeout(() => {
            proc.stdout.write((options.version ?? "codex-cli 0.155.1") + "\n")
            proc.emit("exit", 0, null)
          }, 5)
        }
      } else {
        // Active session
        setTimeout(() => {
          proc.stdout.write(JSON.stringify({ type: "thread.created", thread_id: "thread-mock-123" }) + "\n")
        }, 5)
      }
      return proc
    },
  })

  return { adapter, processes, spawnedArgs }
}

describe("CodexRuntimeAdapter", () => {
  describe("Detection & Version Probe", () => {
    it("detects installed binary and extracts version and capabilities", async () => {
      const { adapter } = createMockAdapter({ version: "codex-cli 0.155.1" })
      const node = nodeContextSchema.parse({
        schemaVersion: 1,
        nodeId: "node-contract",
        meshId: "mesh-contract",
        platform: "darwin",
        architecture: "arm64",
      })

      const detected = await adapter.detect(node)
      expect(detected.ok).toBe(true)
      if (detected.ok) {
        expect(detected.value.length).toBe(1)
        expect(detected.value[0].version).toBe("codex-cli 0.155.1")
        expect(detected.value[0].runtimeKind).toBe("codex")
        expect(detected.value[0].capabilities.structuredPermissions).toBe(false)
        expect(detected.value[0].capabilities.nativeSessionRestore).toBe(true)
        expect(detected.value[0].capabilities.reliableCompletion).toBe(true)
        expect(detected.value[0].capabilityReport?.structuredPermissions.status).toBe("unsupported")
      }
    })

    it("returns empty array when probe times out", async () => {
      const { adapter } = createMockAdapter({ probeTimeout: true })
      const node = nodeContextSchema.parse({
        schemaVersion: 1,
        nodeId: "node-contract",
        meshId: "mesh-contract",
        platform: "darwin",
        architecture: "arm64",
      })

      const detected = await adapter.detect(node)
      expect(detected.ok).toBe(true)
      if (detected.ok) {
        expect(detected.value.length).toBe(0)
      }
    })
  })

  describe("Lifecycle & Result Normalization", () => {
    it("degrades to unknown on exit code 0 when result event is missing", async () => {
      const { adapter, processes } = createMockAdapter()
      const request = await createTestLaunchRequest({ commandId: "codex-res-unknown", runtimeKind: "codex" })
      const launched = await adapter.launch(request)
      expect(launched.ok).toBe(true)
      if (!launched.ok) return

      const proc = processes[processes.length - 1]
      proc.emit("exit", 0, null)

      const op = createTestOperationContext("codex-res-op-1")
      const result = await adapter.collectResult(launched.value, op)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.outcome).toBe("unknown")
        expect(result.value.summary).toContain("without structured completion result")
      }
    })

    it("records succeeded outcome when structured result event arrives", async () => {
      const { adapter, processes } = createMockAdapter()
      const request = await createTestLaunchRequest({ commandId: "codex-res-success", runtimeKind: "codex" })
      const launched = await adapter.launch(request)
      expect(launched.ok).toBe(true)
      if (!launched.ok) return

      const proc = processes[processes.length - 1]
      proc.stdout.write(JSON.stringify({
        type: "turn.completed",
        status: "completed",
        summary: "Codex implemented the request",
      }) + "\n")
      proc.emit("exit", 0, null)

      const op = createTestOperationContext("codex-res-op-2")
      const result = await adapter.collectResult(launched.value, op)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.outcome).toBe("succeeded")
        expect(result.value.summary).toBe("Codex implemented the request")
      }
    })

    it("records failed outcome when process exits with non-zero code", async () => {
      const { adapter, processes } = createMockAdapter()
      const request = await createTestLaunchRequest({ commandId: "codex-res-fail", runtimeKind: "codex" })
      const launched = await adapter.launch(request)
      expect(launched.ok).toBe(true)
      if (!launched.ok) return

      const proc = processes[processes.length - 1]
      proc.emit("exit", 1, null)

      const op = createTestOperationContext("codex-res-op-3")
      const result = await adapter.collectResult(launched.value, op)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.outcome).toBe("failed")
      }
    })
  })

  describe("Control Operations & Unsupported Capabilities", () => {
    it("sends SIGINT on interrupt and SIGTERM on terminate", async () => {
      const { adapter, processes } = createMockAdapter()
      const request = await createTestLaunchRequest({ commandId: "codex-control-signals", runtimeKind: "codex" })
      const launched = await adapter.launch(request)
      expect(launched.ok).toBe(true)
      if (!launched.ok) return

      const proc = processes[processes.length - 1]
      const op = createTestOperationContext("codex-control-op")

      await adapter.interrupt(launched.value, op)
      expect(proc.signalsSent).toContain("SIGINT")

      await adapter.terminate(launched.value, op)
      expect(proc.signalsSent).toContain("SIGTERM")
    })

    it("returns unsupported_capability error when respond is invoked", async () => {
      const { adapter } = createMockAdapter()
      const request = await createTestLaunchRequest({ commandId: "codex-respond-test", runtimeKind: "codex" })
      const launched = await adapter.launch(request)
      expect(launched.ok).toBe(true)
      if (!launched.ok) return

      const responseResult = await adapter.respond(launched.value, {
        schemaVersion: 1,
        operation: createTestOperationContext("codex-respond-op"),
        responseId: "resp-1" as any,
        kind: "permission",
        value: "allow_once",
      })

      expect(responseResult.ok).toBe(false)
      if (!responseResult.ok) {
        expect(responseResult.error.category).toBe("unsupported_capability")
        expect(responseResult.error.code).toBe("runtime.codex.permissions_unsupported")
      }
    })
  })

  describe("Direct Argv & Flag Generation", () => {
    it("constructs direct argv array with --json, -C, -s read-only, and skips git repo check when no .git", async () => {
      const { adapter, spawnedArgs } = createMockAdapter()
      const request = await createTestLaunchRequest({
        commandId: "codex-argv-check-readonly",
        runtimeKind: "codex",
        model: "o3-mini",
      })
      const launched = await adapter.launch(request)
      expect(launched.ok).toBe(true)

      const lastSpawn = spawnedArgs[spawnedArgs.length - 1]
      expect(lastSpawn.command).toBe("codex-mock")
      expect(lastSpawn.args).toContain("exec")
      expect(lastSpawn.args).toContain("--json")
      expect(lastSpawn.args).toContain("-C")
      expect(lastSpawn.args).toContain("/workspace/contract")
      expect(lastSpawn.args).toContain("--skip-git-repo-check")
      expect(lastSpawn.args).toContain("-s")
      expect(lastSpawn.args).toContain("read-only")
      expect(lastSpawn.args).toContain("-m")
      expect(lastSpawn.args).toContain("o3-mini")
    })

    it("passes -s workspace-write when filesystem.write capability is granted", async () => {
      const { adapter, spawnedArgs } = createMockAdapter()
      const request = await createTestLaunchRequest({
        commandId: "codex-argv-check-write",
        runtimeKind: "codex",
      })
      request.dispatchEnvelope.requestedCapabilities = ["read", "filesystem.write"]
      request.dispatchEnvelope.permissionEnvelope.allowedCapabilities = ["read", "filesystem.write"]
      request.dispatchEnvelope.permissionEnvelope.deniedCapabilities = []
      request.dispatchEnvelope.roleSnapshot.permissionRestrictions.allowedCapabilities = ["read", "filesystem.write"]
      request.dispatchEnvelope.roleSnapshot.permissionRestrictions.deniedCapabilities = []
      request.dispatchEnvelope.ruleSnapshots = []
      request.dispatchEnvelopeDigest = digestDispatchEnvelope(request.dispatchEnvelope)

      const launched = await adapter.launch(request)
      expect(launched.ok).toBe(true)

      const lastSpawn = spawnedArgs[spawnedArgs.length - 1]
      expect(lastSpawn.args).toContain("-s")
      expect(lastSpawn.args).toContain("workspace-write")
    })
  })

  // Full Conformance Suite
  let currentAdapter: CodexRuntimeAdapter | undefined
  describeAdapterConformance("CodexRuntimeAdapter", () => {
    const created = createMockAdapter()
    currentAdapter = created.adapter
    return created.adapter
  }, {
    nodeId: "node-contract",
    projectId: "project-contract",
    installationId: "installation-contract",
    runtimeKind: "codex",
    supportsStructuredPermissions: false,
    getSessionReference: (session) => currentAdapter?.sessionReference(session.sessionId) ?? {
      ...session,
      adapterMetadata: { handle: "unknown", projectPathId: "project-path-contract" },
    },
  })

  // Credential-Free Smoke Test against installed binary
  describe("Installed Codex Binary Smoke Test (credential-free)", () => {
    const installedPath = "/opt/homebrew/bin/codex"
    const hasBinary = existsSync(installedPath)

    it.skipIf(!hasBinary)("probes real installed codex binary version without credentials or network", async () => {
      const adapter = new CodexRuntimeAdapter({
        executablePath: installedPath,
        nodeId: "node-smoke",
        installationId: "installation-smoke",
        projects: {
          async resolve() {
            return { ok: true, value: "/tmp" }
          },
        },
      })

      const node = nodeContextSchema.parse({
        schemaVersion: 1,
        nodeId: "node-smoke",
        meshId: "mesh-smoke",
        platform: "darwin",
        architecture: "arm64",
      })

      const detected = await adapter.detect(node)
      expect(detected.ok).toBe(true)
      if (detected.ok) {
        expect(detected.value.length).toBe(1)
        expect(detected.value[0].version).toContain("codex-cli")
        expect(detected.value[0].executable).toBe(installedPath)
      }
    })
  })
})
