/**
 * Memory Write-Back from Roundtable Deliberation Outcomes (Plan §6.3, §7.5, §10 row 3).
 *
 * Captures the advisory deliberation outcome of a closed roundtable as a
 * persistent memory record.
 *
 * Invariants Enforced:
 * 1. PROVENANCE (§10 Phase 5 row 3):
 *    `sourceReferences` link back directly to the discussion (`discussionId`)
 *    and each constituent post (`postId`), making the deliberation outcome
 *    fully auditable to its inputs.
 *
 * 2. PROPOSED TRUST STATE (§7, §10):
 *    Outcome-derived memories are unreviewed deliberation output and therefore
 *    MUST be born `proposed`. Only an authorized human user may decide trust.
 *
 * 3. TRANSACTION / OUTBOX DISCIPLINE (§6.3, ADR 0003, ADR 0008):
 *    The write-back is named in the command's outbox records within the same
 *    durable transaction as `roundtable.outcome_recorded`. If memory writes
 *    fail post-commit, the outcome commit is never corrupted or rolled back.
 */

import { digestJson } from "../digest.js"
import { memoryIdSchema } from "../identifiers.js"
import { memoryRecordSchema } from "../schemas.js"
import type { OrchestrationCommand, MemoryRecord } from "../types.js"
import { deriveMemoryId, memoryRecordSourceKey } from "../../memory/in-memory-repository.js"
import type { AppendMemoryInput } from "../../memory/ports.js"
import type { Post, RoundtableAggregateState, RoundtableOutcome } from "./types.js"

export const ROUNDTABLE_MEMORY_KIND = "decision" as const
export const MEMORY_WRITEBACK_DESTINATION = "memory.write_back" as const

/**
 * Formats a roundtable deliberation outcome into a human- and agent-readable markdown string.
 */
export function formatRoundtableOutcomeContent(outcome: RoundtableOutcome): string {
  const parts: string[] = []
  parts.push(`Summary: ${outcome.summary}`)
  if (outcome.recommendation) {
    parts.push(`Recommendation: ${outcome.recommendation}`)
  }
  if (outcome.addressedObjections.length > 0) {
    parts.push(`Addressed objections: ${outcome.addressedObjections.join(", ")}`)
  }
  if (outcome.unresolvedObjections.length > 0) {
    parts.push(`Unresolved objections: ${outcome.unresolvedObjections.join(", ")}`)
  }
  return parts.join("\n\n")
}

/**
 * Derives the provenance source references linking back to the discussion and all constituent posts.
 */
export function createRoundtableOutcomeSourceReferences(
  discussionId: string,
  posts: readonly Post[],
): readonly { readonly namespace: string; readonly id: string }[] {
  const uniquePostIds = Array.from(new Set(posts.map((p) => p.postId)))
  const postRefs = uniquePostIds.map((postId) => ({
    namespace: "postId" as const,
    id: postId,
  }))

  return [
    { namespace: "discussionId" as const, id: discussionId },
    ...postRefs,
  ]
}

export interface RoundtableOutcomeMemoryRecordResult {
  readonly memoryRecord: MemoryRecord
  readonly appendInput: AppendMemoryInput
}

/**
 * Creates both the canonical M0 `MemoryRecord` and the memory subsystem `AppendMemoryInput`
 * for a closed roundtable deliberation outcome.
 */
export function createRoundtableOutcomeMemoryRecord(input: {
  readonly discussion: RoundtableAggregateState
  readonly outcome: RoundtableOutcome
  readonly command: Extract<OrchestrationCommand, { type: "roundtable.close" }>
}): RoundtableOutcomeMemoryRecordResult {
  const { discussion, outcome, command } = input
  const discussionId = discussion.roundtable.id
  const content = formatRoundtableOutcomeContent(outcome)
  const sourceReferences = createRoundtableOutcomeSourceReferences(discussionId, discussion.posts)

  const scope =
    discussion.roundtable.taskId !== undefined
      ? {
          kind: "task" as const,
          runId: command.runId,
          taskId: discussion.roundtable.taskId,
        }
      : {
          kind: "run" as const,
          runId: command.runId,
        }

  const appendInput: AppendMemoryInput = {
    projectId: command.projectId,
    kind: ROUNDTABLE_MEMORY_KIND,
    scope,
    author: command.actor,
    createdAt: command.issuedAt,
    content,
    detail: {
      discussionId,
      summary: outcome.summary,
      recommendation: outcome.recommendation,
      addressedObjections: outcome.addressedObjections,
      unresolvedObjections: outcome.unresolvedObjections,
    },
    sensitivity: "public_to_project",
    retention: "project",
    sourceReferences,
    trust: "proposed",
    correlationId: command.commandId,
  }

  const derivedId = deriveMemoryId(memoryRecordSourceKey(appendInput))
  const memoryId = memoryIdSchema.parse(derivedId)

  const memoryRecord = memoryRecordSchema.parse({
    schemaVersion: 1,
    memoryId,
    projectId: command.projectId,
    kind: ROUNDTABLE_MEMORY_KIND,
    content,
    contentDigest: digestJson(content),
    scope,
    author: command.actor,
    createdAt: command.issuedAt,
    sourceReferences,
    trustState: "proposed",
    sensitivity: "internal",
    retention: "project",
  })

  return { memoryRecord, appendInput }
}
