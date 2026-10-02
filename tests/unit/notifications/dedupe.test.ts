/**
 * M6.9 — deduplication by `dedupeKey` within the retention window.
 *
 * # The properties under test, and why each is a separate claim
 *
 * 1. The same `dedupeKey` inside the window is stored ONCE and delivered ONCE.
 * 2. Across the window boundary, behaviour is exactly what the constant defines — on
 *    both sides, asserted at `window - 1ms` and at `window` so the boundary cannot be
 *    off-by-one in either direction.
 * 3. Two DIFFERENT keys describing the same event are BOTH delivered. This is the
 *    one that matters most for a reader's expectations: dedupe is by key, and it is
 *    not content dedupe. Nobody should ever assume this bus figured out that two
 *    notifications were "really" the same, because it has no way to know and must not
 *    try (store.ts N8, `types.ts` on `dedupeKeySchema`).
 * 4. A duplicate is invisible to the producer beyond a resolved promise and a
 *    `deduplicated` counter. It is not an error.
 *
 * # And the one property the M6.10 MED-4 fix could have broken
 *
 * The bus now hands every adapter a CLONE and the store keeps a CLONE, and
 * `dedupeKey` is the field the entire mechanism turns on. The closing section exists
 * because "the clone has the same key" is an assumption that would fail quietly if the
 * clone were ever built by anything other than a copy of the envelope — and it also
 * covers the failure the aliasing used to permit, where an adapter rewrote
 * `dedupeKey` and the next notification carrying the ORIGINAL key was stored as a
 * second entry instead of being deduplicated.
 */

import { describe, expect, it } from "vitest"
import {
  DEFAULT_NOTIFICATION_RETENTION_WINDOW_MS,
  createNotificationBus,
  createNotificationStore,
  createNotificationTuiAdapter,
} from "../../../src/notifications/index.js"
import {
  FORGED_ENVELOPE_FIELDS,
  createTestClock,
  identityRecordingAdapter,
  nestedVandalousAdapter,
  notificationRequest,
  reasonsOf,
  recordingAdapter,
  vandalousAdapter,
} from "./fixtures.js"

/** The value every boundary assertion in this file is measured against. */
const WINDOW = DEFAULT_NOTIFICATION_RETENTION_WINDOW_MS

function busWith(adapters: readonly ReturnType<typeof recordingAdapter>[]): {
  bus: ReturnType<typeof createNotificationBus>
  store: ReturnType<typeof createNotificationStore>
  clock: ReturnType<typeof createTestClock>
} {
  const clock = createTestClock()
  const store = createNotificationStore({ clock })
  const bus = createNotificationBus({ store, adapters, clock })
  return { bus, store, clock }
}

describe("M6.9 a repeated dedupeKey inside the window is stored once and delivered once", () => {
  it("stores a single entry no matter how many times the same key is emitted", async () => {
    const { bus, store } = busWith([recordingAdapter("a")])
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await bus.emit(notificationRequest())
    }
    expect(store.entries()).toHaveLength(1)
    expect(store.entries()[0]!.envelope.dedupeKey).toBe("run_blocked:run-1:task-1:rule-1")
  })

  it("delivers to an adapter exactly once for five emissions of the same key", async () => {
    const adapter = recordingAdapter("a")
    const { bus } = busWith([adapter])
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await bus.emit(notificationRequest())
    }
    expect(adapter.calls).toHaveLength(1)
  })

  it("reports the duplicate rather than delivering it, and never rejects", async () => {
    const adapter = recordingAdapter("a")
    const { bus } = busWith([adapter])
    await bus.emit(notificationRequest())
    const second = await bus.emit(notificationRequest())
    expect(reasonsOf(second)).toEqual(["duplicate"])
  })

  it("reports the ORIGINAL notificationId on a duplicate rather than the one just minted", async () => {
    // The producer gets an id it can log. It gets the original's id because that is
    // the notification the duplicate refers to, and a freshly-minted id would name a
    // notification that does not exist (bus.ts, "The return value for a duplicate").
    const adapter = recordingAdapter("a")
    const { bus } = busWith([adapter])
    const first = await bus.emit(notificationRequest())
    const second = await bus.emit(notificationRequest())
    expect(first[0]!.notificationId).toBe("ntf-000001")
    expect(second[0]!.notificationId).toBe("ntf-000001")
  })

  it("counts exactly one emission and four deduplications for five emissions of one key", async () => {
    const { bus } = busWith([recordingAdapter("a")])
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await bus.emit(notificationRequest())
    }
    expect(bus.counters()).toMatchObject({ emitted: 1, deduplicated: 4, delivered: 1, muted: 0, adapterErrors: 0 })
  })

  it("produces no adapter attempt at all for a duplicate, so an unavailable adapter is never probed", async () => {
    // A duplicate that probed an adapter would produce an `adapter_unavailable`
    // result alongside the `duplicate`, and the producer would then have two
    // non-delivery reasons to interpret for one event.
    const adapter = recordingAdapter("a")
    let probes = 0
    const counting = { ...adapter, available: () => { probes += 1; return true } }
    const { bus } = busWith([counting])
    await bus.emit(notificationRequest())
    probes = 0
    const second = await bus.emit(notificationRequest())
    expect(probes).toBe(0)
    expect(reasonsOf(second)).toEqual(["duplicate"])
  })
})

describe("M6.9 the window boundary is exactly where the constant says it is", () => {
  it("deduplicates one millisecond before the window elapses", async () => {
    const { bus, store, clock } = busWith([recordingAdapter("a")])
    await bus.emit(notificationRequest())
    clock.advance(WINDOW - 1)
    const second = await bus.emit(notificationRequest())
    expect(reasonsOf(second)).toEqual(["duplicate"])
    expect(store.entries()).toHaveLength(1)
  })

  it("treats an emission exactly at the window as a NEW notification", async () => {
    // `isLive` is `elapsed < windowMs`, so the boundary belongs to the new event. The
    // same expression governs expiry and dedupe, which is why one number is used for
    // both (store.ts, "The dedupe window").
    const { bus, store, clock } = busWith([recordingAdapter("a")])
    await bus.emit(notificationRequest())
    clock.advance(WINDOW)
    const second = await bus.emit(notificationRequest())
    expect(reasonsOf(second)).toEqual(["delivered"])
    // The first entry has expired at exactly the window, so the inbox holds only the
    // new one. Two entries here would mean dedupe and expiry disagreed.
    expect(store.entries()).toHaveLength(1)
    expect(store.entries()[0]!.envelope.notificationId).toBe("ntf-000002")
  })

  it("keeps a single entry across a long run of sub-window re-emissions", async () => {
    // The retry-storm case the window is sized for: a run failing every thirty
    // seconds must not produce thirty notifications in a quarter of an hour.
    const { bus, store, clock } = busWith([recordingAdapter("a")])
    for (let tick = 0; tick < 20; tick += 1) {
      await bus.emit(notificationRequest())
      clock.advance(30_000)
    }
    expect(store.entries()).toHaveLength(1)
    expect(bus.counters().deduplicated).toBe(19)
  })

  it("emits again after the window, so a genuinely repeated failure is still reported", async () => {
    // The other pull on the window: a run that fails at 09:00 and again at 09:20 has
    // failed twice, and the second failure is information.
    const { bus, store, clock } = busWith([recordingAdapter("a")])
    await bus.emit(notificationRequest())
    clock.advance(WINDOW)
    await bus.emit(notificationRequest())
    expect(bus.counters()).toMatchObject({ emitted: 2, deduplicated: 0, delivered: 2 })
    expect(store.entries()[0]!.envelope.notificationId).toBe("ntf-000002")
  })
})

describe("M6.9 deduplication is by key and never by content", () => {
  it("delivers two DIFFERENT keys that describe the same event", async () => {
    // Two producers, or two code paths, describing one blocked run with different
    // key shapes. Both are stored and both are delivered, because the bus has no way
    // to know they are the same event and must not guess: deciding what counts as
    // "the same event" is the producer's policy question, not the observer's.
    const adapter = recordingAdapter("a")
    const { bus, store } = busWith([adapter])
    await bus.emit(notificationRequest({ dedupeKey: "run_blocked:run-1" }))
    await bus.emit(notificationRequest({ dedupeKey: "rule/rule-1/deny/run-1" }))
    expect(adapter.calls).toHaveLength(2)
    expect(store.entries()).toHaveLength(2)
  })

  it("delivers two DIFFERENT keys whose summaries are byte-identical", async () => {
    // The strongest form of "not content dedupe": identical text, different keys,
    // two notifications. A reader who assumed otherwise would build a UI that hides
    // real events.
    const adapter = recordingAdapter("a")
    const { bus } = busWith([adapter])
    const summary = "Run run-1 blocked by rule rule-1"
    await bus.emit(notificationRequest({ dedupeKey: "k-one", summary }))
    await bus.emit(notificationRequest({ dedupeKey: "k-two", summary }))
    expect(adapter.calls).toHaveLength(2)
  })

  it("delivers the SAME key for two different events, because the key is the identity", async () => {
    // The converse, and the reason a caller must put the event identity in the key:
    // reusing a key suppresses a genuinely different event. That is the caller's
    // mistake, and it is invisible here on purpose — the bus has no way to detect it,
    // which is precisely why the docblock says the key is the producer's contract.
    const adapter = recordingAdapter("a")
    const { bus } = busWith([adapter])
    await bus.emit(notificationRequest({ dedupeKey: "shared", category: "run_blocked", summary: "first" }))
    await bus.emit(notificationRequest({ dedupeKey: "shared", category: "run_failed", summary: "second" }))
    expect(adapter.calls).toHaveLength(1)
  })

  it("does not treat the summary as a key even when the summary is unique per event", async () => {
    const adapter = recordingAdapter("a")
    const { bus } = busWith([adapter])
    await bus.emit(notificationRequest({ dedupeKey: "k-one", summary: "unique one" }))
    await bus.emit(notificationRequest({ dedupeKey: "k-two", summary: "unique two" }))
    expect(adapter.calls.map((envelope) => envelope.summary)).toEqual(["unique one", "unique two"])
  })
})

describe("M6.9 the store is the only thing that knows about liveness", () => {
  it("reports a live entry for a key the store already holds", async () => {
    const { bus, store } = busWith([recordingAdapter("a")])
    await bus.emit(notificationRequest())
    expect(store.findByDedupeKey("run_blocked:run-1:task-1:rule-1")).not.toBeNull()
  })

  it("reports no live entry for a key the store never held", async () => {
    const { store } = busWith([])
    expect(store.findByDedupeKey("never-emitted")).toBeNull()
  })

  it("keeps two entries whose keys differ only in code-unit order, rather than collapsing them", async () => {
    // `A` and `a` are different code units and different keys. A case-insensitive
    // comparison would collapse them and one notification would be lost.
    const adapter = recordingAdapter("a")
    const { bus, store } = busWith([adapter])
    await bus.emit(notificationRequest({ dedupeKey: "KeyA" }))
    await bus.emit(notificationRequest({ dedupeKey: "keya" }))
    expect(store.entries()).toHaveLength(2)
    expect(adapter.calls).toHaveLength(2)
  })

  it("delivers to every configured adapter for a first emission and to none for the duplicate", async () => {
    const first = recordingAdapter("first")
    const second = recordingAdapter("second")
    const { bus } = busWith([first, second])
    await bus.emit(notificationRequest())
    await bus.emit(notificationRequest())
    expect(first.calls).toHaveLength(1)
    expect(second.calls).toHaveLength(1)
  })
})

describe("M6.9 a duplicate is invisible to the producer", () => {
  it("resolves rather than rejecting when the only adapter is one the bus cannot reach", async () => {
    // The deduplicated path must not depend on any adapter being reachable. A
    // duplicate that threw because a sink was down would make the sink's health
    // visible to the producer, which is the coupling N3 forbids.
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const tui = createNotificationTuiAdapter()
    const bus = createNotificationBus({ store, adapters: [tui], clock })
    await bus.emit(notificationRequest())
    const second = await bus.emit(notificationRequest())
    expect(reasonsOf(second)).toEqual(["duplicate"])
    expect(bus.counters().adapterErrors).toBe(0)
  })

  it("does not report a duplicate as an error in any counter", async () => {
    const { bus } = busWith([recordingAdapter("a")])
    await bus.emit(notificationRequest())
    await bus.emit(notificationRequest())
    expect(bus.counters().adapterErrors).toBe(0)
  })
})

/**
 * N14's effect on dedupe, which is the one place the fix could plausibly have broken
 * something that was working.
 *
 * The bus now hands each adapter a CLONE, and the store keeps a clone. `dedupeKey` is
 * the one field the whole dedupe mechanism turns on, so "the clone has the same key" is
 * not an assumption — it is the property that would fail first if the clone were
 * built by anything other than a copy of the envelope. The tests here are the
 * regression net for that, and the interesting one is the LAST: before the fix, an
 * adapter that rewrote `dedupeKey` desynchronised `byDedupeKey` from the entries, and
 * the next notification carrying the ORIGINAL key was stored as a second entry rather
 * than deduplicated — a duplicate storm that the store was certain it had already
 * absorbed.
 */
describe("N14 dedupe survives the per-adapter clone", () => {
  it("deduplicates a repeated key when every adapter is a forgery attempt", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({
      store,
      adapters: [vandalousAdapter("v1"), nestedVandalousAdapter("v2")],
      clock,
    })
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await bus.emit(notificationRequest({ dedupeKey: "clone-key" }))
    }
    expect(store.entries()).toHaveLength(1)
    expect(bus.counters()).toMatchObject({ emitted: 1, deduplicated: 4, delivered: 0 })
  })

  it("delivers the same dedupeKey string to every adapter as the store holds", async () => {
    // The claim is about three parties agreeing on one string: the record, the first
    // adapter's clone, and the second adapter's clone. Asserted per adapter because a
    // single adapter would pass on a bus that cloned for the first adapter and shared
    // for the rest.
    const first = identityRecordingAdapter("first")
    const second = identityRecordingAdapter("second")
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters: [first.adapter, second.adapter], clock })
    await bus.emit(notificationRequest({ dedupeKey: "agreed-key" }))
    const held = store.entries()[0]!.envelope.dedupeKey
    expect(first.seen[0]!.dedupeKey).toBe(held)
    expect(second.seen[0]!.dedupeKey).toBe(held)
    expect(held).toBe("agreed-key")
  })

  it("keeps two different keys distinct when an adapter tries to rewrite both of them", async () => {
    // The converse of the property-3 test above, under attack: N8 says dedupe is by key
    // and never by content, and a forgery that collapsed the two keys together would
    // make one real notification disappear.
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters: [vandalousAdapter("v1")], clock })
    await bus.emit(notificationRequest({ dedupeKey: "key-one", summary: "unique one" }))
    await bus.emit(notificationRequest({ dedupeKey: "key-two", summary: "unique two" }))
    expect(store.entries()).toHaveLength(2)
    expect(store.entries().map((entry) => entry.envelope.dedupeKey).sort()).toEqual(["key-one", "key-two"])
  })

  it("does not let a rewritten key desynchronise the index from the entries", async () => {
    // The MED-4 second consequence, stated as a dedupe claim. `findByDedupeKey` must
    // answer about the key the record still holds, and a forged key must not become
    // findable — otherwise `findByDedupeKey` is a lookup into an index the caller can
    // populate by rewriting an envelope.
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters: [vandalousAdapter("v1")], clock })
    await bus.emit(notificationRequest({ dedupeKey: "indexed-key" }))
    expect(store.findByDedupeKey("indexed-key")).not.toBeNull()
    expect(store.findByDedupeKey(FORGED_ENVELOPE_FIELDS.dedupeKey!)).toBeNull()
    // And the index still answers for a key the record holds, rather than only
    // rejecting the forged one — an index that rejected everything would pass the line
    // above too.
    expect(store.findByDedupeKey("indexed-key")!.envelope.dedupeKey).toBe("indexed-key")
  })

  it("still re-opens a key once the retention window has expired, with a forger registered", async () => {
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters: [vandalousAdapter("v1")], clock })
    await bus.emit(notificationRequest({ dedupeKey: "expiring-key" }))
    await bus.emit(notificationRequest({ dedupeKey: "expiring-key" }))
    clock.advance(DEFAULT_NOTIFICATION_RETENTION_WINDOW_MS)
    await bus.emit(notificationRequest({ dedupeKey: "expiring-key" }))
    expect(store.entries()).toHaveLength(1)
    expect(bus.counters()).toMatchObject({ emitted: 2, deduplicated: 1 })
  })

  it("acknowledges a deduplicated key, so the retry storm stops rather than accumulating", async () => {
    // N7 by way of N14: the id a caller holds is the id on the record, and the record is
    // frozen, so acknowledgement still finds it. Without this the fix would have left a
    // storm that could never be silenced.
    const clock = createTestClock()
    const store = createNotificationStore({ clock })
    const bus = createNotificationBus({ store, adapters: [vandalousAdapter("v1")], clock })
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await bus.emit(notificationRequest({ dedupeKey: "storm-key" }))
    }
    const id = store.entries()[0]!.envelope.notificationId
    expect(store.acknowledge(id)).toBe(true)
    await bus.emit(notificationRequest({ dedupeKey: "storm-key" }))
    expect(store.entries()).toHaveLength(1)
    expect(store.entries()[0]!.envelope.notificationId).not.toBe(id)
  })
})
