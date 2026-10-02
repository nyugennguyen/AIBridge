/**
 * M6.7 — the fail-closed command sinks.
 *
 * # What this file is
 *
 * ADR 0007 section 16's mechanism, made concrete:
 *
 * > The simulator is composed of the SAME pure planners and evaluators as
 * > production, with every command sink replaced by a fail-closed fake whose only
 * > implementation throws. There is no "dry-run mode" flag threaded through
 * > production code, because a flag is a second code path and a second code path is
 * > where divergence starts.
 *
 * So there is no `dryRun: true` anywhere in this module, and there is no
 * `if (dryRun)` in `src/rules/`, `src/budgets/`, `src/routing/` or
 * `src/workflows/`. The composition in `./plan.js` calls those modules'
 * production functions, and the only things standing between that composition and
 * the outside world are the interfaces declared here — every one of which throws.
 *
 * # The two shapes of fake, and why they differ
 *
 * **Fail-closed throwing sinks** — the event log, the network, the process
 * launcher, the filesystem, the notifier. Every method's only implementation
 * throws `SimulationSideEffectError`. They exist so that a dry run which reaches
 * one fails LOUDLY at the point of the call, with the sink named, instead of
 * quietly appending an event nobody can later un-append. A dry run that reports
 * success for a plan the real run would refuse is a dry run of nothing, and a sink
 * that no-ops is exactly how that happens.
 *
 * **The counting budget store** — the one sink the composition must actually
 * *enter*, because ADR 0007 section 13.2 defines a dispatch's eligibility as
 * holding a `held` reservation, and a dry run that never asked the ledger would be
 * a dry run that never asked the only question that matters. So
 * `createBudgetLedgerProbe` is a `BudgetLedgerStore` that:
 *
 *   - runs the ledger's OWN admission callback, synchronously, exactly as
 *     `InMemoryBudgetLedgerStore` does, so the saturation arithmetic and the
 *     refusal are `src/budgets`' decisions and not this module's;
 *   - returns the `BudgetReservation` the ledger would have written, parsed through
 *     `budgetReservationSchema` so the reported reservation is a shape the ledger
 *     would accept; and
 *   - retains NOTHING. There is no map, no index, and no held-units total in this
 *     class at all — not a reset one, not an empty one, none. `read`,
 *     `reservationForDispatch` and `heldUnitsFor` are therefore structurally
 *     incapable of reporting capacity, and the strongest available statement
 *     holds: after a dry run, every dispatch is still INELIGIBLE, because
 *     eligibility is *defined* as holding a held reservation and none exists.
 *
 * That last point is why the counting store does not merely "not write". A store
 * that held reservations in a map and was cleared afterwards would have made
 * capacity briefly real inside the dry run; one that refuses to hold a map at all
 * makes the write unrepresentable. Its `transition` throws, because a dry run has
 * no reservation to commit, release or expire.
 *
 * # Named invariants
 *
 * - **K1 — Every sink throws or retains nothing.** No sink in this file has a
 *   reachable implementation that performs I/O, appends an event, opens a
 *   connection, launches a process, or writes a file. `SimulationSideEffectError`
 *   is the only terminal state of every one of them.
 * - **K2 — The counters are at the sink.** `SimulationSinkCounters` counts CALLS at
 *   the boundary, not calls observed by a source scan. A test that reads them is
 *   measuring the thing the claim is about; a test that greps the source is
 *   measuring the text, and `Date.now` in a comment would fail it.
 * - **K3 — One error type, always naming the sink.** A dry run that reached a sink
 *   throws `SimulationSideEffectError` carrying the sink name and the call, so the
 *   failure says which boundary was crossed without a stack trace.
 * - **K4 — No clock, no randomness, no I/O in this file either.** The sink module
 *   is where a "just record the time" would go, and that is the clock that would
 *   make a plan's digest depend on when it was taken.
 * - **K5 — Every mutating method of the budget probe either counts or throws.**
 *   `reserveInTransaction` counts and decides; `transition` throws; there is no
 *   third behaviour for a future editor to discover.
 *
 * # Stop conditions
 *
 * - **S1 — If a sink is ever given a real implementation, the milestone's headline
 *   claim is void.** The throw is the claim. A sink that degrades to a warning, or
 *   to a `console.log`, is a sink that will eventually be a call.
 * - **S2 — If the composition needs a fact only a live sink could supply, the fact
 *   belongs on the request as a snapshot value** (see `./types.ts` S3). Reaching for
 *   a sink to ask "is the node up right now" would make the dry run a real run.
 */

import {
  budgetRefusal,
  budgetRefuse,
  budgetReservationSchema,
  type BudgetLedgerStore,
  type BudgetRefusal,
  type BudgetReservation,
  type BudgetResult,
  type ReservationAdmission,
  type ReservationDraft,
  type ReservationId,
  type ReservationState,
  type ReservationTransition,
  type ReservationTransitionResult,
  type BudgetScope,
} from "../budgets/index.js"

// ===========================================================================
// The error
// ===========================================================================

/**
 * Thrown by a sink, and by nothing else.
 *
 * It is the one class in this module that a caller is expected to see, and it is
 * NOT a refusal: a refusal is a decision about the plan, and this is a statement
 * that the plan was built by crossing a boundary it must not cross. Conflating them
 * would let a caller treat "the dry run is broken" as "the dry run said no", which
 * is how a broken dry run ships.
 */
export class SimulationSideEffectError extends Error {
  /** The sink that was reached: `event_log`, `network`, `process`, `filesystem`, `notifier`, `budget_ledger`. */
  readonly sink: string
  /** The member that was called. */
  readonly call: string

  constructor(sink: string, call: string, detail: string) {
    super(
      `simulation.sink_invoked: the '${sink}' sink was reached at '${call}'. ${detail} A dry run that reaches a command sink has crossed the boundary ADR 0007 section 16 exists to hold; the fix is a plan that does not need this call, never a sink that performs it.`,
    )
    this.name = "SimulationSideEffectError"
    this.sink = sink
    this.call = call
  }
}

/** The sink names, closed so a test can assert an exhaustive set. */
export const SIMULATION_SINK_NAMES = [
  "budget_ledger",
  "event_log",
  "filesystem",
  "network",
  "notifier",
  "process",
] as const

export type SimulationSinkName = (typeof SIMULATION_SINK_NAMES)[number]

/** Builds the throw. One call site per sink method, so the detail is per-sink. */
function refuseSink(sink: SimulationSinkName, call: string, detail: string): never {
  throw new SimulationSideEffectError(sink, call, detail)
}

// ===========================================================================
// Counters
// ===========================================================================

/**
 * What the dry run would have written, counted at the sink.
 *
 * Every member is a COUNT OF CALLS, which is why the acceptance test can assert
 * zeros without inspecting any production source: a member that stayed at zero is a
 * member no implementation was reached through. `retainedReservations` is the one
 * that matters most, and the budget probe increments nothing on a successful
 * reserve — see its docblock.
 */
export interface SimulationSinkCounters {
  /** Calls that would have appended an event. */
  readonly eventAppends: number
  /** Calls that would have opened a connection. */
  readonly networkCalls: number
  /** Calls that would have launched a process. */
  readonly processLaunches: number
  /** Calls that would have written to the filesystem. */
  readonly filesystemWrites: number
  /** Calls that would have emitted a notification. */
  readonly notificationsEmitted: number
  /**
   * Calls into the budget store's compare-and-set.
   *
   * Non-zero in a normal dry run, and that is correct: the ledger's admission
   * decision is one of the answers a plan must carry. What must be zero is
   * `retainedReservations` — the gate was asked, and nothing was kept.
   */
  readonly budgetReservationAttempts: number
  /** Reservations the store kept. Always zero; the class holds no map. */
  readonly retainedReservations: number
  /** Sink calls that were refused by a throwing sink. */
  readonly refusedCalls: number
}

/** A mutable counter block. The only mutable object a dry run is allowed to own. */
export interface SimulationSinkTally {
  eventAppends: number
  networkCalls: number
  processLaunches: number
  filesystemWrites: number
  notificationsEmitted: number
  budgetReservationAttempts: number
  retainedReservations: number
  refusedCalls: number
}

/** A zeroed tally. */
export function emptySinkTally(): SimulationSinkTally {
  return {
    eventAppends: 0,
    networkCalls: 0,
    processLaunches: 0,
    filesystemWrites: 0,
    notificationsEmitted: 0,
    budgetReservationAttempts: 0,
    retainedReservations: 0,
    refusedCalls: 0,
  }
}

/** A frozen read of a tally, which is what a test asserts on. */
export function readSinkCounters(tally: SimulationSinkTally): SimulationSinkCounters {
  return Object.freeze({ ...tally })
}

/**
 * Every counter, and the assertion a test wants to make about it.
 *
 * A caller asking "did the dry run do anything?" should not have to remember the
 * member names, and a new sink added later should not be able to join this module
 * without appearing here. `reservationsRetained` is separated from the rest
 * deliberately: it is the one that must be zero for a plan to be a dry run, while
 * `budgetReservationAttempts` is expected to be non-zero.
 */
export function assertNoRetainedSideEffects(counters: SimulationSinkCounters): readonly string[] {
  const findings: string[] = []
  if (counters.eventAppends > 0) findings.push(`eventAppends=${counters.eventAppends}`)
  if (counters.networkCalls > 0) findings.push(`networkCalls=${counters.networkCalls}`)
  if (counters.processLaunches > 0) findings.push(`processLaunches=${counters.processLaunches}`)
  if (counters.filesystemWrites > 0) findings.push(`filesystemWrites=${counters.filesystemWrites}`)
  if (counters.notificationsEmitted > 0) findings.push(`notificationsEmitted=${counters.notificationsEmitted}`)
  if (counters.retainedReservations > 0) findings.push(`retainedReservations=${counters.retainedReservations}`)
  return findings
}

// ===========================================================================
// The throwing sinks
// ===========================================================================

/**
 * The event log.
 *
 * Every member throws, including the read members. A dry run has no event log to
 * read: the events a run would append are exactly the thing being planned, and a
 * simulator that read them would be reading the future.
 */
export interface SimulationEventSink {
  append(event: unknown): never
  readSince(cursor: unknown): never
  close(): never
}

/** The network: a dispatch, a heartbeat, a remote command, a lease renewal. */
export interface SimulationNetworkSink {
  send(target: string, payload: unknown): never
  connect(endpoint: string): never
  fetch(url: string): never
}

/** The process launcher: a runtime, a terminal, a command adapter. */
export interface SimulationProcessSink {
  launch(command: string, args: readonly string[]): never
  spawn(command: string): never
  terminate(pid: string): never
}

/** The filesystem: the event store's files, a job's workspace, a receipt. */
export interface SimulationFilesystemSink {
  writeFile(path: string, contents: string): never
  appendFile(path: string, contents: string): never
  createDirectory(path: string): never
  unlink(path: string): never
}

/** The notifier: ADR 0007 section 17's advisory bus. */
export interface SimulationNotifierSink {
  emit(payload: unknown): never
  acknowledge(id: string): never
  quiet(category: string): never
}

/** All five, as one block, so a caller cannot wire four of them. */
export interface SimulationCommandSinks {
  readonly events: SimulationEventSink
  readonly network: SimulationNetworkSink
  readonly process: SimulationProcessSink
  readonly filesystem: SimulationFilesystemSink
  readonly notifier: SimulationNotifierSink
}

/**
 * Builds the five fail-closed sinks, all sharing one tally.
 *
 * Every method increments `refusedCalls` and then throws, so a caller that
 * catches `SimulationSideEffectError` can still read the count. The increment is
 * the ONLY side effect any method in this function performs, and it is on an
 * in-memory object the caller supplied — which is what makes "zero side effects"
 * assertable while still being able to assert that a sink was refused.
 */
export function createFailClosedSinks(tally: SimulationSinkTally = emptySinkTally()): SimulationCommandSinks {
  const refuse = (sink: SimulationSinkName, call: string, detail: string): never => {
    tally.refusedCalls += 1
    return refuseSink(sink, call, detail)
  }
  return {
    events: {
      append: (event: unknown) =>
        refuse("event_log", "append", `An event of type '${describeUnserialisable(event)}' would have been appended to the run's event log.`),
      readSince: (cursor: unknown) =>
        refuse("event_log", "readSince", `A read from cursor '${describeUnserialisable(cursor)}' would have read an event log a dry run does not have.`),
      close: () => refuse("event_log", "close", "Closing an event store is a write."),
    },
    network: {
      send: (target: string, payload: unknown) =>
        refuse("network", "send", `A message to '${target}' carrying ${describeUnserialisable(payload)} would have left this machine.`),
      connect: (endpoint: string) => refuse("network", "connect", `Connecting to '${endpoint}' would have opened a connection.`),
      fetch: (url: string) => refuse("network", "fetch", `Fetching '${url}' would have performed a request.`),
    },
    process: {
      launch: (command: string, args: readonly string[]) =>
        refuse("process", "launch", `Launching '${command}' with ${args.length} argument(s) would have started a process.`),
      spawn: (command: string) => refuse("process", "spawn", `Spawning '${command}' would have started a process.`),
      terminate: (pid: string) => refuse("process", "terminate", `Terminating '${pid}' would have signalled a process.`),
    },
    filesystem: {
      writeFile: (path: string, contents: string) =>
        refuse("filesystem", "writeFile", `Writing ${contents.length} character(s) to '${path}' would have touched the disk.`),
      appendFile: (path: string, contents: string) =>
        refuse("filesystem", "appendFile", `Appending ${contents.length} character(s) to '${path}' would have touched the disk.`),
      createDirectory: (path: string) => refuse("filesystem", "createDirectory", `Creating '${path}' would have touched the disk.`),
      unlink: (path: string) => refuse("filesystem", "unlink", `Unlinking '${path}' would have touched the disk.`),
    },
    notifier: {
      emit: (payload: unknown) => refuse("notifier", "emit", `A notification carrying ${describeUnserialisable(payload)} would have been delivered.`),
      acknowledge: (id: string) => refuse("notifier", "acknowledge", `Acknowledging '${id}' would have written to the inbox.`),
      quiet: (category: string) => refuse("notifier", "quiet", `Quieting category '${category}' would have written to the quiet list.`),
    },
  }
}

/**
 * Describes a rejected payload by SHAPE, never by content.
 *
 * A sink's refusal message is still a string a plan could be made to print, so it
 * names the kind of the thing and its size rather than the thing. The refusal
 * exists to be thrown into a test failure; if it echoed a payload, a test asserting
 * the no-secret property would be printing the secret it was checking for.
 */
function describeUnserialisable(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return "no value"
  if (Array.isArray(value)) return `an array of ${value.length}`
  switch (typeof value) {
    case "string":
      return `a string of ${value.length} character(s)`
    case "number":
    case "boolean":
      return `a ${typeof value}`
    case "object": {
      const size = Object.keys(value as Record<string, unknown>).length
      return `an object of ${size} member(s)`
    }
    default:
      return `a ${typeof value}`
  }
}

// ===========================================================================
// The budget store probe
// ===========================================================================

/**
 * The budget gate's store, which cannot reserve.
 *
 * ## Why it is a counter and not a throw
 *
 * Five of the six sinks throw. This one counts, because ADR 0007 section 13.2 makes
 * the reservation the DEFINITION of eligibility rather than a check before one:
 *
 * > A dispatch is eligible to launch if and only if it holds a `reservationId`
 * > whose reservation is in state `held`.
 *
 * A dry run that refused to enter the gate would report no reservation and no
 * saturation for any dispatch, and the difference between "would be admitted" and
 * "would be refused: concurrency 2 is full" is one of the answers a plan exists to
 * give. So the gate is entered, the ledger's own compare-and-set runs, the
 * ledger's own `decide` callback produces the admission verdict, and the verdict is
 * reported.
 *
 * ## Why it cannot reserve
 *
 * Because it holds no state. There is no `Map` of reservations, no
 * `reservationIdByDispatch` index, and no `heldUnits` total anywhere in this class.
 * `reserveInTransaction` runs `decide(0)`, and if the decision admits, it BUILDS the
 * `BudgetReservation` the ledger asked for, validates it through
 * `budgetReservationSchema`, returns it, and drops it. `read` and
 * `reservationForDispatch` consult the absence of a map, which is why they are
 * `null`-returning constants rather than lookups.
 *
 * The consequence is stronger than a cleared map and is the property the
 * acceptance test leans on: **after any dry run, every dispatch is still
 * ineligible**, because eligibility is defined as holding a held reservation and
 * this store holds none. A store that reserved and was then reset would have made
 * capacity momentarily real; this one makes the write unrepresentable.
 *
 * ## Why `transition` throws
 *
 * A dry run has no reservation to move. A probe that answered `transition` would be
 * a reservation store with a tombstone table, which is a store.
 */
export interface BudgetStoreProbe extends BudgetLedgerStore {
  reservationForDispatch(dispatchId: string): BudgetReservation | null
  heldUnitsFor(projectId: string, scope: BudgetScope): number
  /** A frozen read of this probe's counters. */
  readonly counters: {
    readonly attempts: number
    readonly admitted: number
    readonly refused: number
    readonly retained: number
    readonly transitionAttempts: number
  }
}

export interface BudgetStoreProbeOptions {
  readonly tally: SimulationSinkTally
}

/**
 * Builds the probe.
 *
 * The admission verdict is the ledger's, not this module's: `decide` is the
 * callback `BudgetLedger.reserve` hands down, and it is the code that compares
 * `held + units` against the ceiling. This module does not compare anything, does
 * not know what a ceiling is, and cannot admit or refuse on its own account — if
 * `decide` says no, this returns `decide`'s refusal verbatim.
 */
export function createBudgetLedgerProbe(options: BudgetStoreProbeOptions): BudgetStoreProbe {
  const { tally } = options
  let attempts = 0
  let admitted = 0
  let refused = 0
  let transitionAttempts = 0

  return {
    /**
     * `null`, always.
     *
     * The literal, not a lookup: there is nothing to look up in. `BudgetLedger`'s
     * constructor requires this method to exist (eligibility is defined as holding a
     * reservation, so the ledger must be able to find one), and a `null` answer is
     * the honest one for a store that has never held one.
     */
    reservationForDispatch: () => null,
    /** `0`, always, for the same reason. */
    heldUnitsFor: () => 0,
    /** `null`, always: a reservation this probe returned was never retained. */
    read: () => null,
    /** Empty, always. */
    list: () => [],
    /** Empty, always. */
    listHeld: () => [],

    reserveInTransaction(
      draft: ReservationDraft,
      ceiling: number,
      decide: (held: number) => ReservationAdmission,
    ): BudgetResult<BudgetReservation> {
      attempts += 1
      tally.budgetReservationAttempts += 1
      // `0` held, always, and that is the whole point: the ledger's compare-and-set
      // is asked what it would decide against an EMPTY scope, which is exactly the
      // state a dry run leaves the ledger in.
      const verdict = decide(0)
      if (!verdict.admitted) {
        refused += 1
        return { ok: false, refusal: verdict.refusal }
      }
      admitted += 1
      const reservation = budgetReservationSchema.safeParse({
        reservationId: draft.reservationId,
        projectId: draft.projectId,
        runId: draft.runId,
        taskId: draft.taskId,
        dispatchId: draft.dispatchId,
        scope: draft.scope,
        units: draft.units,
        // The ONLY state that makes a dispatch eligible, because the ledger would
        // have written this one. Anything else would be a reservation nobody could
        // launch on.
        state: "held" as const,
        leaseExpiresAt: draft.leaseExpiresAt,
        createdAt: draft.now,
        updatedAt: draft.now,
      })
      if (!reservation.success) {
        // Unreachable for a draft `BudgetLedger.reserve` built from a parsed
        // request. Thrown rather than coerced: this store returns the shape the
        // ledger would have written, and a coerced one would be a reservation the
        // ledger would have refused to write.
        return budgetRefuse(
          "budget.request_invalid",
          `The reservation this probe would have written does not satisfy budgetReservationSchema: ${reservation.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ")}`,
          { scope: draft.scope, reservationId: draft.reservationId },
        )
      }
      // Dropped on the floor. `tally.retainedReservations` is deliberately NOT
      // incremented: it counts what was KEPT, and this is not kept.
      return { ok: true, value: reservation.data }
    },

    transition(_reservationId: ReservationId, to: ReservationTransition, _now: string): ReservationTransitionResult {
      transitionAttempts += 1
      throw new SimulationSideEffectError(
        "budget_ledger",
        "transition",
        `A reservation would have moved to '${to}'. This store retains no reservation, so there is none to move: a probe that answered 'transition' would be a reservation store with a tombstone table, which is a store.`,
      )
    },

    get counters(): {
      readonly attempts: number
      readonly admitted: number
      readonly refused: number
      readonly retained: number
      readonly transitionAttempts: number
    } {
      return Object.freeze({ attempts, admitted, refused, retained: 0, transitionAttempts })
    },
  }
}

/** `SimulationPorts.budgetStore` accepts a probe. Named, so the port's type is readable. */
export function isBudgetStoreProbe(value: unknown): value is BudgetStoreProbe {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as BudgetStoreProbe).reserveInTransaction === "function" &&
    typeof (value as BudgetStoreProbe).reservationForDispatch === "function"
  )
}

export type { BudgetRefusal, ReservationState, BudgetScope }
