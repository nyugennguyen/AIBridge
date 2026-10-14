/**
 * Charter Proposal Lifecycle Management.
 *
 * Implements plan §7.4 ("Proposal lifecycle") and §7.3 ("The immutable core"):
 *
 * 1. Proposal Lifecycle (§7.4):
 *    - `charter.propose` -> `charter.proposed` (status: pending; active charter UNCHANGED).
 *    - `charter.approve` -> flows through `charter.revise` -> `charter.revised` (new version active in repository).
 *    - `charter.reject` -> `charter.rejected` (rationale recorded; active charter UNCHANGED).
 *    - There is NO `charter.approved` event: approval flows through `charter.revise` which activates a new version.
 *    - `charter.revise` is a KERNEL COMMAND, never a file write.
 *
 * 2. Pre-Pending Core Refusal (§7.3, DoD #4):
 *    - `assertCharterDoesNotRelaxCore(proposal, floor)` is called from EXACTLY ONE place:
 *      the propose path, BEFORE the proposal becomes pending.
 *    - A proposal that touches any immutable core item or mismatches the immutableCoreDigest
 *      is refused immediately with `charter_core_violation`.
 *    - The refused proposal is STILL RECORDED AS EVIDENCE (auditable deliberation record),
 *      but can NEVER reach pending and can NEVER be activated.
 *
 * 3. Human-Only Approval (settled §15):
 *    - No auto-approve classes in v1: `charter.approve` is a human-authority command (`actor.kind === "user"`).
 *    - An agent-authored proposal (`author: "agent"` or submitted by `actor.kind: "session" | "node"`)
 *      can never approve itself; an unauthorized approval attempt is refused with `charter.unauthorized_approval`.
 */

import { digestJson } from "../digest.js"
import { createContractError, type ContractError, type Result } from "../errors.js"
import { SAFETY_FLOOR } from "../policy/floor.js"
import { assertCharterDoesNotRelaxCore } from "../policy/immutable-core.js"
import type { SafetyFloor } from "../policy/types.js"
import type { Actor } from "../types.js"
import type { Charter, CharterProposal } from "./types.js"
import type { CharterRepository } from "./repository.js"

// ============================================================================
// Types
// ============================================================================

/**
 * Lifecycle states of a charter revision proposal.
 */
export type ProposalStatus =
  | "pending"
  | "approved"
  | "revised"
  | "rejected"
  | "refused_core_violation"

/**
 * Recorded proposal document tracking state, audit metadata, and activation outcomes.
 */
export interface CharterProposalRecord {
  readonly proposalId: string
  readonly proposal: CharterProposal
  readonly status: ProposalStatus
  readonly proposedAt: string
  readonly proposedBy: Actor
  readonly decidedAt?: string
  readonly decidedBy?: Actor
  readonly rejectionRationale?: string
  readonly refusalReason?: string
  readonly activatedVersion?: number
}

/**
 * Input for submitting a new charter proposal.
 */
export interface ProposeCharterInput {
  readonly proposalId?: string
  readonly proposal: CharterProposal
  readonly actor: Actor
  readonly proposedAt?: string
  readonly safetyFloor?: SafetyFloor
}

/**
 * Input for approving a pending charter proposal.
 */
export interface ApproveCharterInput {
  readonly proposalId?: string
  readonly charterId: string
  readonly version?: number
  readonly actor: Actor
  readonly decidedAt?: string
  readonly comment?: string
}

/**
 * Input for rejecting a pending charter proposal.
 */
export interface RejectCharterInput {
  readonly proposalId?: string
  readonly charterId: string
  readonly version?: number
  readonly rationale: string
  readonly actor: Actor
  readonly decidedAt?: string
}

/**
 * Options for configuring CharterProposalLifecycle.
 */
export interface ProposalLifecycleOptions {
  readonly safetyFloor?: SafetyFloor
  readonly initialRecords?: readonly CharterProposalRecord[]
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Proposal lifecycle manager governing agent- and operator-proposed charter revisions.
 */
export class CharterProposalLifecycle {
  readonly #records = new Map<string, CharterProposalRecord>()
  readonly #evidenceLog: CharterProposalRecord[] = []
  readonly #defaultFloor: SafetyFloor

  constructor(options?: ProposalLifecycleOptions) {
    this.#defaultFloor = options?.safetyFloor ?? SAFETY_FLOOR
    if (options?.initialRecords) {
      for (const rec of options.initialRecords) {
        this.#records.set(rec.proposalId, rec)
        if (rec.status === "refused_core_violation") {
          this.#evidenceLog.push(rec)
        }
      }
    }
  }

  /**
   * Generates a deterministic proposalId if none was supplied.
   */
  #deriveProposalId(proposal: CharterProposal): string {
    const charter = proposal.charter
    const hash = digestJson({
      charterId: charter.charterId,
      version: charter.version,
      purpose: charter.purpose,
      changes: proposal.changes,
      rationale: proposal.rationale,
    })
    return `prop-${charter.charterId}-v${charter.version}-${hash.slice(7, 19)}`
  }

  /**
   * Locates a proposal record by explicit ID or by (charterId, optional version).
   */
  #findProposal(
    proposalId?: string,
    charterId?: string,
    version?: number,
  ): CharterProposalRecord | undefined {
    if (proposalId) {
      return this.#records.get(proposalId)
    }
    if (!charterId) return undefined

    // Find by charterId and optional version (prefer pending/approved over terminal)
    const matches: CharterProposalRecord[] = []
    for (const record of this.#records.values()) {
      if (record.proposal.charter.charterId === charterId) {
        if (version === undefined || record.proposal.charter.version === version) {
          matches.push(record)
        }
      }
    }

    if (matches.length === 0) return undefined

    // Prefer pending proposals, otherwise most recently proposed
    const pending = matches.find((m) => m.status === "pending")
    if (pending) return pending

    const approved = matches.find((m) => m.status === "approved")
    if (approved) return approved

    return matches[matches.length - 1]
  }

  /**
   * Proposes a charter revision.
   *
   * PRE-PENDING CORE REFUSAL (§7.3, DoD #4):
   * `assertCharterDoesNotRelaxCore(proposal, floor)` is called here — the EXACT ONE PLACE
   * in the system — before the proposal can become pending.
   *
   * If a core violation is found:
   * - It is refused with `charter_core_violation`.
   * - The proposed document is RECORDED as evidence in the store.
   * - It can NEVER become pending and can NEVER be activated.
   *
   * If valid:
   * - Recorded with status="pending".
   * - The active charter in CharterRepository remains completely UNCHANGED.
   */
  propose(input: ProposeCharterInput): Result<CharterProposalRecord> {
    const proposalId = input.proposalId ?? this.#deriveProposalId(input.proposal)
    const proposedAt = input.proposedAt ?? new Date().toISOString()
    const floor = input.safetyFloor ?? this.#defaultFloor

    // Invariant §7.3: assertCharterDoesNotRelaxCore called from exactly one place
    const coreVerdict = assertCharterDoesNotRelaxCore(input.proposal, floor)
    if (!coreVerdict.ok) {
      // Record as evidence; NEVER reaches pending
      const evidenceRecord: CharterProposalRecord = Object.freeze({
        proposalId,
        proposal: input.proposal,
        status: "refused_core_violation",
        proposedAt,
        proposedBy: input.actor,
        refusalReason: coreVerdict.error.message,
      })
      this.#records.set(proposalId, evidenceRecord)
      this.#evidenceLog.push(evidenceRecord)

      return {
        ok: false,
        error: coreVerdict.error,
      }
    }

    // Passed core checks: register as pending proposal
    const pendingRecord: CharterProposalRecord = Object.freeze({
      proposalId,
      proposal: input.proposal,
      status: "pending",
      proposedAt,
      proposedBy: input.actor,
    })
    this.#records.set(proposalId, pendingRecord)

    return {
      ok: true,
      value: pendingRecord,
    }
  }

  /**
   * Approves a pending charter revision proposal.
   *
   * HUMAN-ONLY APPROVAL (settled §15):
   * Approving a charter revision requires human authority (`actor.kind === "user"`).
   * Autonomous agent callers (`actor.kind === "session"` or `"node"`) are refused
   * with `charter.unauthorized_approval`.
   */
  approve(input: ApproveCharterInput): Result<CharterProposalRecord> {
    // 1. Enforce human-only approval authority
    if (input.actor.kind !== "user") {
      return {
        ok: false,
        error: createContractError(
          "policy_denied",
          "charter.unauthorized_approval",
          `Charter revision approval requires human authority (actor.kind must be 'user', got '${input.actor.kind}'). Agent-authored proposals cannot approve themselves.`,
          false,
        ),
      }
    }

    // 2. Locate the proposal
    const record = this.#findProposal(input.proposalId, input.charterId, input.version)
    if (!record) {
      const targetDesc = input.proposalId
        ? `'${input.proposalId}'`
        : `'${input.charterId}'${input.version !== undefined ? ` version ${input.version}` : ""}`
      return {
        ok: false,
        error: createContractError(
          "validation",
          "charter.proposal_not_found",
          `Proposal ${targetDesc} does not exist.`,
          false,
        ),
      }
    }

    // 3. Refuse non-pending states
    if (record.status === "refused_core_violation") {
      return {
        ok: false,
        error: createContractError(
          "policy_denied",
          "charter_core_violation",
          `Proposal '${record.proposalId}' was refused as an immutable core violation and can never be activated.`,
          false,
        ),
      }
    }

    if (record.status !== "pending") {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "charter.proposal_not_pending",
          `Proposal '${record.proposalId}' is in state '${record.status}' and cannot be approved (must be 'pending').`,
          false,
        ),
      }
    }

    // 4. Record approval transition
    const decidedAt = input.decidedAt ?? new Date().toISOString()
    const approvedRecord: CharterProposalRecord = Object.freeze({
      ...record,
      status: "approved",
      decidedAt,
      decidedBy: input.actor,
    })
    this.#records.set(record.proposalId, approvedRecord)

    return {
      ok: true,
      value: approvedRecord,
    }
  }

  /**
   * Marks a proposal as revised after activation in the CharterRepository.
   */
  markRevised(proposalId: string, activatedVersion: number): Result<CharterProposalRecord> {
    const record = this.#records.get(proposalId)
    if (!record) {
      return {
        ok: false,
        error: createContractError(
          "validation",
          "charter.proposal_not_found",
          `Proposal '${proposalId}' does not exist.`,
          false,
        ),
      }
    }

    // The `revised` stamp records an ACTIVATION (§7.4), so only a proposal whose
    // content was approved may receive it: stamping pending/rejected records
    // would let activation history be manufactured after the fact.
    if (record.status !== "approved") {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "charter.revision_not_approved",
          `Proposal '${proposalId}' is '${record.status}', not 'approved'; only an approved proposal can be stamped revised.`,
          false,
        ),
      }
    }

    const revisedRecord: CharterProposalRecord = Object.freeze({
      ...record,
      status: "revised",
      activatedVersion,
    })
    this.#records.set(proposalId, revisedRecord)

    return {
      ok: true,
      value: revisedRecord,
    }
  }

  /**
   * Rejects a pending charter revision proposal with an audited rationale.
   * Leaves the active charter in CharterRepository completely UNCHANGED.
   */
  reject(input: RejectCharterInput): Result<CharterProposalRecord> {
    const record = this.#findProposal(input.proposalId, input.charterId, input.version)
    if (!record) {
      const targetDesc = input.proposalId
        ? `'${input.proposalId}'`
        : `'${input.charterId}'${input.version !== undefined ? ` version ${input.version}` : ""}`
      return {
        ok: false,
        error: createContractError(
          "validation",
          "charter.proposal_not_found",
          `Proposal ${targetDesc} does not exist.`,
          false,
        ),
      }
    }

    if (record.status === "refused_core_violation") {
      return {
        ok: false,
        error: createContractError(
          "policy_denied",
          "charter_core_violation",
          `Proposal '${record.proposalId}' was already refused as an immutable core violation and cannot be rejected.`,
          false,
        ),
      }
    }

    if (record.status !== "pending") {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "charter.proposal_not_pending",
          `Proposal '${record.proposalId}' is in state '${record.status}' and cannot be rejected (must be 'pending').`,
          false,
        ),
      }
    }

    const decidedAt = input.decidedAt ?? new Date().toISOString()
    const rejectedRecord: CharterProposalRecord = Object.freeze({
      ...record,
      status: "rejected",
      decidedAt,
      decidedBy: input.actor,
      rejectionRationale: input.rationale,
    })
    this.#records.set(record.proposalId, rejectedRecord)

    return {
      ok: true,
      value: rejectedRecord,
    }
  }

  /**
   * Retrieves a proposal record by its ID.
   */
  getProposal(proposalId: string): CharterProposalRecord | undefined {
    return this.#records.get(proposalId)
  }

  /**
   * Finds a proposal by charterId and optional version.
   */
  findProposal(charterId: string, version?: number): CharterProposalRecord | undefined {
    return this.#findProposal(undefined, charterId, version)
  }

  /**
   * Retrieves a pending proposal for a given charterId and optional version.
   */
  getPendingProposal(charterId: string, version?: number): CharterProposalRecord | undefined {
    const match = this.#findProposal(undefined, charterId, version)
    return match?.status === "pending" ? match : undefined
  }

  /**
   * Lists all recorded proposals, optionally filtered by charterId.
   */
  listProposals(charterId?: string): readonly CharterProposalRecord[] {
    const all = [...this.#records.values()]
    if (!charterId) return Object.freeze(all)
    return Object.freeze(all.filter((r) => r.proposal.charter.charterId === charterId))
  }

  /**
   * Lists all recorded evidence, including core violation refusals.
   */
  listEvidence(charterId?: string): readonly CharterProposalRecord[] {
    if (!charterId) return Object.freeze([...this.#evidenceLog])
    return Object.freeze(
      this.#evidenceLog.filter((r) => r.proposal.charter.charterId === charterId),
    )
  }

  /**
   * Checks whether any pending proposal exists for a charterId.
   */
  hasPending(charterId: string): boolean {
    return this.getPendingProposal(charterId) !== undefined
  }
}

/**
 * Single-export alias matching repository convention.
 */
export const CharterProposalRepository = CharterProposalLifecycle
export type CharterProposalRepository = CharterProposalLifecycle
