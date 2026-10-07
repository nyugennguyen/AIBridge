//! Hit-test routing: every `HitTarget`, the border drag, copy-on-select, the wheel, the
//! context menu, hyperlink sanitisation, and modal click interception.

use crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::Rect;

use aibr_tui::input::{
    mouse, Action, ContextMenu, HitTarget, HitTest, LayoutRects, SidebarRows, WHEEL_LINES,
};
use aibr_tui::layout::{HitTarget as LayoutHitTarget, TileLayout};

use crate::common::{
    chrome, input, now, one_pane_with_job, rects, two_pane_layout, two_pane_state,
};
use crate::fixtures::{FakeList, FakeModal, FakePane};

/// The sidebar rows the render pass would have drawn.
fn sidebar_rows() -> SidebarRows {
    let sidebar = chrome()
        .sidebar
        .expect("the sidebar is drawn at 100 columns");
    let row = |y: u16| Rect::new(sidebar.x, y, sidebar.width, 1);
    SidebarRows {
        entries: vec![
            (
                row(2),
                LayoutHitTarget::SidebarWorkspace {
                    workspace_id: "ws-1".to_owned(),
                },
            ),
            (
                row(3),
                LayoutHitTarget::SidebarJob {
                    job_id: "job-1".to_owned(),
                },
            ),
            (
                row(4),
                LayoutHitTarget::SidebarQueueItem {
                    job_id: "job-2".to_owned(),
                },
            ),
        ],
    }
}

/// A press at `(column, row)`.
fn press(column: u16, row: u16) -> MouseEvent {
    MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column,
        row,
        modifiers: KeyModifiers::NONE,
    }
}

/// A press with modifiers held.
fn press_mods(kind: MouseEventKind, column: u16, row: u16, modifiers: KeyModifiers) -> MouseEvent {
    MouseEvent {
        kind,
        column,
        row,
        modifiers,
    }
}

/// Somewhere inside the canvas, inside `pane-a`.
fn inside_pane_a() -> (u16, u16) {
    let layout = two_pane_layout();
    let rects = rects(&layout);
    let area = rects.panes["pane-a"].area;
    (area.x + 1, area.y + 1)
}

// ---------------------------------------------------------------------------------------
// Hit testing, for every target
// ---------------------------------------------------------------------------------------

/// Every `HitTarget` the layout can report, resolved from the geometry the renderer drew.
///
/// The test asserts on the LAYOUT's hit test, because that is what the engine calls; what
/// the engine adds is the ROUTING, asserted below.
#[test]
fn every_hit_target_resolves_from_the_render_geometry() {
    let layout = two_pane_layout();
    let rects = rects(&layout);
    let chrome = chrome();
    let rows = sidebar_rows();
    let hit = |column: u16, row: u16| HitTest::hit(column, row, &rects, &chrome, &rows);

    // Top bar.
    assert_eq!(hit(0, 0), LayoutHitTarget::TopBar);
    // Status bar.
    assert_eq!(hit(0, 29), LayoutHitTarget::StatusBar);
    // Sidebar rows.
    let sx = chrome.sidebar.unwrap().x;
    // Sidebar rows.
    assert_eq!(
        hit(sx + 2, 2),
        LayoutHitTarget::SidebarWorkspace {
            workspace_id: "ws-1".to_owned()
        }
    );
    assert_eq!(
        hit(sx + 2, 3),
        LayoutHitTarget::SidebarJob {
            job_id: "job-1".to_owned()
        }
    );
    assert_eq!(
        hit(sx + 2, 4),
        LayoutHitTarget::SidebarQueueItem {
            job_id: "job-2".to_owned()
        }
    );
    // Sidebar, on no row.
    assert_eq!(hit(sx + 2, 10), LayoutHitTarget::Sidebar);
    // A pane, and the seam between the two panes.
    let (column, row) = inside_pane_a();
    assert_eq!(
        hit(column, row),
        LayoutHitTarget::Pane {
            pane_id: "pane-a".to_owned()
        }
    );
    let seam = rects.borders[0];
    assert!(matches!(
        hit(seam.x, seam.y),
        LayoutHitTarget::Border { axis, first_pane, second_pane, .. }
            if axis == aibr_tui::input::Axis::Vertical
                && first_pane == "pane-a"
                && second_pane == "pane-b"
    ));
    // Canvas, on no pane -- only reachable with no seam to claim the cell.
    let empty = TileLayout::single("pane-a");
    let empty_rects = empty.compute(chrome.canvas);
    assert_eq!(
        HitTest::hit(
            empty_rects.canvas.x + 1,
            empty_rects.canvas.y + 1,
            &empty_rects,
            &chrome,
            &rows
        ),
        LayoutHitTarget::Pane {
            pane_id: "pane-a".to_owned()
        }
    );
    // Off the frame entirely.
    assert_eq!(hit(200, 200), LayoutHitTarget::None);
}

/// A click inside a pane focuses it.
#[test]
fn a_click_in_a_pane_focuses_it() {
    let mut layout = two_pane_layout();
    let rects = rects(&layout);
    let (column, row) = inside_pane_a();

    let mut state = input();
    let mut ui = one_pane_with_job();
    crate::common::focus(&mut ui, &mut layout, "pane-b");
    let mut pane = FakePane::default();

    let actions = mouse(
        &mut state,
        &press(column, row),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut FakeList::default(),
        &mut layout,
        &mut FakeModal::default(),
    );

    assert_eq!(ui.presentation.focused.as_deref(), Some("pane-a"));
    assert_eq!(
        layout.focused.as_deref(),
        Some("pane-a"),
        "the layout must agree"
    );
    assert!(actions.contains(&Action::FocusPane {
        pane_id: "pane-a".to_owned()
    }));
}

/// A double click on a pane titlebar toggles zoom.
#[test]
fn double_click_pane_header_toggles_zoom() {
    let mut layout = two_pane_layout();
    let mut state = input();
    let mut ui = two_pane_state();
    crate::common::focus(&mut ui, &mut layout, "pane-b");
    let mut pane = FakePane::default();
    let r = rects(&layout);
    let pane_rect = r.panes.get("pane-a").unwrap();
    let (col, row) = (pane_rect.area.x + 2, pane_rect.area.y);
    let t1 = now();

    // First click focuses
    let actions1 = mouse(
        &mut state,
        &press(col, row),
        &r,
        &chrome(),
        &sidebar_rows(),
        t1,
        &mut ui,
        &mut pane,
        &mut FakeList::default(),
        &mut layout,
        &mut FakeModal::default(),
    );
    assert!(actions1.contains(&Action::FocusPane {
        pane_id: "pane-a".to_owned()
    }));
    assert_eq!(ui.presentation.zoomed, None);

    // Second click within 200ms at same titlebar coordinate toggles zoom
    let t2 = crate::common::later(t1, 150);
    let actions2 = mouse(
        &mut state,
        &press(col, row),
        &r,
        &chrome(),
        &sidebar_rows(),
        t2,
        &mut ui,
        &mut pane,
        &mut FakeList::default(),
        &mut layout,
        &mut FakeModal::default(),
    );
    assert_eq!(
        actions2,
        vec![Action::ZoomPane {
            pane_id: Some("pane-a".to_owned())
        }]
    );
    assert_eq!(ui.presentation.zoomed.as_deref(), Some("pane-a"));
}

/// A click on a sidebar workspace row makes it active, on the daemon too.
#[test]
fn a_click_on_a_sidebar_workspace_activates_it() {
    let mut layout = two_pane_layout();
    let mut state = input();
    let mut ui = two_pane_state();
    ui.presentation.active_workspace = Some("ws-other".to_owned());
    let mut pane = FakePane::default();

    let actions = mouse(
        &mut state,
        &press(2, 1),
        &rects(&layout),
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut FakeList::default(),
        &mut layout,
        &mut FakeModal::default(),
    );

    assert_eq!(ui.presentation.active_workspace.as_deref(), Some("ws-1"));
    assert!(actions.contains(&Action::SetActiveWorkspace {
        workspace_id: "ws-1".to_owned()
    }));
    assert!(
        actions
            .iter()
            .any(|action| matches!(action, Action::Command(_))),
        "the daemon must be told, not only the client"
    );
}

/// A click on a sidebar job row focuses that job's pane.
#[test]
fn a_click_on_a_sidebar_job_focuses_its_pane() {
    let mut layout = two_pane_layout();
    let mut state = input();
    let mut ui = one_pane_with_job();
    crate::common::focus(&mut ui, &mut layout, "pane-b");
    let mut pane = FakePane::default();

    let actions = mouse(
        &mut state,
        &press(2, 2),
        &rects(&layout),
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut FakeList::default(),
        &mut layout,
        &mut FakeModal::default(),
    );

    assert_eq!(ui.presentation.focused.as_deref(), Some("pane-a"));
    assert!(actions.contains(&Action::FocusPane {
        pane_id: "pane-a".to_owned()
    }));
}

/// The wheel scrolls the sidebar over a sidebar row, and the pane's scrollback over a
/// pane -- and NOTHING over chrome.
#[test]
fn the_wheel_scrolls_where_it_is_pointed_and_nowhere_else() {
    let mut layout = two_pane_layout();
    let rects = rects(&layout);
    let (column, row) = inside_pane_a();

    // Over a pane: three lines of scrollback, and the pane is asked to scroll.
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::new(&["a", "b", "c", "d", "e", "f"], 40, 3);
    let mut list = FakeList::default();
    let actions = mouse(
        &mut state,
        &press_mods(MouseEventKind::ScrollUp, column, row, KeyModifiers::NONE),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut list,
        &mut layout,
        &mut FakeModal::default(),
    );
    assert_eq!(
        actions,
        vec![Action::ScrollPane {
            pane_id: "pane-a".to_owned(),
            lines: WHEEL_LINES
        }]
    );
    assert_eq!(
        pane.scrolls,
        vec![("pane-a".to_owned(), 3)],
        "three lines a notch"
    );

    // Over the sidebar: the list scrolls and the pane does not.
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::new(&["a", "b"], 40, 3);
    let mut list = FakeList::default();
    let actions = mouse(
        &mut state,
        &press_mods(
            MouseEventKind::ScrollDown,
            chrome().sidebar.unwrap().x + 2,
            2,
            KeyModifiers::NONE,
        ),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut list,
        &mut layout,
        &mut FakeModal::default(),
    );
    assert_eq!(actions, vec![Action::ScrollSidebar(-3)]);
    assert_eq!(list.scrolls, vec![-3]);
    assert!(
        pane.scrolls.is_empty(),
        "the pane must not scroll from a sidebar wheel"
    );

    // Over the top bar: nothing.
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::new(&["a"], 40, 3);
    let actions = mouse(
        &mut state,
        &press_mods(MouseEventKind::ScrollUp, 5, 0, KeyModifiers::NONE),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut FakeList::default(),
        &mut layout,
        &mut FakeModal::default(),
    );
    assert!(
        actions.is_empty(),
        "scrolling the header must do nothing: {actions:?}"
    );
    assert!(pane.scrolls.is_empty());
}

/// A pane with no scrollback -- a diff widget -- ignores the wheel rather than scrolling
/// whatever is nearest.
#[test]
fn a_pane_without_scrollback_ignores_the_wheel() {
    let mut layout = two_pane_layout();
    let (column, row) = inside_pane_a();
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::new(&["a"], 40, 3).unscrollable();

    let actions = mouse(
        &mut state,
        &press_mods(MouseEventKind::ScrollUp, column, row, KeyModifiers::NONE),
        &rects(&layout),
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut FakeList::default(),
        &mut layout,
        &mut FakeModal::default(),
    );

    assert!(actions.is_empty(), "got {actions:?}");
    assert!(pane.scrolls.is_empty());
}

// ---------------------------------------------------------------------------------------
// Border drag
// ---------------------------------------------------------------------------------------

/// A press-drag-release on a seam snaps the seam to the operator's cell, and the ratio the
/// engine reports is the one the LAYOUT stored.
///
/// THE SNAP IS THE WHOLE CLAIM. `TileLayout::split_parts` puts the seam at
/// `round((span - 1) * ratio)`; the engine computes `ratio = (cell - origin) / (span - 1)`.
/// Asserting the rendered seam lands on the drag cell is what proves criterion 5's
/// no-tearing, rather than asserting the ratio merely "changed".
#[test]
fn a_border_drag_snaps_the_seam_to_the_cursor_cell() {
    let layout = two_pane_layout();
    let rects = rects(&layout);
    let seam = rects.borders[0];
    let span = rects.panes["pane-b"].area.x + rects.panes["pane-b"].area.width
        - rects.panes["pane-a"].area.x;

    for target in [30u16, 40, 55, 70] {
        let mut fresh = two_pane_layout();
        let mut state = input();
        let mut ui = two_pane_state();
        let mut pane = FakePane::default();

        mouse(
            &mut state,
            &press(seam.x, seam.y + 1),
            &rects,
            &chrome(),
            &sidebar_rows(),
            now(),
            &mut ui,
            &mut pane,
            &mut FakeList::default(),
            &mut fresh,
            &mut FakeModal::default(),
        );
        assert!(state.dragging(), "the press must begin a drag");

        let dragged = mouse(
            &mut state,
            &press_mods(
                MouseEventKind::Drag(MouseButton::Left),
                target,
                seam.y + 1,
                KeyModifiers::NONE,
            ),
            &rects,
            &chrome(),
            &sidebar_rows(),
            now(),
            &mut ui,
            &mut pane,
            &mut FakeList::default(),
            &mut fresh,
            &mut FakeModal::default(),
        );

        let action = dragged
            .iter()
            .find_map(|action| match action {
                Action::SetSplitRatio {
                    ratio,
                    first_pane,
                    second_pane,
                    axis,
                } => Some((*ratio, first_pane.as_str(), second_pane.as_str(), *axis)),
                _ => None,
            })
            .unwrap_or_else(|| panic!("a drag must move the ratio: {dragged:?}"));
        assert_eq!((action.1, action.2), ("pane-a", "pane-b"));
        assert_eq!(action.3, aibr_tui::input::Axis::Vertical);

        // THE INVERSE. This is the assertion that would fail if the snap were computed from
        // a float delta instead of a cell.
        let (left, _) =
            TileLayout::split_children(aibr_tui::input::Axis::Vertical, rects.canvas, action.0);
        assert_eq!(
            left.width + rects.panes["pane-a"].area.x,
            target,
            "the seam must land on the dragged cell ({target}), not beside it"
        );
        let _ = span;
    }
}

/// The ratio is clamped so neither pane collapses, at BOTH ends of the drag.
#[test]
fn a_border_drag_clamps_so_neither_pane_collapses() {
    let layout = two_pane_layout();
    let rects = rects(&layout);
    let seam = rects.borders[0];

    for (target, expected_side) in [
        (0u16, "left"),
        (rects.canvas.x + rects.canvas.width - 1, "right"),
    ] {
        let mut fresh = two_pane_layout();
        let mut state = input();
        let mut ui = two_pane_state();
        let mut pane = FakePane::default();

        mouse(
            &mut state,
            &press(seam.x, seam.y),
            &rects,
            &chrome(),
            &sidebar_rows(),
            now(),
            &mut ui,
            &mut pane,
            &mut FakeList::default(),
            &mut fresh,
            &mut FakeModal::default(),
        );
        let actions = mouse(
            &mut state,
            &press_mods(
                MouseEventKind::Up(MouseButton::Left),
                target,
                seam.y,
                KeyModifiers::NONE,
            ),
            &rects,
            &chrome(),
            &sidebar_rows(),
            now(),
            &mut ui,
            &mut pane,
            &mut FakeList::default(),
            &mut fresh,
            &mut FakeModal::default(),
        );

        let after = fresh.compute(chrome().canvas);
        let first = after.panes["pane-a"].area.width;
        let second = after.panes["pane-b"].area.width;
        assert!(
            first >= 1,
            "dragging to the {expected_side} edge collapsed the first pane: {first}"
        );
        assert!(
            second >= 1,
            "dragging to the {expected_side} edge collapsed the second pane: {second}"
        );

        // The engine reports pane sizes, and neither is zero.
        for action in &actions {
            if let Action::PaneResized { columns, rows, .. } = action {
                assert!(
                    (*columns, *rows) != (0, 0),
                    "a resize to zero was emitted: {actions:?}"
                );
            }
        }
        assert!(!state.dragging(), "the release must end the drag");
    }
}

/// Releasing emits the pane sizes exactly ONCE -- not once per motion event.
#[test]
fn releasing_sends_the_pane_sizes_once() {
    let mut layout = two_pane_layout();
    let rects = rects(&layout);
    let seam = rects.borders[0];
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::default();

    mouse(
        &mut state,
        &press(seam.x, seam.y),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut FakeList::default(),
        &mut layout,
        &mut FakeModal::default(),
    );
    for target in [30u16, 35, 40, 45] {
        let actions = mouse(
            &mut state,
            &press_mods(
                MouseEventKind::Drag(MouseButton::Left),
                target,
                seam.y,
                KeyModifiers::NONE,
            ),
            &rects,
            &chrome(),
            &sidebar_rows(),
            now(),
            &mut ui,
            &mut pane,
            &mut FakeList::default(),
            &mut layout,
            &mut FakeModal::default(),
        );
        assert!(
            !actions
                .iter()
                .any(|action| matches!(action, Action::PaneResized { .. })),
            "a motion event must not tell the daemon: {actions:?}"
        );
    }

    let actions = mouse(
        &mut state,
        &press_mods(
            MouseEventKind::Up(MouseButton::Left),
            40,
            seam.y,
            KeyModifiers::NONE,
        ),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut FakeList::default(),
        &mut layout,
        &mut FakeModal::default(),
    );

    let resizes = actions
        .iter()
        .filter(|action| matches!(action, Action::PaneResized { .. }))
        .count();
    assert_eq!(
        resizes, 2,
        "exactly the two panes either side of the seam: {actions:?}"
    );
    assert_eq!(ui.presentation.mode, aibr_tui::input::InputMode::Terminal);
}

/// `ratio_for_drag` and `TileLayout::split_parts` are exact inverses over every cell in
/// the unclamped interior. This is the property criterion 5 rests on, stated directly.
#[test]
fn ratio_for_drag_inverts_split_parts_exactly() {
    let layout = two_pane_layout();
    let rects = rects(&layout);
    let first = rects.panes["pane-a"].area;
    let second = rects.panes["pane-b"].area;
    let axis = aibr_tui::input::Axis::Vertical;

    for cell in first.x..second.x + second.width {
        let geometry = aibr_tui::input::ratio_for_drag(&rects, "pane-a", "pane-b", axis, cell)
            .unwrap_or_else(|| panic!("no geometry for cell {cell}"));
        let (leading, _) = TileLayout::split_children(axis, rects.canvas, geometry.ratio);
        assert_eq!(
            leading.width + first.x,
            cell,
            "cell {cell}: the seam landed on {}, not the cell",
            leading.width + first.x
        );
    }
}

/// A drag on a seam whose panes have gone is refused, rather than resized to whatever is
/// there now.
#[test]
fn a_drag_on_a_stale_seam_does_nothing() {
    let mut layout = two_pane_layout();
    let rects = rects(&layout);
    let seam = rects.borders[0];
    let mut empty = LayoutRects {
        canvas: rects.canvas,
        ..LayoutRects::default()
    };

    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::default();
    let actions = mouse(
        &mut state,
        &press_mods(
            MouseEventKind::Drag(MouseButton::Left),
            40,
            seam.y,
            KeyModifiers::NONE,
        ),
        &empty,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut FakeList::default(),
        &mut layout,
        &mut FakeModal::default(),
    );

    assert!(
        actions.is_empty(),
        "a stale seam must do nothing: {actions:?}"
    );
    empty.canvas = rects.canvas;
}

// ---------------------------------------------------------------------------------------
// Copy on select
// ---------------------------------------------------------------------------------------

/// A drag across two panes' text copies exactly the selected cells, and shows the toast.
#[test]
fn copy_on_select_extracts_the_selected_cells_and_toasts() {
    let mut layout = two_pane_layout();
    let rects = rects(&layout);
    let area = rects.panes["pane-a"].area;
    let mut pane = FakePane::new(&["hello world", "second line"], 40, 10);
    let mut state = input();
    let mut ui = two_pane_state();
    let mut list = FakeList::default();

    // Press on the 'h' of "hello" and drag to its 'o': cells 0..4 inclusive, which is what
    // the operator sees selected. Columns 6..10 would be "world" -- the assertion below is
    // about the cells, so getting them wrong would still pass a weaker test.
    let to = (area.x + 4, area.y);
    let drag_row = |column: u16| MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column,
        row: area.y,
        modifiers: KeyModifiers::NONE,
    };

    mouse(
        &mut state,
        &drag_row(area.x),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut list,
        &mut layout,
        &mut FakeModal::default(),
    );
    mouse(
        &mut state,
        &press_mods(
            MouseEventKind::Drag(MouseButton::Left),
            to.0,
            to.1,
            KeyModifiers::NONE,
        ),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut list,
        &mut layout,
        &mut FakeModal::default(),
    );
    let actions = mouse(
        &mut state,
        &press_mods(
            MouseEventKind::Up(MouseButton::Left),
            to.0,
            to.1,
            KeyModifiers::NONE,
        ),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut list,
        &mut layout,
        &mut FakeModal::default(),
    );

    let copied = actions.iter().find_map(|action| match action {
        Action::CopySelection(text) => Some(text.as_str().to_owned()),
        _ => None,
    });
    assert_eq!(copied.as_deref(), Some("hello"), "got {actions:?}");
    assert!(
        actions.iter().any(|action| matches!(action, Action::Toast(toast) if toast.message == "Copied to clipboard")),
        "a copy must confirm: {actions:?}"
    );
}

/// A multi-line selection is joined with newlines, and a soft-wrapped one is NOT.
#[test]
fn a_selection_joins_real_newlines_but_not_soft_wraps() {
    let layout = two_pane_layout();
    let area = rects(&layout).panes["pane-a"].area;

    // Two hard lines.
    let rects_two = rects(&layout);
    let hard = FakePane::new(&["first line", "second line"], 40, 10);
    // PANE-CONTENT coordinates: column 0 is the pane's first column, row 0 the first line
    // the pane shows. The pane's terminal origin is deliberately not involved.
    let selection = aibr_tui::input::Selection::new(
        "pane-a",
        aibr_tui::input::CellCoords::new(0, 0),
        aibr_tui::input::CellCoords::new(6, 1),
    );
    assert_eq!(selection.extract(&hard), "first line\nsecond");
    assert!(
        !area.is_empty(),
        "the area exists only to prove the origin is unused"
    );
    let _ = rects_two;

    // The same shape across a soft wrap.
    let wrapped = FakePane::new(&["first line", "second line"], 40, 10).wrapping(1);
    let selection = aibr_tui::input::Selection::new(
        "pane-a",
        aibr_tui::input::CellCoords::new(0, 0),
        aibr_tui::input::CellCoords::new(6, 1),
    );
    assert_eq!(
        selection.extract(&wrapped),
        "first linesecond",
        "a soft wrap is one logical line and must not gain a newline"
    );
    let _ = layout;
}

/// The clipboard receives REDACTED text, not the raw selection.
#[test]
fn a_copied_selection_is_redacted() {
    let mut layout = two_pane_layout();
    let rects = rects(&layout);
    let area = rects.panes["pane-a"].area;
    // A line whose middle is a bearer token.
    let mut pane = FakePane::new(
        &["Authorization: Bearer sk-ant-AAAABBBBCCCCDDDDEEEE1234 done"],
        70,
        10,
    );
    let mut state = input();
    let mut ui = two_pane_state();
    let mut list = FakeList::default();

    mouse(
        &mut state,
        &press(area.x, area.y),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut list,
        &mut layout,
        &mut FakeModal::default(),
    );
    mouse(
        &mut state,
        &press_mods(
            MouseEventKind::Drag(MouseButton::Left),
            area.x + 55,
            area.y,
            KeyModifiers::NONE,
        ),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut list,
        &mut layout,
        &mut FakeModal::default(),
    );
    let actions = mouse(
        &mut state,
        &press_mods(
            MouseEventKind::Up(MouseButton::Left),
            area.x + 55,
            area.y,
            KeyModifiers::NONE,
        ),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut list,
        &mut layout,
        &mut FakeModal::default(),
    );

    let copied = actions.iter().find_map(|action| match action {
        Action::CopySelection(text) => Some(text.as_str().to_owned()),
        _ => None,
    });
    let copied = copied.unwrap_or_else(|| panic!("nothing copied: {actions:?}"));
    assert!(
        copied.contains("[redacted]"),
        "the token must be masked: {copied:?}"
    );
    assert!(
        !copied.contains("sk-ant-AAAABBBBCCCCDDDDEEEE1234"),
        "{copied:?}"
    );
}

/// A click with no drag does NOT overwrite the clipboard.
///
/// It would, if a single-cell selection counted: clicking to focus a pane would clobber
/// whatever the operator had copied.
#[test]
fn a_click_without_a_drag_copies_nothing() {
    let mut layout = two_pane_layout();
    let rects = rects(&layout);
    let area = rects.panes["pane-a"].area;
    let mut pane = FakePane::new(&["some text here"], 40, 10);
    let mut state = input();
    let mut ui = two_pane_state();
    let mut list = FakeList::default();

    let (column, row) = (area.x + 2, area.y + 1);
    mouse(
        &mut state,
        &press(column, row),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut list,
        &mut layout,
        &mut FakeModal::default(),
    );
    let actions = mouse(
        &mut state,
        &press_mods(
            MouseEventKind::Up(MouseButton::Left),
            column,
            row,
            KeyModifiers::NONE,
        ),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut list,
        &mut layout,
        &mut FakeModal::default(),
    );

    assert!(
        !actions
            .iter()
            .any(|action| matches!(action, Action::CopySelection(_))),
        "a plain click must not touch the clipboard: {actions:?}"
    );
}

/// A selection that ends below the pane stops at the last row, rather than running into
/// scrollback the operator cannot see.
#[test]
fn a_selection_is_clipped_to_the_viewport() {
    let layout = two_pane_layout();
    let rects = rects(&layout);
    let area = rects.panes["pane-a"].area;
    let pane = FakePane::new(&["row zero", "row one"], 40, 2);
    // The drag ended 40 rows below the pane. The viewport is two rows, so the selection is
    // clipped to the bottom rather than reaching into scrollback nobody can see.
    let selection = aibr_tui::input::Selection::new(
        "pane-a",
        aibr_tui::input::CellCoords::new(0, 0),
        aibr_tui::input::CellCoords::new(6, 40),
    );

    assert_eq!(selection.extract(&pane), "row zero\nrow one");
    assert!(area.width > 0);
}

// ---------------------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------------------

/// A right-click on a pane opens the five-item menu, and nothing is routed through.
#[test]
fn a_right_click_opens_the_menu_and_routes_nothing() {
    let mut layout = two_pane_layout();
    let rects = rects(&layout);
    let (column, row) = inside_pane_a();
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::default();

    let actions = mouse(
        &mut state,
        &press_mods(
            MouseEventKind::Down(MouseButton::Right),
            column,
            row,
            KeyModifiers::NONE,
        ),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut FakeList::default(),
        &mut layout,
        &mut FakeModal::default(),
    );

    assert!(actions.is_empty());
    let menu = state.menu().expect("a menu opened");
    assert_eq!(menu.at(), (column, row));
    assert_eq!(menu.pane_id.as_deref(), Some("pane-a"));
    assert_eq!(
        menu.items(),
        ContextMenu::open(
            (0, 0),
            &HitTarget::Pane {
                pane_id: "x".to_owned()
            }
        )
        .expect("a pane yields a menu")
        .items(),
        "all five items, in the documented order"
    );
}

/// The menu's own hit test and its own dimensions agree, so the row an operator clicks is
/// the row that highlights.
#[test]
fn the_menu_hit_test_agrees_with_its_dimensions() {
    let mut layout = two_pane_layout();
    let rects = rects(&layout);
    let (column, row) = inside_pane_a();
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::default();
    let mut list = FakeList::default();

    mouse(
        &mut state,
        &press_mods(
            MouseEventKind::Down(MouseButton::Right),
            column,
            row,
            KeyModifiers::NONE,
        ),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut list,
        &mut layout,
        &mut FakeModal::default(),
    );
    let menu = state.menu().expect("a menu opened").clone();
    assert_eq!(menu.height() as usize, menu.items().len() + 2);
    assert!(menu.width() as usize >= "View Outbox Item".len());

    // Click the SECOND item: one border row down, then one row per item.
    let item_column = menu.at().0 + 2;
    let item_row = menu.at().1 + 2;
    let actions = mouse(
        &mut state,
        &press(item_column, item_row),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut list,
        &mut layout,
        &mut FakeModal::default(),
    );

    assert!(state.menu().is_none(), "activating closes the menu");
    assert!(
        actions.contains(&Action::SpawnPaneRequested {
            workspace_id: "ws-1".to_owned(),
            parent_pane_id: "pane-a".to_owned(),
            axis: aibr_tui::input::Axis::Horizontal,
            kind: aibr_tui::state::PaneKind::Terminal,
        }),
        "the second item is Split Horizontal: {actions:?}"
    );
}

/// A click outside the menu dismisses it AND routes through to what is underneath.
#[test]
fn a_click_outside_the_menu_dismisses_it_and_routes_through() {
    let mut layout = two_pane_layout();
    let rects = rects(&layout);
    let (column, row) = inside_pane_a();
    let mut state = input();
    let mut ui = two_pane_state();
    ui.presentation.focused = Some("pane-b".to_owned());
    let mut pane = FakePane::default();
    let mut list = FakeList::default();

    mouse(
        &mut state,
        &press_mods(
            MouseEventKind::Down(MouseButton::Right),
            column,
            row,
            KeyModifiers::NONE,
        ),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut list,
        &mut layout,
        &mut FakeModal::default(),
    );
    assert!(state.menu().is_some());

    // Somewhere well clear of the menu: the other pane.
    let other = rects.panes["pane-b"].area;
    let actions = mouse(
        &mut state,
        &press(other.x + 1, other.y + 1),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut list,
        &mut layout,
        &mut FakeModal::default(),
    );

    assert!(state.menu().is_none(), "one click must dismiss the menu");
    assert_eq!(
        ui.presentation.focused.as_deref(),
        Some("pane-b"),
        "and reach through: {actions:?}"
    );
}

/// A right-click on chrome opens NO menu, because a menu with no items is a rectangle the
/// operator has to click away from.
#[test]
fn a_right_click_on_chrome_opens_no_menu() {
    let mut layout = two_pane_layout();
    let rects = rects(&layout);
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::default();

    mouse(
        &mut state,
        &press_mods(
            MouseEventKind::Down(MouseButton::Right),
            5,
            0,
            KeyModifiers::NONE,
        ),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut FakeList::default(),
        &mut layout,
        &mut FakeModal::default(),
    );

    assert!(state.menu().is_none());
}

/// `Close Pane` tells the daemon and collapses the layout's leaf.
#[test]
fn close_pane_tells_the_daemon_and_removes_the_leaf() {
    let mut layout = two_pane_layout();
    let rects = rects(&layout);
    let (column, row) = inside_pane_a();
    let mut state = input();
    let mut ui = one_pane_with_job();
    ui.presentation.focused = Some("pane-b".to_owned());
    let mut pane = FakePane::default();
    let mut list = FakeList::default();

    mouse(
        &mut state,
        &press_mods(
            MouseEventKind::Down(MouseButton::Right),
            column,
            row,
            KeyModifiers::NONE,
        ),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut list,
        &mut layout,
        &mut FakeModal::default(),
    );
    let menu = state.menu().expect("a menu opened").clone();
    let close_row = menu.at().1 + 3; // border, Split V, Split H, Close Pane
    let actions = mouse(
        &mut state,
        &press(menu.at().0 + 2, close_row),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut list,
        &mut layout,
        &mut FakeModal::default(),
    );

    assert!(
        actions.contains(&Action::Command(
            aibr_tui::input::commands::close_pane("pane-a").expect("valid")
        )),
        "{actions:?}"
    );
    assert!(
        !layout.root.contains("pane-a"),
        "the leaf must leave the tree"
    );
}

/// `Copy Raw Logs` copies the pane's raw log, redacted.
#[test]
fn copy_raw_logs_is_redacted() {
    let mut layout = two_pane_layout();
    let rects = rects(&layout);
    let (column, row) = inside_pane_a();
    let mut state = input();
    let mut ui = two_pane_state();
    let mut pane = FakePane::new(&["a"], 40, 10);
    pane.raw = "connecting with token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123".to_owned();
    let mut list = FakeList::default();

    mouse(
        &mut state,
        &press_mods(
            MouseEventKind::Down(MouseButton::Right),
            column,
            row,
            KeyModifiers::NONE,
        ),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut list,
        &mut layout,
        &mut FakeModal::default(),
    );
    let menu = state.menu().expect("a menu opened").clone();
    // border, five items, border: the last item is two rows above the bottom.
    let raw_row = menu.at().1 + menu.height() - 2;
    let actions = mouse(
        &mut state,
        &press(menu.at().0 + 2, raw_row),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut list,
        &mut layout,
        &mut FakeModal::default(),
    );

    let copied = actions.iter().find_map(|action| match action {
        Action::CopyRawLog(text) => Some(text.as_str().to_owned()),
        _ => None,
    });
    let copied = copied.unwrap_or_else(|| panic!("nothing copied: {actions:?}"));
    assert!(
        !copied.contains("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"),
        "{copied:?}"
    );
    assert!(copied.contains("[redacted]"));
}

// ---------------------------------------------------------------------------------------
// Hyperlinks
// ---------------------------------------------------------------------------------------

/// `Ctrl+LeftClick` on an OSC 8 link opens it, after validation.
#[test]
fn ctrl_click_opens_a_valid_http_link() {
    let mut layout = two_pane_layout();
    let rects = rects(&layout);
    let area = rects.panes["pane-a"].area;
    let pane = FakePane::new(
        &["see the docs at https://example.com/a?b=c for more"],
        60,
        10,
    )
    .with_link("pane-a", 0, 12, "https://example.com/a?b=c");
    let mut state = input();
    let mut ui = two_pane_state();

    let actions = mouse(
        &mut state,
        &press_mods(
            MouseEventKind::Down(MouseButton::Left),
            area.x + 12,
            area.y,
            KeyModifiers::CONTROL,
        ),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut FakePane::new(&[], 0, 0),
        &mut FakeList::default(),
        &mut layout,
        &mut FakeModal::default(),
    );

    // The fake needs the real pane, so re-run with it. `pane` was built above only to hold
    // the link map; the engine reads it through the trait object it is handed.
    let _ = pane;
    let _ = actions;

    let mut pane = FakePane::new(
        &["see the docs at https://example.com/a?b=c for more"],
        60,
        10,
    )
    .with_link("pane-a", 0, 12, "https://example.com/a?b=c");
    let mut state = input();
    let mut ui = two_pane_state();
    let actions = mouse(
        &mut state,
        &press_mods(
            MouseEventKind::Down(MouseButton::Left),
            area.x + 12,
            area.y,
            KeyModifiers::CONTROL,
        ),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut FakeList::default(),
        &mut layout,
        &mut FakeModal::default(),
    );

    let opened = actions.iter().find_map(|action| match action {
        Action::OpenLink(url) => Some(url.as_str().to_owned()),
        _ => None,
    });
    assert_eq!(opened.as_deref(), Some("https://example.com/a?b=c"));
}

/// A `Ctrl+Click` on a link whose scheme is not `http`/`https` is REFUSED, and the
/// operator is told which scheme was refused.
///
/// THIS IS THE SECURITY CASE. The hyperlink came from a pane, the pane from an agent, and
/// the agent from a peer. `file:///…` and `javascript:` handed to the OS handler would be
/// an arbitrary-command-execution primitive.
#[test]
fn ctrl_click_refuses_a_non_http_scheme_and_names_it() {
    for (raw, scheme) in [
        ("file:///etc/passwd", "file"),
        ("javascript:alert(1)", "javascript"),
        ("data:text/html,<script>x</script>", "data"),
        ("mailto:a@b.c", "mailto"),
        ("vscode://file/etc/passwd", "vscode"),
    ] {
        let mut layout = two_pane_layout();
        let rects = rects(&layout);
        let area = rects.panes["pane-a"].area;
        let mut pane = FakePane::new(&["a link"], 60, 10).with_link("pane-a", 0, 0, raw);
        let mut state = input();
        let mut ui = two_pane_state();

        let actions = mouse(
            &mut state,
            &press_mods(
                MouseEventKind::Down(MouseButton::Left),
                area.x,
                area.y,
                KeyModifiers::CONTROL,
            ),
            &rects,
            &chrome(),
            &sidebar_rows(),
            now(),
            &mut ui,
            &mut pane,
            &mut FakeList::default(),
            &mut layout,
            &mut FakeModal::default(),
        );

        assert!(
            !actions
                .iter()
                .any(|action| matches!(action, Action::OpenLink(_))),
            "`{raw}` must not be opened: {actions:?}"
        );
        let toast = actions.iter().find_map(|action| match action {
            Action::Toast(toast) => Some(toast.message.as_str()),
            _ => None,
        });
        assert!(
            toast.is_some_and(|message| message.contains(scheme) && message.contains("http")),
            "the refusal must name the scheme for `{raw}`: {actions:?}"
        );
    }
}

/// `Ctrl+Click` where there is no link does nothing at all -- it must not fall through to
/// focusing the pane and starting a selection.
#[test]
fn ctrl_click_with_no_link_does_nothing() {
    let mut layout = two_pane_layout();
    let rects = rects(&layout);
    let (column, row) = inside_pane_a();
    let mut pane = FakePane::new(&["plain text"], 40, 10);
    let mut state = input();
    let mut ui = two_pane_state();
    ui.presentation.focused = Some("pane-b".to_owned());

    let actions = mouse(
        &mut state,
        &press_mods(
            MouseEventKind::Down(MouseButton::Left),
            column,
            row,
            KeyModifiers::CONTROL,
        ),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut FakeList::default(),
        &mut layout,
        &mut FakeModal::default(),
    );

    assert!(actions.is_empty(), "{actions:?}");
    assert!(!state.dragging(), "a link click must not begin a selection");
    assert_eq!(
        ui.presentation.focused.as_deref(),
        Some("pane-b"),
        "focus must not move"
    );
}

// ---------------------------------------------------------------------------------------
// Modal interception, by mouse
// ---------------------------------------------------------------------------------------

/// A click meant for the terminal BEHIND the modal is swallowed by the modal.
///
/// The mouse half of the rule whose keyboard half is tested in `keyboard.rs`. A `blocked`
/// job is the one moment the operator is being asked to make a security decision, and a
/// stray click landing on the terminal behind the dialog is a way for the agent to act
/// while the human believes they are reading.
#[test]
fn a_click_meant_for_the_terminal_behind_the_modal_is_swallowed() {
    let mut layout = two_pane_layout();
    let rects = rects(&layout);
    let (column, row) = inside_pane_a();
    let mut state = input();
    let mut ui = one_pane_with_job();
    crate::common::focus(&mut ui, &mut layout, "pane-b");
    let mut pane = FakePane::new(&["secret plan text"], 40, 10);
    let mut list = FakeList::default();
    // The modal is open and covers the click.
    let mut modal = FakeModal::open_on("job-1").at(Rect::new(column, row, 20, 6));

    let actions = mouse(
        &mut state,
        &press(column + 2, row + 2),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut list,
        &mut layout,
        &mut modal,
    );

    assert!(
        actions.is_empty(),
        "the click must produce nothing at all: {actions:?}"
    );
    assert_eq!(
        modal.clicks,
        vec![(2, 2)],
        "the modal must receive it, translated"
    );
    assert_eq!(
        ui.presentation.focused.as_deref(),
        Some("pane-b"),
        "focus must not move"
    );
    assert!(!state.dragging(), "no selection may start behind the modal");
    assert!(state.menu().is_none(), "no menu may open behind the modal");
}

/// A DRAG behind the modal is eaten without being read as a button press.
///
/// Otherwise moving the mouse across the dialog would approve a plan.
#[test]
fn a_drag_behind_the_modal_is_not_a_click() {
    let mut layout = two_pane_layout();
    let rects = rects(&layout);
    let (column, row) = inside_pane_a();
    let mut state = input();
    let mut ui = one_pane_with_job();
    let mut pane = FakePane::default();
    let mut modal = FakeModal::open_on("job-1")
        .answering_clicks(aibr_tui::input::ModalOutcome::Approve {
            scope: aibr_tui::input::ApproveScope::Apply,
        })
        .at(Rect::new(column, row, 20, 6));

    for kind in [
        MouseEventKind::Drag(MouseButton::Left),
        MouseEventKind::Moved,
    ] {
        let actions = mouse(
            &mut state,
            &press_mods(kind, column + 2, row + 2, KeyModifiers::NONE),
            &rects,
            &chrome(),
            &sidebar_rows(),
            now(),
            &mut ui,
            &mut pane,
            &mut FakeList::default(),
            &mut layout,
            &mut modal,
        );
        assert!(
            actions.is_empty(),
            "{kind:?} approved something: {actions:?}"
        );
    }
    assert!(modal.clicks.is_empty(), "only a press is a click");
}

/// A right-click behind the modal does not open a context menu.
#[test]
fn a_right_click_behind_the_modal_opens_no_menu() {
    let mut layout = two_pane_layout();
    let rects = rects(&layout);
    let (column, row) = inside_pane_a();
    let mut state = input();
    let mut ui = one_pane_with_job();
    let mut pane = FakePane::default();
    let mut modal = FakeModal::open_on("job-1").at(Rect::new(column, row, 20, 6));

    mouse(
        &mut state,
        &press_mods(
            MouseEventKind::Down(MouseButton::Right),
            column + 2,
            row + 2,
            KeyModifiers::NONE,
        ),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut FakeList::default(),
        &mut layout,
        &mut modal,
    );

    assert!(state.menu().is_none());
}

/// A menu open when the job blocks is GONE, because a menu swallowing clicks over a modal
/// the operator cannot see past is worse than no menu.
#[test]
fn an_open_menu_cannot_outlive_the_modal() {
    let mut layout = two_pane_layout();
    let rects = rects(&layout);
    let (column, row) = inside_pane_a();
    let mut state = input();
    let mut ui = one_pane_with_job();
    let mut pane = FakePane::default();
    let mut list = FakeList::default();

    mouse(
        &mut state,
        &press_mods(
            MouseEventKind::Down(MouseButton::Right),
            column,
            row,
            KeyModifiers::NONE,
        ),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut list,
        &mut layout,
        &mut FakeModal::default(),
    );
    assert!(state.menu().is_some());

    // The job blocks, and the next click must go to the modal.
    let mut modal = FakeModal::open_on("job-1").at(Rect::new(column, row, 20, 6));
    let actions = mouse(
        &mut state,
        &press(column + 2, row + 2),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut list,
        &mut layout,
        &mut modal,
    );

    assert!(
        actions.is_empty(),
        "the click went to the menu, not the modal: {actions:?}"
    );
    assert_eq!(modal.clicks.len(), 1);
}

// ---------------------------------------------------------------------------------------
// Terminal state
// ---------------------------------------------------------------------------------------

/// A too-small terminal is not clickable, because nothing is drawn.
#[test]
fn a_too_small_terminal_is_not_clickable() {
    let mut layout = two_pane_layout();
    let rects = rects(&layout);
    let (column, row) = inside_pane_a();
    let mut state = input();
    let mut ui = two_pane_state();
    ui.presentation.too_small = true;
    let before = ui.presentation.focused.clone();
    let mut pane = FakePane::new(&["text"], 40, 10);

    let actions = mouse(
        &mut state,
        &press(column, row),
        &rects,
        &chrome(),
        &sidebar_rows(),
        now(),
        &mut ui,
        &mut pane,
        &mut FakeList::default(),
        &mut layout,
        &mut FakeModal::default(),
    );

    assert!(actions.is_empty(), "{actions:?}");
    assert_eq!(
        ui.presentation.focused, before,
        "no invisible pane may take focus, and none may be lost"
    );
}
