/**
 * M6.9 — the notification bus: one entry point (`emit`) that cannot affect anything.
 *
 * # The whole architectural claim, in one function
 *
 * ADR 0007 section 17: "Delivery never affects orchestration state: a notification
 * is emitted strictly after the state write, inside a `try`/`catch` whose only
 * effect is incrementing a counter. A subscriber that throws, an adapter that is
 * unavailable, and a delivery that is deduplicated away are all indistinguishable to
 * the orchestrator, because none of them can reach it."
 *
 * This file is that `try`/`catch`, with the counter named.
 *
 * Three mechanisms make it true, and each is separately asserted:
 *
 *  1. **STRUCTURAL — no upward edge.** `src/notifications/` imports nothing from
 *     `src/orchestration/`, `src/mesh/`, `src/runtime/`, `src/application/`,
 *     `src/memory/`, `src/context/`, or `src/server/`. The bus is handed a store and
 *     a list of adapters; it is never handed an orchestrator, so it has no verb for
 *     "block", "retry", "fail the run", or "re-dispatch". It observes and it
 *     cannot act, and that is not a discipline anyone has to maintain — there is
 *     nothing to call.
 *  2. **BEHAVIOURAL — `emit` is total.** It never throws and never rejects. Not for a
 *     throwing adapter, not for an unavailable one, not for a malformed one, not for a
 *     store that throws on write, not for an envelope the schema refuses. Every one
 *     of those resolves to an array of `NotificationDeliveryResult`.
 *  3. **INFORMATIONAL — the return value carries nothing actionable.** Every element
 *     is one of four non-delivery reasons or a delivered id. There is no throw
 *     signal, no retry hint, no backoff, no queue position, no partial-success count
 *     a caller could treat as "3 of 5 delivered, retry the rest". A caller that
 *     branched on any of it would be branching on noise, which is the point: the
 *     return value exists so a test and the TUI can observe, not so a producer can
 *     decide.
 *
 * # The bus mints two fields and refuses to accept them
 *
 * `notificationId` comes from a monotonic sequence on this bus; `createdAt` comes
 * from the injected clock. A producer supplies neither. If it could supply
 * `notificationId`, two emitters would collide on ids and one notification would
 * overwrite another in the inbox; if it could supply `createdAt`, it would be
 * choosing the instant that decides expiry and listing order, which means a
 * misbehaving producer could hide a notification by dating it in the past. Both are
 * therefore derived here (N6) and neither is in `notificationRequestSchema`.
 *
 * # Every adapter is attempted exactly once, in the order given
 *
 * Delivery is sequential rather than `Promise.all`, for two reasons that are both
 * about determinism. `Promise.all` rejects on the first rejection, which would mean
 * the remaining adapters are never awaited and an unhandled rejection could escape;
 * and concurrent delivery makes the ORDER of results depend on adapter timing. The
 * bus catches each adapter individually and keeps going, so a broken adapter cannot
 * prevent the others from being attempted, and a caller sees one result per adapter
 * in the order it passed them.
 *
 * A throwing adapter becomes `{ delivered: false, reason: "adapter_error" }` and
 * increments `adapterErrors`. A `false` from `available()` becomes
 * `adapter_unavailable`. Neither throws, neither rejects, and both leave the
 * remaining adapters untouched. That is the ADR's "indistinguishable to the
 * orchestrator" requirement made concrete: the producer gets an array either way.
 *
 * # The return value for a duplicate or a mute
 *
 * A deduplicated or muted emission produces exactly one result, not one per adapter,
 * because no adapter was asked. `deduplicated` and `muted` are therefore disjoint
 * from `delivered`, and `emitted === delivered + muted` holds for a bus whose
 * adapters all succeed — which is the invariant the determinism test asserts.
 *
 * # Why a store failure does not stop delivery
 *
 * If `store.publish` throws, the bus increments `adapterErrors`, records the
 * failure, and **still attempts delivery**. The reasoning: a notification that was
 * never stored is still true, and an operator who is watching should be told. The
 * store is the retention mechanism, not the truth mechanism. Refusing to notify
 * because a cache write failed would mean a memory-pressure blip silently swallows
 * a blocked run, which is the failure mode this whole module exists to prevent.
 *
 * The alternative — delivering only what was stored — is defensible too, and it is
 * rejected here because it makes an infrastructure fault look like an absence of
 * events, and "no blocked runs" and "we could not record that a run was blocked" are
 * the two sentences an operator most needs to be able to tell apart.
 *
 * # Each adapter gets its OWN deep-frozen clone (N14)
 *
 * ADR 0007 section 17 says a notification is an observation of orchestration state,
 * and `src/notifications/**` has no upward import edge precisely so it cannot act.
 * The adapter is the one participant in this loop that is not us: section 17 invites
 * "a future external sink", so an adapter is third-party code, and the bus used to
 * hand it the very object the store held (M6.10 MED-4). An adapter could therefore
 * rewrite `runId`, `ruleId`, `reasonCode`, `summary` and `createdAt` in the operator's
 * own inbox, and a later adapter saw the rewritten values.
 *
 * The fix is in `deliverOne`, so it is per adapter by construction and cannot be
 * forgotten by a future call site: `structuredClone` the envelope, deep-freeze the
 * clone, and hand THAT to one adapter. Three properties follow, and each is a claim
 * the isolation test asserts rather than a hope:
 *
 *   1. **The store's record is unreachable.** The bus no longer holds a reference an
 *      adapter can be given — `store.publish` takes its own clone too (`store.ts` N14),
 *      so the record is not merely frozen, it is not this object.
 *   2. **Adapters cannot observe each other.** Each gets a different object, so even
 *      if a later edit dropped the freeze the blast radius is one adapter's view
 *      rather than the inbox and its neighbours' views.
 *   3. **A mutation attempt THROWS instead of corrupting.** The clone is frozen, and
 *      ES modules are strict, so `envelope.summary = "nothing happened"` raises a
 *      `TypeError` inside the adapter, which `deliverOne`'s existing `catch` turns into
 *      `{ delivered: false, reason: "adapter_error" }`. That is the outcome the ADR
 *      wants: a misbehaving sink is counted, the producer learns nothing actionable
 *      (N3), and the operator's record is untouched.
 *
 * The cost is named rather than hidden: one `structuredClone` of a flat object of at
 * most twelve string fields, per adapter, per `emit` — and the store holds many
 * envelopes while the clone is of the ONE being emitted. Cloning the store's records
 * per read would be the expensive shape, and it is not this one. The clone is also
 * what makes the in-TUI adapter's own `list()` safe transitively: it stores what it
 * is handed, and what it is handed is frozen.
 *
 * # Named invariants
 *
 *   - **N1 — No upward edge.** See `types.ts`.
 *   - **N3 — `emit` is total and returns nothing actionable.** See above.
 *   - **N6 — Injected clock.** See above.
 *   - **N8 — Dedupe is by key.** The bus passes `dedupeKey` to the store and does not
 *     look at `summary`, so it cannot decide two notifications are "the same".
 *   - **N10 — Every adapter is attempted exactly once, in order.** See above.
 *   - **N11 — A store failure does not suppress delivery.** See above.
 *   - **N14 — An adapter is handed a value, never a reference to the record.** See
 *     above, and `store.ts` for the other half.
 *
 * # Stop conditions
 *
 *   - **S8 — If `emit` ever needs to return more than a delivery result, stop.** The
 *     moment the return type can express "should the caller do something", the
 *     notification bus has become a control path and N1 is decorative. A richer
 *     signal belongs in the store's own API, which the TUI reads.
 *   - **S9 — If a caller ever needs to AWAIT delivery for correctness, stop.** There
 *     is no such caller. If there were, the producer would be depending on the
 *     notification path, which is the dependency N1 forbids in the other direction.
 *     `emit` returning a promise is a convenience for sequential test setup and
 *     nothing more; a producer is expected to not await it.
 *   - **S10 — If quieting ever needs to be evaluated inside the bus against anything
 *     but `category` and `severity`, stop** (`types.ts` S2).
 *   - **S15 — If an adapter ever needs to WRITE to what it was handed, the interface
 *     is wrong rather than the freeze.** An adapter that wants to record "delivered at
 *     T", retry counts, or a transport id must keep that in its own state; the
 *     envelope is a report of what orchestration did, and a sink that can edit the
 *     report is a sink that can lie about it. The first adapter that needs this is the
 *     evidence that `NotificationAdapter` should grow a result type, not that N14
 *     should be relaxed.
 */

import { deepFreezeNotificationValue, normalizeNotificationQuieting, notificationMuteVerdict, type NotificationStore } from "./store.js"
import {
  NO_NOTIFICATION_QUIETING,
  notificationRequestSchema,
  type NotificationAdapter,
  type NotificationClock,
  type NotificationCounters,
  type NotificationDeliveryResult,
  type NotificationEnvelope,
  type NotificationId,
  type NotificationQuieting,
  type NotificationRequest,
} from "./types.js"

export interface NotificationBusOptions {
  readonly store: NotificationStore
  /** Attempted in this order, each exactly once (N10). May be empty. */
  readonly adapters: readonly NotificationAdapter[]
  readonly clock: NotificationClock
  /** Replaces the bus's quieting settings wholesale. Defaults to none. */
  readonly quieting?: NotificationQuieting
}

export interface NotificationBus {
  /**
   * Publish a notification. Never throws, never rejects (N3).
   *
   * The result is for tests and the TUI, not for branching. See the file docblock.
   */
  emit(request: NotificationRequest): Promise<readonly NotificationDeliveryResult[]>
  /** A copy of the counters. Reading them cannot affect delivery. */
  counters(): NotificationCounters
  /** Replace the quieting settings. Affects SUBSEQUENT emissions only (S7). */
  setQuieting(quieting: NotificationQuieting): void
  /** The current quieting settings, normalized. */
  quieting(): NotificationQuieting
  /** The store, for a caller that is rendering rather than producing. */
  readonly store: NotificationStore
  /** How many notifications this bus has minted, including duplicates. */
  emittedCount(): number
}

function increment(counters: Record<string, number>, key: keyof NotificationCounters): void {
  counters[key] = (counters[key] ?? 0) + 1
}

/**
 * The frozen array `emit` returns, holding frozen results (N14).
 *
 * `readonly` on the result type is a type-level claim; this is the runtime one, and it
 * closes the last reference path out of the bus: `results[0].delivered = true` is a
 * mutation a producer could make to the value it was handed, and a value a producer
 * can edit is a value a producer can branch on — which is the thing N3 exists to
 * prevent. Freezing it is one `map` and one `freeze` on an array of at most one
 * element per adapter, so it is not a cost worth arguing about.
 */
function settled(results: readonly NotificationDeliveryResult[]): readonly NotificationDeliveryResult[] {
  return Object.freeze(results.map((result) => Object.freeze(result)))
}

/**
 * Mint a notification id: `ntf-` plus a zero-padded sequence.
 *
 * A sequence rather than a hash or a UUID because it needs no randomness (N6) and no
 * crypto import, and because a monotonic id makes the listing order's final
 * tie-break deterministic. Zero-padded so that string order matches numeric order
 * for the first ten thousand notifications, which is what keeps a code-unit sort of
 * ids honest.
 */
function mintNotificationId(sequence: number): NotificationId {
  return `ntf-${String(sequence).padStart(6, "0")}` as NotificationId
}

export function createNotificationBus(options: NotificationBusOptions): NotificationBus {
  const { store, adapters, clock } = options
  let quieting: NotificationQuieting = options.quieting === undefined
    ? NO_NOTIFICATION_QUIETING
    : normalizeNotificationQuieting(options.quieting)

  let sequence = 0
  const mutable: Record<keyof NotificationCounters, number> = {
    emitted: 0,
    deduplicated: 0,
    muted: 0,
    delivered: 0,
    adapterErrors: 0,
  }

  /**
   * Attempt one adapter. Total by construction: a throw, a rejection, a malformed
   * result, a lying `available`, and a mutation attempt all become a result value
   * (N3, N14).
   *
   * The clone is made HERE, inside the per-adapter function, rather than in the loop
   * that calls it. That placement is the whole mechanism: a clone built once per
   * `emit` and shared would leave adapter N's view to adapter N+1's mutations, and a
   * clone built at the call site is one edit away from not existing. Here there is no
   * code path that hands an adapter anything but a fresh frozen value.
   *
   * The reported `notificationId` is read from the bus's OWN envelope, before the clone
   * is attempted, and that is deliberate rather than incidental: the result has to be
   * reportable even on the paths where no clone was ever produced. A `catch` that read
   * the id off the clone would need the clone to exist, so a clone that failed would
   * leave a path with no id to report — and the id is the one thing every result must
   * carry (N3). The bus mints it, owns it, and never hands it out, so reading it here
   * cannot be reached by anything an adapter does.
   */
  async function deliverOne(adapter: NotificationAdapter, envelope: NotificationEnvelope): Promise<NotificationDeliveryResult> {
    const notificationId = envelope.notificationId
    if (adapter.available !== undefined) {
      let available: boolean
      try {
        available = adapter.available()
      } catch {
        // A probe that throws is indistinguishable from an adapter that is down,
        // and both are just "not delivered" as far as the producer is concerned.
        increment(mutable, "adapterErrors")
        return { delivered: false, notificationId, reason: "adapter_unavailable" }
      }
      if (!available) {
        increment(mutable, "adapterErrors")
        return { delivered: false, notificationId, reason: "adapter_unavailable" }
      }
    }
    try {
      // Structured clone and freeze INSIDE this `try`, and that placement is load-bearing
      // rather than cosmetic. `structuredClone` throws on a value it cannot copy — a
      // function, a symbol, a `WeakMap` — and nothing in the schema can legally put one
      // of those in an envelope today (`store.ts` S14). If this line sat ABOVE the
      // `catch`, a future field that could would reject out of `deliverOne`, abort the
      // fan-out loop, and leave the remaining adapters unattempted — which is N10 broken
      // by a line whose whole purpose was to make delivery safer. Inside the `try`, the
      // same failure is one more `adapter_error` and the loop carries on.
      const forAdapter = deepFreezeNotificationValue(structuredClone(envelope))
      const result = await adapter.deliver(forAdapter)
      // A malformed result is an adapter bug, and it is treated as a failure rather
      // than trusted: an adapter that returns `undefined` has not delivered, and
      // reporting it as delivered would make `delivered` a lie the TUI shows.
      if (result === undefined || result === null || typeof result !== "object") {
        increment(mutable, "adapterErrors")
        return { delivered: false, notificationId, reason: "adapter_error" }
      }
      if (result.delivered === true) {
        increment(mutable, "delivered")
        return { delivered: true, notificationId }
      }
      increment(mutable, "adapterErrors")
      return {
        delivered: false,
        notificationId,
        reason: result.reason ?? "adapter_error",
      }
    } catch {
      increment(mutable, "adapterErrors")
      return { delivered: false, notificationId, reason: "adapter_error" }
    }
  }

  return {
    store,

    async emit(request: NotificationRequest): Promise<readonly NotificationDeliveryResult[]> {
      // The outermost `try` exists so that `emit` is total even against a bug in
      // this function rather than only against a misbehaving dependency. N3 says
      // "never throws"; that has to mean never, including never-because-of-here.
      try {
        const parsed = notificationRequestSchema.safeParse(request)
        if (!parsed.success) {
          // A producer that sends a bad request has a bug, but it is not the bus's
          // bug to propagate: the bus's contract is total (N3), so this is counted
          // and swallowed. The TUI sees no notification, which is correct — there
          // was none.
          increment(mutable, "adapterErrors")
          return settled([])
        }

        const nowMs = Date.parse(clock.now())
        if (!Number.isFinite(nowMs)) {
          increment(mutable, "adapterErrors")
          return settled([])
        }

        sequence += 1
        const envelope: NotificationEnvelope = {
          ...parsed.data,
          notificationId: mintNotificationId(sequence),
          createdAt: clock.now(),
        }

        const verdict = notificationMuteVerdict(quieting, envelope.category, envelope.severity)
        if (verdict.muted) {
          // Stored with the muted disposition and NOT delivered (N9). The store call
          // is in its own `try`: a store failure here must not turn a mute into a
          // delivery either.
          try {
            const { entry, duplicate } = store.publish(envelope, "muted", verdict.by)
            if (duplicate) {
              increment(mutable, "deduplicated")
              return settled([{ delivered: false, notificationId: entry.envelope.notificationId, reason: "duplicate" }])
            }
          } catch {
            increment(mutable, "adapterErrors")
          }
          increment(mutable, "muted")
          increment(mutable, "emitted")
          return settled([{ delivered: false, notificationId: envelope.notificationId, reason: "muted" }])
        }

        try {
          const { entry, duplicate } = store.publish(envelope, "pending")
          if (duplicate) {
            increment(mutable, "deduplicated")
            // Not delivered, and the id reported is the ORIGINAL's id rather than
            // the one just minted. The producer gets an answer it can log and cannot
            // use to conclude anything about the original (N3).
            return settled([{ delivered: false, notificationId: entry.envelope.notificationId, reason: "duplicate" }])
          }
        } catch {
          increment(mutable, "adapterErrors")
        }

        increment(mutable, "emitted")

        const results: NotificationDeliveryResult[] = []
        // Sequential, each in its own try (N10). `deliverOne` is itself total, so
        // this loop cannot be exited by anything an adapter does — including an
        // adapter that tries to write to the envelope it was handed, because that
        // write throws inside the adapter and is caught there (N14).
        for (const adapter of adapters) {
          results.push(await deliverOne(adapter, envelope))
        }
        return settled(results)
      } catch {
        // Unreachable in practice; present so that N3 is a property of the code
        // rather than of the current set of known failure modes.
        increment(mutable, "adapterErrors")
        return settled([])
      }
    },

    counters() {
      return Object.freeze({
        emitted: mutable.emitted,
        deduplicated: mutable.deduplicated,
        muted: mutable.muted,
        delivered: mutable.delivered,
        adapterErrors: mutable.adapterErrors,
      })
    },

    setQuieting(next: NotificationQuieting) {
      // Replaces, not merges, and affects only subsequent emissions. An already-muted
      // notification stays muted (store.ts: "The decision on storing muted entries"),
      // and is NOT delivered retroactively. A bus that replayed muted entries on
      // un-mute would make the mute a delay rather than a decision.
      quieting = normalizeNotificationQuieting(next)
    },

    quieting() {
      return quieting
    },

    emittedCount() {
      return sequence
    },
  }
}
