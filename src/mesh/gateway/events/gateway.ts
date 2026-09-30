import { createContractError } from "../../../orchestration/errors.js"
import { eventIdSchema, nodeIdSchema, type EventId, type NodeId } from "../../../orchestration/identifiers.js"
import { safeParseMeshEnvelope } from "../../protocol/registry.js"
import { EventSequenceTracker, type MeshEvent } from "../../protocol/event.js"
import { MESH_EVENT_RESUME_LIMIT, MESH_EVENT_RETENTION_MAX_AGE_MS, MESH_EVENT_RETENTION_MAX_EVENTS } from "./types.js"
import type {
  EventGatewayDependencies,
  EventStreamCursor,
  EventStreamGateway,
  GatewayPublishOutcome,
  GatewayPublishResult,
  GatewayResume,
  ReplayScope,
  StreamedEvent,
} from "./types.js"

/**
 * M4.6 — the SSE event gateway.
 *
 * It is the ONLY place an event gets a total order, and the reason it needs one
 * is that neither order the mesh already has is total:
 *
 *   - the kernel's `sequence` is per RUN, so two runs' event 7 have nothing to
 *     order them against each other by;
 *   - the mesh's `localSequence` is per SOURCE NODE, for the same reason.
 *
 * A single SSE client reads every run this controller drives and every worker's
 * reports about them, so its cursor has to order all of them. That number is
 * `position`, it is assigned here at accept time, and it is the only thing
 * `Last-Event-ID` ever carries.
 *
 * ### The four properties, and where each one lives
 *
 *   1. **Order.** `position` is strictly increasing and gapless, so a total order
 *      over the retained stream is a property of the counter rather than of a
 *      sort. {@link sortPosition} re-sorts defensively, and the reason it is
 *      worth the allocation is written there.
 *   2. **Resume.** `resume(cursor)` returns STRICTLY LATER entries. Strictly,
 *      not "from": an inclusive `>=` re-delivers the event the client already
 *      holds, and SSE clients have no dedupe of their own, so a re-delivery is a
 *      second thing that happened unless the receiver happens to notice.
 *   3. **Retention, and the refusal to jump.** {@link MeshEventGateway.resume}
 *      returns `snapshot_required` or `refused` when a cursor cannot be
 *      honoured. It NEVER returns the head for an un-honourable cursor.
 *   4. **Suppression and version refusal.** {@link MeshEventGateway.publish}.
 */
export class MeshEventGateway implements EventStreamGateway {
  readonly #now: () => number
  readonly #maxEvents: number
  readonly #maxAgeMs: number
  readonly #resumeLimit: number
  readonly #snapshots: EventGatewayDependencies["snapshots"]
  readonly #retained: StreamedEvent[] = []
  readonly #trackers = new Map<string, EventSequenceTracker>()
  readonly #seenEventIds = new Set<string>()
  #nextPosition = 1

  constructor(dependencies: EventGatewayDependencies) {
    this.#now = dependencies.now
    this.#maxEvents = dependencies.retentionMaxEvents ?? MESH_EVENT_RETENTION_MAX_EVENTS
    this.#maxAgeMs = dependencies.retentionMaxAgeMs ?? MESH_EVENT_RETENTION_MAX_AGE_MS
    this.#resumeLimit = dependencies.resumeLimit ?? MESH_EVENT_RESUME_LIMIT
    this.#snapshots = dependencies.snapshots
    this.#restore(dependencies.durableStream)
  }

  /**
   * Rebuilds the window, the watermark and the position counter from the durable
   * log.
   *
   * Called once, from the constructor, and the ORDER of what it restores is the
   * whole point:
   *
   *   - `#nextPosition` is set to one past the newest durable position, so a
   *     position is never re-issued. Re-issuing one would hand two different
   *     events the same `Last-Event-ID`, and a client resuming from it could not
   *     tell which it already held.
   *   - The trackers and `#seenEventIds` are rebuilt from the same entries, so a
   *     redelivery after a restart is still recognised as a redelivery. Without
   *     them the first retransmission after a restart would be admitted as a NEW
   *     event, which is the duplicate the plan's convergence requirement is about.
   *   - `#retained` is restored BEFORE `#age()`, and only the tail that still fits
   *     the count bound is kept — a restart must not resurrect a window the
   *     process was in the middle of evicting.
   *
   * A source that throws is fatal to construction rather than swallowed: a
   * gateway that started with a half-restored window would issue positions that
   * collide with ones a client already holds, which is worse than not starting.
   */
  #restore(source: EventGatewayDependencies["durableStream"]): void {
    if (source === undefined) return
    const durable = source.entries()
    if (durable.length === 0) return

    let newest = 0
    for (const entry of durable) {
      newest = Math.max(newest, entry.position)
      this.#seenEventIds.add(entry.eventId)
      const tracker = this.#trackerFor(entry.sourceNodeId)
      // `observe` rather than `evaluate`: restoring must not be able to REFUSE.
      // A durable log is a record of what this node already published, so a
      // restoration that reported a gap would be a claim about history this
      // process did not witness and cannot contradict.
      tracker.observe(entry.localSequence)
    }
    this.#nextPosition = newest + 1
    for (const entry of durable.slice(-this.#maxEvents)) this.#retained.push(entry)
    this.#age()
  }

  /**
   * Admits one wire record to the stream, or says why not.
   *
   * ASYNC and not pure, for one reason: the retention window is aged against the
   * injected clock on the way in, so a gateway that aged only on read would let
   * an idle stream's retention bound be decided by who happened to ask next. The
   * clock is injected, so "aged out" is a number rather than a wait.
   */
  async publish(value: unknown): Promise<GatewayPublishResult> {
    const parsed = safeParseMeshEnvelope(value)
    if (!parsed.ok) {
      return {
        ok: false,
        // `versionError` is the whole reason `safeParseMeshEnvelope` returns a
        // result object rather than throwing. `true` means "upgrade the peer" and
        // will never parse here however long it is retried; `false` means "your
        // sender is broken" and is a bug in a version both sides already speak.
        // Collapsing them produces a version-skewed node that retries forever, and
        // a sender bug that gets diagnosed as version skew.
        kind: parsed.versionError ? "version_unsupported" : "record_invalid",
        versionError: parsed.versionError,
        error: parsed.error,
      }
    }
    const envelope = parsed.value
    if (envelope.recordType !== "mesh.event") {
      return {
        ok: false,
        kind: "not_an_event",
        versionError: false,
        error: createContractError(
          "validation",
          "mesh.stream_not_an_event",
          `The event gateway received a '${envelope.recordType}'. This seam streams 'mesh.event' and nothing else, and interpreting another family here would put a record on the stream with no 'localSequence' to order it by.`,
        ),
      }
    }
    return { ok: true, outcome: this.#admit(envelope.payload) }
  }

  /**
   * Everything strictly after `cursor`, in order — or an explicit refusal.
   *
   * ### The scope is a FILTER, not only a fallback key
   *
   * `scope` is the RUN the client is asking about, and when one is supplied the
   * returned page contains ONLY that run's entries. This is the whole of the
   * cross-run disclosure defence, and it is stated first because the alternative
   * reading is the obvious one: a `position` is a single total order across every
   * run and source this controller drives, so a page taken from the retained
   * window without consulting the scope hands a client scoped to run A the full
   * payloads of run B — including `session.prompt`'s prompt text and every
   * dispatch envelope. M4.10 demonstrated exactly that (finding M4.10-S1): a
   * client that named a scope it had no events for received another run's events
   * verbatim, because the scope was used to file the snapshot and to nothing else.
   *
   * So the scope is applied in TWO places, and the second is the one that is easy
   * to forget:
   *
   *   1. the PAGE is filtered to the scope, and
   *   2. the honourability floor is computed over the SCOPED window, not the
   *      global one. A global floor would tell a run-scoped client it is
   *      continuous when every one of ITS events had been evicted while another
   *      run's were retained — which is the same undetectable gap the snapshot
   *      fallback exists to refuse, reached by a different route.
   *
   * ### An unscoped resume is a MESH-WIDE read
   *
   * `scope` is optional, and omitting it means "every run on this gateway". That
   * is deliberate and it is confined: the only callers that omit it are the
   * in-process controller/TUI readers, which are inside the trust boundary by
   * construction. The NETWORK seam cannot omit it — `EventStreamRouteDependencies
   * .scopeOf` is a required member returning a `Result`, and a request whose
   * scope does not parse is a 400 before `resume` is ever called. A future
   * gateway that wants a mesh-wide stream has to be a new seam, not this one with
   * its `scopeOf` made optional.
   */
  async resume(
    cursor: EventStreamCursor | null,
    options: { readonly limit?: number; readonly scope?: ReplayScope } = {},
  ): Promise<GatewayResume> {
    this.#age()
    const bound = Math.max(1, Math.min(options.limit ?? this.#resumeLimit, this.#resumeLimit))
    const head = this.head()
    // The window this client is entitled to see. With no scope, that is the whole
    // retained window; with one, it is the entries belonging to that run alone.
    const window = options.scope === undefined ? this.#retained : this.#inScope(options.scope)
    // The head the CLIENT can reach, which is the newest position in ITS window.
    // Reporting the global head to a run-scoped client would tell it about
    // positions it can never be given, and it would then believe it was behind by
    // events that do not concern it.
    const scopedHead = window.length === 0 ? head : window[window.length - 1]!.position

    if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 0)) {
      return {
        kind: "refused",
        reason: "cursor_malformed",
        error: createContractError(
          "validation",
          "mesh.stream_cursor_malformed",
          `A resume cursor of ${JSON.stringify(cursor)} is not a non-negative integer gateway position. It is refused rather than treated as "start from the head", because a client that cannot state where it was must be told: the alternative is a client that silently believes it is continuous when it is not.`,
        ),
      }
    }

    // A cursor AHEAD of the head is not a stale client. It is a client reading a
    // different stream — a second gateway, a restored database, a client bug —
    // and answering it with the head is indistinguishable from "you are current",
    // which is the one false answer that hides the fault.
    //
    // The comparison is against the GLOBAL head, not the scoped one, and the
    // asymmetry is deliberate. `position` is one counter over every run, so a
    // cursor minted anywhere on this gateway names a position in that single
    // sequence; a client holding a position from another run's page is holding a
    // position this gateway DID produce, and refusing it as `cursor_ahead` would
    // tell a correct client its own history is fictional. It is answered from its
    // own window instead, and the answer is simply the entries that window holds.
    if (cursor !== null && cursor > head) {
      return {
        kind: "refused",
        reason: "cursor_ahead",
        error: createContractError(
          "conflict",
          "mesh.stream_cursor_ahead",
          `The resume cursor ${cursor} is ahead of this gateway's head ${head}, so it names a stream this gateway has never produced. It is refused rather than treated as "already current": the client is reading a different stream, and saying so is the only answer that surfaces it.`,
        ),
      }
    }

    const from = cursor === null ? scopedHead : cursor
    const available = sortPosition(window.filter((entry) => entry.position > from))
    const entries = available.slice(0, bound)

    if (cursor === null) {
      // No cursor: the client asked for the head and gets the head. There is no
      // gap to declare, so there is nothing here to refuse. `from` is the SCOPED
      // head, so the page a client receives never claims to start before a
      // position it cannot be given.
      return { kind: "resume", from, head: scopedHead, entries }
    }

    // Honourable exactly when the entry immediately after the cursor is still
    // retained **in this client's own window**. Expressed against the retention
    // FLOOR rather than as "is anything missing", because an empty retention and
    // a retention that starts above the cursor are the same problem and must not
    // be two code paths.
    //
    // The floor is the SCOPED floor, and this is the second half of the
    // cross-run disclosure defence. A global floor would be a false "you are
    // continuous" for a run whose every event had been evicted while another
    // run's were retained: the client would receive an empty page and conclude it
    // was up to date, with nothing on the wire reporting the events it missed.
    // That is precisely the silent gap the snapshot fallback exists to refuse, so
    // the floor has to be the one the client's own window can actually answer for.
    const floor = window.length === 0 ? scopedHead + 1 : window[0]!.position
    if (cursor + 1 >= floor) {
      return { kind: "resume", from: cursor + 1, head: scopedHead, entries }
    }

    // The re-base is a SEPARATE question from the page, and it is asked only once
    // the page is known to be unhonourable. The `scope` is the caller's, never the
    // retained window's — see `ReplayScope`.
    const scope = options.scope
    if (this.#snapshots === undefined || scope === undefined) {
      return { kind: "refused", reason: "snapshot_unavailable", error: this.#noSnapshot(cursor, floor) }
    }
    const rebase = await this.#snapshots.fallbackFor(scope)
    if (!rebase.ok) {
      return { kind: "refused", reason: "snapshot_unavailable", error: rebase.error }
    }
    // `null` is the source saying it holds nothing for this run. It is NOT the same
    // answer as a digest mismatch — one is "there is no state here", the other is
    // "the state here is not what it claims to be" — and both are refusals, so
    // neither can degrade into serving the head. The distinction is preserved in
    // the error, not in the branch, because the client's next action is the same
    // for both: stop and tell a human.
    if (rebase.value === null) {
      return { kind: "refused", reason: "snapshot_unavailable", error: this.#noSnapshot(cursor, floor) }
    }
    // The reported `head` is the SCOPED head, for the same reason the resume
    // branch reports one: a re-base frame that names a position the client can
    // never be given is a position it will wait for.
    return { kind: "snapshot_required", rebase: rebase.value, head: scopedHead }
  }

  /**
   * The newest position this gateway has issued, across EVERY run.
   *
   * Deliberately the GLOBAL head even though `resume` reports a scoped one, and
   * the two are different questions: this is "where has the counter got to", which
   * is what `cursor_ahead` and `cursorFromRequest`'s `> head` comparison are both
   * measured against, because a `Last-Event-ID` is a position in that one
   * sequence. `resume`'s `head` is "where can THIS client get to".
   */
  head(): EventStreamCursor {
    return this.#retained.length === 0 ? this.#nextPosition - 1 : this.#retained[this.#retained.length - 1]!.position
  }

  oldestRetained(): EventStreamCursor | null {
    this.#age()
    return this.#retained.length === 0 ? null : this.#retained[0]!.position
  }

  /**
   * How many dedupe marks are held.
   *
   * Exists for M4.10-H2 and for the audit that follows it. The mark set is
   * private, so before this accessor existed the only way to observe its growth was
   * a heap measurement — which is a real measurement and a poor regression test,
   * because it fails on a machine's allocator rather than on the bound. A count
   * against `MESH_EVENT_RETENTION_MAX_EVENTS` is a statement about the bound, and
   * `unbounded-marks.test.ts` is what keeps it one.
   *
   * Ages the window first, so the answer is "after applying the bounds", which is
   * the question. Reporting the pre-age count would let the accessor be right about
   * an instant no caller ever observes.
   */
  dedupeMarkCount(): number {
    this.#age()
    return this.#seenEventIds.size
  }

  retained(): readonly StreamedEvent[] {
    this.#age()
    return this.#retained
  }

  /**
   * The admission decision, once the record is known to be a `mesh.event`.
   *
   * The order of the three checks is load-bearing and matches
   * `MeshEventIngestor.ingest`'s: the `eventId` check comes FIRST, because a
   * duplicate must be answered without consulting the tracker at all. Evaluating
   * a duplicate through the sequence check classifies it as `out_of_order` the
   * moment the watermark has moved past it — which is exactly what happens after
   * the very redelivery the plan requires to be harmless — and an operator then
   * reads a retransmission as a defect.
   */
  #admit(event: MeshEvent): GatewayPublishOutcome {
    const eventId = eventIdSchema.parse(event.eventId)
    const sourceNodeId = nodeIdSchema.parse(event.sourceNodeId)

    if (this.#seenEventIds.has(eventId)) {
      return {
        accepted: false,
        disposition: "duplicate",
        eventId,
        detail: `Event '${eventId}' is already on this stream. A redelivery converges onto the entry already held rather than becoming a second thing that happened.`,
      }
    }

    const tracker = this.#trackerFor(sourceNodeId)
    const verdict = tracker.evaluate(event.localSequence)
    if (verdict.status === "duplicate") {
      return {
        accepted: false,
        disposition: "out_of_order",
        eventId,
        detail: `Event '${eventId}' carries local sequence ${event.localSequence} from '${sourceNodeId}', behind the highest sequence accepted (${verdict.highestAccepted}). It is suppressed rather than applied: the watermark is the record of what this node has been through, and re-applying would put the stream backwards.`,
      }
    }
    if (verdict.status === "gap") {
      // NOT admitted and NOT advancing. The tracker has already declined to move
      // the watermark over a hole, which is what keeps a missing
      // `dispatch.started` from making a running session read as un-run. The
      // missing range is in the error because the remedy is to ask for that range.
      return {
        accepted: false,
        disposition: "gap",
        eventId,
        detail: `Event '${eventId}' at local sequence ${event.localSequence} leaves ${verdict.missingFrom}-${verdict.missingTo} unseen.`,
        error: verdict.error,
      }
    }

    const entry: StreamedEvent = Object.freeze({
      position: this.#nextPosition,
      eventId,
      sourceNodeId,
      localSequence: event.localSequence,
      projectId: event.runProjectScope.projectId,
      runId: event.runProjectScope.runId,
      eventType: event.eventType,
      // THIS gateway's clock, never the event's `observedAt`. Retention is a
      // property of the retaining node, and measuring it with the sender's clock
      // would let a fast-clocked peer age its own events out of the window
      // immediately and a slow-clocked one keep them forever.
      retainedFromMs: this.#now(),
      payload: event,
    })
    this.#nextPosition += 1
    this.#seenEventIds.add(eventId)
    this.#retained.push(entry)
    this.#evict()
    return { accepted: true, entry }
  }

  #trackerFor(sourceNodeId: NodeId): EventSequenceTracker {
    const existing = this.#trackers.get(sourceNodeId)
    if (existing !== undefined) return existing
    const created = new EventSequenceTracker(sourceNodeId)
    this.#trackers.set(sourceNodeId, created)
    return created
  }

  /**
   * The retained entries belonging to one `(projectId, runId)`, in position order.
   *
   * BOTH members of the pair, and not the run alone. A `runId` is an id a
   * controller mints, and nothing in the protocol says two projects cannot mint
   * the same one; matching on `runId` alone would make a run id a global
   * capability, which is the same class of defect as resolving a lease by run id
   * without the project. The `StreamedEvent` carries both because both come off
   * the RECORD (`runProjectScope`), not off the caller — see `#admit`.
   */
  #inScope(scope: ReplayScope): StreamedEvent[] {
    return this.#retained.filter(
      (entry) => entry.projectId === scope.projectId && entry.runId === scope.runId,
    )
  }

  /**
   * The COUNT bound. Splice from the front, because the array is already ordered.
   *
   * And the dedupe marks go with each evicted entry, for the reason `#age` gives.
   * `#evict` and `#age` are the two places a bound is applied, so they are the two
   * places a mark is released; a third eviction path added later without it would
   * reintroduce M4.10-H2, which is why both are written to release rather than
   * merely shift.
   */
  #evict(): void {
    while (this.#retained.length > this.#maxEvents) {
      const evicted = this.#retained.shift()
      if (evicted !== undefined) this.#seenEventIds.delete(evicted.eventId)
    }
  }

  /**
   * The AGE bound, applied on read as well as on write.
   *
   * On READ as well because a gateway that is read but not written still ages: an
   * idle stream that only ever answered a resume would otherwise keep offering
   * entries past their bound indefinitely, and the bound would be a property of
   * traffic rather than of time.
   *
   * The dedupe marks are pruned IN THE SAME LOOP, and that is M4.10-H2. They used
   * to be a `Set` that only ever grew, so a controller whose mesh was merely busy
   * held one `string` per event it had ever accepted for the life of the process
   * while its own stated bound was 256 entries. 200 000 events measured 62 MB of
   * heap against a 256-entry window. The window is the only stated retention bound
   * in this class, so anything that outlives it without a bound of its own is an
   * unbounded structure wearing a bounded structure's name.
   *
   * Pruning costs NO idempotence, and the reason is the per-source sequence
   * watermark: an event whose id has aged out of the mark set still sits behind its
   * source's highest accepted sequence, so a redelivery of it is refused as
   * `out_of_order` rather than admitted as new. The mark set is the FAST path for
   * the common case (a retransmission of the newest event); the watermark is the
   * backstop that makes the fast path's eviction safe. `#seenEventIds` is therefore
   * a cache of the watermark's answer, and a cache bounded by the thing it caches is
   * correct rather than merely tidy.
   */
  #age(): void {
    const cutoff = this.#now() - this.#maxAgeMs
    while (this.#retained.length > 0 && this.#retained[0]!.retainedFromMs <= cutoff) {
      const evicted = this.#retained.shift()
      // The id is removed only once the ENTRY is gone. Removing it earlier would
      // mean the mark set could drop a mark for an entry the window is still
      // serving, and the eviction would then be visible to a client resuming inside
      // the window — which is the range the resume floor is computed over.
      if (evicted !== undefined) this.#seenEventIds.delete(evicted.eventId)
    }
  }

  #noSnapshot(cursor: EventStreamCursor, floor: EventStreamCursor) {
    return createContractError(
      "conflict",
      "mesh.stream_snapshot_unavailable",
      `The resume cursor ${cursor} is below this gateway's retention floor ${floor}, and no snapshot is available to re-base onto. The stream is NOT continued from the head: the client would be missing every event between ${cursor + 1} and ${floor - 1}, and nothing on the wire would report it.`,
    )
  }
}

/**
 * Sorts by the gateway's position, defensively.
 *
 * The retained array is in order by construction, so this is not a correctness
 * requirement for it. It is here because a stream that reached a client out of
 * order is UNDETECTABLE at the client: a TUI applying events in arrival order
 * builds a wrong projection and reports nothing, and that is the failure mode
 * the whole "ordered events" requirement exists to prevent. A sort that costs one
 * array and makes the guarantee structural is worth it.
 */
function sortPosition(entries: readonly StreamedEvent[]): readonly StreamedEvent[] {
  return [...entries].sort((left, right) => left.position - right.position)
}
