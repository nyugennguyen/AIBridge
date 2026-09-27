import { EventEmitter } from "node:events"
import { existsSync } from "node:fs"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { ClaudeCodeRuntimeAdapter, type ProcessHandle } from "../../../src/runtime/claude-adapter.js"
import { nodeContextSchema } from "../../../src/runtime/schemas.js"
import { describeAdapterConformance } from "../../contracts/runtime/conformance-suite.js"
import { createTestLaunchRequest, createTestOperationContext } from "../../contracts/runtime/conformance-helpers.js"

class MockProcess extends EventEmitter implements ProcessHandle {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 12345
  signalsSent: string[] = []

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.signalsSent.push(String(signal))
    this.emit("exit", 0, signal)
    return true
  }
}

function createMockAdapter(options: { version?: string; probeTimeout?: boolean } = {}) {
  const processes: MockProcess[] = []
  const adapter = new ClaudeCodeRuntimeAdapter({
    executablePath: "claude-mock",
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
    spawn: (_cmd, args) => {
      const proc = new MockProcess()
      processes.push(proc)
      if (args.includes("--version")) {
        if (options.probeTimeout) {
          // Never emits exit to trigger timeout
        } else {
          setTimeout(() => {
            proc.stdout.write((options.version ?? "2.1.138 (Claude Code)") + "\n")
            proc.emit("exit", 0, null)
          }, 5)
        }
      } else {
        // Active session
        setTimeout(() => {
          proc.stdout.write(JSON.stringify({ type: "system", message: "Claude initialized" }) + "\n")
        }, 5)
      }
      return proc
    },
  })

  return { adapter, processes }
}


describe("ClaudeCodeRuntimeAdapter", () => {
  describe("Detection & Version Probe", () => {
    it("detects installed binary and extracts version and capabilities", async () => {
      const { adapter } = createMockAdapter({ version: "2.1.138 (Claude Code)" })
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
        expect(detected.value[0].version).toBe("2.1.138 (Claude Code)")
        expect(detected.value[0].runtimeKind).toBe("claude")
        expect(detected.value[0].capabilities.nativeSessionRestore).toBe(true)
        expect(detected.value[0].capabilityReport?.structuredPermissions.status).toBe("conditional")
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
        expect(detected.value).toEqual([])
      }
    })
  })

  describe("Lifecycle & Result Normalization", () => {
    it("degrades to unknown on exit code 0 when result event is missing", async () => {
      const { adapter, processes } = createMockAdapter()
      const request = await createTestLaunchRequest({ commandId: "claude-no-res-1", runtimeKind: "claude" })
      const launched = await adapter.launch(request)
      expect(launched.ok).toBe(true)
      if (!launched.ok) return

      const proc = processes[processes.length - 1]
      proc.emit("exit", 0, null)

      const op = createTestOperationContext("claude-res-op-1")
      const result = await adapter.collectResult(launched.value, op)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.outcome).toBe("unknown")
      }
    })

    it("records succeeded outcome when structured result event arrives", async () => {
      const { adapter, processes } = createMockAdapter()
      const request = await createTestLaunchRequest({ commandId: "claude-res-success", runtimeKind: "claude" })
      const launched = await adapter.launch(request)
      expect(launched.ok).toBe(true)
      if (!launched.ok) return

      const proc = processes[processes.length - 1]
      proc.stdout.write(
        JSON.stringify({
          type: "result",
          outcome: "success",
          summary: "Refactored module successfully",
        }) + "\n",
      )
      proc.emit("exit", 0, null)

      const op = createTestOperationContext("claude-res-op-2")
      const result = await adapter.collectResult(launched.value, op)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.outcome).toBe("succeeded")
        expect(result.value.summary).toBe("Refactored module successfully")
      }
    })

    it("records failed outcome when process exits with non-zero code", async () => {
      const { adapter, processes } = createMockAdapter()
      const request = await createTestLaunchRequest({ commandId: "claude-res-fail", runtimeKind: "claude" })
      const launched = await adapter.launch(request)
      expect(launched.ok).toBe(true)
      if (!launched.ok) return

      const proc = processes[processes.length - 1]
      proc.emit("exit", 1, null)

      const op = createTestOperationContext("claude-res-op-3")
      const result = await adapter.collectResult(launched.value, op)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.outcome).toBe("failed")
      }
    })
  })

  describe("Control Operations", () => {
    it("sends SIGINT on interrupt and SIGTERM on terminate", async () => {
      const { adapter, processes } = createMockAdapter()
      const request = await createTestLaunchRequest({ commandId: "claude-control-signals", runtimeKind: "claude" })
      const launched = await adapter.launch(request)
      expect(launched.ok).toBe(true)
      if (!launched.ok) return

      const proc = processes[processes.length - 1]
      const op = createTestOperationContext("claude-control-op")

      await adapter.interrupt(launched.value, op)
      expect(proc.signalsSent).toContain("SIGINT")

      await adapter.terminate(launched.value, op)
      expect(proc.signalsSent).toContain("SIGTERM")
    })
  })

  // Full Conformance Suite
  let currentAdapter: ClaudeCodeRuntimeAdapter | undefined
  describeAdapterConformance("ClaudeCodeRuntimeAdapter", () => {
    const created = createMockAdapter()
    currentAdapter = created.adapter
    return created.adapter
  }, {
    nodeId: "node-contract",
    projectId: "project-contract",
    installationId: "installation-contract",
    runtimeKind: "claude",
    getSessionReference: (session) => currentAdapter?.sessionReference(session.sessionId) ?? {
      ...session,
      adapterMetadata: { handle: "unknown", projectPathId: "project-path-contract" },
    },
  })

  // Credential-Free Smoke Test against installed binary
  describe("Installed Claude Binary Smoke Test (credential-free)", () => {
    const installedPath = "/Users/mac/.local/bin/claude"
    const hasBinary = existsSync(installedPath)

    it.skipIf(!hasBinary)("probes real installed claude binary version without credentials or network", async () => {
      const adapter = new ClaudeCodeRuntimeAdapter({
        executablePath: installedPath,
        nodeId: "node-smoke",
        installationId: "installation-smoke",
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
        expect(detected.value[0].version).toContain("Claude Code")
        expect(detected.value[0].executable).toBe(installedPath)
      }
    })
  })
})
