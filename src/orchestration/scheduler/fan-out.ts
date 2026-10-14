/**
 * Fan-out scheduling and sibling lifecycle management.
 *
 * # What this module is
 *
 * Implements N-sibling fan-out dispatch and sibling failure cancellation for Phase 1
 * kernel capabilities (DoD #6):
 * 1. Deterministic N-sibling dispatch derivation: stable sibling IDs derived from
 *    parent dispatch ID and sibling index.
 * 2. Budget ledger integration: fan-out capacity reservations against the ledger's
 *    dedicated fan_out counter. When the ceiling is reached, excess siblings are refused
 *    with the ledger's refusal discipline ("the budget ledger refuses the seventh").
 * 3. Sibling cancellation on failure: when a parent dispatch or one sibling fails terminally,
 *    all remaining live siblings transition to 'cancelled' according to the transition matrix.
 *    Cancellation is idempotent and absorbs already terminal dispatches.
 */

import { digestDispatchEnvelope } from "../digest.js"
import { dispatchIdSchema, type DispatchId } from "../identifiers.js"
import type { Dispatch, DispatchEnvelope } from "../types.js"
import type { DispatchProjection, RunProjectionState, SessionProjection } from "../projections/types.js"
import { isDispatchTerminal, isSessionTerminal, transitionDispatch } from "../transitions.js"
import type {
  BudgetReservationResult,
  PlanFanOutOptions,
  PlanFanOutResult,
  PlanFanOutSyncOptions,
  RefusedSiblingDispatch,
  SiblingCancellationResult,
} from "./types.js"

/**
 * Deterministically derives a sibling dispatch ID from a parent dispatch ID and sibling index.
 *
 * Invariant: Identical parent dispatch ID + index always yields identical sibling ID.
 */
export function deriveSiblingDispatchId(
  parentDispatchId: DispatchId | string,
  index: number,
): DispatchId {
  return dispatchIdSchema.parse(`${parentDispatchId}-sibling-${index}`)
}

/**
 * Extracts the parent dispatch ID from a sibling dispatch ID if it follows the
 * standard `${parentDispatchId}-sibling-${index}` format.
 */
export function parseParentDispatchId(dispatchId: string): DispatchId | null {
  const match = dispatchId.match(/^(.+)-sibling-\d+$/)
  if (!match || !match[1]) return null
  return match[1] as DispatchId
}

/**
 * Finds all sibling dispatches for a given dispatch ID within a run projection.
 */
export function getSiblingDispatches(
  runState: RunProjectionState,
  dispatchId: DispatchId | string,
): readonly DispatchProjection[] {
  const currentDispatch = runState.dispatches[dispatchId]
  const parentId: string | null =
    currentDispatch?.envelope?.parentDispatchId ??
    parseParentDispatchId(dispatchId as string) ??
    (Object.values(runState.dispatches).some((d) => d.envelope?.parentDispatchId === dispatchId)
      ? dispatchId
      : null)

  if (!parentId) {
    return currentDispatch ? [currentDispatch] : []
  }

  const siblings: DispatchProjection[] = []
  for (const d of Object.values(runState.dispatches)) {
    if (
      d.envelope?.parentDispatchId === parentId ||
      d.dispatchId === parentId ||
      d.dispatchId.startsWith(`${parentId}-sibling-`)
    ) {
      siblings.push(d)
    }
  }

  return siblings.sort((a, b) => a.dispatchId.localeCompare(b.dispatchId))
}

/**
 * Plans N sibling dispatches derived from a parent dispatch asynchronously,
 * reserving fan_out capacity with the budget ledger if provided.
 *
 * Sibling dispatches are generated in deterministic order (index 0..N-1).
 * When the budget ledger ceiling is saturated, planning halts and the refusal
 * is reported in `refusedDispatches` ("the budget ledger refuses the seventh").
 */
export async function planFanOutDispatches(
  options: PlanFanOutOptions,
): Promise<PlanFanOutResult> {
  const parentDispatch = options.parentDispatch
  const parentEnvelope = parentDispatch.envelope
  const parentDispatchId = parentEnvelope.dispatchId
  const requestedFanOut = options.fanOut ?? parentEnvelope.fanOut ?? 1
  const count = Math.max(1, requestedFanOut)
  const now = options.now ?? parentDispatch.createdAt

  const plannedDispatches: Dispatch[] = []
  const refusedDispatches: RefusedSiblingDispatch[] = []

  for (let index = 0; index < count; index += 1) {
    const siblingDispatchId = deriveSiblingDispatchId(parentDispatchId, index)
    const siblingEnvelope: DispatchEnvelope = {
      ...parentEnvelope,
      dispatchId: siblingDispatchId,
      parentDispatchId,
      fanOut: 1,
      ...(options.envelopeOverrides?.[index] ?? {}),
    }

    if (options.budgetLedger) {
      const reservationId = `res-${siblingDispatchId}`
      const reserveResult = await options.budgetLedger.reserve({
        reservationId,
        projectId: siblingEnvelope.projectId,
        runId: siblingEnvelope.runId,
        taskId: siblingEnvelope.taskId,
        dispatchId: siblingDispatchId,
        scope: "fan_out",
        units: 1,
        now,
        leaseSeconds: options.leaseSeconds,
      })

      if (!reserveResult.ok) {
        refusedDispatches.push({
          siblingDispatchId,
          index,
          refusal: reserveResult.refusal,
        })
        // Ceilings are hard boundaries: once saturated, excess dispatches are refused
        break
      }
    }

    plannedDispatches.push({
      schemaVersion: 1,
      envelope: siblingEnvelope,
      envelopeDigest: digestDispatchEnvelope(siblingEnvelope),
      state: parentDispatch.state,
      createdAt: now,
      externalReferences: parentDispatch.externalReferences,
    })
  }

  return {
    parentDispatchId,
    requestedFanOut: count,
    plannedDispatches,
    refusedDispatches,
  }
}

/**
 * Synchronous variant of planFanOutDispatches using reserveSync on the budget ledger.
 */
export function planFanOutDispatchesSync(
  options: PlanFanOutSyncOptions,
): PlanFanOutResult {
  const parentDispatch = options.parentDispatch
  const parentEnvelope = parentDispatch.envelope
  const parentDispatchId = parentEnvelope.dispatchId
  const requestedFanOut = options.fanOut ?? parentEnvelope.fanOut ?? 1
  const count = Math.max(1, requestedFanOut)
  const now = options.now ?? parentDispatch.createdAt

  const plannedDispatches: Dispatch[] = []
  const refusedDispatches: RefusedSiblingDispatch[] = []

  for (let index = 0; index < count; index += 1) {
    const siblingDispatchId = deriveSiblingDispatchId(parentDispatchId, index)
    const siblingEnvelope: DispatchEnvelope = {
      ...parentEnvelope,
      dispatchId: siblingDispatchId,
      parentDispatchId,
      fanOut: 1,
      ...(options.envelopeOverrides?.[index] ?? {}),
    }

    if (options.budgetLedger) {
      const reservationId = `res-${siblingDispatchId}`
      const reserveParams = {
        reservationId,
        projectId: siblingEnvelope.projectId,
        runId: siblingEnvelope.runId,
        taskId: siblingEnvelope.taskId,
        dispatchId: siblingDispatchId,
        scope: "fan_out" as const,
        units: 1,
        now,
        leaseSeconds: options.leaseSeconds,
      }

      let reserveResult: BudgetReservationResult
      if (options.budgetLedger.reserveSync) {
        reserveResult = options.budgetLedger.reserveSync(reserveParams)
      } else {
        const raw = options.budgetLedger.reserve(reserveParams)
        if (raw instanceof Promise) {
          throw new Error("planFanOutDispatchesSync requires a synchronous budget ledger or reserveSync")
        }
        reserveResult = raw
      }
      if (reserveResult && !reserveResult.ok) {
        refusedDispatches.push({
          siblingDispatchId,
          index,
          refusal: reserveResult.refusal,
        })
        break
      }
    }

    plannedDispatches.push({
      schemaVersion: 1,
      envelope: siblingEnvelope,
      envelopeDigest: digestDispatchEnvelope(siblingEnvelope),
      state: parentDispatch.state,
      createdAt: now,
      externalReferences: parentDispatch.externalReferences,
    })
  }

  return {
    parentDispatchId,
    requestedFanOut: count,
    plannedDispatches,
    refusedDispatches,
  }
}

/**
 * Cancels all live siblings of a failed dispatch in a RunProjectionState.
 *
 * Rules:
 * - A terminal failure of one sibling cancels the remaining siblings.
 * - Transitions are asserted via `transitionDispatch(current, "cancelled")`.
 * - Absorbing: dispatches already in a terminal state (completed, failed, cancelled, timed_out)
 *   are left unchanged (idempotent).
 * - Corresponding active sessions are transitioned to 'cancelled' with observedState 'unknown'.
 */
export function cancelSiblingsOnFailure(
  runState: RunProjectionState,
  failedDispatchId: DispatchId | string,
  options?: { now?: string; reason?: string },
): SiblingCancellationResult {
  const currentDispatch = runState.dispatches[failedDispatchId]
  const parentId: DispatchId | null =
    (currentDispatch?.envelope?.parentDispatchId as DispatchId | undefined) ??
    parseParentDispatchId(failedDispatchId as string) ??
    (Object.values(runState.dispatches).some((d) => d.envelope?.parentDispatchId === failedDispatchId)
      ? (failedDispatchId as DispatchId)
      : null)

  if (!parentId) {
    return {
      updatedRunState: runState,
      cancelledDispatchIds: [],
      parentDispatchId: null,
    }
  }

  const now = options?.now ?? currentDispatch?.updatedAt ?? new Date().toISOString()
  const reason = options?.reason ?? `Cancelled due to terminal failure of sibling dispatch '${failedDispatchId}'`

  const nextDispatches: Record<string, DispatchProjection> = { ...runState.dispatches }
  const nextSessions: Record<string, SessionProjection> = { ...runState.sessions }
  const cancelledDispatchIds: DispatchId[] = []

  for (const [id, d] of Object.entries(runState.dispatches)) {
    if (id === failedDispatchId) continue

    const isSibling =
      d.envelope?.parentDispatchId === parentId ||
      d.dispatchId === parentId ||
      d.dispatchId.startsWith(`${parentId}-sibling-`)

    if (!isSibling) continue

    // Absorbing: skip already terminal dispatches (idempotency)
    if (isDispatchTerminal(d.lifecycleState)) {
      continue
    }

    // License and assert state machine transition
    transitionDispatch(d.lifecycleState, "cancelled")

    nextDispatches[id] = {
      ...d,
      lifecycleState: "cancelled",
      state: "cancelled",
      outcome: "cancelled",
      summary: reason,
      updatedAt: now,
      cancelRequested: false,
    }

    cancelledDispatchIds.push(d.dispatchId)

    if (d.sessionId && nextSessions[d.sessionId]) {
      const sess = nextSessions[d.sessionId]
      if (!isSessionTerminal(sess.state)) {
        nextSessions[d.sessionId] = {
          ...sess,
          state: "cancelled",
          observedState: "unknown",
          outcome: "cancelled",
          updatedAt: now,
        }
      }
    }
  }

  const updatedRunState: RunProjectionState = {
    ...runState,
    run: {
      ...runState.run,
      updatedAt: now,
    },
    dispatches: nextDispatches,
    sessions: nextSessions,
  }

  return {
    updatedRunState,
    cancelledDispatchIds,
    parentDispatchId: parentId,
  }
}
