/**
 * Step 6, asserted as a property of the TYPE rather than of anybody's discipline.
 *
 * The plan's step 6 is "mark unexplained differences for user review; do not silently
 * adopt or terminate", and the protocol spec says the same thing as a design
 * constraint: "If you find yourself adding one, the design is wrong". That makes the
 * RESPONSE SHAPE the artefact under test — not the reconciler, which could be correct
 * today and widened tomorrow.
 *
 * Every negative here is asserted against the schema's OWN field list
 * (`RECONCILIATION_RESPONSE_FIELDS`, which the schema is built from) and against the
 * schema's own token guard, never against a list written inside this file. A test that
 * hard-codes the forbidden field list proves only that the test agrees with itself —
 * and the whole property is that a future author cannot quietly add one.
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  FORBIDDEN_RECONCILIATION_VERBS,
  RECONCILIATION_RESPONSE_FIELDS,
  UNRECONCILED_REASONS,
  isReconciliationResponseFieldAllowed,
  meshReconciliationResponseSchema,
  type MeshReconciliationResponse,
} from "../../../../../src/mesh/protocol/reconciliation.js"
import { MeshReconciler } from "../../../../../src/mesh/gateway/reconcile/index.js"
import { EPOCH, IDS, RUN, WORKER, reconcileRequestEnvelope } from "../fixtures.js"
import { FakeLease, FakeProjections, FakeUnacknowledged } from "./fixtures.js"

const RECONCILER_SOURCE = readFileSync(join(import.meta.dirname, "../../../../../src/mesh/gateway/reconcile/reconciler.ts"), "utf8")

/** A response with every optional member filled, so the widest shape is the one checked. */
const WIDEST: MeshReconciliationResponse = {
  reconcileId: IDS.reconcile("rec-1"),
  outcome: "degraded",
  acceptedControllerEpoch: EPOCH,
  resendCommandIds: [IDS.command("cmd-1")],
  resendEventIds: [IDS.event("evt-1")],
  unreconciled: [{ nodeId: WORKER, reason: "session_not_in_projection", detail: "a difference" }],
  snapshotFallback: { runId: RUN, lastAppliedSequence: 1, stateDigest: `sha256:${"a".repeat(64)}` as never },
}

describe("the reconciliation response has no member that could adopt or terminate", () => {
  it("every field the schema declares is a field this repository may send", () => {
    // `RECONCILIATION_RESPONSE_FIELDS` is derived from the object the schema is built
    // from, so widening the response has to widen this list too — and the guard below
    // then refuses the new field. The two together are what make step 6 structural
    // rather than a review convention.
    for (const field of RECONCILIATION_RESPONSE_FIELDS) {
      expect(isReconciliationResponseFieldAllowed(field), `'${field}' must be a field a peer can be told about, and nothing else`).toBe(true)
    }
  })

  it("no field is named with a verb that could act on a session", () => {
    // Checked token by token, and against the schema's OWN token splitter, because the
    // previous implementation matched forbidden verbs as raw SUBSTRINGS and reported
    // that the spec's required `resendCommandIds` and `resendEventIds` were forbidden —
    // the letters `end` sit inside `resend`. A guard that refuses the shape it is
    // meant to certify is worse than no guard, because a reader has to decide which
    // of the two is wrong.
    for (const field of RECONCILIATION_RESPONSE_FIELDS) {
      const tokens = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter((token) => token.length > 0)
      for (const token of tokens) {
        const singular = token.endsWith("s") ? token.slice(0, -1) : token
        expect(FORBIDDEN_RECONCILIATION_VERBS, `'${field}' carries the forbidden verb '${token}'`).not.toContain(token)
        expect(FORBIDDEN_RECONCILIATION_VERBS, `'${field}' carries the forbidden verb '${singular}'`).not.toContain(singular)
      }
    }
  })

  it("the guard refuses every verb the plan names, including in the plural", () => {
    // The other half: a guard that permits everything would pass the two assertions
    // above. Bailing out on a plural is how a guard gets bypassed by grammar.
    for (const verb of FORBIDDEN_RECONCILIATION_VERBS) {
      expect(isReconciliationResponseFieldAllowed(verb), `'${verb}' must be refused`).toBe(false)
      expect(isReconciliationResponseFieldAllowed(`${verb}s`), `'${verb}s' must be refused`).toBe(false)
      expect(isReconciliationResponseFieldAllowed(`session${verb[0]!.toUpperCase()}${verb.slice(1)}s`), `'session${verb}...' must be refused`).toBe(false)
    }
  })

  it("the widest response is EXACTLY the seven fields the protocol allows", () => {
    // Including `snapshotFallback`, so a reader can see that M4-S added nothing: the
    // fallback is the protocol's own optional field, filled from the same source the
    // SSE route uses.
    expect(RECONCILIATION_RESPONSE_FIELDS).toEqual([
      "reconcileId",
      "outcome",
      "acceptedControllerEpoch",
      "resendCommandIds",
      "resendEventIds",
      "unreconciled",
      "snapshotFallback",
    ])
    expect(Object.keys(WIDEST).sort()).toEqual([...RECONCILIATION_RESPONSE_FIELDS].sort())
  })

  it("no outcome VALUE reads as 'a difference was resolved'", () => {
    // `outcome` is the coarsest thing a reader can act on, so a value like
    // `resolved` or `adopted` there would be the whole of step 6 defeated while every
    // field name stayed clean.
    for (const outcome of ["converged", "degraded", "snapshot_required", "refused"] as const) {
      expect(isReconciliationResponseFieldAllowed(`outcome${outcome[0]!.toUpperCase()}${outcome.slice(1)}`), `'outcome: "${outcome}"`).toBe(true)
    }
    for (const outcome of meshReconciliationResponseSchema.shape.outcome.options) {
      expect(["resolved", "adopted", "terminated", "repaired"]).not.toContain(outcome)
    }
  })

  it("no `unreconciled` REASON reads as 'a difference was resolved'", () => {
    // The reason vocabulary is what a user-facing triage view groups by, so a reason
    // called `resolved` would be an operator-visible claim that reconciliation settled
    // something. The set is closed, and the closure is asserted rather than assumed.
    for (const reason of UNRECONCILED_REASONS) {
      expect(/resolved|adopted|terminated|repaired|fixed/i.test(reason), `'${reason}' must not read as resolved`).toBe(false)
    }
  })

  it("the schema is STRICT, so a member invented here is a parse failure", () => {
    // The mechanism. An `adopt` or a `terminate` added to the reconciler's response
    // object fails here rather than reaching a peer, and the refusal carries a message
    // that says what happened.
    const invented = { ...WIDEST, sessions: [{ sessionId: "sess-1", action: "terminate" }] }
    const parsed = meshReconciliationResponseSchema.safeParse(invented)
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(parsed.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true)
  })

  it("'converged' and 'unreconciled entries' cannot both be true", () => {
    // A response that said "converged" while carrying a list of differences is the
    // failure an operator cannot see, because the list is right there and the headline
    // is above it. The schema refuses the combination rather than trusting the writer
    // to have ranked them correctly.
    const parsed = meshReconciliationResponseSchema.safeParse({ ...WIDEST, outcome: "converged" })
    expect(parsed.success).toBe(false)
  })

  it("the reconciler's own source contains no session transition and no epoch write", () => {
    // The last place something could smuggle an action in: not the wire, but the code
    // that fills it. A reconciler that reached a session store, a runtime, or a lease
    // write could act without a field to put the action in — which is why the LEASE
    // PORT it holds has no `takeover` and the test in `six-steps.test.ts` asserts
    // that from the other side.
    expect(RECONCILER_SOURCE).not.toMatch(/\.terminate\(/)
    expect(RECONCILER_SOURCE).not.toMatch(/\.adopt\(/)
    expect(RECONCILER_SOURCE).not.toMatch(/\.kill\(/)
    expect(RECONCILER_SOURCE).not.toMatch(/\.takeover\(/)
    expect(RECONCILER_SOURCE).not.toMatch(/closeTerminal/)
  })
})

describe("what the reconciler does with a difference is mark it", () => {
  it("produces a response whose every field is on the allowed list", async () => {
    const lease = new FakeLease(EPOCH)
    const reconciler = new MeshReconciler({
      lease,
      unacknowledged: new FakeUnacknowledged(),
      projections: new FakeProjections(),
    })
    const outcome = await reconciler.reconcile(
      reconcileRequestEnvelope({
        activeSessionInventory: [{ sessionId: "sess-orphan", dispatchId: "dispatch-unknown", startedAt: "2026-09-28T00:00:00.000Z" }],
      }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    for (const field of Object.keys(outcome.response)) {
      expect(RECONCILIATION_RESPONSE_FIELDS, `'${field}' is not a field the protocol allows`).toContain(field)
      expect(isReconciliationResponseFieldAllowed(field)).toBe(true)
    }
    // And the response PARSES, which is the last of it: the reconciler builds it, the
    // schema validates it, and nothing in between could have widened it.
    expect(meshReconciliationResponseSchema.safeParse(outcome.response).success).toBe(true)
  })

  it("and the response it hands back carries no session id outside `unreconciled`", async () => {
    const lease = new FakeLease(EPOCH)
    const reconciler = new MeshReconciler({
      lease,
      unacknowledged: new FakeUnacknowledged(),
      projections: new FakeProjections().seed([{ dispatchId: "dispatch-gateway-1", sessionId: "sess-gateway-1" }]),
    })
    const outcome = await reconciler.reconcile(
      reconcileRequestEnvelope({
        activeSessionInventory: [{ sessionId: "sess-second", dispatchId: "dispatch-gateway-1", startedAt: "2026-09-28T00:00:00.000Z" }],
      }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // The only place a session id appears is inside a `detail` STRING, where a human
    // reads it. There is no `sessionIds` array a caller could iterate and act on.
    const sessionBearingFields = Object.entries(outcome.response).filter(
      ([, value]) => JSON.stringify(value).includes("sess-second"),
    )
    expect(sessionBearingFields.map(([field]) => field)).toEqual(["unreconciled"])
  })
})
