/**
 * M5.5 — the deterministic context assembler.
 *
 * # The one rule
 *
 * `assembleContext` is a pure function. It reads no clock, opens no file, calls
 * no repository, and consults no environment. Everything it needs arrives in
 * `ContextAssemblyRequest` and `ContextCandidate[]`.
 *
 * That is not a style preference, it is the plan's stop condition made
 * executable: "Stop if context rendering can differ without a manifest/digest
 * change." A function that can reach ambient state has an unbounded number of
 * inputs, so no test can prove the property and no reviewer can check it. A pure
 * function has one: build the same inputs twice, get the same bytes.
 *
 * # Order of operations, and why this order
 *
 * 1. **Category order** (`CONTEXT_CATEGORY_ORDER`) — fixed, never policy-tunable.
 *    A policy that could reorder categories could put a run summary above the
 *    safety instructions, and safety instructions that can be moved are not
 *    safety instructions.
 * 2. **Eligibility** — category disabled, untrusted, expired, superseded, or
 *    above clearance. Each failure becomes an *exclusion with a reason*, never a
 *    silence. The plan's "every included item is explainable; every excluded item
 *    has a non-sensitive reason" is only satisfiable if the assembler is the
 *    thing that writes exclusions, because a provider that silently filters
 *    cannot know why.
 * 3. **Redaction** — before rendering, always. A candidate whose text is not
 *    safe is excluded with `prohibited_content`, and an exclusion of that kind
 *    carries `revealsKind: false` and no hash.
 * 4. **Rank** — `priority` descending, then `sourceId` ascending. `sourceId` is
 *    the final key because it is the only one that does not depend on insertion
 *    order, on which reader asked, or on how many records exist.
 * 5. **Budget** — walk the ranked list, include while it fits; when an item does
 *    not fit, skip it and try the next. Pruned items become `budget_exceeded`
 *    exclusions.
 * 6. **Manifest** — every included item gets a `renderedHash` over the exact text
 *    it contributed, then the whole manifest is hashed without its own `digest`.
 *
 * # Why pruning is greedy and can over-prune
 *
 * Step 5 is a single forward pass, not a knapsack. A 6-item, single-dimension
 * optimization has an exact answer, and taking it would make the exclusion list
 * depend on a search order that is not obviously stable. A greedy pass has an
 * obvious, checkable property — "every item is included unless it did not fit at
 * its turn" — and the cost is that a high-cost item ranked above several
 * low-cost ones can push all of them out.
 *
 * That is recorded rather than hidden: the docblock states it, and
 * `tests/unit/context/budget.test.ts` asserts the *specific* set pruned so a
 * future change to the algorithm is a visible diff rather than a silent
 * behaviour change.
 *
 * # What "required" means
 *
 * `optional: false` items are never pruned. If the required set does not fit the
 * budget, the assembly **fails** with `context.budget_exceeded` and no manifest.
 * Producing a manifest that silently omits the safety instructions, because the
 * budget was tight, is the failure this milestone exists to prevent — the
 * dispatch is then approved against a manifest that does not describe what the
 * agent will read.
 */

import { createHash } from "node:crypto"
import { createContractError, type Result } from "../orchestration/errors.js"
import { digestJson } from "../orchestration/digest.js"
import {
  CONTEXT_CATEGORY_ORDER,
  CONTEXT_CATEGORY_TITLES,
  SENSITIVE_EXCLUSION_REASONS,
  SENSITIVITY_RANK,
  mayReadSensitivity,
  type ContextCategory,
  type ContextExclusionReason,
  type ContextInclusionReason,
  type Sensitivity,
} from "../memory/ontology.js"
import {
  contextAssemblyPolicySchema,
  memoryKindOf,
  contextExclusionSchema,
  contextManifestItemSchema,
  contextManifestV2Schema,
  type ContextAssemblyPolicy,
  type ContextAssemblyRequest,
  type ContextCandidate,
  type ContextCandidateProvider,
  type ContextExclusion,
  type ContextManifestItem,
  type ContextManifestV2,
  type ContextTextRedactor,
  type RenderedContext,
  type RenderedContextSection,
} from "./types.js"

/** `sha256:<hex>` over text, via the same canonical rule the kernel uses. */
function digestText(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`
}

/**
 * Cost estimation: `ceil(chars / 4)`, or the byte length for a byte budget.
 *
 * A real tokenizer is deliberately not used. Token counts are model- and
 * library-version-specific, so a manifest hashed with one tokenizer would change
 * digest on a dependency bump — and the whole point of the digest is that a
 * previously-approved dispatch still verifies. A crude stable estimate can be
 * wrong about the real number and right every time, which is the trade this
 * wants.
 */
export function estimateCost(text: string, unit: "tokens" | "bytes"): number {
  return unit === "bytes" ? Buffer.byteLength(text, "utf8") : Math.ceil(text.length / 4)
}

/**
 * Priority resolution: the kind override wins, then the category override, then
 * the candidate's own priority.
 *
 * Kind beats category because it is the more specific statement: an operator who
 * writes `handoff: 999` means "a handoff, wherever it would otherwise land", and
 * a category override is the coarser fallback.
 *
 * The M5.9 review found this function keyed on `candidate.reason` (SF-10), which
 * made `priorityByMemoryKind` a knob keyed on an *inclusion reason*: the
 * documented `{ handoff: 999 }` did nothing and an undocumented
 * `{ handoff_packet: 999 }` reordered the context. `memoryKindOf` is now the only
 * source of the key, and `tests/unit/context/budget.test.ts` asserts both halves
 * — a real kind takes effect, and an inclusion reason does not.
 */
function resolvePriority(candidate: ContextCandidate, policy: ContextAssemblyPolicy): number {
  const kind = memoryKindOf(candidate)
  const byKind = kind === undefined ? undefined : policy.priorityByMemoryKind?.[kind]
  const byCategory = policy.priorityByCategory?.[candidate.category]
  return byKind ?? byCategory ?? candidate.priority
}

const DEFAULT_PRIORITY: Readonly<Record<ContextCategory, number>> = Object.freeze({
  safety_instructions: 1_000,
  dispatch_approval: 900,
  project_constraints: 700,
  dependency_results: 600,
  task_references: 400,
  run_summary: 200,
})

interface Ranked {
  readonly candidate: ContextCandidate
  readonly priority: number
  readonly text: string
  readonly cost: number
  /** The redactor found a credential *reference*. Drives `reference_only`. */
  readonly mentionsSecret: boolean
}

/** The comparator, isolated so a test can assert the order without the assembler. */
export function compareRanked(a: Ranked, b: Ranked): number {
  const categoryDelta =
    CONTEXT_CATEGORY_ORDER[a.candidate.category] - CONTEXT_CATEGORY_ORDER[b.candidate.category]
  if (categoryDelta !== 0) return categoryDelta
  if (a.priority !== b.priority) return b.priority - a.priority
  return sourceIdOf(a.candidate) < sourceIdOf(b.candidate) ? -1 : sourceIdOf(a.candidate) > sourceIdOf(b.candidate) ? 1 : 0
}

/** The stable identity of a candidate's source, used for ordering and dedupe. */
export function sourceIdOf(candidate: ContextCandidate): string {
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

/** Rendering is the assembler's only text-producing step, and it adds a stable prefix. */
export function renderCandidateText(candidate: ContextCandidate): string {
  switch (candidate.source.kind) {
    case "memory":
      return candidate.text
    case "safety_floor":
      return candidate.text
    case "dispatch":
      return `Dispatch ${candidate.source.dispatchId} (approval ${candidate.source.approvalDigest}):\n${candidate.text}`
    case "artifact":
      return `Artifact ${candidate.source.name} (${candidate.source.artifactId}):\n${candidate.text}`
    case "run_summary":
      return candidate.text
  }
}

/**
 * What kind of thing an excluded source was.
 *
 * M5.9's SF-17: this used to be `candidate.reason`, which is an *inclusion*
 * reason, so a `budget_exceeded` exclusion reported `kind: "active_decision"` and
 * the TUI's `renderExclusion` printed it. The field name lied to every consumer,
 * and a field that lies is worse than a field that is absent.
 *
 * For a memory candidate the answer is the record's own ontology kind, carried on
 * the candidate source as `memoryKind` (the same value `resolvePriority` uses —
 * SF-10 was the same bug in the priority lookup). For a non-memory source there
 * is no record kind, so the label is the source discriminant itself, which is
 * both true and useful: "an artifact was left out" is information a reader can
 * act on and information the reason does not already disclose.
 */
export function exclusionKindOf(candidate: ContextCandidate): string | undefined {
  const memoryKind = memoryKindOf(candidate)
  if (memoryKind !== undefined) return memoryKind
  switch (candidate.source.kind) {
    case "safety_floor":
      return "safety_floor"
    case "dispatch":
      return "dispatch_envelope"
    case "artifact":
      return "artifact"
    case "run_summary":
      return "run_summary"
  }
}

/**
 * Reasons whose exclusion must not even name the kind.
 *
 * Derived from the ontology's own `SENSITIVE_EXCLUSION_REASONS` rather than
 * restated here. It was previously a hand-copied duplicate that nothing read
 * (M5.9's SF-21): the invariant "a sensitive exclusion names no kind" was
 * maintained by each call site remembering to pass `false` in the right
 * position, and adding a reason to the ontology set would have left the
 * assembler naming that kind. The `nonRevealing` parameter is defaulted rather
 * than fixed so a test can prove the *derivation* is what decides, not the
 * caller's memory.
 */
const NON_REVEALING: ReadonlySet<ContextExclusionReason> = new Set(SENSITIVE_EXCLUSION_REASONS)

/**
 * Does an exclusion of this reason get to name its kind?
 *
 * The single decision point for the invariant. Every exclusion is built through
 * it, so a reason added to `SENSITIVE_EXCLUSION_REASONS` becomes non-revealing
 * in the assembler with no edit here at all.
 */
export function revealsKindForReason(
  reason: ContextExclusionReason,
  nonRevealing: ReadonlySet<ContextExclusionReason> = NON_REVEALING,
): boolean {
  return !nonRevealing.has(reason)
}

function exclusion(candidate: ContextCandidate, reason: ContextExclusionReason): ContextExclusion {
  const revealsKind = revealsKindForReason(reason)
  const kind = exclusionKindOf(candidate)
  return contextExclusionSchema.parse({
    sourceId: sourceIdOf(candidate),
    // `contextExclusionSchema.superRefine` refuses a `kind` beside
    // `revealsKind: false`, so the omission is load-bearing rather than tidy.
    ...(revealsKind && kind !== undefined ? { kind } : {}),
    category: candidate.category,
    reason,
    revealsKind,
    scopeKind: candidate.scope.kind,
  })
}

export interface AssembleOptions {
  readonly provider: ContextCandidateProvider
  readonly redactor?: ContextTextRedactor
  /** Stable manifest id. Derived from the request when omitted. */
  readonly manifestId?: string
}

/**
 * Assemble a manifest. Pure with respect to everything except `provider`.
 *
 * The provider is the only impure dependency and it is a *read*; supplying the
 * same candidate list twice must produce the same manifest, which
 * `tests/unit/context/determinism.test.ts` asserts by shuffling the input array
 * between runs.
 */
export async function assembleContext(
  request: ContextAssemblyRequest,
  options: AssembleOptions,
): Promise<Result<ContextManifestV2>> {
  const policy = contextAssemblyPolicySchema.parse(request.policy)
  const supplied = await options.provider.candidates(request)
  const excluded: ContextExclusion[] = []
  const eligible: Ranked[] = []

  // Two candidates for one source id is refused, not deduplicated.
  //
  // Deduplicating here would mean picking one of two *different bodies* for the
  // same id, and which one survived would depend on the order the provider
  // happened to return them in. That is precisely the "context rendering can
  // differ without a manifest change" hazard, reached by a different route, and
  // it would be recorded in a manifest an operator had already approved.
  //
  // It is also unrepresentable in the manifest: a source cannot be both included
  // and excluded, so a "duplicate" exclusion for an included source would fail
  // the manifest's own schema. The refusal is the honest answer.
  const bySource = new Map<string, ContextCandidate>()
  for (const candidate of supplied) {
    const id = sourceIdOf(candidate)
    const existing = bySource.get(id)
    if (existing === undefined) {
      bySource.set(id, candidate)
      continue
    }
    return {
      ok: false,
      error: createContractError(
        "validation",
        "context.duplicate_source",
        `Source '${id}' was offered twice with different content; the assembly is refused rather than resolved by arrival order`,
      ),
    }
  }

  const disabled = new Set(policy.disabledCategories ?? [])

  for (const candidate of [...bySource.values()]) {
    if (disabled.has(candidate.category)) {
      excluded.push(exclusion(candidate, "policy_disabled"))
      continue
    }

    if (candidate.sensitivity === "prohibited") {
      excluded.push(exclusion(candidate, "prohibited_content"))
      continue
    }

    if (!mayReadSensitivity(candidate.sensitivity, request.destination.clearance)) {
      excluded.push(exclusion(candidate, "sensitivity_above_clearance"))
      continue
    }

    let text = renderCandidateText(candidate)
    let mentionsSecret = false
    if (options.redactor) {
      const redaction = options.redactor.redact(text, request)
      if (!redaction.safe) {
        excluded.push(exclusion(candidate, "prohibited_content"))
        continue
      }
      text = redaction.text
      mentionsSecret = redaction.mentionsSecret
    }

    const cost = estimateCost(text, policy.budget.unit)
    eligible.push({ candidate, priority: resolvePriority(candidate, policy), text, cost, mentionsSecret })
  }

  eligible.sort(compareRanked)

  const items: ContextManifestItem[] = []
  let estimated = 0
  let requiredOverBudget = false

  for (const ranked of eligible) {
    if (estimated + ranked.cost > policy.budget.maximum) {
      if (!ranked.candidate.optional) {
        requiredOverBudget = true
        // Keep scanning: a later required item may be smaller and would fit. The
        // assembly still fails, but the exclusion list is then complete and
        // honest about *everything* that did not fit.
      }
      excluded.push(exclusion(ranked.candidate, "budget_exceeded"))
      continue
    }
    estimated += ranked.cost
    const sensitivity = ranked.candidate.sensitivity
    const sensitivityDecision = sensitivity === "secret_reference_only" || ranked.mentionsSecret
      ? "reference_only"
      : "within_clearance"
    items.push(
      contextManifestItemSchema.parse({
        sourceId: sourceIdOf(ranked.candidate),
        sourceHash: ranked.candidate.sourceHash ?? digestJson({ kind: ranked.candidate.source.kind }),
        renderedHash: digestText(ranked.text),
        scope: ranked.candidate.scope,
        category: ranked.candidate.category,
        reason: ranked.candidate.reason satisfies ContextInclusionReason,
        sensitivity,
        sensitivityDecision,
        orderingKey: orderingKeyOf(ranked),
        priority: ranked.priority,
        optional: ranked.candidate.optional,
        estimatedCost: ranked.cost,
        ...(ranked.candidate.artifactReferences
          ? { artifactReferences: [...ranked.candidate.artifactReferences] }
          : {}),
      }),
    )
  }

  if (requiredOverBudget) {
    return {
      ok: false,
      error: createContractError(
        "validation",
        "context.budget_exceeded",
        `Required context items do not fit the ${policy.budget.unit} budget of ${policy.budget.maximum}; the assembly is refused rather than rendered without them`,
      ),
    }
  }

  // Exclusions are sorted by the same total order as items so the digest does
  // not depend on the order candidates arrived in.
  excluded.sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0))

  const manifestId = options.manifestId ?? deriveManifestId(request)
  const withoutDigest = {
    manifestId,
    schemaVersion: 2 as const,
    projectId: request.projectId,
    runId: request.runId,
    taskId: request.taskId,
    dispatchId: request.dispatchId,
    roleSnapshotHash: request.roleSnapshotHash,
    items,
    excluded,
    budget: { maximum: policy.budget.maximum, estimated, unit: policy.budget.unit },
    policyVersion: policy.policyVersion,
    destination: request.destination,
    createdAt: request.now,
  }
  const digest = digestJson(withoutDigest)

  return {
    ok: true,
    value: contextManifestV2Schema.parse({ ...withoutDigest, digest }),
  }
}

/** Zero-padded so lexicographic sort agrees with numeric category order. */
function orderingKeyOf(ranked: Ranked): string {
  const category = String(CONTEXT_CATEGORY_ORDER[ranked.candidate.category]).padStart(2, "0")
  const priority = String(10_000 - Math.min(ranked.priority, 10_000)).padStart(5, "0")
  return `${category}:${priority}:${sourceIdOf(ranked.candidate)}`
}

function deriveManifestId(request: ContextAssemblyRequest): string {
  return `manifest_${digestJson({
    correlationId: request.correlationId,
    dispatchId: request.dispatchId,
    policyVersion: request.policy.policyVersion,
  })
    .slice("sha256:".length, "sha256:".length + 40)}`
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The one heading prefix, and the only place it exists.
 *
 * M5.9's SF-12: `renderContextPrompt` used to take a `headingPrefix` option that
 * `renderContextWithContent` could not see, so one manifest had two legal
 * renderings and nothing in either manifest said which one was used. The
 * milestone's stop condition is "stop if context rendering can differ without a
 * manifest/digest change", and a caller-supplied prefix is exactly that: a
 * different prompt, same digest.
 *
 * It was removed rather than hashed into the manifest because the prefix is not
 * a per-dispatch choice — nothing in M5 has a caller with a legitimate reason to
 * render at a different heading level, and the frozen M0 envelope's prompt is a
 * plain string assembled by the dispatcher. A knob nothing needs is a knob that
 * can be turned. The alternative (putting it in `contextManifestV2Schema`) would
 * have meant a manifest field that is either always `"##"` or a second way for
 * two texts to exist.
 */
const HEADING_PREFIX = "##"

/** The category order, as a list. One iteration for both renderers. */
const CATEGORIES: readonly ContextCategory[] = Object.freeze(
  Object.keys(CONTEXT_CATEGORY_ORDER) as ContextCategory[],
)

/**
 * The single section-and-text composer both renderers use.
 *
 * `bodyOf` supplies what each section's body is; everything else — which
 * categories appear, in what order, under which title, joined by which newline
 * — is decided here exactly once. That is what makes "the two renderers produce
 * byte-identical text for one manifest" a structural property rather than a
 * coincidence two functions currently happen to agree on.
 *
 * Cannot fail: the per-item text verification lives in `renderContextWithContent`
 * and runs before this is called.
 */
function composeContext(
  manifest: ContextManifestV2,
  bodyOf: (item: ContextManifestItem) => string,
): RenderedContext {
  const sections: RenderedContextSection[] = []
  for (const category of CATEGORIES) {
    const items = manifest.items.filter((item) => item.category === category)
    if (items.length === 0) continue
    sections.push({
      category,
      title: CONTEXT_CATEGORY_TITLES[category],
      body: items.map(bodyOf).join("\n"),
      sourceIds: items.map((item) => item.sourceId),
      orderingKeys: items.map((item) => item.orderingKey),
    })
  }
  const text = sections.map((section) => `${HEADING_PREFIX} ${section.title}\n${section.body}`).join("\n\n")
  return { sections, text, digest: digestText(text) }
}

/**
 * Render a manifest into prompt text, naming what was included.
 *
 * Takes the manifest and nothing else. It cannot consult the repository, so it
 * is structurally incapable of producing text the manifest does not describe —
 * which is the stop condition, enforced by the signature rather than by review.
 *
 * It emits source *ids* rather than content, because it has none: this is the
 * manifest-only view the TUI preview and the audit need. `renderContextWithContent`
 * is the content-bearing renderer, and both produce the same text for the same
 * section layout — see `composeContext`.
 *
 * Not the function to send. The text this returns has no whole-prompt digest
 * check behind it, so it is for reading, not for dispatch: use
 * `renderVerifiedContextPrompt` for that.
 */
export function renderContextPrompt(manifest: ContextManifestV2): RenderedContext {
  return composeContext(manifest, (item) => item.sourceId)
}

/**
 * Render with the records' actual text.
 *
 * Every item's text is checked against the manifest's `renderedHash` *before*
 * any section is composed, so a text that is not the one the manifest hashed
 * produces a refusal rather than a prompt. That is what makes "rendering cannot
 * differ without a digest change" a runtime check rather than a review item.
 */
export function renderContextWithContent(
  manifest: ContextManifestV2,
  texts: ReadonlyMap<string, string>,
): Result<RenderedContext> {
  for (const item of manifest.items) {
    const text = texts.get(item.sourceId)
    if (text === undefined) {
      return {
        ok: false,
        error: createContractError(
          "validation",
          "context.render_missing_source",
          `No rendered text was supplied for included source '${item.sourceId}'`,
        ),
      }
    }
    if (digestText(text) !== item.renderedHash) {
      return {
        ok: false,
        error: createContractError(
          "validation",
          "context.render_digest_mismatch",
          `Rendered text for '${item.sourceId}' does not match the hash recorded in the manifest; the context would differ from what was approved`,
        ),
      }
    }
  }
  return { ok: true, value: composeContext(manifest, (item) => texts.get(item.sourceId) ?? "") }
}

/** Is the rendered text the one the manifest describes? */
export function verifyRenderedDigest(manifest: ContextManifestV2, rendered: RenderedContext): boolean {
  if (manifest.renderedDigest === undefined) return false
  return manifest.renderedDigest === rendered.digest
}

/**
 * A rendered context whose whole-prompt digest the manifest records and this
 * function confirmed.
 *
 * A distinct type, not a comment. `renderContextWithContent` still returns a
 * bare `RenderedContext` because the dispatcher needs to render before it can
 * record the digest; what must not exist is a *verified* prompt that nobody
 * checked, and the only way to obtain one of these is `renderVerifiedContextPrompt`,
 * which refuses when `manifest.renderedDigest` is absent or disagrees.
 */
export interface VerifiedRenderedContext extends RenderedContext {
  /** Equal to both `rendered.digest` and `manifest.renderedDigest`. */
  readonly verifiedDigest: string
}

/**
 * Record the rendered prompt's digest on the manifest.
 *
 * Does not change `manifest.digest`, so an approval taken before binding still
 * verifies. Refuses to rebind a manifest that already names different text: a
 * manifest whose recorded digest silently follows whatever it was last handed is
 * a manifest that records nothing.
 */
export function bindRenderedDigest(
  manifest: ContextManifestV2,
  rendered: RenderedContext,
): Result<ContextManifestV2> {
  if (manifest.renderedDigest !== undefined && manifest.renderedDigest !== rendered.digest) {
    return {
      ok: false,
      error: createContractError(
        "validation",
        "context.rendered_digest_mismatch",
        `The manifest records a rendered prompt digest of ${manifest.renderedDigest} and the text supplied now hashes to ${rendered.digest}; the manifest is refused rather than rebound`,
      ),
    }
  }
  return { ok: true, value: contextManifestV2Schema.parse({ ...manifest, renderedDigest: rendered.digest }) }
}

/**
 * Render the prompt an approval may be bound to.
 *
 * The gate the stop condition asks for. Per-item `renderedHash` checks bind the
 * *content*; this binds the whole text, including the section titles, the
 * heading prefix, and the separators — the parts no per-item hash covers and the
 * parts a caller could previously vary freely while the manifest digest stayed
 * identical.
 *
 * It refuses when the manifest records no `renderedDigest`, so the sequence
 * `bindRenderedDigest` → `renderVerifiedContextPrompt` is the only route to a
 * verified prompt and "verified" is a state the manifest is in, not something
 * the caller asserts.
 */
export function renderVerifiedContextPrompt(
  manifest: ContextManifestV2,
  texts: ReadonlyMap<string, string>,
): Result<VerifiedRenderedContext> {
  const rendered = renderContextWithContent(manifest, texts)
  if (!rendered.ok) return rendered
  if (manifest.renderedDigest === undefined) {
    return {
      ok: false,
      error: createContractError(
        "validation",
        "context.rendered_digest_missing",
        "The manifest records no whole-prompt digest, so this text could be sent with nothing to verify it against; bind it with bindRenderedDigest first",
      ),
    }
  }
  if (manifest.renderedDigest !== rendered.value.digest) {
    return {
      ok: false,
      error: createContractError(
        "validation",
        "context.rendered_digest_mismatch",
        `The whole prompt hashes to ${rendered.value.digest} but the manifest records ${manifest.renderedDigest}; the context would differ from what was approved`,
      ),
    }
  }
  return { ok: true, value: { ...rendered.value, verifiedDigest: rendered.value.digest } }
}

/** The frozen M0 `contextManifest`, as M5 produces it. */
export interface DispatchEnvelopeManifest {
  readonly references: readonly {
    readonly sourceKind: "memory"
    readonly sourceId: string
    readonly contentDigest: string
    readonly sensitivity: "public" | "internal" | "confidential" | "restricted"
    readonly byteCount: number
  }[]
  readonly manifestDigest: string
}

/**
 * Project to the frozen M0 `contextManifest` for the dispatch envelope.
 *
 * Lossy in one direction by necessity: the M0 shape has no exclusions, no
 * rendered hashes, and no destination. The `manifestDigest` is the M5 digest of
 * the *full* manifest, not a digest of the projection, so an approval bound to
 * the M0 shape still fails verification if anything in the manifest the operator
 * was shown changed.
 *
 * `texts` is **required**, and the reason is M5.9's SF-18: this used to report
 * `item.estimatedCost` as the frozen `byteCount`, but `estimatedCost` is in
 * `budget.unit` and a token budget makes it `ceil(chars / 4)` — a 400-character
 * body was reported as `byteCount: 100`, a number that is wrong for every
 * multi-byte body and for every non-multiple-of-four body.
 *
 * Omitting the field was the other option and the schema does allow it, but
 * `byteCount` is a *required* property of every M0 `contextReference` variant
 * (`contextReferenceSchema`, inside the signed M0 digest), so omitting it would
 * mean not producing an M0 envelope at all. The real byte length is knowable
 * only from the text itself, so the text is the argument. It is verified against
 * the item's `renderedHash` first, which makes `byteCount` a count of exactly
 * the bytes the manifest hashed — the two cannot drift.
 */
export function toDispatchEnvelopeManifest(
  manifest: ContextManifestV2,
  texts: ReadonlyMap<string, string>,
): Result<DispatchEnvelopeManifest> {
  const references: DispatchEnvelopeManifest["references"][number][] = []
  for (const item of manifest.items) {
    if (SENSITIVITY_RANK[item.sensitivity] >= SENSITIVITY_RANK.secret_reference_only) continue
    const text = texts.get(item.sourceId)
    if (text === undefined) {
      return {
        ok: false,
        error: createContractError(
          "validation",
          "context.render_missing_source",
          `No rendered text was supplied for included source '${item.sourceId}'; its byte count cannot be reported`,
        ),
      }
    }
    if (digestText(text) !== item.renderedHash) {
      return {
        ok: false,
        error: createContractError(
          "validation",
          "context.render_digest_mismatch",
          `Rendered text for '${item.sourceId}' does not match the hash recorded in the manifest; its byte count would describe text the manifest did not hash`,
        ),
      }
    }
    references.push({
      sourceKind: "memory",
      sourceId: item.sourceId,
      contentDigest: item.sourceHash,
      sensitivity: envelopeSensitivityOf(item.sensitivity),
      byteCount: Buffer.byteLength(text, "utf8"),
    })
  }
  return { ok: true, value: { references, manifestDigest: manifest.digest } }
}

/** M0's coarser sensitivity axis, for the frozen envelope shape only. */
export function envelopeSensitivityOf(sensitivity: Sensitivity): "public" | "internal" | "confidential" | "restricted" {
  if (sensitivity === "public_to_project") return "public"
  if (sensitivity === "restricted") return "confidential"
  return "restricted"
}

export { DEFAULT_PRIORITY, NON_REVEALING, digestText }
