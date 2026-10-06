//! The render pass: `(state, layout)` to cells.
//!
//! # One function, no I/O, no clock
//!
//! Everything this module draws comes from its arguments. It does not read the
//! clock, query the terminal, or mutate client state. That is what lets the whole
//! render path be asserted on cells with Ratatui's `TestBackend` -- and a cell
//! assertion can say *which* cell is wrong, which a screenshot diff cannot. That is
//! the information needed when a pane's border is one column off.
//!
//! # Geometry comes from `LayoutRects` and is never recomputed
//!
//! The panes are drawn into the rects [`TileLayout::compute`] produced, which are
//! the same rects [`HitTest`](crate::layout::HitTest) resolves clicks against. A
//! widget that derived its own rect would be free to disagree with the hit-test, and
//! that disagreement is the "tearing" acceptance criterion 5 forbids.
//!
//! The sidebar's row rects come back OUT of [`draw_chrome`] and go to the hit-test,
//! so a click lands on the row the operator saw rather than on one recomputed from
//! an assumption about row heights.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;

use crate::input::selection::Selection;
use crate::layout::hit::SidebarRows;
use crate::layout::tile::Axis;
use crate::layout::{partition, ChromeRects, LayoutRects};
use crate::state::{PaneKind, UiState};
use crate::vt::parser::Parser;
use crate::widgets::chrome::draw_chrome;
use crate::widgets::modal::{draw_approval_modal, ApprovalModalState};
use crate::widgets::terminal::{draw_terminal_pane, TerminalPane};

/// Everything the render pass reads that is not in [`UiState`].
///
/// Grouped rather than passed as nine arguments so a caller cannot transpose two
/// `Rect`s.
pub struct FrameInput<'a> {
    /// The pane arrangement and its geometry for this frame.
    pub layout: &'a crate::layout::TileLayout,
    /// The VT emulator per pane, for `PaneKind::Terminal`.
    pub parsers: &'a BTreeMap<String, Parser>,
    /// The active selection, if the operator is dragging one.
    pub selection: Option<&'a Selection>,
    /// The approval modal, if a job is blocked.
    pub modal: Option<&'a ApprovalModalState>,
    /// How far each pane is scrolled back, by pane id.
    pub scroll: &'a BTreeMap<String, u16>,
}

use std::collections::BTreeMap;

/// Draw one frame into `buffer`.
///
/// Returns the chrome and the sidebar rows the caller must hand back to
/// [`HitTest`](crate::layout::HitTest). Returning them rather than recomputing is
/// the whole point: the geometry the mouse resolves against is the geometry that
/// was drawn.
pub fn render_frame(
    state: &UiState,
    input: &FrameInput<'_>,
    buffer: &mut Buffer,
) -> (ChromeRects, LayoutRects, SidebarRows) {
    let full = buffer.area;

    // Below the minimum, draw nothing but the notice. A layout squeezed into a
    // terminal it cannot fit is a screen full of overlapping borders that reads as
    // a crash rather than as "your window is too small".
    if state.presentation.too_small {
        let chrome = partition(full, None);
        draw_chrome(state, &chrome, buffer);
        draw_too_small(state, full, buffer);
        return (chrome, LayoutRects::default(), SidebarRows::default());
    }

    let sidebar_width = state
        .presentation
        .sidebar_visible
        .then(|| crate::layout::chrome::clamp_sidebar(crate::layout::SIDEBAR_DEFAULT, full.width));
    let chrome = partition(full, sidebar_width);
    let rows = draw_chrome(state, &chrome, buffer);

    // Zoom wins over the arrangement, because it is the operator's most recent
    // explicit statement about what they want to look at.
    let zoomed = state.presentation.zoomed.clone();
    let rects = input.layout.compute(chrome.canvas);

    if let Some(zoomed) = zoomed {
        if let Some(pane) = rects.panes.get(&zoomed) {
            draw_pane(state, input, &zoomed, pane.area, buffer);
        }
        draw_borders(&rects, buffer);
    } else {
        for (pane_id, pane) in &rects.panes {
            draw_pane(state, input, pane_id, pane.area, buffer);
        }
        draw_borders(&rects, buffer);
        draw_focus_markers(state, &rects, buffer);
    }

    if let Some(modal) = input.modal {
        draw_approval_modal(modal, full, buffer);
    }

    (chrome, rects, rows)
}

/// Draw one pane's content.
fn draw_pane(
    state: &UiState,
    input: &FrameInput<'_>,
    pane_id: &str,
    area: Rect,
    buffer: &mut Buffer,
) {
    let Some(pane) = state.world.panes.get(pane_id) else {
        return;
    };
    match pane.kind {
        PaneKind::Terminal => {
            // A pane with no emulator yet (between the snapshot and its first chunk)
            // draws nothing rather than a placeholder: an empty pane and a
            // "starting" pane look identical, and inventing text would be a lie.
            let Some(parser) = input.parsers.get(pane_id) else {
                return;
            };
            // Cloned rather than borrowed: `TerminalPane` holds the selection by
            // value, and a borrow would make the widget's lifetime depend on the
            // input frame's -- which would mean every caller has to keep the
            // `FrameInput` alive for the whole render.
            let selection = input
                .selection
                .filter(|selection| selection.pane_id == pane_id)
                .cloned();
            let mut view = TerminalPane::new(parser.grid());
            view.cursor = parser
                .cursor()
                .visible
                .then_some((parser.cursor().column, parser.cursor().row));
            view.selection = selection;
            view.top_row = input.scroll.get(pane_id).copied().unwrap_or(0);
            draw_terminal_pane(&view, area, buffer);
        }
        // The diff and audit panes are drawn by the shell through their own widgets;
        // a pane whose widget has not been wired draws as an empty frame rather
        // than as the terminal, because showing another pane's VT grid in it would
        // be actively misleading.
        PaneKind::PlanReview | PaneKind::AuditLog => {}
    }
}

/// Draw every split seam.
fn draw_borders(rects: &LayoutRects, buffer: &mut Buffer) {
    for border in &rects.borders {
        let glyph = match border.width <= border.height {
            true => Axis::Vertical.glyph(),
            false => Axis::Horizontal.glyph(),
        };
        for offset in 0..border.width.max(border.height) {
            let (x, y) = if border.width <= border.height {
                (border.x, border.y.saturating_add(offset))
            } else {
                (border.x.saturating_add(offset), border.y)
            };
            if x >= buffer.area.x.saturating_add(buffer.area.width)
                || y >= buffer.area.y.saturating_add(buffer.area.height)
            {
                break;
            }
            buffer[(x, y)].set_symbol(&glyph.to_string());
        }
    }
}

/// Mark the focused pane's title, so focus is visible without a highlight that
/// would obscure its content.
fn draw_focus_markers(state: &UiState, rects: &LayoutRects, buffer: &mut Buffer) {
    let Some(focused) = state.presentation.focused.as_deref() else {
        return;
    };
    let Some(pane) = rects.panes.get(focused) else {
        return;
    };
    let area = pane.area;
    if area.width < 2 || area.height == 0 {
        return;
    }
    let marker = "▌";
    buffer[(area.x, area.y)]
        .set_symbol(marker)
        .set_style(ratatui::style::Style::default().fg(ratatui::style::Color::LightCyan));
}

/// The "your terminal is too small" notice.
fn draw_too_small(state: &UiState, full: Rect, buffer: &mut Buffer) {
    let (columns, rows) = state.presentation.size;
    let message = format!(
        "Terminal too small: {columns}x{rows}, need {}x{}",
        crate::state::MINIMUM_COLUMNS,
        crate::state::MINIMUM_ROWS
    );
    if full.width < message.chars().count() as u16 || full.height == 0 {
        return;
    }
    let mut x = full.x;
    for grapheme in message.chars() {
        buffer[(x, full.y)].set_symbol(&grapheme.to_string());
        x += 1;
    }
}
