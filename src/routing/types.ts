/**
 * M6.6 — deterministic eligible-node routing. Types.
 *
 * # What this module is
 *
 * One question, answered the same way every time: **given an immutable view of
 * the mesh, which node may run this dispatch, and why?**
 *
 * `src/routing/` exists as a SEPARATE module, over a PROJECTION of the mesh
 * registry rather than over the registry itself, and that placement is the whole
 * architectural claim of this milestone's routing decision. `RegisteredNode` has
 * nowhere to put a scheduling preference, and the structural test
 * `tests/unit/mesh/registry/no-scheduling-edges.test.ts` refuses any registry
 * member or physical column whose name could hold one. So the preference lives
 * here, the registry stays a description of machines, and that test stays green
 * **by construction rather than by argument**:
 *
 *   - `RoutingNodeSnapshot` is a PROJECTION — a frozen, self-contained
 *     re-expression of what `RegisteredNode` + `capabilitySnapshotSchema` +
 *     `CapabilityVerdict` already say. It is not a registry record, it is not
 *     persisted, and no registry code knows it exists.
 *   - `buildRoutingSnapshot` is an adapter over the registry's PUBLIC API. It
 *     reads. It writes nothing, opens no connection, and re-implements no liveness
 *     derivation.
 *   - `rankNodes` never sees a registry at all. It is a pure function of
 *     `(snapshots, request, preferences)`, which is what makes the determinism
 *     property in `tests/unit/routing/determinism.test.ts` assertable at all.
 *
 * # Named invariants
 *
 * - **I1 — Projection, not registration.** Nothing here adds a member to a
 *   registry schema, a wire payload, or a SQLite column. A field a future change
 *   adds to `RoutingNodeSnapshot` is a field routing needs and the registry
 *   therefore does not have.
 * - **I2 — Three ordered stages, no fourth.** Hard eligibility, then
 *   deterministic preference, then a stable code-unit tie-break. A stage may
 *   reorder or explain; it may never introduce a criterion the previous stage
 *   did not already own. See `./rank.js` for the stage order and why it is fixed.
 * - **I3 — A preference can only REORDER an eligible set.** It cannot add a node
 *   that failed a hard check, and it cannot remove one that passed. A rule asking
 *   for a node it cannot have is reported as `preference_ignored` with the
 *   eligibility reason attached, so the ask is visible rather than silently
 *   dropped. This is the routing analogue of the safety floor's refusal to
 *   widen: a rule may not acquire the power to remove a node the hard checks
 *   admitted.
 * - **I4 — No node is ever silently dropped.** Every node in the snapshot array
 *   appears in `RoutingResult.candidates`, eligible or not, and every ineligible
 *   node carries at least one exclusion code with a human-readable reason. The
 *   failure this prevents is a routing layer that answers "nothing is eligible"
 *   without saying which node it wanted and why it could not have it.
 * - **I5 — An empty eligible set is an ANSWER, not an error.** Zero eligible
 *   nodes returns `{ ok: true, value: { selectedNodeId: null, ... } }` with every
 *   candidate's exclusions recorded. "No node can take this work" is a fact the
 *   dispatcher needs to report; making it a throw would leave the caller to
 *   distinguish it from a bug in routing.
 * - **I6 — No free text crosses into an explanation.** `explanationText` and
 *   every `reason` string are built from identifiers, enum members, numbers, and
 *   reason codes — never from `displayName`, an advertised capability name, an
 *   advertised project path id, or any other node-supplied string. ADR 0007
 *   section 12 forbids prompt, task, context, memory, capability-payload, and
 *   credential material in a rendered explanation, and the cheapest way to keep
 *   that true under a future edit is to build every string from a closed set of
 *   sources. `tests/unit/routing/explanation.test.ts` seeds a canary into every
 *   free-text field of a snapshot and asserts none of it appears.
 * - **I7 — Code-unit ordering, never `localeCompare`.** Identifiers sort by
 *   UTF-16 code unit (ADR 0007 section 10.2). `localeCompare` is
 *   locale-dependent, so two machines with different locale data could rank two
 *   eligible nodes differently and the selection would stop being reproducible.
 *   `tests/unit/routing/determinism.test.ts` asserts the case-differing and
 *   non-ASCII orderings explicitly, and fails loudly if someone "improves" the
 *   comparator later.
 * - **I8 — Purity.** No clock, no randomness, no filesystem, no network, no
 *   process. `now` arrives on the request. The same snapshot array, request, and
 *   preferences produce a byte-identical result.
 *
 * # Stop conditions
 *
 *   - **S1 — If a needed fact is not in `capabilitySnapshotSchema` or
 *     `RegisteredNode`, do not add it there.** Either the routing request can
 *     carry it (an injected authorization map, a permission envelope) or routing
 *     cannot see it. Widening the registry is the one move this module exists to
 *     avoid, and the structural test will refuse the widening rather than let it
 *     land quietly.
 *   - **S2 — If eligibility ever needs a criterion outside the closed
 *     `ROUTING_EXCLUSION_REASONS` set, that is a new ADR decision, not a new
 *     `if`. The set is what makes "the node was excluded for exactly these
 *     reasons" a checkable statement.
 *   - **S3 — If a stage-2 preference ever needs to EXCLUDE, the design is wrong
 *     (I3). Demotion exists for that case; exclusion from a rule would let a rule
 *     remove a node the hard checks admitted, which is a safety-floor widening
 *     expressed as a preference.
 */

import { z } from "zod"
import { CAPABILITY_VERDICT_REFUSALS } from "../mesh/registry/capability.js"
import { capabilitySnapshotSchema, nodeLivenessSchema } from "../mesh/registry/schemas.js"
import { ARRAY_MAX } from "../mesh/protocol/identifiers.js"
import {
  nodeIdSchema,
  projectIdSchema,
  projectPathIdSchema,
  timestampSchema,
} from "../orchestration/identifiers.js"

/**
 * Frozen recursively.
 *
 * Local rather than imported from `src/memory/` because ADR 0007 section 1 gives
 * `routing` the edges `orchestration` and `mesh/registry` only, and a deep freeze
 * is not worth a dependency edge that a source-scan test has to be taught about.
 */
export function deepFreezeRouting<T>(value: T): T {
  if (value === null || typeof value !== "object") return value
  if (Object.isFrozen(value)) return value
  for (const member of Object.values(value as Record<string, unknown>)) {
    deepFreezeRouting(member)
  }
  return Object.freeze(value)
}

/**
 * Element schemas read off the registry's own capability snapshot rather than
 * restated.
 *
 * A restated bound is a second bound that can be widened independently, and the
 * widening that matters is the one admitting a capability name or runtime kind
 * this build would not otherwise recognise — at which point routing would be
 * matching a node against a vocabulary the registry itself does not carry.
 */
const snapshotShape = capabilitySnapshotSchema.shape

/** The health vocabulary routing owns, as a CLOSED set. */
export const ROUTING_HEALTH_REASONS = [
  "liveness_live",
  "liveness_stale",
  "liveness_revoked",
  "liveness_never_seen",
  "liveness_no_capability_snapshot",
] as const

export const routingHealthReasonSchema = z.enum(ROUTING_HEALTH_REASONS)

export type RoutingHealthReason = z.infer<typeof routingHealthReasonSchema>

/**
 * The frozen per-node view routing ranks over.
 *
 * A PROJECTION of `RegisteredNode` + `capabilitySnapshot` + `CapabilityVerdict`,
 * and deliberately not a registry record: nothing writes it, nothing persists it,
 * and no registry member names it. Every field here is a re-expression of a fact
 * the registry already holds or a fact the CALLER injected (authorization,
 * request-derived requirements), which is precisely why no mesh file had to
 * change for this milestone.
 *
 * Nullable means "the registry has no value", never "unknown": `activeSessions`
 * is `null` because the node has never sent a heartbeat, and that is itself a
 * health fact rather than a gap in this module's knowledge.
 */
export const routingNodeSnapshotSchema = z
  .object({
    nodeId: nodeIdSchema,
    /**
     * Carried for display by a caller that wants it, and NEVER rendered by
     * routing's own explanation (I6). It is the only free-text field on this
     * shape, which is exactly why the canary test seeds it.
     */
    displayName: z.string().min(1).max(256),
    revoked: z.boolean(),
    /**
     * Projects this node is authorized for. Caller-injected, because
     * authorization is a project-scoped fact and the mesh registry knows nothing
     * about projects (S1).
     */
    projectIds: z.array(projectIdSchema).max(ARRAY_MAX),
    projectPathIds: snapshotShape.projectPathIds,
    runtimeKinds: snapshotShape.runtimeKinds,
    capabilities: snapshotShape.capabilities,
    maxConcurrentSessions: snapshotShape.maxConcurrentSessions.nullable(),
    activeSessions: z.number().int().nonnegative().safe().nullable(),
    /** `true` only for `deriveLiveness` reporting `live`. */
    healthy: z.boolean(),
    /** A CLOSED member, never a sentence — see I6. */
    healthReason: routingHealthReasonSchema,
    livenessState: nodeLivenessSchema,
    sequence: z.number().int().nonnegative().safe(),
    observedAt: timestampSchema.nullable(),
    /**
     * The registry's own composite answer for this node, carried forward rather
     * than recomputed. `rankNodes` reads it; it never re-derives it.
     */
    verdictEligible: z.boolean(),
    /** `"advertised"` or a member of `CAPABILITY_VERDICT_REFUSALS`. */
    verdictReason: z.enum(["advertised", ...CAPABILITY_VERDICT_REFUSALS]),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    // Three statements that make the projection self-consistent, so a caller
    // cannot hand ranking a snapshot that contradicts itself and get an answer
    // derived from whichever half it happened to read.
    if (snapshot.revoked !== (snapshot.livenessState === "revoked")) {
      ctx.addIssue({
        code: "custom",
        path: ["revoked"],
        message: "`revoked` must agree with `livenessState`: a revoked node is terminal and cannot also be live",
      })
    }
    if (snapshot.healthy !== (snapshot.livenessState === "live")) {
      ctx.addIssue({
        code: "custom",
        path: ["healthy"],
        message: "`healthy` is derived from `deriveLiveness` and must not be asserted independently of it",
      })
    }
    if (snapshot.maxConcurrentSessions !== null && snapshot.activeSessions !== null) {
      if (snapshot.activeSessions > snapshot.maxConcurrentSessions) {
        ctx.addIssue({
          code: "custom",
          path: ["activeSessions"],
          message: "A node reporting more active sessions than its advertised ceiling is describing a state the wire refuses, so the projection will not carry it",
        })
      }
    }
  })

export type RoutingNodeSnapshot = z.infer<typeof routingNodeSnapshotSchema>

/**
 * The closed set of ways a node can be ineligible.
 *
 * Closed on purpose (S2): an operator's question is "why was that node not
 * chosen", and the answer has to be enumerable, machine-comparable, and stable
 * enough to render in a preview. Each member is produced by a CODE that knows how
 * to describe itself, never by a bare boolean at a call site.
 *
 * - `revoked` — the terminal state. Checked before everything else, because it is
 *   the only exclusion a fresh heartbeat can never undo.
 * - `not_authorized_for_project` — the node is not authorized for this project.
 * - `project_path_not_advertised` — the dispatch's project path is not among the
 *   node's advertised `projectPathIds`.
 * - `missing_runtime_kind` — the node advertises none of the required runtime
 *   kinds.
 * - `missing_capability` — the node advertises none of the required capabilities
 *   (or required tool categories; see `RoutingRequest.requiredToolCategories`).
 * - `unhealthy` — not `live` by `deriveLiveness`.
 * - `concurrency_saturated` — `activeSessions >= maxConcurrentSessions`.
 * - `verdict_declined` — a `CapabilityVerdict` declined to authorize.
 * - `excluded_by_rule` — a matched `select_routing_preference`, or the caller,
 *   named this node id in an exclusion list.
 */
export const ROUTING_EXCLUSION_REASONS = [
  "revoked",
  "not_authorized_for_project",
  "project_path_not_advertised",
  "missing_runtime_kind",
  "missing_capability",
  "unhealthy",
  "concurrency_saturated",
  "verdict_declined",
  "excluded_by_rule",
] as const

export const routingExclusionReasonSchema = z.enum(ROUTING_EXCLUSION_REASONS)

export type RoutingExclusionReason = z.infer<typeof routingExclusionReasonSchema>

/**
 * One reason, with a human-readable description beside the code.
 *
 * The pair is the unit of explanation. A code alone tells a program what to
 * filter on and tells a person nothing; a sentence alone cannot be asserted on.
 * Every `reason` string is built by `describeRoutingExclusion` from request-side
 * identifiers, closed enum members, and numbers (I6).
 */
export const routingExclusionSchema = z
  .object({
    code: routingExclusionReasonSchema,
    reason: z.string().min(1).max(1024),
  })
  .strict()

export type RoutingExclusion = z.infer<typeof routingExclusionSchema>

/** The runtime-kind element schema, read off the registry's snapshot shape. */
const runtimeKindSchema = snapshotShape.runtimeKinds.element
/** The capability element schema, read off the registry's snapshot shape. */
const capabilityTokenSchema = snapshotShape.capabilities.element

/**
 * One routing question.
 *
 * Every time value is injected (`now`), and the two authority-bearing inputs —
 * which projects a node serves, and which capabilities are denied — are supplied
 * by the caller rather than read from a store, because a routing layer that can
 * reach a store is a routing layer whose answer depends on when it was asked
 * (S1).
 */
export const routingRequestSchema = z
  .object({
    projectId: projectIdSchema,
    projectPathId: projectPathIdSchema,
    requiredCapabilities: z.array(capabilityTokenSchema).max(ARRAY_MAX),
    /**
     * Alternatives, not a conjunction: a node satisfies this check by
     * advertising AT LEAST ONE of them, because a dispatch runs on one runtime.
     */
    requiredRuntimeKinds: z.array(runtimeKindSchema).max(ARRAY_MAX),
    /**
     * Tool CATEGORIES. The mesh advertisement has no separate category
     * vocabulary — it advertises capabilities — so a required category is checked
     * against the advertised capability names and a shortfall is reported as
     * `missing_capability`. Recorded here rather than silently dropped: a caller
     * that names a category routing cannot check deserves to know it is being
     * checked as a capability name. See the module handoff's known limitations.
     */
    requiredToolCategories: z.array(capabilityTokenSchema).max(ARRAY_MAX),
    /** Injected clock, milliseconds. Never defaulted, never read from the host. */
    now: z.number().int().nonnegative().safe(),
    /** Node ids the caller refuses outright. Reported as `excluded_by_rule`. */
    excludeNodeIds: z.array(nodeIdSchema).max(ARRAY_MAX),
  })
  .strict()

export type RoutingRequest = z.infer<typeof routingRequestSchema>

/**
 * The unioned preference, as handed over by `RuleEvaluationResult.routing`.
 *
 * Structurally compatible with `RuleRoutingComposition` on purpose: `src/rules`
 * does not import `src/routing` and this module does not import `src/rules`
 * (ADR 0007 section 1 gives routing `orchestration` and `mesh/registry` only), so
 * a caller passes `evaluation.routing` across by shape rather than through a
 * shared type that would have to live in one of them.
 *
 * `requiredRuntimeKind` and `requiredProjectPathId` are SOFT here. The rule
 * language composes them as hard requirements; routing demotes rather than
 * excludes, because a hard exclusion would let a rule remove a node the hard
 * checks admitted (I3).
 */
export interface RoutingPreference {
  readonly preferredNodeIds: readonly string[]
  readonly excludedNodeIds: readonly string[]
  readonly requiredRuntimeKind: string | null
  readonly requiredProjectPathId: string | null
}

/** The neutral preference: no preference expressed. */
export const EMPTY_ROUTING_PREFERENCE: RoutingPreference = Object.freeze({
  preferredNodeIds: Object.freeze([]) as readonly string[],
  excludedNodeIds: Object.freeze([]) as readonly string[],
  requiredRuntimeKind: null,
  requiredProjectPathId: null,
})

/** One candidate, as reported. Every snapshot node appears exactly once here. */
export const routingCandidateResultSchema = z
  .object({
    nodeId: nodeIdSchema,
    eligible: z.boolean(),
    /** ALL failing codes, in the fixed check order. Never empty when ineligible. */
    exclusions: z.array(routingExclusionSchema).max(ROUTING_EXCLUSION_REASONS.length),
    /** Selection rank among eligible nodes, or `null` when ineligible. */
    rank: z.number().int().nonnegative().safe().nullable(),
    selected: z.boolean(),
    /** `true` when a soft preference requirement demoted this node (I3). */
    demotedByPreference: z.boolean(),
  })
  .strict()
  .superRefine((candidate, ctx) => {
    if (candidate.eligible && candidate.exclusions.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["exclusions"],
        message: "An eligible candidate cannot carry an exclusion; the two are one decision",
      })
    }
    if (!candidate.eligible && candidate.exclusions.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["exclusions"],
        message: "An ineligible candidate must carry at least one exclusion code (invariant I4)",
      })
    }
    if (candidate.eligible !== (candidate.rank !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["rank"],
        message: "A rank exists exactly for an eligible candidate",
      })
    }
    if (candidate.selected && candidate.rank !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["selected"],
        message: "Only the rank-0 candidate can be selected",
      })
    }
  })

export type RoutingCandidateResult = z.infer<typeof routingCandidateResultSchema>

/**
 * A preferred node that is not eligible.
 *
 * Reported rather than dropped (I3): a rule that asks for a node it cannot have
 * is a fact an operator needs, and silently ignoring it is indistinguishable from
 * a rule that never matched.
 */
export const routingIgnoredPreferenceSchema = z
  .object({
    nodeId: nodeIdSchema,
    /** The eligibility exclusions that made the preference unusable. */
    exclusions: z.array(routingExclusionSchema).min(1),
  })
  .strict()

export type RoutingIgnoredPreference = z.infer<typeof routingIgnoredPreferenceSchema>

/** The refusal codes routing itself raises. A routing answer is never a throw. */
export const ROUTING_REFUSALS = [
  "routing.request_invalid",
  "routing.snapshot_invalid",
  "routing.preference_invalid",
  "routing.registry_unreadable",
] as const

export type RoutingRefusalCode = (typeof ROUTING_REFUSALS)[number]

/**
 * The answer.
 *
 * `candidates` is sorted by `nodeId` in UTF-16 code-unit order regardless of
 * selection order, so two runs that selected different nodes still produce
 * comparable reports; `rank` carries the selection order. `explanationText` is a
 * function of the other members and is deliberately EXCLUDED from `digest` for the
 * reason recorded on `RuleEvaluationResult.decisionDigest`: including it would
 * make the digest cover a derivation of itself.
 */
export interface RoutingResult {
  readonly selectedNodeId: string | null
  readonly candidates: readonly RoutingCandidateResult[]
  readonly consideredCount: number
  readonly excludedCount: number
  readonly eligibleCount: number
  readonly preferenceApplied: boolean
  readonly tieBreakApplied: boolean
  /** Eligible nodes demoted by a soft preference requirement, sorted by nodeId. */
  readonly demotedNodeIds: readonly string[]
  /** Preferred nodes that were not eligible, sorted by nodeId. */
  readonly preferenceIgnored: readonly RoutingIgnoredPreference[]
  readonly explanationText: string
  readonly digest: string
}
