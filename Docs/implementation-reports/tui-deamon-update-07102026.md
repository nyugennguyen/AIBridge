 AIBridge Systems Engineering Summary Report: TUI Control Plane & Onboarding Wizard Modernization

 ────────────────────────────────────────────────────────────────────────────────

 1. Executive Summary

 This implementation session executed two major architectural modernization milestones for AIBridge (aibr v2.0):

 1. Modernized TUI Control Plane Client (crates/aibr-tui, src/tui):
    Re-engineered the terminal control plane according to ADR 0010 (../../Docs/adr/0010-tui-daemon-modernization.md) and Docs/tui/TUI_UX_SPEC.md (../../Docs/tui/TUI_UX_SPEC.md).
    Delivered a mouse-native, multi-pane terminal workspace manager featuring zero-prefix Alt-chords (Profile A), an embedded non-disruptive Human-in-the-Loop (HITL) approval card, a
    universal fuzzy command palette (Ctrl+K), an interactive keymap switcher (?), and a collapsible 28-column mesh/telemetry inspector (Alt+B).
 2. Brand Vector/ANSI Identity & 5-Step Stepper Onboarding Wizard (src/cli/, crates/aibr-tui):
    Replaced legacy sequential readline prompts in aibr setup with a mouse-and-keyboard interactive 5-step stepper interface matching Docs/tui/aibridge-setup-wizard.html
    (../../Docs/tui/aibridge-setup-wizard.html), Docs/assets/logos/logo-design-system.html (../../Docs/assets/logos/logo-design-system.html), and SKILL.md
    (../../.agents/skills/aibr-onboarding/SKILL.md). Embedded high-resolution vector/ANSI glyphs into the TUI chrome and CLI splash sequence, automated Tailscale discovery, enforced a
    128-bit CSPRNG bearer token security floor, and generated system supervisors (launchd/systemd).

 ```
+----------------------------------------------------------------------------------------------------+
| ╭─▲─╮ ◈ AIBridge [project: web-store / run: #108] ● tailscale (3 nodes) 🟢1 🟡1 🔵0  [Ctrl+K] [? Keymap] [Alt+B] | Top Header (2 rows)
+----------------------------------------------------------------------------------------------------+
| [Alt+1: api-gateway ×] [Alt+2: web-store ×] [+]                                                    | Tab Bar (1 row)
+----------------------------------------------------+-------------------------------+---------------+
| Pane 1: claude-code:implementer (Host) [running]   | Pane 2: opencode:auditor      | Mesh & Run    |
| -------------------------------------------------- | [BLOCKED HITL]                | Inspector     |
| $ cargo test -p aibr-tui                           | ----------------------------- | ------------- |
| test logo_tests::test_logo_mark_spans ... ok       | 🚨 HIGH RISK: FILE REWRITE    | macbook-local |
| test input_engine_tests::alt_hjkl ... ok           | [-] rm -rf build/cache        | dev-vps [24ms]|
|                                                    | [+] rm -rf build/cache --safe | ------------- |
|                                                    | [y] Approve Once  [d] Deny    | Task DAG / Cost
+----------------------------------------------------+-------------------------------+---------------+
| [MODERN] Alt+H/J/K/L: Focus | Alt+V/S: Split | Alt+Z: Zoom | Alt+B: Inspector | Alt+Q: Detach       | Status Bar (1 row)
+----------------------------------------------------------------------------------------------------+
 ```

 ────────────────────────────────────────────────────────────────────────────────

 2. Workstream Architecture & Deliverables

 ### A. TUI Control Plane Subsystems (crates/aibr-tui)

 #### 1. Dual-Profile Keybinding Engine (crates/aibr-tui/src/input/engine.rs, keys.rs, action.rs)

 - Profile A (Modern Ergonomic):
   - Zero prefix latency: Alt+H, Alt+J, Alt+K, Alt+L, and Alt+Arrows execute instantaneous directional pane focus.
   - Geometry splits: Alt+V (vertical 50/50 split), Alt+S / Alt+- (horizontal 50/50 split).
   - Window management: Alt+Z (zoom/maximize toggle), Alt+W (close focused pane).
   - Navigation: Alt+1..9 (switch workspace tabs), Alt+A (direct jump to pending HITL card).
   - Overlays: Ctrl+K / Cmd+K (universal command palette), ? / F1 / Alt+? (keymap cheatsheet & profile switcher).
   - Clean Detach: Alt+Q emits Action::Detach with process exit code 0.
 - Profile B (Tmux Classic):
   - Armed prefix Ctrl+B (2000 ms window) preserving classic bindings (", %, z, c, n, p, q"). The window is
     deliberately longer than tmux's 1000 ms: this client is used over SSH, where one delayed packet loses the
     second key of a two-key sequence. See `tui-daemon-modernization.md` §5.
 - HITL Interception:
   - In InputMode::Terminal, when an agent pane enters state: "blocked", keys y (approve once), d (deny), and e (revise prompt) route strictly to the approval card and are halted from
     leaking into agent PTY stdin.

 #### 2. Shell Layout, Top Header & Tab Bar (crates/aibr-tui/src/widgets/chrome.rs, layout/)

 - TopHeaderBarWidget:
   - Terminal height: 2 rows (38px equivalent).
   - Displays Tailscale health (100.66.222.45/10, peer count, ping latency).
   - Breadcrumb component responsive to terminal width ([project: <workspace> / run: #108] on ≥ 100 columns, [<workspace>] on < 100 columns).
   - Global agent status summary pills: 🟢 Working, 🟡 Blocked (HITL), 🔵 Done.
   - Clickable action chips: [Ctrl+K Search], [? Keymap], [Alt+B Inspector].
 - WorkspaceTabBarWidget:
   - Numbered tab badges (Alt+1, Alt+2, Alt+3) with close button (×) and add button (+).
   - Full mouse hit-testing in layout/hit.rs (HitTarget::WorkspaceTabClose, HitTarget::WorkspaceTabNew).

 #### 3. Embedded In-Pane HITL Approval Card & Diff Viewer (crates/aibr-tui/src/widgets/diff.rs, modal.rs)

 - Replaced disruptive full-screen takeovers with an embedded in-pane approval card rendered directly inside the blocked agent's pane.
 - Colorized diff view: syntax-highlighted additions (+ in green), deletions (- in red), and hunk headers (@@ in cyan).
 - Risk badges: HIGH RISK: FILE REWRITE, MEDIUM RISK: SHELL EXEC with real-time countdown timer.
 - Direct emission of ControlCommand::ApprovePlan and ControlCommand::RejectPlan IPC frames upon keyboard press or mouse button click.
 - CAVEAT, carried over from tui-daemon-modernization.md §1/§9 and unchanged by this work: the daemon-side handler in
   src/ipc/publisher.ts still answers these two commands with `accepted: false`, because the engine's plan-review
   path sits behind the job manager rather than behind the IPC bridge. The card renders, the keybinding fires, and
   the frame reaches the daemon -- but no approval actually takes effect yet. An earlier revision of this report
   described the HITL card without this caveat, which read as a working feature. Also still open: the PTY host has
   no PtySink wired to the bus, so pane commands from a real client are answered not_allowed.

 #### 4. Universal Command Palette & Keymap Modals (crates/aibr-tui/src/widgets/modal.rs, input/menu.rs)

 - CommandPaletteWidget:
   - Centered floating overlay with text input buffer.
   - Live fuzzy search filtering across all actions (Split Horizontal/Vertical, Toggle Zoom, Focus HITL, Toggle Inspector, Detach).
   - Keyboard navigation (Up/Down, Enter to execute, Esc to dismiss).
 - KeymapSetupModalWidget:
   - Interactive profile toggles: Modern Ergonomic vs Tmux Classic vs Vim-Centric.
   - Keybinding comparison table with mouse hit-testing to switch active profile immediately.

 #### 5. Collapsible Inspector Sidebar (crates/aibr-tui/src/layout/tile.rs, widgets/chrome.rs, src/tui/view-model.ts)

 - 28-column right sidebar toggled via Alt+B or top header chip.
 - Automatically recalibrates central BSP tile dimensions without cursor jump or visual tearing.
 - Displays live Tailscale node latencies (macbook-local [Host], dev-vps [24ms], gpu-cluster [68ms]), Run Task DAG mini-map, and telemetry summary (cost $0.18, tokens 24.8k, secret
   redactions 14).

 ────────────────────────────────────────────────────────────────────────────────

 ### B. Brand Identity & Onboarding Stepper Subsystems (src/cli/, src/host/)

 #### 1. ANSI Logo Branding System

 - Color Tokens:
   - Primary Pylon: Electric Cyan RGB(0, 240, 255) / ■ #00f0ff
   - Suspension Span: Neural Violet RGB(168, 85, 247) / ■ #a855f7
   - Status Pulse: Mesh Emerald RGB(16, 185, 129) / ■ #10b981
 - Vector/ANSI Glyphs:
   - logo_mark_spans(): ╭─▲─╮ ◈ AIBridge
   - WindowHeader: Standard framed window titlebar with branding mark, title, and version badge.
 - CLI Splash Banner:
   - getCliBanner() / printCliBanner() in src/cli.ts outputs the 7-row cyber-mesh ASCII splash banner during aibr --version and aibr setup.

 #### 2. 5-Step Stepper Finite State Machine (src/cli/setup-wizard.ts)

 - Refactored runSetupWizard from serial prompts into a 5-step state machine (StepperFSM):
   1. Step 1 (Network): Automated Tailscale socket discovery and port collision checks.
   2. Step 2 (Security): Router port, CSPRNG bearer token (aibr_sec_...), invariant checkboxes.
   3. Step 3 (Allowlists): Multi-select project directory picker enforcing fail-closed containment.
   4. Step 4 (AI Runtimes): Diagnostic loopback pings (OpenCode 127.0.0.1:4096, Claude Code CLI, Codex CLI).
   5. Step 5 (Install & Test): Service supervisor setup (launchd/systemd) and preflight audit.
 - Input Parity:
   - 1..5: Direct jump to completed or current steps.
   - Tab / Shift+Tab: Cycle field focus.
   - Space: Toggle focused checkbox.
   - Enter: Submit step / advance.
   - Esc / b: Return to previous step.
   - r: Regenerate CSPRNG bearer token in Step 2 (128-bit: 16 bytes / 32 hex chars).
   - Mouse SGR 1006 click coordinates for step tabs, checkboxes, and buttons.
   - Headless/prompter fallback for non-interactive test suites.

 #### 3. Step Widgets (src/cli/setup-step-widgets.ts, crates/aibr-tui/src/widgets/setup.rs)

 - NetworkProbeWidget / probeNetwork():
   - Validates Tailscale CGNAT address space (100.64.0.0/10).
   - Probes bind availability for ports 4095 (Router), 4096 (OpenCode), and 8787 (Bridge).
 - TokenGeneratorWidget / generateCsprngToken():
   - Generates CSPRNG bearer tokens (aibr_sec_<32-hex> = 128 bits; raw 64-hex = 256 bits). An earlier revision of
     this report, SKILL.md, and the wizard mockup all called the 32-hex default "256-bit". It is 16 bytes, so 128.
     The format is pinned by those documents and 128 bits is far past brute force for a bearer token.
   - Checkboxes for constant-time comparison, 2 MB body cap, and automated secret redaction.
 - DirectorySelectorWidget:
   - Path normalization, directory selection toggling, and fail-closed subpath policy notice.
 - RuntimeProbeWidget / probeRuntimes():
   - Probes OpenCode loopback HTTP endpoint (http://127.0.0.1:4096/health) and resolves claude and codex binaries on $PATH.

 #### 4. Service Daemonizer & Outbox Infrastructure (src/host/daemonizer.ts)

 - macOS launchd: Generates ~/Library/LaunchAgents/com.aibridge.daemon.plist (0600). Writes it WITHOUT activating it;
   activation is a separate confirmation after the profile is persisted, because the unit is KeepAlive and loading
   one whose config does not match the router's store turns a setup mistake into a restart loop.
   Profile names are constrained to [A-Za-z0-9._-] and the binary path is XML-escaped, since both are interpolated
   into a plist and a systemd ExecStart.
 - Linux systemd: Generates ~/.config/systemd/user/aibridge.service (0600) under the same write-then-confirm rule.
 - Ingress Queue: NOT provisioned here, and deliberately so. An earlier revision of this report claimed the wizard
   called initializeOutboxDatabase() to create ~/.aibridge/ingress_outbox.db. That was wrong and has been removed:
   the table belongs to the Rust router (router/src/outbox.rs, CREATE TABLE ingress_outbox ... STRICT) and is
   provisioned by an explicit operator step, `aibr-router --init-store`. The version that shipped here declared a
   DIFFERENT set of columns at a path the router does not read, and it reported walEnabled: true without ever
   reading PRAGMA journal_mode back. `aibr worker` documents at length why an implicitly-created store is worse
   than none -- the router refuses to serve against it, the worker drains an empty one, and both look healthy.
 - Setup still prints which state the daemon is in (started / written-but-not-started / error / unsupported), because
   a KeepAlive unit that was never activated is otherwise indistinguishable from one that is running.
 - TUI Transition: Returns launchTui: true option on completion to seamlessly transition into the interactive TUI.

 ────────────────────────────────────────────────────────────────────────────────

 3. Verification & Evidence Matrix

 ### A. Test Execution Summary

 ┌─────────────────────────┬─────────────────────────────────────┬────────────────────────────────────────────────────┬─────────────────────────────┬────────────────┐
 │ Test Suite              │ Scope                               │ Target                                             │ Result                      │ Execution Time │
 ├─────────────────────────┼─────────────────────────────────────┼────────────────────────────────────────────────────┼─────────────────────────────┼────────────────┤
 │ Rust Client Tests       │ Full crate                          │ cargo test -p aibr-tui                             │ 218 / 218 PASS              │ 4.20s          │
 ├─────────────────────────┼─────────────────────────────────────┼────────────────────────────────────────────────────┼─────────────────────────────┼────────────────┤
 │ Rust Keybinding Tests   │ Profile A, Alt-chords, HITL         │ cargo test -p aibr-tui --test input_engine_tests   │ 16 / 16 PASS                │ 0.47s          │
 ├─────────────────────────┼─────────────────────────────────────┼────────────────────────────────────────────────────┼─────────────────────────────┼────────────────┤
 │ Rust Mouse Tests        │ Focus, drag, double-click zoom      │ cargo test -p aibr-tui --test input mouse::        │ 31 / 31 PASS                │ 0.15s          │
 ├─────────────────────────┼─────────────────────────────────────┼────────────────────────────────────────────────────┼─────────────────────────────┼────────────────┤
 │ Rust Logo Tests         │ Spans, dimensions, color channels   │ cargo test -p aibr-tui --test logo_tests           │ 3 / 3 PASS                  │ 0.51s          │
 ├─────────────────────────┼─────────────────────────────────────┼────────────────────────────────────────────────────┼─────────────────────────────┼────────────────┤
 │ TypeScript Setup Tests  │ FSM, token regen, daemon units      │ bun test tests/unit/cli/setup-wizard.test.ts       │ 23 / 23 PASS                │ 1.05s          │
 ├─────────────────────────┼─────────────────────────────────────┼────────────────────────────────────────────────────┼─────────────────────────────┼────────────────┤
 │ TypeScript Step Widgets │ Network, token, directory, runtimes │ bun test tests/unit/cli/setup-step-widgets.test.ts │ 39 / 39 PASS                │ 1.05s          │
 ├─────────────────────────┼─────────────────────────────────────┼────────────────────────────────────────────────────┼─────────────────────────────┼────────────────┤
 │ TypeScript CLI Suite    │ CLI commands, flags, banners        │ bun test tests/unit/cli/                           │ 84 / 84 PASS                │ 0.29s          │
 ├─────────────────────────┼─────────────────────────────────────┼────────────────────────────────────────────────────┼─────────────────────────────┼────────────────┤
 │ TypeScript TUI Tests    │ State, runner, decoupled worker     │ bun test tests/unit/tui/                           │ 38 / 38 PASS                │ 0.46s          │
 ├─────────────────────────┼─────────────────────────────────────┼────────────────────────────────────────────────────┼─────────────────────────────┼────────────────┤
 │ Full Repository Suite   │ End-to-end repository tests         │ bun test                                           │ 5,415 / 5,415 PASS          │ 25.83s         │
 ├─────────────────────────┼─────────────────────────────────────┼────────────────────────────────────────────────────┼─────────────────────────────┼────────────────┤
 │ Static Typecheck        │ Zero TypeScript diagnostics         │ bun run typecheck                                  │ PASS (0 errors)             │ 5.35s          │
 ├─────────────────────────┼─────────────────────────────────────┼────────────────────────────────────────────────────┼─────────────────────────────┼────────────────┤
 │ Cargo Workspace Check   │ Zero warnings, strict docs          │ cargo check --workspace                            │ PASS (0 errors, 0 warnings) │ 1.67s          │
 │ Cargo Workspace Tests   │ Whole Rust workspace                │ cargo test --workspace                             │ 407 / 407 PASS              │ 21.4s          │
 │ Rust Formatting Gate    │ CI gate: no diff                    │ cargo fmt --all --check                            │ PASS (clean)                │ 0.9s           │
 │ Rust Lint Gate          │ CI gate: warnings are errors        │ cargo clippy --workspace --all-targets -- -D warnings│ PASS (0 warnings)         │ 4.1s           │
 └─────────────────────────┴─────────────────────────────────────┴────────────────────────────────────────────────────┴─────────────────────────────┴────────────────┘

 ### C. Gates that were RED when this report was first written

 An earlier revision of this report listed `cargo check` and the two TypeScript gates and declared the work verified.
 It did not run the two gates CI actually enforces on Rust, and both were failing on the delivered code:

 - `cargo fmt --all --check` produced ~125 hunks across 12 files.
 - `cargo clippy --workspace --all-targets -- -D warnings` produced 6 errors: 4x `manual_clamp`, 1x `map_or` that
   clippy can simplify, 1x `vec_init_then_push`.

 Both are now clean. The substantive corrections made alongside them (the outbox provisioning, the daemon
 activation, the injection guards, and the four false claims listed throughout this report) are described in the
 sections above rather than only here.

 ────────────────────────────────────────────────────────────────────────────────

 ### B. Acceptance Criteria Checklist

 ┌──────────────────────┬──────────────────────────────────────────────────────────────────────────────────┬───────────────────────────────────────────────────────────────┬──────────┐
 │ Criterion            │ Requirement                                                                      │ Verification Method                                           │ Status   │
 ├──────────────────────┼──────────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┼──────────┤
 │ 1. Logo Verification │ aibr --version and aibr tui render the new AIBridge ANSI logo and brand gradient │ bun src/cli.ts --version (TTY) & cargo test -p aibr-tui       │ VERIFIED │
 │                      │ without character misalignment.                                                  │ --test logo_tests                                             │          │
 ├──────────────────────┼──────────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┼──────────┤
 │ 2. Stepper Flow      │ Running aibr setup in an interactive terminal opens the full 5-step stepper      │ bun test tests/unit/cli/setup-wizard.test.ts -t "advances     │ VERIFIED │
 │                      │ interface.                                                                       │ through steps"                                                │          │
 ├──────────────────────┼──────────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┼──────────┤
 │ 3. Token             │ Pressing r in Step 2 updates the bearer token with a fresh CSPRNG value        │ bun test tests/unit/cli/setup-wizard.test.ts -t "regenerates  │ VERIFIED │
 │ Regeneration         │ (aibr_sec_<32-hex> = 128 bits).                                                  │ bearer token with 'r'"                                        │          │
 ├──────────────────────┼──────────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┼──────────┤
 │ 4. Mouse Hit-Testing │ Clicking steps, checkboxes, and buttons triggers immediate state transitions.    │ bun test tests/unit/cli/setup-wizard.test.ts -t "StepperFSM   │ VERIFIED │
 │                      │                                                                                  │ mouse hit-testing"                                            │          │
 ├──────────────────────┼──────────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┼──────────┤
 │ 5. Preflight Output  │ Completing all 5 steps writes valid JSON config matching config/schemas.ts and   │ bun test tests/unit/cli/setup-wizard.test.ts                 │ VERIFIED  │
 │                      │ writes the platform supervisor unit WITHOUT activating it, then asks before │ -t "writes the unit without activating it"                   │ (correct- │
 │                      │ starting it. Activation is NOT claimed here: it is opt-in at the           │ -t "reports the unit as installed but not started"           │ ed; see  │
 │                      │ operator's prompt.                                                                │                                                                 │ note)    │
 ├──────────────────────┼──────────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┼──────────┤
 │ 6. Test Coverage     │ All setup wizard unit tests in tests/unit/cli/setup-wizard.test.ts pass with     │ bun test tests/unit/cli/setup-wizard.test.ts                  │ VERIFIED │
 │                      │ 100% success rate.                                                               │                                                               │          │
 ├──────────────────────┼──────────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┼──────────┤
 │ 7. Ergonomic         │ Pressing Alt+H/J/K/L navigates panes immediately with zero prefix delay.         │ cargo test -p aibr-tui --test input_engine_tests alt_hjkl     │ VERIFIED │
 │ Keybindings          │                                                                                  │                                                               │          │
 ├──────────────────────┼──────────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┼──────────┤
 │ 8. HITL Interception │ Blocked agent state halts PTY input; y/d/e route strictly to embedded approval   │ cargo test -p aibr-tui --test input_engine_tests              │ VERIFIED │
 │                      │ card.                                                                            │ hitl_interception                                             │          │
 ├──────────────────────┼──────────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┼──────────┤
 │ 9. Command Palette   │ Ctrl+K opens fuzzy launcher; typing split filters to split actions; Enter        │ cargo test -p aibr-tui command_palette                        │ VERIFIED │
 │                      │ executes immediately.                                                            │                                                               │          │
 ├──────────────────────┼──────────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┼──────────┤
 │ 10. Clean Detach     │ Ctrl+B q or Alt+Q exits TUI with code 0 without disrupting background daemon     │ cargo test -p aibr-tui --test input_engine_tests alt_q        │ VERIFIED │
 │                      │ jobs.                                                                            │                                                               │          │
 └──────────────────────┴──────────────────────────────────────────────────────────────────────────────────┴───────────────────────────────────────────────────────────────┴──────────┘

 ────────────────────────────────────────────────────────────────────────────────

 4. Operational Runbook

 ### Interactive Launch & Onboarding

 ```bash
# 1. Launch the interactive 5-step onboarding wizard
bun aibr setup

# 2. Verify installed profile credentials and prerequisites
bun aibr verify -p default

# 3. Open the interactive TUI control plane
bun aibr tui -p default
# or directly via the compiled Rust binary:
cargo run -p aibr-tui
 ```

 ### Keybinding Quick Reference

 - Focus Navigation: Alt+H (Left), Alt+J (Down), Alt+K (Up), Alt+L (Right) or Alt+Arrows
 - Splits & Zoom: Alt+V (Vertical Split), Alt+S (Horizontal Split), Alt+Z (Zoom Toggle)
 - Workspaces & Inspector: Alt+1..9 (Switch Tab), Alt+B (Toggle Inspector), Alt+A (Focus HITL Card)
 - Modals & Palette: Ctrl+K (Command Palette), ? (Keymap Cheatsheet & Profile Switcher)
 - Clean Detach: Alt+Q or Ctrl+B q (exits client with code 0; daemon and agent PTYs remain alive)
