//! BSP tiling, chrome partitioning, and the hit-test geometry.
//!
//! # The one rule everything here follows
//!
//! **Geometry is computed once, in `compute`, and every other consumer reads the
//! result.** The render pass draws these rects and the mouse engine hit-tests
//! them. There is no second function that computes where a pane is, and there
//! must never be one.
//!
//! That is not tidiness. Acceptance criterion 5 requires that dragging a split
//! border resize panes "without visual tearing or flickering", and the way that
//! breaks is a hit-test that knows about `split_ratio` while the renderer knows
//! about rounded pixel rects: the two agree until they disagree, and then every
//! click lands one cell off what the operator sees. The cure is structural — one
//! computation, many readers — not a careful one.
//!
//! # Integer arithmetic at the leaves
//!
//! Ratios live in the tree; integers live at the leaves. `compute` walks the tree
//! once, converts each internal node's ratio into integer child sizes using the
//! parent's integer dimensions, and never divides twice on a rounded value.
//!
//! The naive alternative — lay out in floats, round each rect at every level —
//! accumulates drift: with a 0.33 ratio over successive splits, the sum of leaf
//! widths stops equalling the parent width, borders stop lining up with pane
//! interiors, and the seam shows as a one-cell gap that flickers as the tree
//! changes. Because this layout recomputes from the root on every change, the fix
//! is to make each level's children *exactly* tile their parent.

pub mod chrome;
pub mod hit;
pub mod tile;

use ratatui::layout::Rect;

/// The narrowest canvas worth drawing panes into, in columns.
///
/// Below this a pane cannot show a border, a title, and any content at once, so
/// the sidebar is dropped rather than the canvas being squeezed. 20 is measured
/// from `opencode`'s own minimum comfortable line length rather than guessed: below
/// it a wrapped line is indistinguishable from two lines.
pub const MIN_CANVAS_COLUMNS: u16 = 20;

pub use chrome::{ChromeRects, SidebarWidth};
pub use hit::{HitTarget, HitTest};
pub use tile::{Axis, Node, TileLayout};

/// The smallest pane a drag may leave behind, in cells.
///
/// Both a ratio floor and a width floor, because a ratio floor alone does not
/// prevent a collapsed pane: at a ratio of 0.02 in a 40-column canvas the child
/// rounds to 0 columns, and a 0-wide pane makes the operator's next drag land on
/// the border instead of inside what they can see. One cell is the floor because
/// that is the smallest thing that can hold a border glyph.
pub const MIN_PANE_CELLS: u16 = 1;

/// A pane's rectangle, plus which split seam sits beside it.
///
/// The axis is carried here rather than looked up at hit-test time because a border
/// drag needs to know which way to move the seam, and deriving it from the seam's
/// shape works only while the seam has a non-square extent — which fails for a
/// 1x1 seam on a 1-row canvas, the exact case where the operator is most likely to
/// be fiddling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneRect {
    /// The pane this belongs to.
    pub pane_id: String,
    /// The rectangle to draw the pane's content into.
    pub area: Rect,
    /// The node whose split produced the seam beside this pane, if any.
    pub border: Option<Axis>,
}

/// Every rectangle the layout pass produced, in one place.
///
/// A single struct rather than several return values because the render pass and
/// the hit-test must see the *same* rectangles, and a signature returning two
/// collections invites a caller to mix one from this call and one from another.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LayoutRects {
    /// Content area for each pane, keyed by pane id and ordered by pane id so the
    /// collection is deterministic across calls.
    ///
    /// `BTreeMap` rather than `HashMap`: the hit-test walks this in order, and a
    /// `HashMap`'s iteration order varies per process, which would make
    /// overlapping-pane resolution non-deterministic between runs.
    pub panes: std::collections::BTreeMap<String, PaneRect>,
    /// One rectangle per split border, sized to the seam it represents.
    pub borders: Vec<Rect>,
    /// The full canvas the panes were laid out in, excluding chrome.
    pub canvas: Rect,
}

impl LayoutRects {
    /// Find the pane containing `(column, row)`.
    ///
    /// Iterates in pane-id order rather than "last one wins". With a zoomed pane
    /// drawn over the full canvas the two rects overlap, and which one wins must
    /// be a function of the pane id rather than of insertion order.
    #[must_use]
    pub fn pane_at(&self, column: u16, row: u16) -> Option<&PaneRect> {
        self.panes
            .values()
            .find(|pane| contains(pane.area, column, row))
    }

    /// Find a split border within `tolerance` cells of `(column, row)`.
    ///
    /// Tolerance exists because a border is one character wide and hitting a
    /// one-character target with a mouse is otherwise unreliable. Two cells is
    /// chosen so the drag target is usable without swallowing clicks meant for the
    /// pane either side of it.
    #[must_use]
    pub fn border_at(&self, column: u16, row: u16, tolerance: u16) -> Option<Rect> {
        self.borders
            .iter()
            .copied()
            .find(|border| near(*border, column, row, tolerance))
    }
}

/// Whether `(column, row)` is inside `area`.
///
/// A hand-written comparison rather than `Rect::contains` because `Rect::width`
/// is `u16` arithmetic that saturates, and a `Rect` produced by subtraction can
/// have `x + width` overflow the way the operator's terminal size never should.
#[must_use]
pub fn contains(area: Rect, column: u16, row: u16) -> bool {
    column >= area.x
        && column < area.x.saturating_add(area.width)
        && row >= area.y
        && row < area.y.saturating_add(area.height)
}

/// Whether `(column, row)` is within `tolerance` cells of `rect`, inclusive.
///
/// Inclusive of both edges because the seam between two panes is the *boundary*
/// between their rects, and the character an operator sees at that boundary
/// belongs to the right-hand pane. An exclusive test would leave the last column
/// of the left pane draggable and the first of the right not, which is a seam
/// that is off by one on exactly one side.
#[must_use]
pub fn near(rect: Rect, column: u16, row: u16, tolerance: u16) -> bool {
    let left = rect.x.saturating_sub(tolerance);
    let top = rect.y.saturating_sub(tolerance);
    let right = rect.x.saturating_add(rect.width).saturating_add(tolerance);
    let bottom = rect.y.saturating_add(rect.height).saturating_add(tolerance);
    column >= left && column <= right && row >= top && row <= bottom
}

/// Partition `area` into the chrome bands and the remaining canvas.
///
/// The chrome is taken from fixed heights and a clamped sidebar width rather than
/// from `Layout::split` so that a terminal too small to hold the chrome yields an
/// **empty** canvas rather than a negative one. `u16` cannot represent "no room",
/// so the alternative is a silent wrap, and a wrapped height makes every
/// subsequent subtraction wrong.
#[must_use]
pub fn partition(area: Rect, sidebar: Option<u16>) -> ChromeRects {
    let top = area.y;
    let status = area.y.saturating_add(area.height.saturating_sub(1));
    let body_top = top.saturating_add(1);
    let body_height = area.height.saturating_sub(2);

    let (sidebar_rect, canvas) = match sidebar {
        Some(width) if width > 0 && area.width.saturating_sub(width) >= MIN_CANVAS_COLUMNS => {
            let sidebar_rect = Rect::new(area.x, body_top, width, body_height);
            let canvas = Rect::new(
                area.x.saturating_add(width),
                body_top,
                area.width.saturating_sub(width),
                body_height,
            );
            (Some(sidebar_rect), canvas)
        }
        // Either no sidebar, or the canvas would be too narrow to be worth
        // drawing. Dropping the sidebar is better than a one-column canvas the
        // operator cannot read, and the status bar still reports the queue count,
        // so nothing the operator needs becomes invisible.
        //
        // The check lives HERE as well as in `clamp_sidebar` because `partition`
        // is what actually subtracts. A caller that passes an unclamped width would
        // otherwise get a canvas too narrow to render, and the sidebar is easier to
        // live without than the panes are.
        _ => (None, Rect::new(area.x, body_top, area.width, body_height)),
    };

    ChromeRects {
        top_bar: Rect::new(area.x, top, area.width, 1),
        sidebar: sidebar_rect,
        canvas,
        status_bar: Rect::new(area.x, status, area.width, 1),
    }
}
