/**
 * M6.6 — the adapter from the mesh registry to a routing snapshot.
 *
 * # What this file is, and what it is not
 *
 * It is a READ-ONLY projection. `buildRoutingSnapshot` calls the registry's public
 * API — `nodes` and `canScheduleOn` — plus the registry's exported
 * `deriveLiveness`, and turns what comes back into frozen `RoutingNodeSnapshot`
 * values. It performs no writes, opens no connection beyond the registry it was
 * handed, holds no module state, and has no second implementation of liveness,
 * capability matching, or protocol negotiation. Every one of those is the
 * registry's, and a second copy is a second answer.
 *
 * Nothing in `src/mesh/registry/` is modified to make this work, which is the
 * point of the whole arrangement: routing preferences live in `src/routing/` so
 * that `tests/unit/mesh/registry/no-scheduling-edges.test.ts` stays green **by
 * construction rather than by argument**.
 *
 * # Named invariants
 *
 * - **A1 — No writes, no new connections.** The only registry members this file
 *   touches are `nodes` and `canScheduleOn`, both reads. There is no code path
 *   from here to `enrollNode`, `revoke`, `writeHeartbeat`, or `recordHeartbeat`, so
 *   a routing decision can never enroll a node, revoke one, or move a sequence.
 * - **A2 — Liveness is derived ONCE, by the registry's own function.** The
 *   snapshot's `livenessState` is `deriveLiveness(record, request.now)` — the
 *   registry's function at the ROUTING REQUEST's clock, not at whatever instant
 *   the read happened. A snapshot whose liveness depended on when it was read
 *   could not be digested into a reproducible decision, and a decision that
 *   changes if you ask it twice is not a decision.
 * - **A3 — Authorization is caller-injected and fails closed.** Which projects a
 *   node may serve is not a mesh fact: `capabilitySnapshotSchema` has no such
 *   member, and adding one is stop condition S1. It arrives in
 *   `authorizedProjectIds`, and a node with no entry authorizes NO project — an
 *   absent allowlist is an absence of evidence, not evidence of permission.
 * - **A4 — Verdicts are reused, never re-derived.** `verdictEligible` and
 *   `verdictReason` come from the registry's own `CapabilityVerdict`, whose
 *   `authorizes` is `false` on every member. Routing reads it as a FILTER RESULT
 *   and nothing more; the dispatch's permission envelope and the recorded approval
 *   remain the authorities.
 * - **A5 — Deterministic output order.** Snapshots come back sorted by `nodeId`
 *   in UTF-16 code-unit order, and every collection on a snapshot is sorted and
 *   de-duplicated, so the order the registry happened to return nodes in cannot
 *   influence the digest.
 * - **A6 — Input shape is validated, not trusted.** The request is parsed through
 *   `routingRequestSchema` and each projection through `routingNodeSnapshotSchema`.
 *   Ranking a projection this build cannot read would make the selection
 *   unreproducible on a machine that reads it differently.
 *
 * # Stop conditions
 *
 *   - **S1 — If routing needs a node fact the registry does not have, the fact
 *     goes on `RoutingRequest` or on `authorizedProjectIds`, never into
 *     `nodeRecordSchema` or a SQLite column.** The structural test in
 *     `tests/unit/mesh/registry` refuses such a widening by name, which is the
 *     outcome this file is written to produce rather than to argue against.
 */

import { type CapabilityRequest, type CapabilityVerdict } from "../mesh/registry/capability.js"
import { deriveLiveness } from "../mesh/registry/registry.js"
import type { RegisteredNode } from "../mesh/registry/schemas.js"
import { createContractError, type Result } from "../orchestration/errors.js"
import { projectIdSchema, type MeshId, type NodeId } from "../orchestration/identifiers.js"
import { permissionEnvelopeSchema } from "../orchestration/schemas.js"
import {
  deepFreezeRouting,
  routingNodeSnapshotSchema,
  routingRequestSchema,
  ROUTING_REFUSALS,
  type RoutingHealthReason,
  type RoutingNodeSnapshot,
  type RoutingRequest,
} from "./types.js"

/**
 * The narrow registry surface this adapter needs.
 *
 * Declared structurally rather than accepting a whole `NodeRegistry` for two
 * reasons: a caller cannot hand routing a registry whose other half — heartbeat
 * ingest, revocation — this file has no business reaching, and a test can supply
 * four pure functions instead of building a store. `MeshNodeRegistry` satisfies
 * it as-is, which is asserted by the adapter test.
 */
export interface RoutingRegistryPort {
  readonly nodes: (meshId: MeshId) => Promise<Result<readonly RegisteredNode[]>>
  readonly canScheduleOn: (node: RegisteredNode, request: CapabilityRequest) => CapabilityVerdict
}

/**
 * The facts the registry does not hold, supplied by the caller.
 *
 * `authorizedProjectIds` is the load-bearing one (A3). `permissionEnvelope` is
 * the DISPATCH's recorded ceiling and `projectPathAllowedCapabilities` the
 * project's recorded binding — both facts about one dispatch that no mesh snapshot
 * contains, which is why they are carried rather than looked up. They are required
 * rather than optional: `canScheduleOn` refuses a request that does not carry
 * them, and a routing layer that quietly supplied an empty envelope would turn
 * "the envelope permits more than this dispatch asked for" into a pass.
 */
export interface RoutingSnapshotContext {
  readonly meshId: MeshId
  readonly authorizedProjectIds: Readonly<Record<string, readonly string[]>>
  readonly permissionEnvelope: ReturnType<typeof permissionEnvelopeSchema.parse>
  readonly projectPathAllowedCapabilities: string[] | null
}

function routingRefusal(code: (typeof ROUTING_REFUSALS)[number], message: string) {
  return createContractError("validation", code, message)
}

/**
 * Code-unit comparison. Never `localeCompare` (I7 in `./types.js`).
 *
 * `a < b` on two strings compares UTF-16 code units and depends on nothing but
 * the two strings. `localeCompare` depends on the host's locale data, so two
 * machines with different locale tables could rank the same two eligible nodes
 * differently and the selection would stop being reproducible across a mesh.
 */
export function compareByCodeUnit(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Sorted and de-duplicated by code unit (A5).
 *
 * Returns a fresh MUTABLE array: two of the destinations are schemas that infer a
 * mutable array (`capabilityRequestSchema`), and copying at the call site would
 * put a `[...]` on every caller rather than in the one place that owns the rule.
 */
export function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareByCodeUnit)
}

/**
 * Liveness → a CLOSED health reason.
 *
 * Total over a four-member enum, and it returns an enum member rather than a
 * sentence because `healthReason` reaches an explanation (I6). A free-text field
 * on a snapshot is a field an explanation can leak; the human-readable rendering
 * of an exclusion is built in `./rank.js` from enums and numbers instead.
 */
function healthReasonFor(liveness: RegisteredNode["liveness"]): RoutingHealthReason {
  if (liveness === "live") return "liveness_live"
  if (liveness === "stale") return "liveness_stale"
  if (liveness === "revoked") return "liveness_revoked"
  return "liveness_no_capability_snapshot"
}

/**
 * The registry's verdict, asked once per candidate runtime kind.
 *
 * `canScheduleOn` takes ONE runtime kind because a dispatch runs on one runtime.
 * A routing request may name several as ALTERNATIVES, so this asks once per
 * required kind and keeps the most favourable outcome: `advertised` if any kind is
 * filter-eligible, otherwise the FIRST refusal in code-unit order among the kinds
 * asked. "Most favourable wins" is the rule `canScheduleOn` already embodies
 * internally (it refuses at its first failing check rather than accumulating
 * refusals), so this reuses its semantics instead of authoring a second policy.
 *
 * When the request names no runtime kind, the node's OWN advertised kinds are
 * asked instead — the dispatch constrains nothing, so anything the node claims to
 * speak is a fair subject for the authority and capacity checks. An empty
 * fallback keeps the call well-formed for a node that has advertised nothing; the
 * resulting refusal is one the hard checks report anyway.
 */
function verdictFor(
  registry: RoutingRegistryPort,
  node: RegisteredNode,
  request: RoutingRequest,
  context: RoutingSnapshotContext,
): { eligible: boolean; reason: CapabilityVerdict["reason"] } {
  const required = sortedUnique(request.requiredRuntimeKinds)
  const advertised = sortedUnique(node.node.capability?.runtimeKinds ?? [])
  const kindsToAsk = required.length > 0 ? required : advertised.length > 0 ? advertised : ["opencode"]
  let firstRefusal: CapabilityVerdict["reason"] | null = null
  for (const runtimeKind of kindsToAsk) {
    const capabilityRequest: CapabilityRequest = {
      runtimeKind,
      requestedCapabilities: sortedUnique([
        ...request.requiredCapabilities,
        ...request.requiredToolCategories,
      ]),
      projectPathId: request.projectPathId,
      permissionEnvelope: context.permissionEnvelope,
      projectPathAllowedCapabilities: context.projectPathAllowedCapabilities,
    }
    const verdict = registry.canScheduleOn(node, capabilityRequest)
    if (verdict.eligible) return { eligible: true, reason: verdict.reason }
    if (firstRefusal === null) firstRefusal = verdict.reason
  }
  return { eligible: false, reason: firstRefusal ?? "node_never_seen" }
}

/**
 * Builds the frozen, deterministically ordered snapshot array routing ranks over.
 *
 * Returns a `Result` rather than throwing. A registry read that fails is a fact
 * the caller must report, and a throw would leave "the mesh could not be read"
 * indistinguishable from "the mesh has no nodes" — two situations whose correct
 * handling is the same (route nowhere) and whose correct EXPLANATION is not.
 */
export async function buildRoutingSnapshot(
  registry: RoutingRegistryPort,
  request: RoutingRequest,
  context: RoutingSnapshotContext,
): Promise<Result<readonly RoutingNodeSnapshot[]>> {
  const parsedRequest = routingRequestSchema.safeParse(request)
  if (!parsedRequest.success) {
    return {
      ok: false,
      error: routingRefusal(
        "routing.request_invalid",
        `A routing request that does not satisfy routingRequestSchema is refused rather than half-evaluated: ${parsedRequest.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}. A filter that cannot read its own request has not run, and "has not run" is not a pass.`,
      ),
    }
  }
  const parsedEnvelope = permissionEnvelopeSchema.safeParse(context.permissionEnvelope)
  if (!parsedEnvelope.success) {
    return {
      ok: false,
      error: routingRefusal(
        "routing.request_invalid",
        `The permission envelope carried into the capability request is refused because it does not satisfy permissionEnvelopeSchema: ${parsedEnvelope.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}. Routing will not substitute an empty envelope, because an empty envelope permits more than this dispatch asked for.`,
      ),
    }
  }
  const envelope = parsedEnvelope.data
  const ask = parsedRequest.data

  const read = await registry.nodes(context.meshId)
  if (!read.ok) return read

  const snapshots: RoutingNodeSnapshot[] = []
  for (const node of read.value) {
    // A2: the registry's own function, at the REQUEST's clock.
    const liveness = deriveLiveness(node.node, ask.now)
    const capability = node.node.capability
    const verdict = verdictFor(registry, node, ask, { ...context, permissionEnvelope: envelope })
    const projected = {
      nodeId: node.node.nodeId,
      displayName: node.node.displayName,
      revoked: node.node.revocation !== null,
      projectIds: sortedUnique(context.authorizedProjectIds[node.node.nodeId] ?? []).filter(
        (projectId): projectId is RoutingNodeSnapshot["projectIds"][number] =>
          projectIdSchema.safeParse(projectId).success,
      ),
      projectPathIds: sortedUnique(capability?.projectPathIds ?? []),
      runtimeKinds: sortedUnique(capability?.runtimeKinds ?? []),
      capabilities: sortedUnique(capability?.capabilities ?? []),
      maxConcurrentSessions: capability?.maxConcurrentSessions ?? null,
      activeSessions: capability?.load.activeSessions ?? null,
      healthy: liveness.liveness === "live",
      healthReason: healthReasonFor(liveness.liveness),
      livenessState: liveness.liveness,
      sequence: capability?.sequence ?? 0,
      observedAt: capability?.observedAt ?? null,
      verdictEligible: verdict.eligible,
      verdictReason: verdict.reason,
    }
    const parsed = routingNodeSnapshotSchema.safeParse(projected)
    if (!parsed.success) {
      return {
        ok: false,
        error: routingRefusal(
          "routing.snapshot_invalid",
          `The projection of node ${node.node.nodeId} does not satisfy routingNodeSnapshotSchema: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ")}. Ranking a projection this build cannot read would make the selection unreproducible on a machine that reads it differently.`,
        ),
      }
    }
    snapshots.push(parsed.data)
  }

  snapshots.sort((a, b) => compareByCodeUnit(a.nodeId, b.nodeId))
  return { ok: true, value: deepFreezeRouting(snapshots) }
}

/**
 * One node's snapshot, or `null` when it is not enrolled.
 *
 * Provided because a caller that already knows which node it is asking about
 * should not have to read the whole mesh, and because "is this specific node
 * eligible" is the question a TUI asks. Every rule is `buildRoutingSnapshot`'s.
 */
export async function buildRoutingSnapshotForNode(
  registry: RoutingRegistryPort,
  request: RoutingRequest,
  context: RoutingSnapshotContext,
  nodeId: NodeId,
): Promise<Result<RoutingNodeSnapshot | null>> {
  const all = await buildRoutingSnapshot(registry, request, context)
  if (!all.ok) return all
  return { ok: true, value: all.value.find((snapshot) => snapshot.nodeId === nodeId) ?? null }
}
