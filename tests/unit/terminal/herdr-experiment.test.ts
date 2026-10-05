import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  type TerminalBackend,
  type TerminalChannel,
  type TerminalReference,
  type TerminalOperationContext,
  type TerminalControlOperationContext,
  type CreateTerminalRequest,
  type TerminalDimensions,
  type TerminalSnapshot,
  type InputTakeoverRequest,
  type SdkResult,
  sdkOk,
  sdkErr,
  runTerminalBackendConformance,
  ExtensionRegistry,
  AIBRIDGE_SDK_VERSION,
} from "../../../src/sdk/index.js"

/**
 * Prototype experimental Herdr terminal backend spike (M8.8).
 * Built exclusively using public Extension SDK primitives.
 */
class HerdrExperimentalTerminalBackend implements TerminalBackend {
  readonly kind = "herdr-experimental"

  private readonly workspaces = new Map<string, { panes: Map<string, Uint8Array>; inputOwner: string | null }>()

  async create(request: CreateTerminalRequest): Promise<SdkResult<TerminalReference>> {
    const termId = String(request.terminalId)
    this.workspaces.set(termId, { panes: new Map(), inputOwner: null })

    const ref: TerminalReference = {
      schemaVersion: 1,
      terminalId: request.terminalId,
      nodeId: request.operation.nodeId,
      projectId: request.operation.projectId,
      sessionId: request.sessionId,
      backendKind: this.kind,
      adapterMetadata: {},
    }
    return sdkOk(ref)
  }

  async attach(reference: TerminalReference, operation: TerminalOperationContext): Promise<SdkResult<TerminalChannel>> {
    const termId = String(reference.terminalId)
    const workspace = this.workspaces.get(termId)
    if (!workspace) {
      return sdkErr("policy_denied", "herdr.terminal_not_found", "Workspace pane not found")
    }

    const channel: TerminalChannel = {
      reference,
      clientId: operation.clientId,
      read: async (_maxBytes: number) => sdkOk(new Uint8Array()),
      write: async (data: Uint8Array) => {
        workspace.panes.set(operation.clientId, data)
        return sdkOk(undefined)
      },
      requestInputOwnership: async (op: TerminalOperationContext) => {
        workspace.inputOwner = op.clientId
        return sdkOk({
          schemaVersion: 1,
          terminalId: reference.terminalId,
          ownerClientId: op.clientId,
          changedAt: new Date().toISOString(),
        })
      },
      releaseInputOwnership: async () => {
        workspace.inputOwner = null
        return sdkOk({
          schemaVersion: 1,
          terminalId: reference.terminalId,
          ownerClientId: null,
          changedAt: new Date().toISOString(),
        })
      },
      takeOverInput: async (req: InputTakeoverRequest) => {
        workspace.inputOwner = req.operation.clientId
        return sdkOk({
          schemaVersion: 1,
          terminalId: reference.terminalId,
          ownerClientId: req.operation.clientId,
          changedAt: new Date().toISOString(),
        })
      },
    }

    return sdkOk(channel)
  }

  async resize(
    _reference: TerminalReference,
    _dimensions: TerminalDimensions,
    _operation: TerminalOperationContext,
  ): Promise<SdkResult<void>> {
    return sdkOk(undefined)
  }

  async snapshot(reference: TerminalReference, _operation: TerminalOperationContext): Promise<SdkResult<TerminalSnapshot>> {
    const data = new Uint8Array()
    return sdkOk({
      schemaVersion: 1,
      terminalId: reference.terminalId,
      nodeId: reference.nodeId,
      projectId: reference.projectId,
      sessionId: reference.sessionId,
      capturedAt: new Date().toISOString(),
      byteCount: 0,
      truncated: false,
      data,
    })
  }

  async detach(_reference: TerminalReference, _operation: TerminalOperationContext): Promise<SdkResult<void>> {
    return sdkOk(undefined)
  }

  async terminate(reference: TerminalReference, _operation: TerminalControlOperationContext): Promise<SdkResult<void>> {
    this.workspaces.delete(String(reference.terminalId))
    return sdkOk(undefined)
  }

  async recover(_operation: TerminalOperationContext): Promise<SdkResult<TerminalReference[]>> {
    return sdkOk([])
  }
}

describe("M8.8: Herdr Terminal Backend Experiment and Spike Validation", () => {
  it("satisfies TerminalBackend interface contract and passes conformance checks", async () => {
    const backend = new HerdrExperimentalTerminalBackend()
    const report = await runTerminalBackendConformance(backend)

    expect(report.ok).toBe(true)
    expect(report.suite).toBe("terminal")
    expect(report.targetKind).toBe("herdr-experimental")
    expect(report.passedTests).toContain("kind")
    expect(report.passedTests).toContain("recover")
  })

  it("can be registered as an extension via ExtensionRegistry", () => {
    const registry = new ExtensionRegistry()
    const backend = new HerdrExperimentalTerminalBackend()

    registry.registerTerminalBackend({
      metadata: {
        name: "herdr-experimental-backend",
        version: "0.1.0-alpha",
        aibridgeSdkVersion: AIBRIDGE_SDK_VERSION,
        description: "Experimental Herdr workspace backend",
      },
      backend,
    })

    expect(registry.getTerminalBackend("herdr-experimental")).toBe(backend)
  })

  it("ensures zero production dependencies are added to package.json for Herdr", () => {
    const pkgPath = join(import.meta.dirname, "../../../package.json")
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))

    expect(pkg.dependencies.herdr).toBeUndefined()
    expect(pkg.dependencies["@herdr/core"]).toBeUndefined()
    expect(pkg.devDependencies.herdr).toBeUndefined()
  })

  it("documents ADR 0009 with explicit adopt/defer/reject evaluation", () => {
    const adrPath = join(import.meta.dirname, "../../../Docs/adr/0009-herdr-terminal-backend-evaluation.md")
    const content = readFileSync(adrPath, "utf8")

    expect(content).toContain("ADR 0009")
    expect(content).toContain("DEFERRED")
    expect(content).toContain("Primitive Mapping")
    expect(content).toContain("State-Authority Interaction")
    expect(content).toContain("Input Ownership")
  })
})
