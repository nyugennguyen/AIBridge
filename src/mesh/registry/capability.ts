import { z } from "zod"
import { createContractError, type ContractError } from "../../orchestration/errors.js"
import { capabilitySchema, projectPathIdSchema, type ProjectPathId } from "../../orchestration/identifiers.js"
import { permissionEnvelopeSchema } from "../../orchestration/schemas.js"
import { meshHeartbeatSchema } from "../protocol/heartbeat.js"
import { ARRAY_MAX } from "../protocol/identifiers.js"
import type { CapabilitySnapshot, NodeLiveness, RegisteredNode } from "./schemas.js"

/**
 * The candidate filter. This module is the answer to one question — "does this
 * node ADVERTISE what this dispatch asks for?" — and the question's narrowness is
 * the entire design.
 *
 * What this is NOT, stated first because it is the failure this milestone exists
 * to prevent:
 *
 *   A capability advertisement is a node's CLAIM about its own machine. It is not
 *   a grant, and matching against it confers nothing. The authorities are, and
 *   remain:
 *
 *     - `dispatchEnvelopeSchema.permissionEnvelope` — what the DISPATCH is allowed
 *       to do, decided and recorded at propose time;
 *     - `projectPathSchema.allowedCapabilities` — what the controller bound to this
 *       project path;
 *     - `verifyApproval` against the recorded log (M4-A / M4-M), which is not in
 *       this directory at all.
 *
 *   So a node advertising `fs.write` when the envelope denies it is refused, and a
 *   node advertising nothing when the envelope allows everything is still refused.
 *   Both directions are the same statement: the advertisement is a filter, and the
 *   envelope is the answer. `tests/unit/mesh/registry/capability-verdict.test.ts`
 *   asserts the first direction; the second is what makes the first mean anything.
 *
 * Why this is not a negotiation protocol. The tempting design is "the controller
 * tells the node what it may do and the node agrees", which makes the heartbeat's
 * capability list the source of authority. That is the M3 blocker carried into M4:
 * authority moves from the recorded log to a peer-supplied claim, and a node that
 * wants more work simply advertises more. §4.3 of the protocol spec says it
 * directly — "a capability a node advertises is not a capability the controller must
 * honour" — and the `authorizes: false` literal on every verdict is that sentence
 * made into something a switch statement has to read.
 */

/**
 * The request being filtered for.
 *
 * The `permissionEnvelope` and the project-path allowlist are CARRIED IN the
 * request rather than looked up, for one reason: a verdict that could only be
 * produced by reading a particular store is not a filter, it is a disguised
 * authorization decision, and a reader of `canScheduleOn` has to be able to see
 * every input the verdict was made from. `projectPathAllowedCapabilities` is
 * `null` when the caller has no binding on record, and `null` means "not
 * restricted by an allowlist here" — it never means "allowed", because a missing
 * allowlist is an absence of evidence, not evidence of absence of restriction.
 */
export const capabilityRequestSchema = z
  .object({
    /**
     * Read off the heartbeat family's own element schema rather than restated.
     * The bound that governs a runtime kind name on the wire is the one that has to
     * govern it in a request, and a request that accepted a name the wire cannot
     * carry would be a request the registry could never see satisfied.
     */
    runtimeKind: meshHeartbeatSchema.shape.runtimeKinds.element,
    requestedCapabilities: z.array(capabilitySchema).max(ARRAY_MAX),
    projectPathId: projectPathIdSchema,
    /** The dispatch envelope's OWN permission envelope, carried verbatim. */
    permissionEnvelope: permissionEnvelopeSchema,
    /**
     * The `allowedCapabilities` the controller recorded for `projectPathId`, or
     * `null` when it recorded none.
     */
    projectPathAllowedCapabilities: z.array(capabilitySchema).max(ARRAY_MAX).nullable(),
  })
  .strict()

export type CapabilityRequest = z.infer<typeof capabilityRequestSchema>

/**
 * Every way a node fails the filter.
 *
 * A union rather than a boolean because each refusal has a different owner and a
 * different next action, and a TUI reducer (M4.8) that collapsed them to "not
 * eligible" would show an operator a grey dot and send them to the wrong system:
 * `node_stale` is a network question, `denied_by_permission_envelope` is a policy
 * question this registry does not own, and `at_capacity` is a reason to wait.
 */
export const CAPABILITY_VERDICT_REFUSALS = [
  "node_revoked",
  "node_never_seen",
  "node_stale",
  "no_common_protocol_version",
  "runtime_kind_not_advertised",
  "capability_not_advertised",
  "project_path_not_advertised",
  "denied_by_permission_envelope",
  "not_permitted_by_project_allowlist",
  "at_capacity",
] as const

export type CapabilityVerdictRefusal = (typeof CAPABILITY_VERDICT_REFUSALS)[number]

/**
 * What the node did not have, in the request's terms.
 *
 * Echoed back so a caller can render "missing fs.write" instead of "not eligible",
 * which is the difference between a two-second fix and an afternoon of reading the
 * dispatch envelope.
 */
export interface CapabilityShortfall {
  readonly runtimeKind?: string
  readonly capabilities?: readonly string[]
  readonly projectPathId?: ProjectPathId
}

/**
 * The filter's answer.
 *
 * `authorizes` is typed as the literal `false` and is present on BOTH the eligible
 * and the ineligible shape. That is the whole point of carrying it: a caller that
 * writes `if (verdict.authorizes)` compiles, runs, and is always false — so the
 * mistake becomes an obvious dead branch rather than a silent authorization. A type
 * cannot stop a caller from ignoring a verdict; what it can do is make the wrong
 * reading of that verdict impossible to write by accident.
 *
 * The `authoritative` field names who actually decided, on every verdict including
 * the passing one. A caller that logs `eligible: true` and nothing else has produced
 * a record that reads as "the registry approved this dispatch", which is precisely
 * the misreading M4-M was created to end.
 */
export interface CapabilityVerdict {
  readonly eligible: boolean
  /** Always `false`. A filter result is not an authorization. */
  readonly authorizes: false
  readonly reason: "advertised" | CapabilityVerdictRefusal
  /** The authority or authorities that actually govern this dispatch. */
  readonly authoritative: readonly CapabilityAuthority[]
  readonly shortfall: CapabilityShortfall
  readonly observed: {
    readonly liveness: NodeLiveness
    readonly negotiatedProtocolVersion: number | null
    readonly runtimeKinds: readonly string[]
    readonly capabilities: readonly string[]
    readonly projectPathIds: readonly string[]
    readonly activeSessions: number | null
    readonly maxConcurrentSessions: number | null
  }
  readonly detail: string
  readonly error: ContractError | null
}

export type CapabilityAuthority = "permission_envelope" | "project_allowlist"

export interface NodeCandidate {
  readonly node: RegisteredNode
  readonly verdict: CapabilityVerdict
}

/**
 * The seam, so M4.8 can decorate a selection (by load, by round-trip time, by
 * whether the operator pinned a node) without re-deriving eligibility and getting
 * a different answer than the dispatcher got.
 */
export interface NodeCandidateSelector {
  canScheduleOn(node: RegisteredNode, request: CapabilityRequest): CapabilityVerdict
  select(nodes: readonly RegisteredNode[], request: CapabilityRequest): readonly NodeCandidate[]
}

function refuse(
  reason: CapabilityVerdictRefusal,
  detail: string,
  shortfall: CapabilityShortfall,
  error: ContractError,
  observed: CapabilityVerdict["observed"],
): CapabilityVerdict {
  return {
    eligible: false,
    authorizes: false,
    reason,
    authoritative: [],
    shortfall,
    observed,
    detail,
    error,
  }
}

/**
 * Renders the node as it is RIGHT NOW, for a refusal that happens before the
 * advertisement is even read.
 *
 * A revoked node and a node that has never spoken both have no usable snapshot, and
 * an `observed` full of nulls is what keeps the two distinguishable in a log line
 * without the caller having to remember which fields it may read.
 */
function unobserved(node: RegisteredNode): CapabilityVerdict["observed"] {
  const snapshot = node.node.capability
  return {
    liveness: node.liveness,
    negotiatedProtocolVersion: node.negotiatedProtocolVersion,
    runtimeKinds: snapshot?.runtimeKinds ?? [],
    capabilities: snapshot?.capabilities ?? [],
    projectPathIds: snapshot?.projectPathIds ?? [],
    activeSessions: snapshot?.load.activeSessions ?? null,
    maxConcurrentSessions: snapshot?.maxConcurrentSessions ?? null,
  }
}

function observedOf(node: RegisteredNode, snapshot: CapabilitySnapshot): CapabilityVerdict["observed"] {
  return {
    liveness: node.liveness,
    negotiatedProtocolVersion: node.negotiatedProtocolVersion,
    runtimeKinds: snapshot.runtimeKinds,
    capabilities: snapshot.capabilities,
    projectPathIds: snapshot.projectPathIds,
    activeSessions: snapshot.load.activeSessions,
    maxConcurrentSessions: snapshot.maxConcurrentSessions,
  }
}

function eligible(
  observed: CapabilityVerdict["observed"],
  authoritative: readonly CapabilityAuthority[],
): CapabilityVerdict {
  return {
    eligible: true,
    authorizes: false,
    reason: "advertised",
    // Stated even on a pass, because a pass is precisely the moment a reader is
    // most likely to mistake the filter for the decision.
    authoritative,
    shortfall: {},
    observed,
    detail:
      "The node advertises everything this dispatch asks for. That makes it a candidate, and nothing more: the permission envelope, the project path allowlist, and the recorded approval still decide whether it may run.",
    error: null,
  }
}

/**
 * The filter itself. Pure, synchronous, and total — every input produces a verdict,
 * because a filter that throws leaves the caller to decide whether a throw meant
 * "no", and "no" is the only safe reading of a filter that did not run.
 *
 * ORDER IS LOAD-BEARING and runs identity -> protocol -> advertisement ->
 * authority -> capacity:
 *
 *   1. Liveness, first, and `revoked` above everything. A revoked node is not a
 *      candidate whatever it advertises, and a candidate list is exactly the place
 *      a revoked node must not appear.
 *   2. Protocol version, before the advertisement is read. A node speaking a
 *      dialect this build does not implement is not a candidate even if its
 *      advertisement would match, because acting on the match means acting on
 *      fields whose meaning has not been agreed.
 *   3. The ADVERTISEMENT, all of it, before the authority is consulted. Reporting
 *      `denied_by_permission_envelope` for a node that never advertised the
 *      capability would send an operator to fix a policy that was never the
 *      problem; the two refusals have different owners.
 *   4. The AUTHORITY, which can only ever REFUSE. This is the only step that reads
 *      a grant, and it reads nothing the registry produced.
 *   5. Capacity, last, because it is the only refusal that resolves by waiting
 *      rather than by changing anything.
 */
export function canScheduleOn(node: RegisteredNode, request: CapabilityRequest): CapabilityVerdict {
  const parsed = capabilityRequestSchema.safeParse(request)
  if (!parsed.success) {
    return refuse(
      "capability_not_advertised",
      `The capability request itself is not well formed (${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}). A filter that cannot read its own request has not run, and "has not run" is not a pass.`,
      {},
      createContractError(
        "validation",
        "registry.capability_request_invalid",
        "A capability request that does not satisfy capabilityRequestSchema is refused rather than half-evaluated.",
      ),
      unobserved(node),
    )
  }
  const ask = parsed.data
  const observed = unobserved(node)

  if (node.liveness === "revoked") {
    return refuse(
      "node_revoked",
      `Node ${node.node.nodeId} is revoked, so it is not a candidate regardless of what it advertises. Revocation is terminal: the node has to enroll again with a fresh one-time code and a fresh key.`,
      {},
      createContractError(
        "policy_denied",
        "registry.node_revoked",
        `Node ${node.node.nodeId} is revoked and cannot be a dispatch candidate.`,
      ),
      observed,
    )
  }

  if (node.liveness === "never-seen" || node.node.capability === null) {
    return refuse(
      "node_never_seen",
      `Node ${node.node.nodeId} has never sent an accepted heartbeat, so it has never demonstrated what it can do. "Enrolled" is a statement about a key, not about a machine's current capacity or software.`,
      {},
      createContractError(
        "policy_denied",
        "registry.node_never_seen",
        `Node ${node.node.nodeId} has never heartbeated and cannot be a dispatch candidate.`,
      ),
      observed,
    )
  }

  if (node.liveness === "stale") {
    return refuse(
      "node_stale",
      `Node ${node.node.nodeId} last reported ${node.ageMs ?? 0}ms ago, past the heartbeat freshness bound. Its capabilities are not honoured until it speaks again — a node that went quiet is not a node that was never trusted, which is why this is a wait rather than a removal.`,
      {},
      createContractError(
        "stale_epoch",
        "registry.node_stale",
        `Node ${node.node.nodeId} is stale; its capability advertisement is not honoured.`,
      ),
      observed,
    )
  }

  if (node.negotiatedProtocolVersion === null) {
    return refuse(
      "no_common_protocol_version",
      `Node ${node.node.nodeId} offers protocol versions [${(node.node.capability?.offeredProtocolVersions ?? []).join(", ")}], none of which this build speaks. It is never downgraded onto a version we happen to parse — one side has to be upgraded.`,
      {},
      createContractError(
        "unsupported_capability",
        "protocol.no_common_version",
        `Node ${node.node.nodeId} has no mesh protocol version in common with this controller.`,
      ),
      observed,
    )
  }

  const snapshot = node.node.capability
  const snapshotObserved = observedOf(node, snapshot)

  if (!snapshot.runtimeKinds.includes(ask.runtimeKind)) {
    return refuse(
      "runtime_kind_not_advertised",
      `Node ${node.node.nodeId} advertises runtime kinds [${snapshot.runtimeKinds.join(", ")}], not '${ask.runtimeKind}'. This is the node's own claim about its machine; a refusal here is not a policy decision.`,
      { runtimeKind: ask.runtimeKind },
      createContractError(
        "unsupported_capability",
        "registry.runtime_kind_not_advertised",
        `Node ${node.node.nodeId} does not advertise runtime kind '${ask.runtimeKind}'.`,
      ),
      snapshotObserved,
    )
  }

  const missing = ask.requestedCapabilities.filter((capability) => !snapshot.capabilities.includes(capability))
  if (missing.length > 0) {
    return refuse(
      "capability_not_advertised",
      `Node ${node.node.nodeId} does not advertise [${missing.join(", ")}]. The advertisement is a claim, so this refusal means "it says it cannot", not "it is forbidden" — those need different fixes and collapsing them is how a node that is merely out of date gets reported as a policy failure.`,
      { capabilities: missing },
      createContractError(
        "unsupported_capability",
        "registry.capability_not_advertised",
        `Node ${node.node.nodeId} does not advertise [${missing.join(", ")}].`,
      ),
      snapshotObserved,
    )
  }

  if (!snapshot.projectPathIds.includes(ask.projectPathId)) {
    return refuse(
      "project_path_not_advertised",
      `Node ${node.node.nodeId} advertises project paths [${snapshot.projectPathIds.join(", ")}], not '${ask.projectPathId}'. The advertisement names ids the controller itself recorded rather than filesystem paths, so this is a checkable reference and not a claim about a remote disk.`,
      { projectPathId: ask.projectPathId },
      createContractError(
        "unsupported_capability",
        "registry.project_path_not_advertised",
        `Node ${node.node.nodeId} does not advertise project path '${ask.projectPathId}'.`,
      ),
      snapshotObserved,
    )
  }

  // The authority. Read from the request the CALLER supplied from the recorded
  // dispatch envelope and the recorded project binding — never from the node, and
  // never from anything this registry wrote. A node that advertises a capability
  // the envelope denies fails here, which is the single most important assertion in
  // this file: the advertisement is a filter, and the envelope is the answer.
  const authoritative: CapabilityAuthority[] = []
  const denied = ask.permissionEnvelope.deniedCapabilities
  const deniedHere = ask.requestedCapabilities.filter((capability) => denied.includes(capability))
  if (deniedHere.length > 0) {
    return refuse(
      "denied_by_permission_envelope",
      `Node ${node.node.nodeId} advertises [${deniedHere.join(", ")}], but the dispatch envelope's permission envelope denies exactly those capabilities. The advertisement is a claim and the envelope is the grant, so the claim loses. This refusal belongs to the dispatch envelope, not to the registry.`,
      { capabilities: deniedHere },
      createContractError(
        "policy_denied",
        "registry.capability_denied_by_envelope",
        `The dispatch envelope denies [${deniedHere.join(", ")}], so node ${node.node.nodeId} is not a candidate for it regardless of what it advertises.`,
      ),
      snapshotObserved,
    )
  }

  const notAllowed = ask.permissionEnvelope.allowedCapabilities.filter(
    (capability) => !ask.requestedCapabilities.includes(capability),
  )
  if (notAllowed.length > 0) {
    // The envelope permits more than the dispatch asks for. That is a mismatch
    // between the recorded envelope and the request built from it, so it is refused
    // here rather than quietly widened: treating "permitted but unrequested" as
    // "requested" is how a dispatch acquires capabilities nobody proposed it with.
    return refuse(
      "denied_by_permission_envelope",
      `The dispatch envelope permits [${notAllowed.join(", ")}] that this request does not ask for. The registry will not widen a request to match an envelope: the envelope is the ceiling, and a request that under-uses it is a defect in the caller, not a licence here.`,
      { capabilities: notAllowed },
      createContractError(
        "policy_denied",
        "registry.request_below_envelope",
        `The dispatch envelope permits capabilities the capability request did not ask for: [${notAllowed.join(", ")}].`,
      ),
      snapshotObserved,
    )
  }
  authoritative.push("permission_envelope")

  if (ask.projectPathAllowedCapabilities !== null) {
    const outsideAllowlist = ask.requestedCapabilities.filter(
      (capability) => !ask.projectPathAllowedCapabilities!.includes(capability),
    )
    if (outsideAllowlist.length > 0) {
      return refuse(
        "not_permitted_by_project_allowlist",
        `Node ${node.node.nodeId} advertises everything the dispatch asks for, and the envelope permits it, but the project path binding for '${ask.projectPathId}' allows only [${ask.projectPathAllowedCapabilities.join(", ")}]. Two independent authorities say yes and a third says no; the third wins.`,
        { capabilities: outsideAllowlist },
        createContractError(
          "policy_denied",
          "registry.capability_outside_project_allowlist",
          `Capabilities [${outsideAllowlist.join(", ")}] are outside the project path allowlist for '${ask.projectPathId}'.`,
        ),
        snapshotObserved,
      )
    }
    authoritative.push("project_allowlist")
  }

  if (snapshot.load.activeSessions >= snapshot.maxConcurrentSessions) {
    return refuse(
      "at_capacity",
      `Node ${node.node.nodeId} reports ${snapshot.load.activeSessions} active sessions against a ceiling of ${snapshot.maxConcurrentSessions}. This is the one refusal that resolves by waiting rather than by changing anything, and it is a claim like every other part of the advertisement.`,
      {},
      createContractError(
        "unsupported_capability",
        "registry.node_at_capacity",
        `Node ${node.node.nodeId} is at its advertised session ceiling.`,
      ),
      snapshotObserved,
    )
  }

  return eligible(snapshotObserved, authoritative)
}

/**
 * Filters a set of nodes.
 *
 * Returns EVERY node with the verdict that decided it, not only the eligible ones.
 * An M4.8 TUI that wants to render "3 nodes, 1 eligible, 2 stale" cannot get that
 * from a list of winners, and a debug view that can only see the losers' verdicts
 * cannot explain to an operator why the mesh is idle.
 */
export function selectCandidates(
  nodes: readonly RegisteredNode[],
  request: CapabilityRequest,
): readonly NodeCandidate[] {
  return Object.freeze(nodes.map((node) => Object.freeze({ node, verdict: canScheduleOn(node, request) })))
}

/**
 * The default selector.
 *
 * A named object rather than a bare function so a consumer can be handed the
 * selector itself (M4.8 decorates a selection without re-deriving eligibility) and
 * so the "which implementation decided this" question has one answer in production.
 */
export const defaultNodeCandidateSelector: NodeCandidateSelector = Object.freeze({
  canScheduleOn,
  select: selectCandidates,
})
