import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ExtensionRegistry,
  SampleEchoAdapter,
  runAdapterConformance,
  assertSdkVersionCompatible,
  AIBRIDGE_SDK_VERSION,
} from "../../../src/sdk/index.js"

describe("M8.7: Extension SDK and Conformance Kit", () => {
  it("runs conformance test runner successfully against SampleEchoAdapter", async () => {
    const adapter = new SampleEchoAdapter()
    const report = await runAdapterConformance(adapter)

    expect(report.ok).toBe(true)
    expect(report.suite).toBe("adapter")
    expect(report.targetKind).toBe("sample-echo")
    expect(report.passedTests).toContain("kind")
    expect(report.passedTests).toContain("capabilities")
    expect(report.passedTests).toContain("detect")
    expect(report.failures).toHaveLength(0)
  })

  it("verifies sample adapter has ZERO internal imports (SDK boundary criterion)", () => {
    const sampleFilePath = join(import.meta.dirname, "../../../src/sdk/sample-adapter.ts")
    const sourceCode = readFileSync(sampleFilePath, "utf8")

    // Forbid any imports from internal modules
    expect(sourceCode).not.toContain("../orchestration/")
    expect(sourceCode).not.toContain("../mesh/")
    expect(sourceCode).not.toContain("../jobs/")
    expect(sourceCode).not.toContain("../server/")
    expect(sourceCode).not.toContain("../security/")
    expect(sourceCode).not.toContain("../config/")

    // Only imports from the SDK
    const importLines = sourceCode.split("\n").filter((line) => line.trim().startsWith("import") || line.trim().startsWith("} from"))
    for (const line of importLines) {
      if (line.includes("from")) {
        expect(line).toMatch(/from\s+["']\.\/(?:index|types|errors)\.js["']/)
      }
    }
  })

  it("ExtensionRegistry registers adapters and terminal backends and enforces version compatibility", () => {
    const registry = new ExtensionRegistry()
    const adapter = new SampleEchoAdapter()

    // 1. Compatible registration succeeds
    registry.registerAdapter({
      metadata: {
        name: "echo-extension",
        version: "1.0.0",
        aibridgeSdkVersion: AIBRIDGE_SDK_VERSION,
      },
      adapter,
    })

    expect(registry.getAdapter("sample-echo")).toBe(adapter)
    expect(registry.listAdapters().length).toBe(1)

    // 2. Incompatible SDK version registration throws immediately (fail-closed)
    expect(() => {
      registry.registerAdapter({
        metadata: {
          name: "incompatible-extension",
          version: "1.0.0",
          aibridgeSdkVersion: "9.0.0", // Incompatible major version
        },
        adapter: {
          kind: "incompatible-kind",
          capabilities: adapter.capabilities,
          detect: async () => ({ ok: true, value: [] }),
          launch: async () => ({ ok: true, value: {} as unknown as import("../../../src/sdk/index.js").RuntimeSession }),
          restore: async () => ({ ok: true, value: {} as unknown as import("../../../src/sdk/index.js").RuntimeSession }),
          prompt: async () => ({ ok: true, value: undefined }),
          observe: async function* () {},
          respond: async () => ({ ok: true, value: undefined }),
          interrupt: async () => ({ ok: true, value: undefined }),
          terminate: async () => ({ ok: true, value: undefined }),
          collectResult: async () => ({ ok: true, value: {} as unknown as import("../../../src/sdk/index.js").AgentResult }),
        },
      })
    }).toThrow(/Incompatible AIBridge SDK version/)

    // 3. Duplicate kind throws
    expect(() => {
      registry.registerAdapter({
        metadata: {
          name: "duplicate-echo",
          version: "1.0.0",
          aibridgeSdkVersion: AIBRIDGE_SDK_VERSION,
        },
        adapter,
      })
    }).toThrow(/already registered/)
  })

  it("assertSdkVersionCompatible enforces semver major compatibility", () => {
    expect(() => assertSdkVersionCompatible("1.0.0")).not.toThrow()
    expect(() => assertSdkVersionCompatible("1.5.2")).not.toThrow()
    expect(() => assertSdkVersionCompatible("2.0.0")).toThrow(/Major version mismatch/)
    expect(() => assertSdkVersionCompatible("0.9.0")).toThrow(/Major version mismatch/)
  })
})
