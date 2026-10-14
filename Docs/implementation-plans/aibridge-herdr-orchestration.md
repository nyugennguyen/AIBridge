# AIBridge × Herdr — Orchestration Architecture Implementation Plan

- **Status:** Approved for execution
- **Date:** 2026-10-11
- **Supersedes:** `Docs/adr/0009-herdr-terminal-backend-evaluation.md` (partially — see §2)
- **Target version:** `3.0.0` (breaking: `aibr-tui` retired, config schema gains `charter`)
- **Scope:** `src/` (TypeScript/Bun), `crates/` (Rust, reduced), new fork repo, two new plugin repos
- **Structure:** **Part A** (§1–§15) is the orchestration architecture → `3.0.0`. **Part B** (§16) is independent setup/security work → `2.2.0`, and **ships first**.

---

## 1. Purpose

Turn AIBridge from a *job-relay bridge* into a **multi-agent orchestration runtime** whose operator surface is Herdr, whose authority is the AIBridge kernel, and whose agents can deliberate with each other before acting.

Four things change:

1. **Herdr becomes the TUI.** `aibr-tui` is retired; Herdr is the operator surface for local and remote agents.
2. **The kernel becomes the backbone** for agent-to-agent communication.
3. **Roles become multi-role assignments**, and a **Charter** becomes the single editable system prompt governing the whole orchestration.
4. **A Roundtable** lets agents discuss a task before it is executed — advisory, never authoritative.

---

## 2. Relationship to ADR 0009

ADR 0009 deferred Herdr **as a `TerminalBackend`** — Herdr owning PTYs that AIBridge drives headlessly. This plan **inverts** that relationship: Herdr is presentation + terminal substrate; the kernel remains sole authority. ADR 0009's objections resolve as follows:

| ADR 0009 objection | Resolution |
|---|---|
| §2.1 Impedance mismatch (panes no human views) | Every pane is now a human-visible agent. Mismatch gone. |
| §2.2 Competing state authority | Herdr is a projection consumer — the same role as its own TUI client. Kernel remains sole authority. |
| §2.3 Input ownership fencing (SF-10) | **Unresolved → becomes fork change F1.** This is the load-bearing reason to fork. |
| §2.4 Transient pane IDs | Solved by `pane.report_agent_session` + `resume_argv`, and by F2 making `role` a first-class durable field. |
| §2.5 Distribution impact | Herdr is a detected user-installed binary (`brew install herdr`), never an npm dependency. ADR 0009's constraint is met literally. |
| §2.6 Privilege | Acceptable: AIBridge runs unprivileged inside Herdr panes; tmux remains the headless fallback. |

**This plan satisfies ADR 0009's Revisit Condition #1 verbatim** ("Herdr publishes a stable, versioned daemon IPC protocol with atomic input-ownership fencing primitives") via fork change F1. A new **ADR 0011** supersedes the decision and records the amended relationship.

---

## 3. Locked decisions

| # | Question | Decision |
|---|---|---|
| 1 | Herdr vs `aibr-tui` | **Herdr replaces `aibr-tui`.** The Rust ratatui TUI, the OpenTUI fallback in `src/tui/`, and the TUI half of `src/ipc/` are retired. `crates/aibr-pty` and `crates/aibr-ipc` survive as the headless substrate for the router and worker. |
| 2 | Remote over Tailscale | **Keep both paths.** (a) Herdr SSH machine federation for remote *terminals*; (b) AIBridge mesh projection for remote *orchestration state*. |
| 3 | Charter edits | **Agent-proposable.** Agents may propose charter revisions; every proposal is gated by an approval path and blocked from touching the immutable core (§7.3). |
| 4 | Roundtable | **Advisory.** A discussion produces a recommendation and an audited transcript. It never causes a state transition directly. Execution dispatch may be *required by rule* to have a closed discussion. |

---

## 4. Current state

### 4.1 What already exists (and is reused, not rebuilt)

| Capability | Location |
|---|---|
| Mesh protocol, 11 record types, controller/worker, leases, epochs | `src/mesh/` |
| Event-sourced kernel: run/task/dispatch/session, `SqliteEventStore`, coordinator, projections | `src/orchestration/` |
| Role templates, snapshots, digests, versioned repository | `src/orchestration/roles/` |
| Rule language, layered policy with a `SAFETY_FLOOR` built outside caller input | `src/rules/`, `src/orchestration/policy/` |
| Budget ledger (concurrency and fan-out as separate counters) | `src/budgets/` |
| Scoped memory + redaction | `src/memory/` |
| Deterministic context assembler + isolation auditor | `src/context/` |
| SSE event gateway (the only place an event gets a total order) | `src/mesh/gateway/events/` |
| Terminal WebSocket gateway (attach, ownership, takeover, detach) | `src/mesh/gateway/terminal/` |
| Runtime adapters (opencode, claude, codex) + conformance kit | `src/runtime/` |
| tmux terminal backend | `src/terminal/tmux-terminal-backend.ts` |
| Routing stages | `src/routing/` |
| CLI, profiles, setup wizard, preflight, diagnostics | `src/cli.ts`, `src/host/`, `src/cli/`, `src/diagnostics/` |

### 4.2 What is missing or dead (and must change)

| Gap | Evidence | Fix |
|---|---|---|
| `AgentRegistry` / `ConfigAgentRegistry` / `CapabilityRouter` wired into nothing | `src/registry/*.ts` — no production caller | Rewire to read the mesh registry + role catalog (Phase 1) |
| `session.prompt` is a stub with an empty event allowlist | `coordinator/coordinator.ts:235`, `coordinator/types.ts:102` | Implement as the primary agent-prompt path (Phase 1) |
| No fan-out dispatch — `maximumFanOut` is policy-only | `src/rules/evaluate.ts:1581`, `src/budgets/types.ts:408` | Implement N-sibling dispatch (Phase 1) |
| No role → runtime binding | `preferredRuntimeKinds` stored and filtered, never bound | `RoleBinder` (Phase 1) |
| No orchestration-wide system prompt | Only `OpencodePromptPolicy.system`, compiled in `runtime/opencode-adapter.ts:413` | Charter (Phase 1) |
| **No conversational primitive at all** | `grep discussion\|debate\|roundtable\|consensus` → 2 hits, both *negative* | Roundtable (Phase 1) |
| Remote dependency bug: a missing local dep reads `"missing"` → `waiting` **forever** | `src/jobs/manager.ts` `dependencyOutcome` | Fix before anything builds on it (Phase 0) |
| No input-ownership fencing over the Herdr socket | Herdr 0.9.3 public API | Fork change F1 (Phase 2) |
| Role not representable natively in Herdr | only a metadata token | Fork change F2 (Phase 2) |

### 4.3 Stack after this plan

```
Herdr fork (Rust)  ── terminal substrate + input fencing + first-class role
  └── aibr-manager plugin (bun + OpenTUI)  ── role grid, charter editor, roundtable view
  └── aibr-herdr-bridge plugin (bun)       ── mesh → Herdr projection

AIBridge kernel (Bun/TS) ── sole authority: charter, roles, roundtable, dispatch, rules, budgets
  └── HerdrTerminalBackend (new)  ── beside TmuxTerminalBackend, not replacing it

Rust: aibr-router (unchanged), crates/aibr-pty + aibr-ipc (headless substrate)   [aibr-tui REMOVED]
```

---

## 5. Target architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  HERDR FORK                                                                   │
│  server: owns panes & processes · SSH machine federation over Tailscale       │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  aibr-manager  (plugin pane: overlay / popup / split / tab / zoomed)   │  │
│  │   · Role grid — assign agents ↔ roles, multi-role, primary/secondary   │  │
│  │   · Charter editor — orchestration system prompt, proposal + approval  │  │
│  │   · Roundtable — live transcript, human injection, membership          │  │
│  │   · Multi-machine grid — local + all Tailscale nodes in one view       │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│    │ agent prompt --wait · agent wait · agent read            ▲ pane.report  │
│    ▼                                                          │ _agent +     │
│  ┌──────────────────────────────┐                            │ _metadata    │
│  │ Panes: one real terminal     │────────────────────────────┘ (tokens:     │
│  │ per agent                    │   $role $run $task $discussion $node)     │
│  │ claude · codex · opencode ·  │                                         │
│  │ cursor · grok · …            │                                         │
│  └──────────┬───────────────────┘                                         │
└─────────────┼─────────────────────────────────────────────────────────────┘
              │ agent prompt = fallback only (TUI-only runtimes)
    ┌─────────▼───────────────────────────────────────────────────────────┐
    │  AIBRIDGE KERNEL — sole authority                                   │
    │                                                                    │
    │   ┌──────────────┐  ┌───────────────┐  ┌──────────────────────────┐ │
    │   │   CHARTER    │  │ ROLEASSIGNMENT│  │       ROUNDTABLE         │ │
    │   │  versioned   │  │  multi-role   │  │  advisory, relayed thru  │ │
    │   │  + immutable │  │  ∩ capability│  │  controller, event-sourced│ │
    │   │    core      │  │   envelope    │  │                          │ │
    │   └──────────────┘  └───────────────┘  └──────────────────────────┘ │
    │                                                                    │
    │   orchestration/ · mesh/ · rules/ · budgets/ · memory/ · routing/   │
    └──────┬───────────────────────────────┬─────────────────────────────┘
           │ mesh.command / mesh.event     │ SSE event gateway (total order)
           │ over Tailscale                │
    ┌──────▼───────────┐          ┌────────▼────────────────────────────┐
    │ Remote node B    │          │  Any client: live transcripts,     │
    │ aibr worker +    │          │  run state, approval queues        │
    │ herdr panes      │          │                                    │
    └──────────────────┘          └────────────────────────────────────┘
```

**The invariant that makes this safe:** *Herdr owns the terminal. AIBridge owns the intent. Never both, never either.* Kernel decides who is asked what, in what order, under which role, with which budget. Herdr decides where the pixels go and which process owns keystrokes.

---

## 6. New kernel concepts

All three are kernel-level, event-sourced, digest-stamped, and versioned — following the existing discipline of `orchestration/roles/`.

### 6.1 Charter — the orchestration system prompt

```ts
// src/orchestration/charter/types.ts
export interface Charter {
  readonly charterId: string
  readonly version: number
  readonly purpose: string
  readonly globalRules: readonly string[]        // bounded, ARRAY_MAX
  readonly communicationPolicy: CommunicationPolicy
  readonly escalationPolicy: EscalationPolicy
  readonly roleCatalog: readonly CharterRoleRef[]
  readonly immutableCoreDigest: Digest          // stamped at creation, never changes
  readonly snapshotDigest: Digest
  readonly capturedAt: Timestamp
  readonly author: CharterAuthor                  // human | agent
}

export interface CommunicationPolicy {
  readonly turnTaking: "chair_ordered" | "free_for_all"
  readonly objectionRequiredBefore: readonly string[]   // dispatch kinds needing a closed roundtable
  readonly verbosity: "terse" | "normal" | "detailed"
  readonly mustStopAndAsk: readonly string[]            // conditions that forbid guessing
  readonly objectionMustContain: readonly string[]      // required fields of an objection post
}

export interface EscalationPolicy {
  readonly maxRounds: number
  readonly onDeadlock: "chair_decides" | "human_decides" | "fail_run"
  readonly budgetScope: "shared" | "per_member"
}
```

### 6.2 RoleAssignment — multi-role

```ts
export interface RoleAssignment {
  readonly roleId: string
  readonly primary: boolean
  readonly addendum?: string          // secondary-only contribution, bounded
}
// Exactly one primary per assignment. Secondaries contribute addenda, not full instructions.
```

### 6.3 Roundtable — advisory deliberation

```ts
export type DiscussionMode = "sequential" | "parallel" | "until_objections_resolved"
export type PostKind = "proposal" | "objection" | "question" | "answer" | "note"

export interface Roundtable {
  readonly id: string
  readonly runId: RunId
  readonly taskId?: TaskId
  readonly subject: string
  readonly mode: DiscussionMode
  readonly chairNodeId: NodeId
  readonly members: readonly RoundtableMember[]
  readonly state: "open" | "closed"
}

export interface Post {
  readonly postId: string
  readonly discussionId: string
  readonly seq: number
  readonly authorNodeId: NodeId
  readonly authorRoleId: string            // "human" is a valid role id
  readonly kind: PostKind
  readonly replyTo?: string
  readonly body: string                    // markdown, bounded
  readonly createdAt: Timestamp
}

export interface RoundtableOutcome {
  readonly summary: string
  readonly recommendation: string
  readonly addressedObjections: readonly string[]   // postIds
  readonly unresolvedObjections: readonly string[]
  // NOTE: advisory only. Never a transition trigger.
}
```

**New commands** (`orchestrationCommandSchema`): `charter.propose`, `charter.approve`, `charter.reject`, `charter.revise`, `roundtable.open`, `roundtable.post`, `roundtable.close`, `roundtable.inject_human`.

**New events**: `charter.proposed`, `charter.rejected`, `charter.revised`, `roundtable.opened`, `roundtable.posted`, `roundtable.closed`, `roundtable.outcome_recorded`.

**Transport:** `roundtable.post` is a `mesh.event` payload variant. **No new wire family is added** — `MeshCommand.payload`/`MeshEvent.payload` already carry `OrchestrationCommand`/`OrchestrationEvent`, so the mesh already transports this. The controller relays every post to the other members (no worker-to-worker sockets), preserving the invariant that the SSE gateway is the only place an event gets total order.

---

## 7. Compiled prompt and the security model

### 7.1 Deterministic compilation

```
system = Charter(v).globalRules
       + primaryRole.instructions
       + Σ secondaryRole.addendum        (bounded budget, hard cap)
       + Charter(v).communicationPolicy
       + taskPrompt
```
Stamped with `charterDigest + roleDigests + ruleDigests`. A running dispatch keeps the exact versions it started with — the same discipline as "Roles are snapshots."

### 7.2 Capability envelope for multi-role

`allowed ∩ roleAllowed ∩ ¬denied`, extended across all assigned roles. Default is **intersection** (an agent holding `implementer` + `release-manager` can do only what *both* permit). Union requires explicit per-role `permissionRestrictions` opt-in. This extends the existing logic at `runtime/opencode-adapter.ts:401` rather than replacing it.

### 7.3 The immutable core (agent-proposable charters)

Because charters are agent-proposable, a proposal must never be able to weaken the system. One function, called from exactly one place:

```ts
// src/orchestration/policy/immutable-core.ts
export function assertCharterDoesNotRelaxCore(
  proposal: CharterProposal,
  floor: SafetyFloor,
): Result<void, CharterCoreViolation>
```

The immutable core — fixed list, no exceptions, no override flag:

1. The `SAFETY_FLOOR` policy layer (built outside all caller input, `policy/floor.ts`).
2. Input-ownership fencing requirements (fork F1).
3. The security perimeter: `security.allowed_sources`, project allowlist resolution.
4. The advisory-only roundtable invariant.
5. Budget ceilings (`rules/limits.ts`).
6. Terminal-state authority: the kernel event store as sole source of truth.

A proposal that touches any of these is refused with `charter_core_violation` **before** it becomes a pending proposal. The proposed document is still recorded (as evidence) but can never be activated. The rule language gains a matching test so this is enforced the same way every other invariant is.

### 7.4 Proposal lifecycle

```
charter.propose         → charter.proposed   (status: pending; active charter UNCHANGED)
charter.approve         → charter.revise     → charter.revised  (new version active)
charter.reject          → charter.rejected   (rationale recorded)
```
Proposals carry `rationale` and `evidenceRefs` (roundtable ids, memory ids) so every charter change is auditable back to the deliberation that caused it. Every `charter.revise` is a **kernel command, never a file write** — this is what keeps the TUI editor from becoming a second source of truth.

### 7.5 Roundtable advisory-only enforcement

A roundtable outcome is an *input* to `dispatch.propose`, never a trigger. Enforced by: `roundtable.closed` is present in `COMMAND_EVENT_ALLOWLIST` for exactly zero command types. A test asserts that no command allows it.

---

## 8. The Herdr fork — thin

The plugin API already provides ~90% of the manager TUI (verified against Herdr 0.9.3): `[[panes]]` with `overlay`/`popup`/`split`/`tab`/`zoomed` placement; `pane.report_metadata` tokens renderable as `$role`/`$run`/`$task` in sidebar rows; `agent.view.set` with `{"token":"name"}` filter and sort fields; `agent prompt --wait`; `agent wait`; `agent read`; `agent start --kind`; `pane split --env`; `[[keys.command]]`; `pane.report_agent_session` + `resume_argv`.

**Fork for exactly three things:**

### F1 — Input-ownership fencing (fixes SF-10; satisfies ADR 0009 Revisit Condition #1)
```
pane.claim_input   { pane_id, holder, epoch } → { granted, epoch, holder }
pane.release_input { pane_id, holder, epoch }
```
`pane.send_text` / `pane.send_keys` / `pane.send_input` / `agent prompt` / `agent send-keys` reject with `input_fenced` unless the caller holds the fence. A human-focused pane always holds it; the orchestrator must claim → prompt → release. This is the difference between the orchestrator waiting its turn and interleaving text into what a human is typing.

### F2 — `role` as a first-class field on pane/agent records
Durable, first-class, native to filter/sort — survives `pane move` and cross-workspace re-identification, and is the stable join key back to the kernel's `RoleSnapshot` digest. Closes ADR 0009 §2.4 properly instead of via token indirection.

### F3 — Multi-machine surface fan-out (DEFER)
Herdr streams only the *selected* machine's surface. Remote agents on other machines show state but not live terminal content. The plugin-rendered grid (§10) covers the need; revisit only if the grid proves insufficient.

**Fork discipline:** cap the diff at F1+F2 (~2–3 weeks), rebase on upstream monthly, keep the manager in a plugin so upgrades stay cheap. Herdr is Apache-2.0; significant modifications require prominent notice.

---

## 9. Two Herdr plugins

### 9.1 `aibr-manager` — the agent-managing TUI
`herdr-plugin.toml` declaring one `[[panes]]` entrypoint plus actions and keybindings. Bun + OpenTUI. Views:

- **Role grid** — agents × roles; assign/remove; set primary; capability-envelope preview showing the *intersection* live before commit.
- **Charter editor** — structured edit of purpose / global rules / communication policy / escalation; "propose" produces `charter.propose` through the kernel, not a file write; shows immutable-core refusal inline.
- **Roundtable view** — live transcript from the SSE gateway; membership panel; human injection box; outcome summary when closed.
- **Multi-machine grid** — local Herdr agents + every Tailscale node's agents, one view.
- **Approval queue** — pending charter proposals and dispatch approvals.

Sidebar integration: `pane.report_metadata` tokens `$role`, `$run`, `$task`, `$discussion`, `$node`; `agent.view.set` projections to group by role or by node.

### 9.2 `aibr-herdr-bridge` — mesh → Herdr projection
Subscribes to remote AIBridge nodes over Tailscale and projects their agents into the local Herdr as first-class agents via `pane.report_agent` (semantic state) + `pane.report_metadata` (tokens) + `pane.report_agent_session`. Gives orchestration state for agents with no local pane — the complement to Herdr's SSH federation, which gives terminals but no orchestration state.

---

## 10. Workstreams

### Phase 0 — Unblock and lock contracts
**Goal:** nothing builds on broken ground.

| Task | Files | Acceptance |
|---|---|---|
| Fix missing-dependency `waiting`-forever bug | `src/jobs/manager.ts` `dependencyOutcome` | Missing local dep → terminal `failed` after the dep-resolution window; test in `tests/unit/jobs/` |
| Add Charter schemas | `src/orchestration/schemas.ts`, `charter/types.ts` | Strict parse; `snapshotDigest` via canonical JSON; unknown versions refused |
| Add Roundtable schemas | same | Same |
| Immutable-core validator | `src/orchestration/policy/immutable-core.ts` | Pure; refuses each of the 6 core items |
| Wire `AgentRegistry`/`CapabilityRouter` to the mesh registry | `src/registry/*.ts`, `src/routing/snapshot.ts` | `routeByCapability` resolves live mesh nodes |
| Contract regeneration | `scripts/generate-contracts.ts`, `contracts/v1/*.schema.json` | `bun run generate:contracts` clean |

### Phase 1 — Kernel capability (P0 core)
**Goal:** the kernel can define, bind, dispatch, and deliberate.

| Task | Files | Acceptance |
|---|---|---|
| `RoleAssignment` multi-role + capability intersection | `src/orchestration/schemas.ts`, `src/runtime/*-adapter.ts` | One primary enforced; secondary addenda byte-capped; intersection computed |
| `RoleBinder`: RoleTemplate → runtime kind + system prompt + tool policy | `src/runtime/binder.ts` | Deterministic; digest-stamped; unit tests per runtime |
| Charter store, versioning, snapshot digest | `src/orchestration/charter/repository.ts` | Mirror of `roles/repository.ts`: `computeCharterSnapshotDigest`, `verifySnapshotDigest`, `RoleVersionConflictError`-style errors |
| Implement `session.prompt` | `src/orchestration/coordinator/coordinator.ts`, `types.ts` | Emits real events; drives `OpencodeClient.sendPromptAsync`; monitored to idle |
| Fan-out dispatch (N siblings) | `src/orchestration/scheduler/`, `dispatch.propose` | `maximumFanOut` enforced by the budget ledger as *separate* counters; sibling cancellation on parent failure |
| Roundtable + controller relay | `src/orchestration/roundtable/`, `src/mesh/outbox/ingest.ts`, `src/mesh/protocol/` | Post relayed to all members; total order preserved; `roundtable.closed` in zero `COMMAND_EVENT_ALLOWLIST` entries |
| Charter proposal lifecycle | `src/orchestration/charter/proposal.ts`, `src/rules/evaluate.ts` | Active charter unchanged until approval; core violations refused pre-pending |
| Fault harness coverage | `src/mesh/fault/` | Two-node harness exercises a relayed post with a dropped response and a replay |

### Phase 2 — Herdr fork
**Goal:** F1 + F2 shipped, upstream-tracked.

| Task | Acceptance |
|---|---|
| Fork `herdrdev/herdr`, branch `aibr-orchestration` | Builds on macOS arm64 + Linux x86_64/aarch64 |
| F1 input fencing | Socket API + conformance tests; `input_fenced` on unheld write; claim/release epochs |
| F2 first-class `role` | Survives `pane move`; native to `agent.view.set` filter/sort |
| `herdr api schema` conformance | New methods validated against the printed JSON Schema |
| Preflight detection | `src/host/preflight.ts` gains a Herdr branch; `aibr verify` reports fork capability flags |

### Phase 3 — Terminal backend + manager plugin (P0 end-to-end)
**Goal:** one agent, one machine, kernel-prompted, visible in Herdr with its role.

| Task | Files | Acceptance |
|---|---|---|
| `HerdrTerminalBackend implements TerminalBackend` | `src/terminal/herdr-terminal-backend.ts` | Beside tmux; conformance against `src/sdk/conformance.ts`; realises the `HerdrExperimentalTerminalBackend` spike |
| Terminal backend selection in config | `src/config/schemas.ts` | `terminal.backend: "tmux" \| "herdr"`; default `tmux` (headless safety) |
| Manager plugin: role grid + charter editor + roundtable view | new repo `aibr-manager` | Assign role → pane token `$role` updates → re-prompt uses new role |
| Local loop integration test | `tests/integration/herdr-*.test.ts` | spawn → `session.prompt` → wait idle → `session.observed` → roundtable → outcome → `dispatch.propose` |

### Phase 4 — Remote (keep both)
| Task | Acceptance |
|---|---|
| `aibr-herdr-bridge` plugin | Remote agent state projected into local Herdr; tokens `$node`/`$role`/`$run` render; disconnects degrade to cached state |
| Herdr SSH federation over Tailscale | `herdr machine add 100.x.y.z`; combined agent list; switch without leaving the window |
| Multi-machine grid | Local + all nodes in one view; per-node connection health |
| Remote roundtable | A post from node B relays through the controller to node C; totals order across nodes |

### Phase 5 — Governed discussion
| Task | Acceptance |
|---|---|
| Rule requiring a closed roundtable before execution dispatch | `communicationPolicy.objectionRequiredBefore` denies execution dispatch with `roundtable_required` |
| Budget gating on roundtable fan-out | Parallel mode refused by the ledger beyond the ceiling; per-member vs shared scope honoured |
| Memory write-back from outcomes | `RoundtableOutcome` → memory record with provenance back to post ids |
| Notification integration (advisory only, per ADR 0007 §17) | Notifications never reach orchestration |

### Phase 6 — Retirement and release
| Task | Acceptance |
|---|---|
| Remove `aibr-tui` bin, `src/tui/` OpenTUI shell, TUI half of `src/ipc/` | `crates/aibr-pty` + `crates/aibr-ipc` retained; `crates/aibr-tui` removed from the workspace |
| CLI: `aibr tui` no longer launches a local TUI; launches/links the manager plugin | `aibr tui` errors clearly when Herdr is absent |
| ADR 0011 supersedes ADR 0009 | Decision + revisit conditions recorded |
| Rewrite `AGENTS.md` (currently badly stale — describes a ~10-file POC) | Matches the real tree |
| Version bump to `3.0.0` | `package.json`, `src/version.ts`, `CHANGELOG.md` |
| `bun run release:check` | Full gate green: frozen install, tsc, vitest, typecheck, shellcheck, contract parity, `npm pack --dry-run` |

---

## 11. Test strategy

Mirroring the existing layout (`tests/unit/{module}/`, `tests/integration/`, `tests/contracts/`).

| Layer | Location | What it proves |
|---|---|---|
| Charter immutability | `tests/unit/orchestration/immutable-core.test.ts` | None of the 6 core items can be relaxed by any proposal shape |
| Roundtable advisory-only | `tests/unit/orchestration/roundtable.test.ts` | `roundtable.closed` appears in zero `COMMAND_EVENT_ALLOWLIST` entries; no command produces a transition from an outcome |
| Deterministic compile | `tests/unit/runtime/binder.test.ts` | Same inputs → byte-identical prompt; digest matches |
| Multi-role capability | `tests/unit/runtime/` | Intersection; one primary enforced; addenda budget enforced |
| Fan-out budgets | `tests/unit/budgets/` | Concurrency and fan-out counted separately; ceiling refused |
| Integration | `tests/integration/herdr-roundtable.test.ts` | Full loop through `app.inject()` with a fake Herdr client |
| Contract parity | `tests/contracts/` | `charter` + `roundtable` schemas generated and parity-checked |
| Fault | `src/mesh/fault/` | Dropped post, replayed post, mid-relay controller restart |
| Security | `tests/security/canary-token-audit.test.ts` | No charter text, prompt, or transcript leaks into logs or support bundles |

**Gate:** every phase ends with `bun test && bun run typecheck`. Phase 6 additionally runs `bun run release:check`.

---

## 12. Migration and rollout

| Stage | Audience | Condition |
|---|---|---|
| **0 — internal** | This machine | Phase 3 end-to-end green |
| **1 — opt-in** | One second node | Phase 4 remote projection + federation working; `terminal.backend = "tmux"` remains the default everywhere |
| **2 — default** | All nodes | Phase 5 rules and budgets green; Herdr fork in prebuilt `bin/` |
| **3 — release** | npm `3.0.0` | Phase 6 complete; CI publish gate passes |

No node is ever forced off tmux. `terminal.backend` is per-profile, so a headless VPS keeps tmux forever while operator machines use Herdr.

---

## 13. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Fork diverges from upstream** | High | Cap at F1+F2; monthly rebase; manager lives in a plugin, so upgrades stay cheap |
| **Screen-scraping fallback is fragile** | High | opencode SDK adapter is the default; `agent prompt` only for TUI-only runtimes (claude, codex, cursor) |
| **Agent-proposed charters weaken the system** | Medium | Single immutable-core function, called from exactly one place, tested per item; proposals recorded but refused pre-pending |
| **Roundtable accretes authority** | Medium | Enforced by `COMMAND_EVENT_ALLOWLIST` + a regression test; advisory-only is a stated invariant |
| **Two TUIs left running** | Medium | Decision 1 retires `aibr-tui` in Phase 6; removing the bin, not just deprecating it |
| **Discussion traffic starves terminal streaming** | Medium | SSE event gateway and terminal WebSocket gateway stay separate channels |
| **Tailscale remote path assumptions** | Medium | `preflight` probes both paths per node; degrade to mesh projection when SSH is unavailable |
| **Charter growth unbounded** | Low | Byte budgets on global rules and addenda, enforced at proposal time |

---

## 14. Definition of done

1. An operator installs Herdr + `aibr-manager`, runs `aibr serve -p default`, and sees every agent — local and across the Tailnet — with its role, run, and task in one grid.
2. They assign `reviewer` and `implementer` to one agent; the capability envelope shown is the intersection; re-prompting uses the compiled prompt stamped with both role digests and the charter digest.
3. They edit the charter in the manager; the edit becomes `charter.propose`; on approval `charter.revised` activates a new version; running dispatches keep the old digest.
4. An agent proposes a charter revision that would remove an `allowed_sources` entry; it is refused as a core violation before becoming pending.
5. A roundtable is opened on a task; three agents post proposals and objections; the human injects a clarification; the roundtable closes with a recommendation; a rule requiring a closed roundtable then admits `dispatch.execute`.
6. `dispatch.execute` fans out N siblings; the budget ledger refuses the seventh; a sibling failure cancels its parent's siblings.
7. `aibr-tui` no longer exists in the tree; headless nodes are unaffected because they were on tmux all along.
8. `bun test`, `bun run typecheck`, and `bun run release:check` are green at `3.0.0`.

---

## 15. Open items to settle before Phase 1 starts

**Settled 2026-10-13 — all four adopted as recommended below:** charter is per profile (per-project role catalogs); chair selection is routed by role capability; charter auto-approval is human-only for v1; the manager plugin is Bun + OpenTUI. These are the decision of record for Phase 1 until ADR 0011 captures the architecture.

1. **Charter scope:** one charter per profile (simplest), or per project (matches your existing `projectId` scoping on role templates)? Recommend **per profile, with per-project role catalogs** — the charter governs *how the herd talks*, which is a machine-level property.
2. **Chair selection:** static config, or routed by role capability (e.g. the agent holding a role with `capabilities: ["orchestration"]`)? Recommend **routed**, so it degrades when the default chair is down.
3. **Charter auto-approval:** narrow auto-approve classes (e.g. wording-only changes to `globalRules`) or human-only? Recommend **human-only for v1**, tightened policy later — the immutable core already blocks the dangerous cases, and auto-approval adds a new attack surface for no immediate benefit.
4. **Manager plugin runtime:** Bun + OpenTUI (matches `src/tui/` conventions and `@opentui/core` is already a dependency) or Rust + ratatui (consistent with the fork)? Recommend **Bun + OpenTUI** for iteration speed; the pane is disposable anyway.

---

# Part B — Setup: optional bearer token + Tailscale agent discovery

**Ships as `2.2.0`, before Part A.** These are independent of the Herdr work, touch security-sensitive code, and deserve their own review cycle. They also make Part A dramatically easier to install, because a newly onboarded node can discover its peers instead of hand-typing `http://100.64.0.2:8787`.

## 16. Where the setup path actually lives

| File | Function | Status |
|---|---|---|
| `src/cli/setup-wizard.ts` | `runSetupWizard` → `runHeadlessWizard` | **LIVE** (`src/cli.ts:598`) |
| `src/host/setup.ts` | `runSetup` | **DEAD CODE** — `src/cli.ts:546` imports it and never calls it |

Both build their config inline and duplicate the same object nearly verbatim. **All changes below go in `src/cli/setup-wizard.ts`.** Do not duplicate work into `src/host/setup.ts`; instead mark it `@deprecated` and add a test asserting the CLI never imports a live path from it. Two setup implementations diverging is how the next stale-`AGENTS.md` problem gets created.

Also note: `runSetupWizard` computes `isInteractiveTty` at line 132 and **never uses it** — line 137 always delegates to `runHeadlessWizard`. The pretty `StepperFSM` (lines 344–551) is unreachable in production. If we add a discovery step, wire it into the **headless** path, and delete the dead bright-object TUI or it will rot.

## 17. Optional bearer token

### 17.1 What "optional" has to mean

The wizard **already** has a two-way choice (`setup-wizard.ts:174-190`): generate, or paste your own. There is no "no auth at all" path, because `auth_mode` is `z.literal("bearer-token")` and `writeSecret` runs unconditionally at line 288 and **throws on empty input** (`profile-store.ts:182`).

So this is a **third** option, and it changes `security.auth_mode`, not the prompt:

```
[G]enerate a new shared bearer token   (default, unchanged)
[P]aste an existing token              (unchanged)
[N]o bearer token — trust the network   (NEW)
```

### 17.2 Schema change (the one-line enabler)

`src/config/schemas.ts:39`:
```ts
- auth_mode: z.literal("bearer-token"),
+ auth_mode: z.enum(["bearer-token", "none"]).default("bearer-token"),
```
`.default("bearer-token")` keeps every existing config and every existing fixture valid — this is **not** a breaking change.

### 17.3 Blast radius — every site that assumes a token exists

| Site | Problem | Change |
|---|---|---|
| `setup-wizard.ts:288` | `writeSecret` unconditional, throws on `""` | Skip when mode is `none` |
| `setup-wizard.ts:240`, `setup.ts:251` | Hardcoded `"bearer-token"` | Read from the prompt |
| `src/cli.ts:662` (`serveBridge`), `:705` (`runWorker`) | `readSecret` is **unguarded and has no ENOENT catch** — it throws (`profile-store.ts:165`) | Return `string \| null`; thread through |
| `src/bridge.ts` | `bearerToken` reaches `startBridge` as `string` | Accept `string \| null` |
| `src/security/auth-provider.ts` | `BearerAuthProvider` requires non-empty token | Add `OpenAuthProvider` (always `true`), selected by `auth_mode` |
| `src/cli/verify.ts:270-276` | The `catch` around `stat(bearer_token)` **fails** when the file is absent | Skip the whole secret block when `auth_mode === "none"`; emit a persistent `warn` naming the exposure instead. (`secret-bearer-token-mode` at :249 is only a permissions sub-check, not an auth-mode check) |
| `src/server/routes/*.ts` | Each route constructs `BearerAuthProvider` directly | Route via a factory keyed on `auth_mode` |
| `tests/unit/documentation/install-runbook.test.ts:121-168` | Asserts README documents token generation | Update to document the third option |
| `README.md`, `.agents/skills/aibr-onboarding/SKILL.md:42-53` | Token-generation prose | Update |

**`readSecret` is write-once and never re-validated against config** — so an operator who picks `none` on a profile that already has a `bearer_token` file gets a silently-ignored secret and no auth. Setup must detect and refuse that case.

### 17.4 The guard that makes this safe

"No auth" is only defensible on a tailnet interface. Gate it hard — `setup` **blocks** unless all three hold:

1. `bridge.host` is in `100.64.0.0/10` — reuse the existing `isTailscaleCgnatIp` (`setup-step-widgets.ts:85`).
2. Preflight reports `tailscale.ip !== null && backendState === "Running"`.
3. An explicit typed confirmation (`type the node id to confirm`), plus a one-line warning naming the exposure.

Additionally make the state visible, not silent:
- `aibr verify` emits a persistent `warn: node accepts unauthenticated /trigger and /report` while in this mode.
- The IPC tailscale status view (`src/ipc/bridge.ts:144-154`) already models a status enum — surface auth mode there too rather than leaving it implicit.

Refuse the combination outright: `auth_mode: "none"` + `bridge.host` outside `100.64.0.0/10` → `SetupBlocked`. If someone genuinely wants an open bridge, they can hand-edit; setup won't author it.

### 17.5 Tests

`tests/unit/cli/setup-wizard.test.ts` extends the existing prompt-sequence fakes: three-way choice; `none` writes no secret file; `none` + non-CGNAT host returns `blocked`; `none` over an existing profile with a `bearer_token` file is refused; `auth_mode` defaults to `bearer-token` for every existing fixture. `tests/integration/` gains an unauthenticated `/trigger` round-trip with `auth_mode: "none"`.

## 18. Tailscale agent auto-discovery

### 18.1 What exists to build on

Only the **CLI**, never the API — four invocations repo-wide: `which tailscale` (`preflight.ts:121`), `tailscale status --json` (`preflight.ts:204`), `tailscale ip -4` (`setup-step-widgets.ts:154,159`; `scripts/install.sh:244`), `tailscale status` (`install.sh:240`). No local API socket client — `/var/run/tailscaled.sock` is only `stat`ed for existence (`setup-step-widgets.ts:133`).

Critically, **`checkTailscaleStatus` already parses peer rows and throws them away**:
- JSON branch reads only `Self`, never the `Peer` object that `tailscale status --json` emits (`preflight.ts:188-198`).
- The plain-text branch walks every machine line but keeps only the first (`if (ip === null)`).

### 18.2 Peer enumeration

Extend the existing Zod schema in place — it is `.optional()` everywhere, so this is back-compatible:

```ts
// src/host/preflight.ts, extend tailscaleStatusSchema
Peer: z.record(
  z.string(),
  z.object({
    HostName: z.string().optional(),
    DNSName: z.string().optional(),
    TailscaleIPs: z.array(z.string()).optional(),
    OS: z.string().optional(),
    Online: z.boolean().optional(),
  }),
).optional(),
```

New, additive — do **not** change `TailscaleFacts` or `checkTailscaleStatus`:

```ts
// src/host/tailscale-discovery.ts
export interface TailscalePeer {
  readonly ip: string            // first CGNAT v4
  readonly hostname: string      // DNSName, trailing dot stripped
  readonly os: string | null
  readonly online: boolean
}
export async function discoverTailscalePeers(runner: ProcessRunner): Promise<readonly TailscalePeer[]>
```
Excludes `Self`. Sorted by hostname. Handles both the JSON `Peer` map and the plain-text fallback, mirroring the dual-branch style already in `checkTailscaleStatus`.

### 18.3 Agent probing

New probe in `src/cli/setup-step-widgets.ts`, following the module's established `Deps → result → render` contract (`probeNetwork` at :121, `probeRuntimes` at :713):

```ts
export interface AgentDiscoveryDeps {
  readonly processRunner?: ProcessRunner
  readonly fetchFn?: typeof fetch          // injected, as probeRuntimes does
  readonly bridgePort?: number             // default 8787
}
export interface DiscoveredAgent {
  readonly ip: string
  readonly hostname: string
  readonly os: string | null
  readonly online: boolean
  readonly bridgeReachable: boolean
  readonly agentId: string | null          // from /health
  readonly opencodeReachable: boolean | null
  readonly enrolled: boolean                // already in config?
}
export async function probeDiscoveredAgents(deps?: AgentDiscoveryDeps): Promise<AgentDiscoveryResult>
```

Per peer: `GET http://<ip>:8787/health` with a short timeout and `AbortSignal`. **`/health` is deliberately unauthenticated** (`src/server/routes/health.ts`) — discovery must work without credentials, exactly as today.

> **Decision required:** `/health` currently returns `{ ok, opencode }` and does **not** expose `agent_id`. Without it, discovery can prove *reachability* but not *identity*, so it cannot auto-populate `allowed_sources[].source_agent_id`. The fix is to add `agent_id` and `capabilities` to the `/health` response — a contract change requiring regeneration of `contracts/v1/*.schema.json` and parity tests. Exposure is modest (`agent_id` is already visible in `public_url` and bridge responses, and `/jobs/:id` is already unauthenticated), but it is a real change and should be its own reviewed commit.

### 18.4 The security boundary — read this before shipping

`src/mesh/` states this invariant in roughly ten places, and `Docs/security/milestone-0-threat-model.md` states it plainly: *"A Tailscale connection provides reachability, not user identity, enrollment, project membership, or approval."*

**Therefore: discovery never enrolls anything.** It produces a *candidate list*. The operator explicitly selects which peers to enroll, and must choose each peer's `capabilities` — there is no sensible default, because `assertSourceAuthorized` (`src/security/source-authorization.ts:4`) authorizes on `source_agent_id` **and** capability membership, and a discovered agent present in `agents[]` but absent from `allowed_sources[]` returns 403 on `/trigger` (`trigger.ts:26`).

Enrolling a peer writes **both** parallel arrays, and they must agree:
```ts
security.allowed_sources.push({ source_agent_id: peerAgentId, capabilities: [...chosen], requires_plan_approval: [] })
agents.push({ id: peerAgentId, url: `http://${peer.ip}:8787`, capabilities: [...chosen] })
```

Reachability is still not authentication — actual trust comes from the mesh identity path (ed25519 node keys, enrollment codes, peer pins in `src/mesh/identity/`). Discovery is a **config-authoring convenience**, nothing more. State that in the UI copy and in the wizard summary so nobody mistakes a green checkmark for a trust decision.

If a discovered peer's tailnet data is ever surfaced or stored, note that `src/memory/redaction/` already redacts `tskey-` (a reusable node-enrollment credential) — do not print raw `tailscale status --json` anywhere a log or a support bundle could capture it.

### 18.5 Where it surfaces

| Surface | Change |
|---|---|
| `aibr setup` step 4 | Replace the hardcoded `http://100.64.0.2:8787` default (`setup-wizard.ts:203-209`) with the discovered list; operator picks, types capabilities, enrols |
| **`aibr discover --json`** (NEW) | Standalone command, scriptable — the Herdr manager plugin calls this to build its multi-machine grid. Same probe, no wizard state |
| `aibr verify` | New informational check: `N peers reachable, M enrolled`; unenrolled peers listed as detail, never as failure |
| `renderXxxProbe` | New ANSI row set matching the widget house style ("🔒 Tailscale Daemon" / "📡 Tailscale Mesh IPv4 Coordinate") |

### 18.6 Tests

- `tests/unit/host/tailscale-discovery.test.ts` — JSON `Peer` map parsing; `Self` exclusion; offline peers; malformed JSON; plain-text fallback (both branches of `checkTailscaleStatus` already have fixtures to copy).
- **The fakes are load-bearing:** `tests/unit/cli/setup-wizard.test.ts:111,116` and `tests/unit/host/setup.test.ts:43,176-238` map fake-runner argv for `"which tailscale"` and `"tailscale status --json"`. The discovery command must be added to every fake or the whole setup suite fails.
- `tests/unit/cli/setup-step-widgets.test.ts` — `FakeProcessRunner` and `FakeHttpProbe` already exist at lines 29-57; extend them.
- `tests/integration/` — a discovered, operator-enrolled peer round-trips `/trigger` successfully; a discovered-but-unenrolled peer gets 403.
- `tests/security/` — canary audit asserts no `tskey-` and no raw peer JSON reaches logs or support bundles.

## 19. Part B phase order

| Phase | Deliverable | Gate |
|---|---|---|
| **B1** | Schema widening + `OpenAuthProvider` + all §17.3 call sites + `none`-mode guards + tests | `bun test && bun run typecheck`; security review of §17.4 |
| **B2** | `discoverTailscalePeers` + `/health` `agent_id` (own reviewed commit) + contract regeneration | contract parity green |
| **B3** | `probeDiscoveredAgents` + wizard integration + `aibr discover --json` + verify informational check + docs | §18.4 boundary test green |
| **B4** | Release `2.2.0`: `package.json`, `src/version.ts`, `CHANGELOG.md`, `bun run release:check` | full gate green |

**B1 is shippable alone** if B2's `/health` contract change stalls review.
