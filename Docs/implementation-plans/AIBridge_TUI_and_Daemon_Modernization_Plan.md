# AIBridge TUI & Background Architecture Modernization Plan

This document provides a comprehensive, production-ready modernization plan for [**AIBridge**](https://github.com/nyugennguyen/AIBridge) (`aibr`), incorporating design principles and patterns from [**Herdr**](https://github.com/herdrdev/herdr). It spans the entire stack: the headless background server/daemon, the interactive multi-pane TUI runtime, an interactive onboarding wizard for `aibr setup`, and a parallel sub-agent execution prompt for `oh-my-pi` / `opencode`.

---

## 1\. Executive Summary & Architectural Overview

### 1.1 Objective

Upgrade AIBridge from a basic request-forwarding gateway into a resilient, mouse-native, multi-tenant terminal workspace manager designed specifically for coordinating local [OpenCode](https://github.com/nyugennguyen/AIBridge) AI instances across private **Tailscale** networks.

### 1.2 Core Architectural Invariants

1. **Daemon-Client Decoupling**: The background server (`aibr-router` \+ `aibr-worker`) retains all state, SQLite queues, OpenCode child processes, and pseudo-terminals (PTYs). The client interface (`aibr tui`) is an ephemeral, immediate-mode presentation layer that can attach or detach (`Ctrl+B q`) without disrupting background jobs.  
2. **Deterministic Agent State Machine**: Standardize agent execution into four core states:  
   * `working`: Agent is actively analyzing code, reading ASTs, or generating patches.  
   * `blocked`: Agent requires human-in-the-loop (HITL) authorization (plan review, sensitive file edits, destructive shell executions).  
   * `done`: Agent completed its goal; waiting for user inspection.  
   * `idle`: Session is idle and ready for incoming tasks.  
3. **Embedded Virtual Terminal (VT) Emulation**: Every active OpenCode pane embeds a full virtual terminal parser (via `ghostty-vt` or `vte`) that maps ANSI/VT sequences, truecolor styles, and cursor positions directly into [Ratatui](https://github.com/ratatui/ratatui) buffer cells.  
4. **Dual Input Subsystem**:  
   * **Mouse-Native**: SGR 1006 tracking, live border dragging for pane resizing, right-click context menus, copy-on-select to clipboard, and wheel scrolling.  
   * **Keyboard-Centric**: Transparent terminal passthrough, tmux-style prefix mode (`Ctrl+B`), prefix-free direct chords (`Ctrl+Alt`), vi-style copy mode, and readline-compatible modal inputs.  
5. **Interactive Onboarding (`aibr setup`)**: A guided, validation-driven wizard that verifies network topology, generates security credentials, configures allowlists, initializes SQLite storage, and installs daemon system services.

---

### 1.3 High-Level Component Topology

               Tailscale Network (100.64.0.0/10)

                             │

                             ▼

┌─────────────────────────────────────────────────────────────┐

│ Tier 1: aibr-router (Native Rust)                           │

│ • Constant-time Bearer Token Authentication                 │

│ • Body Size Capping & Structural JSON Schema Validation    │

│ • Commit-Before-202 Ingress Queue (SQLite WAL)              │

└────────────────────────────┬────────────────────────────────┘

                             │ durable outbox insert

                             ▼

┌─────────────────────────────────────────────────────────────┐

│ Tier 2: aibr-worker Daemon (Rust / Bun Runtime)             │

│ • SQLite Lease Claimer & Ingress Queue Drainer              │

│ • Semantic Authorization & Project Allowlist Engine         │

│ • Automated Secret Redaction Pipeline                       │

│ • OpenCode PTY & Process Coordinator (portable-pty)        │

│ • Local IPC Socket Server (Unix Domain Socket / Named Pipe) │

└────────────────────────────┬────────────────────────────────┘

                             │ Local IPC (Events, State Diffs, PTY I/O)

                             ├─────────────────────────────────────────┐

                             ▼                                         ▼

┌─────────────────────────────────────────┐ ┌─────────────────────────────────────────┐

│ aibr-tui Client (Ratatui \+ Crossterm)   │ │ aibr setup (Interactive Onboarding)     │

│ • Hierarchical Multi-Pane Workspace     │ │ • Step-by-step Stepper Wizard           │

│ • Embedded Ghostty-VT Emulation Engine  │ │ • Tailscale IP & Token Auto-Discovery   │

│ • Dual Mouse & Keyboard Event Engine    │ │ • Project Allowlist & Path Picker       │

│ • HITL Plan Review & Approval Modals    │ │ • System Service Daemonizer             │

└─────────────────────────────────────────┘ └─────────────────────────────────────────┘

---

## 2\. Detailed Stage-by-Stage Implementation Plan

---

### Phase 1: Interactive Onboarding & Environment Wizard (`aibr setup`)

#### 1.1 Scope & Objective

Replace manual JSON/environment configuration with an interactive, wizard-style TUI invoked via `aibr setup`. The wizard validates prerequisites, configures security credentials, establishes project allowlists, and verifies loopback OpenCode connectivity before first launch.

#### 1.2 Onboarding Workflow & Step Architecture

The onboarding flow is modeled as a multi-step state machine with interactive form widgets:

┌─────────────────────────────────────────────────────────────────────────────────────────┐

│ AIBridge Setup Wizard ── Step 2 of 5: Security & Tailscale Invariants                   │

├─────────────────────────────────────────────────────────────────────────────────────────┤

│ \[1. Network\] ──▶ \[2. Security\] ──▶ \[3. Allowlists\] ──▶ \[4. OpenCode\] ──▶ \[5. Install\]   │

├─────────────────────────────────────────────────────────────────────────────────────────┤

│ Tailscale Interface Discovery:                                                          │

│   ✔ Tailscale daemon running (tailscaled)                                               │

│   ✔ Bound IP: 100.64.42.18                                                              │

│                                                                                         │

│ Router Security Configuration:                                                          │

│   Listening Port:      \[ 4095                 \]                                         │

│   Bearer Auth Token:   \[ aibr\_sec\_8f9024b81c2e4318a9942a1b94d1f05e                  \]   │

│                        (Generated via CSPRNG \- Click \[Regenerate\] or press 'r')         │

│                                                                                         │

│ Security Invariants Enforcement:                                                        │

│   \[\*\] Enable constant-time token comparison                                             │

│   \[\*\] Enforce strict payload body limit (Default: 2 MB)                                 │

│   \[\*\] Enable automated secret redaction for telemetry & audit logs                      │

│                                                                                         │

│ SQLite Queue Storage Location:                                                          │

│   Database Path:       \[ \~/.local/share/aibridge/queue.db     \]                         │

│   Storage Mode:        (•) WAL Mode (Recommended)   ( ) Standard Rollback               │

│                                                                                         │

├─────────────────────────────────────────────────────────────────────────────────────────┤

│ \[◄ Back (Esc)\]            \[Test Tailscale Connectivity\]             \[Continue (Enter) ►\]│

└─────────────────────────────────────────────────────────────────────────────────────────┘

#### 1.3 Step Breakdown

1. **Step 1 — Tailscale & Network Topology**:  
   - Queries `tailscale status --json` to detect local Tailscale IP (`100.64.0.0/10`).  
   - Validates whether the ingress port (default: 4095\) is free.  
2. **Step 2 — Security & Token Generation**:  
   - Generates a cryptographically secure 256-bit Bearer token (`aibr_sec_...`).  
   - Configures rate limiting, payload capping (default 2MB), and secret-redaction flags.  
   - Sets SQLite database location and enforces `WAL` journal mode with `busy_timeout=5000`.  
3. **Step 3 — Project Allowlists & Workspace Roots**:  
   - Interactive multi-select directory picker.  
   - Allows users to specify safe project paths where OpenCode instances may execute.  
   - Sets file-system boundary isolation to prevent agents from traversing root directories.  
4. **Step 4 — OpenCode Loopback Diagnostics**:  
   - Pings local OpenCode server on loopback (`http://127.0.0.1:4096/v1/health` or CLI binary check).  
   - If not detected, offers an auto-start configuration or inline instructions to install OpenCode.  
5. **Step 5 — System Service Installation & Verification**:  
   - Generates and installs background service units:  
     - Linux: `systemd/user/aibridge.service`  
     - macOS: `~/Library/LaunchAgents/com.aibridge.daemon.plist`  
     - Windows: Windows Background Service registration  
   - Runs an end-to-end self-test by injecting a test job into `ingress_outbox` and validating lease acquisition.

#### 1.4 Mouse & Keyboard Navigation in Setup

* **Mouse**: Click any text box to focus, click checkboxes `[*]` to toggle, click buttons `[Continue]` / `[Back]`, and click file path pickers.  
* **Keyboard**: `Tab` / `Shift+Tab` to move between form elements; `Space` to toggle switches; `Enter` to confirm/submit; `Esc` to step back.

---

### Phase 2: Background Daemon & Bidirectional IPC Layer

#### 2.1 Scope & Objective

Establish a persistent IPC event bus between the background runtime (`aibr-router` \+ `aibr-worker`) and frontend clients. This ensures the TUI remains purely reactive and side-effect-free during rendering.

#### 2.2 Technical Features

* **IPC Transport**: Create a local Unix Domain Socket at `/var/run/aibr/daemon.sock` (POSIX) or Named Pipe `\\.\pipe\aibr-daemon` (Windows) using the `interprocess` crate.  
* **Message Protocol**: Framed JSON-RPC or binary `bincode` messages carrying:  
  * `StateSnapshot`: Complete workspace topology, project allowlists, active panes, and queued jobs.  
  * `StateDiff`: Real-time delta updates (`JobStateChanged`, `QueueItemAdded`, `LeaseAcquired`).  
  * `PtyStream`: Bidirectional raw byte stream between the client pane and the OpenCode PTY.  
  * `ControlCommand`: Client actions (`ApprovePlan`, `RejectPlan`, `CancelJob`, `ResizePane`, `SpawnAgent`).  
* **PTY Process Management**: Wrap OpenCode invocations inside pseudo-terminals via `portable-pty`. Capture raw stdout/stderr for streaming, while honoring window size change events (`SIGWINCH` / `PtySize`).

#### 2.3 Workflow

1. When a job is accepted by `aibr-router` into SQLite `ingress_outbox`, the daemon emits a `QueueItemAdded` event over the IPC socket.  
2. When `aibr-worker` claims the lease, it initializes a PTY session for OpenCode and broadcasts `JobStateChanged { id, state: Working }`.  
3. If OpenCode triggers a plan review or sensitive file edit, the worker sets `state: Blocked` with payload `PlanPayload` and notifies all attached TUI clients.

---

### Phase 3: High-Performance Rust TUI Shell & Layout Engine

#### 3.1 Scope & Objective

Build a 60fps immediate-mode TUI using [Ratatui](https://github.com/ratatui/ratatui) and [Crossterm](https://github.com/crossterm-rs/crossterm) with hierarchical layout management.

#### 3.2 TUI Visual Architecture & Mockup

┌─────────────────────────────────────────────────────────────────────────────────────────────────┐

│ AIBridge 0.9.0 │ Space: my-ecommerce │ Tailscale: 100.64.1.42 (Active) │ Ingress Outbox: 3 pending│

├──────────────────────┬──────────────────────────────────┬───────────────────────────────────────┤

│ WORKSPACES           │ PANE 1: OpenCode Session (Agent) │ PANE 2: Plan Review & Security Diff   │

│ ▶ web-store (main)   │ ┌──────────────────────────────┐ │ ┌───────────────────────────────────┐ │

│   ├─ job-4812 \[●\]    │ │ \$ opencode refactor /api/v1  │ │ │ Target: src/controllers/order.ts  │ │

│   └─ job-4815 \[✔\]    │ │ Reading AST tree...          │ │ │ Risk Score: MEDIUM (DB mutation)  │ │

│ ▼ data-pipeline      │ │ Applying rule set: ts-strict │ │ │                                   │ │

│   └─ job-4819 \[▲\]    │ │ Synthesizing patch:          │ │ │ \- await db.orders.deleteMany();   │ │

│                      │ │ \> order\_controller.ts        │ │ │ \+ await db.orders.softDelete();   │ │

│ INGRESS QUEUE        │ └──────────────────────────────┘ │ │                                   │ │

│ • \[202\] req-9011 (0s)├──────────────────────────────────┴─┤ Status: BLOCKED \[Plan Confirmation\] │

│ • \[202\] req-9012 (2s)│ PANE 3: Live Audit & Redaction Log │                                   │ │

│ • \[202\] req-9013 (5s)│ \[23:18:01\] Redacted: Bearer sk-ant-\*\*\* │ \[Approve: Space\] \[Reject: Esc\] │ │

│                      │ \[23:18:04\] Rule check: Project Allowlist verified for 'data-pipeline'   │ │

├──────────────────────┴──────────────────────────────────────────────────────────────────────────┤

│ \[Ctrl+B c\] New Tab │ \[Ctrl+B v\] Split │ \[Ctrl+B z\] Zoom │ \[Ctrl+B q\] Detach │ \[Click/Drag\] Mouse│

└─────────────────────────────────────────────────────────────────────────────────────────────────┘

#### 3.3 Layout Engine Implementation

* **Binary Space Partitioning (`TileLayout`)**:  
  * Organize panes as a recursive tree of vertical and horizontal splits.  
  * Every leaf node retains a normalized floating-point ratio (`split_ratio: 0.5`).  
  * In the render pass, compute exact bounding boxes (`ratatui::layout::Rect`) for every pane and split border.  
* **Component Partitioning**:  
  * **Top Bar (Height 1\)**: System health, Tailscale node status, outbox count, active workspace name.  
  * **Collapsible Sidebar (Width 24-32, toggleable via `Ctrl+B b`)**: Tree view of projects, active jobs, and pending ingress queue items.  
  * **Central Pane Canvas**: Evaluated by `TileLayout`.  
  * **Bottom Status Bar (Height 1\)**: Keybinding cheatsheet, current input mode indicator (`TERMINAL`, `PREFIX`, `NAVIGATE`, `COPY`).

---

### Phase 4: Interactive PTY Panes & Human-in-the-Loop (HITL) Plan Review

#### 4.1 Scope & Objective

Embed live terminal emulation into Ratatui panes to enable streaming OpenCode session outputs and build a human-in-the-loop review workflow for `blocked` agents.

#### 4.2 Technical Features

* **Virtual Terminal Engine (`crates/ghostty-vt` or `vte`)**:  
  * Maintain an in-memory terminal screen grid for each pane.  
  * Parse incoming PTY bytes into ANSI cells (glyphs, 24-bit RGB colors, bold, italic, underline, alternate screen buffers).  
  * Direct rendering: In the Ratatui draw loop, copy cells from the VT grid into Ratatui's `Buffer` within the pane's `Rect`.  
* **Plan Review & Diff Widget**:  
  * When a job enters `blocked`, parse the agent's proposed plan, modified files, and shell commands.  
  * Syntax-highlight unified diffs with green/red spans and alert markers for sensitive operations.  
* **Floating Approval Modal**:  
  * Render an overlay centered dialog using `ratatui::widgets::Clear` to clear background cells.  
  * Offer contextual actions: `Approve and Apply`, `Approve Step-by-Step`, `Reject with Instructions`, `Abort Job`.

┌────────────────── Human-in-the-Loop Plan Review ──────────────────┐

│ Job: job-4819 (data-pipeline)                                      │

│ Initiator: remote-dev@tailscale                                   │

│                                                                   │

│ The agent requests execution of an unlisted shell command:        │

│   \$ rm \-rf /tmp/cache && migrate-schema \--force                   │

│                                                                   │

│ Reason: Cache invalidation required for schema alignment          │

│ Secret Inspection: Clean (No exposed tokens or private paths)     │

│                                                                   │

│           \[ Approve (Enter) \]       \[ Reject (Esc) \]              │

└───────────────────────────────────────────────────────────────────┘

#### 4.3 Workflow

1. Agent attempts an action requiring user verification.  
2. `aibr-worker` shifts job state to `blocked` and pauses the PTY process.  
3. The TUI receives the event, rings the terminal bell, highlights the sidebar job with a yellow badge `[▲]`, and displays the Floating Approval Modal.  
4. The operator reviews the diff and approves via `Enter` or mouse click.  
5. The TUI sends `ControlCommand::ApprovePlan { job_id }` over the IPC socket.  
6. The worker resumes the PTY and sets job state to `working`.

---

### Phase 5: Mouse-Native Interactions & Advanced Keyboard Modes

#### 5.1 Scope & Objective

Implement parity with Herdr's mouse and keyboard engine, making keyboard navigation optional and enabling fluid mouse interaction across the entire TUI.

#### 5.2 Mouse Interaction System (`src/app/input/mouse.rs`)

* **Terminal Initialization**: Enable mouse reporting by executing Crossterm's `EnableMouseCapture` (SGR 1006).  
* **Hit-Testing**: Use the bounding geometry computed during the layout pass to map any `(col, row)` event to a specific target:  
  * **Pane Focus**: Single-click inside any pane boundary shifts focus immediately.  
  * **Border Drag Resizing**:  
    * If `MouseEventKind::Down` or `Drag` occurs on a 1-character split border, calculate delta \$\\Delta x\$ or \$\\Delta y\$.  
    * Dynamically adjust `split_ratio` on the active `TileLayout` node and re-render at 60fps.  
  * **Right-Click Context Menu**:  
    * `RightClick` at `(col, row)` opens a popup menu at that coordinate.  
    * Menu items: `Split Vertical`, `Split Horizontal`, `Close Pane`, `View Outbox Item`, `Copy Raw Logs`.  
  * **Copy-on-Select**:  
    * `MouseDown` records `Selection::anchor(col, row)`.  
    * `MouseDrag` paints an inverted background color over selected VT grid cells.  
    * `MouseUp` extracts text from the VT buffer, writes to the OS clipboard, and briefly displays a `Copied to clipboard` notification toast.  
  * **Smooth Scrolling**: Forward `ScrollUp` / `ScrollDown` events to scroll the active pane's scrollback buffer (3 lines per notch).  
  * **Link Handling**: `Ctrl + LeftClick` on a URL or OSC 8 hyperlink triggers system browser opening.

#### 5.3 Keyboard Engine & Modes (`src/app/input/keyboard.rs`)

* **Terminal Mode (Default)**: Raw key events forward directly to the active PTY, preserving nested CLI keybindings (including `Ctrl+C`, `Shift+Enter`, and escape sequences).  
* **Prefix Mode (`Ctrl+B`)**:  
  * Press `Ctrl+B`: Enters prefix state. Next key is intercepted by AIBridge.  
  * Keymap:  
    * `c`: New tab / workspace.  
    * `v` / `-`: Split pane vertically / horizontally.  
    * `h` / `j` / `k` / `l` or arrow keys: Move focus between split panes.  
    * `z`: Zoom / toggle full-screen for active pane.  
    * `[`: Enter **Copy Mode** (navigate pane history with vi keys `h/j/k/l`, `/` search, `v` select, `y` yank).  
    * `q`: Detach TUI client safely.  
* **Prefix-Free Direct Chords**: Map conflict-free chords such as `Ctrl+Alt+H/J/K/L` (pane switching) and `Ctrl+Alt+D` (split) to bypass prefix mode entirely.

---

### Phase 6: Session Detach/Persistence & Production Hardening

#### 6.1 Scope & Objective

Ensure complete decoupling between the TUI presentation layer and daemon jobs, guaranteeing zero data loss during network interruptions or client detachment.

#### 6.2 Technical Features

* **Safe Client Detachment**: When the client detaches (`Ctrl+B q` or closed terminal window), the IPC connection closes gracefully. The background daemon continues running all PTYs, drains the SQLite queue, and maintains process logs.  
* **Client Re-Attachment**: When running `aibr tui` again, the client connects to the IPC socket, requests a full `StateSnapshot`, re-creates the active `TileLayout`, hydrates the VT terminal buffers from daemon scrollback memory, and resumes real-time rendering.  
* **Telemetry & Redaction Self-Audit**: Ensure that text selected via mouse or logs displayed in Pane 3 strictly pass through the existing automated secret-redaction filters (scrubbing Bearer tokens, private paths, and internal prompts).

---

## 3\. Sub-Agent Execution Prompt for `oh-my-pi` / `opencode` (`/goal`)

Below is the execution prompt formatted for `oh-my-pi` or `opencode`. It uses the `/goal` command and instructs the orchestrator to deploy 5 parallel sub-agents across isolated workstreams.

/goal Modernize AIBridge (aibr) with a mouse-native multi-pane TUI, an interactive onboarding setup wizard, an embedded VT terminal engine, and a decoupled background daemon modeled after Herdr's architecture.

\#\#\# Orchestration & Execution Strategy

You are the Lead Systems Architect. You are authorized and instructed to aggressively spawn parallel sub-agents to execute independent workstreams simultaneously.

\#\#\# Architecture & Tech Stack

\- \*\*Daemon / Worker Backend\*\*: Rust (\`router/\`) \+ Bun/TypeScript (\`src/\`).

\- \*\*TUI & Setup Wizard\*\*: Rust (\`crates/aibr-tui\`), \[Ratatui 0.30\](https\://github.com/ratatui/ratatui), \[Crossterm 0.29\](https\://github.com/crossterm-rs/crossterm), \`portable-pty\`, \`interprocess\`, and headless VT parser (\`ghostty-vt\` or \`vte\`).

\- \*\*Data & Invariants\*\*: SQLite WAL \`ingress\_outbox\` (commit-before-202 invariant), automated secret redaction, and Tailscale boundary enforcement.

\---

\#\#\# Sub-Agent Task Allocations

\#\#\#\# Sub-Agent 1: Interactive Onboarding Wizard (\`aibr setup\`)

1\. Implement the \`aibr setup\` CLI command and interactive TUI stepper wizard using Ratatui.

2\. Step 1: Query \`tailscale status \--json\` to detect Tailscale interface IP and verify port availability.

3\. Step 2: Generate CSPRNG 256-bit Bearer token (\`aibr\_sec\_...\`), configure payload caps, and initialize SQLite database with \`WAL\` mode and \`busy\_timeout=5000\`.

4\. Step 3: Implement interactive multi-select directory picker for project allowlists.

5\. Step 4: Add diagnostic ping for local OpenCode loopback (\`127.0.0.1:4096\`).

6\. Step 5: Implement system service daemonizer for systemd, launchd, and Windows services, followed by an end-to-end self-test.

7\. Support both mouse clicks and keyboard form navigation (\`Tab\`, \`Space\`, \`Enter\`, \`Esc\`).

\#\#\#\# Sub-Agent 2: IPC Bus & Daemon Protocol (Workstream: Backend/IPC)

1\. In \`contracts/v1/\`, define schema contracts for bidirectional IPC: \`StateSnapshot\`, \`StateDiff\`, \`JobState\` (\`working\`, \`blocked\`, \`done\`, \`idle\`), \`PtyChunk\`, and \`ControlCommand\`.

2\. Implement local IPC server in Rust (\`router/src/ipc/\` or \`daemon/\`) using \`interprocess\` (Unix Domain Socket on POSIX, Named Pipe on Windows).

3\. Connect \`aibr-worker\` (Bun/TS) to publish real-time state changes and drain events from SQLite WAL queue into the IPC bus.

4\. Wrap OpenCode CLI execution inside \`portable-pty\` to capture raw I/O and support dynamic terminal window resizing (\`PtySize\`).

\#\#\#\# Sub-Agent 3: Ratatui Shell & BSP Layout Engine (Workstream: TUI Core)

1\. Scaffold \`crates/aibr-tui\` with Ratatui 0.30 and Crossterm 0.29.

2\. Implement the hierarchical layout:

   \- Top Header Bar: Tailscale status, active workspace, and outbox count.

   \- Collapsible Left Sidebar: Project tree, agent status indicators (\`working\`, \`blocked\`, \`done\`, \`idle\`), and pending queue list.

   \- Central Main View: Binary Space Partitioning (\`TileLayout\`) supporting recursive vertical/horizontal splits and zoom toggling.

   \- Bottom Status Bar: Current mode indicator and contextual keybinding hints.

3\. Implement IPC client listener in \`aibr-tui\` that hydrates local state from \`StateSnapshot\` and streams live updates.

\#\#\#\# Sub-Agent 4: Embedded Terminal Emulation & HITL Approval Modal (Workstream: Agent UI)

1\. Integrate \`vte\` or vendored \`ghostty-vt\` binding to parse raw PTY stream from OpenCode into an in-memory terminal screen grid.

2\. Implement custom Ratatui widget \`PtyTerminalWidget\` that maps VT cells, 24-bit RGB colors, and cursor coordinates directly into Ratatui buffer cells.

3\. Build the \*\*Plan Review & Diff Widget\*\*: Render syntax-highlighted diffs and modified files when an agent triggers plan evaluation.

4\. Implement the \*\*Floating Approval Modal\*\*: Center-aligned modal overlay triggered when a job is \`blocked\`. Provide interactive \`\[Approve\]\` and \`\[Reject\]\` actions with justification inputs.

\#\#\#\# Sub-Agent 5: Mouse-Native Subsystem & Keyboard State Machine (Workstream: Input)

1\. Configure Crossterm \`EnableMouseCapture\` (SGR 1006 tracking).

2\. Implement hit-testing engine mapping \`(col, row)\` coordinates to layout rectangles:

   \- Click to focus panes and select sidebar workspaces.

   \- Split border dragging: detect mouse drag on pane boundaries and adjust \`split\_ratio\` in real-time.

   \- Right-click context menus: popup menu for split, close, and inspect actions.

   \- Copy-on-select: drag to highlight VT text cells, auto-copy to system clipboard on mouse-up.

   \- Mouse wheel: scroll pane scrollback and list views.

3\. Implement the multi-tier keyboard state machine:

   \- \`Terminal Mode\`: Raw passthrough of keystrokes to active PTY.

   \- \`Prefix Mode\` (\`Ctrl+B\`): Handle \`c\` (new tab), \`v\` (split vertical), \`-\` (split horizontal), \`h/j/k/l\` (focus navigation), \`z\` (zoom), \`q\` (detach).

   \- \`Prefix-free Chords\`: Bind \`Ctrl+Alt+H/J/K/L\` for instant pane switching.

   \- \`Copy Mode\` (\`Ctrl+B \[\`): Vi-style scrollback navigation and text searching.

\---

\#\#\# Verification & Acceptance Criteria

1\. \`cargo check\` and \`cargo test\` pass across all workspace crates without warnings.

2\. \`aibr setup\` launches successfully, guides through all 5 steps with mouse and keyboard, and writes valid config and system service units.

3\. \`aibr tui\` launches, connects to running daemon via IPC, and reflects live changes in SQLite \`ingress\_outbox\`.

4\. OpenCode session terminal renders ANSI output with correct layout proportions and responsiveness.

5\. Simulating a security violation or plan review immediately transitions the agent to \`blocked\` and renders the Floating Approval Modal.

6\. Mouse drag on split borders resizes panes smoothly without visual tearing or flickering.

7\. Detaching client via \`Ctrl+B q\` leaves background OpenCode processes running; re-running \`aibr tui\` seamlessly restores the session.

8\. Automated secret redaction verifies all streamed logs and clipboard copies remain scrubbed.