/**
 * M4.9 — the deterministic transport proxy.
 *
 * This is the only place a fault is applied. It sits between two real nodes and
 * moves wire records; it never opens a store, never calls a decision function,
 * and never tells a node what its answer should have been. Everything a fault
 * "does" is therefore something a real network could do to a real record.
 *
 * ### Determinism
 *
 * Three rules, and each closes a hole the previous two leave:
 *
 *   1. **No wall clock and no timer.** Every instant comes from the injected
 *      {@link FaultClock}. "Delivered 400ms late" is arithmetic, not a `sleep`.
 *   2. **No randomness.** A duplicate's copies are a count; a reorder's
 *      inversion is a rule about which transmission is due first. There is no
 *      coin to flip, so a run is reproducible on a machine that is not this one.
 *   3. **A total order.** Pending deliveries are ordered by
 *      `(dueAtMs, sequence)`. Two transmissions due at the same virtual instant
 *      are delivered in the order they were sent, which is the only ordering a
 *      reader can check by eye.
 *
 * ### Why a dropped record rejects the sender
 *
 * A drop rejects `send` with a `transient_transport` `ContractError` rather than
 * hanging. That is not a convenience: the outbox deliverer decides between
 * "requeue and retry" and "give up" on whether `send` threw, and a proxy that
 * never settled would turn every drop into a hang that a test timeout reports as
 * a logic failure. The refusal is `retryable: true` because the fault being
 * modelled is a lost packet, which is the one delivery failure a mesh is built to
 * retry.
 *
 * ### Why a duplicate is re-signed
 *
 * A retransmission is a NEW request, not a replayed one: the sender's HTTP stack
 * signs again, with a fresh nonce, and the receiver's replay guard is right to
 * refuse the byte-identical copy. So the sender hands the proxy a `resign`
 * factory and each copy after the first is signed with it. Reusing copy one's
 * signature would exercise the replay guard instead of the inbox's
 * `commandId`/`eventId` dedupe, and the plan's convergence requirement is about
 * the latter.
 */
import { createContractError, type ContractError } from "../../orchestration/errors.js"
import type { NodeId } from "../../orchestration/identifiers.js"
import type { MeshRequestSignature } from "../identity/index.js"
import { readRecordType, type MeshRecordType } from "../protocol/registry.js"
import type {
  DeliveryRecord,
  FaultClock,
  FaultLink,
  FaultMatch,
  FaultScript,
  InboundHandler,
  InboundRequest,
  TransmissionFault,
  TransmissionRecord,
} from "./types.js"

/** Every fault the proxy itself can report. All of them are transport failures. */
export type ProxyFault = "dropped" | "partitioned" | "node_down" | "unknown_destination" | "unnamed_record"

export function proxyFaultError(fault: ProxyFault, detail: string): ContractError {
  const message =
    fault === "dropped"
      ? `The record was lost in transit and never arrived. ${detail}`
      : fault === "partitioned"
        ? `The link is cut, so the record could not leave this node. ${detail}`
        : fault === "node_down"
          ? `The destination node's process is down, so nothing accepted the record. ${detail}`
          : fault === "unnamed_record"
            ? `The record names no readable recordType, so it is refused at the transport rather than delivered. ${detail}`
            : `The proxy has no endpoint registered for this destination. ${detail}`
  return createContractError("transient_transport", `fault.${fault}`, message, true)
}

/** A rule plus the counter that makes `after`/`times` mean a position. */
interface ArmedRule {
  readonly fault: TransmissionFault
  readonly match: FaultMatch
  seen: number
}

/**
 * A transmission as the proxy is still building it.
 *
 * The public {@link TransmissionRecord} publishes `deliveries` as a
 * `readonly DeliveryRecord[]`, which is the right contract for a reader: nothing
 * outside the proxy may add or remove a delivery. But the proxy is the ONLY thing
 * that can know when a copy landed, so internally the list has to be appended to.
 * Splitting the two is what lets `timeline()` hand out a record a scenario cannot
 * rewrite while `drain()` still records what it did. `Omit` rather than a
 * hand-restated interface so a new field on `TransmissionRecord` cannot be
 * forgotten here.
 */
type LiveTransmission = Omit<TransmissionRecord, "deliveries"> & { readonly deliveries: DeliveryRecord[] }

/** One scheduled copy of one transmission. */
interface PendingCopy {
  readonly sequence: number
  readonly copy: number
  readonly request: InboundRequest
}

export interface ProxySendInput {
  readonly from: NodeId
  readonly to: NodeId
  readonly record: unknown
  /** Copy one's signature. Bound to `method`, `path` and the body digest. */
  readonly signature: MeshRequestSignature
  /** A fresh signature for each retransmitted copy. See the module note. */
  readonly resign: () => MeshRequestSignature
  readonly method: string
  readonly path: string
}

/**
 * The proxy.
 *
 * A registered endpoint is an {@link InboundHandler}: a node hands over a
 * function and the proxy holds no reference to any store behind it. That is what
 * makes the transport-seam claim checkable rather than aspirational — there is
 * nothing else here the proxy could reach for.
 */
export class MeshFaultProxy {
  readonly #clock: FaultClock
  readonly #endpoints = new Map<NodeId, InboundHandler>()
  readonly #partitions = new Set<string>()
  readonly #down = new Set<string>()
  readonly #transmissions: LiveTransmission[] = []
  readonly #responses = new Map<number, unknown>()
  #armed: ArmedRule[] = []
  #pending: PendingCopy[] = []
  #sequence = 0

  constructor(clock: FaultClock, script: FaultScript = []) {
    this.#clock = clock
    this.arm(script)
  }

  /**
   * Replaces the scripted fault log.
   *
   * Wholesale rather than additive because every rule carries a match counter,
   * and a counter that survived a script change would silently shift which
   * transmission a later rule fires on.
   */
  arm(script: FaultScript): void {
    this.#armed = script.map((fault) => ({ fault, match: fault.match ?? {}, seen: 0 }))
  }

  register(nodeId: NodeId, handler: InboundHandler): void {
    this.#endpoints.set(nodeId, handler)
  }

  /** A node's process died. Sends to it fail until it is brought back. */
  takeDown(nodeId: NodeId): void {
    this.#down.add(nodeId)
  }

  bringUp(nodeId: NodeId): void {
    this.#down.delete(nodeId)
  }

  isDown(nodeId: NodeId): boolean {
    return this.#down.has(nodeId)
  }

  /** Severs one directed link, or every link when `link` is omitted. */
  partition(link?: FaultLink): void {
    if (link === undefined) {
      for (const from of this.#endpoints.keys()) {
        for (const to of this.#endpoints.keys()) {
          if (from !== to) this.#partitions.add(key(from, to))
        }
      }
      return
    }
    this.#partitions.add(key(link.from, link.to))
  }

  /** Restores one directed link, or every link when `link` is omitted. */
  heal(link?: FaultLink): void {
    if (link === undefined) {
      this.#partitions.clear()
      return
    }
    this.#partitions.delete(key(link.from, link.to))
  }

  isPartitioned(link: FaultLink): boolean {
    return this.#partitions.has(key(link.from, link.to))
  }

  /**
   * Offers one record to one node.
   *
   * Resolves with whatever the node answered. Every fault the proxy applied
   * rejects with a `ContractError`, because a rejection is the only thing a
   * sender's retry policy can act on and a silent non-resolution is not.
   */
  async send(input: ProxySendInput): Promise<unknown> {
    const recordType = readRecordType(input.record)
    if (recordType === null) {
      throw proxyFaultError(
        "unnamed_record",
        `The proxy received ${describe(input.record)}, which names no family this build knows. Refusing at the transport keeps "a proxy forwarded something unreadable" from being reachable at all.`,
      )
    }

    const sequence = (this.#sequence += 1)
    const fault = this.#select(input.from, input.to, recordType)
    const now = this.#clock.now()
    const copies = fault?.kind === "duplicate" ? Math.max(2, fault.times ?? 2) : 1
    const dueAtMs = fault !== undefined && (fault.kind === "delay" || fault.kind === "reorder") ? now + fault.ms : now
    const partitionActive = this.isPartitioned({ from: input.from, to: input.to })

    const deliveries: DeliveryRecord[] = []
    const transmission: LiveTransmission = {
      sequence,
      from: input.from,
      to: input.to,
      recordType,
      sentAtMs: now,
      dueAtMs,
      deliveries,
      fault: fault?.kind ?? "none",
      partitionActive,
    }
    this.#transmissions.push(transmission)

    const link = { from: input.from, to: input.to }
    if (partitionActive) {
      deliveries.push({ copy: 1, atMs: now, outcome: "partitioned" })
      throw proxyFaultError(
        "partitioned",
        `The link ${link.from} -> ${link.to} is cut, so ${recordType} never left ${input.from}. The sender learns nothing it could not learn by trying again, and the record stays the sender's to retry.`,
      )
    }
    if (this.isDown(input.to)) {
      deliveries.push({ copy: 1, atMs: now, outcome: "node_down" })
      throw proxyFaultError(
        "node_down",
        `Node ${input.to} is down, so ${recordType} was never delivered. Only a restart makes it deliverable; retrying sooner cannot help.`,
      )
    }
    if (fault?.kind === "drop") {
      deliveries.push({ copy: 1, atMs: now, outcome: "dropped" })
      throw proxyFaultError(
        "dropped",
        `${recordType} from ${input.from} was dropped on the wire. The receiver never saw it, which at the sender is indistinguishable from a delivery whose acknowledgement was lost — which is why at-least-once delivery is the only safe answer.`,
      )
    }
    const handler = this.#endpoints.get(input.to)
    if (handler === undefined) {
      throw proxyFaultError("unknown_destination", `No endpoint is registered for node ${input.to}.`)
    }

    for (let copy = 1; copy <= copies; copy += 1) {
      this.#pending.push({
        sequence,
        copy,
        request: {
          record: input.record,
          signature: copy === 1 ? input.signature : input.resign(),
          method: input.method,
          path: input.path,
        },
      })
    }
    await this.drain()

    const first = deliveries[0]
    if (first === undefined || first.outcome !== "delivered") {
      throw proxyFaultError(
        "dropped",
        `${recordType} was scheduled but never reached ${input.to}; see the fault timeline for which copy failed and why.`,
      )
    }
    return this.#responses.get(sequence)
  }

  /**
   * Delivers everything that is DUE.
   *
   * Loops rather than iterating once, because a delivery can itself send: an
   * acknowledgement is a record the proxy moves too, and stopping after one pass
   * would make the observed timeline depend on how many turns a scenario happened
   * to await.
   *
   * A destination that THROWS is recorded as `dropped` rather than propagated.
   * The throw is a node's own refusal — a gate that refused a stale command, an
   * inbox that rejected an unparseable record — and re-raising it from inside the
   * delivery loop would mean one refusing peer masks every record queued behind
   * it. The refusal itself travels back as the response; only a delivery that
   * never produced one is a drop.
   */
  async drain(): Promise<void> {
    for (let guard = 0; guard < 2_000; guard += 1) {
      const index = this.#nextDue()
      if (index === undefined) return
      const entry = this.#pending[index]!
      this.#pending.splice(index, 1)
      const transmission = this.#transmissions.find((candidate) => candidate.sequence === entry.sequence)
      /* c8 ignore next 3 -- a pending copy always has its transmission */
      if (transmission === undefined) continue
      const now = Math.max(this.#clock.now(), transmission.dueAtMs)

      if (transmission.partitionActive) {
        transmission.deliveries.push({ copy: entry.copy, atMs: now, outcome: "partitioned" })
        continue
      }
      const handler = this.#endpoints.get(transmission.to)
      if (handler === undefined || this.isDown(transmission.to)) {
        transmission.deliveries.push({ copy: entry.copy, atMs: now, outcome: "node_down" })
        continue
      }
      try {
        const response = await handler(entry.request)
        if (entry.copy === 1) this.#responses.set(transmission.sequence, response)
        transmission.deliveries.push({ copy: entry.copy, atMs: now, outcome: "delivered" })
      } catch {
        transmission.deliveries.push({ copy: entry.copy, atMs: now, outcome: "dropped" })
      }
    }
    throw new Error(
      "the fault proxy exceeded its delivery bound, which means a scenario is enqueueing records faster than the queue empties",
    )
  }

  /** Moves the injected clock forward and delivers everything that becomes due. */
  async advance(ms: number): Promise<void> {
    this.#clock.advance(ms)
    await this.drain()
  }

  /** How many copies are still undelivered. A count that never falls is a stuck queue. */
  get pending(): number {
    return this.#pending.length
  }

  /** The observed fault timeline, in the order the proxy was asked to move records. */
  timeline(): readonly TransmissionRecord[] {
    return this.#transmissions
  }

  /** The response a delivered transmission produced, for a scenario asserting on it. */
  responseOf(sequence: number): unknown {
    return this.#responses.get(sequence)
  }

  /**
   * The first rule, in script order, that fires at this transmission.
   *
   * Counters advance for every rule whose selectors match, whether or not it is
   * the one that fires. That is what makes `after: 1` mean "the second matching
   * transmission" rather than "the second transmission a rule of this shape
   * happened to be consulted for", which would depend on the rule's position in
   * the script.
   */
  #select(from: NodeId, to: NodeId, recordType: MeshRecordType): TransmissionFault | undefined {
    let chosen: TransmissionFault | undefined
    for (const rule of this.#armed) {
      if (!matches(rule.match, from, to, recordType)) continue
      rule.seen += 1
      const after = rule.match.after ?? 0
      const times = rule.match.times ?? 1
      if (chosen === undefined && rule.seen > after && rule.seen <= after + times) {
        chosen = rule.fault
      }
    }
    return chosen
  }

  #nextDue(): number | undefined {
    let best: number | undefined
    for (let index = 0; index < this.#pending.length; index += 1) {
      const candidate = this.#pending[index]!
      const candidateTransmission = this.#transmissions[candidate.sequence - 1]
      /* c8 ignore next -- pending copies are only pushed for a live transmission */
      if (candidateTransmission === undefined) continue
      if (candidateTransmission.dueAtMs > this.#clock.now()) continue
      if (best === undefined) {
        best = index
        continue
      }
      const incumbent = this.#pending[best]!
      const incumbentTransmission = this.#transmissions[incumbent.sequence - 1]
      /* c8 ignore next */
      if (incumbentTransmission === undefined) continue
      if (
        candidateTransmission.dueAtMs < incumbentTransmission.dueAtMs ||
        (candidateTransmission.dueAtMs === incumbentTransmission.dueAtMs &&
          candidateTransmission.sequence < incumbentTransmission.sequence)
      ) {
        best = index
      }
    }
    return best
  }
}

function matches(match: FaultMatch, from: NodeId, to: NodeId, recordType: MeshRecordType): boolean {
  if (match.from !== undefined && match.from !== from) return false
  if (match.to !== undefined && match.to !== to) return false
  if (match.recordType !== undefined && match.recordType !== recordType) return false
  return true
}

function key(from: NodeId, to: NodeId): string {
  return `${from}>${to}`
}

function describe(value: unknown): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value)
  return JSON.stringify((value as { recordType?: unknown }).recordType ?? null)
}
