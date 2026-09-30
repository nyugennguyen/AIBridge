/**
 * M5.5 test fixtures.
 *
 * Everything is built through the OWNING schema and then re-parsed, so a fixture
 * that assembled a candidate by hand could not satisfy a manifest with values the
 * real pipeline could never produce.
 *
 * Nothing here reads a clock. `NOW` is a constant, and every request echoes it,
 * because an assembler that read the clock would make every determinism test in
 * this directory a coin flip.
 */

import {
  contextAssemblyPolicySchema,
  type ContextAssemblyRequest,
  type ContextManifestV2,
} from "../../../src/context/types.js"
import { digestJson } from "../../../src/orchestration/digest.js"
import { roleIdSchema, runIdSchema, taskIdSchema, dispatchIdSchema, artifactIdSchema } from "../../../src/orchestration/identifiers.js"
import type { ContextCandidate, ContextCandidateProvider } from "../../../src/context/types.js"

export const NOW = "2026-09-30T12:00:00.000Z"
export const PROJECT_ID = "project-m5"
export const RUN_ID = "run-m5"
export const TASK_ID = "task-m5"
export const DISPATCH_ID = dispatchIdSchema.parse("dispatch-m5")
export const NODE_ID = "node-a"
export const ROLE_ID = roleIdSchema.parse("role-implementer")
export const CORRELATION_ID = "corr-m5"
export const ROLE_SNAPSHOT_HASH = digestJson({ roleId: ROLE_ID, version: 3 })

export function scope(kind: "project" | "run" | "task" = "project"): ContextCandidate["scope"] {
  if (kind === "project") return { kind: "project" }
  if (kind === "run") return { kind: "run", runId: runIdSchema.parse(RUN_ID) }
  return { kind: "task", runId: runIdSchema.parse(RUN_ID), taskId: taskIdSchema.parse(TASK_ID) }
}

export function policy(overrides: Record<string, unknown> = {}) {
  return contextAssemblyPolicySchema.parse({
    policyVersion: "m5.v1",
    budget: { maximum: 100_000, unit: "tokens" },
    ...overrides,
  })
}

export function request(overrides: Partial<ContextAssemblyRequest> = {}): ContextAssemblyRequest {
  return {
    projectId: PROJECT_ID,
    runId: RUN_ID,
    taskId: TASK_ID,
    dispatchId: DISPATCH_ID,
    destination: { nodeId: NODE_ID, roleId: ROLE_ID, clearance: "restricted" },
    roleSnapshotHash: ROLE_SNAPSHOT_HASH,
    policy: policy(),
    now: NOW,
    correlationId: CORRELATION_ID,
    ...overrides,
  }
}

/** A memory candidate. `text` is the stored content; the assembler renders it. */
export function memoryCandidate(input: {
  memoryId: string
  content: string
  category?: ContextCandidate["category"]
  reason?: ContextCandidate["reason"]
  priority?: number
  optional?: boolean
  sensitivity?: ContextCandidate["sensitivity"]
  scope?: ContextCandidate["scope"]
  createdAt?: string
  artifactReferences?: readonly string[]
}): ContextCandidate {
  return {
    source: { kind: "memory", memoryId: input.memoryId, memoryKind: "decision" },
    scope: input.scope ?? scope(),
    category: input.category ?? "project_constraints",
    reason: input.reason ?? "active_decision",
    text: input.content,
    sensitivity: input.sensitivity ?? "public_to_project",
    priority: input.priority ?? 500,
    optional: input.optional ?? true,
    createdAt: input.createdAt ?? NOW,
    ...(input.artifactReferences ? { artifactReferences: input.artifactReferences } : {}),
  }
}

/** The safety floor item. Non-optional by construction — that is the point. */
export function safetyCandidate(text = "Never weaken the safety floor."): ContextCandidate {
  return {
    source: { kind: "safety_floor", floorId: "floor.default" },
    scope: scope(),
    category: "safety_instructions",
    reason: "safety_floor",
    text,
    sensitivity: "public_to_project",
    priority: 1_000,
    optional: false,
    createdAt: NOW,
  }
}

export function dispatchCandidate(text = "Approved envelope for this dispatch."): ContextCandidate {
  return {
    source: {
      kind: "dispatch",
      dispatchId: DISPATCH_ID,
      roleSnapshotHash: ROLE_SNAPSHOT_HASH,
      approvalDigest: digestJson({ dispatchId: DISPATCH_ID }),
    },
    scope: scope("task"),
    category: "dispatch_approval",
    reason: "approved_dispatch",
    text,
    sensitivity: "public_to_project",
    priority: 900,
    optional: false,
    createdAt: NOW,
  }
}

export function artifactCandidate(artifactId: string, name = "report.md", text = "artifact body"): ContextCandidate {
  return {
    source: { kind: "artifact", artifactId: artifactIdSchema.parse(artifactId), name },
    scope: scope("task"),
    category: "task_references",
    reason: "task_artifact_reference",
    text,
    sensitivity: "public_to_project",
    priority: 400,
    optional: true,
    createdAt: NOW,
    artifactReferences: [artifactId],
  }
}

export function runSummaryCandidate(summaryId: string, text: string): ContextCandidate {
  return {
    source: { kind: "run_summary", summaryId },
    scope: scope("run"),
    category: "run_summary",
    reason: "run_summary",
    text,
    sensitivity: "public_to_project",
    priority: 200,
    optional: true,
    createdAt: NOW,
  }
}

/** A provider that returns a fixed list. Order of the input is irrelevant by design. */
export function fixedProvider(candidates: readonly ContextCandidate[]): ContextCandidateProvider {
  return {
    candidates: async () => candidates,
  }
}

export function manifestTexts(
  manifest: ContextManifestV2,
  candidates: readonly ContextCandidate[],
): Map<string, string> {
  const byId = new Map(candidates.map((candidate) => [sourceId(candidate), candidate.text]))
  return new Map(manifest.items.map((item) => [item.sourceId, byId.get(item.sourceId) ?? ""]))
}

function sourceId(candidate: ContextCandidate): string {
  switch (candidate.source.kind) {
    case "memory":
      return candidate.source.memoryId
    case "safety_floor":
      return `safety:${candidate.source.floorId}`
    case "dispatch":
      return `dispatch:${candidate.source.dispatchId}`
    case "artifact":
      return `artifact:${candidate.source.artifactId}`
    case "run_summary":
      return `run-summary:${candidate.source.summaryId}`
  }
}
