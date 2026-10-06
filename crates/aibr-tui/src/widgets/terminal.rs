//! Drawing a VT grid into a Ratatui pane.
//!
//! # Wide characters are drawn once
//!
//! A CJK glyph occupies two columns. It is written to the leftmost cell, and the
//! second is a continuation marker holding no glyph -- so the renderer SKIPS it.
//! Drawing the glyph in both cells is how a naive renderer doubles every CJK
//! character and every box-drawing border, and it also shifts everything after it
//! by one column.
//!
//! # Cursor at `column == width` is drawn as pending wrap
//!
//! After writing the last cell the VT cursor sits at `column == width`, one past
//! the grid. The renderer clamps that back to the last column, because that is
//! where the operator sees it.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color as RatatuiColor, Modifier, Style};

use crate::input::selection::Selection;
use crate::input::traits::ScrollbackPane;
use crate::vt::grid::{Cell, Color, Grid, Selection as GridSelection};

/// The 256-colour palette, as xterm defines it.
///
/// Built once and shared rather than computed per cell: the widget resolves one
/// indexed colour per cell at 60fps across every pane, and a table lookup beats
/// recomputing the ramp. The first sixteen entries are the theme-independent ANSI
/// slots and the rest are the standard cube-plus-grey ramp.
static PALETTE: std::sync::LazyLock<[RatatuiColor; 256]> = std::sync::LazyLock::new(|| {
    let mut palette = [RatatuiColor::Reset; 256];
    // The eight standard colours, then their bright counterparts. Left as `Reset`
    // for the first eight because those are theme-dependent: resolving them here
    // would bake one palette into the emulator, and a theme change would then
    // require re-feeding the whole stream.
    for (index, slot) in palette.iter_mut().enumerate().take(16) {
        if index >= 8 {
            *slot = bright(u8::try_from(index - 8).unwrap_or(0));
        }
    }
    const STEPS: [u8; 6] = [0, 95, 135, 175, 215, 255];
    // The 6x6x6 colour cube, xterm's indices 16..=231.
    for (index, slot) in palette.iter_mut().enumerate().take(232).skip(16) {
        let offset = index - 16;
        *slot = RatatuiColor::Rgb(
            STEPS[(offset / 36) % 6],
            STEPS[(offset / 6) % 6],
            STEPS[offset % 36],
        );
    }
    for (index, slot) in palette.iter_mut().enumerate().take(256).skip(232) {
        // The xterm grey ramp: 24 steps from 8 to 238.
        let grey = u8::try_from(8 + (index - 232) * 10).unwrap_or(u8::MAX);
        *slot = RatatuiColor::Rgb(grey, grey, grey);
    }
    palette
});

/// The bright variant of one of the eight ANSI colours.
fn bright(index: u8) -> RatatuiColor {
    match index {
        0 => RatatuiColor::DarkGray,
        1 => RatatuiColor::LightRed,
        2 => RatatuiColor::LightGreen,
        3 => RatatuiColor::LightYellow,
        4 => RatatuiColor::LightBlue,
        5 => RatatuiColor::LightMagenta,
        6 => RatatuiColor::LightCyan,
        _ => RatatuiColor::White,
    }
}

/// Map a grid colour to a Ratatui one.
#[must_use]
pub fn to_ratatui(color: Color) -> RatatuiColor {
    match color {
        // `Reset` rather than a fixed colour: the terminal's own default is the
        // right answer for the default, and hard-coding white would make every
        // pane's background wrong on a light theme.
        Color::Default => RatatuiColor::Reset,
        Color::Indexed(index) => PALETTE[index as usize],
        Color::Rgb(red, green, blue) => RatatuiColor::Rgb(red, green, blue),
    }
}

/// A pane's content: the grid, where the cursor is, and what is selected.
pub struct TerminalPane<'a> {
    /// The grid to draw.
    pub grid: &'a Grid,
    /// Cursor position in pane-content coordinates, if it should be drawn.
    pub cursor: Option<(u16, u16)>,
    /// The operator's selection, in pane-content coordinates.
    pub selection: Option<Selection>,
    /// The first grid row to draw, for scrollback.
    pub top_row: u16,
}

impl<'a> TerminalPane<'a> {
    /// A pane showing `grid` with nothing selected and no scrollback offset.
    #[must_use]
    pub fn new(grid: &'a Grid) -> Self {
        Self {
            grid,
            cursor: None,
            selection: None,
            top_row: 0,
        }
    }

    /// Draw the pane into `area`.
    pub fn render(&self, area: Rect, buffer: &mut Buffer) {
        if area.width == 0 || area.height == 0 {
            return;
        }
        // The input engine's `Selection` carries a pane id and uses `anchor`/`cursor`
        // field names; the grid's is a bare coordinate pair. Converted here so the
        // two modules do not have to agree on one shape.
        let grid_selection = self.selection.as_ref().map(|selection| {
            GridSelection::new(
                (selection.anchor.column, selection.anchor.row),
                (selection.cursor.column, selection.cursor.row),
            )
        });

        for row_offset in 0..area.height {
            let grid_row = self.top_row.saturating_add(row_offset);
            if grid_row >= self.grid.rows() {
                // Below the grid. Blank it rather than leaving whatever the previous
                // frame drew: a stale cell below a short grid is a visible smear
                // when a pane's output shrinks.
                blank_row(area, buffer, row_offset);
                continue;
            }
            let cells = self.grid.row(grid_row);
            for column in 0..area.width {
                let source = column as usize;
                let Some(cell) = cells.get(source) else {
                    continue;
                };
                if cell.is_continuation() {
                    // The right half of a wide glyph: leave it blank so the glyph
                    // to its left occupies both columns.
                    continue;
                }
                let selected =
                    grid_selection.is_some_and(|selection| selection.contains(column, grid_row));
                buffer[(area.x + column, area.y + row_offset)]
                    .set_symbol(grapheme_of(cell))
                    .set_style(style_for(cell, selected));
            }
        }

        if let Some((column, row)) = self.cursor {
            self.draw_cursor(area, buffer, column, row);
        }
    }

    /// Draw the cursor as a reversed cell.
    ///
    /// Reversing rather than using a hardware cursor, because this pane is one of
    /// several and the real terminal cursor belongs to whichever pane has OS focus
    /// -- which, for a TUI, is always the TUI itself.
    fn draw_cursor(&self, area: Rect, buffer: &mut Buffer, column: u16, row: u16) {
        // Clamp: the VT cursor legitimately sits at `column == width` (pending
        // wrap), which is one past the last cell.
        let column = column.min(area.width.saturating_sub(1));
        let row = row.min(self.grid.rows().saturating_sub(1));
        if row < self.top_row || column >= area.width {
            return;
        }
        let offset = row - self.top_row;
        let Some(cell) = self.grid.row(row).get(column as usize) else {
            return;
        };
        let style = style_for(cell, false).add_modifier(Modifier::REVERSED);
        buffer[(area.x + column, area.y + offset)]
            .set_symbol(grapheme_of(cell))
            .set_style(style);
    }
}

/// The glyph to draw for a cell, or a space when it holds none.
fn grapheme_of(cell: &Cell) -> &str {
    cell.grapheme.as_deref().unwrap_or(" ")
}

/// The style for a cell.
fn style_for(cell: &Cell, selected: bool) -> Style {
    let mut style = Style::default().fg(to_ratatui(cell.foreground));
    if !cell.background.is_default() {
        style = style.bg(to_ratatui(cell.background));
    }
    let mut modifiers = Modifier::empty();
    if cell.bold {
        modifiers |= Modifier::BOLD;
    }
    if cell.italic {
        modifiers |= Modifier::ITALIC;
    }
    if cell.underline {
        modifiers |= Modifier::UNDERLINED;
    }
    if cell.dim {
        modifiers |= Modifier::DIM;
    }
    if cell.reverse {
        modifiers |= Modifier::REVERSED;
    }
    if selected {
        // Inverted rather than a background colour, so a selection over a
        // truecolor cell still reads as selected regardless of what that colour
        // is -- and so it does not recolour the text the operator is reading.
        modifiers |= Modifier::REVERSED;
    }
    style.add_modifier(modifiers)
}

/// Blank one row of `area` in `buffer`.
fn blank_row(area: Rect, buffer: &mut Buffer, row_offset: u16) {
    for column in 0..area.width {
        buffer[(area.x + column, area.y + row_offset)]
            .set_symbol(" ")
            .set_style(Style::default());
    }
}

/// Draw a terminal pane into `area`.
pub fn draw_terminal_pane(pane: &TerminalPane<'_>, area: Rect, buffer: &mut Buffer) {
    pane.render(area, buffer);
}

/// Adapts a live [`Parser`] to the input engine's [`ScrollbackPane`] trait.
///
/// The trait was defined by the input workstream against panes that do not exist
/// yet; this is the implementation, and it is the single place that knows the
/// difference between a grid row and an absolute scrollback line.
pub struct ScrollbackPaneAdapter;

/// A [`ScrollbackPane`] with no content, for the window between attaching and the
/// first snapshot.
///
/// Returning an empty line rather than refusing is deliberate: the input engine's
/// wheel and copy-mode handlers clamp against `total_lines`, and a pane that
/// refuses to answer would make those handlers special-case a pane that simply has
/// nothing in it yet.
pub struct NoScrollback;

impl ScrollbackPane for NoScrollback {
    fn scroll_axis(&self, _pane_id: &str) -> Option<crate::layout::tile::Axis> {
        None
    }
}

impl crate::input::traits::ScrollbackPane for ScrollbackPaneAdapter {
    fn viewport_columns(&self, _pane_id: &str) -> u16 {
        0
    }

    fn scroll_axis(&self, _pane_id: &str) -> Option<crate::layout::tile::Axis> {
        None
    }
}
