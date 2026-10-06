//! Hit-test routing: one mouse event in, [`Action`]s out.
//!
//! # THE GEOMETRY IS AN ARGUMENT, NOT A LOOKUP
//!
//! [`mouse`] takes the [`LayoutRects`], [`ChromeRects`] and [`SidebarRows`] the render
//! pass used and calls [`HitTest::hit`] on them. It derives no rectangle of its own, and
//! it cannot: there is no code in this module that computes where a pane is. A second,
//! parallel notion of the layout would drift from the pixels the first time a rounding
//! rule or a minimum-size clamp differed, and the symptom is an operator clicking a
//! border and getting a focus change. Criterion 5's tearing.
//!
//! # EVERY EVENT IS CLASSIFIED BEFORE IT IS ACTED ON
//!
//! [`HitTest::hit`] runs first, for every event including the ones that do nothing, and
//! the RESULT -- not the coordinate -- decides what happens. The alternative, and the one
//! that produces the bugs this module exists to prevent, is to ask "is this coordinate in
//! the sidebar?" inline and forget the status bar, so a click on the mode indicator
//! toggles a pane.

use std::time::Instant;

use crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};

use crate::input::action::{Action, Toast};
use crate::input::commands;
use crate::input::engine::{modal_actions, BorderDrag, InputState, PointerDrag};
use crate::input::menu::{ContextMenu, MenuItem};
use crate::input::redact::redact_to_text;
use crate::input::sanitize::{sanitize_url, UrlRejection};
use crate::input::selection::{to_content, Selection};
use crate::input::traits::{ApprovalModal, ModalOutcome, ScrollbackPane, SidebarList};
use crate::input::tree::{ratio_for_drag, PaneLayout};
use crate::layout::hit::SidebarRows;
use crate::layout::{Axis, ChromeRects, HitTarget, HitTest, LayoutRects};
use crate::state::{InputMode, UiState};

/// Lines scrolled per wheel notch.
///
/// Three is the value that makes a wheel feel like a scrollbar: one line per notch needs
/// eight notches to cross a pane, which is slow, and ten scrolls the whole pane away in
/// one gesture. Fixed rather than configurable, because a configurable scroll rate is a
/// setting nobody changes and everybody notices is wrong on someone else's screen.
pub const WHEEL_LINES: i16 = 3;

/// Reduce one mouse event.
///
/// # Order of operations
///
/// 1. **Modal interception.** A `blocked` job is a security decision, and a stray click
///    meant for the terminal behind it must not reach that terminal. This precedes
///    everything, including the context menu: a menu opened before a job blocked would
///    otherwise still be open, still visible, and still swallowing clicks after the modal
///    appeared on top of it.
/// 2. **A too-small terminal.** Nothing is drawn, so nothing is clickable, and a click
///    that fell through to a pane would focus a pane that is not on screen.
/// 3. **The open context menu.** It intercepts clicks on its own items and is dismissed
///    by a click outside them, after which the click is routed normally -- one click
///    closes the menu and focuses what is underneath, rather than costing two.
/// 4. **Classification**, then routing.
///
/// # Parameters
///
/// * `rects`, `chrome`, `rows` -- the geometry the render pass used, unchanged.
/// * `panes` -- the VT grids, for selection extraction and link lookup.
/// * `list` -- the sidebar list, for wheel scrolling.
/// * `layout` -- the pane tree, for focus and for the drag ratio.
/// * `modal` -- the approval modal.
#[allow(clippy::too_many_arguments)]
pub fn mouse(
    state: &mut InputState,
    event: &MouseEvent,
    rects: &LayoutRects,
    chrome: &ChromeRects,
    rows: &SidebarRows,
    now: Instant,
    ui: &mut UiState,
    panes: &mut dyn ScrollbackPane,
    list: &mut dyn SidebarList,
    layout: &mut dyn PaneLayout,
    modal: &mut dyn ApprovalModal,
) -> Vec<Action> {
    // (1) The modal takes every event, including the ones with no meaning behind it.
    if modal.is_open() {
        return route_mouse_to_modal(state, event, now, modal);
    }

    // (2) Nothing is drawn, so nothing is clickable.
    if ui.presentation.too_small || !chrome.canvas_is_drawable() {
        return Vec::new();
    }

    let target = HitTest::hit(event.column, event.row, rects, chrome, rows);
    let control = event.modifiers.contains(KeyModifiers::CONTROL);

    // (3) An open menu.
    if state.menu.is_some() {
        if clicked_menu(state, event) {
            return menu_click(state, event, now, ui, panes, layout);
        }
        dismiss_menu(state);
    }

    match event.kind {
        MouseEventKind::Down(MouseButton::Left) => match &target {
            // A seam begins a resize drag. Matched before "focus the pane" because
            // `HitTest` deliberately gives a near-seam cell to the seam with a two-cell
            // tolerance, and the panes either side of it are legitimate click targets
            // that the tolerance has already claimed.
            HitTarget::Border {
                axis,
                first_pane,
                second_pane,
                ..
            } => begin_border_drag(state, ui, first_pane, second_pane, *axis),
            HitTarget::Pane { pane_id } if control => {
                open_link(state, now, panes, rects, pane_id, event.column, event.row)
            }
            HitTarget::Pane { pane_id } => {
                state.button_down = true;
                let mut actions = focus_pane(ui, layout, pane_id);
                actions.extend(begin_selection(state, rects, event, pane_id));
                actions
            }
            HitTarget::SidebarWorkspace { workspace_id } => {
                set_workspace(state, now, ui, workspace_id)
            }
            HitTarget::SidebarJob { job_id } => focus_job(ui, layout, job_id),
            // A queue row opens on RIGHT click, where the plan puts the menu; a left
            // click on it is a no-op rather than a guess.
            HitTarget::SidebarQueueItem { .. }
            | HitTarget::TopBar
            | HitTarget::StatusBar
            | HitTarget::Sidebar
            | HitTarget::Canvas
            | HitTarget::None => Vec::new(),
        },

        // `Ctrl` IS CHECKED BEFORE THE RIGHT BUTTON IS CONSIDERED. Some terminals report
        // `Ctrl+LeftClick` as a right click -- crossterm documents this for macOS -- and
        // the operator wanted to open a link. Preferring the link when `Ctrl` is held makes
        // both work on a terminal that distinguishes them, and makes the link work on one
        // that does not. The consequence is that on such a terminal `Ctrl+RightClick`
        // opens a link instead of a menu, which is the lesser surprise.
        MouseEventKind::Down(MouseButton::Right) => {
            if control {
                if let HitTarget::Pane { pane_id } = &target {
                    return open_link(state, now, panes, rects, pane_id, event.column, event.row);
                }
            }
            state.menu = ContextMenu::open((event.column, event.row), &target);
            Vec::new()
        }
        MouseEventKind::Down(MouseButton::Middle) => Vec::new(),

        MouseEventKind::Drag(MouseButton::Left) => match state.drag.clone() {
            Some(PointerDrag::Border(drag)) => {
                drag_border(state, rects, layout, &drag, event.column, event.row)
            }
            Some(PointerDrag::Selecting) => {
                extend_selection(state, rects, event);
                Vec::new()
            }
            None => Vec::new(),
        },
        MouseEventKind::Drag(_) => Vec::new(),

        MouseEventKind::Up(MouseButton::Left) => {
            state.button_down = false;
            match state.drag.take() {
                Some(PointerDrag::Border(drag)) => {
                    state.enter(&mut ui.presentation, InputMode::Terminal);
                    end_border_drag(state, now, rects, layout, &drag, event.column, event.row)
                }
                Some(PointerDrag::Selecting) => end_selection(state, now, panes),
                None => Vec::new(),
            }
        }
        MouseEventKind::Up(_) => Vec::new(),

        MouseEventKind::ScrollUp => wheel(state, &target, ui, panes, list, WHEEL_LINES),
        MouseEventKind::ScrollDown => wheel(state, &target, ui, panes, list, -WHEEL_LINES),
        // Horizontal wheel: nothing scrolls horizontally in a terminal, and treating it as
        // a vertical scroll would move the pane under the operator on a two-finger
        // trackpad swipe sideways.
        MouseEventKind::ScrollLeft | MouseEventKind::ScrollRight => Vec::new(),
        // Motion with no button. Deliberately nothing: there is no hover state to update,
        // and a redraw per mouse motion is the churn that 1003 was dropped for.
        MouseEventKind::Moved => Vec::new(),
    }
}

/// Begin a resize drag on a seam.
fn begin_border_drag(
    state: &mut InputState,
    ui: &mut UiState,
    first_pane: &str,
    second_pane: &str,
    axis: Axis,
) -> Vec<Action> {
    state.drag = Some(PointerDrag::Border(BorderDrag {
        first_pane: first_pane.to_owned(),
        second_pane: second_pane.to_owned(),
        axis,
    }));
    state.enter(&mut ui.presentation, InputMode::Navigate);
    Vec::new()
}

/// Adjust the ratio while the drag is in progress.
///
/// THE SNAP IS THE WHOLE POINT. The ratio comes from the cursor's CELL, so the value is
/// always one the renderer can draw exactly: `split_parts` multiplies by the same span and
/// rounds, landing the seam on the cell the operator is holding. A ratio from a float pixel
/// delta would round to a neighbouring cell and the seam would lag the cursor.
fn drag_border(
    state: &mut InputState,
    rects: &LayoutRects,
    layout: &mut dyn PaneLayout,
    drag: &BorderDrag,
    column: u16,
    row: u16,
) -> Vec<Action> {
    let _ = state;
    apply_ratio(rects, layout, drag, cursor_cell(drag.axis, column, row))
}

/// Finish a resize drag: the final ratio, plus the new pane sizes for the daemon.
///
/// THE DAEMON IS TOLD ONCE, ON RELEASE. A `resize_pane` per motion event would mean sixty
/// commands a second per drag, each making the agent's line editor redraw -- so the agent
/// would reflow continuously while the operator is still moving, and the scrollback would
/// fill with the reflow. The client's own seam follows the cursor immediately from the
/// ratio applied during [`drag_border`], which is what makes the drag feel smooth; the
/// daemon learns the final geometry once.
fn end_border_drag(
    state: &mut InputState,
    now: Instant,
    rects: &LayoutRects,
    layout: &mut dyn PaneLayout,
    drag: &BorderDrag,
    column: u16,
    row: u16,
) -> Vec<Action> {
    let BorderDrag {
        first_pane,
        second_pane,
        axis,
    } = drag;
    let mut actions = apply_ratio(rects, layout, drag, cursor_cell(*axis, column, row));

    // Only the two panes either side of the seam change size. A seam in this layout always
    // separates two leaves -- `HitTarget::Border` resolves it that way -- so there is no
    // subtree to walk, and resizing anything else would move a pane the operator is not
    // looking at.
    //
    // The new sizes are the old ones plus the seam's displacement, which is exact rather
    // than re-derived: the layout has just told us the ratio it stored, and the first
    // child's width is `round((span - 1) * ratio)`. Anything else would be a second
    // computation of the layout's arithmetic.
    let Some(applied) = actions.first().and_then(|action| match action {
        Action::SetSplitRatio { ratio, .. } => Some(*ratio),
        _ => None,
    }) else {
        return actions;
    };
    let _ = (state, now);
    let (Some(first), Some(second)) = (rects.panes.get(first_pane), rects.panes.get(second_pane))
    else {
        return actions;
    };
    let span = u32::from(second.area.x + second.area.width) - u32::from(first.area.x);
    let available = span.saturating_sub(1);
    // `rects` is one frame behind the live preview, so measuring the span from it
    // yields a denominator one cell short of the one the stored ratio was computed
    // against, and the reported sizes land one cell off the seam the operator is
    // looking at. The canvas extent does not move while a drag is in progress, so it
    // is the stable denominator — used only when this pair really does span it,
    // which is the case for a top-level seam and not for one inside a subtree.
    let available = if first.area.x == rects.canvas.x
        && second.area.x.saturating_add(second.area.width)
            == rects.canvas.x.saturating_add(rects.canvas.width)
    {
        u32::from(rects.canvas.width).saturating_sub(1)
    } else {
        available
    };
    if available == 0 {
        return actions;
    }
    let new_first = ((f64::from(available) * applied).round() as u32).min(available);
    // NO `moved == 0` EARLY RETURN, and its absence is the fix.
    //
    // The drag preview applies the ratio LIVE, so by the time the button comes up
    // `rects` already reflects the new sizes and `moved` computes as zero. An early
    // return there therefore suppressed the report on *every* drag: the seam moved
    // on screen, the operator saw it move, and the daemon was never told — which
    // looks like the agent ignoring the resize.
    //
    // The sizes below are computed from the ratio and the span, not from `rects`, so
    // the first report the daemon receives is correct even when it is one frame
    // behind the seam.
    let (first_columns, first_rows) = shift_to(first, *axis, new_first as i64);
    // The second pane gets what is LEFT, not a delta. Passing
    // `new_first - available` here clamped every pane to one column, because a
    // delta is meaningless to a function that sets an absolute size.
    let (second_columns, second_rows) =
        shift_to(second, *axis, i64::from(available) - i64::from(new_first));
    actions.push(Action::PaneResized {
        pane_id: first_pane.to_owned(),
        columns: first_columns,
        rows: first_rows,
    });
    actions.push(Action::PaneResized {
        pane_id: second_pane.to_owned(),
        columns: second_columns,
        rows: second_rows,
    });
    actions
}

/// A pane's `(columns, rows)` with its size along `axis` set to `new_size`.
///
/// ONE CELL MINIMUM, which is what the layout's own clamp exists to prevent: a pane
/// with zero columns cannot be drawn, clicked, scrolled or dragged back, and the
/// operator would have to detach and re-attach to recover.
///
/// Setting the size outright rather than shifting by a delta matters because the live
/// drag preview has already moved the seam by the time this runs, so a delta computed
/// against the drawn rects is zero even when the seam moved twenty cells.
fn shift_to(pane: &crate::layout::PaneRect, axis: Axis, new_size: i64) -> (u16, u16) {
    let clamped = new_size.clamp(1, i64::from(u16::MAX)) as u16;
    match axis {
        Axis::Vertical => (clamped, pane.area.height),
        Axis::Horizontal => (pane.area.width, clamped),
    }
}

/// A pane's `(columns, rows)` after the seam beside it moved by `delta` cells.
///
/// No longer called -- `end_border_drag` uses [`shift_to`] -- but kept because it is
/// the clearest statement of the floor, and deleting the only other caller of it
/// would leave that rule asserted nowhere.
#[allow(dead_code)]
fn shift(pane: &crate::layout::PaneRect, axis: Axis, delta: i64) -> (u16, u16) {
    let (columns, rows) = match axis {
        Axis::Vertical => (
            (i64::from(pane.area.width) + delta).clamp(1, i64::from(u16::MAX)) as u16,
            pane.area.height,
        ),
        Axis::Horizontal => (
            pane.area.width,
            (i64::from(pane.area.height) + delta).clamp(1, i64::from(u16::MAX)) as u16,
        ),
    };
    (columns, rows)
}

/// Compute and apply the ratio for a seam at `cell`.
fn apply_ratio(
    rects: &LayoutRects,
    layout: &mut dyn PaneLayout,
    drag: &BorderDrag,
    cell: u16,
) -> Vec<Action> {
    let BorderDrag {
        first_pane,
        second_pane,
        axis,
    } = drag;
    let Some(geometry) = ratio_for_drag(rects, first_pane, second_pane, *axis, cell) else {
        // A stale hit: the pane closed between the frame being drawn and the click
        // arriving. There is nothing left to resize, and inventing a span would resize
        // whatever happened to be there instead.
        return Vec::new();
    };
    match layout.apply_ratio(*axis, geometry.available, geometry.ratio) {
        // The CLAMPED ratio, not the requested one. They differ at the ends of the range,
        // which is exactly where an operator is watching, and reporting the requested
        // value would let the status bar disagree with the seam on screen.
        Some(applied) => vec![Action::SetSplitRatio {
            axis: *axis,
            first_pane: first_pane.to_owned(),
            second_pane: second_pane.to_owned(),
            ratio: applied,
        }],
        None => Vec::new(),
    }
}

/// The cell along a seam's axis, from a screen coordinate.
fn cursor_cell(axis: Axis, column: u16, row: u16) -> u16 {
    match axis {
        Axis::Vertical => column,
        Axis::Horizontal => row,
    }
}

/// Focus a pane.
fn focus_pane(ui: &mut UiState, layout: &mut dyn PaneLayout, pane_id: &str) -> Vec<Action> {
    if layout.focused().as_deref() == Some(pane_id) {
        return Vec::new();
    }
    layout.set_focused(Some(pane_id.to_owned()));
    ui.presentation.focused = Some(pane_id.to_owned());
    vec![Action::FocusPane {
        pane_id: pane_id.to_owned(),
    }]
}

/// Anchor a selection at the pressed cell.
fn begin_selection(
    state: &mut InputState,
    rects: &LayoutRects,
    event: &MouseEvent,
    pane_id: &str,
) -> Vec<Action> {
    let Some(pane) = rects.panes.get(pane_id) else {
        return Vec::new();
    };
    // The cell must be inside the pane's content area. `HitTest` already guarantees that
    // for a `Pane` target, and the guard is here so a future caller of this function cannot
    // anchor a selection to a seam cell and extract a line that is one cell off.
    let Some(cell) = to_content(pane.area, event.column, event.row) else {
        return Vec::new();
    };
    state.drag = Some(PointerDrag::Selecting);
    state.selection = Some(Selection::new(pane_id, cell, cell));
    Vec::new()
}

/// Move the selection's cursor while dragging.
///
/// A drag that leaves the pane CLAMPS to the edge rather than being dropped.
fn extend_selection(state: &mut InputState, rects: &LayoutRects, event: &MouseEvent) {
    let Some(selection) = state.selection.clone() else {
        return;
    };
    let Some(pane) = rects.panes.get(&selection.pane_id) else {
        return;
    };
    let area = pane.area;
    if area.width == 0 || area.height == 0 {
        return;
    }
    // Clamp rather than drop: an operator dragging to the last cell and overshooting by a
    // pixel should select the last cell, not have the selection collapse.
    let column = event.column.clamp(area.x, area.x + area.width - 1);
    let row = event.row.clamp(area.y, area.y + area.height - 1);
    let Some(cell) = to_content(area, column, row) else {
        return;
    };
    state.selection = Some(Selection::new(&selection.pane_id, selection.anchor, cell));
}

/// Finish a selection: extract, redact, and ask for a clipboard write.
fn end_selection(state: &mut InputState, now: Instant, panes: &dyn ScrollbackPane) -> Vec<Action> {
    let Some(selection) = state.selection.take() else {
        return Vec::new();
    };
    // A click with no drag is not a selection. Copying the single cell under the cursor
    // would overwrite the operator's clipboard every time they clicked to focus a pane,
    // which is data loss dressed as a feature.
    if !selection.is_extent() {
        return Vec::new();
    }
    let text = selection.extract(panes);
    if text.trim().is_empty() {
        return Vec::new();
    }
    vec![
        Action::CopySelection(redact_to_text(
            &crate::input::redact::ConservativeRedactor,
            &text,
        )),
        state.raise_toast(now, Toast::info("Copied to clipboard")),
    ]
}

/// Make a workspace active, locally and on the daemon.
fn set_workspace(
    state: &mut InputState,
    now: Instant,
    ui: &mut UiState,
    workspace_id: &str,
) -> Vec<Action> {
    if ui.presentation.active_workspace.as_deref() == Some(workspace_id) {
        return Vec::new();
    }
    ui.presentation.active_workspace = Some(workspace_id.to_owned());
    let mut actions = vec![Action::SetActiveWorkspace {
        workspace_id: workspace_id.to_owned(),
    }];
    match commands::set_active_workspace(workspace_id) {
        Ok(command) => actions.insert(0, Action::Command(command)),
        // The workspace is activated LOCALLY even when the daemon refused the id, because
        // the operator clicked a row the render pass drew from a snapshot the daemon sent.
        // Refusing to follow their click would look like the client ignoring them.
        Err(error) => actions.push(state.raise_toast(now, Toast::warning(error.to_string()))),
    }
    actions
}

/// Focus the pane showing a sidebar job.
///
/// A job with no pane yet focuses nothing and says nothing: a job is created before its
/// pane exists, and a toast on every click during that window would be noise for a state
/// that resolves in one frame.
fn focus_job(ui: &mut UiState, layout: &mut dyn PaneLayout, job_id: &str) -> Vec<Action> {
    let Some(pane_id) = ui
        .world
        .panes
        .values()
        .find(|pane| pane.job_id.as_deref() == Some(job_id))
        .map(|pane| pane.id.clone())
    else {
        return Vec::new();
    };
    layout.set_focused(Some(pane_id.clone()));
    ui.presentation.focused = Some(pane_id.clone());
    vec![Action::FocusPane { pane_id }]
}

/// Open the OSC 8 hyperlink under a `Ctrl+Click`.
///
/// THE SANITISER IS NOT OPTIONAL AND NOT THE IMPLEMENTATION'S JOB. A hyperlink here came
/// from a pane's output, which came from an agent, which came from a peer. A client that
/// handed `file:///…` or `javascript:` to the operating system's URL handler would be an
/// arbitrary-command-execution primitive reachable by anyone who can get text into a pane.
/// [`sanitize_url`] is the only thing that may produce the value this emits, and
/// [`crate::input::UrlOpener`] takes a type it alone can construct.
fn open_link(
    state: &mut InputState,
    now: Instant,
    panes: &dyn ScrollbackPane,
    rects: &LayoutRects,
    pane_id: &str,
    column: u16,
    row: u16,
) -> Vec<Action> {
    if !rects.panes.contains_key(pane_id) {
        return Vec::new();
    }
    // PANE-CONTENT COORDINATES, because the grid's row 0 is the first line it shows and it
    // does not know -- and must not know -- where it is drawn. Passing terminal coordinates
    // would make it depend on the render pass, which is the coupling the layout crate's
    // module header exists to prevent.
    let pane = rects.panes.get(pane_id).expect("checked by the caller");
    let Some(cell) = to_content(pane.area, column, row) else {
        return Vec::new();
    };
    let Some(raw) = panes.hyperlink_at(pane_id, cell.column, cell.row) else {
        return Vec::new();
    };
    match sanitize_url(&raw) {
        Ok(url) => vec![Action::OpenLink(url)],
        Err(rejection) => {
            vec![state.raise_toast(now, Toast::warning(refusal_message(&rejection)))]
        }
    }
}

/// The operator-facing reason a link was refused.
///
/// NAMES THE SCHEME, which is the answer the operator needs: "that link was refused" is
/// useless when the actual problem is that a peer's output used `file:`.
fn refusal_message(rejection: &UrlRejection) -> String {
    match rejection {
        UrlRejection::SchemeNotAllowed(scheme) => {
            format!("refusing to open a `{scheme}` URL: only http and https are allowed")
        }
        UrlRejection::ControlCharacter => {
            "refusing to open a URL containing a control character".to_owned()
        }
        UrlRejection::Backslash => "refusing to open a URL containing a backslash".to_owned(),
        UrlRejection::NoScheme | UrlRejection::MalformedScheme => {
            "refusing to open a URL with no valid scheme".to_owned()
        }
        UrlRejection::NotHierarchical | UrlRejection::NoAuthority => {
            "refusing to open a URL with no host".to_owned()
        }
        UrlRejection::Empty => "refusing to open an empty URL".to_owned(),
        UrlRejection::TooLong(length) => format!("refusing to open a {length}-character URL"),
    }
}

/// Route a wheel notch.
///
/// IN THE SIDEBAR, the list scrolls. In a pane, the scrollback does -- but only if that
/// pane HAS scrollback. A `PlanReview` pane is a diff widget, not a terminal: scrolling it
/// would scroll a buffer that does not exist, so the wheel is dropped there rather than
/// being applied to the nearest scrollable thing, which would move a pane the operator did
/// not point at.
fn wheel(
    state: &mut InputState,
    target: &HitTarget,
    ui: &mut UiState,
    panes: &mut dyn ScrollbackPane,
    list: &mut dyn SidebarList,
    lines: i16,
) -> Vec<Action> {
    let _ = (state, ui);
    match target {
        HitTarget::SidebarWorkspace { .. }
        | HitTarget::SidebarJob { .. }
        | HitTarget::SidebarQueueItem { .. }
        | HitTarget::Sidebar => {
            list.scroll(i32::from(lines));
            vec![Action::ScrollSidebar(i32::from(lines))]
        }
        HitTarget::Pane { pane_id } => {
            if panes.scroll_axis(pane_id).is_none() {
                return Vec::new();
            }
            if lines > 0 {
                panes.scroll_back(pane_id, lines.unsigned_abs());
            } else {
                panes.scroll_forward(pane_id, lines.unsigned_abs());
            }
            // The pane's `scroll_offset` is part of `Pane`, which the world projection owns,
            // so the scroll is reported as an action and the shell writes it back.
            vec![Action::ScrollPane {
                pane_id: pane_id.clone(),
                lines,
            }]
        }
        HitTarget::TopBar
        | HitTarget::StatusBar
        | HitTarget::Border { .. }
        | HitTarget::Canvas
        | HitTarget::None => Vec::new(),
    }
}

/// Whether this press landed on the open menu's own items.
fn clicked_menu(state: &InputState, event: &MouseEvent) -> bool {
    let Some(menu) = state.menu.as_ref() else {
        return false;
    };
    if !matches!(event.kind, MouseEventKind::Down(_)) {
        return false;
    }
    // The menu's rows are the render pass's rows: `at`, a border row, one row per item,
    // and a border row. Deriving them from the same numbers the widget draws from is what
    // keeps "the row I clicked" and "the row that is highlighted" the same row.
    event.column >= menu.at().0
        && event.column < menu.at().0.saturating_add(menu.width())
        && event.row >= menu.at().1
        && event.row < menu.at().1.saturating_add(menu.height())
}

/// Close the open menu.
fn dismiss_menu(state: &mut InputState) {
    state.menu = None;
}

/// Handle a click on the open menu.
fn menu_click(
    state: &mut InputState,
    event: &MouseEvent,
    now: Instant,
    ui: &mut UiState,
    panes: &mut dyn ScrollbackPane,
    layout: &mut dyn PaneLayout,
) -> Vec<Action> {
    let Some(menu) = state.menu.clone() else {
        return Vec::new();
    };
    let row = event.row.saturating_sub(menu.at().1);
    // Row 0 is the top border and row `items.len() + 1` is the bottom border.
    let index = row
        .checked_sub(1)
        .filter(|index| (*index as usize) < menu.items().len());
    let Some(index) = index else {
        state.menu = None;
        return Vec::new();
    };
    let highlighted = menu.with_highlight(index as usize);
    state.menu = None;
    activate(state, now, ui, panes, layout, &highlighted)
}

/// Perform the highlighted menu item.
fn activate(
    state: &mut InputState,
    now: Instant,
    ui: &mut UiState,
    panes: &mut dyn ScrollbackPane,
    layout: &mut dyn PaneLayout,
    menu: &ContextMenu,
) -> Vec<Action> {
    let Some(activation) = menu.activation() else {
        return Vec::new();
    };
    if activation.item.needs_queue_item() {
        return view_outbox_item(state, now, activation.queue_item_id.as_deref());
    }
    let Some(pane_id) = activation.pane_id.clone() else {
        return Vec::new();
    };
    match activation.item {
        MenuItem::SplitVertical => split_menu_item(ui, &pane_id, Axis::Vertical),
        MenuItem::SplitHorizontal => split_menu_item(ui, &pane_id, Axis::Horizontal),
        MenuItem::ClosePane => close_pane(state, now, layout, ui, &pane_id),
        MenuItem::CopyRawLogs => {
            let raw = panes.raw_log(&pane_id);
            if raw.is_empty() {
                return vec![
                    state.raise_toast(now, Toast::warning("this pane has no raw log to copy"))
                ];
            }
            vec![
                Action::CopyRawLog(redact_to_text(
                    &crate::input::redact::ConservativeRedactor,
                    &raw,
                )),
                state.raise_toast(now, Toast::info("Copied to clipboard")),
            ]
        }
        MenuItem::ViewOutboxItem => {
            view_outbox_item(state, now, activation.queue_item_id.as_deref())
        }
    }
}

fn split_menu_item(ui: &mut UiState, pane_id: &str, axis: Axis) -> Vec<Action> {
    let Some(pane) = ui.world.panes.get(pane_id) else {
        return Vec::new();
    };
    vec![Action::SpawnPaneRequested {
        workspace_id: pane.workspace_id.clone(),
        parent_pane_id: pane_id.to_owned(),
        axis,
        kind: crate::state::PaneKind::Terminal,
    }]
}

/// Close a pane, locally and on the daemon.
///
/// THE LOCAL CLOSE HAPPENS EVEN IF THE COMMAND FAILS, and that is deliberate in the other
/// direction: if the daemon refuses, the pane stays in the world and the shell's next
/// snapshot brings it back. Removing it from the layout first would make the pane vanish
/// and reappear, which reads as a glitch. So the layout is only updated when the command
/// is accepted, and a rejected id leaves everything as it was plus a toast.
fn close_pane(
    state: &mut InputState,
    now: Instant,
    layout: &mut dyn PaneLayout,
    ui: &mut UiState,
    pane_id: &str,
) -> Vec<Action> {
    match commands::close_pane(pane_id) {
        Ok(command) => {
            layout.close_pane(pane_id);
            ui.presentation.focused = layout.focused();
            ui.presentation.zoomed = layout.zoomed().filter(|zoomed| zoomed != pane_id);
            vec![Action::Command(command)]
        }
        Err(error) => vec![state.raise_toast(now, Toast::warning(error.to_string()))],
    }
}

/// Open an ingress queue item.
///
/// A CLIENT-LOCAL MESSAGE, not a command: the contract has no `view_queue_item`, and
/// inventing one would mean the outbox item's payload had to reach the client in a
/// snapshot field that does not exist. Until the daemon grows one, saying so is better than
/// a menu entry that silently does nothing.
fn view_outbox_item(
    state: &mut InputState,
    now: Instant,
    queue_item_id: Option<&str>,
) -> Vec<Action> {
    let Some(item_id) = queue_item_id else {
        return vec![state.raise_toast(now, Toast::warning("no queue item selected"))];
    };
    vec![state.raise_toast(
        now,
        Toast::warning(format!(
            "viewing outbox item {item_id} needs an IPC command that the contract does not have"
        )),
    )]
}

/// Hand a mouse event to the approval modal.
///
/// Coordinates are translated into the modal's own rectangle HERE rather than in the
/// widget, because the widget that draws a centred dialog should not have to be the only
/// thing that knows where the dialog is. When the modal publishes no rectangle -- which it
/// may, while it is open over a layout that has not been built -- it is given `(0, 0)` and
/// the only outcome reachable is `Dismissed`, which is the safe direction.
fn route_mouse_to_modal(
    state: &mut InputState,
    event: &MouseEvent,
    now: Instant,
    modal: &mut dyn ApprovalModal,
) -> Vec<Action> {
    let (column, row) = match modal.rect() {
        Some(area) if area.width > 0 && area.height > 0 => (
            event.column.saturating_sub(area.x),
            event.row.saturating_sub(area.y),
        ),
        _ => (0, 0),
    };
    // ONLY A PRESS IS A CLICK. A drag or a motion behind the modal is still eaten -- it
    // produces no action at all -- but it must not be read as a button press, or moving
    // the mouse across the dialog would approve a plan.
    let outcome = match event.kind {
        MouseEventKind::Down(_) => modal.handle_click(column, row, modal.focus()),
        _ => ModalOutcome::Consumed,
    };
    modal_actions(state, now, modal, &outcome)
}
