# Operational Guide 04: Herdr Workspace Presentation

> **Topic:** Herdr workspace manager integration, manager plugin, input fencing, and multi-node projection.  
> **Source of Truth:** `ADR 0011`, `src/terminal/herdr-backend.ts`, `src/cli/tui.ts`.

---

## 1. Architectural Core: Inverted Ownership

In AIBridge v3.0.0, Herdr serves as the interactive presentation layer for human operators, replacing bespoke terminal frontends (`aibr-tui`).

> **The Architectural Invariant (ADR 0011):**  
> *Herdr owns the terminal. AIBridge owns the intent. Never both, never either.*

* **Herdr Authority:** Window management, tabs, pane tiling, truecolor VT rendering, process supervision, keyboard focus.
* **Kernel Authority:** Charters, role binding, roundtables, budgets, and dispatch scheduling. External tools consume read-only SSE projections.

---

## 2. Launching the Interactive Workspace (`aibr tui`)

To connect your current terminal workspace to the AIBridge manager:

```bash
aibr tui --profile dev-main
```

### 2.1 Behavior & Detection
1. Checks for the local `herdr` binary on `$PATH`.
2. Verifies the `aibr-manager` plugin exists.
3. Automatically executes `herdr plugin link` to link the manager.
4. If Herdr is not installed, exits cleanly with installation instructions:
   ```
   Herdr is required for interactive terminal presentation.
   Install via Homebrew: brew install herdr
   Or visit: https://github.com/herdrdev/herdr
   ```

---

## 3. Thin Herdr Fork Primitives

AIBridge requires two capabilities implemented in the thin Herdr fork (`herdrdev/herdr` branch `aibr-orchestration`):

### 3.1 Primitive F1: Input-Ownership Fencing
Prevents concurrent human typing and agent command execution on the same pane:
* **API:** `pane.claim_input` and `pane.release_input` via Unix socket with epoch tokens.
* **Enforcement:** Any keystroke or write sent to a pane claimed by an active agent is rejected with error `input_fenced`.
* **Guarantees:** Human operators cannot accidentally interleave commands into an active agent run.

### 3.2 Primitive F2: First-Class Role Tagging
* Native `role` property on agent and pane records.
* Binds directly to the kernel's `RoleSnapshot` cryptographic digest.
* Survives pane movement, window reorganization, and daemon restarts.

---

## 4. Components of the Herdr Manager Plugin (`aibr-manager`)

The manager plugin provides five coordinated views:

1. **Role Grid:**
   * Live agents $\times$ roles matrix.
   * Visualizes effective capability envelope ($\text{allowed} \cap \text{roleAllowed} \cap \neg\text{denied}$).
2. **Charter Editor:**
   * Live inspection of active orchestration system prompt.
   * Real-time Immutable Core validation highlights prohibited relaxations.
3. **Roundtable Live Transcript:**
   * Real-time SSE streaming of pre-execution debates.
   * Allows human operators to inject posts or objections directly into the discussion.
4. **Multi-Machine Grid:**
   * Displays status of all enrolled nodes across the Tailscale mesh.
5. **Approval Queue:**
   * Interactive review queue for pending charter revisions, execution plans, and emergency aborts.

---

## 5. Remote Mesh Federation (`aibr-herdr-bridge`)

When orchestrating multiple machines across a tailnet:
* **Terminal Federation:** Herdr SSH federation connects directly to remote panes over Tailscale.
* **Orchestration Federation:** `aibr-herdr-bridge` subscribes to remote SSE event streams.
* **Projection Tokens:** Remote agents are projected into the local Herdr layout using tokenized naming:
  `$node/$role/$run` (e.g. `test-vps/reviewer/run-449`).
