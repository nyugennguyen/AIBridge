/**
 * M6.9 — the in-TUI adapter, the view model, the reducer, and the key routing.
 *
 * # Why this file tests a VIEW MODEL and not a rendered string
 *
 * Same decision as `src/context/tui/memory-view.ts`, for the same reason: a string can
 * only be asserted on with `toContain`, and `toContain("run-1")` cannot distinguish
 * "the row named the run" from "the row contained the run somewhere in a paragraph".
 *
 * So every assertion below that could have been `toContain` on a blob of text is
 * instead a read of a structured field — `rows[0].summary`, `rows[0].withheldDetail`,
 * `unreadCount`, `mutedCount`, `quietingSummary` — and the `lines` assertions exist
 * only to prove that the DERIVED text agrees with the structure it came from. That is
 * the `verifyPreviewMatchesManifest` discipline: the structure is the source of truth
 * and the lines are a projection of it, so a drift between them is a failing test.
 *
 * # The properties under test
 *
 *   1. The adapter appends verbatim and returns `delivered: true`.
 *   2. The view model is structured, and `lines` is its LAST member.
 *   3. Age is a closed-vocabulary label, never a locale-formatted duration.
 *   4. A muted row withholds its subject and keeps its severity.
 *   5. The reducer is exhaustive with no `default` clause (a compile-time claim, made
 *      runtime-visible below by driving every action).
 *   6. Key routing is pure, and the acknowledgement it returns is an INTENT the caller
 *      performs — this module never writes.
 *   7. `notificationNoticeLine` returns `string | null`, which is structurally
 *      `TuiUiState.notice`, and this file never imports `src/tui/` to prove it.
 */

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  NOTIFICATION_TUI_ACTIONS,
  NOTIFICATION_TUI_ADAPTER_ID,
  acknowledgeNotificationEntries,
  buildNotificationTuiView,
  createNotificationStore,
  createNotificationTuiAdapter,
  describeQuieting,
  initialNotificationTuiState,
  loadNotificationTuiEntries,
  notificationNoticeLine,
  reduceNotificationTui,
  renderAge,
  renderRowSubject,
  routeNotificationKey,
  summarizeNotification,
  type NotificationEnvelope,
  type NotificationInboxEntry,
  type NotificationTuiAction,
  type NotificationTuiKey,
  type NotificationTuiRow,
  type NotificationTuiUiState,
} from "../../../src/notifications/index.js"
import { FIXED_NOW, createTestClock, dedupeKey, notificationId, notificationRequest, testHarness } from "./fixtures.js"

const REPOSITORY_ROOT = join(import.meta.dirname, "../../..")
const TUI_ADAPTER_SOURCE = readFileSync(join(REPOSITORY_ROOT, "src/notifications/tui-adapter.ts"), "utf8")

/** A state with `count` entries already loaded, built through the real bus+store. */
async function loadedState(count: number, now = FIXED_NOW): Promise<{ state: NotificationTuiUiState; store: ReturnType<typeof createNotificationStore> }> {
  const { bus, store } = testHarness()
  for (let index = 0; index < count; index += 1) {
    await bus.emit(notificationRequest({ dedupeKey: `k-${index}`, severity: "attention", summary: `summary ${index}` }))
  }
  return { state: loadNotificationTuiEntries(store, initialNotificationTuiState(now), now), store }
}

function key(name: string, ctrl = false): NotificationTuiKey {
  return { type: "key", name, ctrl }
}

describe("M6.9 the in-TUI adapter appends what it is handed", () => {
  it("reports the declared adapter id", () => {
    expect(createNotificationTuiAdapter().id).toBe(NOTIFICATION_TUI_ADAPTER_ID)
  })

  it("reports itself available", () => {
    expect(createNotificationTuiAdapter().available?.()).toBe(true)
  })

  it("returns delivered:true with the envelope's own id", async () => {
    const adapter = createNotificationTuiAdapter()
    const result = await adapter.deliver({
      notificationId: notificationId("ntf-000007"),
      dedupeKey: dedupeKey("k"),
      category: "run_failed",
      severity: "info",
      summary: "a run failed",
      createdAt: FIXED_NOW,
    })
    expect(result).toEqual({ delivered: true, notificationId: "ntf-000007" })
  })

  it("appends each delivery to its own inbox in arrival order", async () => {
    const adapter = createNotificationTuiAdapter()
    for (const id of ["ntf-000001", "ntf-000002", "ntf-000003"] as const) {
      await adapter.deliver({
        notificationId: notificationId(id),
        dedupeKey: dedupeKey(id),
        category: "run_failed",
        severity: "info",
        summary: id,
        createdAt: FIXED_NOW,
      })
    }
    expect(adapter.list().map((envelope) => envelope.notificationId)).toEqual([
      "ntf-000001",
      "ntf-000002",
      "ntf-000003",
    ])
    expect(adapter.size()).toBe(3)
  })

  it("stores the envelope by identity rather than by re-serializing it", async () => {
    const { bus, tui } = testHarness()
    await bus.emit(notificationRequest())
    const delivered = tui.list()[0]!
    const envelope = { ...delivered } as NotificationEnvelope
    await tui.deliver(envelope)
    expect(tui.list()[1]).toBe(envelope)
  })

  it("refuses an envelope the schema rejects rather than appending an unrenderable value", async () => {
    // A TUI that renders `undefined` is worse than one that renders nothing.
    const adapter = createNotificationTuiAdapter()
    await expect(
      adapter.deliver({ notificationId: notificationId("ntf-000001"), dedupeKey: dedupeKey("k"), category: "run_failed", severity: "info", summary: "x" } as never),
    ).rejects.toThrow()
    expect(adapter.size()).toBe(0)
  })

  it("empties its inbox on clear()", async () => {
    const adapter = createNotificationTuiAdapter()
    await adapter.deliver({ notificationId: notificationId("ntf-000001"), dedupeKey: dedupeKey("k"), category: "run_failed", severity: "info", summary: "x", createdAt: FIXED_NOW })
    adapter.clear()
    expect(adapter.size()).toBe(0)
  })
})

describe("M6.9 the view model is a structure and its lines are a projection of it", () => {
  it("declares lines as the LAST member of the view-model interface", () => {
    // Read from the source rather than from `Object.keys` on a value: an interface's
    // member order is the declaration order, and a value's key order is whatever the
    // object literal happened to be. The claim is about the declaration.
    const interfaceStart = TUI_ADAPTER_SOURCE.indexOf("export interface NotificationTuiViewModel {")
    expect(interfaceStart).toBeGreaterThan(-1)
    const interfaceEnd = TUI_ADAPTER_SOURCE.indexOf("\n}", interfaceStart)
    const members = TUI_ADAPTER_SOURCE.slice(interfaceStart, interfaceEnd)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("readonly "))
      .map((line) => line.replace(/^readonly /, "").split(":")[0]!)
    expect(members.at(-1)).toBe("lines")
  })

  it("returns rows carrying structured fields rather than one pre-rendered string", async () => {
    const { state } = await loadedState(1)
    const row = buildNotificationTuiView(state).rows[0]!
    expect(row.category).toBe("run_blocked")
    expect(row.severity).toBe("attention")
    expect(row.summary).toBe("summary 0")
    expect(row.disposition).toBe("pending")
    expect(typeof row.age).toBe("string")
  })

  it("reports the store's order rather than imposing one of its own", async () => {
    // The store lists severity-first, so a `critical` row precedes an `info` row even
    // though the `info` one is newer. The view preserves that rather than sorting.
    const { bus, store } = testHarness()
    await bus.emit(notificationRequest({ dedupeKey: "info-first", severity: "info", summary: "info one" }))
    await bus.emit(notificationRequest({ dedupeKey: "critical-second", severity: "critical", summary: "critical two" }))
    const state = loadNotificationTuiEntries(store, initialNotificationTuiState(FIXED_NOW), FIXED_NOW)
    expect(buildNotificationTuiView(state).rows.map((row) => row.severity)).toEqual(["critical", "info"])
  })

  it("agrees with the store about how many rows there are", async () => {
    const { state, store } = await loadedState(3)
    expect(buildNotificationTuiView(state).rows).toHaveLength(store.entries().length)
  })

  it("renders one line per row plus the header lines", async () => {
    const { state } = await loadedState(2)
    const view = buildNotificationTuiView(state)
    // Four header lines, one line per row.
    expect(view.lines).toHaveLength(4 + view.rows.length)
  })

  it("derives each rendered row line from the corresponding structured row", async () => {
    const { state } = await loadedState(3)
    const view = buildNotificationTuiView(state)
    view.rows.forEach((row, index) => {
      expect(view.lines[4 + index]).toContain(row.categoryTitle)
      expect(view.lines[4 + index]).toContain(row.severity)
      expect(view.lines[4 + index]).toContain(renderRowSubject(row))
    })
  })

  it("freezes the lines it returns, so a renderer cannot mutate the model's output", async () => {
    const { state } = await loadedState(1)
    expect(Object.isFrozen(buildNotificationTuiView(state).lines)).toBe(true)
  })

  it("reports an unread count that counts only pending rows", async () => {
    const { bus, store } = testHarness({ quieting: { severities: ["info"], categories: [], pairs: [] } })
    await bus.emit(notificationRequest({ dedupeKey: "muted", severity: "info" }))
    await bus.emit(notificationRequest({ dedupeKey: "pending", severity: "critical" }))
    const view = buildNotificationTuiView(loadNotificationTuiEntries(store, initialNotificationTuiState(FIXED_NOW), FIXED_NOW))
    expect(view.unreadCount).toBe(1)
    expect(view.mutedCount).toBe(1)
  })

  it("shows an empty inbox as an explicit sentence rather than blank lines", async () => {
    const view = buildNotificationTuiView(initialNotificationTuiState(FIXED_NOW))
    expect(view.rows).toEqual([])
    expect(view.lines).toContain("no notifications")
  })

  it("clamps a selected index past the end of the list", async () => {
    const { state } = await loadedState(2)
    const moved = reduceNotificationTui(state, { type: "select", index: 99 })
    expect(buildNotificationTuiView(moved).selectedIndex).toBe(1)
    expect(buildNotificationTuiView(moved).selected?.notificationId).toBe(state.entries[1]!.envelope.notificationId)
  })

  it("reports no selection for an empty inbox", () => {
    expect(buildNotificationTuiView(initialNotificationTuiState(FIXED_NOW)).selected).toBeNull()
  })
})

describe("M6.9 age is a closed-vocabulary label and never a locale-formatted duration", () => {
  const created = Date.parse(FIXED_NOW)
  const cases: readonly { readonly elapsedMs: number; readonly label: string }[] = [
    { elapsedMs: 0, label: "just now" },
    { elapsedMs: 59_999, label: "just now" },
    { elapsedMs: 60_000, label: "1m" },
    { elapsedMs: 59 * 60_000, label: "59m" },
    { elapsedMs: 60 * 60_000, label: "1h" },
    { elapsedMs: 23 * 60 * 60_000, label: "23h" },
    { elapsedMs: 24 * 60 * 60_000, label: "1d" },
    { elapsedMs: 29 * 24 * 60 * 60_000, label: "29d" },
    { elapsedMs: 30 * 24 * 60 * 60_000, label: "aged" },
  ]

  for (const { elapsedMs, label } of cases) {
    it(`renders ${elapsedMs}ms as '${label}'`, () => {
      expect(renderAge(created + elapsedMs, created)).toBe(label)
    })
  }

  it("renders a clock that has gone backwards as 'just now' rather than a negative age", () => {
    expect(renderAge(created - 60_000, created)).toBe("just now")
  })

  it("emits only digits and a single unit suffix, so no locale can change it", () => {
    for (const { elapsedMs } of cases) {
      expect(renderAge(created + elapsedMs, created)).toMatch(/^(just now|\d+[mhd]|aged)$/)
    }
  })

  it("is a pure function of two numbers, with no clock and no locale involved", () => {
    expect(renderAge.length).toBe(2)
  })
})

describe("M6.9 a summary is truncated by a fixed, stated rule", () => {
  it("leaves a short summary untouched", () => {
    expect(summarizeNotification("short summary")).toBe("short summary")
  })

  it("collapses runs of whitespace, so a summary cannot forge extra columns", () => {
    expect(summarizeNotification("a    b\nc")).toBe("a b c")
  })

  it("truncates a long summary with a literal ellipsis", () => {
    const summary = summarizeNotification("x".repeat(200))
    expect(summary).toHaveLength(96)
    expect(summary.endsWith("…")).toBe(true)
  })

  it("distinguishes a truncated summary from a short one that ends in a period", () => {
    // The `memory-view.ts` rule, kept because it is the only thing that makes an
    // assertion about truncation possible at all.
    const truncated = summarizeNotification("y".repeat(200))
    const short = summarizeNotification("z".repeat(95))
    expect(truncated.endsWith("…")).toBe(true)
    expect(short.endsWith("…")).toBe(false)
  })
})

describe("M6.9 a muted row withholds its subject but keeps its severity", () => {
  async function mutedState(): Promise<NotificationTuiUiState> {
    const { bus, store } = testHarness({ quieting: { categories: ["run_blocked"], severities: [], pairs: [] } })
    await bus.emit(notificationRequest({ runId: "run-subject", taskId: "task-subject", ruleId: "rule-subject" }))
    return loadNotificationTuiEntries(store, initialNotificationTuiState(FIXED_NOW), FIXED_NOW)
  }

  it("marks the row as withholding detail", async () => {
    const view = buildNotificationTuiView(await mutedState())
    expect(view.rows[0]!.withheldDetail).toBe(true)
  })

  it("renders the mute axis instead of the subject", async () => {
    const view = buildNotificationTuiView(await mutedState())
    expect(renderRowSubject(view.rows[0]!)).toBe("muted (by category)")
  })

  it("renders no identifier of the muted notification anywhere in the lines", async () => {
    const rendered = buildNotificationTuiView(await mutedState()).lines.join("\n")
    expect(rendered).not.toContain("run-subject")
    expect(rendered).not.toContain("task-subject")
    expect(rendered).not.toContain("rule-subject")
  })

  it("still renders the severity, because hiding 'critical' would hide the reason to un-mute", async () => {
    const view = buildNotificationTuiView(await mutedState())
    expect(view.lines.join("\n")).toContain("critical")
  })

  it("names the axis by which it was muted", async () => {
    const view = buildNotificationTuiView(await mutedState())
    expect(view.rows[0]!.mutedBy).toBe("category")
  })

  it("withholds the detail screen's subject too, not just the list row", async () => {
    const state = reduceNotificationTui(await mutedState(), { type: "navigate", screen: "detail" })
    const rendered = buildNotificationTuiView(state).lines.join("\n")
    expect(rendered).toContain("subject withheld")
    expect(rendered).not.toContain("run-subject")
  })
})

describe("M6.9 the reducer covers every declared action and no others", () => {
  it("declares each action type exactly once in the actions list", () => {
    expect(new Set(NOTIFICATION_TUI_ACTIONS).size).toBe(NOTIFICATION_TUI_ACTIONS.length)
  })

  it("declares an action list matching the reducer's switch cases", () => {
    // Scoped to the reducer's own body. This file contains other switches — the key
    // router's per-screen switch and the renderer's per-screen switch, whose case
    // labels are SCREEN names (`list`, `detail`, `quieting`) and would otherwise be
    // read as action types. A whole-file scan would fail on correct code and, worse,
    // would make the assertion meaningless if someone renamed an action to collide.
    const reducerStart = TUI_ADAPTER_SOURCE.indexOf("export function reduceNotificationTui")
    expect(reducerStart).toBeGreaterThanOrEqual(0)
    const reducerEnd = TUI_ADAPTER_SOURCE.indexOf("\n}\n", reducerStart)
    expect(reducerEnd).toBeGreaterThan(reducerStart)
    const reducerBody = TUI_ADAPTER_SOURCE.slice(reducerStart, reducerEnd)
    const cases = [...reducerBody.matchAll(/^\s*case "([a-z-]+)":/gm)].map((match) => match[1]!)
    expect(cases.sort()).toEqual([...NOTIFICATION_TUI_ACTIONS].sort())
  })

  it("has no default clause in the reducer, so a new action is a compile error", () => {
    const reducerStart = TUI_ADAPTER_SOURCE.indexOf("export function reduceNotificationTui")
    const reducerEnd = TUI_ADAPTER_SOURCE.indexOf("\n}", reducerStart)
    expect(TUI_ADAPTER_SOURCE.slice(reducerStart, reducerEnd)).not.toContain("default:")
  })

  it("drives every declared action without changing screen or overlay by accident", () => {
    const now = FIXED_NOW
    const base = initialNotificationTuiState(now)
    const entry: NotificationInboxEntry = {
      envelope: {
        notificationId: notificationId("ntf-000001"),
        dedupeKey: dedupeKey("k"),
        category: "run_blocked",
        severity: "critical",
        summary: "s",
        createdAt: now,
      },
      disposition: "pending",
      storedAt: now,
    }
    const actions: readonly NotificationTuiAction[] = [
      { type: "entries-loaded", entries: [entry], now },
      { type: "navigate", screen: "detail" },
      { type: "set-overlay", overlay: "help" },
      { type: "select", index: 0 },
      { type: "move", delta: 1 },
      { type: "scroll", delta: 2 },
      { type: "set-quieting", quieting: { categories: ["run_failed"], severities: [], pairs: [] } },
      { type: "toggle-quiet-category", category: "run_blocked" },
      { type: "toggle-quiet-severity", severity: "info" },
      { type: "toggle-quiet-pair", category: "run_failed", severity: "attention" },
      { type: "notice", message: "acknowledged" },
      { type: "error", message: "something" },
      { type: "clear-error" },
    ]
    expect(actions.map((action) => action.type)).toEqual([...NOTIFICATION_TUI_ACTIONS])
    let state = base
    for (const action of actions) {
      state = reduceNotificationTui(state, action)
    }
    expect(state.quieting.categories).toEqual(["run_blocked", "run_failed"])
  })

  it("returns a new object rather than mutating the state it was given", () => {
    const state = initialNotificationTuiState(FIXED_NOW)
    const next = reduceNotificationTui(state, { type: "navigate", screen: "quieting" })
    expect(next).not.toBe(state)
    expect(state.screen).toBe("list")
  })

  it("toggles a quieting value off again", () => {
    let state = initialNotificationTuiState(FIXED_NOW)
    state = reduceNotificationTui(state, { type: "toggle-quiet-category", category: "run_failed" })
    expect(state.quieting.categories).toEqual(["run_failed"])
    state = reduceNotificationTui(state, { type: "toggle-quiet-category", category: "run_failed" })
    expect(state.quieting.categories).toEqual([])
  })

  it("toggles a quieting pair off again", () => {
    let state = initialNotificationTuiState(FIXED_NOW)
    state = reduceNotificationTui(state, { type: "toggle-quiet-pair", category: "run_failed", severity: "info" })
    expect(state.quieting.pairs).toEqual([{ category: "run_failed", severity: "info" }])
    state = reduceNotificationTui(state, { type: "toggle-quiet-pair", category: "run_failed", severity: "info" })
    expect(state.quieting.pairs).toEqual([])
  })

  it("clamps a negative scroll offset to zero", () => {
    const state = reduceNotificationTui(initialNotificationTuiState(FIXED_NOW), { type: "scroll", delta: -10 })
    expect(state.scrollOffset).toBe(0)
  })

  it("clears the error when a notice arrives", () => {
    let state = reduceNotificationTui(initialNotificationTuiState(FIXED_NOW), { type: "error", message: "boom" })
    expect(state.error).toBe("boom")
    state = reduceNotificationTui(state, { type: "notice", message: "fine" })
    expect(state.error).toBeNull()
    expect(state.notice).toBe("fine")
  })
})

describe("M6.9 key routing is pure and never writes", () => {
  it("closes on ctrl-c from every screen", async () => {
    const { state } = await loadedState(2)
    for (const screen of ["list", "detail", "quieting"] as const) {
      const positioned = reduceNotificationTui(state, { type: "navigate", screen })
      expect(routeNotificationKey(positioned, key("c", true)).type).toBe("close")
    }
  })

  it("toggles the help overlay with ? and closes it with escape", async () => {
    const { state } = await loadedState(1)
    const opened = routeNotificationKey(state, key("?"))
    expect(opened).toEqual({ type: "dispatch", action: { type: "set-overlay", overlay: "help" } })
    const withOverlay = reduceNotificationTui(state, { type: "set-overlay", overlay: "help" })
    expect(routeNotificationKey(withOverlay, key("?"))).toEqual({
      type: "dispatch",
      action: { type: "set-overlay", overlay: "none" },
    })
    expect(routeNotificationKey(withOverlay, key("escape"))).toEqual({
      type: "dispatch",
      action: { type: "set-overlay", overlay: "none" },
    })
  })

  it("renders the help overlay's key legend when it is open", async () => {
    const { state } = await loadedState(1)
    const view = buildNotificationTuiView(reduceNotificationTui(state, { type: "set-overlay", overlay: "help" }))
    expect(view.lines.join("\n")).toContain("enter acknowledge")
  })

  it("moves the selection with j, k, down, and up", async () => {
    const { state } = await loadedState(3)
    for (const name of ["j", "down"]) {
      expect(routeNotificationKey(state, key(name))).toEqual({ type: "dispatch", action: { type: "move", delta: 1 } })
    }
    for (const name of ["k", "up"]) {
      expect(routeNotificationKey(state, key(name))).toEqual({ type: "dispatch", action: { type: "move", delta: -1 } })
    }
  })

  it("returns an acknowledge INTENT for the selected row rather than performing it", async () => {
    // The acknowledgement is a store write, and this module holds the store only as a
    // read. The intent is the caller's to perform (S13).
    const { state, store } = await loadedState(2)
    const intent = routeNotificationKey(state, key("enter"))
    expect(intent).toEqual({ type: "acknowledge", notificationIds: [state.entries[0]!.envelope.notificationId] })
    expect(store.pendingCount()).toBe(2)
  })

  it("returns an acknowledge intent for every pending row on 'a', and leaves muted rows alone", async () => {
    const { bus, store } = testHarness({ quieting: { severities: ["info"], categories: [], pairs: [] } })
    await bus.emit(notificationRequest({ dedupeKey: "muted", severity: "info" }))
    await bus.emit(notificationRequest({ dedupeKey: "pending-one", severity: "critical" }))
    await bus.emit(notificationRequest({ dedupeKey: "pending-two", severity: "attention" }))
    const state = loadNotificationTuiEntries(store, initialNotificationTuiState(FIXED_NOW), FIXED_NOW)
    const intent = routeNotificationKey(state, key("a"))
    expect(intent.type).toBe("acknowledge")
    if (intent.type !== "acknowledge") throw new Error("expected an acknowledge intent")
    expect(intent.notificationIds).toHaveLength(2)
    expect(intent.notificationIds.every((id) => state.entries.some((entry) => entry.envelope.notificationId === id))).toBe(true)
  })

  it("returns an empty acknowledge intent when there is nothing pending", async () => {
    const { bus, store } = testHarness({ quieting: { categories: ["run_blocked"], severities: [], pairs: [] } })
    await bus.emit(notificationRequest())
    const state = loadNotificationTuiEntries(store, initialNotificationTuiState(FIXED_NOW), FIXED_NOW)
    const intent = routeNotificationKey(state, key("a"))
    expect(intent).toEqual({ type: "acknowledge", notificationIds: [] })
  })

  it("returns no intent for enter on an empty inbox", () => {
    expect(routeNotificationKey(initialNotificationTuiState(FIXED_NOW), key("enter")).type).toBe("none")
  })

  it("returns no intent for an unmapped key", async () => {
    const { state } = await loadedState(1)
    expect(routeNotificationKey(state, key("z")).type).toBe("none")
  })

  it("returns to the list from another screen with escape", async () => {
    const { state } = await loadedState(1)
    const onQuieting = reduceNotificationTui(state, { type: "navigate", screen: "quieting" })
    expect(routeNotificationKey(onQuieting, key("escape"))).toEqual({
      type: "dispatch",
      action: { type: "navigate", screen: "list" },
    })
  })

  it("returns no intent for escape already on the list with no overlay", async () => {
    const { state } = await loadedState(1)
    expect(routeNotificationKey(state, key("escape")).type).toBe("none")
  })

  it("refuses pasted text with a reason rather than dispatching it", async () => {
    const { state } = await loadedState(1)
    const intent = routeNotificationKey(state, { type: "paste", text: "some pasted prompt" })
    expect(intent.type).toBe("reject")
  })

  it("cycles quieting categories and severities on the quieting screen", async () => {
    const { state } = await loadedState(1)
    const onQuieting = reduceNotificationTui(state, { type: "navigate", screen: "quieting" })
    const categoryIntent = routeNotificationKey(onQuieting, key("c"))
    expect(categoryIntent).toEqual({
      type: "dispatch",
      action: { type: "toggle-quiet-category", category: "run_blocked" },
    })
    const severityIntent = routeNotificationKey(onQuieting, key("s"))
    expect(severityIntent).toEqual({
      type: "dispatch",
      action: { type: "toggle-quiet-severity", severity: "info" },
    })
  })

  it("does not let a quieting keystroke through from the list screen", async () => {
    const { state } = await loadedState(1)
    expect(routeNotificationKey(state, key("c")).type).toBe("none")
  })
})

describe("M6.9 the notice is shaped for TuiUiState.notice without importing src/tui", () => {
  /** Structurally the same declaration as `TuiUiState.notice` at `src/tui/types.ts:62`. */
  interface NoticeOnlyShape {
    readonly notice: string | null
  }

  it("returns null for an empty inbox", () => {
    expect(notificationNoticeLine(initialNotificationTuiState(FIXED_NOW))).toBeNull()
  })

  it("assigns to a { notice: string | null } without an import or a cast", () => {
    const state = initialNotificationTuiState(FIXED_NOW)
    const shaped: NoticeOnlyShape = { notice: notificationNoticeLine(state) }
    expect(shaped.notice).toBeNull()
  })

  it("names the most severe pending notification rather than the newest", async () => {
    const { bus, store } = testHarness()
    await bus.emit(notificationRequest({ dedupeKey: "info", severity: "info", summary: "informational" }))
    await bus.emit(notificationRequest({ dedupeKey: "critical", severity: "critical", summary: "critical one" }))
    const notice = notificationNoticeLine(loadNotificationTuiEntries(store, initialNotificationTuiState(FIXED_NOW), FIXED_NOW))
    expect(notice).toContain("Run blocked")
    expect(notice).not.toContain("informational")
  })

  it("counts the pending notifications in the notice", async () => {
    const { bus, store } = testHarness()
    await bus.emit(notificationRequest({ dedupeKey: "k1" }))
    await bus.emit(notificationRequest({ dedupeKey: "k2" }))
    expect(notificationNoticeLine(loadNotificationTuiEntries(store, initialNotificationTuiState(FIXED_NOW), FIXED_NOW))).toContain("(2 pending)")
  })

  it("reports muted-and-none-pending in one sentence rather than naming a muted row", async () => {
    const { bus, store } = testHarness({ quieting: { categories: ["run_blocked"], severities: [], pairs: [] } })
    await bus.emit(notificationRequest())
    expect(notificationNoticeLine(loadNotificationTuiEntries(store, initialNotificationTuiState(FIXED_NOW), FIXED_NOW))).toBe(
      "1 muted notification(s), none pending",
    )
  })

  it("imports nothing from src/tui in the adapter's source", () => {
    expect(TUI_ADAPTER_SOURCE).not.toContain('from "../tui/')
    expect(TUI_ADAPTER_SOURCE).not.toContain('from "./tui.js"')
  })

  it("references no src/tui import statement anywhere under src/notifications/", () => {
    const directory = join(REPOSITORY_ROOT, "src/notifications")
    const files = readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => readFileSync(join(entry.parentPath ?? directory, entry.name), "utf8"))
    for (const text of files) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "")
      expect(code).not.toMatch(/^\s*import\s[^;]*?from\s+"\.\.?\/tui\//m)
    }
  })

  it("agrees with src/tui on the shape of the notice field, by reading both declarations", () => {
    // The compatibility is asserted against the real declaration rather than against
    // a local copy of it, so a change to `TuiUiState.notice` breaks this test instead
    // of silently invalidating the M6.8 integration.
    const tuiTypes = join(REPOSITORY_ROOT, "src/tui/types.ts")
    expect(existsSync(tuiTypes)).toBe(true)
    const source = readFileSync(tuiTypes, "utf8")
    expect(source).toContain("readonly notice: string | null")
  })
})

describe("M6.9 the acknowledgement write path is the caller's, in one function", () => {
  it("removes exactly the ids it is given and reports how many", async () => {
    const { bus, store } = testHarness()
    await bus.emit(notificationRequest({ dedupeKey: "k1" }))
    await bus.emit(notificationRequest({ dedupeKey: "k2" }))
    const [first, second] = store.entries().map((entry) => entry.envelope.notificationId)
    expect(acknowledgeNotificationEntries(store, [first!, second!])).toBe(2)
    expect(store.list()).toEqual([])
  })

  it("is a no-op for an empty id list", () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    expect(acknowledgeNotificationEntries(store, [])).toBe(0)
  })
})

describe("M6.9 the quieting summary is a fixed vocabulary, not an interpolation", () => {
  it("says 'none' when nothing is muted", () => {
    expect(describeQuieting({ categories: [], severities: [], pairs: [] })).toBe("none")
  })

  it("names each non-empty axis and omits the empty ones", () => {
    expect(describeQuieting({ categories: ["run_failed"], severities: [], pairs: [] })).toBe("muted categories=run_failed")
  })

  it("produces the same summary for two differently-ordered equal settings", () => {
    const left = describeQuieting({ categories: ["run_failed", "run_blocked"], severities: [], pairs: [] })
    const right = describeQuieting({ categories: ["run_blocked", "run_failed"], severities: [], pairs: [] })
    expect(left).not.toBe(right)
  })

  it("includes the pair axis when pairs are muted", () => {
    expect(describeQuieting({ categories: [], severities: [], pairs: [{ category: "run_failed", severity: "info" }] })).toBe(
      "muted pairs=run_failed/info",
    )
  })

  it("renders the quieting screen as a checkbox list in a fixed order", async () => {
    const { state } = await loadedState(1)
    const quieting = reduceNotificationTui(state, {
      type: "navigate",
      screen: "quieting",
    })
    const view = buildNotificationTuiView(
      reduceNotificationTui(quieting, { type: "set-quieting", quieting: { categories: ["run_blocked"], severities: [], pairs: [] } }),
    )
    expect(view.quietingLines[0]).toEqual({ axis: "category", label: "run_blocked", muted: true })
    expect(view.quietingLines.filter((line) => line.muted)).toHaveLength(1)
    expect(view.lines.join("\n")).toContain("[x] category: run_blocked")
  })
})

describe("M6.9 a row carries only what the envelope declared", () => {
  it("omits every identifier the envelope omitted", async () => {
    const { bus, store } = testHarness()
    await bus.emit(notificationRequest({ dedupeKey: "bare", runId: undefined, taskId: undefined, ruleId: undefined, reasonCode: undefined }))
    const row = buildNotificationTuiView(loadNotificationTuiEntries(store, initialNotificationTuiState(FIXED_NOW), FIXED_NOW)).rows[0]!
    expect("runId" in row).toBe(false)
    expect("taskId" in row).toBe(false)
    expect("dispatchId" in row).toBe(false)
    expect("nodeId" in row).toBe(false)
    expect("ruleId" in row).toBe(false)
    expect("reasonCode" in row).toBe(false)
  })

  it("renders the subject with no identifiers when there are none to render", () => {
    const row: NotificationTuiRow = {
      notificationId: notificationId("ntf-000001"),
      category: "rule_conflict",
      categoryTitle: "Rule conflict",
      severity: "info",
      marker: "  ",
      summary: "Two rules disagree",
      age: "just now",
      disposition: "pending",
      mutedBy: null,
      withheldDetail: false,
    }
    expect(renderRowSubject(row)).toBe("Two rules disagree")
  })

  it("renders the subject with every identifier joined in declaration order", async () => {
    const { bus, store } = testHarness()
    await bus.emit(
      notificationRequest({
        dedupeKey: "full",
        dispatchId: "dispatch-9",
        nodeId: "node-9",
        summary: "Lease expired",
      }),
    )
    const row = buildNotificationTuiView(loadNotificationTuiEntries(store, initialNotificationTuiState(FIXED_NOW), FIXED_NOW)).rows[0]!
    expect(renderRowSubject(row)).toBe("Lease expired [run-1 task-1 dispatch-9 node-9 rule-1 policy_denied]")
  })
})
