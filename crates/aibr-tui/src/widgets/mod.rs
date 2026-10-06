//! The widgets that draw a pane and the chrome around it.
//!
//! # Rendering is a pure function of `(state, layout)`
//!
//! Every widget here takes its inputs and writes cells. Nothing in this module
//! reads the clock, queries the terminal, or mutates client state. That is what
//! lets the whole render path be tested with Ratatui's `TestBackend` and asserted
//! on cells rather than compared against a screenshot -- and a screenshot diff
//! cannot tell you *which* cell is wrong, which is the information needed when a
//! pane's border is one column off.
//!
//! # One geometry source
//!
//! Widgets receive [`LayoutRects`](crate::layout::LayoutRects) from the shell and
//! never compute a rectangle themselves. A widget that derived its own `Rect`
//! would be free to disagree with the hit-test, and that disagreement is the
//! "tearing" acceptance criterion 5 forbids.
//!
//! # Colour is 24-bit because the stream is
//!
//! [`vt::grid::Color::Rgb`] maps straight to `ratatui::Color::Rgb` with no
//! quantisation. Indexed colours resolve through one table so the widget and the
//! emulator cannot disagree about what index 196 means.

pub mod chrome;
pub mod diff;
pub mod frame;
pub mod modal;
pub mod terminal;

pub use chrome::{draw_chrome, SidebarSection};
pub use diff::{draw_diff_pane, DiffLine, DiffView};
pub use frame::{render_frame, FrameInput};
pub use modal::{draw_approval_modal, ApprovalModalState, ModalAction};
// `FocusTarget` lives in the input engine, which defines the modal's focus model;
// re-exported so a widget consumer needs one `use`.
pub use crate::input::traits::FocusTarget;
pub use terminal::{draw_terminal_pane, NoScrollback, ScrollbackPaneAdapter, TerminalPane};
