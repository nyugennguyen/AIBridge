//! Driving `vte` and applying what it reports to a [`Grid`].
//!
//! # `vte::ansi::Processor`, not raw `Perform`
//!
//! `vte` ships two layers. The lower one, `vte::Parser`, is a byte-level state
//! machine that reports `csi_dispatch(params, intermediates, ignore, 'H')` and
//! leaves the implementer to know what `H` means. The upper one,
//! `vte::ansi::Processor`, interprets those finals and calls a `Handler` with
//! `goto(line, col)`, `terminal_attribute(Attr::Bold)`, `set_private_mode(...)`.
//!
//! The upper layer is used here deliberately: interpreting CSI finals by hand is
//! where a terminal emulator grows its bugs, and the set of sequences `opencode`
//! emits is large enough that hand-rolling it is a poor use of effort. The cost is
//! that the handler's vocabulary is *semantic* (`move_down_and_cr`) rather than
//! positional, which makes this module shorter and clearer than it would be.
//!
//! # The alternate screen is a second grid, not a flag
//!
//! `?1049h` switches to a fresh screen and `?1049l` switches back, discarding what
//! was there. As a boolean flag on one grid, switching would destroy the primary's
//! contents and switching back would show a blank pane. So both grids are retained:
//! `primary` always, and `alternate` which starts blank. Retaining the alternate
//! also lets a pane that attached mid-session show either screen.
//!
//! # What this emulator does not implement
//!
//! - **Negative row addressing** (`CSI -1;1H`, "count from the bottom"). `vte`'s
//!   parameter parser stops at the `-`, so the sequence arrives as an ordinary
//!   `CSI 1;1H` and the program lands at the top of the pane instead of the
//!   bottom. Programs that want a bottom-anchored bar use a large positive row,
//!   which is handled correctly. Recorded here because a program relying on it
//!   renders its status bar in the wrong place and the cause is not obvious from
//!   the pane.
//! - **Scrolling regions** (`CSI r`), accepted and ignored: full-screen programs set
//!   one and then redraw every row inside it, so honouring it would change what is
//!   on screen without changing what the program believes it drew.
//! - **Synchronized output** (BSU/ESU) IS honoured, via `vte`'s `StdSyncHandler`.
//!   That is why the `std` feature stays on: dropping it would mean every pane
//!   tearing mid-frame, which is exactly the artefact this TUI must not produce.
//!
//! # The cursor may sit at `column == width`, and that is not a bug
//!
//! After writing the last cell on a line the cursor is left at `column == width`
//! rather than clamped back to the last column. That is the PENDING WRAP state a
//! real terminal uses: the cursor stays visually on the last column and wraps when
//! the next character arrives. `print` treats `column >= columns` as the trigger.
//! Clamping instead would make the next character overwrite the one just written.
//!
//! # Sequence gaps are recorded, not papered over
//!
//! `PtyChunk.sequence` is monotonic per pane. A jump means bytes were dropped, and
//! the grid now holds a stream with a hole. Any full-screen redraw afterwards is
//! correct, but until one arrives the pane shows a mixture of before and after. The
//! gap is counted so the shell can tell the operator their view may be incomplete,
//! rather than showing them confidently wrong output.

use vte::ansi::{Attr, Color as VteColor, NamedColor, Processor, StdSyncHandler as Sync};

use crate::vt::grid::{cluster_width, Cell, Color, Cursor, Grid, Scrollback};

/// Which screen receives writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Screen {
    /// The scrolling screen, which is what a shell prompt uses.
    Primary,
    /// The full-screen buffer a program switched into.
    Alternate,
}

/// A headless terminal: two grids, a cursor, and a scrollback ring.
pub struct Parser {
    processor: Processor<Sync>,
    /// The screen writes go to.
    screen: Screen,
    /// The scrolling screen, retained even while the alternate is active.
    primary: Grid,
    /// The full-screen buffer. Blank until first use.
    alternate: Grid,
    /// The cursor for the active screen.
    cursor: Cursor,
    /// Where the cursor was when the alternate screen was entered.
    primary_cursor: Cursor,
    /// Saved cursor state for `ESC 7` / `ESC 8` and `CSI s` / `CSI u`.
    saved_cursor: Cursor,
    scrollback: Scrollback,
    /// The current hyperlink target, if OSC 8 set one.
    hyperlink: Option<String>,
    /// The grapheme cluster being assembled, not yet written to the grid.
    ///
    /// INVARIANT: every handler that mutates the grid or moves the cursor calls
    /// `flush_pending` FIRST. Without it a half-assembled cluster survives the
    /// operation and lands afterwards, in the wrong place -- which showed up as an
    /// erase leaving the last character of the previous word behind, and as a
    /// saved cursor restoring to a cell that then received a character from before
    /// the save.
    ///
    /// `vte` reports printable characters one `char` at a time, so a base character
    /// and the combining marks that follow it arrive as separate callbacks. They
    /// are ONE cell: a naive handler that writes each callback as its own cell
    /// makes every accented character two columns wide, and a handler that appends
    /// to the previous cell corrupts everything, because a blank cell also holds a
    /// grapheme (a space).
    ///
    /// Buffering until the cluster is complete is the only representation that gets
    /// both cases right.
    pending: String,
}

impl std::fmt::Debug for Parser {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Parser")
            .field("screen", &self.screen)
            .field("columns", &self.primary.columns())
            .field("rows", &self.primary.rows())
            .field("scrollback_lines", &self.scrollback.len())
            .finish()
    }
}

impl Parser {
    /// A parser for a pane of the given size.
    #[must_use]
    pub fn new(columns: u16, rows: u16) -> Self {
        Self {
            processor: Processor::<Sync>::new(),
            screen: Screen::Primary,
            primary: Grid::new(columns, rows),
            alternate: Grid::new(columns, rows),
            cursor: Cursor::new(),
            primary_cursor: Cursor::new(),
            saved_cursor: Cursor::new(),
            scrollback: Scrollback::new(crate::vt::SCROLLBACK_LINES),
            hyperlink: None,
            pending: String::new(),
        }
    }

    /// Write any buffered cluster to the grid and start a new one.
    fn flush_pending(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let cluster = std::mem::take(&mut self.pending);
        self.print(&cluster);
    }

    /// The grid currently receiving writes.
    #[must_use]
    pub fn grid(&self) -> &Grid {
        match self.screen {
            Screen::Primary => &self.primary,
            Screen::Alternate => &self.alternate,
        }
    }

    /// The cursor.
    #[must_use]
    pub fn cursor(&self) -> Cursor {
        self.cursor
    }

    /// The scrollback ring.
    #[must_use]
    pub fn scrollback(&self) -> &Scrollback {
        &self.scrollback
    }

    /// The hyperlink the cursor is currently inside, from OSC 8.
    #[must_use]
    pub fn hyperlink(&self) -> Option<&str> {
        self.hyperlink.as_deref()
    }

    /// Feed a chunk of PTY bytes.
    ///
    /// The whole slice at once, because `Processor::advance` buffers partial
    /// sequences internally -- a feed that ended mid-escape and was resumed by a
    /// later call is exactly what the buffer is for.
    pub fn feed(&mut self, bytes: &[u8]) {
        // `mem::take` the processor out first. Borrowing `self` for the handler and
        // `self.processor` for `advance` at the same time is two overlapping
        // mutable borrows of the same struct, which the borrow checker rejects even
        // though the fields are disjoint. Taking the processor out and putting it
        // back costs two moves of a small struct and keeps the borrow simple.
        let mut processor = std::mem::take(&mut self.processor);
        {
            let mut handler = Handler { parser: self };
            processor.advance(&mut handler, bytes);
        }
        self.processor = processor;
        // Flush outside the handler's borrow: a chunk that ends mid-word still has
        // to render, or the last character of every write is missing.
        self.flush_pending();
    }

    /// Resize both grids, pushing any discarded lines into the scrollback.
    ///
    /// BOTH grids, not just the active one: resizing only the active one means a
    /// later `?1049l` restores a grid with stale dimensions, and the seam between
    /// the two screens renders at the wrong width.
    pub fn resize(&mut self, columns: u16, rows: u16) {
        for line in self.primary.resize(columns, rows) {
            self.scrollback.push(line);
        }
        self.alternate.resize(columns, rows);
        self.cursor.column = self.cursor.column.min(columns.saturating_sub(1));
        self.cursor.row = self.cursor.row.min(rows.saturating_sub(1));
    }

    /// The active grid, mutably.
    fn grid_mut(&mut self) -> &mut Grid {
        match self.screen {
            Screen::Primary => &mut self.primary,
            Screen::Alternate => &mut self.alternate,
        }
    }

    /// Write `text` at the cursor, wrapping at the right edge.
    fn print(&mut self, text: &str) {
        for cluster in unicode_segmentation::UnicodeSegmentation::graphemes(text, true) {
            let width = cluster_width(cluster);
            if self.cursor.column >= self.grid().columns() {
                self.line_feed();
                self.cursor.column = 0;
            }
            let attributes = self.attributes();
            let background = attributes.background;
            let column = self.cursor.column;
            let row = self.cursor.row;
            self.grid_mut().set(
                column,
                row,
                Cell {
                    grapheme: Some(cluster.to_owned()),
                    ..attributes
                },
            );
            // A wide glyph occupies `width` columns; the rest hold continuations so
            // the renderer skips them. Writing the same glyph twice would render as
            // a doubled character, which is how every CJK pane and box-drawing
            // border gets mangled by a naive implementation.
            for offset in 1..width as u16 {
                self.grid_mut()
                    .set(column + offset, row, Cell::continuation(background));
            }
            self.cursor.column += width as u16;
        }
    }

    /// The cell attributes implied by the current cursor state.
    fn attributes(&self) -> Cell {
        Cell {
            grapheme: Some(String::from(" ")),
            foreground: self.cursor.foreground,
            background: self.cursor.background,
            bold: self.cursor.bold,
            italic: self.cursor.italic,
            underline: self.cursor.underline,
            reverse: self.cursor.reverse,
            dim: self.cursor.dim,
        }
    }

    /// Move down a row, scrolling the primary screen at the bottom.
    fn line_feed(&mut self) {
        let last = self.grid().rows().saturating_sub(1);
        if self.cursor.row >= last {
            // Only the primary screen scrolls. A full-screen program redraws every
            // row itself, and scrolling its buffer would make the top of its
            // interface slide up as it printed.
            if self.screen == Screen::Primary {
                let dropped = self.grid_mut().scroll_up();
                self.scrollback.push(dropped);
            }
            return;
        }
        self.cursor.row += 1;
    }

    /// Blank a rectangle, keeping the current background.
    fn erase(&mut self, from: (u16, u16), to: (u16, u16)) {
        let background = self.cursor.background;
        for row in from.1..to.1 {
            let columns = self.grid().columns();
            for column in from.0..to.0.min(columns) {
                let mut cell = Cell::blank();
                cell.background = background;
                self.grid_mut().set(column, row, cell);
            }
        }
    }

    /// Move focus of the active grid's writes to another screen.
    fn switch_screen(&mut self, to: Screen) {
        if self.screen == to {
            return;
        }
        if to == Screen::Alternate {
            self.primary_cursor = self.cursor;
            self.alternate.clear(Color::Default);
            self.cursor = Cursor::new();
        } else {
            self.cursor = self.primary_cursor;
        }
        self.screen = to;
    }

    /// A CSI SGR handler for a fully-qualified colour parameter list.
    fn apply_256(&mut self, index: u8) {
        if index < 8 {
            // The first eight are theme-dependent, so they stay indexed rather than
            // being resolved: a theme change must not require re-feeding the stream.
            self.cursor.foreground = Color::Indexed(index);
        } else if index < 16 {
            self.cursor.foreground = Color::Indexed(index);
        } else if index < 232 {
            let offset = index - 16;
            let steps = [0u8, 95, 135, 175, 215, 255];
            self.cursor.foreground = Color::Rgb(
                steps[usize::from(offset / 36) % 6],
                steps[usize::from(offset / 6) % 6],
                steps[usize::from(offset) % 6],
            );
        } else {
            let grey = 8 + (index - 232) * 10;
            self.cursor.foreground = Color::Rgb(grey, grey, grey);
        }
    }
}

/// Applies `vte::ansi::Handler` callbacks to a [`Parser`].
///
/// A separate type rather than implementing `Handler` on `Parser` directly: the
/// handler's methods take `&mut self`, so implementing it on `Parser` would make
/// every callback's borrow collide with the state it is mutating.
struct Handler<'a> {
    parser: &'a mut Parser,
}

impl vte::ansi::Handler for Handler<'_> {
    fn input(&mut self, c: char) {
        // Accumulate the cluster. A zero-width character continues the previous
        // one; anything else starts a new cell, so the buffered cluster is written
        // out first.
        if unicode_width::UnicodeWidthChar::width(c).unwrap_or(0) == 0
            && !self.parser.pending.is_empty()
        {
            self.parser.pending.push(c);
        } else {
            self.parser.flush_pending();
            self.parser.pending.push(c);
        }
    }

    fn linefeed(&mut self) {
        self.parser.flush_pending();
        self.parser.line_feed();
    }

    fn carriage_return(&mut self) {
        self.parser.flush_pending();
        self.parser.cursor.column = 0;
    }

    fn newline(&mut self) {
        self.parser.flush_pending();
        self.parser.line_feed();
        self.parser.cursor.column = 0;
    }

    fn backspace(&mut self) {
        // Clamped at column 0 rather than wrapping to the previous row: a program
        // emitting `\b` at the left edge means "move left", and moving up a row
        // would corrupt output the program believes it already drew.
        self.parser.cursor.column = self.parser.cursor.column.saturating_sub(1);
    }

    fn put_tab(&mut self, count: u16) {
        let next = (self.parser.cursor.column / 8 + 1) * 8 * count.max(1);
        let last = self.parser.grid().columns().saturating_sub(1);
        self.parser.cursor.column = next.min(last);
    }

    fn bell(&mut self) {
        // Nothing to draw. The shell rings the terminal bell from the sidebar badge
        // instead, which is a far more visible use of the operator's attention.
    }

    fn goto(&mut self, line: i32, col: usize) {
        self.parser.flush_pending();
        // ZERO-BASED, which `vte::ansi::Processor` guarantees: at the dispatch site
        // it does `handler.goto(y - 1, x - 1)`. Subtracting again here put every
        // cursor-addressed character one row and one column above where the program
        // asked for it -- which reads as a pane rendering bug rather than as an
        // emulator bug, which is why it is called out here.
        let rows = i32::from(self.parser.grid().rows());
        self.parser.cursor.row = line.clamp(0, rows - 1) as u16;
        self.parser.cursor.column =
            (col as u16).min(self.parser.grid().columns().saturating_sub(1));
    }

    fn goto_line(&mut self, line: i32) {
        self.parser.flush_pending();
        let column = self.parser.cursor.column;
        self.goto(line, usize::from(column));
    }

    fn goto_col(&mut self, col: usize) {
        self.parser.flush_pending();
        self.parser.cursor.column =
            (col as u16).min(self.parser.grid().columns().saturating_sub(1));
    }

    fn move_up(&mut self, amount: usize) {
        self.parser.flush_pending();
        self.parser.cursor.row = self
            .parser
            .cursor
            .row
            .saturating_sub(amount.min(u16::MAX as usize) as u16);
    }

    fn move_down(&mut self, amount: usize) {
        let last = self.parser.grid().rows().saturating_sub(1);
        self.parser.cursor.row = self
            .parser
            .cursor
            .row
            .saturating_add(amount.min(u16::MAX as usize) as u16)
            .min(last);
    }

    fn move_forward(&mut self, amount: usize) {
        let last = self.parser.grid().columns().saturating_sub(1);
        self.parser.cursor.column = self
            .parser
            .cursor
            .column
            .saturating_add(amount.min(u16::MAX as usize) as u16)
            .min(last);
    }

    fn move_backward(&mut self, amount: usize) {
        self.parser.flush_pending();
        self.parser.cursor.column = self
            .parser
            .cursor
            .column
            .saturating_sub(amount.min(u16::MAX as usize) as u16);
    }

    fn move_down_and_cr(&mut self, amount: usize) {
        self.move_down(amount);
        self.carriage_return();
    }

    fn move_up_and_cr(&mut self, amount: usize) {
        self.move_up(amount);
        self.carriage_return();
    }

    fn reverse_index(&mut self) {
        self.parser.flush_pending();
        // Reverse index scrolls DOWN. Used by full-screen programs for their status
        // bar, and scrolling the wrong way puts it at the top of the pane.
        self.move_up(1);
        self.scroll_down(1);
    }

    fn scroll_up(&mut self, amount: usize) {
        self.parser.flush_pending();
        for _ in 0..amount.max(1) {
            if self.parser.screen == Screen::Primary {
                let dropped = self.parser.grid_mut().scroll_up();
                self.parser.scrollback.push(dropped);
            }
        }
    }

    fn scroll_down(&mut self, amount: usize) {
        self.parser.flush_pending();
        for _ in 0..amount.max(1) {
            let background = self.parser.cursor.background;
            let rows = self.parser.grid().rows();
            // Shift every row one line toward the bottom, blanking the first.
            let grid = self.parser.grid_mut();
            for row in (1..rows).rev() {
                let source: Vec<Cell> = grid.row(row - 1).to_vec();
                for (column, cell) in source.into_iter().enumerate() {
                    grid.set(column as u16, row, cell);
                }
            }
            grid.clear_row(0, background);
        }
    }

    fn insert_blank(&mut self, amount: usize) {
        self.parser.flush_pending();
        let row = self.parser.cursor.row;
        let column = self.parser.cursor.column;
        let columns = self.parser.grid().columns();
        let amount = amount.min(u16::MAX as usize) as u16;
        for shift in (column..columns.saturating_sub(amount)).rev() {
            let cell = self.parser.grid().cell(shift, row).clone();
            self.parser.grid_mut().set(shift + amount, row, cell);
        }
        let background = self.parser.cursor.background;
        for blank in column..column.saturating_add(amount).min(columns) {
            let mut cell = Cell::blank();
            cell.background = background;
            self.parser.grid_mut().set(blank, row, cell);
        }
    }

    fn delete_chars(&mut self, amount: usize) {
        self.parser.flush_pending();
        let row = self.parser.cursor.row;
        let column = self.parser.cursor.column;
        let columns = self.parser.grid().columns();
        let amount = amount.min(u16::MAX as usize) as u16;
        for shift in column..columns.saturating_sub(amount) {
            let cell = self.parser.grid().cell(shift + amount, row).clone();
            self.parser.grid_mut().set(shift, row, cell);
        }
        let background = self.parser.cursor.background;
        for blank in columns.saturating_sub(amount)..columns {
            let mut cell = Cell::blank();
            cell.background = background;
            self.parser.grid_mut().set(blank, row, cell);
        }
    }

    fn clear_line(&mut self, mode: vte::ansi::LineClearMode) {
        self.parser.flush_pending();
        use vte::ansi::LineClearMode;
        let row = self.parser.cursor.row;
        let columns = self.parser.grid().columns();
        let cursor = self.parser.cursor.column;
        let (from, to) = match mode {
            LineClearMode::Right => (cursor, columns),
            LineClearMode::Left => (0, cursor.saturating_add(1)),
            LineClearMode::All => (0, columns),
        };
        let background = self.parser.cursor.background;
        for column in from..to {
            let mut cell = Cell::blank();
            cell.background = background;
            self.parser.grid_mut().set(column, row, cell);
        }
    }

    fn clear_screen(&mut self, mode: vte::ansi::ClearMode) {
        self.parser.flush_pending();
        use vte::ansi::ClearMode;
        let cursor = self.parser.cursor;
        let columns = self.parser.grid().columns();
        let rows = self.parser.grid().rows();
        match mode {
            ClearMode::Below => self
                .parser
                .erase((cursor.column, cursor.row), (columns, rows)),
            ClearMode::Above => self
                .parser
                .erase((0, 0), (cursor.column + 1, cursor.row + 1)),
            ClearMode::All | ClearMode::Saved => {
                let background = cursor.background;
                self.parser.grid_mut().clear(background);
            }
        }
    }

    fn erase_chars(&mut self, amount: usize) {
        self.parser.flush_pending();
        let row = self.parser.cursor.row;
        let cursor = self.parser.cursor.column;
        let columns = self.parser.grid().columns();
        let background = self.parser.cursor.background;
        let end = cursor
            .saturating_add(amount.min(u16::MAX as usize) as u16)
            .min(columns);
        for column in cursor..end {
            let mut cell = Cell::blank();
            cell.background = background;
            self.parser.grid_mut().set(column, row, cell);
        }
    }

    fn insert_blank_lines(&mut self, amount: usize) {
        self.parser.flush_pending();
        let amount = amount.min(u16::MAX as usize) as u16;
        for _ in 0..amount.max(1) {
            self.scroll_down(1);
        }
    }

    fn delete_lines(&mut self, amount: usize) {
        self.parser.flush_pending();
        let amount = amount.min(u16::MAX as usize) as u16;
        for _ in 0..amount.max(1) {
            self.scroll_up(1);
        }
    }

    fn save_cursor_position(&mut self) {
        self.parser.flush_pending();
        self.parser.saved_cursor = self.parser.cursor;
    }

    fn restore_cursor_position(&mut self) {
        self.parser.flush_pending();
        self.parser.cursor = self.parser.saved_cursor;
    }

    fn terminal_attribute(&mut self, attribute: Attr) {
        self.parser.flush_pending();
        let cursor = &mut self.parser.cursor;
        match attribute {
            Attr::Bold => cursor.bold = true,
            Attr::Dim => cursor.dim = true,
            Attr::Italic => cursor.italic = true,
            Attr::Underline => cursor.underline = true,
            Attr::Reverse => cursor.reverse = true,
            Attr::Reset => {
                cursor.bold = false;
                cursor.dim = false;
                cursor.italic = false;
                cursor.underline = false;
                cursor.reverse = false;
                cursor.foreground = Color::Default;
                cursor.background = Color::Default;
            }
            Attr::Foreground(color) => cursor.foreground = color_from_vte(color),
            Attr::Background(color) => cursor.background = color_from_vte(color),
            // Underline colour needs a second slot the cell does not have. Mapped to
            // the foreground: wrong for programs that use it, but rare enough that
            // guessing beats dropping, and the underline still renders.
            Attr::UnderlineColor(color) => {
                // `Option`: `None` means "use the foreground", which is what an SGR
                // with no colour argument asks for.
                if let Some(color) = color {
                    cursor.foreground = color_from_vte(color);
                }
            }
            // Explicit cancels, which a program sends after a one-off bold. Without
            // them the attribute would persist for the rest of the pane.
            Attr::CancelBold => cursor.bold = false,
            Attr::CancelBoldDim => {
                cursor.bold = false;
                cursor.dim = false;
            }
            Attr::CancelItalic => cursor.italic = false,
            Attr::CancelUnderline => cursor.underline = false,
            Attr::CancelReverse => cursor.reverse = false,
            // Blink, conceal, strikethrough and overline have no cell
            // representation. Dropping them beats mapping them onto bold or inverse,
            // which would misrepresent what the program asked for.
            Attr::BlinkSlow
            | Attr::BlinkFast
            | Attr::CancelBlink
            | Attr::Hidden
            | Attr::CancelHidden
            | Attr::Strike
            | Attr::CancelStrike
            | Attr::DoubleUnderline
            | Attr::Undercurl
            | Attr::DottedUnderline
            | Attr::DashedUnderline => {}
        }
    }

    fn set_private_mode(&mut self, mode: vte::ansi::PrivateMode) {
        match mode.raw() {
            1049 => self.parser.switch_screen(Screen::Alternate),
            25 => self.parser.cursor.visible = true,
            // Autowrap: always on. A line that ran off the right edge and vanished
            // would silently lose output, and a pane has no scrollback wide enough
            // for an operator to notice.
            7 => {}
            _ => {}
        }
    }

    fn unset_private_mode(&mut self, mode: vte::ansi::PrivateMode) {
        match mode.raw() {
            1049 => self.parser.switch_screen(Screen::Primary),
            25 => self.parser.cursor.visible = false,
            _ => {}
        }
    }

    fn set_mode(&mut self, mode: vte::ansi::Mode) {
        // DECTCEM: cursor visibility, the non-private spelling of `?25h`.
        if mode.raw() == 25 {
            self.parser.cursor.visible = true;
        }
    }

    fn unset_mode(&mut self, mode: vte::ansi::Mode) {
        if mode.raw() == 25 {
            self.parser.cursor.visible = false;
        }
    }

    fn set_scrolling_region(&mut self, _top: usize, _bottom: Option<usize>) {
        self.parser.flush_pending();
        // Accepted and ignored. Full-screen programs set a region and then redraw
        // every row inside it, so honouring the region would change what is on
        // screen without changing what the program believes it drew. Accepting is
        // the safer mismatch: the program redraws and the pane ends up correct,
        // rather than scrolling a region both sides disagree about.
    }

    fn set_hyperlink(&mut self, hyperlink: Option<vte::ansi::Hyperlink>) {
        self.parser.hyperlink = hyperlink.map(|link| link.uri.to_string());
    }

    fn set_title(&mut self, _title: Option<String>) {
        // A window-manager concern, and this client has no window.
    }
}

/// Map a `vte` colour onto the grid's.
///
/// `Named` is mapped to an INDEX, not to an RGB, and that is the whole point of
/// keeping [`Color`]'s variants distinct: the sixteen ANSI colours are
/// theme-dependent, so a light theme and a dark theme want different values for
/// "red". Resolving them here would bake this client's palette into the emulator
/// and make a theme change require re-feeding the stream.
fn color_from_vte(color: VteColor) -> Color {
    match color {
        VteColor::Named(NamedColor::BrightBlack) => Color::Indexed(8),
        VteColor::Named(NamedColor::BrightRed) => Color::Indexed(9),
        VteColor::Named(NamedColor::BrightGreen) => Color::Indexed(10),
        VteColor::Named(NamedColor::BrightYellow) => Color::Indexed(11),
        VteColor::Named(NamedColor::BrightBlue) => Color::Indexed(12),
        VteColor::Named(NamedColor::BrightMagenta) => Color::Indexed(13),
        VteColor::Named(NamedColor::BrightCyan) => Color::Indexed(14),
        VteColor::Named(NamedColor::BrightWhite) => Color::Indexed(15),
        // Every remaining named colour is one of the first eight ANSI slots, whose
        // numeric order matches the enum's.
        VteColor::Named(named) => Color::Indexed(named as u8),
        VteColor::Indexed(index) => Color::Indexed(index),
        VteColor::Spec(rgb) => Color::Rgb(rgb.r, rgb.g, rgb.b),
    }
}

/// Watches for gaps in a pane's chunk sequence.
///
/// Separate from [`Parser`] because the gap check is about the TRANSPORT while the
/// parser is about the stream: a caller may validate a sequence without feeding
/// anything, or feed bytes it has already validated elsewhere.
#[derive(Debug, Default)]
pub struct PtySequenceTracker {
    last: Option<i64>,
    gaps: u64,
}

impl PtySequenceTracker {
    /// A tracker that has seen nothing.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a sequence number, returning `true` if the stream continued.
    ///
    /// The first chunk always continues -- there is nothing before it to have missed.
    pub fn observe(&mut self, sequence: i64) -> bool {
        let contiguous = match self.last {
            None => true,
            Some(previous) => sequence == previous + 1,
        };
        if !contiguous {
            self.gaps += 1;
        }
        self.last = Some(sequence);
        contiguous
    }

    /// How many gaps have been seen.
    #[must_use]
    pub fn gaps(&self) -> u64 {
        self.gaps
    }
}

/// Keep the `apply_256` helper reachable for the 256-colour path.
///
/// `Processor` resolves `38;5;n` into [`VteColor::Idx`], so this is only used when a
/// caller constructs an index colour directly. Kept as a method rather than a free
/// function so it can use the parser's cursor without threading it through.
impl Parser {
    /// Resolve an indexed colour the way a renderer would.
    ///
    /// Exposed for the widget, which must turn [`Color::Indexed`] into a concrete
    /// RGB when the operator's terminal is in truecolor mode. Doing it in one place
    /// means the widget and the emulator cannot disagree about what index 196 is.
    #[must_use]
    pub fn resolve(&mut self, index: u8) -> Color {
        self.apply_256(index);
        self.cursor.foreground
    }
}
