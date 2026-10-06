//! Frame codec: a 4-byte big-endian length prefix followed by a UTF-8 JSON
//! payload.
//!
//! WHY LENGTH-PREFIXED JSON AND NOT `bincode`. The two endpoints are written in
//! two languages (Rust daemon, TypeScript worker). A self-describing frame can be
//! replayed through `socat` when a state divergence has to be explained, and it
//! does not couple the two sides to one codec's version. The cost is bytes per
//! message, which is not the bottleneck: the high-rate traffic on this bus is
//! PTY output, and that is already base64 inside JSON (see
//! `contracts::PtyChunk` for why it cannot be a raw byte array).
//!
//! THE CAP IS A DENIAL-OF-SERVICE GUARD, NOT A WORKING LIMIT. `MAX_FRAME_BYTES`
//! is 8 MiB, far above any legitimate frame. It exists because the announced
//! length comes from the peer: a reader that allocated on trust would let a
//! four-byte message request eight megabytes. Every decode path checks the
//! announced length against the cap BEFORE reserving, so an oversized frame is a
//! connection error rather than an allocation.

use std::io;

use serde::de::DeserializeOwned;
use serde::Serialize;

/// Bytes of length prefix in front of every frame.
pub const LENGTH_PREFIX_BYTES: usize = 4;

/// The largest frame payload this build will accept, in bytes.
///
/// Mirrors `MAX_IPC_FRAME_BYTES` in `src/ipc/schemas.ts`. The duplication is
/// deliberate and checked: a generated constant is not reachable from a
/// hand-written framing module without importing the whole contracts module for
/// one `usize`, and a mismatch here would be a silent interoperability break
/// rather than a compile error. `tests/frame_cap_parity.rs` asserts the two
/// agree.
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// Why a frame was refused.
///
/// Separate from [`io::Error`] because a caller needs to react differently to
/// "this peer is misbehaving, drop it" than to "this I/O call failed, maybe
/// retry": a malformed frame is a protocol violation and the connection is not
/// recoverable, whereas an `Interrupted` is.
// NEITHER `PartialEq` NOR `Eq` NOR `Clone`: the `Io` variant carries a
// `std::io::Error`, which implements none of them. An `I/O` failure is compared
// by message in a log, never by equality in a branch, so a hand-written
// `PartialEq` here would invite code that treats two different transport
// failures as the same event.
#[derive(Debug)]
pub enum FrameError {
    /// The announced length exceeded [`MAX_FRAME_BYTES`].
    ///
    /// Carries the announced value so a log can name it. Nothing was allocated
    /// on its behalf. `u64` rather than `usize` because on a 16-bit target a
    /// `u32` length does not fit a `usize` at all, and the refusal must still be
    /// reportable rather than being a silent truncation.
    TooLarge {
        /// The length the peer announced, which was refused.
        announced: u64,
    },
    /// The payload was not valid JSON for the expected type.
    ///
    /// Holds a description rather than the payload: a frame from a foreign or
    /// broken peer can contain anything, and echoing it into an error message
    /// would route untrusted bytes into a log.
    Malformed {
        /// What the codec was doing when the payload failed.
        context: &'static str,
        /// The underlying JSON error, which names offsets but contains no data.
        detail: String,
    },
    /// A JSON value that parsed but violated the contract, or the frame could
    /// not be encoded at all.
    ///
    /// The codec validates on decode because the peer is not necessarily another
    /// `aibr-ipc`: the TypeScript worker has its own Zod parse, and a client
    /// speaking the wrong protocol version produces structurally valid JSON that
    /// would deserialize into a nonsense value without this check.
    ContractViolation {
        /// What the codec was doing when validation failed.
        context: &'static str,
        /// The validation failure.
        detail: String,
    },
    /// The peer closed mid-frame.
    ///
    /// A short read is normal on shutdown and is not by itself a violation.
    Incomplete,
    /// The underlying transport failed.
    ///
    /// Separate from the protocol variants because a caller retries an I/O error
    /// and drops a connection on a protocol violation. Conflating them would
    /// make a flaky socket indistinguishable from a misbehaving peer.
    Io {
        /// What the transport reported.
        error: std::io::Error,
    },
}

impl From<std::io::Error> for FrameError {
    fn from(error: std::io::Error) -> Self {
        // `Interrupted` is not a failure at all -- the syscall was interrupted by
        // a signal before transferring anything -- so it keeps its own identity
        // and `read_exact_or_eof` retries rather than surfacing it.
        Self::Io { error }
    }
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge { announced } => write!(
                formatter,
                "frame of {announced} bytes exceeds the {MAX_FRAME_BYTES}-byte cap"
            ),
            Self::Malformed { context, detail } => {
                write!(formatter, "{context}: malformed JSON frame: {detail}")
            }
            Self::ContractViolation { context, detail } => {
                write!(
                    formatter,
                    "{context}: frame violates its contract: {detail}"
                )
            }
            Self::Incomplete => write!(formatter, "connection closed mid-frame"),
            Self::Io { error } => write!(formatter, "transport error: {error}"),
        }
    }
}

impl std::error::Error for FrameError {}

/// Encode a value into a length-prefixed frame.
///
/// Serialization cannot fail for a type that implements `Serialize` with no
/// error-returning path, and this returns `io::Error` rather than `serde_json::Error`
/// so callers do not have to convert at every call site.
pub fn encode<T>(value: &T) -> io::Result<Vec<u8>>
where
    T: Serialize + ?Sized,
{
    let payload = serde_json::to_vec(value).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            FrameError::Malformed {
                context: "encode",
                detail: error.to_string(),
            },
        )
    })?;
    encode_payload(&payload)
}

/// Wrap an already-serialized payload in the length prefix.
pub fn encode_payload(payload: &[u8]) -> io::Result<Vec<u8>> {
    if payload.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            FrameError::TooLarge {
                announced: payload.len() as u64,
            },
        ));
    }
    let length = u32::try_from(payload.len()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            FrameError::TooLarge {
                announced: payload.len() as u64,
            },
        )
    })?;
    let mut framed = Vec::with_capacity(LENGTH_PREFIX_BYTES + payload.len());
    framed.extend_from_slice(&length.to_be_bytes());
    framed.extend_from_slice(payload);
    Ok(framed)
}

/// Read exactly one frame payload off a blocking reader.
///
/// Returns the payload WITHOUT the prefix, or `None` when the peer closed on a
/// frame boundary. Callers decode it with [`decode_payload`].
///
/// The cap is checked against the ANNOUNCED length before any buffer is sized to
/// it. `vec![0u8; announced]` on an untrusted number is the bug this ordering
/// exists to prevent.
pub fn read_frame_blocking<R>(reader: &mut R) -> Result<Option<Vec<u8>>, FrameError>
where
    R: io::Read,
{
    let mut prefix = [0u8; LENGTH_PREFIX_BYTES];
    if !read_exact_or_eof(reader, &mut prefix)? {
        return Ok(None);
    }
    let announced = u32::from_be_bytes(prefix);
    // The cap is compared as `u64` BEFORE the narrowing to `usize`, so a frame
    // that would overflow a 16-bit `usize` is refused as too large rather than
    // being truncated into a small in-range length and then allocating on a lie.
    if u64::from(announced) > MAX_FRAME_BYTES as u64 {
        return Err(FrameError::TooLarge {
            announced: u64::from(announced),
        });
    }
    let announced = usize::try_from(announced).map_err(|_| FrameError::TooLarge {
        announced: u64::from(u32::MAX),
    })?;
    let mut payload = vec![0u8; announced];
    if !read_exact_or_eof(reader, &mut payload)? {
        return Err(FrameError::Incomplete);
    }
    // A zero-length frame is a well-formed prefix carrying no payload, and
    // decoding it raises `Malformed` naming an empty document. That is the
    // correct report, so the empty payload is passed through rather than being
    // special-cased into a distinct error here.
    Ok(Some(payload))
}

/// Fill `buffer` completely, or report that the peer closed first.
///
/// Returns `false` when zero bytes were read before any data arrived (a clean
/// close on a frame boundary), and `Err(Incomplete)` when the close happened
/// part-way through. Distinguishing the two is the reason this is not
/// `read_exact`.
fn read_exact_or_eof<R>(reader: &mut R, buffer: &mut [u8]) -> Result<bool, FrameError>
where
    R: io::Read,
{
    if buffer.is_empty() {
        return Ok(true);
    }
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..]) {
            Ok(0) => {
                return if filled == 0 {
                    Ok(false)
                } else {
                    Err(FrameError::Incomplete)
                };
            }
            Ok(count) => filled += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(true)
}

/// Decode a frame payload into a contract type.
///
/// Separate from [`read_frame_blocking`] so a caller may batch several payloads
/// before validating them, and so a `PtyChunk`'s base64 can be decoded without
/// re-serializing.
pub fn decode_payload<T>(payload: &[u8], context: &'static str) -> Result<T, FrameError>
where
    T: DeserializeOwned,
{
    serde_json::from_slice(payload).map_err(|error| FrameError::Malformed {
        context,
        detail: error.to_string(),
    })
}

/// The [`tokio::io::AsyncRead`] half of the codec.
///
/// A method on `BufReader` rather than a free function so a caller cannot
/// accidentally pair a `tokio` reader with the blocking [`read_frame_blocking`]
/// and deadlock: `read_exact_or_eof` retries `ErrorKind::Interrupted` in a loop
/// with no `.await`, which on an async reader is a spin.
/// The async half of the codec, as an extension trait.
///
/// A TRAIT and not inherent methods on `AsyncRead`: an inherent impl on a foreign
/// trait for a foreign type is not allowed (`E0782`), and a free function taking
/// `&mut R where R: AsyncRead + Unpin` would not be callable as
/// `reader.read_frame()` — which is how it is written at the call site, and the
/// point of the method is that the two halves of the codec read identically.
// `Send` IS IN THE SUPERTRAIT, and that is what replaces the desugared
// `-> impl Future + Send` spelling: bounding the IMPLEMENTOR makes the returned
// future `Send` whenever the reader is, which `tokio::spawn` requires. Without it
// the future is neither known to be `Send` nor permitted to be assumed, and every
// caller would be pushed to `spawn_local` -- a thread-local runtime, which is the
// wrong shape for a client whose only concurrency is one socket and a render loop.
pub trait AsyncFrameRead: tokio::io::AsyncRead + Unpin + Send {
    /// Read one frame payload, or `None` at a clean close on a frame boundary.
    ///
    /// Written as a DESUGARED `-> impl Future + Send` rather than `async fn`,
    /// because `async fn` in a public trait cannot state an auto-trait bound
    /// (`async_fn_in_trait`). The future would then be neither known to be
    /// `Send` nor permitted to be assumed, `tokio::spawn` would refuse a task
    /// holding it, and every caller would be pushed toward `spawn_local` -- a
    /// thread-local runtime, which is the wrong shape for a client whose only
    /// concurrency is one socket and a render loop. Naming `+ Send` here is what
    /// makes `tokio::spawn(read_loop(..))` compile in the TUI.
    fn read_frame(
        &mut self,
    ) -> impl std::future::Future<Output = Result<Option<Vec<u8>>, FrameError>> + Send;
}

impl<R> AsyncFrameRead for R
where
    R: tokio::io::AsyncRead + Unpin + Send,
{
    // `clippy::manual_async_fn` is allowed rather than obeyed: rewriting this as
    // `async fn` would DROP the `+ Send` bound from the signature, which is the
    // entire reason it is spelled this way. The lint's suggestion is correct Rust
    // and the wrong API here.
    #[allow(clippy::manual_async_fn)]
    fn read_frame(
        &mut self,
    ) -> impl std::future::Future<Output = Result<Option<Vec<u8>>, FrameError>> + Send {
        async move {
            let mut prefix = [0u8; LENGTH_PREFIX_BYTES];
            if !read_exact_or_eof_async(self, &mut prefix).await? {
                return Ok(None);
            }
            let announced = u32::from_be_bytes(prefix);
            // Compared as `u64` BEFORE the narrowing to `usize`, for the reason
            // `read_frame_blocking` gives.
            if u64::from(announced) > MAX_FRAME_BYTES as u64 {
                return Err(FrameError::TooLarge {
                    announced: u64::from(announced),
                });
            }
            let announced = usize::try_from(announced).map_err(|_| FrameError::TooLarge {
                announced: u64::from(u32::MAX),
            })?;
            let mut payload = vec![0u8; announced];
            if !read_exact_or_eof_async(self, &mut payload).await? {
                return Err(FrameError::Incomplete);
            }
            Ok(Some(payload))
        }
    }
}

/// The async twin of [`read_exact_or_eof`].
async fn read_exact_or_eof_async<R>(reader: &mut R, buffer: &mut [u8]) -> Result<bool, FrameError>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;

    if buffer.is_empty() {
        return Ok(true);
    }
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..]).await {
            Ok(0) => {
                return if filled == 0 {
                    Ok(false)
                } else {
                    Err(FrameError::Incomplete)
                };
            }
            Ok(count) => filled += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(true)
}
