//! Layout geometry tests.
//!
//! Every case here exists because the corresponding bug is invisible in a
//! screenshot and obvious in use. Border drift by one cell, a pane that vanishes
//! at an odd width, a seam that moves two panes at once — each renders as
//! something that looks almost right.

use aibr_tui::layout::chrome::{clamp_sidebar, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN};
use aibr_tui::layout::hit::{HitTarget, HitTest, SidebarRows};
use aibr_tui::layout::tile::{Axis, Focus, Node, TileLayout};
use aibr_tui::layout::{partition, ChromeRects, LayoutRects};
use ratatui::layout::Rect;

/// The rectangles pane interiors and borders together must tile the canvas.
///
/// This is the invariant that makes "no tearing" true rather than aspirational. If
/// the leaves plus the seams exactly tile the canvas, no cell is claimed twice and
/// no cell is left dark -- which is exactly the one-cell gap that appears at an odd
/// width and shimmers as the window resizes.
///
/// The check is per row and per column because a layout can satisfy the total area
/// while still misplacing a single seam.
#[test]
fn panes_and_borders_exactly_tile_the_canvas() {
    for width in [20u16, 21, 40, 79, 80, 120, 200] {
        for height in [6u16, 7, 9, 24, 60] {
            let canvas = Rect::new(0, 0, width, height);
            let rects = layout_for(&["a", "b", "c"]).compute(canvas);

            for column in 0..width {
                let mut owner: Option<String> = None;
                for row in 0..height {
                    let pane = rects
                        .panes
                        .values()
                        .find(|pane| inside(pane.area, column, row))
                        .map(|pane| pane.pane_id.clone());
                    let on_seam = rects
                        .borders
                        .iter()
                        .any(|border| inside(*border, column, row));

                    assert!(
                        pane.is_some() || on_seam,
                        "at {width}x{height}, cell ({column},{row}) belongs to nothing"
                    );
                    assert!(
                        !(pane.is_some() && on_seam),
                        "at {width}x{height}, cell ({column},{row}) is claimed by both a pane and a seam"
                    );

                    let occupant = pane.or_else(|| on_seam.then(|| "seam".to_owned()));

                    match (&owner, &occupant) {
                        (None, Some(who)) => owner = Some(who.clone()),
                        (Some(existing), Some(who)) => assert_eq!(
                            existing, who,
                            "at {width}x{height}, column {column} changes owner at row {row}: \
                             the split is not vertical-only"
                        ),
                        _ => {}
                    }
                }
            }
        }
    }
}

/// Whether `(column, row)` is inside `area`.
fn inside(area: Rect, column: u16, row: u16) -> bool {
    column >= area.x
        && column < area.x.saturating_add(area.width)
        && row >= area.y
        && row < area.y.saturating_add(area.height)
}

#[test]
fn no_two_panes_claim_the_same_cell() {
    let canvas = Rect::new(0, 0, 60, 24);
    let rects = layout_for(&["a", "b", "c", "d"]).compute(canvas);
    let panes: Vec<&aibr_tui::layout::PaneRect> = rects.panes.values().collect();

    for (index, left) in panes.iter().enumerate() {
        for right in panes.iter().skip(index + 1) {
            let overlap_x = left.area.x.max(right.area.x)
                < (left.area.x + left.area.width).min(right.area.x + right.area.width);
            let overlap_y = left.area.y.max(right.area.y)
                < (left.area.y + left.area.height).min(right.area.y + right.area.height);
            assert!(
                !(overlap_x && overlap_y),
                "{} and {} overlap at {left:?} / {right:?}",
                left.pane_id,
                right.pane_id
            );
        }
    }
}

#[test]
fn a_border_sits_exactly_in_the_gap_between_its_panes() {
    let rects = layout_for(&["a", "b"]).compute(Rect::new(0, 0, 21, 10));
    let a = rects.panes["a"].area;
    let b = rects.panes["b"].area;
    let seam = rects.borders[0];

    assert_eq!(a.x + a.width, seam.x, "the seam abuts A's right edge");
    assert_eq!(seam.x + seam.width, b.x, "the seam abuts B's left edge");
    assert_eq!(seam.width, 1);
}

#[test]
fn an_odd_width_splits_without_losing_a_cell() {
    // 21 with an even ratio: 10 + seam + 10. Rounding 0.5 * 20 must give 10, not
    // 9 -- the failure would be a one-cell gap at the seam that flickers as the
    // window resizes.
    let rects = layout_for(&["a", "b"]).compute(Rect::new(0, 0, 21, 10));
    assert_eq!(rects.panes["a"].area.width, 10);
    assert_eq!(rects.panes["b"].area.width, 10);
    assert_eq!(
        rects.panes["a"].area.x + rects.panes["a"].area.width + 1 + rects.panes["b"].area.width,
        21
    );
}

#[test]
fn nested_splits_keep_their_seams_aligned() {
    // A vertical split whose left child is itself a horizontal split. The child's
    // seams must start exactly at the parent's seam, not one cell beside it.
    let root = Node::split(
        Axis::Vertical,
        Node::split(Axis::Horizontal, Node::leaf("a"), Node::leaf("b")),
        Node::leaf("c"),
    );
    let layout = TileLayout {
        root,
        focused: Some("a".to_owned()),
        zoomed: None,
    };
    let rects = layout.compute(Rect::new(0, 0, 40, 21));

    assert_eq!(rects.panes["a"].area.x, rects.panes["b"].area.x);
    assert_eq!(rects.panes["a"].area.width, rects.panes["b"].area.width);
    let parent_seam = rects
        .borders
        .iter()
        .find(|border| border.y == 0 && border.height == canvas_height(21))
        .copied()
        .expect("the vertical split has a seam");
    assert_eq!(
        rects.panes["b"].area.x + rects.panes["b"].area.width,
        parent_seam.x,
        "the nested subtree ends exactly where the parent seam begins"
    );
    assert_eq!(parent_seam.x + 1, rects.panes["c"].area.x);
}

#[test]
fn a_canvas_too_narrow_to_split_collapses_instead_of_producing_a_zero_width_pane() {
    let rects = layout_for(&["a", "b"]).compute(Rect::new(0, 0, 1, 10));
    assert!(
        rects.panes.values().all(|pane| pane.area.width > 0),
        "a zero-width pane cannot be clicked or dragged back: {rects:?}"
    );
    assert!(rects.borders.is_empty(), "no seam fits in one column");
}

#[test]
fn closing_a_pane_gives_its_area_to_the_survivor() {
    let mut layout = layout_for(&["a", "b", "c"]);
    let before = layout.compute(Rect::new(0, 0, 60, 20));
    let total = before.canvas.width;

    layout.close("b");
    let after = layout.compute(Rect::new(0, 0, 60, 20));

    assert!(!after.panes.contains_key("b"));
    let occupied: u16 = after.panes.values().map(|pane| pane.area.width).sum();
    let seams: u16 = after.borders.iter().map(|border| border.width).sum();
    assert_eq!(
        occupied + seams,
        total,
        "the survivors and the remaining seam must still fill the canvas exactly"
    );
}

#[test]
fn closing_the_focused_pane_moves_focus_survivor_ward() {
    let mut layout = layout_for(&["a", "b", "c"]);
    layout.focused = Some("b".to_owned());
    layout.close("b");
    assert!(
        layout.focused.as_deref() != Some("b"),
        "focus left on a pane that is no longer in the tree would send every \
         keystroke to an id the daemon answers not_found"
    );
    assert!(layout.focused.is_some(), "focus must land somewhere");
}

#[test]
fn closing_a_zoomed_pane_clears_the_zoom() {
    let mut layout = layout_for(&["a", "b"]);
    layout.focused = Some("b".to_owned());
    layout.toggle_zoom();
    assert_eq!(layout.zoomed.as_deref(), Some("b"));
    layout.close("b");
    assert_eq!(layout.zoomed, None);
}

#[test]
fn a_zoomed_pane_takes_the_whole_canvas_and_releases_cleanly() {
    let canvas = Rect::new(0, 0, 80, 24);
    let mut layout = layout_for(&["a", "b", "c"]);
    layout.focused = Some("b".to_owned());
    layout.toggle_zoom();

    let zoomed = layout.compute(canvas);
    assert_eq!(zoomed.panes["b"].area, canvas);

    layout.toggle_zoom();
    let released = layout.compute(canvas);
    assert!(released.panes.contains_key("a"), "the sibling comes back");
    assert!(
        released.panes["b"].area.width < canvas.width,
        "the zoom was released, so b must be back in the tiled arrangement"
    );
    let occupied: u16 = released.panes.values().map(|pane| pane.area.width).sum();
    let seams: u16 = released.borders.iter().map(|border| border.width).sum();
    assert_eq!(
        occupied + seams,
        canvas.width,
        "and the tiling must still be exact"
    );
}

#[test]
fn a_dragged_ratio_never_collapses_either_pane() {
    let mut layout = layout_for(&["a", "b"]);
    for attempted in [0.0, 0.001, 0.5, 0.999, 1.0, -5.0, 42.0] {
        layout.set_ratio(Axis::Vertical, 60, attempted);
        let rects = layout.compute(Rect::new(0, 0, 60, 20));
        assert!(
            rects.panes.values().all(|pane| pane.area.width >= 1),
            "at ratio {attempted}, a pane collapsed: {rects:?}"
        );
    }
}

#[test]
fn a_dragged_ratio_lands_on_whole_cells() {
    // The operator drags to a pixel position; the border must land on a character
    // boundary, never between two, or the seam renders as half a glyph and the
    // whole layout shimmers.
    let mut layout = layout_for(&["a", "b"]);
    for step in 0..=59u16 {
        layout.set_ratio(Axis::Vertical, 60, f64::from(step) / 59.0);
        let rects = layout.compute(Rect::new(0, 0, 60, 20));
        let seam = rects.borders[0];
        let a = rects.panes["a"].area;
        assert_eq!(
            a.x + a.width,
            seam.x,
            "the seam left the cell boundary at step {step}"
        );
    }
}

#[test]
fn cardinal_focus_moves_in_the_direction_named() {
    let canvas = Rect::new(0, 0, 61, 21);
    let mut layout = layout_for(&["a", "b", "c"]);

    layout.focused = Some("a".to_owned());
    layout.focus(Focus::Right, canvas);
    assert_eq!(layout.focused.as_deref(), Some("b"));

    layout.focus(Focus::Left, canvas);
    assert_eq!(layout.focused.as_deref(), Some("a"));

    // At the left edge, `Left` must be a no-op rather than wrapping.
    layout.focus(Focus::Left, canvas);
    assert_eq!(layout.focused.as_deref(), Some("a"));
}

#[test]
fn focus_clamps_at_the_ends_rather_than_wrapping() {
    let canvas = Rect::new(0, 0, 61, 21);
    let mut layout = layout_for(&["a", "b"]);
    layout.focused = Some("a".to_owned());
    layout.focus(Focus::Previous, canvas);
    assert_eq!(layout.focused.as_deref(), Some("a"));
}

/// A layout with evenly split panes.
fn layout_for(ids: &[&str]) -> TileLayout {
    let owned: Vec<String> = ids.iter().map(|id| (*id).to_owned()).collect();
    TileLayout::from_panes(&owned)
}

#[test]
fn chrome_takes_two_rows_and_leaves_the_rest_for_panes() {
    let chrome = partition(Rect::new(0, 0, 100, 30), Some(SIDEBAR_DEFAULT));
    assert_eq!(chrome.top_bar.height, 1);
    assert_eq!(chrome.status_bar.height, 1);
    assert_eq!(chrome.canvas.height, 28);
    assert_eq!(chrome.canvas.x, SIDEBAR_DEFAULT);
    assert_eq!(chrome.canvas.width, 100 - SIDEBAR_DEFAULT);
}

#[test]
fn a_terminal_with_no_room_for_chrome_yields_an_empty_canvas() {
    // One row cannot hold a top bar, a body, and a status bar. The honest result
    // is an empty canvas the shell reports as "too small", not a wrapped height
    // that makes every subsequent subtraction wrong.
    let chrome = partition(Rect::new(0, 0, 80, 1), None);
    assert_eq!(chrome.canvas.height, 0);
    assert!(!chrome.canvas_is_drawable());
}

#[test]
fn the_sidebar_is_dropped_rather_than_starving_the_canvas() {
    // 40 columns minus a 24-column sidebar is 16, below MIN_CANVAS_COLUMNS.
    let chrome = partition(Rect::new(0, 0, 40, 20), Some(SIDEBAR_DEFAULT));
    assert!(
        chrome.sidebar.is_none(),
        "a 40-column terminal cannot afford a 24-column sidebar beside a usable canvas"
    );
    assert_eq!(chrome.canvas.width, 40);
}

#[test]
fn the_sidebar_width_is_clamped_to_what_the_terminal_can_afford() {
    assert_eq!(clamp_sidebar(8, 200), SIDEBAR_MIN);
    assert_eq!(clamp_sidebar(100, 200), SIDEBAR_MAX);
    assert_eq!(clamp_sidebar(SIDEBAR_MIN, 200), SIDEBAR_MIN);
    assert!(clamp_sidebar(SIDEBAR_MAX, 60) <= 60);
}

#[test]
fn a_click_inside_a_pane_focuses_that_pane() {
    // Lay out into the SAME rect the chrome hands the canvas. Computing the layout
    // against a different rect is precisely the bug this module exists to prevent,
    // so the test uses the real one rather than a convenient one.
    let chrome = partition(Rect::new(0, 0, 80, 24), Some(SIDEBAR_DEFAULT));
    let canvas = chrome.canvas;
    let rects = layout_for(&["a", "b"]).compute(canvas);
    let sidebar = sidebar_at(&chrome);

    let target = HitTest::hit(canvas.x + 5, canvas.y + 5, &rects, &chrome, &sidebar);
    assert_eq!(
        target,
        HitTarget::Pane {
            pane_id: "a".to_owned()
        }
    );
}

#[test]
fn a_click_on_the_header_hits_the_header() {
    let rects = layout_for(&["a"]).compute(Rect::new(30, 2, 50, 20));
    let chrome = partition(Rect::new(0, 0, 80, 24), None);
    assert_eq!(
        HitTest::hit(40, 0, &rects, &chrome, &SidebarRows::default()),
        HitTarget::TopBar
    );
    assert_eq!(
        HitTest::hit(40, 23, &rects, &chrome, &SidebarRows::default()),
        HitTarget::StatusBar
    );
}

#[test]
fn a_click_near_a_seam_hits_the_border_so_a_drag_can_start() {
    let canvas = Rect::new(30, 2, 50, 20);
    let rects = layout_for(&["a", "b"]).compute(canvas);
    let chrome = partition(Rect::new(0, 0, 80, 24), None);
    let seam = rects.borders[0];

    // Two cells to the left of the seam: inside pane A, but within tolerance.
    let target = HitTest::hit(
        seam.x - 2,
        seam.y + 5,
        &rects,
        &chrome,
        &SidebarRows::default(),
    );
    assert!(
        matches!(target, HitTarget::Border { .. }),
        "a click within tolerance of a seam must start a resize, got {target:?}"
    );

    // Well inside pane A, past the tolerance.
    let target = HitTest::hit(
        seam.x - 8,
        seam.y + 5,
        &rects,
        &chrome,
        &SidebarRows::default(),
    );
    assert_eq!(
        target,
        HitTarget::Pane {
            pane_id: "a".to_owned()
        },
        "a click well inside a pane must focus it, not grab a border"
    );
}

#[test]
fn a_hit_border_names_both_panes_and_its_axis() {
    let canvas = Rect::new(30, 2, 50, 20);
    let rects = layout_for(&["a", "b"]).compute(canvas);
    let chrome = partition(Rect::new(0, 0, 80, 24), None);
    let seam = rects.borders[0];

    match HitTest::hit(seam.x, seam.y + 3, &rects, &chrome, &SidebarRows::default()) {
        HitTarget::Border {
            axis,
            first_pane,
            second_pane,
            extent,
        } => {
            assert_eq!(axis, Axis::Vertical);
            assert_eq!(first_pane, "a");
            assert_eq!(second_pane, "b");
            assert_eq!(extent, canvas.height);
        }
        other => panic!("expected a border, got {other:?}"),
    }
}

#[test]
fn a_zoomed_layout_hits_the_zoomed_pane_anywhere_in_the_canvas() {
    let canvas = Rect::new(30, 2, 50, 20);
    let mut layout = layout_for(&["a", "b"]);
    layout.focused = Some("b".to_owned());
    layout.toggle_zoom();
    let rects = layout.compute(canvas);
    let chrome = partition(Rect::new(0, 0, 80, 24), None);

    let target = HitTest::hit(
        canvas.x + 2,
        canvas.y + 2,
        &rects,
        &chrome,
        &SidebarRows::default(),
    );
    assert_eq!(
        target,
        HitTarget::Pane {
            pane_id: "b".to_owned()
        },
        "while zoomed, the zoomed pane covers the canvas and must swallow every click"
    );
}

#[test]
fn a_sidebar_row_resolves_to_its_id() {
    let chrome = partition(Rect::new(0, 0, 80, 24), Some(SIDEBAR_DEFAULT));
    let rows = sidebar_at(&chrome);
    let first = rows.entries[0].0;

    let rects = layout_for(&["a"]).compute(chrome.canvas);
    assert_eq!(
        HitTest::hit(first.x, first.y, &rects, &chrome, &rows),
        rows.entries[0].1
    );
}

#[test]
fn sidebar_background_resolves_to_the_sidebar_not_a_row() {
    let chrome = partition(Rect::new(0, 0, 80, 24), Some(SIDEBAR_DEFAULT));
    let rects = layout_for(&["a"]).compute(chrome.canvas);
    let rows = SidebarRows::default();

    // Inside the sidebar, past the last row (there are none): the sidebar itself,
    // not a row and not the canvas.
    let target = HitTest::hit(2, chrome.canvas.y + 3, &rects, &chrome, &rows);
    assert_eq!(target, HitTarget::Sidebar);
}

#[test]
fn a_coordinate_outside_every_region_is_none() {
    // A rect set from a frame that no longer matches the chrome -- a stale layout
    // left over after a resize. Hit-testing must report "nothing here" rather than
    // guessing, because a wrong guess is a click the operator believes did
    // something.
    let chrome = partition(Rect::new(0, 0, 40, 24), None);
    let stale = layout_for(&["a"]).compute(Rect::new(0, 0, 10, 5));
    assert_eq!(
        HitTest::hit(30, 20, &stale, &chrome, &SidebarRows::default()),
        HitTarget::None,
        "a coordinate in neither the stale canvas nor the chrome must be None"
    );
}

/// A sidebar with one workspace row and one job row, as the render pass would.
fn sidebar_at(chrome: &ChromeRects) -> SidebarRows {
    let Some(sidebar) = chrome.sidebar else {
        return SidebarRows::default();
    };
    SidebarRows {
        entries: vec![
            (
                Rect::new(sidebar.x, sidebar.y, sidebar.width, 1),
                HitTarget::SidebarWorkspace {
                    workspace_id: "ws-1".to_owned(),
                },
            ),
            (
                Rect::new(sidebar.x, sidebar.y + 1, sidebar.width, 1),
                HitTarget::SidebarJob {
                    job_id: "job-1".to_owned(),
                },
            ),
        ],
    }
}

#[test]
fn a_layout_with_no_panes_computes_nothing_rather_than_panicking() {
    let layout = TileLayout::from_panes(&[]);
    let rects = layout.compute(Rect::new(0, 0, 80, 24));
    assert!(matches!(rects, LayoutRects { .. }));
    assert_eq!(
        layout.pane_ids().len(),
        1,
        "the empty placeholder leaf remains"
    );
}
/// The canvas height the nested-split test builds against.
fn canvas_height(height: u16) -> u16 {
    height
}
