//! Render tests.
//!
//! Assertions are on BUFFER CELLS, never on a screenshot. A screenshot diff can say
//! the frame is wrong; a cell assertion says which cell, which is the information
//! needed when a pane's border is one column off or a colour is silently
//! downsampled.

use std::collections::BTreeMap;

use aibr_tui::layout::tile::TileLayout;
use aibr_tui::state::{Job, Pane, PaneKind, UiState, Workspace};
use aibr_tui::vt::parser::Parser;
use aibr_tui::widgets::{render_frame, FrameInput};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;

/// The text of one row of a buffer, trailing blanks trimmed.
fn line(buffer: &Buffer, row: u16) -> String {
    let area = buffer.area;
    (0..area.width)
        .map(|column| buffer[(area.x + column, area.y + row)].symbol())
        .collect::<String>()
        .trim_end()
        .to_owned()
}

/// Whether a cell carries a glyph.
fn has_glyph(buffer: &Buffer, column: u16, row: u16) -> bool {
    buffer[(buffer.area.x + column, buffer.area.y + row)].symbol() != " "
}

fn empty_state() -> UiState {
    UiState::default()
}

/// A state with one workspace and `count` terminal panes.
fn state_with_panes(count: u16) -> UiState {
    let mut ui = empty_state();
    ui.world.sequence = Some(1);
    ui.world.node_id = "node-1".to_owned();
    ui.world.workspaces.insert(
        "ws-1".to_owned(),
        Workspace {
            id: "ws-1".to_owned(),
            name: "web-store".to_owned(),
            project_id: "proj-1".to_owned(),
            project_root: "/srv/web".to_owned(),
            selected: true,
        },
    );
    for index in 0..count {
        let id = format!("pane-{index}");
        ui.world.panes.insert(
            id.clone(),
            Pane {
                id,
                workspace_id: "ws-1".to_owned(),
                kind: PaneKind::Terminal,
                title: "OpenCode".to_owned(),
                job_id: None,
                session_id: None,
                columns: std::num::NonZeroU64::new(80).expect("80 is non-zero"),
                rows: std::num::NonZeroU64::new(24).expect("24 is non-zero"),
                scroll_offset: 0,
            },
        );
    }
    ui
}

#[test]
fn the_header_names_the_workspace_and_the_queue_depth() {
    let mut ui = state_with_panes(1);
    ui.world.outbox_pending_count = 3;
    let mut buffer = Buffer::empty(Rect::new(0, 0, 80, 24));
    let layout = TileLayout::from_panes(&["pane-0".to_owned()]);

    render_frame(
        &ui,
        &FrameInput {
            layout: &layout,
            parsers: &BTreeMap::new(),
            selection: None,
            modal: None,
            scroll: &BTreeMap::new(),
        },
        &mut buffer,
    );

    let header = line(&buffer, 0);
    assert!(header.contains("web-store"), "header was {header:?}");
    assert!(
        header.contains("outbox: 3"),
        "the queue depth must be visible without opening anything: {header:?}"
    );
}

#[test]
fn the_status_bar_shows_the_input_mode() {
    let mut ui = state_with_panes(1);
    let layout = TileLayout::from_panes(&["pane-0".to_owned()]);
    let mut buffer = Buffer::empty(Rect::new(0, 0, 80, 24));

    render_frame(
        &ui,
        &FrameInput {
            layout: &layout,
            parsers: &BTreeMap::new(),
            selection: None,
            modal: None,
            scroll: &BTreeMap::new(),
        },
        &mut buffer,
    );
    assert!(line(&buffer, 23).contains("TERMINAL"));

    // The mode is what changes the meaning of a key, so it must change visibly.
    ui.presentation.mode = aibr_tui::state::InputMode::Prefix;
    render_frame(
        &ui,
        &FrameInput {
            layout: &layout,
            parsers: &BTreeMap::new(),
            selection: None,
            modal: None,
            scroll: &BTreeMap::new(),
        },
        &mut buffer,
    );
    assert!(line(&buffer, 23).contains("PREFIX"));
}

#[test]
fn a_pane_shows_its_emulators_output() {
    let ui = state_with_panes(1);
    let mut parser = Parser::new(40, 10);
    parser.feed(b"\x1b[38;2;0;200;120m$ opencode refactor\r\nReading AST...");
    let mut parsers = BTreeMap::new();
    parsers.insert("pane-0".to_owned(), parser);

    let layout = TileLayout::from_panes(&["pane-0".to_owned()]);
    let mut buffer = Buffer::empty(Rect::new(0, 0, 80, 24));

    render_frame(
        &ui,
        &FrameInput {
            layout: &layout,
            parsers: &parsers,
            selection: None,
            modal: None,
            scroll: &BTreeMap::new(),
        },
        &mut buffer,
    );

    // The canvas starts at row 2 (below the 2-row header), column 0 (with right sidebar).
    let body = line(&buffer, 2);
    assert!(
        body.contains("$ opencode refactor"),
        "the pane did not render its output: {body:?}"
    );
    assert!(line(&buffer, 3).contains("Reading AST"));
}

#[test]
fn truecolor_reaches_the_buffer() {
    let ui = state_with_panes(1);
    let mut parser = Parser::new(40, 10);
    parser.feed(b"\x1b[38;2;255;0;128mX");
    let mut parsers = BTreeMap::new();
    parsers.insert("pane-0".to_owned(), parser);

    let mut buffer = Buffer::empty(Rect::new(0, 0, 80, 24));
    let layout = TileLayout::from_panes(&["pane-0".to_owned()]);
    render_frame(
        &ui,
        &FrameInput {
            layout: &layout,
            parsers: &parsers,
            selection: None,
            modal: None,
            scroll: &BTreeMap::new(),
        },
        &mut buffer,
    );

    let cell = &buffer[(0, 2)];
    assert_eq!(
        cell.fg,
        ratatui::style::Color::Rgb(255, 0, 128),
        "truecolor must reach the buffer unquantised"
    );
}

#[test]
fn a_wide_glyph_occupies_two_columns_and_is_not_drawn_twice() {
    let ui = state_with_panes(1);
    let mut parser = Parser::new(40, 10);
    parser.feed("世界".as_bytes());
    let mut parsers = BTreeMap::new();
    parsers.insert("pane-0".to_owned(), parser);

    let mut buffer = Buffer::empty(Rect::new(0, 0, 80, 24));
    let layout = TileLayout::from_panes(&["pane-0".to_owned()]);
    render_frame(
        &ui,
        &FrameInput {
            layout: &layout,
            parsers: &parsers,
            selection: None,
            modal: None,
            scroll: &BTreeMap::new(),
        },
        &mut buffer,
    );

    assert!(has_glyph(&buffer, 0, 2), "the wide glyph's first column");
    assert!(
        !has_glyph(&buffer, 1, 2),
        "the second column is a continuation and must stay blank, or the glyph renders twice"
    );
    assert!(
        has_glyph(&buffer, 2, 2),
        "the next glyph lands two columns on"
    );
}

#[test]
fn a_small_terminal_draws_a_notice_rather_than_a_mangled_layout() {
    let mut ui = state_with_panes(2);
    ui.set_size(40, 10);
    let layout = TileLayout::from_panes(&["pane-0".to_owned(), "pane-1".to_owned()]);
    let mut buffer = Buffer::empty(Rect::new(0, 0, 40, 10));

    render_frame(
        &ui,
        &FrameInput {
            layout: &layout,
            parsers: &BTreeMap::new(),
            selection: None,
            modal: None,
            scroll: &BTreeMap::new(),
        },
        &mut buffer,
    );

    assert!(
        line(&buffer, 0).contains("too small"),
        "the operator must be told why: {:?}",
        line(&buffer, 0)
    );
}

#[test]
fn a_split_border_is_drawn_between_the_panes() {
    let ui = state_with_panes(2);
    let layout = TileLayout::from_panes(&["pane-0".to_owned(), "pane-1".to_owned()]);
    let mut buffer = Buffer::empty(Rect::new(0, 0, 80, 24));

    let (_, rects, _) = render_frame(
        &ui,
        &FrameInput {
            layout: &layout,
            parsers: &BTreeMap::new(),
            selection: None,
            modal: None,
            scroll: &BTreeMap::new(),
        },
        &mut buffer,
    );

    let seam = rects.borders[0];
    assert_eq!(
        buffer[(seam.x, seam.y)].symbol(),
        "│",
        "the seam must be painted where the layout says it is"
    );
}

#[test]
fn the_sidebar_lists_the_workspace_and_the_jobs() {
    let mut ui = state_with_panes(1);
    ui.world.jobs.insert(
        "job-1".to_owned(),
        Job {
            id: "job-1".to_owned(),
            project_id: "proj-1".to_owned(),
            workspace_id: "ws-1".to_owned(),
            session_id: None,
            state: aibr_ipc::contracts::JobState::Blocked,
            blocked_reason: Some(aibr_tui::state::BlockedReason::PlanReview),
            detail: None,
            updated_at: "2026-10-06T00:00:00Z".to_owned(),
        },
    );
    let layout = TileLayout::from_panes(&["pane-0".to_owned()]);
    let mut buffer = Buffer::empty(Rect::new(0, 0, 80, 24));

    let (_, _, _rows) = render_frame(
        &ui,
        &FrameInput {
            layout: &layout,
            parsers: &BTreeMap::new(),
            selection: None,
            modal: None,
            scroll: &BTreeMap::new(),
        },
        &mut buffer,
    );

    let sidebar: String = (0..12)
        .map(|row| line(&buffer, row + 1))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(sidebar.contains("web-store"), "sidebar was {sidebar:?}");
    assert!(sidebar.contains("job-1"));
    assert!(
        sidebar.contains("[!]"),
        "a blocked job needs a badge the operator can see without hovering: {sidebar:?}"
    );
}

#[test]
fn the_sidebar_row_rects_match_the_rows_that_were_drawn() {
    // The point of returning the rows from the render is that a click lands on the
    // row the operator saw. If these disagree the hit-test is guessing.
    let ui = state_with_panes(1);
    let layout = TileLayout::from_panes(&["pane-0".to_owned()]);
    let mut buffer = Buffer::empty(Rect::new(0, 0, 80, 24));

    let (chrome, _, rows) = render_frame(
        &ui,
        &FrameInput {
            layout: &layout,
            parsers: &BTreeMap::new(),
            selection: None,
            modal: None,
            scroll: &BTreeMap::new(),
        },
        &mut buffer,
    );

    assert!(
        chrome.sidebar.is_some(),
        "the sidebar should be drawn at 80 columns"
    );
    assert!(!rows.entries.is_empty(), "the sidebar drew no rows");
    for (rect, _) in &rows.entries {
        assert!(
            chrome
                .sidebar
                .is_some_and(|sidebar| aibr_tui::layout::contains(sidebar, rect.x, rect.y)),
            "row at {rect:?} is not inside the sidebar at {:?}",
            chrome.sidebar
        );
        assert!(
            !line(&buffer, rect.y).trim().is_empty(),
            "row at y={} has a hit rect but drew nothing",
            rect.y
        );
    }
}

#[test]
fn a_zoomed_pane_takes_the_whole_canvas() {
    let mut ui = state_with_panes(2);
    let mut layout = TileLayout::from_panes(&["pane-0".to_owned(), "pane-1".to_owned()]);
    layout.zoomed = Some("pane-1".to_owned());
    ui.presentation.zoomed = Some("pane-1".to_owned());

    let mut parser = Parser::new(40, 10);
    parser.feed(b"ZOOMED");
    let mut parsers = BTreeMap::new();
    parsers.insert("pane-1".to_owned(), parser);

    let mut buffer = Buffer::empty(Rect::new(0, 0, 80, 24));
    let (_, rects, _) = render_frame(
        &ui,
        &FrameInput {
            layout: &layout,
            parsers: &parsers,
            selection: None,
            modal: None,
            scroll: &BTreeMap::new(),
        },
        &mut buffer,
    );

    assert_eq!(
        rects.panes.len(),
        1,
        "a zoom hides its siblings rather than drawing them underneath"
    );
    assert!(line(&buffer, 2).contains("ZOOMED"));
}

#[test]
fn the_rendering_is_deterministic() {
    // Two renders of the same state must produce identical buffers, or a pane
    // flickers for reasons nobody can find.
    let ui = state_with_panes(3);
    let layout = TileLayout::from_panes(&[
        "pane-0".to_owned(),
        "pane-1".to_owned(),
        "pane-2".to_owned(),
    ]);
    // Borrowed rather than returned from a closure: the maps are temporaries, and a
    // closure returning a borrow of one does not outlive it.
    let parsers: BTreeMap<String, Parser> = BTreeMap::new();
    let scroll: BTreeMap<String, u16> = BTreeMap::new();
    let input = || FrameInput {
        layout: &layout,
        parsers: &parsers,
        selection: None,
        modal: None,
        scroll: &scroll,
    };

    let mut first = Buffer::empty(Rect::new(0, 0, 100, 30));
    let mut second = Buffer::empty(Rect::new(0, 0, 100, 30));
    render_frame(&ui, &input(), &mut first);
    render_frame(&ui, &input(), &mut second);

    assert_eq!(first, second, "two renders of one state differed");
}

#[test]
fn a_blocked_job_opens_the_modal_over_the_panes() {
    let mut ui = state_with_panes(1);
    ui.world.jobs.insert(
        "job-1".to_owned(),
        Job {
            id: "job-1".to_owned(),
            project_id: "proj-1".to_owned(),
            workspace_id: "ws-1".to_owned(),
            session_id: None,
            state: aibr_ipc::contracts::JobState::Blocked,
            blocked_reason: Some(aibr_tui::state::BlockedReason::PlanReview),
            detail: Some("needs approval".to_owned()),
            updated_at: "2026-10-06T00:00:00Z".to_owned(),
        },
    );
    let layout = TileLayout::from_panes(&["pane-0".to_owned()]);
    let modal = aibr_tui::widgets::ApprovalModalState::new(
        ui.blocked_job().expect("the job is blocked").clone(),
    );

    let mut buffer = Buffer::empty(Rect::new(0, 0, 80, 24));
    render_frame(
        &ui,
        &FrameInput {
            layout: &layout,
            parsers: &BTreeMap::new(),
            selection: None,
            modal: Some(&modal),
            scroll: &BTreeMap::new(),
        },
        &mut buffer,
    );

    let frame: String = (0..24)
        .map(|row| line(&buffer, row))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(frame.contains("Human-in-the-Loop"), "modal was not drawn");
    assert!(frame.contains("job-1"));
    assert!(
        frame.contains("Approve"),
        "an approval prompt without an approve button is not one"
    );
}

#[test]
fn the_modals_button_rects_resolve_to_the_actions_they_name() {
    let job = Job {
        id: "job-1".to_owned(),
        project_id: "proj-1".to_owned(),
        workspace_id: "ws-1".to_owned(),
        session_id: None,
        state: aibr_ipc::contracts::JobState::Blocked,
        blocked_reason: Some(aibr_tui::state::BlockedReason::PlanReview),
        detail: None,
        updated_at: "2026-10-06T00:00:00Z".to_owned(),
    };
    let modal = aibr_tui::widgets::ApprovalModalState::new(job);
    let area = Rect::new(0, 0, 80, 24);

    // Every button must resolve, and resolve to ITSELF -- a click on Abort must not
    // approve a plan, which is the expensive mistake.
    for action in aibr_tui::widgets::ModalAction::ALL {
        let rect = modal
            .button_rects(area)
            .into_iter()
            .find(|(candidate, _)| *candidate == action)
            .map(|(_, rect)| rect)
            .unwrap_or_else(|| panic!("{action:?} has no rect"));
        assert_eq!(
            modal.action_at(area, rect.x, rect.y),
            Some(action),
            "{action:?}'s rect resolves to a different action"
        );
    }
}

#[test]
fn a_narrow_modal_stacks_its_buttons_rather_than_truncating_them() {
    let job = Job {
        id: "job-1".to_owned(),
        project_id: "proj-1".to_owned(),
        workspace_id: "ws-1".to_owned(),
        session_id: None,
        state: aibr_ipc::contracts::JobState::Blocked,
        blocked_reason: None,
        detail: None,
        updated_at: "2026-10-06T00:00:00Z".to_owned(),
    };
    let modal = aibr_tui::widgets::ApprovalModalState::new(job);
    let narrow = Rect::new(0, 0, 44, 20);
    let rects = modal.button_rects(narrow);
    assert_eq!(rects.len(), 4, "every action stays reachable");
    for (_, rect) in &rects {
        assert!(
            rect.x.saturating_add(rect.width) <= narrow.width,
            "a button ran off the side: {rect:?} in {narrow:?}"
        );
    }
}
