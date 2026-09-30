/**
 * M5.2 — the access policy: the single place that answers "may this reader see
 * this record, and if not, why".
 *
 * It exists as its own module because the answer is needed in two situations
 * that must not be allowed to disagree. `query()` needs it to decide, per
 * record, between returning a view and recording a `MemoryWithholding`. The
 * context assembler (M5.5) and the TUI (M5.8) need the same answer for a
 * record that is already in hand. Two implementations of the same rule would
 * disagree at the boundary — the assembler would exclude something the query
 * returned, or render something the TUI said was hidden.
 *
 * # The decision order is fixed, and it is ordered by what must never leak
 *
 * The order below is not arbitrary; it is the order of "how badly would it be
 * to answer *this* instead of the truth":
 *
 * 1. `project_mismatch` — isolation first. A reader outside the project learns
 *    only that it is outside.
 * 2. `tombstoned` — the content is gone. Nothing downstream may proceed as
 *    though a record exists.
 * 3. `prohibited_content` / 4. `redacted_unavailable` — terminal for content.
 * 5. `scope_not_visible` — the lattice.
 * 6. `sensitivity_above_clearance` — clearance.
 * 7. `node_restricted` / 8. `role_restricted` — the explicit allow-lists.
 * 9. `not_trusted` — only `accepted` is injectable.
 * 10. `superseded` / 11. `expired` — *view* concerns, not access concerns, and
 *     therefore last: they are the only two reasons a query can switch off.
 *
 * `superseded` and `expired` are last for a specific reason. They are the two
 * reasons that mean "this record is fine, you just asked for the wrong view".
 * Every earlier reason means "this reader must never have this record". If a
 * superseded record were reported as `prohibited_content` because it happened
 * to also be untrusted, the withholding would be a lie about *why*, and a lie
 * about why is how a reviewer concludes the ACL works when it does not.
 *
 * # What `revealsKind` is for
 *
 * `MemoryWithholding` carries a `kind`, but `revealsKind: false` is the flag the
 * contract says callers must respect, so the flag decides what a withholding is
 * allowed to say. Four reasons set it, and the grouping is the design:
 *
 * - `prohibited_content` and `redacted_unavailable` assert something about
 *   *content*. A withholding that names the kind of a record whose content is
 *   prohibited has leaked the thing the prohibition protects.
 * - `project_mismatch`, `sensitivity_above_clearance`, `node_restricted`, and
 *   `role_restricted` assert that an operator decided this record is not for
 *   this reader. "There is a restricted record you may not have" is itself a
 *   disclosure about work someone classified; the ontology lists exactly these
 *   reasons in `SENSITIVE_EXCLUSION_REASONS` for the same reason. The reader
 *   learns the id is withheld and nothing about what it says.
 *
 * The remaining reasons — `scope_not_visible`, `not_trusted`, `superseded`,
 * `expired`, `tombstoned` — reveal the kind, because they are about *this
 * reader's relationship to a record in its own project*: it is outside the
 * reader's run, it is not yet trusted, it has been corrected, it has expired, or
 * it was deleted. Naming the kind of a record the reader could otherwise have
 * read is what makes an exclusion reviewable, which is the whole point of
 * recording one.
 */

import {
  isRenderable,
  mayReadSensitivity,
  type MemoryKind,
  type Sensitivity,
} from "./ontology.js"
import { scopeContains, type MemoryRecordView, type MemoryViewScope } from "./record.js"
import type {
  MemoryAccessDecision,
  MemoryQueryScope,
  MemoryWithholdingReason,
} from "./ports.js"

/**
 * Store facts the policy cannot derive from a record alone.
 *
 * Tombstone status and supersession are properties of the *set* of records, not
 * of one record, and they are deliberately not stored on the record: writing
 * `supersededByMemoryId` back onto the superseded record would mutate its bytes,
 * which is exactly what `tests/unit/memory/supersession.test.ts` forbids. So the
 * repository answers these from its derived index and hands them over here.
 */
export interface MemoryAccessState {
  readonly isTombstoned: (memoryId: string) => boolean
  readonly isSuperseded: (memoryId: string) => boolean
}

export const EMPTY_MEMORY_ACCESS_STATE: MemoryAccessState = Object.freeze({
  isTombstoned: () => false,
  isSuperseded: () => false,
})

export interface MemoryAccessPolicyOptions {
  readonly state?: MemoryAccessState
  /**
   * View switches, mirroring `MemoryQuery.includeSuperseded` /
   * `includeExpired`. Both default to `false`: the active view is the default
   * because a repository that returns history unless asked is a repository whose
   * callers silently resurrect corrected facts.
   */
  readonly includeSuperseded?: boolean
  readonly includeExpired?: boolean
}

const ALLOW: MemoryAccessDecision = Object.freeze({ allowed: true, reason: "allowed", revealsKind: true })

function deny(reason: MemoryWithholdingReason, revealsKind: boolean): MemoryAccessDecision {
  return { allowed: false, reason, revealsKind }
}

/**
 * The scope lattice.
 *
 * Delegates to `scopeContains` rather than comparing anything here: the
 * ontology owns the relation, and a second comparison in this file is a second
 * definition that will drift.
 *
 * # This used to be kind-only, and that was a real limitation
 *
 * `MemoryQueryScope.scope` was a `MemoryScopeKind`, so this wrapper had no
 * reader *identity* to compare and could only answer the standing-facts
 * direction. Two consequences, both recorded when the limitation was live:
 *
 * 1. run-1's finding and run-2's finding are both `run` kind, so a run-scoped
 *    reader was a candidate for both. It failed closed in the sense that no
 *    record was *returned* incorrectly — but only because the query's `runId`
 *    filter, not this check, was doing the work, and a caller who omitted that
 *    filter had no protection at all.
 * 2. A reader was refused its own descendants' records (a session reader could
 *    not see its own session's findings). Harmless, but a legitimate read
 *    refused for a reason nobody could name from the outside.
 *
 * The port now carries a full `MemoryViewScope`, so both are gone: identity is
 * compared for cross-scope isolation, and a reader sees its own history.
 *
 * The argument order is the remaining hazard — `record` first, `reader` second —
 * and inverting it fails silently by returning fewer records rather than by
 * erroring, so the wrapper is kept as a named seam and the tests assert both
 * directions.
 */
export function isRecordVisibleToReader(recordScope: MemoryViewScope, readerScope: MemoryViewScope): boolean {
  return scopeContains(recordScope, readerScope)
}

/** Would this record's content be a "prohibited" or redacted-away disclosure? */
function revealsContent(record: MemoryRecordView): boolean {
  return isRenderable(record.sensitivity) && record.redaction.status !== "prohibited"
}

/** Is the record past its own expiry at `now`? `now` is supplied, never read. */
export function isExpired(record: MemoryRecordView, now: string): boolean {
  if (record.expiresAt === undefined) return false
  const expiry = Date.parse(record.expiresAt)
  const reference = Date.parse(now)
  if (!Number.isFinite(expiry) || !Number.isFinite(reference)) return false
  return expiry <= reference
}

/**
 * The default policy. Every `MemoryRepository` constructs one of these per
 * query, because the view switches belong to the query and the state belongs to
 * the store.
 */
export class ScopeLatticeAccessPolicy {
  private readonly state: MemoryAccessState
  private readonly includeSuperseded: boolean
  private readonly includeExpired: boolean

  constructor(options: MemoryAccessPolicyOptions = {}) {
    this.state = options.state ?? EMPTY_MEMORY_ACCESS_STATE
    this.includeSuperseded = options.includeSuperseded === true
    this.includeExpired = options.includeExpired === true
  }

  /**
   * A copy of this policy with the query's view switches applied. The store's
   * state is carried over, because a policy without state is a policy that
   * cannot see tombstone or supersession.
   */
  forQuery(options: MemoryAccessPolicyOptions): ScopeLatticeAccessPolicy {
    return new ScopeLatticeAccessPolicy({
      state: options.state ?? this.state,
      includeSuperseded: options.includeSuperseded ?? this.includeSuperseded,
      includeExpired: options.includeExpired ?? this.includeExpired,
    })
  }

  decide(record: MemoryRecordView, reader: MemoryQueryScope, now: string): MemoryAccessDecision {
    // 1. Isolation. Before anything is read off the record, because every later
    //    answer would be a disclosure to a foreign project.
    if (record.projectId !== reader.projectId) {
      return deny("project_mismatch", false)
    }

    // 2. The content is physically gone. A tombstoned record's fields are not
    //    consulted beyond the ones needed to say "this id was deleted".
    if (this.state.isTombstoned(record.memoryId)) {
      return deny("tombstoned", revealsContent(record))
    }

    // 3/4. Terminal for content. `revealsKind: false` in both cases: a
    //      withholding that names the kind of a record whose content is
    //      prohibited has leaked the one thing the prohibition protects.
    if (record.sensitivity === "prohibited") {
      return deny("prohibited_content", false)
    }
    if (record.redaction.status === "prohibited") {
      return deny("redacted_unavailable", false)
    }

    // 5. The lattice. `scopeContains` compares the reader's *identity chain*,
    //    not just the scope kind, which is the whole point: run-1's finding and
    //    run-2's finding are both `run` kind, and a kind-only comparison hands
    //    a run-1 reader every run's records. The failure would be silent — more
    //    records, not an error.
    if (!isRecordVisibleToReader(record.scope, reader.scope)) {
      return deny("scope_not_visible", true)
    }

    // 6. Clearance. `mayReadSensitivity` already returns false for `prohibited`
    //    at every clearance, so a reader with the highest clearance still
    //    cannot read prohibited content — that is why step 3 exists at all.
    if (!mayReadSensitivity(record.sensitivity, reader.clearance)) {
      // Not revealing: telling a reader "there is a `restricted` record here" is
      // itself a disclosure about work someone decided was sensitive.
      return deny("sensitivity_above_clearance", false)
    }

    // 7/8. Explicit allow-lists. Absent means unrestricted, which is the only
    //      sensible default: a list that must be populated before anything can
    //      be read is a list every author forgets.
    // Both restrictions withhold without revealing the kind. An explicit
    // allow-list exists precisely because the operator decided this record is
    // not for the reader; telling them what it is about defeats the decision
    // without disclosing the content.
    const nodeIds = record.visibleToNodeIds
    if (nodeIds !== undefined && !nodeIds.includes(reader.nodeId)) {
      return deny("node_restricted", false)
    }
    const roleIds = record.visibleToRoleIds
    if (roleIds !== undefined && (reader.roleId === undefined || !roleIds.includes(reader.roleId))) {
      return deny("role_restricted", false)
    }

    // 9. Trust. Only `accepted` is injectable — a proposed record is a
    //    suggestion awaiting a user, and a rejected one is a closed question.
    if (record.trust !== "accepted") {
      return deny("not_trusted", true)
    }

    // 10. Superseded. The correction is active; this one is history.
    if (!this.includeSuperseded && this.state.isSuperseded(record.memoryId)) {
      return deny("superseded", true)
    }

    // 11. Expired.
    if (!this.includeExpired && isExpired(record, now)) {
      return deny("expired", true)
    }

    return ALLOW
  }

  /** A stable, log- and manifest-safe string for a decision. Never the record. */
  explain(decision: MemoryAccessDecision): string {
    return decision.allowed ? "allowed" : `withheld:${decision.reason}`
  }
}

export function createMemoryAccessPolicy(options: MemoryAccessPolicyOptions = {}): ScopeLatticeAccessPolicy {
  return new ScopeLatticeAccessPolicy(options)
}

/**
 * Build the `MemoryWithholding` for a decision.
 *
 * Kept next to the policy so the `revealsKind` rule has exactly one
 * implementation: the flag on a withholding is the policy's decision, copied
 * and never recomputed by a query.
 */
export function toWithholding(record: { readonly memoryId: string; readonly kind: MemoryKind }, decision: MemoryAccessDecision): {
  readonly memoryId: string
  readonly kind?: MemoryKind
  readonly reason: MemoryWithholdingReason
  readonly revealsKind: boolean
} {
  if (decision.allowed) {
    throw new Error(`memory: cannot build a withholding from an allowing decision for '${record.memoryId}'`)
  }
  return {
    memoryId: record.memoryId,
    // Absent, not flagged. A `kind` that is populated alongside a "do not
    // reveal" boolean is one `{ ...withholding }` away from a log line, and the
    // id is already an existence oracle for a foreign project — the kind makes
    // it a topic oracle too. `tests/unit/memory/access-policy.test.ts` asserts
    // the key is not present at all, so a caller cannot leak it by spreading.
    ...(decision.revealsKind ? { kind: record.kind } : {}),
    reason: decision.reason as MemoryWithholdingReason,
    revealsKind: decision.revealsKind,
  }
}

export type { MemoryAccessDecision, MemoryQueryScope, MemoryRecordView, Sensitivity }
