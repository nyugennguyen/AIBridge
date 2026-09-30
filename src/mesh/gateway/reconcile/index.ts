/**
 * M4.6 — reconnect reconciliation: the plan's six steps, in order.
 *
 * The seam M4.8 (TUI mesh and takeover UX), M4.9 (the two-node fault harness) and
 * M4.10 (the protocol/security audit) consume. Six things a consumer must know
 * before importing anything from here:
 *
 *   1. **`MeshReconciler` is the only entry point, and it takes a RAW wire value.**
 *      Same reason as every other mesh seam: M4-V is that there is exactly one parse
 *      entry point, and a typed parameter would be an invitation to add a second.
 *   2. **Step 3's accepted epoch comes from M4.4's lease, and there is no second
 *      epoch rule in this directory.** The comparison itself is
 *      `verifyReconciliationPair`'s; this directory supplies the right-hand side.
 *      A reconciler that could raise an epoch would be an automatic election, which
 *      the milestone forbids — and `ReconcileLeaseReader` has no `takeover` for
 *      exactly that reason.
 *   3. **Steps 4 and 5 run only after 1–3 all pass.** A superseded controller must
 *      not cause a durable read, let alone a resend list. The gate is not a style
 *      preference: the resend list is a set of decisions taken against a projection
 *      that no longer exists.
 *   4. **Step 6 is structural.** `meshReconciliationResponseSchema` is `.strict()`
 *      and the response is PARSED before it is returned, so a member that could
 *      adopt or terminate a session is a parse failure in `./reconciler.ts`, not a
 *      field on the wire. `unreconciled[]` is the only channel a difference takes to
 *      a human. `reconcile-response-cannot-act.test.ts` asserts that against the
 *      schema's own shape rather than against a list written in the test.
 *   5. **M4-S is one rule, two callers.** The reconciler and the SSE route both ask
 *      the same `SnapshotFallbackSource`, so a client that reconnects over SSE and a
 *      peer that reconciles over the wire are told the same thing about a cursor
 *      that cannot be honoured, and the two cannot drift apart into one of them
 *      silently serving the head.
 *   6. **The ONE write is step 6's.** `setUnreconciledNodeIds` hands the marked
 *      nodes to M4.4 so a later takeover's user-inspection precondition is
 *      evaluated against a fact. It is not a session transition, and there is no
 *      member anywhere in this directory that could express one.
 *
 * Purity: `./reconciler.ts` touches no framework and opens no connection. It reads
 * M4.4's lease, M4.5's queues and the controller's projections through the ports in
 * `./types.ts`, which is what lets the partition, restart and stale-epoch scenarios
 * be tested by constructing a request at a particular epoch rather than by
 * simulating a network.
 */

export { RECONCILE_RESEND_LIMIT } from "./constants.js"

export { MeshReconciler, type MeshReconcilerDependencies } from "./reconciler.js"

export {
  type DispatchProjectionReader,
  type ReconcileLeaseReader,
  type ReconcileOutcome,
  type ReportedSession,
  type UnacknowledgedSource,
  type UnreconciledEntry,
  type UnreconciledReason,
} from "./types.js"
