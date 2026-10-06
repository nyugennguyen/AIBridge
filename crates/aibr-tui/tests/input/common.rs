//! Shared builders: a `UiState` with panes, a layout, and a geometry frame.

#![allow(dead_code)]

use std::num::NonZeroU64;
use std::time::{Duration, Instant};

use aibr_ipc::contracts::JobState;
use aibr_tui::input::InputState;
use aibr_tui::layout::{ChromeRects, LayoutRects, TileLayout};
use aibr_tui::state::{Job, Pane, PaneKind, UiState};

/// A base instant, so every test that cares about time starts from the same place.
pub fn now() -> Instant {
    Instant::now()
}

/// `base + millis`, for the prefix timeout.
pub fn later(base: Instant, millis: u64) -> Instant {
    base + Duration::from_millis(millis)
}

/// A `UiState` with two panes in one workspace, the first focused.
pub fn two_pane_state() -> UiState {
    let mut state = UiState::default();
    state.presentation.active_workspace = Some("ws-1".to_owned());
    state.presentation.focused = Some("pane-a".to_owned());
    state.world.workspaces.insert(
        "ws-1".to_owned(),
        aibr_tui::state::Workspace {
            id: "ws-1".to_owned(),
            name: "main".to_owned(),
            project_id: "proj".to_owned(),
            project_root: "/srv/main".to_owned(),
            selected: true,
        },
    );
    state
        .world
        .panes
        .insert("pane-a".to_owned(), pane("pane-a", "ws-1", None));
    state
        .world
        .panes
        .insert("pane-b".to_owned(), pane("pane-b", "ws-1", None));
    state
        .world
        .jobs
        .insert("job-1".to_owned(), job("job-1", "ws-1"));
    state
}

/// A `UiState` with one pane that shows `job-1`.
pub fn one_pane_with_job() -> UiState {
    let mut state = two_pane_state();
    if let Some(pane) = state.world.panes.get_mut("pane-a") {
        pane.job_id = Some("job-1".to_owned());
    }
    state
}

fn pane(id: &str, workspace: &str, job: Option<&str>) -> Pane {
    Pane {
        id: id.to_owned(),
        workspace_id: workspace.to_owned(),
        kind: PaneKind::Terminal,
        title: id.to_owned(),
        job_id: job.map(str::to_owned),
        session_id: None,
        columns: NonZeroU64::new(80).expect("80 is non-zero"),
        rows: NonZeroU64::new(24).expect("24 is non-zero"),
        scroll_offset: 0,
    }
}

fn job(id: &str, workspace: &str) -> Job {
    Job {
        id: id.to_owned(),
        project_id: "proj".to_owned(),
        workspace_id: workspace.to_owned(),
        session_id: None,
        state: JobState::Working,
        blocked_reason: None,
        detail: None,
        updated_at: "2026-01-01T00:00:00Z".to_owned(),
    }
}

/// A layout with the two panes, focused on the first.
pub fn two_pane_layout() -> TileLayout {
    let mut layout = TileLayout::from_panes(&["pane-a".to_owned(), "pane-b".to_owned()]);
    layout.focused = Some("pane-a".to_owned());
    layout
}

/// The frame geometry for a 100x30 terminal with a 24-column sidebar.
pub fn chrome() -> ChromeRects {
    let frame = ratatui::layout::Rect::new(0, 0, 100, 30);
    aibr_tui::layout::partition(frame, Some(24))
}

/// The pane rectangles for the two-pane layout in [`chrome`].
pub fn rects(layout: &TileLayout) -> LayoutRects {
    layout.compute(chrome().canvas)
}

/// Focus a pane in BOTH places that record it.
///
/// The engine writes [`Presentation::focused`] and the layout's own `focused` in adjacent
/// statements and is the only writer of either. A test that sets one and not the other is
/// not modelling a reachable state, and the mismatch shows up as the engine declining to
/// move focus because the layout already believes it is where it is going.
pub fn focus(ui: &mut UiState, layout: &mut TileLayout, pane_id: &str) {
    ui.presentation.focused = Some(pane_id.to_owned());
    layout.focused = Some(pane_id.to_owned());
}

/// A fresh input state.
pub fn input() -> InputState {
    InputState::default()
}

/// The pane id a `pty_input` command addresses, or `None`.
pub fn pty_target(command: &aibr_ipc::ControlCommand) -> Option<String> {
    match command {
        aibr_ipc::ControlCommand::PtyInput { pane_id, .. } => Some(pane_id.as_str().to_owned()),
        _ => None,
    }
}

/// The base64 payload a `pty_input` command carries, or `None`.
pub fn pty_payload(command: &aibr_ipc::ControlCommand) -> Option<String> {
    match command {
        aibr_ipc::ControlCommand::PtyInput { data, .. } => Some(data.as_str().to_owned()),
        _ => None,
    }
}

/// Decode base64 the same way the daemon will, so a test asserts on BYTES.
pub fn decode_base64(payload: &str) -> Vec<u8> {
    let table = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut bits = 0u32;
    let mut count = 0u32;
    for character in payload.chars().filter(|character| *character != '=') {
        let value = table
            .iter()
            .position(|candidate| *candidate as char == character)
            .unwrap_or_else(|| panic!("not base64: {character}")) as u32;
        bits = (bits << 6) | value;
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push(((bits >> count) & 0xff) as u8);
        }
    }
    out
}

/// The `pty_input` payloads, decoded, in order.
pub fn payloads(actions: &[aibr_tui::input::Action]) -> Vec<Vec<u8>> {
    actions
        .iter()
        .filter_map(|action| match action {
            aibr_tui::input::Action::Command(command) => {
                pty_payload(command).map(|raw| decode_base64(&raw))
            }
            _ => None,
        })
        .collect()
}
