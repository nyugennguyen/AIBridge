//! The bridge between the input engine and the pane layout.
//!
//! # WHY A TRAIT WHEN `TileLayout` ALREADY EXISTS
//!
//! Because the engine's reducers must be pure over a state they do not own, and
//! [`TileLayout`] is the render pass's state. A reducer that took `&mut TileLayout`
//! directly would be a reducer coupled to the layout's internal representation, and the
//! copy-mode key handler would grow a parameter it has no use for.
//!
//! The trait is deliberately SMALL. Every method here is one the input engine actually
//! calls; there is no method "for the renderer", because the renderer reads
//! [`TileLayout`] directly.
//!
//! # WHY FOCUS MOVEMENT IS LIST ORDER AND NOT GEOMETRY HERE
//!
//! The plan's reducer signature is `key(state, event) -> Vec<Action]`, with no
//! geometry. A geometric focus movement would need the render pass's rectangles, which
//! means the reducer would depend on the layout being current -- and a keystroke
//! handled between a resize and the next frame would move focus to the wrong pane.
//! [`TileLayout::focus_towards`] exists for callers that DO have a canvas, and the
//! engine's [`focus_towards`] wrapper exposes it for the shell's preference.
//!
//! # THE ONE PLACE GEOMETRY CROSSES
//!
//! [`apply_ratio`] takes an `available` extent that the CALLER derives from
//! [`LayoutRects`], never from the tree. The number must be the extent the render pass
//! laid the two panes out in, or the ratio the engine computes and the ratio the
//! renderer applies would be measured against different spans.
//! [`ratio_for_drag`] is that derivation.

use ratatui::layout::Rect;

use crate::layout::tile::Focus;
use crate::layout::{Axis, LayoutRects, TileLayout};

/// The layout operations the input engine performs.
///
/// IMPLEMENTED FOR [`TileLayout`] BELOW. A shell with a different layout type implements
/// this; a shell using [`TileLayout`] only passes it in.
pub trait PaneLayout {
    /// Every pane, in visual order.
    fn pane_ids(&self) -> Vec<String>;

    /// The pane receiving keystrokes.
    fn focused(&self) -> Option<String>;

    /// Set the focused pane.
    fn set_focused(&mut self, pane_id: Option<String>);

    /// Move focus one step, returning the pane it landed on.
    ///
    /// CLAMPED, NOT WRAPPED: `h` on the leftmost pane doing nothing is predictable,
    /// whereas a wrapped jump makes a held key teleport the operator across the screen
    /// and redraw everything.
    fn focus_step(&mut self, direction: Focus) -> Option<String>;

    /// Move focus geometrically, if the implementation can.
    ///
    /// `None` means "I cannot", and the caller falls back to [`Self::focus_step`]. That
    /// is the honest contract: a layout with no canvas cannot answer, and guessing would
    /// be a focus jump with no basis.
    fn focus_towards(&mut self, _direction: Focus, _canvas: Rect) -> Option<String> {
        None
    }

    /// Toggle zoom on the focused pane, returning the zoomed pane.
    fn toggle_zoom(&mut self) -> Option<String>;

    /// The zoomed pane, if any.
    fn zoomed(&self) -> Option<String>;

    /// Apply a ratio to the split along `axis`.
    ///
    /// `available` is the FULL extent including the seam; the layout subtracts the seam
    /// itself. `None` means no split along `axis` was found.
    fn apply_ratio(&mut self, axis: Axis, available: u16, ratio: f64) -> Option<f64>;

    /// Drop a pane from the layout.
    fn close_pane(&mut self, pane_id: &str);
}

/// The span two adjacent panes were laid out in, and the ratio that span implies.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DragGeometry {
    /// The parent extent along the split axis, INCLUDING the one-cell seam.
    pub available: u16,
    /// The ratio a seam at `cell` implies, before the layout clamps it.
    pub ratio: f64,
}

/// The span and ratio for a seam drag between two panes.
///
/// # WHY THE SPAN IS DERIVED FROM THE RECTS AND NOT FROM THE TREE
///
/// `first_pane` and `second_pane` are the two leaves the hit-test resolved, and the
/// span between their edges is exactly the extent the renderer divided: `first` starts
/// at the parent's origin, the seam is the one cell between them, and `second` ends at
/// the parent's far edge. Deriving it from the tree instead would mean re-walking to find
/// the parent and re-computing its rect -- a second computation of geometry the render
/// pass already did, which is the drift `layout`'s module header forbids.
///
/// # THE SNAP
///
/// `ratio = (cell - origin) / (span - 1)`, and the renderer computes
/// `first_cells = round((span - 1) * ratio)`, so the two are exact inverses and the
/// seam lands on the cell the operator is holding. A ratio computed from a float pixel
/// delta would round to a neighbouring cell and the seam would visibly lag the cursor,
/// which is acceptance criterion 5's tearing.
///
/// Returns `None` when either pane is absent, which is a STALE HIT -- the pane closed
/// between the frame being drawn and the click arriving. A drag then does nothing, which
/// is right: there is no longer anything to resize.
#[must_use]
pub fn ratio_for_drag(
    rects: &LayoutRects,
    first_pane: &str,
    second_pane: &str,
    axis: Axis,
    cell: u16,
) -> Option<DragGeometry> {
    let first = rects.panes.get(first_pane)?.area;
    let second = rects.panes.get(second_pane)?.area;
    let (origin, first_extent, second_origin, second_extent) = match axis {
        Axis::Vertical => (first.x, first.width, second.x, second.width),
        Axis::Horizontal => (first.y, first.height, second.y, second.height),
    };
    // `span` is `first + seam + second`, i.e. the parent's extent exactly.
    let span = u32::from(second_origin) + u32::from(second_extent) - u32::from(origin);
    let span = u16::try_from(span).unwrap_or(u16::MAX);
    let available = span.saturating_sub(1);
    if available == 0 || first_extent == 0 || second_extent == 0 {
        return None;
    }
    let offset = u32::from(cell)
        .saturating_sub(u32::from(origin))
        .min(u32::from(available));
    Some(DragGeometry {
        available: span,
        ratio: f64::from(offset) / f64::from(available),
    })
}

impl PaneLayout for TileLayout {
    fn pane_ids(&self) -> Vec<String> {
        self.root.leaves().into_iter().map(str::to_owned).collect()
    }

    fn focused(&self) -> Option<String> {
        self.focused.clone()
    }

    fn set_focused(&mut self, pane_id: Option<String>) {
        self.focused = pane_id;
    }

    fn focus_step(&mut self, direction: Focus) -> Option<String> {
        let order = self.root.leaves();
        let current = self.focused.clone()?;
        let index = order.iter().position(|id| *id == current)?;
        let next = match direction {
            Focus::Previous | Focus::Left | Focus::Up => index.checked_sub(1),
            Focus::Next | Focus::Right | Focus::Down => {
                Some(index.saturating_add(1).min(order.len().saturating_sub(1)))
            }
        }?;
        let target = (*order.get(next)?).to_owned();
        self.focused = Some(target.clone());
        Some(target)
    }

    fn focus_towards(&mut self, direction: Focus, canvas: Rect) -> Option<String> {
        // The layout's own geometric movement CLAMPS and can therefore leave focus
        // where it is; reporting that as "no change" lets the engine leave it too rather
        // than falling back to a step the operator did not ask for.
        let before = self.focused.clone();
        TileLayout::focus_towards(self, direction, canvas);
        (self.focused != before).then(|| self.focused.clone())?
    }

    fn toggle_zoom(&mut self) -> Option<String> {
        TileLayout::toggle_zoom(self);
        self.zoomed.clone()
    }

    fn zoomed(&self) -> Option<String> {
        self.zoomed.clone()
    }

    fn apply_ratio(&mut self, axis: Axis, available: u16, ratio: f64) -> Option<f64> {
        // `TileLayout::set_ratio` clamps and reports whether it found a split. The
        // CLAMPED ratio is what the renderer will use, and it is returned so the caller
        // can report the value that was actually applied rather than the one it asked
        // for -- those differ at the ends of the range, which is exactly where an
        // operator is watching.
        let before = self.root.clone();
        if !TileLayout::set_ratio(self, axis, available, ratio) {
            let _ = before;
            return None;
        }
        ratio_in_node(&self.root, axis)
    }

    fn close_pane(&mut self, pane_id: &str) {
        TileLayout::close(self, pane_id);
    }
}

/// The ratio now stored on the first split along `axis`.
///
/// READ BACK FROM THE TREE rather than returned from the clamp arithmetic, because the
/// layout's clamp is the authority and re-deriving it here would be a second rule set.
fn ratio_in_node(node: &crate::layout::Node, axis: Axis) -> Option<f64> {
    match node {
        crate::layout::Node::Leaf { .. } => None,
        crate::layout::Node::Split {
            axis: split_axis,
            ratio,
            first,
            ..
        } => {
            if *split_axis == axis {
                Some(*ratio)
            } else {
                ratio_in_node(first, axis)
            }
        }
    }
}
