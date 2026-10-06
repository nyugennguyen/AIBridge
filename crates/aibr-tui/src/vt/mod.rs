//! The headless virtual terminal emulator.
//!
//! # Why the grid is ours
//!
//! `vte` is a byte-level parser state machine. It turns a stream of bytes into
//! callbacks -- print, cursor move, set attribute, switch buffer -- and maintains
//! **no screen at all**. There is no grid, no scrollback, no notion of a wide
//! character. Everything the operator actually sees lives here.
//!
//! That split is the point rather than an inconvenience. A screen with no terminal
//! behind it is testable: a test feeds bytes and asserts on cells. The alternative
//! -- shelling out to a real terminal emulator per pane -- makes the whole TUI
//! untestable and unembeddable.
//!
//! # What an `opencode` session needs
//!
//! At minimum: printable text, the usual control characters, absolute and relative
//! cursor motion, SGR including 24-bit colour, erase operations, scrollback, and
//! the alternate screen buffer. The last one is not optional -- `opencode` and most
//! full-screen TUI programs switch to the alternate buffer to draw their UI, and a
//! pane that ignores `?1049h` renders the program's interface smeared over the
//! shell output underneath it.

pub mod grid;
pub mod parser;

pub use grid::{Cell, Color, Cursor, Grid, Scrollback, SCROLLBACK_LINES};
pub use parser::{Parser, PtySequenceTracker};
