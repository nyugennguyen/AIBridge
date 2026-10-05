# ADR 0009: Herdr Terminal Backend Experiment and Evaluation

- **Status:** Evaluated / DEFERRED for Production Inclusion
- **Date:** 2026-10-05
- **Authors:** AIBridge Architecture & Hardening Team
- **Deciders:** Core Engineering Team, Release Gate
- **Related Milestones:** Milestone 8 (M8.8), Milestone 4 (Mesh), Milestone 7 (Polyglot Ingress)
- **Supersedes / Amends:** N/A (Herdr evaluated as optional `TerminalBackend`)

---

## 1. Context and Objective

Herdr is an autonomous agent workspace manager providing multi-tab, multi-pane terminal abstractions with local process supervision. Milestone 8 task M8.8 mandates a time-boxed spike to evaluate whether Herdr should be adopted as a first-class production `TerminalBackend` in AIBridge, deferred, or rejected.

The evaluation specifically examined six criteria:
1. Mapping AIBridge terminal/session operations to Herdr workspace/tab/pane primitives.
2. State-authority interaction with AIBridge runtime adapters.
3. Input ownership and remote attach behavior (`SF-10`).
4. Recovery and identity mapping across process restarts.
5. Version/API stability and distribution impact.
6. Security boundary and required OS privileges.

---

## 2. Technical Evaluation

### 2.1 Primitive Mapping (AIBridge vs. Herdr)
- **AIBridge Model:** Terminal abstraction is strictly decoupled from agent orchestration. A `TerminalReference` represents an isolated PTY session (`columns`, `rows`, `bufferByteLimit`), while orchestration state lives in the append-only event store (`run_streams`, `run_events`).
- **Herdr Model:** Herdr couples terminal panes to an internal workspace tree (`workspace -> tab -> pane -> agent`). Herdr panes assume interactive graphical/TUI multiplexing rather than headless RPC-driven stream pipes.
- **Impedance Mismatch:** Forcing AIBridge `TerminalBackend` operations (`create`, `attach`, `resize`, `snapshot`, `terminate`) onto Herdr panes requires translating headless background daemon lifecycles into Herdr workspace tree nodes, introducing artificial pane allocations that no human views.

### 2.2 State-Authority Interaction
- **Inviolable Principle (ADR 0001 / ADR 0008):** AIBridge possesses exactly ONE source of truth: the kernel event store and controller lease. No external broker or secondary daemon may claim authoritative lifecycle state.
- **Herdr Conflict:** Herdr maintains its own process manager, state database, and session lifecycle state machine. Adopting Herdr as a production backend would introduce a competing state authority. If Herdr crashes or restarts a pane independently, AIBridge's controller epoch and lease tracking would diverge from physical process reality.

### 2.3 Input Ownership and Remote Attach (`SF-10`)
- **Requirement:** AIBridge enforces single-input-owner semantics via atomic takeover tokens (`takeOverInput`, `requestInputOwnership`, `releaseInputOwnership`) over Tailscale WebSocket gateways.
- **Herdr Behavior:** Herdr does not expose atomic input ownership fencing tokens over its socket API. Concurrent attachment in Herdr allows multiple concurrent keystroke injections into the same pane, violating AIBridge's input fencing security invariant.

### 2.4 Recovery and Identity Mapping Across Restarts
- **AIBridge Requirement:** A terminal must be deterministically recoverable using durable identifiers (`terminalId`, `sessionId`, `nodeId`) across daemon restarts without state loss.
- **Herdr Behavior:** Herdr assigns transient UUIDs or pane indices upon restart. Mapping ephemeral pane handles back to persistent AIBridge session records requires an out-of-band translation registry with complex reconciliation edge cases.

### 2.5 Distribution and Packaging Impact
- **Constraint:** AIBridge is packaged as a minimal, standalone npm CLI (`aibr`) and statically-linked Rust binary (`aibr-router`), targeting musl Linux and macOS with zero unnecessary system dependencies.
- **Impact:** Requiring Herdr as a production dependency would add external process dependencies, unverified desktop runtime requirements, and platform-specific daemon installation steps that fail the clean-machine installation gate.

### 2.6 Security Boundary and Privilege Separation
- **Threat Model:** AIBridge runtime adapters operate with strict capability bounds (sandboxed filesystem, restricted network, no policy bypass).
- **Herdr Privilege Profile:** Herdr daemon requires broad access to user desktop session buses, global process management, and local sockets, enlarging the attack surface without providing measurable operational benefits over `tmux`.

---

## 3. Decision

**DEFER adoption of Herdr for production distribution.**

1. **Production Backend Remains Tmux / PTY:** `TmuxTerminalBackend` remains the sole production-supported `TerminalBackend` for Milestone 8 release candidates. It satisfies all POSIX isolation, single-input-owner fencing, and headless daemon recovery requirements.
2. **Experimental SDK Extension Only:** A prototype spike adapter (`HerdrExperimentalTerminalBackend`) is retained in experimental/test harnesses using the public Extension SDK (`src/sdk/`). It is NOT linked into production runtime dependencies (`package.json` dependencies remains zero for Herdr).
3. **No Secondary Authority:** Under no circumstances will Herdr primitives be permitted to supersede or compete with AIBridge orchestration event stores.

---

## 4. Revisit Conditions

This decision may be revisited in a future ecosystem milestone if:
1. Herdr publishes a stable, versioned daemon IPC protocol with atomic input-ownership fencing primitives.
2. Headless server mode is supported without graphical workspace coupling.
3. Third-party adoption requests warrant publishing a community SDK package (`@nyugennguyen/aibridge-backend-herdr`).
