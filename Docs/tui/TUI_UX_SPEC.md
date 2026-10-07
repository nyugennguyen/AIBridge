# AIBridge TUI: Re-engineered UI/UX & Keybinding Architecture Specification

## 1. Executive Summary

AIBridge TUI is the terminal-native control plane for coordinating CLI AI agents (Claude Code, OpenCode, Codex) across a private Tailscale mesh. 

This specification defines the modern redesign of the TUI's interaction model, layout architecture, and keybinding system, addressing previous ergonomics pain points (e.g. prefix timeout penalties, key chord collisions, hidden approval flows, and poor discoverability).

An interactive live prototype is published as an OpenDesign project:
- **OpenDesign Preview**: `http://127.0.0.1:55715/api/projects/aibridge-tui/raw/index.html`
- **OpenDesign Studio**: `http://127.0.0.1:55726/projects/aibridge-tui/conversations/a210090c-ab57-4a17-93d9-cc205e60e4c2/files/index.html`
- **Local Artifact**: [`Docs/tui/aibridge-tui-redesign.html`](file:///Users/mac/Projects/AIBrigde/Docs/tui/aibridge-tui-redesign.html)

---

## 2. Core UI/UX Layout Architecture

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ AIBridge  [project: AIBridge-v2 / run: #108]   ● tailscale (3 nodes)   1●  1▲  1✔  [?] │ Top Bar
├────────────────────────────────────────────────────────────────────────────────────────┤
│ [Alt+1: ⚡ Dev & Orchestrator]  [Alt+2: 🛡️ Security]  [Alt+3: 🌐 Router]         [+]   │ Tab Bar
├─────────────────────────────────────────┬──────────────────────────────┬───────────────┤
│ Pane 1: claude-code:implementer         │ Pane 2: opencode:auditor     │ Mesh & Run    │
│ macbook-local (Host)       [running]   │ dev-vps        [BLOCKED HITL]│ Inspector     │
│ ─────────────────────────────────────── │ ──────────────────────────── │ ───────────── │
│ $ bun test tests/unit/tui/engine.test   │ 🚨 Plan Review Request #84   │ Enrolled Nodes│
│ ✓ should handle Alt+H/J/K/L nav (1.2ms) │ Risk: Sensitive File Edit    │ macbook-local │
│ ✓ should resolve split seams   (2.1ms) │ [-] token = req.headers...   │ dev-vps (24ms)│
│ ✓ should intercept HITL auth   (0.8ms) │ [+] if (!constantTimeCmp)    │ gpu-cluster   │
│                                         │ [y] Approve  [d] Deny [e] Rev│ Task DAG      │
│ claude@aibr-mesh:~/AIBrigde$ █          ├──────────────────────────────┤ Cost & Tokens │
│                                         │ Pane 3: codex:qa-verifier    │ $0.18 / 24k tk│
│                                         │ gpu-cluster           [DONE] │               │
│                                         │ Exit Code: 0 (18 passed)     │               │
├─────────────────────────────────────────┴──────────────────────────────┴───────────────┤
│ [PASSTHROUGH]  Alt+H/J/K/L: Focus | Alt+V/S: Split | Alt+Z: Zoom | Alt+A: HITL | ? Help│ Status Line
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Visual Hierarchy & Components

1. **Top Master Control Bar (38px)**
   - **Mesh Status & Health**: Live Tailscale connection status, IP address, ping latency, and connected peer count.
   - **Project & Run Breadcrumb**: Direct context of active project, run ID, and workflow state.
   - **Global Agent Status Pills**: Real-time counter of agent states:
     - 🟢 **Working**: Active inference, file I/O, or tool execution.
     - 🟡 **Blocked (HITL)**: Requires human-in-the-loop review (blinking border indicator).
     - 🔵 **Done**: Completed run ready for inspection.
     - 🔴 **Error**: Terminated or failed dispatch.
   - **Quick Command Chips**: Quick mouse or keyboard triggers for Search (`Ctrl+K`), Keymap (`?`), and Inspector (`Alt+B`).

2. **Workspace Tab Bar (32px)**
   - Numbered tabs (`Alt+1`, `Alt+2`, `Alt+3`) with project-scoped views and active agent indicators.
   - Middle-click or `×` icon to close; `+` button or `Alt+N` to spawn a new workspace.

3. **Multi-Pane Flexible Tiling Canvas**
   - **Binary Space Partitioning (BSP)**: Support for arbitrary vertical (`Alt+V`) and horizontal (`Alt+S`) splits.
   - **Mouse-Native Seam Dragging**: Real-time border drag with column/row resize without terminal redraw flicker.
   - **Double-Click Titlebar to Zoom (`Alt+Z`)**: Instantly expands any focused pane to 100% viewport while maintaining layout state.

4. **Human-in-the-Loop (HITL) Interactive Approval Card**
   - Replaces disruptive full-screen modal takeovers with an actionable, embedded inspection card.
   - Displays clear risk stratification badges (`HIGH RISK: DESTRUCTIVE SHELL` vs `MEDIUM RISK: SENSITIVE FILE EDIT`).
   - Side-by-side / unified colorized git diff preview.
   - Instant 1-key actions: `[y]` Approve Once, `[a]` Approve for Session, `[d]` Deny, `[e]` Revise Prompt.

5. **Collapsible Mesh & Task Inspector (`Alt+B`)**
   - Side panel displaying real-time Tailscale topology, ping latencies, Task Dependency DAG, shared memory state, and token cost telemetry ($ / token count).

---

## 3. Re-engineered Keybinding Architecture

### 3.1 Pain Points in Previous Setup
- **Tmux Prefix (`Ctrl+B`) Lag**: A 2-second timeout window caused latency and dropped keystrokes over SSH. In addition, `Ctrl+B` conflicts with standard readline backward-char.
- **Chord Conflicts (`Ctrl+Alt+...`)**: macOS and popular desktop environments hijack `Ctrl+Alt` for window management (e.g. Raycast, Rectangle, Mission Control) and special characters.
- **Discoverability**: Obscure modal help required operators to leave context.

### 3.2 Keybinding Profiles

#### Profile A: Modern Ergonomic (Default)
Optimized for speed, zero prefix delay, and ergonomics on both macOS and Linux.

| Keybinding | Action | Behavior & Rationale |
|:---|:---|:---|
| <kbd>Alt</kbd> + <kbd>H</kbd> / <kbd>J</kbd> / <kbd>K</kbd> / <kbd>L</kbd><br>or <kbd>Alt</kbd> + <kbd>Arrows</kbd> | **Focus Navigation** | Move focus left, down, up, right. Instantaneous, prefix-free, zero latency. |
| <kbd>Alt</kbd> + <kbd>V</kbd> | **Split Vertically** | Divides the current pane vertically 50/50. |
| <kbd>Alt</kbd> + <kbd>S</kbd> or <kbd>Alt</kbd> + <kbd>-</kbd> | **Split Horizontally** | Divides the current pane horizontally 50/50. |
| <kbd>Alt</kbd> + <kbd>Z</kbd> | **Toggle Zoom** | Maximizes current pane to 100% or restores split layout. |
| <kbd>Alt</kbd> + <kbd>W</kbd> | **Close Pane** | Closes focused pane gracefully. |
| <kbd>Alt</kbd> + <kbd>1</kbd> .. <kbd>9</kbd> | **Switch Workspace Tab** | Jumps directly to corresponding workspace tab. |
| <kbd>Alt</kbd> + <kbd>A</kbd> | **Focus Approval Card** | Direct focus jump to any pending HITL approval card. |
| <kbd>y</kbd> / <kbd>d</kbd> / <kbd>e</kbd> | **HITL Decision** | When approval card is focused: `[y]` Approve, `[d]` Deny, `[e]` Revise. |
| <kbd>Alt</kbd> + <kbd>B</kbd> | **Toggle Sidebar** | Expand or collapse the Mesh & Run Inspector. |
| <kbd>Ctrl</kbd> + <kbd>K</kbd> / <kbd>Cmd</kbd> + <kbd>K</kbd> | **Universal Command Palette** | Fuzzy search actions, workspaces, agents, and configs. |
| <kbd>Alt</kbd> + <kbd>[</kbd> or <kbd>PageUp</kbd> | **Copy / Scrollback Mode** | Enters vi scrollback buffer (`h`, `j`, `k`, `l`, `/`, `y`). |
| <kbd>Esc</kbd> | **Back / Cancel / Unzoom** | Dismisses palettes, restores zoom, or clears focus. |
| <kbd>Ctrl</kbd> + <kbd>B</kbd> <kbd>q</kbd> | **Safe Detach** | Detaches client cleanly without terminating daemon jobs or PTYs. |

#### Profile B: Tmux Classic (For Tmux Veterans)
- Configurable prefix (`Ctrl+B` or `Ctrl+A`).
- `prefix + c`: New tab.
- `prefix + %` or `v`: Split vertical.
- `prefix + "` or `-`: Split horizontal.
- `prefix + z`: Zoom.
- `prefix + [`: Copy mode.
- `prefix + d`: Detach session.

---

## 4. Mouse-Native Interaction Invariants

1. **Click to Focus**: Clicking anywhere inside a terminal pane instantly acquires input focus.
2. **Dynamic Divider Drag**: Hovering over horizontal or vertical seam dividers turns cursor into `col-resize` / `row-resize`; drag smoothly recalibrates layout flex ratio.
3. **Double-Click Titlebar**: Toggles pane zoom/maximize.
4. **Context Menu**: Right-click provides quick actions (Copy, Paste, Split, Clear Scrollback, Inspect Node).
5. **Scroll Wheel Passthrough**: Automatically scrolls active terminal scrollback buffer without needing manual copy mode.
