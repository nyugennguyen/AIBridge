import { canonicalJson } from "../../orchestration/digest.js"
import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import { fingerprintCommand } from "../../orchestration/event-store/fingerprint.js"
import { ackForReceipt, decideCommandReceipt, type CommandReceipt, type MeshAck, type StoredCommandReceipt } from "../protocol/ack.js"
import { sameId } from "../protocol/envelope.js"
import type { MeshCommand } from "../protocol/command.js"
import { timestampSchema } from "../../orchestration/identifiers.js"
import type { CommandId } from "../../orchestration/identifiers.js"
import { authorizeAgainstRecordedLog, type RecordedAuthorization } from "./authorization.js"
import type {
  CommandInbox,
  CommandInboxDependencies,
  CommandInboxOutcome,
  GateOutcomeLike,
  InboxRefusalStage,
  InboxRow,
  InboxScope,
  NewInboxRow,
} from "./types.js"

/**
 * ### THE ORDER
 *
 * Eight steps, and the sequence is the deliverable:
 *
 *   0. **Serialize.** One submission at a time, on a promise chain.
 *   1. **Authenticate.** M4.2's `IdentityProvider`, revocation included, before
 *      anything about the record is believed. The plan states the order as
 *      "authenticated and authorized before persistence", and an authentication
 *      step that lives outside this class is a step nothing asserts.
 *   2. **Gate.** `MeshCommandEpochGate.authorize` — M4.4, already done. It
 *      answers whether this command may be persisted. It does not persist, so a
 *      refusal here has nothing to roll back.
 *   3. **Dedupe / digest.** Has this `commandId` been admitted, and is this the
 *      SAME instruction? Answered BEFORE authorization, because a duplicate is not
 *      a new instruction and re-authorizing one would consult a projection that
 *      has legitimately moved on since the first delivery — turning a successful
 *      retry into a spurious refusal.
 *   4. **Recorded-log authorization.** The pointers in the payload resolve against
 *      the log. A payload is a claim.
 *   5. **Persist.** Durably, before anything is said to the sender.
 *   6. **Ack.** Only now.
 *
 * Steps 5 and 6 are the plan's "persisted before acknowledgement", and they are
 * ADJACENT with nothing between them on purpose. Any work between the write and
 * the ack — a session lookup, an enqueue — widens the crash window in which the
 * command is durable and the sender has heard nothing, which is the window the
 * retry diagram covers, and widening it is not free.
 *
 * ### Why step 0 exists
 *
 * `acceptedSequence` is the ack order, so two concurrent submissions that both
 * persisted would emit acks in whatever order their writes finished rather than in
 * the order they arrived. A controller that receives acks for `cmd-2` before
 * `cmd-1` cannot tell "worker took them out of order" from "worker reordered my
 * commands", and the plan's completion criterion is that duplicate and reordered
 * commands CONVERGE — convergence needs a determinate order to converge onto.
 *
 * Serializing costs concurrency at the seam and buys it back at storage: SQLite
 * already serialises writers, so nothing downstream gains from two of these
 * running at once, and the reader that must see "one inbox row per command" is the
 * thing this makes true by construction.
 *
 * ### What this class deliberately does NOT do
 *
 * It does not run the command, and it does not know what a runtime is. Applying an
 * admitted command is the runtime seam's job, reached through
 * {@link MeshCommandInbox.markRuntimeAccepted} and
 * {@link MeshCommandInbox.recordResult}. That is the M4-B hook 6 boundary: between
 * those two calls the launch is ambiguous, and R4 is the answer for what that
 * state means. See `./launch-outcome.ts`.
 */
export class MeshCommandInbox implements CommandInbox {
  readonly #deps: CommandInboxDependencies
  /** The serialization chain. Step 0. See the class comment. */
  #tail: Promise<unknown> = Promise.resolve()

  constructor(dependencies: CommandInboxDependencies) {
    this.#deps = dependencies
  }

  /**
   * Enqueues onto the serialization chain and returns when this submission's own
   * work is done.
   *
   * The chain is NOT awaited by anyone else: `submit` resolves with THIS
   * submission's outcome, and the tail only carries the ordering. A caller that
   * awaited the tail instead would learn the outcome of a different command.
   */
  async submit(value: unknown): Promise<CommandInboxOutcome> {
    const run = this.#tail.then(() => this.#run(value), () => this.#run(value))
    // The tail swallows this submission's rejection so one failed submission
    // cannot poison the chain for every later one. The failure is still delivered
    // to THIS caller through `run`.
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async lookup(commandId: CommandId): Promise<Result<InboxRow | null>> {
    return this.#deps.store.find(commandId)
  }

  async list(scope: InboxScope, limit?: number): Promise<Result<readonly InboxRow[]>> {
    return this.#deps.store.listInbox({ projectId: scope.projectId, runId: scope.runId, ...(limit === undefined ? {} : { limit }) })
  }

  async peekAcceptedSequence(): Promise<Result<number>> {
    return this.#deps.store.nextAcceptedSequence()
  }

  /**
   * The M4-B hook 6 half: the peer took the effect.
   *
   * Written AFTER the peer has accepted and BEFORE anything acknowledges it, which
   * is the whole content of `runtime_accepted` and the whole reason R4 has an
   * answer. A caller that invokes this and then crashes has left the honest state
   * behind; a caller that never invokes it and crashes has left `not_started`,
   * which claims less than is true.
   */
  async markRuntimeAccepted(commandId: CommandId): Promise<Result<InboxRow | null>> {
    return this.#deps.store.markRuntimeAccepted(commandId, this.#deps.now())
  }

  /** The effect reported its result, so a redelivery can return it verbatim. */
  async recordResult(commandId: CommandId, result: unknown): Promise<Result<InboxRow | null>> {
    return this.#deps.store.recordResult(commandId, result, this.#deps.now())
  }

  async #run(value: unknown): Promise<CommandInboxOutcome> {
    // 1. Authenticate. Before the record is believed, and before the gate spends
    // a lease read on it: M4.2's revocation decision belongs to the first step,
    // and a revoked node should be answered with its revocation rather than with
    // whichever schema check its record happens to fail first.
    const authenticated = await this.#deps.authenticate.authenticate(value)
    if (!authenticated.ok) {
      return this.#refuse(null, "authentication", authenticated.error)
    }

    // 2. The gate. It does not persist, so a refusal here has written nothing.
    const gate = await this.#deps.gate.authorize(value)
    if (!gate.admitted || gate.verified === undefined) {
      return this.#refuse(null, "gate", gate.error ?? unknownGateRefusal(gate))
    }
    const verified = gate.verified

    // The authenticated peer must be the controller the command names. The gate
    // already matched the command's controller against the held lease, so this is
    // not a second authority check — it is the closure of step 1, and without it
    // authentication would be a stage that ran and then contributed nothing.
    if (!sameId(authenticated.value.nodeId, verified.record.controllerNodeId)) {
      return this.#refuse(
        verified.commandId,
        "authentication",
        createContractError(
          "policy_denied",
          "inbox.sender_not_controller",
          `Command '${verified.commandId}' was submitted by authenticated node '${authenticated.value.nodeId}' but names controller '${verified.record.controllerNodeId}'. Only the controller a command names may submit it.`,
        ),
      )
    }

    // 3. Dedupe / digest. BEFORE authorization, for the reason the class comment
    // gives: a duplicate is the same instruction, and re-authorizing it would
    // consult a projection that may legitimately have moved on.
    //
    // The decision is `decideCommandReceipt` — the PROTOCOL's, not a second copy
    // of it here. It keys on the SEMANTIC fingerprint and derives that itself from
    // the command, so the stored dedupe key written at step 5 comes from the same
    // `fingerprintCommand` call the comparison used. Passing the wire
    // `recomputedDigest` instead is the one-line defect that function exists to
    // prevent: the wire digest covers `issuedAt`/`expiresAt`, so a controller
    // re-minting an unanswered command would answer every at-least-once retry with
    // `conflict.command_digest_conflict` — B8 reproduced one layer up.
    const semanticFingerprint = fingerprintCommand(verified.command).semantic
    const existing = await this.#deps.store.find(verified.commandId)
    if (!existing.ok) {
      return this.#refuse(verified.commandId, "persistence", existing.error)
    }
    const decision = decideCommandReceipt(verified.record, storedReceiptOf(existing.value))
    if (decision.disposition === "return_stored") {
      // The stored result, and NOT the one this arrival would produce. The whole
      // point of the retry diagram is that responses 2..N equal response 1.
      const ack = this.#ackFor(verified.record, decision)
      await this.#deps.acks.emit(ack, {
        commandId: verified.commandId,
        acceptedSequence: decision.row.acceptedSequence,
      })
      await this.#deps.store.markAckEmitted(verified.commandId, this.#deps.now())
      return {
        outcome: "duplicate",
        commandId: verified.commandId,
        acceptedSequence: decision.row.acceptedSequence,
        ack,
        storedResult: decision.storedResult,
        row: decision.row,
      }
    }
    if (decision.disposition === "conflict") {
      // Written NOTHING. Not "recorded as a conflict" — a conflict row would be a
      // second row for one command id, and the primary key exists to make that
      // impossible. The sender is told, and the original row is untouched.
      const ack = this.#ackFor(verified.record, decision)
      await this.#deps.acks.emit(ack, { commandId: verified.commandId, acceptedSequence: 0 })
      return {
        outcome: "conflict",
        commandId: verified.commandId,
        ack,
        error: createContractError(
          "conflict",
          "conflict.command_digest_conflict",
          decision.reason,
        ),
      }
    }

    // 4. The recorded log. The pointers are the payload's; the grant is not.
    // The controller node is read off the RECORD, not off `authorizationClaims`,
    // because the wire's claim shape deliberately carries only the three
    // authorization pointers and leaving `controllerNodeId` off it was a decision
    // made where the log was not reachable. It is a pointer here too, and the log
    // decides whether it is true.
    const authorized = await authorizeAgainstRecordedLog(
      verified.command,
      {
        approvalId: verified.authorizationClaims.approvalId,
        dispatchId: verified.authorizationClaims.dispatchId,
        leaseId: verified.authorizationClaims.leaseId,
        controllerEpoch: verified.authorizationClaims.controllerEpoch,
        controllerNodeId: verified.record.controllerNodeId,
      },
      this.#deps.recordedLog,
    )
    if (!authorized.ok) {
      // Still nothing persisted. The gate admitted the command, so a reader of the
      // store must not be able to tell this command was ever seen — that is what
      // makes a refusal invisible to a later redelivery, which then runs the full
      // pipeline again rather than returning a cached refusal.
      return this.#refuse(verified.commandId, "authorization", authorized.error, null)
    }

    // 5. Persist. Durably, and the write is the last thing before the ack.
    const newRow: NewInboxRow = {
      commandId: verified.commandId,
      projectId: verified.projectId,
      runId: verified.runId,
      dispatchId: verified.dispatchId,
      targetNodeId: verified.record.targetNodeId,
      controllerNodeId: verified.record.controllerNodeId,
      controllerEpoch: verified.controllerEpoch,
      leaseId: verified.record.leaseId,
      commandType: verified.record.commandType,
      payloadDigest: verified.recomputedDigest,
      // The SAME semantic fingerprint the dedupe step compared, not a second
      // derivation. Two derivations of "is this the same instruction" are two
      // definitions, and the one that drifts is invisible until a retry is
      // answered as a conflict.
      semanticFingerprint,
      commandJson: canonicalJson(verified.record),
      acceptedAt: this.#deps.now(),
    }
    const written = await this.#deps.store.accept(newRow)
    if (!written.ok) {
      return this.#refuse(verified.commandId, "persistence", written.error, authorized.value)
    }

    // Two arrivals of one command can both pass the dedupe read above and both
    // reach the write; the store's convergence rule makes the second one land on
    // the first one's row. Two writers converging on one row is the property
    // at-least-once delivery is built on, so this is reported as a duplicate —
    // unless the row it landed on is a DIFFERENT instruction, which is a
    // conflict and not a retry.
    //
    // The in-process chain makes the convergent branch unreachable from a single
    // `MeshCommandInbox`, and it is reachable from a second process sharing the
    // database. Reporting "duplicate" there for a mutated payload would hand a
    // caller the stored result of work its own command never described, which is
    // the payload-claim failure this whole seam exists to prevent.
    if (!written.value.written) {
      const converged = decideCommandReceipt(verified.record, storedReceiptOf(written.value.row))
      if (converged.disposition === "conflict") {
        // The ack's sequence position is the CONVERGED row's, not this
        // submission's: a conflict ack says "I already did something else under
        // this id", and the sequence a reader correlates on has to be the one
        // that actually holds that other instruction.
        const ack = this.#ackFor(verified.record, converged)
        await this.#deps.acks.emit(ack, {
          commandId: verified.commandId,
          acceptedSequence: written.value.row.acceptedSequence,
        })
        return {
          outcome: "conflict",
          commandId: verified.commandId,
          ack,
          error: createContractError("conflict", "conflict.command_digest_conflict", converged.reason),
        }
      }
      const ack = this.#ackFor(verified.record, converged)
      await this.#deps.acks.emit(ack, {
        commandId: verified.commandId,
        acceptedSequence: written.value.row.acceptedSequence,
      })
      await this.#deps.store.markAckEmitted(verified.commandId, this.#deps.now())
      return {
        outcome: "duplicate",
        commandId: verified.commandId,
        acceptedSequence: written.value.row.acceptedSequence,
        ack,
        storedResult: storedResultOf(written.value.row),
        row: written.value.row,
      }
    }

    // 6. Ack. Adjacent to the write with nothing in between.
    const ack = this.#ackFor(verified.record, { disposition: "apply", duplicate: false })
    await this.#deps.acks.emit(ack, {
      commandId: verified.commandId,
      acceptedSequence: written.value.row.acceptedSequence,
    })
    await this.#deps.store.markAckEmitted(verified.commandId, this.#deps.now())

    return {
      outcome: "accepted",
      commandId: verified.commandId,
      acceptedSequence: written.value.row.acceptedSequence,
      ack,
      row: written.value.row,
    }
  }

  /**
   * Builds the ack.
   *
   * The payload comes from `meshAckSchema` — the protocol's own builder, not a
   * hand-written literal — and `acknowledgedAt` comes from the injected clock for
   * the reason `ackForReceipt` documents: an ack whose timestamp drifts between
   * the accept path and the duplicate path is two records for one decision.
   */
  #ackFor(record: MeshCommand, receipt: CommandReceipt<InboxRow>): MeshAck {
    // `timestampSchema.parse` is the whole conversion. A `Timestamp` is a checked
    // string, so casting here would put the type back without putting back the
    // check that the instant is a real RFC 3339 UTC value a peer can parse.
    const acknowledgedAt = timestampSchema.parse(new Date(this.#deps.now()).toISOString())
    return ackForReceipt(record, receipt, acknowledgedAt)
  }

  #refuse(
    commandId: CommandId | null,
    stage: InboxRefusalStage,
    error: ContractError,
    authorization: RecordedAuthorization | null = null,
  ): CommandInboxOutcome {
    return { outcome: "refused", commandId, stage, error, authorization }
  }
}

/**
 * The stored answer for a duplicate, from a stored row.
 *
 * `null` rather than a throw when the row has no recorded result: that is the
 * `pending` case — admitted, durable, the effect not yet run — and a retry must
 * still be answered rather than refused, because the sender has no way to
 * distinguish "ran and produced nothing" from "has not run yet" and treating the
 * second as a failure would strand the first command forever.
 */
export function storedResultOf(row: InboxRow): unknown {
  if (row.resultJson === null) return null
  return JSON.parse(row.resultJson) as unknown
}

/**
 * an inbox row, in the shape `decideCommandReceipt` reads.
 *
 * The only adaptation between the two, and it exists because the stored result is
 * JSON TEXT here and a decoded value there. The fingerprint is passed through
 * unchanged and deliberately NOT re-derived: the row's column is the same
 * `fingerprintCommand` value the protocol function computes from the incoming
 * command, so a second derivation here would be a second definition of "the same
 * instruction" and the one that drifts is invisible until a retry is answered as
 * a conflict.
 *
 * `null` in, `null` out, so "this command has never been admitted" stays the
 * protocol's own answer to make rather than a branch here.
 */
function storedReceiptOf(row: InboxRow | null): StoredCommandReceipt<InboxRow> | null {
  if (row === null) return null
  return { row, semanticFingerprint: row.semanticFingerprint, storedResult: storedResultOf(row) }
}

/**
 * Refuses a gate outcome that is neither an admission nor a usable refusal.
 *
 * A gate that returned `admitted: true` with no `verified` payload is a wiring
 * defect, and it must NOT be treated as an admission — this seam persists what it
 * is handed, so an admission without a payload would write a row built from
 * `undefined`. Refusing here is the only direction that is safe.
 */
function unknownGateRefusal(gate: GateOutcomeLike): ContractError {
  return createContractError(
    "internal_failure",
    "inbox.gate_incomplete_admission",
    `The command gate admitted a command but supplied no verified payload (stage '${gate.stage ?? "unknown"}'). The inbox persists what the gate hands it, so an admission with nothing to persist is refused rather than written from undefined values.`,
  )
}
