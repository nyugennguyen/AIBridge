import type { z } from "zod"
import {
  CHARTER_CHANGE_AREAS,
  CHARTER_CORE_CHANGE_AREAS,
} from "../schemas.js"
import type {
  charterAuthorSchema,
  charterChangeAreaSchema,
  charterChangeOpSchema,
  charterProposalSchema,
  charterRoleRefSchema,
  charterSchema,
  communicationPolicySchema,
  discussionModeSchema,
  escalationPolicySchema,
  postKindSchema,
  postSchema,
  roundtableMemberSchema,
  roundtableOutcomeSchema,
  roundtableSchema,
} from "../schemas.js"

export { CHARTER_CHANGE_AREAS, CHARTER_CORE_CHANGE_AREAS }

/**
 * Structural change areas recognized in charter revision proposals.
 */
export type CharterChangeArea = z.infer<typeof charterChangeAreaSchema>

/**
 * Immutable-core subset of change areas (plan §7.3).
 */
export type CharterCoreChangeArea = (typeof CHARTER_CORE_CHANGE_AREAS)[number]

/**
 * Structural change operation on a charter proposal.
 */
export type CharterChangeOp = z.infer<typeof charterChangeOpSchema>
/**
 * Author kind for a charter document.
 * Charters are either authored by human operators or proposed by agents.
 */
export type CharterAuthor = z.infer<typeof charterAuthorSchema>

/**
 * Reference to a role template included in a charter's catalog.
 */
export type CharterRoleRef = z.infer<typeof charterRoleRefSchema>

/**
 * Communication policy governing deliberation, turn-taking, and objection
 * requirements across agents during orchestration.
 */
export type CommunicationPolicy = z.infer<typeof communicationPolicySchema>

/**
 * Escalation policy configuring round bounds and deadlock resolution.
 */
export type EscalationPolicy = z.infer<typeof escalationPolicySchema>

/**
 * Charter document defining the immutable-core-anchored orchestration prompt,
 * global rules, communication rules, escalation rules, and catalog of roles.
 */
export type Charter = z.infer<typeof charterSchema>

/**
 * Deliberation sequencing modes for a roundtable.
 */
export type DiscussionMode = z.infer<typeof discussionModeSchema>

/**
 * Structural kind of a post in a roundtable deliberation.
 */
export type PostKind = z.infer<typeof postKindSchema>

/**
 * Minimal membership record identifying a roundtable participant by node and role.
 */
export type RoundtableMember = z.infer<typeof roundtableMemberSchema>

/**
 * Advisory roundtable session aggregate for structured multi-agent deliberation.
 */
export type Roundtable = z.infer<typeof roundtableSchema>

/**
 * Single post within a roundtable deliberation.
 */
export type Post = z.infer<typeof postSchema>

/**
 * Advisory outcome recorded at the conclusion of a roundtable.
 * NOTE: Advisory only; never a state-transition trigger.
 */
export type RoundtableOutcome = z.infer<typeof roundtableOutcomeSchema>

/**
 * Agent- or human-authored proposal to revise the active charter, carrying
 * rationale and evidence references back to deliberation sessions.
 */
export type CharterProposal = z.infer<typeof charterProposalSchema>

export type {
  ProposalStatus,
  CharterProposalRecord,
  ProposeCharterInput,
  ApproveCharterInput,
  RejectCharterInput,
} from "./proposal.js"
export {
  CharterProposalLifecycle,
  CharterProposalRepository,
} from "./proposal.js"
