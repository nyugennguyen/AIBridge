/**
 * Immutable-core validator and canonical core digest computation.
 *
 * WHY THIS EXISTS:
 * Per ADR 0009 and implementation plan §7.3, charters in the AIBridge/Herdr
 * orchestration architecture are agent-proposable. To ensure that an autonomous
 * agent or rogue suggestion can NEVER weaken the system's foundational invariants,
 * §7.3 establishes a fixed 6-item immutable core.
 *
 * This module exports:
 * 1. `computeImmutableCoreDigest(floor)`: produces the canonical SHA-256 digest of
 *    the fixed 6-item core specification with the active `SafetyFloor` embedded.
 * 2. `assertCharterDoesNotRelaxCore(proposal, floor)`: a pure function called from
 *    exactly one place — the P1 charter-proposal lifecycle pre-pending gate.
 *
 * ARCHITECTURAL INVARIANTS:
 * - One function, called from exactly one place: the pre-pending gate validates every
 *   `CharterProposal` before it can transition to pending (`charter.proposed`).
 * - Two refusal rules, no exceptions, no override flag:
 *   A. Touching: Any proposal operation touching an area in `CHARTER_CORE_CHANGE_AREAS`
 *      is immediately refused with `charter_core_violation`. Position in the ops list
 *      is irrelevant.
 *   B. Core stamp: `proposal.charter.immutableCoreDigest` must strictly equal
 *      `computeImmutableCoreDigest(floor)`. A mismatch indicates the proposal was
 *      stamped against a different or outdated core baseline and is refused.
 * - Non-core operations alone (`CHARTER_NON_CORE_CHANGE_AREAS`) with a matching stamp
 *   are accepted (`{ ok: true, value: undefined }`).
 * - Recorded evidence: When a proposal is refused, the proposed document is still
 *   recorded as deliberation evidence (e.g. in command receipts / audit log) but
 *   can never become pending or be activated.
 * - Defense in depth: The human-only approval gate (settled §15) remains the final
 *   backstop; this pure validator is the programmatic front line.
 */

import { digestJson } from "../digest.js"
import { createContractError, type ContractError, type Result } from "../errors.js"
import type { Digest } from "../identifiers.js"
import {
  CHARTER_CORE_CHANGE_AREAS,
  type CharterChangeArea,
  type CharterCoreChangeArea,
  type CharterProposal,
} from "../schemas.js"
import type { SafetyFloor } from "./types.js"

/**
 * Stable identifier for each of the 6 fixed immutable-core items (§7.3).
 */
export type ImmutableCoreItemId =
  | "safety_floor"
  | "input_ownership_fencing"
  | "security_perimeter"
  | "roundtable_advisory_only"
  | "budget_ceilings"
  | "terminal_state_authority"

/**
 * Specification record for an immutable core item.
 */
export interface ImmutableCoreItemSpec {
  readonly id: ImmutableCoreItemId
  readonly title: string
  readonly description: string
  readonly areas: readonly CharterCoreChangeArea[]
}

/**
 * The fixed 6-item immutable core list defined in plan §7.3.
 *
 * This module is the single source of truth for these 6 items; the list is deeply
 * frozen and cannot be extended, overridden, or relaxed at runtime.
 */
export const IMMUTABLE_CORE_ITEMS: readonly ImmutableCoreItemSpec[] = Object.freeze([
  Object.freeze({
    id: "safety_floor" as const,
    title: "Safety Floor Policy Layer",
    description: "Unconditional safety floor built outside caller input (policy/floor.ts).",
    areas: Object.freeze(["policy.safety_floor"] as const),
  }),
  Object.freeze({
    id: "input_ownership_fencing" as const,
    title: "Input-Ownership Fencing",
    description: "Input-ownership fencing requirements preventing concurrent terminal interference.",
    areas: Object.freeze(["fencing.input_ownership"] as const),
  }),
  Object.freeze({
    id: "security_perimeter" as const,
    title: "Security Perimeter",
    description: "Allowed external sources and project allowlist resolution.",
    areas: Object.freeze(["security.allowed_sources", "security.project_allowlist"] as const),
  }),
  Object.freeze({
    id: "roundtable_advisory_only" as const,
    title: "Roundtable Advisory-Only Invariant",
    description: "Deliberation outcomes are strictly advisory and never trigger state transitions directly.",
    areas: Object.freeze(["roundtable.advisory_only"] as const),
  }),
  Object.freeze({
    id: "budget_ceilings" as const,
    title: "Budget Ceilings",
    description: "Hard cost, token, and run limits enforced by rules/limits.ts.",
    areas: Object.freeze(["budgets.ceilings"] as const),
  }),
  Object.freeze({
    id: "terminal_state_authority" as const,
    title: "Terminal-State Authority",
    description: "Kernel event store as sole source of truth; terminal states are strictly immutable.",
    areas: Object.freeze(["kernel.event_store_authority"] as const),
  }),
])

/**
 * Static lookup mapping each core change area token to its governing immutable core item.
 */
const AREA_TO_CORE_ITEM: Record<CharterCoreChangeArea, ImmutableCoreItemId> = {
  "policy.safety_floor": "safety_floor",
  "fencing.input_ownership": "input_ownership_fencing",
  "security.allowed_sources": "security_perimeter",
  "security.project_allowlist": "security_perimeter",
  "roundtable.advisory_only": "roundtable_advisory_only",
  "budgets.ceilings": "budget_ceilings",
  "kernel.event_store_authority": "terminal_state_authority",
}

/**
 * Static membership record for core change areas.
 */
const IS_CORE_CHANGE_AREA: Record<string, true> = {
  "policy.safety_floor": true,
  "fencing.input_ownership": true,
  "security.allowed_sources": true,
  "security.project_allowlist": true,
  "roundtable.advisory_only": true,
  "budgets.ceilings": true,
  "kernel.event_store_authority": true,
}

/**
 * Specialized ContractError shape for core violations.
 * Always carries category="policy_denied", code="charter_core_violation", retryable=false.
 */
export type CharterCoreViolation = ContractError & {
  readonly code: "charter_core_violation"
  readonly category: "policy_denied"
  readonly retryable: false
}

/**
 * Computes the canonical SHA-256 digest of the 6-item immutable core claim object
 * with the supplied `SafetyFloor` embedded.
 *
 * PURE and deterministic: uses `digestJson` (canonical JSON encoding with sorted keys)
 * guaranteeing byte-identical digests across calls and key orderings.
 */
export function computeImmutableCoreDigest(floor: SafetyFloor): Digest {
  // Canonical representation enumerates the 6 fixed items by stable id,
  // embedding the safety floor data within the safety_floor item.
  const claim = {
    coreVersion: 1,
    items: IMMUTABLE_CORE_ITEMS.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      areas: [...item.areas],
      ...(item.id === "safety_floor" ? { data: floor } : {}),
    })),
  }

  return digestJson(claim)
}

/**
 * Asserts that a charter proposal does not relax or touch any element of the immutable core.
 *
 * PURE: No I/O, no system clock, no randomness. Identical inputs always return identical results.
 *
 * Validation rules:
 * 1. Area touching: If any operation in `proposal.changes` names an area belonging to
 *    `CHARTER_CORE_CHANGE_AREAS`, the proposal is immediately refused. Position in the ops
 *    list is irrelevant (first, middle, last).
 * 2. Core stamp: `proposal.charter.immutableCoreDigest` must match `computeImmutableCoreDigest(floor)`.
 *    A mismatch is refused as stamped against a different core baseline.
 *
 * @param proposal The proposed charter revision with its rationale, evidence refs, and ops.
 * @param floor The immutable SafetyFloor against which core validity is evaluated.
 * @returns Ok with void if valid, or a refusal Result containing CharterCoreViolation.
 */
export function assertCharterDoesNotRelaxCore(
  proposal: CharterProposal,
  floor: SafetyFloor,
): Result<void> {
  // Rule A: Check for any operations touching the immutable core
  for (const op of proposal.changes) {
    if (IS_CORE_CHANGE_AREA[op.area]) {
      const coreArea = op.area as CharterCoreChangeArea
      const coreItemId = AREA_TO_CORE_ITEM[coreArea]
      const noteSuffix = op.note ? ` (${op.note})` : ""
      return {
        ok: false,
        error: createContractError(
          "policy_denied",
          "charter_core_violation",
          `Proposal touches immutable core item '${coreItemId}' via change area '${op.area}'${noteSuffix}. Immutable core cannot be modified by charter revision.`,
          false,
        ) as CharterCoreViolation,
      }
    }
  }

  // Rule B: Verify core stamp matches the computed digest of the safety floor
  const expectedDigest = computeImmutableCoreDigest(floor)
  if (proposal.charter.immutableCoreDigest !== expectedDigest) {
    return {
      ok: false,
      error: createContractError(
        "policy_denied",
        "charter_core_violation",
        `Proposal charter immutableCoreDigest '${proposal.charter.immutableCoreDigest}' does not match active core digest '${expectedDigest}'. Proposal was stamped against a different core.`,
        false,
      ) as CharterCoreViolation,
    }
  }

  return { ok: true, value: undefined }
}
