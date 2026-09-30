import { createContractError, type ContractError } from "../../orchestration/errors.js"
import type { CommandId, DispatchId, SessionId } from "../../orchestration/identifiers.js"
import type { InboxRow } from "./types.js"

/**
 * R4, decided.
 *
 * Milestone 3 carried this forward as:
 *
 * > **R4** `launchAdmission` can never be `unknown`/`failed`, because no event
 * > records a launch-command outcome. M4.1 should either add that event type or
 * > state explicitly that an ambiguous launch is unrepresentable in projections.
 *
 * The plan's two options were "add an event type" and "state that it is
 * unrepresentable". **Neither of those is what M4.5 does, and taking either would
 * have been wrong**, because both were written when the answer to "what happened
 * to the launch" lived in the KERNEL event log — and there it still does.
 *
 * The decision this module implements instead:
 *
 * > **The launch outcome is a MESH fact, recorded durably at the worker, keyed on
 * > `commandId`, and it is NOT a kernel event.**
 *
 * ### Why the kernel event route was not taken
 *
 * `src/orchestration/schemas.ts` is inside the M0 contract digest —
 * `scripts/m0-contract-signoff.sh` hashes it, plus `types.ts` and `transitions.ts`
 * and the frozen examples and the M0 contract tests, and exits 2 with a `STALE`
 * notice if any of them moves without a recorded re-approval. Adding a
 * `launch.outcome` member to `orchestrationEventSchema` would change that digest.
 * A milestone-4 task that silently reshapes the canonical domain is the exact
 * failure the gate report calls "a passing gate that silently reshapes the
 * canonical domain is not a passing gate". The change would be defensible; taking
 * it from inside M4.5, without a re-approval, would not be.
 *
 * There is also a correctness argument that does not depend on the digest. The
 * kernel event log is the CONTROLLER's record of what it decided. The ambiguous
 * case is a fact about the WORKER: "a peer took this launch and I never heard
 * back". Recording it as a controller event would mean the controller asserting
 * something it cannot know, from a message it has not yet received. The mesh
 * already has the honest place for it, and it already has the durable row.
 *
 * ### What the ambiguity therefore IS
 *
 * `InboxEffectState` carries it. A row in `runtime_accepted` means: the peer took
 * the effect (stamped at `EffectBoundary.afterRuntimeAccept`) and no outcome was
 * recorded before the process stopped. That is a crash between "the runtime
 * accepted the launch" and "the ack was committed" — the boundary the sequence
 * diagrams name as hook 6 — and it is now a DURABLE STATE rather than an absence
 * of one. `not_started` and `result_recorded` bracket it.
 *
 * The three states are one-way. Nothing moves a row back out of
 * `runtime_accepted`, because the fact that the effect was accepted does not stop
 * being true when this process loses its memory of the outcome.
 *
 * ### How a projection reads it
 *
 * {@link deriveLaunchOutcome}. It is TOTAL over the stored states and over the
 * recorded log, and it is the only place a launch outcome is derived. It never
 * returns a fourth "unknown" because the three states plus the log already
 * determine the answer — that is what makes R4 closed rather than relabelled.
 *
 * The kernel's `ProjectionLaunchAdmission` is deliberately NOT changed. It still
 * has three members, and `unknown`/`failed` are still not among them, because
 * that type is derived from `dispatch.started` and `approval.decided` and nothing
 * else — and this module adds no source of truth to that fold. What changes is
 * that the thing the kernel type cannot express now has a durable, queryable home,
 * and `deriveLaunchOutcome` is the bridge a TUI (M4.8) or a reconciliation view
 * (M4.6) reads instead of inventing one.
 */

/** What a launch is, as the mesh layer now knows it. */
export const MESH_LAUNCH_OUTCOMES = ["not-requested", "pending", "runtime-accepted", "started", "unresolved"] as const

export type MeshLaunchOutcome = (typeof MESH_LAUNCH_OUTCOMES)[number]

/**
 * The version of the vocabulary above.
 *
 * M4-V's rule is that a record family's SHAPE is versioned, and this is a record
 * family in everything but transport: `MeshLaunchOutcome` is persisted, read by a
 * TUI (M4.8) and a reconciliation view (M4.6), and cached in operator memory
 * longer than any binary that produced it. `runtime-accepted` and `unresolved`
 * are the two members that did not exist in Milestone 3, and a peer holding a
 * stored outcome from a build that predates them must be able to tell "this build
 * has never heard of that state" from "this launch is fine".
 *
 * The version is a separate constant rather than a member of the enum because the
 * enum's members are STATE names a reader switches on, and a member that exists
 * only to be a version is a value every one of those switches would have to
 * handle.
 */
export const CURRENT_LAUNCH_OUTCOME_VERSION = 2

/** The launch-outcome versions this build can interpret. */
export const LAUNCH_OUTCOME_VERSIONS = [1, 2] as const

export type LaunchOutcomeVersion = (typeof LAUNCH_OUTCOME_VERSIONS)[number]

/**
 * Whether this build can interpret an outcome recorded at `version`.
 *
 * `unknownLaunchOutcomeVersion` is the loud half of M4-V: a stored outcome at a
 * version this build does not list is refused, never coerced to a member it
 * happens to recognise by name.
 */
export function canReadLaunchOutcomeVersion(version: number): version is LaunchOutcomeVersion {
  return (LAUNCH_OUTCOME_VERSIONS as readonly number[]).includes(version)
}

export function unknownLaunchOutcomeVersion(version: number): ContractError {
  return createContractError(
    "unsupported_capability",
    "mesh.launch_outcome_version_unsupported",
    `A launch outcome recorded at version ${version} cannot be interpreted by this build, which reads [${LAUNCH_OUTCOME_VERSIONS.join(", ")}]. The outcome is reported UNREADABLE rather than mapped onto a member this build happens to know, because a launch that reads as '${MESH_LAUNCH_OUTCOMES[0]}' here could read as anything to the build that wrote it.`,
  )
}

export interface LaunchOutcomeDetail {
  /** The vocabulary this outcome was derived under. See {@link CURRENT_LAUNCH_OUTCOME_VERSION}. */
  readonly outcomeVersion: LaunchOutcomeVersion
  readonly outcome: MeshLaunchOutcome
  readonly commandId: CommandId | null
  readonly dispatchId: DispatchId | null
  readonly sessionId: SessionId | null
  /** Set for `runtime-accepted` and `unresolved`, and null otherwise. */
  readonly error: ContractError | null
  /** One sentence naming the evidence, for an operator and for a TUI tooltip. */
  readonly evidence: string
}

/**
 * What the RECORDED log knows about a dispatch's launch.
 *
 * The only member that matters is `startedSessionId`. It is the kernel's
 * `dispatch.started`, read from the controller's log — the same fact the kernel
 * projection derives `started` from — supplied here so this module does not have
 * to read a projection, and so the two derivations can be compared against each
 * other in a test rather than one of them being an assumption about the other.
 */
export interface RecordedLaunchObservation {
  readonly dispatchId: DispatchId
  readonly startedSessionId: SessionId | null
}

/**
 * Derives a launch outcome from the durable inbox and the recorded log.
 *
 * The state machine, and each line is a case that had to be decided rather than a
 * default:
 *
 * | inbox `effectState` | recorded start | outcome |
 * | --- | --- | --- |
 * | no row | — | `not-requested` — no launch command was ever admitted here |
 * | `not_started` | no | `pending` — admitted and durable, the peer has not taken it |
 * | `not_started` | yes | `started` — the log outran the inbox stamp, which is a redelivery; the log wins |
 * | `runtime_accepted` | no | `runtime-accepted` — **the ambiguous launch, as a durable fact** |
 * | `runtime_accepted` | yes | `started` — accepted and then observed |
 * | `result_recorded` | no | `unresolved` — the effect reported, the start never recorded |
 * | `result_recorded` | yes | `started` |
 *
 * Two orderings are load-bearing.
 *
 * **`not_started` with a recorded start is `started`, not `pending`.** The log is
 * downstream evidence of something that happened; the inbox stamp is this node's
 * record of its own outbound action. A projection built across a redelivery where
 * the log is ahead must not report the work as still waiting, and "still waiting"
 * is the reading that makes an operator press retry.
 *
 * **`result_recorded` with no recorded start is `unresolved`, not `started`.** The
 * inbox row says this node ran the effect and got a result; the log says no
 * session was ever recorded. Collapsing that into `started` would invent a
 * session, and into `pending` would claim the launch has not happened when this
 * node has direct evidence that it did. `unresolved` is the honest answer and it
 * is a member of the enum precisely so nobody has to reach for a string.
 */
export function deriveLaunchOutcome(
  row: InboxRow | null,
  observation: RecordedLaunchObservation | null,
): LaunchOutcomeDetail {
  const commandId = row?.commandId ?? null
  const dispatchId = row?.dispatchId ?? observation?.dispatchId ?? null
  const sessionId = observation?.startedSessionId ?? null

  if (row === null) {
    return {
      outcomeVersion: CURRENT_LAUNCH_OUTCOME_VERSION,
      outcome: "not-requested",
      commandId: null,
      dispatchId: observation?.dispatchId ?? null,
      sessionId,
      error: null,
      evidence: "No launch command for this dispatch was admitted by this node, so no launch was attempted here.",
    }
  }

  if (sessionId !== null) {
    return {
      outcomeVersion: CURRENT_LAUNCH_OUTCOME_VERSION,
      outcome: "started",
      commandId,
      dispatchId,
      sessionId,
      error: null,
      evidence: `The recorded log carries dispatch.started for '${row.dispatchId ?? "the dispatch"}' with session '${sessionId}'.`,
    }
  }

  switch (row.effectState) {
    case "not_started":
      return {
        outcomeVersion: CURRENT_LAUNCH_OUTCOME_VERSION,
        outcome: "pending",
        commandId,
        dispatchId,
        sessionId: null,
        error: null,
        evidence:
          "The launch command is durable in this node's inbox and no peer has taken the effect yet. The retry path will redeliver it; this is not an ambiguous launch.",
      }
    case "runtime_accepted":
      return {
        outcomeVersion: CURRENT_LAUNCH_OUTCOME_VERSION,
        outcome: "runtime-accepted",
        commandId,
        dispatchId,
        sessionId: null,
        error: createContractError(
          "conflict",
          "mesh.launch_outcome_ambiguous",
          `Command '${row.commandId}' was accepted by a peer at ${row.runtimeAcceptedAt} and no launch outcome was recorded before this process stopped. The launch is AMBIGUOUS rather than failed: the effect may be running. Redelivering is safe — the inbox returns this row — and terminating is not, because the plan forbids stopping work because a node went quiet.`,
        ),
        evidence: `A peer accepted the effect for '${row.commandId}' and no outcome was recorded. This is the crash window between "the runtime accepted the launch" and "the acknowledgement was committed".`,
      }
    case "result_recorded":
      return {
        outcomeVersion: CURRENT_LAUNCH_OUTCOME_VERSION,
        outcome: "unresolved",
        commandId,
        dispatchId,
        sessionId: null,
        error: createContractError(
          "conflict",
          "mesh.launch_outcome_unresolved",
          `Command '${row.commandId}' recorded an effect result at this node, but the recorded log carries no dispatch.started for '${row.dispatchId ?? "the dispatch"}'. One of the two records is behind the other; neither may be discarded to make them agree.`,
        ),
        evidence:
          "This node ran the effect and stored a result, but no session start was ever recorded. The launch is unresolved, not failed.",
      }
  }
}

/**
 * Whether an outcome is one an operator must look at.
 *
 * A predicate rather than a set membership test at each call site, so "needs
 * attention" has one definition. `unresolved` is in it and `pending` is not: a
 * durable launch the peer has not taken yet is normal under a partition, while an
 * unresolved one is a divergence between two durable records.
 */
export function launchOutcomeNeedsAttention(outcome: MeshLaunchOutcome): boolean {
  return outcome === "runtime-accepted" || outcome === "unresolved"
}

/**
 * The kernel's vocabulary, restated as a refusal.
 *
 * Exists so a caller that reaches for `unknown`/`failed` on
 * `ProjectionLaunchAdmission` finds this explaining why there is nothing there
 * instead. It returns the outcome rather than throwing: the honest response to
 * "what does the kernel type say" is the mesh answer plus the reason the kernel
 * type has no member for it.
 */
export function explainKernelLaunchAdmissionGap(outcome: MeshLaunchOutcome): string {
  switch (outcome) {
    case "runtime-accepted":
      return (
        "ProjectionLaunchAdmission has no member for this state, and adding one would mean a member derived from " +
        "nothing the kernel log records. The kernel type is derived from `dispatch.started` and `approval.decided` " +
        "only; an ambiguous launch is a WORKER fact, not a controller event, so it is reported here and through " +
        "`deriveLaunchOutcome` rather than by editing `src/orchestration/schemas.ts` (the M0 contract digest)."
      )
    case "unresolved":
      return (
        "ProjectionLaunchAdmission has no member for this state either. The inbox recorded an effect result and the " +
        "kernel log recorded no start; the two records disagree and neither is authoritative over the other, which is " +
        "exactly the situation a projection must report rather than resolve."
      )
    case "not-requested":
    case "pending":
    case "started":
      return `The kernel projection already represents '${outcome}'; no mesh-only member is needed.`
  }
}
