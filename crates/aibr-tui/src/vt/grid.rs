//! The cell grid, the scrollback ring, and the selection.
//!
//! # Wide characters are one cell with a continuation marker
//!
//! A CJK glyph or a box-drawing character occupies TWO columns. It is stored once,
//! in the leftmost of them, and the column to its right holds a
//! [`Cell::continuation`] with no glyph of its own.
//!
//! The tempting alternative -- writing the same glyph into both columns -- renders
//! as a doubled character, which is exactly how a naive VT implementation mangles
//! every CJK pane and every box-drawing border. The continuation marker is what
//! makes "this cell is half of a wider glyph" representable, so a renderer can skip
//! it instead of drawing over its left neighbour.
//!
//! # Colour is 24-bit because the stream is
//!
//! [`Color`] carries rgb values without downsampling. `opencode` emits truecolor,
//! and quantising to 256 colours or 16 would visibly band its syntax highlighting.
//! Indexed and named colours are kept as distinct variants rather than resolved at
//! parse time so a theme change does not require re-feeding the stream.

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

/// How many lines of history a pane keeps.
///
/// Bounded because an agent session can run for days, and a pane that accumulated
/// every line it ever showed would grow without limit in a process whose memory is
/// the operator's terminal window. 10_000 lines is roughly a full screen of a dense
/// build log several hundred times over -- far past what anyone scrolls back
/// through, and about 2 MB at an average of 200 bytes a line.
pub const SCROLLBACK_LINES: usize = 10_000;

/// A foreground or background colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Color {
    /// The terminal's own default, which the renderer's theme decides.
    #[default]
    Default,
    /// One of the 256 indexed colours.
    Indexed(u8),
    /// A 24-bit colour.
    Rgb(u8, u8, u8),
}

impl Color {
    /// Whether this is the terminal default.
    ///
    /// A named method rather than a `matches!` at each call site, because
    /// "is this the default" is asked for a different reason each time and the
    /// answer must not change.
    #[must_use]
    pub fn is_default(self) -> bool {
        matches!(self, Self::Default)
    }
}

/// One cell's content and attributes.
///
/// NOT `Copy`: the grapheme is an owned `String`, and a `Copy` derive would have to
/// be un-implemented anyway. Cloning a row to hand it to the renderer is the cost,
/// and it is paid once per frame per pane rather than per cell access.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cell {
    /// The grapheme cluster shown here, or `None` for a continuation cell.
    pub grapheme: Option<String>,
    /// Foreground colour.
    pub foreground: Color,
    /// Background colour.
    pub background: Color,
    /// Bold, which also selects the bright variant of an indexed colour.
    pub bold: bool,
    /// Italic.
    pub italic: bool,
    /// Underline.
    pub underline: bool,
    /// Reverse video: swap foreground and background at render time.
    pub reverse: bool,
    /// Dimmed.
    pub dim: bool,
}

impl Default for Cell {
    fn default() -> Self {
        Self::blank()
    }
}

impl Cell {
    /// An empty cell with no attributes.
    ///
    /// A space, not an empty string: a cell with no glyph renders as whatever the
    /// theme's background is, which is not what a terminal does. A terminal's blank
    /// cell is a space carrying the current background, and the difference is
    /// visible wherever a program draws a background colour and then clears.
    #[must_use]
    pub fn blank() -> Self {
        Self {
            grapheme: Some(String::from(" ")),
            foreground: Color::Default,
            background: Color::Default,
            bold: false,
            italic: false,
            underline: false,
            reverse: false,
            dim: false,
        }
    }

    /// A cell holding `grapheme`, with the given attributes.
    #[must_use]
    pub fn with_grapheme(grapheme: String, foreground: Color, background: Color) -> Self {
        Self {
            grapheme: Some(grapheme),
            foreground,
            background,
            ..Self::blank()
        }
    }

    /// A continuation cell: the right half of a wide glyph.
    #[must_use]
    pub fn continuation(background: Color) -> Self {
        Self {
            grapheme: None,
            background,
            ..Self::blank()
        }
    }

    /// Whether this cell is the right half of a wider glyph.
    ///
    /// Distinct from "has no glyph": a blank cell has a space and renders, while a
    /// continuation must be skipped by the renderer.
    #[must_use]
    pub fn is_continuation(&self) -> bool {
        self.grapheme.is_none()
    }

    /// The number of columns this cell's glyph occupies.
    ///
    /// `unicode_width`, not `chars().count()`: a combining mark is zero-width and
    /// an emoji is two, and counting characters gets both wrong. A zero-width
    /// cluster still occupies the cell it lands in -- terminals attach marks to the
    /// preceding cell rather than creating one -- so the minimum is 1.
    #[must_use]
    pub fn width(&self) -> usize {
        self.grapheme
            .as_deref()
            .map(|grapheme| UnicodeWidthStr::width(grapheme).max(1))
            .unwrap_or(0)
    }
}

/// Where the cursor is and what it is showing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Cursor {
    /// Zero-based column.
    pub column: u16,
    /// Zero-based row.
    pub row: u16,
    /// Whether the cursor is visible.
    pub visible: bool,
    /// The current attributes applied to newly written cells.
    pub foreground: Color,
    /// Current background.
    pub background: Color,
    /// Current bold.
    pub bold: bool,
    /// Current italic.
    pub italic: bool,
    /// Current underline.
    pub underline: bool,
    /// Current reverse video.
    pub reverse: bool,
    /// Current dim.
    pub dim: bool,
}

impl Cursor {
    /// A cursor at the origin, visible, with default attributes.
    #[must_use]
    pub fn new() -> Self {
        Self {
            visible: true,
            ..Self::default()
        }
    }
}

/// A bounded ring of scrolled-off lines.
///
/// A ring rather than a `VecDeque` shift: shifting a `VecDeque` on every scroll is
/// O(n) per line, and a long build log scrolls constantly. A ring writes in place.
#[derive(Debug, Clone)]
pub struct Scrollback {
    lines: Vec<Vec<Cell>>,
    start: usize,
    len: usize,
    capacity: usize,
}

impl Scrollback {
    /// An empty scrollback holding at most `capacity` lines.
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        Self {
            lines: vec![Vec::new(); capacity],
            start: 0,
            len: 0,
            capacity,
        }
    }

    /// Push one line, dropping the oldest when full.
    pub fn push(&mut self, line: Vec<Cell>) {
        if self.capacity == 0 {
            return;
        }
        let index = (self.start + self.len) % self.capacity;
        self.lines[index] = line;
        if self.len == self.capacity {
            // Full: the write overwrote the oldest line, so advance the window.
            self.start = (self.start + 1) % self.capacity;
        } else {
            self.len += 1;
        }
    }

    /// The retained lines, oldest first.
    #[must_use]
    pub fn lines(&self) -> &[Vec<Cell>] {
        &self.lines[self.start..self.start + self.len]
    }

    /// How many lines are retained.
    #[must_use]
    pub fn len(&self) -> usize {
        self.len
    }

    /// Whether anything is retained.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Discard everything.
    pub fn clear(&mut self) {
        self.start = 0;
        self.len = 0;
    }
}

/// An inclusive rectangle of cells the operator selected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Selection {
    /// Where the drag began.
    pub anchor: (u16, u16),
    /// Where the pointer is now.
    pub head: (u16, u16),
}

impl Selection {
    /// A selection from `anchor` to `head`.
    #[must_use]
    pub fn new(anchor: (u16, u16), head: (u16, u16)) -> Self {
        Self { anchor, head }
    }

    /// The selection with its corners ordered, as (min, max) pairs.
    ///
    /// Ordering here rather than at every use site, because "is this row within the
    /// selection" has three plausible answers for a backwards drag and only one of
    /// them is the one the operator meant.
    #[must_use]
    pub fn ordered(&self) -> ((u16, u16), (u16, u16)) {
        (
            (
                self.anchor.0.min(self.head.0),
                self.anchor.1.min(self.head.1),
            ),
            (
                self.anchor.0.max(self.head.0),
                self.anchor.1.max(self.head.1),
            ),
        )
    }

    /// Whether `(column, row)` falls inside, inclusive of both ends.
    #[must_use]
    pub fn contains(&self, column: u16, row: u16) -> bool {
        let ((min_x, min_y), (max_x, max_y)) = self.ordered();
        (min_x..=max_x).contains(&column) && (min_y..=max_y).contains(&row)
    }
}

/// A screen: cells, cursor, and scrollback.
///
/// One grid, with the alternate screen held as a second `Grid` by the parser. A
/// single grid with a mode flag is the tempting design and the wrong one: the
/// alternate buffer must be restored exactly as it was, which means it has to have
/// been preserved while the primary was being drawn over.
#[derive(Debug, Clone)]
pub struct Grid {
    cells: Vec<Cell>,
    columns: u16,
    rows: u16,
    /// Cached row widths, so `row()` is O(1) rather than O(columns).
    strides: Vec<usize>,
}

impl Grid {
    /// An empty grid of the given size.
    #[must_use]
    pub fn new(columns: u16, rows: u16) -> Self {
        let columns = columns.max(1);
        let rows = rows.max(1);
        let cells = vec![Cell::blank(); usize::from(columns) * usize::from(rows)];
        let strides = vec![usize::from(columns); usize::from(rows)];
        Self {
            cells,
            columns,
            rows,
            strides,
        }
    }

    /// The grid's width in columns.
    #[must_use]
    pub fn columns(&self) -> u16 {
        self.columns
    }

    /// The grid's height in rows.
    #[must_use]
    pub fn rows(&self) -> u16 {
        self.rows
    }

    /// The cell at `(column, row)`, or a blank cell when out of range.
    ///
    /// A reference, because `Cell` owns its grapheme and cloning one per cell access
    /// would allocate on every read -- and the renderer reads every cell of every
    /// pane at 60fps. Callers that need an owned cell clone explicitly.
    ///
    /// An out-of-range read yields a blank rather than panicking: a confused or
    /// hostile stream emits out-of-range cursor moves routinely, and taking the pane
    /// down over one would be a denial of service by a single escape sequence. The
    /// blank is a fresh value because a `&'static` one cannot exist for a type that
    /// owns a `String`.
    #[must_use]
    pub fn cell(&self, column: u16, row: u16) -> &Cell {
        static BLANK: std::sync::OnceLock<Cell> = std::sync::OnceLock::new();
        if column >= self.columns || row >= self.rows {
            return BLANK.get_or_init(Cell::blank);
        }
        &self.cells[self.index(column, row)]
    }

    /// Overwrite the cell at `(column, row)`.
    pub fn set(&mut self, column: u16, row: u16, cell: Cell) {
        if column >= self.columns || row >= self.rows {
            return;
        }
        // The index is computed into a local first: `self.cells[self.index(..)]`
        // would borrow `self` immutably inside the expression that borrows it
        // mutably.
        let index = self.index(column, row);
        self.cells[index] = cell;
    }

    /// The cells of one row, or an empty slice when out of range.
    #[must_use]
    pub fn row(&self, row: u16) -> &[Cell] {
        if row >= self.rows {
            return &[];
        }
        let start = row as usize * self.columns as usize;
        &self.cells[start..start + self.columns as usize]
    }

    /// Blank every cell, keeping the current background.
    ///
    /// Keeping the background is what a terminal actually does for an erase, and
    /// getting it wrong shows as coloured bands left behind by a program that
    /// repainted its own region.
    pub fn clear(&mut self, background: Color) {
        for cell in &mut self.cells {
            *cell = Cell::blank();
            cell.background = background;
        }
    }

    /// Blank one row.
    pub fn clear_row(&mut self, row: u16, background: Color) {
        for cell in self.row_mut(row) {
            *cell = Cell::blank();
            cell.background = background;
        }
    }

    /// The mutable cells of one row.
    pub fn row_mut(&mut self, row: u16) -> &mut [Cell] {
        if row >= self.rows {
            return &mut [];
        }
        let start = row as usize * self.columns as usize;
        &mut self.cells[start..start + self.columns as usize]
    }

    /// Scroll the whole grid up by one line, returning the line that fell off.
    ///
    /// Returning the scrolled-off row rather than discarding it is what lets the
    /// caller push it into the scrollback; a grid that scrolls internally would
    /// have to grow a second history that can disagree with the primary one.
    pub fn scroll_up(&mut self) -> Vec<Cell> {
        let width = self.columns as usize;
        let dropped: Vec<Cell> = self.cells[..width].to_vec();
        // ASCENDING, copying row+1 into row. Scrolling up moves content toward row
        // 0 and vacates the bottom row.
        //
        // The order is load-bearing and the natural instinct is backwards: because
        // the destination (row) is always BELOW the source (row+1), iterating
        // ascending guarantees each source is still untouched when read. Iterating
        // descending reads row 1 after row 1 has been overwritten by row 2, so every
        // row ends up holding the same line.
        //
        // Row by row rather than `copy_within` over the flat buffer: `Cell` is not
        // `Copy`, so a flat shift would need a clone per cell.
        for row in 0..self.rows - 1 {
            let source: Vec<Cell> =
                self.cells[usize::from(row + 1) * width..usize::from(row + 2) * width].to_vec();
            for (offset, cell) in source.into_iter().enumerate() {
                self.cells[usize::from(row) * width + offset] = cell;
            }
        }
        for cell in &mut self.cells[(self.rows as usize - 1) * width..] {
            *cell = Cell::blank();
        }
        dropped
    }

    /// Resize the grid, preserving content.
    ///
    /// GROWING pads with blanks. SHRINKING discards what no longer fits rather than
    /// reflowing: a reflow would need to re-wrap every logical line and re-apply its
    /// SGR attributes across the new boundaries, and getting that wrong corrupts
    /// output in a way the operator cannot distinguish from a broken program.
    /// Truncation is also what a terminal with no reflow capability does, and
    /// `opencode` redraws on a SIGWINCH anyway.
    ///
    /// Returns the lines pushed to the scrollback, which shrinking discards.
    pub fn resize(&mut self, columns: u16, rows: u16) -> Vec<Vec<Cell>> {
        let columns = columns.max(1);
        let rows = rows.max(1);
        if columns == self.columns && rows == self.rows {
            return Vec::new();
        }

        let mut discarded = Vec::new();
        while self.rows > rows {
            discarded.push(self.scroll_up());
            self.rows -= 1;
        }

        let mut resized = Grid::new(columns, rows);
        for row in 0..self.rows {
            let source = self.row(row);
            for (column, cell) in source.iter().enumerate().take(columns as usize) {
                resized.set(column as u16, row, cell.clone());
            }
        }

        *self = resized;
        discarded
    }

    /// The flat index of `(column, row)`.
    fn index(&self, column: u16, row: u16) -> usize {
        row as usize * self.columns as usize + column as usize
    }

    /// The row stride cache, kept so the field is not dead weight.
    #[must_use]
    pub fn stride(&self, row: u16) -> usize {
        self.strides
            .get(row as usize)
            .copied()
            .unwrap_or(self.columns as usize)
    }
}

/// Split a grapheme cluster's display width into its cell count.
///
/// A wrapper rather than open-coding `UnicodeWidthStr` at each site, because the
/// floor at 1 is easy to forget and the failure -- a zero-width cell that swallows
/// a column and shifts every pane after it -- is invisible until something looks
/// subtly misaligned.
#[must_use]
pub fn cluster_width(cluster: &str) -> usize {
    UnicodeWidthStr::width(cluster).max(1)
}

/// How many grapheme clusters a string contains, for cursor advancement.
///
/// Counted in clusters rather than `chars()` because a combining mark must not
/// advance the cursor: it belongs to the cell before it.
#[must_use]
pub fn cluster_count(text: &str) -> usize {
    text.graphemes(true).count()
}

/// The text of a row, with continuation cells skipped.
///
/// Trailing blanks are trimmed, because a row scrolled off the top of a pane is
/// mostly padding and copying it into the clipboard with 200 trailing spaces makes
/// pasting it anywhere unpleasant.
#[must_use]
pub fn row_text(cells: &[Cell]) -> String {
    let mut text = String::new();
    for cell in cells {
        if let Some(grapheme) = &cell.grapheme {
            text.push_str(grapheme);
        }
    }
    text.trim_end().to_owned()
}
