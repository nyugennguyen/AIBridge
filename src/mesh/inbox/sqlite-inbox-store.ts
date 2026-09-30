import type { SqliteDriver, SqliteStatement } from "../../orchestration/event-store/sqlite-driver.js"
import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import { CURRENT_SCHEMA_VERSION } from "../../orchestration/identifiers.js"
import type { CommandId, DispatchId, ProjectId, RunId } from "../../orchestration/identifiers.js"
import {
  INSERT_INBOX_ROW_SQL,
  MARK_ACK_EMITTED_SQL,
  MARK_RUNTIME_ACCEPTED_SQL,
  RECORD_INBOX_RESULT_SQL,
  SELECT_INBOX_ROW_SQL,
  SELECT_INBOX_ROWS_BY_RUN_SQL,
  SELECT_NEXT_ACCEPTED_SEQUENCE_SQL,
} from "./migrations.js"
import { parseInboxRow, rowToValue, type InboxRow, type MeshInboxRowShape } from "./schemas.js"
import type {
  CommandInboxStore,
  InboxRowFilter,
  InboxWriteOutcome,
  NewInboxRow,
} from "./types.js"

/**
 * THIS MODULE IS ALLOWED TO TOUCH STORAGE, together with `./migrations.ts` and
 * nothing else in `src/mesh/inbox/`. The driver is INJECTED rather than opened
 * here, which is not a test convenience: it is what makes the durability the tests
 * exercise the durability production runs on.
 *
 * Four properties, each stated as a test in `tests/unit/mesh/inbox/`:
 *
 *   1. **The convergence rule is in the statement.** `ON CONFLICT DO NOTHING`
 *      plus a re-read inside the same transaction, for the registry's reason: two
 *      redeliveries of one command must land on one row, and a check-then-write
 *      has a gap between the two operations.
 *   2. **The row is durable BEFORE the caller is told anything.** `accept`
 *      returns only after the transaction commits, which is what makes "persisted
 *      before acknowledgement" a property of this method rather than of the
 *      caller's sequencing.
 *   3. **Every read re-validates.** `parseInboxRow` on every read, and a single
 *      unreadable row fails the whole list rather than being skipped — a list with
 *      a hole in it and no error is what a redelivery path cannot tell apart from
 *      "this command was never accepted".
 *   4. **The `runtime_accepted` and `result_recorded` transitions are idempotent
 *      and one-way.** A redelivery reaching them twice must not move the recorded
 *      instant, and nothing may move a row backwards out of a settled state.
 */

/** The `code` of a driver error, never its message — an inbox row carries command payloads. */
export function describeInboxStoreError(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code
  }
  return error instanceof Error ? error.name : "an unknown error"
}

/**
 * The one refusal both stores share, so a storage fault reads identically in
 * either.
 *
 * `policy_denied` is deliberate and not obvious: a store that cannot be READ is
 * refused exactly like one that cannot authorize. An empty read is a claim that
 * this node has accepted no commands, and a disk fault must not be able to make
 * that claim — because the retry path's answer for "no row" is "apply it", so a
 * failed read answered as empty would re-run an effect that already happened.
 */
export function inboxStoreUnavailable(detail: string): { ok: false; error: ContractError } {
  return {
    ok: false,
    error: createContractError(
      "policy_denied",
      "inbox.store_unavailable",
      `The inbox store could not answer: ${detail}. A store that cannot be read is refused rather than treated as empty — "no row" is the inbox's answer for APPLY IT, so a disk fault answered as an empty store would re-run an effect that already happened.`,
    ),
  }
}

function buildListFilter(filter: InboxRowFilter | undefined): { sql: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  if (filter?.projectId !== undefined) {
    clauses.push("project_id = ?")
    params.push(filter.projectId)
  }
  if (filter?.runId !== undefined) {
    clauses.push("run_id = ?")
    params.push(filter.runId)
  }
  if (filter?.commandId !== undefined) {
    clauses.push("command_id = ?")
    params.push(filter.commandId)
  }
  if (filter?.effectState !== undefined) {
    clauses.push("effect_state = ?")
    params.push(filter.effectState)
  }
  return { sql: clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "", params }
}

export class SqliteCommandInboxStore implements CommandInboxStore {
  readonly #driver: SqliteDriver
  readonly #insert: SqliteStatement
  readonly #find: SqliteStatement<MeshInboxRowShape>
  readonly #byRun: SqliteStatement<MeshInboxRowShape>
  readonly #nextSequence: SqliteStatement<{ next_sequence: number }>
  readonly #markRuntimeAccepted: SqliteStatement
  readonly #recordResult: SqliteStatement
  readonly #markAckEmitted: SqliteStatement

  constructor(driver: SqliteDriver) {
    this.#driver = driver
    this.#insert = driver.prepare(INSERT_INBOX_ROW_SQL)
    this.#find = driver.prepare<MeshInboxRowShape>(SELECT_INBOX_ROW_SQL)
    this.#byRun = driver.prepare<MeshInboxRowShape>(SELECT_INBOX_ROWS_BY_RUN_SQL)
    this.#nextSequence = driver.prepare<{ next_sequence: number }>(SELECT_NEXT_ACCEPTED_SEQUENCE_SQL)
    this.#markRuntimeAccepted = driver.prepare(MARK_RUNTIME_ACCEPTED_SQL)
    this.#recordResult = driver.prepare(RECORD_INBOX_RESULT_SQL)
    this.#markAckEmitted = driver.prepare(MARK_ACK_EMITTED_SQL)
  }

  /** Exposed so a structural test can read the physical columns. */
  get driver(): SqliteDriver {
    return this.#driver
  }

  async accept(row: NewInboxRow): Promise<Result<InboxWriteOutcome>> {
    try {
      return this.#driver.transaction((): Result<InboxWriteOutcome> => {
        // The sequence is read INSIDE the transaction, not before it. Read outside,
        // two concurrent accepts would both compute the same MAX and one would
        // either lose the insert or win it with a sequence that duplicates the
        // other's — and the sequence IS the ack order.
        const next = this.#nextSequence.get()?.next_sequence
        if (next === undefined) return inboxStoreUnavailable("the inbox sequence query returned no row")

        this.#insert.run(
          row.commandId,
          row.projectId,
          row.runId,
          row.dispatchId,
          row.targetNodeId,
          row.controllerNodeId,
          row.controllerEpoch,
          row.leaseId,
          row.commandType,
          row.payloadDigest,
          row.semanticFingerprint,
          row.commandJson,
          row.acceptedAt,
          next,
          // Stamped HERE rather than backfilled at read time. A read that
          // substituted the running build's current version would make every row
          // of an older file claim a shape it was not written with, which is the
          // M0 contract-reapproval lesson restated: the version on a record is
          // the version it was WRITTEN at.
          CURRENT_SCHEMA_VERSION,
        )

        const read = this.#readRow(row.commandId)
        if (!read.ok) return read as Result<InboxWriteOutcome>
        if (read.value === null) {
          return inboxStoreUnavailable("an inserted inbox row was not readable in the same transaction")
        }
        // `written` is derived from the sequence the row ended up with, not from a
        // separate "did I insert" flag, because the statement's DO NOTHING makes
        // that the only honest question: this caller's row, or the one that was
        // already there.
        return { ok: true, value: { written: read.value.acceptedSequence === next, row: read.value } }
      })
    } catch (error) {
      return inboxStoreUnavailable(describeInboxStoreError(error))
    }
  }

  async find(commandId: CommandId): Promise<Result<InboxRow | null>> {
    try {
      return this.#readRow(commandId)
    } catch (error) {
      return inboxStoreUnavailable(describeInboxStoreError(error))
    }
  }

  async listInbox(filter: InboxRowFilter = {}): Promise<Result<readonly InboxRow[]>> {
    try {
      if (filter.projectId !== undefined && filter.runId !== undefined) {
        const rows = this.#byRun.all(filter.projectId, filter.runId)
        return this.#mapRows(rows, filter.limit)
      }
      const { sql, params } = buildListFilter(filter)
      let statement = `SELECT * FROM mesh_inbox_commands WHERE 1 = 1${sql} ORDER BY accepted_sequence ASC`
      const bound = [...params]
      if (filter.limit !== undefined) {
        statement += " LIMIT ?"
        bound.push(filter.limit)
      }
      return this.#mapRows(this.#driver.all<MeshInboxRowShape>(statement, ...bound), filter.limit)
    } catch (error) {
      return inboxStoreUnavailable(describeInboxStoreError(error))
    }
  }

  async countInbox(filter: InboxRowFilter = {}): Promise<Result<number>> {
    try {
      const { sql, params } = buildListFilter(filter)
      const row = this.#driver.get<{ total: number }>(
        `SELECT COUNT(*) as total FROM mesh_inbox_commands WHERE 1 = 1${sql}`,
        ...params,
      )
      return { ok: true, value: row?.total ?? 0 }
    } catch (error) {
      return inboxStoreUnavailable(describeInboxStoreError(error))
    }
  }

  async markRuntimeAccepted(commandId: CommandId, now: number): Promise<Result<InboxRow | null>> {
    return this.#transition(commandId, () => this.#markRuntimeAccepted.run(now, commandId))
  }

  async recordResult(commandId: CommandId, result: unknown, now: number): Promise<Result<InboxRow | null>> {
    void now
    return this.#transition(
      commandId,
      () => this.#recordResult.run(JSON.stringify(result === undefined ? null : result), commandId),
    )
  }

  async markAckEmitted(commandId: CommandId, now: number): Promise<Result<InboxRow | null>> {
    return this.#transition(commandId, () => this.#markAckEmitted.run(now, commandId))
  }

  async nextAcceptedSequence(): Promise<Result<number>> {
    try {
      const next = this.#nextSequence.get()?.next_sequence
      if (next === undefined) return inboxStoreUnavailable("the inbox sequence query returned no row")
      return { ok: true, value: next }
    } catch (error) {
      return inboxStoreUnavailable(describeInboxStoreError(error))
    }
  }

  async #transition(commandId: CommandId, write: () => { changes: number }): Promise<Result<InboxRow | null>> {
    try {
      return this.#driver.transaction((): Result<InboxRow | null> => {
        write()
        return this.#readRow(commandId)
      })
    } catch (error) {
      return inboxStoreUnavailable(describeInboxStoreError(error))
    }
  }

  #readRow(commandId: CommandId): Result<InboxRow | null> {
    const row = this.#find.get(commandId)
    if (row === undefined) return { ok: true, value: null }
    return parseInboxRow(rowToValue(row))
  }

  async #mapRows(rows: MeshInboxRowShape[], limit: number | undefined): Promise<Result<readonly InboxRow[]>> {
    const out: InboxRow[] = []
    for (const row of rows) {
      // One unreadable row fails the WHOLE read. Returning the readable ones would
      // let a redelivery path see a run's accepted commands with a hole in them
      // and no error — and "not in the list" is the inbox's answer for "apply it".
      const mapped = parseInboxRow(rowToValue(row))
      if (!mapped.ok) return mapped as Result<readonly InboxRow[]>
      out.push(mapped.value)
      if (limit !== undefined && out.length >= limit) break
    }
    return { ok: true, value: Object.freeze(out) }
  }
}

export type { DispatchId, ProjectId, RunId }
