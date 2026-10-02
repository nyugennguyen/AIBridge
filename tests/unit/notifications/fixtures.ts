/**
 * Shared fixtures for `tests/unit/notifications/`.
 *
 * # What is shared and why
 *
 * Four things, and the reason for each is that a shared fixture is a SHARED CLAIM:
 *
 *  1. **A fixed clock.** Every notification test needs a clock it controls, and the
 *     alternative — a real clock — makes expiry and age untestable. `FIXED_NOW` is a
 *     literal, so a test that renders a row at "now" gets the same age label on every
 *     machine forever. `advanceClock` moves it forward without ever calling
 *     `Date.now()`, which is what lets the retention-expiry test exist.
 *
 *  2. **Canaries.** `NOTIFICATION_CANARIES` holds a prompt, a task description, a
 *     context excerpt, a token-shaped string, and an env-var-shaped string. They are
 *     exported as a list so `no-secrets.test.ts` can seed each of them into each
 *     plausible field rather than inventing a new canary per assertion and thereby
 *     never testing the same thing twice.
 *
 *  3. **Recording and failing adapters.** `recordingAdapter` is the one that must be
 *     attempted-exactly-once; `throwingAdapter`, `rejectingAdapter`,
 *     `unavailableAdapter`, and `malformedAdapter` are the four ways an adapter can
 *     misbehave, kept as four names so `isolation.test.ts` reads as a list of cases
 *     rather than as four inline literals.
 *
 *  5. **The mutating adapters.** MED-4 is about an adapter that writes to what it was
 *     handed, and a bug that reproduces only in an inline literal is a bug nobody
 *     re-runs. `vandalousAdapter` rewrites every writable field, `nestedVandalousAdapter`
 *     reaches for structure the envelope does not have, and `halfMutatingThrowingAdapter`
 *     writes and then throws — the three shapes the isolation test needs, named.
 *
 *  4. **A request builder.** `notificationRequest` fills in a valid request and lets a
 *     test override one field. That is what makes "the same key twice" a one-word
 *     change rather than a copy-paste, which is where copy-paste tests go wrong.
 *
 * # What is deliberately NOT here
 *
 * No helper that builds an envelope directly. Tests that want an envelope build one
 * through the bus, because the bus is what mints `notificationId` and `createdAt`
 * (`bus.ts`), and an envelope built by hand would be testing a value the producer
 * cannot actually produce. The one exception is `rawEnvelope`, which exists FOR the
 * no-secret tests — those need an envelope that is deliberately malformed, and
 * building a malformed thing requires bypassing the schema.
 */

import {
  createNotificationBus,
  createNotificationStore,
  createNotificationTuiAdapter,
  dedupeKeySchema,
  notificationEnvelopeSchema,
  notificationIdSchema,
  notificationRequestSchema,
  type NotificationAdapter,
  type NotificationCategory,
  type NotificationClock,
  type NotificationCounters,
  type NotificationDeliveryResult,
  type DedupeKey,
  type NotificationEnvelope,
  type NotificationId,
  type NotificationQuieting,
  type NotificationRequest,
  type NotificationSeverity,
  type NotificationTimestamp,
} from "../../../src/notifications/index.js"

/** 2026-10-01T00:00:00.000Z. A literal, so nothing in these tests depends on when they run. */
export const FIXED_NOW = "2026-10-01T00:00:00.000Z" as NotificationTimestamp

/** A second later. Used wherever a test needs two distinct `createdAt` values. */
export const ONE_SECOND_LATER = "2026-10-01T00:00:01.000Z" as NotificationTimestamp

/**
 * A clock a test drives by hand.
 *
 * `now` returns whatever `current` holds. Nothing here reads ambient time, which is
 * why `Date.now` appears nowhere in this directory.
 */
export function createTestClock(start: NotificationTimestamp = FIXED_NOW): NotificationClock & { set(value: NotificationTimestamp): void; advance(ms: number): void } {
  let current: NotificationTimestamp = start
  return {
    now: () => current,
    set: (value: NotificationTimestamp) => {
      current = value
    },
    advance: (ms: number) => {
      current = new Date(Date.parse(current) + ms).toISOString() as NotificationTimestamp
    },
  }
}

// ===========================================================================
// Canaries
// ===========================================================================

/**
 * The canary set. Five literals, five shapes.
 *
 * Each is longer than 8 characters because the audit's encoding scan ignores forms
 * shorter than that — a 3-character secret would match almost any text and every
 * assertion using it would be vacuous.
 */
export const NOTIFICATION_CANARIES = Object.freeze({
  prompt: "Rewrite the quarterly compliance narrative for the Frankfurt entity",
  taskDescription: "Delete every object in the production bucket older than ninety days",
  contextContent: "incident-4417 notes: the vendor rotated the signing key without notice",
  token: "sk-live-9f3aQ2mZ7pL4xN8bT1wK6dY0hR5cV",
  envAssignment: "DATABASE_ADMIN_PASSWORD=hunter2-indefinitely-not-a-real-password",
} as const)

/** Every canary value, for seeding loops. */
export const ALL_NOTIFICATION_CANARIES: readonly string[] = Object.freeze(Object.values(NOTIFICATION_CANARIES))

// ===========================================================================
// Request building
// ===========================================================================

/**
 * A request as a TEST writes it: plain strings, no brands.
 *
 * Deliberately not `Partial<NotificationRequest>`. The envelope's identifier fields are
 * branded, so a fixture typed as the request type would force every test that overrides
 * a `dedupeKey` or a `runId` to cast — and a fixture that needs casts to be written is a
 * fixture nobody writes carefully. This type is the unbranded shape, and
 * `notificationRequest` puts the result through the request schema so the value a test
 * receives is genuinely the one a producer could produce.
 */
export interface NotificationRequestOverrides {
  readonly dedupeKey?: string
  readonly category?: NotificationCategory
  readonly severity?: NotificationSeverity
  readonly summary?: string
  readonly runId?: string
  readonly taskId?: string
  readonly dispatchId?: string
  readonly nodeId?: string
  readonly ruleId?: string
  readonly reasonCode?: string
}

/**
 * A valid request, with one field overridable.
 *
 * `overrides` is spread LAST so a test can replace the `dedupeKey` (the dedupe test),
 * the `category`/`severity` (the quieting test), or the `summary` (the truncation
 * test) in one word.
 *
 * The result is PARSED, not cast. So a test that writes an invalid request gets a
 * throw here rather than a request the bus quietly refuses — which is the failure that
 * would otherwise be very hard to read. The one test that needs an invalid request
 * writes it inline with an explicit cast.
 */
export function notificationRequest(overrides: NotificationRequestOverrides = {}): NotificationRequest {
  return notificationRequestSchema.parse({
    dedupeKey: "run_blocked:run-1:task-1:rule-1",
    category: "run_blocked",
    severity: "critical",
    summary: "Run run-1 task-1 blocked by rule rule-1 (policy_denied)",
    runId: "run-1",
    taskId: "task-1",
    ruleId: "rule-1",
    reasonCode: "policy_denied",
    ...overrides,
  })
}

/**
 * A deliberately unvalidated envelope, for the no-secret tests only.
 *
 * The schema is bypassed with a cast rather than with `parse`, because the whole
 * point is to build a payload the schema would REFUSE. `no-secrets.test.ts` then
 * asserts both that the audit finds the canaries inside it and that the schema
 * refuses it — the first proves the audit works, the second is the real control.
 */
export function rawEnvelope(overrides: Record<string, unknown> = {}): NotificationEnvelope {
  return {
    notificationId: "ntf-000001",
    dedupeKey: "run_blocked:run-1:task-1:rule-1",
    category: "run_blocked",
    severity: "critical",
    summary: "Run run-1 blocked by rule rule-1",
    createdAt: FIXED_NOW,
    ...overrides,
  } as unknown as NotificationEnvelope
}

// ===========================================================================
// Adapters
// ===========================================================================

export interface RecordingAdapter extends NotificationAdapter {
  readonly calls: readonly NotificationEnvelope[]
  /** The ids this adapter was asked to deliver, in order. */
  deliveredIds(): readonly NotificationId[]
}

/**
 * An adapter that records what it was handed and always succeeds.
 *
 * `calls` is the array `deliver` pushes to, exposed read-only through a getter so a
 * test cannot mutate what the adapter is holding — a test that could write to
 * `calls` could make the exactly-once assertion pass by writing to it.
 */
export function recordingAdapter(id: string, available = true): RecordingAdapter {
  const calls: NotificationEnvelope[] = []
  return {
    id,
    available: () => available,
    async deliver(envelope: NotificationEnvelope): Promise<NotificationDeliveryResult> {
      calls.push(envelope)
      return { delivered: true, notificationId: envelope.notificationId }
    },
    get calls() {
      return Object.freeze([...calls])
    },
    deliveredIds: () => Object.freeze(calls.map((envelope) => envelope.notificationId)),
  }
}

/** An adapter whose `deliver` throws synchronously (an async throw). */
export function throwingAdapter(id: string, message = "adapter is on fire"): NotificationAdapter {
  return {
    id,
    async deliver(): Promise<NotificationDeliveryResult> {
      throw new Error(message)
    },
  }
}

/** An adapter whose `deliver` returns a promise that rejects. */
export function rejectingAdapter(id: string): NotificationAdapter {
  return {
    id,
    deliver(): Promise<NotificationDeliveryResult> {
      return Promise.reject(new Error("adapter rejected"))
    },
  }
}

/** An adapter that reports itself unavailable through the `available` hook. */
export function unavailableAdapter(id: string): NotificationAdapter {
  return {
    id,
    available: () => false,
    async deliver(): Promise<NotificationDeliveryResult> {
      throw new Error("an unavailable adapter must not be asked to deliver")
    },
  }
}

/** An adapter whose `available` hook throws. */
export function probingAdapter(id: string): NotificationAdapter {
  return {
    id,
    available: () => {
      throw new Error("the probe is broken too")
    },
    async deliver(): Promise<NotificationDeliveryResult> {
      throw new Error("an adapter whose probe throws must not be asked to deliver")
    },
  }
}

/** An adapter that returns something that is not a `NotificationDeliveryResult`. */
export function malformedAdapter(id: string): NotificationAdapter {
  return {
    id,
    // The cast is the malformation. A real adapter with a wrong return type is a
    // compile error, which is why this fixture exists at all: it is the shape of bug
    // that only shows up at runtime across a module boundary.
    deliver: (async () => "delivered!") as unknown as NotificationAdapter["deliver"],
  }
}

// ===========================================================================
// Mutating adapters (MED-4)
// ===========================================================================

/**
 * The forged value for every writable field, as a CLOSED table.
 *
 * Closed and exported rather than written inline at each call site because the
 * isolation test's central claim is that the store's record is byte-identical before
 * and after, and that claim is only checkable if the list of things an attacker would
 * try to change is itself fixed. A test that mutated "a field or two" would pass on a
 * store that protected `summary` and nothing else.
 *
 * Every replacement is a value the SCHEMA would accept wherever the schema has an
 * opinion, and the point of that is stated in `tests/unit/notifications/isolation.test.ts`:
 * the forgery has to be plausible, because a forgery the schema would reject is a
 * forgery a reader would spot.
 */
export const FORGED_ENVELOPE_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  notificationId: "ntf-999999",
  dedupeKey: "run_blocked:run-forged:task-forged:rule-forged",
  category: "run_failed",
  severity: "info",
  summary: "nothing happened and nothing was blocked",
  createdAt: "2099-01-01T00:00:00.000Z",
  runId: "run-forged",
  taskId: "task-forged",
  dispatchId: "dispatch-forged",
  nodeId: "node-forged",
  ruleId: "rule-forged",
  reasonCode: "silent.ok",
})

/**
 * A mutable view of an envelope, obtained by casting.
 *
 * Every mutation in this section goes through this cast rather than through an index
 * signature, because the envelope type is the SCHEMA's inference and has no index
 * signature by design. The cast is the honest statement "this code is doing the thing
 * the type system forbids", which is exactly the thing being tested.
 */
function asMutable(envelope: NotificationEnvelope): Record<string, unknown> {
  return envelope as unknown as Record<string, unknown>
}

/**
 * What a forging adapter reports back, given how many of its writes were refused.
 *
 * A forged write is an `adapter_error`, not a delivery — the bus is entitled to count
 * it, and it is the only thing about the attempt the producer is allowed to see (N3).
 * Written as a helper because two fixtures need it and because the two branches have
 * to be spelled out: returning `{ delivered: someBoolean }` would be a value outside
 * the result union, and the point of the `NotificationDeliveryResult` type is that
 * there is no such value.
 */
function forgeryResult(envelope: NotificationEnvelope, refusals: number): NotificationDeliveryResult {
  if (refusals === 0) return { delivered: true, notificationId: envelope.notificationId }
  return { delivered: false, notificationId: envelope.notificationId, reason: "adapter_error" }
}

export interface VandalousAdapter extends NotificationAdapter {
  /** How many of the forged writes actually landed, i.e. were not refused. */
  readonly landed: number
  /** How many were attempted. */
  readonly attempted: number
  /** The `TypeError`s the refused writes raised, one per refused write. */
  refusals(): readonly string[]
  /** The envelope exactly as it was handed over, for a before/after comparison. */
  readonly received: NotificationEnvelope | null
}

/**
 * An adapter that rewrites every field it is handed, and counts what happened.
 *
 * Three details make this a usable probe rather than a sketch:
 *
 *   - **It keeps going after a refused write.** A real mutation attempt throws on a
 *     frozen object, and an attacker (or a buggy adapter) does not stop at the first
 *     exception, so the fixture catches each one and records it. A test can then assert
 *     "every field was attempted" separately from "the record is unchanged", which is
 *     the difference between proving the defence and proving the probe ran.
 *   - **It records what it received, by value.** A test asserting the store's record
 *     is unchanged needs to know the adapter really did see the original, or a
 *     regression that handed the adapter a pre-forged envelope would pass.
 *   - **It returns `delivered: true` when nothing threw.** So "the store survived" and
 *     "the delivery still happened" are separate, separately-asserted facts.
 */
export function vandalousAdapter(id: string): VandalousAdapter {
  let landed = 0
  let attempted = 0
  const refusals: string[] = []
  let received: NotificationEnvelope | null = null
  return {
    id,
    get landed() {
      return landed
    },
    get attempted() {
      return attempted
    },
    get received() {
      return received
    },
    refusals: () => Object.freeze([...refusals]),
    async deliver(envelope: NotificationEnvelope): Promise<NotificationDeliveryResult> {
      received = { ...envelope }
      const mutable = asMutable(envelope)
      for (const [field, forged] of Object.entries(FORGED_ENVELOPE_FIELDS)) {
        attempted += 1
        try {
          mutable[field] = forged
          landed += 1
        } catch (error) {
          refusals.push(`${field}: ${error instanceof Error ? error.name : "unknown"}`)
        }
      }
      // Also try to REPLACE the object wholesale, which freezing the properties does
      // not prevent but freezing the reference this module holds does: the adapter is
      // handed a value, not a slot, so there is no slot to write.
      attempted += 1
      try {
        Object.assign(mutable, { summary: FORGED_ENVELOPE_FIELDS.summary! })
        landed += 1
      } catch (error) {
        refusals.push(`assign: ${error instanceof Error ? error.name : "unknown"}`)
      }
      return forgeryResult(envelope, refusals.length)
    },
  }
}

/**
 * An adapter that reaches for structure the envelope does not have.
 *
 * Two things are being probed, and they are different:
 *
 *   - **A nested WRITE.** The envelope the schema accepts is flat, so a nested write is
 *     an adapter inventing a container. The store must be untouched, which is the part
 *     `deepFreezeNotificationValue` earns its name on: the freezing has to reach a
 *     value the module never had, not only the strings it knows about.
 *   - **A DEEPER nested write, on the entry rather than the envelope.** The adapter is
 *     only handed an envelope, so this one reaches through it for the record via a
 *     second adapter that was handed the whole entry. Kept as its own adapter so the
 *     two claims are asserted separately.
 */
export function nestedVandalousAdapter(id: string): VandalousAdapter {
  let landed = 0
  let attempted = 0
  const refusals: string[] = []
  let received: NotificationEnvelope | null = null
  return {
    id,
    get landed() {
      return landed
    },
    get attempted() {
      return attempted
    },
    get received() {
      return received
    },
    refusals: () => Object.freeze([...refusals]),
    async deliver(envelope: NotificationEnvelope): Promise<NotificationDeliveryResult> {
      received = { ...envelope }
      const mutable = asMutable(envelope)
      // Invent a container, fill it, and then reach inside it. Every step is a write.
      for (const [field, value] of [
        ["invented", { nested: { list: ["a"] } }],
        ["inventedArray", ["b"]],
        ["__proto__", { polluted: true }],
      ] as const) {
        attempted += 1
        try {
          mutable[field] = value
          landed += 1
        } catch (error) {
          refusals.push(`${field}: ${error instanceof Error ? error.name : "unknown"}`)
        }
      }
      // A second-level write, through a container that DID get attached, if any did.
      const container = mutable["invented"]
      if (container !== undefined && typeof container === "object") {
        attempted += 1
        try {
          ;(container as { nested: { list: string[] } }).nested.list.push("c")
          landed += 1
        } catch (error) {
          refusals.push(`deep: ${error instanceof Error ? error.name : "unknown"}`)
        }
      }
      return forgeryResult(envelope, refusals.length)
    },
  }
}

/**
 * An adapter that writes, is refused, and then throws anyway.
 *
 * The awkward case, and the one worth a fixture: the store must be intact AND `emit`
 * must still resolve (ADR 0007 section 17 — "delivery never affects orchestration
 * state"). An adapter that fails after a partial write is the one that would turn a
 * naive "publish, then deliver, then re-read" implementation into a state where the
 * inbox and the dedupe index disagree.
 */
export function halfMutatingThrowingAdapter(id: string, message = "died mid-forgery"): NotificationAdapter {
  return {
    id,
    async deliver(envelope: NotificationEnvelope): Promise<NotificationDeliveryResult> {
      const mutable = asMutable(envelope)
      // The first write is the one that would land if the clone were NOT frozen, so
      // this adapter is a live reproduction of the MED-4 bug and not a strawman.
      mutable["summary"] = "partially rewritten before the failure"
      try {
        mutable["runId"] = "run-forged"
      } catch {
        // Refused. Ignored on purpose: the point of this adapter is the throw below.
      }
      throw new Error(message)
    },
  }
}

/**
 * An adapter that records the value it was handed WITHOUT copying it, for identity
 * assertions.
 *
 * Kept as a named fixture rather than reusing `recordingAdapter` because the two
 * answer different questions: `recordingAdapter` copies with `{ ...envelope }`, so it
 * is safe to inspect, while this one holds the object the bus actually handed over —
 * which is the object whose frozenness and whose distinctness from the store's record
 * are the N14 claims. A test that asserted on a copy would pass against the MED-4 bug.
 */
export function identityRecordingAdapter(id: string): { readonly adapter: NotificationAdapter; readonly seen: readonly NotificationEnvelope[] } {
  const seen: NotificationEnvelope[] = []
  return {
    adapter: {
      id,
      async deliver(envelope: NotificationEnvelope): Promise<NotificationDeliveryResult> {
        seen.push(envelope)
        return { delivered: true, notificationId: envelope.notificationId }
      },
    },
    get seen(): readonly NotificationEnvelope[] {
      return Object.freeze([...seen])
    },
  }
}

// ===========================================================================
// Assemblies
// ===========================================================================

export interface TestHarness {
  readonly clock: ReturnType<typeof createTestClock>
  readonly store: ReturnType<typeof createNotificationStore>
  readonly bus: ReturnType<typeof createNotificationBus>
  readonly tui: ReturnType<typeof createNotificationTuiAdapter>
  counters(): NotificationCounters
}

/**
 * A store, a bus, the shipped TUI adapter, and a clock — wired the way M6.8 wires
 * them.
 *
 * `retentionWindowMs` and `quieting` are optional so a test that cares overrides one
 * and a test that does not takes the module's default.
 */
export function testHarness(options: { readonly retentionWindowMs?: number; readonly quieting?: NotificationQuieting } = {}): TestHarness {
  const clock = createTestClock()
  const store = createNotificationStore({
    clock,
    ...(options.retentionWindowMs === undefined ? {} : { retentionWindowMs: options.retentionWindowMs }),
  })
  const tui = createNotificationTuiAdapter()
  const bus = createNotificationBus({
    store,
    adapters: [tui],
    clock,
    ...(options.quieting === undefined ? {} : { quieting: options.quieting }),
  })
  return { clock, store, bus, tui, counters: () => bus.counters() }
}

/** The store's entries as plain envelopes, for the audit's `inbox_at_rest` path. */
export function storedEnvelopes(store: TestHarness["store"]): readonly NotificationEnvelope[] {
  return store.entries().map((entry) => entry.envelope)
}

/**
 * The inbox at rest, as one string, for a byte-for-byte comparison.
 *
 * The comparison MED-4 needs is "the record is UNCHANGED", and the only way to say
 * that without naming the fields is to serialise the whole thing: a store that
 * quietly dropped a field, renamed one, or reordered them would pass an assertion
 * that only checked `summary`. `JSON.stringify` is deterministic here because the
 * envelope is flat, its keys are fixed by a `.strict()` schema, and the order is
 * insertion order — so two runs of the same sequence produce the same string, which
 * is also what the 50-iteration determinism test relies on.
 *
 * `entries()` is used rather than `list()` because it takes no filter, so a snapshot
 * cannot accidentally be a snapshot of a subset.
 */
export function inboxAtRest(store: TestHarness["store"]): string {
  return JSON.stringify(store.entries())
}

/** Assert that an array of delivery results contains a reason, for terse assertions. */
export function reasonsOf(results: readonly NotificationDeliveryResult[]): readonly string[] {
  return results.map((result) => (result.delivered ? "delivered" : result.reason))
}

/** Every category, so a quieting test cannot forget one. */
export const ALL_NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = Object.freeze([
  "run_blocked",
  "run_failed",
  "lease_expired",
  "budget_exhausted",
  "rule_conflict",
  "pre_approval_pending",
])

/** Every severity. */
export const ALL_NOTIFICATION_SEVERITIES: readonly NotificationSeverity[] = Object.freeze([
  "info",
  "attention",
  "critical",
])

/** A parsed envelope, for tests that need a value the schema has blessed. */
export function parsedEnvelope(overrides: Record<string, unknown> = {}): NotificationEnvelope {
  return notificationEnvelopeSchema.parse(rawEnvelope(overrides))
}

/**
 * A branded id, produced by PARSING rather than by casting.
 *
 * `notificationIdSchema` and `dedupeKeySchema` both `.brand<...>()`, so a test that
 * writes `notificationId: "ntf-000007"` is asserting something the type system
 * forbids and a cast would silence. Going through the schema is both shorter and
 * stronger: it fails loudly if the literal ever stops satisfying the bound, so a
 * test cannot quietly depend on an id shape the schema has since narrowed.
 */
export function notificationId(id: string): NotificationId {
  return notificationIdSchema.parse(id)
}

/** The branded counterpart of {@link notificationId}. See its docblock. */
export function dedupeKey(key: string): DedupeKey {
  return dedupeKeySchema.parse(key)
}
