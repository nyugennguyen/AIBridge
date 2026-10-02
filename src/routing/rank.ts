/**
 * M6.6 — the three ordered stages. Selection.
 *
 * # The stage order, and why it is FIXED
 *
 * ADR 0007 section 14 fixes the shape: (1) hard eligibility, (2) deterministic
 * preference, (3) stable tie-break. This file fixes the order WITHIN stage 1, and
 * that order is load-bearing in a way the ADR's stage order is not:
 *
 *   1. `revoked`
 *   2. `not_authorized_for_project`
 *   3. `project_path_not_advertised`
 *   4. `missing_runtime_kind`
 *   5. `missing_capability`
 *   6. `unhealthy`
 *   7. `concurrency_saturated`
 *   8. `verdict_declined`
 *   9. `excluded_by_rule`
 *
 * The order runs **decisive to incidental**, and it is fixed rather than
 * evaluation-ordered because a node can fail several checks at once and a
 * reported reason that depends on which `if` happened to run first is not a fact
 * anybody can act on:
 *
 *   - `revoked` first, because it is the only exclusion a fresh heartbeat can
 *     never undo. Everything below it is repairable by the node doing something;
 *     revocation is repaired by re-enrolling with a fresh key.
 *   - `not_authorized_for_project` second, because it is about WHO may use this
 *     node at all, and a node unauthorized for the project is not a candidate for
 *     any capability question about it.
 *   - `project_path_not_advertised`, `missing_runtime_kind`, `missing_capability`
 *   next, in the order the request itself names them: the path, then the runtime,
 *     then the capabilities. Reading them top to bottom walks the request.
 *   - `unhealthy` then, because a node whose advertisement is stale is not a node
 *     with the wrong advertisement — the advertisement is simply not being
 *     honoured until it speaks again.
 *   - `concurrency_saturated` then `verdict_declined` last among the mesh checks,
 *     because capacity and the registry's composite verdict are the two that
 *     resolve by WAITING or by an authority elsewhere, and neither is fixed by
 *     editing the node.
 *   - `excluded_by_rule` LAST, deliberately last: it is the only code a rule can
 *     produce, and reporting it first would send an operator to their own rules
 *     when the real problem is that the node is revoked. A rule is the least
 *     authoritative fact about a machine.
 *
 * Crucially, ALL failing codes are recorded (I4), not just the first. The order
 * above fixes the reported ORDER of the codes and therefore the primary reason,
 * and nothing else; an operator sees the full picture rather than one failure at a
 * time.
 *
 * # Stage 2 — preference, which may only reorder
 *
 * `preferredNodeIds` orders the eligible set. It cannot add a node that failed a
 * hard check, and a preferred node that is not eligible is reported as
 * `preference_ignored` with the eligibility reasons attached (I3).
 *
 * `requiredRuntimeKind` and `requiredProjectPathId` from the preference are SOFT:
 * they DEMOTE a node to the back of the eligible set rather than excluding it. The
 * rule language composes them as hard requirements
 * (`src/rules/evaluate.ts:composeRouting`), and routing deliberately disagrees,
 * because a hard exclusion here would let a rule remove a node the hard checks
 * admitted. That is a safety-floor widening expressed as a preference, and I3
 * exists to make it unreachable. Demotion keeps the intent ("prefer something that
 * speaks this runtime") and removes the power ("delete the nodes that do not").
 *
 * # Stage 3 — the tie-break
 *
 * Lowest `nodeId` by UTF-16 code unit. NEVER `localeCompare`: it is
 * locale-dependent, so the same eligible set could select different nodes on two
 * machines with different locale data, and "same registry snapshot plus same
 * rules gives the same selection" would be true only per-machine. ADR 0007 section
 * 10.2 requires code-unit order for exactly this reason.
 *
 * # `concurrency_saturated` and what it is NOT
 *
 * The check is `activeSessions >= maxConcurrentSessions` on the node's own
 * advertisement — the same comparison `canScheduleOn` makes before it returns
 * `at_capacity` (`src/mesh/registry/capability.ts:450`). It is **NOT** Milestone
 * 6's budgets:
 *
 *   - `SchedulerOptions.maxConcurrency` (`src/orchestration/scheduler/types.ts:158`)
 *     is a per-CONTROLLER cap on how many dispatches the kernel starts at once,
 *     and `ScheduleResult.availableCapacity` is what it leaves over. It is a
 *     controller-side budget.
 *   - `maxConcurrentSessions` is a NODE-side advertisement: how many sessions this
 *     machine claims it can host. It is a claim, like every other part of the
 *     heartbeat.
 *   - ADR 0007 section 13.2's budget reservation is a THIRD mechanism again:
 *     eligibility to launch is DEFINED as holding a `held` reservation, so that a
 *     check and its reservation cannot interleave.
 *
 * Conflating them would produce a number that reads like a safety property and is
 * none: a budget is an algebraic ceiling a rule can tighten, a scheduler cap is a
 * controller-side ceiling, and this is a per-node advertisement. `rankNodes`
 * consults only the third and never reads a budget ledger or a scheduler, which is
 * also why it needs no store.
 *
 * # The empty eligible set
 *
 * Zero eligible nodes returns `{ ok: true, value: { selectedNodeId: null, ... } }`
 * with every candidate's exclusions recorded (I5). "No node can take this work" is
 * the answer the dispatcher needs to report, and every candidate's reason is in the
 * result. Turning it into an error would make a legitimate, fully-explained state
 * indistinguishable from a bug in routing.
 *
 * # Purity
 *
 * No clock, no randomness, no filesystem, no network, no process, no store. The
 * same snapshot array, request, and preferences produce a byte-identical result,
 * `explanationText`, and digest (I8).
 */

import { createContractError, type Result } from "../orchestration/errors.js"
import { digestJson } from "../orchestration/digest.js"
import {
  deepFreezeRouting,
  EMPTY_ROUTING_PREFERENCE,
  routingCandidateResultSchema,
  routingNodeSnapshotSchema,
  routingRequestSchema,
  ROUTING_REFUSALS,
  type RoutingCandidateResult,
  type RoutingExclusion,
  type RoutingExclusionReason,
  type RoutingIgnoredPreference,
  type RoutingNodeSnapshot,
  type RoutingPreference,
  type RoutingRequest,
  type RoutingResult,
} from "./types.js"
import { compareByCodeUnit } from "./snapshot.js"

/**
 * The stage-1 check order, as DATA.
 *
 * Exported so a test can assert the order and assert that every member of
 * `ROUTING_EXCLUSION_REASONS` appears, so the two cannot drift: a code added to
 * the enum but not to this list would be unreachable, and a code in this list but
 * not in the enum would not typecheck.
 */
export const ROUTING_CHECK_ORDER: readonly RoutingExclusionReason[] = Object.freeze([
  "revoked",
  "not_authorized_for_project",
  "project_path_not_advertised",
  "missing_runtime_kind",
  "missing_capability",
  "unhealthy",
  "concurrency_saturated",
  "verdict_declined",
  "excluded_by_rule",
])

function routingRefusal(code: (typeof ROUTING_REFUSALS)[number], message: string) {
  return createContractError("validation", code, message)
}

/**
 * The human-readable rendering of one exclusion code.
 *
 * Invariant I6 is enforced here, structurally rather than by review: every string
 * is assembled from a CLOSED set of sources — a reason code, an enum member, a
 * number, and identifiers the CALLER supplied on the request (project id, project
 * path id, runtime kinds, capabilities) or the node's own `nodeId`. Nothing here
 * reads `displayName`, an advertised capability name, an advertised project path
 * id, `observedAt`, or any other node-supplied string, so no canary planted in a
 * snapshot's free text can reach an explanation. That is why the reason is a
 * function of the CODE and the request rather than of the snapshot's contents.
 */
function describeExclusion(
  code: RoutingExclusionReason,
  snapshot: RoutingNodeSnapshot,
  request: RoutingRequest,
): string {
  switch (code) {
    case "revoked":
      return `Node ${snapshot.nodeId} is revoked. Revocation is terminal: the node must enroll again with a fresh one-time code and a fresh key, and no heartbeat revives it.`
    case "not_authorized_for_project":
      return `Node ${snapshot.nodeId} is not authorized for project ${request.projectId}. Authorization is a project-scoped fact supplied by the caller and is absent unless the caller recorded it, so an absent entry denies rather than permits.`
    case "project_path_not_advertised":
      return `Node ${snapshot.nodeId} does not advertise project path ${request.projectPathId}. The advertisement names an identifier the controller itself recorded, never a filesystem path, so this is a checkable reference rather than a claim about a remote disk.`
    case "missing_runtime_kind":
      return `Node ${snapshot.nodeId} advertises none of the required runtime kinds [${request.requiredRuntimeKinds.join(", ")}]. A runtime kind is the node's own claim about its machine, so this refusal is about what it says it can run, not about what policy permits.`
    case "missing_capability":
      return `Node ${snapshot.nodeId} advertises none of the required capabilities [${request.requiredCapabilities.join(", ")}], nor of the required tool categories [${request.requiredToolCategories.join(", ")}]. The advertisement is a claim: this refusal means "it says it cannot", not "it is forbidden", and the two need different fixes.`
    case "unhealthy":
      return `Node ${snapshot.nodeId} is ${snapshot.healthReason}, so its advertisement is not honoured. Liveness is derived by the registry from an injected clock and is never read from the node's own claim; a node that went quiet is not a node that was never trusted, which is why this is a wait rather than a removal.`
    case "concurrency_saturated":
      return `Node ${snapshot.nodeId} reports ${snapshot.activeSessions ?? 0} active sessions against an advertised ceiling of ${snapshot.maxConcurrentSessions ?? 0}, so it is at capacity. This is the node's own claim about its own machine and is the only exclusion here that resolves by waiting; it is NOT a Milestone 6 budget, which is an algebraic ceiling a rule can tighten, and NOT SchedulerOptions.maxConcurrency, which is a controller-side cap.`
    case "verdict_declined":
      return `Node ${snapshot.nodeId} was declined by the mesh registry's capability filter, which returned ${snapshot.verdictReason}. A verdict is a filter result and never an authorization: every CapabilityVerdict carries authorizes=false, and the dispatch's permission envelope and the recorded approval remain the authorities.`
    case "excluded_by_rule":
      return `Node ${snapshot.nodeId} was named in an exclusion list by a matched routing preference or by the caller. This is the only code a rule can produce, and it is applied after the mesh checks so that a genuine mesh fault is reported as the mesh fault.`
    default: {
      // Compile-time exhaustiveness: adding a member to `ROUTING_EXCLUSION_REASONS`
      // without describing it here is a type error, which is the point. At runtime
      // this cannot be reached, and the message says so rather than inventing a
      // plausible sentence for a case that does not exist.
      const unreachable: never = code
      return `Node ${snapshot.nodeId} was excluded by an undescribed reason code. Unreachable: ${String(unreachable)} has no description, so the exclusion is reported without prose rather than with a fabricated one.`
    }
  }
}

function hasAny(snapshot: { readonly runtimeKinds: readonly string[] }, required: readonly string[]): boolean {
  return required.length === 0 || required.some((kind) => snapshot.runtimeKinds.includes(kind))
}

function hasAnyCapability(snapshot: { readonly capabilities: readonly string[] }, required: readonly string[]): boolean {
  return required.length === 0 || required.some((capability) => snapshot.capabilities.includes(capability))
}

/**
 * Stage 1.
 *
 * Every check runs; every failing check is recorded. There is no early `return`,
 * because an operator looking at an excluded node wants the whole picture and not
 * the first thing that happened to be true about it.
 */
function evaluateHardEligibility(
  snapshot: RoutingNodeSnapshot,
  request: RoutingRequest,
  preferences: RoutingPreference,
): readonly RoutingExclusion[] {
  const failing = new Set<RoutingExclusionReason>()

  // 1. Revocation is terminal and survives a fresh heartbeat.
  if (snapshot.revoked || snapshot.livenessState === "revoked") failing.add("revoked")

  // 2. Project-scoped authorization. A node with no recorded projects is authorized
  //    for none: an absent allowlist is an absence of evidence (A3).
  if (!snapshot.projectIds.includes(request.projectId)) failing.add("not_authorized_for_project")

  // 3. The project path, by identifier. Never a path string, never a prefix.
  if (!snapshot.projectPathIds.includes(request.projectPathId)) {
    failing.add("project_path_not_advertised")
  }

  // 4. Runtime kind, as alternatives.
  if (!hasAny(snapshot, request.requiredRuntimeKinds)) failing.add("missing_runtime_kind")

  // 5. Capabilities and tool categories. A tool category is checked against the
  //    advertised capability names because the mesh advertisement has no separate
  //    category vocabulary; the shortfall is therefore reported as a capability
  //    shortfall rather than silently dropped.
  if (
    !hasAnyCapability(snapshot, request.requiredCapabilities) ||
    !hasAnyCapability(snapshot, request.requiredToolCategories)
  ) {
    failing.add("missing_capability")
  }

  // 6. Health. `deriveLiveness` already folded revocation in; checked again here so
  //    a revoked node reports BOTH codes rather than only the terminal one.
  if (!snapshot.healthy) failing.add("unhealthy")

  // 7. The node's own advertised ceiling. Deliberately not a budget: see the
  //    module docblock's "concurrency_saturated and what it is NOT".
  if (
    snapshot.maxConcurrentSessions !== null &&
    snapshot.activeSessions !== null &&
    snapshot.activeSessions >= snapshot.maxConcurrentSessions
  ) {
    failing.add("concurrency_saturated")
  }

  // 8. The registry's own composite verdict, reused rather than re-derived (A4).
  if (!snapshot.verdictEligible) failing.add("verdict_declined")

  // 9. An explicit exclusion list. Last, per the module docblock.
  if (
    preferences.excludedNodeIds.includes(snapshot.nodeId) ||
    request.excludeNodeIds.includes(snapshot.nodeId)
  ) {
    failing.add("excluded_by_rule")
  }

  return ROUTING_CHECK_ORDER.filter((code) => failing.has(code)).map((code) => ({
    code,
    reason: describeExclusion(code, snapshot, request),
  }))
}

/**
 * Stage 2's soft demotion.
 *
 * A node is demoted when it fails a SOFT preference requirement the eligible set
 * would otherwise have honoured. Demotion, not exclusion (I3).
 */
function isDemotedByPreference(snapshot: RoutingNodeSnapshot, preferences: RoutingPreference): boolean {
  if (preferences.requiredRuntimeKind !== null && !snapshot.runtimeKinds.includes(preferences.requiredRuntimeKind)) {
    return true
  }
  if (
    preferences.requiredProjectPathId !== null &&
    !snapshot.projectPathIds.some((pathId) => pathId === preferences.requiredProjectPathId)
  ) {
    return true
  }
  return false
}

/** Preference index, or `null` when the node is not named. */
function preferenceIndex(nodeId: string, preferences: RoutingPreference): number | null {
  const index = preferences.preferredNodeIds.indexOf(nodeId)
  return index === -1 ? null : index
}

/**
 * Stage 2's whole contribution to an ordering, as one comparable value.
 *
 * Two keys in a fixed order: preference rank first (a node the rules named beats a
 * node they did not), then the soft demotion flag. Expressed as one function so
 * the comparator and `tieBreakApplied` cannot disagree about what "the same stage-2
 * position" means — the two would drift the moment either were written twice.
 */
function stageTwoKey(
  snapshot: RoutingNodeSnapshot,
  preferences: RoutingPreference,
): readonly [number, number] {
  const index = preferenceIndex(snapshot.nodeId, preferences)
  // `Number.MAX_SAFE_INTEGER` rather than a sentinel string, because the two keys
  // are compared as NUMBERS: a string key would order the tenth preference before
  // the second ("p10" < "p2"), which is exactly the kind of plausible-looking bug
  // a deterministic selector cannot afford.
  return [index === null ? Number.MAX_SAFE_INTEGER : index, isDemotedByPreference(snapshot, preferences) ? 1 : 0]
}

function compareStageTwoKeys(a: readonly [number, number], b: readonly [number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0]
  return a[1] - b[1]
}

/**
 * The complete, deterministic answer.
 *
 * Pure. No clock, no randomness, no store, no I/O (I8).
 */
export function rankNodes(
  snapshots: readonly RoutingNodeSnapshot[],
  request: RoutingRequest,
  preferences: RoutingPreference = EMPTY_ROUTING_PREFERENCE,
): Result<RoutingResult> {
  const parsedRequest = routingRequestSchema.safeParse(request)
  if (!parsedRequest.success) {
    return {
      ok: false,
      error: routingRefusal(
        "routing.request_invalid",
        `A routing request that does not satisfy routingRequestSchema is refused rather than half-evaluated: ${parsedRequest.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}.`,
      ),
    }
  }
  const ask = parsedRequest.data

  const projectionErrors: string[] = []
  const validated: RoutingNodeSnapshot[] = []
  for (const snapshot of snapshots) {
    const parsed = routingNodeSnapshotSchema.safeParse(snapshot)
    if (!parsed.success) {
      projectionErrors.push(
        `${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`,
      )
      continue
    }
    validated.push(parsed.data)
  }
  if (projectionErrors.length > 0) {
    return {
      ok: false,
      error: routingRefusal(
        "routing.snapshot_invalid",
        `${projectionErrors.length} routing snapshot(s) do not satisfy routingNodeSnapshotSchema: ${projectionErrors.join(" | ")}. Ranking a projection this build cannot read would make the selection unreproducible on a machine that reads it differently.`,
      ),
    }
  }

  if (
    !Array.isArray(preferences.preferredNodeIds) ||
    !Array.isArray(preferences.excludedNodeIds)
  ) {
    return {
      ok: false,
      error: routingRefusal(
        "routing.preference_invalid",
        "A routing preference must carry `preferredNodeIds` and `excludedNodeIds` as arrays. A preference that is not readable cannot be applied, and a preference applied half-read is a routing decision nobody can reproduce.",
      ),
    }
  }

  // Stage 1 — every node, eligible or not, with every failing code.
  const staged = validated
    .map((snapshot) => ({ snapshot, exclusions: evaluateHardEligibility(snapshot, ask, preferences) }))
    .sort((a, b) => compareByCodeUnit(a.snapshot.nodeId, b.snapshot.nodeId))

  const eligible = staged.filter((entry) => entry.exclusions.length === 0)
  const excluded = staged.filter((entry) => entry.exclusions.length > 0)

  // Stage 2 — reorder the ELIGIBLE set only. Two keys, in this order:
  //   1. whether the preference named this node (named before unnamed), and
  //   2. whether a soft requirement demoted it.
  // Stage 3 — code-unit `nodeId`.
  //
  // The comparator is a total order: `nodeId` is unique within a mesh, so no two
  // eligible entries can compare equal, which is what makes the sort stable
  // without depending on the input order.
  const orderedEligible = [...eligible].sort((a, b) => {
    const byStage = compareStageTwoKeys(stageTwoKey(a.snapshot, preferences), stageTwoKey(b.snapshot, preferences))
    if (byStage !== 0) return byStage
    return compareByCodeUnit(a.snapshot.nodeId, b.snapshot.nodeId)
  })

  const selectedNodeId = orderedEligible.length > 0 ? orderedEligible[0]!.snapshot.nodeId : null
  const rankOf = new Map<string, number>()
  orderedEligible.forEach((entry, index) => rankOf.set(entry.snapshot.nodeId, index))

  const candidates: RoutingCandidateResult[] = staged.map((entry) => {
    const rank = rankOf.get(entry.snapshot.nodeId) ?? null
    const candidate = {
      nodeId: entry.snapshot.nodeId,
      eligible: entry.exclusions.length === 0,
      exclusions: entry.exclusions,
      rank,
      selected: entry.snapshot.nodeId === selectedNodeId,
      demotedByPreference:
        entry.exclusions.length === 0 && isDemotedByPreference(entry.snapshot, preferences),
    }
    const parsed = routingCandidateResultSchema.safeParse(candidate)
    if (!parsed.success) {
      // Unreachable for any snapshot that satisfied `routingNodeSnapshotSchema`;
      // refused rather than coerced because a candidate whose invariants do not
      // hold is a routing bug, and a coerced one would report as a decision.
      throw new Error(
        `routing produced a candidate that does not satisfy routingCandidateResultSchema: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}`,
      )
    }
    return parsed.data
  })

  // Preferred nodes that are not eligible: reported, never silently dropped (I3).
  const preferenceIgnored: RoutingIgnoredPreference[] = staged
    .filter((entry) => entry.exclusions.length > 0 && preferences.preferredNodeIds.includes(entry.snapshot.nodeId))
    .map((entry) => ({ nodeId: entry.snapshot.nodeId, exclusions: [...entry.exclusions] }))
    .sort((a, b) => compareByCodeUnit(a.nodeId, b.nodeId))

  const demotedNodeIds = candidates
    .filter((candidate) => candidate.demotedByPreference)
    .map((candidate) => candidate.nodeId)
    .sort(compareByCodeUnit)

  const preferenceApplied =
    preferences.preferredNodeIds.length > 0 || preferences.excludedNodeIds.length > 0 || demotedNodeIds.length > 0

  // `tieBreakApplied` is a fact about THIS run, not a guess: stage 3 decided the
  // selection exactly when the winner and the runner-up tie on both stage-2 keys
  // (preference rank and demotion), because then nothing but `nodeId` code unit
  // separated them. With zero or one eligible node there was nothing to break.
  const tieBreakApplied =
    orderedEligible.length > 1 &&
    compareStageTwoKeys(
      stageTwoKey(orderedEligible[0]!.snapshot, preferences),
      stageTwoKey(orderedEligible[1]!.snapshot, preferences),
    ) === 0

  const stable = {
    selectedNodeId,
    candidates,
    consideredCount: staged.length,
    excludedCount: excluded.length,
    eligibleCount: orderedEligible.length,
    preferenceApplied,
    tieBreakApplied,
    demotedNodeIds,
    preferenceIgnored,
  }

  const explanationText = renderExplanation(stable, ask, preferences)
  // `explanationText` is EXCLUDED from the digest for the reason recorded on
  // `RuleEvaluationResult.decisionDigest`: it is a function of the other members,
  // so including it would make the digest cover a derivation of itself.
  const digest = digestJson({
    selectedNodeId: stable.selectedNodeId,
    candidates: stable.candidates,
    consideredCount: stable.consideredCount,
    excludedCount: stable.excludedCount,
    eligibleCount: stable.eligibleCount,
    preferenceApplied: stable.preferenceApplied,
    tieBreakApplied: stable.tieBreakApplied,
    demotedNodeIds: stable.demotedNodeIds,
    preferenceIgnored: stable.preferenceIgnored,
  })

  return { ok: true, value: deepFreezeRouting({ ...stable, explanationText, digest }) }
}

/**
 * The rendered explanation.
 *
 * Sorted, one line per candidate, every node present (I4). Built only from reason
 * codes, enum members, numbers, and request-supplied identifiers — the exclusion
 * `reason` strings are the only prose and they come from `describeExclusion`, which
 * reads no node free text (I6).
 *
 * A line per node, always: an operator asking "why was node X not chosen" has to
 * find node X, and a report that omits ineligible nodes makes the absence
 * indistinguishable from a routing layer that never looked.
 */
export function renderExplanation(
  stable: Omit<RoutingResult, "explanationText" | "digest">,
  request: RoutingRequest,
  preferences: RoutingPreference,
): string {
  const header = [
    `routing: project=${request.projectId}`,
    `projectPath=${request.projectPathId}`,
    `requiredCapabilities=[${request.requiredCapabilities.join(",")}]`,
    `requiredRuntimeKinds=[${request.requiredRuntimeKinds.join(",")}]`,
    `requiredToolCategories=[${request.requiredToolCategories.join(",")}]`,
    `now=${request.now}`,
    `considered=${stable.consideredCount}`,
    `eligible=${stable.eligibleCount}`,
    `excluded=${stable.excludedCount}`,
    `preferenceApplied=${stable.preferenceApplied}`,
    `tieBreakApplied=${stable.tieBreakApplied}`,
  ].join(" ")

  const candidateLines = stable.candidates.map((candidate) => {
    const disposition = candidate.eligible
      ? `eligible rank=${candidate.rank}${candidate.selected ? " selected" : ""}${
          candidate.demotedByPreference ? " demoted_by_preference" : ""
        }`
      : `excluded codes=[${candidate.exclusions.map((exclusion) => exclusion.code).join(",")}]`
    return `routing: candidate ${candidate.nodeId} ${disposition}`
  })

  const reasonLines = stable.candidates
    .filter((candidate) => !candidate.eligible)
    .flatMap((candidate) =>
      candidate.exclusions.map(
        (exclusion) => `routing: excluded ${candidate.nodeId} ${exclusion.code} — ${exclusion.reason}`,
      ),
    )

  const preferenceLines = [
    `routing: preference preferred=[${preferences.preferredNodeIds.join(",")}]`,
    `routing: preference excluded=[${preferences.excludedNodeIds.join(",")}]`,
    `routing: preference requiredRuntimeKind=${preferences.requiredRuntimeKind ?? "none"}`,
    `routing: preference requiredProjectPathId=${preferences.requiredProjectPathId ?? "none"}`,
  ]

  const ignoredLines = stable.preferenceIgnored.map(
    (ignored) =>
      `routing: preference_ignored ${ignored.nodeId} codes=[${ignored.exclusions
        .map((exclusion) => exclusion.code)
        .join(",")}]`,
  )

  const demotedLines = stable.demotedNodeIds.map(
    (nodeId) => `routing: demoted_by_preference ${nodeId}`,
  )

  const selection = stable.selectedNodeId === null
    ? "routing: selected none — no node satisfied every hard check; see the exclusion lines above"
    : `routing: selected ${stable.selectedNodeId}`

  return [header, ...preferenceLines, ...candidateLines, ...reasonLines, ...ignoredLines, ...demotedLines, selection].join("\n")
}

/**
 * The digest over an already-built result, re-derivable by a caller that wants to
 * assert the result was not mutated between construction and use.
 *
 * The result is frozen, so this is a check rather than a repair.
 */
export function digestRoutingResult(result: RoutingResult): string {
  return digestJson({
    selectedNodeId: result.selectedNodeId,
    candidates: result.candidates,
    consideredCount: result.consideredCount,
    excludedCount: result.excludedCount,
    eligibleCount: result.eligibleCount,
    preferenceApplied: result.preferenceApplied,
    tieBreakApplied: result.tieBreakApplied,
    demotedNodeIds: result.demotedNodeIds,
    preferenceIgnored: result.preferenceIgnored,
  })
}
