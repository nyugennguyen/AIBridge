//! Library root for the `aibr-tui` binary.
//!
//! Everything lives in the library rather than in `main.rs` for one reason that
//! is not about tidiness: acceptance criterion 5 requires that dragging a split
//! border resizes panes without tearing, and criterion 4 requires the approval
//! modal to appear the instant a job blocks. Neither is testable against a
//! process that owns a real terminal. Every subsystem below is therefore a pure
//! function over its inputs, and `main.rs` is the only place that touches the
//! process's terminal, its stdin, or the clock.
//!
//! # Module layout
//!
//! - [`state`] — the client's view of the world and the reducer over it.
//! - [`daemon`] — the IPC client: connect, hydrate, stream.
//! - [`layout`] — BSP tiling, chrome partition, and the hit-test geometry.
//! - [`vt`] — the headless terminal emulator.
//! - [`input`] — keyboard modes and mouse routing.
//! - [`widgets`] — the Ratatui widgets that draw the above.

#![deny(missing_docs)]

pub mod daemon;
pub mod input;
pub mod layout;
pub mod state;
pub mod vt;
pub mod widgets;

/// Run the client until the operator detaches.
///
/// Exit codes are the process's contract with a supervising shell, so they are
/// enumerated rather than left to whatever `?` produced:
///
/// * `0` — clean detach (`Ctrl+B q`), or the terminal being too small is
///   resolved. Nothing was lost; the daemon is still running.
/// * `1` — the client could not become usable at all (no daemon, no TTY). This
///   is the only code that should make a script treat `aibr tui` as failed,
///   because in every other case the work is still running and re-attaching
///   will show it.
/// * `2` — an invariant broke: a contract violation from the daemon, or a layout
///   that could not be built. Distinct from `1` so a bug is not reported as a
///   configuration problem.
pub fn run() -> std::process::ExitCode {
    use std::process::ExitCode;

    let outcome = match crate::state::terminal_size() {
        Ok(_size) => crate::daemon::run_attached(),
        Err(error) => {
            eprintln!("aibr tui: {error}");
            eprintln!("aibr tui: a TTY is required; run `aibr tui` from a terminal, not a pipe.");
            return ExitCode::from(1);
        }
    };

    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(crate::daemon::ClientError::NotATerminal) => ExitCode::from(1),
        Err(crate::daemon::ClientError::Invariant(message)) => {
            eprintln!("aibr tui: {message}");
            ExitCode::from(2)
        }
        Err(crate::daemon::ClientError::Io(error)) => {
            eprintln!("aibr tui: {error}");
            ExitCode::from(1)
        }
    }
}