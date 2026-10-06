//! The PTY host: every agent child this machine runs, supervised.
//!
//! # The one property this crate is shaped around
//!
//! **A PTY outlives the client that was watching it.** `aibr tui` can be killed
//! mid-frame, its socket can close, an operator can close the terminal window --
//! and the agent keeps running with its scrollback intact, because reattaching
//! re-hydrates from a fresh [`contracts::StateSnapshot`] rather than from a
//! connection that survived. That is acceptance criterion 6, and it is the reason
//! [`PtyHost`] is an owner of children rather than a thing a connection borrows:
//! there is deliberately no [`Drop`] impl anywhere in this crate that signals a
//! child, so there is no code path from "a peer disconnected" to "an agent died".
//!
//! # Why the sink is a trait and not the IPC connection
//!
//! [`PtySink`] receives [`contracts::PtyChunk`] and [`contracts::PtyExit`] rather
//! than a socket. That indirection is the mechanism for the property above: the
//! reader thread has no reference to any connection, so it cannot be closed by
//! one, and the daemon's job is to fan a chunk out to every attached peer instead.
//! It also keeps this crate off the transport -- `aibr-ipc` is a dependency for the
//! generated wire types and nothing else, so a future client could depend on the
//! contracts without inheriting a process supervisor.
//!
//! # Why a path check exists here AND in the TypeScript engine
//!
//! [`resolve_working_directory`] enforces the same *rule* `assertProjectAllowed`
//! enforces in `src/security/allowlist.ts`: resolve, canonicalise, confirm the
//! result is inside an allowlisted root, refuse otherwise. It is duplicated
//! deliberately, and the duplication is defence in depth rather than a second
//! authority: ADR 0008 §2.2 Tier 2 makes the TypeScript engine the sole authority
//! for allowlist MEMBERSHIP -- what is configured -- while a Rust host that spawns
//! a process with a client-supplied working directory would otherwise be a hole
//! straight through that boundary. The host checks the rule it can check; the
//! engine remains the only thing that decides the list.
//!
//! # What is NOT here
//!
//! Job state, plan review, and cancellation live in the TypeScript engine. This
//! crate knows about processes and terminals, and [`PtyHost::close_pane`] exists
//! because an operator closing a pane is a deliberate act that must reach the
//! child -- the one signal path here, and it is reachable only from an explicit
//! `close_pane`.

#![deny(missing_docs)]

use std::io::Write;
use std::num::NonZeroU64;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, PtySystem};

use aibr_ipc::contracts;

/// Bytes read from a PTY per emitted chunk.
///
/// Below [`contracts::PtyChunk`]'s own base64 ceiling with room for the envelope,
/// and chosen independently of it: the contract says how large a frame may BE,
/// while this says how much output is collected before a client is told anything.
/// Reading in one big gulp would make a fast child invisible until it finished,
/// and reading in tiny gulps would make the sequence numbers a per-byte stream.
const READ_BUFFER_BYTES: usize = 32 * 1024;

/// Why a pane could not be created.
///
/// Each variant is an operator-actionable refusal rather than a string, because
/// every one of these is reported verbatim to a client as
/// `contracts::ServerError::Error` and an operator who sees "invalid" without
/// knowing what was invalid cannot fix anything.
#[derive(Debug)]
pub enum SpawnError {
    /// The working directory is not inside an allowlisted project root.
    WorkingDirectoryNotAllowed {
        /// The path as requested, which is safe to echo: the caller supplied it.
        requested: PathBuf,
    },
    /// The working directory does not exist.
    WorkingDirectoryMissing {
        /// The path as requested.
        requested: PathBuf,
    },
    /// The pane geometry does not fit the PTY's `u16` window size.
    GeometryOutOfRange {
        /// The requested column count.
        columns: u64,
        /// The requested row count.
        rows: u64,
    },
    /// The pane identifier is already in use.
    PaneAlreadyExists {
        /// The pane that already exists.
        pane_id: String,
    },
    /// The child could not be spawned.
    Spawn {
        /// What the platform said.
        detail: String,
    },
}

impl std::fmt::Display for SpawnError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WorkingDirectoryNotAllowed { requested } => write!(
                formatter,
                "{} is not inside an allowlisted project root",
                requested.display()
            ),
            Self::WorkingDirectoryMissing { requested } => {
                write!(formatter, "{} does not exist", requested.display())
            }
            Self::GeometryOutOfRange { columns, rows } => write!(
                formatter,
                "a {columns}x{rows} pane does not fit a terminal's window size"
            ),
            Self::PaneAlreadyExists { pane_id } => {
                write!(formatter, "pane {pane_id} already exists")
            }
            Self::Spawn { detail } => write!(formatter, "the agent could not be started: {detail}"),
        }
    }
}

impl std::error::Error for SpawnError {}

/// Why a pane operation failed.
#[derive(Debug)]
pub enum PaneError {
    /// No pane with this identifier is open.
    NotFound {
        /// The pane that was asked for.
        pane_id: String,
    },
    /// The PTY refused the operation.
    Pty {
        /// What the platform said.
        detail: String,
    },
}

impl std::fmt::Display for PaneError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound { pane_id } => write!(formatter, "pane {pane_id} is not open"),
            Self::Pty { detail } => write!(formatter, "the terminal refused the request: {detail}"),
        }
    }
}

impl std::error::Error for PaneError {}

/// Where PTY output goes.
///
/// Implemented by whatever holds the connections -- the daemon, in production --
/// and by tests. Deliberately NOT a socket: see the module header for why that
/// indirection is what makes the outlives-the-client property structural.
pub trait PtySink: Send + Sync + 'static {
    /// A pane produced bytes.
    ///
    /// `sequence` is per-pane and monotonic, so a client that sees a jump knows
    /// it missed output rather than believing its grid is complete.
    fn on_chunk(&self, chunk: contracts::PtyChunk);

    /// A pane's child exited.
    fn on_exit(&self, exit: contracts::PtyExit);
}

/// Collects events instead of sending them, for tests and for a host with no peers.
#[derive(Debug, Default)]
pub struct RecordingSink {
    chunks: Mutex<Vec<contracts::PtyChunk>>,
    exits: Mutex<Vec<contracts::PtyExit>>,
}

impl RecordingSink {
    /// Every chunk seen, in arrival order.
    #[must_use]
    pub fn chunks(&self) -> Vec<contracts::PtyChunk> {
        lock(&self.chunks).clone()
    }

    /// Every exit seen, in arrival order.
    #[must_use]
    pub fn exits(&self) -> Vec<contracts::PtyExit> {
        lock(&self.exits).clone()
    }

    /// Wait for a chunk whose decoded text contains `needle`.
    ///
    /// Bounded, because a test that waits forever is a test that hangs CI rather
    /// than one that fails.
    pub fn await_chunk_containing(
        &self,
        needle: &str,
        within: std::time::Duration,
    ) -> Option<String> {
        let deadline = std::time::Instant::now() + within;
        while std::time::Instant::now() < deadline {
            for chunk in self.chunks() {
                let decoded = decode_base64(chunk.data.as_str());
                if let Ok(text) = String::from_utf8(decoded.unwrap_or_default()) {
                    if text.contains(needle) {
                        return Some(text);
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        None
    }

    /// Wait for the pane to exit.
    pub fn await_exit(&self, within: std::time::Duration) -> Option<contracts::PtyExit> {
        let deadline = std::time::Instant::now() + within;
        while std::time::Instant::now() < deadline {
            if let Some(exit) = self.exits().first() {
                return Some(exit.clone());
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        None
    }
}

impl PtySink for RecordingSink {
    fn on_chunk(&self, chunk: contracts::PtyChunk) {
        lock(&self.chunks).push(chunk);
    }

    fn on_exit(&self, exit: contracts::PtyExit) {
        lock(&self.exits).push(exit);
    }
}

/// Lock a mutex this crate owns, ignoring poisoning.
///
/// `into_inner` rather than propagating, everywhere in this file: a panic while
/// encoding one chunk must not make a running agent unreachable, which is the
/// opposite of what propagating would achieve. The alternative -- taking the lock
/// only for arithmetic, so no panic can happen inside it -- is true today and is
/// not worth a lock type per field to enforce.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Decode base64 payload text.
fn decode_base64(payload: &str) -> Result<Vec<u8>, base64::DecodeError> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(payload)
}

/// A terminal geometry, converted from the wire's `NonZeroU64` at the boundary.
///
/// The conversion is where a client-supplied number becomes a kernel window size,
/// so it is the place a value that fits neither `u16` nor a sane terminal has to
/// be refused rather than truncated: a truncated column count would render a
/// pane narrower than the client believes, and every line would wrap differently
/// than the layout expects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaneGeometry {
    /// Visible width in character cells.
    pub columns: u16,
    /// Visible height in character cells.
    pub rows: u16,
}

impl PaneGeometry {
    /// Convert the wire's geometry.
    ///
    /// Fails rather than clamping. The contract already caps both at 1000, so a
    /// value this rejects means a peer that is not speaking the contract, and
    /// silently clamping it would hand a client a pane of a different size than it
    /// asked for -- the kind of mismatch that only shows up as wrapped output.
    pub fn from_wire(columns: NonZeroU64, rows: NonZeroU64) -> Result<Self, SpawnError> {
        let to_u16 = |value: u64| u16::try_from(value).ok();
        match (to_u16(columns.get()), to_u16(rows.get())) {
            (Some(columns), Some(rows)) => Ok(Self { columns, rows }),
            _ => Err(SpawnError::GeometryOutOfRange {
                columns: columns.get(),
                rows: rows.get(),
            }),
        }
    }

    fn to_pty(self) -> PtySize {
        PtySize {
            rows: self.rows,
            cols: self.columns,
            // Pixels are not tracked: a pane is measured in cells, and inventing a
            // cell size here would make `SIGWINCH` handling depend on a font
            // measurement this crate has no way to make honestly.
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

/// What to spawn.
#[derive(Debug, Clone)]
pub struct SpawnRequest {
    /// The pane this child belongs to, and the id in every emitted frame.
    pub pane_id: String,
    /// Executable plus argv.
    ///
    /// A vector rather than a shell string because `spawn_pane`'s `command` is
    /// `shortTextSchema` -- one opaque string -- and splitting it here with
    /// `shell-words` semantics would make the daemon a shell. Splitting on
    /// whitespace is the narrower reading and is what the field's length bound
    /// implies; a client that needs shell syntax gets a shell as the program.
    pub command: Vec<String>,
    /// The directory to run in, checked against the allowlist before spawning.
    pub working_directory: PathBuf,
    /// Initial geometry.
    pub geometry: PaneGeometry,
}

impl SpawnRequest {
    /// Split a `spawn_pane` command string into program and argv.
    ///
    /// Whitespace-separated, with no quote handling, and that is a deliberate
    /// limitation rather than an oversight: honouring quotes means implementing a
    /// shell parser in the daemon, and a shell parser in the daemon is a shell
    /// injection surface on a path that runs with the owner's privileges. A
    /// client that needs `"two words"` as one argument should spawn a program that
    /// understands its own arguments.
    #[must_use]
    pub fn split_command(command: &str) -> Vec<String> {
        command.split_whitespace().map(str::to_owned).collect()
    }
}

/// One supervised child and its terminal.
///
/// Public but opaque: a caller can hold one and ask whether the child is alive,
/// which is what the "a dropped connection must not kill the child" test asserts,
/// and cannot reach the PTY or the process handle. Every mutation goes through
/// [`PtyHost`], which is what keeps the check for a pane's existence and the
/// operation on it in one place.
pub struct Pane {
    id: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    geometry: Mutex<PaneGeometry>,
    /// The next value [`Pane::next_sequence`] will hand out.
    ///
    /// Atomic rather than guarded by the pane's mutex because it is read on every
    /// chunk from the reader thread and would otherwise serialise that thread
    /// against every resize.
    sequence: AtomicU64,
}

impl Pane {
    fn next_sequence(&self) -> i64 {
        // `fetch_add` returns the previous value, so the first chunk is 0 rather
        // than 1: the contract's `nonNegativeInteger` allows both, but starting
        // at 0 means an absent chunk and a first chunk are distinguishable by the
        // same counter that detects the gap.
        let next = self.sequence.fetch_add(1, Ordering::Relaxed);
        i64::try_from(next).unwrap_or(i64::MAX)
    }

    /// Whether the child is still running.
    ///
    /// Asks the OS rather than a flag this crate maintains, because a flag could
    /// disagree with reality after an external kill -- and the one caller that
    /// matters ("did the agent survive the client?") needs an answer the OS gives.
    #[must_use]
    pub fn is_running(&self) -> bool {
        lock(&self.child).try_wait().ok().flatten().is_none()
    }

    /// The child's process id, where the platform has one.
    ///
    /// Exposed so an operator can find a runaway agent with `ps`, and so a test can
    /// assert aliveness against the PROCESS rather than against a test double --
    /// which is the only way the Phase 6 property is worth asserting.
    #[must_use]
    pub fn process_id(&self) -> Option<u32> {
        lock(&self.child).process_id()
    }
}

/// Owns every agent child on this machine.
///
/// Cheap to clone and safe to share: the daemon holds one behind an `Arc` and hands
/// it to the IPC listener, and neither the listener nor any connection can close a
/// pane by going away.
#[derive(Clone)]
pub struct PtyHost {
    system: Arc<dyn PtySystem + Send>,
    panes: Arc<Mutex<Vec<Arc<Pane>>>>,
    sink: Arc<dyn PtySink>,
    roots: Arc<Vec<PathBuf>>,
}

impl std::fmt::Debug for PtyHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PtyHost")
            .field("panes", &self.panes().len())
            .field("allowed_roots", &self.roots.len())
            .finish()
    }
}

impl PtyHost {
    /// A host with no allowlisted roots, which spawns nothing.
    ///
    /// For a test that only exercises output and exit, where refusing every
    /// working directory would make the pane impossible to create at all.
    #[must_use]
    pub fn for_tests(sink: Arc<dyn PtySink>) -> Self {
        Self::new(roots_allowing_everything(), sink)
    }

    /// A host that will only spawn inside one of `roots`.
    #[must_use]
    pub fn new(roots: Vec<PathBuf>, sink: Arc<dyn PtySink>) -> Self {
        Self {
            system: Arc::from(portable_pty::native_pty_system()),
            panes: Arc::new(Mutex::new(Vec::new())),
            sink,
            roots: Arc::new(roots),
        }
    }

    /// Every open pane.
    #[must_use]
    pub fn panes(&self) -> Vec<Arc<Pane>> {
        lock(&self.panes).clone()
    }

    /// One pane, if it is open.
    #[must_use]
    pub fn pane(&self, pane_id: &str) -> Option<Arc<Pane>> {
        self.panes().into_iter().find(|pane| pane.id == pane_id)
    }

    /// Spawn a child in a PTY and start streaming its output.
    ///
    /// Returns once the child exists. Output arrives on the [`PtySink`] from a
    /// dedicated reader thread, so this never blocks on a child that produces
    /// nothing -- which an agent sitting at a prompt does indefinitely.
    pub fn spawn(&self, request: SpawnRequest) -> Result<Arc<Pane>, SpawnError> {
        let working_directory = resolve_working_directory(&request.working_directory, &self.roots)?;

        if self.pane(&request.pane_id).is_some() {
            return Err(SpawnError::PaneAlreadyExists {
                pane_id: request.pane_id,
            });
        }

        let Some((program, argv)) = request.command.split_first() else {
            return Err(SpawnError::Spawn {
                detail: "the command was empty".to_owned(),
            });
        };

        let pair = self
            .system
            .openpty(request.geometry.to_pty())
            .map_err(|error| SpawnError::Spawn {
                detail: error.to_string(),
            })?;

        let mut builder = CommandBuilder::new(program);
        builder.args(argv);
        builder.cwd(&working_directory);

        let child = pair
            .slave
            .spawn_command(builder)
            .map_err(|error| SpawnError::Spawn {
                detail: error.to_string(),
            })?;

        // The reader and writer are taken BEFORE the slave and the pair are
        // dropped. Dropping the master would close the terminal's control end and
        // hand the child a SIGHUP, which is exactly the "killing the connection
        // kills the agent" failure this crate exists to make impossible -- here it
        // would be an ordering bug in the spawn path instead.
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| SpawnError::Spawn {
                detail: error.to_string(),
            })?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| SpawnError::Spawn {
                detail: error.to_string(),
            })?;

        let pane = Arc::new(Pane {
            id: request.pane_id.clone(),
            master: Mutex::new(pair.master),
            writer: Mutex::new(Some(writer)),
            child: Mutex::new(child),
            geometry: Mutex::new(request.geometry),
            sequence: AtomicU64::new(0),
        });

        self.read_out(pane.clone(), reader);
        lock(&self.panes).push(pane.clone());
        Ok(pane)
    }

    /// Resize a pane, delivering `SIGWINCH` through the PTY.
    pub fn resize_pane(
        &self,
        pane_id: &str,
        columns: NonZeroU64,
        rows: NonZeroU64,
    ) -> Result<PaneGeometry, PaneError> {
        let geometry = PaneGeometry::from_wire(columns, rows).map_err(|error| PaneError::Pty {
            detail: error.to_string(),
        })?;
        let pane = self.pane(pane_id).ok_or_else(|| PaneError::NotFound {
            pane_id: pane_id.to_owned(),
        })?;
        lock(&pane.master)
            .resize(geometry.to_pty())
            .map_err(|error| PaneError::Pty {
                detail: error.to_string(),
            })?;
        *lock(&pane.geometry) = geometry;
        Ok(geometry)
    }

    /// The pane's current geometry as this host last set it.
    pub fn geometry(&self, pane_id: &str) -> Option<PaneGeometry> {
        let pane = self.pane(pane_id)?;
        let geometry = *lock(&pane.geometry);
        Some(geometry)
    }

    /// Write raw bytes to a pane's terminal.
    ///
    /// This is the input path for a keystroke, a paste, or a bracketed paste.
    pub fn write(&self, pane_id: &str, bytes: &[u8]) -> Result<(), PaneError> {
        let pane = self.pane(pane_id).ok_or_else(|| PaneError::NotFound {
            pane_id: pane_id.to_owned(),
        })?;
        let mut guard = lock(&pane.writer);
        let writer = guard.as_mut().ok_or_else(|| PaneError::Pty {
            detail: "the terminal's write end has been closed".to_owned(),
        })?;
        writer.write_all(bytes).map_err(|error| PaneError::Pty {
            detail: error.to_string(),
        })?;
        // Not flushed on purpose: a PTY is not line buffered, so every flush is a
        // syscall per keystroke, and a client that sends a paste in pieces gets
        // the bytes when the child reads them rather than when we guessed.
        Ok(())
    }

    /// Whether a pane's child is still running.
    #[must_use]
    pub fn is_running(&self, pane_id: &str) -> bool {
        self.pane(pane_id).is_some_and(|pane| pane.is_running())
    }

    /// A pane's child's process id, if the pane is open and the platform has one.
    #[must_use]
    pub fn process_id(&self, pane_id: &str) -> Option<u32> {
        self.pane(pane_id).and_then(|pane| pane.process_id())
    }

    /// Kill a pane's child and forget the pane.
    ///
    /// The ONLY path in this crate that signals a child, and it is reachable only
    /// from an explicit request. There is no `Drop` impl that does this, which is
    /// why a client disappearing cannot reach it.
    pub fn close_pane(&self, pane_id: &str) -> Result<(), PaneError> {
        let pane = self.pane(pane_id).ok_or_else(|| PaneError::NotFound {
            pane_id: pane_id.to_owned(),
        })?;
        {
            let mut child = lock(&pane.child);
            let _ = child.kill();
            let _ = child.wait();
        }
        lock(&self.panes).retain(|open| open.id != pane_id);
        Ok(())
    }

    /// Read a pane's output on its own thread until the child exits.
    ///
    /// A thread per pane rather than an async task: `portable-pty`'s reader is a
    /// blocking `Read`, and wrapping a blocking read in a task would park a runtime
    /// worker for the life of the agent. The cost is one parked OS thread per pane,
    /// which is cheaper than the alternative and is what the PTY API is shaped for.
    fn read_out(&self, pane: Arc<Pane>, mut reader: Box<dyn Read + Send>) {
        let sink = Arc::clone(&self.sink);
        let pane_id = pane.id.clone();
        let _join: JoinHandle<()> = std::thread::spawn(move || {
            let mut buffer = vec![0u8; READ_BUFFER_BYTES];
            loop {
                let count = match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => count,
                    // A PTY reports EIO rather than EOF when the last slave closes,
                    // so an error here is the normal end of a session on Linux and
                    // is not worth reporting as a failure. The exit event below is
                    // the reportable one, and it comes from `wait`.
                    Err(_) => break,
                };
                // A chunk that will not fit the contract is DROPPED rather than
                // truncated: half a UTF-8 sequence or half an escape sequence would
                // corrupt the client's grid silently, whereas a missing sequence
                // number is a gap the client can see and ask to recover from. So the
                // sequence is consumed either way -- the counter above has already
                // advanced -- and the hole is honest.
                if let Some(chunk) = encode_chunk(&pane_id, pane.next_sequence(), &buffer[..count])
                {
                    sink.on_chunk(chunk);
                }
            }
            if let Some(exit) = exit_event(&pane_id, &pane) {
                sink.on_exit(exit);
            }
        });
    }
}

/// `Read` is imported for the reader thread's signature only.
use std::io::Read;

/// Build a chunk, or `None` when the payload would violate the contract.
///
/// The failure being a silent skip is the whole of the comment above it: the
/// alternative is a frame the client's own Zod parse would reject, which would
/// cost it the connection.
fn encode_chunk(pane_id: &str, sequence: i64, bytes: &[u8]) -> Option<contracts::PtyChunk> {
    use base64::Engine as _;

    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(contracts::PtyChunk {
        data: contracts::PtyChunkData::try_from(data).ok()?,
        final_: false,
        pane_id: contracts::PtyChunkPaneId::try_from(pane_id.to_owned()).ok()?,
        sequence,
        type_: "pty_chunk".to_owned(),
    })
}

/// Build the exit frame once a child has been reaped.
fn exit_event(pane_id: &str, pane: &Arc<Pane>) -> Option<contracts::PtyExit> {
    let status = lock(&pane.child).wait().ok()?;
    Some(contracts::PtyExit {
        // `try_wait` above may already have reaped the child, in which case
        // `wait` returns a fresh status with the same contents -- `portable-pty`
        // keeps the last status rather than losing it. Either way the numbers
        // below are the child's, not a placeholder.
        exit_status: Some(i64::from(status.exit_code())),
        pane_id: contracts::PtyExitPaneId::try_from(pane_id.to_owned()).ok()?,
        signal: signal_number(status.signal()),
        type_: "pty_exit".to_owned(),
    })
}

/// The numeric signal a pane's child died from, POSIX only.
///
/// [`contracts::PtyExit::signal`] is a number because a number is what a client
/// can branch on, but `portable-pty` reports a signal as its NAME. So the name is
/// translated back through the platform's own table -- the same
/// `strsignal`-derived strings the name came from -- rather than through a
/// hand-written mapping, which would drift from the platform's and would have to
/// be updated per signal.
///
/// `None` on Windows and for a name the platform does not describe, which the
/// contract permits: the field is nullable precisely because a signal is
/// POSIX-only.
#[cfg(unix)]
fn signal_number(name: Option<&str>) -> Option<i64> {
    let name = name?;
    // SAFETY: `strsignal` returns a pointer to a static NUL-terminated string for
    // every signal number in range, or null for one out of range. Both are
    // checked before use.
    // Scanned over a fixed range rather than `NSIG`, which is not exposed by
    // `libc` on every unix it supports (macOS has no `SIGRTMAX` either). Sixty-four
    // is above every signal number in existence on any platform this crate builds
    // for, and `strsignal` returns null for a number it does not know, so the
    // oversized tail costs a few iterations rather than a wrong answer.
    for number in 1..=64i64 {
        let described = unsafe { libc::strsignal(number as libc::c_int) };
        if described.is_null() {
            continue;
        }
        // SAFETY: non-null `strsignal` results are NUL-terminated static strings.
        let text = unsafe { std::ffi::CStr::from_ptr(described) };
        if text.to_string_lossy() == name {
            return Some(number);
        }
    }
    None
}

/// A pane that exited normally has no signal.
#[cfg(windows)]
fn signal_number(_name: Option<&str>) -> Option<i64> {
    None
}

/// Confirm a working directory is inside an allowlisted root.
///
/// Three steps, in this order, and the order is load-bearing:
///
/// 1. **Reject a relative path.** It would resolve against the daemon's working
///    directory, which is whatever a supervisor chose, and "which directory did
///    that mean" has no good answer.
/// 2. **Require it to exist.** Checked BEFORE the allowlist, and that ordering is
///    deliberate: a directory that is not there cannot be canonicalised, so
///    deferring the check to after the membership test would either canonicalise an
///    ancestor and silently approve a path that does not exist, or report a
///    "not allowed" refusal for what is really a missing-directory mistake. An
///    operator shown the wrong one of those two goes looking in the wrong place.
/// 3. **Canonicalise, then confirm membership.** Symlinks are how "inside the
///    project" becomes "the whole filesystem": a link at an allowed path pointing
///    out of it passes every prefix check on the unresolved path, so the check has
///    to be about the real location. [`Path::starts_with`] then compares whole
///    components, so `/srv/apps/application` does NOT match a root of
///    `/srv/apps/app` -- a string prefix test would say it does, and that is the bug
///    this step exists to avoid.
pub fn resolve_working_directory(
    requested: &Path,
    allowed_roots: &[PathBuf],
) -> Result<PathBuf, SpawnError> {
    if !requested.is_absolute() {
        return Err(SpawnError::WorkingDirectoryNotAllowed {
            requested: requested.to_path_buf(),
        });
    }

    if !requested.exists() {
        return Err(SpawnError::WorkingDirectoryMissing {
            requested: requested.to_path_buf(),
        });
    }

    // Now canonicalisation cannot fail for want of the path, so the error it does
    // return is a real I/O failure and is reported as "not allowed" only because
    // that is the safer of the two things to say about a directory this code could
    // not resolve.
    let Ok(resolved) = requested.canonicalize() else {
        return Err(SpawnError::WorkingDirectoryNotAllowed {
            requested: requested.to_path_buf(),
        });
    };

    let permitted = allowed_roots.iter().any(|root| {
        // The roots are canonicalised too: a configured root that is itself a
        // symlink would otherwise never match the canonicalised candidate, and the
        // failure would read as "your project is not allowed" for a project that is
        // on the list.
        root.canonicalize()
            .map(|root| resolved.starts_with(root))
            .unwrap_or_else(|_| resolved.starts_with(root))
    });

    if permitted {
        return Ok(resolved);
    }
    Err(SpawnError::WorkingDirectoryNotAllowed {
        requested: requested.to_path_buf(),
    })
}

/// The allowlist used by [`PtyHost::for_tests`].
///
/// Canonicalises to `/`, which every absolute path starts with, so it permits
/// every location. It is confined to `for_tests` for exactly that reason: a
/// production host with this list would spawn anything any local client asked,
/// which is the attack the allowlist is here to stop.
fn roots_allowing_everything() -> Vec<PathBuf> {
    vec![PathBuf::from("/")]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_geometry_converts_to_a_window_size() {
        let geometry = PaneGeometry::from_wire(
            NonZeroU64::new(120).expect("nonzero"),
            NonZeroU64::new(40).expect("nonzero"),
        )
        .expect("in range");
        assert_eq!(geometry.columns, 120);
        assert_eq!(geometry.rows, 40);
    }

    /// Truncating here would render a pane narrower than the client believes, and
    /// the mismatch would only show up as wrapped output.
    #[test]
    fn geometry_beyond_a_terminals_range_is_refused_rather_than_truncated() {
        let result = PaneGeometry::from_wire(
            NonZeroU64::new(u16::MAX as u64 + 1).expect("nonzero"),
            NonZeroU64::new(40).expect("nonzero"),
        );
        assert!(
            matches!(result, Err(SpawnError::GeometryOutOfRange { .. })),
            "a pane of 65537 columns must be refused, not rendered at 1 column"
        );
    }

    #[test]
    fn a_command_string_splits_on_whitespace_without_a_shell() {
        assert_eq!(
            SpawnRequest::split_command("opencode  run --model x"),
            vec!["opencode", "run", "--model", "x"]
        );
        assert!(SpawnRequest::split_command("   ").is_empty());
    }

    #[test]
    fn a_relative_working_directory_is_refused() {
        let result = resolve_working_directory(Path::new("relative/dir"), &[PathBuf::from("/")]);
        assert!(
            matches!(result, Err(SpawnError::WorkingDirectoryNotAllowed { .. })),
            "a relative path resolves against whatever working directory a supervisor chose"
        );
    }

    /// A scratch tree of two sibling roots under the system temp directory.
    ///
    /// Canonicalised, because the comparison canonicalises its candidate: on
    /// macOS `temp_dir()` is a symlink (`/var` -> `/private/var`), and a test that
    /// mixed the two forms would be asserting against a mismatch rather than
    /// against the allowlist rule.
    fn scratch(name: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir()
            .join(format!("aibr-pty-{}-{name}", std::process::id()))
            .canonicalize()
            .unwrap_or_else(|_| {
                std::fs::create_dir_all(std::env::temp_dir()).expect("the temp dir exists");
                std::env::temp_dir()
            });
        let allowed = base.join("allowed");
        let outside = base.join("outside");
        std::fs::create_dir_all(&allowed).expect("created");
        std::fs::create_dir_all(&outside).expect("created");
        (allowed, outside)
    }

    #[test]
    fn a_directory_outside_every_root_is_refused() {
        let (allowed, outside) = scratch("outside");
        let result = resolve_working_directory(&outside, &[allowed]);
        assert!(
            matches!(result, Err(SpawnError::WorkingDirectoryNotAllowed { .. })),
            "a sibling directory is outside the allowlist even though it shares a parent"
        );
    }

    #[test]
    fn a_directory_inside_a_root_is_accepted() {
        let (allowed, _) = scratch("inside");
        let requested = allowed.join("project");
        std::fs::create_dir_all(&requested).expect("created");
        let resolved = resolve_working_directory(&requested, &[allowed]).expect("inside a root");
        assert!(resolved.ends_with("project"));
    }

    /// The bug this exists for: a string prefix test accepts
    /// `/srv/apps/application` for a root of `/srv/apps/app`.
    #[test]
    fn a_sibling_with_a_shared_name_prefix_is_not_inside_the_root() {
        let base = std::env::temp_dir().join(format!("aibr-pty-prefix-{}", std::process::id()));
        let root = base.join("app");
        let lookalike = base.join("application");
        std::fs::create_dir_all(&root).expect("created");
        std::fs::create_dir_all(&lookalike).expect("created");

        let result = resolve_working_directory(&lookalike, &[root]);
        assert!(
            matches!(result, Err(SpawnError::WorkingDirectoryNotAllowed { .. })),
            "`starts_with` must compare whole path components, not strings"
        );
    }

    #[test]
    fn a_missing_directory_is_reported_as_missing_rather_than_not_allowed() {
        let (allowed, _) = scratch("missing");
        let result = resolve_working_directory(&allowed.join("not-yet-created"), &[allowed]);
        assert!(
            matches!(result, Err(SpawnError::WorkingDirectoryMissing { .. })),
            "'not allowed' and 'does not exist' are different operator problems"
        );
    }
}
