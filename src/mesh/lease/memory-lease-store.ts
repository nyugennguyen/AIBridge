import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import { parseLeaseRecord, type LeaseHistoryEntry, type LeaseRecord, type LeaseScope } from "./schemas.js"
import type { ControllerLeaseStore, LeaseWrite, LeaseWriteOutcome } from "./types.js"

/**
 * The in-memory store: the specification the durable one is checked against.
 *
 * It exists for two reasons, and the second is the important one.
 *
 *   1. Tests and the TUI (M4.8) can run without a database file. Necessary, and
 *      not sufficient justification for a second implementation of a store that
 *      decides who may create work for a run.
 *   2. **It is the specification `SqliteControllerLeaseStore` has to agree with.**
 *      Every semantic in `ControllerLeaseStore` — the compare-and-set on the
 *      epoch, the convergence of a redelivered record, the refusal of a
 *      regression — is written here first, in the shape that makes it obvious.
 *      `lease-store.test.ts` runs the same scenarios against BOTH, because a
 *      durable store whose transaction semantics have drifted from the reference
 *      is exactly the defect this pairing exists to prevent.
 *
 * It is NOT a cache and NOT a fast path. Nothing in production may hold a lease
 * in a `Map`: a controller restart would silently raise every epoch to "no lease",
 * and a node that believes it holds no lease creates no work — so the failure is
 * a silent halt rather than a duplicate, but it is a halt, and it is invisible.
 */
export class InMemoryControllerLeaseStore implements ControllerLeaseStore {
  readonly #active = new Map<string, LeaseRecord>()
  readonly #history = new Map<string, LeaseHistoryEntry[]>()

  async activeLease(scope: LeaseScope): Promise<Result<LeaseRecord | null>> {
    return { ok: true, value: this.#active.get(keyOf(scope)) ?? null }
  }

  async writeLease(write: LeaseWrite): Promise<Result<LeaseWriteOutcome>> {
    const key = keyOf(write.scope)
    // The stored record is re-validated before it is admitted, exactly as a row
    // read back from SQLite is. A caller that hands this port a record its own
    // schema would refuse is a caller whose bug would otherwise be written to
    // disk here and discovered on the next boot.
    const parsed = parseLeaseRecord(write.record)
    if (!parsed.ok) return parsed as Result<LeaseWriteOutcome>
    const record = parsed.value
    if (record.projectId !== write.scope.projectId || record.runId !== write.scope.runId) {
      return {
        ok: false,
        error: createContractError(
          "validation",
          "lease.store_scope_mismatch",
          `The record's scope (${record.projectId}/${record.runId}) does not match the scope it is written under (${write.scope.projectId}/${write.scope.runId}). A lease filed under a run it does not cover is a lease that fences the wrong run.`,
        ),
      }
    }

    const current = this.#active.get(key) ?? null
    // The same comparison the durable store makes in its `ON CONFLICT ... WHERE`,
    // for the same reason: a check that is a separate step from the write is two
    // operations, and the gap between them is where two controllers each observe
    // a predecessor they believe they may supersede.
    if ((current?.epoch ?? null) !== write.expectedEpoch) {
      return { ok: true, value: { written: false, current } }
    }

    // A write that does not RAISE the epoch must not change the epoch either. The
    // compare-and-set above already made a raise the only way past a live row, so
    // this is the second half of the same invariant: a renewal carries the epoch
    // it was issued at, and a store that let a renewal carry a different one
    // would be letting a controller change the run's authority while claiming to
    // continue it.
    if (current !== null && record.epoch !== current.epoch && record.operation !== "takeover") {
      return {
        ok: true,
        value: { written: false, current },
      }
    }

    this.#active.set(key, record)
    this.#appendHistory(key, record)
    return { ok: true, value: { written: true, lease: record } }
  }

  async leaseHistory(scope: LeaseScope): Promise<Result<readonly LeaseHistoryEntry[]>> {
    return { ok: true, value: Object.freeze([...(this.#history.get(keyOf(scope)) ?? [])]) }
  }

  #appendHistory(key: string, record: LeaseRecord): void {
    const existing = this.#history.get(key) ?? []
    // A redelivered record converges rather than duplicating, keyed on the lease
    // id: the same record is the same row, and a second copy of it in the audit
    // trail would make "how many times was this lease accepted?" a question with
    // an answer that depends on transport rather than on decisions.
    if (existing.some((entry) => entry.leaseId === record.leaseId)) return
    this.#history.set(key, [
      ...existing,
      Object.freeze({
        leaseId: record.leaseId,
        projectId: record.projectId,
        runId: record.runId,
        controllerNodeId: record.controllerNodeId,
        epoch: record.epoch,
        operation: record.operation,
        issuedAt: record.issuedAt,
        expiresAt: record.expiresAt,
        recordedAt: record.recordedAt,
      }),
    ])
  }
}

function keyOf(scope: LeaseScope): string {
  return `${scope.projectId} ${scope.runId}`
}

/** The `code` of a driver error, never its message — a lease row carries ids and reasons. */
export function describeStoreError(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code
  }
  return error instanceof Error ? error.name : "an unknown error"
}

/** The one refusal both stores share, so a storage fault reads identically in either. */
export function storeUnavailable(detail: string): { ok: false; error: ContractError } {
  return {
    ok: false,
    error: createContractError(
      "internal_failure",
      "lease.store_unavailable",
      `The lease store could not answer: ${detail}. A lease store that cannot be read is refused rather than treated as empty — an empty store reads as "nobody controls this run", which is a claim about authority that a disk fault must not be able to make.`,
    ),
  }
}
