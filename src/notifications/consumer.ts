/**
 * M6.9 / P5 row 4 — event-driven advisory notification consumer.
 *
 * # What this module is
 *
 * A purely event-driven bridge between orchestration facts and the operator notification
 * bus. This module translates significant orchestration moments — such as roundtable outcomes
 * recorded, dispatch refusals (`roundtable_required`, budget ceiling exhaustion), charter
 * proposals awaiting human approval, lease expirations, and run/dispatch failures — into
 * strictly validated {@link NotificationRequest} payloads and submits them to a {@link NotificationBus}.
 *
 * # The Invariants (ADR 0007 §17, §12)
 *
 * 1. **N1 — No upward edge and ADVISORY ONLY.**
 *    Notifications are strictly advisory. Delivery NEVER affects orchestration state.
 *    The notification subsystem consumes orchestration EVENTS and observations of state,
 *    and NEVER feeds commands or state back into orchestration decisions.
 *    Structurally:
 *    - `src/notifications/**` imports nothing from `src/orchestration/`, `src/mesh/`,
 *      `src/runtime/`, `src/application/`, `src/memory/`, `src/context/`, or `src/server/`.
 *    - The event consumer interacts with orchestration events via the structural
 *      {@link OrchestrationEventLike} duck-type contract, completely avoiding any import
 *      of kernel modules.
 *    - No rule, dispatch, charter, or roundtable command is admitted or denied based on
 *      notification data or delivery outcomes.
 *
 * 2. **N2 — Payloads carry identifiers and reason codes only (ADR 0007 §12).**
 *    Notifications alert the operator that a significant event occurred without carrying
 *    untrusted work contents, prompts, context manifests, memory data, or secret material.
 *    All summaries are bounded (<= 200 characters), stripped of control characters, and
 *    validated by {@link notificationRequestSchema}. Reason codes are code-shaped tokens
 *    (`^[a-z][a-z0-9._]{0,63}$`), never prose.
 *
 * 3. **N3 — Total consumption, no failure propagation.**
 *    All event handling methods are total. If a subscriber throws, an adapter errors,
 *    or a payload fails parsing, the error is caught and absorbed. The orchestrator's
 *    progress is completely isolated from delivery outcomes.
 *
 * 4. **No polling loops (push-based event-driven design).**
 *    This module contains NO timers, NO intervals, NO polling threads, and NO sleep loops.
 *    The consumer reacts strictly when an event or refusal is pushed to its handler methods.
 *
 * # Stop conditions
 *
 * - **S1 — If a fact is not an identifier, code, or bounded reason, do not add it.**
 *   A notification names the run, the task, the rule, the proposal, or the discussion.
 *   It never attaches transcripts, memory content, or prompt text.
 * - **S8 — Never let notification failures throw into orchestration.**
 *   The event listener wraps bus emissions in defensive try/catch blocks.
 */

import type { NotificationBus } from "./bus.js"
import {
  MAX_NOTIFICATION_SUMMARY_CHARACTERS,
  notificationRequestSchema,
  type NotificationDeliveryResult,
  type NotificationRequest,
} from "./types.js"

// ===========================================================================
// Structural Event and Refusal Types (N1: no imports from src/orchestration)
// ===========================================================================

/**
 * Structural shape of an orchestration domain event.
 * Matches `OrchestrationEvent` from `src/orchestration/types.js` structurally,
 * ensuring zero compile-time or runtime upward module edges.
 */
export interface OrchestrationEventLike {
  readonly schemaVersion?: number
  readonly eventId?: string
  readonly sequence?: number
  readonly projectId?: string
  readonly runId?: string
  readonly type: string
  readonly payload?: unknown
  readonly [key: string]: unknown
}

/**
 * Structural input representing a dispatch refusal observation.
 * Provides the context required to notify the operator when a dispatch is blocked.
 */
export interface DispatchRefusalInput {
  readonly runId: string
  readonly taskId?: string
  readonly ruleId?: string
  readonly dispatchId?: string
  readonly reasonCode: string
  readonly detail?: string
}

// ===========================================================================
// Sanitization Helpers (N2: bounded, control-character-free strings)
// ===========================================================================

const CONTROL_CHAR_REGEX = /[\u0000-\u001F\u007F]/g
const DEDUPE_KEY_ALLOWED_REGEX = /[^A-Za-z0-9._:/-]/g
const REASON_CODE_ALLOWED_REGEX = /[^a-z0-9._]/g
const OPAQUE_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function cleanSummary(raw: string): string {
  const sanitized = raw.replace(CONTROL_CHAR_REGEX, " ").trim()
  if (sanitized.length === 0) return "Notification alert"
  if (sanitized.length <= MAX_NOTIFICATION_SUMMARY_CHARACTERS) return sanitized
  return sanitized.slice(0, MAX_NOTIFICATION_SUMMARY_CHARACTERS)
}

function cleanDedupeKey(raw: string): string {
  const filtered = raw.replace(DEDUPE_KEY_ALLOWED_REGEX, "_")
  const trimmed = filtered.replace(/^[^A-Za-z0-9]+/, "")
  if (trimmed.length === 0) return "ntf:event"
  return trimmed.slice(0, 256)
}

function cleanReasonCode(raw: string): string {
  const lower = raw.toLowerCase()
  const filtered = lower.replace(REASON_CODE_ALLOWED_REGEX, "_")
  const trimmed = filtered.replace(/^[^a-z]+/, "")
  if (trimmed.length === 0) return "refused"
  return trimmed.slice(0, 64)
}

function validIdOrUndefined(id: unknown): string | undefined {
  if (typeof id === "string" && OPAQUE_ID_REGEX.test(id)) {
    return id
  }
  return undefined
}

// ===========================================================================
// Event Translation (Mapping significant orchestration moments)
// ===========================================================================

/**
 * Translates an incoming orchestration event to a {@link NotificationRequest},
 * or returns `null` if the event is not one of the significant notification moments.
 *
 * Recognized moments:
 * 1. `roundtable.outcome_recorded` — deliberation completed with outcome.
 * 2. `charter.proposed` — charter proposal awaiting human review.
 * 3. `controller.lease.changed` — controller lease expired or transitioned.
 * 4. `dispatch.finished` — dispatch terminated in failure or timeout.
 * 5. `approval.invalidated` — previously granted approval revoked/invalidated.
 */
export function orchestrationEventToNotification(
  event: OrchestrationEventLike
): NotificationRequest | null {
  const runId = validIdOrUndefined(event.runId)
  const payload = (event.payload !== null && typeof event.payload === "object")
    ? (event.payload as Record<string, unknown>)
    : {}

  switch (event.type) {
    case "roundtable.outcome_recorded": {
      const discussionId = typeof payload.discussionId === "string" ? payload.discussionId : "roundtable"
      const outcome = (payload.outcome !== null && typeof payload.outcome === "object")
        ? (payload.outcome as Record<string, unknown>)
        : {}
      const recommendation = typeof outcome.recommendation === "string" ? outcome.recommendation : "outcome recorded"
      const summary = cleanSummary(`Roundtable discussion ${discussionId} outcome recorded: ${recommendation}`)
      const dedupeKey = cleanDedupeKey(`roundtable_outcome:${discussionId}`)
      const reasonCode = cleanReasonCode("outcome_recorded")

      const candidate: Record<string, unknown> = {
        dedupeKey,
        category: "roundtable_outcome",
        severity: "info",
        summary,
        reasonCode,
      }
      if (runId !== undefined) candidate.runId = runId

      const parsed = notificationRequestSchema.safeParse(candidate)
      return parsed.success ? parsed.data : null
    }

    case "charter.proposed": {
      const proposal = (payload.proposal !== null && typeof payload.proposal === "object")
        ? (payload.proposal as Record<string, unknown>)
        : {}
      const proposalId = typeof payload.proposalId === "string"
        ? payload.proposalId
        : (typeof proposal.charterId === "string" ? proposal.charterId : "charter")
      const summary = cleanSummary(`Charter proposal ${proposalId} awaiting human approval`)
      const dedupeKey = cleanDedupeKey(`charter_proposal:${proposalId}`)
      const reasonCode = cleanReasonCode("charter_proposal")

      const candidate: Record<string, unknown> = {
        dedupeKey,
        category: "pre_approval_pending",
        severity: "attention",
        summary,
        reasonCode,
      }
      if (runId !== undefined) candidate.runId = runId

      const parsed = notificationRequestSchema.safeParse(candidate)
      return parsed.success ? parsed.data : null
    }

    case "controller.lease.changed": {
      const lease = (payload.lease !== null && typeof payload.lease === "object")
        ? (payload.lease as Record<string, unknown>)
        : {}
      const controllerNodeId = validIdOrUndefined(lease.controllerNodeId)
      const summary = cleanSummary(`Controller lease expired or changed for node ${controllerNodeId ?? "unknown"}`)
      const dedupeKey = cleanDedupeKey(`lease_expired:${controllerNodeId ?? "node"}:${runId ?? "lease"}`)
      const reasonCode = cleanReasonCode("lease_expired")

      const candidate: Record<string, unknown> = {
        dedupeKey,
        category: "lease_expired",
        severity: "critical",
        summary,
        reasonCode,
      }
      if (runId !== undefined) candidate.runId = runId
      if (controllerNodeId !== undefined) candidate.nodeId = controllerNodeId

      const parsed = notificationRequestSchema.safeParse(candidate)
      return parsed.success ? parsed.data : null
    }

    case "dispatch.finished": {
      const outcome = typeof payload.outcome === "string" ? payload.outcome : ""
      if (outcome !== "failed" && outcome !== "timed_out" && outcome !== "cancelled") {
        return null
      }
      const dispatchId = validIdOrUndefined(payload.dispatchId)
      const summary = cleanSummary(`Dispatch ${dispatchId ?? "unknown"} finished with outcome ${outcome}`)
      const dedupeKey = cleanDedupeKey(`run_failed:${runId ?? "run"}:${dispatchId ?? "disp"}`)
      const reasonCode = cleanReasonCode("run_failed")

      const candidate: Record<string, unknown> = {
        dedupeKey,
        category: "run_failed",
        severity: "critical",
        summary,
        reasonCode,
      }
      if (runId !== undefined) candidate.runId = runId
      if (dispatchId !== undefined) candidate.dispatchId = dispatchId

      const parsed = notificationRequestSchema.safeParse(candidate)
      return parsed.success ? parsed.data : null
    }

    case "approval.invalidated": {
      const dispatchId = validIdOrUndefined(payload.dispatchId)
      const approvalId = typeof payload.approvalId === "string" ? payload.approvalId : "approval"
      const summary = cleanSummary(`Approval ${approvalId} invalidated for dispatch ${dispatchId ?? "unknown"}`)
      const dedupeKey = cleanDedupeKey(`run_blocked:${runId ?? "run"}:${approvalId}:invalidated`)
      const reasonCode = cleanReasonCode("approval_invalidated")

      const candidate: Record<string, unknown> = {
        dedupeKey,
        category: "run_blocked",
        severity: "attention",
        summary,
        reasonCode,
      }
      if (runId !== undefined) candidate.runId = runId
      if (dispatchId !== undefined) candidate.dispatchId = dispatchId

      const parsed = notificationRequestSchema.safeParse(candidate)
      return parsed.success ? parsed.data : null
    }

    default:
      return null
  }
}

/**
 * Translates a dispatch refusal observation into a {@link NotificationRequest}.
 *
 * Recognized moments:
 * 1. `roundtable_required` — dispatch denied by communication policy requiring a closed roundtable.
 * 2. `budget_exhausted` / `ceiling_exceeded` — dispatch denied due to fan-out or concurrency ceilings.
 * 3. `policy_denied` — general policy rule refusal.
 * 4. `rule_conflict` — conflicting policy rules detected.
 */
export function dispatchRefusalToNotification(
  refusal: DispatchRefusalInput
): NotificationRequest {
  const runId = validIdOrUndefined(refusal.runId)
  const taskId = validIdOrUndefined(refusal.taskId)
  const ruleId = validIdOrUndefined(refusal.ruleId)
  const dispatchId = validIdOrUndefined(refusal.dispatchId)
  const code = refusal.reasonCode.toLowerCase()

  if (code === "roundtable_required") {
    const summary = cleanSummary(`Dispatch for run ${refusal.runId}${taskId ? ` task ${taskId}` : ""} blocked: roundtable required`)
    const dedupeKey = cleanDedupeKey(`run_blocked:${refusal.runId}:${taskId ?? "task"}:roundtable_required`)
    const reasonCode = cleanReasonCode("roundtable_required")

    const candidate: Record<string, unknown> = {
      dedupeKey,
      category: "run_blocked",
      severity: "attention",
      summary,
      reasonCode,
    }
    if (runId !== undefined) candidate.runId = runId
    if (taskId !== undefined) candidate.taskId = taskId
    if (ruleId !== undefined) candidate.ruleId = ruleId
    if (dispatchId !== undefined) candidate.dispatchId = dispatchId

    return notificationRequestSchema.parse(candidate)
  }

  if (code.includes("budget") || code.includes("ceiling") || code.includes("fan_out")) {
    const summary = cleanSummary(`Dispatch for run ${refusal.runId}${taskId ? ` task ${taskId}` : ""} blocked: budget ceiling exceeded`)
    const dedupeKey = cleanDedupeKey(`budget_exhausted:${refusal.runId}:${taskId ?? "task"}:ceiling`)
    const reasonCode = cleanReasonCode("budget_exhausted")

    const candidate: Record<string, unknown> = {
      dedupeKey,
      category: "budget_exhausted",
      severity: "critical",
      summary,
      reasonCode,
    }
    if (runId !== undefined) candidate.runId = runId
    if (taskId !== undefined) candidate.taskId = taskId
    if (dispatchId !== undefined) candidate.dispatchId = dispatchId

    return notificationRequestSchema.parse(candidate)
  }

  if (code.includes("conflict")) {
    const summary = cleanSummary(`Rule conflict detected for run ${refusal.runId}`)
    const dedupeKey = cleanDedupeKey(`rule_conflict:${refusal.runId}:${ruleId ?? "conflict"}`)
    const reasonCode = cleanReasonCode("rule_conflict")

    const candidate: Record<string, unknown> = {
      dedupeKey,
      category: "rule_conflict",
      severity: "attention",
      summary,
      reasonCode,
    }
    if (runId !== undefined) candidate.runId = runId
    if (ruleId !== undefined) candidate.ruleId = ruleId

    return notificationRequestSchema.parse(candidate)
  }

  // Default policy denial (run_blocked)
  const summary = cleanSummary(`Dispatch for run ${refusal.runId}${taskId ? ` task ${taskId}` : ""} blocked by policy rule`)
  const dedupeKey = cleanDedupeKey(`run_blocked:${refusal.runId}:${taskId ?? "task"}:${ruleId ?? "policy"}`)
  const reasonCode = cleanReasonCode(refusal.reasonCode || "policy_denied")

  const candidate: Record<string, unknown> = {
    dedupeKey,
    category: "run_blocked",
    severity: "critical",
    summary,
    reasonCode,
  }
  if (runId !== undefined) candidate.runId = runId
  if (taskId !== undefined) candidate.taskId = taskId
  if (ruleId !== undefined) candidate.ruleId = ruleId
  if (dispatchId !== undefined) candidate.dispatchId = dispatchId

  return notificationRequestSchema.parse(candidate)
}

// ===========================================================================
// Consumer Interface & Factory (N3: total, push-based, advisory only)
// ===========================================================================

export interface OrchestrationNotificationConsumer {
  /**
   * Consumes an orchestration domain event and emits a notification if significant.
   * Total and advisory: never throws, never delays, never alters orchestration state.
   */
  handleEvent(event: OrchestrationEventLike): Promise<readonly NotificationDeliveryResult[]>

  /**
   * Consumes a dispatch refusal observation and emits an advisory notification.
   * Total and advisory: never throws.
   */
  handleRefusal(refusal: DispatchRefusalInput): Promise<readonly NotificationDeliveryResult[]>
}

/**
 * Creates an event-driven notification consumer bound to the given bus.
 *
 * Invariant: Notifications are advisory only. Any exception during translation
 * or delivery is absorbed silently, guaranteeing that the caller's control flow
 * cannot be interrupted or branched upon.
 */
export function createOrchestrationNotificationConsumer(
  bus: NotificationBus
): OrchestrationNotificationConsumer {
  return {
    async handleEvent(event: OrchestrationEventLike): Promise<readonly NotificationDeliveryResult[]> {
      try {
        const request = orchestrationEventToNotification(event)
        if (request === null) return []
        return await bus.emit(request)
      } catch {
        // N3 / S8: Total consumption — failure to translate or deliver never affects caller
        return []
      }
    },

    async handleRefusal(refusal: DispatchRefusalInput): Promise<readonly NotificationDeliveryResult[]> {
      try {
        const request = dispatchRefusalToNotification(refusal)
        return await bus.emit(request)
      } catch {
        return []
      }
    },
  }
}
