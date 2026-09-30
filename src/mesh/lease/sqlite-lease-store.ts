import type { SqliteDriver } from "../../orchestration/event-store/sqlite-driver.js"
import { createContractError, type Result } from "../../orchestration/errors.js"
import type { SqliteStatement } from "../../orchestration/event-store/sqlite-driver.js"
import {
  CAS_UPSERT_ACTIVE_LEASE_SQL,
  INSERT_LEASE_HISTORY_SQL,
  SELECT_ACTIVE_LEASE_SQL,
  SELECT_LEASE_HISTORY_SQL,
  type MeshLeaseActiveRow,
  type MeshLeaseHistoryRow,
} from "./migrations.js"
import { leaseHistoryEntrySchema, parseLeaseRecord, unreadableLeaseRecord, type LeaseHistoryEntry, type LeaseRecord, type LeaseScope } from "./schemas.js"
import { describeStoreError, storeUnavailable } from "./memory-lease-store.js"
import type { ControllerLeaseStore, LeaseWrite, LeaseWriteOutcome } from "./types.js"

/**
 * THIS MODULE IS ALLOWED TO TOUCH STORAGE, together with `./migrations.js` and
 * nothing else in `src/mesh/lease/`. The driver is INJECTED rather than opened
 * here, which is not a test convenience: it is what makes the durability the tests
 * exercise the same durability production runs on, rather than a second in-memory
 * path that is "basically the same" until the day the transactions differ.
 *
 * Four properties this file exists to guarantee, each stated as a test in
 * `lease-store.test.ts`:
 *
 *   1. **The write is a compare-and-set on the epoch.** The check sits in the
 *      `ON CONFLICT ... DO UPDATE ... WHERE` guard, so two controllers racing to
 *      take over from the same epoch cannot both pass a check each performed
 *      against its own stale read. This is the property the split-brain model
 *      test bottoms out in.
 *   2. **The active row and its history row are ONE write.** Both go in one
 *      transaction, so the audit trail can never be missing the record that is
 *      currently in force. A takeover that supersedes a lease the audit does not
 *      record is an unfalsifiable fence.
 *   3. **A redelivered lease record converges.** `INSERT OR IGNORE` on the
 *      history, and the compare-and-set is idempotent for a record that was
 *      already applied.
 *   4. **Rows are untrusted on read.** Every row is re-validated through
 *      `parseLeaseRecord`. "Trust the shape you wrote" is how a downgrade becomes
 *      permanent the first time two builds of this controller meet on one file.
 */

function refusal(code: string, message: string): { ok: false; error: ReturnType<typeof createContractError> } {
  return { ok: false, error: createContractError("policy_denied", code, message) }
}

function describeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")
}

/**
 * Decodes the two JSON list columns.
 *
 * A column this build did not write, or one truncated by a crash mid-write, is
 * not something to guess at — so a decode failure refuses the ROW rather than
 * yielding an empty list. An empty list here means "the user was shown nothing",
 * which is the one value the takeover guard must never read out of a broken
 * column.
 */
function decodeNodeIdList(value: string, column: string, leaseId: string): Result<string[]> {
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch {
    return {
      ok: false,
      error: unreadableLeaseRecord(
        `${column} for lease '${leaseId}' is not valid JSON. It is refused rather than repaired, because the empty list is exactly the value that would make a takeover's user-inspection precondition vacuous.`,
      ),
    }
  }
  if (!Array.isArray(decoded) || decoded.some((entry) => typeof entry !== "string")) {
    return {
      ok: false,
      error: unreadableLeaseRecord(
        `${column} for lease '${leaseId}' is not a JSON array of strings. Reading it as an empty list would silently convert a corrupt row into "the user acknowledged nothing", which is the reading the takeover guard treats as proof of inspection.`,
      ),
    }
  }
  return { ok: true, value: decoded as string[] }
}

function mapActiveRow(row: MeshLeaseActiveRow): Result<LeaseRecord> {
  const acknowledged = decodeNodeIdList(row.acknowledged_unreconciled_node_ids, "acknowledged_unreconciled_node_ids", row.lease_id)
  if (!acknowledged.ok) return acknowledged as Result<LeaseRecord>
  const unreconciled = decodeNodeIdList(row.unreconciled_node_ids, "unreconciled_node_ids", row.lease_id)
  if (!unreconciled.ok) return unreconciled as Result<LeaseRecord>

  return parseLeaseRecord({
    schemaVersion: row.schema_version,
    leaseId: row.lease_id,
    projectId: row.project_id,
    runId: row.run_id,
    controllerNodeId: row.controller_node_id,
    epoch: row.epoch,
    operation: row.operation,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    durationSeconds: row.duration_seconds,
    predecessorLeaseId: row.predecessor_lease_id,
    predecessorEpoch: row.predecessor_epoch,
    takeoverReason: row.takeover_reason,
    acknowledgedUnreconciledNodeIds: acknowledged.value,
    unreconciledNodeIds: unreconciled.value,
    recordedAt: row.recorded_at,
  })
}

function mapHistoryRow(row: MeshLeaseHistoryRow): Result<LeaseHistoryEntry> {
  const parsed = leaseHistoryEntrySchema.safeParse({
    leaseId: row.lease_id,
    projectId: row.project_id,
    runId: row.run_id,
    controllerNodeId: row.controller_node_id,
    epoch: row.epoch,
    operation: row.operation,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    recordedAt: row.recorded_at,
  })
  if (!parsed.success) {
    return {
      ok: false,
      error: unreadableLeaseRecord(
        `A stored lease history row for lease '${row.lease_id}' does not satisfy leaseHistoryEntrySchema (${describeIssues(parsed.error.issues)}). The audit trail is refused rather than partially reported, because a takeover response with a hole in its history is the one thing an auditor cannot detect.`,
      ),
    }
  }
  return { ok: true, value: Object.freeze(parsed.data) }
}

export class SqliteControllerLeaseStore implements ControllerLeaseStore {
  readonly #driver: SqliteDriver
  readonly #activeStatement: SqliteStatement<MeshLeaseActiveRow>
  readonly #historyStatement: SqliteStatement<MeshLeaseHistoryRow>
  readonly #casStatement: SqliteStatement
  readonly #insertHistoryStatement: SqliteStatement

  constructor(driver: SqliteDriver) {
    this.#driver = driver
    this.#activeStatement = driver.prepare<MeshLeaseActiveRow>(SELECT_ACTIVE_LEASE_SQL)
    this.#historyStatement = driver.prepare<MeshLeaseHistoryRow>(SELECT_LEASE_HISTORY_SQL)
    this.#casStatement = driver.prepare(CAS_UPSERT_ACTIVE_LEASE_SQL)
    this.#insertHistoryStatement = driver.prepare(INSERT_LEASE_HISTORY_SQL)
  }

  /** Exposed so a structural test can read the physical columns. */
  get driver(): SqliteDriver {
    return this.#driver
  }

  async activeLease(scope: LeaseScope): Promise<Result<LeaseRecord | null>> {
    try {
      const row = this.#activeStatement.get(scope.projectId, scope.runId)
      if (row === undefined) return { ok: true, value: null }
      return mapActiveRow(row)
    } catch (error) {
      return storeUnavailable(describeStoreError(error))
    }
  }

  async writeLease(write: LeaseWrite): Promise<Result<LeaseWriteOutcome>> {
    // The record is validated BEFORE the transaction opens, for the same reason a
    // wire record is validated before anything touches storage: a row written
    // from a record the build's own schema refuses is a row the next boot has to
    // refuse, and the operator gets to find out through an outage rather than a
    // log line.
    const parsed = parseLeaseRecord(write.record)
    if (!parsed.ok) return parsed as Result<LeaseWriteOutcome>
    const record = parsed.value
    if (record.projectId !== write.scope.projectId || record.runId !== write.scope.runId) {
      return refusal(
        "lease.store_scope_mismatch",
        `The record's scope (${record.projectId}/${record.runId}) does not match the scope it is written under (${write.scope.projectId}/${write.scope.runId}). A lease filed under a run it does not cover is a lease that fences the wrong run.`,
      )
    }

    try {
      return this.#driver.transaction((): Result<LeaseWriteOutcome> => {
        const changes = this.#casStatement.run(
          record.projectId,
          record.runId,
          record.leaseId,
          record.controllerNodeId,
          record.epoch,
          record.operation,
          record.issuedAt,
          record.expiresAt,
          record.durationSeconds,
          record.predecessorLeaseId,
          record.predecessorEpoch,
          record.takeoverReason,
          JSON.stringify(record.acknowledgedUnreconciledNodeIds),
          JSON.stringify(record.unreconciledNodeIds),
          record.recordedAt,
          record.schemaVersion,
          // The compare-and-set. Bound last because it is the last placeholder in
          // the statement, and bound as `IS ?` so the first claim (expecting NULL)
          // and every later write go through one statement.
          write.expectedEpoch,
        ).changes

        if (changes === 0) {
          // The row moved, or there was no row and one was expected. Reported
          // rather than retried here, deliberately: the epoch the caller reasoned
          // about was READ by the caller, and only the caller knows whether it is
          // still the one it holds.
          const current = this.#readActive(write.scope)
          if (!current.ok) return current as Result<LeaseWriteOutcome>
          return { ok: true, value: { written: false, current: current.value } }
        }

        // The audit row goes in the SAME transaction as the authority. One
        // transaction because a takeover that supersedes a lease the audit trail
        // does not record is a fence nobody can check.
        this.#insertHistoryStatement.run(
          record.projectId,
          record.runId,
          record.leaseId,
          record.controllerNodeId,
          record.epoch,
          record.operation,
          record.issuedAt,
          record.expiresAt,
          record.recordedAt,
          record.schemaVersion,
        )
        return { ok: true, value: { written: true, lease: record } }
      })
    } catch (error) {
      return storeUnavailable(describeStoreError(error))
    }
  }

  async leaseHistory(scope: LeaseScope): Promise<Result<readonly LeaseHistoryEntry[]>> {
    try {
      const rows = this.#historyStatement.all(scope.projectId, scope.runId)
      const out: LeaseHistoryEntry[] = []
      for (const row of rows) {
        // A single unreadable history row fails the WHOLE read. Returning the
        // readable ones would let a takeover report a history with a hole in it
        // and no error.
        const mapped = mapHistoryRow(row)
        if (!mapped.ok) return mapped as Result<readonly LeaseHistoryEntry[]>
        out.push(mapped.value)
      }
      return { ok: true, value: Object.freeze(out) }
    } catch (error) {
      return storeUnavailable(describeStoreError(error))
    }
  }

  #readActive(scope: LeaseScope): Result<LeaseRecord | null> {
    const row = this.#activeStatement.get(scope.projectId, scope.runId)
    if (row === undefined) return { ok: true, value: null }
    return mapActiveRow(row)
  }
}
