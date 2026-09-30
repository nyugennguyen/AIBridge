/**
 * M5.5 — projecting the M5 manifest down to the frozen M0 dispatch-envelope
 * shape.
 *
 * The M0 `contextManifestSchema` is `{ references, manifestDigest }`: a list of
 * source ids with coarse sensitivity labels, and a digest. It is inside the
 * signed M0 contract and cannot be extended without a re-approval, so M5 adds a
 * richer manifest and projects onto it.
 *
 * The projection is lossy in exactly one direction, and this file pins which
 * loss is acceptable:
 *
 * - **Lost:** exclusions, rendered hashes, per-item scope, the destination, the
 *   policy version, the budget. The M0 shape has nowhere to put them.
 * - **Not lost:** the digest. `manifestDigest` is the digest of the FULL M5
 *   manifest, not of the projection, so an approval bound to the M0 shape still
 *   fails verification if anything the operator was shown changed. That is the
 *   whole reason the projection is worth having.
 *
 * `secret_reference_only` items are dropped from the reference list. The M0 axis
 * has no value for "a credential exists here", and mapping it onto `restricted`
 * would put a record into a dispatch envelope that a reader with `restricted`
 * clearance could dereference — a widening introduced purely by the projection.
 * Dropping it is the conservative direction: the reference list is not the
 * context, and the manifest is what the dispatcher renders from.
 *
 * M5.9's SF-18: the projection takes the rendered texts and reports
 * `Buffer.byteLength` of them, because the M0 `byteCount` is a *byte* count and
 * the M5 manifest's `estimatedCost` is in `budget.unit` — `ceil(chars / 4)` under
 * a token budget. A 400-character body used to reach the kernel as
 * `byteCount: 100`.
 */

import { describe, expect, it } from "vitest"
import {
  assembleContext,
  envelopeSensitivityOf,
  renderCandidateText,
  renderContextWithContent,
  toDispatchEnvelopeManifest,
  type DispatchEnvelopeManifest,
} from "../../../src/context/assembler.js"
import { contextManifestSchema, dispatchEnvelopeSchema } from "../../../src/orchestration/schemas.js"
import { digestJson } from "../../../src/orchestration/digest.js"
import {
  artifactIdSchema,
  dispatchIdSchema,
  installationIdSchema,
  nodeIdSchema,
  projectIdSchema,
  projectPathIdSchema,
  roleIdSchema,
  runIdSchema,
  taskIdSchema,
  userIdSchema,
} from "../../../src/orchestration/identifiers.js"
import { digestText } from "../../../src/context/assembler.js"
import type { ContextCandidate, ContextManifestV2 } from "../../../src/context/types.js"

const PROJECT = projectIdSchema.parse("project-m5")
const RUN = runIdSchema.parse("run-m5")
const TASK = taskIdSchema.parse("task-m5")
const DISPATCH = dispatchIdSchema.parse("dispatch-m5")
const ROLE = roleIdSchema.parse("role-implementer")
const ROLE_HASH = digestJson({ roleId: ROLE, version: 4 })
const NOW = "2026-09-30T12:00:00.000Z"

function candidate(overrides: Partial<ContextCandidate> & { memoryId: string }): ContextCandidate {
  return {
    source: { kind: "memory", memoryId: overrides.memoryId, memoryKind: "decision" },
    scope: { kind: "project" },
    category: "project_constraints",
    reason: "active_decision",
    text: `content of ${overrides.memoryId}`,
    sensitivity: "public_to_project",
    priority: 500,
    optional: true,
    createdAt: NOW,
    ...overrides,
  }
}

function candidateId(entry: ContextCandidate): string {
  switch (entry.source.kind) {
    case "memory":
      return entry.source.memoryId
    case "safety_floor":
      return `safety:${entry.source.floorId}`
    case "dispatch":
      return `dispatch:${entry.source.dispatchId}`
    case "artifact":
      return `artifact:${entry.source.artifactId}`
    case "run_summary":
      return `run-summary:${entry.source.summaryId}`
  }
}

/** The texts the manifest hashed, keyed by `sourceId`. The projection refuses anything else. */
function textsFor(manifest: ContextManifestV2, candidates: readonly ContextCandidate[]): Map<string, string> {
  const byId = new Map(candidates.map((entry) => [candidateId(entry), renderCandidateText(entry)]))
  return new Map(manifest.items.map((item) => [item.sourceId, byId.get(item.sourceId) ?? ""]))
}

/** Project, failing the test rather than returning a Result, on a refusal. */
function project(manifest: ContextManifestV2, texts: ReadonlyMap<string, string>): DispatchEnvelopeManifest {
  const result = toDispatchEnvelopeManifest(manifest, texts)
  if (!result.ok) throw new Error(`projection should succeed: ${result.error.code}`)
  return result.value
}

async function assemble(candidates: readonly ContextCandidate[], clearance: "public_to_project" | "restricted" | "secret_reference_only" = "restricted") {
  const result = await assembleContext(
    {
      projectId: PROJECT,
      runId: RUN,
      taskId: TASK,
      dispatchId: DISPATCH,
      destination: { nodeId: nodeIdSchema.parse("node-a"), roleId: ROLE, clearance },
      roleSnapshotHash: ROLE_HASH,
      policy: { policyVersion: "m5.v1", budget: { maximum: 100_000, unit: "tokens" } },
      now: NOW,
      correlationId: "corr-m5",
    },
    { provider: { candidates: async () => candidates } },
  )
  if (!result.ok) throw new Error(`assembly should succeed: ${result.error.code}`)
  return result.value
}

describe("M5.5 the projection satisfies the frozen M0 manifest schema", () => {
  it("produces a value the M0 schema accepts, unchanged", async () => {
    const candidates = [candidate({ memoryId: "m-1" }), candidate({ memoryId: "m-2" })]
    const manifest = await assemble(candidates)
    const projection = project(manifest, textsFor(manifest, candidates))

    // Parsed by the M0 schema itself, so this is the real contract check and not
    // a restatement of it.
    const parsed = contextManifestSchema.parse(projection)
    expect(parsed.references).toHaveLength(2)
    expect(parsed.manifestDigest).toBe(manifest.digest)
  })

  it("carries the FULL manifest digest, not a digest of the projection", async () => {
    const candidates = [candidate({ memoryId: "m-1" })]
    const manifest = await assemble(candidates)
    const projection = project(manifest, textsFor(manifest, candidates))

    // A digest of the projection would be satisfied by any change the M0 shape
    // cannot express — an added exclusion, a changed budget — and the approval
    // would still verify. This is the assertion that stops that.
    expect(projection.manifestDigest).toBe(manifest.digest)
    expect(projection.manifestDigest).not.toBe(digestJson(projection))
  })

  it("a change the M0 shape cannot express still changes the digest", async () => {
    const both = [candidate({ memoryId: "m-1" }), candidate({ memoryId: "m-2" })]
    const one = [candidate({ memoryId: "m-1" }), candidate({ memoryId: "m-secret", sensitivity: "prohibited" })]
    const withBoth = await assemble(both)
    const withOne = await assemble(one)
    // `withOne` differs from `withBoth` only by the *exclusion* of m-2 and the
    // inclusion of an excluded m-secret. The M0 shape would be identical in
    // structure; the digest is not.
    expect(project(withOne, textsFor(withOne, one)).manifestDigest).not.toBe(
      project(withBoth, textsFor(withBoth, both)).manifestDigest,
    )
  })

  it("uses the M0 coarser sensitivity axis, and never widens it", () => {
    expect(envelopeSensitivityOf("public_to_project")).toBe("public")
    expect(envelopeSensitivityOf("restricted")).toBe("confidential")
    // `prohibited` and `secret_reference_only` have no M0 value that would not
    // widen; `restricted` is the closest M0 label, and the projection below
    // drops these items rather than relying on it.
    expect(envelopeSensitivityOf("secret_reference_only")).toBe("restricted")
    expect(envelopeSensitivityOf("prohibited")).toBe("restricted")
  })

  it("drops a secret_reference_only item rather than mapping it onto something readable", async () => {
    const candidates = [
      candidate({ memoryId: "m-public" }),
      candidate({ memoryId: "m-secret-ref", sensitivity: "secret_reference_only" }),
    ]
    const manifest = await assemble(candidates, "secret_reference_only")
    // The item IS in the manifest, at full detail — the manifest is what the
    // dispatcher renders from.
    expect(manifest.items.map((item) => item.sourceId)).toContain("m-secret-ref")

    // But it is NOT in the M0 reference list. `restricted` on the M0 axis would
    // be readable by a reader holding `restricted` clearance, which is a
    // widening caused purely by the projection.
    const projection = project(manifest, textsFor(manifest, candidates))
    expect(projection.references.map((reference) => reference.sourceId)).toEqual(["m-public"])
  })

  it("a prohibited item can never reach the envelope, at any clearance", async () => {
    for (const clearance of ["public_to_project", "restricted", "secret_reference_only"] as const) {
      const candidates = [candidate({ memoryId: "m-secret", sensitivity: "prohibited" })]
      const manifest = await assemble(candidates, clearance)
      expect(manifest.items).toHaveLength(0)
      expect(project(manifest, textsFor(manifest, candidates)).references).toHaveLength(0)
    }
  })

  it("the projection is deterministic", async () => {
    const candidates = [candidate({ memoryId: "m-1" }), candidate({ memoryId: "m-2" })]
    const manifest = await assemble(candidates)
    const texts = textsFor(manifest, candidates)
    expect(JSON.stringify(project(manifest, texts))).toBe(JSON.stringify(project(manifest, texts)))
  })
})

describe("M5.9 byteCount is a byte count, not a token estimate", () => {
  it("reports the real UTF-8 length of the exact text the manifest hashed", async () => {
    // 400 characters. A token budget calls this `ceil(400 / 4)` = 100, which is
    // the SF-18 defect: a number in a field named `byteCount` that is off by 4x.
    const candidates = [candidate({ memoryId: "m-1", text: "x".repeat(400) })]
    const manifest = await assemble(candidates)
    const texts = textsFor(manifest, candidates)
    const item = manifest.items[0]!

    // Precondition: the two numbers really are different here, so the assertion
    // below cannot pass by accident on a body that happens to divide evenly.
    expect(item.estimatedCost).toBe(100)
    expect(item.estimatedCost).not.toBe(400)

    const [reference] = project(manifest, texts).references
    expect(reference?.sourceKind).toBe("memory")
    expect(reference?.sourceId).toBe("m-1")
    expect(reference?.contentDigest).toBe(item.sourceHash)
    expect(reference?.byteCount).toBe(400)
    expect(digestText(texts.get("m-1") ?? "")).toBe(item.renderedHash)
  })

  it("counts bytes, not characters, for a multi-byte body", async () => {
    // 'é' is one character and two UTF-8 bytes. A character count and a token
    // estimate are wrong here in different directions, so this body separates
    // the three candidate meanings of "byteCount".
    const candidates = [candidate({ memoryId: "m-accents", text: "é".repeat(37) })]
    const manifest = await assemble(candidates)
    const [reference] = project(manifest, textsFor(manifest, candidates)).references

    expect(reference?.byteCount).toBe(74)
    expect(reference?.byteCount).not.toBe(manifest.items[0]!.estimatedCost)
  })

  it("REFUSES to report a byte count for text the manifest did not hash", async () => {
    const candidates = [candidate({ memoryId: "m-1", text: "the approved body" })]
    const manifest = await assemble(candidates)
    const tampered = new Map([["m-1", "the body that was swapped in after approval"]])

    const result = toDispatchEnvelopeManifest(manifest, tampered)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("context.render_digest_mismatch")
    // Naming the source is fine; naming the body is the leak this avoids.
    expect(result.error.message).toContain("m-1")
    expect(result.error.message).not.toContain("swapped in")
  })

  it("REFUSES rather than reporting 0 for a source whose text is missing", async () => {
    const candidates = [candidate({ memoryId: "m-1" }), candidate({ memoryId: "m-2" })]
    const manifest = await assemble(candidates)
    const partial = new Map<string, string>([["m-1", renderCandidateText(candidates[0]!)]])

    const result = toDispatchEnvelopeManifest(manifest, partial)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("context.render_missing_source")
  })

  it("the projected byte counts come from text the renderer accepted", async () => {
    const candidates = [candidate({ memoryId: "m-1", text: "the approved body" })]
    const manifest = await assemble(candidates)
    const texts = textsFor(manifest, candidates)

    // The prompt the dispatcher sends contains the body, and the envelope's
    // per-reference count is measured on that same text.
    const rendered = renderContextWithContent(manifest, texts)
    expect(rendered.ok).toBe(true)
    const [reference] = project(manifest, texts).references
    expect(rendered.ok && rendered.value.text).toContain(candidates[0]!.text)
    expect(reference?.byteCount).toBe(Buffer.byteLength(candidates[0]!.text, "utf8"))
  })
})

describe("M5.5 a real dispatch envelope accepts the projected manifest", () => {
  it("fits the M0 dispatchEnvelopeSchema unchanged", async () => {
    const candidates = [
      candidate({ memoryId: "m-1" }),
      candidate({
        memoryId: "m-artifact",
        source: { kind: "artifact", artifactId: artifactIdSchema.parse("artifact-1"), name: "report.md" },
        category: "task_references",
        reason: "task_artifact_reference",
        text: "The verification report.",
        artifactReferences: [artifactIdSchema.parse("artifact-1")],
      }),
    ]
    const manifest = await assemble(candidates)

    const envelope = dispatchEnvelopeSchema.parse({
      schemaVersion: 1,
      dispatchId: DISPATCH,
      attempt: 1,
      projectId: PROJECT,
      runId: RUN,
      taskId: TASK,
      targetNodeId: nodeIdSchema.parse("node-a"),
      installationId: installationIdSchema.parse("install-1"),
      runtimeKind: "opencode",
      projectPathId: projectPathIdSchema.parse("path-1"),
      prompt: "Do the thing.",
      // The M0 `roleTemplateSchema` in full, built through the real contract.
      // A partial hand-written role here would make this test assert against a
      // shape the kernel can never produce.
      roleSnapshot: {
        schemaVersion: 1,
        roleId: ROLE,
        templateVersion: 4,
        projectId: PROJECT,
        name: "Implementer",
        purpose: "Implements one approved task inside a fixed context.",
        instructions: "Follow the approved dispatch exactly.",
        requiredCapabilities: ["read"],
        preferredRuntimeKinds: ["opencode"],
        contextSelectionPolicyReference: { namespace: "policy.context", id: "m5.v1" },
        permissionRestrictions: {
          allowedCapabilities: ["read"],
          deniedCapabilities: [],
          approvalRequirements: { destructiveEffects: true, externalEffects: true, capabilities: [] },
        },
        author: { kind: "user", userId: userIdSchema.parse("user-owner") },
        createdAt: NOW,
      },
      ruleSnapshots: [],
      contextManifest: project(manifest, textsFor(manifest, candidates)),
      requestedCapabilities: ["read"],
      permissionEnvelope: {
        allowedCapabilities: ["read"],
        deniedCapabilities: [],
        approvalRequirements: { destructiveEffects: true, externalEffects: true, capabilities: [] },
      },
      dependencies: [],
      timeoutSeconds: 600,
      controllerEpoch: 1,
    })

    // The envelope's own digest is what an approval binds to, and it now covers
    // the M5 manifest's digest transitively.
    expect(envelope.contextManifest.manifestDigest).toBe(manifest.digest)
    expect(envelope.contextManifest.references.length).toBeGreaterThan(0)
    // And the byte count that reaches the kernel is the real one.
    expect(envelope.contextManifest.references[0]?.byteCount).toBe(Buffer.byteLength(candidates[0]!.text, "utf8"))
  })
})

describe("M5.5 the rendered digest is a second, independent check", () => {
  it("a manifest with no renderedDigest does not claim to have verified", async () => {
    const manifest = await assemble([candidate({ memoryId: "m-1" })])
    // The manifest is built BEFORE rendering, so `renderedDigest` is absent and
    // the dispatcher fills it in. A manifest that claimed to be verified at
    // construction time would be claiming something it cannot know.
    expect(manifest.renderedDigest).toBeUndefined()
  })

  it("rendered text hashes to something the manifest can record", async () => {
    const manifest = await assemble([candidate({ memoryId: "m-1", text: "a stable body" })])
    const item = manifest.items[0]!
    expect(digestText("a stable body")).toBe(item.renderedHash)
  })
})
