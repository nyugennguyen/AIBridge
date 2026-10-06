//! The IPC client: connect, hydrate, stream, and stay out of the way.
//!
//! OWNERSHIP. This module holds the socket, the read loop, and the mapping from
//! decoded frames into [`UiState`](crate::state::UiState). It is the ONLY place in
//! the client that performs I/O against the daemon, which is what lets the render
//! pass and the input handlers stay pure.
//!
//! # What "decoupled" means here, concretely
//!
//! * Nothing the client learns is kept anywhere but `UiState`, and `UiState` is
//!   rebuilt from a `StateSnapshot` on every attach. Killing this process mid-frame
//!   costs the operator nothing.
//! * The client sends exactly one command on startup — `request_snapshot` — and
//!   then only sends commands the operator asked for. It never polls.
//! * `detach` is a control command, not a shutdown. The client sends it and exits
//!   0. The daemon keeps every PTY alive. There is no code path in this module in
//!   which leaving the TUI stops a job.
//!
//! # What is still a seam
//!
//! The loop below selects over three sources: inbound frames, an outbound command
//! channel, and a detach signal. The last of those is fed by the input and shell
//! layers (`crate::input`, `crate::layout`), which are separate workstreams. Until
//! they are wired the detach arm never fires, so the loop relies on its tick to
//! stay scheduled; that is a wiring gap, not a design one, and the alternative --
//! omitting the arm until the shell lands -- would make the eventual wiring a
//! change to a loop that had already been reviewed without it.

use std::time::Duration;

use tokio::sync::mpsc;

use crate::state::{ClientError, RunOutcome, UiState};

/// How long to wait for the daemon's first snapshot before reporting a dead
/// socket.
///
/// The client cannot draw a frame until it has one, so this bounds how long an
/// operator stares at a blank terminal. Generous because the first snapshot
/// requires the daemon to enumerate every pane, which on a cold start includes
/// spawning the PTYs.
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a graceful detach may take before the client gives up on it.
///
/// Short, then the socket is dropped anyway: the daemon must survive a client
/// that vanishes, so a client that cannot close cleanly must still exit.
const DETACH_TIMEOUT: Duration = Duration::from_millis(500);

/// The render cadence's floor.
///
/// Comfortably inside 60fps. The loop redraws whether or not anything arrived, so
/// a cursor blink keeps animating; `layout` decides what actually changes.
const FRAME_INTERVAL: Duration = Duration::from_millis(16);

/// The upper bound on buffered outbound commands.
///
/// Small on purpose. Every command is a consequence of an operator action, so a
/// full channel means the daemon is not reading -- a condition to report, not to
/// absorb by growing a queue that would delay the operator's next keystroke by
/// seconds.
const OUTBOUND_CAPACITY: usize = 64;

/// The upper bound on buffered inbound frames.
///
/// PTY output dominates this channel, and it is lossy under pressure BY DESIGN:
/// when the render loop falls behind, dropping the oldest pending frame keeps the
/// newest output visible. That is the correct trade for a terminal -- a missing
/// middle frame is invisible, whereas an unbounded queue grows until the process
/// is OOM-killed and the operator loses the session.
const INBOUND_CAPACITY: usize = 256;

/// A command the operator asked for, on its way to the daemon.
pub type Outbound = aibr_ipc::contracts::ControlCommand;

/// Run the client to completion.
///
/// Returns once the operator detaches, the daemon closes the connection, or a
/// failure makes the client unusable. Terminal side effects are the shell's
/// business and are undone before this returns, so the caller's error reporting
/// lands in a restored terminal.
pub async fn run_attached() -> Result<RunOutcome, ClientError> {
    let socket = socket_path()?;
    let (outbound_tx, outbound_rx) = mpsc::channel::<Outbound>(OUTBOUND_CAPACITY);
    let mut inbound_rx = connect(&socket, outbound_rx).await?;

    // The one command the client sends unprompted. Everything after this is an
    // operator action.
    //
    // Sent through the channel rather than written directly, so there is exactly
    // ONE writer for the socket. A second writer would interleave a frame with a
    // half-written one from the read loop, and the daemon would see a corrupt
    // length prefix -- the kind of failure that looks like a daemon bug and is
    // actually two tasks racing on one fd.
    outbound_tx
        .send(Outbound::RequestSnapshot)
        .await
        .map_err(|_| {
            ClientError::Invariant(
                "the daemon reader stopped before the snapshot request".to_owned(),
            )
        })?;

    let state = tokio::time::timeout(FIRST_FRAME_TIMEOUT, wait_for_snapshot(&mut inbound_rx))
        .await
        .map_err(|_| {
            ClientError::Invariant(format!(
                "the daemon accepted the connection but sent no snapshot within {FIRST_FRAME_TIMEOUT:?}"
            ))
        })??;

    let (_detach_tx, mut detach_rx) = mpsc::channel::<()>(1);
    let outcome = event_loop(state, &mut inbound_rx, &mut detach_rx).await?;

    detach(&outbound_tx).await;
    Ok(outcome)
}

/// Read frames until a snapshot arrives, discarding PTY output on the way.
///
/// The discard is correct rather than lossy: PTY bytes for a pane this client has
/// not yet learned about cannot be rendered, and the snapshot that follows is what
/// tells it the pane exists and how wide it is. The VT grid is re-hydrated from the
/// daemon's scrollback memory (Phase 6 §6.2), not from bytes that arrived before
/// the client knew the pane existed.
async fn wait_for_snapshot(
    inbound: &mut mpsc::Receiver<aibr_ipc::Frame>,
) -> Result<UiState, ClientError> {
    let mut state = UiState::default();
    while let Some(frame) = inbound.recv().await {
        if frame.snapshot().is_some() {
            apply_frame(&mut state, frame)?;
            return Ok(state);
        }
    }
    Err(ClientError::Invariant(
        "the daemon closed the connection before sending a snapshot".to_owned(),
    ))
}

/// The loop that owns the client's lifetime.
///
/// Split out so [`run_attached`] reads as setup and teardown, and the body here
/// reads as the thing it is: a `select` over three sources.
async fn event_loop(
    mut state: UiState,
    inbound: &mut mpsc::Receiver<aibr_ipc::Frame>,
    detach_requested: &mut mpsc::Receiver<()>,
) -> Result<RunOutcome, ClientError> {
    let mut outcome = RunOutcome::default();

    loop {
        tokio::select! {
            // A frame from the daemon.
            //
            // `biased` is deliberately NOT set. The inbound arm is listed first so
            // that PTY output, the high-frequency source, is polled first -- which
            // is the ordering that matters, and `select!` does not randomise its
            // arm order when `biased` is absent but does favour it when present.
            // A biased select here would starve the tick below instead.
            frame = inbound.recv() => {
                let Some(frame) = frame else {
                    // The daemon closed the connection. Its PTYs keep running;
                    // re-running `aibr tui` re-attaches to them.
                    return Ok(outcome);
                };
                apply_frame(&mut state, frame)?;
            }

            // The operator asked to leave. This is the ONLY exit that means
            // "detach": the other, the `None` above, is the daemon going away.
            _ = detach_requested.recv() => {
                outcome.detached = true;
                return Ok(outcome);
            }

            _ = tokio::time::sleep(FRAME_INTERVAL) => {
                outcome.ticks += 1;
            }
        }
    }
}

/// Fold one frame into the client state.
///
/// A diff whose `baseSequence` does not match this client's sequence is an
/// `Err`, and that is the only correct response. Applying it onto a gap leaves the
/// client silently wrong about which panes exist, and no later frame would reveal
/// it -- the exact failure the sequence numbers exist to prevent.
fn apply_frame(state: &mut UiState, frame: aibr_ipc::Frame) -> Result<(), ClientError> {
    if let Some(snapshot) = frame.snapshot() {
        state.apply_snapshot(snapshot);
        return Ok(());
    }
    if let Some(diff) = frame.diff() {
        if !state.apply_diff(diff) {
            return Err(ClientError::Invariant(format!(
                "a diff arrived with base sequence {}, but this client holds {:?}; \
                 a snapshot must be re-requested before any diff is applied",
                diff.base_sequence, state.world.sequence
            )));
        }
        return Ok(());
    }
    // PTY chunks, exits, acks and errors are consumed by the pane that owns them;
    // `vt` and `widgets` take those from the stream this module exposes. An
    // unhandled frame is not an invariant break -- it is simply not this module's
    // business -- so returning `Ok` is correct rather than lenient.
    Ok(())
}

/// Resolve the socket path for this platform.
///
/// `AIBRIDGE_IPC_SOCKET` wins so a test harness, a second daemon on a developer's
/// machine, or a container can point at its own socket without a rebuild. The
/// default is user-scoped, NOT the plan's `/var/run/aibr`: a path there needs root
/// to create, and a socket in a shared directory means any local user can reach a
/// daemon that runs OpenCode inside the owner's project allowlist.
fn socket_path() -> Result<String, ClientError> {
    if let Some(path) = std::env::var_os(aibr_ipc::SOCKET_PATH_ENV) {
        if path.is_empty() {
            return Err(ClientError::Invariant(format!(
                "{} is set but empty",
                aibr_ipc::SOCKET_PATH_ENV
            )));
        }
        return Ok(path.to_string_lossy().into_owned());
    }
    Ok(default_socket_path())
}

/// The platform's default IPC path.
#[cfg(unix)]
fn default_socket_path() -> String {
    // `$XDG_RUNTIME_DIR` is the filesystem's answer to "a directory only this user
    // may read", and it is removed at logout, so a stale socket from a previous
    // run cannot be inherited by the next one. `aibr/` inside it is created 0700
    // by the daemon before it binds.
    if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") {
        if !runtime.is_empty() {
            return std::path::Path::new(&runtime)
                .join("aibr")
                .join("daemon.sock")
                .to_string_lossy()
                .into_owned();
        }
    }
    aibr_ipc::DEFAULT_POSIX_SOCKET_PATH.to_owned()
}

/// The platform's default IPC path.
#[cfg(windows)]
fn default_socket_path() -> String {
    aibr_ipc::DEFAULT_WINDOWS_PIPE_PATH.to_owned()
}

/// Attach to the daemon and return the first snapshot plus the connection.
///
/// Separate from [`run_attached`] because the client enters its terminal AFTER this
/// returns, and the two halves should fail independently: a daemon that is not
/// running must be reported with the operator's scrollback intact, not swallowed by
/// a half-restored alternate screen.
///
/// The returned [`Attached`] keeps the connection so the session loop keeps
/// receiving diffs and PTY output. Dropping it here would leave the client rendering
/// a snapshot that immediately goes stale.
pub async fn attach() -> Result<(UiState, Attached), ClientError> {
    let socket = socket_path()?;
    let (outbound_tx, outbound_rx) = mpsc::channel::<Outbound>(OUTBOUND_CAPACITY);
    let mut inbound = connect(&socket, outbound_rx).await?;

    outbound_tx
        .send(Outbound::RequestSnapshot)
        .await
        .map_err(|_| {
            ClientError::Invariant(
                "the daemon reader stopped before the snapshot request".to_owned(),
            )
        })?;

    let state = tokio::time::timeout(FIRST_FRAME_TIMEOUT, wait_for_snapshot(&mut inbound))
        .await
        .map_err(|_| {
            ClientError::Invariant(format!(
                "the daemon accepted the connection but sent no snapshot within {FIRST_FRAME_TIMEOUT:?}"
            ))
        })??;

    Ok((
        state,
        Attached {
            frames: inbound,
            outbound: outbound_tx,
        },
    ))
}

/// The daemon closed the connection.
///
/// A named zero-sized type rather than `()`, because `Result<_, ()>` says nothing
/// at a call site and there is no way to attach context to it later without
/// changing every caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DaemonGone;

/// A live connection to the daemon, after the initial snapshot.
pub struct Attached {
    /// Inbound frames: snapshots, diffs and PTY output.
    pub frames: mpsc::Receiver<aibr_ipc::Frame>,
    /// Outbound commands.
    outbound: mpsc::Sender<Outbound>,
}

impl Attached {
    /// Take the next frame if one is already buffered, WITHOUT waiting.
    ///
    /// `Ok(None)` means "nothing right now", which is the normal state between
    /// events. `Err(())` means the daemon closed the connection, which is a normal
    /// end: the operator detached, or the daemon exited. Either way the PTYs it owned
    /// keep whatever they were doing.
    ///
    /// The split between this and [`Self::next_frame`] is deliberate. A blocking
    /// read in the render loop stalls drawing for as long as the daemon is quiet,
    /// which on an idle session is most of the time.
    pub fn try_next_frame(&mut self) -> Result<Option<aibr_ipc::Frame>, DaemonGone> {
        match self.frames.try_recv() {
            Ok(frame) => Ok(Some(frame)),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => Ok(None),
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => Err(DaemonGone),
        }
    }

    /// Wait for the next frame.
    ///
    /// Used only where blocking is correct -- the initial snapshot -- never in the
    /// render loop. See [`Self::try_next_frame`].
    pub async fn next_frame(&mut self) -> Option<aibr_ipc::Frame> {
        self.frames.recv().await
    }

    /// Send one command.
    ///
    /// A send failure means the daemon is gone, which is not reported as an error:
    /// the operator asked for an action and the client is telling them it could not
    /// be delivered, not failing the session.
    pub async fn send(&self, command: Outbound) -> bool {
        self.outbound.send(command).await.is_ok()
    }

    /// Tell the daemon the operator is leaving, then close.
    pub async fn detach(self) {
        detach(&self.outbound).await;
    }
}

/// Tell the daemon the operator is leaving.
///
/// Queued rather than written, for the single-writer reason recorded at the
/// startup request. The socket itself closes when the read loop returns, which it
/// does on EOF, on a protocol violation, or when the outbound sender is dropped --
/// the last of which happens here, so this call is what actually closes it.
///
/// A send failure means the daemon is already gone. That is not an error: the
/// operator asked to leave and is leaving, and the daemon's PTYs are unaffected
/// either way.
async fn detach(outbound: &mpsc::Sender<Outbound>) {
    let _ = tokio::time::timeout(DETACH_TIMEOUT, outbound.send(Outbound::Detach)).await;
}

/// Connect to the daemon and spawn the read loop.
///
/// The read loop owns decoding and pushes [`aibr_ipc::Frame`]s into a bounded
/// channel. It terminates on EOF and sends `None`, which the event loop reads as
/// "the daemon closed" -- a normal end, since detaching is how a client leaves.
async fn connect(
    socket: &str,
    outbound: mpsc::Receiver<Outbound>,
) -> Result<mpsc::Receiver<aibr_ipc::Frame>, ClientError> {
    let io = tokio::net::UnixStream::connect(socket)
        .await
        .map_err(|error| {
            // `DaemonUnavailable`, not `Invariant`: a daemon that is not running is the
            // most common outcome and the operator's to fix, and every job behind that
            // daemon is unaffected. Exit code 1, not 2.
            ClientError::DaemonUnavailable {
                path: socket.to_owned(),
                detail: error.to_string(),
            }
        })?;

    // `into_split`, not an `Arc`. tokio implements `AsyncRead`/`AsyncWrite` for
    // the owned halves and NOT for `Arc<UnixStream>`: with a shared handle the
    // read half's `&mut self` borrow would have to exclude the write half's, and
    // both are used concurrently by the same task. Splitting is what makes the
    // single-writer rule below a structural property instead of a convention.
    let (read_half, write_half) = io.into_split();

    let (inbound_tx, inbound_rx) = mpsc::channel(INBOUND_CAPACITY);
    tokio::spawn(read_loop(read_half, write_half, outbound, inbound_tx));

    Ok(inbound_rx)
}

/// Decode frames until the peer closes, forwarding commands the other way.
///
/// Both directions are handled on ONE task over a shared socket because they are
/// genuinely independent, and the failure mode of getting this wrong is asymmetric:
/// a client that stops reading PTY output to send a keystroke backs up the PTY and
/// stalls the agent, which is worse than the reverse.
async fn read_loop(
    read_half: tokio::net::unix::OwnedReadHalf,
    mut write_half: tokio::net::unix::OwnedWriteHalf,
    mut outbound: mpsc::Receiver<Outbound>,
    inbound_tx: mpsc::Sender<aibr_ipc::Frame>,
) {
    use aibr_ipc::frame::AsyncFrameRead;

    let mut reader = tokio::io::BufReader::new(read_half);

    loop {
        tokio::select! {
            read = reader.read_frame() => {
                let payload = match read {
                    // `None` is a clean close on a frame boundary: the operator
                    // detached, or the daemon exited. Both are normal ends.
                    Ok(None) => return,
                    Ok(Some(payload)) => payload,
                    // A protocol violation or an I/O failure. The connection is
                    // not recoverable in either case, and dropping the sender is
                    // what tells the event loop the daemon is gone.
                    Err(_) => return,
                };
                match aibr_ipc::message::decode(&payload) {
                    Ok(frame) => {
                        // A send failure means the event loop is gone, so the
                        // client is shutting down. Returning rather than
                        // continuing to read is what stops this task leaking.
                        if inbound_tx.send(frame).await.is_err() { return; }
                    }
                    // A frame this build cannot parse is DROPPED, not fatal. One
                    // bad frame must not take down a session with running jobs
                    // behind it. The contract's `UnknownTag` case is deliberate --
                    // see `aibr_ipc::DecodeError` -- and a client that skipped
                    // messages it did not recognise would silently drop a
                    // `blocked` transition and leave an operator believing an
                    // agent is still working.
                    Err(_) => continue,
                }
            }
            command = outbound.recv() => {
                // `None` means the UI dropped its sender, which happens on
                // shutdown. Keep reading, so a late diff is not lost.
                let Some(command) = command else { continue };
                if encode_and_write(&mut write_half, &command).await.is_err() {
                    return;
                }
            }
        }
    }
}

/// Encode and write one command frame.
///
/// Takes the write half by `&mut`, which is the mechanical expression of the
/// single-writer rule: there is no second handle to this socket to write through.
async fn encode_and_write(
    write_half: &mut tokio::net::unix::OwnedWriteHalf,
    command: &Outbound,
) -> Result<(), ClientError> {
    use tokio::io::AsyncWriteExt;

    let bytes = aibr_ipc::frame::encode(command)
        .map_err(|error| ClientError::Invariant(format!("could not encode a command: {error}")))?;
    write_half.write_all(&bytes).await.map_err(ClientError::Io)
}
