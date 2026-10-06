//! Mouse capture and hit-test routing.
//!
//! # WHY THE INPUT ENGINE OWNS THE `EnableMouseCapture` CALL
//!
//! Because the capture mode decides whether the client can work at all, and getting it
//! wrong is not a degraded experience but a broken one. Crossterm's
//! [`EnableMouseCapture`] emits 1000 (click), 1002 (button-event), 1003
//! (any-event), 1015 (rxvt) and 1006 (SGR). This client keeps 1002 and 1006 and drops
//! 1003, which is the whole point of the [`DropAnyEventTracking`] below.
//!
//! # 1002, NOT 1000
//!
//! Border dragging needs the motion events BETWEEN a press and a release. 1000
//! reports only presses and releases; a drag under 1000 delivers a press, nothing, and
//! then a release, so the border would jump once at the end instead of following the
//! cursor. 1002 reports motion while a button is held, which is exactly the drag.
//!
//! # WHY 1003 IS DROPPED
//!
//! 1003 reports EVERY motion event, including motion with no button held. In a
//! full-screen TUI that is a message per cell of mouse movement, each of which the
//! event loop would hit-test -- to discover the pointer is still over the same pane it
//! was over 30 milliseconds ago. On a remote session that is the difference between
//! typing into an agent staying responsive and every mouse move queueing a frame.
//! Motion with no button is not actionable here: the client has no drag state, no
//! hover highlighting, and no tooltip.
//!
//! Crossterm has no option to enable a subset, so the sequences are adjusted after the
//! fact. That is noted in `Cargo.toml` too, because "crossterm 0.29 has no `mouse`
//! feature" is the surprising fact a future reader will hit first.

use std::io::{self, Write};

use crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
};
use crossterm::execute;

/// Turn on mouse reporting and bracketed paste.
///
/// MUST be paired with [`disable`]. Mouse reporting left on after the client exits
/// means the shell the operator returns to cannot print: every keystroke and every
/// scroll is reported to a process that no longer reads it, and the terminal appears
/// frozen. This is why [`restore`] exists as a separate function rather than leaving
/// it to `Drop` -- a `Drop` that ran during a panic unwind would be writing escape
/// sequences to a terminal whose state is already unknown.
///
/// [`crate::daemon`]'s exit path calls [`restore`]; nothing else should call
/// [`disable`] directly, so that focus-change reporting and bracketed paste are undone
/// in the same order every time.
pub fn enable() -> io::Result<()> {
    // The lock is held for the whole `execute!`, because a partially-applied
    // mouse-capture sequence is a terminal left in a mode nobody knows how it got into.
    let mut out = io::stdout().lock();
    execute!(
        out,
        EnableMouseCapture,
        DropAnyEventTracking,
        EnableBracketedPaste
    )
}

/// Undo [`enable`].
pub fn disable() -> io::Result<()> {
    let mut out = io::stdout().lock();
    execute!(out, DisableMouseCapture, DisableBracketedPaste)
}

/// Undo [`enable`], reporting failure as a message rather than propagating it.
///
/// FOR THE EXIT PATH. A failure here must not change the exit code: the daemon is
/// still running, the operator's work is intact, and reporting "aibr tui: broken pipe"
/// on a successful detach would tell them something untrue. The message goes to stderr
/// because the alternate screen may already be gone.
pub fn restore() {
    if let Err(error) = disable() {
        eprintln!(
            "aibr tui: could not restore the terminal ({error}); run `reset` if it looks wrong"
        );
    }
}

/// `CSI ?1003l` -- drop any-event tracking, keeping button-event tracking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DropAnyEventTracking;

impl crossterm::Command for DropAnyEventTracking {
    fn write_ansi(&self, formatter: &mut impl std::fmt::Write) -> std::fmt::Result {
        // Written by hand because crossterm has no command for "everything except
        // this one mode". See the module header for why this one mode is excluded.
        formatter.write_str("\x1b[?1003l")
    }
}

/// Write raw bytes to the terminal, for the shell's own escape sequences.
pub fn write_bytes(bytes: &[u8]) -> io::Result<()> {
    io::stdout().lock().write_all(bytes)
}
