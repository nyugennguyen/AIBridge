//! `aibr-tui` — mouse-native, multi-pane terminal workspace client.
//!
//! PHASE 3/4/5 of
//! [`AIBridge_TUI_and_Daemon_Modernization_Plan.md`].
//!
//! The three properties this binary is built around, in the order they constrain the
//! code:
//!
//! 1. **It is ephemeral.** Every byte of authoritative state lives in the daemon.
//!    This process renders a snapshot, applies diffs, and can be killed mid-frame
//!    without consequence beyond that frame. `detach` is therefore not a shutdown
//!    path, and there is no code here that treats it as one.
//! 2. **It is mouse-native.** Every action reachable by keyboard is reachable by
//!    pointer, and every pointer target is computed from the geometry the render
//!    pass actually used — never from a second, parallel notion of layout that could
//!    disagree with the pixels.
//! 3. **It renders a terminal, not a log view.** A pane is a real VT grid fed by raw
//!    PTY bytes, so truecolor, cursor addressing and the alternate screen work the
//!    way they do in `opencode` itself. A line-oriented approximation cannot be made
//!    to behave like the program it is embedding.
//!
//! Module map, and who owns what:
//!
//! | module    | role                                                        |
//! |-----------|-------------------------------------------------------------|
//! | `state`   | the client's local view; pure reducer, no I/O               |
//! | `daemon`  | IPC client, snapshot hydration, diff application             |
//! | `layout`  | BSP `TileLayout`, chrome partitioning, hit-test rectangles   |
//! | `vt`      | headless VT parser, grid, scrollback                        |
//! | `input`   | keyboard state machine, mouse routing, clipboard, redaction |
//! | `widgets` | Ratatui widgets: terminal pane, diff view, approval modal     |
//! | `session` | the terminal itself: enter, loop, restore                    |

#![deny(missing_docs)]

pub mod daemon;
pub mod input;
pub mod layout;
pub mod session;
pub mod state;
pub mod vt;
pub mod widgets;

use std::time::Instant;

use state::ClientError;

/// Run the client until the operator detaches.
///
/// Exit codes are the process's contract with a supervising shell, so they are
/// enumerated rather than left to whatever `?` produced:
///
/// * `0` — clean detach (`Ctrl+B q`). The daemon is still running and `aibr tui`
///   re-attaches to it. A daemon-side close is also `0`: the client did its job.
/// * `1` — the client could not become usable: no daemon, no TTY, or the terminal
///   could not be prepared. This is the only code that should make a script treat
///   `aibr tui` as failed, because in every other case the work is still running.
/// * `2` — an invariant broke. Distinct from `1` so a bug is not reported as a
///   configuration problem.
pub fn run() -> std::process::ExitCode {
    use std::process::ExitCode;

    match event_loop() {
        Ok(()) => ExitCode::SUCCESS,
        // Reported AFTER the terminal has been restored, so the operator sees a
        // normal scrollback rather than a half-restored alternate screen.
        Err(error) => {
            eprintln!("aibr tui: {error}");
            error.exit_code()
        }
    }
}

/// Attach to the daemon, then run the terminal loop until detaching.
///
/// The two halves are separate because they fail differently: attaching fails for
/// reasons that are the OPERATOR'S to fix (no daemon, no TTY) and is reported before
/// anything is taken over, while the loop can fail for reasons that are ours.
fn event_loop() -> Result<(), ClientError> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(ClientError::Io)?;

    let (snapshot, attached) = runtime.block_on(daemon::attach())?;
    let mut session = session::Session::new(snapshot);

    // The terminal is entered only AFTER the first snapshot arrives. Entering first
    // would leave the operator watching a blank alternate screen for the ten seconds
    // a cold daemon may need to spawn its PTYs, with no way to tell whether it is
    // working or wedged.
    let (guard, mut terminal) = session::TerminalGuard::enter().map_err(ClientError::Io)?;
    let result = pump(&mut terminal, &mut session, &runtime, attached);
    // Explicit rather than relying on `Drop`: the release profile sets
    // `panic = "abort"`, and this is the path taken on an ordinary return.
    guard.restore();
    result
}

/// The frame loop, with the daemon's frames folded in as they arrive.
fn pump(
    terminal: &mut ratatui::Terminal<ratatui::backend::CrosstermBackend<std::io::Stdout>>,
    session: &mut session::Session,
    runtime: &tokio::runtime::Runtime,
    mut attached: daemon::Attached,
) -> Result<(), ClientError> {
    loop {
        // Drain the daemon before drawing, so the frame shows everything that has
        // arrived rather than being one tick behind.
        while let Some(frame) = runtime.block_on(attached.next_frame()) {
            if !session::apply_frame(session, &frame) {
                // The diff does not continue from the sequence this client holds.
                // Re-requesting a snapshot is the ONLY correct response: applying it
                // anyway leaves the client quietly wrong about which panes exist, and
                // no later frame would reveal it.
                let _ = runtime.block_on(attached.send(daemon::Outbound::RequestSnapshot));
            }
        }

        session::draw(terminal, session).map_err(ClientError::Io)?;

        // Expire toasts and any armed prefix BEFORE polling: a prefix must expire on
        // time whether or not another key arrives, and a toast must disappear without
        // needing input to dismiss it.
        let _ = session.input.tick(Instant::now());

        match session::poll_event() {
            Ok(Some(event)) => {
                if session::handle_event(session, event, Instant::now()) {
                    runtime.block_on(attached.detach());
                    return Ok(());
                }
            }
            // The redraw tick. Not an error, and not an EOF -- see `poll_event`.
            Ok(None) => {}
            Err(error) => {
                runtime.block_on(attached.detach());
                return Err(ClientError::Io(error));
            }
        }
    }
}
