/**
 * Roundtable Deliberation Aggregate Types, Preconditions, and Error Models.
 *
 * Implements the domain contracts for advisory multi-agent deliberation
 * defined in docs/implementation-plans/aibridge-herdr-orchestration.md §6.3, §7.5, and §10.
 *
 * Key Invariants:
 * 1. ADVISORY ONLY (§7.5):
 *    A roundtable outcome is an INPUT to a future `dispatch.propose` or rule evaluation;
 *    it NEVER directly triggers a kernel state transition.
 *
 * 2. FIXED MEMBERSHIP (§10):
 *    Roundtable membership is immutable once opened. Only declared members may post
 *    (with the exception of human injection via `roundtable.inject_human`).
 *
 * 3. MONOTONIC SEQUENCE PER DISCUSSION (§6.3, §10):
 *    Posts within a discussion carry a deterministic, monotonically increasing `seq` (1, 2, ...),
 *    assigned at append time.
 */

import type { z } from "zod"
import { createContractError, type ContractError } from "../errors.js"
import type { NodeId, RoleId, Timestamp } from "../identifiers.js"
import type {
  discussionModeSchema,
  postKindSchema,
  postSchema,
  roundtableMemberSchema,
  roundtableOutcomeSchema,
  roundtableSchema,
} from "../schemas.js"

export type DiscussionMode = z.infer<typeof discussionModeSchema>
export type PostKind = z.infer<typeof postKindSchema>
export type RoundtableMember = z.infer<typeof roundtableMemberSchema>
export type Roundtable = z.infer<typeof roundtableSchema>
export type Post = z.infer<typeof postSchema>
export type RoundtableOutcome = z.infer<typeof roundtableOutcomeSchema>

/**
 * In-memory aggregate state for a single roundtable deliberation session.
 */
export interface RoundtableAggregateState {
  readonly roundtable: Roundtable
  readonly posts: readonly Post[]
  readonly outcome?: RoundtableOutcome
}

/**
 * User-supplied input for authoring a post within an existing discussion.
 * Sequence (`seq`) is omitted because it is assigned deterministically at append time.
 */
export interface NewPostInput {
  readonly postId: string
  readonly discussionId: string
  readonly authorNodeId: NodeId
  readonly authorRoleId: RoleId | "human"
  readonly kind: PostKind
  readonly replyTo?: string
  readonly body: string
  readonly createdAt: Timestamp
}

// ============================================================================
// Domain Errors
// ============================================================================

export class RoundtableNotFoundError extends Error {
  readonly code = "roundtable.not_found" as const
  readonly category = "validation" as const
  readonly discussionId: string

  constructor(discussionId: string, message?: string) {
    super(message ?? `roundtable.not_found: Discussion '${discussionId}' does not exist`)
    this.name = "RoundtableNotFoundError"
    this.discussionId = discussionId
  }

  toContractError(): ContractError {
    return createContractError("validation", this.code, this.message, false)
  }
}

export class RoundtableAlreadyExistsError extends Error {
  readonly code = "roundtable.already_exists" as const
  readonly category = "conflict" as const
  readonly discussionId: string

  constructor(discussionId: string, message?: string) {
    super(message ?? `roundtable.already_exists: Discussion '${discussionId}' already exists`)
    this.name = "RoundtableAlreadyExistsError"
    this.discussionId = discussionId
  }

  toContractError(): ContractError {
    return createContractError("conflict", this.code, this.message, false)
  }
}

export class RoundtableClosedError extends Error {
  readonly code = "roundtable.closed" as const
  readonly category = "conflict" as const
  readonly discussionId: string

  constructor(discussionId: string, message?: string) {
    super(message ?? `roundtable.closed: Discussion '${discussionId}' is closed; operation refused`)
    this.name = "RoundtableClosedError"
    this.discussionId = discussionId
  }

  toContractError(): ContractError {
    return createContractError("conflict", this.code, this.message, false)
  }
}

export class RoundtableNonMemberError extends Error {
  readonly code = "roundtable.non_member" as const
  readonly category = "conflict" as const
  readonly discussionId: string
  readonly authorNodeId: string
  readonly authorRoleId: string

  constructor(discussionId: string, authorNodeId: string, authorRoleId: string, message?: string) {
    super(
      message ??
        `roundtable.non_member: Author node '${authorNodeId}' with role '${authorRoleId}' is not a member of discussion '${discussionId}'`,
    )
    this.name = "RoundtableNonMemberError"
    this.discussionId = discussionId
    this.authorNodeId = authorNodeId
    this.authorRoleId = authorRoleId
  }

  toContractError(): ContractError {
    return createContractError("conflict", this.code, this.message, false)
  }
}

export class RoundtableInvalidAuthorError extends Error {
  readonly code = "roundtable.invalid_author" as const
  readonly category = "validation" as const
  readonly authorRoleId: string

  constructor(authorRoleId: string, message?: string) {
    super(message ?? `roundtable.invalid_author: Author role ID for inject_human must be 'human', got '${authorRoleId}'`)
    this.name = "RoundtableInvalidAuthorError"
    this.authorRoleId = authorRoleId
  }

  toContractError(): ContractError {
    return createContractError("validation", this.code, this.message, false)
  }
}

export class RoundtableMembershipError extends Error {
  readonly code = "roundtable.invalid_members" as const
  readonly category = "validation" as const

  constructor(message: string) {
    super(`roundtable.invalid_members: ${message}`)
    this.name = "RoundtableMembershipError"
  }

  toContractError(): ContractError {
    return createContractError("validation", this.code, this.message, false)
  }
}
