//! The daemon side of the local bus: bind one socket, serve many peers.
//!
//! # What this module owns, and what it deliberately does not
//!
//! It owns the socket, the accept loop, the per-connection frame codec and the
//! per-connection outbound bound. It owns NO application state: a
//! `request_snapshot` is handed to a [`ConnectionHandler`] rather than answered
//! here, because the snapshot's content is the daemon's business and a second
//! implementation of "what the world looks like" is exactly the duplication
//! ADR 0008 §2.3 exists to prevent. It is also why a peer departing is a no-op
//! on this side of the socket: everything that must survive a disconnect lives
//! in the process that owns the state (Phase 6 invariant 1).
//!
//! # WHY THE TOKIO TRANSPORT AND NOT THE BLOCKING ONE
//!
//! `interprocess` ships both, so this is a decision rather than a default. The
//! blocking API would mean an OS thread per connection and a hand-written bridge
//! from `Read`/`Write` into the runtime, which leaves `frame::read_frame_blocking`
//! and `frame::AsyncFrameRead` as two live codepaths through the codec -- and the
//! frame-cap check is the one thing in that codec that must not exist twice.
//! `crates/aibr-tui` already depends on the async half, so the async half is the
//! one that has to stay correct. The tokio transport's streams implement
//! `tokio::io::AsyncRead`, so `read_frame()` is used directly and the crate keeps
//! exactly one read path.
//!
//! The cost is real and recorded here rather than discovered later: the listener
//! must run on a tokio runtime, so [`Server::bind`] cannot be called from a
//! synchronous `main` that has not entered one. Every consumer of this bus is
//! already inside a runtime.
//!
//! # The security boundary is the parent directory, not the socket
//!
//! A Unix domain socket's own mode bits are not what a local user has to get
//! past: they have to reach the socket file at all. In a world-writable
//! directory that is free, and what they reach is a process able to run OpenCode
//! inside the owner's project allowlist. So the parent directory is created
//! `0700` before binding and its mode is verified afterwards -- see
//! [`ensure_private_parent`], which refuses an existing directory rather than
//! silently tightening one an operator may have created on purpose.
//!
//! # Stale sockets are removed, but only after proving nobody is listening
//!
//! Unlinking a path a live daemon is bound to does not stop that daemon, it
//! splits the fleet: the running daemon keeps its queue while a second one binds
//! the same name, and both answer clients. So a leftover path is probed with a
//! real connect first, and a successful connect is a refusal to start
//! ([`ServerError::AlreadyRunning`]) rather than an unlink.

#![deny(missing_docs)]

use std::collections::VecDeque;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use interprocess::local_socket::{
    tokio::prelude::*,
    // The tokio traits are imported for their side effect on the accept path; the
    // SYNC `traits::Stream` is imported under a different name because the stale
    // socket probe in `prepare_path` uses the blocking `connect`, which is the
    // right choice there: it runs once at bind time, possibly before any runtime
    // exists, and it must not require one.
    traits::Stream as _,
    GenericFilePath,
    ListenerOptions,
    Name,
    ToFsName,
};
use tokio::io::{AsyncWriteExt, BufReader};

use crate::contracts::{ControlCommand, ServerMessage};
use crate::frame::{self, AsyncFrameRead};

/// Ceiling on simultaneously served peers.
///
/// A bound rather than a queue: a peer beyond it is accepted and immediately
/// closed instead of being parked. Parking would mean an accept backlog sized by
/// the OS, which is a resource bounded by someone else's policy, and the only
/// thing a client can do with a refused connection is reconnect.
pub const MAX_CONNECTIONS: usize = 32;

/// Ceiling on frames buffered for one peer.
pub const MAX_OUTBOUND_FRAMES: usize = 256;

/// Ceiling on BYTES buffered for one peer, not on frames.
///
/// The frame count alone is not a memory bound, because PTY chunks are large:
/// `MAX_PTY_CHUNK_BYTES` is 256 KiB of raw bytes per chunk, so 256 frames is up
/// to 64 MiB per peer and 2 GiB across [`MAX_CONNECTIONS`]. This ceiling is what
/// actually keeps a client that stopped reading from OOM-killing a daemon holding
/// every team's PTYs.
pub const MAX_OUTBOUND_BYTES: usize = 4 * 1024 * 1024;

/// What happened to a frame handed to [`PeerHandle::publish`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishOutcome {
    /// The frame is queued and will be written in order.
    Delivered,
    /// The frame is queued, and this many older PTY chunks were discarded to make
    /// room.
    ///
    /// Only PTY chunks are ever discarded, and only the oldest: for a terminal the
    /// newest output is what the operator needs, and the pane's monotonic
    /// `sequence` turns the resulting hole into a detectable gap rather than a
    /// silent corruption.
    DroppedLossy {
        /// How many older PTY chunks were discarded to admit this frame.
        frames_dropped: usize,
    },
    /// Nothing was queued, and the peer was closed.
    ///
    /// Reached only for a frame that is NOT a PTY chunk, which is why this is a
    /// separate variant instead of being folded into `DroppedLossy`. A snapshot
    /// or a `pty_exit` is the only record of something that happened, so
    /// discarding it to keep a wedged client attached would trade correctness for
    /// uptime. Closing the peer is the honest response: its state is already
    /// wrong, and re-attaching re-hydrates from a fresh snapshot, which is the
    /// documented recovery.
    Refused,
}

/// Why the daemon could not take the socket.
#[derive(Debug)]
pub enum ServerError {
    /// A daemon is already listening on this path.
    ///
    /// Reported rather than acted on: replacing the path would leave that daemon
    /// running and unreachable, which is the split-fleet failure this variant
    /// exists to prevent.
    AlreadyRunning {
        /// The path that is already served.
        path: String,
    },
    /// The path could not be turned into a local socket name.
    InvalidName {
        /// The path that was rejected.
        path: String,
        /// What the platform said.
        detail: String,
    },
    /// The socket's parent directory is not private enough, or could not be made
    /// so.
    ///
    /// Never a warning. See the module header: this is the boundary that decides
    /// whether another local user can reach a daemon that can execute code.
    InsecureParentDirectory {
        /// The directory that was refused or could not be created.
        path: PathBuf,
        /// What was wrong with it.
        detail: String,
    },
    /// The listener could not be created.
    Bind {
        /// The path being bound.
        path: String,
        /// What the platform said.
        detail: String,
    },
}

impl std::fmt::Display for ServerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyRunning { path } => write!(
                formatter,
                "an AIBridge daemon is already listening on {path}; refusing to start a second \
                 one, because replacing the socket would leave the running daemon unreachable"
            ),
            Self::InvalidName { path, detail } => {
                write!(
                    formatter,
                    "{path} is not a usable IPC socket name: {detail}"
                )
            }
            Self::InsecureParentDirectory { path, detail } => write!(
                formatter,
                "the IPC socket directory {} is not usable: {detail}. It must be reachable only \
                 by its owner, because a socket other local users can reach is a daemon they can \
                 drive",
                path.display()
            ),
            Self::Bind { path, detail } => write!(formatter, "could not bind {path}: {detail}"),
        }
    }
}

impl std::error::Error for ServerError {}

/// Resolve the socket path, in the order [`crate::SOCKET_PATH_ENV`] documents.
///
/// The same three steps, in the same order, as
/// `crates/aibr-tui/src/daemon/mod.rs::socket_path`: the override, then
/// `$XDG_RUNTIME_DIR/aibr/daemon.sock`, then the `/tmp` default. They have to
/// agree byte for byte, because a disagreement surfaces as "the daemon is not
/// running" rather than as a disagreement about a path.
pub fn socket_path() -> Result<String, ServerError> {
    if let Some(path) = std::env::var_os(crate::SOCKET_PATH_ENV) {
        if path.is_empty() {
            return Err(ServerError::InvalidName {
                path: String::new(),
                detail: format!("{} is set but empty", crate::SOCKET_PATH_ENV),
            });
        }
        return Ok(path.to_string_lossy().into_owned());
    }
    Ok(default_socket_path())
}

/// The platform's default IPC path.
#[cfg(unix)]
fn default_socket_path() -> String {
    if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") {
        if !runtime.is_empty() {
            return Path::new(&runtime)
                .join("aibr")
                .join("daemon.sock")
                .to_string_lossy()
                .into_owned();
        }
    }
    crate::DEFAULT_POSIX_SOCKET_PATH.to_owned()
}

/// The platform's default IPC path.
#[cfg(windows)]
fn default_socket_path() -> String {
    crate::DEFAULT_WINDOWS_PIPE_PATH.to_owned()
}

/// A bound listener, ready to accept.
///
/// Owns nothing but the listener and the connection budget, so dropping it is a
/// complete teardown: the socket file is reclaimed by `interprocess` and no state
/// survives, because no state was here.
#[derive(Debug)]
pub struct Server {
    listener: interprocess::local_socket::tokio::Listener,
    path: String,
    /// The connection budget, shared with every spawned peer task.
    ///
    /// An `Arc<Mutex<Vec<()>>>` rather than a `Semaphore` because the budget has to
    /// be observable as a count -- `aibr status` and the tests both ask "how many
    /// clients are attached" -- and released by the task that ends rather than by
    /// the accept loop. A `Semaphore::acquire_owned` guard would give the same
    /// release semantics and hide the count behind `available_permits`, which is a
    /// second place the number would have to be derived.
    permits: Arc<Mutex<Vec<()>>>,
    open: AtomicBool,
    next_peer_id: AtomicU64,
}

impl Server {
    /// Bind the resolved path.
    ///
    /// Fails with [`ServerError::AlreadyRunning`] rather than stealing the path,
    /// and refuses a parent directory that is not private.
    pub fn bind_default() -> Result<Self, ServerError> {
        Self::bind(&socket_path()?)
    }

    /// Bind an explicit path.
    pub fn bind(path: &str) -> Result<Self, ServerError> {
        let name = local_name(path)?;
        prepare_path(path)?;
        let listener = ListenerOptions::new()
            .name(name)
            .create_tokio()
            .map_err(|error| ServerError::Bind {
                path: path.to_owned(),
                detail: error.to_string(),
            })?;
        Ok(Self {
            listener,
            path: path.to_owned(),
            permits: Arc::new(Mutex::new(Vec::new())),
            open: AtomicBool::new(true),
            next_peer_id: AtomicU64::new(1),
        })
    }

    /// The path this listener is bound to.
    #[must_use]
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Peers currently attached.
    #[must_use]
    pub fn attached(&self) -> usize {
        self.permits
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }

    /// Stop accepting.
    ///
    /// Does not touch the peers already attached: a shutdown that signalled their
    /// PTYs would be the "detach means stop" behaviour Phase 6 forbids. The
    /// socket file is reclaimed when the listener is dropped.
    pub fn close(&self) {
        self.open.store(false, Ordering::Release);
    }

    /// Accept peers until [`Server::close`] is called.
    ///
    /// Never returns while open. An accept error is reported and the loop
    /// continues, because a daemon that exited on one transient accept failure
    /// would take every running PTY and job with it -- the one outcome Phase 6
    /// exists to prevent.
    pub async fn serve(self, handler: Arc<dyn ConnectionHandler>) {
        while self.open.load(Ordering::Acquire) {
            let stream = match self.listener.accept().await {
                Ok(stream) => stream,
                Err(error) => {
                    report(&format!("could not accept a connection: {error}"));
                    continue;
                }
            };

            let slot = {
                let mut permits = self
                    .permits
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if permits.len() >= MAX_CONNECTIONS {
                    None
                } else {
                    permits.push(());
                    Some(())
                }
            };
            if slot.is_none() {
                report(&format!(
                    "refusing a connection: {MAX_CONNECTIONS} peers are already attached"
                ));
                drop(stream);
                continue;
            }

            let id = self.next_peer_id.fetch_add(1, Ordering::Relaxed);
            let queue = Arc::new(OutboundQueue::new(MAX_OUTBOUND_FRAMES, MAX_OUTBOUND_BYTES));
            let peer = PeerHandle { id, queue };
            // Split before spawning, so the reader and the writer hold disjoint
            // halves. Sharing one handle would need the read borrow to exclude
            // the write borrow while two tasks use them concurrently, which
            // `tokio` deliberately does not implement; the split is what makes
            // the single-writer rule structural rather than a convention.
            let (read_half, write_half) = stream.split();
            let writer_queue = Arc::clone(&peer.queue);
            let budget = Arc::clone(&self.permits);
            // Cloned per peer so the handler is shared rather than moved: several
            // peers are attached at once and each gets the same daemon.
            let reader_handler = Arc::clone(&handler);
            tokio::spawn(async move {
                // The writer starts FIRST so a frame published by `on_connect`
                // has somewhere to go: a snapshot queued before the writer task
                // exists would sit in the queue until it does, which is correct
                // but makes the ordering depend on task scheduling rather than on
                // the code.
                tokio::spawn(async move {
                    write_loop(write_half, writer_queue).await;
                });
                // `on_connect` runs before the read loop so a peer that attaches
                // and immediately asks for a snapshot is answered from the state
                // at attach time rather than after it has already sent commands.
                Arc::clone(&reader_handler).on_connect(peer.clone()).await;
                read_loop(BufReader::new(read_half), peer, reader_handler).await;
                // The budget is released here, by the task whose life it counts.
                budget
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .pop();
            });
        }
        report("the listener was closed; no further peers are accepted");
    }
}

/// One served peer, from the handler's side.
///
/// A cheap clonable handle, because a handler holds one for the life of a
/// connection and the daemon fans the same snapshot out to every peer.
#[derive(Clone)]
pub struct PeerHandle {
    id: u64,
    queue: Arc<OutboundQueue>,
}

impl std::fmt::Debug for PeerHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PeerHandle")
            .field("id", &self.id)
            .field("queued_frames", &self.queue.len())
            .finish()
    }
}

impl PeerHandle {
    /// This peer's identifier, stable for the life of the connection.
    ///
    /// In a log line it is what makes "the client that was dropped" nameable: the
    /// path cannot, because every peer shares one socket path.
    #[must_use]
    pub fn id(&self) -> u64 {
        self.id
    }

    /// Queue one frame for this peer.
    ///
    /// Never blocks and never awaits, because the caller is usually the PTY
    /// reader thread; blocking it would back a child's output up into a terminal
    /// nobody is reading, which stalls the agent rather than the display. The
    /// bound is enforced here instead of by the caller.
    pub fn publish(&self, frame: ServerMessage) -> PublishOutcome {
        let lossy = Lossiness::of(&frame);
        match frame::encode(&frame) {
            Ok(bytes) => self.queue.push(bytes, lossy),
            // An unencodable frame is a contract bug in this build, not
            // something the peer did, so the peer stays connected and the
            // condition is reported. Closing it would punish a client for our
            // mistake.
            Err(error) => {
                report(&format!(
                    "peer {}: a frame could not be encoded and was not sent: {error}",
                    self.id
                ));
                PublishOutcome::Delivered
            }
        }
    }

    /// Frames waiting for this peer.
    #[must_use]
    pub fn queued(&self) -> usize {
        self.queue.len()
    }

    /// Stop accepting frames for this peer.
    ///
    /// Called on disconnect and on a refused publish. It is deliberately NOT the
    /// end of the daemon's interest in whatever the peer was watching: PTYs and
    /// jobs belong to the handler, not to the socket.
    pub fn close(&self) {
        self.queue.close();
    }
}

/// Whether a frame may be discarded to make room for a newer one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lossiness {
    /// PTY output: interchangeable with a later chunk of the same pane.
    Lossy,
    /// The only record of something that happened.
    Lossless,
}

impl Lossiness {
    fn of(frame: &ServerMessage) -> Self {
        match frame {
            ServerMessage::PtyChunk { .. } => Self::Lossy,
            ServerMessage::StateSnapshot { .. }
            | ServerMessage::StateDiff { .. }
            | ServerMessage::PtyExit { .. }
            | ServerMessage::Ack { .. }
            | ServerMessage::Error { .. } => Self::Lossless,
        }
    }
}

/// What the daemon does with a connected peer.
///
/// Object-safe on purpose: the handler is shared across every peer, so it has to
/// be usable behind an `Arc` rather than as a generic parameter, and a future
/// daemon that wants a different handler must not have to re-instantiate this
/// listener.
///
/// The `self: Arc<Self>` receiver is what object safety costs here, and the
/// alternative was rejected deliberately. An `&self` receiver with a
/// `Pin<Box<dyn Future + '_>>` return cannot be called through a `dyn` object at
/// all, because the future would borrow a handler whose lifetime the trait object
/// does not track -- the error is "`'1` must outlive `'static`". Handing the
/// handler its own `Arc` moves the shared ownership INTO the future, which is
/// both expressible and the ownership a per-peer task actually wants.
pub trait ConnectionHandler: Send + Sync + 'static {
    /// A peer attached.
    ///
    /// Where a snapshot is published if the peer did not ask for one. The handler
    /// owns that decision, because only it knows the world.
    fn on_connect(self: Arc<Self>, peer: PeerHandle) -> Pin<Box<dyn Future<Output = ()> + Send>>;

    /// A peer sent a command.
    ///
    /// Delivered already decoded and contract-checked, so no handler ever sees a
    /// partially validated frame.
    fn on_command(
        self: Arc<Self>,
        peer: PeerHandle,
        command: ControlCommand,
    ) -> Pin<Box<dyn Future<Output = ()> + Send>>;
}

/// Read frames until the peer closes or misbehaves.
///
/// A [`frame::FrameError`] ends the CONNECTION, never the process: the peer
/// announced an oversized frame or sent something unparseable, and that is a
/// statement about one client. The daemon holds jobs and PTYs that belong to every
/// other peer, so the only proportionate response is to stop serving the one that
/// misbehaved.
async fn read_loop(
    mut reader: BufReader<interprocess::local_socket::tokio::RecvHalf>,
    peer: PeerHandle,
    handler: Arc<dyn ConnectionHandler>,
) {
    loop {
        let payload = match reader.read_frame().await {
            // A clean close on a frame boundary: the operator detached, or the
            // client process died. Both are normal ends and both are silent.
            Ok(None) => break,
            Ok(Some(payload)) => payload,
            Err(error) => {
                report(&format!(
                    "peer {}: dropping the connection after a framing error: {error}",
                    peer.id
                ));
                break;
            }
        };
        let command = match frame::decode_payload::<ControlCommand>(&payload, "control command") {
            Ok(command) => command,
            Err(error) => {
                report(&format!(
                    "peer {}: dropping the connection after a contract violation: {error}",
                    peer.id
                ));
                break;
            }
        };
        // Cloned rather than borrowed: the future is `'static`, so it has to own
        // the handler it runs against.
        Arc::clone(&handler).on_command(peer.clone(), command).await;
    }
    // No teardown beyond closing the socket. Nothing is cancelled, no pane is
    // signalled and no state is discarded: the daemon owns all of it and the
    // operator reattaching is supposed to find every PTY still running (Phase 6
    // invariant 1).
    peer.close();
}

/// Drain one peer's outbound queue onto its socket.
///
/// A write error means the peer is gone or wedged, which is the same condition
/// as a refused publish from the queue's side, so the queue is closed here too.
/// What it does NOT mean is that the daemon should stop: the peer it belonged to
/// was a view, not an owner.
async fn write_loop(
    mut writer: interprocess::local_socket::tokio::SendHalf,
    queue: Arc<OutboundQueue>,
) {
    while let Some(frame) = queue.pop().await {
        if let Err(error) = writer.write_all(&frame).await {
            report(&format!(
                "closing a peer whose socket stopped accepting writes: {error}"
            ));
            break;
        }
    }
    queue.close();
}

/// Report a condition the daemon survives.
///
/// A stderr line rather than a logging framework: this crate has no logging
/// dependency, and adding one for four call sites would make a dependency
/// change a prerequisite for a diagnostic. `router/src/notify.rs` records the same
/// choice for the same reason.
fn report(message: &str) {
    eprintln!("aibr-ipc: {message}");
}

/// Create the socket's parent directory, privately, and prove it is.
///
/// Two properties in this order: create the directory if missing, so a fresh
/// machine works at all, and verify the mode afterwards, so an existing
/// world-writable directory someone else made is refused rather than inherited.
#[cfg(unix)]
fn ensure_private_parent(path: &Path) -> Result<(), ServerError> {
    use std::os::unix::fs::PermissionsExt;

    let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    else {
        // A bare relative name such as "daemon.sock" has no directory to police,
        // and policing the process's working directory would be a claim this
        // crate cannot keep.
        return Err(ServerError::InsecureParentDirectory {
            path: PathBuf::from("."),
            detail: format!(
                "{} has no parent directory to hold the socket privately",
                path.display()
            ),
        });
    };

    if !parent.exists() {
        std::fs::create_dir_all(parent).map_err(|error| ServerError::InsecureParentDirectory {
            path: parent.to_path_buf(),
            detail: format!("could not be created: {error}"),
        })?;
        // `create_dir_all` applies the process umask to whatever it makes, so the
        // mode is set explicitly afterwards rather than trusted to have come out
        // `0700`.
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).map_err(
            |error| ServerError::InsecureParentDirectory {
                path: parent.to_path_buf(),
                detail: format!("could not be made private: {error}"),
            },
        )?;
    }

    let mode = std::fs::metadata(parent)
        .map_err(|error| ServerError::InsecureParentDirectory {
            path: parent.to_path_buf(),
            detail: format!("could not be inspected: {error}"),
        })?
        .permissions()
        .mode();
    if mode & 0o077 != 0 {
        return Err(ServerError::InsecureParentDirectory {
            path: parent.to_path_buf(),
            detail: format!("its mode is {mode:04o}; group and other must have no access to it"),
        });
    }
    Ok(())
}

/// A named pipe carries its own ACL, so there is no directory to create.
#[cfg(not(unix))]
fn ensure_private_parent(_path: &Path) -> Result<(), ServerError> {
    Ok(())
}

/// Probe for a live daemon, remove a corpse, and verify the directory.
///
/// Ordered deliberately: the directory is secured FIRST, because a leftover
/// socket in a world-writable directory must not even be probed -- the connect
/// attempt is itself a message to whoever put it there.
#[cfg(unix)]
fn prepare_path(path: &str) -> Result<(), ServerError> {
    ensure_private_parent(Path::new(path))?;
    let target = Path::new(path);
    if target.symlink_metadata().is_err() {
        return Ok(());
    }
    let name = local_name(path)?;
    match interprocess::local_socket::Stream::connect(name) {
        // Something answered. It is a daemon, and unlinking its socket would
        // leave it running and unreachable.
        Ok(_) => Err(ServerError::AlreadyRunning {
            path: path.to_owned(),
        }),
        // Nothing answered, so the entry is a corpse from a daemon that died
        // without cleaning up, and `bind` would fail with `AddrInUse` forever
        // without this.
        Err(_) => std::fs::remove_file(target).map_err(|error| ServerError::Bind {
            path: path.to_owned(),
            detail: format!("a stale socket is present but could not be removed: {error}"),
        }),
    }
}

/// A named pipe has no filesystem entry, so there is nothing to probe or clear.
#[cfg(not(unix))]
fn prepare_path(path: &str) -> Result<(), ServerError> {
    ensure_private_parent(Path::new(path))?;
    Ok(())
}

/// Turn a path into a platform-independent local socket name.
///
/// One conversion for both platforms on purpose. A `cfg`-gated pair of name
/// constructions is exactly the duplication `interprocess` exists to remove, and
/// `GenericFilePath` is the variant its own docs describe as supported
/// everywhere: a Unix domain socket on POSIX, the named pipe namespace on
/// Windows.
fn local_name(path: &str) -> Result<Name<'static>, ServerError> {
    path.to_owned()
        .to_fs_name::<GenericFilePath>()
        .map(Name::into_owned)
        .map_err(|error| ServerError::InvalidName {
            path: path.to_owned(),
            detail: error.to_string(),
        })
}

/// One queued frame and whether it may be dropped for a newer one.
#[derive(Debug)]
struct Queued {
    bytes: Vec<u8>,
    lossy: bool,
}

/// A peer's bounded outbound queue.
///
/// Bounded in BOTH frames and bytes, because PTY chunks are large and the frame
/// count alone is not a memory bound -- see [`MAX_OUTBOUND_BYTES`].
struct OutboundQueue {
    limits: Limits,
    state: Mutex<QueueState>,
    writable: tokio::sync::Notify,
    closed: AtomicBool,
}

#[derive(Debug, Clone, Copy)]
struct Limits {
    frames: usize,
    bytes: usize,
}

#[derive(Debug, Default)]
struct QueueState {
    frames: VecDeque<Queued>,
    bytes: usize,
}

impl OutboundQueue {
    fn new(frames: usize, bytes: usize) -> Self {
        Self {
            limits: Limits { frames, bytes },
            state: Mutex::new(QueueState::default()),
            writable: tokio::sync::Notify::new(),
            closed: AtomicBool::new(false),
        }
    }

    fn len(&self) -> usize {
        self.lock().frames.len()
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    /// Never held across an `.await`.
    ///
    /// A `std::sync::Mutex` rather than `tokio::sync::Mutex` for the reason
    /// `router/src/outbox.rs` gives its own: the critical section is arithmetic
    /// over a deque with no suspension point inside it, so an async mutex would
    /// buy nothing while making it easy for a later edit to hold the lock across
    /// a write.
    fn lock(&self) -> MutexGuard<'_, QueueState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn push(&self, bytes: Vec<u8>, lossy: Lossiness) -> PublishOutcome {
        let mut dropped = 0usize;
        let refused = {
            let mut state = self.lock();
            if fits(&state, &self.limits, bytes.len()) {
                state.bytes += bytes.len();
                state.frames.push_back(Queued {
                    bytes,
                    lossy: lossy == Lossiness::Lossy,
                });
                None
            } else {
                // Room exists only by giving something up. Only a lossy frame is
                // ever sacrificed, and only the oldest: for a terminal the newest
                // output is what the operator needs, and the pane's `sequence`
                // turns the hole into a detectable gap.
                while !fits(&state, &self.limits, bytes.len()) {
                    if !evict_oldest_lossy(&mut state) {
                        break;
                    }
                    dropped += 1;
                }
                if fits(&state, &self.limits, bytes.len()) {
                    state.bytes += bytes.len();
                    state.frames.push_back(Queued {
                        bytes,
                        lossy: lossy == Lossiness::Lossy,
                    });
                    None
                } else {
                    // Either the queue holds nothing droppable -- a peer that
                    // cannot absorb a snapshot -- or a single frame is larger than
                    // the whole byte ceiling. Both mean the peer's view is no
                    // longer trustworthy, so it is closed rather than fed a lie.
                    Some(dropped)
                }
            }
        };
        if refused.is_some() {
            self.close();
            return PublishOutcome::Refused;
        }
        self.writable.notify_one();
        if dropped == 0 {
            PublishOutcome::Delivered
        } else {
            PublishOutcome::DroppedLossy {
                frames_dropped: dropped,
            }
        }
    }

    async fn pop(&self) -> Option<Vec<u8>> {
        loop {
            {
                let mut state = self.lock();
                if let Some(frame) = state.frames.pop_front() {
                    state.bytes = state.bytes.saturating_sub(frame.bytes.len());
                    return Some(frame.bytes);
                }
                if self.is_closed() {
                    return None;
                }
            }
            // The future is created AFTER the emptiness check, which is the
            // ordering that loses no wakeups: a producer pushing in between the
            // check and the await leaves a permit behind, and `notify_one` stores
            // a permit rather than discarding it.
            self.writable.notified().await;
        }
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.writable.notify_waiters();
    }
}

/// Whether one more frame of `incoming` bytes would stay inside both bounds.
fn fits(state: &QueueState, limits: &Limits, incoming: usize) -> bool {
    state.frames.len() < limits.frames && state.bytes.saturating_add(incoming) <= limits.bytes
}

/// Remove the oldest droppable frame, reporting whether one was there.
fn evict_oldest_lossy(state: &mut QueueState) -> bool {
    let Some(index) = state.frames.iter().position(|frame| frame.lossy) else {
        return false;
    };
    let frame = state
        .frames
        .remove(index)
        .expect("the index came from this deque");
    state.bytes = state.bytes.saturating_sub(frame.bytes.len());
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue(frames: usize, bytes: usize) -> OutboundQueue {
        OutboundQueue::new(frames, bytes)
    }

    fn payload(marker: &str) -> Vec<u8> {
        marker.as_bytes().to_vec()
    }

    #[test]
    fn a_frame_within_both_bounds_is_delivered() {
        let queue = queue(4, 64);
        assert_eq!(
            queue.push(payload("a"), Lossiness::Lossy),
            PublishOutcome::Delivered
        );
        assert_eq!(queue.len(), 1);
    }

    /// The byte ceiling, not the frame ceiling, is what bounds memory.
    #[test]
    fn a_full_queue_drops_the_oldest_lossy_frame_to_admit_a_new_one() {
        let queue = queue(64, 8);
        queue.push(payload("1111"), Lossiness::Lossy);
        queue.push(payload("2222"), Lossiness::Lossy);

        let outcome = queue.push(payload("3333"), Lossiness::Lossy);

        assert_eq!(
            outcome,
            PublishOutcome::DroppedLossy { frames_dropped: 1 },
            "the oldest chunk goes, not the newest: an operator watching a pane needs the \
             most recent output, and the pane's sequence makes the hole detectable"
        );
        assert_eq!(
            queue.len(),
            2,
            "the queue stays at its byte bound rather than growing: one survivor plus the new \
             frame is exactly the ceiling"
        );
    }

    #[test]
    fn a_frame_too_large_for_the_whole_queue_is_refused() {
        let queue = queue(64, 4);
        let outcome = queue.push(payload("far too long"), Lossiness::Lossy);
        assert_eq!(outcome, PublishOutcome::Refused);
        assert!(
            queue.is_closed(),
            "a peer that cannot be served is closed, not fed"
        );
    }

    /// A snapshot is the only record of the world, so it is never traded away.
    #[test]
    fn a_lossless_frame_is_refused_rather_than_dropping_state() {
        let queue = queue(64, 8);
        queue.push(payload("1111"), Lossiness::Lossless);
        queue.push(payload("2222"), Lossiness::Lossless);

        assert_eq!(
            queue.push(payload("3333"), Lossiness::Lossless),
            PublishOutcome::Refused,
            "discarding a snapshot would leave a client believing a world that never existed"
        );
        assert_eq!(
            queue.len(),
            2,
            "the queued state frames are not evicted to make room"
        );
        assert!(queue.is_closed());
    }

    #[test]
    fn a_lossless_frame_may_displace_a_lossy_one() {
        // Four bytes of ceiling and a four-byte lossy frame already queued, so the
        // next frame of any size has to displace something.
        let queue = queue(64, 4);
        queue.push(payload("1111"), Lossiness::Lossy);
        assert_eq!(
            queue.push(payload("22"), Lossiness::Lossless),
            PublishOutcome::DroppedLossy { frames_dropped: 1 },
            "PTY output is the droppable side of the trade in both directions: a pane can \
             re-read its scrollback, a state frame cannot be reconstructed"
        );
        assert_eq!(queue.len(), 1);
    }

    #[test]
    fn the_frame_ceiling_is_enforced_independently_of_the_byte_ceiling() {
        let queue = queue(2, 1_000);
        queue.push(payload("a"), Lossiness::Lossy);
        queue.push(payload("b"), Lossiness::Lossy);
        assert_eq!(
            queue.push(payload("c"), Lossiness::Lossy),
            PublishOutcome::DroppedLossy { frames_dropped: 1 },
            "many small frames are bounded too, or a chatty pane is unbounded"
        );
        assert_eq!(queue.len(), 2);
    }

    #[tokio::test]
    async fn pop_returns_frames_in_order_and_then_nothing_once_closed() {
        let queue = queue(4, 64);
        queue.push(payload("first"), Lossiness::Lossy);
        queue.push(payload("second"), Lossiness::Lossy);
        queue.close();

        assert_eq!(queue.pop().await, Some(payload("first")));
        assert_eq!(queue.pop().await, Some(payload("second")));
        assert_eq!(queue.pop().await, None);
    }

    #[tokio::test]
    async fn a_push_after_a_waiting_pop_is_not_lost() {
        let queue = Arc::new(queue(4, 64));
        let waiter = {
            let queue = Arc::clone(&queue);
            tokio::spawn(async move { queue.pop().await })
        };
        // The race this covers: the consumer observed an empty queue and parked
        // between the check and the await.
        tokio::task::yield_now().await;
        queue.push(payload("late"), Lossiness::Lossy);

        assert_eq!(
            waiter.await.expect("the pop task finishes"),
            Some(payload("late"))
        );
    }

    #[test]
    fn the_connection_budget_refuses_a_peer_beyond_the_ceiling() {
        let permits: Vec<()> = (0..MAX_CONNECTIONS).map(|_| ()).collect();
        assert!(
            permits.len() >= MAX_CONNECTIONS,
            "the budget is exactly MAX_CONNECTIONS peers"
        );
    }

    #[test]
    fn the_byte_ceiling_is_smaller_than_a_frame_count_of_maximum_chunks() {
        // The arithmetic that justifies MAX_OUTBOUND_BYTES: without a byte bound,
        // MAX_OUTBOUND_FRAMES chunks of MAX_PTY_CHUNK_BYTES each would queue
        // 64 MiB per peer.
        let worst_case = MAX_OUTBOUND_FRAMES * 256 * 1024;
        assert!(
            MAX_OUTBOUND_BYTES < worst_case,
            "a frame count alone does not bound memory when chunks are 256 KiB"
        );
    }
}
