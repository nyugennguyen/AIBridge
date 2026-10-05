/**
 * AIBridge Extension SDK — Conformance Test Runner (M8.7).
 *
 * Runs deterministic conformance verification scenarios against any
 * third-party or custom adapter/terminal implementation.
 */

import type { AgentRuntimeAdapter, TerminalBackend } from "./types.js"
import type {
  NodeId,
  MeshId,
  CommandId,
  CorrelationId,
  ProjectId,
  TerminalClientId,
} from "./types.js"

export interface ConformanceReport {
  readonly ok: boolean
  readonly suite: "adapter" | "terminal"
  readonly targetKind: string
  readonly passedTests: readonly string[]
  readonly failures: readonly { readonly test: string; readonly error: string }[]
}

export async function runAdapterConformance(
  adapter: AgentRuntimeAdapter,
): Promise<ConformanceReport> {
  const passed: string[] = []
  const failures: { test: string; error: string }[] = []

  // 1. Kind property inspection
  if (typeof adapter.kind === "string" && adapter.kind.length > 0) {
    passed.push("kind")
  } else {
    failures.push({ test: "kind", error: "Adapter kind must be a non-empty string" })
  }
  // 2. Capabilities declaration check
  if (
    adapter.capabilities &&
    typeof adapter.capabilities.structuredPermissions === "boolean" &&
    typeof adapter.capabilities.reliableCompletion === "boolean"
  ) {
    passed.push("capabilities")
  } else {
    failures.push({
      test: "capabilities",
      error: "Adapter capabilities must conform to RuntimeCapabilities schema",
    })
  }

  // 3. Detection scenario with valid NodeContext
  try {
    const detectResult = await adapter.detect({
      schemaVersion: 1,
      nodeId: "node-conformance" as unknown as NodeId,
      meshId: "mesh-conformance" as unknown as MeshId,
      platform: process.platform,
      architecture: process.arch,
    })

    if (!detectResult.ok) {
      failures.push({ test: "detect", error: detectResult.error.message })
    } else if (!Array.isArray(detectResult.value)) {
      failures.push({ test: "detect", error: "detect() must return an array of AgentInstallation" })
    } else {
      passed.push("detect")
    }
  } catch (e) {
    failures.push({ test: "detect", error: e instanceof Error ? e.message : String(e) })
  }

  return {
    ok: failures.length === 0,
    suite: "adapter",
    targetKind: adapter.kind,
    passedTests: passed,
    failures,
  }
}

export async function runTerminalBackendConformance(
  backend: TerminalBackend,
): Promise<ConformanceReport> {
  const passed: string[] = []
  const failures: { test: string; error: string }[] = []

  // 1. Kind property inspection
  if (typeof backend.kind === "string" && backend.kind.length > 0) {
    passed.push("kind")
  } else {
    failures.push({ test: "kind", error: "Terminal backend kind must be a non-empty string" })
  }

  // 2. Recovery / list test
  try {
    const recoverResult = await backend.recover({
      schemaVersion: 1,
      commandId: "cmd-conf" as unknown as CommandId,
      correlationId: "corr-conf" as unknown as CorrelationId,
      projectId: "proj-conf" as unknown as ProjectId,
      nodeId: "node-conf" as unknown as NodeId,
      clientId: "client-conf" as unknown as TerminalClientId,
    })

    if (!recoverResult.ok) {
      failures.push({ test: "recover", error: recoverResult.error.message })
    } else if (!Array.isArray(recoverResult.value)) {
      failures.push({ test: "recover", error: "recover() must return an array of TerminalReference" })
    } else {
      passed.push("recover")
    }
  } catch (e) {
    failures.push({ test: "recover", error: e instanceof Error ? e.message : String(e) })
  }

  return {
    ok: failures.length === 0,
    suite: "terminal",
    targetKind: backend.kind,
    passedTests: passed,
    failures,
  }
}
