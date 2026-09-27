import { describe, expect, it } from "vitest"
import { RuntimeDiscoveryService, type SupportedRuntimeKind } from "../../../src/runtime/discovery.js"
import { nodeContextSchema } from "../../../src/runtime/schemas.js"
import { createTestLaunchRequest } from "../../contracts/runtime/conformance-helpers.js"

describe("RuntimeDiscoveryService", () => {
  function createMockDiscovery(options: {
    installed?: Partial<Record<SupportedRuntimeKind, { version: string; mtimeMs?: number; size?: number }>>
    probeHang?: SupportedRuntimeKind
    probeFail?: SupportedRuntimeKind
  } = {}) {
    const probeExecutions: Array<{ file: string; args: string[] }> = []
    const fileStats = new Map<string, { mtimeMs: number; size: number }>()

    const customBinaryPaths: Record<SupportedRuntimeKind, string> = {
      opencode: "/bin/mock-opencode",
      claude: "/bin/mock-claude",
      codex: "/bin/mock-codex",
    }

    for (const [kind, info] of Object.entries(options.installed ?? {})) {
      const path = customBinaryPaths[kind as SupportedRuntimeKind]
      fileStats.set(path, {
        mtimeMs: info.mtimeMs ?? 1000,
        size: info.size ?? 5000,
      })
    }

    const service = new RuntimeDiscoveryService({
      nodeId: "node-test-1",
      customBinaryPaths,
      probeTimeoutMs: 50,
      projects: {
        async resolve() {
          return { ok: true, value: "/tmp/project" }
        },
      },
      statFile: async (filePath) => fileStats.get(filePath),
      execProbe: async (filePath, args, timeoutMs) => {
        probeExecutions.push({ file: filePath, args })

        for (const [kind, path] of Object.entries(customBinaryPaths)) {
          if (filePath === path) {
            if (options.probeHang === kind) {
              await new Promise((r) => setTimeout(r, timeoutMs + 10))
              return { ok: false, stdout: "" }
            }
            if (options.probeFail === kind) {
              return { ok: false, stdout: "" }
            }
            const info = options.installed?.[kind as SupportedRuntimeKind]
            if (info) {
              return { ok: true, stdout: info.version }
            }
          }
        }
        return { ok: false, stdout: "" }
      },
    })

    return { service, probeExecutions, fileStats, customBinaryPaths }
  }

  describe("Multi-Runtime Probing & Capability Reporting", () => {
    it("discovers all 3 installed runtimes and extracts versions and capability reports", async () => {
      const { service, probeExecutions } = createMockDiscovery({
        installed: {
          opencode: { version: "1.18.32" },
          claude: { version: "2.1.138 (Claude Code)" },
          codex: { version: "codex-cli 0.155.1" },
        },
      })

      const all = await service.discoverAll()
      expect(all.length).toBe(3)

      const opencode = all.find((r) => r.kind === "opencode")
      expect(opencode?.installed).toBe(true)
      expect(opencode?.version).toBe("1.18.32")
      expect(opencode?.capabilities?.structuredPermissions).toBe(true)

      const claude = all.find((r) => r.kind === "claude")
      expect(claude?.installed).toBe(true)
      expect(claude?.version).toBe("2.1.138 (Claude Code)")
      expect(claude?.capabilities?.nativeSessionRestore).toBe(true)
      expect(claude?.capabilityReport?.structuredPermissions.status).toBe("conditional")

      const codex = all.find((r) => r.kind === "codex")
      expect(codex?.installed).toBe(true)
      expect(codex?.version).toBe("codex-cli 0.155.1")
      expect(codex?.capabilities?.structuredPermissions).toBe(false)
      expect(codex?.capabilityReport?.structuredPermissions.status).toBe("unsupported")

      expect(probeExecutions.length).toBe(3)
    })

    it("gracefully marks uninstalled runtimes as installed: false without throwing", async () => {
      const { service } = createMockDiscovery({
        installed: {
          codex: { version: "codex-cli 0.155.1" },
        },
      })

      const all = await service.discoverAll()
      expect(all.length).toBe(3)

      const opencode = all.find((r) => r.kind === "opencode")
      expect(opencode?.installed).toBe(false)
      expect(opencode?.error).toContain("was not found")

      const claude = all.find((r) => r.kind === "claude")
      expect(claude?.installed).toBe(false)
      expect(claude?.error).toContain("was not found")

      const codex = all.find((r) => r.kind === "codex")
      expect(codex?.installed).toBe(true)
    })
  })

  describe("Health Check Isolation", () => {
    it("keeps working runtimes available even if one runtime probe times out", async () => {
      const { service } = createMockDiscovery({
        installed: {
          opencode: { version: "1.18.32" },
          claude: { version: "2.1.138" },
          codex: { version: "codex-cli 0.155.1" },
        },
        probeHang: "claude",
      })

      const all = await service.discoverAll()
      const opencode = all.find((r) => r.kind === "opencode")
      const claude = all.find((r) => r.kind === "claude")
      const codex = all.find((r) => r.kind === "codex")

      expect(opencode?.installed).toBe(true)
      expect(codex?.installed).toBe(true)
      expect(claude?.installed).toBe(false)
      expect(claude?.error).toContain("timed out")
    })
  })

  describe("Cache Invalidation Semantics", () => {
    it("reuses cached probe when file path, mtime, and size are unchanged", async () => {
      const { service, probeExecutions } = createMockDiscovery({
        installed: {
          codex: { version: "codex-cli 0.155.1", mtimeMs: 1000, size: 5000 },
        },
      })

      await service.probeRuntime("codex")
      expect(probeExecutions.length).toBe(1)

      // Second probe should use cache
      const second = await service.probeRuntime("codex")
      expect(second.installed).toBe(true)
      expect(probeExecutions.length).toBe(1)
    })

    it("invalidates cache when mtime changes", async () => {
      const { service, probeExecutions, fileStats, customBinaryPaths } = createMockDiscovery({
        installed: {
          codex: { version: "codex-cli 0.155.1", mtimeMs: 1000, size: 5000 },
        },
      })

      await service.probeRuntime("codex")
      expect(probeExecutions.length).toBe(1)

      // Simulate binary update (mtime bump)
      fileStats.set(customBinaryPaths.codex, { mtimeMs: 2000, size: 5000 })

      await service.probeRuntime("codex")
      expect(probeExecutions.length).toBe(2)
    })

    it("invalidates cache when size changes", async () => {
      const { service, probeExecutions, fileStats, customBinaryPaths } = createMockDiscovery({
        installed: {
          codex: { version: "codex-cli 0.155.1", mtimeMs: 1000, size: 5000 },
        },
      })

      await service.probeRuntime("codex")
      expect(probeExecutions.length).toBe(1)

      // Simulate binary size change
      fileStats.set(customBinaryPaths.codex, { mtimeMs: 1000, size: 6000 })

      await service.probeRuntime("codex")
      expect(probeExecutions.length).toBe(2)
    })

    it("bypasses cache when forceRefresh is requested", async () => {
      const { service, probeExecutions } = createMockDiscovery({
        installed: {
          codex: { version: "codex-cli 0.155.1", mtimeMs: 1000, size: 5000 },
        },
      })

      await service.probeRuntime("codex")
      expect(probeExecutions.length).toBe(1)

      await service.probeRuntime("codex", true)
      expect(probeExecutions.length).toBe(2)
    })
  })

  describe("Routing Guardrails", () => {
    it("routes dispatch to the matching installed runtime adapter", async () => {
      const { service } = createMockDiscovery({
        installed: {
          opencode: { version: "1.18.32" },
          claude: { version: "2.1.138 (Claude Code)" },
        },
      })

      const request = await createTestLaunchRequest({
        runtimeKind: "claude",
      })

      const routed = await service.route(request.dispatchEnvelope)
      expect(routed.ok).toBe(true)
      if (routed.ok) {
        expect(routed.value.kind).toBe("claude")
      }
    })

    it("rejects dispatch with clear error when requested runtime is not installed", async () => {
      const { service } = createMockDiscovery({
        installed: {
          claude: { version: "2.1.138 (Claude Code)" },
        },
      })

      const request = await createTestLaunchRequest({
        runtimeKind: "codex",
      })

      const routed = await service.route(request.dispatchEnvelope)
      expect(routed.ok).toBe(false)
      if (!routed.ok) {
        expect(routed.error.category).toBe("unsupported_capability")
        expect(routed.error.code).toBe("runtime.router.runtime_unavailable")
        expect(routed.error.message).toContain("Claude Code (claude)")
      }
    })

    it("rejects dispatch with unsupported_kind when runtime kind is unknown", async () => {
      const { service } = createMockDiscovery()
      const request = await createTestLaunchRequest()
      const envelope = { ...request.dispatchEnvelope, runtimeKind: "custom-fake-kind" }

      const routed = await service.route(envelope)
      expect(routed.ok).toBe(false)
      if (!routed.ok) {
        expect(routed.error.category).toBe("unsupported_capability")
        expect(routed.error.code).toBe("runtime.router.unsupported_kind")
      }
    })
  })

  describe("TUI Runtime Selection & Aggregated Detect", () => {
    it("getSelectableRuntimes returns only installed runtimes", async () => {
      const { service } = createMockDiscovery({
        installed: {
          opencode: { version: "1.18.32" },
          codex: { version: "codex-cli 0.155.1" },
        },
      })

      const selectable = await service.getSelectableRuntimes()
      expect(selectable.length).toBe(2)
      expect(selectable.map((s) => s.kind)).toEqual(["opencode", "codex"])
    })

    it("detect aggregates installations across all available adapters for valid nodeContext", async () => {
      const { service } = createMockDiscovery({
        installed: {
          opencode: { version: "1.18.32" },
          claude: { version: "2.1.138" },
        },
      })

      const node = nodeContextSchema.parse({
        schemaVersion: 1,
        nodeId: "node-test-1",
        meshId: "mesh-test-1",
        platform: "darwin",
        architecture: "arm64",
      })

      const detected = await service.detect(node)
      expect(detected.ok).toBe(true)
      if (detected.ok) {
        expect(detected.value.length).toBeGreaterThanOrEqual(1)
      }
    })

    it("detect rejects foreign node context", async () => {
      const { service } = createMockDiscovery()
      const foreignNode = nodeContextSchema.parse({
        schemaVersion: 1,
        nodeId: "foreign-node",
        meshId: "mesh-test-1",
        platform: "darwin",
        architecture: "arm64",
      })

      const detected = await service.detect(foreignNode)
      expect(detected.ok).toBe(false)
      if (!detected.ok) {
        expect(detected.error.category).toBe("policy_denied")
        expect(detected.error.code).toBe("runtime.detect.node_scope")
      }
    })
  })

  describe("Real Host Discovery Smoke Test", () => {
    it("probes real host runtimes cleanly without hanging or crashing", async () => {
      const realService = new RuntimeDiscoveryService({
        nodeId: "node-host-smoke",
        projects: {
          async resolve() {
            return { ok: true, value: "/tmp" }
          },
        },
      })

      const discovered = await realService.discoverAll()
      expect(discovered.length).toBe(3)
      for (const entry of discovered) {
        expect(["opencode", "claude", "codex"]).toContain(entry.kind)
        if (entry.installed) {
          expect(entry.version).toBeDefined()
          expect(entry.capabilities).toBeDefined()
        }
      }
    })
  })
})
