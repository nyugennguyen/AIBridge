//! The chrome bands around the canvas.
//!
//! Fixed heights and a clamped sidebar width, rather than Ratatui's `Layout`,
//! because `Layout` returns whatever fits and a `u16` cannot express "does not
//! fit". A terminal 30 rows tall would get a 1-row top bar, a 1-row status bar,
//! and a 28-row body — fine — but a terminal 1 row tall gets a top bar and a
//! status bar that overlap, and every subtraction after that is wrong. Sizing the
//! chrome explicitly and yielding an **empty** canvas when it does not fit is the
//! only version of this that cannot produce a negative height.
//!
//! The empty canvas is not a degraded mode to be avoided at all costs: the shell
//! checks it and shows a "too small" notice instead of the layout, so the operator
//! gets an honest message rather than a mangled one.

use ratatui::layout::Rect;

use crate::state::MINIMUM_COLUMNS;

/// The sidebar's minimum width.
///
/// 24 fits `web-store (main)` plus a badge at the default font. Below that the
/// workspace names truncate to the point where two projects are indistinguishable,
/// and an operator cannot tell which pane belongs to which project.
pub const SIDEBAR_MIN: u16 = 24;

/// The sidebar's maximum width.
///
/// 32 leaves a usable canvas on the 60-column minimum terminal. A sidebar wider
/// than this on a narrow terminal is a sidebar that has eaten the thing the
/// operator came to read.
pub const SIDEBAR_MAX: u16 = 32;

/// The width the shell starts with.
pub const SIDEBAR_DEFAULT: u16 = SIDEBAR_MIN;

/// The sidebar width, type-aliased so a caller cannot pass a height by mistake.
pub type SidebarWidth = u16;

/// Clamp a requested sidebar width to what the terminal can afford.
///
/// The canvas is guaranteed at least [`MINIMUM_COLUMNS`] minus the sidebar, so the
/// layout never becomes a sidebar with a two-column canvas beside it.
#[must_use]
pub fn clamp_sidebar(requested: SidebarWidth, terminal_width: u16) -> SidebarWidth {
    let affordable = terminal_width.saturating_sub(MINIMUM_COLUMNS);
    requested.clamp(SIDEBAR_MIN.min(affordable.max(SIDEBAR_MIN)), SIDEBAR_MAX)
}

/// The chrome rectangles for one frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChromeRects {
    /// The single-row header: Tailscale status, workspace, outbox count.
    pub top_bar: Rect,
    /// The workspace tree, or `None` when collapsed or unaffordable.
    pub sidebar: Option<Rect>,
    /// Everything left for panes.
    pub canvas: Rect,
    /// The single-row footer: mode indicator and keybinding hints.
    pub status_bar: Rect,
}

impl ChromeRects {
    /// Whether there is enough room to draw the pane layout at all.
    ///
    /// The caller shows a notice instead. Exposed as a method rather than left for
    /// each caller to re-derive, because "is this frame drawable" is one question
    /// and answering it two different ways produces a screen that shows a layout in
    /// one widget and a notice in another.
    #[must_use]
    pub fn canvas_is_drawable(&self) -> bool {
        self.canvas.width > 0 && self.canvas.height > 0
    }
}
