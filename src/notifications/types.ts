/**
 * M6.9 — advisory notifications. Types, schemas, and the no-secret audit.
 *
 * # What this module is
 *
 * One question, asked of orchestration and answered to nobody but a human: **what
 * just happened that the operator needs to know about, without telling them what
 * the work was?**
 *
 * A notification names a run, a task, a rule, a lease, and a reason code. It never
 * names a prompt, a task description, a context manifest item, a memory record, a
 * capability payload, terminal output, an environment value, or a credential
 * (ADR 0007 section 12).
 *
 * # The two properties this module exists to make unrepresentable
 *
 * **N1 — Delivery cannot reach orchestration.** ADR 0007 section 17: notifications
 * are advisory; "delivery never affects orchestration state". The mechanism is
 * structural, not behavioural: `src/notifications/**` has **no upward import edge**,
 * so this module cannot name an orchestrator, a registry, a repository, or a clock
 * it does not own. It observes through values its caller hands it and it cannot act.
 * `tests/unit/notifications/isolation.test.ts` asserts the absence of every upward
 * edge by source scan, and asserts behaviourally that a throwing adapter, an
 * unavailable adapter, a deduplicated delivery, and a throwing store all leave the
 * producer with a resolved promise and no new information.
 *
 * **N2 — A payload has nowhere to put a secret.** The envelope is `.strict()`, every
 * free-text field is length-bounded and control-character-free, and the only
 * reason-bearing field (`reasonCode`) is code-shaped — a token, not prose. A caller
 * that tries to attach a prompt gets a schema refusal, not a stored payload.
 * `tests/unit/notifications/no-secrets.test.ts` asserts both halves: that the AUDIT
 * finds canaries seeded into every field a caller might plausibly try (which proves
 * the audit works), and that the SCHEMA refuses them (which is the real control).
 *
 * # Why the identifier schemas are restated here and not imported
 *
 * ADR 0007 section 1: `notifications -> (no orchestration, mesh, memory, or runtime
 * imports)`. `runIdSchema` and `timestampSchema` live in
 * `src/orchestration/identifiers.js`, so importing them would be exactly the upward
 * edge N1 forbids — an import cycle is also something a type checker will happily
 * accept, which is why the boundary is asserted by source scan.
 *
 * The cost of restating them is drift, so the cost is paid explicitly: the patterns
 * below are byte-identical to `src/orchestration/identifiers.ts:3` and `:105-118`,
 * and `tests/unit/notifications/barrel.test.ts` asserts that this file's patterns are
 * exactly the orchestration file's, by reading both files. A local restatement that
 * matches is a projection; a local restatement that has drifted is a failing test,
 * not a silent second identifier language.
 *
 * The brands are also local, and that is a deliberate second divergence: `RunId` here
 * is NOT the kernel's `RunId`. A notification is a different kind of object from a
 * command, and being unable to pass a `RunId` across without going through this
 * module's schema is the point. It also means this module's exports cannot collide
 * with `src/rules`'s re-exported kernel identifiers at the type level.
 *
 * # Named invariants
 *
 * - **N1 — No upward edge.** See above. Nothing under `src/notifications/` imports
 *   `src/orchestration/`, `src/mesh/`, `src/runtime/`, `src/application/`,
 *   `src/memory/`, `src/context/`, or `src/server/`. Asserted by source scan.
 * - **N2 — No secrets in a payload.** See above. Asserted by the audit AND by the
 *   schema.
 * - **N3 — `emit` is total.** It never throws and never rejects. Every path out of
 *   it is a resolved `NotificationDeliveryResult[]`, and no element of that array is
 *   a value a caller can branch orchestration on: there is no throw/no-throw signal,
 *   no retry hint, and no ordering guarantee that could be read as a queue position.
 * - **N4 — The envelope is stored verbatim.** The store keeps the producer's envelope
 *   unchanged in content: it does not re-serialize, re-shape, truncate, enrich, or
 *   annotate it, and the disposition lives in the wrapper this module owns rather than
 *   inside the envelope. "Verbatim" is a claim about VALUE, not about reference — the
 *   store holds a deep-frozen clone (N14), not the producer's object, so what is at
 *   rest is equal to what was emitted and is not the same object either party can
 *   write. See `store.ts`.
 * - **N5 — Code-unit ordering, never `localeCompare`.** Identifiers sort by UTF-16
 *   code unit (ADR 0007 section 10.2). `localeCompare` is locale-dependent, so two
 *   machines with different locale data could render the same inbox differently.
 * - **N6 — Injected clock, always.** There is no `Date.now`, no `new Date()`, no
 *   `Math.random`, no filesystem, no network, no `process` in this module.
 *   `Date.parse` is the only date function used and it is applied to an
 *   already-supplied instant.
 * - **N14 — Nothing that leaves this module is a handle on what it keeps.** The
 *   store's records, the arrays it returns, the quieting it normalizes, the counters
 *   it reports, and the envelope each adapter is handed are all deep-frozen, and the
 *   adapter's copy is a fresh one per adapter. The module is an untrusted boundary
 *   (N1) and a value that can be rewritten by whoever receives it is a boundary that
 *   can be crossed in the wrong direction. Implemented in `store.ts` and `bus.ts`; see
 *   `NotificationAdapter` below for the contract it puts on a sink.
 *
 * # Stop conditions
 *
 *   - **S1 — If a needed fact is not on the envelope, do not add it here.** A caller
 *     that wants to attach the task's text is asking for the payload ADR 0007
 *     section 12 forbids. The answer is the `.strict()` refusal, not a wider schema.
 *     A field added here is a field every future notification carries, so the bar is
 *     "identifier, enum, number, digest, or code-shaped reason" and nothing else.
 *   - **S2 — If quieting ever needs to depend on envelope CONTENT, quieting becomes
 *     a content channel and stop.** Quieting reads `category` and `severity` only,
 *     both closed enums. A predicate over `summary` would be a filter over
 *     untrusted text, and the TUI would then be rendering a match it found in a
 *     prompt.
 *   - **S3 — If the audit ever needs to know what the renderer produced, it stops
 *     being an audit.** `NotificationAuditInput` is declared STRUCTURALLY and does
 *     not import `NotificationTuiViewModel`. This is the
 *     `src/context/isolation.ts:94-122` discipline: a redaction check that depended
 *     on the renderer it was checking could be defeated by a change to the renderer.
 *     A rendering that is structurally wrong (too long, control characters, a secret)
 *     is caught by the scan; a rendering that is structurally RIGHT but wrong about
 *     its own contract is a different test, and the boundary is what keeps the two
 *     from being confused.
 *   - **S4 — If `src/notifications/` ever needs to import `src/tui/`, the direction
 *     is wrong, not the import.** The TUI may import notifications; notifications
 *     may not import the TUI. A notification that knows how it will be drawn is a
 *     notification that can be made to lie by its own renderer.
 *   - **S17 — If a sink needs to write anything, grow the RESULT, not the envelope.**
 *     The natural pressure here is "the adapter wants to add a delivery timestamp to
 *     the envelope it received", and the answer is that the envelope is a report of
 *     what orchestration did, so a sink that edits it is a sink that can lie about
 *     what happened (N14). `NotificationDeliveryResult` is where sink-side facts
 *     belong; N3 constrains what may be added there, and that constraint is the point
 *     — it forces the fact to be something a producer cannot act on.
 *
 * # The audit, and why it lives beside the schema
 *
 * `auditNotificationPayload` scans what a notification *leaves* as: the envelope a
 * caller built, what the store holds at rest, the lines the view model derived, and
 * the one-line notice. Its input is `unknown`-shaped for exactly the reason S3 says.
 *
 * It does NOT import `src/context/isolation.ts`. That module imports
 * `src/memory/ontology.js` and `src/orchestration/identifiers.js`, so reusing it
 * would put an upward edge under N1 — the same reason `src/rules` is allowed
 * `rules -> memory/ontology` and this module is not. The scanning is therefore
 * implemented here directly: same encodings (raw, JSON-escaped, base64, base64url,
 * percent-encoded) plus two SHAPE detectors that catch a credential nobody seeded —
 * a bearer token, a provider-style API key, and an environment assignment.
 *
 * A leak test that only greps the raw form is a test that passes on a leak, so the
 * encodings are the point. So are the shape detectors: the canary set proves the
 * audit runs, and the shape detectors prove it is not only looking for what the
 * test planted.
 */

import { z } from "zod"

// ===========================================================================
// Identifiers, restated (see the module docblock: "why restated here")
// ===========================================================================

/** Byte-identical to `opaqueIdPattern` at `src/orchestration/identifiers.ts:3`. */
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** Byte-identical to `utcTimestampPattern` at `src/orchestration/identifiers.ts:105`. */
const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/

/**
 * A notification identifier: minted by the bus from a monotonic sequence, so the
 * same emit sequence always produces the same ids (N6: no randomness).
 */
export const notificationIdSchema = z.string().regex(/^ntf-\d{1,12}$/).brand<"NotificationId">()

/**
 * The dedupe key is the CALLER's event identity, and it is the only thing
 * deduplication reads.
 *
 * Deliberately NOT a content digest, and `tests/unit/notifications/dedupe.test.ts`
 * asserts that two different keys describing the same event are both delivered. A
 * caller who wants event-level dedupe has to say so in the key; the bus cannot
 * infer it, because inferring it would mean the bus deciding what counts as "the
 * same event", which is a policy question the producer owns and the observer does
 * not.
 */
export const dedupeKeySchema = z
  .string()
  .min(1)
  .max(256)
  // No whitespace and no free punctuation. The key is an identifier composed of other
  // identifiers, and `:`/`/`/`-`/`.`/`_` are the separators a producer reaches for when
  // it is joining `category/runId/taskId/ruleId` — so all three spellings above are
  // accepted rather than forcing one on the caller. What is refused is anything with a
  // space in it, because a key containing prose is a key someone put a description in,
  // and that is the failure mode the audit would then have to catch downstream.
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
  .brand<"DedupeKey">()

/**
 * A reason code, as opposed to a reason sentence.
 *
 * Code-shaped on purpose (N2, S1): `[a-z][a-z0-9._]{0,63}` cannot hold a sentence,
 * so the one field that could plausibly grow into prose is structurally unable to.
 * `deny_with_reason`'s user-authored explanation belongs in the rule record and the
 * explanation tree, both of which the operator opens deliberately — not in a
 * notification that interrupts.
 */
export const notificationReasonCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9._]{0,63}$/)
  .brand<"NotificationReasonCode">()

export const notificationRunIdSchema = z.string().regex(opaqueIdPattern).brand<"NotificationRunId">()
export const notificationTaskIdSchema = z.string().regex(opaqueIdPattern).brand<"NotificationTaskId">()
export const notificationDispatchIdSchema = z.string().regex(opaqueIdPattern).brand<"NotificationDispatchId">()
export const notificationNodeIdSchema = z.string().regex(opaqueIdPattern).brand<"NotificationNodeId">()
export const notificationRuleIdSchema = z.string().regex(opaqueIdPattern).brand<"NotificationRuleId">()

/**
 * The same two-step refinement the kernel's `timestampSchema` performs: a shape match,
 * then a COMPONENT ROUND-TRIP. The shape match alone is not enough — `Date.parse`
 * happily rolls `2026-02-31T00:00:00Z` forward to 2026-03-03, so an impossible
 * instant satisfies both the pattern and `Number.isFinite`, and only comparing the
 * parsed components against the written ones catches it.
 *
 * Restated rather than imported for the reason in the module docblock;
 * `barrel.test.ts` asserts the two agree, including on `2026-02-31T00:00:00Z`.
 */
export const notificationTimestampSchema = z
  .string()
  .regex(utcTimestampPattern)
  .refine((value) => {
    const milliseconds = Date.parse(value)
    if (!Number.isFinite(milliseconds)) return false

    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value)
    if (match === null) return false

    const date = new Date(milliseconds)
    return (
      date.getUTCFullYear() === Number(match[1]) &&
      date.getUTCMonth() + 1 === Number(match[2]) &&
      date.getUTCDate() === Number(match[3]) &&
      date.getUTCHours() === Number(match[4]) &&
      date.getUTCMinutes() === Number(match[5]) &&
      date.getUTCSeconds() === Number(match[6])
    )
  }, "Must be a real RFC 3339 UTC timestamp")
  .brand<"NotificationTimestamp">()

export type NotificationId = z.infer<typeof notificationIdSchema>
export type DedupeKey = z.infer<typeof dedupeKeySchema>
export type NotificationReasonCode = z.infer<typeof notificationReasonCodeSchema>
export type NotificationRunId = z.infer<typeof notificationRunIdSchema>
export type NotificationTaskId = z.infer<typeof notificationTaskIdSchema>
export type NotificationDispatchId = z.infer<typeof notificationDispatchIdSchema>
export type NotificationNodeId = z.infer<typeof notificationNodeIdSchema>
export type NotificationRuleId = z.infer<typeof notificationRuleIdSchema>
export type NotificationTimestamp = z.infer<typeof notificationTimestampSchema>

// ===========================================================================
// Closed sets
// ===========================================================================

/**
 * What a notification can be about.
 *
 * Six categories, all of them observable facts about orchestration state. A category
 * that cannot be answered "did this happen?" does not belong here, and a category
 * that could carry work content does not belong here at all (N2).
 */
export const NOTIFICATION_CATEGORIES = [
  "run_blocked",
  "run_failed",
  "lease_expired",
  "budget_exhausted",
  "rule_conflict",
  "pre_approval_pending",
] as const
export const notificationCategorySchema = z.enum(NOTIFICATION_CATEGORIES)
export type NotificationCategory = z.infer<typeof notificationCategorySchema>

/**
 * How loudly the operator should be told. A total order over a closed enum, used
 * for the critical-first listing sort — never for delivery policy, which is
 * quieting's job and is deliberately independent of severity.
 */
export const NOTIFICATION_SEVERITIES = ["info", "attention", "critical"] as const
export const notificationSeveritySchema = z.enum(NOTIFICATION_SEVERITIES)
export type NotificationSeverity = z.infer<typeof notificationSeveritySchema>

/** Why a delivery did not happen. Closed, because a free-form reason would leak. */
export const NOTIFICATION_NON_DELIVERY_REASONS = ["duplicate", "muted", "adapter_error", "adapter_unavailable"] as const
export const notificationNonDeliveryReasonSchema = z.enum(NOTIFICATION_NON_DELIVERY_REASONS)
export type NotificationNonDeliveryReason = z.infer<typeof notificationNonDeliveryReasonSchema>

/**
 * The disposition a stored entry carries.
 *
 * `pending` is the only one the operator is being asked to look at, and therefore
 * the only one `pendingCount` counts. `muted` is recorded but not nagging: the user
 * silenced it, and counting it would nag them about something they explicitly
 * chose not to hear about.
 */
export const NOTIFICATION_DISPOSITIONS = ["pending", "muted"] as const
export const notificationDispositionSchema = z.enum(NOTIFICATION_DISPOSITIONS)
export type NotificationDisposition = z.infer<typeof notificationDispositionSchema>

// ===========================================================================
// The envelope
// ===========================================================================

/**
 * The summary length bound, and why it is a number rather than a taste.
 *
 * A notification is an interruption, not a document. At 200 characters it fits a
 * terminal line beside the rest of a TUI status bar, and it is long enough to name
 * the subject, the rule, and the code. Longer text means the notification is trying
 * to be a report, and a report belongs in the run view the operator opens on purpose
 * — where the disclosure rules are the run's, not the notification's.
 */
export const MAX_NOTIFICATION_SUMMARY_CHARACTERS = 200

/**
 * No control characters, and specifically no newline.
 *
 * A newline in a summary is a forged line: the TUI renders notices as one line, so
 * a summary carrying `\n` could impersonate a second notice, a header, or a prompt.
 * Refusing it at the schema is cheaper than escaping it at four render sites, and
 * escaping it is the kind of thing that gets forgotten at the fifth.
 */
const controlCharacterPattern = /[\u0000-\u001F\u007F]/

export const notificationSummarySchema = z
  .string()
  .min(1)
  .max(MAX_NOTIFICATION_SUMMARY_CHARACTERS)
  .refine((value) => !controlCharacterPattern.test(value), "A summary may not contain control characters")

/**
 * The envelope. `.strict()` is the load-bearing part of N2.
 *
 * A non-strict object schema silently DROPS unknown keys, which means a caller
 * attaching `promptText` would get a valid envelope back with the prompt nowhere in
 * it — no error, no signal, and a producer that believes it notified someone of
 * something they cannot reproduce. `.strict()` turns that into a refusal, and the
 * refusal is the guarantee.
 */
export const notificationEnvelopeSchema = z
  .object({
    notificationId: notificationIdSchema,
    dedupeKey: dedupeKeySchema,
    category: notificationCategorySchema,
    severity: notificationSeveritySchema,
    summary: notificationSummarySchema,
    createdAt: notificationTimestampSchema,
    runId: notificationRunIdSchema.optional(),
    taskId: notificationTaskIdSchema.optional(),
    dispatchId: notificationDispatchIdSchema.optional(),
    nodeId: notificationNodeIdSchema.optional(),
    ruleId: notificationRuleIdSchema.optional(),
    /**
     * The denial or failure code — `policy_denied`, `budget_reserved`, and so on.
     *
     * ADR 0007 section 17 requires a blocked-run notification to name "the run, the
     * task, the rule that blocked it, and the denial code". Three of those four are
     * identifiers on the envelope; this is the fourth. It is code-shaped so that it
     * cannot become the place a user-authored explanation leaks (S1, N2).
     */
    reasonCode: notificationReasonCodeSchema.optional(),
  })
  .strict()

export type NotificationEnvelope = z.infer<typeof notificationEnvelopeSchema>

/**
 * What a producer hands the bus. Everything the envelope carries except the two
 * fields the bus owns: `notificationId` (minted from a sequence, N6) and `createdAt`
 * (read from the injected clock, N6). A producer that supplies either is trying to
 * control identity or time from outside, and neither is the producer's to control.
 */
export const notificationRequestSchema = z.strictObject({
  dedupeKey: dedupeKeySchema,
  category: notificationCategorySchema,
  severity: notificationSeveritySchema,
  summary: notificationSummarySchema,
  runId: notificationRunIdSchema.optional(),
  taskId: notificationTaskIdSchema.optional(),
  dispatchId: notificationDispatchIdSchema.optional(),
  nodeId: notificationNodeIdSchema.optional(),
  ruleId: notificationRuleIdSchema.optional(),
  reasonCode: notificationReasonCodeSchema.optional(),
})

export type NotificationRequest = z.infer<typeof notificationRequestSchema>

// ===========================================================================
// Delivery
// ===========================================================================

export type NotificationDeliveryResult =
  | { readonly delivered: true; readonly notificationId: NotificationId }
  | {
      readonly delivered: false
      readonly notificationId: NotificationId
      readonly reason: NotificationNonDeliveryReason
    }

/**
 * The optional sink interface, so a future external destination is an
 * implementation rather than a schema change (ADR 0007 section 17).
 *
 * An adapter is an OBSERVER. It is handed an envelope and returns a verdict; there
 * is no method through which it could return anything to the producer, and nothing
 * it does is visible to the producer except through the counters. The `available`
 * hook is a question the adapter may decline to answer truthfully in either
 * direction, which is why a throw from it is treated exactly like a throw from
 * `deliver` (N3).
 *
 * # What an adapter is HANDED, and why it is not the store's envelope (N14)
 *
 * `deliver` receives a **deep-frozen, per-adapter clone** of the notification. Before
 * the M6.10 security round it received the store.s own envelope object, by identity, and an adapter
 * could therefore rewrite `runId`, `ruleId`, `reasonCode`, `summary` and `createdAt`
 * in the operator's own inbox and hand the next adapter the rewritten values (MED-4).
 *
 * Three things follow, and an adapter implementation is written against all three:
 *
 *   - **Treat the parameter as read-only.** It is frozen, and ES modules are strict, so
 *     writing to it throws a `TypeError` inside `deliver`. The bus catches it and
 *     reports `adapter_error`, so the notification is not lost from the inbox — it is
 *     lost from that adapter, which is the correct outcome for a sink that tries to
 *     edit the report it was given.
 *   - **Keep per-delivery state in the adapter, not on the envelope.** "Delivered at",
 *     a retry count, a transport id: those belong in the adapter, which is the thing
 *     that owns the transport. See `bus.ts` S15.
 *   - **Do not retain the object and write to it later.** The clone is frozen for its
 *     whole lifetime, not just for the duration of the call, so a deferred write fails
 *     too — but it will fail somewhere other than the delivery it belonged to, which
 *     is a worse error than one the bus can count.
 *
 * The parameter TYPE is unchanged, and that is deliberate. `NotificationEnvelope` is
 * `z.infer` of a `.strict()` schema, so every field is already `readonly`-in-practice
 * by the schema's refusal to accept content; introducing a parallel `Readonly<>` type
 * would give adapters a second envelope type to be confused with the one `list()` and
 * the audit hand out, and the control here is `Object.freeze` rather than a type —
 * a type-level `readonly` is erased before the value reaches a JavaScript adapter
 * that was not compiled against it.
 */
export interface NotificationAdapter {
  readonly id: string
  /** Whether this adapter can accept a delivery right now. Optional; absent means "yes". */
  readonly available?: () => boolean
  /**
   * Deliver one notification. Never throws out of the bus: a rejection here becomes
   * `{ delivered: false, reason: "adapter_error" }` and a counter increment (N3).
   *
   * @param envelope A deep-frozen clone that belongs to this call alone (N14). Do not
   *   write to it, and do not keep a reference for a later write.
   */
  deliver(envelope: NotificationEnvelope): Promise<NotificationDeliveryResult>
}

/** The bus reads time only through this. */
export interface NotificationClock {
  now(): NotificationTimestamp
}

// ===========================================================================
// Quieting
// ===========================================================================

/**
 * Quieting by category, by severity, and by the category+severity pair.
 *
 * Deliberately three axes rather than one filter list (S2): a user who is
 * saturated by `info` wants `severities: ["info"]` and nothing else, while a user
 * who never wants to hear about budget exhaustion wants `categories:
 * ["budget_exhausted"]`. With one axis, one of those two users has to enumerate
 * values they did not mean.
 *
 * It reads only `category` and `severity` — both closed enums. A predicate over
 * `summary` would be a content filter, and a content filter is a content channel.
 */
export interface NotificationQuieting {
  readonly categories: readonly NotificationCategory[]
  readonly severities: readonly NotificationSeverity[]
  readonly pairs: readonly { readonly category: NotificationCategory; readonly severity: NotificationSeverity }[]
}

/** Which axis muted a notification, most specific first. */
export const NOTIFICATION_MUTE_AXES = ["pair", "category", "severity"] as const
export type NotificationMuteAxis = (typeof NOTIFICATION_MUTE_AXES)[number]

export type NotificationMuteVerdict =
  | { readonly muted: false }
  | { readonly muted: true; readonly by: NotificationMuteAxis }

/** The empty setting. Frozen, shared, and the default for a bus with no quieting. */
export const NO_NOTIFICATION_QUIETING: NotificationQuieting = Object.freeze({
  categories: Object.freeze([]) as readonly NotificationCategory[],
  severities: Object.freeze([]) as readonly NotificationSeverity[],
  pairs: Object.freeze([]) as readonly { readonly category: NotificationCategory; readonly severity: NotificationSeverity }[],
})

// ===========================================================================
// Counters
// ===========================================================================

/**
 * What the bus counted. Read by the TUI's status line and by the isolation test.
 *
 * The definitions are exact because the isolation test's headline assertion is a
 * statement about these numbers:
 *
 *   - `emitted` — `emit` calls that were ACCEPTED and stored (muted or not). A
 *     duplicate is not emitted; it is deduplicated.
 *   - `deduplicated` — `emit` calls suppressed because the key was already live.
 *   - `muted` — accepted emissions stored with the muted disposition.
 *   - `delivered` — adapter attempts that resulted in a delivery.
 *   - `adapterErrors` — **any** notification-path failure: an adapter that threw, an
 *     adapter that reported itself unavailable, an adapter that returned a malformed
 *     result, a store that threw on write, and an envelope the schema refused. The
 *     name is deliberately broader than "the adapter threw": from the producer's
 *     side there is exactly one question — did this reach a human — and one counter
 *     for every way the answer was no (N3).
 */
export interface NotificationCounters {
  readonly emitted: number
  readonly deduplicated: number
  readonly muted: number
  readonly delivered: number
  readonly adapterErrors: number
}

export const EMPTY_NOTIFICATION_COUNTERS: NotificationCounters = Object.freeze({
  emitted: 0,
  deduplicated: 0,
  muted: 0,
  delivered: 0,
  adapterErrors: 0,
})

// ===========================================================================
// Ordering (N5)
// ===========================================================================

/**
 * Compare by UTF-16 code unit. Never `localeCompare`.
 *
 * Exported so a TUI or a future sink sorting an inbox sorts it the way this module
 * did; re-deriving the comparator is how two views of one inbox end up disagreeing,
 * and `localeCompare` is how that disagreement becomes machine-dependent.
 */
export function compareNotificationCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Sorted and de-duplicated, by code unit. The shape every output collection has. */
export function sortedUniqueNotificationCodes(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareNotificationCodeUnits))
}

// ===========================================================================
// The no-secret audit (N2, S3)
// ===========================================================================

/** The four things a notification leaves as. Exported so a report can cite the list. */
export const NOTIFICATION_EGRESS_PATHS = [
  "envelope_payload",
  "inbox_at_rest",
  "tui_render",
  "notice_line",
] as const
export type NotificationEgressPath = (typeof NOTIFICATION_EGRESS_PATHS)[number]

export interface NotificationLeakFinding {
  readonly path: NotificationEgressPath
  readonly kind: "secret_material" | "credential_shape" | "unauthorized_content" | "structure"
  readonly severity: "blocker" | "medium"
  /** What was found, in a form safe to put in a report: paths and codes, never content. */
  readonly detail: string
  /** The subject the finding is about, when there is one. */
  readonly subjectId?: string
}

/**
 * The audit's input, declared STRUCTURALLY (S3).
 *
 * Every payload field is `unknown`. The audit reads what it is GIVEN and does not
 * import — or therefore trust — `NotificationTuiViewModel`,
 * `NotificationEnvelope`, or anything else this module happens to export. A
 * redaction check that imported the renderer it was checking could be defeated by a
 * change to the renderer; the same is true of the envelope.
 *
 * `envelopes` and `inboxEntries` are `readonly unknown[]` rather than
 * `readonly NotificationEnvelope[]` for the same reason: the audit has to work on
 * an envelope that does NOT satisfy the schema, which is precisely the case where a
 * schema-derived type would have thrown before the audit could look at it.
 */
export interface NotificationAuditInput {
  /** Literals that must not appear in any output, in any encoding. */
  readonly seededSecrets: readonly string[]
  /** Envelopes as they were emitted, valid or not. */
  readonly envelopes?: readonly unknown[]
  /** Entries as the store holds them at rest. */
  readonly inboxEntries?: readonly unknown[]
  /**
   * The rendered view, as the STRUCTURE the audit needs: a title and its lines.
   * Declared here rather than imported from `./tui-adapter.js` (S3).
   */
  readonly rendered?: { readonly title?: string; readonly lines: readonly string[] } | null
  /** The one-line notice, which is the form `TuiUiState.notice` consumes. */
  readonly notice?: string | null
}

export interface NotificationAuditResult {
  readonly findings: readonly NotificationLeakFinding[]
  /** Every path actually examined, so "no findings" is not "no checks". */
  readonly examinedPaths: readonly NotificationEgressPath[]
  readonly passed: boolean
}

/**
 * Field names that are forbidden in a serialized notification, because they are the
 * names a caller reaches for when putting CONTENT in a notification.
 *
 * The check is on the KEY, not the value, which is what makes it survive a caller
 * who did not read this file: `promptText: "..."` is refused even when the value is
 * empty, because the presence of the key is the intent, and the intent is what
 * §12 forbids.
 */
const FORBIDDEN_PAYLOAD_FIELDS = [
  "prompt",
  "prompts",
  "instructions",
  "instruction",
  "systemPrompt",
  "description",
  "taskDescription",
  "content",
  "contents",
  "text",
  "body",
  "transcript",
  "output",
  "stdout",
  "stderr",
  "diff",
  "patch",
  "payload",
  "capabilityPayload",
  "contextContent",
  "contextItems",
  "manifestItems",
  "memoryContent",
  "env",
  "environment",
  "token",
  "apiKey",
  "secret",
  "credential",
  "bearer",
] as const

/**
 * Shape detectors for credentials nobody seeded.
 *
 * The canary set proves the audit runs. These prove it is not only looking for what
 * the test planted: a `Bearer eyJ...` header, a provider-shaped API key, or an
 * `OPENAI_API_KEY=...` assignment is found whether or not it was on the list.
 */
const CREDENTIAL_SHAPE_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/ },
  { name: "provider_api_key", pattern: /\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xoxb|AKIA)[-_][A-Za-z0-9_-]{12,}/ },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: "private_key_block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "environment_assignment", pattern: /\b[A-Z][A-Z0-9_]{3,}_(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)\b\s*=/ },
]

/** Every encoding a value could plausibly arrive in. */
function notificationEncodings(value: string): readonly string[] {
  const forms = [value]
  forms.push(Buffer.from(value, "utf8").toString("base64"))
  forms.push(Buffer.from(value, "utf8").toString("base64url"))
  forms.push(encodeURIComponent(value))
  forms.push(JSON.stringify(value).slice(1, -1))
  return forms
}

/** Does any seeded literal appear in `text`, in any encoding? Returns the first hit. */
export function findSeededNotificationSecret(text: string, seededSecrets: readonly string[]): string | null {
  for (const secret of seededSecrets) {
    for (const form of notificationEncodings(secret)) {
      if (form.length >= 8 && text.includes(form)) return secret
    }
  }
  return null
}

function findCredentialShape(text: string): string | null {
  for (const { name, pattern } of CREDENTIAL_SHAPE_PATTERNS) {
    if (pattern.test(text)) return name
  }
  return null
}

/** Every own key at every depth, so a nested `payload` is found, not just a top-level one. */
function collectFieldNames(value: unknown, prefix = ""): readonly string[] {
  if (value === null || typeof value !== "object") return []
  if (Array.isArray(value)) return value.flatMap((item) => collectFieldNames(item, prefix))
  const names: string[] = []
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    names.push(key, ...collectFieldNames(child, `${prefix}${key}.`))
  }
  return names
}

function auditText(
  text: string,
  seededSecrets: readonly string[],
  path: NotificationEgressPath,
  subjectId: string | undefined,
  label: string,
): readonly NotificationLeakFinding[] {
  const findings: NotificationLeakFinding[] = []
  const secret = findSeededNotificationSecret(text, seededSecrets)
  if (secret !== null) {
    findings.push({
      path,
      kind: "secret_material",
      severity: "blocker",
      detail: `${label} contains a seeded secret literal, in an encoding the audit recognises`,
      ...(subjectId === undefined ? {} : { subjectId }),
    })
  }
  const shape = findCredentialShape(text)
  if (shape !== null) {
    findings.push({
      path,
      kind: "credential_shape",
      severity: "blocker",
      detail: `${label} contains a credential-shaped string (${shape})`,
      ...(subjectId === undefined ? {} : { subjectId }),
    })
  }
  return findings
}

function auditPayloads(
  payloads: readonly unknown[],
  seededSecrets: readonly string[],
  path: NotificationEgressPath,
  label: string,
): readonly NotificationLeakFinding[] {
  const findings: NotificationLeakFinding[] = []
  payloads.forEach((payload, index) => {
    const subjectId =
      payload !== null && typeof payload === "object"
        ? (payload as { notificationId?: unknown }).notificationId
        : undefined
    const subject = typeof subjectId === "string" ? subjectId : `${label}[${index}]`

    const serialized = JSON.stringify(payload) ?? "undefined"
    findings.push(...auditText(serialized, seededSecrets, path, subject, `${label} ${subject}`))

    for (const name of collectFieldNames(payload)) {
      const bare = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name
      if ((FORBIDDEN_PAYLOAD_FIELDS as readonly string[]).includes(bare)) {
        findings.push({
          path,
          kind: "unauthorized_content",
          severity: "blocker",
          // The KEY, never the value. This string ends up in a reviewer's report.
          detail: `${label} ${subject} carries a '${bare}' field; ADR 0007 section 12 forbids content fields in a notification payload`,
          subjectId: subject,
        })
      }
    }
  })
  return findings
}

/**
 * Audit what a notification produced.
 *
 * Checks the paths the input supplies and records which ones it examined, so a
 * caller that forgets to pass the rendered view gets an audit that says it examined
 * three of four — not one that quietly passed (the `src/context/isolation.ts:175-179`
 * lesson).
 */
export function auditNotificationPayload(input: NotificationAuditInput): NotificationAuditResult {
  const findings: NotificationLeakFinding[] = []
  const examined: NotificationEgressPath[] = []

  if (input.envelopes !== undefined) {
    examined.push("envelope_payload")
    findings.push(...auditPayloads(input.envelopes, input.seededSecrets, "envelope_payload", "Envelope"))
    // The schema is the primary control (N2), and the audit says so rather than
    // leaving it implicit: an envelope that would not parse is reported here as a
    // structural finding, so a caller auditing a *malformed* payload still gets a
    // signal that the envelope is malformed.
    input.envelopes.forEach((envelope, index) => {
      if (notificationEnvelopeSchema.safeParse(envelope).success) return
      findings.push({
        path: "envelope_payload",
        kind: "structure",
        severity: "blocker",
        detail: `An emitted envelope does not satisfy notificationEnvelopeSchema; a payload this build cannot read is a payload nothing downstream can validate`,
        subjectId:
          envelope !== null && typeof envelope === "object"
            ? String((envelope as { notificationId?: unknown }).notificationId ?? `envelope[${index}]`)
            : `envelope[${index}]`,
      })
    })
  }

  if (input.inboxEntries !== undefined) {
    examined.push("inbox_at_rest")
    findings.push(...auditPayloads(input.inboxEntries, input.seededSecrets, "inbox_at_rest", "Inbox entry"))
  }

  if (input.rendered !== undefined && input.rendered !== null) {
    examined.push("tui_render")
    const rendered = input.rendered.lines.join("\n")
    findings.push(...auditText(rendered, input.seededSecrets, "tui_render", undefined, "The rendered notification view"))
    if (input.rendered.title !== undefined) {
      findings.push(...auditText(input.rendered.title, input.seededSecrets, "tui_render", undefined, "The rendered title"))
    }
  }

  if (input.notice !== undefined && input.notice !== null) {
    examined.push("notice_line")
    findings.push(...auditText(input.notice, input.seededSecrets, "notice_line", undefined, "The one-line notice"))
  }

  return { findings, examinedPaths: examined, passed: findings.length === 0 }
}

/**
 * A one-line disposition for a report.
 *
 * Says which paths were checked, because "no leaks found" without "out of four" is
 * indistinguishable from "no leaks, because nothing was checked".
 */
export function describeNotificationAudit(result: NotificationAuditResult): string {
  const blockers = result.findings.filter((finding) => finding.severity === "blocker").length
  return `${result.examinedPaths.length}/${NOTIFICATION_EGRESS_PATHS.length} paths examined, ${result.findings.length} finding(s) (${blockers} blocker), ${result.passed ? "PASS" : "FAIL"}`
}
