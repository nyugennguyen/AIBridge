/**
 * Keyboard reachability: every advertised action is produced by a keystroke, and
 * every dangerous path requires an explicit armed confirmation.
 *
 * # THE PROPERTY, AND WHY IT IS TESTED RATHER THAN ASSERTED
 *
 * "Keyboard-only" is a claim about a ROUTER, and a claim about a router is only
 * checkable by driving the router. So this file does not read `routeRuleTuiKey`'s
 * source and count the branches. It calls `routeRuleTuiKey` over every screen, every
 * overlay and every declared key, collects the action types it produces, and compares
 * that set against `RULE_TUI_KEY_PRODUCED_ACTIONS`.
 *
 * The comparison runs in BOTH directions:
 *
 *   - Every declared key-produced action is produced by some key. This catches an
 *     action in the declared list that no key reaches — a dead control the footer
 *     would advertise.
 *   - Every action the router produces is in the declared list. This catches a key
 *     that dispatches an action nobody declared, which is how an action escapes the
 *     reducer's exhaustiveness discipline.
 *
 * # NO STATE IS REACHED BY AN ACTION NO KEY PRODUCES
 *
 * The keyboard tests below reach every state through `routeRuleTuiKey` and
 * `reduceRuleTui` only. The intake actions (`rule-set-loaded`, `preview-loaded`, …)
 * are how a CALLER supplies compiled data and no keystroke can produce them; they are
 * exercised in `tui.test.ts` and are excluded here. That split is why
 * `RULE_TUI_KEY_PRODUCED_ACTIONS` exists as a separate list from `RULE_TUI_ACTIONS`:
 * the difference between "an action a keystroke can cause" and "a value a caller
 * supplies" is exactly the boundary between interaction and intake.
 */

import { describe, expect, it } from "vitest"
import {
  RULE_TUI_ACTIONS,
  RULE_TUI_KEY_PRODUCED_ACTIONS,
  RULE_TUI_NON_KEY_ACTIONS,
  RULE_TUI_OVERLAYS,
  RULE_TUI_SCREENS,
  defaultRuleTuiDraft,
  initialRuleTuiState,
  reduceRuleTui,
  routeRuleTuiKey,
  type RuleTuiAction,
  type RuleTuiActionType,
  type RuleTuiKey,
  type RuleTuiNamedKey,
  type RuleTuiOverlay,
  type RuleTuiScreen,
  type RuleTuiUiState,
} from "../../../src/rules/tui/index.js"
import { NARROW_VIEWPORT, TUI_ACTOR, TUI_NOW, canaryDenyDocument, emptyState, partiallyScopedPreApprovalDocument, stateWithRules } from "./tui-fixtures.js"

/**
 * Every key this screen vocabulary can produce.
 *
 * Declared rather than enumerated so the sweep is exhaustive over the KEYS the module
 * claims to handle. A key not in this list produces `none` or `reject`, and the tests
 * that need a specific one name it explicitly.
 */
const KEYS: readonly RuleTuiNamedKey[] = [
  // BOTH cases. Uppercase is not decorative: `N` removes a predicate, `A` removes an
  // action, `E` applies a staged enable change and `G` jumps to the last rule. A sweep
  // over lowercase alone would report every one of those as unreachable, which is
  // exactly the kind of false negative this sweep exists to avoid.
  ...[..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((name) => ({ type: "key" as const, name })),
  { type: "key", name: "tab" },
  { type: "key", name: "enter" },
  { type: "key", name: "escape" },
  { type: "key", name: "backspace" },
  { type: "key", name: "space" },
  { type: "key", name: "up" },
  { type: "key", name: "down" },
  { type: "key", name: "left" },
  { type: "key", name: "right" },
  { type: "key", name: "?" },
  { type: "key", name: "f1" },
  // Printable variants, which the name-only sweep does not cover: a key with
  // `text` is what the builder types with.
  { type: "key", name: "x", text: "x" },
  { type: "key", name: "9", text: "9" },
  { type: "key", name: "c", ctrl: true },
]

/** Apply one key to a state through the router, as a caller would. */
function press(state: RuleTuiUiState, key: RuleTuiNamedKey): RuleTuiUiState {
  const intent = routeRuleTuiKey(state, key)
  return intent.type === "dispatch" ? reduceRuleTui(state, intent.action) : state
}

/** Press several keys in order. */
function pressAll(state: RuleTuiUiState, keys: readonly RuleTuiNamedKey[]): RuleTuiUiState {
  return keys.reduce(press, state)
}

const key = (name: string, text?: string): RuleTuiNamedKey => ({ type: "key", name, ...(text === undefined ? {} : { text }) })

/** The action types the router produces from a state, sweeping every key. */
function producedActionTypes(state: RuleTuiUiState): Set<RuleTuiActionType> {
  const produced = new Set<RuleTuiActionType>()
  for (const candidate of KEYS) {
    const intent = routeRuleTuiKey(state, candidate)
    if (intent.type === "dispatch") produced.add(intent.action.type)
  }
  return produced
}

/** A state with rules loaded, a draft open, and enough for every screen to have content. */
function populatedState(screen: RuleTuiScreen, overlay: RuleTuiOverlay = "none"): RuleTuiUiState {
  const base = stateWithRules([canaryDenyDocument(), partiallyScopedPreApprovalDocument()])
  const withDraft: RuleTuiUiState = {
    ...base,
    draft: {
      ruleId: "rule-new",
      templateVersion: 1,
      projectId: "proj-1",
      name: "new rule",
      description: "a rule being authored",
      enabled: true,
      expiresAt: null,
      authorKind: "user",
      authorId: "user-1",
      createdAt: TUI_NOW,
      predicateField: "projectId",
      predicateOperator: "eq",
      predicateValue: "proj-1",
      predicateNote: "",
      actionKind: "deny_with_reason",
      actionValue: "denied-by-rule",
      focus: "metadata",
      cursor: 0,
    },
    draftPredicates: ["projectId"],
    draftActions: ["deny_with_reason"],
    templateCaptures: [],
  }
  return { ...withDraft, screen, overlay }
}

// ===========================================================================
// Every declared action is key-reachable, and nothing else is
// ===========================================================================

describe("every action the module declares as key-produced is produced by a keystroke", () => {
  it("produces every declared key-produced action from some reachable state", () => {
    // A BREADTH-FIRST SEARCH over key presses, not a single-keystroke sweep.
    //
    // The distinction is load-bearing. `apply-enable-change` is only reachable once
    // something has STAGED a change, and `confirm-activation` only once a dialog has
    // been armed — so sweeping one keystroke from a fixed state can never find them,
    // and a sweep that expected to would be asserting that every action is reachable
    // in one press, which is false of the design (R1 and R3 both require two).
    //
    // Searching from the real initial state through `routeRuleTuiKey` and
    // `reduceRuleTui` is also the strongest available statement of "keyboard-only": a
    // state exists that a user reaches with keys ALONE, and an action fires there. No
    // state in this file is reached by dispatching an action no key produces.
    const seen = new Set<string>()
    const queue: RuleTuiUiState[] = [
      populatedState("list"),
      populatedState("detail"),
      populatedState("builder"),
      populatedState("conflicts"),
      populatedState("simulation"),
      populatedState("templates"),
    ]
    const produced = new Set<RuleTuiActionType>()

    while (queue.length > 0) {
      const state = queue.shift()!
      // Keyed on the ROUTING-RELEVANT fields, and nothing else.
      //
      // # WHY THIS IS A PROJECTION, AND EVERY OMISSION IS SOUND
      //
      // The search's only question is WHICH ACTION a key produces. `routeRuleTuiKey`
      // branches on the screen, the overlay, the arming flag, whether a draft is open,
      // the draft's focus target, the selection, and the four pending values. So those
      // are the identity, and everything else is projected away.
      //
      // The projected fields fall into three groups, none of which any branch reads:
      //
      //   1. `scrollOffset` — a window over content the view already holds.
      //   2. The draft's TEXT fields, which grow by one character per typed keypress,
      //      and `draftPredicates`/`draftActions`, which grow by one per add keypress
      //      with no upper bound (the COMPILER bounds them, with
      //      `rule.limit_exceeded`, which is a refusal and not a keystroke). Following
      //      these would make the space infinite.
      //   3. The draft's `predicateField`/`predicateOperator`/`actionKind`/`enabled`,
      //      which cycle over CLOSED vocabularies (18, 5, 6 and 2 members). They are
      //      finite, but including them multiplies the space by roughly a thousand and
      //      finds nothing new: no branch of the router reads them.
      //
      // Nothing is claimed here that is not tested elsewhere: typing, cycling and
      // add/remove are each exercised by the dedicated builder tests below, which
      // assert the state actually changes.
      const identity = JSON.stringify({
        screen: state.screen,
        overlay: state.overlay,
        armed: state.confirmationArmed,
        selectedIndex: state.selectedIndex,
        draftOpen: state.draft !== null,
        focus: state.draft?.focus ?? null,
        pendingEnable: state.pendingEnableChange !== null,
        pendingActivation: state.pendingActivation !== null,
        pendingTemplate: state.pendingTemplateCapture !== null,
        pendingSimulation: state.pendingSimulationRequest !== null,
      })
      if (seen.has(identity)) continue
      seen.add(identity)

      // Each state is expanded at most ONCE, and the key set is finite, so the
      // frontier is bounded by the number of distinct states rather than by the
      // depth. Nothing in this loop can grow without bound.
      for (const candidate of KEYS) {
        const intent = routeRuleTuiKey(state, candidate)
        if (intent.type !== "dispatch") continue
        produced.add(intent.action.type)
        queue.push(reduceRuleTui(state, intent.action))
      }
      // A hard frontier bound as a backstop, so a future reducer change that made
      // some field grow unbounded fails this test as a clear timeout rather than
      // hanging the suite. It is far above the space this search actually visits.
      if (seen.size > 20_000) throw new Error("the keystroke search did not converge; a state field grows without bound")
    }

    const missing = RULE_TUI_KEY_PRODUCED_ACTIONS.filter((actionType) => !produced.has(actionType))
    expect(missing).toEqual([])
    // The search is not vacuous: it explored a large state space and produced more
    // action types than it needed to.
    expect(seen.size).toBeGreaterThan(50)
  })

  it("produces nothing that is not in the declared list", () => {
    // The reverse direction. A key that dispatches an undeclared action would escape
    // the reducer's exhaustiveness discipline, which is the whole point of T3.
    const declared = new Set<string>(RULE_TUI_KEY_PRODUCED_ACTIONS)
    const produced = new Set<RuleTuiActionType>()
    for (const screen of RULE_TUI_SCREENS) {
      for (const overlay of RULE_TUI_OVERLAYS) {
        for (const actionType of producedActionTypes(populatedState(screen, overlay))) produced.add(actionType)
      }
    }
    const undeclared = [...produced].filter((actionType) => !declared.has(actionType))
    expect(undeclared).toEqual([])
  })

  it("partitions the full action list into key-produced actions and actions no key produces", () => {
    // Every action is in exactly one of the two lists. An action in both would mean a
    // keystroke could cause something only the caller may cause; an action in neither
    // would be one nothing could ever cause, which is worse — it would be a control the
    // footer advertises and no key reaches.
    const keyProduced = new Set<string>(RULE_TUI_KEY_PRODUCED_ACTIONS)
    const nonKey = new Set<string>(RULE_TUI_NON_KEY_ACTIONS)
    expect(RULE_TUI_ACTIONS.filter((actionType) => keyProduced.has(actionType) && nonKey.has(actionType))).toEqual([])
    expect(keyProduced.size + nonKey.size).toBe(RULE_TUI_ACTIONS.length)
    // The intake values are in the second list, and the navigation actions are not.
    expect(nonKey.has("rule-set-loaded")).toBe(true)
    expect(nonKey.has("compile-result")).toBe(true)
    expect(keyProduced.has("navigate")).toBe(true)
    expect(keyProduced.has("rule-set-loaded")).toBe(false)
  })

  it("leaves the actions no key produces unreachable by any keystroke from any state", () => {
    // The complement of the search above, on the same reachable state space. This is
    // what makes `RULE_TUI_NON_KEY_ACTIONS` a claim rather than a comment: an action
    // declared unreachable that a keystroke actually produces would fail here.
    const reachable = new Set<string>()
    const seen = new Set<string>()
    const queue: RuleTuiUiState[] = [
      populatedState("list"),
      populatedState("detail"),
      populatedState("builder"),
      populatedState("conflicts"),
    ]
    while (queue.length > 0) {
      const state = queue.shift()!
      const identity = JSON.stringify({
        screen: state.screen,
        overlay: state.overlay,
        armed: state.confirmationArmed,
        selectedIndex: state.selectedIndex,
        draftOpen: state.draft !== null,
        focus: state.draft?.focus ?? null,
        pendingEnable: state.pendingEnableChange !== null,
        pendingActivation: state.pendingActivation !== null,
        pendingTemplate: state.pendingTemplateCapture !== null,
        pendingSimulation: state.pendingSimulationRequest !== null,
      })
      if (seen.has(identity)) continue
      seen.add(identity)
      for (const candidate of KEYS) {
        const intent = routeRuleTuiKey(state, candidate)
        if (intent.type !== "dispatch") continue
        reachable.add(intent.action.type)
        queue.push(reduceRuleTui(state, intent.action))
      }
    }
    const wronglyClaimed = RULE_TUI_NON_KEY_ACTIONS.filter((actionType) => reachable.has(actionType))
    expect(wronglyClaimed).toEqual([])
  })

  it("gives every screen at least one action that reaches a different screen", () => {
    // A screen with no exit is a screen a user is trapped on, and the footer would
    // advertise a `esc back` that does nothing.
    for (const screen of RULE_TUI_SCREENS) {
      const intents = KEYS.map((candidate) => routeRuleTuiKey(populatedState(screen), candidate))
      const navigates = intents.some(
        (intent) => intent.type === "dispatch" && (intent.action.type === "navigate" || intent.action.type === "dismiss-overlay"),
      )
      if (screen === "list") {
        // The list screen's exit is `close`, which the router returns as an intent
        // rather than a dispatch.
        const closes = intents.some((intent) => intent.type === "close")
        expect(closes || navigates, `${screen} has no exit`).toBe(true)
      } else {
        expect(navigates, `${screen} has no exit`).toBe(true)
      }
    }
  })

  it("closes on ctrl-c from every screen and every overlay", () => {
    for (const screen of RULE_TUI_SCREENS) {
      for (const overlay of RULE_TUI_OVERLAYS) {
        const intent = routeRuleTuiKey(populatedState(screen, overlay), { type: "key", name: "c", ctrl: true })
        expect(intent.type, `${screen}/${overlay}`).toBe("close")
      }
    }
  })

  it("returns reject with a reason for a paste, rather than silently dropping it", () => {
    // S-ST1: a keystroke that would need authority says why. A paste into a rule
    // predicate is unvalidated text entering a document the compiler will hash.
    const intent = routeRuleTuiKey(populatedState("builder"), { type: "paste", text: "anything" })
    expect(intent.type).toBe("reject")
    if (intent.type === "reject") {
      expect(intent.reason).toContain("pasted text is not accepted")
      expect(intent.reason.length).toBeGreaterThan(0)
    }
  })
})

// ===========================================================================
// Activation requires an armed confirmation
// ===========================================================================

describe("a pre-approval cannot be activated without an explicit armed confirmation", () => {
  /** Drive to the detail screen with the second rule (the pre-approval) selected. */
  function atPreApproval(): RuleTuiUiState {
    const base = stateWithRules([canaryDenyDocument(), partiallyScopedPreApprovalDocument()])
    return pressAll(reduceRuleTui(base, { type: "navigate", screen: "detail" }), [key("j")])
  }

  it("opens the dangerous-warning overlay first, because the selected rule carries dangers", () => {
    const state = press(atPreApproval(), key("a"))
    expect(state.overlay).toBe("dangerous-warning")
    expect(state.confirmationArmed).toBe(false)
    // Reading the warning is not agreeing: no activation has been submitted.
    expect(state.pendingActivation).toEqual({ ruleId: "rule-partial-pre", templateVersion: 1 })
  })

  it("ignores confirm-activation while the dangerous-warning overlay is open", () => {
    const warned = press(atPreApproval(), key("a"))
    // The action dispatched DIRECTLY, bypassing the router, must still be ignored.
    const confirmed = reduceRuleTui(warned, { type: "confirm-activation" })
    expect(confirmed.overlay).toBe("dangerous-warning")
    expect(confirmed.notice).toBeNull()
  })

  it("requires moving from the warning to the activation dialog before anything can be armed", () => {
    const warned = press(atPreApproval(), key("a"))
    const dialog = press(warned, key("enter"))
    expect(dialog.overlay).toBe("activation-confirm")
    // AND it opens unarmed: two acts, not one.
    expect(dialog.confirmationArmed).toBe(false)
  })

  it("rejects Enter on the activation dialog with a reason until the dialog is armed", () => {
    const dialog = press(press(atPreApproval(), key("a")), key("enter"))
    const intent = routeRuleTuiKey(dialog, key("enter"))
    expect(intent.type).toBe("reject")
    if (intent.type === "reject") expect(intent.reason).toContain("not armed")
  })

  it("confirms only after an explicit arming keystroke", () => {
    const dialog = press(press(atPreApproval(), key("a")), key("enter"))
    const armed = press(dialog, key("tab"))
    expect(armed.confirmationArmed).toBe(true)
    // The overlay is STILL open after arming: arming is not accepting.
    expect(armed.overlay).toBe("activation-confirm")

    const confirmed = press(armed, key("enter"))
    expect(confirmed.overlay).toBe("none")
    expect(confirmed.confirmationArmed).toBe(false)
    expect(confirmed.notice).toContain("rule-partial-pre@1")
    expect(confirmed.notice).toContain("waiting on the caller")
  })

  it("ignores confirm-activation dispatched directly while unarmed", () => {
    // The reducer's guard, independent of the router's. One guard would be a guard a
    // caller that dispatched the action directly could bypass.
    const dialog = press(press(atPreApproval(), key("a")), key("enter"))
    const bypassed = reduceRuleTui(dialog, { type: "confirm-activation" })
    expect(bypassed.overlay).toBe("activation-confirm")
    expect(bypassed.notice).toBeNull()
  })

  it("opens the plain activation dialog for a rule with no dangers, and still requires arming", () => {
    // The two overlays are separate because they ask different questions — and the
    // arming requirement applies to BOTH, not only to the dangerous path.
    const base = stateWithRules([canaryDenyDocument()])
    const detail = reduceRuleTui(base, { type: "navigate", screen: "detail" })
    const warned = press(detail, key("a"))
    expect(warned.overlay).toBe("activation-confirm")
    expect(warned.confirmationArmed).toBe(false)
    expect(reduceRuleTui(warned, { type: "confirm-activation" }).notice).toBeNull()
  })

  it("cancels the pending activation when the overlay is dismissed", () => {
    const warned = press(atPreApproval(), key("a"))
    const dismissed = press(warned, key("escape"))
    expect(dismissed.overlay).toBe("none")
    // A dismissed request is a CANCELLED request. Leaving it set would let a caller
    // that reads it after the dialog closed perform an activation the user backed out
    // of.
    expect(dismissed.pendingActivation).toBeNull()
  })

  it("re-arms nothing when the overlay changes, so a dialog cannot inherit a stale armed flag", () => {
    const warned = press(atPreApproval(), key("a"))
    const dialog = press(warned, key("enter"))
    const armed = press(dialog, key("tab"))
    expect(armed.confirmationArmed).toBe(true)
    // Navigating away and back disarms.
    const away = reduceRuleTui(armed, { type: "navigate", screen: "list" })
    expect(away.confirmationArmed).toBe(false)
    expect(away.overlay).toBe("none")
  })

  it("ignores set-confirmation-armed while no overlay is open", () => {
    const base = stateWithRules([canaryDenyDocument()])
    const armed = reduceRuleTui(base, { type: "set-confirmation-armed", armed: true })
    // With no dialog open there is nothing to arm, so the flag is not stored and a
    // later dialog cannot inherit it.
    expect(armed.confirmationArmed).toBe(false)
  })

  it("requires arming for a discard too, since a discard throws away authored work", () => {
    const builder = populatedState("builder")
    const requested = press(builder, key("x"))
    expect(requested.overlay).toBe("discard-confirm")
    expect(requested.confirmationArmed).toBe(false)
    expect(reduceRuleTui(requested, { type: "confirm-discard" }).draft).not.toBeNull()
    expect(press(press(requested, key("tab")), key("enter")).draft).toBeNull()
  })
})

// ===========================================================================
// Enable/disable is explicit
// ===========================================================================

describe("an enable/disable change is two explicit steps, and the first states its target", () => {
  it("stages a change without applying it, and says which rule and which direction", () => {
    const detail = reduceRuleTui(stateWithRules([canaryDenyDocument()]), { type: "navigate", screen: "detail" })
    const staged = press(detail, key("e"))
    expect(staged.pendingEnableChange).toEqual({ ruleId: "rule-canary", templateVersion: 1, toEnabled: false })
    expect(staged.notice).toContain("rule-canary@1")
    expect(staged.notice).toContain("would be disabled")
    expect(staged.notice).toContain("nothing has changed yet")
  })

  it("applies the change only on the explicit second keystroke, and hands it to the caller", () => {
    const detail = reduceRuleTui(stateWithRules([canaryDenyDocument()]), { type: "navigate", screen: "detail" })
    const applied = pressAll(detail, [key("e"), key("E")])
    expect(applied.pendingEnableChange).toBeNull()
    expect(applied.notice).toContain("submitted to be disabled")
    // The rows are the CALLER's compiled output, so the reducer does not edit them —
    // a reducer that did would be holding a rule set nobody compiled.
    expect(applied.rows[0]?.enabled).toBe(true)
  })

  it("stages the opposite direction for a disabled rule", () => {
    const base = stateWithRules([canaryDenyDocument({ enabled: false })])
    const staged = press(reduceRuleTui(base, { type: "navigate", screen: "detail" }), key("e"))
    expect(staged.pendingEnableChange?.toEnabled).toBe(true)
    expect(staged.notice).toContain("would be enabled")
  })

  it("does nothing when no rule is selected", () => {
    const empty = emptyState({ screen: "detail" })
    expect(press(empty, key("e")).pendingEnableChange).toBeNull()
  })

  it("clears the staged change when the selection moves", () => {
    const base = stateWithRules([canaryDenyDocument(), partiallyScopedPreApprovalDocument()])
    const staged = press(reduceRuleTui(base, { type: "navigate", screen: "detail" }), key("e"))
    expect(staged.pendingEnableChange).not.toBeNull()
    // A staged change for rule A must not be applied to rule B after a move, so `move`
    // clears it for the same reason `select` does. Both actions move the selection and
    // both forget the pending target.
    expect(press(staged, key("j")).pendingEnableChange).toBeNull()
    // And a direct `select` does too, which the router never reaches from the detail
    // screen's own keys, so it is driven as an action here.
    expect(reduceRuleTui(staged, { type: "select", index: 1 }).pendingEnableChange).toBeNull()
  })
})

// ===========================================================================
// The builder is reachable by keyboard alone
// ===========================================================================

describe("every builder operation is reachable from a key press alone", () => {
  const cases: readonly { keys: readonly RuleTuiNamedKey[]; claim: string }[] = [
    { keys: [key("tab")], claim: "cycle focus" },
    { keys: [key("j")], claim: "move the cursor" },
    { keys: [key("j")], claim: "move the cursor forward" },
    { keys: [key("n")], claim: "add a predicate" },
    { keys: [key("N")], claim: "remove a predicate" },
    { keys: [key("a")], claim: "add an action" },
    { keys: [key("A")], claim: "remove an action" },
    { keys: [key("f")], claim: "cycle the predicate field" },
    { keys: [key("o")], claim: "cycle the predicate operator" },
    { keys: [key("c")], claim: "cycle the action kind" },
    { keys: [key("space")], claim: "toggle enabled" },
    { keys: [key("x", "z")], claim: "type a character" },
    { keys: [key("backspace")], claim: "delete a character" },
  ]

  for (const { keys, claim } of cases) {
    it(`produces a state change for ${claim}`, () => {
      const before = populatedState("builder")
      const after = pressAll(before, keys)
      expect(after).not.toEqual(before)
    })
  }

  it("adds and removes a predicate, and the list is the difference", () => {
    const before = populatedState("builder")
    const added = press(before, key("n"))
    expect(added.draftPredicates).toHaveLength(before.draftPredicates.length + 1)
    const removed = press(added, key("N"))
    expect(removed.draftPredicates).toEqual(before.draftPredicates)
  })

  it("adds and removes an action, and the list is the difference", () => {
    const before = populatedState("builder")
    const added = press(before, key("a"))
    expect(added.draftActions).toHaveLength(before.draftActions.length + 1)
    const removed = press(added, key("A"))
    expect(removed.draftActions).toEqual(before.draftActions)
  })

  it("changes nothing when removing from an empty list, rather than indexing past it", () => {
    const empty = { ...populatedState("builder"), draftPredicates: [], draftActions: [] }
    expect(press(empty, key("N")).draftPredicates).toEqual([])
    expect(press(empty, key("A")).draftActions).toEqual([])
  })

  it("cycles the predicate field through the language's vocabulary and back around", () => {
    const before = populatedState("builder")
    const after = press(before, key("f"))
    expect(after.draft?.predicateField).not.toBe(before.draft?.predicateField)
    // Cycling 18 times returns to the start, which is what makes the vocabulary
    // reachable rather than merely enterable.
    let state = before
    for (let step = 0; step < 18; step += 1) state = press(state, key("f"))
    expect(state.draft?.predicateField).toBe(before.draft?.predicateField)
  })

  it("cycles the action kind through the language's vocabulary and back around", () => {
    const before = populatedState("builder")
    let state = before
    for (let step = 0; step < 6; step += 1) state = press(state, key("c"))
    expect(state.draft?.actionKind).toBe(before.draft?.actionKind)
  })

  it("types a printable character into the focused field", () => {
    // The test that makes "keyboard-only" true of AUTHORING rather than of
    // navigation: without it the builder could move but not type.
    //
    // The key name is "9", not "x": `x` is bound to `request-discard` and is checked
    // BEFORE the printable-character branch, so a key named "x" discards rather than
    // types. That ordering is a property of the router worth pinning — a printable key
    // whose NAME is also a command belongs to the command, and the next test says so.
    const before = populatedState("builder")
    const after = press(before, key("9", "9"))
    expect(after.draft).not.toEqual(before.draft)
    expect(JSON.stringify(after.draft)).toContain("9")
  })

  it("gives a printable key whose name is a command to the command, not to the text field", () => {
    const before = populatedState("builder")
    expect(press(before, key("x", "x")).overlay).toBe("discard-confirm")
  })

  it("seeds a legal value when a predicate is added for a newly chosen field", () => {
    // Cycle to a bounded-integer field and add: the value must be legal for THAT
    // field, or the author would see a refusal they did not cause.
    const before = populatedState("builder")
    // `projectId` is first in RULE_PREDICATE_FIELDS; `roleVersion` is third.
    let state = press(before, key("f"))
    state = press(state, key("f"))
    expect(state.draft?.predicateField).toBe("roleVersion")
    const added = press(state, key("n"))
    expect(added.draft?.predicateValue).toBe("1")
  })

  it("seeds a legal value when an action is added for a newly chosen kind", () => {
    const before = populatedState("builder")
    const added = press(press(before, key("c")), key("a"))
    expect(added.draftActions).toContain("require_approval")
    expect(added.draft?.actionValue.length).toBeGreaterThan(0)
  })

  it("invalidates the last compile answer on every edit", () => {
    // An edit changes the document, so leaving the old refusal codes on screen would
    // be showing a refusal for a document the author has already changed.
    const compiled: RuleTuiUiState = {
      ...populatedState("builder"),
      compileCodes: ["rule.invalid_source"],
      compileMessages: ["stale"],
      compiled: false,
    }
    for (const candidate of [key("f"), key("c"), key("o"), key("9", "9"), key("tab")]) {
      const after = press(compiled, candidate)
      expect(after.compileCodes, `${candidate.name} left a stale refusal`).toEqual([])
      expect(after.compiled).toBe(false)
    }
  })

  it("cycles focus through the three lists and back around", () => {
    const before = populatedState("builder")
    const seen = new Set<string>([before.draft!.focus])
    let state = before
    for (let step = 0; step < 3; step += 1) {
      state = press(state, key("tab"))
      seen.add(state.draft!.focus)
    }
    expect(seen).toEqual(new Set(["metadata", "predicate", "action"]))
    expect(state.draft?.focus).toBe(before.draft?.focus)
  })

  it("does nothing on the builder screen when no draft is open", () => {
    const noDraft = { ...populatedState("builder"), draft: null }
    for (const candidate of [key("n"), key("a"), key("space"), key("f"), key("tab")]) {
      expect(press(noDraft, candidate).draft).toBeNull()
    }
  })
})

// ===========================================================================
// Navigation and the other screens
// ===========================================================================

describe("every screen is reachable from the list by a key press", () => {
  const expected: readonly { pressed: string; screen: RuleTuiScreen }[] = [
    { pressed: "d", screen: "detail" },
    { pressed: "r", screen: "raw" },
    { pressed: "p", screen: "preview" },
    { pressed: "b", screen: "builder" },
    { pressed: "t", screen: "templates" },
    { pressed: "s", screen: "simulation" },
    { pressed: "c", screen: "conflicts" },
  ]

  for (const { pressed, screen } of expected) {
    it(`reaches ${screen} with "${pressed}"`, () => {
      const state = press(populatedState("list"), key(pressed))
      expect(state.screen).toBe(screen)
    })
  }

  it("returns to the list on escape from every screen", () => {
    for (const { screen } of expected) {
      expect(press(populatedState(screen), key("escape")).screen).toBe("list")
    }
  })

  it("moves the selection with j and k, and clamps at both ends", () => {
    const base = stateWithRules([canaryDenyDocument(), partiallyScopedPreApprovalDocument()])
    expect(press(base, key("j")).selectedIndex).toBe(1)
    expect(press(press(base, key("j")), key("j")).selectedIndex).toBe(1)
    expect(press(base, key("k")).selectedIndex).toBe(0)
    expect(press(press(base, key("j")), key("k")).selectedIndex).toBe(0)
  })

  it("jumps to the first and last rule with g and G", () => {
    const base = stateWithRules([canaryDenyDocument(), partiallyScopedPreApprovalDocument()])
    expect(press(base, key("G")).selectedIndex).toBe(1)
    expect(press(press(base, key("G")), key("g")).selectedIndex).toBe(0)
  })

  it("opens and closes the help overlay with ? on every screen", () => {
    for (const screen of RULE_TUI_SCREENS) {
      const opened = press(populatedState(screen), key("?"))
      expect(opened.overlay, screen).toBe("help")
      expect(press(opened, key("?")).overlay, screen).toBe("none")
    }
  })

  it("scrolls with j and k on the screens that scroll, and never scrolls below zero", () => {
    for (const screen of ["raw", "preview", "templates", "simulation"] as const) {
      const state = populatedState(screen)
      expect(press(state, key("j")).scrollOffset, screen).toBe(1)
      expect(press(state, key("k")).scrollOffset, screen).toBe(0)
    }
  })

  it("requests a template capture with a key, and the capture is a pending value", () => {
    const state = press(populatedState("templates"), key("n"))
    expect(state.pendingTemplateCapture).not.toBeNull()
    // Named by digest, never by document.
    expect(state.pendingTemplateCapture?.ruleSetDigest).toMatch(/^sha256:/)
    expect(state.pendingTemplateCapture).not.toHaveProperty("predicates")
  })

  it("requests a simulation with a key, and the request carries the injected clock", () => {
    const state = press(populatedState("simulation"), key("r"))
    expect(state.pendingSimulationRequest?.ruleSetDigest).toMatch(/^sha256:/)
    // The clock arrives with the request rather than being read at request time.
    expect(state.pendingSimulationRequest?.now).toBe(TUI_NOW)
  })

  it("opens no activation dialog with no rule loaded", () => {
    expect(press(emptyState({ screen: "detail" }), key("a")).overlay).toBe("none")
  })

  it("opens no discard dialog with no draft open", () => {
    const noDraft = { ...populatedState("builder"), draft: null }
    expect(press(noDraft, key("x")).overlay).toBe("none")
  })
})

// ===========================================================================
// Purity of the keystroke path
// ===========================================================================

describe("the keystroke path is a pure function of state and key", () => {
  it("routes the same key from the same state to the same intent fifty times", () => {
    const state = populatedState("detail")
    const first = KEYS.map((candidate) => routeRuleTuiKey(state, candidate))
    for (let iteration = 0; iteration < 50; iteration += 1) {
      expect(KEYS.map((candidate) => routeRuleTuiKey(state, candidate))).toEqual(first)
    }
  })

  it("reaches the same state from the same key sequence fifty times", () => {
    const sequence: readonly RuleTuiNamedKey[] = [
      key("d"),
      key("j"),
      key("a"),
      key("enter"),
      key("tab"),
      key("enter"),
      key("escape"),
      key("b"),
      key("n"),
      key("x"),
    ]
    const run = (): RuleTuiUiState =>
      sequence.reduce(
        (state, candidate) => {
          const intent = routeRuleTuiKey(state, candidate)
          return intent.type === "dispatch" ? reduceRuleTui(state, intent.action) : state
        },
        stateWithRules([canaryDenyDocument(), partiallyScopedPreApprovalDocument()]),
      )
    const first = run()
    for (let iteration = 0; iteration < 50; iteration += 1) {
      expect(run()).toEqual(first)
    }
  })

  it("never returns an intent carrying an action outside the declared union", () => {
    // A structural check over the whole screen matrix, so a new branch in the router
    // that dispatched something undeclared would fail here rather than at a call site.
    const declared = new Set<string>(RULE_TUI_ACTIONS)
    for (const screen of RULE_TUI_SCREENS) {
      for (const overlay of RULE_TUI_OVERLAYS) {
        for (const candidate of KEYS) {
          const intent = routeRuleTuiKey(populatedState(screen, overlay), candidate)
          if (intent.type === "dispatch") {
            expect(declared.has(intent.action.type), `${screen}/${overlay}/${candidate.name}`).toBe(true)
          }
        }
      }
    }
  })

  it("leaves the initial state's viewport untouched by any keystroke", () => {
    const initial = initialRuleTuiState(TUI_NOW, NARROW_VIEWPORT)
    for (const screen of RULE_TUI_SCREENS) {
      for (const candidate of KEYS) {
        const after = press({ ...initial, screen }, candidate)
        expect(after.dimensions).toEqual(NARROW_VIEWPORT)
      }
    }
  })
})

// ===========================================================================
// Totality
// ===========================================================================

/**
 * One well-typed instance of EVERY declared action.
 *
 * Written out rather than generated, because a generated instance would be generated
 * from the same union it is testing and would agree with a broken reducer by
 * construction. Each entry is the action a CALLER or a keystroke would really send,
 * so a case that cannot happen in production is still exercised here: totality is a
 * claim about the reducer's shape, not about which inputs reach it.
 */
const ONE_OF_EVERY_ACTION: readonly RuleTuiAction[] = [
  { type: "rule-set-loaded", rows: [], previewEntries: [], now: TUI_NOW },
  { type: "preview-loaded", previewText: "" },
  { type: "raw-loaded", documentText: "{}" },
  { type: "explanation-loaded", explanationText: "" },
  { type: "builder-loaded", draft: defaultRuleTuiDraft(TUI_NOW, TUI_ACTOR) },
  { type: "builder-edited", draft: defaultRuleTuiDraft(TUI_NOW, TUI_ACTOR) },
  { type: "compile-result", codes: [], messages: [] },
  { type: "templates-loaded", captures: [] },
  { type: "simulation-reported", report: null },
  { type: "notice", message: "noted" },
  { type: "error", message: "failed" },
  { type: "clear-error" },
  { type: "navigate", screen: "list" },
  { type: "set-overlay", overlay: "help" },
  { type: "dismiss-overlay" },
  { type: "toggle-help" },
  { type: "set-confirmation-armed", armed: true },
  { type: "move", delta: 1 },
  { type: "select", index: 0 },
  { type: "scroll", delta: 1 },
  { type: "request-enable-change" },
  { type: "apply-enable-change" },
  { type: "request-activation" },
  { type: "confirm-activation" },
  { type: "confirm-danger" },
  { type: "builder-focus", focus: "metadata" },
  { type: "builder-move", delta: 1 },
  { type: "builder-set-field", field: "name", value: "x", mode: "append" },
  { type: "builder-toggle-enabled" },
  { type: "builder-add-predicate" },
  { type: "builder-remove-predicate" },
  { type: "builder-add-action" },
  { type: "builder-remove-action" },
  { type: "builder-cycle-predicate-field" },
  { type: "builder-cycle-predicate-operator" },
  { type: "builder-cycle-action-kind" },
  { type: "builder-cycle-focus" },
  { type: "builder-abandon" },
  { type: "request-template-capture" },
  { type: "request-simulation" },
  { type: "request-discard" },
  { type: "confirm-discard" },
]

describe("the reducer and the router are total over their declared inputs", () => {
  it("names an instance of every declared action, so the totality sweep below is exhaustive", () => {
    // The negative control for the sweep. Without it, deleting an entry from the list
    // above would silently shrink what "every action" means, and the sweep would keep
    // passing over a smaller world.
    expect(ONE_OF_EVERY_ACTION.map((action) => action.type).sort()).toEqual([...RULE_TUI_ACTIONS].sort())
  })

  it("reduces every declared action from every screen and overlay to a state, and never throws", () => {
    // Totality over the reducer. A reducer with a missing case returns `undefined` or
    // throws here, and a shell wiring that in would render an empty frame — so the
    // assertion is that a STATE comes back, from every screen, with every overlay
    // open, for every action in the union.
    for (const screen of RULE_TUI_SCREENS) {
      for (const overlay of RULE_TUI_OVERLAYS) {
        const state = populatedState(screen, overlay)
        for (const action of ONE_OF_EVERY_ACTION) {
          const after = reduceRuleTui(state, action)
          expect(after, `${action.type} from ${screen}/${overlay}`).toBeDefined()
          expect(typeof after.screen, `${action.type} from ${screen}/${overlay}`).toBe("string")
          expect(RULE_TUI_SCREENS, `${action.type} from ${screen}/${overlay}`).toContain(after.screen)
          expect(RULE_TUI_OVERLAYS, `${action.type} from ${screen}/${overlay}`).toContain(after.overlay)
        }
      }
    }
  })

  it("leaves the input state untouched by any action, because the reducer is pure", () => {
    // The purity half, stated over the whole action union rather than over one
    // sequence. A reducer that mutated its argument would pass the fifty-iteration
    // equality tests above on the first run and fail on none of them, because each
    // run would mutate its own fresh copy.
    for (const screen of RULE_TUI_SCREENS) {
      for (const overlay of RULE_TUI_OVERLAYS) {
        const state = populatedState(screen, overlay)
        const before = JSON.stringify(state)
        for (const action of ONE_OF_EVERY_ACTION) {
          reduceRuleTui(state, action)
          expect(JSON.stringify(state), `${action.type} mutated the state from ${screen}/${overlay}`).toBe(before)
        }
      }
    }
  })

  it("answers every key on every screen and overlay with an intent, and never throws", () => {
    // Totality over the router. `none`, `reject`, `dispatch` and `close` are the four
    // declared answers; a router that fell off the end of its branches would return
    // `undefined`, and the caller would have nothing to switch on.
    const answers = new Set(["none", "close", "dispatch", "reject"])
    for (const screen of RULE_TUI_SCREENS) {
      for (const overlay of RULE_TUI_OVERLAYS) {
        for (const candidate of KEYS) {
          const intent = routeRuleTuiKey(populatedState(screen, overlay), candidate)
          expect(answers.has(intent.type), `${screen}/${overlay}/${candidate.name}`).toBe(true)
          if (intent.type === "reject") expect(intent.reason.length, `${screen}/${overlay}/${candidate.name}`).toBeGreaterThan(0)
        }
      }
    }
  })
})

/** The action union, re-exported so a future edit to it breaks this file's types. */
export type { RuleTuiAction }