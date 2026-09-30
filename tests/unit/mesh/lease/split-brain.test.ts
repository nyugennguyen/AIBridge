import { describe, expect, it } from "vitest"
import { MeshControllerLease, createUnreconciledNodeSource } from "../../../../src/mesh/lease/lease.js"
import { MeshCommandEpochGate } from "../../../../src/mesh/lease/command-gate.js"
import { InMemoryControllerLeaseStore } from "../../../../src/mesh/lease/memory-lease-store.js"
import type { ControllerLeaseStore } from "../../../../src/mesh/lease/types.js"
import type { LeaseRecord, LeaseScope } from "../../../../src/mesh/lease/schemas.js"
import type { RecordedCommandStateResolver } from "../../../../src/mesh/lease/types.js"
import {
  CONTROLLER_A,
  CONTROLLER_B,
  EPOCH_1,
  EPOCH_2,
  LEASE_1,
  LEASE_2,
  TestClock,
  WORKER_1,
  WORKER_2,
  WORKER_3,
  aRecordedStateResolver,
  claimEnvelope,
  commandEnvelope,
  iso,
  proposePayload,
  renewEnvelope,
  scopeFor,
  takeoverEnvelope,
} from "./fixtures.js"

/**
 * The split-brain model test. RELEASE-BLOCKING.
 *
 * The plan's stop condition is "stop release if any partition test permits two
 * controllers to create new work for the same run", and the sequence diagrams
 * name the test that discharges it: "under every partition in the matrix, at most
 * one controller may create new work for a given run".
 *
 * ── What is modelled ────────────────────────────────────────────────────────
 *
 * Two controllers and three workers, each with its OWN lease store — because they
 * are separate machines and a shared store would assume away the entire problem.
 * Reachability is a set of directed controller→node links, and the matrix is
 * EVERY subset of them: 2⁸ = 256 configurations, enumerated rather than sampled.
 * Directed rather than undirected because the diagrams' cut is bidirectional but
 * a real Tailscale path can fail one way, and a model that only knew symmetric
 * partitions would not cover the half-healed case.
 *
 * The script is fixed and every step is a NUMBER of milliseconds, so a
 * configuration is reproducible:
 *
 *   t=0s   A claims the run at epoch 1, broadcast to every node A can reach.
 *   t=1s   A issues `dispatch.propose` at epoch 1 — creating work.
 *   t=20s  A renews, but ONLY if it can reach at least one worker. That is the
 *          plan's partition diagram: "lease renewal FAILS" when the controller is
 *          cut off, and modelling it as a free parameter would have hidden the
 *          fact that renewal is a network act.
 *   t=40s  B attempts a takeover to epoch 2, naming the predecessor B HOLDS. B
 *          has only heard of this run through a link, so a controller that never
 *          received A's claim cannot name the right fence — and that is not a rule
 *          imposed here, it is what falls out.
 *   t=41s  B issues `dispatch.propose` at epoch 2.
 *   t=42s  A issues `dispatch.propose` at epoch 1, still believing it is the
 *          controller wherever it is still partitioned away from B.
 *
 * ── What is asserted, and what is NOT ───────────────────────────────────────
 *
 * The strong, unconditional property is PER WORKER: at no point, under any of the
 * 256 configurations, does one worker create work for two different controllers,
 * or at two different epochs. That is the property the epoch actually delivers,
 * and it is what makes the mesh converge.
 *
 * The RUN-level property is weaker than "at most one controller, ever", and the
 * test says so rather than pretending otherwise. Under a partition, B cannot
 * reach A and A cannot reach B, and a controller that cannot be reached cannot be
 * fenced. The protocol's answer — §4.7 invariant 4 and the plan's own words — is
 * that a takeover is refused unless the user has been shown the unreconciled
 * nodes. So the test asserts the precise, provable statement:
 *
 *   A4  If two controllers did create work for the run, then EVERY worker where
 *       the older one still acted was one the newer controller could not reach,
 *       and therefore one the takeover was obliged to name. The ambiguity is
 *       exactly the set the operator was shown, and it is recorded.
 *   A5  Remove that acknowledgement and the ambiguity disappears: in all 256
 *       configurations with an empty acknowledgement, at most one controller
 *       creates work.
 *
 * A4 and A5 together are the release-blocking claim: the system does not merely
 * fail to split-brain silently, it splits-brain only where a human was shown the
 * exact nodes and accepted them, and taking that acceptance away removes the
 * window entirely.
 *
 * ── What this test does NOT cover ───────────────────────────────────────────
 *
 *   - Message duplication, reordering and delay. There is one delivery per link
 *     per step; idempotent redelivery is M4.5's inbox and M4.9's fault harness.
 *   - A worker that is itself a controller, or a mesh with three controllers. The
 *     epoch argument is pairwise and the matrix is the 2-controller instance of
 *     it; adding a third controller composes pairwise, and M4.9 exercises the
 *     three-node case with real processes.
 *   - Clock skew between nodes. Every node reads the SAME injected clock, so a
 *     node whose clock runs slow cannot be modelled. This does not weaken the
 *     epoch fence — the epoch comparison uses no clock at all — but it does mean
 *     the test says nothing about how long a stale controller keeps believing it
 *     is in charge.
 *   - Anything M4.5 persists. The gate answers; a "created work" here means a
 *     command was ADMITTED, not that a session exists.
 */

/** Every link in the mesh. The matrix is every subset of this list. */
const LINKS = [
  "A>B",
  "B>A",
  "A>W1",
  "A>W2",
  "A>W3",
  "B>W1",
  "B>W2",
  "B>W3",
] as const

type Link = (typeof LINKS)[number]
type NodeName = "A" | "B" | "W1" | "W2" | "W3"
type ControllerName = "A" | "B"

const WORKER_NAMES: readonly NodeName[] = ["W1", "W2", "W3"]
const CONTROLLER_NAMES: readonly ControllerName[] = ["A", "B"]
const ALL_NODES: readonly NodeName[] = [...CONTROLLER_NAMES, ...WORKER_NAMES]

const NODE_ID = {
  A: CONTROLLER_A,
  B: CONTROLLER_B,
  W1: WORKER_1,
  W2: WORKER_2,
  W3: WORKER_3,
} as const

const SCOPE: LeaseScope = scopeFor()
const LEASE_DURATION_SECONDS = 30
const LICENSING_STATES = { runState: "active", taskState: "ready" } as const

/** The instants the script visits. Every one is a number, never a wait. */
const T_CLAIM = 0
const T_FIRST_WORK = 1_000
const T_RENEW = 20_000
const T_TAKEOVER = 40_000
const T_SUCCESSOR_WORK = 41_000
const T_STALE_WORK = 42_000
const T_CONCURRENT = 43_000

interface MeshNode {
  readonly name: NodeName
  readonly lease: MeshControllerLease
  readonly store: ControllerLeaseStore
  readonly gate: MeshCommandEpochGate | null
  readonly unreconciled: ReturnType<typeof createUnreconciledNodeSource>
}

function makeNode(clock: TestClock, name: NodeName): MeshNode {
  const store = new InMemoryControllerLeaseStore()
  const unreconciled = createUnreconciledNodeSource()
  const lease = new MeshControllerLease({ store, unreconciled: unreconciled.source, now: clock.now })
  const isWorker = WORKER_NAMES.includes(name)
  // A worker holds no unreconciled set of its own: the user-inspection
  // precondition is decided where the USER is, which is the controller performing
  // the takeover. A worker's copy is populated by M4.6's reconciliation and is a
  // record of what reconciliation reported, never of a click. Modelling it as
  // empty is what makes the model honest about where the guard is enforced.
  if (!isWorker) unreconciled.set(SCOPE, unreconciledWorkersFor(name as ControllerName, new Set()))
  const gate = isWorker
    ? new MeshCommandEpochGate({
        lease,
        recordedState: aRecordedStateResolver(LICENSING_STATES) as RecordedCommandStateResolver,
        recipientNodeId: NODE_ID[name],
        now: clock.now,
      })
    : null
  return { name, lease, store, gate, unreconciled }
}

function unreconciledWorkersFor(controller: ControllerName, reachable: ReadonlySet<string>): NodeIdish[] {
  return WORKER_NAMES.filter((worker) => !reachable.has(`${controller}>${worker}`)).map((worker) => NODE_ID[worker])
}
type NodeIdish = typeof CONTROLLER_A

/** Every one of the 2⁸ configurations, in a fixed order so a failure is reproducible. */
function everyConfiguration(): { readonly mask: number; readonly links: ReadonlySet<Link>; readonly label: string }[] {
  const out: { mask: number; links: ReadonlySet<Link>; label: string }[] = []
  for (let mask = 0; mask < 1 << LINKS.length; mask += 1) {
    const links = new Set<Link>()
    for (let bit = 0; bit < LINKS.length; bit += 1) {
      if ((mask & (1 << bit)) !== 0) links.add(LINKS[bit])
    }
    out.push({ mask, links, label: [...links].sort().join(" ") || "(no links)" })
  }
  return out
}

interface WorkEntry {
  readonly controller: ControllerName
  readonly epoch: number
  /** The epoch the WORKER had stored at the instant the command was offered. */
  readonly epochInForce: number | null
  /** The clock reading at which the command was offered. */
  readonly atMs: number
  readonly commandId: string
}

interface TakeoverDelivery {
  readonly node: string
  readonly heldEpochBefore: number | null
  readonly outcome: string
  readonly reason: string | null
  readonly code: string | null
  readonly epochAfter: number | null
}

interface SimulationResult {
  /** Every command offered to every worker, in the order it was offered. */
  readonly offers: readonly (WorkEntry & { readonly worker: string; readonly admitted: boolean })[]
  /** Which controllers created work at each worker, in the order it happened. */
  readonly workByWorker: ReadonlyMap<string, WorkEntry[]>
  /** Whether B's takeover was accepted by the node that BROADCAST it. */
  readonly takeoverAccepted: boolean
  readonly takeoverRefusalCode: string | null
  /**
   * What each node B could reach said to the takeover, and whether it held a lease
   * for the run at that instant.
   *
   * Recorded separately from `takeoverAccepted` because that flag only describes
   * what happened at B, and the split-brain hole this file exists to police was
   * never at B — it was at the nodes that held NOTHING and admitted a takeover
   * anyway.
   */
  readonly takeoverBroadcasts: ReadonlyMap<string, TakeoverDelivery>
  /** The epoch each worker held for the run at the instant the takeover arrived. */
  readonly epochAtTakeoverByWorker: ReadonlyMap<string, number | null>
  /** The workers the newer controller could not reach, i.e. what it had to name. */
  readonly acknowledged: readonly string[]
  /** The epoch each worker ended up under. */
  readonly finalEpochByWorker: ReadonlyMap<string, number>
  /** Every stored epoch observed per worker, in order, to assert monotonicity. */
  readonly epochHistoryByWorker: ReadonlyMap<string, number[]>
}

async function simulate(links: ReadonlySet<Link>, acknowledgement: "complete" | "empty"): Promise<SimulationResult> {
  const clock = new TestClock(T_CLAIM)
  const nodes = Object.fromEntries(ALL_NODES.map((name) => [name, makeNode(clock, name)])) as Record<NodeName, MeshNode>
  const reachable = (from: ControllerName, to: NodeName) => links.has(`${from}>${to}` as Link)

  // Both controllers' unreconciled sets are the workers they cannot reach. Set
  // AFTER construction because reachability is a property of the configuration.
  for (const controller of CONTROLLER_NAMES) {
    nodes[controller].unreconciled.set(
      SCOPE,
      unreconciledWorkersFor(controller, new Set([...links].filter((link) => link.startsWith(`${controller}>`)))),
    )
  }

  const workByWorker = new Map<string, WorkEntry[]>()
  const offers: (WorkEntry & { worker: string; admitted: boolean })[] = []
  const epochHistoryByWorker = new Map<string, number[]>()
  const epochOf = async (worker: string): Promise<number | null> => {
    const stored = await nodes[worker as NodeName].store.activeLease(SCOPE)
    return stored.ok ? (stored.value?.epoch ?? null) : null
  }
  const recordEpoch = async (worker: string): Promise<void> => {
    const epoch = await epochOf(worker)
    if (epoch === null) return
    epochHistoryByWorker.set(worker, [...(epochHistoryByWorker.get(worker) ?? []), epoch])
  }

  const offer = async (
    controller: ControllerName,
    worker: NodeName,
    epoch: number,
    leaseId: string,
    commandId: string,
    issuedAtMs: number,
  ): Promise<void> => {
    if (!reachable(controller, worker)) return
    const node = nodes[worker]
    if (node.gate === null) return
    // The epoch the worker had stored AT THE INSTANT of the offer. Recorded so the
    // test can assert that no command was admitted against a fence the worker had
    // already superseded, which is strictly stronger than "the admitted epochs are
    // in order" and is the property the epoch gate exists to provide.
    const epochInForce = await epochOf(worker)
    const outcome = await node.gate.authorize(
      commandEnvelope({
        commandId,
        type: "dispatch.propose",
        payload: proposePayload(epoch),
        controllerNodeId: NODE_ID[controller],
        controllerEpoch: epoch,
        leaseId,
        targetNodeId: NODE_ID[worker],
        issuedAt: iso(issuedAtMs),
        // A one-second window, and deliberately short. A command may not outlive
        // the lease that minted it (spec §4.4 invariant 7), so the script has to
        // mint commands the way a controller has to: ending inside the window it
        // still holds. The original ten-second window made the t=42s and t=43s
        // steps outlive A's renewed lease, which the gate correctly refuses — and a
        // script whose controllers all mint illegal commands is no longer
        // modelling the EPOCH fence this file exists to police, it is modelling a
        // different guard and proving it by accident.
        expiresAt: iso(issuedAtMs + 1_000),
      }),
    )
    const entry: WorkEntry = { controller, epoch, epochInForce, atMs: clock.now(), commandId }
    offers.push({ ...entry, worker, admitted: outcome.admitted })
    if (outcome.admitted) {
      workByWorker.set(worker, [...(workByWorker.get(worker) ?? []), entry])
    }
    await recordEpoch(worker)
  }

  const broadcast = async (controller: ControllerName, value: unknown): Promise<void> => {
    for (const target of ALL_NODES) {
      if (target === controller) continue
      if (!reachable(controller, target)) continue
      await nodes[target].lease.applyLease(value)
      await recordEpoch(target)
    }
  }

  // --- t=0: A claims the run. ------------------------------------------------
  await broadcast("A", claimEnvelope({ leaseId: LEASE_1, controllerNodeId: NODE_ID.A, epoch: EPOCH_1 }))

  // --- t=1s: A creates work. -------------------------------------------------
  clock.set(T_FIRST_WORK)
  for (const worker of WORKER_NAMES) await offer("A", worker, EPOCH_1, LEASE_1, "cmd-A-1", T_FIRST_WORK)

  // --- t=20s: A renews, but only if it can reach a worker. -------------------
  const aReachesAWorker = WORKER_NAMES.some((worker) => reachable("A", worker))
  if (aReachesAWorker) {
    clock.set(T_RENEW)
    await broadcast(
      "A",
      renewEnvelope({
        leaseId: LEASE_1,
        controllerNodeId: NODE_ID.A,
        epoch: EPOCH_1,
        issuedAt: iso(T_RENEW),
        expiresAt: iso(T_RENEW + LEASE_DURATION_SECONDS * 1000),
        durationSeconds: LEASE_DURATION_SECONDS,
      }),
    )
  }

  // --- t=40s: B takes over, naming the predecessor B HOLDS. ------------------
  clock.set(T_TAKEOVER)
  const bHeld = await nodes.B.store.activeLease(SCOPE)
  const bLease = bHeld.ok ? bHeld.value : null
  // B names what it knows. A controller that never received A's claim holds
  // nothing, and a placeholder is all it can put in the field — which no worker
  // holding A's lease will accept. That is not a rule imposed by this file; it is
  // what the predecessor check does when a controller has not been told.
  const takeover = takeoverEnvelope({
    leaseId: LEASE_2,
    controllerNodeId: NODE_ID.B,
    epoch: EPOCH_2,
    predecessorLeaseId: bLease?.leaseId ?? "lease-unknown-to-b",
    predecessorEpoch: bLease?.epoch ?? EPOCH_1,
    takeoverReason: "operator moved control after inspecting the degraded nodes",
    acknowledgedUnreconciledNodeIds:
      acknowledgement === "complete" ? [...unreconciledWorkersFor("B", new Set([...links].filter((link) => link.startsWith("B>"))))] : [],
    issuedAt: iso(T_TAKEOVER),
    expiresAt: iso(T_TAKEOVER + LEASE_DURATION_SECONDS * 1000),
    durationSeconds: LEASE_DURATION_SECONDS,
  })

  // B's own seam evaluates the takeover first: the acknowledgement precondition is
  // enforced where the operator is sitting, so B is refused before it can even
  // offer the record to anybody.
  const bSelfTakeover = await nodes.B.lease.takeover(takeover)
  const takeoverAccepted = bSelfTakeover.outcome === "accepted"
  const takeoverRefusalCode = bSelfTakeover.outcome === "accepted" ? null : bSelfTakeover.error.code
  // Every node B can reach answers the takeover for itself, and each answer is
  // recorded with what that node held AT THAT INSTANT. The distinction the whole
  // no_lease_to_fence rule turns on is visible only in this pair: a node that held
  // A's lease refuses on the predecessor mismatch, and a node that held NOTHING
  // has to refuse too or it adopts an epoch on the strength of the sender's word.
  const takeoverBroadcasts = new Map<string, TakeoverDelivery>()
  const epochAtTakeoverByWorker = new Map<string, number | null>()
  if (takeoverAccepted) {
    for (const target of ALL_NODES) {
      if (target === "B") continue
      if (!reachable("B", target)) continue
      const before = await nodes[target].store.activeLease(SCOPE)
      const heldEpochBefore = (before.ok ? before.value : null)?.epoch ?? null
      const delivered = await nodes[target].lease.applyLease(takeover)
      const after = await nodes[target].store.activeLease(SCOPE)
      takeoverBroadcasts.set(target, {
        node: target,
        heldEpochBefore,
        outcome: delivered.outcome,
        reason: delivered.outcome === "refused" ? delivered.reason : null,
        code: delivered.outcome === "refused" ? delivered.error.code : null,
        epochAfter: (after.ok ? after.value : null)?.epoch ?? null,
      })
      if (WORKER_NAMES.includes(target)) epochAtTakeoverByWorker.set(target, heldEpochBefore)
      await recordEpoch(target)
    }
  }

  // --- t=41s: B creates work. ------------------------------------------------
  clock.set(T_SUCCESSOR_WORK)
  for (const worker of WORKER_NAMES) await offer("B", worker, EPOCH_2, LEASE_2, "cmd-B-1", T_SUCCESSOR_WORK)

  // --- t=42s: A tries again, wherever it is still partitioned from B. ---------
  clock.set(T_STALE_WORK)
  for (const worker of WORKER_NAMES) await offer("A", worker, EPOCH_1, LEASE_1, "cmd-A-2", T_STALE_WORK)

  // --- t=43s: BOTH controllers offer at the SAME instant. --------------------
  // The script so far is sequential, and a sequential script cannot express
  // "concurrently", which is what split brain actually is. This step is the
  // concurrent one: at one clock reading, each controller issues a new command at
  // the epoch it believes it holds, to every worker it can reach. Whatever the
  // partition, a worker may admit at most one of them — and the reason it may not
  // admit both is that a worker holds ONE lease at ONE epoch, and only the
  // controller at that epoch is admissible.
  clock.set(T_CONCURRENT)
  for (const worker of WORKER_NAMES) {
    await offer("A", worker, EPOCH_1, LEASE_1, "cmd-A-concurrent", T_CONCURRENT)
    await offer("B", worker, EPOCH_2, LEASE_2, "cmd-B-concurrent", T_CONCURRENT)
  }

  const finalEpochByWorker = new Map<string, number>()
  for (const worker of WORKER_NAMES) {
    const epoch = await epochOf(worker)
    if (epoch !== null) finalEpochByWorker.set(worker, epoch)
  }

  return {
    offers,
    workByWorker,
    takeoverAccepted,
    takeoverRefusalCode,
    takeoverBroadcasts,
    epochAtTakeoverByWorker,
    acknowledged: takeoverAcknowledged(takeover),
    finalEpochByWorker,
    epochHistoryByWorker,
  }
}

function takeoverAcknowledged(value: Record<string, unknown>): readonly string[] {
  const payload = value.payload as { acknowledgedUnreconciledNodeIds?: readonly string[] }
  return payload.acknowledgedUnreconciledNodeIds ?? []
}

const CONFIGURATIONS = everyConfiguration()

/**
 * Every configuration simulated once, and the result shared by every test below.
 *
 * Nine tests each enumerate all 256 configurations, and each simulation drives
 * five nodes through a nine-step script. Re-running the whole matrix inside
 * every test cost ~65 000 simulations, which pushed individual tests past
 * `bun test`'s five-second default under full-suite load — a timeout that reads
 * as a logic failure and is not one. Caching makes the cost linear: 256
 * simulations for the file, whatever the number of tests.
 *
 * Sharing is sound because `simulate` is deterministic and hermetic: it builds
 * its own `TestClock` and its own in-memory lease stores per call and never
 * reads ambient state, so a cached result is the result every caller would have
 * computed. The cache is keyed by BOTH axes the tests vary — the link set and
 * the acknowledgement mode — so the "with the acknowledgement REMOVED" test
 * cannot be served an "acknowledgement complete" result.
 */
const SIMULATION_CACHE = new Map<string, Promise<SimulationResult>>()

function simulateCached(label: string, acknowledgement: "complete" | "empty"): Promise<SimulationResult> {
  const key = `${acknowledgement}::${label}`
  const existing = SIMULATION_CACHE.get(key)
  if (existing !== undefined) return existing
  const started = simulate(linksOf(label), acknowledgement)
  SIMULATION_CACHE.set(key, started)
  return started
}

describe("M4.4 split-brain: the partition matrix, exhaustively", () => {
  it("enumerates 2^8 = 256 configurations, so nothing is sampled", () => {
    // Asserted first, and by COUNT, because a table-driven test whose table was
    // accidentally reduced to a handful of rows is the most likely way for this
    // file to become decorative — and it would still be green.
    expect(LINKS.length).toBe(8)
    expect(CONFIGURATIONS.length).toBe(256)
    expect(new Set(CONFIGURATIONS.map((configuration) => configuration.label)).size).toBe(256)
  })

  it("at every epoch a worker ever accepted, the work came from exactly ONE controller", async () => {
    // THE property, and unconditional. Stated per (worker, epoch) rather than per
    // worker, because a worker legitimately changes hands: a successful takeover
    // means A drove it at epoch 1 and B drives it at epoch 2, and that is a
    // handover, not a split brain. What must never happen is two controllers
    // working the same worker AT THE SAME EPOCH — that is two sessions for one run
    // with no fence between them.
    const violations: string[] = []
    for (const { label } of CONFIGURATIONS) {
      const result = await simulateCached(label, "complete")
      for (const [worker, entries] of result.workByWorker) {
        const byEpoch = new Map<number, Set<ControllerName>>()
        for (const entry of entries) {
          const seen = byEpoch.get(entry.epoch) ?? new Set<ControllerName>()
          seen.add(entry.controller)
          byEpoch.set(entry.epoch, seen)
        }
        for (const [epoch, controllers] of byEpoch) {
          if (controllers.size > 1) {
            violations.push(`${label}: ${worker} at epoch ${epoch} was driven by [${[...controllers].join(", ")}]`)
          }
        }
      }
    }
    expect(violations).toEqual([])
  })

  it("no worker ever admitted a command at an epoch it had already superseded", async () => {
    // Strictly stronger than "the epochs are in order", and the property the epoch
    // gate actually delivers: every admitted command carried the epoch the worker
    // was holding AT THAT INSTANT. A worker whose authority had moved to epoch 2
    // and which then ran an epoch-1 command is the exact shape of "a command
    // minted under a superseded controller was applied under its successor".
    const violations: string[] = []
    for (const { label } of CONFIGURATIONS) {
      const result = await simulateCached(label, "complete")
      for (const offer of result.offers) {
        if (!offer.admitted) continue
        if (offer.epoch !== offer.epochInForce) {
          violations.push(`${label}: ${offer.worker} admitted ${offer.commandId} at epoch ${offer.epoch} while holding ${String(offer.epochInForce)}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it("at the concurrent instant, no worker admits work from both controllers", async () => {
    // Split brain is a CONCURRENCY defect, and the earlier steps of the script
    // are sequential. This is the step that is not: at one clock reading both
    // controllers offer a fresh command at the epoch each believes it holds, and
    // at most one of the two may be admitted at any worker.
    const violations: string[] = []
    let contested = 0
    for (const { label } of CONFIGURATIONS) {
      const result = await simulateCached(label, "complete")
      const byWorker = new Map<string, typeof result.offers>()
      for (const offer of result.offers) {
        // Only the concurrent step, and only at a worker that HAS an authority:
        // two offers to an unleased run are two refusals, which is not contention.
        if (offer.atMs !== T_CONCURRENT || offer.epochInForce === null) continue
        byWorker.set(offer.worker, [...(byWorker.get(offer.worker) ?? []), offer])
      }
      for (const [worker, group] of byWorker) {
        if (new Set(group.map((offer) => offer.controller)).size < 2) continue
        contested += 1
        const admitted = group.filter((offer) => offer.admitted).map((offer) => `${offer.controller}@${offer.epoch}`)
        if (admitted.length > 1) violations.push(`${label}: ${worker} admitted [${admitted.join(", ")}] at the same instant`)
      }
    }
    expect(violations).toEqual([])
    // Non-vacuity: a worker where both controllers actually contended has to exist
    // in the matrix, or the property above is being satisfied by a script that
    // never made the controllers disagree.
    expect(contested).toBeGreaterThan(0)
  })

  it("no node's stored epoch ever decreases", async () => {
    // The same property from the storage side. A worker whose stored epoch went
    // backwards would have accepted a command against a fence it had already
    // superseded, which is what the compare-and-set exists to prevent.
    const violations: string[] = []
    for (const { label } of CONFIGURATIONS) {
      const result = await simulateCached(label, "complete")
      for (const [worker, history] of result.epochHistoryByWorker) {
        for (let index = 1; index < history.length; index += 1) {
          if (history[index] < history[index - 1]) {
            violations.push(`${label}: ${worker} went from epoch ${history[index - 1]} to ${history[index]}`)
          }
        }
      }
    }
    expect(violations).toEqual([])
  })

  it("where two controllers DID create work, every node the older one used was one the user was shown", async () => {
    // The run-level statement, in its provable form. Two controllers can only
    // coexist where the takeover could not reach the older one's workers — and
    // those workers are, by construction, the ones the takeover had to name. The
    // ambiguity is therefore exactly the set the operator was shown, not a
    // surprise the protocol discovered afterwards.
    const ambiguous: string[] = []
    let ambiguousConfigurations = 0
    for (const { label } of CONFIGURATIONS) {
      const links = linksOf(label)
      const result = await simulateCached(label, "complete")
      const controllers = new Set(
        [...result.workByWorker.values()]
          .flat()
          .filter((entry) => entry.atMs >= T_TAKEOVER)
          .map((entry) => entry.controller),
      )
      if (controllers.size < 2) continue
      ambiguousConfigurations += 1

      const bUnreachable = new Set(unreconciledWorkersFor("B", new Set([...links].filter((link) => link.startsWith("B>")))))
      for (const [worker, entries] of result.workByWorker) {
        // Only work created FROM THE TAKEOVER ONWARD counts. A's work at t=1s,
        // before anybody had any reason to supersede it, is not split brain — it
        // is the run working, and a property that flagged it would be flagging the
        // ordinary case.
        const aAfterTakeover = entries.filter((entry) => entry.controller === "A" && entry.atMs >= T_TAKEOVER)
        const bAfterTakeover = entries.filter((entry) => entry.controller === "B")
        if (aAfterTakeover.length === 0 || bAfterTakeover.length === 0) continue
        if (!bUnreachable.has(worker as never)) {
          ambiguous.push(`${label}: A still created work at ${worker} after the takeover, and B could reach ${worker} so did not have to name it`)
        }
        // And the takeover that moved B in carried that id, so the record of what
        // the user saw exists rather than being inferable only from this test.
        if (!result.acknowledged.includes(NODE_ID[worker as NodeName])) {
          ambiguous.push(`${label}: ${worker} produced work for both controllers but was not in the takeover's acknowledgement`)
        }
      }
      if (!result.takeoverAccepted) {
        ambiguous.push(`${label}: two controllers acted although the takeover was refused`)
      }
    }
    // Non-vacuity, asserted alongside: a matrix test in which the interesting
    // case never arises proves nothing about it.
    expect(ambiguousConfigurations).toBeGreaterThan(0)
    expect(ambiguous).toEqual([])
  })

  it("with the acknowledgement REMOVED, no configuration lets two controllers create work", async () => {
    // The teeth of the guard, from the other side. §4.7 invariant 4: "a takeover
    // with an empty list while unreconciled nodes exist is refused". With the
    // list emptied, the takeover never happens, and the run-level ambiguity the
    // previous test characterised disappears entirely — in all 256 configurations.
    const violations: string[] = []
    let refused = 0
    let acceptedWithoutAmbiguity = 0
    for (const { label } of CONFIGURATIONS) {
      const result = await simulateCached(label, "empty")
      if (result.takeoverAccepted) {
        acceptedWithoutAmbiguity += 1
      } else {
        refused += 1
      }
      const controllers = new Set(
        [...result.workByWorker.values()]
          .flat()
          .filter((entry) => entry.atMs >= T_TAKEOVER)
          .map((entry) => entry.controller),
      )
      if (controllers.size > 1) violations.push(`${label}: [${[...controllers].join(", ")}] both created work after the takeover instant`)
    }
    expect(violations).toEqual([])
    // The refusal has to be reachable in a real number of configurations, and the
    // acceptance has to remain reachable too — otherwise this test would be
    // satisfied by an implementation that refused every takeover ever offered.
    expect(refused).toBeGreaterThan(0)
    expect(acceptedWithoutAmbiguity).toBeGreaterThan(0)
  })

  it("a worker that holds NO lease refuses a takeover broadcast to it, rather than adopting the epoch", async () => {
    // The release-blocking half of the review finding, and the one the original
    // script could not see: every case the matrix exercised had the workers either
    // holding A's lease or unreachable from B, so the one node state that admitted
    // an arbitrary epoch — holding NOTHING — was never on the receiving end of a
    // takeover that was broadcast.
    //
    // The shape that produces it is ordinary: A is cut off from W2 while B reaches
    // both W1 (which heard A) and W2 (which did not). B's takeover is admissible at
    // W1 — it names the predecessor W1 holds — and at W2 the epoch is an unbacked
    // assertion, because W2 has never heard of any authority at all. Accepting it
    // there is what produced one controller per worker and two controllers on one
    // run: every worker had exactly one controller, and the run had two.
    const violations: string[] = []
    let cases = 0
    let unleasedDeliveries = 0
    for (const { label } of CONFIGURATIONS) {
      const links = linksOf(label)
      const result = await simulateCached(label, "complete")
      for (const delivery of result.takeoverBroadcasts.values()) {
        if (delivery.heldEpochBefore !== null) continue
        cases += 1
        if (delivery.outcome === "accepted") {
          violations.push(`${label}: ${delivery.node} held no lease and accepted the takeover at epoch ${String(delivery.epochAfter)}`)
          continue
        }
        // Refused, and refused for the RIGHT reason: a node that held nothing can
        // only be short of the predecessor comparison, so a refusal that reported
        // a predecessor mismatch would mean this test had built the wrong node.
        unleasedDeliveries += 1
        if (delivery.reason !== "no_lease_to_fence") {
          violations.push(`${label}: ${delivery.node} held no lease and was refused as '${delivery.reason}' rather than no_lease_to_fence`)
        }
        // And nothing was written by the refusal, which is the half that matters
        // operationally: a refusal that had already moved the epoch would be a
        // fence nobody asked for.
        if (delivery.epochAfter !== null) {
          violations.push(`${label}: ${delivery.node} held no lease, refused the takeover, and then held epoch ${delivery.epochAfter}`)
        }
      }
    }
    // Non-vacuity, and it is the whole point of the test: a partition matrix in
    // which no node ever receives a takeover while holding nothing proves that
    // nothing about the unleased case, however green the other assertions are.
    expect(cases).toBeGreaterThan(0)
    expect(unleasedDeliveries).toBe(cases)
    expect(violations).toEqual([])
  })

  it("a controller that never received the run's lease cannot fence a node that holds it", async () => {
    // Emergent, not imposed. B can only name the predecessor it HOLDS, so a
    // controller cut off from the run has nothing to fence against and its
    // takeover is refused at every node that already holds the lease.
    let checked = 0
    const violations: string[] = []
    for (const { label } of CONFIGURATIONS) {
      const links = linksOf(label)
      if (links.has("A>B")) continue
      checked += 1
      const result = await simulateCached(label, "complete")
      for (const worker of WORKER_NAMES) {
        // Only the workers that actually heard A's claim are interesting: a worker
        // that never did is UNLEASED, and B adopting an unleased run is the
        // ordinary "who drives this" question rather than a fence.
        if (!links.has(`A>${worker}` as Link)) continue
        if (!links.has(`B>${worker}` as Link)) continue
        if (result.finalEpochByWorker.get(worker) !== EPOCH_1) {
          violations.push(`${label}: ${worker} held A's lease at epoch 1 but ended at epoch ${String(result.finalEpochByWorker.get(worker))}`)
        }
      }
    }
    expect(checked).toBeGreaterThan(0)
    expect(violations).toEqual([])
  })

  it("a renewal never changes the epoch anywhere it lands", async () => {
    // Asserted over the matrix rather than once, because the renewal lands on a
    // different SUBSET of nodes in each configuration and the store's
    // "non-takeover writes may not change the epoch" rule has to hold on every
    // subset. The check is on the STORED epochs, not on the commands: a renewal
    // that changed authority would be visible in the row even on a node that was
    // never asked to do any work.
    for (const { label } of CONFIGURATIONS) {
      const result = await simulateCached(label, "complete")
      for (const [worker, history] of result.epochHistoryByWorker) {
        // Before any takeover has been accepted, every reading on this worker is
        // epoch 1 — the claim and, where it landed, the renewal.
        const beforeTakeover = result.takeoverAccepted ? [] : history
        for (const epoch of beforeTakeover) expect(epoch, `${label} / ${worker}`).toBe(EPOCH_1)
        for (let index = 1; index < history.length; index += 1) {
          expect(history[index], `${label} / ${worker}`).toBeGreaterThanOrEqual(history[index - 1])
        }
      }
    }
  })
})

/** The link set for a configuration, parsed from its stable label. */
function linksOf(label: string): ReadonlySet<Link> {
  return new Set<Link>(label === "(no links)" ? [] : (label.split(" ") as Link[]))
}

describe("M4.4 split-brain: the sequence diagram's own scenario", () => {
  it("A partitioned at epoch 4 is refused at a worker that took over to 5, and nothing is persisted", async () => {
    // Diagram §4, in the diagram's own numbers, so the model above is anchored to
    // a scenario a reader can check by eye.
    const clock = new TestClock(0)
    const worker = makeNode(clock, "W1")
    const gate = new MeshCommandEpochGate({
      lease: worker.lease,
      recordedState: aRecordedStateResolver(LICENSING_STATES) as RecordedCommandStateResolver,
      recipientNodeId: NODE_ID.W1,
      now: clock.now,
    })

    await worker.lease.claim(claimEnvelope({ leaseId: LEASE_1, controllerNodeId: NODE_ID.A, epoch: EPOCH_1 }))
    const takenOver = await worker.lease.takeover(
      takeoverEnvelope({
        leaseId: LEASE_2,
        controllerNodeId: NODE_ID.B,
        epoch: EPOCH_2,
        issuedAt: iso(T_RENEW),
        expiresAt: iso(T_RENEW + 30_000),
      }),
    )
    expect(takenOver.outcome).toBe("accepted")
    clock.set(T_RENEW + 1_000)

    const before = await storedRow(worker)
    const outcome = await gate.authorize(
      commandEnvelope({
        commandId: "cmd-from-partitioned-a",
        type: "dispatch.propose",
        payload: proposePayload(EPOCH_1),
        controllerNodeId: NODE_ID.A,
        controllerEpoch: EPOCH_1,
        leaseId: LEASE_1,
        targetNodeId: NODE_ID.W1,
        issuedAt: iso(T_RENEW + 1_000),
        expiresAt: iso(T_RENEW + 20_000),
      }),
    )
    expect(outcome.admitted).toBe(false)
    if (outcome.admitted) return
    expect(outcome.error.code).toBe("epoch.stale")
    expect(outcome.error.message).toMatch(/DROPPED, not stored for later/)
    // "Nothing persisted" as an observation, not as a claim about the return value.
    expect(await storedRow(worker)).toEqual(before)
  })
})

async function storedRow(node: MeshNode): Promise<LeaseRecord | null> {
  const found = await node.store.activeLease(SCOPE)
  return found.ok ? found.value : null
}
