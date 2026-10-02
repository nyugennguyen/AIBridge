/**
 * M6.9 — the in-TUI notification adapter, its view model, its reducer, and its key
 * routing.
 *
 * # What this file is
 *
 * ADR 0007 section 17: "An optional adapter interface exists so that a future
 * external sink can be added without a schema change; the in-TUI adapter is the only
 * implementation in this milestone." This is that implementation, plus the view
 * model the M6.8 shell renders.
 *
 * It is an adapter and a view model in one file because the view model is the
 * adapter's OWN state, and splitting them would mean the renderer could hold a
 * projection the adapter does not agree with — which is the drift
 * `src/context/tui/memory-view.ts` spends `verifyPreviewMatchesManifest` existing to
 * catch. Here the inbox a view renders IS the array the adapter appended to.
 *
 * # Why a structured view model and not a rendered string
 *
 * Same decision as `src/context/tui/memory-view.ts` and `src/mesh/tui/view-model.ts`,
 * for the same reason: a renderer is one consumer and a test is another, and a string
 * can only be asserted on with `toContain`. `toContain("run-1")` cannot distinguish
 * "the notification named the run" from "the notification named a run somewhere in
 * a sentence that also contained the prompt".
 *
 * So `buildNotificationTuiView` returns a STRUCTURE with `lines` as a derived
 * member, and the structured fields are what the tests read. `lines` is declared
 * LAST in the interface and assigned last in the builder, so a future field added
 * above it cannot be quietly rendered in a way the structure does not describe.
 *
 * # The notice shape, and the import direction (S4)
 *
 * `notificationNoticeLine` returns `string | null`, which is exactly
 * `TuiUiState.notice` (`src/tui/types.ts:62`) — structurally compatible, not
 * imported. This file does NOT import from `src/tui/`, and `barrel.test.ts` asserts
 * that it does not.
 *
 * The direction is settled, and this is the argument: `src/tui/` importing
 * `src/notifications/` is CORRECT and `src/notifications/` importing `src/tui/` is
 * FORBIDDEN. The TUI is the consumer; a notification that knew how it would be drawn
 * would be a notification that could be made to lie by its own renderer (S4). So the
 * M6.8 integration is an import in `src/tui/`, not in here, and the only thing this
 * side owes is a compatible shape. That is why the shape is `string | null` and not
 * a `TuiNotice` class: a class would have to be imported, and importing it would be
 * the forbidden direction.
 *
 * # `withheldDetail`, and what it withholds
 *
 * Following `renderExclusion` in `memory-view.ts`. A muted entry renders as
 * `muted (by <axis>)` and nothing more about why it was silenced — it does not
 * render its subject. A muted notification is something the user asked not to hear
 * about; rendering its subject on a list screen is showing it anyway, one glance
 * later. An unmuted entry renders fully.
 *
 * So `withheldDetail` here means "this row's subject is not rendered", and it is
 * derived from the disposition rather than stored. A `critical` muted entry is still
 * muted, and the count of muted critical entries is on the quieting line, which is
 * where a user who wants to know goes. Severity is not withheld: hiding "critical"
 * would hide the reason to un-mute.
 *
 * # Age is a closed-vocabulary label, never a duration string
 *
 * `renderAge` maps elapsed milliseconds onto a fixed set of words — `just now`,
 * `Nm`, `Nh`, `Nd`, `aged`. Never `toLocaleString`, never a locale-formatted
 * duration, never `Math.round` on a raw millisecond count (N5, N6). A TUI line that
 * said `5 minutes ago` in one locale and `vor 5 Minuten` in another would make the
 * determinism test machine-dependent, and the same emitted sequence would render
 * differently on two machines.
 *
 * # Named invariants
 *
 *   - **N2 — No secrets.** Every string this module renders came out of a
 *     `NotificationEnvelope`, and the envelope cannot carry content
 *     (`types.ts` N2). There is no string concatenation here that could introduce
 *     one, and `no-secrets.test.ts` asserts it over `lines` and the notice.
 *   - **N4 — The adapter stores envelopes verbatim.** `append` pushes the object it
 *     was handed. It does not re-serialize, re-shape, or annotate.
 *   - **N5 — Code-unit ordering, never `localeCompare`.** The inbox is listed in the
 *     store's order (severity, then age, then id) and this module preserves it. Rows
 *     are not re-sorted here.
 *   - **N6 — Injected clock.** `now` arrives on the view request. This module reads
 *     no ambient time.
 *   - **N12 — Derived, not filtered.** Every row in the view comes from a store
 *     entry. The view model filters nothing: a notification the operator silenced
 *     is on the list, marked muted, because a mute that removes the row is a mute
 *     that removes the evidence (store.ts, "The decision on storing muted entries").
 *     The list is the store's list.
 *   - **N13 — Exhaustive reducer.** `reduceNotificationTui` switches over every
 *     `NotificationTuiAction` with no `default` clause, so a new action is a compile
 *     error rather than a silently ignored keystroke (`src/tui/state.ts:46-144`).
 *
 * # Stop conditions
 *
 *   - **S11 — If the view needs a field the envelope does not carry, stop and change
 *     the envelope deliberately** (`types.ts` S1). The temptation here is to derive
 *     it from something already on the envelope and smuggle content in that way.
 *   - **S12 — If this file ever needs to import from `src/tui/`, the direction is
 *     wrong, not the import** (S4). The compatible shape is `string | null` and it
 *     is compatible on purpose.
 *   - **S13 — If a keystroke would need authorization to do anything, it must be
 *     refused with a reason, not dispatched.** The notification screen has no write
 *     action except acknowledgement, and acknowledgement is dispatched through the
 *     same `acknowledge` action the reducer handles — which is a caller-side effect,
 *     deliberately NOT performed here. A keystroke that silently does nothing is
 *     worse than one that says why.
 */

import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_SEVERITIES,
  compareNotificationCodeUnits,
  notificationEnvelopeSchema,
  type NotificationAdapter,
  type NotificationCategory,
  type NotificationDeliveryResult,
  type NotificationEnvelope,
  type NotificationId,
  type NotificationQuieting,
  type NotificationSeverity,
  type NotificationTimestamp,
} from "./types.js"
import type { NotificationInboxEntry, NotificationStore } from "./store.js"
import { normalizeNotificationQuieting, notificationMuteVerdict } from "./store.js"

export const NOTIFICATION_TUI_ADAPTER_ID = "in-tui-inbox"

/** Human titles for the closed category enum. A lookup, never a formatted string. */
const CATEGORY_TITLES: Readonly<Record<NotificationCategory, string>> = Object.freeze({
  run_blocked: "Run blocked",
  run_failed: "Run failed",
  lease_expired: "Lease expired",
  budget_exhausted: "Budget exhausted",
  rule_conflict: "Rule conflict",
  pre_approval_pending: "Pre-approval pending",
})

/** One-line markers for the closed severity enum. */
const SEVERITY_MARKERS: Readonly<Record<NotificationSeverity, string>> = Object.freeze({
  critical: "!!",
  attention: "! ",
  info: "  ",
})

export interface NotificationTuiAdapter extends NotificationAdapter {
  readonly id: string
  /** The adapter's own copy of what it was handed, verbatim and in arrival order (N4). */
  list(): readonly NotificationEnvelope[]
  /** How many entries the adapter holds. */
  size(): number
  /** Forget every entry. The M6.8 shell calls this on a screen change. */
  clear(): void
}

/**
 * The in-TUI adapter.
 *
 * Appends each delivered envelope to an in-process array the TUI reads, and returns
 * `delivered: true`. It cannot fail in a way the bus would notice, which is the
 * point: the bus's error paths are exercised by adapters that CAN fail (see
 * `tests/unit/notifications/fixtures.ts`), not by the one that ships.
 *
 * `available()` is present and always true, so the "adapter reports itself
 * unavailable" path is reachable in production configuration rather than only in a
 * test double. It is a hook, not a policy.
 */
export function createNotificationTuiAdapter(): NotificationTuiAdapter {
  const entries: NotificationEnvelope[] = []
  return {
    id: NOTIFICATION_TUI_ADAPTER_ID,
    available: () => true,
    async deliver(envelope: NotificationEnvelope): Promise<NotificationDeliveryResult> {
      // VALIDATE, then append the ORIGINAL OBJECT.
      //
      // The schema is a gate here, not a transformer: `parse` would return a fresh
      // object, and the adapter's inbox is supposed to hold the very envelope the bus
      // built and the store kept (N4). A TUI that renders `undefined` is worse than one
      // that renders nothing, so the refusal is right and the copy is not (N2).
      const validation = notificationEnvelopeSchema.safeParse(envelope)
      if (!validation.success) {
        throw new TypeError("envelope does not satisfy notificationEnvelopeSchema")
      }
      entries.push(envelope)
      return { delivered: true, notificationId: envelope.notificationId }
    },
    list: () => Object.freeze([...entries]),
    size: () => entries.length,
    clear: () => {
      entries.length = 0
    },
  }
}

// ===========================================================================
// View model
// ===========================================================================

export type NotificationTuiScreen = "list" | "detail" | "quieting"
export type NotificationTuiOverlay = "none" | "help"

export interface NotificationTuiUiState {
  readonly screen: NotificationTuiScreen
  readonly overlay: NotificationTuiOverlay
  /** Store entries, in the store's order (N5, N12). */
  readonly entries: readonly NotificationInboxEntry[]
  readonly selectedIndex: number
  readonly scrollOffset: number
  readonly quieting: NotificationQuieting
  /** The clock reading the last render used, so `renderAge` is reproducible (N6). */
  readonly now: NotificationTimestamp
  /** Non-sensitive status, shaped like `TuiUiState.notice` but owned here (S4, S12). */
  readonly notice: string | null
  readonly error: string | null
}

export type NotificationTuiAction =
  | { readonly type: "entries-loaded"; readonly entries: readonly NotificationInboxEntry[]; readonly now: NotificationTimestamp }
  | { readonly type: "navigate"; readonly screen: NotificationTuiScreen }
  | { readonly type: "set-overlay"; readonly overlay: NotificationTuiOverlay }
  | { readonly type: "select"; readonly index: number }
  | { readonly type: "move"; readonly delta: number }
  | { readonly type: "scroll"; readonly delta: number }
  | { readonly type: "set-quieting"; readonly quieting: NotificationQuieting }
  | { readonly type: "toggle-quiet-category"; readonly category: NotificationCategory }
  | { readonly type: "toggle-quiet-severity"; readonly severity: NotificationSeverity }
  | { readonly type: "toggle-quiet-pair"; readonly category: NotificationCategory; readonly severity: NotificationSeverity }
  | { readonly type: "notice"; readonly message: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "clear-error" }

export const NOTIFICATION_TUI_ACTIONS = [
  "entries-loaded",
  "navigate",
  "set-overlay",
  "select",
  "move",
  "scroll",
  "set-quieting",
  "toggle-quiet-category",
  "toggle-quiet-severity",
  "toggle-quiet-pair",
  "notice",
  "error",
  "clear-error",
] as const
export type NotificationTuiActionType = (typeof NOTIFICATION_TUI_ACTIONS)[number]

export type NotificationTuiKey =
  | { readonly type: "key"; readonly name: string; readonly ctrl?: boolean }
  | { readonly type: "paste"; readonly text: string }

export type NotificationTuiIntent =
  | { readonly type: "none" }
  | { readonly type: "close" }
  /** Perform the acknowledged ids against the store, then dispatch `entries-loaded`. */
  | { readonly type: "acknowledge"; readonly notificationIds: readonly NotificationId[] }
  | { readonly type: "dispatch"; readonly action: NotificationTuiAction }
  | { readonly type: "reject"; readonly reason: string }

export function initialNotificationTuiState(now: NotificationTimestamp): NotificationTuiUiState {
  return {
    screen: "list",
    overlay: "none",
    entries: [],
    selectedIndex: 0,
    scrollOffset: 0,
    quieting: normalizeNotificationQuieting({ categories: [], severities: [], pairs: [] }),
    now,
    notice: null,
    error: null,
  }
}

/** Pure reducer, exhaustive over `NotificationTuiAction` with no `default` (N13). */
export function reduceNotificationTui(state: NotificationTuiUiState, action: NotificationTuiAction): NotificationTuiUiState {
  switch (action.type) {
    case "entries-loaded":
      return {
        ...state,
        entries: action.entries,
        selectedIndex: 0,
        scrollOffset: 0,
        now: action.now,
        error: null,
      }
    case "navigate":
      return { ...state, screen: action.screen, overlay: "none", scrollOffset: 0 }
    case "set-overlay":
      return { ...state, overlay: action.overlay }
    case "select":
      return { ...state, selectedIndex: clampIndex(action.index, state.entries.length) }
    case "move": {
      const last = Math.max(0, state.entries.length - 1)
      return { ...state, selectedIndex: Math.max(0, Math.min(state.selectedIndex + action.delta, last)) }
    }
    case "scroll":
      return { ...state, scrollOffset: Math.max(0, state.scrollOffset + action.delta) }
    case "set-quieting":
      // Normalized here so the reducer's output is order-independent: two settings
      // describing the same silences produce the same state (N5).
      return { ...state, quieting: normalizeNotificationQuieting(action.quieting) }
    case "toggle-quiet-category": {
      const categories = state.quieting.categories.includes(action.category)
        ? state.quieting.categories.filter((category) => category !== action.category)
        : [...state.quieting.categories, action.category]
      return { ...state, quieting: normalizeNotificationQuieting({ ...state.quieting, categories }) }
    }
    case "toggle-quiet-severity": {
      const severities = state.quieting.severities.includes(action.severity)
        ? state.quieting.severities.filter((severity) => severity !== action.severity)
        : [...state.quieting.severities, action.severity]
      return { ...state, quieting: normalizeNotificationQuieting({ ...state.quieting, severities }) }
    }
    case "toggle-quiet-pair": {
      const present = state.quieting.pairs.some((pair) => pair.category === action.category && pair.severity === action.severity)
      const pairs = present
        ? state.quieting.pairs.filter((pair) => !(pair.category === action.category && pair.severity === action.severity))
        : [...state.quieting.pairs, { category: action.category, severity: action.severity }]
      return { ...state, quieting: normalizeNotificationQuieting({ ...state.quieting, pairs }) }
    }
    case "notice":
      return { ...state, notice: action.message, error: null }
    case "error":
      return { ...state, error: action.message, notice: null }
    case "clear-error":
      return { ...state, error: null }
  }
}

function clampIndex(index: number, length: number): number {
  if (length === 0) return 0
  return Math.max(0, Math.min(index, length - 1))
}

/**
 * Key routing. Pure, with no access to a store or a renderer.
 *
 * `enter` on a selected row returns an `acknowledge` INTENT rather than a
 * dispatch of an acknowledge action, because acknowledgement is a store write and
 * this module holds a store only as a read. The shell performs the writes and
 * dispatches `entries-loaded` with the result. That keeps the reducer pure and keeps
 * the acknowledgement effect in the caller, which is also the caller that owns the
 * TUI's lifecycle (S13).
 */
export function routeNotificationKey(state: NotificationTuiUiState, key: NotificationTuiKey): NotificationTuiIntent {
  if (key.type === "paste") {
    // Pasted text has no meaning on this screen. It is refused with a reason rather
    // than filtered into a search box, because a notification list that could be
    // searched would be a place content could be echoed back (N2, S13).
    return { type: "reject", reason: "pasted text is not accepted on the notification screen" }
  }
  if (key.ctrl && key.name.toLowerCase() === "c") return { type: "close" }
  if (key.name === "?" || key.name === "f1") {
    return {
      type: "dispatch",
      action: { type: "set-overlay", overlay: state.overlay === "help" ? "none" : "help" },
    }
  }
  if (key.name === "escape") {
    if (state.overlay !== "none") return { type: "dispatch", action: { type: "set-overlay", overlay: "none" } }
    if (state.screen !== "list") return { type: "dispatch", action: { type: "navigate", screen: "list" } }
    return { type: "none" }
  }

  switch (state.screen) {
    case "list": {
      if (key.name === "j" || key.name === "down") return { type: "dispatch", action: { type: "move", delta: 1 } }
      if (key.name === "k" || key.name === "up") return { type: "dispatch", action: { type: "move", delta: -1 } }
      if (key.name === "enter") {
        const entry = state.entries[clampIndex(state.selectedIndex, state.entries.length)]
        if (entry === undefined) return { type: "none" }
        return { type: "acknowledge", notificationIds: [entry.envelope.notificationId] }
      }
      if (key.name === "a") {
        // Acknowledge every PENDING entry. Muted entries are left alone: the user
        // silenced them, and a bulk-ack that silently deleted the evidence of what
        // they silenced would make the mute indistinguishable from a loss (store.ts).
        return {
          type: "acknowledge",
          notificationIds: state.entries.filter((entry) => entry.disposition === "pending").map((entry) => entry.envelope.notificationId),
        }
      }
      if (key.name === "q") return { type: "dispatch", action: { type: "navigate", screen: "quieting" } }
      break
    }
    case "detail":
      if (key.name === "j" || key.name === "down") return { type: "dispatch", action: { type: "move", delta: 1 } }
      if (key.name === "k" || key.name === "up") return { type: "dispatch", action: { type: "move", delta: -1 } }
      break
    case "quieting": {
      if (key.name === "j" || key.name === "down") {
        return { type: "dispatch", action: { type: "move", delta: 1 } }
      }
      if (key.name === "k" || key.name === "up") {
        return { type: "dispatch", action: { type: "move", delta: -1 } }
      }
      if (key.name === "c" || key.name === "s") {
        // `c` cycles categories, `s` cycles severities. Cycling a closed enum in
        // declaration order rather than a filtered list: the filter would have to
        // render every value, and a cycle cannot go off the end.
        const index = clampIndex(state.selectedIndex, NOTIFICATION_CATEGORIES.length)
        const category = NOTIFICATION_CATEGORIES[index]!
        if (key.name === "c") return { type: "dispatch", action: { type: "toggle-quiet-category", category } }
        const severity = NOTIFICATION_SEVERITIES[index]!
        return { type: "dispatch", action: { type: "toggle-quiet-severity", severity } }
      }
      break
    }
  }

  return { type: "none" }
}

// ===========================================================================
// The view model
// ===========================================================================

export interface NotificationTuiRow {
  readonly notificationId: NotificationId
  readonly category: NotificationCategory
  readonly categoryTitle: string
  readonly severity: NotificationSeverity
  readonly marker: string
  /** The envelope's own summary. Truncated by a fixed, stated rule. */
  readonly summary: string
  /** Closed-vocabulary age label. Never a locale-formatted duration. */
  readonly age: string
  readonly disposition: "pending" | "muted"
  /** Which axis muted it, or `null`. `null` for a pending row. */
  readonly mutedBy: "category" | "severity" | "pair" | null
  /**
   * True when this row's SUBJECT is not rendered.
   *
   * A muted row withholds its subject. Severity and category are still rendered,
   * because hiding "critical" would hide the reason to un-mute.
   */
  readonly withheldDetail: boolean
  readonly runId?: string
  readonly taskId?: string
  readonly dispatchId?: string
  readonly nodeId?: string
  readonly ruleId?: string
  readonly reasonCode?: string
}

export interface NotificationTuiQuietingLine {
  readonly axis: "category" | "severity" | "pair"
  readonly label: string
  readonly muted: boolean
}

export interface NotificationTuiViewModel {
  readonly screen: NotificationTuiScreen
  readonly title: string
  readonly rows: readonly NotificationTuiRow[]
  readonly selectedIndex: number
  readonly selected: NotificationTuiRow | null
  /** How many rows are `pending` — i.e. unacknowledged and unmuted. */
  readonly unreadCount: number
  /** How many rows are `muted`. Shown so a mute is not invisible. */
  readonly mutedCount: number
  /** One line per quieting axis, in a fixed order. */
  readonly quietingLines: readonly NotificationTuiQuietingLine[]
  /** A single-line summary of the quieting settings. Never a formatted list. */
  readonly quietingSummary: string
  readonly notice: string | null
  readonly error: string | null
  /**
   * The rendered lines. Declared LAST and assigned LAST, so the structure is the
   * source of truth and the lines are a projection of it.
   */
  readonly lines: readonly string[]
}

/** Row characters. Long, so the wrapped form is distinguishable from a short one. */
const ROW_SUMMARY_CHARACTERS = 96

/**
 * Truncate to a fixed width.
 *
 * The ellipsis is a literal `…`, so a truncated row is distinguishable from a short
 * one that happens to end in a period — the `memory-view.ts` rule, kept because it
 * makes an assertion about truncation possible at all.
 */
export function summarizeNotification(summary: string): string {
  const collapsed = summary.replace(/\s+/g, " ").trim()
  if (collapsed.length <= ROW_SUMMARY_CHARACTERS) return collapsed
  return `${collapsed.slice(0, ROW_SUMMARY_CHARACTERS - 1)}…`
}

/**
 * A closed-vocabulary age label.
 *
 * Never a locale-formatted duration and never a raw millisecond count (N5, N6). The
 * buckets are fixed so that two machines with different locale data render the same
 * row identically, which is what makes the 50-run determinism test mean anything.
 */
export function renderAge(nowMs: number, createdAtMs: number): string {
  const elapsed = Math.max(0, nowMs - createdAtMs)
  const second = 1000
  const minute = 60 * second
  const hour = 60 * minute
  const day = 24 * hour
  if (elapsed < minute) return "just now"
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`
  if (elapsed < 30 * day) return `${Math.floor(elapsed / day)}d`
  return "aged"
}

function titleFor(screen: NotificationTuiScreen): string {
  switch (screen) {
    case "list":
      return "Notifications"
    case "detail":
      return "Notification detail"
    case "quieting":
      return "Notification quieting"
  }
}

/**
 * Render a row's subject line.
 *
 * A muted row renders `muted (by <axis>)` and NOTHING else — no summary, no run id,
 * no rule id. That is `withheldDetail` (the `renderExclusion` rule from
 * `memory-view.ts`): a user who silenced a category asked not to be shown it, and
 * rendering the subject one glance later is showing it anyway.
 *
 * Severity and category survive the withholding, deliberately. A list that hid
 * "critical" from a muted row would remove the only signal that would make the user
 * un-mute it.
 */
export function renderRowSubject(row: NotificationTuiRow): string {
  if (row.withheldDetail) return `muted (by ${row.mutedBy ?? "category"})`
  const subject = [row.runId, row.taskId, row.dispatchId, row.nodeId, row.ruleId, row.reasonCode]
    .filter((part): part is string => part !== undefined)
    .join(" ")
  return subject.length > 0 ? `${row.summary} [${subject}]` : row.summary
}

/**
 * Build the view. Pure: no I/O, no clock, no store.
 *
 * `now` arrives on the state, injected when the state was built (N6). Rows come from
 * the store's entries in the store's order (N12, N5) — this function does not sort,
 * because a view that sorted would be a view whose output depended on a preference it
 * also performed.
 */
export function buildNotificationTuiView(state: NotificationTuiUiState): NotificationTuiViewModel {
  const nowMs = Date.parse(state.now)
  const rows = state.entries.map<NotificationTuiRow>((entry) => {
    const envelope = entry.envelope
    const withheldDetail = entry.disposition === "muted"
    return {
      notificationId: envelope.notificationId,
      category: envelope.category,
      categoryTitle: CATEGORY_TITLES[envelope.category],
      severity: envelope.severity,
      marker: SEVERITY_MARKERS[envelope.severity],
      summary: summarizeNotification(envelope.summary),
      age: renderAge(nowMs, Date.parse(envelope.createdAt)),
      disposition: entry.disposition,
      mutedBy: entry.disposition === "muted" ? entry.mutedBy ?? "category" : null,
      withheldDetail,
      ...(envelope.runId === undefined ? {} : { runId: envelope.runId }),
      ...(envelope.taskId === undefined ? {} : { taskId: envelope.taskId }),
      ...(envelope.dispatchId === undefined ? {} : { dispatchId: envelope.dispatchId }),
      ...(envelope.nodeId === undefined ? {} : { nodeId: envelope.nodeId }),
      ...(envelope.ruleId === undefined ? {} : { ruleId: envelope.ruleId }),
      ...(envelope.reasonCode === undefined ? {} : { reasonCode: envelope.reasonCode }),
    }
  })

  const selectedIndex = clampIndex(state.selectedIndex, rows.length)
  const quietingLines = buildQuietingLines(state.quieting)

  const view: NotificationTuiViewModel = {
    screen: state.screen,
    title: titleFor(state.screen),
    rows,
    selectedIndex,
    selected: rows[selectedIndex] ?? null,
    unreadCount: rows.filter((row) => row.disposition === "pending").length,
    mutedCount: rows.filter((row) => row.disposition === "muted").length,
    quietingLines,
    quietingSummary: describeQuieting(state.quieting),
    notice: state.notice,
    error: state.error,
    lines: [],
  }
  return { ...view, lines: renderNotificationLines(view, state) }
}

/**
 * The quieting screen's lines: one per axis, in a fixed order.
 *
 * Declared order, not code-unit order, because the axes have a reading order the
 * user chose: which categories, then which severities, then which pairs. Code-unit
 * would interleave them and the list would stop being readable as a policy.
 */
function buildQuietingLines(quieting: NotificationQuieting): readonly NotificationTuiQuietingLine[] {
  return Object.freeze([
    ...NOTIFICATION_CATEGORIES.map<NotificationTuiQuietingLine>((category) => ({
      axis: "category" as const,
      label: category,
      muted: quieting.categories.includes(category),
    })),
    ...NOTIFICATION_SEVERITIES.map<NotificationTuiQuietingLine>((severity) => ({
      axis: "severity" as const,
      label: severity,
      muted: quieting.severities.includes(severity),
    })),
  ])
}

/**
 * A single-line quieting summary. A fixed vocabulary, not an interpolation.
 *
 * `none` when nothing is muted, so the common case is one short word rather than
 * three empty clauses. Otherwise `muted categories=a,b; severities=c` — and the
 * sorted lists make two equal settings produce two equal summaries (N5).
 */
export function describeQuieting(quieting: NotificationQuieting): string {
  const parts: string[] = []
  if (quieting.categories.length > 0) parts.push(`categories=${quieting.categories.join(",")}`)
  if (quieting.severities.length > 0) parts.push(`severities=${quieting.severities.join(",")}`)
  if (quieting.pairs.length > 0) {
    parts.push(`pairs=${quieting.pairs.map((pair) => `${pair.category}/${pair.severity}`).join(",")}`)
  }
  return parts.length === 0 ? "none" : `muted ${parts.join("; ")}`
}

function renderNotificationLines(view: NotificationTuiViewModel, state: NotificationTuiUiState): readonly string[] {
  const lines: string[] = [
    `AIBridge — ${view.title}`,
    `notifications: ${view.unreadCount} unread, ${view.mutedCount} muted`,
    `quieting: ${view.quietingSummary}`,
    "",
  ]

  if (view.error !== null) lines.push(`error: ${view.error}`)
  if (view.notice !== null) lines.push(`notice: ${view.notice}`)

  switch (view.screen) {
    case "list": {
      if (view.rows.length === 0) {
        lines.push("no notifications")
        break
      }
      view.rows.forEach((row, index) => {
        const marker = index === view.selectedIndex ? ">" : " "
        const flags = [row.categoryTitle, row.severity, row.age]
        if (row.disposition === "muted") flags.push(`muted:${row.mutedBy ?? "category"}`)
        lines.push(`${marker} ${row.marker} [${flags.join(" ")}] ${renderRowSubject(row)}`)
      })
      break
    }
    case "detail": {
      if (view.selected === null) {
        lines.push("no notification selected")
        break
      }
      const row = view.selected
      lines.push(`${row.categoryTitle} (${row.severity})`)
      lines.push(`notification: ${row.notificationId}`)
      lines.push(`age: ${row.age}`)
      lines.push(`disposition: ${row.disposition}`)
      if (row.mutedBy !== null) lines.push(`muted by: ${row.mutedBy}`)
      if (row.withheldDetail) {
        lines.push("subject withheld: this notification is muted")
      } else {
        lines.push(renderRowSubject(row))
        if (row.runId !== undefined) lines.push(`run: ${row.runId}`)
        if (row.taskId !== undefined) lines.push(`task: ${row.taskId}`)
        if (row.dispatchId !== undefined) lines.push(`dispatch: ${row.dispatchId}`)
        if (row.nodeId !== undefined) lines.push(`node: ${row.nodeId}`)
        if (row.ruleId !== undefined) lines.push(`rule: ${row.ruleId}`)
        if (row.reasonCode !== undefined) lines.push(`reason: ${row.reasonCode}`)
      }
      break
    }
    case "quieting": {
      lines.push("categories and severities may be muted; pairs are configured in settings")
      view.quietingLines.forEach((line, index) => {
        const marker = index === view.selectedIndex ? ">" : " "
        lines.push(`${marker} ${line.muted ? "[x]" : "[ ]"} ${line.axis}: ${line.label}`)
      })
      break
    }
  }

  if (state.overlay === "help") {
    lines.push("")
    lines.push("j/k move   enter acknowledge   a acknowledge all unread   q quieting   ? close help")
  }
  return Object.freeze(lines)
}

/**
 * The one-line notice, shaped for `TuiUiState.notice`.
 *
 * Returns `string | null` and NOTHING else, because `src/tui/types.ts:62` declares
 * `notice: string | null` and this file must not import from `src/tui/` (S4, S12).
 * The compatibility is structural, and `barrel.test.ts` asserts the type identity by
 * assigning a call's result to a locally-declared `{ notice: string | null }`.
 *
 * The most severe unread row wins, so a `critical` is not hidden behind four `info`
 * lines. When everything is muted it says so in one short sentence rather than
 * choosing a row, because naming a muted row here would defeat the withholding
 * (N12).
 */
export function notificationNoticeLine(state: NotificationTuiUiState): string | null {
  const pending = state.entries.filter((entry) => entry.disposition === "pending")
  if (pending.length === 0) {
    const mutedCount = state.entries.length
    return mutedCount === 0 ? null : `${mutedCount} muted notification(s), none pending`
  }
  const rank: Readonly<Record<NotificationSeverity, number>> = { critical: 0, attention: 1, info: 2 }
  let best: NotificationInboxEntry | null = null
  for (const entry of pending) {
    if (best === null) {
      best = entry
      continue
    }
    const bySeverity = rank[entry.envelope.severity] - rank[best.envelope.severity]
    if (bySeverity < 0) best = entry
    else if (bySeverity === 0 && compareNotificationCodeUnits(entry.envelope.notificationId, best.envelope.notificationId) < 0) {
      best = entry
    }
  }
  if (best === null) return null
  const envelope = best.envelope
  const row: NotificationTuiRow = {
    notificationId: envelope.notificationId,
    category: envelope.category,
    categoryTitle: CATEGORY_TITLES[envelope.category],
    severity: envelope.severity,
    marker: SEVERITY_MARKERS[envelope.severity],
    summary: summarizeNotification(envelope.summary),
    age: renderAge(Date.parse(state.now), Date.parse(envelope.createdAt)),
    disposition: best.disposition,
    mutedBy: null,
    withheldDetail: false,
    ...(envelope.runId === undefined ? {} : { runId: envelope.runId }),
    ...(envelope.taskId === undefined ? {} : { taskId: envelope.taskId }),
    ...(envelope.dispatchId === undefined ? {} : { dispatchId: envelope.dispatchId }),
    ...(envelope.nodeId === undefined ? {} : { nodeId: envelope.nodeId }),
    ...(envelope.ruleId === undefined ? {} : { ruleId: envelope.ruleId }),
    ...(envelope.reasonCode === undefined ? {} : { reasonCode: envelope.reasonCode }),
  }
  return `${CATEGORY_TITLES[envelope.category]}: ${summarizeNotification(envelope.summary)} (${pending.length} pending)`
}

/**
 * Read the store into TUI state. The one place the view and the store meet.
 *
 * Takes `now` rather than reading a clock, so a test renders at a chosen instant and
 * the M6.8 shell passes the same value it gave the bus.
 */
export function loadNotificationTuiEntries(
  store: NotificationStore,
  state: NotificationTuiUiState,
  now: NotificationTimestamp,
): NotificationTuiUiState {
  return reduceNotificationTui(state, { type: "entries-loaded", entries: store.entries(), now })
}

/**
 * Apply acknowledgements and reload. The shell's write path.
 *
 * Split out so the acknowledgement side effect lives in one function rather than in
 * a keystroke handler, and so a caller can ack without a keystroke (a timeout, an
 * auto-dismiss policy) using the same code.
 */
export function acknowledgeNotificationEntries(
  store: NotificationStore,
  ids: readonly NotificationId[],
): number {
  let removed = 0
  for (const id of ids) {
    if (store.acknowledge(id)) removed += 1
  }
  return removed
}

/**
 * Whether a notification WOULD be muted by the given settings.
 *
 * Exported so a TUI can show a "this will be muted" hint at emit time without
 * duplicating the rule. It is the same function the bus calls, which is the point:
 * two implementations of quieting would be two answers (store.ts S7).
 */
export function isNotificationMuted(quieting: NotificationQuieting, category: NotificationCategory, severity: NotificationSeverity): boolean {
  return notificationMuteVerdict(quieting, category, severity).muted
}

export type { NotificationInboxEntry }
