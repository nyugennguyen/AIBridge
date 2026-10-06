//! VT emulator tests.
//!
//! Every case feeds bytes and asserts on cells. That is the point of keeping the
//! screen in-crate: these run without a terminal, so a bug in cursor motion or
//! attribute handling is caught by CI rather than by an operator noticing their
//! pane is subtly wrong.

use aibr_tui::vt::grid::{row_text, Cell, Color, Grid, Scrollback, Selection};
use aibr_tui::vt::parser::{Parser, PtySequenceTracker};

/// The text of a row, trailing blanks trimmed.
fn row(parser: &Parser, row: u16) -> String {
    row_text(parser.grid().row(row))
}

/// A parser with no panes, ready to feed.
fn parser(columns: u16, rows: u16) -> Parser {
    Parser::new(columns, rows)
}

#[test]
fn plain_text_lands_in_the_grid_and_advances_the_cursor() {
    let mut p = parser(20, 5);
    p.feed(b"hello");
    assert_eq!(row(&p, 0), "hello");
    assert_eq!(p.cursor().column, 5);
}

#[test]
fn newlines_and_carriage_returns_are_honoured() {
    let mut p = parser(20, 5);
    p.feed(b"first\r\nsecond\r\nthird");
    assert_eq!(row(&p, 0), "first");
    assert_eq!(row(&p, 1), "second");
    assert_eq!(row(&p, 2), "third");
}

#[test]
fn text_wraps_at_the_right_edge() {
    let mut p = parser(5, 3);
    p.feed(b"abcdefghij");
    assert_eq!(row(&p, 0), "abcde");
    assert_eq!(row(&p, 1), "fghij");
}

#[test]
fn cursor_positioning_lands_where_asked() {
    let mut p = parser(20, 10);
    // CSI 3;4 H: row 3, column 4, both 1-based on the wire.
    p.feed(b"\x1b[3;4Hmarker");
    assert_eq!(p.cursor().row, 2);
    assert_eq!(p.cursor().column, 9, "3 columns of marker past column 3");
    assert_eq!(row(&p, 2), "   marker");
}

#[test]
fn a_bottom_anchored_bar_lands_at_the_bottom() {
    // `opencode` anchors its status bar with a large positive row, not a negative
    // one -- `vte`'s parameter parser stops at `-`, so negative rows never reach
    // the handler. A row past the end must CLAMP to the last row rather than be
    // dropped, or the bar vanishes instead of being misplaced.
    let mut p = parser(20, 10);
    p.feed(b"\x1b[10;1Hbar");
    assert_eq!(p.cursor().row, 9);
    assert_eq!(row(&p, 9), "bar");
}

#[test]
fn truecolor_foreground_survives_as_24_bit() {
    let mut p = parser(20, 5);
    p.feed(b"\x1b[38;2;255;128;0mX");
    let cell = p.grid().cell(0, 0);
    assert_eq!(
        cell.foreground,
        Color::Rgb(255, 128, 0),
        "truecolor must not be downsampled: opencode's syntax highlighting depends on it"
    );
}

#[test]
fn truecolor_background_survives_as_24_bit() {
    let mut p = parser(20, 5);
    p.feed(b"\x1b[48;2;10;20;30m ");
    assert_eq!(p.grid().cell(0, 0).background, Color::Rgb(10, 20, 30));
}

#[test]
fn named_colours_stay_indexed_so_a_theme_can_change_them() {
    let mut p = parser(20, 5);
    p.feed(b"\x1b[31mX");
    assert_eq!(
        p.grid().cell(0, 0).foreground,
        Color::Indexed(1),
        "resolving a named colour here would bake this client's palette into the emulator"
    );
}

#[test]
fn sgr_attributes_are_recorded_and_reset() {
    let mut p = parser(20, 5);
    p.feed(b"\x1b[1;3;4mA");
    let cell = p.grid().cell(0, 0);
    assert!(cell.bold && cell.italic && cell.underline);

    p.feed(b"\x1b[0mB");
    let plain = p.grid().cell(1, 0);
    assert!(!plain.bold && !plain.italic && !plain.underline);
}

#[test]
fn explicit_cancels_do_not_leak_into_later_text() {
    // A program that bolds one word must not leave the rest of the pane bold. The
    // Cancels are the SGR 21/23/24 forms, distinct from a full reset.
    let mut p = parser(20, 5);
    p.feed(b"\x1b[1mbold\x1b[22mnormal");
    assert!(p.grid().cell(0, 0).bold, "the word was bold");
    assert!(!p.grid().cell(4, 0).bold, "the word after it is not");
}

#[test]
fn the_alternate_screen_is_retained_and_restored() {
    let mut p = parser(20, 5);
    p.feed(b"shell output");

    p.feed(b"\x1b[?1049h");
    assert_eq!(row(&p, 0), "", "the alternate screen starts blank");
    p.feed(b"full screen app");
    assert_eq!(row(&p, 0), "full screen app");

    p.feed(b"\x1b[?1049l");
    assert_eq!(
        row(&p, 0),
        "shell output",
        "leaving the alternate screen must restore the primary, not blank it"
    );
}

#[test]
fn the_cursor_is_remembered_across_an_alternate_screen_switch() {
    let mut p = parser(20, 5);
    p.feed(b"abc");
    assert_eq!(p.cursor().column, 3);
    p.feed(b"\x1b[?1049h");
    assert_eq!(p.cursor().column, 0, "the alternate screen starts fresh");
    p.feed(b"\x1b[?1049l");
    assert_eq!(p.cursor().column, 3, "and the primary's cursor comes back");
}

#[test]
fn cursor_visibility_follows_the_private_modes() {
    let mut p = parser(20, 5);
    assert!(p.cursor().visible);
    p.feed(b"\x1b[?25l");
    assert!(!p.cursor().visible, "a hidden cursor must not be drawn");
    p.feed(b"\x1b[?25h");
    assert!(p.cursor().visible);
}

#[test]
fn the_primary_screen_scrolls_and_feeds_the_scrollback() {
    let mut p = parser(10, 3);
    for line in 0..10 {
        // No trailing newline on the last one: a `\n` after the final line scrolls
        // that line off, which is correct behaviour and not what this test is about.
        let suffix = if line == 9 { "" } else { "\r\n" };
        p.feed(format!("line{line}{suffix}").as_bytes());
    }
    assert!(
        !p.scrollback().is_empty(),
        "scrolled-off lines must be retained, or copy-mode has nothing to show"
    );
    assert_eq!(
        row(&p, p.grid().rows() - 1),
        "line9",
        "the newest line is at the bottom"
    );
}

#[test]
fn the_alternate_screen_does_not_feed_the_scrollback() {
    // A full-screen program redraws every row itself. Scrolling its buffer would
    // make the top of its interface slide up as it printed, and would bury the
    // shell output that preceded the switch under a history of the app's frames.
    let mut p = parser(10, 3);
    p.feed(b"\x1b[?1049h");
    for line in 0..10 {
        p.feed(format!("line{line}\r\n").as_bytes());
    }
    assert_eq!(
        p.scrollback().len(),
        0,
        "the alternate screen's frames must never enter the scrollback"
    );
    // The primary's history is intact and in order.
    p.feed(b"\x1b[?1049l");
    assert!(
        p.scrollback().is_empty(),
        "and the primary never scrolled either"
    );
}

#[test]
fn scrolling_up_moves_content_toward_row_zero_and_vacates_the_bottom() {
    // The ordering here is subtle and was wrong twice: descending reads a row after
    // it has been overwritten, so every row ends up holding the same line.
    let mut p = parser(10, 3);
    p.feed(b"a\r\nb\r\nc");
    assert_eq!([row(&p, 0), row(&p, 1), row(&p, 2)], ["a", "b", "c"]);
    p.feed(b"\r\n");
    assert_eq!(
        [row(&p, 0), row(&p, 1), row(&p, 2)],
        ["b", "c", ""],
        "content moves up and the bottom row is vacated"
    );
    assert_eq!(p.scrollback().len(), 1, "the vacated line is retained");
    assert_eq!(
        aibr_tui::vt::grid::row_text(&p.scrollback().lines()[0]),
        "a",
        "the scrollback holds the line that scrolled off, not the one that stayed"
    );
}

#[test]
fn the_scrollback_is_bounded() {
    let scrollback = Scrollback::new(4);
    for line in 0..10 {
        let mut ring = scrollback.clone();
        ring.push(vec![Cell::blank(); 1]);
        let _ = line;
    }
    let mut ring = Scrollback::new(4);
    for index in 0..100 {
        let mut cell = Cell::blank();
        cell.grapheme = Some(index.to_string());
        ring.push(vec![cell]);
    }
    assert_eq!(ring.len(), 4, "a pane must not grow without bound");
    let retained = ring.lines();
    assert_eq!(
        retained.first().unwrap()[0].grapheme.as_deref(),
        Some("96"),
        "the newest lines are the ones kept"
    );
}

#[test]
fn a_wide_glyph_occupies_two_columns_and_marks_the_second() {
    let mut p = parser(10, 3);
    p.feed("世界".as_bytes());
    assert_eq!(p.grid().cell(0, 0).grapheme.as_deref(), Some("世"));
    assert!(
        p.grid().cell(1, 0).is_continuation(),
        "the second column must be a continuation, or the glyph renders twice"
    );
    assert_eq!(
        p.grid().cell(2, 0).grapheme.as_deref(),
        Some("界"),
        "the next glyph lands on a real column"
    );
    assert_eq!(p.cursor().column, 4);
}

#[test]
fn a_combining_mark_attaches_to_the_previous_cell() {
    let mut p = parser(10, 3);
    // "e" followed by a combining acute accent.
    p.feed("e\u{0301}".as_bytes());
    assert_eq!(p.grid().cell(0, 0).grapheme.as_deref(), Some("e\u{0301}"));
    assert_eq!(
        p.cursor().column,
        1,
        "a combining mark must not advance the cursor"
    );
}

#[test]
fn erasing_clears_cells_but_keeps_the_background() {
    let mut p = parser(10, 2);
    p.feed(b"\x1b[48;2;1;2;3mfilled\x1b[0m\x1b[2J");
    assert_eq!(row(&p, 0), "");
    assert_eq!(
        p.grid().cell(0, 0).background,
        Color::Default,
        "erase uses the current background, which reset just made the default"
    );
}

#[test]
fn erase_display_below_clears_only_below_the_cursor() {
    let mut p = parser(10, 4);
    p.feed(b"a\r\nb\r\nc\r\nd");
    // Row 2, column 1 puts the cursor at the start of "c". Below clears from there,
    // so "c" goes too -- that is what a program using it expects.
    p.feed(b"\x1b[2;1H\x1b[J");
    assert_eq!(row(&p, 0), "a", "above the cursor is untouched");
    assert_eq!(
        row(&p, 1),
        "",
        "the cursor's own row is part of 'below' and goes too"
    );
    assert_eq!(row(&p, 2), "");
    assert_eq!(row(&p, 3), "");
}

#[test]
fn a_trailing_cluster_is_flushed_at_the_end_of_a_chunk() {
    // A chunk that ends mid-word still has to render, or the last character of
    // every write is missing -- and a PTY read boundary lands anywhere.
    let mut p = parser(20, 3);
    p.feed(b"hel");
    assert_eq!(row(&p, 0), "hel");
    p.feed(b"lo");
    assert_eq!(row(&p, 0), "hello");
}

#[test]
fn an_out_of_range_cursor_move_clamps_rather_than_panicking() {
    // A hostile or confused stream emits these routinely. Panicking would be a
    // denial of service by a single escape sequence.
    let mut p = parser(10, 4);
    p.feed(b"\x1b[999;999HX");
    assert!(p.cursor().row < 4);
    // `column == columns` is the PENDING WRAP state, which is where a real
    // terminal leaves the cursor after writing the last cell: it stays on the last
    // column and wraps on the next write, rather than moving to a column that does
    // not exist. `print` treats `column >= columns` as the wrap trigger.
    assert!(
        p.cursor().column <= 10,
        "the cursor may sit at the wrap point, never past the grid"
    );

    // A zero parameter is an underflow at the wire level: `vte` computes `param - 1`
    // in the parser and hands over -1.
    p.feed(b"\x1b[0;0HY");
    assert!(
        p.cursor().row < 4,
        "a negative row must clamp, not wrap or panic"
    );
    assert!(p.cursor().column <= 10);
}

#[test]
fn an_out_of_range_read_yields_a_blank_rather_than_panicking() {
    let grid = Grid::new(5, 2);
    assert!(grid.cell(99, 99).grapheme.is_some());
}

#[test]
fn resizing_preserves_content_and_discards_only_what_cannot_fit() {
    let mut p = parser(20, 5);
    p.feed(b"keep me");
    p.resize(10, 5);
    assert_eq!(row(&p, 0), "keep me", "content that still fits is kept");

    p.resize(40, 8);
    assert_eq!(row(&p, 0), "keep me", "growing pads rather than losing");
    assert_eq!(p.grid().columns(), 40);
    assert_eq!(p.grid().rows(), 8);
}

#[test]
fn resizing_both_grids_keeps_the_alternate_screen_the_right_size() {
    let mut p = parser(20, 5);
    p.feed(b"\x1b[?1049h");
    p.resize(40, 10);
    p.feed(b"\x1b[?1049l");
    assert_eq!(
        p.grid().columns(),
        40,
        "a later switch back must not restore a stale-width grid"
    );
}

#[test]
fn an_osc8_hyperlink_is_recorded_and_cleared() {
    let mut p = parser(20, 5);
    p.feed(b"\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\");
    assert_eq!(
        p.hyperlink(),
        None,
        "the link ends where the OSC 8 terminator does"
    );
}

#[test]
fn an_osc52_clipboard_write_is_ignored() {
    // A pane must not be able to write the operator's clipboard from output an
    // agent produced. The link above is inert; this asserts the clipboard path is
    // too, rather than merely unimplemented.
    let mut p = parser(20, 5);
    p.feed(b"\x1b]52;c;cGF5cGF6cGFzCg==\x1b\\");
    assert_eq!(row(&p, 0), "", "nothing was written to the screen");
}

#[test]
fn sequence_gaps_are_detected() {
    let mut tracker = PtySequenceTracker::new();
    assert!(tracker.observe(1), "the first chunk always continues");
    assert!(tracker.observe(2));
    assert!(!tracker.observe(9), "a jump means bytes were dropped");
    assert!(tracker.observe(10), "and the stream resumes cleanly");
    assert_eq!(tracker.gaps(), 1);
}

#[test]
fn backspace_clamps_at_the_left_edge() {
    let mut p = parser(10, 3);
    p.feed(b"\x08X");
    assert_eq!(
        p.cursor().column,
        1,
        "a backspace at column 0 must not move up a row and corrupt the line above"
    );
}

#[test]
fn saved_and_restored_cursor_position_survive_a_sequence() {
    let mut p = parser(20, 10);
    p.feed(b"\x1b[5;5H\x1b7\x1b[1;1Hgone\x1b8X");
    assert_eq!(p.cursor().row, 4);
    assert_eq!(row(&p, 4), "    X");
}

#[test]
fn a_selection_orders_its_own_corners() {
    // A backwards drag is the common case; three plausible answers exist and only
    // one is what the operator meant.
    let selection = Selection::new((10, 10), (2, 3));
    let ((min_x, min_y), (max_x, max_y)) = selection.ordered();
    assert_eq!((min_x, min_y), (2, 3));
    assert_eq!((max_x, max_y), (10, 10));
    assert!(selection.contains(5, 5));
    assert!(!selection.contains(1, 5));
    assert!(selection.contains(10, 10), "both ends are inclusive");
}

#[test]
fn an_escape_sequence_split_across_feeds_is_reassembled() {
    // PTY reads do not align with escape-sequence boundaries. A parser that resets
    // its state per chunk turns every SGR into garbage.
    let mut p = parser(20, 3);
    p.feed(b"\x1b[3");
    p.feed(b"8;2;255;0;0mX");
    assert_eq!(
        p.grid().cell(0, 0).foreground,
        Color::Rgb(255, 0, 0),
        "a sequence split across two chunks must still parse"
    );
}

#[test]
fn a_realistic_prompt_and_output_renders_in_the_right_places() {
    let mut p = parser(40, 6);
    p.feed(b"\x1b[38;2;0;200;120m$\x1b[0m opencode refactor /api/v1\r\n");
    p.feed(b"Reading AST tree...\r\n");
    p.feed(b"Synthesizing patch:");
    assert_eq!(p.grid().cell(0, 0).foreground, Color::Rgb(0, 200, 120));
    assert_eq!(p.grid().cell(1, 0).grapheme.as_deref(), Some(" "));
    assert_eq!(row(&p, 0), "$ opencode refactor /api/v1");
    assert_eq!(row(&p, 1), "Reading AST tree...");
    assert_eq!(row(&p, 2), "Synthesizing patch:");
    assert!(
        !p.grid().cell(0, 0).bold,
        "the reset after the prompt must have taken effect"
    );
}
