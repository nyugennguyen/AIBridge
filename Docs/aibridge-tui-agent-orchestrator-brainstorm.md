# AIBridge TUI Agent Orchestrator

## Status

- **Document type:** Product brainstorm and architecture direction
- **Product:** AIBridge
- **Target:** Major upgrade from an OpenCode bridge to a distributed CLI-agent orchestrator
- **Implementation status:** Proposed
- **Primary network:** Private Tailscale mesh
- **Initial runtimes:** OpenCode, Claude Code, and Codex
- **Initial platforms:** macOS and Debian/Ubuntu

Detailed execution plans for every milestone are indexed in [`Docs/implementation-plans/README.md`](./implementation-plans/README.md).

## Executive Summary

AIBridge should evolve into a terminal-native control plane for coordinating CLI AI agents across a private network. A user opens one TUI, selects a project, creates an orchestration run, assigns versioned roles, reviews each proposed dispatch, and supervises agents running on any enrolled machine in the Tailscale mesh.

The product should not initially replace tmux or build a terminal multiplexer from scratch. Each AIBridge node should continue to run agents in durable local terminal sessions while the AIBridge controller provides the higher-level capabilities that terminal multiplexers do not own:

- Project and run orchestration
- Task dependencies and agent routing
- Role and rule management
- Human approval and permission enforcement
- Durable event history and recovery
- Shared project memory and explicit handoffs
- Secure cross-machine command and terminal access
- A normalized control surface for different CLI agent products

The first controller is selected by the user for a run. It holds a renewable controller lease and is the authoritative writer for orchestration state. If it disconnects, workers preserve their sessions but pause new dispatches until the user explicitly promotes another healthy node. This favors understandable recovery over premature distributed consensus.

## Product Thesis

AI coding agents are usually operated as isolated terminal applications. A user must remember which machine and pane owns which task, repeatedly inspect terminal output, relay context manually, and independently approve similar actions. The problem grows rapidly when work spans a laptop, workstation, and remote test or deployment machines.

AIBridge can make those agents behave like one supervised team without hiding their native interfaces or forcing every agent onto one provider. Its central abstraction is not a terminal pane; it is an approved unit of work with identity, role, policy, dependencies, memory, and an auditable result.

The concise product promise is:

> One terminal to compose, approve, observe, and guide trusted AI-agent work across every machine in your private mesh.

## Relationship to Herdr

AIBridge's TUI should take inspiration from Herdr's clear workspace hierarchy, visible agent states, persistent terminal sessions, and direct agent attachment. Herdr describes a workspace as a project-level container of tabs and panes, with agents recognized inside real terminals and summarized as states such as working, blocked, done, idle, or unknown ([Herdr concepts](https://herdr.dev/docs/concepts/)). Its automation layer also separates layout, raw pane control, and recognized-agent control ([Herdr agent automation](https://herdr.dev/docs/agent-automation/)).

This is a useful interaction model, but multi-machine presentation alone is not enough to distinguish AIBridge. Herdr also supports connecting machines and operating multiple agent kinds. AIBridge should differentiate itself through orchestration semantics:

| Concern | Herdr-inspired behavior | AIBridge responsibility |
| --- | --- | --- |
| Terminal experience | Persistent sessions, attach/detach, visible lifecycle state | Show and interact with remote native terminals without replacing their UI |
| Work model | Workspaces, tabs, panes, agents | Projects, runs, dependency-aware tasks, dispatches, and artifacts |
| Authority | User or automation controls a terminal/agent | A selected controller owns an auditable orchestration run |
| Safety | Agent-aware blocked states and direct interaction | Policy evaluation, dispatch approval, permission envelopes, and hard safety invariants |
| Context | Terminal/session history | Scoped decisions, constraints, handoffs, summaries, and provenance |
| Networking | Connected terminal machines | Tailscale-native node identity, authorization, routing, recovery, and secure command delivery |
| Extensibility | Agent detection and integrations | Runtime adapters, terminal backends, roles, rules, and workflow extensions |

A future Herdr terminal backend can be valuable, but it should remain an adapter rather than a required foundation. The orchestration core must also work with tmux and future embedded PTY backends.

## Product Principles

1. **Human authority is explicit.** The shipped default requires approval before every dispatch. Automation is introduced through visible rules, not silent behavior.
2. **A hard safety floor always wins.** User rules may narrow permissions or pre-approve bounded work, but they cannot disable identity checks, project boundaries, secret protections, or destructive-operation safeguards.
3. **Agents remain native.** Claude Code, Codex, OpenCode, and future agents keep their own terminal UI, session model, and provider features.
4. **State is replayable.** Orchestration state is derived from an append-only event history, so the TUI and a recovered controller reach the same result.
5. **Roles are snapshots.** A running dispatch keeps the exact role and rule versions it started with. Editing a template affects future work only.
6. **Memory is scoped and attributable.** Context has project/run/task/session scope, provenance, and retention rules. Raw transcripts are not broadcast by default.
7. **Network failure is normal.** Commands are idempotent, workers have durable outboxes, and reconnection reconciles known event positions.
8. **Unknown is a valid state.** An adapter must report uncertainty instead of guessing that an agent is idle or complete.
9. **Local operation remains useful.** The same orchestration model should provide value on one machine before mesh behavior is enabled.

## Conceptual Model

```text
Mesh
└── Project
    ├── Role templates
    ├── Rule sets
    ├── Project memory
    └── Run
        ├── Controller lease
        ├── Task graph
        │   └── Task
        │       └── Dispatch
        │           ├── Approval
        │           ├── Role snapshot
        │           ├── Permission envelope
        │           └── Agent session
        ├── Run memory
        ├── Artifacts
        └── Event log
```

### Mesh

A mesh is the set of enrolled AIBridge nodes reachable through the user's tailnet. Each node has a stable AIBridge identity, one or more local projects, installed agent runtimes, terminal capabilities, and current health.

### Project

A project is the top-level security and context boundary. It maps a stable project ID to explicitly allowlisted paths on one or more nodes. Rules, roles, memory, runs, and artifacts are project-scoped unless declared system-wide.

### Run

A run is one orchestration attempt toward a user goal. It owns the task graph, controller lease, role snapshots, approvals, sessions, event sequence, and final outcome. Runs are immutable historical records after completion, though they may be cloned into a new run.

### Task and Dispatch

A task describes desired work and its dependencies. A dispatch is a concrete attempt to execute a task using one agent installation on one node. Retries create new dispatch attempts rather than rewriting the previous history.

### Agent Installation and Session

An installation represents an available CLI agent runtime on a node, such as `codex` or `claude`. A session is a live or recoverable execution instance created by a dispatch. A session has both a normalized orchestration state and runtime-specific metadata.

### Role

A role is a versioned template containing purpose, instructions, capability requirements, preferred runtimes, context-selection rules, and additional permission restrictions. Examples include implementer, reviewer, QA operator, release manager, and incident investigator.

Roles are assigned per dispatch. Switching a role means choosing a different template for new work; it does not mutate a running agent's identity or instructions.

### Rule

A rule matches dispatch properties and produces policy constraints or an approval decision. Rules can inspect project, role, capability, node, runtime, command category, path, fan-out size, and time window. They cannot grant an action forbidden by the system safety floor.

### Memory

Memory is structured context, not an unrestricted transcript archive. Initial record kinds are:

- Decision
- Constraint
- Finding
- Handoff
- Summary
- Artifact reference
- User correction
- Run outcome

Each record includes scope, author, timestamps, source event, sensitivity, retention, and optional supersession metadata.

## User Experience

### Primary Flow

1. The user runs `aibr tui` on an enrolled machine.
2. The TUI connects to the local node and shows known projects and mesh health.
3. The user opens a project and creates a run with a goal.
4. The controller or user decomposes the goal into tasks and dependencies.
5. A routing proposal selects a node, runtime, role, context packet, and permission envelope for the next task.
6. The TUI presents the full dispatch proposal for approval.
7. After approval, the worker idempotently creates or resumes a terminal-backed agent session and sends the prompt.
8. Events update the task graph and agent state. If the agent blocks, the approval inbox brings it to the user's attention.
9. The user can open the embedded terminal, inspect native output, resize it, and send keyboard input.
10. Completion produces a structured result, artifacts, memory candidates, and follow-up tasks for review.

### Default Approval Experience

Every dispatch initially requires the user to review:

- Task and prompt
- Target node and project path
- Agent runtime and model information when available
- Role name and exact version
- Included memory/context summary
- Requested capabilities and tool categories
- Expected artifacts
- Timeout, retry, dependency, and fan-out behavior
- Rule evaluation and any warnings

The user may approve once, reject, edit the proposal, or create a bounded rule for similar future dispatches. Creating a rule is a separate, explicit action and displays what future work it could match.

### TUI Information Architecture

```text
┌ Projects ────────┬ Run: release-1.4 ─────────────────────────────┐
│ ● AIBridge       │ Goal: prepare, test, and review release       │
│   Web Store      │                                               │
│   Data Pipeline  │ Task graph                                    │
│                  │ [done] Plan ──▶ [working] Implement           │
│ Mesh             │                       ├──▶ [blocked] Review    │
│ ● mac-dev        │                       └──▶ [queued] Test       │
│ ● linux-vps      │                                               │
│ ◌ gpu-box        │ Agents: 1 working · 1 blocked · 1 idle        │
├──────────────────┴───────────────────────────────────────────────┤
│ Inbox: reviewer asks for permission to run integration tests    │
└──────────────────────────────────────────────────────────────────┘
```

The TUI should provide these views:

- **Projects:** Recent projects, active runs, attention counts, and mesh health.
- **Run:** Goal, task graph, progress, dispatch history, artifacts, and event timeline.
- **Agents:** Sessions grouped by task with normalized state, runtime, node, role, elapsed time, and attention status.
- **Agent detail:** Native embedded terminal, structured session metadata, context packet, permissions, and controls.
- **Approval inbox:** New dispatch proposals and blocked-agent questions ordered by urgency.
- **Roles and rules:** Version history, match previews, effective policy explanation, and safe editing.
- **Memory:** Decisions, constraints, handoffs, provenance, sensitivity, and superseded entries.
- **Audit:** Append-only events, actor identity, policy outcomes, command IDs, and error details.

Mouse interaction can supplement keyboard navigation, but every action must be keyboard-accessible. Direct terminal input must be visually distinct from TUI command mode to prevent accidental keystrokes reaching an agent.

## System Architecture

```text
                         Tailscale mesh

┌──────────────── Controller node ────────────────┐
│ AIBridge TUI                                   │
│        │ local API                             │
│ AIBridge node daemon                           │
│ ├── Orchestration kernel                       │
│ ├── Policy and approval engine                 │
│ ├── Event store + projections                  │
│ ├── Memory/context service                     │
│ ├── Runtime and terminal adapters              │
│ └── HTTP + SSE + terminal WebSocket gateway    │
└──────────────────────┬─────────────────────────┘
                       │ authenticated commands/events
           ┌───────────┴───────────┐
           ▼                       ▼
┌──────── Worker node ───────┐  ┌──────── Worker node ───────┐
│ AIBridge node daemon       │  │ AIBridge node daemon       │
│ ├── Command inbox/outbox   │  │ ├── Command inbox/outbox   │
│ ├── Runtime adapters       │  │ ├── Runtime adapters       │
│ ├── Terminal backend       │  │ ├── Terminal backend       │
│ ├── Local session metadata │  │ ├── Local session metadata │
│ └── OpenCode / Claude      │  │ └── Codex / future agents  │
└────────────────────────────┘  └────────────────────────────┘
```

### Node Daemon

Every machine runs the same daemon. A node can be a worker, a controller, or both. The daemon owns local runtime discovery, command execution, session metadata, terminal access, a durable outgoing event queue, and the existing secured HTTP bridge behavior.

### Controller Lease

The user explicitly claims control of a run. The resulting lease contains a controller node ID, run ID, epoch, issuance time, and expiry. Workers accept orchestration commands only from the current epoch and reject stale controllers.

Workers heartbeat the controller lease but do not automatically elect a replacement in the initial release. When the lease expires:

- Existing agent processes continue running.
- Terminal attachments may remain available directly on their owning nodes.
- No new dispatch, retry, role change, or policy mutation is accepted.
- Workers append observations to their durable outboxes.
- A user can claim a higher epoch from another healthy node and reconcile outstanding events before resuming.

### Persistence

The controller uses SQLite in WAL mode as the source of truth for an append-only event log and transactional projections. Bun's SQLite support keeps the first implementation within the existing TypeScript/Bun stack.

Workers maintain a small local store for session ownership, processed command IDs, controller epoch, and unsent events. The current JSON job store can remain readable during migration, but new orchestration runs should use the event store.

Core event fields include:

```ts
interface OrchestrationEvent<TType extends string, TPayload> {
  eventId: string
  sequence: number
  projectId: string
  runId: string
  type: TType
  payload: TPayload
  actor: { kind: "user" | "node" | "agent" | "system"; id: string }
  commandId?: string
  causationId?: string
  correlationId?: string
  occurredAt: string
  schemaVersion: number
}
```

Sequences are authoritative within a run. Commands carry stable IDs and desired controller epochs. Re-delivery returns the original result instead of executing twice.

### Control Protocols

- **HTTP:** Commands, queries, enrollment, health, artifacts, and compatibility endpoints.
- **SSE:** Ordered project/run/session events for the TUI and controller projections.
- **WebSocket:** Authenticated bidirectional terminal bytes, resize messages, focus ownership, and disconnect signals.
- **Existing trigger/report API:** Retained behind a compatibility translation layer while callers migrate to run/task/dispatch commands.

Terminal streams are not orchestration history. The audit log records attach/detach identity and control actions, while transcript retention follows an explicit project policy.

## Runtime and Terminal Abstractions

### Agent Runtime Adapter

```ts
type AgentLifecycleState =
  | "starting"
  | "idle"
  | "working"
  | "blocked"
  | "completed"
  | "failed"
  | "unknown"

interface AgentRuntimeAdapter {
  readonly kind: string
  detect(nodeContext: NodeContext): Promise<AgentInstallation[]>
  launch(request: LaunchAgentRequest): Promise<RuntimeSession>
  restore(reference: RuntimeSessionReference): Promise<RuntimeSession>
  prompt(session: RuntimeSession, request: PromptRequest): Promise<void>
  observe(session: RuntimeSession): AsyncIterable<AgentRuntimeEvent>
  respond(session: RuntimeSession, response: AgentResponse): Promise<void>
  interrupt(session: RuntimeSession): Promise<void>
  terminate(session: RuntimeSession): Promise<void>
  collectResult(session: RuntimeSession): Promise<AgentResult>
}
```

Adapter behavior must be capability-based. An adapter reports whether it supports structured permissions, native session restore, reliable completion, model selection, usage data, hooks, and transcript export. Callers must not assume every adapter provides every feature.

Initial adapters:

- **OpenCode:** Use the existing SDK/server integration as the structured reference adapter.
- **Claude Code:** Launch in a terminal, prefer supported lifecycle hooks where available, and use conservative terminal state detection as fallback.
- **Codex:** Launch in a terminal, consume supported notifications or session metadata where available, and use conservative terminal state detection as fallback.

Terminal screen matching must never be treated as proof of successful completion. If output cannot be classified confidently, the adapter reports `unknown` and requests inspection.

### Terminal Backend

```ts
interface TerminalBackend {
  readonly kind: string
  create(request: CreateTerminalRequest): Promise<TerminalReference>
  attach(reference: TerminalReference): Promise<TerminalChannel>
  resize(reference: TerminalReference, columns: number, rows: number): Promise<void>
  snapshot(reference: TerminalReference): Promise<TerminalSnapshot>
  detach(reference: TerminalReference, clientId: string): Promise<void>
  terminate(reference: TerminalReference): Promise<void>
  recover(): Promise<TerminalReference[]>
}
```

tmux is the initial backend because AIBridge already installs and supervises it. The adapter should isolate tmux commands from the orchestration domain so a Herdr or embedded PTY backend can be added later.

Only one client owns terminal input at a time. Additional clients are read-only until they request an explicit takeover. TUI command mode and terminal input mode use a visible border/status change and an escape sequence that is not forwarded to the agent.

## Roles, Rules, and Safety

### Role Template

```ts
interface RoleTemplate {
  id: string
  version: number
  name: string
  purpose: string
  instructions: string
  requiredCapabilities: string[]
  preferredRuntimes: string[]
  contextPolicyId: string
  permissionRestrictions: PermissionRestriction[]
  createdBy: string
  createdAt: string
}
```

The approved dispatch stores the entire effective role snapshot or its immutable content hash, not only a mutable role ID.

### Dispatch Envelope

```ts
interface DispatchEnvelope {
  dispatchId: string
  attempt: number
  projectId: string
  runId: string
  taskId: string
  targetNodeId: string
  agentKind: string
  projectPathId: string
  prompt: string
  roleSnapshot: RoleTemplate
  contextManifest: ContextManifest
  requestedCapabilities: string[]
  permissionEnvelope: PermissionEnvelope
  dependencies: TaskDependency[]
  timeoutSeconds: number
  controllerEpoch: number
}
```

Approval binds to a digest of the envelope. Any change to the prompt, role, target, context, permissions, timeout, or dependencies invalidates approval and creates a revised proposal.

### Policy Precedence

Policy evaluation is deterministic and explainable:

1. System safety floor
2. Project rules
3. Role restrictions
4. Dispatch-specific restrictions

Each layer may deny or restrict. Only project rules may pre-approve an otherwise permitted dispatch, and only when the user explicitly enables that rule. Later layers cannot restore a capability removed by an earlier layer.

The immutable system floor includes:

- Authenticated node and controller identity
- Exact project/path allowlisting
- Rejection of stale controller epochs
- Secret redaction and no secret inclusion in logs or memory
- No silent permission expansion after approval
- No execution outside the approved node, path, role, and capability envelope
- Explicit handling of destructive commands and external side effects
- Idempotency for remotely delivered commands

### Example Rules

- Require manual approval for every dispatch: shipped default.
- Pre-approve read-only review tasks using the reviewer role inside one project.
- Allow integration tests only on `linux-vps`, never on the development laptop.
- Deny deployment capabilities outside a defined time window.
- Limit fan-out to two agents unless separately approved.
- Require a successful reviewer task before a deployment task becomes eligible.

## Memory and Context Assembly

The controller assembles a context packet for each dispatch from explicitly selected sources. A packet contains references and summaries rather than automatically copying every prior conversation.

Context selection order:

1. System safety instructions
2. Approved dispatch envelope and role snapshot
3. Project constraints and active decisions
4. Dependency results and relevant handoffs
5. Task-specific files or artifact references
6. Bounded run summary

Every context item includes a source record ID and content hash. Sensitive records may be excluded from remote nodes or reduced to a redacted summary. Agents can propose memory entries, but proposed entries are marked untrusted until accepted by a rule or user.

Memory conflicts do not overwrite history. A new decision can supersede an older one while preserving both records and the event that authorized the change.

## Example Orchestration Scenarios

### Development, Review, and Test

1. An implementer role on the development workstation changes code.
2. A reviewer role on another node reviews the diff without write permission.
3. A QA role on a Linux VPS runs integration tests after both prior tasks succeed.
4. Findings and artifacts return to the run, and the controller proposes follow-up work.

### Incident Response

1. An investigator receives read-only logs and a bounded production capability.
2. A second agent independently tests the leading hypothesis in staging.
3. Any remediation dispatch requires a new approval with the exact command and target.
4. The final timeline, decisions, commands, and artifacts remain auditable.

### Research Swarm

1. A coordinator decomposes a question into independent research tasks.
2. User rules cap fan-out, runtime cost, and allowed network access.
3. Researcher agents return structured findings with source provenance.
4. A synthesizer receives accepted findings, not all raw transcripts.

## Delivery Milestones

### Milestone 0: Architecture and Migration Contracts

**Goal:** Freeze vocabulary and boundaries before expanding the current implementation.

Deliverables:

- Architecture decision records for event sourcing, controller leases, node identity, and terminal streaming
- Versioned schemas for nodes, projects, runs, tasks, dispatches, approvals, roles, rules, memory, and events
- `AgentRuntimeAdapter` and `TerminalBackend` contracts
- Mapping from current jobs, triggers, reports, tasks, memory, permissions, registry, and OpenCode sessions
- Compatibility and data-migration strategy for existing profiles and JSON job state
- Threat model covering controller compromise, stale commands, path escape, terminal takeover, replay, secret leakage, and split brain

Exit criteria:

- All new concepts have one canonical name and owner.
- A legacy trigger can be mapped to a single-task run without losing authorization data.
- Security boundaries and non-overridable invariants are documented and tested at the schema level.

### Milestone 1: Single-Node TUI Vertical Slice

**Goal:** Prove the complete user loop locally with the existing OpenCode integration.

Deliverables:

- `aibr tui` entry point using TypeScript/Bun
- Project and run navigation
- One-task run creation and dispatch proposal
- Default approval-before-dispatch flow
- OpenCode session state and structured result display
- tmux terminal backend and embedded attach view
- Clear TUI command mode versus terminal input mode

Exit criteria:

- A user can create, approve, watch, interact with, and complete an OpenCode task without leaving AIBridge.
- Closing and reopening the TUI does not stop the agent.
- Terminal resize, detach, read-only viewing, and explicit input takeover behave predictably.

### Milestone 2: Multi-Runtime Adapter Layer

**Goal:** Demonstrate that orchestration is independent of one agent provider.

Deliverables:

- Extracted OpenCode adapter
- Claude Code terminal adapter
- Codex terminal adapter
- Runtime discovery and capability reporting
- Normalized lifecycle and permission events
- Shared adapter conformance suite
- Conservative fallback behavior for unsupported or uncertain states

Exit criteria:

- OpenCode, Claude Code, and Codex can each run the same approved task lifecycle.
- Runtime-specific capabilities are visible in routing and approval screens.
- An ambiguous terminal screen results in `unknown`, never a false completion.

### Milestone 3: Orchestration Kernel

**Goal:** Replace imperative job coordination with durable, explainable runs.

Deliverables:

- SQLite/WAL event store and deterministic projections
- Task graph with dependency validation and cycle rejection
- Dispatch attempts, retry, cancellation, timeout, and idempotent command handling
- Versioned roles and immutable role snapshots
- Policy evaluation with explanations
- Approval bound to the dispatch-envelope digest
- Run timeline, audit view, and artifact index

Exit criteria:

- Replaying events rebuilds identical run, task, session, and approval views.
- Duplicate commands cannot create duplicate agent sessions or prompts.
- Modifying an approved envelope invalidates approval.
- Failed dependencies block or fail downstream work according to an explicit task policy.

### Milestone 4: Distributed Tailscale Mesh

**Goal:** Operate the orchestration model safely across machines.

Deliverables:

- Node enrollment, stable identity, and revocation
- Runtime/project capability heartbeats
- User-selected controller lease and epoch enforcement
- Durable worker command inbox and event outbox
- Authenticated HTTP, SSE, and terminal WebSocket channels
- Reconnect reconciliation from known event and command positions
- Manual controller takeover workflow
- Compatibility translation for current `/trigger` and `/report` clients

Exit criteria:

- A controller can dispatch to at least two worker nodes through Tailscale.
- Network interruption does not duplicate work or lose terminal sessions.
- Workers reject expired or stale-epoch commands.
- After controller loss, new dispatches pause until takeover and then resume from reconciled state.

### Milestone 5: Shared Memory and Context Engineering

**Goal:** Give agents useful continuity without uncontrolled context sharing.

Deliverables:

- Structured, scoped memory records
- Provenance, content hashes, sensitivity, retention, and supersession
- Agent-proposed versus trusted memory states
- Deterministic context manifests and size budgets
- Handoff packets and dependency-result summaries
- Secret scanning and redaction before persistence or transmission
- TUI memory and context-inspection views

Exit criteria:

- Every prompt context item can be traced to its source.
- A project cannot read another project's memory.
- Sensitive entries obey node and role restrictions.
- Reassembling the same approved dispatch produces the same context manifest.

### Milestone 6: Rules, Automation, and Reusable Workflows

**Goal:** Let users reduce repetitive approvals without losing control.

Deliverables:

- Rule builder with match preview and effective-policy explanation
- Bounded pre-approval rules
- Reusable run templates and role packs
- Fan-out limits, cost/time budgets, concurrency limits, and routing preferences
- Dry-run simulation showing proposed tasks, targets, policies, and approvals
- Notifications for blocked agents, failed runs, and expiring controller leases

Exit criteria:

- Users can preview every dispatch a rule would match before enabling it.
- Rules cannot cross the system safety floor.
- Disabling a rule affects future proposals without mutating active role or approval snapshots.

### Milestone 7: Hardening and Ecosystem

> **Renumbered to Milestone 8.** Milestone 7 is now
> [Polyglot ingress and durable admission](./implementation-plans/milestone-7-polyglot-ingress.md),
> inserted per [ADR 0008](./adr/0008-polyglot-ingress-and-admission.md). The
> executable plans in `Docs/implementation-plans/` are authoritative for
> numbering; the section below is retained as the original product direction.

**Goal:** Prepare AIBridge for broader adoption and runtime expansion.

Deliverables:

- Crash, storage-corruption, and upgrade recovery procedures
- Structured logs, metrics, diagnostics bundle, and audit export
- Adapter/plugin SDK and compatibility tests
- Optional Herdr terminal backend experiment
- Packaging and upgrade migration for supported platforms
- Performance limits for nodes, concurrent sessions, event volume, terminal streams, and artifact size
- Additional runtime adapters selected from real user demand

Exit criteria:

- Upgrade and rollback preserve existing profiles and run history.
- A third party can implement an adapter using documented contracts and pass the conformance suite.
- Load and failure tests establish supported operating limits.

## Testing Strategy

### Unit Tests

- Event serialization, schema migration, and deterministic projection
- Role snapshot and dispatch digest generation
- Rule matching, precedence, and hard-floor enforcement
- Dependency graph validation and transition rules
- Context selection, provenance, retention, and redaction
- Runtime state normalization and uncertainty handling
- Command idempotency and controller epoch validation

### Contract Tests

Every runtime adapter must pass the same scenarios:

- Detect installation and report capabilities
- Launch and restore a session
- Submit exactly one prompt for one command ID
- Observe working, blocked, terminal, failed, and unknown conditions
- Interrupt and terminate safely
- Collect a structured result or explicitly report unsupported behavior

Every terminal backend must pass:

- Create, attach, snapshot, resize, detach, recover, and terminate
- Preserve the terminal when the TUI disconnects
- Enforce one input owner and read-only secondary clients
- Avoid leaking terminal data across project or node identities

### Integration Tests

- Approval, rejection, editing, and approval invalidation
- Retry and timeout with multiple dispatch attempts
- Worker disconnect/reconnect and outbox replay
- Controller lease expiry and manual takeover
- Duplicate and out-of-order network messages
- Terminal attachment, resizing, takeover, and reconnect
- Legacy trigger/report translation
- Secret and cross-project isolation

### End-to-End Acceptance

The release candidate must run a project across at least two Tailscale nodes and complete a dependency chain using OpenCode, Claude Code, and Codex. The scenario must include one rejected dispatch, one blocked-agent interaction, one network interruption, controller takeover, artifact collection, and replay of the final run from its event log.

## Security and Privacy Considerations

- Bind node services only to approved Tailscale interfaces or loopback.
- Give every node a revocable identity; do not rely indefinitely on one mesh-wide bearer token.
- Authenticate the user separately from node-to-node commands.
- Keep runtime provider credentials on the worker that owns them.
- Send context by explicit manifest and apply sensitivity restrictions before transmission.
- Never store secrets, bearer tokens, raw credentials, or unredacted environment values in events.
- Validate project paths after resolving symlinks and before starting every process.
- Record policy decisions and envelope digests, not secret values.
- Treat terminal access as privileged interactive control and log attachment ownership changes.
- Bound request bodies, terminal buffers, artifacts, event payloads, fan-out, concurrency, and retries.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Terminal screen scraping is fragile | Prefer native APIs/hooks, expose adapter confidence, and preserve `unknown` |
| A custom TUI becomes a multiplexer project | Keep terminal ownership behind tmux first and restrict AIBridge to attach/stream controls |
| Controller loss creates split brain | Use run-scoped epochs, expiring leases, paused dispatch, and manual takeover |
| Shared memory spreads secrets or stale facts | Scope records, require provenance, redact, retain history, and support supersession |
| Rules create invisible autonomy | Default to approval, show match previews, explain decisions, and keep immutable safety rules |
| Cross-agent behavior differs widely | Use capability negotiation and conformance tests rather than lowest-common-denominator claims |
| Event sourcing increases complexity | Start with one local vertical slice, keep projections small, and test full replay from the beginning |
| Product overlaps with Herdr | Focus on governed workflows, memory, approvals, and mesh orchestration; allow Herdr as a backend |

## Non-Goals for the Initial Releases

- Replacing tmux with a new terminal emulator or multiplexer
- Automatic controller election or distributed consensus
- Running nodes over the public internet without Tailscale
- A hosted cloud relay or multi-tenant control plane
- Windows support
- Live mutation of a running agent's role
- Automatic trust of agent-generated memory
- Guaranteed feature parity across all CLI agent products
- Autonomous production deployment without explicit policy and approval
- Copying complete transcripts into every agent prompt

## Measures of Success

- A new user can enroll two nodes and complete a remote approved task without constructing HTTP requests manually.
- The TUI always shows which runs and agents require human attention.
- The same run state can be reconstructed from the event log after a controller restart.
- A network retry never produces duplicate sessions or duplicate prompts.
- Users can explain why a dispatch was allowed, denied, or required approval.
- Adding a new runtime does not change orchestration-domain code.
- Project context is useful across handoffs without leaking secrets or unrelated transcripts.
- A controller failure pauses safely and can be recovered through an understandable manual workflow.

## Recommended First Release Boundary

The first product release should include Milestones 0 through 4: the contracts, a usable local TUI, three runtime adapters, the durable orchestration kernel, and controlled operation across a Tailscale mesh. Shared memory should initially carry forward AIBridge's existing decisions, constraints, and handoffs through a compatibility projection.

Milestones 5 and 6 should follow after real runs reveal which memory and automation features users repeatedly need. Milestone 7 is an ongoing hardening and ecosystem track rather than a reason to delay the first useful release.

This boundary produces a coherent product: a user can see the mesh, define work, approve an exact dispatch, operate the native agent terminal, survive disconnection, and review a durable run history. It avoids claiming a universal autonomous agent platform before the underlying safety and recovery model has been proven.
