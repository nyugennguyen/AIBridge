# ADR 0011: Herdr-Orchestrated Multi-Agent Architecture and Kernel Authority

- **Status:** Accepted (Milestone 8 / Part A, Target Version 3.0.0)
- **Date:** 2026-10-14
- **Authors:** AIBridge Architecture & Hardening Team
- **Deciders:** Core Engineering Team, Release Gate, Architecture Team
- **Related Milestones:** Milestone 8 (Hardening & Ecosystem), Milestone 4 (Mesh), Milestone 7 (Polyglot Ingress), Milestone 6 (Rules)
- **Supersedes:** [ADR 0009: Herdr Terminal Backend Experiment and Evaluation](./0009-herdr-terminal-backend-evaluation.md)
- **Amends:** [ADR 0008](./0008-polyglot-ingress-and-admission.md) §4 (operator actor claims), [ADR 0010](./0010-tui-daemon-modernization.md) (retiring `aibr-tui` in favor of Herdr manager plugin)

---

## 1. Context and Problem Statement

AIBridge began as a private Tailscale bridge relaying jobs to single-agent instances (`opencode serve`). Over Milestones 1 through 7, it acquired a distributed mesh protocol with controller leases (ADR 0004), an event-sourced kernel with append-only stores (ADR 0003), a layered rule engine with immutable safety floors (ADR 0007), polyglot ingress admission (ADR 0008), scoped memory with redaction pipelines (M5), and multiple runtime adapters (ADR 0005, ADR 0006).

However, two architectural bottlenecks prevented AIBridge from scaling to complex multi-agent workflows:

1. **Terminal and Operator Presentation Friction:** Maintaining a bespoke terminal user interface (`aibr-tui` in Rust/ratatui and `src/tui/` in OpenTUI) incurred significant maintenance overhead, struggled with complex multi-workspace/multi-agent multiplexing, and duplicated window-management capabilities already solved by modern terminal workspace managers.
2. **Lack of Governed Multi-Agent Deliberation:** Agents operated in isolated dispatch silos without structured, governed communication. Complex problem-solving requires agents to deliberate, challenge assumptions, and form consensus *before* executing irreversible changes, all governed by an orchestration-wide charter and strict budget ceilings.

In Milestone 8 (M8.8), ADR 0009 evaluated adopting Herdr as a `TerminalBackend`. ADR 0009 deferred adoption primarily because of impedance mismatches (AIBridge driving headless hidden panes), lack of atomic input-ownership fencing (`SF-10`), and competing state authorities.

This ADR records the decision to transition AIBridge into a **Herdr-orchestrated multi-agent architecture** by inverting the relationship evaluated in ADR 0009, satisfying ADR 0009's Revisit Condition #1, retiring `aibr-tui`, and establishing the AIBridge kernel as the sole orchestration authority.

---

## 2. Inviolable Architectural Invariant

> **The Inviolable Invariant:**
> *Herdr owns the terminal. AIBridge owns the intent. Never both, never either.*

- **AIBridge Kernel Authority:** The AIBridge kernel (`src/orchestration/`, `src/mesh/`, `src/rules/`, `src/budgets/`, `src/memory/`) remains the sole authority for state, scheduling, charters, role assignments, roundtable discussions, budget ledgers, and dispatch decisions. All state transitions occur through append-only event streams. Herdr is strictly a presentation substrate and terminal multiplexer.
- **Terminal Ownership:** Herdr manages windows, tabs, pane layout, truecolor VT parsing, process supervision, and keyboard focus. The kernel decides *who* is prompted, under *which role*, with *what budget*, and *after what deliberation*.

---

## 3. Why This Decision Supersedes ADR 0009

ADR 0009 evaluated Herdr as an underlying headless `TerminalBackend` where AIBridge attempted to allocate and manage Herdr panes invisibly. The orchestration architecture inverts that relationship: Herdr is the human operator's interactive workspace, and every agent pane is a visible, inspectable participant.

Each of ADR 0009's six objections is resolved:

| ADR 0009 Objection | Evaluation in ADR 0009 | Resolution in ADR 0011 |
|---|---|---|
| **§2.1 Primitive Mapping** | Headless background daemon lifecycles forced onto interactive Herdr panes that no human views. | **Inverted Model:** Every pane in Herdr represents a human-visible, interactive agent. Headless background execution continues to use `TmuxTerminalBackend`. |
| **§2.2 State-Authority Conflict** | Herdr process manager and state database competed with AIBridge event store as secondary authority. | **Projection Consumer:** Herdr maintains zero orchestration authority. Herdr plugins (`aibr-manager`, `aibr-herdr-bridge`) consume the total-order SSE event gateway strictly as read-only projections. Kernel event store remains the single source of truth. |
| **§2.3 Input Ownership Fencing (`SF-10`)** | Herdr lacked atomic input-ownership fencing tokens, risking concurrent keystroke interleaving. | **Satisfied via Fork F1:** The thin Herdr fork (`herdrdev/herdr` branch `aibr-orchestration`) introduces `pane.claim_input` and `pane.release_input` with epoch fencing. Unheld writes reject with `input_fenced`. **Satisfies ADR 0009 Revisit Condition #1 verbatim.** |
| **§2.4 Transient Pane Recovery** | Ephemeral UUIDs upon restart prevented durable session association. | **First-Class Role Tagging (Fork F2):** Durable `role` field on pane/agent records natively joins to the kernel's `RoleSnapshot` digest, surviving `pane move` and process restarts alongside `pane.report_agent_session` and `resume_argv`. |
| **§2.5 Distribution Impact** | Packaging Herdr as an npm dependency would enlarge bundle and fail clean-machine gates. | **Zero npm Dependencies:** Herdr is an optional detected user-installed binary (`brew install herdr` or prebuilt fork), never an npm dependency. `package.json` dependencies on Herdr remain zero. |
| **§2.6 Security & Privilege Separation** | Herdr required broad desktop bus access. | **Unprivileged Isolation:** AIBridge runs unprivileged inside Herdr panes. Headless VPS deployments retain tmux with zero desktop privilege footprint. |

---

## 4. Architectural Pillars of the Orchestration Kernel

### 4.1 Charter Governance & The Immutable Core

The orchestration-wide system prompt is governed by a versioned, digest-stamped **Charter** (`src/orchestration/charter/types.ts`):
- **Structure:** Purpose, bounded global rules (`globalRules`), communication policy (`turnTaking`, `objectionRequiredBefore`, `mustStopAndAsk`), escalation policy (`maxRounds`, `onDeadlock`), and role catalog refs.
- **Agent-Proposable Lifecycle:** Agents may propose charter revisions via `charter.propose` carrying rationale and evidence refs (roundtable outcomes, memory records). Proposed charters remain pending until explicit operator approval (`charter.approve` / `charter.reject`).
- **Kernel Command Enforcement:** Revisions are enacted exclusively via kernel commands (`charter.revise`), never direct filesystem writes, eliminating secondary sources of truth.
- **The Immutable Core (`assertCharterDoesNotRelaxCore`):** Enforces that no proposal can relax the immutable core:
  1. `SAFETY_FLOOR` policy layer (`src/orchestration/policy/floor.ts`).
  2. Input-ownership fencing requirements (Fork F1).
  3. Security perimeter (`security.allowed_sources`, project allowlist).
  4. Advisory-only roundtable invariant.
  5. Budget ceilings (`src/rules/limits.ts`).
  6. Terminal-state authority (kernel event store as sole source of truth).
  Violations are refused immediately with `charter_core_violation` before entering the pending queue.

### 4.2 Multi-Role Assignments and Deterministic Prompt Compilation

Agents are assigned roles dynamically via `RoleAssignment`:
- **Role Model:** Exactly one primary role per assignment; secondary roles contribute bounded addenda (`addendum`), not conflicting base instructions.
- **Deterministic Prompt Compilation:**
  $$\text{system} = \text{Charter}(v).\text{globalRules} + \text{primaryRole}.\text{instructions} + \sum \text{secondaryRole}.\text{addenda} + \text{Charter}(v).\text{communicationPolicy} + \text{taskPrompt}$$
  Every compiled prompt is stamped with `charterDigest + roleDigests + ruleDigests`. Dispatches preserve the exact snapshot versions active at start time.
- **Capability Envelope:** Multi-role capability resolution enforces strict intersection by default:
  $$\text{effectivePermissions} = \text{allowed} \cap \text{roleAllowed} \cap \neg\text{denied}$$
  An agent combining multiple roles possesses only the privileges permitted by *all* assigned roles.

### 4.3 Roundtable Deliberation (Advisory Only)

Structured pre-execution debate is modeled as a first-class **Roundtable** (`src/orchestration/roundtable/`):
- **Lifecycle:** `roundtable.open` $\to$ `roundtable.post` $\to$ `roundtable.close` $\to$ `roundtable.outcome_recorded`.
- **Wire Transport & Total Order:** Post operations travel over existing `mesh.event` envelopes. The controller relays posts to all participating nodes. Total ordering is established uniquely at the SSE event gateway.
- **Advisory Invariant:** Roundtable discussions produce an outcome summary, recommendation, and addressed/unresolved objection list. **`roundtable.closed` is present in zero `COMMAND_EVENT_ALLOWLIST` entries.** A roundtable outcome is an audited *input* to `dispatch.propose`, never an automatic state trigger.
- **Execution Gating:** Communication policies may specify `objectionRequiredBefore`, refusing execution dispatch with `roundtable_required` if attempted without a concluded roundtable.

### 4.4 Herdr Ecosystem Integration

The presentation layer comprises three external components:
1. **Thin Herdr Fork (`herdrdev/herdr` branch `aibr-orchestration`):**
   - **F1 (Input Fencing):** `pane.claim_input` / `pane.release_input` socket API with epoch fencing, rejecting unheld writes with `input_fenced`.
   - **F2 (First-Class Role):** Native `role` property on agent/pane records, surviving moves and restarts.
   - **Schema Conformance:** Verified via `herdr api schema --json`.
2. **`aibr-manager` Plugin (Bun + OpenTUI):** Operator management pane embedding Role Grid, Charter Editor, Roundtable Live Transcript, Multi-Machine Grid, and Approval Queue.
3. **`aibr-herdr-bridge` Plugin (Bun):** Subscribes to remote AIBridge nodes over Tailscale and projects remote agents into the local Herdr workspace.
4. **Terminal Backend Selection:** `HerdrTerminalBackend` is added alongside `TmuxTerminalBackend` in `src/terminal/`, selectable via config (`terminal.backend: "tmux" | "herdr"`, default `"tmux"`).

### 4.5 Retirement of `aibr-tui`

With Herdr assuming the role of the operator TUI:
- The Rust `aibr-tui` binary and the OpenTUI fallback (`src/tui/`) are retired.
- `crates/aibr-pty` and `crates/aibr-ipc` are retained as headless substrates for terminal management and IPC framing.
- `aibr tui` is cut over to verify Herdr installation and launch/link the `aibr-manager` plugin, failing with a clean diagnostic if Herdr is absent.

### 4.6 Operator Credential Security Model

In alignment with ADR 0008 §4, operator-level administrative actions (charter approval/rejection, human roundtable post injection, emergency execution abort) require explicit operator credential claims (`AIBRIDGE_OPERATOR_TOKEN` / `actor.kind: "user"`). Automated agents (`actor.kind: "agent"`) are cryptographically constrained from self-approving charter modifications or bypassing the immutable core.

---

## 5. Revisit Conditions

This decision is rooted in the assumptions of a thin, maintainable fork, controller relay efficiency, and loose plugin coupling. This decision **MUST be revisited** if any of the following concrete triggers occur:

1. **Herdr Fork Maintenance Burden Exceeds Threshold:**
   - *Trigger:* Upstream Herdr undergoes rapid architectural changes, refactors its IPC layer, or rejects standardizing input-fencing primitives, causing monthly rebases of the F1/F2 diff to require $>2$ engineer-days per month or $>500$ lines of conflicting fork delta.
   - *Remedy:* Re-evaluate headless daemon PTY ownership or contribute an official extension/middleware hook to upstream Herdr that eliminates the hard fork.
2. **Central Controller Roundtable Relay Bottleneck:**
   - *Trigger:* In large mesh deployments ($>50$ nodes or $>200$ active concurrent agents), relaying every roundtable post through the single controller saturates SSE gateway throughput or introduces post-to-all broadcast latency exceeding $500\text{ ms}$.
   - *Remedy:* Introduce peer-to-peer gossip transport for advisory roundtable posts (e.g., authenticated Tailscale UDP or direct WebRTC data channels) while retaining total-order timestamps at outcome recording.
3. **Plugin-UI Coupling & OpenTUI Rendering Fragility:**
   - *Trigger:* The `aibr-manager` plugin pane suffers from recurring rendering artifacts, keyboard event hijacking, or terminal emulator incompatibilities across platform matrixes, or Herdr's plugin API limits multi-machine dashboard layout flexibility.
   - *Remedy:* Decouple the operator UI from the terminal pane into a dedicated local web dashboard or standalone Tauri/native desktop application connecting directly to the SSE gateway and operator IPC socket.
4. **Headless Operational Divergence:**
   - *Trigger:* If features (such as charter proposals, roundtable deliberation views, or approval resolution) become practically inoperable without Herdr installed, degrading headless Linux VPS deployments where only tmux is available.
   - *Remedy:* Ensure CLI commands (`aibr charter`, `aibr roundtable`, `aibr approve`) provide 100% headless feature parity for all kernel operations.
5. **Herdr Socket Security Boundary Compromise:**
   - *Trigger:* Herdr's local IPC daemon exposes an unauthenticated loopback port or insufficiently restricted socket permissions (`>0700`) allowing untrusted local processes to spoof operator claims or inject unvetted keystrokes.
   - *Remedy:* Restrict Herdr terminal backend integration to authenticated TLS or mutual Unix domain socket credential checks (`SO_PEERCRED`), falling back to strict POSIX tmux isolation.

---

## 6. References

- [ADR 0009: Herdr Terminal Backend Experiment and Evaluation](./0009-herdr-terminal-backend-evaluation.md) (superseded)
- [ADR 0008: Polyglot Ingress Router and Durable Admission](./0008-polyglot-ingress-and-admission.md)
- [ADR 0007: Rule Language, Evaluation, Budgets, and Simulation](./0007-rule-language-and-evaluation.md)
- [ADR 0010: Mouse-Native TUI Client and Decoupled Daemon](./0010-tui-daemon-modernization.md)
- Implementation Plan: `docs/implementation-plans/aibridge-herdr-orchestration.md`
