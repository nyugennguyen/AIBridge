/**
 * M6.9 — the notification inbox: an in-memory store with deduplication,
 * acknowledgement, quieting dispositions, and retention expiry.
 *
 * # What this file is
 *
 * One data structure, and it is a log with a deletion rule rather than a queue:
 *
 *   - **publish** appends an envelope, unless a live entry already claims its
 *     `dedupeKey`, in which case the call is a duplicate and nothing is stored.
 *   - **list** returns the live entries, ordered newest-first by severity then
 *     oldest-first by creation, with code-unit tie-breaks.
 *   - **acknowledge** removes an entry. **acknowledgeAll** empties the inbox.
 *   - **pendingCount** counts entries the operator has not been shown yet.
 *   - Entries older than the retention window are expired and stop being listed.
 *
 * # The envelope is stored verbatim (N4) — by VALUE, not by reference
 *
 * `publish` stores the producer's envelope unchanged. It does not re-serialize it,
 * re-shape it, truncate the summary, add a received-at stamp, or annotate it with
 * the disposition. The disposition lives in a wrapper this module owns
 * (`NotificationInboxEntry`), so the envelope the producer built is byte-for-byte
 * the envelope at rest — which is what makes the no-secret audit's `inbox_at_rest`
 * path mean the same thing as its `envelope_payload` path.
 *
 * A store that "helpfully" added a `storedAt` inside the envelope would break that,
 * and it would also break the next reader's ability to tell what the producer said
 * from what the store thought.
 *
 * **What changed in the M6.10 security round, and what did not.** "Verbatim" now means *equal in content
 * and distinct in reference*. `publish` takes a `structuredClone` of the value it was
 * given and deep-freezes it, so the record at rest is an object this module OWNS.
 * Before, the record was the caller's object by identity, which meant the operator's
 * inbox was writable by anything that could reach a reference to it — including every
 * adapter (MED-4: `bus.ts` handed each adapter the store's own envelope object, so
 * `runId`, `ruleId`, `reasonCode`, `summary` and `createdAt` were all rewritable in
 * the operator's own inbox, and rewriting `dedupeKey` desynchronised the dedupe index
 * from the entries).
 *
 * The content claim survives the change and is still the load-bearing part. `parse`
 * output is NOT used as the source, deliberately: Zod's output is a function of the
 * SCHEMA, so a future default, transform, or `.catch()` would silently change what
 * "at rest" means and break the audit's two paths meaning the same thing.
 * `structuredClone` is a function of the VALUE, so the envelope at rest is the
 * envelope emitted, whatever the schema does next. The cost is that the store no
 * longer holds the producer's object — which is the entire point, and is exactly what
 * `tests/unit/notifications/isolation.test.ts` now asserts instead of identity.
 *
 * # The untrusted boundary: adapters, and why they get a frozen clone each (N14)
 *
 * This module's whole job is to be an observation surface that cannot act
 * (ADR 0007 section 17). It is reached by: producers, the bus, a TUI, the no-secret
 * audit, and **adapters** — and the adapter is the one participant that is explicitly
 * third-party, because ADR section 17 invites "a future external sink". An adapter
 * that can rewrite what the operator sees is an adapter that can lie about what
 * happened, so three separate mechanisms now keep the record out of reach:
 *
 *   1. **The store owns its record.** `publish` clones, so the producer's object is
 *      not the record, and a producer that mutates its own envelope after the call
 *      cannot reach the inbox either.
 *   2. **The record is deep-frozen** (`deepFreezeNotificationValue`, N14), so the
 *      array a read returns, the entry, and the envelope inside it are all immutable.
 *      A caller handed `list()` and reaching for `entry.envelope.summary` gets a
 *      `TypeError` in the strict mode every ES module runs in, not a corrupted inbox.
 *   3. **Each adapter gets its own deep-frozen clone** (`bus.ts`, N14). Freezing alone
 *      would suffice today, but a clone per adapter means the store's integrity does
 *      not DEPEND on the freeze still being there: if a later edit drops the freeze, or
 *      a different `NotificationStore` implementation is substituted, the worst case
 *      stays one adapter corrupting one adapter's view rather than the inbox.
 *
 * The per-adapter clone is cheap and the cost is stated rather than hidden. It is
 * `O(adapters)` per `emit` over a flat object of at most twelve string fields — NOT
 * `O(entries)` per read. Cloning the whole inbox on every `list()` was the
 * alternative and was rejected: `list` runs on every TUI keystroke, and the inbox is
 * bounded by the retention window, so that is the copy that would actually cost.
 * Sharing the frozen record on read is safe precisely because a frozen object cannot
 * be mutated — sharing an immutable value is not aliasing mutable state.
 *
 * # The dedupe window, and why 15 minutes
 *
 * `DEFAULT_NOTIFICATION_RETENTION_WINDOW_MS = 15 * 60_000`.
 *
 * The window has to satisfy two pulls that point in opposite directions:
 *
 * - **Long enough to absorb a duplicate storm.** A `run_failed` notification is
 *   emitted from a retry loop, and a retry loop can emit the same failure every few
 *   seconds. A human's attention span for a TUI line is roughly a minute before
 *   they either act or stop looking. A window below about five minutes lets a single
 *   failure ring the operator repeatedly inside the interval in which they are
 *   deciding what to do about it, which converts a notification system into noise
 *   and gets the whole feature muted.
 * - **Short enough not to hide a second, real occurrence.** The failure modes here
 *   are not bursty. A run that fails at 09:00 and fails again at 09:20 has failed
 *   twice, and the second failure is information: either the retry succeeded and
 *   something later broke, or it never recovered. Fifteen minutes is long enough to
 *   cover a human noticing and reacting to one line, and short enough that a
 *   genuinely separate occurrence inside a working session still gets through.
 *
 * What the window is NOT sized for is the lease case, and this is the part worth
 * stating: a lease expiry does not re-fire on a human timescale at all. Leases in
 * this codebase are capped at `MAX_DURATION_SECONDS = 86_400` (24h,
 * `src/mesh/protocol/lease.ts:49`) and are renewed well inside that, so a lease
 * expiring twice inside fifteen minutes is not "the same event twice" — it is two
 * expiries, and the producer's `dedupeKey` is what distinguishes them. Sizing the
 * window for a lease cadence would mean a multi-hour window, and a multi-hour window
 * would suppress the second `lease_expired` that an operator genuinely needs to see
 * when a node is flapping. So the window is sized for the *retry* case, and the
 * lease case is delegated to `dedupeKey`.
 *
 * The retention window is the same number as the dedupe window, on purpose. Two
 * separate numbers would create a state neither of them describes: a dedupe window
 * longer than the retention window means an entry can be deduplicated against after
 * it has expired and stopped being listable, so the operator is told nothing about a
 * notification they cannot see either. One number, one lifecycle: an entry is live
 * for exactly as long as it suppresses its own key.
 *
 * # Acknowledgement removes, and that is the whole enforcement
 *
 * There is no `acknowledged` flag to get out of sync with the entry list. `ack` is a
 * deletion, so "an acknowledged entry must never be re-delivered" is true by
 * construction: there is nothing left to deliver. An unknown id is a no-op that
 * returns `false` rather than throwing, because an ack racing an expiry is an
 * ordinary event and not a caller error.
 *
 * # Determinism
 *
 * The injected clock is read once per operation and never from ambient time (N6).
 * Ordering is severity-descending, then `createdAt`-ascending, then `notificationId`
 * code-unit (N5) — never `localeCompare`. Entries are stored in an array with a
 * by-key index, so `list` is a filter plus a sort and nothing else.
 *
 * # Named invariants
 *
 *   - **N4 — Stored verbatim.** See above.
 *   - **N5 — Code-unit ordering.** See above.
 *   - **N6 — Injected clock.** See above.
 *   - **N7 — A duplicate is not stored and not delivered.** One key, one entry, one
 *     delivery attempt, inside the window. The store is the only place that knows
 *     this, so a bus cannot accidentally deliver a duplicate by delivering around it.
 *   - **N8 — Dedupe is by key, never by content.** Two different keys describing the
 *     same event are two notifications. See `types.ts` on `dedupeKeySchema`.
 *   - **N9 — Muted entries are stored, not delivered.** See "muted" below.
 *   - **N14 — The store's record is unreachable by reference.** No adapter and no
 *     caller can obtain an object through which the stored envelope could be written.
 *     `publish` clones; the clone is deep-frozen; every array this module returns is
 *     frozen; and the bus hands each adapter a separate deep-frozen clone (N14 in
 *     `bus.ts` is the adapter half of the same invariant). See "the untrusted
 *     boundary" above.
 *
 * # Stop conditions
 *
 *   - **S5 — If the inbox needs to persist, that is a different store.** This one is
 *     in-memory by design: an unacknowledged notification is a live screen state,
 *     and a notification that outlived the process that produced it would be
 *     notifying about orchestration state this process can no longer see. If
 *     durability is wanted, it wants a `NotificationStore` interface with a second
 *     implementation, and the interface is the boundary — not a `fs` import here.
 *   - **S6 — If acknowledgement ever needs to keep the entry for history, the
 *     semantics change from "removes" to "marks read", and ADR 0007 section 17 says
 *     "Acknowledgement removes an entry from the inbox". Do not add a tombstone
 *     table to reconcile the two.**
 *   - **S7 — If quieting ever grows a predicate, see `types.ts` S2.** This module
 *     records the disposition the bus decided; it does not evaluate quieting, so
 *     there is exactly one place in the module where a quieting rule can be wrong.
 *   - **S14 — If the envelope ever grows a value that is not plain JSON, the clone
 *     here is the thing to revisit.** `structuredClone` handles dates, `Map`, `Set`,
 *     typed arrays and null-prototype objects, so a future field does not break it —
 *     but a future field carrying a FUNCTION cannot be cloned, and `publish` would
 *     throw on a value the schema had already accepted. The answer then is to change
 *     the schema so the value is refused earlier, not to weaken N14.
 *
 * # The decision on storing muted entries (N9)
 *
 * **Muted entries are stored, with the `muted` disposition, and are not delivered.**
 *
 * The case for storing them: quieting is a display preference, not a deletion, and a
 * user who silences `run_blocked` still needs to be able to ask "did I silence
 * something that mattered?" If muted entries vanished, the inbox would be
 * indistinguishable from a bus that had stopped emitting, and the user's only way to
 * tell the two apart would be to un-mute and wait — during which they would have no
 * record of the thing they are trying to find out about. That is the failure mode
 * where an operator disables a safety signal and never learns it was telling them
 * something.
 *
 * The case against, which was the real competitor: storing a silenced notification
 * costs memory and puts content on a surface the user asked not to see. Both costs
 * are near zero here. Memory is bounded by the retention window and the entry count.
 * Content is not a concern at all, because the payload carries no content to begin
 * with (ADR 0007 section 12, enforced structurally by `types.ts` N2) — the worst a
 * stored muted entry can leak is a run id, a rule id, and a reason code, which the
 * same user could get by un-muting.
 *
 * So the deciding factor is not privacy and it is not cost. It is that a mute must
 * not be indistinguishable from a silence in the system, and a stored muted entry is
 * the only representation that preserves the difference. `list` shows both, tagged;
 * `pendingCount` counts only `pending`, so muting still silences.
 *
 * The consequence, stated so it is not discovered later: un-muting does NOT
 * retroactively deliver anything already muted. The muted entries are still in the
 * inbox, marked muted, and the next emission of that key is a new event which will
 * be delivered normally. Retroactive delivery would mean a mute was a delay rather
 * than a decision, and would make `emit`'s result depend on history in a way a
 * caller could branch on (N3).
 */

import {
  NO_NOTIFICATION_QUIETING,
  compareNotificationCodeUnits,
  notificationEnvelopeSchema,
  type NotificationCategory,
  type NotificationClock,
  type NotificationDisposition,
  type NotificationEnvelope,
  type NotificationId,
  type NotificationQuieting,
  type NotificationSeverity,
  type NotificationTimestamp,
} from "./types.js"

/** 15 minutes. The reasoning is the module docblock's; this is the number. */
export const DEFAULT_NOTIFICATION_RETENTION_WINDOW_MS = 15 * 60_000

/**
 * Deep-freeze a value, recursively, and return it (N14).
 *
 * Exported rather than kept private for one reason: recursion is a CLAIM, and the
 * only way to keep a claim honest is to test it on a value that actually nests. The
 * envelope the schema accepts is flat — every field is a string or an enum — so a
 * private freeze helper would be untestable as a *deep* freeze and could silently
 * become a shallow one. The exported surface takes an arbitrary `T` so a test can
 * hand it `{ nested: { list: [1, 2] } }` and prove the freezing reaches the array.
 *
 * `Object.isFrozen` is consulted first, so freezing an already-frozen value is a
 * constant-time no-op and the recursion terminates on a shared or cyclic structure
 * rather than overflowing the stack. A cycle cannot occur in a value the schema
 * accepts (S14), but the guard costs one property read and makes the helper total on
 * anything it is handed.
 *
 * Frozen means the mutation ATTEMPTS fail, not that they are intercepted: in the
 * strict mode every ES module runs in, `frozen.summary = "x"` throws a `TypeError`.
 * That is the intended outcome, and it is why the bus counts a throwing adapter as
 * `adapter_error` rather than treating a rejected write as a delivery.
 */
export function deepFreezeNotificationValue<T>(value: T): T {
  freezeRecursively(value, new WeakSet<object>())
  return value
}

function freezeRecursively(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== "object") return
  if (seen.has(value)) return
  seen.add(value)
  for (const child of Object.values(value as Record<string, unknown>)) freezeRecursively(child, seen)
  Object.freeze(value)
}

/** A stored envelope plus the disposition this store recorded for it (N4). */
export interface NotificationInboxEntry {
  /**
   * The envelope, verbatim in content, and DEEP-FROZEN (N4, N14).
   *
   * Never re-serialized, reshaped, or annotated, and never the producer's own object:
   * `publish` clones, so this is a value the store owns. `readonly` here is a
   * type-level convenience; the control is `Object.freeze`, which is why
   * `deepFreezeNotificationValue` is exported and tested.
   */
  readonly envelope: NotificationEnvelope
  /**
   * `pending` when the operator is being asked to look at it; `muted` when the
   * producer's quieting settings silenced it (N9).
   */
  readonly disposition: NotificationDisposition
  /** Which axis muted it, when `disposition` is `muted`. */
  readonly mutedBy?: "category" | "severity" | "pair"
  /** The clock reading at publish, for expiry and for deterministic ordering. */
  readonly storedAt: NotificationTimestamp
}

export interface NotificationListFilter {
  readonly category?: NotificationCategory
  readonly severity?: NotificationSeverity
  /** Which dispositions to include. Defaults to both (N9: muted entries are visible). */
  readonly disposition?: readonly NotificationDisposition[]
}

export interface NotificationStore {
  /**
   * Store an envelope, or report it as a duplicate of a live entry (N7).
   *
   * Returns the entry it stored, or the live entry whose key it matched. It does NOT
   * throw for a duplicate: a duplicate is an ordinary outcome with a value, and the
   * bus needs to report one either way (N3).
   *
   * It DOES throw for an envelope that does not satisfy `notificationEnvelopeSchema`
   * — that is a caller bug in the producer, and the store is the last place before
   * the value reaches disk-shaped memory. The bus never lets one through; see
   * `bus.ts`.
   *
   * The caller's object is NOT retained: the record is a deep-frozen clone (N14), so a
   * producer that keeps a reference to its envelope and edits it afterwards cannot
   * reach the inbox either. The returned entry is the frozen record, not a copy of it.
   */
  publish(envelope: NotificationEnvelope, disposition?: NotificationDisposition, mutedBy?: "category" | "severity" | "pair"): { entry: NotificationInboxEntry; duplicate: boolean }
  /**
   * The listed entries, newest-first by severity then oldest-first by creation, with
   * code-unit tie-breaks (N5).
   *
   * The array is frozen and the entries in it are deep-frozen (N14), so a caller that
   * sorts, splices, or writes to `entry.envelope` changes nothing. Both are returned
   * as the stored values rather than copies — see the docblock on why that is not
   * aliasing.
   */
  list(filter?: NotificationListFilter): readonly NotificationInboxEntry[]
  /** Remove one entry. An unknown id is a no-op returning `false`, not a throw. */
  acknowledge(notificationId: NotificationId): boolean
  /** Remove every live entry. Returns how many were removed. */
  acknowledgeAll(): number
  /** How many entries are `pending` — i.e. not muted and not yet acknowledged. */
  pendingCount(): number
  /**
   * Every live entry, in the same order as `list()`. For the audit's `inbox_at_rest`.
   * Frozen, and holding frozen entries, exactly as `list` is (N14).
   */
  entries(): readonly NotificationInboxEntry[]
  /**
   * The live entry claiming `key`, or `null`. Exposed so a test can prove N7 directly.
   *
   * The STORED entry, deep-frozen (N14). It is not a copy because there is nothing
   * about it a caller can write, and a copy would imply otherwise.
   */
  findByDedupeKey(key: string): NotificationInboxEntry | null
  /** A copy of the retention window in milliseconds. */
  readonly retentionWindowMs: number
}

export interface NotificationStoreOptions {
  readonly clock: NotificationClock
  /** Overrides the 15-minute default. Must be a positive integer. */
  readonly retentionWindowMs?: number
}

/**
 * Severity rank for the listing order: critical first.
 *
 * A total order over a closed enum, declared rather than derived from the string, so
 * a future severity added mid-list does not silently become "least important".
 */
const SEVERITY_RANK: Readonly<Record<NotificationSeverity, number>> = Object.freeze({
  critical: 0,
  attention: 1,
  info: 2,
})

function compareEntries(left: NotificationInboxEntry, right: NotificationInboxEntry): number {
  const bySeverity = SEVERITY_RANK[left.envelope.severity] - SEVERITY_RANK[right.envelope.severity]
  if (bySeverity !== 0) return bySeverity
  const byAge = compareNotificationCodeUnits(left.envelope.createdAt, right.envelope.createdAt)
  if (byAge !== 0) return byAge
  return compareNotificationCodeUnits(left.envelope.notificationId, right.envelope.notificationId)
}

function isLive(entry: NotificationInboxEntry, nowMs: number, windowMs: number): boolean {
  return nowMs - Date.parse(entry.storedAt) < windowMs
}

/**
 * The in-memory store.
 *
 * An array for order and a `Map` for the dedupe index, because the two jobs are
 * different: the array answers "list these", the map answers "has this key been
 * claimed", and a linear scan of the array for the second question would make dedupe
 * O(n) in the size of the inbox — which is exactly the cost that shows up when a
 * retry loop is misbehaving.
 */
export function createNotificationStore(options: NotificationStoreOptions): NotificationStore {
  const { clock } = options
  const windowMs = options.retentionWindowMs ?? DEFAULT_NOTIFICATION_RETENTION_WINDOW_MS
  if (!Number.isInteger(windowMs) || windowMs <= 0) {
    throw new TypeError("retentionWindowMs must be a positive integer number of milliseconds")
  }

  const entries: NotificationInboxEntry[] = []
  const byDedupeKey = new Map<string, NotificationInboxEntry>()

  /** Drop anything past the window from both the array and the index (N7). */
  function expire(): void {
    const nowMs = Date.parse(clock.now())
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!
      if (isLive(entry, nowMs, windowMs)) continue
      entries.splice(index, 1)
      if (byDedupeKey.get(entry.envelope.dedupeKey) === entry) byDedupeKey.delete(entry.envelope.dedupeKey)
    }
  }

  function ordered(filter?: NotificationListFilter): readonly NotificationInboxEntry[] {
    expire()
    const wanted = filter?.disposition
    // The array is a fresh copy (`filter` allocates) and it is FROZEN anyway (N14).
    //
    // Freezing it is not load-bearing on its own — a caller could not reach `entries`
    // through the copy — but it costs one property write and it removes a whole class
    // of question ("can a TUI that re-sorts the list corrupt the inbox?") from the set
    // of things a reviewer has to reason about. `sort` is a mutation of the array, so
    // this is exactly the operation the freeze forecloses.
    //
    // The ENTRIES are shared, not cloned, and that is the deliberate half of the
    // decision: they are deep-frozen at publish (N14), so there is nothing about them
    // a caller can mutate, and sharing an immutable value is not aliasing mutable
    // state. Cloning the inbox on every read would be `O(entries)` per keystroke
    // (see the docblock, "the untrusted boundary").
    return Object.freeze(
      entries
        .filter((entry) => {
          if (wanted !== undefined && !wanted.includes(entry.disposition)) return false
          if (filter?.category !== undefined && entry.envelope.category !== filter.category) return false
          if (filter?.severity !== undefined && entry.envelope.severity !== filter.severity) return false
          return true
        })
        .sort(compareEntries),
    )
  }

  return {
    retentionWindowMs: windowMs,

    publish(envelope, disposition = "pending", mutedBy) {
      // VALIDATE as a GATE, then store a CLONE OF THE INPUT — never Zod's output.
      //
      // `notificationEnvelopeSchema.parse` would return a NEW object built by the
      // schema, and using that as the record would make "what is at rest" a function
      // of the schema rather than of the producer: a future default, transform, or
      // `.catch()` would silently change the content the no-secret audit compares
      // between `inbox_at_rest` and `envelope_payload` (N4, and the docblock's "stored
      // verbatim BY VALUE"). `structuredClone` is a function of the VALUE, so the
      // envelope at rest is the envelope emitted, whatever the schema does next.
      //
      // A payload this build cannot read is a payload the audit cannot reason about
      // and the TUI cannot render (N2), so the REFUSAL is right and it happens first.
      const validation = notificationEnvelopeSchema.safeParse(envelope)
      if (!validation.success) {
        throw new TypeError("envelope does not satisfy notificationEnvelopeSchema")
      }
      expire()
      // The key is read from the value the store is about to KEEP, not from the
      // caller's object. Reading it from the caller's object is what let MED-4's
      // aliasing desynchronise the index: rewrite `dedupeKey` through a reference to
      // the record and `findByDedupeKey` answers about a key the inbox no longer
      // holds, while the next notification carrying the ORIGINAL key is stored as a
      // second entry rather than deduplicated.
      const atRest = deepFreezeNotificationValue(structuredClone(envelope))
      const existing = byDedupeKey.get(atRest.dedupeKey)
      // The result wrapper is frozen for the same reason as the array `list` returns:
      // it costs one call, and it keeps the rule "every value this module hands out is
      // frozen" true without an exception someone has to remember.
      if (existing !== undefined) return Object.freeze({ entry: existing, duplicate: true })
      const entry: NotificationInboxEntry = deepFreezeNotificationValue<NotificationInboxEntry>({
        envelope: atRest,
        disposition,
        ...(disposition === "muted" && mutedBy !== undefined ? { mutedBy } : {}),
        storedAt: clock.now(),
      })
      entries.push(entry)
      byDedupeKey.set(atRest.dedupeKey, entry)
      return Object.freeze({ entry, duplicate: false })
    },

    // `list` IS `ordered` rather than a wrapper around it, so there is exactly one
    // read path and one place where the array is frozen. A second read method with
    // its own copy of the filter logic is how a `list()` and an `entries()` come to
    // disagree about what the inbox contains.
    list: ordered,

    acknowledge(notificationId) {
      expire()
      const index = entries.findIndex((entry) => entry.envelope.notificationId === notificationId)
      if (index < 0) return false
      const [removed] = entries.splice(index, 1)
      if (removed !== undefined && byDedupeKey.get(removed.envelope.dedupeKey) === removed) {
        byDedupeKey.delete(removed.envelope.dedupeKey)
      }
      return true
    },

    acknowledgeAll() {
      expire()
      const removed = entries.length
      entries.length = 0
      byDedupeKey.clear()
      return removed
    },

    // A number, so there is nothing here to hand out. It goes through `ordered()`
    // anyway, so a read can never report a count the listing would contradict —
    // specifically, it can never count an entry that `expire()` has just dropped.
    pendingCount() {
      return ordered().filter((entry) => entry.disposition === "pending").length
    },

    entries() {
      return ordered()
    },

    // The stored entry itself, not a copy. Safe because it is deep-frozen at publish
    // (N14): a caller can read it, and can attempt a write that throws, and there is
    // no reference chain from here back to anything mutable. Cloning it would imply
    // the entry is at risk of being written, and would be a second place to keep in
    // sync if the entry ever grew a field.
    findByDedupeKey(key) {
      expire()
      return byDedupeKey.get(key) ?? null
    },
  }
}

// ===========================================================================
// Quieting
// ===========================================================================

/**
 * Is this notification silenced, and by which axis?
 *
 * The order of the checks is the reporting order and it runs most-specific-first:
 * a pair mute is reported as a pair mute even when the category is also listed,
 * because the pair is the rule that actually explains the silence to a user who has
 * muted four categories and nine pairs.
 *
 * Reads `category` and `severity` only (S2). Nothing here reads `summary`, and a
 * predicate that did would make this a content filter.
 */
export function notificationMuteVerdict(
  quieting: NotificationQuieting,
  category: NotificationCategory,
  severity: NotificationSeverity,
): { muted: false } | { muted: true; by: "pair" | "category" | "severity" } {
  const pairMuted = quieting.pairs.some((pair) => pair.category === category && pair.severity === severity)
  if (pairMuted) return { muted: true, by: "pair" }
  if (quieting.categories.includes(category)) return { muted: true, by: "category" }
  if (quieting.severities.includes(severity)) return { muted: true, by: "severity" }
  return { muted: false }
}

/**
 * Normalise a quieting setting: de-duplicated and code-unit sorted (N5).
 *
 * Sorted and de-duplicated so that two quieting settings describing the same
 * silences are `deepEqual`, which is what lets the TUI re-render without a
 * spurious "your settings changed" and what lets a test compare them with `toEqual`.
 * The pairs are sorted on `category:severity` — a concatenation, so the ordering is
 * still total and still code-unit.
 */
export function normalizeNotificationQuieting(quieting: NotificationQuieting): NotificationQuieting {
  const categories = [...new Set(quieting.categories)].sort(compareNotificationCodeUnits)
  const severities = [...new Set(quieting.severities)].sort(compareNotificationCodeUnits)
  const seen = new Set<string>()
  const pairs: { category: NotificationCategory; severity: NotificationSeverity }[] = []
  for (const pair of quieting.pairs) {
    const key = `${pair.category}:${pair.severity}`
    if (seen.has(key)) continue
    seen.add(key)
    pairs.push({ category: pair.category, severity: pair.severity })
  }
  pairs.sort((left, right) => compareNotificationCodeUnits(`${left.category}:${left.severity}`, `${right.category}:${right.severity}`))
  return Object.freeze({
    categories: Object.freeze(categories) as readonly NotificationCategory[],
    severities: Object.freeze(severities) as readonly NotificationSeverity[],
    pairs: Object.freeze(pairs),
  })
}

export { NO_NOTIFICATION_QUIETING }
