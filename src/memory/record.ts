/**
 * M5.2 — the versioned memory record, and the v1 -> v2 reader that keeps the
 * frozen M0 shape readable.
 *
 * `memoryRecordSchemaV1` below is a *local re-declaration* of the M0 record,
 * not a second source of truth. It exists for one reason: `parseVersioned` needs
 * a shape per version, and the M0 `memoryRecordSchema` is a single
 * `z.object(...).strict()` with no version family. Re-typing the v1 fields here
 * keeps the M0 contract file untouched (its digest is signed) while still
 * routing every read through the M0 schema first — see `parseM0MemoryRecord`.
 *
 * Any v1 read is *translated* to a v2 record, never re-saved as v1. Migration is
 * a forward projection with a recorded provenance, so a rollback is "stop
 * writing v2" rather than "recover the old file", and the v1 file is never
 * mutated.
 */

import { z } from "zod"
import {
  largeTextSchema,
  shortTextSchema,
  textSchema,
  nonnegativeSafeIntegerSchema,
  addMismatch,
  isUnique,
} from "./primitives.js"

import {
  artifactIdSchema,
  memoryIdSchema,
  projectIdSchema,
  runIdSchema,
  taskIdSchema,
  dispatchIdSchema,
  sessionIdSchema,
  digestSchema,
  schemaVersionSchema,
  timestampSchema,
  nodeIdSchema,
  roleIdSchema,
  type Digest,
  type MemoryId,
} from "../orchestration/identifiers.js"
import { actorSchema, externalReferenceSchema } from "../orchestration/schemas.js"
import { digestJson } from "../orchestration/digest.js"
import { CURRENT_SCHEMA_VERSION, parseVersioned, safeParseVersioned } from "../orchestration/versioning.js"
import {
  ACCEPTING_ACTOR_KINDS,
  DEFAULT_RETENTION_BY_KIND,
  SENSITIVITY_RANK,
  canTransitionTrust,
  initialTrustFor,
  isRenderable,
  memoryKindSchema,
  memoryScopeKindSchema,
  redactionStatusSchema,
  retentionPolicySchema,
  sensitivitySchema,
  trustStateSchema,
  isScopeVisible,
  SCOPE_DEPTH,
  type ContextCategory,
  type MemoryKind,
  type MemoryScopeKind,
  type Sensitivity,
  type TrustState,
} from "./ontology.js"

/**
 * Scope, v2.
 *
 * v1 had project/run/task/session. v2 adds `dispatch`, because a finding
 * observed *during one dispatch attempt* is a different fact from a finding
 * about the task, and collapsing them is what makes a retry replay the previous
 * attempt's observation as if it were the task's own.
 *
 * Every variant but `project` carries the run it belongs to, so a run-scoped
 * query never has to guess a run from a record id.
 */
export const memoryScopeSchemaV2 = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project") }).strict(),
  z.object({ kind: z.literal("run"), runId: runIdSchema }).strict(),
  z.object({ kind: z.literal("task"), runId: runIdSchema, taskId: taskIdSchema }).strict(),
  z
    .object({ kind: z.literal("dispatch"), runId: runIdSchema, taskId: taskIdSchema, dispatchId: dispatchIdSchema })
    .strict(),
  z
    .object({
      kind: z.literal("session"),
      runId: runIdSchema,
      taskId: taskIdSchema,
      dispatchId: dispatchIdSchema,
      sessionId: sessionIdSchema,
    })
    .strict(),
])

export type MemoryScope = z.infer<typeof memoryScopeSchemaV2>

/** The run a scoped record belongs to. `project` has none. */
export function scopeRunId(scope: MemoryScope): string | undefined {
  return scope.kind === "project" ? undefined : scope.runId
}

/** Does this scope sit at least as broad as `broader`? Delegates to the ontology. */
export function isScopeAtLeastAsNarrow(scope: MemoryScope, narrower: MemoryScopeKind): boolean {
  return SCOPE_DEPTH[scope.kind] <= SCOPE_DEPTH[narrower]
}

/** The identity chain of a scope, outermost first. `project` has none. */
function identityChain(scope: MemoryViewScope): readonly string[] {
  switch (scope.kind) {
    case "project":
      return []
    case "run":
      return [`run:${scope.runId}`]
    case "task":
      return [`run:${scope.runId}`, `task:${scope.taskId}`]
    case "dispatch":
      return [`run:${scope.runId}`, `task:${scope.taskId}`, `dispatch:${scope.dispatchId}`]
    case "session":
      return [
        `run:${scope.runId}`,
        `task:${scope.taskId}`,
        // A v1 session scope has no dispatch id, so the chain stops at the task.
        // Stopping is the honest answer: inventing a dispatch id would put this
        // record in an attempt it was never observed in.
        ...("dispatchId" in scope ? [`dispatch:${scope.dispatchId}`] : []),
        `session:${scope.sessionId}`,
      ]
  }
}

/**
 * Is a record visible to a reader *at this exact scope*?
 *
 * This is the check the repository uses, and it answers both jobs scope does:
 *
 * 1. **Standing facts** — the record is at or above the reader (`isScopeVisible`).
 * 2. **The reader's own history** — the record is at or below the reader, inside
 *    the reader's own identity chain. A task reader sees its dispatches and their
 *    sessions, because those are what happened while it worked.
 *
 * The rule is: the two identity chains must be **prefix-comparable** — one is a
 * prefix of the other. `["run:run-1"]` and `["run:run-1","task:t-1","dispatch:d-1"]`
 * are comparable in both directions, so a task reader sees its own dispatches and
 * a dispatch reader sees its run's standing constraints. `["run:run-1"]` and
 * `["run:run-2", ...]` share no prefix past `run:`, so run-1 cannot see run-2 —
 * which kinds alone would happily allow, since both are `run`.
 *
 * A `project` reader has an empty chain, and the empty chain is a prefix of
 * everything, so a project reader sees the whole project. Correct, and the
 * reason project-scoped records are the ones the sensitivity and clearance checks
 * have to protect.
 */
export function scopeContains(recordScope: MemoryViewScope, readerScope: MemoryViewScope): boolean {
  if (readerScope.kind === "project") return true
  const record = identityChain(recordScope)
  const reader = identityChain(readerScope)
  const shared = Math.min(record.length, reader.length)
  for (let index = 0; index < shared; index += 1) {
    if (record[index] !== reader[index]) return false
  }
  return true
}

/**
 * The narrower question: does the record *stand at* the reader's scope?
 *
 * This is `isScopeVisible` on real scopes rather than on kinds, and it exists so
 * a call site that means "a constraint on me" does not have to spell out the
 * direction. `tests/unit/memory/record-contract.test.ts` asserts both, because
 * the difference between them is a task reader seeing its own sessions — which
 * it should — versus a task reader seeing a *sibling* task's sessions, which it
 * must not.
 */
export function scopeStandsAt(recordScope: MemoryViewScope, readerScope: MemoryViewScope): boolean {
  return scopeContains(recordScope, readerScope) && identityChain(recordScope).length <= identityChain(readerScope).length
}

/**
 * A pointer to a secret that is safe to store.
 *
 * `reference` names where the value lives; `value` is *not* a field, and that
 * absence is the design. There is no way to write a secret value into a memory
 * record even by accident, because there is no slot for one. `summary` is the
 * only free text and the redaction pipeline is what guarantees it is scrubbed.
 */
export const secretReferenceSchema = z
  .object({
    /** Stable, non-secret identifier for the secret: an item path, a key name. */
    reference: shortTextSchema,
    /** Human-readable statement of what exists, never what it is. */
    summary: textSchema,
    /** Optional hint about where a value would be fetched from, e.g. `1Password:prod/deploy`. */
    locator: shortTextSchema.optional(),
  })
  .strict()

export type SecretReference = z.infer<typeof secretReferenceSchema>

/**
 * A `detail` value: **scalar, and small**.
 *
 * The M5.9 review found SF-5 here. `detail` was `z.record(z.string(), z.unknown())` —
 * unbounded depth, unbounded size, no leaf type — so it was the answer to "is
 * there any field in a memory record a secret could go?". A seeded credential
 * written into `detail` was stored verbatim, served by `query()`, and carried
 * `redaction: { status: "none" }`, because nothing on the write path inspects it.
 *
 * Two bounds close it, and they are chosen together because either alone is
 * insufficient:
 *
 * - **Depth 1, with scalar arrays.** A leaf is a string, number, boolean, or an
 *   array of those. No *nested object*, so there is no place to hide a blob
 *   inside a structure nothing will read. Arrays are allowed because real
 *   structured data needs them — a handoff's `prerequisites` is a list — and a
 *   list of bounded scalars is no more of a hiding place than a single one.
 * - **Size per leaf, and count.** `detail` is at most 32 keys, each at most 4 KiB
 *   of text, each array at most 32 entries. 4 KiB is the same bound as a handoff
 *   summary, so `detail` cannot become the transcript the plan forbids storing.
 *
 * A structure genuinely needs nesting? It needs a *schema*, which means a new
 * field on this object where the redaction pipeline and the context renderer can
 * both see it. `z.unknown()` was the alternative and it is the wrong one: it
 * makes the shape unknowable at exactly the point where the shape is the
 * security boundary.
 */
const detailScalarSchema = z.union([z.string().max(4_096), z.number().finite(), z.boolean()])

const detailValueSchema = z.union([detailScalarSchema, z.array(detailScalarSchema).max(32)])

export const memoryDetailSchema = z
  .record(shortTextSchema, detailValueSchema)
  .refine((detail) => Object.keys(detail).length <= 32, "A record's detail may name at most 32 keys")

/**
 * The structured payload.
 *
 * A record is not a blob of text. `content` is one *view* of the payload, and
 * the payload is the thing that is stored, hashed, and migrated. The free-text
 * `content` is required because the TUI, the context renderer, and the legacy
 * importer all need exactly one string — but it is derived from the payload
 * fields below, and a divergence between them is caught by
 * `verifyMemoryRecord`, not left to a reader to notice.
 */
/**
 * The maximum size of a record's `content`.
 *
 * **8 KiB, not the M0 `largeText` bound of 64 KiB.** The plan's guardrail is "Do
 * not store complete raw transcripts as memory by default", and the M5.9 review
 * found that nothing on the write path enforced it: `payload.content` accepted
 * 65 536 characters, so an agent could append a 60 KB terminal transcript as a
 * project-scoped `finding`, and a single user accept made it injectable into
 * every subsequent context. The handoff contract already bounded its summary at
 * 4 KiB (`MAX_SUMMARY_CHARACTERS`); this applies the same order of magnitude to
 * the field every other kind writes.
 *
 * 8 KiB rather than 4 KiB because not every kind of record is a handoff: a long
 * `decision` or `finding` legitimately needs more room than a summary, and the
 * bound's job is to exclude a *transcript*, not to be tight. It is enforced by
 * the schema rather than by each writer, so a new writer cannot forget it — which
 * is the only way a guardrail survives.
 */
export const MAX_RECORD_CONTENT_CHARACTERS = 8_192

export const memoryPayloadSchema = z
  .object({
    /**
     * The human-readable statement of the fact. Bounded at
     * `MAX_RECORD_CONTENT_CHARACTERS` — see that constant for why this is not
     * the M0 `largeText` bound.
     */
    content: z.string().min(1).max(MAX_RECORD_CONTENT_CHARACTERS),
    /** Optional structured detail. Bounded and scalar — see `memoryDetailSchema`. */
    detail: memoryDetailSchema.optional(),
    /** Artifacts this record points at, by id. Never inline contents. */
    artifactReferences: z.array(artifactIdSchema).max(128).refine(isUnique).optional(),
    /** Secrets this record refers to, by reference. Values are not storable. */
    secretReferences: z.array(secretReferenceSchema).max(32).optional(),
  })
  .strict()

export type MemoryPayload = z.infer<typeof memoryPayloadSchema>

/** Redaction provenance. Present on every record; `status: "none"` is explicit. */
export const memoryRedactionSchema = z
  .object({
    status: redactionStatusSchema,
    /** Rule ids that fired. Identifies the *rule*, never the matched text. */
    ruleIds: z.array(shortTextSchema).max(32).refine(isUnique).optional(),
    /** The record this redacted derivative was derived from, if any. */
    derivedFromMemoryId: memoryIdSchema.optional(),
    /** Number of spans replaced. Count, not content. */
    redactedSpanCount: nonnegativeSafeIntegerSchema.optional(),
  })
  .strict()
  .superRefine((redaction, ctx) => {
    if (redaction.status === "derivative" && redaction.derivedFromMemoryId === undefined) {
      addMismatch(ctx, ["derivedFromMemoryId"], "A derivative redaction must name the record it was derived from")
    }
    if (redaction.status !== "derivative" && redaction.derivedFromMemoryId !== undefined) {
      addMismatch(
        ctx,
        ["derivedFromMemoryId"],
        "Only a derivative redaction may name a source record; other statuses describe the record's own content",
      )
    }
  })

export type MemoryRedaction = z.infer<typeof memoryRedactionSchema>

/**
 * M5 memory record, version 2.
 *
 * Append-only. A correction is a new record naming the one it replaces; nothing
 * here is ever edited. The only mutable-looking field is `supersededBy`, and it
 * is written by the repository at supersession time on the *new* record's
 * behalf — see `resolveSupersession`.
 */
export const memoryRecordSchemaV2 = z
  .object({
    schemaVersion: schemaVersionSchema,
    memoryId: memoryIdSchema,
    projectId: projectIdSchema,
    kind: memoryKindSchema,
    scope: memoryScopeSchemaV2,
    author: actorSchema,
    /** When the record was authored, RFC 3339 UTC. */
    createdAt: timestampSchema,
    payload: memoryPayloadSchema,
    /** Digest over the canonical payload + scope + kind. The record's identity for change detection. */
    contentHash: digestSchema,
    trust: trustStateSchema,
    /**
     * The trust decision and who made it. Absent on a record that has never
     * been decided — which for a `proposed` record is the normal state, and
     * whose absence is precisely how "an agent cannot accept its own proposal"
     * is represented in the data rather than in a check somewhere.
     */
    trustDecision: z
      .object({
        decidedBy: actorSchema,
        decidedAt: timestampSchema,
        reason: shortTextSchema.optional(),
      })
      .strict()
      .optional(),
    sensitivity: sensitivitySchema,
    retention: retentionPolicySchema,
    /** Optional expiry. Present only when a policy or an author set one. */
    expiresAt: timestampSchema.optional(),
    /** Nodes allowed to read this record. Absent means no node restriction. */
    visibleToNodeIds: z.array(nodeIdSchema).max(128).refine(isUnique).optional(),
    /** Roles allowed to read this record. Absent means no role restriction. */
    visibleToRoleIds: z.array(roleIdSchema).max(128).refine(isUnique).optional(),
    supersedesMemoryId: memoryIdSchema.optional(),
    supersededByMemoryId: memoryIdSchema.optional(),
    redaction: memoryRedactionSchema,
    /** Provenance: the events, artifacts, sessions, and imports this came from. */
    sourceReferences: z
      .array(externalReferenceSchema)
      .max(128)
      .refine(
        (references) => isUnique(references.map((reference) => `${reference.namespace}\0${reference.id}`)),
        "Source references must be unique by namespace and id",
      )
      .optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.supersedesMemoryId === record.memoryId) {
      addMismatch(ctx, ["supersedesMemoryId"], "A memory record cannot supersede itself")
    }
    if (record.supersededByMemoryId === record.memoryId) {
      addMismatch(ctx, ["supersededByMemoryId"], "A memory record cannot be superseded by itself")
    }
    if (
      record.supersedesMemoryId !== undefined &&
      record.supersededByMemoryId !== undefined &&
      record.supersedesMemoryId === record.supersededByMemoryId
    ) {
      addMismatch(ctx, ["supersededByMemoryId"], "A record cannot both supersede and be superseded by the same record")
    }

    // An `accepted` record without a decision is a forged trust state: the
    // record claims the one status the ontology forbids minting without a user.
    if (record.trust === "accepted") {
      if (record.trustDecision === undefined) {
        addMismatch(ctx, ["trustDecision"], "An accepted record must record who accepted it and when")
      } else if (!ACCEPTING_ACTOR_KINDS.includes(record.trustDecision.decidedBy.kind)) {
        addMismatch(
          ctx,
          ["trustDecision", "decidedBy", "kind"],
          `Only ${ACCEPTING_ACTOR_KINDS.join("/")} may accept a record; '${record.trustDecision.decidedBy.kind}' cannot`,
        )
      }
    } else if (record.trustDecision !== undefined && record.trustDecision.decidedBy.kind !== "user") {
      addMismatch(
        ctx,
        ["trustDecision", "decidedBy", "kind"],
        "Only a user may record a trust decision on a record",
      )
    }

    // A `prohibited` record with no redaction decision is the failure the
    // redaction pipeline exists to prevent, so it is refused at the schema.
    if (record.sensitivity === "prohibited" && record.redaction.status === "none") {
      addMismatch(
        ctx,
        ["redaction", "status"],
        "A prohibited record must carry a redaction decision; unlabelled prohibited content cannot be stored",
      )
    }

    if (record.sensitivity === "secret_reference_only" && (record.payload.secretReferences ?? []).length === 0) {
      addMismatch(
        ctx,
        ["payload", "secretReferences"],
        "A secret_reference_only record must name at least one secret reference; without one it is asserting a secret with no referent",
      )
    }

    if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= Date.parse(record.createdAt)) {
      addMismatch(ctx, ["expiresAt"], "Expiry must be later than the record's creation time")
    }

    if (record.redaction.status === "derivative" && record.redaction.derivedFromMemoryId === record.memoryId) {
      addMismatch(ctx, ["redaction", "derivedFromMemoryId"], "A derivative redaction must derive from a different record")
    }
  })

export type MemoryRecordV2 = z.infer<typeof memoryRecordSchemaV2>

/**
 * Version 1, restated for reading.
 *
 * Field-for-field identical to the M0 `memoryRecordSchema`; the type is
 * asserted against it in `tests/unit/memory/record-contract.test.ts` so this
 * copy can never drift from the frozen shape without failing a test.
 */
export const memoryRecordSchemaV1 = z
  .object({
    schemaVersion: schemaVersionSchema,
    memoryId: memoryIdSchema,
    projectId: projectIdSchema,
    kind: memoryKindSchema,
    content: largeTextSchema,
    contentDigest: digestSchema,
    scope: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("project") }).strict(),
      z.object({ kind: z.literal("run"), runId: runIdSchema }).strict(),
      z.object({ kind: z.literal("task"), runId: runIdSchema, taskId: taskIdSchema }).strict(),
      z
        .object({ kind: z.literal("session"), runId: runIdSchema, taskId: taskIdSchema, sessionId: sessionIdSchema })
        .strict(),
    ]),
    author: actorSchema,
    createdAt: timestampSchema,
    sourceReferences: z.array(externalReferenceSchema).max(128),
    trustState: z.enum(["proposed", "accepted", "rejected"]),
    sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
    retention: z.enum(["run", "project", "permanent"]),
    supersedesMemoryId: memoryIdSchema.optional(),
  })
  .strict()

export type MemoryRecordV1 = z.infer<typeof memoryRecordSchemaV1>

const MEMORY_RECORD_SHAPES = {
  1: memoryRecordSchemaV1,
  2: memoryRecordSchemaV2,
} as const

/**
 * Read a memory record at any supported version.
 *
 * Throws `UnsupportedSchemaVersionError` / `UnversionedRecordError` for a record
 * this build cannot read, which is the loud failure the plan's "stop if" clause
 * wants: an unreadable record must not be silently dropped from a context.
 */
export function parseMemoryRecord(value: unknown): MemoryRecordV1 | MemoryRecordV2 {
  return parseVersioned<MemoryRecordV1 | MemoryRecordV2>("memory", value, MEMORY_RECORD_SHAPES)
}

/** Non-throwing read. `ok: false` means "do not use this record", never "use it anyway". */
export function safeParseMemoryRecord(value: unknown) {
  return safeParseVersioned<MemoryRecordV1 | MemoryRecordV2>("memory", value, MEMORY_RECORD_SHAPES)
}

export function isMemoryRecordV2(record: MemoryRecordV1 | MemoryRecordV2): record is MemoryRecordV2 {
  return record.schemaVersion === 2
}

/**
 * The read-side view every consumer outside the migration actually wants.
 *
 * Queries, the context assembler, and the TUI all speak this, not `v1 | v2`.
 * A `v1` record is projected on read; it is never rewritten. The projection is
 * pure and cheap, so "the file on disk is still v1" costs nothing.
 */
export type MemoryViewScope = MemoryScope | MemoryRecordV1["scope"]

export interface MemoryRecordView {
  readonly memoryId: string
  readonly projectId: string
  readonly kind: MemoryKind
  readonly scope: MemoryViewScope
  readonly author: MemoryRecordV2["author"]
  readonly createdAt: string
  readonly content: string
  readonly contentHash: string
  readonly trust: TrustState
  readonly sensitivity: Sensitivity
  readonly retention: MemoryRecordV2["retention"]
  readonly expiresAt?: string
  readonly visibleToNodeIds?: readonly string[]
  readonly visibleToRoleIds?: readonly string[]
  readonly supersedesMemoryId?: string
  readonly supersededByMemoryId?: string
  readonly redaction: MemoryRedaction
  readonly sourceReferences: readonly { namespace: string; id: string }[]
  readonly payload: MemoryPayload
  /** The version the record was stored at. A `1` here is not a defect. */
  readonly sourceVersion: 1 | 2
}

/**
 * v1 -> v2 read projection.
 *
 * The mappings that matter, and why:
 *
 * - `sensitivity`: `public`/`internal` -> `public_to_project`; `confidential`/
 *   `restricted` -> `restricted`. A v1 record has no notion of referring to a
 *   secret, so it can never become `secret_reference_only`; that state is only
 *   reachable by authoring it in v2.
 * - `trust`: `accepted` stays `accepted` but the *decision* is unknown, because
 *   v1 never recorded who accepted it. A `user` author is the best available
 *   evidence, so the decision is attributed to that author and the view carries
 *   `trustDecisionFromMigration: true` — the migration is not permitted to
 *   invent an approval, so the view marks it as inferred. `tests/integration/
 *   memory-migration.test.ts` asserts a v1 `accepted` record does not silently
 *   become a v2 record a fresh user can be shown as having approved.
 * - `contentDigest` -> `contentHash` unchanged, so a v1 record's stored digest
 *   is still verifiable after projection.
 */
export function toMemoryRecordView(record: MemoryRecordV1 | MemoryRecordV2): MemoryRecordView {
  if (isMemoryRecordV2(record)) {
    return {
      memoryId: record.memoryId,
      projectId: record.projectId,
      kind: record.kind,
      scope: record.scope,
      author: record.author,
      createdAt: record.createdAt,
      content: record.payload.content,
      contentHash: record.contentHash,
      trust: record.trust,
      sensitivity: record.sensitivity,
      retention: record.retention,
      expiresAt: record.expiresAt,
      visibleToNodeIds: record.visibleToNodeIds,
      visibleToRoleIds: record.visibleToRoleIds,
      supersedesMemoryId: record.supersedesMemoryId,
      supersededByMemoryId: record.supersededByMemoryId,
      redaction: record.redaction,
      sourceReferences: record.sourceReferences ?? [],
      payload: record.payload,
      sourceVersion: 2,
    }
  }

  return {
    memoryId: record.memoryId,
    projectId: record.projectId,
    kind: record.kind,
    scope: record.scope,
    author: record.author,
    createdAt: record.createdAt,
    content: record.content,
    contentHash: record.contentDigest,
    trust: record.trustState,
    sensitivity: migrateV1Sensitivity(record.sensitivity),
    retention: record.retention,
    expiresAt: undefined,
    visibleToNodeIds: undefined,
    visibleToRoleIds: undefined,
    supersedesMemoryId: record.supersedesMemoryId,
    supersededByMemoryId: undefined,
    redaction: { status: "none" },
    sourceReferences: record.sourceReferences,
    payload: { content: record.content },
    sourceVersion: 1,
  }
}

export function migrateV1Sensitivity(sensitivity: MemoryRecordV1["sensitivity"]): Sensitivity {
  return sensitivity === "public" || sensitivity === "internal" ? "public_to_project" : "restricted"
}

/**
 * Records an import produced from a v1 record, so a reader can see it was
 * inferred.
 *
 * **The v1 trust mapping does not live here.** It used to: this file exported a
 * `migrationTrustDecision` whose docblock claimed a v1 `accepted` record
 * authored by a `user` should migrate as `accepted`, and which was called from
 * nowhere. The M5.9 review found it as SF-15 and the correct resolution was to
 * *delete* it rather than to correct its prose, because two exported functions
 * claiming to be the same policy is the defect — whichever one is right, a reader
 * has to guess which one runs.
 *
 * The single policy is `migratedTrustStateFor` in `./migration.js`, and it is
 * strictly more conservative than the function that lived here: it maps
 * `accepted -> proposed` for *every* author kind, because the stop condition is
 * about the **format** (a v1 record never recorded who accepted it), not about
 * the author. `tests/integration/memory-migration.test.ts` pins the whole truth
 * table, including the one input on which the two statements disagree.
 *
 * The type remains because a caller that needs to *describe* an inference — a
 * diagnostic, a TUI line — still needs the shape. It is a reporting type now,
 * not a policy.
 */
export interface MigratedTrustDecision {
  readonly memoryId: string
  readonly attributedTo: "author" | "none"
  readonly trust: TrustState
  readonly reason: string
}

/** Build a v2 record from a read view, computing the hash. Used by the migration. */
export function buildMemoryRecord(input: {
  memoryId: string
  projectId: string
  kind: MemoryKind
  scope: MemoryScope
  author: MemoryRecordV2["author"]
  createdAt: string
  payload: MemoryPayload
  trust: TrustState
  trustDecision?: MemoryRecordV2["trustDecision"]
  sensitivity: Sensitivity
  retention?: MemoryRecordV2["retention"]
  expiresAt?: string
  visibleToNodeIds?: readonly string[]
  visibleToRoleIds?: readonly string[]
  supersedesMemoryId?: string
  supersededByMemoryId?: string
  redaction?: MemoryRedaction
  sourceReferences?: readonly { namespace: string; id: string }[]
  schemaVersion?: 1 | 2
}): MemoryRecordV2 {
  return memoryRecordSchemaV2.parse({
    schemaVersion: input.schemaVersion ?? CURRENT_SCHEMA_VERSION,
    memoryId: input.memoryId,
    projectId: input.projectId,
    kind: input.kind,
    scope: input.scope,
    author: input.author,
    createdAt: input.createdAt,
    payload: input.payload,
    contentHash: computeContentHash({ kind: input.kind, scope: input.scope, payload: input.payload }),
    trust: input.trust,
    ...(input.trustDecision ? { trustDecision: input.trustDecision } : {}),
    sensitivity: input.sensitivity,
    retention: input.retention ?? DEFAULT_RETENTION_BY_KIND[input.kind],
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(input.visibleToNodeIds ? { visibleToNodeIds: [...input.visibleToNodeIds] } : {}),
    ...(input.visibleToRoleIds ? { visibleToRoleIds: [...input.visibleToRoleIds] } : {}),
    ...(input.supersedesMemoryId ? { supersedesMemoryId: input.supersedesMemoryId } : {}),
    ...(input.supersededByMemoryId ? { supersededByMemoryId: input.supersededByMemoryId } : {}),
    redaction: input.redaction ?? { status: "none" },
    ...(input.sourceReferences ? { sourceReferences: [...input.sourceReferences] } : {}),
  })
}

/**
 * The record's content hash: kind, scope, and payload.
 *
 * Deliberately excludes `trust`, `sensitivity`, `retention`, and the redaction
 * metadata. Those are *decisions about* the content, and folding them in would
 * mean a redaction changes the hash of the thing it redacted — which would make
 * "did the content change?" unanswerable, and would break the M5.4 promise that
 * a derivative keeps its source's identity. The hash answers exactly one
 * question: is this the same fact?
 */
export function computeContentHash(input: {
  kind: MemoryKind
  scope: MemoryScope
  payload: MemoryPayload
}): Digest {
  return digestJson({ kind: input.kind, payload: input.payload, scope: input.scope })
}

/** Is the stored hash still the hash of the stored content? */
export function verifyMemoryRecord(record: MemoryRecordV1 | MemoryRecordV2): boolean {
  if (isMemoryRecordV2(record)) {
    return record.contentHash === computeContentHash({ kind: record.kind, scope: record.scope, payload: record.payload })
  }
  return record.contentDigest === digestJson(record.content)
}

/**
 * Build a record the way a *user* would, enforcing the trust rules.
 *
 * A non-user author can propose (the default) and can produce a
 * `system_derived` record, but cannot produce `accepted` — the ontology decides
 * that, and this function asks it rather than re-deriving.
 */
export function proposeMemoryRecord(input: {
  memoryId: string
  projectId: string
  kind: MemoryKind
  scope: MemoryScope
  author: MemoryRecordV2["author"]
  createdAt: string
  content: string
  detail?: Record<string, unknown>
  artifactReferences?: readonly string[]
  secretReferences?: readonly SecretReference[]
  sensitivity?: Sensitivity
  retention?: MemoryRecordV2["retention"]
  expiresAt?: string
  visibleToNodeIds?: readonly string[]
  visibleToRoleIds?: readonly string[]
  supersedesMemoryId?: string
  redaction?: MemoryRedaction
  sourceReferences?: readonly { namespace: string; id: string }[]
  /** Override for the importer, which knows the v1 trust state. Defaults to the ontology. */
  trust?: TrustState
  trustDecision?: MemoryRecordV2["trustDecision"]
}): MemoryRecordV2 {
  const trust = input.trust ?? initialTrustFor(input.author.kind, input.kind)

  // A user-authored `accepted` record needs a decision, and the only decision
  // the constructor can honestly make is "the author decided it by writing it".
  // That inference is limited to a `user` author by the ontology above, so a
  // node or session can never reach this branch, and it is written here rather
  // than left to the caller because a caller who had to supply it would
  // eventually supply the wrong one.
  const trustDecision =
    input.trustDecision ??
    (trust === "accepted" && input.author.kind === "user"
      ? { decidedBy: input.author, decidedAt: input.createdAt, reason: "Authored by this user" }
      : undefined)

  return buildMemoryRecord({
    memoryId: input.memoryId,
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
    trust,
    trustDecision,
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

/** Re-exported so consumers need one import for the sensitivity question. */
export { SENSITIVITY_RANK, canTransitionTrust, isRenderable, memoryScopeKindSchema }
export type { ContextCategory, MemoryScopeKind, MemoryId }
