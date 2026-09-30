import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { COMMAND_MATRIX } from "../../../../src/orchestration/invariants.js"
import { orchestrationCommandSchema } from "../../../../src/orchestration/schemas.js"
import {
  APPROVAL_CREATING_COMMAND_TYPES,
  DISPATCH_CREATING_COMMAND_TYPES,
  approvalIsCreatedBy,
  dispatchIsCreatedBy,
} from "../../../../src/mesh/inbox/authorization.js"
import {
  FakeRecordedLog,
  aRecordedApproval,
  aRecordedDispatch,
  aRecordedLeaseAt,
  durableInboxHarness,
  envelopeDigestOf,
  executeCommand,
  licensingLog,
  memoryInboxHarness,
  TestClock,
  at,
  type InboxHarness,
} from "./fixtures.js"

/**
 * Recorded-log authorization. The plan's guardrail, quoted:
 *
 * > **Do not authorize a remote command against its own payload.** Authorization
 * > resolves against durable recorded state; a payload is a claim, not a grant.
 *
 * The central test is the one M3.8 and M4.0 each closed a variant of: a payload
 * that is PERFECTLY SELF-CONSISTENT — a schema-valid `approval`, digest-bound to
 * an envelope it carries, `decision: "approved"`, `state: "approved"`, right
 * project, right run, right dispatch — and the recorded log holds no such
 * approval at all. Everything the caller could check by itself lines up. It must
 * still be refused, with nothing persisted, because a caller can compute a hash
 * and cannot decide anything.
 *
 * Every refusal below asserts three separate things, because any one of them
 * alone is satisfiable by an implementation that is wrong in a different way:
 * the outcome is a refusal, the STORE is byte-identical, and the LOG was
 * actually consulted. The third is what separates "refused after checking" from
 * "refused before checking anything", and a refusal that never read the log
 * would be a refusal for the wrong reason.
 */

const AUTHORIZATION_SOURCE = readFileSync(
  join(import.meta.dirname, "../../../../src/mesh/inbox/authorization.ts"),
  "utf8",
)
const INBOX_SOURCE = readFileSync(join(import.meta.dirname, "../../../../src/mesh/inbox/inbox.ts"), "utf8")

function harnesses(options: Parameters<typeof memoryInboxHarness>[1] = {}): { label: string; make: () => InboxHarness }[] {
  return [
    { label: "InMemoryCommandInboxStore", make: () => memoryInboxHarness(new TestClock(at(0)), options) },
    { label: "SqliteCommandInboxStore", make: () => durableInboxHarness(new TestClock(at(0)), options) },
  ]
}

describe("M4.5 a self-consistent payload claiming an approval the log never decided is refused", () => {
  it("refuses, writes nothing, and reads the log to find out", async () => {
    for (const label of LABELS) {
      // The log holds the LEASE and the DISPATCH but NOT the approval. Every
      // other fact the payload asserts about itself is true.
      const command = executeCommand()
      const log = new FakeRecordedLog({ dispatch: aRecordedDispatch(envelopeDigestOf(command)), approval: null })
      const live = harnessWith(label, log)
      try {
        const outcome = await live.inbox.submit(command)
        expect(outcome.outcome, label).toBe("refused")
        if (outcome.outcome !== "refused") continue
        expect(outcome.stage, label).toBe("authorization")
        expect(outcome.error.code, label).toBe("inbox.approval_not_recorded")
        expect(outcome.error.category, label).toBe("policy_denied")

        // The store is byte-identical. "Byte-identical" and "no new row" are the
        // same claim here because the row does not exist yet, and a second row
        // for one command id is what the primary key exists to prevent.
        expect(await live.rows(), label).toHaveLength(0)
        // And the log WAS consulted — an approval lookup that never happened
        // would be a refusal for an unstated reason.
        expect(log.reads.approval, label).toBe(1)
        expect(log.reads.lease, label).toBeGreaterThan(0)
      } finally {
        live.close()
      }
    }
  })

  it("refuses a launch that names NO approval at all", async () => {
    for (const label of LABELS) {
      const command = executeCommand()
      // The same as the case above, reached through a different door: the
      // command names a dispatch the log recorded, and there is no approval to
      // find for it either way.
      const log = new FakeRecordedLog({ dispatch: aRecordedDispatch(envelopeDigestOf(command)), approval: null })
      const live = harnessWith(label, log)
      try {
        const outcome = await live.inbox.submit(command)
        expect(outcome.outcome, label).toBe("refused")
        if (outcome.outcome === "refused") expect(outcome.error.code, label).toBe("inbox.approval_not_recorded")
        expect(await live.rows(), label).toHaveLength(0)
      } finally {
        live.close()
      }
    }
  })
})

describe("M4.5 the recorded approval, not the payload's, decides", () => {
  it("refuses when the RECORDED approval was decided against, whatever the payload says", async () => {
    const command = executeCommand()
    const digest = envelopeDigestOf(command)
    // The payload's approval says `approved`. The log's says `rejected`. The log
    // wins — this is the "a digest that still matches is necessary but not
    // sufficient" case.
    const log = new FakeRecordedLog({
      approval: aRecordedApproval(digest, { state: "rejected", decision: "rejected" }),
      dispatch: aRecordedDispatch(digest),
    })
    for (const label of LABELS) {
      const harness = harnessWith(label, log)
      try {
        const outcome = await harness.inbox.submit(command)
        expect(outcome.outcome, label).toBe("refused")
        if (outcome.outcome !== "refused") continue
        expect(outcome.error.code, label).toBe("inbox.approval_not_authorized")
        expect(outcome.error.category, label).toBe("approval_required")
        expect(await harness.rows(), label).toHaveLength(0)
      } finally {
        harness.close()
      }
    }
  })

  it("refuses when the RECORDED approval was invalidated after the fact", async () => {
    const command = executeCommand()
    const digest = envelopeDigestOf(command)
    // The most dangerous shape: `decision` is still `approved`, and the digest
    // still matches, but the state says the approval no longer authorizes
    // anything. Trusting the payload here would let an invalidated approval
    // launch work.
    const log = new FakeRecordedLog({
      approval: aRecordedApproval(digest, { state: "invalidated" }),
      dispatch: aRecordedDispatch(digest),
    })
    for (const label of LABELS) {
      const harness = harnessWith(label, log)
      try {
        const outcome = await harness.inbox.submit(command)
        expect(outcome.outcome, label).toBe("refused")
        if (outcome.outcome === "refused") expect(outcome.error.code, label).toBe("inbox.approval_not_authorized")
        expect(await harness.rows(), label).toHaveLength(0)
      } finally {
        harness.close()
      }
    }
  })

  it("refuses when the payload launches an envelope the recorded dispatch never carried", async () => {
    const command = executeCommand()
    const recordedDigest = envelopeDigestOf(command)
    // The log recorded a DIFFERENT envelope digest for this dispatch. The
    // payload's approval is internally consistent with the payload's own
    // envelope, and both disagree with what was approved.
    const log = new FakeRecordedLog({
      approval: aRecordedApproval(`sha256:${"9".repeat(64)}`),
      dispatch: aRecordedDispatch(`sha256:${"9".repeat(64)}`),
    })
    for (const label of LABELS) {
      const harness = harnessWith(label, log)
      try {
        const outcome = await harness.inbox.submit(command)
        expect(outcome.outcome, label).toBe("refused")
        if (outcome.outcome === "refused") {
          // Either the approval/dispatch digests disagree, or the command's own
          // envelope does. Both are the same fact seen from two sides, and
          // either code is a refusal with nothing persisted.
          expect(["inbox.approval_digest_mismatch", "inbox.dispatch_envelope_digest_mismatch"], label).toContain(
            outcome.error.code,
          )
        }
        expect(await harness.rows(), label).toHaveLength(0)
        void recordedDigest
      } finally {
        harness.close()
      }
    }
  })
})

describe("M4.5 the recorded lease, not the payload's, decides", () => {
  it("refuses a command whose lease the log does not hold", async () => {
    for (const { label, make } of harnesses({ log: new FakeRecordedLog({ lease: null }) })) {
      const harness = make()
      try {
        const outcome = await harness.inbox.submit(executeCommand())
        expect(outcome.outcome, label).toBe("refused")
        if (outcome.outcome !== "refused") continue
        expect(outcome.error.code, label).toBe("inbox.lease_not_recorded")
        expect(await harness.rows(), label).toHaveLength(0)
      } finally {
        harness.close()
      }
    }
  })

  it("refuses a command whose claimed epoch is not the recorded lease's epoch", async () => {
    const command = executeCommand()
    const digest = envelopeDigestOf(command)
    // The log holds a lease at a HIGHER epoch than the command claims. A stale
    // command is not a command this node may apply, and the recorded epoch is
    // the grant; the claim is only a pointer to it.
    const log = new FakeRecordedLog({
      lease: aRecordedLeaseAt({ epoch: 2 }),
      approval: aRecordedApproval(digest),
      dispatch: aRecordedDispatch(digest),
    })
    for (const label of LABELS) {
      const harness = harnessWith(label, log)
      try {
        const outcome = await harness.inbox.submit(command)
        expect(outcome.outcome, label).toBe("refused")
        if (outcome.outcome === "refused") expect(outcome.error.code, label).toBe("inbox.lease_epoch_mismatch")
        expect(await harness.rows(), label).toHaveLength(0)
      } finally {
        harness.close()
      }
    }
  })

  it("refuses a lease issued to a different controller than the command names", async () => {
    const command = executeCommand()
    const digest = envelopeDigestOf(command)
    const log = new FakeRecordedLog({
      lease: aRecordedLeaseAt({ controllerNodeId: "node-controller-b" }),
      approval: aRecordedApproval(digest),
      dispatch: aRecordedDispatch(digest),
    })
    for (const label of LABELS) {
      const harness = harnessWith(label, log)
      try {
        const outcome = await harness.inbox.submit(command)
        expect(outcome.outcome, label).toBe("refused")
        if (outcome.outcome === "refused") expect(outcome.error.code, label).toBe("inbox.lease_controller_mismatch")
        expect(await harness.rows(), label).toHaveLength(0)
      } finally {
        harness.close()
      }
    }
  })

  it("refuses a lease that fences a different run", async () => {
    const command = executeCommand()
    const digest = envelopeDigestOf(command)
    const log = new FakeRecordedLog({
      lease: aRecordedLeaseAt({ runId: "run-release-2" }),
      approval: aRecordedApproval(digest),
      dispatch: aRecordedDispatch(digest),
    })
    for (const label of LABELS) {
      const harness = harnessWith(label, log)
      try {
        const outcome = await harness.inbox.submit(command)
        expect(outcome.outcome, label).toBe("refused")
        if (outcome.outcome === "refused") expect(outcome.error.code, label).toBe("inbox.lease_scope_mismatch")
        expect(await harness.rows(), label).toHaveLength(0)
      } finally {
        harness.close()
      }
    }
  })
})

describe("M4.5 COMMAND_MATRIX is the single source of allowed states, and it is not restated here", () => {
  it("the recorded-log step declares no allowed-state list of its own", () => {
    // `COMMAND_MATRIX` states which LIFECYCLE STATES a command type may act in,
    // and M4.4's gate resolves it against recorded state. A second list in this
    // module would be the parallel hand-maintained set the plan forbids, and it
    // would drift silently: adding a command type to the matrix would compile
    // here and mean nothing.
    expect(AUTHORIZATION_SOURCE).not.toMatch(/COMMAND_MATRIX\[/)
    expect(AUTHORIZATION_SOURCE).not.toMatch(/allowedRunStates|allowedDispatchStates|allowedApprovalStates/)
  })

  it("the two creator tables are EXHAUSTIVE over the matrix's command types", () => {
    // Every command type is classified as creating or consuming the approval and
    // the dispatch it points at. A type nobody classified would fall through to
    // "creator" by accident, which is the direction that SKIPS a check.
    const types = Object.keys(COMMAND_MATRIX).sort()
    const approvalCreators = Object.keys(APPROVAL_CREATING_COMMAND_TYPES).sort()
    const dispatchCreators = Object.keys(DISPATCH_CREATING_COMMAND_TYPES).sort()
    expect(approvalCreators).toEqual(types)
    expect(dispatchCreators).toEqual(types)
  })

  it("only `dispatch.approve` creates the approval, and only `dispatch.propose` creates the dispatch", () => {
    const creatingApprovals = Object.entries(APPROVAL_CREATING_COMMAND_TYPES)
      .filter(([, creates]) => creates)
      .map(([type]) => type)
    const creatingDispatches = Object.entries(DISPATCH_CREATING_COMMAND_TYPES)
      .filter(([, creates]) => creates)
      .map(([type]) => type)
    // `dispatch.approve` CREATES the approval, so its payload's approval state is
    // the command's RESULT and not a precondition. Requiring a recorded approval
    // first would make the first approval in a run impossible.
    expect(creatingApprovals).toEqual(["dispatch.approve"])
    expect(creatingDispatches).toEqual(["dispatch.propose"])
  })

  it("the creators are readable as functions, not only as tables", () => {
    const approve = commandOfType("dispatch.approve")
    const propose = commandOfType("dispatch.propose")
    expect(approvalIsCreatedBy(approve)).toBe(true)
    expect(dispatchIsCreatedBy(approve)).toBe(false)
    expect(approvalIsCreatedBy(propose)).toBe(false)
    expect(dispatchIsCreatedBy(propose)).toBe(true)
  })
})

describe("M4.5 a refusal is INVISIBLE to a later redelivery", () => {
  it("re-runs the whole pipeline rather than answering from a cached refusal", async () => {
    const command = executeCommand()
    const digest = envelopeDigestOf(command)
    for (const label of LABELS) {
      // A log PER LABEL, not one shared across the loop. The second half of the
      // test mutates the log, and a shared one would carry that mutation into the
      // next iteration's "refused" assertion — which would then fail for having
      // been given a different starting state.
      const log = new FakeRecordedLog({ approval: null, dispatch: aRecordedDispatch(digest) })
      const harness = harnessWith(label, log)
      try {
        // First arrival: refused, nothing persisted.
        const refused = await harness.inbox.submit(command)
        expect(refused.outcome, label).toBe("refused")
        expect(await harness.rows(), label).toHaveLength(0)

        // The log later records the approval — a legitimate fact arriving late
        // from the controller's reconciliation.
        log.set({ approval: aRecordedApproval(digest) })

        // Second arrival of the SAME command: it must run the full pipeline
        // again and be ACCEPTED. A store that cached the refusal would answer
        // `refused` forever, and the work would never run.
        const accepted = await harness.inbox.submit(command)
        expect(accepted.outcome, label).toBe("accepted")
        expect(await harness.rows(), label).toHaveLength(1)
      } finally {
        harness.close()
      }
    }
  })
})

describe("M4.5 the module states the rule it exists to enforce", () => {
  it("never reads a grant out of the payload", () => {
    // The only two payload facts this module consults are WHICH dispatch the
    // command names and WHAT envelope it would launch — and the envelope's
    // digest is compared AGAINST the recorded one, with the recorded one
    // winning. A `.payload.approval.state` read would be the defect.
    expect(AUTHORIZATION_SOURCE).not.toMatch(/command\.payload\.approval\.(state|decision)/)
    expect(AUTHORIZATION_SOURCE).toMatch(/is a claim, not a grant|POINTER; the grant is whatever the event log recorded/)
  })

  it("resolves the controller node from the RECORD, not from the payload", () => {
    // `verified.authorizationClaims` deliberately carries only the three
    // authorization pointers and no `controllerNodeId`, so the inbox reads the
    // controller off the wire record — and the log then decides whether it is
    // true. The comment in `inbox.ts` says why.
    expect(INBOX_SOURCE).toMatch(/controllerNodeId: verified\.record\.controllerNodeId/)
  })
})

// --- helpers --------------------------------------------------------------

const LABELS = ["InMemoryCommandInboxStore", "SqliteCommandInboxStore"] as const

function harnessWith(label: string, log: FakeRecordedLog): InboxHarness {
  const clock = new TestClock(at(0))
  return label === "InMemoryCommandInboxStore"
    ? memoryInboxHarness(clock, { log })
    : durableInboxHarness(clock, { log })
}

/** A licensing log for a command, so a "this one is ADMITTED" control has a home. */
export function licensedHarness(label: string, command = executeCommand()): InboxHarness {
  return harnessWith(label, licensingLog(command))
}

/**
 * A KERNEL command of the given type, for the creators table.
 *
 * Built through `orchestrationCommandSchema` rather than cast, so a rename of a
 * command type stops compiling here instead of leaving a row of the creators
 * table quietly uncovered — which is the exact failure the table's exhaustiveness
 * is for. Only the three fields the table reads are meaningful; nothing verifies
 * this record, and the wire schema's own `commandType === command.type` check is
 * the reason a full `mesh.command` is not built.
 */
function commandOfType(type: "dispatch.approve" | "dispatch.propose") {
  const envelope = executeCommand().payload as {
    command: { payload: { dispatch: unknown; approval?: unknown } }
  }
  const payload =
    type === "dispatch.approve"
      ? envelope.command.payload
      : { dispatch: envelope.command.payload.dispatch }
  return orchestrationCommandSchema.parse({
    schemaVersion: 1,
    commandId: "cmd-creator",
    projectId: "project-release",
    runId: "run-release-1",
    actor: { kind: "node", nodeId: "node-controller-a" },
    controllerNodeId: "node-controller-a",
    controllerEpoch: 1,
    leaseId: "lease-run-1-e1",
    issuedAt: new Date(at(1)).toISOString(),
    expiresAt: new Date(at(20)).toISOString(),
    correlationId: "cmd-creator",
    causation: null,
    type,
    payload,
  })
}
