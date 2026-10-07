//! The recursive split tree.
//!
//! A binary tree where leaves are panes and internal nodes are splits. There is no
//! third kind of node: a pane cannot be both a leaf and a split, which is what
//! makes `compute` total — every path from the root ends at exactly one leaf.
//!
//! # Why the tree stores pane ids and not pane state
//!
//! The tree holds `String` ids. A `Pane` carries the daemon's view (its size, its
//! kind, its job), and duplicating that here would create a second copy that
//! drifts the moment the daemon sends a diff. Ids are stable and cheap, and a
//! lookup into `DaemonWorld` is a `BTreeMap` hit on a key that cannot go stale
//! silently: a pane removed by a diff simply is not found, which is the same
//! outcome as removing it from the tree.
//!
//! # Recomputed, never cached
//!
//! `compute` walks the tree from the root on every call. A cached rect set would
//! need invalidating on every ratio change, every resize, and every pane
//! add/remove, and a stale rect is exactly the bug acceptance criterion 5 forbids
//! (a hit-test that disagrees with the pixels). Recomputation is a walk over a
//! handful of leaves at 60fps, which is not a cost worth defending against.

use ratatui::layout::Rect;

use crate::layout::{LayoutRects, PaneRect, MIN_PANE_CELLS};

/// Which way a split divides its area.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    /// Left | right.
    Vertical,
    /// Top / bottom.
    Horizontal,
}

impl Axis {
    /// The character used to draw the seam.
    ///
    /// Box-drawing rather than ASCII, because these are guaranteed single-width by
    /// `unicode-width`, so they cannot shift a pane interior by one column.
    #[must_use]
    pub fn glyph(self) -> char {
        match self {
            Self::Vertical => '│',
            Self::Horizontal => '─',
        }
    }

    /// The extent this axis divides, and the extent it runs along.
    #[must_use]
    pub fn extents(self, area: Rect) -> (u16, u16) {
        match self {
            Self::Vertical => (area.width, area.height),
            Self::Horizontal => (area.height, area.width),
        }
    }
}

/// One node of the tree.
#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    /// A pane. Carries the pane id and nothing else.
    Leaf {
        /// The pane this leaf draws.
        pane_id: String,
    },
    /// A split of its area into two children along `axis`.
    Split {
        /// The direction of the split.
        axis: Axis,
        /// Where the first child gets its space, as a fraction of the available
        /// cells *after* the seam is deducted.
        ///
        /// A normalized `f64` rather than an integer, because the operator drags a
        /// seam and the natural model is a proportion. The single conversion to
        /// integer cells happens in [`TileLayout::split_children`], against the
        /// parent's already-integer dimensions.
        ratio: f64,
        /// The child nearer the origin: left for vertical, top for horizontal.
        first: Box<Node>,
        /// The child further from the origin.
        second: Box<Node>,
    },
}

impl Node {
    /// Build a leaf.
    pub fn leaf(pane_id: impl Into<String>) -> Self {
        Self::Leaf {
            pane_id: pane_id.into(),
        }
    }

    /// Build a split with an even ratio.
    pub fn split(axis: Axis, first: Self, second: Self) -> Self {
        Self::Split {
            axis,
            ratio: 0.5,
            first: Box::new(first),
            second: Box::new(second),
        }
    }

    /// Every leaf under this node, left-to-right then top-to-bottom.
    ///
    /// This is the order the operator perceives panes in, so it is also the order
    /// `Next`/`Previous` focus navigation walks.
    #[must_use]
    pub fn leaves(&self) -> Vec<&str> {
        let mut found = Vec::new();
        self.collect_leaves(&mut found);
        found
    }

    fn collect_leaves<'a>(&'a self, into: &mut Vec<&'a str>) {
        match self {
            Self::Leaf { pane_id } => into.push(pane_id),
            Self::Split { first, second, .. } => {
                first.collect_leaves(into);
                second.collect_leaves(into);
            }
        }
    }

    /// Whether this node contains `pane_id`.
    #[must_use]
    pub fn contains(&self, pane_id: &str) -> bool {
        match self {
            Self::Leaf { pane_id: id } => id == pane_id,
            Self::Split { first, second, .. } => {
                first.contains(pane_id) || second.contains(pane_id)
            }
        }
    }

    /// The two leaves directly separated by `axis`, for a border drag.
    ///
    /// Only a split with **exactly** two leaves qualifies. A drag on a border that
    /// separates two *subtrees* has no single ratio to move, and pretending
    /// otherwise would let the operator drag one seam and get several panes moving
    /// — which reads as tearing even though each pane is internally consistent.
    #[must_use]
    pub fn bordering_leaves(&self, axis: Axis) -> Option<(&str, &str)> {
        match self {
            Self::Leaf { .. } => None,
            Self::Split {
                axis: split_axis,
                first,
                second,
                ..
            } if *split_axis == axis => {
                let left = first.leaves();
                let right = second.leaves();
                match (left.as_slice(), right.as_slice()) {
                    ([only_left], [only_right]) => Some((*only_left, *only_right)),
                    _ => None,
                }
            }
            Self::Split { .. } => None,
        }
    }

    /// Every split node, paired with its axis, in tree order.
    ///
    /// Used by hit-testing to identify which split a dragged border belongs to.
    #[must_use]
    pub fn splits(&self) -> Vec<&Node> {
        let mut found = Vec::new();
        self.collect_splits(&mut found);
        found
    }

    fn collect_splits<'a>(&'a self, into: &mut Vec<&'a Node>) {
        if let Self::Split {
            axis,
            first,
            second,
            ..
        } = self
        {
            into.push(self);
            let _ = axis;
            first.collect_splits(into);
            second.collect_splits(into);
        }
    }
}

/// A workspace's pane arrangement.
#[derive(Debug, Clone, PartialEq)]
pub struct TileLayout {
    /// The tree.
    pub root: Node,
    /// The pane receiving keystrokes.
    pub focused: Option<String>,
    /// The pane drawn over the whole canvas, if zoomed.
    ///
    /// Client-local and deliberately not sent to the daemon: zoom is how *this*
    /// operator wants to look at a pane, and syncing it would make a second
    /// attached client's view jump to match.
    pub zoomed: Option<String>,
}

impl TileLayout {
    /// A layout holding one pane.
    pub fn single(pane_id: impl Into<String>) -> Self {
        let pane_id = pane_id.into();
        Self {
            root: Node::leaf(pane_id.clone()),
            focused: Some(pane_id),
            zoomed: None,
        }
    }

    /// Rebuild the tree from a flat list of pane ids.
    ///
    /// A flat list because that is what a `StateSnapshot` provides. The arrangement
    /// is even alternating vertical splits: predictable, and every pane the same
    /// size, which for a monitor of agent sessions is the useful default. The
    /// orientation is not chosen by pane kind — deciding that a diff pane must be
    /// wider than a terminal pane is a policy the daemon did not ask for, and the
    /// operator can drag any seam to get whatever proportions they want.
    #[must_use]
    pub fn from_panes(pane_ids: &[String]) -> Self {
        let Some((first, rest)) = pane_ids.split_first() else {
            return Self {
                root: Node::leaf(""),
                focused: None,
                zoomed: None,
            };
        };
        let root = rest
            .iter()
            .fold(Node::leaf(first.clone()), |accumulated, id| {
                Node::split(Axis::Vertical, accumulated, Node::leaf(id.clone()))
            });
        Self {
            root,
            focused: pane_ids.first().cloned(),
            zoomed: None,
        }
    }

    /// Every pane in this layout, in visual order.
    #[must_use]
    pub fn pane_ids(&self) -> Vec<&str> {
        self.root.leaves()
    }

    /// Resolve every pane and border rectangle against `canvas`.
    #[must_use]
    pub fn compute(&self, canvas: Rect) -> LayoutRects {
        let mut rects = LayoutRects {
            canvas,
            ..LayoutRects::default()
        };

        if let Some(zoomed) = &self.zoomed {
            if self.root.contains(zoomed) {
                // A zoomed pane takes the whole canvas. Its siblings stay in the
                // tree and come back when the zoom is released, so this is an
                // override on layout, not a mutation of the arrangement.
                rects.panes.insert(
                    zoomed.clone(),
                    PaneRect {
                        pane_id: zoomed.clone(),
                        area: canvas,
                        border: None,
                    },
                );
                return rects;
            }
        }

        self.walk(&self.root, canvas, None, &mut rects);
        rects
    }
    /// Recalibrate the tile layout for an updated canvas area without shifting focus or resetting split ratios.
    ///
    /// When a collapsible sidebar toggles (e.g. 28-column inspector sidebar on the right),
    /// this cleanly recalculates the central BSP tile dimensions and seams to fit the new canvas bounds.
    #[must_use]
    pub fn recalibrate(&self, canvas: Rect) -> LayoutRects {
        self.compute(canvas)
    }

    /// Assign rectangles to the leaves under `node`.
    ///
    /// `inherited_axis` is the axis of the split that put this subtree where it is,
    /// carried down so a leaf can stamp it without the parent having to walk back
    /// over the results. An earlier version collected each child's panes into a
    /// temporary map and merged them, which silently dropped the SEAMS the child
    /// created -- a nested split's inner border vanished, leaving a one-cell dark
    /// gap that no amount of ratio clamping could explain.
    fn walk(&self, node: &Node, area: Rect, inherited_axis: Option<Axis>, rects: &mut LayoutRects) {
        match node {
            Node::Leaf { pane_id } => {
                rects.panes.insert(
                    pane_id.clone(),
                    PaneRect {
                        pane_id: pane_id.clone(),
                        area,
                        border: inherited_axis,
                    },
                );
            }
            Node::Split {
                axis,
                ratio,
                first,
                second,
            } => {
                let Some(SplitParts {
                    seam,
                    first: first_area,
                    second: second_area,
                }) = Self::split_parts(*axis, area, *ratio)
                else {
                    // No room for a seam. Give everything to the first child: a
                    // zero-width pane cannot be drawn, clicked, scrolled, or
                    // dragged back, so the operator would have no way to recover.
                    self.walk(first, area, inherited_axis, rects);
                    return;
                };
                rects.borders.push(seam);
                self.walk(first, first_area, Some(*axis), rects);
                self.walk(second, second_area, Some(*axis), rects);
            }
        }
    }

    /// The three rectangles a split occupies: the first child, the seam, the
    /// second child — or `None` when there is no room for all three.
    ///
    /// ONE function, returning all three, and that is the point. Computing the
    /// seam's position separately from the children's is how they drift: the
    /// children are placed by arithmetic on the ratio, the seam by arithmetic on
    /// the parent's extent, and if those two disagree by a cell the seam renders
    /// inside a pane and every drag on it grabs the wrong thing. Deriving all
    /// three from one `first_cells` makes disagreement unrepresentable.
    ///
    /// The seam's cell is deducted BEFORE the division, and the second child's size
    /// is computed by subtraction. Dividing first and deducting afterwards would
    /// lose a cell to rounding somewhere, and the children would no longer exactly
    /// tile their parent — the accumulation that makes borders stop lining up under
    /// repeated splits.
    pub fn split_parts(axis: Axis, area: Rect, ratio: f64) -> Option<SplitParts> {
        let (extent, _) = axis.extents(area);
        // One cell for the seam, and at least one for each child.
        if extent < MIN_PANE_CELLS * 2 + 1 {
            return None;
        }
        let available = extent - 1;
        let first_cells = ((f64::from(available) * ratio.clamp(0.0, 1.0)).round()) as u16;
        let first_cells = first_cells.min(available);
        let second_cells = available - first_cells;

        let (first_area, seam, second_area) = match axis {
            Axis::Vertical => {
                let seam_x = area.x + first_cells;
                (
                    Rect::new(area.x, area.y, first_cells, area.height),
                    Rect::new(seam_x, area.y, 1, area.height),
                    Rect::new(seam_x + 1, area.y, second_cells, area.height),
                )
            }
            Axis::Horizontal => {
                let seam_y = area.y + first_cells;
                (
                    Rect::new(area.x, area.y, area.width, first_cells),
                    Rect::new(area.x, seam_y, area.width, 1),
                    Rect::new(area.x, seam_y + 1, area.width, second_cells),
                )
            }
        };
        Some(SplitParts {
            seam,
            first: first_area,
            second: second_area,
        })
    }

    /// The two child rectangles for a split, discarding the seam.
    ///
    /// A convenience over [`Self::split_parts`] for callers that only need the
    /// children — a test asserting on pane widths, for instance.
    #[must_use]
    pub fn split_children(axis: Axis, area: Rect, ratio: f64) -> (Rect, Rect) {
        Self::split_parts(axis, area, ratio)
            .map(|parts| (parts.first, parts.second))
            .unwrap_or((area, Rect::new(0, 0, 0, 0)))
    }

    /// Move focus one step in `direction`, clamped at the edges.
    ///
    /// Clamping rather than wrapping: `h` on the leftmost pane doing nothing is
    /// predictable, whereas a wrapped focus jump makes a held key teleport the
    /// operator across the screen and re-render everything.
    ///
    /// Cardinal directions need geometry and therefore a canvas, so they delegate
    /// to [`Self::focus_towards`]; `Next`/`Previous` are pure list order and need
    /// none.
    pub fn focus(&mut self, direction: Focus, canvas: Rect) {
        if matches!(direction, Focus::Next | Focus::Previous) {
            self.focus_in_order(direction);
            return;
        }
        self.focus_towards(direction, canvas);
    }

    /// Move focus to the next or previous pane in visual order.
    fn focus_in_order(&mut self, direction: Focus) {
        let Some(current) = self.focused.clone() else {
            return;
        };
        let order = self.root.leaves();
        let Some(index) = order.iter().position(|id| *id == current) else {
            return;
        };
        let next = match direction {
            Focus::Previous => index.saturating_sub(1),
            _ => index.saturating_add(1).min(order.len().saturating_sub(1)),
        };
        if let Some(id) = order.get(next) {
            self.focused = Some((*id).to_owned());
        }
    }

    /// Move focus to the nearest pane in a cardinal direction.
    ///
    /// Nearest-centre with a directional filter — a heuristic, not an exact spatial
    /// index. The alternative is a proper BSP traversal, which is exact and buys
    /// nothing an operator can see: with a handful of panes per workspace, the
    /// nearest-pane heuristic and the geometrically correct answer are the same
    /// pane, and the heuristic is a third of the code.
    pub fn focus_towards(&mut self, direction: Focus, canvas: Rect) {
        let Some(current) = self.focused.clone() else {
            return;
        };
        let rects = self.compute(canvas);
        let Some(from) = rects.panes.get(&current) else {
            return;
        };
        let origin = centre(from.area);

        let best = rects
            .panes
            .iter()
            .filter(|(id, _)| id.as_str() != current)
            .filter(|(_, pane)| is_towards(direction, origin, centre(pane.area)))
            .min_by(|left, right| {
                let left_distance = distance2(origin, centre(left.1.area));
                let right_distance = distance2(origin, centre(right.1.area));
                left_distance
                    .partial_cmp(&right_distance)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(id, _)| id.clone());

        if let Some(id) = best {
            self.focused = Some(id);
        }
    }

    /// Toggle the zoom state for the focused pane.
    ///
    /// With nothing focused, nothing happens: the key means "make THIS bigger",
    /// and with no subject the honest answer is no change rather than an
    /// arbitrary pane.
    pub fn toggle_zoom(&mut self) {
        let Some(focused) = self.focused.clone() else {
            return;
        };
        self.zoomed = if self.zoomed.as_ref() == Some(&focused) {
            None
        } else {
            Some(focused)
        };
    }

    /// Move the seam between two panes to `ratio` of the available cells.
    ///
    /// The clamp is what makes border dragging feel solid: without it a drag to the
    /// far left produces a zero-width pane that cannot be clicked, scrolled, or
    /// dragged back, and recovering means detaching and re-attaching.
    ///
    /// `available` is the parent's extent along the split axis, supplied by the
    /// caller because the tree does not know its own geometry — only the render's
    /// rects do, and only those are guaranteed to match what was drawn.
    pub fn set_ratio(&mut self, axis: Axis, available: u16, ratio: f64) -> bool {
        let available = available.saturating_sub(1);
        if available < MIN_PANE_CELLS * 2 {
            return false;
        }
        let floor = f64::from(MIN_PANE_CELLS) / f64::from(available);
        let ceiling = 1.0 - floor;
        let clamped = if ratio < floor || ratio > ceiling {
            ratio.clamp(floor, ceiling)
        } else {
            ratio
        };
        set_ratio_at(&mut self.root, axis, clamped)
    }

    /// Remove a pane, collapsing its parent.
    ///
    /// Collapsing rather than promoting the sibling: a split must keep exactly two
    /// children, so removing one leaf means replacing the parent with the survivor
    /// — and the survivor inherits the parent's whole area, which is what the
    /// operator expects when a pane closes.
    pub fn close(&mut self, pane_id: &str) {
        if !self.root.contains(pane_id) {
            return;
        }
        self.root = remove_leaf(&self.root, pane_id);
        if self.focused.as_deref() == Some(pane_id) {
            // Focus moves to whatever survived. Leaving it on a pane no longer in
            // the tree would send every keystroke to an id the daemon answers
            // `not_found`, and the status bar would name a pane that is not drawn.
            self.focused = self.root.leaves().first().map(|id| (*id).to_owned());
        }
        if self.zoomed.as_deref() == Some(pane_id) {
            self.zoomed = None;
        }
    }
}

/// One step of focus movement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    /// The next pane in visual order.
    Next,
    /// The previous pane in visual order.
    Previous,
    /// The pane above.
    Up,
    /// The pane below.
    Down,
    /// The pane to the left.
    Left,
    /// The pane to the right.
    Right,
}

/// The three rectangles one split occupies.
///
/// Returned as one value so the caller cannot take the children and reconstruct a
/// seam position independently — that reconstruction is precisely the drift this
/// type exists to prevent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SplitParts {
    /// The first child's rectangle: nearer the origin.
    pub first: Rect,
    /// The one-cell seam between the children.
    pub seam: Rect,
    /// The second child's rectangle: further from the origin.
    pub second: Rect,
}

/// Drop `pane_id`, collapsing its parent onto whichever child survived.
fn remove_leaf(node: &Node, pane_id: &str) -> Node {
    match node {
        Node::Leaf { pane_id: id } if id == pane_id => Node::leaf(""),
        Node::Leaf { .. } => node.clone(),
        Node::Split {
            axis,
            ratio,
            first,
            second,
        } => {
            let (first_gone, second_gone) = (first.contains(pane_id), second.contains(pane_id));
            match (first_gone, second_gone) {
                (true, true) => Node::leaf(""),
                (true, false) => (**second).clone(),
                (false, true) => (**first).clone(),
                // Neither child holds it, so the recursion removed something deeper.
                // The ratio is preserved rather than recomputed: re-normalising
                // here would visibly shift an unrelated seam.
                (false, false) => Node::Split {
                    axis: *axis,
                    ratio: *ratio,
                    first: Box::new(remove_leaf(first, pane_id)),
                    second: Box::new(remove_leaf(second, pane_id)),
                },
            }
        }
    }
}

/// Set the ratio of the first `axis` split in the tree.
///
/// Depth-first, first match. `TileLayout::set_ratio` is called with the split the
/// operator's mouse is on, and a hit-test resolves a seam to exactly one node, so
/// in practice there is one candidate; taking the first makes the operation total
/// even if a caller cannot distinguish.
fn set_ratio_at(node: &mut Node, axis: Axis, ratio: f64) -> bool {
    match node {
        Node::Leaf { .. } => false,
        Node::Split {
            axis: split_axis,
            ratio: current,
            first,
            second,
        } => {
            if *split_axis == axis {
                *current = ratio;
                return true;
            }
            set_ratio_at(first, axis, ratio) || set_ratio_at(second, axis, ratio)
        }
    }
}

/// The centre of a rect, in floating point.
fn centre(area: Rect) -> (f64, f64) {
    (
        f64::from(area.x) + f64::from(area.width) / 2.0,
        f64::from(area.y) + f64::from(area.height) / 2.0,
    )
}

/// Squared distance, so a comparison needs no square root.
fn distance2(from: (f64, f64), to: (f64, f64)) -> f64 {
    let (dx, dy) = (to.0 - from.0, to.1 - from.1);
    dx * dx + dy * dy
}

/// Whether `candidate` lies in `direction` from `origin`.
///
/// Permissive on the axis not being moved, so a pane diagonally down-right counts
/// as both right and down. Refusing it would make diagonal navigation impossible
/// in a tree where the operator's mental model is "the one that way".
fn is_towards(direction: Focus, origin: (f64, f64), candidate: (f64, f64)) -> bool {
    let (dx, dy) = (candidate.0 - origin.0, candidate.1 - origin.1);
    match direction {
        Focus::Left => dx < 0.0,
        Focus::Right => dx > 0.0,
        Focus::Up => dy < 0.0,
        Focus::Down => dy > 0.0,
        Focus::Next | Focus::Previous => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_inspector_sidebar_toggle_recalibrates_cleanly() {
        let panes = vec!["pane1".to_string(), "pane2".to_string()];
        let mut layout = TileLayout::from_panes(&panes);
        layout.focused = Some("pane1".to_string());

        // Terminal 100x30 with chrome top 3 rows, status 1 row -> body 26 rows.
        // Without inspector sidebar: canvas width is 100.
        let canvas_full = Rect::new(0, 3, 100, 26);
        let rects_full = layout.recalibrate(canvas_full);
        assert_eq!(rects_full.panes.len(), 2);
        assert_eq!(layout.focused.as_deref(), Some("pane1"));

        // Leftmost pane origin is 0.
        assert_eq!(rects_full.panes["pane1"].area.x, 0);

        // Toggle inspector sidebar (28 cols on right) -> canvas width is 72 (100 - 28).
        let canvas_with_sidebar = Rect::new(0, 3, 72, 26);
        let rects_with_sidebar = layout.recalibrate(canvas_with_sidebar);

        // Focused pane remains intact.
        assert_eq!(layout.focused.as_deref(), Some("pane1"));

        // Leftmost pane origin remains stable at 0 without horizontal jump.
        assert_eq!(rects_with_sidebar.panes["pane1"].area.x, 0);
        assert_eq!(rects_with_sidebar.panes["pane1"].area.y, 3);

        // Central BSP tiles scale into the 72-col canvas without overlap or gaps.
        let p1 = &rects_with_sidebar.panes["pane1"].area;
        let p2 = &rects_with_sidebar.panes["pane2"].area;
        let seam = &rects_with_sidebar.borders[0];

        assert_eq!(p1.width + seam.width + p2.width, 72);
        assert_eq!(seam.x, p1.x + p1.width);
        assert_eq!(p2.x, seam.x + seam.width);

        // Toggle back off -> canvas expands back to 100.
        let rects_restored = layout.recalibrate(canvas_full);
        assert_eq!(rects_restored.panes["pane1"].area.x, 0);
        assert_eq!(
            rects_restored.panes["pane2"].area.x + rects_restored.panes["pane2"].area.width,
            100
        );
    }
}
