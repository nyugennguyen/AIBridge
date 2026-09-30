/**
 * M5.3 — legacy memory migration: v1 -> v2, without content or status loss.
 *
 * # What is migrated
 *
 * Two shapes, both called "legacy memory" and neither of them the same file:
 *
 * - **v1 records** — the output of the M0 dry-run importer
 *   (`src/orchestration/legacy/migration.ts`), i.e. `MemoryRecordV1`. These are
 *   the records a system that already ran `legacy.imported` holds.
 * - **legacy memory data** — the pre-M0 `memory.json` the orphan `FileMemoryStore`
 *   wrote: `{ projectId, decisions[], constraints[], handoffs[] }`, per
 *   `legacyMemoryDataSchema` in `src/orchestration/legacy/schemas.ts`.
 *
 * Both paths converge on the same v2 record, because a migration that handled
 * only the already-imported shape would leave every user who has not yet run the
 * M0 importer with no path to M5 at all — and the plan's prerequisite is
 * compatibility, not "only for people who got there first".
 *
 * # Why no imported record is `accepted`
 *
 * The guardrail is explicit: "Stop if migration cannot distinguish legacy
 * trusted user content from agent-generated content; default uncertain imports
 * to proposed/review-needed." It cannot, and here is the concrete reason:
 *
 * - `legacyDecisionSchema.agent` is a free-text label. It is `"dev-main"` in the
 *   fixture — a node label, not a user id, and nothing in the format says a
 *   human typed it. The M0 importer already had to write
 *   `{ namespace: "legacy.agent-label" }` to say so.
 * - `legacyHandoffSchema.status === "accepted"` means *a receiving agent took
 *   the handoff*. It is an agent-to-agent workflow state. Reading it as "a human
 *   accepted a project fact" is the exact confusion the trust axis exists to
 *   prevent, so `accepted` handoffs migrate as `proposed` with their legacy
 *   status preserved in `payload.detail.legacyStatus`.
 *
 * So: **every** migrated record is `proposed`, and the *content* and the *legacy
 * status* are preserved exactly. A user accepts proposals afterwards through the
 * M5.6 workflow, which is the only way to reach `accepted` at all.
 *
 * # A plan is whole or refused
 *
 * The migration's promise is "no content or status loss", so a plan that
 * silently migrated a subset of the source is not a plan — it is a lie with a
 * `counts.total` attached. `planV1MemoryMigration` therefore **refuses** when
 * any entry cannot be migrated (unreadable, or belonging to another project):
 * the `Result` is `ok: false` and no plan value is produced at all.
 *
 * `diagnostics` remains the reporting channel for everything that does *not*
 * block — warnings such as an empty payload or a severed supersession link —
 * and a plan carrying an error diagnostic is refused again at the write path, so
 * a hand-assembled plan cannot reintroduce what the planner refuses to build.
 *
 * # Rollback safety
 *
 * A migration is a *plan*: a pure value produced by `planLegacyMemoryMigration`
 * and written nowhere. `applyLegacyMemoryMigration` is the only function that
 * writes, it takes an explicit `apply: boolean` gate, and it appends through the
 * repository so the new records are ordinary appends with ordinary provenance.
 *
 * Rollback is therefore "do not call apply" before the call, and "the source is
 * still on disk and unmodified" after it — the migrator never writes to the
 * legacy file, never truncates it, and never deletes it. There is no
 * `rollback()` because there is nothing to undo: the v1 records were never
 * removed, only joined by v2 records that reference them by
 * `legacy.memory.*` namespace.
 *
 * # Idempotence
 *
 * Ids are derived from the source, not from a counter, so a second migration run
 * produces byte-identical records and the repository's duplicate-id refusal
 * turns "ran it twice" into an explicit, non-destructive error rather than a
 * duplicated corpus of proposals.
 */

import { z } from "zod"
import { legacyMemoryDataSchema } from "../orchestration/legacy/schemas.js"
import { digestJson } from "../orchestration/digest.js"
import { createContractError, type ContractError, type Result } from "../orchestration/errors.js"
import { memoryIdSchema, type MemoryId } from "../orchestration/identifiers.js"
import { deriveMemoryId, memoryRecordSourceKey } from "./in-memory-repository.js"
import {
  buildMemoryRecord,
  memoryRecordSchemaV1,
  memoryPayloadSchema,
  migrateV1Sensitivity,
  type MemoryRecordV1,
  type MemoryRecordV2,
  type MemoryScope,
} from "./record.js"
import { DEFAULT_RETENTION_BY_KIND, type MemoryKind, type TrustState } from "./ontology.js"
import type { AppendMemoryInput, MemoryRepository } from "./ports.js"
import { addMismatch, shortTextSchema } from "./primitives.js"

export const legacyMigrationDiagnosticSchema = z.discriminatedUnion("severity", [
  z.object({ severity: z.literal("error"), code: shortTextSchema, message: z.string().min(1).max(4_096) }).strict(),
  z.object({ severity: z.literal("warning"), code: shortTextSchema, message: z.string().min(1).max(4_096) }).strict(),
  z.object({ severity: z.literal("info"), code: shortTextSchema, message: z.string().min(1).max(4_096) }).strict(),
])

export type LegacyMigrationDiagnostic = z.infer<typeof legacyMigrationDiagnosticSchema>

export interface LegacyMigrationCounts {
  readonly decisions: number
  readonly constraints: number
  readonly handoffs: number
  readonly v1Records: number
  readonly total: number
  /** Records whose legacy trust state was downgraded to `proposed`. */
  readonly trustDowngrades: number
}

export const legacyMemoryMigrationPlanSchema = z
  .object({
    planVersion: z.literal(1),
    projectId: z.string().min(1).max(128),
    /** Digest of the inputs, so a second run can prove it saw the same source. */
    sourceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    /** The records as they will be stored, with the ids the repository derives. */
    records: z.array(z.unknown()).max(100_000),
    /**
     * The append inputs, in the same order as `records`.
     *
     * Carried rather than recomputed. `applyLegacyMemoryMigration` writes these
     * verbatim, so there is exactly one code path that knows how a legacy line
     * becomes a stored record; recomputing at write time would be a second one.
     */
    inputs: z.array(z.unknown()).max(100_000),
    counts: z
      .object({
        decisions: z.number().int().nonnegative(),
        constraints: z.number().int().nonnegative(),
        handoffs: z.number().int().nonnegative(),
        v1Records: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        trustDowngrades: z.number().int().nonnegative(),
      })
      .strict(),
    diagnostics: z.array(legacyMigrationDiagnosticSchema).max(1_000),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (plan.counts.total !== plan.records.length) {
      addMismatch(ctx, ["counts", "total"], "Total count must match the number of planned records")
    }
    if (plan.inputs.length !== plan.records.length) {
      addMismatch(
        ctx,
        ["inputs"],
        "There must be exactly one append input per planned record; a plan whose write and report differ in length is not a plan",
      )
    }
  })

export type LegacyMemoryMigrationPlan = z.infer<typeof legacyMemoryMigrationPlanSchema>

export interface LegacyMigrationOptions {
  /** The canonical project the legacy records belong to. */
  readonly projectId: string
  /** When the migration ran. Supplied; never read from a clock inside. */
  readonly migratedAt: string
  /**
   * Identity recorded as the author of every migrated record.
   *
   * `system` by default, matching the M0 importer. A caller that wants the
   * migration attributed to a specific account passes it here.
   */
  readonly migratedBy?: MemoryRecordV2["author"]
  /** The node the legacy data came from, recorded as provenance. */
  readonly sourceNodeId?: string
}

const DEFAULT_MIGRATED_BY: MemoryRecordV2["author"] = { kind: "system", name: "legacy-memory-migration" }

/**
 * Build the stored record from the append input and the id the repository will
 * derive for it.
 *
 * This is the one place the plan and the write are joined. Deriving the id here
 * from the *same* function the repository uses is what makes the plan's records
 * the records that will exist — a plan that reported a guessed id would be
 * reporting ids no reader would ever see, and the gate's "migration counts"
 * would be counts of a corpus that was never written.
 */
function recordFromAppend(input: AppendMemoryInput, memoryId: string): MemoryRecordV2 {
  return buildMemoryRecord({
    memoryId,
    projectId: input.projectId,
    kind: input.kind,
    scope: input.scope,
    author: input.author,
    createdAt: input.createdAt,
    payload: memoryPayloadSchema.parse({
      content: input.content,
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.artifactReferences ? { artifactReferences: [...input.artifactReferences] } : {}),
      ...(input.secretReferences ? { secretReferences: [...input.secretReferences] } : {}),
    }),
    trust: input.trust ?? "proposed",
    trustDecision: input.trustDecision,
    sensitivity: input.sensitivity ?? "public_to_project",
    retention: input.retention,
    expiresAt: input.expiresAt,
    visibleToNodeIds: input.visibleToNodeIds,
    visibleToRoleIds: input.visibleToRoleIds,
    supersedesMemoryId: input.supersedesMemoryId,
    redaction: input.redaction,
    sourceReferences: input.sourceReferences,
  })
}

/**
 * The trust state a legacy record is imported with.
 *
 * This function is *the* trust policy for legacy imports. It is exported and
 * named rather than inlined because a policy that only exists inside a `prepare`
 * call cannot be asserted directly, and "there is exactly one policy" is a
 * property worth a test.
 *
 * The M5.9 review found SF-8 here. The first version mapped *everything* to
 * `proposed`, reasoning that the legacy format cannot prove an acceptance. That
 * reasoning is right for `accepted` and **wrong for `rejected`**: a `proposed`
 * record is one awaiting a decision, so mapping a rejection to it re-opens a
 * closed question and puts it back in the acceptance queue. A migration must
 * never be a trust *upgrade*, whatever the direction.
 *
 * So:
 *
 * - `proposed` -> `proposed`. A proposal awaits a decision; that is unchanged.
 * - `rejected` -> `rejected`. A human closed this; only a correction re-opens it,
 *   and a correction is a new record, never a migration.
 * - `accepted` -> `proposed`, always. The v1 format never recorded *who*
 *   accepted, so the acceptance is unauthenticated and is treated as a proposal.
 *   This is the plan's stop condition resolving to its prescribed answer.
 *
 * # SF-15: this is NOT `migrationTrustDecision`
 *
 * `record.ts` exports `migrationTrustDecision`, whose docblock claims "a v1
 * `accepted` record authored by a user is migrated as `accepted`". It is called
 * from nowhere, and it is *wrong* as a statement about this migration in a way
 * that is worth stating rather than hiding:
 *
 * 1. Its rule is keyed on the **author kind**. The stop condition is about the
 *    *format* — a v1 record never recorded who accepted it — so a v1 acceptance
 *    by a `user` author is exactly as unauthenticated as one by a node, and the
 *    audit's R-1 ("a v1 `accepted` record is never migrated as `accepted`") is
 *    unconditional.
 * 2. Its output cannot be written anyway. It attributes the acceptance to the v1
 *    record's own author, but a migrated record's author is the migration
 *    (`system:legacy-memory-migration`). `memoryRecordSchemaV2` accepts the
 *    decision — a user decided — and then `InMemoryMemoryRepository.buildRecord`
 *    refuses the append because `trustDecision.decidedBy` is not the record's
 *    author. Honouring it would turn "dropped to `proposed`" into "the whole
 *    migration is refused at the write path", which is a worse answer than the
 *    downgrade, not a better one.
 *
 * So the function is not wired in here, and the fix for the contradiction is
 * deletion in `record.ts` (not this file's to make). Until then this docblock is
 * the correction, and `tests/integration/memory-migration.test.ts` pins the
 * statement that is actually true — a v1 acceptance authored by a user migrates
 * as `proposed` with no trust decision — so the two cannot drift apart silently
 * again.
 */
export function migratedTrustStateFor(
  legacyTrustState: "proposed" | "accepted" | "rejected" | "none",
): TrustState {
  if (legacyTrustState === "rejected") return "rejected"
  return "proposed"
}


function scopeForLegacy(plan: { projectId: string }): MemoryScope {
  // Legacy memory had no run/task/dispatch notion at all — `memory.json` is a
  // single project's flat file. Every imported record is therefore project-scoped,
  // which is the widest scope and therefore visible to every narrower reader.
  return { kind: "project" }
}

interface PreparedRecord {
  /** Exactly what will be stored, with the id the repository will derive. */
  readonly record: MemoryRecordV2
  /** The append input, kept so the plan and the write cannot drift apart. */
  readonly input: AppendMemoryInput
  readonly sourceKey: string
  readonly legacyTrustState: "proposed" | "accepted" | "rejected" | "none"
}

function prepare(input: {
  /** Used only for the source key; the repository derives the stored id. */
  sourceKey: string
  projectId: string
  kind: MemoryKind
  content: string
  createdAt: string
  author: MemoryRecordV2["author"]
  sourceReferences: readonly { namespace: string; id: string }[]
  detail?: Record<string, unknown>
  legacyTrustState: PreparedRecord["legacyTrustState"]
  retention?: MemoryRecordV2["retention"]
  /**
   * The v1 record's own sensitivity, if the source had one.
   *
   * Carried through rather than reset, and only ever *upward* in sensitivity.
   * A v1 record marked `restricted` must not arrive in M5 as
   * `public_to_project` just because the migration is what created it — that
   * would silently widen the audience of the operator's most careful label, and
   * the label is the only access control a v1 file has.
   */
  sensitivity?: MemoryRecordV2["sensitivity"]
  /**
   * The record this one corrects, when the source said so.
   *
   * A v1 record's `supersedesMemoryId` names a record in the *legacy* id space,
   * which the migrated corpus does not reuse (ids are derived from content, so a
   * migrated record has an M5 id). Carrying the legacy id across verbatim would
   * therefore produce a dangling link that looks valid and resolves to nothing.
   *
   * So the link is resolved against the corpus being migrated: the migrated
   * record names the *M5 id* of the migrated record it corrects, and the legacy
   * ids of both ends are preserved in `detail`. Where the target is not in the
   * corpus, the link is dropped and a diagnostic says so — a severed link that is
   * *reported* is recoverable; one that is silently dropped is not.
   */
  supersedesSourceKey?: string
  /** The legacy id of the record this one corrects, recorded in `detail`. */
  legacySupersedesMemoryId?: string
}): PreparedRecord {
  const appendInput: AppendMemoryInput = {
    projectId: input.projectId,
    kind: input.kind,
    scope: scopeForLegacy({ projectId: input.projectId }),
    author: input.author,
    createdAt: input.createdAt,
    content: input.content,
    ...(input.detail ? { detail: input.detail } : {}),
    // The trust state is *mapped*, not flattened. See `migratedTrustStateFor`.
    trust: migratedTrustStateFor(input.legacyTrustState),
    sensitivity: input.sensitivity ?? "public_to_project",
    retention: input.retention ?? DEFAULT_RETENTION_BY_KIND[input.kind],
    redaction: { status: "none" },
    ...(input.supersedesSourceKey ? { supersedesMemoryId: input.supersedesSourceKey } : {}),
    sourceReferences: input.sourceReferences,
  }
  return {
    record: recordFromAppend(appendInput, deriveMemoryId(memoryRecordSourceKey(appendInput))),
    input: appendInput,
    sourceKey: input.sourceKey,
    legacyTrustState: input.legacyTrustState,
  }
}

/** Migrate the pre-M0 `memory.json` shape. */
export function planLegacyMemoryDataMigration(
  source: unknown,
  options: LegacyMigrationOptions,
): Result<LegacyMemoryMigrationPlan> {
  const parsed = legacyMemoryDataSchema.safeParse(source)
  if (!parsed.success) {
    return {
      ok: false,
      error: createContractError("validation", "memory.legacy_source_invalid", "Legacy memory data does not match the M0 legacy schema"),
    }
  }
  const data = parsed.data
  const author = options.migratedBy ?? DEFAULT_MIGRATED_BY
  const diagnostics: LegacyMigrationDiagnostic[] = []
  const prepared: PreparedRecord[] = []
  const prefix = `${digestJson(data)}\0`
  const nodeReference = options.sourceNodeId
    ? [{ namespace: "legacy.node-label", id: options.sourceNodeId } as const]
    : []

  for (const decision of data.decisions) {
    prepared.push(
      prepare({
        sourceKey: `${prefix}decision:${decision.id}`,
        projectId: options.projectId,
        kind: "decision",
        content: decision.content,
        createdAt: decision.timestamp,
        author,
        sourceReferences: [
          { namespace: "legacy.memory.decision", id: decision.id },
          { namespace: "legacy.agent-label", id: decision.agent },
          ...nodeReference,
        ],
        detail: { legacyAgentLabel: decision.agent, legacyStatus: "recorded" },
        legacyTrustState: "none",
      }),
    )
  }

  data.constraints.forEach((constraint, index) => {
    prepared.push(
      prepare({
        sourceKey: `${prefix}constraint:${index}`,
        projectId: options.projectId,
        kind: "constraint",
        content: constraint,
        createdAt: options.migratedAt,
        author,
        sourceReferences: [
          // Keyed by index, exactly as the M0 importer does, because a legacy
          // constraint has no id of its own. Recording the index is the only way
          // a re-import can point at the same line.
          { namespace: "legacy.memory.constraint", id: String(index) },
          ...nodeReference,
        ],
        detail: { legacyIndex: index, legacyStatus: "recorded" },
        legacyTrustState: "none",
      }),
    )
  })

  for (const handoff of data.handoffs) {
    prepared.push(
      prepare({
        sourceKey: `${prefix}handoff:${handoff.id}`,
        projectId: options.projectId,
        kind: "handoff",
        content: handoff.context,
        createdAt: handoff.createdAt,
        author,
        sourceReferences: [
          { namespace: "legacy.memory.handoff", id: handoff.id },
          { namespace: "legacy.agent-label", id: handoff.from },
          { namespace: "legacy.agent-label", id: handoff.to },
          ...nodeReference,
        ],
        // The legacy status is preserved verbatim. It is NOT read as trust: a
        // handoff accepted by an agent is not a project fact accepted by a user.
        detail: {
          legacyFrom: handoff.from,
          legacyTo: handoff.to,
          legacyStatus: handoff.status,
        },
        legacyTrustState: "none",
        retention: "run",
      }),
    )
  }

  for (const item of prepared) {
    if (item.record.payload.content.trim().length === 0) {
      diagnostics.push({
        severity: "warning",
        code: "memory.legacy_empty_content",
        message: `Imported ${item.record.kind} ${item.record.memoryId} has no content and will not be injectable`,
      })
    }
  }

  return finishPlan({
    projectId: options.projectId,
    sourceDigest: digestJson(data),
    prepared,
    counts: {
      decisions: data.decisions.length,
      constraints: data.constraints.length,
      handoffs: data.handoffs.length,
      v1Records: 0,
    },
    diagnostics,
    entriesTotal: prepared.length,
  })
}

/** Migrate records already imported at v1 by the M0 dry-run importer. */
export function planV1MemoryMigration(
  records: readonly unknown[],
  options: LegacyMigrationOptions,
): Result<LegacyMemoryMigrationPlan> {
  const author = options.migratedBy ?? DEFAULT_MIGRATED_BY
  const diagnostics: LegacyMigrationDiagnostic[] = []
  const prepared: PreparedRecord[] = []
  const prefix = `${digestJson(records.map((record) => (record as { memoryId?: unknown }).memoryId ?? null))}\0`
  let downgrades = 0

  // Two passes, because a supersession link names a record that may appear
  // *later* in the array. Resolving it in a single pass would drop every link
  // whose target had not been seen yet — order-dependent, silent, and wrong.
  // Pass 1 reads and validates; pass 2 prepares, with the whole corpus's derived
  // ids available for link resolution.
  const readable: MemoryRecordV1[] = []
  records.forEach((raw, index) => {
    const parsed = memoryRecordSchemaV1.safeParse(raw)
    if (!parsed.success) {
      diagnostics.push({
        severity: "error",
        code: "memory.legacy_v1_unreadable",
        message: `Entry ${index} is not a readable v1 memory record and was not migrated`,
      })
      return
    }
    const record: MemoryRecordV1 = parsed.data
    if (record.projectId !== options.projectId) {
      diagnostics.push({
        severity: "error",
        code: "memory.legacy_project_mismatch",
        // The message names the project ids and never the content: a mismatch
        // is reported to an operator, and an operator log is a log.
        message: `Entry ${index} belongs to project '${record.projectId}' but the migration targets '${options.projectId}'`,
      })
      return
    }
    if (record.trustState === "accepted" || record.trustState === "rejected") downgrades += 1
    readable.push(record)
  })

  // The M5 id each legacy record will be given, computed the same way the
  // repository will compute it, so a supersession link can name a real target.
  const derivedIdFor = (legacyId: string): string => deriveMemoryId(`${prefix}v1:${legacyId}`)

  for (const record of readable) {
    // A v1 `supersedesMemoryId` names a record in the *legacy* id space, and the
    // migrated corpus does not reuse legacy ids. Resolving it against the corpus
    // is the only way to produce a link that resolves; a link to the legacy id
    // would look valid and resolve to nothing.
    let supersedesMemoryId: string | undefined
    if (record.supersedesMemoryId !== undefined) {
      supersedesMemoryId = derivedIdFor(record.supersedesMemoryId)
      if (!readable.some((candidate) => candidate.memoryId === record.supersedesMemoryId)) {
        // Reported, not silently dropped. A severed link an operator can see is
        // recoverable; one that vanishes is not.
        diagnostics.push({
          severity: "warning",
          code: "memory.legacy_supersession_target_absent",
          message: `Entry for legacy record '${record.memoryId}' supersedes '${record.supersedesMemoryId}', which is not in the migrated corpus; the link is recorded in provenance but not resolved`,
        })
        supersedesMemoryId = undefined
      }
    }

    prepared.push(
      prepare({
        // The v1 id is preserved as the source reference AND the source of the
        // derived id, so re-running the migration cannot mint a second record
        // for the same v1 record.
        sourceKey: `${prefix}v1:${record.memoryId}`,
        projectId: options.projectId,
        kind: record.kind,
        content: record.content,
        createdAt: record.createdAt,
        author,
        sourceReferences: [
          { namespace: "memory.v1", id: record.memoryId },
          ...record.sourceReferences,
          // The legacy supersession link, preserved by value. The M5 link is on
          // the record; this is the legacy id it was resolved from, so an
          // operator reading the migrated corpus can still find the original.
          ...(record.supersedesMemoryId === undefined
            ? []
            : [{ namespace: "memory.v1.supersedes", id: record.supersedesMemoryId } as const]),
        ],
        detail: {
          legacyMemoryId: record.memoryId,
          legacyTrustState: record.trustState,
          legacySensitivity: record.sensitivity,
          legacyStatus: record.trustState,
          ...(record.supersedesMemoryId === undefined
            ? {}
            : { legacySupersedesMemoryId: record.supersedesMemoryId }),
        },
        legacyTrustState: record.trustState,
        retention: record.retention,
        sensitivity: migrateV1Sensitivity(record.sensitivity),
        ...(supersedesMemoryId === undefined
          ? {}
          : { supersedesSourceKey: supersedesMemoryId, legacySupersedesMemoryId: record.supersedesMemoryId }),
      }),
    )
  }

  return finishPlan({
    projectId: options.projectId,
    sourceDigest: digestJson(records),
    prepared,
    counts: { decisions: 0, constraints: 0, handoffs: 0, v1Records: prepared.length },
    diagnostics,
    trustDowngrades: downgrades,
    entriesTotal: records.length,
  })
}

/** Diagnostics that mean "the corpus you would get is not the corpus you passed in". */
function blockingDiagnostics(diagnostics: readonly LegacyMigrationDiagnostic[]): LegacyMigrationDiagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.severity === "error")
}

/**
 * The refusal for a plan that would be incomplete.
 *
 * SF-16: the plan used to be returned as `ok: true` with these diagnostics
 * buried inside it. A caller that checked only `ok` — which is the entire point
 * of returning a `Result` — imported the readable subset and never learned that
 * N records had been dropped, because a successful migration has no reason for a
 * caller to go looking in `value.diagnostics`.
 *
 * The weaker alternative was a `canCommit: false` flag on the plan. That keeps
 * the partial corpus *available*, and availability is the problem: a flag is one
 * more field a caller must remember to check, so the failure mode it is meant to
 * prevent — a partial import that looks like a complete one — stays reachable by
 * forgetting a boolean. Failing the `Result` makes the incomplete plan
 * un-*obtainable* instead of merely discouraged, and the caller is forced to look
 * at the refusal, which is where the reason is.
 *
 * What the caller keeps: the diagnostics themselves, inlined into the message.
 * `ContractError` is a frozen M0 record with no place to hang arbitrary data, so
 * the reasons travel as text rather than as a field — capped, and never
 * containing any migrated content, only the codes and messages an operator needs
 * to find the offending entry in the source.
 */
function incompleteCorpusError(input: {
  readonly diagnostics: readonly LegacyMigrationDiagnostic[]
  readonly entriesRead: number
  readonly entriesTotal: number
}): ContractError {
  const MAX_LISTED = 10
  const blockers = blockingDiagnostics(input.diagnostics)
  const listed = blockers.slice(0, MAX_LISTED).map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
  const remainder = blockers.length - listed.length
  const detail = listed.length === 0 ? "no reason recorded" : listed.join("; ")
  return createContractError(
    "validation",
    "memory.migration_incomplete",
    // Bounded twice, because a diagnostic message may itself be up to 4 KiB and
    // `ContractError` refuses anything longer: listing ten of them would throw
    // out of the refusal path, and a validation routine that throws is not a
    // validation routine.
    `Refusing to plan a partial migration: ${blockers.length} of ${input.entriesTotal} entries were not migrated and ${input.entriesRead} would have been (${detail}${remainder > 0 ? `; and ${remainder} more` : ""}). A plan is written only when it is the whole corpus, because a plan that reports success while dropping entries loses records the operator can no longer see.`.slice(
      0,
      4_000,
    ),
  )
}

/**
 * The one place a migration becomes an `ok: true` plan.
 *
 * Both planners finish here, so the completeness rule cannot be applied to one
 * shape of source and forgotten for the other.
 */
function finishPlan(input: {
  projectId: string
  sourceDigest: string
  prepared: readonly PreparedRecord[]
  counts: { decisions: number; constraints: number; handoffs: number; v1Records: number }
  diagnostics: readonly LegacyMigrationDiagnostic[]
  trustDowngrades?: number
  entriesTotal: number
}): Result<LegacyMemoryMigrationPlan> {
  if (blockingDiagnostics(input.diagnostics).length > 0) {
    return {
      ok: false,
      error: incompleteCorpusError({
        diagnostics: input.diagnostics,
        entriesRead: input.prepared.length,
        entriesTotal: input.entriesTotal,
      }),
    }
  }
  return { ok: true, value: buildPlan(input) }
}

function buildPlan(input: {
  projectId: string
  sourceDigest: string
  prepared: readonly PreparedRecord[]
  counts: { decisions: number; constraints: number; handoffs: number; v1Records: number }
  diagnostics: readonly LegacyMigrationDiagnostic[]
  trustDowngrades?: number
}): LegacyMemoryMigrationPlan {
  return legacyMemoryMigrationPlanSchema.parse({
    planVersion: 1,
    projectId: input.projectId,
    sourceDigest: input.sourceDigest,
    records: input.prepared.map((item) => item.record),
    inputs: input.prepared.map((item) => item.input),
    counts: {
      ...input.counts,
      total: input.prepared.length,
      trustDowngrades: input.trustDowngrades ?? 0,
    },
    diagnostics: input.diagnostics,
  })
}

export interface ApplyMigrationResult {
  readonly appended: number
  readonly plan: LegacyMemoryMigrationPlan
}

/**
 * Apply a plan. The `apply` gate is explicit and there is no default.
 *
 * A migration that writes on construction is a migration nobody can dry-run, and
 * a dry-run is the only way to answer "what would this import?" without a
 * transaction to roll back.
 *
 * The write uses the plan's own `AppendMemoryInput`s, not the plan's records
 * re-read and re-converted. Re-converting here would be a second place that
 * knows how a record maps to an append, and the two would drift — and the drift
 * would show up as "the plan said 7 records, the store has 6" rather than as an
 * error. The plan carries both because the gate report needs the records (with
 * their ids) and the write needs the inputs, and one object is cheaper than
 * reconciling two.
 */
export async function applyLegacyMemoryMigration(
  repository: MemoryRepository,
  plan: LegacyMemoryMigrationPlan,
  options: { readonly apply: boolean; readonly migratedAt: string; readonly inputs: readonly AppendMemoryInput[] },
): Promise<Result<ApplyMigrationResult>> {
  // The plan is planner-produced and therefore carries no error diagnostics —
  // `finishPlan` refuses to build one that does. A caller can still hand `apply`
  // a plan it assembled itself, and this is where a partial corpus would stop
  // being a value and start being a stored fact, so the same completeness rule
  // is enforced on the way in. Deliberately *before* the `apply` gate: a dry run
  // that reports success for a plan the real run would refuse is a dry run that
  // cannot be trusted.
  const blockers = blockingDiagnostics(plan.diagnostics)
  if (blockers.length > 0) {
    return {
      ok: false,
      error: createContractError(
        "validation",
        "memory.migration_plan_incomplete",
        `This plan reports ${blockers.length} error(s) and describes an incomplete corpus (${blockers
          .slice(0, 10)
          .map((diagnostic) => diagnostic.code)
          .join("; ")}); nothing was written`.slice(0, 4_000),
      ),
    }
  }

  if (!options.apply) {
    return { ok: true, value: { appended: 0, plan } }
  }

  // The inputs must BE the plan's inputs. Found by the M5.9 review as SF-3: the
  // signature let a caller hand `apply` a set of inputs unrelated to the plan it
  // was also given, and the function reported `ok: true, appended: N` — so an
  // entire plan could be redirected into another project, or the plan could
  // report one corpus while a different one was written.
  //
  // Carrying the inputs on the plan at all is what makes this checkable; a
  // design where `apply` recomputed them would have one fewer way to get it
  // wrong, and a design where they arrived only as an argument had this one.
  if (digestJson(options.inputs) !== digestJson(plan.inputs)) {
    return {
      ok: false,
      error: createContractError(
        "validation",
        "memory.migration_inputs_mismatch",
        "The append inputs do not match the plan they are being applied to; a migration writes its own plan and nothing else",
      ),
    }
  }

  // And every input must be for the plan's project. Belt and braces on the same
  // property, because the digest check above is a structural equality and this
  // is the invariant being protected: a plan is about ONE project, and
  // `appendAll` batches across whatever it is handed.
  const foreign = options.inputs.find((input) => input.projectId !== plan.projectId)
  if (foreign !== undefined) {
    return {
      ok: false,
      error: createContractError(
        "policy_denied",
        "memory.migration_project_mismatch",
        `A migration plan for project '${plan.projectId}' was given an input for project '${foreign.projectId}'; nothing was written`,
      ),
    }
  }

  const appended = await repository.appendAll(options.inputs)
  if (!appended.ok) return appended

  // A plan that reports more records than it wrote is a broken plan, and the
  // check is here rather than in a test because a caller that skipped the test
  // still gets the answer.
  if (appended.value.length !== plan.counts.total) {
    return {
      ok: false,
      error: createContractError(
        "internal_failure",
        "memory.migration_count_mismatch",
        `The plan reports ${plan.counts.total} records but ${appended.value.length} were appended; the plan and the write have diverged`,
      ),
    }
  }

  return { ok: true, value: { appended: appended.value.length, plan } }
}

/** Counts for the gate report. Pure; safe to call on a plan that was never applied. */
export function migrationCounts(plan: LegacyMemoryMigrationPlan): LegacyMigrationCounts {
  return plan.counts
}
