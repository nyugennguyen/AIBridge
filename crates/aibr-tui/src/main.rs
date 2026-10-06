//! `aibr-tui` -- mouse-native, multi-pane terminal workspace client.
//!
//! PHASE 3/4/5 of
//! `Docs/implementation-plans/AIBridge_TUI_and_Daemon_Modernization_Plan.md`.
//!
//! The three properties this binary is built around, in the order they constrain
//! the code:
//!
//! 1. **It is ephemeral.** Every byte of authoritative state lives in the
//!    daemon. This process renders a snapshot, applies diffs, and can be killed
//!    mid-frame without consequence beyond the frame. `detach` is therefore not
//!    a shutdown path and there is no code here that treats it as one.
//! 2. **It is mouse-native.** Every action reachable by keyboard is reachable by
//!    pointer, and every pointer target is computed from the geometry the render
//!    pass actually used -- never from a second, parallel notion of layout that
//!    could disagree with the pixels.
//! 3. **It renders a terminal, not a log view.** A pane is a real VT grid fed by
//!    raw PTY bytes, so truecolor, cursor addressing and the alternate screen
//!    work the way they do in `opencode` itself. A line-oriented approximation
//!    cannot be made to behave like the program it is embedding.
//!
//! Module map, and who owns what:
//!
//! | module          | role                                                        |
//! |-----------------|-------------------------------------------------------------|
//! | `state`         | the client's local view; pure reducer, no I/O               |
//! | `daemon`        | IPC client, snapshot hydration, diff application            |
//! | `layout`        | BSP `TileLayout`, chrome partitioning, hit-test rectangles   |
//! | `vt`            | headless VT parser, grid, scrollback, selection extraction  |
//! | `input`         | keyboard state machine, mouse routing, clipboard            |
//! | `widgets`       | Ratatui widgets: terminal pane, diff view, approval modal    |

fn main() -> std::process::ExitCode {
    aibr_tui::run()
}
