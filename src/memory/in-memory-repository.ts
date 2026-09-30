/**
 * M5.2 — the memory repository engine, and the in-memory implementation of it.
 *
 * ## Why the engine lives in this file
 *
 * The authorization, ordering, and supersession rules are the same for a
 * JSONL-backed store and a `Map`-backed one, and a second copy of them would be
 * a second answer to "may this reader see this record". So the shared
 * implementation is `MemoryRepositoryEngine` below, parameterised by a
 * `MemoryStorage` adapter that knows how bytes are persisted, and
 * `FileMemoryRepository` (in `./file-repository.js`) reuses this engine with a
 * different adapter rather than reimplementing any of the rules.
 *
 * The in-memory backend is the one that exists for every non-durable consumer —
 * tests, the context assembler, the TUI — so it is the natural home for the
 * shared engine: the durable backend is the special case, not the rule owner.
 *
 * ## The three invariants this file exists to hold
 *
 * 1. **Append-only.** `append` and `supersede` only ever *add* to the store.
 *    `decideTrust` writes `trust`/`trustDecision` and nothing else, which is
 *    why `computeContentHash` deliberately excludes those fields: a trust
 *    transition is a decision *about* a fact, and folding it into the fact's
 *    identity would make "is this the same fact?" unanswerable. Supersession,
 *    by contrast, appends a new record and never touches the old bytes.
 * 2. **A stable total order.** `query` returns `(createdAt asc, memoryId asc)`.
 *    A tie on `createdAt` is broken by id, and ids are derived from content, so
 *    the order is a property of the *set* of records rather than of insertion
 *    order, map iteration, or filesystem ordering.
 * 3. **A refusal is a value.** Every read returns the record or a withholding
 *    with a reason. `get` returns `ok: false` rather than `null` for both
 *    "unknown" and "not permitted", because a `null` cannot distinguish the two
 *    and a caller cannot be *forced* to handle a case it was not told about.
 */

import { createHash } from "node:crypto"

import { canTransitionTrust, type MemoryKind, type RedactionStatus, type Sensitivity } from "./ontology.js"
import {
  isMemoryRecordV2,
  memoryRecordSchemaV2,
  memoryScopeSchemaV2,
  proposeMemoryRecord,
  toMemoryRecordView,
  type MemoryRecordV1,
  type MemoryRecordV2,
  type MemoryRecordView,
  type MemoryScope,
} from "./record.js"
import type {
  AppendMemoryInput,
  AppendMemoryResult,
  MemoryQuery,
  MemoryQueryResult,
  MemoryQueryScope,
  MemoryRepository,
  MemoryTombstone,
  MemoryWithholding,
  TombstoneRequest,
  MemoryWriteGuard,
} from "./ports.js"
import {
  createMemoryAccessPolicy,
  ScopeLatticeAccessPolicy,
  toWithholding,
  type MemoryAccessState,
} from "./access-policy.js"
import {
  alreadyTombstonedError,
  atomicAppendRefusedError,
  crossProjectSupersessionError,
  duplicateIdError,
  illegalTrustTransitionError,
  invalidTombstoneReasonError,
  legacyRecordImmutableError,
  MemoryCorruptStoreError,
  notVisibleError,
  projectMismatchError,
  queryProjectMismatchError,
  recordInvalidError,
  tombstonedError,
  tombstoneUnauthorizedError,
  trustDecisionDeniedError,
  unknownRecordError,
  unknownSupersessionError,
} from "./repository-errors.js"
import { memoryIdSchema } from "../orchestration/identifiers.js"
import { actorSchema } from "../orchestration/schemas.js"
import type { Actor } from "../orchestration/types.js"
import type { ContractError, Result } from "../orchestration/errors.js"

/** The trust decision as `decideTrust` accepts it. */
export interface TrustDecisionInput {
  readonly trust: "accepted" | "rejected"
  readonly decidedBy: Actor
  readonly decidedAt: string
  readonly reason?: string
}

/** What a query's `now` is: the caller's clock, supplied, never read from here. */
export type MemoryClock = () => string

export interface MemoryRepositoryOptions {
  /**
   * The reference time for expiry evaluation. Required, and never used to stamp
   * a record: `AppendMemoryInput.createdAt` and `TombstoneRequest.requestedAt`
   * supply those. It exists only because `ports.MemoryQuery` has no `now`
   * parameter, and "no ambient clock" must mean "no clock the caller did not
   * choose" rather than "no clock at all".
   */
  readonly now: MemoryClock
  /**
   * An optional check every write passes through, before the record is stored.
   *
   * This is the enforcement point the plan's Redaction Design asks for —
   * "redaction runs before persistence when input is prohibited" — and the M5.9
   * review found it missing (SF-6): `AppendMemoryInput.redaction` was
   * caller-asserted, so a live AWS key in `content` was stored and served with
   * `redaction: { status: "none" }`.
   *
   * **Optional, and that is a real limitation rather than a convenience.** A
   * repository constructed without a guard has no write-path secret detection at
   * all, and the caller who forgets is the one who leaks. It is optional because
   * making it mandatory would mean the store *owns* a detector set, and a
   * detector upgrade would then be a storage change — two places deciding what a
   * secret looks like, which is the failure the port was designed to avoid.
   *
   * The guard **refuses**; it never rewrites. See `MemoryWriteGuard` for why a
   * guard that substituted text would break the record's content hash.
   */
  readonly writeGuard?: MemoryWriteGuard
}

/**
 * What a backend must provide.
 *
 * Every method is a *whole-store* operation with no reader knowledge, because
 * authorization belongs to the engine: a backend that could decide visibility
 * would be a second place to get it wrong, and a backend that stored a derived
 * `supersededBy` marker on the record would be mutating the record.
 */
export interface MemoryStorage {
  /** Load the entire store. Throws `MemoryCorruptStoreError` on unreadable bytes. */
  load(): Promise<MemoryStorageSnapshot>
  /** Durably append records. Called only after the engine has validated the batch. */
  insertRecords(records: readonly MemoryRecordV2[]): Promise<void>
  /** Durably append a trust decision. */
  insertDecision(decision: StoredTrustDecision): Promise<void>
  /** Durably record a tombstone. */
  insertTombstone(tombstone: MemoryTombstone): Promise<void>
  /** Durably erase a record's content, keeping the tombstone. */
  eraseContent(memoryId: string): Promise<void>
}

export interface MemoryStorageSnapshot {
  readonly records: readonly (MemoryRecordV1 | MemoryRecordV2)[]
  readonly decisions: readonly StoredTrustDecision[]
  readonly tombstones: readonly MemoryTombstone[]
}

export interface StoredTrustDecision {
  readonly memoryId: string
  readonly trust: "accepted" | "rejected"
  readonly decidedBy: Actor
  readonly decidedAt: string
  readonly reason?: string
}

/**
 * The id-derivation salts.
 *
 * Both are versioned, and both are the *shape* of the derivation the M0 legacy
 * migration already uses (`deterministicId` in
 * `src/orchestration/legacy/migration.ts`): sha256 over a domain-separated
 * source key, truncated to 40 hex characters, behind a fixed prefix.
 *
 * Two salts, because two different questions are being asked.
 *
 * `NATIVE` is used for every record the repository mints. It is what makes
 * re-importing the same legacy file *idempotent*: the id is derived from the
 * content, so a second run derives the same id, `append` refuses it as
 * `memory.duplicate_id`, and the migration can treat "already imported" as a
 * success rather than as a duplicate history.
 *
 * `LEGACY` reproduces the migration's own id derivation byte-for-byte, so an id
 * the migration already computed can be recomputed rather than invented. It is
 * exported for that use and is never used to mint a record this repository
 * authored — a record born under M5 is not a legacy import and should not wear
 * a `legacy.` prefix.
 *
 * Both salts are frozen: changing either produces a *different* id for the same
 * content, which is a record-identity change, not a refactor.
 */
export const MEMORY_ID_DERIVATION_SALT = "aibridge-memory-v1"
export const LEGACY_MEMORY_ID_DERIVATION_SALT = "aibridge-legacy-v1"

/**
 * A structural copy of a record, so a read cannot hand out the store's own
 * object.
 *
 * `structuredClone` is not used because it is not available in every runtime this
 * builds for, and because a JSON round trip is *sufficient* here for a reason
 * worth stating: both record shapes are `.strict()` Zod over primitives, arrays,
 * and plain objects, so there is no class instance, `Map`, `Set`, or `Date` for a
 * JSON round trip to flatten. If a future field breaks that, this function
 * silently becomes a lossy copy — which is why `deepFreeze` below and the copy
 * are paired, and why `tests/unit/memory/repository.test.ts` asserts a mutation
 * of the result does not change what a later read returns.
 */
export function structuralCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Recursively freeze, so a copy cannot be mutated either. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  return Object.freeze(value)
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function deriveIdWith(salt: string, prefix: string, sourceKey: string): string {
  const hash = sha256Hex(`${salt}\0memory\0${sourceKey}`)
  return memoryIdSchema.parse(`${prefix}${hash.slice(0, 40)}`) as string
}

/** Derive the id of a record from its source key. Stable across processes, runs, and machines. */
export function deriveMemoryId(sourceKey: string): string {
  return deriveIdWith(MEMORY_ID_DERIVATION_SALT, "memory.", sourceKey)
}

/**
 * Recompute the id the M0 legacy migration derived for the same source key.
 *
 * Exists so the M5.3 migration can reconcile what it wrote before M5 existed
 * with what this repository writes now, without either side inventing an id.
 */
export function deriveMigratedMemoryId(sourceKey: string): string {
  return deriveIdWith(LEGACY_MEMORY_ID_DERIVATION_SALT, "legacy.memory.", sourceKey)
}

/**
 * The stable identity of a record's *content*.
 *
 * Everything that makes the record a distinct fact participates: who wrote it,
 * where, when, what it says, and what it points at. What is deliberately
 * excluded is `trust`/`trustDecision` (decisions about the fact, mutable by a
 * user without changing the fact) and `correlationId` (per-request plumbing that
 * would otherwise make the same fact produce two ids on a retry).
 */
export function memoryRecordSourceKey(input: AppendMemoryInput): string {
  return sha256Hex(
    JSON.stringify(
      {
        author: input.author,
        artifactReferences: input.artifactReferences ?? null,
        content: input.content,
        createdAt: input.createdAt,
        detail: input.detail ?? null,
        expiresAt: input.expiresAt ?? null,
        kind: input.kind,
        projectId: input.projectId,
        redaction: input.redaction ?? null,
        retention: input.retention ?? null,
        scope: input.scope,
        secretReferences: input.secretReferences ?? null,
        sensitivity: input.sensitivity ?? null,
        sourceReferences: input.sourceReferences ?? null,
        supersedesMemoryId: input.supersedesMemoryId ?? null,
        visibleToNodeIds: input.visibleToNodeIds ?? null,
        visibleToRoleIds: input.visibleToRoleIds ?? null,
      },
      canonicalKeyOrder,
    ),
  )
}

/** `JSON.stringify` key order is insertion order; sort it so the key is stable. */
function canonicalKeyOrder(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value
  const source = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) sorted[key] = source[key]
  return sorted
}

export class MemoryRepositoryEngine implements MemoryRepository {
  protected readonly records = new Map<string, MemoryRecordV1 | MemoryRecordV2>()
  protected readonly tombstones = new Map<string, MemoryTombstone>()
  /**
   * `memoryId -> the access-relevant facts of the record a tombstone replaced`.
   *
   * In this process only, and never written to a storage adapter. It exists for
   * one question — "would this reader's withholding of the *live* record have
   * been allowed to name its kind?" — and the answer must not depend on whether
   * the process happens to have restarted. The direction of every possible
   * failure is the same: a missing entry discloses less, never more.
   */
  private readonly tombstoneAccess = new Map<string, TombstoneAccessFacts>()
  /** Derived, never stored on the record: `superseded id -> correcting id`. */
  private supersededBy = new Map<string, string>()
  private loaded = false
  private loading: Promise<void> | null = null
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    protected readonly storage: MemoryStorage,
    protected readonly options: MemoryRepositoryOptions,
  ) {}

  // --- load ---------------------------------------------------------------

  protected async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    // Concurrent first reads must not each run a load; a second load would
    // replay decisions onto records that already carry them.
    this.loading ??= this.storage.load().then((snapshot) => {
      this.applySnapshot(snapshot)
      this.loaded = true
      this.loading = null
    })
    await this.loading
  }

  /**
   * Run a mutation with exclusive access to the store.
   *
   * Every refusal this repository makes about a *write* — duplicate id, unknown
   * supersession, already tombstoned, illegal trust transition — is a
   * check-then-act. Without serialization, two concurrent callers passing the
   * same check would both write, and the guarantee that an identical append is
   * a conflict rather than a duplicate line would hold only until the first
   * concurrent caller arrived. The lock is a promise chain rather than a mutex
   * primitive because nothing here blocks and nothing may be re-entered: `append`
   * and `supersede` share one critical section by design.
   */
  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release: () => void = () => undefined
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous.catch(() => undefined)
    try {
      return await task()
    } finally {
      release()
    }
  }

  private applySnapshot(snapshot: MemoryStorageSnapshot): void {
    for (const record of snapshot.records) {
      if (this.records.has(record.memoryId)) {
        throw new MemoryCorruptStoreError({
          file: "records",
          detail: `two records claim memoryId '${record.memoryId}'; a derived id identifies exactly one record`,
        })
      }
      this.records.set(record.memoryId, record)
    }
    this.rebuildSupersessionIndex()

    for (const tombstone of snapshot.tombstones) {
      // A tombstone loaded from a store has no `tombstoneAccess` entry, and
      // deliberately so: the access-relevant facts of the record it replaced are
      // not persisted (see `TombstoneAccessFacts`), so a reloaded tombstone
      // answers conservatively until nothing is known about the record again.
      if (this.tombstones.has(tombstone.memoryId)) {
        throw new MemoryCorruptStoreError({
          file: "tombstones",
          detail: `two tombstones claim memoryId '${tombstone.memoryId}'`,
        })
      }
      this.tombstones.set(tombstone.memoryId, tombstone)
    }

    for (const decision of snapshot.decisions) {
      const record = this.records.get(decision.memoryId)
      if (record === undefined) {
        // A decision for a purged record is legitimate (delete-after-decide), and
        // a decision for a record that never existed is corruption: applying it
        // would invent a fact.
        if (!this.tombstones.has(decision.memoryId)) {
          throw new MemoryCorruptStoreError({
            file: "decisions",
            detail: `a trust decision names memoryId '${decision.memoryId}', which is neither stored nor tombstoned`,
          })
        }
        continue
      }
      if (!isMemoryRecordV2(record)) {
        // A v1 record is a legacy artefact and has no trust decision to replay.
        // Its presence in the decision log means the log disagrees with the
        // records, which is corruption rather than something to work around.
        throw new MemoryCorruptStoreError({
          file: "decisions",
          detail: `a trust decision names memoryId '${decision.memoryId}', which is stored at schema version 1 and has no trust state to transition`,
        })
      }
      this.records.set(decision.memoryId, applyTrustDecision(record, decision))
    }
  }

  private rebuildSupersessionIndex(): void {
    this.supersededBy = new Map()
    for (const record of this.records.values()) {
      const supersedes = supersedesIdOf(record)
      if (supersedes === undefined) continue
      // Later records win the back-pointer. Both remain in the store; the active
      // view hides the superseded one either way.
      this.supersededBy.set(supersedes, record.memoryId)
    }
  }

  protected accessState(): MemoryAccessState {
    return {
      isTombstoned: (memoryId) => this.tombstones.has(memoryId),
      isSuperseded: (memoryId) => this.supersededBy.has(memoryId),
    }
  }

  protected nowValue(): string {
    const value = this.options.now()
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("memory: the injected clock returned no timestamp")
    }
    return value
  }

  // --- append -------------------------------------------------------------

  async append(input: AppendMemoryInput): Promise<Result<AppendMemoryResult>> {
    await this.ensureLoaded()
    return this.exclusive(() => this.appendInternal(input))
  }

  private async appendInternal(input: AppendMemoryInput): Promise<Result<AppendMemoryResult>> {
    // The write guard runs FIRST, before the record is even built, so a refusal
    // costs nothing and cannot be reached by a malformed input first. It runs
    // on the raw `AppendMemoryInput` because that is what the caller authored —
    // inspecting the *derived* record would mean inspecting a record that was
    // about to be stored, which is a subtly different thing to do.
    const guarded = this.options.writeGuard?.inspect(input)
    if (guarded !== undefined && !guarded.ok) return guarded

    const built = this.buildRecord(input)
    if (!built.ok) return built

    const memoryId = built.value.memoryId
    if (this.records.has(memoryId)) {
      return { ok: false, error: duplicateIdError(memoryId, input.correlationId) }
    }

    let superseded: MemoryRecordV2 | undefined
    const supersedesId = supersedesIdOf(built.value)
    if (supersedesId !== undefined) {
      const resolution = this.resolveSupersession(supersedesId, input.projectId, input.correlationId)
      if (!resolution.ok) return resolution
      superseded = resolution.value
    }

    try {
      await this.storage.insertRecords([built.value])
    } catch (error) {
      return { ok: false, error: this.toContractError(error) }
    }

    this.records.set(memoryId, built.value)
    if (superseded !== undefined && supersedesId !== undefined) {
      this.supersededBy.set(supersedesId, memoryId)
    }

    return { ok: true, value: superseded === undefined ? { record: built.value } : { record: built.value, superseded } }
  }

  /**
   * Validate the input against the record schema and mint the record.
   *
   * The id is derived *before* the schema runs, so an invalid record still has
   * a stable id to name in the refusal.
   */
  private buildRecord(input: AppendMemoryInput): Result<MemoryRecordV2> {
    // A trust decision may only be *recorded* by the person it names. Without
    // this, `trust: "accepted"` plus a `trustDecision` naming any user would let
    // a node author a trusted project fact in someone else's name, and the
    // schema cannot catch it: it checks that the decider is a user, not that the
    // decider is this author. Requiring `decidedBy === author` is what makes
    // "accepted" mean "a user wrote this" rather than "a user is named here".
    //
    // It costs the migration nothing: `migratedTrustStateFor` in `migration.ts`
    // imports every v1 record as `proposed` or `rejected` with NO decision at
    // all, so this branch is never reached by a migrated record. (An earlier
    // design attributed a v1 `accepted` record to its own `user` author, which
    // would have made this check *refuse every migrated record* — the decision's
    // decider was the v1 author while the migrated record's author is
    // `system:legacy-memory-migration`. See `MigratedTrustDecision` in
    // `record.ts`.)
    if (input.trustDecision !== undefined && !isSameActor(input.trustDecision.decidedBy, input.author)) {
      return {
        ok: false,
        error: recordInvalidError(
          `a trust decision was supplied by one actor (${describeActor(input.trustDecision.decidedBy)}) and attributed to another (${describeActor(input.author)})`,
          [{ path: "trustDecision.decidedBy", message: "The deciding actor must be the record's author" }],
          input.correlationId,
        ),
      }
    }

    const memoryId = deriveMemoryId(memoryRecordSourceKey(input))
    try {
      const record = proposeMemoryRecord({
        memoryId,
        projectId: input.projectId,
        kind: input.kind,
        scope: input.scope,
        author: input.author,
        createdAt: input.createdAt,
        content: input.content,
        detail: input.detail,
        artifactReferences: input.artifactReferences,
        secretReferences: input.secretReferences,
        sensitivity: input.sensitivity,
        retention: input.retention,
        expiresAt: input.expiresAt,
        visibleToNodeIds: input.visibleToNodeIds,
        visibleToRoleIds: input.visibleToRoleIds,
        supersedesMemoryId: input.supersedesMemoryId,
        redaction: input.redaction,
        sourceReferences: input.sourceReferences,
        trust: input.trust,
        trustDecision: input.trustDecision,
      })
      return { ok: true, value: record }
    } catch (error) {
      return {
        ok: false,
        error: recordInvalidError(
          `the append input does not satisfy the v2 memory record schema (derived id '${memoryId}')`,
          issuesOf(error),
          input.correlationId,
        ),
      }
    }
  }

  private resolveSupersession(supersedesId: string, attemptedProjectId: string, correlationId?: string): Result<MemoryRecordV2> {
    const target = this.records.get(supersedesId)
    if (target === undefined) {
      return { ok: false, error: unknownSupersessionError(supersedesId, correlationId) }
    }
    if (target.projectId !== attemptedProjectId) {
      return { ok: false, error: crossProjectSupersessionError(supersedesId, target.projectId, attemptedProjectId, correlationId) }
    }
    if (!isMemoryRecordV2(target)) {
      return { ok: false, error: legacyRecordImmutableError(supersedesId, "superseded in place", correlationId) }
    }
    if (this.tombstones.has(supersedesId)) {
      return { ok: false, error: unknownSupersessionError(supersedesId, correlationId) }
    }
    return { ok: true, value: target }
  }

  async appendAll(inputs: readonly AppendMemoryInput[]): Promise<Result<readonly MemoryRecordV2[]>> {
    await this.ensureLoaded()
    return this.exclusive(() => this.appendAllInternal(inputs))
  }

  private async appendAllInternal(inputs: readonly AppendMemoryInput[]): Promise<Result<readonly MemoryRecordV2[]>> {
    // Validate the whole batch against a scratch view of the store first, so a
    // refusal anywhere leaves the store untouched. The migration depends on
    // this: it imports a file that may be half-reimported, and a partial import
    // would leave ids that no longer match their source.
    const staged = new Map<string, MemoryRecordV1 | MemoryRecordV2>(this.records)
    const stagedSuperseded = new Map(this.supersededBy)
    const built: MemoryRecordV2[] = []

    for (const input of inputs) {
      const result = this.buildRecord(input)
      if (!result.ok) return result
      const record = result.value
      if (staged.has(record.memoryId)) {
        return { ok: false, error: duplicateIdError(record.memoryId, input.correlationId) }
      }
      const supersedesId = supersedesIdOf(record)
      if (supersedesId !== undefined) {
        const target = staged.get(supersedesId)
        if (target === undefined) {
          return { ok: false, error: unknownSupersessionError(supersedesId, input.correlationId) }
        }
        if (target.projectId !== record.projectId) {
          return { ok: false, error: crossProjectSupersessionError(supersedesId, target.projectId, record.projectId, input.correlationId) }
        }
        if (!isMemoryRecordV2(target)) {
          return { ok: false, error: legacyRecordImmutableError(supersedesId, "superseded in place", input.correlationId) }
        }
        stagedSuperseded.set(supersedesId, record.memoryId)
      }
      staged.set(record.memoryId, record)
      built.push(record)
    }

    if (built.length === 0) return { ok: true, value: [] }

    try {
      await this.storage.insertRecords(built)
    } catch (error) {
      return {
        ok: false,
        error: atomicAppendRefusedError(this.toContractError(error).message, inputs[0]?.correlationId),
      }
    }

    for (const record of built) this.records.set(record.memoryId, record)
    this.supersededBy = stagedSuperseded
    return { ok: true, value: built }
  }

  // --- supersede ----------------------------------------------------------

  /**
   * Append a correction. The target is never mutated: the new record names it,
   * the derived index marks it, and its bytes are byte-for-byte what they were.
   */
  async supersede(memoryId: string, input: AppendMemoryInput): Promise<Result<AppendMemoryResult>> {
    await this.ensureLoaded()
    if (input.supersedesMemoryId !== undefined && input.supersedesMemoryId !== memoryId) {
      return {
        ok: false,
        error: recordInvalidError(
          `supersede('${memoryId}') was given input.supersedesMemoryId='${input.supersedesMemoryId}'`,
          [],
          input.correlationId,
        ),
      }
    }
    // `appendInternal` rather than `append`, so the correction and the check
    // that named its target happen inside one critical section.
    return this.exclusive(() => this.appendInternal({ ...input, supersedesMemoryId: memoryId }))
  }

  // --- read ---------------------------------------------------------------

  /**
   * The stored bytes, with **no authorization**.
   *
   * This is the migration and audit path, and it is the reason the two
   * authorization-aware reads exist beside it. It returns a **deep-frozen
   * structural copy**, and that is not a defensive nicety — it is the fix for a
   * Blocker the M5.9 review found (SF-1).
   *
   * The defect: this used to return the live object out of `this.records`. A
   * caller could assign `raw.trust = "accepted"` together with a `user`-shaped
   * `trustDecision`, and `query()` — which re-reads `this.records` — would then
   * serve a node's proposal as an injectable trusted project fact. Assigning
   * `raw.payload` rewrote the fact itself. Both were reachable through a public
   * port method, and neither the repository's checks nor the record schema could
   * see it, because the mutation happened *after* validation.
   *
   * Freezing closes it at the only place it can be closed: the record that leaves
   * a read is not the record the store holds. A copy also means a caller cannot
   * corrupt the store by accident at all, which is the property an append-only
   * store is supposed to have in the first place.
   *
   * `deepFreeze` is a `JSON.parse`/`stringify` round trip plus a recursive
   * `Object.freeze`. It is the right trade here because the record shapes are
   * plain JSON by construction — the schema is `.strict()` Zod over primitives,
   * arrays, and plain objects — so there is no class instance, `Map`, or `Date`
   * that a JSON round trip would flatten.
   */
  async getRaw(memoryId: string): Promise<MemoryRecordV1 | MemoryRecordV2 | null> {
    await this.ensureLoaded()
    const record = this.records.get(memoryId)
    if (record === undefined) return null
    return deepFreeze(structuralCopy(record)) as MemoryRecordV1 | MemoryRecordV2
  }

  /**
   * A single authorized read.
   *
   * Returns `ok: false` — not `null` — for a record the reader may not have.
   * A `null` would be indistinguishable from "no such record", and a caller
   * that treats the two the same cannot be *shown* to have handled the
   * permission branch.
   *
   * Unlike `query`, this does not apply the *view* switches: a by-id read is a
   * history read. Someone who knows a record's id has already decided they
   * want that record, and the port's own note on `MemoryQuery.memoryIds` says
   * the same — a manifest that has already chosen what it wants must be able to
   * fetch exactly that, including a corrected-then-superseded original. The
   * view's `supersededByMemoryId` still marks it as history.
   */
  async get(memoryId: string, scope: MemoryQueryScope): Promise<Result<MemoryRecordView | null>> {
    await this.ensureLoaded()

    if (this.tombstones.has(memoryId)) {
      return { ok: false, error: tombstonedError(memoryId) }
    }
    const record = this.records.get(memoryId)
    if (record === undefined) return { ok: false, error: unknownRecordError(memoryId) }

    const view = this.viewOf(record)
    const decision = this.policyForRead().decide(view, scope, this.nowValue())
    if (!decision.allowed) {
      return { ok: false, error: notVisibleError(memoryId, decision.reason) }
    }
    return { ok: true, value: view }
  }

  /**
   * The active view of a project, in a total order independent of insertion
   * order, plus every record that existed, matched the filters, and was withheld
   * — each with a reason.
   */
  async query(query: MemoryQuery, scope: MemoryQueryScope): Promise<Result<MemoryQueryResult>> {
    await this.ensureLoaded()

    // The two project ids must agree, and this is the check the M5.9 review
    // found as SF-4. `query.projectId` selects the candidate set and
    // `scope.projectId` is what the access policy compares, so a reader of
    // project A who named project B in the query got project B's *records* as
    // candidates — each refused, each reported as a `project_mismatch`
    // withholding carrying project B's `memoryId`. That is a cross-project
    // existence oracle: a reader could enumerate another project's memory ids by
    // naming it, and learn how many records it holds.
    //
    // It is a **refusal, not an empty result**. An empty `MemoryQueryResult` is
    // what "this project has no matching records" looks like, and returning that
    // for a caller error would make a bug indistinguishable from a fact — which
    // is the same sin as `null`-for-forbidden, one level up. So `query` returns a
    // `Result` like every other method on this port, and the refusal is
    // `validation` / `memory.query_project_mismatch`, kept distinct from
    // `project_mismatch` (`policy_denied`) because it is a caller mistake rather
    // than a permission decision.
    if (query.projectId !== scope.projectId) {
      return {
        ok: false,
        error: queryProjectMismatchError(query.projectId, scope.projectId),
      }
    }

    const policy = this.policyFor(query)
    const now = this.nowValue()
    const liveCandidates = this.liveCandidates(query, scope)
    const tombstoneCandidates = this.tombstoneCandidates(query, scope)

    const kept: { record: MemoryRecordView; createdAtMs: number }[] = []
    const withheld: { withholding: MemoryWithholding; at: number }[] = []

    for (const candidate of tombstoneCandidates) {
      withheld.push({
        withholding: this.tombstoneWithholding(candidate, scope, now),
        at: Date.parse(candidate.deletedAt),
      })
    }

    for (const view of liveCandidates) {
      const decision = policy.decide(view, scope, now)
      if (decision.allowed) {
        kept.push({ record: view, createdAtMs: Date.parse(view.createdAt) })
        continue
      }
      withheld.push({ withholding: toWithholding(view, decision), at: Date.parse(view.createdAt) })
    }

    kept.sort((left, right) => compareOrder(left.createdAtMs, left.record.memoryId, right.createdAtMs, right.record.memoryId))
    withheld.sort((left, right) => compareOrder(left.at, left.withholding.memoryId, right.at, right.withholding.memoryId))

    const limited = query.limit === undefined ? kept : kept.slice(0, Math.max(0, query.limit))
    return {
      ok: true,
      value: { records: limited.map((entry) => entry.record), withheld: withheld.map((entry) => entry.withholding) },
    }
  }

  private policyFor(query: MemoryQuery): ScopeLatticeAccessPolicy {
    return createMemoryAccessPolicy({
      state: this.accessState(),
      includeSuperseded: query.includeSuperseded === true,
      includeExpired: query.includeExpired === true,
    })
  }

  /** The by-id policy: history is readable by id, the view switches do not apply. */
  private policyForRead(): ScopeLatticeAccessPolicy {
    return createMemoryAccessPolicy({ state: this.accessState(), includeSuperseded: true, includeExpired: true })
  }

  /** Records that survived the query's own (non-authorizing) filters. */
  private liveCandidates(query: MemoryQuery, scope: MemoryQueryScope): MemoryRecordView[] {
    const candidates: MemoryRecordView[] = []
    for (const record of this.records.values()) {
      // Project isolation, applied to *candidacy* and not only to the decision:
      // a foreign record must not even become a candidate whose denial is
      // reported back to another project's reader.
      if (record.projectId !== query.projectId) continue
      if (this.tombstones.has(record.memoryId)) continue
      if (!matchesQueryFilters(record, query)) continue
      candidates.push(this.viewOf(record))
    }
    return candidates
  }

  /**
   * Tombstoned records, as withholdings only.
   *
   * They are not candidates for `records` — their content is gone — but a
   * reader that asks for a project's memory is entitled to learn that an id it
   * knows about was deleted, and to learn it as a *withholding* rather than as
   * an absence. What it is entitled to learn about *what was deleted* is a
   * policy question, answered in `tombstoneWithholding`. A tombstone carries no
   * scope, so a run- or task-scoped query cannot place one and gets none.
   */
  private tombstoneCandidates(query: MemoryQuery, _scope: MemoryQueryScope): readonly MemoryTombstone[] {
    if (query.runId !== undefined || query.taskId !== undefined) return []
    const candidates: MemoryTombstone[] = []
    for (const tombstone of this.tombstones.values()) {
      if (tombstone.projectId !== query.projectId) continue
      if (query.memoryIds !== undefined && !query.memoryIds.includes(tombstone.memoryId)) continue
      if (query.kinds !== undefined && !query.kinds.includes(tombstone.kind)) continue
      candidates.push(tombstone)
    }
    return candidates
  }

  /**
   * What a reader is told about a record whose content has been deleted.
   *
   * The M5.9 review found SF-13 here: this path used to bypass the access
   * policy entirely and answer `{ kind, reason: "tombstoned", revealsKind: true }`
   * for every tombstone. So a `prohibited` record — which while it was live
   * answered *every* reader with `prohibited_content` and `revealsKind: false`,
   * with the `kind` key genuinely absent — began naming its kind to every reader
   * of the project the instant it was privacy-deleted. A deletion is a *less*
   * visible state than the record was, never a more visible one.
   *
   * The fix is to ask the same policy the live path asks, rather than to
   * re-decide visibility here: one rule, two call sites, no way for them to
   * disagree. The policy needs four facts a tombstone does not carry, so they
   * are retained in `this.tombstoneAccess` at deletion time and never persisted
   * (`TombstoneAccessFacts` has the reasoning, including the option that was
   * rejected and why).
   *
   * # The `reason` stays `tombstoned`, and only `revealsKind` is policy-driven
   *
   * `tombstoned` is the one fact about a deleted record that is true for every
   * reader in the project, and it is the entire legitimate purpose of a
   * tombstone: "an id you know about was deleted, and here is the proof it
   * existed". Propagating the policy's reason instead — `prohibited_content`,
   * `node_restricted` — would tell an un-cleared or node-restricted-out reader
   * that a record *was classified*, which is the same disclosure
   * `revealsKind: false` exists to prevent, arriving through the `reason`
   * string instead of the `kind` field. A lie about why is also how a reviewer
   * concludes the ACL works when it does not. So the reason states the store's
   * fact, and the policy governs only what may be named.
   *
   * # The disclosure floor
   *
   * `revealsKind` here is the `revealsKind` the *live* record's withholding
   * would have carried for this same reader, so a reader never learns more from
   * a tombstone than from the record. That holds in both directions of the
   * probe's placeholders: the probe view answers `project` scope, `accepted`
   * trust, and no expiry — the most permissive values — so where the live
   * record was denied by one of those steps its `revealsKind` was already
   * `true` (`scope_not_visible`, `not_trusted`, and `expired` all reveal), and
   * the probe can only ever agree or say *less*. Where the live record was
   * denied by sensitivity, redaction, or an allow-list — the four steps whose
   * facts are retained, and the only four whose `revealsKind` is `false` — the
   * probe reaches the same step with the same value and answers the same thing.
   *
   * A reader outside the project is handled by the same policy: a foreign
   * tombstone's probe view carries the foreign `projectId`, so step 1 answers
   * `project_mismatch` with `revealsKind: false`. `tombstoneCandidates` filters
   * foreign tombstones out before this is reached, because a foreign *id* is
   * itself an existence oracle and no reason string makes that safe; the
   * fallback here is defence in depth for a caller or backend that changes
   * that.
   */
  private tombstoneWithholding(tombstone: MemoryTombstone, scope: MemoryQueryScope, now: string): MemoryWithholding {
    const facts = this.tombstoneAccess.get(tombstone.memoryId)
    // No retained facts means no knowledge of how the record was classified, so
    // nothing beyond the id and the fact of deletion is disclosed. See the
    // fallback paragraph in `TombstoneAccessFacts`.
    const revealsKind =
      facts !== undefined && TOMBSTONE_PROBE_POLICY.decide(tombstoneProbeView(tombstone, facts), scope, now).revealsKind
    return {
      memoryId: tombstone.memoryId,
      ...(revealsKind ? { kind: tombstone.kind } : {}),
      reason: "tombstoned",
      revealsKind,
    }
  }

  private viewOf(record: MemoryRecordV1 | MemoryRecordV2): MemoryRecordView {
    const view = toMemoryRecordView(record)
    const supersedingId = this.supersededBy.get(record.memoryId)
    if (supersedingId === undefined) return view
    // The back-reference is *derived*, never written back onto the record: the
    // superseded record's bytes must not change when it is corrected.
    return { ...view, supersededByMemoryId: supersedingId }
  }

  // --- trust --------------------------------------------------------------

  async decideTrust(memoryId: string, decision: TrustDecisionInput): Promise<Result<MemoryRecordV2>> {
    await this.ensureLoaded()
    return this.exclusive(() => this.decideTrustInternal(memoryId, decision))
  }

  private async decideTrustInternal(memoryId: string, decision: TrustDecisionInput): Promise<Result<MemoryRecordV2>> {

    const record = this.records.get(memoryId)
    if (record === undefined) return { ok: false, error: unknownRecordError(memoryId) }
    if (!isMemoryRecordV2(record)) {
      return { ok: false, error: legacyRecordImmutableError(memoryId, "trust-decided in place") }
    }

    // The load-bearing check. A node, session, or system actor cannot mint a
    // trusted project fact, and the refusal changes nothing: the record is
    // returned untouched because it was never written.
    const decidedBy = actorSchema.safeParse(decision.decidedBy)
    if (!decidedBy.success || decidedBy.data.kind !== "user") {
      const kind = decidedBy.success ? decidedBy.data.kind : "unrecognized actor"
      return { ok: false, error: trustDecisionDeniedError(memoryId, kind) }
    }
    if (!canTransitionTrust(record.trust, decision.trust)) {
      return { ok: false, error: illegalTrustTransitionError(memoryId, record.trust, decision.trust) }
    }

    const stored: StoredTrustDecision = {
      memoryId,
      trust: decision.trust,
      decidedBy: decidedBy.data,
      decidedAt: decision.decidedAt,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    }

    let next: MemoryRecordV2
    try {
      next = applyTrustDecision(record, stored)
    } catch (error) {
      return { ok: false, error: recordInvalidError(`the trust decision produced an invalid record for '${memoryId}'`, issuesOf(error)) }
    }

    try {
      await this.storage.insertDecision(stored)
    } catch (error) {
      return { ok: false, error: this.toContractError(error) }
    }

    this.records.set(memoryId, next)
    return { ok: true, value: next }
  }

  // --- tombstone ----------------------------------------------------------

  /**
   * Physical deletion for an explicit retention or privacy operation.
   *
   * Refused unless `authorized` is true *and* the requester is a user. Both
   * conditions, not either: `authorized` alone would be a flag a caller sets on
   * its own behalf, and a user actor alone would let any session that happens to
   * hold a user-shaped actor delete history.
   *
   * What remains is a `MemoryTombstone`: the id, the kind, the time, the
   * requester, the reason, and the content hash. The hash is the whole point —
   * without it, "this record existed and said something" becomes unprovable
   * after a deletion, which turns an audit trail into a rumour. The hash is a
   * one-way digest of content that no longer exists anywhere.
   *
   * The access-relevant facts are captured here, in memory only, on the way out:
   * the deletion destroys the record's bytes, and the tombstone deliberately
   * does not carry its classification, so `query` would otherwise have no way to
   * withhold a deleted `prohibited` record any more than it withholds the live
   * one. See `TombstoneAccessFacts`.
   */
  async tombstone(request: TombstoneRequest): Promise<Result<MemoryTombstone>> {
    await this.ensureLoaded()
    return this.exclusive(() => this.tombstoneInternal(request))
  }

  private async tombstoneInternal(request: TombstoneRequest): Promise<Result<MemoryTombstone>> {
    if (request.authorized !== true) {
      return { ok: false, error: tombstoneUnauthorizedError(request.memoryId, "authorized was not true") }
    }
    const requestedBy = actorSchema.safeParse(request.requestedBy)
    if (!requestedBy.success || requestedBy.data.kind !== "user") {
      const kind = requestedBy.success ? requestedBy.data.kind : "unrecognized actor"
      return { ok: false, error: tombstoneUnauthorizedError(request.memoryId, `the requester is a '${kind}', not a user`) }
    }
    const reason = request.reason.trim()
    if (reason.length < 1 || reason.length > 1024) {
      return { ok: false, error: invalidTombstoneReasonError("reason must be 1..1024 characters") }
    }
    if (!Number.isFinite(Date.parse(request.requestedAt))) {
      return { ok: false, error: invalidTombstoneReasonError("requestedAt is not a parseable timestamp") }
    }

    const existing = this.tombstones.get(request.memoryId)
    if (existing !== undefined) {
      return { ok: false, error: alreadyTombstonedError(request.memoryId, existing.deletedAt) }
    }

    const record = this.records.get(request.memoryId)
    if (record === undefined) return { ok: false, error: unknownRecordError(request.memoryId) }
    if (record.projectId !== request.projectId) {
      return { ok: false, error: projectMismatchError(request.memoryId, request.projectId) }
    }

    const tombstone: MemoryTombstone = {
      schemaVersion: 1,
      memoryId: record.memoryId,
      projectId: record.projectId,
      kind: record.kind,
      // Retained deliberately: after a privacy deletion this is the only
      // remaining proof that the record existed and said something, and it is a
      // one-way digest of content that no longer exists anywhere.
      contentHash: isMemoryRecordV2(record) ? record.contentHash : record.contentDigest,
      deletedAt: request.requestedAt,
      deletedBy: requestedBy.data,
      reason,
      nonSensitive: true,
    }

    try {
      await this.storage.insertTombstone(tombstone)
      await this.storage.eraseContent(request.memoryId)
    } catch (error) {
      return { ok: false, error: this.toContractError(error) }
    }

    this.tombstones.set(tombstone.memoryId, tombstone)
    this.tombstoneAccess.set(tombstone.memoryId, tombstoneAccessFactsOf(this.viewOf(record)))
    this.records.delete(request.memoryId)
    return { ok: true, value: tombstone }
  }

  async listTombstonesUnscoped(projectId: string): Promise<readonly MemoryTombstone[]> {
    await this.ensureLoaded()
    return [...this.tombstones.values()]
      .filter((tombstone) => tombstone.projectId === projectId)
      .sort((left, right) => compareOrder(Date.parse(left.deletedAt), left.memoryId, Date.parse(right.deletedAt), right.memoryId))
  }

  /**
   * Every record in a project, **unauthorized**, for the migration and export
   * paths only.
   *
   * This method is a deliberate hole in the access model and it is named
   * `listProjectUnscoped` rather than `listProject` so that a caller reaching for
   * "list this project's memory" finds `query` instead. The M5.9 review found it
   * as SF-2: under the old name, with no `scope` parameter, it returned
   * node-restricted, role-restricted, `restricted`, and `prohibited` bodies with
   * full content to anyone who could name a project id.
   *
   * It cannot be made safe, only conspicuous: an export has to be able to
   * produce a project archive, and a method that respects every reader's
   * clearance cannot produce one. So it is unscoped, loudly named, documented as
   * the migration/export path, and its results are deep-frozen copies like
   * `getRaw`'s — a caller that mutates an export cannot corrupt the store.
   *
   * Anything user-facing goes through `query`, which returns records *and* the
   * withheld reasons, so an omission is explainable.
   */
  async listProjectUnscoped(projectId: string): Promise<readonly (MemoryRecordV1 | MemoryRecordV2)[]> {
    await this.ensureLoaded()
    return [...this.records.values()]
      .filter((record) => record.projectId === projectId)
      .map((record) => deepFreeze(structuralCopy(record)) as MemoryRecordV1 | MemoryRecordV2)
  }

  /** Normalise anything thrown by a storage adapter into a `ContractError`. */
  protected toContractError(error: unknown): ContractError {
    if (error instanceof MemoryCorruptStoreError) return error.toContractError()
    if (isContractError(error)) return error
    const converted = (error as { toContractError?: () => ContractError } | undefined)?.toContractError?.()
    if (converted !== undefined) return converted
    const message = error instanceof Error ? error.message : String(error)
    return { schemaVersion: 1, category: "internal_failure", code: "memory.storage_failure", message: message.slice(0, 4096), retryable: false }
  }
}

function isContractError(value: unknown): value is ContractError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "category" in value &&
    "message" in value
  )
}

function issuesOf(error: unknown): { path: string; message: string }[] {
  const issues = (error as { issues?: { path?: (string | number | symbol)[]; message?: string }[] })?.issues
  if (!Array.isArray(issues)) return []
  return issues.slice(0, 16).map((issue) => ({
    path: (issue.path ?? []).map(String).join("."),
    message: issue.message ?? "invalid",
  }))
}

/** Total order: timestamp first, then id. A tie on time is broken deterministically. */
function compareOrder(leftMs: number, leftId: string, rightMs: number, rightId: string): number {
  const left = Number.isFinite(leftMs) ? leftMs : Number.MAX_SAFE_INTEGER
  const right = Number.isFinite(rightMs) ? rightMs : Number.MAX_SAFE_INTEGER
  if (left !== right) return left - right
  if (leftId === rightId) return 0
  return leftId < rightId ? -1 : 1
}

/**
 * The access-relevant facts of a record whose content has been deleted.
 *
 * Four fields, taken from the *same* projection the live read path uses
 * (`viewOf` -> `toMemoryRecordView`), so the probe below cannot disagree with
 * the live decision about the only steps that can answer `revealsKind: false`:
 * sensitivity, redaction prohibition, and the two allow-lists.
 *
 * ## Why this is not a field on the tombstone
 *
 * `MemoryTombstone` is a frozen port shape (`src/memory/ports.ts`) that carries
 * only non-sensitive facts — id, project, kind, hash, time, requester, reason —
 * and it is right that it does. SF-13 was caused by the gap: the tombstone path
 * could not tell a `prohibited` record from a `public_to_project` one, so it
 * answered `revealsKind: true` for both, and a record that disclosed nothing to
 * anybody while it was live disclosed its kind to every reader of the project
 * once it was privacy-deleted. A deletion must never increase what is
 * disclosed.
 *
 * Two ways to close the gap, and this is the second:
 *
 * 1. **Put the facts on the tombstone.** Rejected. It needs a re-approval of the
 *    frozen `src/memory/ports.ts` *and* a matching change to the `.strict()`
 *    `memoryTombstoneSchema` in `src/memory/file-repository.ts`, which is not
 *    this file's to change. More substantively, it writes "this deleted record
 *    was `restricted`, and node-restricted to these two ids" into durable
 *    storage as a side effect of a *privacy deletion*: an operator reading
 *    `index.json` could enumerate which deletions were of classified records,
 *    which is a disclosure the live record's own withholding refused to make.
 *    The deletion would create the record of its own secrecy.
 * 2. **Retain the facts in the process that performed the deletion and ask the
 *    same policy the live path asks.** Chosen. The rule stays in
 *    `access-policy.ts` — one implementation, so the two paths cannot drift —
 *    and these facts never reach a storage adapter, never appear in a read
 *    result, and never outlive the process.
 *
 * ## What is lost, and why losing it is the right way round
 *
 * A tombstone this process did not delete — one loaded from a durable store, or
 * written by a process that has since exited — has no entry here, and the answer
 * becomes the most conservative one available: the id, `reason: "tombstoned"`,
 * and no `kind`. That is an availability cost, paid once per restart, on an
 * audit view rather than on a read anyone is cleared for. The alternative costs
 * a disclosure on every read, forever, of the exact fact `revealsKind: false`
 * exists to withhold. `tests/unit/memory/repository.test.ts` asserts the
 * fallback explicitly, so it cannot be quietly turned back into an allow.
 */
interface TombstoneAccessFacts {
  readonly sensitivity: Sensitivity
  /** The full status, not just "was it prohibited": the policy reads the value. */
  readonly redactionStatus: RedactionStatus
  readonly visibleToNodeIds?: readonly string[]
  readonly visibleToRoleIds?: readonly string[]
}

/** Read the four facts off a view, so the probe cannot disagree with the live read. */
function tombstoneAccessFactsOf(view: MemoryRecordView): TombstoneAccessFacts {
  return {
    sensitivity: view.sensitivity,
    redactionStatus: view.redaction.status,
    visibleToNodeIds: view.visibleToNodeIds,
    visibleToRoleIds: view.visibleToRoleIds,
  }
}

/** The most permissive scope, for a probe whose scope identity was deliberately not retained. */
const TOMBSTONE_PROBE_SCOPE: MemoryScope = memoryScopeSchemaV2.parse({ kind: "project" })

/** A placeholder author, so a probe can never be mistaken for a real record's provenance. */
const TOMBSTONE_PROBE_AUTHOR: Actor = { kind: "system", name: "memory.tombstone_probe" }

/**
 * The policy the tombstone path asks, which is *not* the query's policy.
 *
 * Two deliberate differences. Its state reports the id as neither tombstoned nor
 * superseded, because the question is not "may this reader have the record" but
 * "would this reader's withholding of the record have been allowed to name its
 * kind" — and a policy that short-circuits on `isTombstoned` (step 2) answers
 * only `revealsContent`, which is a question about sensitivity alone and is
 * exactly how a `restricted` record's kind would leak. And its view switches are
 * both on, so the answer is not a function of which view the caller asked for:
 * `superseded` and `expired` both reveal the kind, so switching them off could
 * only ever change the reason.
 */
const TOMBSTONE_PROBE_POLICY = createMemoryAccessPolicy({
  state: { isTombstoned: () => false, isSuperseded: () => false },
  includeSuperseded: true,
  includeExpired: true,
})

/**
 * A complete `MemoryRecordView` assembled from a tombstone and its retained
 * facts, for the policy to decide on.
 *
 * The shape is filled in rather than cast, because a cast would leave the
 * fields the policy does not currently read as `undefined`, and a future step
 * that read one of them would then get a different answer from the live path in
 * whichever direction `undefined` happened to fall. Every field here is
 * therefore either a fact (the id, project, kind, hash, time, and the four
 * retained facts) or a placeholder chosen to be the *most permissive* value the
 * field allows — `project` scope, `accepted` trust, no expiry, no supersession —
 * so the probe can only ever disclose as much as the live decision did, or
 * less. The content fields are empty because the content is gone: that is the
 * entire point of a tombstone, and this object never leaves
 * `tombstoneWithholding`.
 */
function tombstoneProbeView(tombstone: MemoryTombstone, facts: TombstoneAccessFacts): MemoryRecordView {
  return {
    memoryId: tombstone.memoryId,
    projectId: tombstone.projectId,
    kind: tombstone.kind,
    scope: TOMBSTONE_PROBE_SCOPE,
    author: TOMBSTONE_PROBE_AUTHOR,
    createdAt: tombstone.deletedAt,
    content: "",
    contentHash: tombstone.contentHash,
    trust: "accepted",
    sensitivity: facts.sensitivity,
    retention: "project",
    ...(facts.visibleToNodeIds === undefined ? {} : { visibleToNodeIds: facts.visibleToNodeIds }),
    ...(facts.visibleToRoleIds === undefined ? {} : { visibleToRoleIds: facts.visibleToRoleIds }),
    redaction: { status: facts.redactionStatus },
    sourceReferences: [],
    payload: { content: "" },
    sourceVersion: 1,
  }
}

function supersedesIdOf(record: MemoryRecordV1 | MemoryRecordV2): string | undefined {
  return record.supersedesMemoryId
}

/** Two actors are the same actor when every field of the discriminated union matches. */
function isSameActor(left: Actor, right: Actor): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case "user":
      return left.userId === (right as typeof left).userId
    case "node":
      return left.nodeId === (right as typeof left).nodeId
    case "session":
      return left.sessionId === (right as typeof left).sessionId
    case "system":
      return left.name === (right as typeof left).name
  }
}

/** A safe description of an actor for an error message. Never anything else. */
function describeActor(actor: Actor): string {
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

/** Does a record match the query's own filters? Authorization is not this function's job. */
function matchesQueryFilters(record: MemoryRecordV1 | MemoryRecordV2, query: MemoryQuery): boolean {
  if (query.memoryIds !== undefined && !query.memoryIds.includes(record.memoryId)) return false
  if (query.kinds !== undefined && !query.kinds.includes(record.kind)) return false

  const trust = isMemoryRecordV2(record) ? record.trust : record.trustState
  if (query.trustStates !== undefined && !query.trustStates.includes(trust)) return false

  if (query.runId !== undefined) {
    const runId = scopeRunIdOf(record)
    if (runId !== undefined && runId !== query.runId) return false
  }
  if (query.taskId !== undefined) {
    const taskId = taskIdOf(record)
    if (taskId !== undefined && taskId !== query.taskId) return false
  }
  return true
}

function scopeRunIdOf(record: MemoryRecordV1 | MemoryRecordV2): string | undefined {
  return record.scope.kind === "project" ? undefined : record.scope.runId
}

function taskIdOf(record: MemoryRecordV1 | MemoryRecordV2): string | undefined {
  return record.scope.kind === "project" || record.scope.kind === "run" ? undefined : record.scope.taskId
}

/**
 * Apply a trust decision to a record.
 *
 * This is the one place the repository writes over a stored record, and the
 * reason it is safe is in `computeContentHash`: the hash covers kind, scope,
 * and payload, and *not* trust. A trust decision changes what may be done with
 * a fact, not what the fact is, so the identity of the fact survives the
 * decision. Supersession is the opposite case and appends a new record instead
 * of writing over anything.
 */
function applyTrustDecision(record: MemoryRecordV2, decision: StoredTrustDecision): MemoryRecordV2 {
  return memoryRecordSchemaV2.parse({
    ...record,
    trust: decision.trust,
    trustDecision: {
      decidedBy: decision.decidedBy,
      decidedAt: decision.decidedAt,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    },
  })
}

/** An in-memory `MemoryStorage`. The default backend for tests and the assembler. */
export class InMemoryMemoryStorage implements MemoryStorage {
  readonly records: (MemoryRecordV1 | MemoryRecordV2)[] = []
  readonly decisions: StoredTrustDecision[] = []
  readonly tombstones: MemoryTombstone[] = []

  async load(): Promise<MemoryStorageSnapshot> {
    return { records: [...this.records], decisions: [...this.decisions], tombstones: [...this.tombstones] }
  }

  async insertRecords(records: readonly MemoryRecordV2[]): Promise<void> {
    this.records.push(...records)
  }

  async insertDecision(decision: StoredTrustDecision): Promise<void> {
    this.decisions.push(decision)
  }

  async insertTombstone(tombstone: MemoryTombstone): Promise<void> {
    this.tombstones.push(tombstone)
  }

  async eraseContent(memoryId: string): Promise<void> {
    const index = this.records.findIndex((record) => record.memoryId === memoryId)
    if (index >= 0) this.records.splice(index, 1)
  }
}

/** The in-memory `MemoryRepository`. No I/O, no clock, fully deterministic. */
export class InMemoryMemoryRepository extends MemoryRepositoryEngine {
  constructor(options: MemoryRepositoryOptions, storage: MemoryStorage = new InMemoryMemoryStorage()) {
    super(storage, options)
  }
}

export { applyTrustDecision }
