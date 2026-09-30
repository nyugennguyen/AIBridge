import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import { protocolVersionSchema } from "./identifiers.js"

/**
 * Protocol version negotiation (§5).
 *
 * There is no downgrade path and no "proceed on the newest one I happen to
 * parse". Those two options are the same defect seen from two ends: a node that
 * silently downgrades will send a record the peer cannot read and the peer will
 * refuse it, and a node that proceeds on "the newest I can parse" will
 * interpret a record whose field means something else. Both surface as an
 * intermittent, unreproducible failure on a version-skewed mesh, which is far
 * worse than a refusal at enrollment.
 *
 * The version is FROZEN at M4.10. While M4.1–M4.9 are in flight it is a single
 * version, and the set is expressed as a list so that adding a second version
 * later is a one-line change here rather than a discovery that two branches had
 * diverged.
 */
export const MESH_PROTOCOL_VERSIONS = [1] as const

export type MeshProtocolVersion = (typeof MESH_PROTOCOL_VERSIONS)[number]

/** The version newly written mesh records carry. */
export const CURRENT_MESH_PROTOCOL_VERSION: MeshProtocolVersion = 1

/**
 * The highest version in `offered` that also appears in `supported`, or `null`.
 *
 * Highest-common, not lowest-common: the whole negotiation exists to avoid
 * running on an older dialect when both sides can do better, and a
 * lowest-common implementation is a silent downgrade wearing a compatibility
 * costume.
 */
export function selectProtocolVersion(offered: readonly number[], supported: readonly number[]): number | null {
  let best: number | null = null
  for (const version of offered) {
    if (!supported.includes(version)) continue
    if (best === null || version > best) best = version
  }
  return best
}

/**
 * The negotiation answer, including WHAT WOULD HAVE WORKED.
 *
 * The offered-but-unsupported list is in the error because the operator's next
 * action is "upgrade the node that speaks only these", and an error that says
 * only "no common version" sends them to read the source instead.
 */
export type NegotiationMismatch =
  | { readonly ok: true; readonly version: number }
  | {
      readonly ok: false
      readonly reason: "no_common_version"
      readonly offered: readonly number[]
      readonly supported: readonly number[]
      readonly error: ContractError
    }

/**
 * Negotiates, or explains precisely why it could not.
 *
 * The refusal is `unsupported_capability` and not retryable. That is not a
 * default: a node that keeps retrying a version it will never understand is a
 * resource-exhaustion vector on the peer, so `retryable: false` is asserted in
 * the tests rather than assumed to follow from the category.
 */
export function negotiationMismatch(offered: readonly number[], supported: readonly number[]): NegotiationMismatch {
  const version = selectProtocolVersion(offered, supported)
  if (version !== null) return { ok: true, version }
  return {
    ok: false,
    reason: "no_common_version",
    offered,
    supported,
    error: createContractError(
      "unsupported_capability",
      "protocol.no_common_version",
      `No common mesh protocol version. This node speaks [${supported.join(", ")}]; the peer offered [${offered.join(", ")}]. One side must be upgraded — the mesh will not proceed on "the newest one I happen to parse".`,
    ),
  }
}

/** `Result` flavour of {@link negotiationMismatch}. */
export function negotiateProtocolVersion(offered: readonly number[], supported: readonly number[]): Result<number> {
  const outcome = negotiationMismatch(offered, supported)
  return outcome.ok ? { ok: true, value: outcome.version } : { ok: false, error: outcome.error }
}

/** Every version this build speaks, for a heartbeat's `protocolVersions`. */
export function supportedProtocolVersions(): readonly MeshProtocolVersion[] {
  return [...MESH_PROTOCOL_VERSIONS]
}

/**
 * Rejects a malformed version list before it reaches negotiation.
 *
 * `protocolVersionListSchema` already bounds and de-duplicates it; this exists
 * so the negative version (a list that is empty, or carries `0`, or carries a
 * float) is refused with a message that says which element, because an empty
 * list negotiating to "no common version" reads as a compatibility problem when
 * it is actually a sender bug.
 */
export function validateOfferedVersions(versions: readonly unknown[]): Result<number[]> {
  for (const [index, version] of versions.entries()) {
    if (!protocolVersionSchema.safeParse(version).success) {
      return {
        ok: false,
        error: createContractError(
          "validation",
          "protocol.invalid_version_offer",
          `Offered protocol version at index ${index} is ${JSON.stringify(version)}, which is not a positive safe integer`,
        ),
      }
    }
  }
  if (versions.length === 0) {
    return {
      ok: false,
      error: createContractError(
        "validation",
        "protocol.empty_version_offer",
        "A node offered no protocol versions at all; that is a sender bug, not a compatibility problem",
      ),
    }
  }
  return { ok: true, value: [...new Set(versions as number[])] }
}
