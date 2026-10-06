//! Local IPC bus for the AIBridge daemon and TUI.
//!
//! The message SHAPES are not declared here. They are generated into
//! [`contracts`] from `src/ipc/schemas.ts`, so the Rust daemon and the
//! TypeScript worker cannot disagree about a wire field and no Rust file becomes
//! a second hand-maintained copy of a contract (ADR 0008 §2.3).
//!
//! What lives here is everything JSON Schema cannot express:
//!
//!   * [`frame`] — the length-prefixed framing and its 8 MiB cap. A frame that
//!     announces more than the cap is refused before anything is allocated,
//!     because the announcement comes from the peer.
//!   * [`message`] — dispatch from the generated union onto the named contract
//!     types, so a consumer matches on `StateSnapshot` rather than on an
//!     anonymous inlined arm.
//!
//! The transport and the per-connection state machine are declared in their own
//! modules as the daemon and the client bring them up.
//!
//! The three invariants the rest of the system leans on:
//!
//! 1. **A client is replaceable.** `aibr tui` holds no authoritative state. It
//!    renders a [`contracts::StateSnapshot`] and applies [`contracts::StateDiff`]
//!    frames, and a fresh process can do the same from nothing. Anything that
//!    survives a client detaching is owned by the daemon.
//! 2. **A diff is only applied onto the sequence it names.** Each diff carries
//!    `baseSequence`; a client behind it re-requests a snapshot instead of
//!    applying a frame with a hole under it.
//! 3. **Detach is not shutdown.** `ControlCommand::detach` closes a connection
//!    and nothing else. No PTY is signalled, no job is cancelled, no state is
//!    discarded. There is deliberately no "detach and stop" command for a
//!    convenience to be added to later.

#![deny(missing_docs)]

// The generated module is exempt from `#![deny(missing_docs)]`, and the reason
// is that the documentation it lacks is not missing from the SYSTEM -- it is
// missing from the Rust file. Every field's meaning is declared once, in the Zod
// schema, as prose that `scripts/generate-contracts.ts` copies into the JSON
// Schema and this generator carries through. Emitting a doc comment per field
// would produce a second wording of the same contract in a language nobody reads
// as authoritative, which is the duplication ADR 0008 §2.3 forbids. The type
// level docs the generator does emit are kept. The router's `pub mod contracts;`
// is exempt for the same reason.
#[allow(missing_docs)]
pub mod contracts;
pub mod frame;
pub mod message;

/// Convenience re-exports so a consumer writes one `use`.
pub use contracts::{
    Ack, ControlCommand, JobState, JobView, PaneView, PtyChunk, PtyExit, ServerError,
    ServerMessage, StateDiff, StateSnapshot, TailscaleStatusView, WorkspaceView,
};
pub use message::{decode, Chunk, DecodeError, Diff, Frame, MessageTag, Snapshot};

/// The IPC protocol version this build speaks.
///
/// Mirrors `IPC_PROTOCOL_VERSION` in `src/ipc/schemas.ts` and is separately
/// declared because a generated `const` inside a `#[serde(deny_unknown_fields)]`
/// module would make the framing layer import the contracts module for one
/// integer. `contract_parity_is_checked_by_test` in `tests/protocol_version.rs`
/// fails the build if the two drift.
pub const PROTOCOL_VERSION: u8 = 1;

/// The environment variable that overrides the IPC socket path.
///
/// Exists so a second daemon, a test harness, or a container can point at its own
/// socket without a rebuild -- and so the Bun worker and the TUI agree on where to
/// look. Mirrors `IPC_SOCKET_PATH_ENV` in `src/ipc/schemas.ts`; the TypeScript
/// side reads the same name, and `tests/socket_path_parity.rs` asserts the two
/// literals agree.
pub const SOCKET_PATH_ENV: &str = "AIBRIDGE_IPC_SOCKET";

/// The POSIX default socket path: a user-scoped subdirectory of `/tmp`.
///
/// NOT `/var/run/aibr/`, which the plan proposes. Two reasons, and the second is
/// the one that matters: a path under `/var/run` needs root to create, and a
/// world-readable socket in a shared directory means any local user can connect to
/// a daemon that can run OpenCode inside the owner's project allowlist. The
/// `aibr/` subdirectory is created 0700 by the daemon before binding.
pub const DEFAULT_POSIX_SOCKET_PATH: &str = "/tmp/aibr/aibrd.sock";

/// The Windows default, a named pipe.
///
/// A named pipe rather than a loopback TCP port because the ACL is inherited from
/// the process token: a loopback listener is reachable by any local process that
/// guesses the port, and "can anyone reach this" is a property worth keeping
/// structural.
pub const DEFAULT_WINDOWS_PIPE_PATH: &str = r"\\.\pipe\aibr-daemon";
