/**
 * M4.9 — the fault harness's own vocabulary.
 *
 * The harness is a TRANSPORT SEAM between two real mesh nodes, and everything in
 * this file exists to keep it one. Three properties are load-bearing, and each
 * one is what a fault harness gets wrong by accident:
 *
 *   1. **Every fault is a FUNCTION OF A SCRIPT AND A CLOCK.** There is no
 *      `setTimeout`, no `Date.now` and no `Math.random` anywhere below
 *      `./proxy.ts`. A fault that fires "roughly here" is a fault a reader cannot
 *      reproduce, and a fault matrix whose failing configuration depends on how
 *      fast the machine is has stopped being a matrix.
 *   2. **The proxy moves RECORDS, not state.** {@link InboundRequest} carries a
 *      wire record and a signature; the receiving node decides what it means.
 *      A proxy that reached into a node's stores to "simulate a lost write" would
 *      be testing a mutation nobody can perform in production, which is the one
 *      thing a fault harness must never become.
 *   3. **A node's DURABLE state outlives its process.** Restart closes the
 *      database handles and reopens the same files, so "the row survived" means
 *      the row survived rather than that a `Map` was never cleared.
 */
import type { NodeId } from "../../orchestration/identifiers.js"
import type { MeshRecordType } from "../protocol/registry.js"
import type { MeshRequestSignature } from "../identity/index.js"

/**
 * The injected clock every part of the harness reads.
 *
 * Declared as an interface rather than reusing one node's clock class because the
 * proxy and the two nodes must read the SAME reading: a proxy that stamped
 * deliveries from its own clock and a node that admitted records against its own
 * would disagree at exactly the boundary a delayed delivery crosses, which is the
 * boundary the delay fault exists to probe.
 */
export interface FaultClock {
  now(): number
  set(ms: number): void
  advance(ms: number): void
}

/** A clock moved by hand, never by a timer. */
export class ScriptedClock implements FaultClock {
  #ms: number

  constructor(startMs: number) {
    this.#ms = startMs
  }

  now = (): number => this.#ms

  set(ms: number): void {
    this.#ms = ms
  }

  advance(ms: number): void {
    this.#ms += ms
  }
}

/** One directed path. A partition is directional because a Tailscale path can fail one way. */
export interface FaultLink {
  readonly from: NodeId
  readonly to: NodeId
}

/**
 * How a {@link FaultScript} rule narrows the transmissions it applies to.
 *
 * `after` and `times` together are what make a script REPRODUCIBLE without being
 * trivial: `after: 2, times: 1` is "the third matching transmission", which is a
 * position in a sequence rather than a wall-clock instant. A rule that could only
 * say "at some point" would make every downstream assertion a race.
 */
export interface FaultMatch {
  readonly from?: NodeId
  readonly to?: NodeId
  readonly recordType?: MeshRecordType
  /** Matching transmissions to let through before this rule fires. Default 0. */
  readonly after?: number
  /** How many matching transmissions this rule affects. Default 1. */
  readonly times?: number
}

/**
 * The per-transmission faults.
 *
 * `reorder` is a DELAY, and that is deliberate rather than a shortcut: a
 * transmission delivered at `now + ms` is overtaken by any transmission sent in
 * the meantime and delivered immediately, so the timeline inversion is a
 * consequence of the rule rather than a separate mechanism that could disagree
 * with it. What the harness asserts is the ORDER, not the delay.
 */
export type TransmissionFault =
  | { readonly kind: "delay"; readonly ms: number; readonly match?: FaultMatch }
  /** Delivered, then delivered again. The at-least-once case the inbox dedupes. */
  | { readonly kind: "duplicate"; readonly times?: number; readonly match?: FaultMatch }
  /** Never delivered. The sender learns only that the write did not land. */
  | { readonly kind: "drop"; readonly match?: FaultMatch }
  /** A delay long enough to be overtaken. See the note above. */
  | { readonly kind: "reorder"; readonly ms: number; readonly match?: FaultMatch }

/** The whole scripted fault log, in the order the rules are consulted. */
export type FaultScript = readonly TransmissionFault[]

/** No faults at all. The control arm every fault test is compared against. */
export const NO_FAULTS: FaultScript = []

/** What actually happened to one transmission. The harness's observable. */
export interface DeliveryRecord {
  /** 1-based within this transmission; a duplicate's second copy is `2`. */
  readonly copy: number
  readonly atMs: number
  readonly outcome: "delivered" | "dropped" | "partitioned" | "node_down"
}

/** One record the proxy was asked to move, and everything that became of it. */
export interface TransmissionRecord {
  /** Monotonic across the proxy's life. The total order of the fault timeline. */
  readonly sequence: number
  readonly from: NodeId
  readonly to: NodeId
  readonly recordType: MeshRecordType
  readonly sentAtMs: number
  /** When the first copy was due. Equal to `sentAtMs` for an undelayed record. */
  readonly dueAtMs: number
  readonly deliveries: readonly DeliveryRecord[]
  /** The rule that decided this, or `"none"`. An empty rule set is observable. */
  readonly fault: TransmissionFault["kind"] | "none"
  readonly partitionActive: boolean
}

/**
 * What the receiving node is asked to do with a record.
 *
 * The signature travels WITH the record rather than being reconstructed at the
 * receiver, because the receiving node's identity provider verifies the exact
 * bytes the sender signed. A harness that re-signed at the receiver would prove
 * nothing about the wire.
 */
export interface InboundRequest {
  readonly record: unknown
  readonly signature: MeshRequestSignature
  readonly method: string
  readonly path: string
}

/** A node's transport endpoint. The ONLY thing the proxy is allowed to call. */
export type InboundHandler = (request: InboundRequest) => Promise<unknown>

/**
 * The eight `EffectBoundary` hooks, by name.
 *
 * Named here rather than derived from the interface because a harness that
 * iterated the interface would have no way to SAY which boundary it crashed at,
 * and "crash at boundary N" is only a reproducible instruction if N is a name
 * an operator can read in a transcript.
 */
export const EFFECT_BOUNDARY_HOOKS = [
  "beforeValidate",
  "afterValidate",
  "duringAppend",
  "afterCommit",
  "beforeDeliver",
  "afterRuntimeAccept",
  "duringProjectionUpdate",
  "duringTranslation",
] as const

export type EffectBoundaryHook = (typeof EFFECT_BOUNDARY_HOOKS)[number]

/** The one-to-one numbering the plan's failure matrix uses. */
export const EFFECT_BOUNDARY_NUMBER: Readonly<Record<EffectBoundaryHook, number>> = Object.freeze({
  beforeValidate: 1,
  afterValidate: 2,
  duringAppend: 3,
  afterCommit: 4,
  beforeDeliver: 5,
  afterRuntimeAccept: 6,
  duringProjectionUpdate: 7,
  duringTranslation: 8,
})
