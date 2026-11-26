/**
 * AIBridge Extension SDK — Conformance Test Runner (M8.7).
 *
 * Runs deterministic conformance verification scenarios against any
 * third-party or custom adapter implementation.
 */

import type { AgentRuntimeAdapter, NodeId, MeshId } from "./types.js"

export interface ConformanceReport {
  readonly ok: boolean
  readonly suite: "adapter"
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
