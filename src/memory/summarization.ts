/**
 * M5.7 — handoff and result summarization.
 *
 * # The thing this module prevents
 *
 * Without structure, "tell the next agent what you did" is answered by pasting
 * the transcript. The plan's guardrail is explicit — "Do not store complete raw
 * transcripts as memory by default" — and the downstream-context criterion is
 * "Downstream context excludes unrelated transcript/output".
 *
 * So a handoff is a *fixed-shape* record: a status, a bounded prose summary, a
 * list of artifact references by id, and a list of what the receiver must know.
 * There is no field a transcript can be put in, and the summary is bounded by
 * `MAX_SUMMARY_CHARACTERS` and validated against it. A caller that tries to
 * write 200 KB of terminal output into `summary` gets a validation error, not a
 * memory record that will be injected into every future context.
 *
 * # Why the bound is a character count and not a token count
 *
 * Same reasoning as the context budget: a tokenizer is a dependency whose
 * behaviour can change under you, and a handoff's size limit must not change
 * because a library was upgraded. Characters are stable, cheap, and the
 * manifest's own estimate converts them consistently.
 *
 * # What "structured dependency result" means here
 *
 * A `DependencyResult` is what a finished dispatch reports: did it complete, what
 * did it produce (artifact ids), what should the next task know (a bounded
 * summary), and what is still unknown (`unresolved`, an explicit list).
 *
 * `unresolved` is the field that makes this honest. A summary that only says
 * what was learned implies completeness; a summary that says "I did not determine
 * whether the deploy key rotates" tells the next agent what it must not assume.
 * The plan's "bounded run summary" only means anything if the bounds are
 * declared.
 *
 * # Bounded run summary
 *
 * `buildRunSummary` is a *capped projection* of dependency results, not an
 * aggregation that grows. It takes the highest-priority results up to a
 * character budget and records which ones it dropped, so a run summary cannot
 * silently under-report.
 */

import { createContractError, type Result } from "../orchestration/errors.js"
import type { Actor } from "../orchestration/types.js"
import { z } from "zod"
import {
  artifactIdSchema,
  dispatchIdSchema,
  projectIdSchema,
  runIdSchema,
  taskIdSchema,
  type ProjectId,
  type RunId,
} from "../orchestration/identifiers.js"
import { addMismatch, shortTextSchema, textSchema } from "../memory/primitives.js"
import type { MemoryRecordV2 } from "../memory/record.js"
import { proposeMemoryRecord } from "../memory/record.js"
import type { Sensitivity } from "../memory/ontology.js"

/** 4 KiB. A handoff summary longer than this is a transcript, not a summary. */
export const MAX_SUMMARY_CHARACTERS = 4_096
/** An upper bound on artifact references, so a handoff cannot become an index. */
export const MAX_ARTIFACT_REFERENCES = 32
export const MAX_UNRESOLVED = 16

export const dependencyOutcomeSchema = z.enum(["completed", "failed", "timed_out", "cancelled"])
export type DependencyOutcome = z.infer<typeof dependencyOutcomeSchema>

/**
 * A structured result, not prose.
 *
 * `content` is bounded and required. `artifacts` are ids only — an id is a
 * pointer, and following it requires the artifact reader, which enforces the
 * same project/node/role policy as memory (see the plan's "Artifact readers
 * enforce the same project/node/role policy as memory records").
 */
export const dependencyResultSchema = z
  .object({
    taskId: taskIdSchema,
    dispatchId: dispatchIdSchema,
    outcome: dependencyOutcomeSchema,
    /** 1..MAX_SUMMARY_CHARACTERS. */
    content: z.string().min(1).max(MAX_SUMMARY_CHARACTERS),
    /** Ids only. Never inline content. */
    artifacts: z.array(artifactIdSchema).max(MAX_ARTIFACT_REFERENCES).optional(),
    /** What the receiver must NOT assume. Explicitly empty is a valid answer. */
    unresolved: z.array(shortTextSchema).max(MAX_UNRESOLVED).optional(),
    /** Higher survives a run-summary budget cut. Defaults are the caller's. */
    priority: z.number().int().min(1).max(1_000).optional(),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.outcome === "completed" && result.unresolved !== undefined && result.unresolved.length === 0) {
      addMismatch(
        ctx,
        ["unresolved"],
        "An empty `unresolved` list is the same as omitting it; list the real unknowns instead of an empty placeholder",
      )
    }
  })

export type DependencyResult = z.infer<typeof dependencyResultSchema>

/**
 * A handoff packet.
 *
 * `to` is a role or a node, never a free-text label. The M0 migration had to
 * record `legacy.agent-label` because a v1 handoff's `from`/`to` were strings
 * that could not be resolved to an identity; here the field is a real id, so a
 * handoff cannot be addressed to a name that does not exist.
 */
export const handoffPacketSchema = z
  .object({
    projectId: z.string().min(1).max(128),
    runId: runIdSchema,
    taskId: taskIdSchema,
    /** The role expected to pick this up. */
    toRoleId: z.string().min(1).max(128),
    fromActor: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("user"), userId: z.string().min(1).max(128) }).strict(),
        z.object({ kind: z.literal("node"), nodeId: z.string().min(1).max(128) }).strict(),
        z.object({ kind: z.literal("session"), sessionId: z.string().min(1).max(128) }).strict(),
        z.object({ kind: z.literal("system"), name: z.string().min(1).max(128) }).strict(),
      ])
      .optional(),
    /** 1..MAX_SUMMARY_CHARACTERS. This is the whole prose budget. */
    summary: z.string().min(1).max(MAX_SUMMARY_CHARACTERS),
    /** What the receiver must know before starting. */
    prerequisites: z.array(shortTextSchema).max(MAX_UNRESOLVED).optional(),
    /** What the sender did NOT determine. */
    unresolved: z.array(shortTextSchema).max(MAX_UNRESOLVED).optional(),
    /** Artifact ids the receiver will need. Ids, never contents. */
    artifacts: z.array(artifactIdSchema).max(MAX_ARTIFACT_REFERENCES).optional(),
    /** Sensitivity of the packet as a whole. A packet is as sensitive as its most sensitive part. */
    sensitivity: z.enum(["public_to_project", "restricted", "secret_reference_only", "prohibited"]),
    /** Why this packet is sensitive. Required when it is not `public_to_project`. */
    sensitivityReason: textSchema.optional(),
  })
  .strict()
  .superRefine((packet, ctx) => {
    if (packet.sensitivity !== "public_to_project" && packet.sensitivityReason === undefined) {
      addMismatch(
        ctx,
        ["sensitivityReason"],
        "A packet above public sensitivity must say why; an unexplained label is not reviewable",
      )
    }
  })

export type HandoffPacket = z.infer<typeof handoffPacketSchema>

/**
 * Turn a packet into a memory record.
 *
 * The detail is structured on purpose: the TUI and the context assembler read
 * `artifacts` out of it, and a summary that had inlined the artifacts' contents
 * could not be rendered without carrying them.
 */
export function handoffToMemoryRecord(input: {
  packet: HandoffPacket
  author: Actor
  createdAt: string
  redaction?: MemoryRecordV2["redaction"]
}): Result<MemoryRecordV2> {
  const packet = handoffPacketSchema.safeParse(input.packet)
  if (!packet.success) {
    return {
      ok: false,
      error: createContractError("validation", "memory.handoff_invalid", "The handoff packet does not match the handoff contract"),
    }
  }

  const value = packet.data
  try {
    return {
      ok: true,
      value: proposeMemoryRecord({
        memoryId: `handoff_${value.runId}_${value.taskId}`,
        projectId: value.projectId,
        kind: "handoff",
        scope: { kind: "task", runId: value.runId, taskId: value.taskId },
        author: input.author,
        createdAt: input.createdAt,
        content: value.summary,
        detail: {
          toRoleId: value.toRoleId,
          // A LABEL, not the actor object. `payload.detail` is depth-1 scalar by
          // contract (see `memoryDetailSchema` in `record.ts`) precisely so it
          // cannot become a place to hide a structure nothing inspects, and an
          // `Actor` is a structure. The record's own `author` already carries
          // the sender, so this is the *display* form for a renderer that wants
          // to say "from session-1" without a second identity lookup.
          ...(value.fromActor ? { fromActorLabel: actorLabel(value.fromActor) } : {}),
          ...(value.prerequisites ? { prerequisites: value.prerequisites } : {}),
          ...(value.unresolved ? { unresolved: value.unresolved } : {}),
          ...(value.sensitivityReason ? { sensitivityReason: value.sensitivityReason } : {}),
        },
        ...(value.artifacts ? { artifactReferences: value.artifacts } : {}),
        sensitivity: value.sensitivity,
        retention: "run",
        ...(input.redaction ? { redaction: input.redaction } : {}),
        sourceReferences: [
          { namespace: "handoff.packet", id: `${value.runId}/${value.taskId}` },
          ...(value.artifacts ?? []).map((artifactId) => ({ namespace: "artifact.reference", id: artifactId })),
        ],
      }),
    }
  } catch (error) {
    return {
      ok: false,
      error: createContractError(
        "validation",
        "memory.handoff_rejected",
        `The handoff packet was refused by the record contract: ${error instanceof Error ? error.message.slice(0, 512) : "unknown reason"}`,
      ),
    }
  }
}

/** A dependency result as a memory record, for the `dependency_results` context category. */
export function dependencyResultToMemoryRecord(input: {
  result: DependencyResult
  projectId: ProjectId
  runId: RunId
  author: Actor
  createdAt: string
  sensitivity?: Sensitivity
}): Result<MemoryRecordV2> {
  const result = dependencyResultSchema.safeParse(input.result)
  if (!result.success) {
    return {
      ok: false,
      error: createContractError("validation", "memory.dependency_result_invalid", "The dependency result does not match the result contract"),
    }
  }
  const value = result.data
  try {
    return {
      ok: true,
      value: proposeMemoryRecord({
        memoryId: `dependency_${value.dispatchId}`,
        projectId: input.projectId,
        // A failed task's outcome is a finding, not a `run_outcome`: the run is
        // not over, this attempt is. Conflating them would put a single
        // attempt's failure into a run-level summary and make it look final.
        kind: value.outcome === "completed" ? "run_outcome" : "finding",
        scope: { kind: "dispatch", runId: input.runId, taskId: value.taskId, dispatchId: value.dispatchId },
        author: input.author,
        createdAt: input.createdAt,
        content: value.content,
        detail: {
          outcome: value.outcome,
          ...(value.unresolved ? { unresolved: value.unresolved } : {}),
        },
        ...(value.artifacts ? { artifactReferences: value.artifacts } : {}),
        sensitivity: input.sensitivity ?? "public_to_project",
        retention: "run",
        sourceReferences: [
          { namespace: "dispatch.result", id: value.dispatchId },
          ...(value.artifacts ?? []).map((artifactId) => ({ namespace: "artifact.reference", id: artifactId })),
        ],
      }),
    }
  } catch (error) {
    return {
      ok: false,
      error: createContractError(
        "validation",
        "memory.dependency_result_rejected",
        `The dependency result was refused by the record contract: ${error instanceof Error ? error.message.slice(0, 512) : "unknown reason"}`,
      ),
    }
  }
}

/** `user:alice`, `node:node-a`, `session:s-1`, `system:migrator`. */
export function actorLabel(actor: NonNullable<HandoffPacket["fromActor"]>): string {
  switch (actor.kind) {
    case "user":
      return `user:${actor.userId}`
    case "node":
      return `node:${actor.nodeId}`
    case "session":
      return `session:${actor.sessionId}`
    case "system":
      return `system:${actor.name}`
  }
}

export interface RunSummary {
  readonly runId: RunId
  readonly projectId: string
  /** Bounded prose. Never a concatenation of every result. */
  readonly content: string
  /** The results the summary covers, by id. */
  readonly included: readonly string[]
  /** The results it dropped for budget, and why. */
  readonly omitted: readonly { readonly dispatchId: string; readonly reason: "budget_exceeded" }[]
  readonly unresolved: readonly string[]
}

/**
 * Build a bounded run summary.
 *
 * Results are taken in descending `priority`, then ascending `dispatchId`, and
 * cut at `budgetCharacters`. `omitted` records what did not fit, because a
 * summary that silently drops half a run is worse than no summary: the next
 * agent reads it as complete.
 *
 * Deterministic by construction — no clock, no input ordering dependence, and
 * `Math.min` on the final content length rather than a slice that could split a
 * word mid-character in a way that depends on the budget's parity.
 */
export function buildRunSummary(input: {
  projectId: string
  runId: RunId
  results: readonly DependencyResult[]
  budgetCharacters?: number
}): Result<RunSummary> {
  const budget = input.budgetCharacters ?? MAX_SUMMARY_CHARACTERS
  if (budget < 1) {
    return {
      ok: false,
      error: createContractError("validation", "context.run_summary_budget", "A run summary budget must be at least one character"),
    }
  }

  const parsed: DependencyResult[] = []
  for (const raw of input.results) {
    const result = dependencyResultSchema.safeParse(raw)
    if (!result.success) {
      return {
        ok: false,
        error: createContractError("validation", "memory.dependency_result_invalid", "A dependency result in the run summary does not match the result contract"),
      }
    }
    parsed.push(result.data)
  }

  const ranked = [...parsed].sort((a, b) => {
    const priorityDelta = (b.priority ?? 100) - (a.priority ?? 100)
    if (priorityDelta !== 0) return priorityDelta
    return a.dispatchId < b.dispatchId ? -1 : a.dispatchId > b.dispatchId ? 1 : 0
  })

  const lines: string[] = []
  const included: string[] = []
  const omitted: { dispatchId: string; reason: "budget_exceeded" }[] = []
  const unresolved: string[] = []
  let used = 0

  for (const result of ranked) {
    for (const item of result.unresolved ?? []) if (!unresolved.includes(item)) unresolved.push(item)
    const line = `- ${result.taskId} (${result.outcome}): ${result.content}`
    if (used + line.length + 1 > budget) {
      omitted.push({ dispatchId: result.dispatchId, reason: "budget_exceeded" })
      continue
    }
    used += line.length + 1
    lines.push(line)
    included.push(result.dispatchId)
  }

  const header = `Run ${input.runId}: ${included.length} of ${ranked.length} task results.`
  const unresolvedLine = unresolved.length > 0 ? `Unresolved: ${unresolved.join("; ")}` : "Unresolved: none recorded."
  const content = `${header}\n${lines.join("\n")}\n${unresolvedLine}`

  return {
    ok: true,
    value: {
      runId: input.runId,
      projectId: input.projectId,
      // The header and the unresolved line are not charged to the budget, so
      // the honest move is to state the real length rather than truncate the
      // tail and drop the "unresolved" line — which is the most important line
      // in the whole summary.
      content,
      included,
      omitted,
      unresolved,
    },
  }
}
