//! Comprehensive tests for the refactored input engine:
//! Alt-chords (Modern Ergonomic profile), legacy Ctrl+Alt backward compatibility,
//! dual-profile state machine (TmuxClassic, VimCentric, ModernErgonomic),
//! modal routing (universal command palette and keymap cheatsheet),
//! and HITL decision interception and safety floor.

use std::time::Instant;

use aibr_ipc::ControlCommand;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use aibr_tui::input::traits::{ApprovalModal, FocusTarget, KeyEventLike, ModalOutcome};
use aibr_tui::input::{key, Action, Chord, InputMode, InputState, NoScrollback};
use aibr_tui::layout::{Axis, TileLayout};
use aibr_tui::state::{BlockedReason, Job, KeybindingProfile, Pane, PaneKind, UiState, Workspace};

// -----------------------------------------------------------------------------------------
// Test Fixtures and Helpers
// -----------------------------------------------------------------------------------------

fn now() -> Instant {
    Instant::now()
}

fn alt(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::ALT)
}

fn alt_code(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::ALT)
}

fn ctrl(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
}

fn ctrl_alt(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL | KeyModifiers::ALT)
}

fn bare(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)
}

struct TestModal {
    open: bool,
    job_id: Option<String>,
    focus: FocusTarget,
    outcome: ModalOutcome,
    keys: Vec<KeyEventLike>,
}

impl Default for TestModal {
    fn default() -> Self {
        Self {
            open: false,
            job_id: None,
            focus: FocusTarget::Approve,
            outcome: ModalOutcome::Consumed,
            keys: Vec::new(),
        }
    }
}

impl ApprovalModal for TestModal {
    fn is_open(&self) -> bool {
        self.open
    }

    fn job_id(&self) -> Option<&str> {
        self.job_id.as_deref()
    }

    fn focus(&self) -> FocusTarget {
        self.focus
    }

    fn set_focus(&mut self, target: FocusTarget) {
        self.focus = target;
    }

    fn focusable_count(&self) -> usize {
        4
    }

    fn handle_key(&mut self, event: &KeyEventLike) -> ModalOutcome {
        self.keys.push(*event);
        self.outcome.clone()
    }
}

fn test_state() -> UiState {
    let mut ui = UiState::default();
    ui.presentation.active_workspace = Some("ws-1".to_owned());
    ui.presentation.focused = Some("pane-a".to_owned());

    let ws1 = Workspace {
        id: "ws-1".to_owned(),
        name: "Dev".to_owned(),
        project_id: "proj-1".to_owned(),
        project_root: "/repo".to_owned(),
        selected: true,
    };
    let ws2 = Workspace {
        id: "ws-2".to_owned(),
        name: "Security".to_owned(),
        project_id: "proj-1".to_owned(),
        project_root: "/repo".to_owned(),
        selected: false,
    };
    ui.world.workspaces.insert("ws-1".to_owned(), ws1);
    ui.world.workspaces.insert("ws-2".to_owned(), ws2);

    let pane_a = Pane {
        id: "pane-a".to_owned(),
        workspace_id: "ws-1".to_owned(),
        kind: PaneKind::Terminal,
        title: "Pane A".to_owned(),
        job_id: None,
        session_id: None,
        columns: std::num::NonZeroU64::new(80).unwrap(),
        rows: std::num::NonZeroU64::new(24).unwrap(),
        scroll_offset: 0,
    };
    let pane_b = Pane {
        id: "pane-b".to_owned(),
        workspace_id: "ws-1".to_owned(),
        kind: PaneKind::Terminal,
        title: "Pane B".to_owned(),
        job_id: None,
        session_id: None,
        columns: std::num::NonZeroU64::new(80).unwrap(),
        rows: std::num::NonZeroU64::new(24).unwrap(),
        scroll_offset: 0,
    };
    ui.world.panes.insert("pane-a".to_owned(), pane_a);
    ui.world.panes.insert("pane-b".to_owned(), pane_b);
    ui
}

fn test_layout() -> TileLayout {
    TileLayout::from_panes(&["pane-a".to_owned(), "pane-b".to_owned()])
}

// -----------------------------------------------------------------------------------------
// 1. Profile A (Modern Ergonomic) Alt-chords
// -----------------------------------------------------------------------------------------

#[test]
fn alt_hjkl_navigates_focus() {
    let mut state = InputState::default();
    let mut ui = test_state();
    let mut panes = NoScrollback;
    let mut layout = test_layout();
    let mut modal = TestModal::default();

    // Start with pane-a focused. Alt+J / Alt+Down moves focus to pane-b (Horizontal split: top to bottom)
    let actions = key(
        &mut state,
        &alt('j'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(
        actions,
        vec![Action::FocusPane {
            pane_id: "pane-b".to_owned()
        }]
    );
    assert_eq!(ui.presentation.focused.as_deref(), Some("pane-b"));

    // Alt+K / Alt+Up moves back to pane-a
    let actions = key(
        &mut state,
        &alt('k'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(
        actions,
        vec![Action::FocusPane {
            pane_id: "pane-a".to_owned()
        }]
    );
    assert_eq!(ui.presentation.focused.as_deref(), Some("pane-a"));

    // Alt+Down arrow moves to pane-b
    let actions = key(
        &mut state,
        &alt_code(KeyCode::Down),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(
        actions,
        vec![Action::FocusPane {
            pane_id: "pane-b".to_owned()
        }]
    );

    // Alt+Up arrow moves to pane-a
    let actions = key(
        &mut state,
        &alt_code(KeyCode::Up),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(
        actions,
        vec![Action::FocusPane {
            pane_id: "pane-a".to_owned()
        }]
    );
}

#[test]
fn alt_v_splits_vertically() {
    let mut state = InputState::default();
    let mut ui = test_state();
    let mut panes = NoScrollback;
    let mut layout = test_layout();
    let mut modal = TestModal::default();

    let actions = key(
        &mut state,
        &alt('v'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(
        actions,
        vec![Action::SpawnPaneRequested {
            workspace_id: "ws-1".to_owned(),
            parent_pane_id: "pane-a".to_owned(),
            axis: Axis::Vertical,
            kind: PaneKind::Terminal,
        }]
    );
}

#[test]
fn alt_s_and_alt_dash_split_horizontally() {
    let mut state = InputState::default();
    let mut ui = test_state();
    let mut panes = NoScrollback;
    let mut layout = test_layout();
    let mut modal = TestModal::default();

    let actions = key(
        &mut state,
        &alt('s'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(
        actions,
        vec![Action::SpawnPaneRequested {
            workspace_id: "ws-1".to_owned(),
            parent_pane_id: "pane-a".to_owned(),
            axis: Axis::Horizontal,
            kind: PaneKind::Terminal,
        }]
    );

    let actions = key(
        &mut state,
        &alt('-'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(
        actions,
        vec![Action::SpawnPaneRequested {
            workspace_id: "ws-1".to_owned(),
            parent_pane_id: "pane-a".to_owned(),
            axis: Axis::Horizontal,
            kind: PaneKind::Terminal,
        }]
    );
}

#[test]
fn alt_z_toggles_zoom() {
    let mut state = InputState::default();
    let mut ui = test_state();
    let mut panes = NoScrollback;
    let mut layout = test_layout();
    let mut modal = TestModal::default();

    let actions = key(
        &mut state,
        &alt('z'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(
        actions,
        vec![Action::ZoomPane {
            pane_id: Some("pane-a".to_owned())
        }]
    );
    assert_eq!(ui.presentation.zoomed.as_deref(), Some("pane-a"));

    // Zooming again restores split view
    let actions = key(
        &mut state,
        &alt('z'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(actions, vec![Action::ZoomPane { pane_id: None }]);
    assert_eq!(ui.presentation.zoomed, None);
}

#[test]
fn alt_w_closes_focused_pane() {
    let mut state = InputState::default();
    let mut ui = test_state();
    let mut panes = NoScrollback;
    let mut layout = test_layout();
    let mut modal = TestModal::default();

    let actions = key(
        &mut state,
        &alt('w'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );

    // Emits ClosePane and close_pane command
    assert!(actions
        .iter()
        .any(|a| matches!(a, Action::ClosePane { pane_id } if pane_id == "pane-a")));
    assert!(actions
        .iter()
        .any(|a| matches!(a, Action::Command(ControlCommand::ClosePane { .. }))));
    // Remaining pane is focused
    assert_eq!(ui.presentation.focused.as_deref(), Some("pane-b"));
}

#[test]
fn alt_1_through_9_switches_workspace() {
    let mut state = InputState::default();
    let mut ui = test_state();
    let mut panes = NoScrollback;
    let mut layout = test_layout();
    let mut modal = TestModal::default();

    // Alt+2 switches to ws-2
    let actions = key(
        &mut state,
        &alt('2'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert!(actions.iter().any(|a| matches!(
        a,
        Action::SetActiveWorkspace { workspace_id } if workspace_id == "ws-2"
    )));
    assert_eq!(ui.presentation.active_workspace.as_deref(), Some("ws-2"));

    // Alt+1 switches back to ws-1
    let actions = key(
        &mut state,
        &alt('1'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert!(actions.iter().any(|a| matches!(
        a,
        Action::SetActiveWorkspace { workspace_id } if workspace_id == "ws-1"
    )));
    assert_eq!(ui.presentation.active_workspace.as_deref(), Some("ws-1"));
}

#[test]
fn alt_a_jumps_focus_to_approval_card() {
    let mut state = InputState::default();
    let mut ui = test_state();
    let mut panes = NoScrollback;
    let mut layout = test_layout();
    let mut modal = TestModal::default();

    let actions = key(
        &mut state,
        &alt('a'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(actions, vec![Action::FocusApprovalCard]);
}

#[test]
fn alt_b_toggles_sidebar() {
    let mut state = InputState::default();
    let mut ui = test_state();
    let mut panes = NoScrollback;
    let mut layout = test_layout();
    let mut modal = TestModal::default();

    let initial = ui.presentation.sidebar_visible;
    let actions = key(
        &mut state,
        &alt('b'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(actions, vec![Action::SidebarVisible(!initial)]);
    assert_eq!(ui.presentation.sidebar_visible, !initial);
}

#[test]
fn alt_q_detaches_safely() {
    let mut state = InputState::default();
    let mut ui = test_state();
    let mut panes = NoScrollback;
    let mut layout = test_layout();
    let mut modal = TestModal::default();

    let actions = key(
        &mut state,
        &alt('q'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(actions, vec![Action::Detach]);
    assert!(state.detach_requested());
}

#[test]
fn ctrl_k_and_cmd_k_open_command_palette() {
    let mut state = InputState::default();
    let mut ui = test_state();
    let mut panes = NoScrollback;
    let mut layout = test_layout();
    let mut modal = TestModal::default();

    let actions = key(
        &mut state,
        &ctrl('k'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(actions, vec![Action::OpenCommandPalette]);
    assert!(state.command_palette().is_some());

    // Cmd+K (Super+K) also triggers it
    let mut state2 = InputState::default();
    let cmd_k = KeyEvent::new(KeyCode::Char('k'), KeyModifiers::SUPER);
    let actions = key(
        &mut state2,
        &cmd_k,
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(actions, vec![Action::OpenCommandPalette]);
    assert!(state2.command_palette().is_some());
}

#[test]
fn question_mark_f1_and_alt_question_open_keymap_modal() {
    let mut state = InputState::default();
    let mut ui = test_state();
    let mut panes = NoScrollback;
    let mut layout = test_layout();
    let mut modal = TestModal::default();

    // Bare '?' in ModernErgonomic
    let actions = key(
        &mut state,
        &bare('?'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(actions, vec![Action::OpenKeymapModal]);
    assert!(state.keymap_modal().is_some());

    // F1 key
    let mut state2 = InputState::default();
    let f1 = KeyEvent::new(KeyCode::F(1), KeyModifiers::NONE);
    let actions = key(
        &mut state2,
        &f1,
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(actions, vec![Action::OpenKeymapModal]);
    assert!(state2.keymap_modal().is_some());

    // Alt+? key
    let mut state3 = InputState::default();
    let actions = key(
        &mut state3,
        &alt('?'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(actions, vec![Action::OpenKeymapModal]);
    assert!(state3.keymap_modal().is_some());
}

// -----------------------------------------------------------------------------------------
// 2. Backward Compatibility with Ctrl+Alt Chords
// -----------------------------------------------------------------------------------------

#[test]
fn legacy_ctrl_alt_chords_work_for_backward_compatibility() {
    let mut state = InputState::default();
    let mut ui = test_state();
    let mut panes = NoScrollback;
    let mut layout = test_layout();
    let mut modal = TestModal::default();

    // Ctrl+Alt+J moves focus down to pane-b
    let actions = key(
        &mut state,
        &ctrl_alt('j'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(
        actions,
        vec![Action::FocusPane {
            pane_id: "pane-b".to_owned()
        }]
    );

    // Ctrl+Alt+D splits vertically
    let actions = key(
        &mut state,
        &ctrl_alt('d'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(
        actions,
        vec![Action::SpawnPaneRequested {
            workspace_id: "ws-1".to_owned(),
            parent_pane_id: "pane-b".to_owned(),
            axis: Axis::Vertical,
            kind: PaneKind::Terminal,
        }]
    );

    // Ctrl+Alt+B toggles sidebar
    let actions = key(
        &mut state,
        &ctrl_alt('b'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(actions, vec![Action::SidebarVisible(false)]);

    // Ctrl+Alt+Shift+H is not a chord
    let shift_event = KeyEvent::new(
        KeyCode::Char('h'),
        KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SHIFT,
    );
    assert_eq!(Chord::from_event(&shift_event), None);
}

// -----------------------------------------------------------------------------------------
// 3. Dual-Profile State Machine & Profile Switching
// -----------------------------------------------------------------------------------------

#[test]
fn tmux_classic_profile_prefers_prefix_over_bare_alt() {
    let mut state = InputState::default();
    let mut ui = test_state();
    ui.presentation.keybinding_profile = KeybindingProfile::TmuxClassic;
    let mut panes = NoScrollback;
    let mut layout = test_layout();
    let mut modal = TestModal::default();

    // Bare Alt+H does NOT trigger FocusLeft chord in TmuxClassic (passes through to PTY)
    let chord = Chord::from_event_for_profile(&alt('h'), KeybindingProfile::TmuxClassic);
    assert_eq!(chord, None);

    let actions = key(
        &mut state,
        &alt('h'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    // In passthrough, Alt+H becomes ESC h to the focused pane PTY
    assert!(actions
        .iter()
        .any(|a| matches!(a, Action::Command(ControlCommand::PtyInput { .. }))));

    // Ctrl+B arms prefix in TmuxClassic
    let prefix = KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL);
    let actions = key(
        &mut state,
        &prefix,
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert!(actions.is_empty());
    assert_eq!(ui.presentation.mode, InputMode::Prefix);

    // Prefix + d detaches in tmux
    let d_key = bare('d');
    let actions = key(
        &mut state,
        &d_key,
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(actions, vec![Action::Detach]);
    assert_eq!(ui.presentation.mode, InputMode::Terminal);
}

#[test]
fn keymap_modal_allows_profile_switching() {
    let mut state = InputState::default();
    let mut ui = test_state();
    let mut panes = NoScrollback;
    let mut layout = test_layout();
    let mut modal = TestModal::default();

    // Open keymap modal with F1
    let f1 = KeyEvent::new(KeyCode::F(1), KeyModifiers::NONE);
    let actions = key(
        &mut state,
        &f1,
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(actions, vec![Action::OpenKeymapModal]);
    assert!(state.keymap_modal().is_some());

    // Pressing '2' inside keymap modal switches to TmuxClassic
    let actions = key(
        &mut state,
        &bare('2'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(
        actions,
        vec![Action::SwitchProfile(KeybindingProfile::TmuxClassic)]
    );
    assert_eq!(
        ui.presentation.keybinding_profile,
        KeybindingProfile::TmuxClassic
    );

    // Pressing '3' switches to VimCentric
    let actions = key(
        &mut state,
        &bare('3'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(
        actions,
        vec![Action::SwitchProfile(KeybindingProfile::VimCentric)]
    );
    assert_eq!(
        ui.presentation.keybinding_profile,
        KeybindingProfile::VimCentric
    );

    // Pressing '1' switches back to ModernErgonomic
    let actions = key(
        &mut state,
        &bare('1'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(
        actions,
        vec![Action::SwitchProfile(KeybindingProfile::ModernErgonomic)]
    );
    assert_eq!(
        ui.presentation.keybinding_profile,
        KeybindingProfile::ModernErgonomic
    );

    // Esc dismisses the modal
    let esc = KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE);
    let actions = key(
        &mut state,
        &esc,
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(actions, vec![Action::ModalClosed]);
    assert!(state.keymap_modal().is_none());
}

// -----------------------------------------------------------------------------------------
// 4. HITL Interception and Safety Floor
// -----------------------------------------------------------------------------------------

#[test]
fn hitl_interception_when_job_is_blocked_without_fullscreen_modal() {
    let mut state = InputState::default();
    let mut ui = test_state();
    let mut panes = NoScrollback;
    let mut layout = test_layout();
    let mut modal = TestModal::default(); // modal is NOT open

    // Add a Blocked job to the world (embedded HITL card active)
    let blocked_job = Job {
        id: "job-blocked-1".to_owned(),
        project_id: "proj-1".to_owned(),
        workspace_id: "ws-1".to_owned(),
        session_id: Some("sess-1".to_owned()),
        state: aibr_ipc::contracts::JobState::Blocked,
        blocked_reason: Some(BlockedReason::PlanReview),
        detail: Some("Review plan before execution".to_owned()),
        updated_at: "2026-10-07T00:00:00Z".to_owned(),
    };
    ui.world
        .jobs
        .insert("job-blocked-1".to_owned(), blocked_job);

    assert!(ui.blocked_job().is_some());

    // 1. Pressing 'y' intercepts and issues approve_plan command directly
    let actions = key(
        &mut state,
        &bare('y'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(actions.len(), 1);
    match &actions[0] {
        Action::Command(ControlCommand::ApprovePlan { job_id, .. }) => {
            assert_eq!(job_id.as_str(), "job-blocked-1");
        }
        other => panic!("expected ApprovePlan command, got {other:?}"),
    }

    // 2. Pressing 'd' intercepts and issues reject_plan command directly
    let actions = key(
        &mut state,
        &bare('d'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(actions.len(), 1);
    match &actions[0] {
        Action::Command(ControlCommand::RejectPlan { job_id, .. }) => {
            assert_eq!(job_id.as_str(), "job-blocked-1");
        }
        other => panic!("expected RejectPlan command, got {other:?}"),
    }

    // 3. Pressing 'e' enters revision mode and emits FocusApprovalCard
    let actions = key(
        &mut state,
        &bare('e'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert!(actions.contains(&Action::FocusApprovalCard));

    // 4. Safety floor: Arbitrary terminal keystrokes (e.g. 'x', 'ls', Enter, Ctrl+C)
    // are completely halted and NEVER leak bytes to PTY stdin!
    for leak_attempt in [
        bare('x'),
        bare('a'),
        bare('c'),
        ctrl('c'),
        KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
    ] {
        let actions = key(
            &mut state,
            &leak_attempt,
            now(),
            &mut ui,
            &mut panes,
            &mut layout,
            &mut modal,
        );
        // Verify no PtyInput command is emitted!
        let has_pty_input = actions
            .iter()
            .any(|a| matches!(a, Action::Command(ControlCommand::PtyInput { .. })));
        assert!(
            !has_pty_input,
            "Blocked state must halt PTY input, leaked: {leak_attempt:?}"
        );
    }
}

#[test]
fn hitl_interception_when_modal_is_open() {
    let mut state = InputState::default();
    let mut ui = test_state();
    let mut panes = NoScrollback;
    let mut layout = test_layout();
    let mut modal = TestModal {
        open: true,
        job_id: Some("job-modal-1".to_owned()),
        focus: FocusTarget::Approve,
        outcome: ModalOutcome::Consumed,
        keys: Vec::new(),
    };

    // 'y' in modal approves
    let actions = key(
        &mut state,
        &bare('y'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(actions.len(), 1);
    match &actions[0] {
        Action::Command(ControlCommand::ApprovePlan { job_id, .. }) => {
            assert_eq!(job_id.as_str(), "job-modal-1");
        }
        other => panic!("expected ApprovePlan command, got {other:?}"),
    }

    // 'd' in modal rejects
    let actions = key(
        &mut state,
        &bare('d'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(actions.len(), 1);
    match &actions[0] {
        Action::Command(ControlCommand::RejectPlan { job_id, .. }) => {
            assert_eq!(job_id.as_str(), "job-modal-1");
        }
        other => panic!("expected RejectPlan command, got {other:?}"),
    }

    // 'e' in modal sets focus to Justification
    let actions = key(
        &mut state,
        &bare('e'),
        now(),
        &mut ui,
        &mut panes,
        &mut layout,
        &mut modal,
    );
    assert_eq!(
        actions,
        vec![Action::ModalFocus {
            target: FocusTarget::Justification,
        }]
    );
    assert_eq!(modal.focus(), FocusTarget::Justification);
}
