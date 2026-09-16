# Milestone 4: Distributed Tailscale Mesh

## Objective

Extend the orchestration kernel across trusted Tailscale-connected nodes with revocable node identity, capability heartbeats, controller leases, idempotent command delivery, durable worker outboxes, authenticated event/terminal streams, reconnect reconciliation, and manual controller takeover.

## Prerequisites

- Milestone 3 passes replay and crash-boundary tests.
- Local runtime dispatch is idempotent by stable dispatch/command ID.
- Current Tailscale-only binding and project allowlist protections remain enforced.
- The threat model has assigned mitigations for identity, replay, stale controller, terminal takeover, and resource exhaustion.

## Fixed Protocol Choices

- Keep Fastify for HTTP APIs.
- Use SSE for ordered orchestration events and `@fastify/websocket` for terminal streaming. WebSocket authentication runs in Fastify request hooks before upgrade; message validation and output transformation remain handler responsibilities after upgrade ([Fastify WebSocket documentation](https://github.com/fastify/fastify-websocket)).
- Use application-level node identity and revocation in addition to Tailscale reachability. Initial enrollment exchanges a one-time code over an already authenticated local/admin flow and pins a generated node key.
- Use user-initiated, run-scoped controller takeover; do not implement automatic election.

## Agent Plan

| Task | Dependency | Sub-agent and model | Deliverable | Verification |
| --- | --- | --- | --- | --- |
| M4.1 Wire protocol and failure semantics | M3 | `architect` — `gpt-6-astra xhigh` | Versioned enrollment, heartbeat, command, ack, event, lease, reconciliation, and terminal-stream protocols | Sequence diagrams cover retries, partitions, restart, stale epoch, and version mismatch |
| M4.2 Node identity and enrollment | M4.1 | `subsystem-builder` — `gpt-5.6-sol high` | Key generation/storage, one-time enrollment, peer pinning, revocation, and identity middleware | Forgery, replay, expiry, revocation, and permission tests |
| M4.3 Node registry and capabilities | M4.1–M4.2 | `feature-builder` — `gpt-5.6-terra high` | Health/runtime/project capability heartbeat with TTL and stale state | Clock-controlled expiration and reconnect tests |
| M4.4 Controller lease and epoch enforcement | M4.1–M4.2 | `subsystem-builder` — `gpt-5.6-sol high` | Claim, renew, expire, pause, higher-epoch takeover, worker rejection | Partition and stale-controller model tests |
| M4.5 Durable command inbox/event outbox | M4.1, M4.4 | `subsystem-builder` — `gpt-5.6-sol high` | Worker persistence, dedupe, ordered ack, retry/backoff, poison handling | Crash at every persistence/delivery boundary |
| M4.6 SSE event gateway and reconciliation | M4.3–M4.5 | `feature-builder` — `gpt-5.6-terra high` | Cursor-based event streaming, resume, bounded retention, snapshot fallback | Disconnect/gap/out-of-order/version tests |
| M4.7 Terminal WebSocket gateway | M4.2, M4.4 | `subsystem-builder` — `gpt-5.6-sol high` | Authenticated attach, binary frames, resize, ownership, takeover, limits, cleanup | `injectWS` tests plus two-node terminal smoke test |
| M4.8 TUI mesh and takeover UX | M4.3–M4.7 | `feature-builder` — `gpt-5.6-terra high` | Node health, remote sessions, degraded state, reconciliation, takeover confirmation | Reducer scenarios for every lease/network state |
| M4.9 Two-node fault harness | M4.4–M4.8 | `test-engineer` — `gpt-5.6-sol high` | Deterministic proxy/fault injection for delay, drop, duplicate, reorder, partition, restart | Acceptance scenario succeeds without duplicate work |
| M4.10 Protocol/security audit | All | `security-reviewer` — `gpt-6-astra xhigh` | Identity, crypto use, replay, authorization, terminal, DoS, and logging review | All blocker/high findings closed; protocol version frozen |

## Protocol Requirements

### Commands

- Carry protocol version, command ID, project/run/dispatch IDs, target node, controller node, controller epoch, issued/expiry times, and payload digest.
- Are authenticated and authorized before persistence.
- Are persisted before acknowledgement.
- Return the stored result when command ID repeats with identical digest.
- Are rejected as conflict when the same command ID has a different digest.

### Worker Events

- Carry stable event ID, source node, command correlation, local sequence, observed time, and schema version.
- Enter a durable outbox before transmission.
- Remain until controller acknowledgement is persisted.
- May be resent; controller ingestion is idempotent.

### Controller Lease

- Is scoped to one run and one monotonically increasing epoch.
- Requires periodic renewal before expiry.
- Prevents new dispatch/retry/policy mutation after expiry.
- Does not kill existing agents on expiry.
- Takeover requires the user to inspect unreconciled nodes and explicitly accept degraded nodes or wait for them.

### Reconciliation

1. Authenticate node and compare protocol versions.
2. Exchange controller epoch and last acknowledged inbox/outbox positions.
3. Reject stale-controller traffic.
4. Resend unacknowledged commands/events idempotently.
5. Compare active session inventory against dispatch projections.
6. Mark unexplained differences for user review; do not silently adopt or terminate.

## Terminal Stream Guardrails

- Authenticate and authorize before WebSocket upgrade.
- Revalidate project/session access and controller epoch when granting input ownership.
- Separate control frames from terminal data and cap frame size/rate.
- Allow multiple viewers but one input owner.
- Require explicit takeover and notify the displaced client.
- Apply backpressure and bounded buffers; slow clients lose frames or reconnect from snapshots rather than exhausting memory.
- Never write terminal content into structured application logs.
- Close ownership on disconnect, revocation, lease expiry, or session termination.

## Completion Criteria

- At least two nodes can enroll, advertise capabilities, and execute a run over Tailscale.
- Node identity is individually revocable; a revoked node cannot reconnect or stream a terminal.
- Duplicate/reordered commands and events converge without duplicate sessions/prompts.
- Worker restart preserves inbox/outbox and active-session references.
- Lease expiry pauses new orchestration but preserves existing processes.
- Manual takeover uses a higher epoch and stale controllers are rejected.
- SSE resumes from a cursor or uses an explicit snapshot fallback.
- Remote terminal attach, resize, read-only viewing, input ownership, and takeover work under bounded resources.
- The two-node fault-injection acceptance suite passes.
- Security review approves identity, authorization, replay defense, and logging behavior.

## Guardrails and Stop Conditions

- Tailscale reachability is not sufficient authentication.
- Do not reuse the current shared bearer token as permanent per-node identity.
- Do not implement auto-election, quorum, gossip, or consensus.
- Do not accept a higher controller epoch without the explicit takeover flow.
- Do not terminate agents because a controller or network disappeared.
- Do not retry remote launch until worker-side command persistence and dedupe are proven.
- Stop if terminal output can enter logs, events, or another project stream.
- Stop release if any partition test permits two controllers to create new work for the same run.

## Gate Verification

```bash
bun test tests/unit/mesh
bun test tests/unit/protocol
bun test tests/integration/mesh-flow.test.ts
bun test tests/integration/controller-takeover.test.ts
bun test tests/integration/terminal-websocket.test.ts
bun run typecheck
bun test
bun run build
git diff --check
```

The gate report contains the protocol version, enrollment/revocation procedure, partition matrix, takeover evidence, resource limits, and two-node acceptance transcript with secrets removed.

