/**
 * The dispatch-context preview (`src/context/preview.ts`): the preview is the
 * manifest, and a preview that drifted from it is reported, not trusted.
 * Kept from the retired memory TUI tests when the view model was removed (3.1.1).
 */

import { describe, expect, it } from "vitest"
import { buildPreview, verifyPreviewMatchesManifest } from "../../../src/context/preview.js"
import { assembleContext } from "../../../src/context/assembler.js"
import type { ContextCandidate, ContextManifestV2 } from "../../../src/context/types.js"
import { digestJson } from "../../../src/orchestration/digest.js"
import { runIdSchema, taskIdSchema, dispatchIdSchema, projectIdSchema, roleIdSchema } from "../../../src/orchestration/identifiers.js"

const NOW = "2026-09-30T12:00:00.000Z"
const PROJECT = projectIdSchema.parse("project-m5-tui")
const RUN = runIdSchema.parse("run-1")
const TASK = taskIdSchema.parse("task-1")
const ROLE = roleIdSchema.parse("role-implementer")
const ROLE_HASH = digestJson({ roleId: ROLE, version: 2 })

function candidate(overrides: Partial<ContextCandidate> & { memoryId: string }): ContextCandidate {
  return {
    source: { kind: "memory", memoryId: overrides.memoryId, memoryKind: "decision" },
    scope: { kind: "project" },
    category: "project_constraints",
    reason: "active_decision",
    text: overrides.text ?? `content of ${overrides.memoryId}`,
    sensitivity: "public_to_project",
    priority: 500,
    optional: true,
    createdAt: NOW,
    ...overrides,
  }
}

async function manifestOf(
  candidates: readonly ContextCandidate[],
  clearance: ContextManifestV2["destination"]["clearance"] = "restricted",
  maximum = 100_000,
): Promise<ContextManifestV2> {
  const assembled = await assembleContext(
    {
      projectId: PROJECT,
      runId: RUN,
      taskId: TASK,
      dispatchId: dispatchIdSchema.parse("dispatch-1"),
      destination: { nodeId: "node-a", roleId: ROLE, clearance },
      roleSnapshotHash: ROLE_HASH,
      policy: { policyVersion: "m5.v1", budget: { maximum, unit: "tokens" } },
      now: NOW,
      correlationId: "corr-tui",
    },
    { provider: { candidates: async () => candidates } },
  )
  if (!assembled.ok) throw new Error(`assembly should succeed: ${assembled.error.code}`)
  return assembled.value
}

describe("the preview is the manifest", () => {
  it("keeps the manifest's included order and sorted exclusions, and verifies clean", async () => {
    const manifest = await manifestOf([
      candidate({ memoryId: "m-low", priority: 100, text: "a low priority note" }),
      candidate({ memoryId: "m-high", priority: 900, text: "a high priority constraint", reason: "active_constraint" }),
      candidate({ memoryId: "m-secret", sensitivity: "prohibited", text: "never shown" }),
      candidate({ memoryId: "m-restricted", sensitivity: "secret_reference_only", text: "the deploy key is in 1Password" }),
    ])
    const preview = buildPreview(manifest)
    expect(verifyPreviewMatchesManifest(preview, manifest)).toEqual([])
    expect(preview.included.map((item) => item.sourceId)).toEqual(manifest.items.map((item) => item.sourceId))
    expect(preview.included.find((item) => item.sourceId === "m-high")?.reason).toBe("active_constraint")
    expect(preview.excluded.map((item) => `${item.sourceId}:${item.reason}`)).toEqual([
      "m-restricted:sensitivity_above_clearance",
      "m-secret:prohibited_content",
    ])
  })

  it("detects a preview that has drifted from its manifest", () => {
    const base = {
      manifestId: "manifest-a",
      schemaVersion: 2 as const,
      projectId: PROJECT,
      runId: RUN,
      taskId: TASK,
      dispatchId: dispatchIdSchema.parse("dispatch-1"),
      roleSnapshotHash: ROLE_HASH,
      items: [],
      excluded: [],
      budget: { maximum: 100, estimated: 0, unit: "tokens" as const },
      policyVersion: "m5.v1",
      destination: { nodeId: "node-a", roleId: ROLE, clearance: "restricted" as const },
      createdAt: NOW,
      digest: digestJson({ a: 1 }),
    }
    const preview = buildPreview(base)
    // A preview that claims a digest the manifest does not have.
    expect(verifyPreviewMatchesManifest({ ...preview, digest: digestJson({ a: 2 }) }, base)).toContain("digest")
    // A preview that claims an exclusion the manifest does not have.
    expect(
      verifyPreviewMatchesManifest(
        {
          ...preview,
          excluded: [{ sourceId: "m-x", category: "project_constraints", reason: "policy_disabled", withheldDetail: false }],
        },
        base,
      ),
    ).toContain("excluded")
  })
})

describe("M5.9 the withheldDetail check fires (SF-11)", () => {
  // The check M5.9 found inert: it compared `source.revealsKind` with
  // `item.withheldDetail`, and `buildPreview` sets the latter to the negation of
  // the former, so `revealsKind === withheldDetail` was never true and an
  // inverted `withheldDetail` was reported as consistent. These four assertions
  // are the difference between a check and a comment.
  const manifestWith = (excluded: readonly ContextManifestV2["excluded"][number][]) => ({
    manifestId: "manifest-a",
    schemaVersion: 2 as const,
    projectId: PROJECT,
    runId: RUN,
    taskId: TASK,
    dispatchId: dispatchIdSchema.parse("dispatch-1"),
    roleSnapshotHash: ROLE_HASH,
    items: [],
    excluded: [...excluded],
    budget: { maximum: 100, estimated: 0, unit: "tokens" as const },
    policyVersion: "m5.v1",
    destination: { nodeId: "node-a", roleId: ROLE, clearance: "restricted" as const },
    createdAt: NOW,
    digest: digestJson({ a: 1 }),
  })

  const sensitive: ContextManifestV2["excluded"][number] = {
    sourceId: "m-secret",
    category: "project_constraints",
    reason: "prohibited_content",
    revealsKind: false,
    scopeKind: "project",
  }
  const ordinary: ContextManifestV2["excluded"][number] = {
    sourceId: "m-pruned",
    category: "project_constraints",
    reason: "budget_exceeded",
    revealsKind: true,
    kind: "handoff",
    scopeKind: "project",
  }

  it("reports a CORRECT withheldDetail as consistent, for both kinds of exclusion", () => {
    const manifest = manifestWith([sensitive, ordinary])
    expect(verifyPreviewMatchesManifest(buildPreview(manifest), manifest)).toEqual([])
  })

  it("reports an INVERTED withheldDetail, and names the source", () => {
    // The manifest says the prohibited record's kind must be withheld; the
    // preview claims it is disclosed. Under the old comparison this returned [].
    const manifest = manifestWith([sensitive])
    const preview = buildPreview(manifest)
    expect(preview.excluded[0]?.withheldDetail).toBe(true)

    const inverted = {
      ...preview,
      excluded: preview.excluded.map((item) => ({ ...item, withheldDetail: false })),
    }
    expect(verifyPreviewMatchesManifest(inverted, manifest)).toEqual(["withheldDetail for m-secret"])
  })

  it("reports the other inversion too: claiming detail is withheld when the manifest allows it", () => {
    // The over-cautious direction. It is not a leak, but it is still a preview
    // that does not describe its manifest, and an operator reading it cannot tell
    // that a pruned `handoff` was in fact nameable.
    const manifest = manifestWith([ordinary])
    const preview = buildPreview(manifest)
    expect(preview.excluded[0]?.withheldDetail).toBe(false)

    const inverted = {
      ...preview,
      excluded: preview.excluded.map((item) => ({ ...item, withheldDetail: true })),
    }
    expect(verifyPreviewMatchesManifest(inverted, manifest)).toEqual(["withheldDetail for m-pruned"])
  })

  it("reports a kind carried beside a non-revealing exclusion", () => {
    // `revealsKind: false` and `kind: "handoff"` is the exact shape
    // `contextExclusionSchema.superRefine` refuses and the exact shape M5.9's
    // SF-4 found an access path producing. The preview object is what the audit
    // reads, so it is checked here too.
    const manifest = manifestWith([sensitive])
    const preview = buildPreview(manifest)
    const contaminated = {
      ...preview,
      excluded: preview.excluded.map((item) => ({ ...item, kind: "handoff" })),
    }
    expect(verifyPreviewMatchesManifest(contaminated, manifest)).toEqual(["kind leaked for m-secret"])
  })

  it("the preview the assembler produces is self-consistent for a real manifest", async () => {
    // `candidate` hard-codes `memoryKind: "decision"`, so the handoff is spelled
    // out here: the whole point of the assertion below is that the exclusion
    // names the record's kind rather than its inclusion reason.
    const handoff: ContextCandidate = {
      source: { kind: "memory", memoryId: "m-pruned", memoryKind: "handoff" },
      scope: { kind: "project" },
      category: "dependency_results",
      reason: "handoff_packet",
      text: "a".repeat(400),
      sensitivity: "public_to_project",
      priority: 500,
      optional: true,
      createdAt: NOW,
    }
    // 400 characters is 100 tokens, so a budget of 50 prunes it.
    const manifest = await manifestOf(
      [handoff, candidate({ memoryId: "m-secret", sensitivity: "prohibited", text: "never shown" })],
      "restricted",
      50,
    )
    // One revealing exclusion and one non-revealing one, from a real assembly
    // rather than a hand-built manifest.
    const preview = buildPreview(manifest)
    const byId = Object.fromEntries(preview.excluded.map((item) => [item.sourceId, item]))
    expect(byId["m-pruned"]?.reason).toBe("budget_exceeded")
    expect(byId["m-pruned"]?.kind).toBe("handoff")
    expect(byId["m-pruned"]?.kind).not.toBe("handoff_packet")
    expect(byId["m-pruned"]?.withheldDetail).toBe(false)
    expect(byId["m-secret"]?.kind).toBeUndefined()
    expect(byId["m-secret"]?.withheldDetail).toBe(true)
    expect(verifyPreviewMatchesManifest(preview, manifest)).toEqual([])
  })
})
