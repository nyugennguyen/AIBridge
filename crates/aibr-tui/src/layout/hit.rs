//! Mapping a mouse coordinate to the thing under it.
//!
//! # Why this consumes `LayoutRects` and never recomputes
//!
//! The obvious implementation of "which pane is at (x, y)" is to ask the tree to
//! walk to the leaf containing that point. That is wrong here, and the reason is
//! acceptance criterion 5: the renderer drew rectangles produced by one pass, and a
//! second traversal answering a subtly different question is how a click lands one
//! cell off what the operator sees. On a slow terminal the drift is invisible in a
//! screenshot and maddening in use.
//!
//! So this module holds no geometry of its own. It reads [`LayoutRects`] — the
//! exact rectangles the render pass used — and does nothing but test membership.
//!
//! # Border tolerance
//!
//! A split border is one character wide. Requiring a pixel-exact hit makes
//! dragging a seam a precision task, and a failed drag is worse than a missed one
//! because the operator believes they resized something and nothing happened.
//! [`HitTest::BORDER_TOLERANCE`] is two cells: wide enough to be a reliable drag
//! target, narrow enough that a click just inside a pane still focuses that pane
//! rather than starting a resize.
//!
//! Borders are tested **before** panes, and a pane only wins if no border is near.
//! The order matters at the seam itself: the character an operator sees at a
//! boundary belongs to whichever pane the renderer drew it into, so hit-testing
//! "the border first" would steal a legitimate pane click on the last column.

use crate::layout::{Axis, ChromeRects, LayoutRects};

/// What is under a mouse coordinate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HitTarget {
    /// A pane's content area.
    Pane {
        /// The pane.
        pane_id: String,
    },
    /// A split border, draggable.
    Border {
        /// The direction of the split, which is how a drag knows what to change.
        axis: Axis,
        /// The pane on the near side, so the caller can size the ratio's floor.
        first_pane: String,
        /// The pane on the far side.
        second_pane: String,
        /// The seam's extent along its own axis, for snapping a drag to whole cells.
        extent: u16,
    },
    /// A workspace row in the sidebar.
    SidebarWorkspace {
        /// The workspace id.
        workspace_id: String,
    },
    /// A job row in the sidebar.
    SidebarJob {
        /// The job id.
        job_id: String,
    },
    /// A pending queue row in the sidebar.
    SidebarQueueItem {
        /// The job id the queue row refers to.
        job_id: String,
    },
    /// The header bar.
    TopBar,
    /// The footer bar.
    StatusBar,
    /// Inside the sidebar but not on a row.
    Sidebar,
    /// Inside the canvas but on no pane — the dead space beside a collapsed pane.
    Canvas,
    /// Nothing: outside every region, or the terminal is too small to lay out.
    None,
}

/// The rows the sidebar drew, so a coordinate can be resolved back to an id.
///
/// The hit-test cannot derive this from geometry alone: the sidebar is a list of
/// variable-height sections (workspaces, then each workspace's jobs, then the
/// queue), and only the render pass knows where each row landed. Passing the rows
/// back in keeps one source of truth for row positions, which is the same rule the
/// pane rects follow.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SidebarRows {
    /// Row rectangles paired with what they are, top to bottom.
    pub entries: Vec<(ratatui::layout::Rect, HitTarget)>,
}

/// Resolve coordinates against the geometry the render pass produced.
#[derive(Debug, Clone, Copy, Default)]
pub struct HitTest;

impl HitTest {
    /// How many cells either side of a seam still count as the seam.
    pub const BORDER_TOLERANCE: u16 = 2;

    /// Resolve `(column, row)` against one frame's geometry.
    ///
    /// `panes` and `chrome` are the same values the render pass used. `sidebar_rows`
    /// may be empty for a frame with the sidebar collapsed.
    #[must_use]
    pub fn hit(
        column: u16,
        row: u16,
        panes: &LayoutRects,
        chrome: &ChromeRects,
        sidebar_rows: &SidebarRows,
    ) -> HitTarget {
        if hit_rect(chrome.top_bar, column, row) {
            return HitTarget::TopBar;
        }
        if hit_rect(chrome.status_bar, column, row) {
            return HitTarget::StatusBar;
        }

        if let Some(sidebar) = chrome.sidebar {
            if hit_rect(sidebar, column, row) {
                return sidebar_row(column, row, sidebar_rows);
            }
        }

        // Borders before panes, with the tolerance applied to the seam only. A
        // border near a click inside a pane wins, which is the whole point of the
        // tolerance; without it the tolerance would do nothing, because the seam
        // cell itself belongs to no pane.
        if let Some(target) = border_at(column, row, panes) {
            return target;
        }
        if let Some(pane) = panes.pane_at(column, row) {
            return HitTarget::Pane {
                pane_id: pane.pane_id.clone(),
            };
        }
        if hit_rect(panes.canvas, column, row) {
            return HitTarget::Canvas;
        }
        HitTarget::None
    }

    /// The border nearest `(column, row)`, if any.
    ///
    /// A standalone function because the context menu wants border detection
    /// without the rest of the hit-test — a right-click on a seam offers
    /// orientation-aware actions.
    #[must_use]
    pub fn border(column: u16, row: u16, panes: &LayoutRects) -> Option<HitTarget> {
        border_at(column, row, panes)
    }
}

/// Find the seam near a coordinate, if there is one.
///
/// The axis is inferred from the seam's own shape rather than tracked alongside
/// it: a seam is 1 cell wide and `height` tall for a vertical split, and 1 cell
/// tall and `width` wide for a horizontal one. Carrying the axis in a parallel
/// structure would be a second thing to keep in step with the rects, which is the
/// failure this module exists to avoid.
///
/// The pane names come from the two panes immediately adjacent to the seam, found
/// by looking for the panes whose far edge abuts it. A seam adjacent to no pane
/// (possible when a zoom is released mid-drag, leaving a stale rect) is skipped
/// rather than panicking.
fn border_at(column: u16, row: u16, panes: &LayoutRects) -> Option<HitTarget> {
    let seam = panes.border_at(column, row, HitTest::BORDER_TOLERANCE)?;
    let axis = if seam.height >= seam.width {
        Axis::Vertical
    } else {
        Axis::Horizontal
    };

    let abutting = |want_before: bool| -> Option<&crate::layout::PaneRect> {
        panes
            .panes
            .values()
            .find(|pane| abuts(pane.area, seam, axis, want_before))
    };

    // `first` is the pane nearer the origin, matching `split_children`.
    let (first_pane, second_pane) = match axis {
        Axis::Vertical => (
            abutting(true).map(|p| p.pane_id.clone()),
            abutting(false).map(|p| p.pane_id.clone()),
        ),
        Axis::Horizontal => (
            abutting(true).map(|p| p.pane_id.clone()),
            abutting(false).map(|p| p.pane_id.clone()),
        ),
    };

    let (first_pane, second_pane) = (first_pane?, second_pane?);
    let extent = match axis {
        Axis::Vertical => seam.height,
        Axis::Horizontal => seam.width,
    };

    Some(HitTarget::Border {
        axis,
        first_pane,
        second_pane,
        extent,
    })
}

/// Whether `pane` sits immediately before or after `seam` along `axis`.
///
/// "Abuts" rather than "contains": the pane's edge is the seam's origin, or the
/// pane's far edge is one past the seam's far edge. A loose proximity test would
/// match the pane on the far side of the seam to the seam as well, giving the drag
/// two candidates for one seam.
fn abuts(
    pane: ratatui::layout::Rect,
    seam: ratatui::layout::Rect,
    axis: Axis,
    before: bool,
) -> bool {
    match axis {
        Axis::Vertical => {
            let pane_right = pane.x.saturating_add(pane.width);
            let seam_right = seam.x.saturating_add(seam.width);
            if before {
                pane_right == seam.x
            } else {
                seam_right == pane.x
            }
        }
        Axis::Horizontal => {
            let pane_bottom = pane.y.saturating_add(pane.height);
            let seam_bottom = seam.y.saturating_add(seam.height);
            if before {
                pane_bottom == seam.y
            } else {
                seam_bottom == pane.y
            }
        }
    }
}

/// The sidebar row under a coordinate.
fn sidebar_row(column: u16, row: u16, rows: &SidebarRows) -> HitTarget {
    rows.entries
        .iter()
        .find(|(rect, _)| hit_rect(*rect, column, row))
        .map(|(_, target)| target.clone())
        .unwrap_or(HitTarget::Sidebar)
}

/// Whether `(column, row)` is inside `rect`.
fn hit_rect(rect: ratatui::layout::Rect, column: u16, row: u16) -> bool {
    column >= rect.x
        && column < rect.x.saturating_add(rect.width)
        && row >= rect.y
        && row < rect.y.saturating_add(rect.height)
}
