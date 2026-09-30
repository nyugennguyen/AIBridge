/**
 * M5.6 — the agent-proposed memory workflow.
 *
 * # What this module is for
 *
 * An agent must be able to write down what it learned, and that writing must
 * not be able to become a trusted project fact by itself. So the workflow is
 * three commands and one rule:
 *
 *   propose   — an agent (or anyone) creates a `proposed` record
 *   accept    — a `user` promotes a proposal to `accepted`
 *   reject    — a `user` marks a proposal `rejected`
 *   supersede — anyone may correct a record; the correction is a NEW record
 *
 * The rule is `ACCEPTING_ACTOR_KINDS = ["user"]`, which lives in the ontology
 * and is enforced in the *record schema* as well. A `proposed` record with a
 * node-authored `trustDecision` does not parse, so "the agent accepted its own
 * proposal" is not a policy violation to be detected at runtime — it is a
 * record that cannot be written.
 *
 * # Why every command is an audit event
 *
 * The plan requires "accept/reject/supersede commands, audit events". Each
 * command returns the events it produced, attributed to the actor who issued
 * it, and each event carries the record's id and the *before* trust state. An
 * audit trail that records only "something changed" cannot answer "who
 * promoted this, and what was it before", which are the two questions an
 * incident review actually asks.
 *
 * # Why the workflow is not a repository method
 *
 * `MemoryRepository.decideTrust` exists and does the storage. This module adds
 * the *workflow* on top: validation, the audit events, and the refusal messages
 * an operator sees. Splitting them means the repository stays a storage port
 * that a TUI, a CLI, and a future HTTP route can each drive with their own
 * policy, and none of them can skip the audit by going straight to storage.
 */

import { createContractError, type Result } from "../orchestration/errors.js"
import type { Actor } from "../orchestration/types.js"
import {
  ACCEPTING_ACTOR_KINDS,
  canTransitionTrust,
  isTrusted,
  type MemoryKind,
  type TrustState,
} from "./ontology.js"
import {
  memoryRecordSchemaV2,
  proposeMemoryRecord,
  type MemoryRecordV2,
} from "./record.js"
import type { AppendMemoryInput, MemoryRepository, MemoryWithholding } from "./ports.js"

/** Every command the workflow accepts, as a closed union. */
export const MEMORY_COMMANDS = ["memory.propose", "memory.accept", "memory.reject", "memory.supersede"] as const
export type MemoryCommandType = (typeof MEMORY_COMMANDS)[number]

/**
 * An audit event.
 *
 * `before`/`after` are trust states, not record bodies, and the event never
 * carries content. A memory audit log is a log a support engineer will paste
 * into a ticket; anything in it is disclosed to whoever reads the ticket.
 */
export interface MemoryAuditEvent {
  readonly type: MemoryCommandType
  readonly memoryId: string
  readonly projectId: string
  readonly kind: MemoryKind
  readonly actor: Actor
  readonly at: string
  readonly before: TrustState | "absent"
  readonly after: TrustState
  /** 1..1024, required on accept/reject. A trust decision with no reason is not auditable. */
  readonly reason?: string
  /** For a supersede: the record this one replaces. */
  readonly supersedesMemoryId?: string
  readonly correlationId: string
}

export interface ProposeCommand {
  readonly type: "memory.propose"
  readonly projectId: string
  readonly kind: MemoryKind
  readonly scope: MemoryRecordV2["scope"]
  readonly author: Actor
  readonly at: string
  readonly content: string
  readonly detail?: Record<string, unknown>
  readonly artifactReferences?: readonly string[]
  readonly correlationId: string
  readonly sensitivity?: MemoryRecordV2["sensitivity"]
  readonly retention?: MemoryRecordV2["retention"]
  readonly supersedesMemoryId?: string
  readonly sourceReferences?: readonly { namespace: string; id: string }[]
  readonly correlationNote?: string
}

export interface DecideCommand {
  readonly type: "memory.accept" | "memory.reject"
  readonly memoryId: string
  readonly projectId: string
  readonly decidedBy: Actor
  readonly at: string
  /** 1..1024. Required. */
  readonly reason: string
  readonly correlationId: string
}

export interface SupersedeCommand {
  readonly type: "memory.supersede"
  readonly supersedesMemoryId: string
  readonly projectId: string
  readonly author: Actor
  readonly at: string
  readonly content: string
  readonly correlationId: string
  readonly detail?: Record<string, unknown>
  readonly sourceReferences?: readonly { namespace: string; id: string }[]
}

export type MemoryCommand = ProposeCommand | DecideCommand | SupersedeCommand

export interface CommandResult {
  readonly record: MemoryRecordV2
  readonly events: readonly MemoryAuditEvent[]
}

/** The scope a command is authorized at. Deliberately not derivable from the command. */
export interface WorkflowContext {
  readonly actor: Actor
  readonly projectId: string
  readonly at: string
  readonly correlationId: string
}

export interface MemoryWorkflow {
  execute(command: MemoryCommand, context: WorkflowContext): Promise<Result<CommandResult>>
}

/**
 * The actor on a command must match the context's actor.
 *
 * Without this, any caller could pass `author: {kind: "user"}` on a command
 * executed by a node. The record would then claim a human wrote it. This is the
 * check that makes the author field mean something, and it is a *refusal* with
 * a specific code so the failure is diagnosable rather than a generic 403.
 */
function assertActorMatches(command: MemoryCommand, context: WorkflowContext): Result<true> {
  const claimed = command.type === "memory.propose" ? command.author : command.type === "memory.supersede" ? command.author : command.decidedBy
  if (JSON.stringify(claimed) === JSON.stringify(context.actor)) return { ok: true, value: true }
  return {
    ok: false,
    error: createContractError(
      "policy_denied",
      "memory.actor_mismatch",
      `The command names a ${claimed.kind} actor but is being executed as a ${context.actor.kind} actor; an actor cannot be asserted by a caller`,
    ),
  }
}

/**
 * Refuses an accept/reject from anything but a user.
 *
 * The record schema would also refuse the result, so this is a *pre-check with
 * a good message* rather than the enforcement. Both exist because the schema
 * protects stored data and this protects the operator's understanding of why
 * their click did nothing.
 */
function assertMayDecide(actor: Actor): Result<true> {
  if (ACCEPTING_ACTOR_KINDS.includes(actor.kind)) return { ok: true, value: true }
  return {
    ok: false,
    error: createContractError(
      "policy_denied",
      "memory.unauthorized_trust_decision",
      `Only ${ACCEPTING_ACTOR_KINDS.join("/")} may accept or reject a memory record; '${actor.kind}' may only propose`,
    ),
  }
}

export class RepositoryMemoryWorkflow implements MemoryWorkflow {
  constructor(private readonly repository: MemoryRepository) {}

  async execute(command: MemoryCommand, context: WorkflowContext): Promise<Result<CommandResult>> {
    if (command.projectId !== context.projectId) {
      return {
        ok: false,
        error: createContractError(
          "policy_denied",
          "memory.cross_project_command",
          `The command targets project '${command.projectId}' but the workflow is scoped to '${context.projectId}'`,
        ),
      }
    }

    const actorMatches = assertActorMatches(command, context)
    if (!actorMatches.ok) return actorMatches

    switch (command.type) {
      case "memory.propose":
        return this.propose(command, context)
      case "memory.accept":
      case "memory.reject":
        return this.decide(command, context)
      case "memory.supersede":
        return this.supersede(command, context)
    }
  }

  private async propose(command: ProposeCommand, context: WorkflowContext): Promise<Result<CommandResult>> {
    // The trust state is not a command parameter. It is derived from the author
    // by the ontology, so `memory.propose` has no way to say "and make it
    // accepted" — the field does not exist.
    const input: AppendMemoryInput = {
      projectId: command.projectId,
      kind: command.kind,
      scope: command.scope,
      author: command.author,
      createdAt: command.at,
      content: command.content,
      ...(command.detail ? { detail: command.detail } : {}),
      ...(command.artifactReferences ? { artifactReferences: command.artifactReferences } : {}),
      ...(command.supersedesMemoryId ? { supersedesMemoryId: command.supersedesMemoryId } : {}),
      ...(command.sourceReferences ? { sourceReferences: command.sourceReferences } : {}),
      ...(command.sensitivity ? { sensitivity: command.sensitivity } : {}),
      ...(command.retention ? { retention: command.retention } : {}),
      correlationId: context.correlationId,
    }

    const appended = await this.repository.append(input)
    if (!appended.ok) return appended

    const event: MemoryAuditEvent = {
      type: "memory.propose",
      memoryId: appended.value.record.memoryId,
      projectId: appended.value.record.projectId,
      kind: appended.value.record.kind,
      actor: context.actor,
      at: command.at,
      before: "absent",
      // The record's ACTUAL trust, not the requested one. An audit event that
      // recorded an intent rather than an outcome would read as though an
      // agent's proposal was accepted.
      after: appended.value.record.trust,
      ...(command.supersedesMemoryId ? { supersedesMemoryId: command.supersedesMemoryId } : {}),
      correlationId: context.correlationId,
    }
    return { ok: true, value: { record: appended.value.record, events: [event] } }
  }

  private async decide(command: DecideCommand, context: WorkflowContext): Promise<Result<CommandResult>> {
    const authorized = assertMayDecide(context.actor)
    if (!authorized.ok) return authorized

    if (command.reason.trim().length === 0) {
      return {
        ok: false,
        error: createContractError(
          "validation",
          "memory.trust_reason_required",
          "A trust decision must state a reason; an unexplained acceptance is the thing an audit cannot review",
        ),
      }
    }

    const target = await this.repository.getRaw(command.memoryId)
    if (target === null) {
      return {
        ok: false,
        error: createContractError("validation", "memory.unknown_record", `No memory record with id '${command.memoryId}'`),
      }
    }
    const current = trustOf(target)
    const next: TrustState = command.type === "memory.accept" ? "accepted" : "rejected"
    if (!canTransitionTrust(current, next)) {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "memory.illegal_trust_transition",
          `A '${current}' record cannot become '${next}'; a rejected or already-decided record is corrected by superseding it, not by re-deciding it`,
        ),
      }
    }

    const decided = await this.repository.decideTrust(command.memoryId, {
      trust: next,
      decidedBy: context.actor,
      decidedAt: command.at,
      reason: command.reason,
    })
    if (!decided.ok) return decided

    const event: MemoryAuditEvent = {
      type: command.type,
      memoryId: decided.value.memoryId,
      projectId: decided.value.projectId,
      kind: decided.value.kind,
      actor: context.actor,
      at: command.at,
      before: current,
      after: decided.value.trust,
      reason: command.reason,
      correlationId: context.correlationId,
    }
    return { ok: true, value: { record: decided.value, events: [event] } }
  }

  private async supersede(command: SupersedeCommand, context: WorkflowContext): Promise<Result<CommandResult>> {
    const target = await this.repository.getRaw(command.supersedesMemoryId)
    if (target === null) {
      return {
        ok: false,
        error: createContractError(
          "validation",
          "memory.unknown_record",
          `No memory record with id '${command.supersedesMemoryId}' to supersede`,
        ),
      }
    }

    const input: AppendMemoryInput = {
      projectId: command.projectId,
      kind: (target as MemoryRecordV2).kind,
      scope: (target as MemoryRecordV2).scope,
      author: command.author,
      createdAt: command.at,
      content: command.content,
      ...(command.detail ? { detail: command.detail } : {}),
      ...(command.sourceReferences ? { sourceReferences: command.sourceReferences } : {}),
      supersedesMemoryId: command.supersedesMemoryId,
      correlationId: context.correlationId,
    }

    const appended = await this.repository.supersede(command.supersedesMemoryId, input)
    if (!appended.ok) return appended

    const events: MemoryAuditEvent[] = [
      {
        type: "memory.propose",
        memoryId: appended.value.record.memoryId,
        projectId: appended.value.record.projectId,
        kind: appended.value.record.kind,
        actor: context.actor,
        at: command.at,
        before: "absent",
        after: appended.value.record.trust,
        supersedesMemoryId: command.supersedesMemoryId,
        correlationId: context.correlationId,
      },
    ]
    if (appended.value.superseded) {
      // A second event: the OLD record's active view changed. Without it, an
      // audit shows a new record appearing and nothing about what it displaced.
      events.push({
        type: "memory.supersede",
        memoryId: appended.value.superseded.memoryId,
        projectId: appended.value.superseded.projectId,
        kind: appended.value.superseded.kind,
        actor: context.actor,
        at: command.at,
        before: trustOf(appended.value.superseded),
        after: appended.value.superseded.trust,
        supersedesMemoryId: appended.value.record.memoryId,
        correlationId: context.correlationId,
      })
    }
    return { ok: true, value: { record: appended.value.record, events } }
  }
}

/** The trust of a record at either version. */
function trustOf(record: unknown): TrustState {
  const typed = record as { trust?: TrustState; trustState?: TrustState }
  return typed.trust ?? typed.trustState ?? "proposed"
}

/**
 * What a review queue looks like.
 *
 * The TUI's reason for existing in M5.8, and the answer to "what still needs a
 * human?". A record is in the queue when it is proposed, visible to this scope,
 * and not superseded — the last two because a queue showing superseded
 * proposals is a queue that asks a human to re-review a correction.
 */
export interface ReviewQueue {
  readonly items: readonly ReviewQueueItem[]
  /** The refusals a reader hit on the way, so the queue explains its own silence. */
  readonly withheld: readonly MemoryWithholding[]
}

export interface ReviewQueueItem {
  readonly memoryId: string
  readonly kind: MemoryKind
  readonly createdAt: string
  readonly authorKind: Actor["kind"]
  readonly sensitivity: MemoryRecordV2["sensitivity"]
  readonly content: string
  readonly isTrusted: boolean
}

export function buildReviewQueue(
  withheld: readonly MemoryWithholding[],
  trusted: readonly { view: ReturnType<typeof toView> }[],
): ReviewQueue {
  return {
    items: trusted.map(({ view }) => ({
      memoryId: view.memoryId,
      kind: view.kind,
      createdAt: view.createdAt,
      authorKind: view.author.kind,
      sensitivity: view.sensitivity,
      content: view.payload.content,
      isTrusted: isTrusted(view.trust),
    })),
    withheld: [...withheld],
  }
}

function toView(record: MemoryRecordV2) {
  return {
    memoryId: record.memoryId,
    projectId: record.projectId,
    kind: record.kind,
    scope: record.scope,
    author: record.author,
    createdAt: record.createdAt,
    payload: record.payload,
    contentHash: record.contentHash,
    trust: record.trust,
    sensitivity: record.sensitivity,
    retention: record.retention,
    redaction: record.redaction,
    sourceReferences: record.sourceReferences,
  }
}

export { memoryRecordSchemaV2, proposeMemoryRecord }
