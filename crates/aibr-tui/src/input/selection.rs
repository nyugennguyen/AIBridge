//! The selection anchor/cursor model, and extraction of what it covers.
//!
//! # WHY THE SELECTION LIVES IN THE INPUT ENGINE
//!
//! Two candidates: the VT grid (workstream 4) or here. It belongs here because the
//! engine is what creates and destroys it -- a `MouseDown` on a pane and a `v` in copy
//! mode both produce one, and both produce it from an event rather than from rendered
//! state. If the grid owned it, copy mode would have to reach into the grid and
//! copy-on-select would have to reach into the grid, and the grid would need to know
//! about mouse events it does not receive. The grid's obligation is only to RENDER it,
//! which it does by asking this module what is selected.
//!
//! # WHY THE COORDINATES ARE PANE-CONTENT-RELATIVE
//!
//! [`crate::layout::PaneRect::area`] is the pane's content area in terminal coordinates,
//! and the mouse gives terminal coordinates -- but everything the grid is asked is asked in
//! GRID coordinates, where row 0 is the first line the pane shows and column 0 is the
//! pane's first column. The two differ by the pane's origin, which the engine translates
//! once on the way in ([`to_content`](crate::input::to_content)).
//!
//! Storing terminal coordinates instead would be wrong in a way that is easy to miss: the
//! grid would have to know where it is drawn on the screen to interpret them, and it does
//! not -- and must not, because a pane is not necessarily at the same place twice. The
//! grid's own space is the only one it can answer questions about.
//!
//! The selection therefore survives the pane being scrolled, reflowed or dragged to a
//! different size, which is the property that matters: a screen-local selection silently
//! moves to a different piece of text the moment the operator drags the divider.

/// A cell in pane-content coordinates.
///
/// `Copy`, `Eq`, `Ord` and `Hash` are derived because the render pass needs to ask "is this
/// cell selected?" per cell per frame, and a packed `u32` or a lookup table would be the
/// wrong trade for a comparison that is already two integer compares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CellCoords {
    /// Column within the pane's content area.
    pub column: u16,
    /// Row within the pane's content area.
    pub row: u16,
}

impl CellCoords {
    /// A cell.
    #[must_use]
    pub const fn new(column: u16, row: u16) -> Self {
        Self { column, row }
    }
}

/// An active selection: where it started and where the cursor is now.
///
/// Normalisation is a method rather than a stored third field, so the stored form cannot
/// disagree with itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selection {
    /// The pane whose grid the selection is over.
    pub pane_id: String,
    /// Where the operator pressed, or where `v` was pressed.
    pub anchor: CellCoords,
    /// Where the cursor is now.
    pub cursor: CellCoords,
}

impl Selection {
    /// A selection between two cells, whichever order they were made in.
    #[must_use]
    pub fn new(pane_id: impl Into<String>, anchor: CellCoords, cursor: CellCoords) -> Self {
        Self {
            pane_id: pane_id.into(),
            anchor,
            cursor,
        }
    }

    /// Anchor and cursor with rows ascending.
    ///
    /// COLUMNS WITHIN A ROW ARE NOT ORDERED. Which end of a row is its "start" is a
    /// property of bidirectional text, and guessing wrong here reverses a selection
    /// inside an Arabic or Hebrew run. [`Self::extract`] hands the column range to the
    /// grid and lets it decide.
    #[must_use]
    pub fn ordered(&self) -> (CellCoords, CellCoords) {
        if self.anchor.row <= self.cursor.row {
            (self.anchor, self.cursor)
        } else {
            (self.cursor, self.anchor)
        }
    }

    /// Whether the selection covers more than one cell.
    ///
    /// A single-cell selection is NOT a selection: copy-on-select would overwrite the
    /// operator's clipboard every time they clicked to focus a pane, which is data loss
    /// dressed as a feature.
    #[must_use]
    pub fn is_extent(&self) -> bool {
        self.anchor != self.cursor
    }

    /// Whether `cell` is inside the selection, in pane-content coordinates.
    ///
    /// Interior rows are full width; the first row starts at the anchor's column and the
    /// last ends at the cursor's. That is what makes an upward drag select the same cells
    /// as the equivalent downward drag, which is the property an operator notices
    /// immediately when it is wrong.
    #[must_use]
    pub fn contains(&self, cell: CellCoords) -> bool {
        let (start, end) = self.ordered();
        if !(start.row..=end.row).contains(&cell.row) {
            return false;
        }
        if cell.row == start.row && cell.column < start.column {
            return false;
        }
        if cell.row == end.row && cell.column > end.column {
            return false;
        }
        true
    }

    /// Whether a TERMINAL cell is inside the selection.
    ///
    /// WHAT THE RENDER PASS CALLS. The widget iterates cells in terminal coordinates
    /// because that is what a `Buffer` is indexed by, so it needs the pane's origin to ask
    /// the question. Passing the origin in -- rather than having the widget subtract it per
    /// cell -- keeps the subtraction in one place.
    #[must_use]
    pub fn contains_screen(&self, area: ratatui::layout::Rect, column: u16, row: u16) -> bool {
        match to_content(area, column, row) {
            Some(cell) => self.contains(cell),
            None => false,
        }
    }

    /// Extract the selected text.
    ///
    /// DELEGATES THE COLUMN MAPPING to the grid and owns the line joining, so the grid
    /// never has to know how a multi-line selection is spelled.
    #[must_use]
    pub fn extract(&self, panes: &dyn crate::input::ScrollbackPane) -> String {
        let (start, end) = self.ordered();
        let top = panes.viewport_top(&self.pane_id);
        // The selection is clipped to the viewport. A drag that ends below the last row
        // -- which happens whenever the pointer leaves the pane -- selects to the bottom,
        // rather than extending into scrollback the operator cannot see and did not aim at.
        let last_row = end
            .row
            .min(panes.viewport_rows(&self.pane_id).saturating_sub(1));
        let full_width = panes.viewport_columns(&self.pane_id);

        let mut text = String::new();
        for row in start.row..=last_row {
            let line_index = top + i64::from(row);
            let from = if row == start.row { start.column } else { 0 };
            let to = if row == end.row && end.row <= last_row {
                end.column.saturating_add(1)
            } else {
                full_width
            };
            let slice = panes.slice_line(&self.pane_id, line_index, from, to);
            if !text.is_empty() && !panes.line_is_continuation(&self.pane_id, line_index) {
                text.push('\n');
            }
            text.push_str(&slice);
        }
        trim_trailing_whitespace(&text)
    }
}

/// Convert a terminal cell to pane-content coordinates, or `None` for pane chrome.
///
/// `None` rather than a clamp, because clamping a click on a title bar to column zero
/// would make a link on the left edge of the first row unopenable and a selection start
/// one cell to the left of where the operator clicked.
#[must_use]
pub fn to_content(area: ratatui::layout::Rect, column: u16, row: u16) -> Option<CellCoords> {
    if !crate::layout::contains(area, column, row) {
        return None;
    }
    Some(CellCoords::new(column - area.x, row - area.y))
}

/// The inverse of [`to_content`], for the render pass.
#[must_use]
pub fn to_screen(area: ratatui::layout::Rect, cell: CellCoords) -> (u16, u16) {
    (area.x + cell.column, area.y + cell.row)
}

/// Drop trailing spaces per line and any trailing newline.
///
/// Trailing padding is invisible on screen and the operator did not select it; leaving it
/// in makes a pasted line carry a run of spaces that breaks diffs and shell quoting.
fn trim_trailing_whitespace(text: &str) -> String {
    text.lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end_matches('\n')
        .to_owned()
}
