# ADR 0004: Controller leases, fencing, and manual recovery

Status: accepted for the Milestone 0 contract freeze (M0.5).

Depends on [ADR 0001](0001-canonical-domain-and-module-boundaries.md), [ADR 0002](0002-versioned-contracts-and-adapter-boundaries.md), [ADR 0003](0003-event-store-and-idempotency.md), and the version-1 `controllerLeaseSchema` / `orchestrationCommandSchema` in [orchestration schemas](../../src/orchestration/schemas.ts).

## Authority and availability decision

Each run is bound to one authority service and its one durable SQLite store for its lifetime. This authority serializes both lease epochs and authoritative event appends. A controller is the temporarily authorized node named by a lease; moving that role does not move the store or confer authority on a replica. A Tailscale address, matching database copy, higher claimed epoch, self-signed assertion, or local timeout cannot establish authority.

There is no automatic election or partition-side promotion. If the fixed authority is unavailable, controllers cannot renew, acquire, or commit run changes. Workers can finish previously admitted runtime operations, preserve local sessions, and queue bounded observations; new orchestration effects stop when their existing authority expires. Read-only history and authorized session inspection remain available. This deliberately accepts reduced write availability during authority failure.

Changing the physical authority host is an offline administrative disaster-recovery procedure requiring exclusive ownership of the original authority and proof against stale writers; it is outside normal manual controller takeover. Permanent authority-store loss fails closed. Starting a new empty store at epoch 1 or promoting an arbitrary replica is forbidden.

## Lease identity, issuance, and renewal

The canonical lease already contains `schemaVersion`, `leaseId`, `projectId`, `runId`, `controllerNodeId`, positive safe-integer `epoch`, `issuedAt`, and `expiresAt`. Additional authority metadata such as renewal revision, takeover intent, renewal-disabled state and authenticated requester belongs to a future versioned internal control record. These values are not injected into the strict version-1 domain object.

The authority maintains exactly one current lease and a monotonically increasing epoch for the run. Initial issuance uses epoch 1. Acquisition after expiry, including reacquisition by the same controller, creates a new lease ID and epoch `previous + 1`; never reuse an expired lease or wrap counters. Renewal before expiry extends the same lease ID/epoch for the same controller, keeps its original `issuedAt`, and cannot decrease expiry. Each renewal is durably serialized; an acknowledged renewal has committed before a controller relies on it.

One authority transaction checks the authenticated administrator/controller, project/run binding, current epoch/lease and takeover state, and then changes the lease/control row, appends `controller.lease.changed` with a matching embedded/event epoch, advances the stream head/projection and records the operation receipt/outbox. The initial lease and run creation share a transaction. There is no interval in which a new lease is acknowledged without its history or the old lease can still renew after a committed takeover intent.

Lease acquisition/renewal/takeover are administrative authority operations, not new members of `orchestrationCommandSchema`. Their future transport needs stable operation IDs and fingerprints with the receipt semantics of ADR 0003. Repeated administrative requests must return the original result rather than increment another epoch. Competing renewals/takeovers serialize at the same authoritative store; compare-and-set on the expected lease/epoch rejects the loser.

## Time and command admission

Lease times are authority-issued UTC instants; clocks do not order events. Deployment must establish a bounded maximum authority/worker clock offset plus drift and synchronization uncertainty, called `U`. Configuration must specify a finite bound and a maximum lease duration. A worker that cannot establish/maintain this bound, detects clock rollback, resumes after an untrusted suspend, or loses durable fencing state must stop admitting effects until it resynchronizes and reconciles with the authority.

At an effect boundary, the worker requires its conservative upper bound for authority time to be strictly earlier than both the verified lease expiry and command expiry. With local time `W` and a valid offset bound `U`, that means `W + U < min(lease.expiresAt, command.expiresAt)`. Issuance cannot be in the future beyond the permitted uncertainty, and command expiry cannot exceed the lease expiry authenticated for that command. A later lease renewal cannot extend an already-issued command's expiry. Use a monotonic deadline to prevent a local wall-clock rollback from lengthening an accepted interval; discard the deadline on restart and revalidate against the authority.

The authority uses its own conservative lower time bound when deciding that a predecessor is certainly expired. Normal takeover waits until that lower bound exceeds the last persisted predecessor expiry plus `U`. If the authority clock itself becomes untrustworthy, it grants no lease. Values of `U` and lease duration are deployment choices requiring M4 clock/fault tests; zero uncertainty cannot be assumed from LAN/Tailscale connectivity.

Expiry fences the start of new orchestration effects. It does not kill running agents, reverse effects already performed, or prevent an existing agent from continuing its approved work. The worker rechecks immediately before every external invocation, including queued prompts, permission responses and process control, under its local effect/fence serializer. A queued operation that has not crossed that boundary is invalidated when expiry or a newer epoch arrives. An invocation already in flight is retained as possible prior work and reconciled; takeover cannot label it nonexistent merely because the old lease ended.

## Worker fencing and proof

Before accepting a lease, authenticate it against the run's fixed authority over the authenticated authority channel, or validate an equivalent authority-authenticated proof whose security format is defined in M4. The claimed `actor`, controller node ID or bare `ControllerLease` JSON is never proof by itself. Authenticate the sending controller and check it equals the verified lease holder.

Persist the highest accepted epoch, lease identity/controller, authenticated expiry and source authority per project/run before admitting commands for it. Under one local serializer/transaction:

1. Reject a lower epoch as `stale_epoch`; reject the same epoch with a different lease/controller as a conflict. A renewed same-epoch lease may only extend expiry with authenticated authority evidence.
2. Accept a higher epoch only from the fixed authority, durably advance the fence, and invalidate prepared old-epoch operations. A controller cannot invent a higher epoch. Advancing a fence never erases old receipts or ambiguous effects.
3. Check command epoch/lease/controller, exact fingerprint, current expiry, canonical scope, dispatch digest/approval, current source/project-path authorization, capability and safety floor. Recheck at the effect boundary as ADR 0003 requires.

Receipt reads may reveal an already-performed old-epoch outcome to an authorized caller, but never invoke that command again. Older worker observations can be uploaded for reconciliation; they are evidence, not permission to issue old commands. Workers that restart with missing/corrupt fence or inbox state cannot reconstruct safety merely from a current controller's claims.

## Manual takeover protocol

An authorized operator requests a specific candidate controller for an existing run. Takeover follows these steps and remains visibly paused until reconciliation succeeds:

1. At the fixed authority, commit a durable takeover intent naming the candidate, expected predecessor lease/epoch, authenticated operator and operation ID. Atomically disable further predecessor renewal and stop new controller work admission for the run. Any renewal that committed first is reflected in the captured final predecessor expiry. A competing takeover conflicts.
2. Ask the predecessor to stop dispatching and workers to quiesce queued effects; these messages improve responsiveness but are not relied on for exclusivity. Do not shorten the predecessor lease and assume disconnected workers learned of revocation.
3. Wait until the final persisted predecessor expiry plus bounded clock uncertainty has certainly passed. A controller disconnect or failed heartbeat alone is insufficient. The wait condition survives authority restart through the durable takeover intent.
4. In one authority transaction, verify the same takeover intent and predecessor, allocate a new lease ID and epoch `old + 1`, assign the candidate, append the matching lease event and store the operation result. The run remains in recovery mode; the new controller cannot dispatch ordinary work yet.
5. Deliver the new authenticated fence to every node that may hold a session, admitted command, pending outbox delivery or ambiguous effect for the run. Each node durably acknowledges the fence, cancels uninvoked prior-epoch work, and reports inbox/effect-journal state, canonical/provider session mappings, outstanding permission requests and unsent observations. Drain/deduplicate accepted observations at the authority.
6. Reconcile the task/dispatch/session projection against that evidence. Restore known sessions without relaunching; preserve confirmed outcomes; explicitly resolve or retain blocked ambiguous launches/prompts/responses. An unreachable relevant worker or unresolved effect keeps the run paused. A different reachable node is not evidence that the missing node never executed work.
7. Once all relevant workers acknowledge and ambiguous effects are resolved, commit the recovery completion and resume scheduling under the new lease. If the new lease expires during recovery, repeat safe acquisition; never stretch timestamps or decrement epochs.

The implementation must expose the relevant-worker inventory from durable dispatch/outbox/inbox acknowledgments, not just currently online nodes. This conservative version-1 protocol pauses the whole run while an involved worker is unaccounted for. More permissive per-task recovery requires a later reviewed contract.

`controllerEpoch` is part of the immutable dispatch-envelope digest. A proposed/approved but unexecuted old-epoch dispatch cannot be edited or silently reissued under the new epoch. Record its disposition, allocate a new dispatch ID/attempt, recompute context/policy/digest, and obtain fresh approval as required. A proven already-running session retains its original dispatch/session identities; newly authorized session-control commands have new command IDs and the new epoch, remain within the session's originally approved permissions, and do not mutate its historical envelope. Restoring or inspecting a session does not broaden its permissions.

Recovery control state and administrative audits need future versioned internal records. The limited M0 event union must not be stretched with arbitrary payloads to represent missing run pause/resume or takeover-intent events; adding public lifecycle events requires a reviewed schema revision before implementation. No missing public event permits recovery metadata to live only in memory.

## Loss, backup, and process ownership

The target node remains the owner of runtime processes and terminals through controller and TUI loss. Attachment authorization and exclusive terminal input ownership are separate from controller liveness; authorized read-only access may continue. Any input capable of causing new effects still requires its own current authorization and cannot bypass a blocked permission or frozen recovery by pretending to be a controller command. TUI detach does not terminate a session.

On ordinary controller restart, inspect the authority's current lease and durable receipts first. A still-valid lease may be used only by its authenticated holder after worker reconciliation; an expired lease needs a new epoch. The worker never launches merely because the controller's projection lacks `dispatch.started`.

On worker storage loss or corruption, quarantine new effects, keep process evidence, and reconcile with the authority and provider. An empty inbox is not evidence of non-execution. On authority loss, do not grant replacement leases from a replica or stale backup. Restore only after fencing the old authority, verifying an exclusive complete authoritative store and reconciling worker fence/receipt high-water marks. An older backup that cannot prove all acknowledged epochs/commands is insufficient; mutation remains blocked. Any administrative recovery that cannot establish this proof requires an explicit later disaster-recovery design, not a force-takeover switch.

## Failure table and verification gates

| Failure/crash point | Required result |
| --- | --- |
| Two controllers request a lease concurrently | Fixed authority transaction grants one successor; other request conflicts. No second store independently grants a lease. |
| Renewal races takeover intent | Transaction order determines final old expiry; once intent commits, every old renewal is rejected. |
| Authority crashes during lease/event/receipt writes | Atomic rollback or complete commit; retry operation ID resolves its result before another epoch is allocated. |
| Old controller is partitioned and continues sending | Workers enforce authenticated current fence and conservative expiry; no new old-epoch effects after deadline. Existing processes may continue. |
| Worker has not yet learned the new epoch | Predecessor's maximum valid interval has already elapsed; it rejects expired old commands and cannot accept new authority without proof. |
| Candidate crashes after issuance but before worker fencing | Recovery remains paused; its lease expires or is renewed by the same holder. Another takeover uses the next epoch and the same reconciliation gates. |
| Worker crashes between new-fence commit and acknowledgment | Resent fence is idempotent; durable higher epoch continues rejecting old work. |
| Worker crashes after possible runtime invocation | Effect remains uncertain; restore/query evidence, never replay a launch/prompt automatically. |
| Repeated stale or duplicated command arrives | Return permitted stored evidence or typed rejection; no side effect and no epoch rollback. |
| Old-epoch launch/prompt observation arrives late | Authenticate/deduplicate, reconcile into current history; do not infer that a replacement dispatch is safe. |
| Relevant worker is unreachable during takeover | New controller stays in recovery; run remains paused until ownership/effects are accounted for. |
| Clock jumps, drift bound is exceeded, or host resumes | Stop new effects; resynchronize and reconcile before constructing new valid deadlines. |
| Authority database missing, corrupt, or stale-restored | Fail closed; no replica promotion, epoch reset, or receipt deletion. |
| Worker loses its database but processes survive | Block new effects; reconcile sessions and receipt evidence before rejoining. |

M3 must test receipt-based controller restart and no relaunch from incomplete projections. M4 must test concurrent acquisition, renewal/takeover races, both partition directions, stale commands before/after worker restart, delayed fence acknowledgments, partial writes, clock rollback/suspend, store restoration and ambiguous in-flight effects. M0 supplies these decisions and contract fakes only. Production takeover cannot ship until these gates pass with real persistence and transport.
