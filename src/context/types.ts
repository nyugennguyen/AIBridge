/**
 * M5.5 — the context manifest contract.
 *
 * The manifest is produced *before* any text is rendered, and the rendered text
 * is a pure function of it. That ordering is the milestone's stop condition —
 * "stop if context rendering can differ without a manifest/digest change" — so
 * it is enforced structurally: `renderContextPrompt` takes a manifest and a
 * renderer, has no access to the repository, and cannot consult a clock.
 *
 * # Why this is not the M0 `contextManifest`
 *
 * The M0 `contextManifestSchema` (in `src/orchestration/schemas.ts`, inside the
 * signed contract digest) is `{ references, manifestDigest }` — a list of
 * source ids and a digest. That is enough to bind an approval to *which*
 * records were referenced, and not enough to answer "what exactly will the
 * agent read, and what was left out, and why".
 *
 * M5 therefore defines a richer manifest here and adds
 * `toDispatchEnvelopeManifest`, which projects it down to the M0 shape. The
 * projection is lossy in exactly one direction — the M0 shape cannot carry
 * exclusions or hashes — and `tests/unit/context/envelope-projection.test.ts`
 * asserts the projection's digest is the M0 `manifestDigest`, so an approval
 * still binds to a value the kernel understands while the TUI shows the full
 * explanation.
 *
 * # Determinism
 *
 * Three independent sources of nondeterminism are removed, and each is named
 * because "deterministic" without saying *what* used to vary is not a test:
 *
 * 1. **Ordering.** Fixed category order, then `priority` descending, then
 *    `sourceId` ascending. `sourceId` is the last key precisely because it is
 *    the only one independent of insertion order and reader identity.
 * 2. **Budget.** Token estimation is `ceil(chars / 4)` — a fixed integer
 *    function of the rendered text, never a tokenizer, because tokenizers
 *    change between library versions and a manifest that hashes differently
 *    after a dependency bump is a manifest that cannot be approved against.
 * 3. **Content.** The digest is taken over the manifest *without* its own
 *    `digest` field, and every hash is of validated text. Two assemblies with
 *    the same inputs and policy produce byte-identical manifests; the test
 *    asserts it by building the same manifest twice from separately-queried
 *    repositories whose records arrived in different orders.
 */

import { z } from "zod"
import {
  contextCategorySchema,
  contextExclusionReasonSchema,
  contextInclusionReasonSchema,
  sensitivitySchema,
  type ContextCategory,
  type ContextExclusionReason,
  type ContextInclusionReason,
  type Sensitivity,
} from "../memory/ontology.js"
import {
  artifactIdSchema,
  dispatchIdSchema,
  projectIdSchema,
  roleIdSchema,
  runIdSchema,
  taskIdSchema,
  digestSchema,
  schemaVersionSchema,
  timestampSchema,
} from "../orchestration/identifiers.js"
import { addMismatch, isUnique, nonnegativeSafeIntegerSchema, positiveSafeIntegerSchema, shortTextSchema } from "../memory/primitives.js"

/**
 * One included record.
 *
 * `sourceHash` is the record's own content hash and `renderedHash` is the hash
 * of the exact text this item contributed. They are stored separately on
 * purpose: they differ whenever the renderer reformats a record (truncation,
 * a heading, a label), and an operator asking "did the *content* change or just
 * the *presentation*?" needs that distinction answered by data rather than by
 * re-running the assembler and guessing.
 */
export const contextManifestItemSchema = z
  .object({
    sourceId: z.string().min(1).max(256),
    /** The record's `contentHash`, when it came from memory. */
    sourceHash: digestSchema,
    /** Hash of the text this item actually contributed to the prompt. */
    renderedHash: digestSchema,
    scope: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("project") }).strict(),
      z.object({ kind: z.literal("run"), runId: runIdSchema }).strict(),
      z.object({ kind: z.literal("task"), runId: runIdSchema, taskId: taskIdSchema }).strict(),
      z
        .object({ kind: z.literal("dispatch"), runId: runIdSchema, taskId: taskIdSchema, dispatchId: dispatchIdSchema })
        .strict(),
      z
        .object({
          kind: z.literal("session"),
          runId: runIdSchema,
          taskId: taskIdSchema,
          dispatchId: dispatchIdSchema,
          sessionId: z.string().min(1).max(128),
        })
        .strict(),
    ]),
    category: contextCategorySchema,
    reason: contextInclusionReasonSchema,
    sensitivity: sensitivitySchema,
    /** The record's sensitivity vs the reader's clearance, as a decision not a verdict. */
    sensitivityDecision: z.enum(["within_clearance", "reference_only", "withheld"]),
    /** Sort key: category order, then priority, then source id. Rendered for the TUI. */
    orderingKey: z.string().min(1).max(256),
    priority: positiveSafeIntegerSchema,
    /** Optional items are the first to be pruned by the budget. */
    optional: z.boolean(),
    /** Estimated cost in `budget.unit`. */
    estimatedCost: nonnegativeSafeIntegerSchema,
    /** Artifacts this item points at, by id. Never contents. */
    artifactReferences: z.array(artifactIdSchema).max(128).refine(isUnique).optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.sensitivityDecision === "reference_only" && item.sensitivity !== "secret_reference_only") {
      addMismatch(
        ctx,
        ["sensitivityDecision"],
        "Only a secret_reference_only item may be included as a reference; any other included sensitivity is within clearance",
      )
    }
    if (item.sensitivityDecision === "withheld") {
      addMismatch(
        ctx,
        ["sensitivityDecision"],
        "A withheld sensitivity cannot be an included item; it belongs in `excluded` with a reason",
      )
    }
  })

export type ContextManifestItem = z.infer<typeof contextManifestItemSchema>

/**
 * One exclusion.
 *
 * Carries a reason and, where the reason is not itself sensitive, the source id
 * and kind. It never carries content, a summary, a title, or a content hash —
 * a hash of a prohibited record's content is a fingerprint an attacker can
 * confirm guesses against, and the integration test scans the whole serialized
 * manifest for seeded secrets precisely because this is the field most likely
 * to leak by accident.
 */
export const contextExclusionSchema = z
  .object({
    sourceId: z.string().min(1).max(256),
    /**
     * What kind of thing was left out — **unless** the exclusion reason makes
     * that itself sensitive, in which case the field is absent.
     *
     * Two vocabularies live here, deliberately. A *memory* candidate reports its
     * ontology kind (`handoff`, `decision`); a non-memory candidate reports its
     * source discriminant (`safety_floor`, `dispatch_envelope`, `artifact`,
     * `run_summary`). A single vocabulary would mean either labelling a dispatch
     * envelope with a memory kind that does not exist, or omitting `kind` for
     * every non-memory source and making the field useless for exactly the
     * exclusions an operator most wants to see — "the artifact was left out" is
     * actionable and discloses nothing the reason does not already say.
     *
     * A consumer that filters on this field must therefore handle both. The M5.9
     * review found it carrying the *inclusion reason* instead (SF-17), which was
     * neither vocabulary and lied to every reader including the TUI.
     */
    kind: z.string().min(1).max(64).optional(),
    category: contextCategorySchema,
    reason: contextExclusionReasonSchema,
    /** False when the reason forbids even naming the kind. */
    revealsKind: z.boolean(),
    /** The scope the item would have had, when stating it leaks nothing. */
    scopeKind: z
      .enum(["project", "run", "task", "dispatch", "session", "external"])
      .optional(),
  })
  .strict()
  .superRefine((exclusion, ctx) => {
    if (!exclusion.revealsKind && exclusion.kind !== undefined) {
      addMismatch(ctx, ["kind"], "An exclusion that does not reveal its kind must not name one")
    }
  })

export type ContextExclusion = z.infer<typeof contextExclusionSchema>

/**
 * The immutable manifest.
 *
 * `digest` is the value a dispatch approval binds to. `renderedDigest` is
 * computed after rendering and is present so a mismatch between the two — which
 * would mean the renderer produced something the manifest did not describe — is
 * detectable rather than invisible.
 */
export const contextManifestV2Schema = z
  .object({
    manifestId: z.string().min(1).max(128),
    schemaVersion: schemaVersionSchema,
    projectId: projectIdSchema,
    runId: runIdSchema,
    taskId: taskIdSchema,
    dispatchId: dispatchIdSchema,
    /** The role snapshot this assembly was bound to. Approval binds to this too. */
    roleSnapshotHash: digestSchema,
    items: z.array(contextManifestItemSchema).max(512),
    excluded: z.array(contextExclusionSchema).max(512),
    budget: z
      .object({
        maximum: positiveSafeIntegerSchema,
        estimated: nonnegativeSafeIntegerSchema,
        unit: z.enum(["tokens", "bytes"]),
      })
      .strict(),
    policyVersion: z.string().min(1).max(64),
    /** The role/node the manifest was assembled for. Not advisory. */
    destination: z
      .object({
        nodeId: z.string().min(1).max(128),
        roleId: roleIdSchema,
        clearance: sensitivitySchema,
      })
      .strict(),
    createdAt: timestampSchema,
    digest: digestSchema,
    /** Digest of the rendered prompt text. Equal-by-construction; asserted. */
    renderedDigest: digestSchema.optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const orderingKeys = manifest.items.map((item) => item.orderingKey)
    if (!isUnique(orderingKeys)) {
      addMismatch(ctx, ["items"], "Included items must have unique ordering keys; a tie would make the order reader-dependent")
    }
    const sourceIds = manifest.items.map((item) => item.sourceId)
    if (!isUnique(sourceIds)) {
      addMismatch(ctx, ["items"], "A source may appear at most once in a manifest")
    }
    const excludedIds = manifest.excluded.map((exclusion) => exclusion.sourceId)
    if (!isUnique(excludedIds)) {
      addMismatch(ctx, ["excluded"], "A source must not appear more than once in the exclusion list")
    }
    const overlap = sourceIds.filter((id) => excludedIds.includes(id))
    if (overlap.length > 0) {
      addMismatch(ctx, ["excluded"], `Sources cannot be both included and excluded: ${overlap.join(", ")}`)
    }
    const included = manifest.items.reduce((total, item) => total + item.estimatedCost, 0)
    if (manifest.budget.estimated < included) {
      addMismatch(
        ctx,
        ["budget", "estimated"],
        "Budget estimate must cover every included item; the sum of item costs is the estimate",
      )
    }
    if (manifest.budget.estimated > manifest.budget.maximum) {
      addMismatch(
        ctx,
        ["budget"],
        "An assembly that exceeds its budget is a failure, not a context; the required items must fit or the assembly must be refused",
      )
    }
  })

export type ContextManifestV2 = z.infer<typeof contextManifestV2Schema>

/**
 * Where a candidate item came from. Determines its category and its reason.
 *
 * The `memory` variant carries the record's **kind**, not just its id. It did not
 * at first, and the M5.9 review found the consequence as SF-10: the assembler's
 * `priorityByMemoryKind` policy knob was looked up with
 * `kindOfCandidate(candidate)`, which returned `candidate.reason` — an
 * *inclusion reason*. An operator's `{ handoff: 999 }` did nothing, and an
 * undocumented `{ handoff_packet: 999 }` silently reordered the context. A policy
 * knob whose key is not the thing its name says is worse than no knob, because it
 * looks like it is working.
 */
export const contextCandidateSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("memory"),
      memoryId: z.string().min(1).max(256),
      /** The record's ontology kind, e.g. `handoff`. Drives `priorityByMemoryKind`. */
      memoryKind: z.string().min(1).max(64),
    })
    .strict(),
  z.object({ kind: z.literal("safety_floor"), floorId: z.string().min(1).max(128) }).strict(),
  z
    .object({
      kind: z.literal("dispatch"),
      dispatchId: dispatchIdSchema,
      roleSnapshotHash: digestSchema,
      approvalDigest: digestSchema,
    })
    .strict(),
  z.object({ kind: z.literal("artifact"), artifactId: artifactIdSchema, name: shortTextSchema }).strict(),
  z.object({ kind: z.literal("run_summary"), summaryId: z.string().min(1).max(256) }).strict(),
])

export type ContextCandidateSource = z.infer<typeof contextCandidateSourceSchema>

/** The memory kind a candidate came from, or `undefined` if it is not a record. */
export function memoryKindOf(candidate: ContextCandidate): string | undefined {
  return candidate.source.kind === "memory" ? candidate.source.memoryKind : undefined
}

/** A candidate before selection: content, provenance, and a policy hint. */
export interface ContextCandidate {
  readonly source: ContextCandidateSource
  readonly scope: ContextManifestItem["scope"]
  readonly category: ContextCategory
  readonly reason: ContextInclusionReason
  /** The text this candidate would render to. Never already redacted by assumption. */
  readonly text: string
  readonly sensitivity: Sensitivity
  readonly priority: number
  readonly optional: boolean
  readonly createdAt: string
  readonly artifactReferences?: readonly string[]
  /** A rendered digest, computed by the assembler. Candidates never carry their own. */
  sourceHash?: string
}

/** Policy input. Deterministic and totally ordered; the version is part of the digest. */
export const contextAssemblyPolicySchema = z
  .object({
    policyVersion: z.string().min(1).max(64),
    budget: z
      .object({
        maximum: positiveSafeIntegerSchema,
        unit: z.enum(["tokens", "bytes"]),
      })
      .strict(),
    /**
     * Per-category priority *overrides*, sparse by design.
     *
     * `z.record(z.enum(...), T)` in Zod 4 demands every key, which would force
     * an operator who wants to raise one category to restate the other five. A
     * total record is more auditable and a sparse one is more usable; the
     * auditability is recovered instead by putting `policyVersion` in the
     * manifest digest, so a policy change is visible in the manifest whether or
     * not this map is total.
     */
    priorityByCategory: z.partialRecord(contextCategorySchema, positiveSafeIntegerSchema).optional(),
    /** Categories the policy refuses entirely. Their candidates are excluded, not silently dropped. */
    disabledCategories: z.array(contextCategorySchema).max(6).optional(),
    /** Per-kind priority overrides, sparse for the same reason. */
    priorityByMemoryKind: z.record(z.string().min(1).max(64), positiveSafeIntegerSchema).optional(),
  })
  .strict()

export type ContextAssemblyPolicy = z.infer<typeof contextAssemblyPolicySchema>

export interface ContextAssemblyRequest {
  readonly projectId: string
  readonly runId: string
  readonly taskId: string
  readonly dispatchId: string
  readonly destination: ContextManifestV2["destination"]
  readonly roleSnapshotHash: string
  readonly policy: ContextAssemblyPolicy
  /** Supplied by the caller. The assembler never reads a clock. */
  readonly now: string
  readonly correlationId: string
}

/** One rendered section. Sections are the unit the TUI previews. */
export interface RenderedContextSection {
  readonly category: ContextCategory
  readonly title: string
  readonly body: string
  readonly sourceIds: readonly string[]
  readonly orderingKeys: readonly string[]
}

export interface RenderedContext {
  readonly sections: readonly RenderedContextSection[]
  readonly text: string
  readonly digest: string
}

/**
 * Where candidates come from.
 *
 * Deliberately not a `MemoryRepository`. The assembler is a pure function from
 * (candidates, policy, request) to (manifest, rendered text): it has no clock,
 * no filesystem, and no knowledge that memory exists. Everything it needs is in
 * `ContextCandidate`.
 *
 * This is what makes the determinism guarantee testable. A test can shuffle the
 * candidate array, build it from a different repository, or synthesize impossible
 * candidates, and the manifest must come out byte-identical. If the assembler
 * could reach into a repository, "the same inputs" would be unfalsifiable —
 * "the same inputs" would mean "whatever the database said at the time".
 */
export interface ContextCandidateProvider {
  /**
   * Every candidate that *could* be included, in any order.
   *
   * The provider is responsible for access control: a record the reader may not
   * see is not a candidate with an exclusion reason, it is absent. The assembler
   * then cannot leak it by rendering it, and cannot leak its *existence* either,
   * because there is nothing to report.
   *
   * Candidates that were filtered for policy reasons the operator should see
   * (untrusted, superseded, budget-pruned) are returned and become exclusions —
   * those are the "every included item is explainable, every excluded item has a
   * non-sensitive reason" criteria, and they are post-access-check facts.
   */
  candidates(request: ContextAssemblyRequest): Promise<readonly ContextCandidate[]>
}

/**
 * Redaction as the assembler sees it.
 *
 * A one-method port rather than the M5.4 `RedactionPipeline`, so the assembler
 * does not import the redaction module and the two can be built and tested
 * independently. `M5.4`'s pipeline satisfies this shape.
 *
 * It is a *precondition* on assembly, not a filter: a candidate whose text
 * redacts to `prohibited` is excluded with `prohibited_content` and never
 * rendered. The plan's ordering — "redaction runs before persistence when input
 * is prohibited and before transmission when destination restrictions apply" —
 * puts it on both sides of this function.
 */
export interface ContextTextRedactor {
  /**
   * Classify and, where safe, replace. Returns `undefined` when the text is
   * acceptable as-is.
   *
   * Returning a *classification* rather than only a cleaned string is what lets
   * the manifest say `sensitivityDecision: "reference_only"` for a
   * `secret_reference_only` candidate: the redactor knows the text mentions a
   * credential, the assembler does not.
   */
  redact(text: string, request: ContextAssemblyRequest): ContextRedactionResult
}

export interface ContextRedactionResult {
  readonly safe: boolean
  readonly text: string
  readonly mentionsSecret: boolean
  /** The redacted-from rule ids. For the manifest; never the matched text. */
  readonly ruleIds: readonly string[]
}

export type { ContextCategory, ContextExclusionReason, ContextInclusionReason, Sensitivity }
