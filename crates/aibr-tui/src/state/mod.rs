//! The client's view of the world, and the terminal it draws onto.
//!
//! TWO RESPONSIBILITIES, and keeping them together is deliberate: the geometry
//! of the terminal is part of the client's state because a resize is not an
//! event the render pass can absorb on its own. Every hit-test rectangle, every
//! pane's `Rect`, and the split ratio a drag is adjusting all derive from the
//! same numbers, and if those numbers were held in two places they would drift.
//!
//! [`UiState`] holds the DAEMON'S WORLD AS THE CLIENT BELIEVES IT. It contains
//! no authority: every field is either a copy of something the daemon sent or a
//! purely local presentation choice (which pane has focus, whether the sidebar
//! is collapsed, how far a pane is scrolled). Nothing here is written back except
//! by sending a [`ControlCommand`](aibr_ipc::ControlCommand), and a client that
//! is killed loses all of it without consequence.

#![deny(missing_docs)]

pub mod app;

pub use app::{
    BlockedReason, ClientError, DaemonWorld, InputMode, Job, KeybindingProfile, Pane, PaneKind,
    Presentation, RunOutcome, Tailscale, TailscaleStatus, UiState, Workspace, MINIMUM_COLUMNS,
    MINIMUM_ROWS,
};
