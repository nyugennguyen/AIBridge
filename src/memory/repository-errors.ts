/**
 * M5.2 — the memory repository's error vocabulary.
 *
 * Every refusal a memory repository can express is named here, once, as a
 * `ContractError` code. Three rules, each load-bearing:
 *
 * 1. **A refusal is a value.** The repository returns `Result<T>`; it does not
 *    throw for a condition a caller can act on. `MemoryCorruptStoreError` is
 *    the single exception and it is deliberate: an unreadable store is not a
 *    condition a caller can branch on and continue from, it is a broken
 *    invariant that must stop the process loudly (see its docblock).
 * 2. **One code per condition, never a message per call site.** A caller
 *    switches on `error.code`, so a code that is spelled differently in two
 *    places is two conditions as far as any caller is concerned.
 * 3. **Codes are contract values.** `MEMORY_ERROR_CODES` is `as const` and
 *    every code matches the `ContractError` pattern
 *    (`/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`) — asserted at runtime by
 *    `isContractErrorCode` and by
 *    `tests/unit/memory/repository.test.ts`, because a code that fails the
 *    frozen M0 pattern is rejected by `createContractError` itself and would
 *    otherwise surface as a thrown Zod error from inside error *construction*.
 */

import { createContractError, type ContractError, type ErrorCategory } from "../orchestration/errors.js"

/** Every `ContractError.code` the memory repository can produce. */
export const MEMORY_ERROR_CODES = {
  /** `append`/`appendAll` derived an id that is already stored. */
  duplicateId: "memory.duplicate_id",
  /** `supersedesMemoryId` names a record this store does not hold. */
  unknownSupersession: "memory.unknown_supersession",
  /** A correction tried to replace a record belonging to another project. */
  crossProjectSupersession: "memory.cross_project_supersession",
  /** The named id exists in another project, or nowhere. */
  projectMismatch: "memory.project_mismatch",
  /**
   * `query.projectId` disagreed with the querying scope's `projectId`.
   *
   * A *caller* error, not a permission decision, and kept as its own code for
   * exactly that reason: the M5.9 review found that a mismatched pair selected
   * the other project's records as candidates and reported each as a
   * `project_mismatch` withholding carrying its foreign `memoryId`, which is a
   * cross-project existence oracle. Answering with this refusal instead means
   * the reader learns that the two arguments disagree and nothing else.
   */
  queryProjectMismatch: "memory.query_project_mismatch",
  /** The named id is not in the store at all. */
  unknownRecord: "memory.unknown_record",
  /** A `MemoryRecordView` the reader may not have, with the reason named. */
  notVisible: "memory.not_visible",
  /** The record was physically deleted; only its tombstone remains. */
  tombstoned: "memory.tombstoned",
  /** The input does not satisfy `memoryRecordSchemaV2`. */
  recordInvalid: "memory.record_invalid",
  /** A trust decision was attempted by something other than a user. */
  trustDecisionDenied: "memory.trust_decision_denied",
  /** `canTransitionTrust` refuses the move. */
  illegalTrustTransition: "memory.illegal_trust_transition",
  /** `tombstone` without `authorized` or without a user requester. */
  tombstoneUnauthorized: "memory.tombstone_unauthorized",
  /** `tombstone` of an id that already has a tombstone. */
  alreadyTombstoned: "memory.already_tombstoned",
  /** A tombstone request with an empty, oversized, or missing reason. */
  invalidTombstoneReason: "memory.invalid_tombstone_reason",
  /** A v1 (legacy) record cannot be superseded or trust-decided in place. */
  legacyRecordImmutable: "memory.legacy_record_immutable",
  /** `appendAll` refused; nothing from the batch was written. */
  atomicAppendRefused: "memory.atomic_append_refused",
  /** The on-disk store is unreadable: a bad line, a duplicate id, a dangling decision. */
  storeCorrupt: "memory.store_corrupt",
  /** The on-disk store could not be read or written. Retryable. */
  storeIo: "memory.store_io",
  /** An injected value failed the repository's own invariants. */
  invalidConfiguration: "memory.invalid_configuration",
} as const

export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[keyof typeof MEMORY_ERROR_CODES]

const CONTRACT_ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/**
 * Does `code` satisfy the frozen `ContractError` code pattern?
 *
 * Exported so the assertion is testable without reaching into this module's
 * internals: the codes are contract surface, and a test that greps for
 * `Date.now` is no more valuable than one that greps for an illegal code.
 */
export function isContractErrorCode(code: string): boolean {
  return CONTRACT_ERROR_CODE_PATTERN.test(code)
}

/** Assert the whole table at module load, once, rather than per call site. */
function assertCodesAreContractCodes(): void {
  for (const code of Object.values(MEMORY_ERROR_CODES)) {
    if (!isContractErrorCode(code)) {
      throw new Error(`memory: error code '${code}' does not satisfy the ContractError code pattern`)
    }
  }
}
assertCodesAreContractCodes()

export function memoryContractError(
  category: ErrorCategory,
  code: MemoryErrorCode,
  message: string,
  correlationId?: string,
): ContractError {
  // `memory.store_io` is the only retryable code here: a transient filesystem
  // failure is the single memory condition a caller may usefully retry, and
  // every other refusal is a fact about the request, not about the moment.
  const retryable = code === MEMORY_ERROR_CODES.storeIo
  return createContractError(category, code, message.slice(0, 4096), retryable, correlationId)
}

export function duplicateIdError(memoryId: string, correlationId?: string): ContractError {
  return memoryContractError(
    "conflict",
    MEMORY_ERROR_CODES.duplicateId,
    `A memory record with id '${memoryId}' is already stored. Memory records are append-only and identified by their derived content id, so an identical append is refused rather than duplicated.`,
    correlationId,
  )
}

export function unknownSupersessionError(memoryId: string, correlationId?: string): ContractError {
  return memoryContractError(
    "validation",
    MEMORY_ERROR_CODES.unknownSupersession,
    `A correction cannot supersede '${memoryId}': no such record is stored, or it has been tombstoned. A supersession must name a record this store still holds.`,
    correlationId,
  )
}

export function crossProjectSupersessionError(
  memoryId: string,
  targetProjectId: string,
  attemptedProjectId: string,
  correlationId?: string,
): ContractError {
  return memoryContractError(
    "policy_denied",
    MEMORY_ERROR_CODES.crossProjectSupersession,
    `A record in project '${attemptedProjectId}' cannot supersede '${memoryId}', which belongs to project '${targetProjectId}'. Supersession is a correction within one project's history and is never a cross-project write.`,
    correlationId,
  )
}

export function projectMismatchError(memoryId: string, attemptedProjectId: string, correlationId?: string): ContractError {
  return memoryContractError(
    "policy_denied",
    MEMORY_ERROR_CODES.projectMismatch,
    `Memory record '${memoryId}' does not belong to project '${attemptedProjectId}'. Nothing about the other project's record is returned.`,
    correlationId,
  )
}

/**
 * A `query` whose two project ids disagree.
 *
 * The message names both projects, because the caller supplied both and the
 * caller is who has to fix it — this is a bug report, not a permission decision.
 * It names nothing about either project's *records*, which is the whole point:
 * the previous behaviour answered with one `project_mismatch` withholding per
 * foreign record, so the message count was a function of how many records the
 * other project held.
 */
export function queryProjectMismatchError(
  queryProjectId: string,
  scopeProjectId: string,
  correlationId?: string,
): ContractError {
  return memoryContractError(
    "validation",
    MEMORY_ERROR_CODES.queryProjectMismatch,
    `The query names project '${queryProjectId}' but the querying scope is scoped to '${scopeProjectId}'. A query and its scope must name the same project; the query is refused before any record is selected.`,
    correlationId,
  )
}

export function unknownRecordError(memoryId: string, correlationId?: string): ContractError {
  return memoryContractError(
    "validation",
    MEMORY_ERROR_CODES.unknownRecord,
    `No memory record with id '${memoryId}' is stored.`,
    correlationId,
  )
}

export function notVisibleError(
  memoryId: string,
  reason: string,
  correlationId?: string,
): ContractError {
  return memoryContractError(
    "policy_denied",
    MEMORY_ERROR_CODES.notVisible,
    `Memory record '${memoryId}' is not readable by this reader: ${reason}. Use query() to obtain the record together with the withholding reason.`,
    correlationId,
  )
}

export function tombstonedError(memoryId: string, correlationId?: string): ContractError {
  return memoryContractError(
    "policy_denied",
    MEMORY_ERROR_CODES.tombstoned,
    `Memory record '${memoryId}' was physically deleted; only its non-sensitive tombstone remains.`,
    correlationId,
  )
}

export function recordInvalidError(
  detail: string,
  issues: readonly { path: string; message: string }[],
  correlationId?: string,
): ContractError {
  return memoryContractError(
    "validation",
    MEMORY_ERROR_CODES.recordInvalid,
    `The memory record was refused: ${detail}${
      issues.length > 0 ? ` (${issues.slice(0, 8).map((issue) => `${issue.path || "root"}: ${issue.message}`).join("; ")})` : ""
    }`,
    correlationId,
  )
}

export function trustDecisionDeniedError(memoryId: string, decidedByKind: string, correlationId?: string): ContractError {
  return memoryContractError(
    "policy_denied",
    MEMORY_ERROR_CODES.trustDecisionDenied,
    `A '${decidedByKind}' may not decide trust for memory record '${memoryId}'. Only a user may accept or reject a record; a node, session, or system actor cannot mint a trusted project fact, and the record is left exactly as it was.`,
    correlationId,
  )
}

export function illegalTrustTransitionError(
  memoryId: string,
  from: string,
  to: string,
  correlationId?: string,
): ContractError {
  return memoryContractError(
    "conflict",
    MEMORY_ERROR_CODES.illegalTrustTransition,
    `Memory record '${memoryId}' cannot move from trust '${from}' to '${to}'. Only a proposed record may be accepted or rejected.`,
    correlationId,
  )
}

export function tombstoneUnauthorizedError(memoryId: string, detail: string, correlationId?: string): ContractError {
  return memoryContractError(
    "policy_denied",
    MEMORY_ERROR_CODES.tombstoneUnauthorized,
    `Memory record '${memoryId}' was not deleted: ${detail}. A physical deletion requires an authorized request from a user.`,
    correlationId,
  )
}

export function alreadyTombstonedError(memoryId: string, deletedAt: string, correlationId?: string): ContractError {
  return memoryContractError(
    "conflict",
    MEMORY_ERROR_CODES.alreadyTombstoned,
    `Memory record '${memoryId}' already has a tombstone (deleted at ${deletedAt}). Deleting it twice would rewrite history rather than remove it.`,
    correlationId,
  )
}

export function invalidTombstoneReasonError(detail: string, correlationId?: string): ContractError {
  return memoryContractError(
    "validation",
    MEMORY_ERROR_CODES.invalidTombstoneReason,
    `The tombstone request is refused: ${detail}. A deletion with no stated reason is not auditable, so the reason is required (1..1024 characters).`,
    correlationId,
  )
}

export function legacyRecordImmutableError(memoryId: string, operation: string, correlationId?: string): ContractError {
  return memoryContractError(
    "validation",
    MEMORY_ERROR_CODES.legacyRecordImmutable,
    `Memory record '${memoryId}' is stored at schema version 1 and cannot be ${operation}. Legacy records are read-only history: project a corrected or re-trusted record as version 2 instead of mutating the imported original.`,
    correlationId,
  )
}

export function atomicAppendRefusedError(detail: string, correlationId?: string): ContractError {
  return memoryContractError(
    "validation",
    MEMORY_ERROR_CODES.atomicAppendRefused,
    `The batch append was refused and nothing from it was written: ${detail}`,
    correlationId,
  )
}

export function invalidConfigurationError(detail: string): ContractError {
  return memoryContractError("validation", MEMORY_ERROR_CODES.invalidConfiguration, detail)
}

export function storeIoError(path: string, cause: unknown): ContractError {
  const message = cause instanceof Error ? cause.message : String(cause)
  return memoryContractError(
    "runtime_failure",
    MEMORY_ERROR_CODES.storeIo,
    `The memory store at '${path}' could not be read or written: ${message}`,
  )
}

/**
 * The store's bytes are not readable, and that is not a caller error.
 *
 * Thrown rather than returned for two reasons that the milestone plan treats as
 * stop conditions. A partially written trailing line is the case that matters:
 * a JSONL log whose last line is truncated means the process died mid-append,
 * and "skip the line that does not parse" is how a half-written memory record
 * becomes an invisible one — the store would then report a clean, shorter
 * history and every reader downstream would believe it. So the line is refused
 * and named (`file`, `line`), and the file is left exactly as found for an
 * operator or the migration to inspect.
 *
 * The same class carries the other structural failures: a duplicate
 * `memoryId` (two records claiming one identity), a trust decision naming a
 * record that is neither present nor tombstoned, and an unparseable
 * `index.json`.
 */
export class MemoryCorruptStoreError extends Error {
  readonly file: string
  /** 1-based line number when the failure is a single line, else `undefined`. */
  readonly line: number | undefined
  readonly cause: unknown

  constructor(input: { file: string; line?: number; detail: string; cause?: unknown }) {
    super(
      `The memory store is corrupt at ${input.file}${input.line === undefined ? "" : ` line ${input.line}`}: ${input.detail}. The store refuses to load rather than silently dropping unreadable history; the file has not been modified.`,
    )
    this.name = "MemoryCorruptStoreError"
    this.file = input.file
    this.line = input.line
    this.cause = input.cause
  }

  toContractError(): ContractError {
    return memoryContractError(
      "runtime_failure",
      MEMORY_ERROR_CODES.storeCorrupt,
      `memory: ${this.message.slice(0, 4000)}`,
    )
  }
}
