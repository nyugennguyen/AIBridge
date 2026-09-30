/**
 * M5.5: the determinism guarantee, stated as an executable property.
 *
 * The plan's stop condition is "stop if context rendering can differ without a
 * manifest/digest change". These tests are that condition as a test rather than
 * as a review item, and they try to break it in the three ways it could
 * actually break:
 *
 * 1. **Input order.** The provider returns the same candidates in a different
 *    order. A manifest whose digest depends on insertion order is not
 *    deterministic in any sense a reader cares about.
 * 2. **Caller identity.** Two different destinations (node, role, clearance) are
 *    different manifests and MUST differ. This is the test that keeps
 *    determinism from being mistaken for "the same for everybody", which would
 *    be a leak.
 * 3. **Fresh vs cached input.** Two separately-built candidate arrays from
 *    "the repository" produce the same manifest. Pure-function behaviour.
 */

import { describe, expect, it } from "vitest"
import {
  assembleContext,
  bindRenderedDigest,
  renderCandidateText,
  renderContextPrompt,
  renderContextWithContent,
  renderVerifiedContextPrompt,
  sourceIdOf,
  verifyRenderedDigest,
  digestText,
} from "../../../src/context/assembler.js"
import {
  artifactCandidate,
  dispatchCandidate,
  fixedProvider,
  memoryCandidate,
  policy,
  request,
  runSummaryCandidate,
  safetyCandidate,
  ROLE_ID,
} from "./fixtures.js"
import { roleIdSchema } from "../../../src/orchestration/identifiers.js"
import { contextManifestV2Schema, type ContextManifestV2 } from "../../../src/context/types.js"

function shuffle<T>(items: readonly T[], rotation: number): T[] {
  if (items.length === 0) return []
  return [...items.slice(rotation % items.length), ...items.slice(0, rotation % items.length)]
}

const CANDIDATES = [
  safetyCandidate(),
  dispatchCandidate(),
  memoryCandidate({ memoryId: "m-constraint-1", content: "Never expose the OpenCode server.", reason: "active_constraint" }),
  memoryCandidate({ memoryId: "m-decision-1", content: "Use the Tailscale-only bridge endpoint." }),
  artifactCandidate("artifact-report"),
  runSummaryCandidate("summary-1", "Three tasks completed."),
]

describe("M5.5 context assembly is deterministic", () => {
  it("produces a byte-identical manifest from the same candidates in any input order", async () => {
    const first = await assembleContext(request(), { provider: fixedProvider(CANDIDATES) })
    const second = await assembleContext(request(), { provider: fixedProvider(shuffle(CANDIDATES, 3)) })
    const third = await assembleContext(request(), { provider: fixedProvider(shuffle(CANDIDATES, 1)) })

    expect(first.ok && second.ok && third.ok).toBe(true)
    if (!first.ok || !second.ok || !third.ok) return
    expect(second.value.digest).toBe(first.value.digest)
    expect(third.value.digest).toBe(first.value.digest)
    expect(JSON.stringify(second.value)).toBe(JSON.stringify(first.value))
    expect(JSON.stringify(third.value)).toBe(JSON.stringify(first.value))
  })

  it("orders items by fixed category order, then priority desc, then source id asc", async () => {
    const result = await assembleContext(request(), { provider: fixedProvider(CANDIDATES) })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const orderingKeys = result.value.items.map((item) => item.orderingKey)
    expect(orderingKeys).toEqual([...orderingKeys].sort())
    expect(result.value.items.map((item) => item.category)).toEqual([
      "safety_instructions",
      "dispatch_approval",
      "project_constraints",
      "project_constraints",
      "task_references",
      "run_summary",
    ])
  })

  it("breaks a priority tie by source id, so two equal-priority items have one order", async () => {
    const tied = [
      safetyCandidate(),
      memoryCandidate({ memoryId: "m-zzz", content: "z", priority: 500 }),
      memoryCandidate({ memoryId: "m-aaa", content: "a", priority: 500 }),
    ]
    const result = await assembleContext(request(), { provider: fixedProvider(tied) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const constraints = result.value.items.filter((item) => item.category === "project_constraints")
    expect(constraints.map((item) => item.sourceId)).toEqual(["m-aaa", "m-zzz"])
  })

  it("gives DIFFERENT manifests to different destinations, so determinism is not sameness", async () => {
    const toBuilder = await assembleContext(
      request({ destination: { nodeId: "node-a", roleId: ROLE_ID, clearance: "restricted" } }),
      { provider: fixedProvider(CANDIDATES) },
    )
    const toAuditor = await assembleContext(
      request({ destination: { nodeId: "node-b", roleId: roleIdSchema.parse("role-auditor"), clearance: "restricted" } }),
      { provider: fixedProvider(CANDIDATES) },
    )
    expect(toBuilder.ok && toAuditor.ok).toBe(true)
    if (!toBuilder.ok || !toAuditor.ok) return
    expect(toAuditor.value.digest).not.toBe(toBuilder.value.digest)
    expect(toAuditor.value.destination.nodeId).toBe("node-b")
  })

  it("binds a different digest to a different policy version", async () => {
    const base = await assembleContext(request(), { provider: fixedProvider(CANDIDATES) })
    const bumped = await assembleContext(
      request({ policy: policy({ policyVersion: "m5.v2" }) }),
      { provider: fixedProvider(CANDIDATES) },
    )
    expect(base.ok && bumped.ok).toBe(true)
    if (!base.ok || !bumped.ok) return
    expect(bumped.value.digest).not.toBe(base.value.digest)
    expect(base.value.policyVersion).toBe("m5.v1")
  })

  it("reproduces the manifest from independently constructed inputs", async () => {
    // A second construction path: fresh objects, no shared references. A
    // function that mutated its input, or cached on it, would diverge here.
    const rebuilt = [
      safetyCandidate(),
      dispatchCandidate(),
      memoryCandidate({ memoryId: "m-constraint-1", content: "Never expose the OpenCode server.", reason: "active_constraint" }),
      memoryCandidate({ memoryId: "m-decision-1", content: "Use the Tailscale-only bridge endpoint." }),
      artifactCandidate("artifact-report"),
      runSummaryCandidate("summary-1", "Three tasks completed."),
    ]
    const original = await assembleContext(request(), { provider: fixedProvider(CANDIDATES) })
    const fresh = await assembleContext(request(), { provider: fixedProvider(rebuilt) })
    expect(original.ok && fresh.ok).toBe(true)
    if (!original.ok || !fresh.ok) return
    expect(fresh.value.digest).toBe(original.value.digest)
  })
})

describe("M5.5 rendering cannot differ from the manifest", () => {
  it("renders exactly the items the manifest included, in manifest order", async () => {
    const assembled = await assembleContext(request(), { provider: fixedProvider(CANDIDATES) })
    expect(assembled.ok).toBe(true)
    if (!assembled.ok) return

    // The texts must be the *rendered* texts, because that is what the manifest
    // hashed. A caller holding only raw candidate content would produce a
    // different string for a wrapped item, and the digest check would refuse it
    // — which is the correct outcome, so the test supplies rendered text.
    const texts = new Map<string, string>()
    for (const candidate of CANDIDATES) texts.set(sourceIdOf(candidate), renderCandidateText(candidate))

    const rendered = renderContextWithContent(assembled.value, texts)
    expect(rendered.ok).toBe(true)
    if (!rendered.ok) return
    const sectionIds = rendered.value.sections.flatMap((section) => section.sourceIds)
    expect(sectionIds).toEqual(assembled.value.items.map((item) => item.sourceId))
  })

  it("REFUSES to render text whose hash is not the one the manifest recorded", async () => {
    const assembled = await assembleContext(request(), { provider: fixedProvider(CANDIDATES) })
    expect(assembled.ok).toBe(true)
    if (!assembled.ok) return

    const tampered = new Map<string, string>()
    for (const candidate of CANDIDATES) tampered.set(sourceIdOf(candidate), renderCandidateText(candidate))
    tampered.set("m-decision-1", "Swapped in after the manifest was built.")

    const rendered = renderContextWithContent(assembled.value, tampered)
    expect(rendered.ok).toBe(false)
    if (rendered.ok) return
    expect(rendered.error.code).toBe("context.render_digest_mismatch")
    expect(rendered.error.message).not.toContain("Swapped in after")
  })

  it("REFUSES to render when a source's text is missing entirely", async () => {
    const assembled = await assembleContext(request(), { provider: fixedProvider(CANDIDATES) })
    expect(assembled.ok).toBe(true)
    if (!assembled.ok) return

    // Only the first item's text. The rest are genuinely absent, so the
    // assembler must report absence rather than substitute.
    const partial = new Map<string, string>()
    const first = assembled.value.items[0]
    if (!first) throw new Error("expected at least one included item")
    partial.set(first.sourceId, renderCandidateText(CANDIDATES[0]!))

    const rendered = renderContextWithContent(assembled.value, partial)
    expect(rendered.ok).toBe(false)
    if (rendered.ok) return
    expect(rendered.error.code).toBe("context.render_missing_source")
  })

  it("a refused render is a refusal, not a manifest with substituted content", async () => {
    const assembled = await assembleContext(request(), { provider: fixedProvider(CANDIDATES) })
    if (!assembled.ok) throw new Error("assembly should succeed")
    expect(assembled.value.renderedDigest).toBeUndefined()
  })
})

/** The texts the assembler hashed, keyed by `sourceId`. */
function renderedTexts(manifest: ContextManifestV2): Map<string, string> {
  const texts = new Map<string, string>()
  for (const candidate of CANDIDATES) texts.set(sourceIdOf(candidate), renderCandidateText(candidate))
  return new Map(manifest.items.map((item) => [item.sourceId, texts.get(item.sourceId) ?? ""]))
}

async function assemble(): Promise<ContextManifestV2> {
  const result = await assembleContext(request(), { provider: fixedProvider(CANDIDATES) })
  if (!result.ok) throw new Error("assembly should succeed")
  return result.value
}

/**
 * A manifest whose per-item `renderedHash` is the hash of each item's own
 * `sourceId`, so the manifest-only renderer and the content renderer have the
 * same body to emit. Built through `contextManifestV2Schema`, so it is a
 * manifest the real schema would accept and not a hand-rolled lookalike.
 */
function idTextManifest(manifest: ContextManifestV2): ContextManifestV2 {
  return contextManifestV2Schema.parse({
    ...manifest,
    items: manifest.items.map((item) => ({ ...item, renderedHash: digestText(item.sourceId) })),
  })
}

describe("M5.9 there is one rendering of a manifest, and it is verified", () => {
  it("the two renderers produce BYTE-IDENTICAL text for one manifest", async () => {
    const manifest = idTextManifest(await assemble())
    const texts = new Map(manifest.items.map((item) => [item.sourceId, item.sourceId]))

    const withContent = renderContextWithContent(manifest, texts)
    expect(withContent.ok).toBe(true)
    if (!withContent.ok) return

    const named = renderContextPrompt(manifest)
    expect(named.text).toBe(withContent.value.text)
    expect(named.digest).toBe(withContent.value.digest)
    // And the section structure, not just the string.
    expect(named.sections).toEqual(withContent.value.sections)
  })

  it("no caller can choose a heading prefix, so no second text exists for one manifest", async () => {
    const manifest = idTextManifest(await assemble())
    const texts = new Map(manifest.items.map((item) => [item.sourceId, item.sourceId]))
    const withContent = renderContextWithContent(manifest, texts)
    if (!withContent.ok) throw new Error("render should succeed")

    // The prefix is a constant in the assembler, not an argument: the signature
    // takes only a manifest, so a second argument is a compile error for a typed
    // caller.
    expect(renderContextPrompt.length).toBe(1)
    for (const section of withContent.value.sections) {
      expect(withContent.value.text).toContain(`## ${section.title}\n`)
    }

    // And the property that actually matters holds at runtime, which is where a
    // JavaScript caller, or a typed caller who casts, would land. A renderer with
    // a `headingPrefix` option reverts this assertion; a renderer without one
    // ignores the extra argument entirely and produces the same bytes.
    const rogue = (renderContextPrompt as (manifest: ContextManifestV2, options?: unknown) => ReturnType<typeof renderContextPrompt>)(
      manifest,
      { headingPrefix: "#" },
    )
    expect(rogue.text).toBe(withContent.value.text)
    expect(rogue.digest).toBe(withContent.value.digest)
  })

  it("REFUSES to hand out a verified prompt when the manifest records no whole-prompt digest", async () => {
    // This is SF-12's actual hole: `verifyRenderedDigest` returned false when
    // `renderedDigest` was absent, but nothing forced a caller to call it, so a
    // caller could hold a prompt no digest had ever been checked against.
    const manifest = await assemble()
    expect(manifest.renderedDigest).toBeUndefined()

    const verified = renderVerifiedContextPrompt(manifest, renderedTexts(manifest))
    expect(verified.ok).toBe(false)
    if (verified.ok) return
    expect(verified.error.code).toBe("context.rendered_digest_missing")
  })

  it("binds the digest first, then produces a verified prompt that verifies", async () => {
    const manifest = await assemble()
    const texts = renderedTexts(manifest)

    const rendered = renderContextWithContent(manifest, texts)
    if (!rendered.ok) throw new Error("render should succeed")
    const bound = bindRenderedDigest(manifest, rendered.value)
    expect(bound.ok).toBe(true)
    if (!bound.ok) return

    // Binding must not move the manifest digest an approval is taken against.
    expect(bound.value.digest).toBe(manifest.digest)
    expect(bound.value.renderedDigest).toBe(rendered.value.digest)

    const verified = renderVerifiedContextPrompt(bound.value, texts)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.value.verifiedDigest).toBe(bound.value.renderedDigest)
    expect(verified.value.digest).toBe(rendered.value.digest)
    expect(verifyRenderedDigest(bound.value, verified.value)).toBe(true)
  })

  it("REFUSES when every item's hash agrees but the whole-prompt digest does not", async () => {
    // The per-item check cannot see the section titles, the heading prefix, or
    // the separators — the parts a renderer can vary. This is the assertion that
    // a whole-prompt digest is checked at all, and it is the check that was
    // opt-in before.
    const manifest = await assemble()
    const texts = renderedTexts(manifest)
    const unbound = renderContextWithContent(manifest, texts)
    if (!unbound.ok) throw new Error("render should succeed")
    const tampered = contextManifestV2Schema.parse({ ...manifest, renderedDigest: digestText("some other prompt") })

    const verified = renderVerifiedContextPrompt(tampered, texts)
    expect(verified.ok).toBe(false)
    if (verified.ok) return
    expect(verified.error.code).toBe("context.rendered_digest_mismatch")
    // The refusal names digests, never a body.
    expect(verified.error.message).not.toContain("Never expose the OpenCode server")
    expect(unbound.value.text).not.toBe("some other prompt")
  })

  it("REFUSES to rebind a manifest that already records a different prompt", async () => {
    const manifest = await assemble()
    const texts = renderedTexts(manifest)
    const rendered = renderContextWithContent(manifest, texts)
    if (!rendered.ok) throw new Error("render should succeed")
    const bound = bindRenderedDigest(manifest, rendered.value)
    if (!bound.ok) throw new Error("binding should succeed")

    // A manifest whose recorded digest follows whatever it was last handed
    // records nothing. Rebinding to different text is refused.
    const drifted = `${rendered.value.text}\n\none more line`
    const rebound = bindRenderedDigest(bound.value, {
      ...rendered.value,
      text: drifted,
      digest: digestText(drifted),
    })
    expect(rebound.ok).toBe(false)
    if (rebound.ok) return
    expect(rebound.error.code).toBe("context.rendered_digest_mismatch")
    expect(rebound.error.message).not.toContain("Never expose the OpenCode server")
  })

  it("the verified prompt is the same text the unverified one produced", async () => {
    const manifest = await assemble()
    const texts = renderedTexts(manifest)
    const rendered = renderContextWithContent(manifest, texts)
    if (!rendered.ok) throw new Error("render should succeed")
    const bound = bindRenderedDigest(manifest, rendered.value)
    if (!bound.ok) throw new Error("binding should succeed")
    const verified = renderVerifiedContextPrompt(bound.value, texts)
    expect(verified.ok).toBe(true)
    // Verification adds a field; it does not re-render anything differently.
    if (verified.ok) expect(verified.value.text).toBe(rendered.value.text)
  })
})

