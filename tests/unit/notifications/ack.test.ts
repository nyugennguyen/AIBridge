/**
 * M6.9 — acknowledgement.
 *
 * # The property under test
 *
 * ADR 0007 section 17: "Acknowledgement removes an entry from the inbox." So
 * acknowledgement is a DELETION, and every consequence follows from that rather than
 * from a flag:
 *
 *   - there is nothing left to redeliver, so "an acknowledged entry must never be
 *     re-delivered" is true by construction rather than by a check;
 *   - the entry is gone from `list`, so `pendingCount` falls with it;
 *   - acknowledging an unknown id is a no-op returning `false`, because an ack racing
 *     an expiry is an ordinary event rather than a caller error.
 *
 * Each of those is asserted here separately, plus the two paths that could plausibly
 * get it wrong: acknowledging while a duplicate is live, and acknowledging everything.
 *
 * # The one thing freezing could have broken
 *
 * Acknowledgement works by matching a `notificationId` read off a stored record, and
 * since the M6.10 security round, that record is deep-frozen. Freezing must not make the id unreadable, and
 * the id a CALLER holds — which came from `emit`'s return value, a different object from
 * the record — must still be the id that removes the entry. The closing section asserts
 * that, and it asserts it with an adapter that tried to rewrite the id first, because
 * that is the case where the store's index and its entries could disagree.
 */

import { describe, expect, it } from "vitest"
import {
  DEFAULT_NOTIFICATION_RETENTION_WINDOW_MS,
  acknowledgeNotificationEntries,
  createNotificationBus,
  createNotificationStore,
  initialNotificationTuiState,
  loadNotificationTuiEntries,
  routeNotificationKey,
} from "../../../src/notifications/index.js"
import {
  FIXED_NOW,
  createTestClock,
  notificationRequest,
  parsedEnvelope,
  reasonsOf,
  recordingAdapter,
  testHarness,
  vandalousAdapter,
} from "./fixtures.js"

describe("M6.9 an acknowledged notification is removed from the inbox", () => {
  it("drops the entry from list()", async () => {
    const { bus, store } = testHarness()
    const [result] = await bus.emit(notificationRequest())
    expect(store.list()).toHaveLength(1)
    store.acknowledge(result!.notificationId)
    expect(store.list()).toEqual([])
  })

  it("decrements pendingCount by exactly one", async () => {
    const { bus, store } = testHarness()
    const [first] = await bus.emit(notificationRequest({ dedupeKey: "k-one" }))
    await bus.emit(notificationRequest({ dedupeKey: "k-two" }))
    expect(store.pendingCount()).toBe(2)
    store.acknowledge(first!.notificationId)
    expect(store.pendingCount()).toBe(1)
  })

  it("reports that it removed something", async () => {
    const { bus, store } = testHarness()
    const [result] = await bus.emit(notificationRequest())
    expect(store.acknowledge(result!.notificationId)).toBe(true)
  })

  it("does not re-deliver an acknowledged notification when its key is emitted again", async () => {
    // Acknowledgement deletes the entry AND releases the dedupe key with it, so the
    // next emission of that key is a NEW event that is delivered. That is correct and
    // intended: an ack says "I have seen this one", not "never tell me about this
    // key again". The re-notification is about a later occurrence.
    const { bus, tui, store } = testHarness()
    const [first] = await bus.emit(notificationRequest())
    store.acknowledge(first!.notificationId)
    await bus.emit(notificationRequest())
    expect(tui.size()).toBe(2)
  })

  it("is not idempotent-silent: acknowledging twice reports false the second time", async () => {
    const { bus, store } = testHarness()
    const [result] = await bus.emit(notificationRequest())
    expect(store.acknowledge(result!.notificationId)).toBe(true)
    expect(store.acknowledge(result!.notificationId)).toBe(false)
  })
})

describe("M6.9 acknowledging an unknown id is a no-op and not an error", () => {
  it("returns false for an id that was never issued", () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    expect(store.acknowledge("ntf-999999" as never)).toBe(false)
  })

  it("does not throw for an id that was never issued", () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    expect(() => store.acknowledge("ntf-999999" as never)).not.toThrow()
  })

  it("leaves the inbox untouched when an unknown id is acknowledged", async () => {
    const { bus, store } = testHarness()
    await bus.emit(notificationRequest())
    store.acknowledge("ntf-999999" as never)
    expect(store.list()).toHaveLength(1)
    expect(store.pendingCount()).toBe(1)
  })

  it("leaves the other entries untouched when one of several ids is unknown", async () => {
    // The multi-id write path M6.8's shell uses for `acknowledge all unread`. One bad
    // id in the batch must not abort the batch — that would mean a single expired
    // entry silently discarded every acknowledgement the user made.
    const { bus, store } = testHarness()
    const [first] = await bus.emit(notificationRequest({ dedupeKey: "k-one" }))
    const [second] = await bus.emit(notificationRequest({ dedupeKey: "k-two" }))
    const removed = acknowledgeNotificationEntries(store, [
      "ntf-999999" as never,
      first!.notificationId,
      second!.notificationId,
    ])
    expect(removed).toBe(2)
    expect(store.list()).toEqual([])
  })

  it("is a no-op for an id that has already expired out of the retention window", async () => {
    const { bus, store, clock } = testHarness()
    const [result] = await bus.emit(notificationRequest())
    clock.advance(DEFAULT_NOTIFICATION_RETENTION_WINDOW_MS)
    expect(store.acknowledge(result!.notificationId)).toBe(false)
    expect(store.list()).toEqual([])
  })
})

describe("M6.9 acknowledgeAll empties the inbox", () => {
  it("removes every entry and reports how many it removed", async () => {
    const { bus, store } = testHarness()
    for (let index = 0; index < 4; index += 1) {
      await bus.emit(notificationRequest({ dedupeKey: `k-${index}` }))
    }
    expect(store.list()).toHaveLength(4)
    expect(store.acknowledgeAll()).toBe(4)
    expect(store.list()).toEqual([])
  })

  it("leaves pendingCount at zero afterwards", async () => {
    const { bus, store } = testHarness()
    for (let index = 0; index < 3; index += 1) {
      await bus.emit(notificationRequest({ dedupeKey: `k-${index}` }))
    }
    store.acknowledgeAll()
    expect(store.pendingCount()).toBe(0)
  })

  it("reports zero for an inbox that is already empty", () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    expect(store.acknowledgeAll()).toBe(0)
  })

  it("removes muted entries too, so a bulk acknowledgement is genuinely a bulk acknowledgement", async () => {
    // The keyboard path `a` deliberately does NOT ack muted entries
    // (`routeNotificationKey`), but `acknowledgeAll` is the store-level operation and
    // does. The difference is stated where it is made; this test pins the store's
    // behaviour so the shell's narrower path is a deliberate choice rather than the
    // only possible one.
    const { bus, store } = testHarness({
      quieting: { categories: ["run_blocked"], severities: [], pairs: [] },
    })
    await bus.emit(notificationRequest({ dedupeKey: "muted-one", category: "run_blocked" }))
    await bus.emit(notificationRequest({ dedupeKey: "delivered-one", category: "run_failed" }))
    expect(store.pendingCount()).toBe(1)
    expect(store.acknowledgeAll()).toBe(2)
    expect(store.list()).toEqual([])
  })
})

describe("M6.9 acknowledgement releases the dedupe key so a later event is reported", () => {
  it("stores the re-emission of an acknowledged key as a new entry", async () => {
    const { bus, store } = testHarness()
    const [first] = await bus.emit(notificationRequest())
    store.acknowledge(first!.notificationId)
    await bus.emit(notificationRequest())
    expect(store.entries().map((entry) => entry.envelope.notificationId)).toEqual(["ntf-000002"])
  })

  it("does not let an acknowledged entry be found by its key", async () => {
    // The dedupe index and the entry list are released together. An index that
    // outlived its entry would suppress a notification the operator can no longer
    // see — "you already know about this" for something they have no way of knowing
    // about.
    const { bus, store } = testHarness()
    const [first] = await bus.emit(notificationRequest())
    store.acknowledge(first!.notificationId)
    expect(store.findByDedupeKey("run_blocked:run-1:task-1:rule-1")).toBeNull()
    expect(store.entries()).toEqual([])
  })
})

describe("M6.9 an entry past the retention window expires and is not re-delivered", () => {
  it("is not listed once the window has elapsed", async () => {
    const { bus, store, clock } = testHarness()
    await bus.emit(notificationRequest())
    expect(store.list()).toHaveLength(1)
    clock.advance(DEFAULT_NOTIFICATION_RETENTION_WINDOW_MS)
    expect(store.list()).toEqual([])
  })

  it("is still listed one millisecond before the window elapses", async () => {
    const { bus, store, clock } = testHarness()
    await bus.emit(notificationRequest())
    clock.advance(DEFAULT_NOTIFICATION_RETENTION_WINDOW_MS - 1)
    expect(store.list()).toHaveLength(1)
  })

  it("stops counting toward pendingCount once expired", async () => {
    const { bus, store, clock } = testHarness()
    await bus.emit(notificationRequest())
    clock.advance(DEFAULT_NOTIFICATION_RETENTION_WINDOW_MS)
    expect(store.pendingCount()).toBe(0)
  })

  it("is not found by its dedupe key once expired", async () => {
    // Expiry releases the key with the entry, so a later occurrence of the same event
    // is reported rather than silently suppressed by an entry nobody can see. The
    // converse — an index outliving its entry — would say "you already know" about
    // something the operator has no way of knowing.
    const { bus, store, clock } = testHarness()
    await bus.emit(notificationRequest())
    clock.advance(DEFAULT_NOTIFICATION_RETENTION_WINDOW_MS)
    expect(store.findByDedupeKey("run_blocked:run-1:task-1:rule-1")).toBeNull()
  })

  it("is delivered again when its key is emitted after expiry", async () => {
    const { bus, tui, clock, store } = testHarness()
    await bus.emit(notificationRequest())
    clock.advance(DEFAULT_NOTIFICATION_RETENTION_WINDOW_MS)
    await bus.emit(notificationRequest())
    expect(tui.size()).toBe(2)
    expect(store.entries()).toHaveLength(1)
    expect(store.entries()[0]!.envelope.notificationId).toBe("ntf-000002")
  })

  it("expires only the entries that are past the window", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    store.publish(parsedEnvelope({ notificationId: "ntf-000001", dedupeKey: "old" }))
    clock.advance(DEFAULT_NOTIFICATION_RETENTION_WINDOW_MS / 2)
    store.publish(
      parsedEnvelope({ notificationId: "ntf-000002", dedupeKey: "new", createdAt: "2026-10-01T00:07:30.000Z" }),
    )
    clock.advance(DEFAULT_NOTIFICATION_RETENTION_WINDOW_MS / 2)
    expect(store.list().map((entry) => entry.envelope.dedupeKey)).toEqual(["new"])
  })

  it("expires muted entries on the same schedule as pending ones", async () => {
    // A mute that outlived its retention window would keep the entry forever and make
    // the inbox grow without bound under a chatty producer.
    const { bus, store, clock } = testHarness({ quieting: { categories: ["run_blocked"], severities: [], pairs: [] } })
    await bus.emit(notificationRequest())
    expect(store.list({ disposition: ["muted"] })).toHaveLength(1)
    clock.advance(DEFAULT_NOTIFICATION_RETENTION_WINDOW_MS)
    expect(store.list()).toEqual([])
  })

  it("honours a custom retention window", async () => {
    const { bus, store, clock } = testHarness({ retentionWindowMs: 1_000 })
    await bus.emit(notificationRequest())
    clock.advance(999)
    expect(store.list()).toHaveLength(1)
    clock.advance(1)
    expect(store.list()).toEqual([])
  })
})

describe("M6.9 an acknowledged notification is not re-delivered from the at-rest inbox", () => {
  it("stores exactly one entry for an emitted notification and deletes exactly that one", async () => {
    // The store keeps the envelope verbatim in CONTENT (N4), so the acknowledgement
    // target is a notificationId that means the same thing to the caller and to the
    // store. If the store re-serialized the envelope with a fresh id, a caller acking
    // the id the adapter received would still work — so this asserts the id EQUALITY
    // rather than the object identity the security round removed, because identity between
    // the record and what an adapter was handed was never the property; it was the
    // aliasing that MED-4 is about.
    const { bus, store, tui } = testHarness()
    const [result] = await bus.emit(notificationRequest())
    const delivered = tui.list()[0]!
    const stored = store.entries()[0]!.envelope
    expect(stored).toEqual(delivered)
    expect(stored).not.toBe(delivered)
    expect(stored.notificationId).toBe(result!.notificationId)
  })

  it("removes only the acknowledged entry when several are live", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const keep = store.publish(parsedEnvelope({ notificationId: "ntf-000001", dedupeKey: "keep" })).entry
    const drop = store.publish(
      parsedEnvelope({ notificationId: "ntf-000002", dedupeKey: "drop", createdAt: "2026-10-01T00:00:01.000Z" }),
    ).entry
    store.acknowledge(drop.envelope.notificationId)
    expect(store.entries().map((entry) => entry.envelope.notificationId)).toEqual([keep.envelope.notificationId])
  })
})

describe("N14 acknowledgement still works against a frozen record", () => {
  it("reads the notificationId off a frozen record without complaint", async () => {
    // The narrow worry, stated on its own so a future change that made the record
    // hostile to readers would fail here rather than at some acknowledgement site.
    const { bus, store } = testHarness()
    await bus.emit(notificationRequest())
    const entry = store.entries()[0]!
    expect(Object.isFrozen(entry)).toBe(true)
    expect(typeof entry.envelope.notificationId).toBe("string")
    expect(store.acknowledge(entry.envelope.notificationId)).toBe(true)
  })

  it("acknowledges the id an adapter was handed, after that adapter tried to forge the id", async () => {
    // The id travels through three objects: the bus minted it, the store's record
    // holds it, and the adapter's clone carried it. The forgery adapter tried to
    // replace it with `ntf-999999`, so if the clone and the record had ever been the
    // same object this acknowledgement would have removed nothing — the failure the
    // aliasing permitted and that a count-only assertion would not have caught.
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const honest = recordingAdapter("honest")
    const bus = createNotificationBus({ store, adapters: [vandalousAdapter("v1"), honest], clock })
    await bus.emit(notificationRequest())
    expect(store.entries()).toHaveLength(1)
    expect(honest.calls[0]!.notificationId).toBe("ntf-000001")
    expect(store.acknowledge(honest.calls[0]!.notificationId)).toBe(true)
    expect(store.entries()).toEqual([])
    expect(store.findByDedupeKey("run_blocked:run-1:task-1:rule-1")).toBeNull()
  })

  it("acknowledges every pending id from a rendered view after a forgery attempt", async () => {
    // The TUI's write path end to end: the shell reads `store.entries()` into state,
    // the reducer turns a keystroke into ids, and the shell acknowledges them. Every
    // value in that chain is now frozen, and the chain still works — which is the
    // behaviour-preservation claim, stated through the shipped code rather than
    // through the store in isolation.
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters: [vandalousAdapter("v1")], clock })
    await bus.emit(notificationRequest({ dedupeKey: "k-one" }))
    await bus.emit(notificationRequest({ dedupeKey: "k-two" }))
    const state = loadNotificationTuiEntries(store, initialNotificationTuiState(FIXED_NOW), FIXED_NOW)
    const intent = routeNotificationKey(state, { type: "key", name: "a" })
    expect(intent.type).toBe("acknowledge")
    const ids = intent.type === "acknowledge" ? intent.notificationIds : []
    expect(ids).toHaveLength(2)
    expect(acknowledgeNotificationEntries(store, ids)).toBe(2)
    expect(store.entries()).toEqual([])
    expect(store.pendingCount()).toBe(0)
  })

  it("keeps acknowledgeAll idempotent, with a forger registered", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters: [vandalousAdapter("v1")], clock })
    for (const dedupeKey of ["k-one", "k-two", "k-three"]) {
      await bus.emit(notificationRequest({ dedupeKey }))
    }
    expect(store.acknowledgeAll()).toBe(3)
    expect(store.acknowledgeAll()).toBe(0)
    expect(store.entries()).toEqual([])
    expect(store.pendingCount()).toBe(0)
  })

  it("leaves no stale index entry behind after an acknowledgement, so the key can be emitted again", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters: [vandalousAdapter("v1")], clock })
    const [first] = await bus.emit(notificationRequest({ dedupeKey: "reusable" }))
    expect(store.acknowledge(first!.notificationId)).toBe(true)
    const second = await bus.emit(notificationRequest({ dedupeKey: "reusable" }))
    expect(reasonsOf(second)).toEqual(["adapter_error"])
    expect(store.entries()).toHaveLength(1)
    expect(store.entries()[0]!.envelope.notificationId).toBe("ntf-000002")
  })
})
