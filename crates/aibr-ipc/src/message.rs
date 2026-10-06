//! Ergonomic access over the generated [`contracts::ServerMessage`] union.
//!
//! # Why this module is thin, and why that is the point
//!
//! `StateSnapshot` and `ServerMessage::StateSnapshot` are DIFFERENT Rust types
//! with the same shape. typify expands the union's arms in place, so the named
//! root schema `state-snapshot.schema.json` produces `StateSnapshot` with its
//! own `StateSnapshotJobsItem`, while `server-message.schema.json` produces
//! `ServerMessage::StateSnapshot { jobs: Vec<ServerMessage0JobsItem>, .. }`.
//! Two type hierarchies, one wire format.
//!
//! That duplication is a property of the committed JSON Schema, not something
//! this module can repair: the schemas are generated from a Zod
//! `z.discriminatedUnion` whose arms are full objects rather than `$ref`s, and
//! `scripts/generate-contracts.ts` does not rewrite Zod's output into a
//! reference graph. Rewriting it would mean a post-pass inventing structure Zod
//! did not declare, which is the divergence ADR 0008 §2.3 exists to prevent.
//!
//! So there is exactly ONE type hierarchy in play in practice:
//! [`contracts::ServerMessage`]. A consumer that used the named roots would have
//! to convert between the two hierarchies at every boundary, and the conversion
//! would be the easiest place in the codebase to silently drop a field. The
//! named roots remain exported because they are the contract's own names and a
//! schema-level validator benefits from them, but the client's state is built
//! from the union arms.
//!
//! What this module provides is therefore narrow on purpose: [`Frame`], a
//! borrowed-or-owned wrapper that names the six cases once, so a consumer does
//! not repeat a six-arm `match` at every call site and so the tag vocabulary is
//! stated in one place.

use crate::contracts::{self, ServerMessage};

/// The `type` values the daemon may send.
///
/// Declared by hand rather than derived from `ServerMessage`, because serde
/// offers no reflection over an enum's discriminants. It is a
/// `#[serde(rename_all = "snake_case")]` mirror of the `z.literal` tags in
/// `src/ipc/schemas.ts`, and [`tags_agree_with_the_generated_union`] in
/// `tests/tag_parity.rs` fails the build if it and the generated union ever
/// disagree -- by serializing each arm and checking its tag round-trips.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageTag {
    /// A complete world description; replaces local state wholesale.
    StateSnapshot,
    /// An incremental change set; applies only onto its `baseSequence`.
    StateDiff,
    /// Raw PTY bytes for one pane.
    PtyChunk,
    /// A pane's PTY ended.
    PtyExit,
    /// A command was accepted or refused.
    Ack,
    /// A refusal the client must surface rather than swallow.
    Error,
}

/// Borrowed fields of a [`ServerMessage::StateSnapshot`].
///
/// The sequence is `i64` because JSON Schema has one number type, so Zod's
/// `z.number().int()` becomes an integer in Rust but the literal `1` in
/// `protocolVersion` becomes an `f64`. Counts are surfaced as-is rather than
/// narrowed here so that clamping happens once, at the point of use, where a
/// comment can say what a negative count would mean.
#[derive(Debug, Clone, Copy)]
pub struct Snapshot<'frame> {
    /// The sequence later diffs continue from.
    pub sequence: i64,
    /// The daemon's node id.
    pub node_id: &'frame str,
    /// Tailscale connectivity.
    pub tailscale: &'frame contracts::ServerMessage0Tailscale,
    /// Rows still pending in `ingress_outbox`.
    pub outbox_pending_count: i64,
    /// Every job the daemon knows.
    pub jobs: &'frame [contracts::ServerMessage0JobsItem],
    /// Every open pane.
    pub panes: &'frame [contracts::ServerMessage0PanesItem],
    /// Every workspace.
    pub workspaces: &'frame [contracts::ServerMessage0WorkspacesItem],
}

/// Borrowed fields of a [`ServerMessage::StateDiff`].
#[derive(Debug, Clone, Copy)]
pub struct Diff<'frame> {
    /// The sequence this diff applies ONTO.
    ///
    /// A client that is not at this sequence must re-request a snapshot. This
    /// field is the entire reason a client can detect that it has a gap, so it
    /// is named here rather than left inside the generated struct.
    pub base_sequence: i64,
    /// The sequence after applying.
    pub sequence: i64,
    /// The changes, in order.
    pub changes: &'frame [contracts::ServerMessage1ChangesItem],
}

/// Borrowed fields of a [`ServerMessage::PtyChunk`].
#[derive(Debug, Clone, Copy)]
pub struct Chunk<'frame> {
    /// The pane these bytes belong to.
    pub pane_id: &'frame str,
    /// Per-pane monotonic counter, for gap detection.
    pub sequence: i64,
    /// Base64 of raw PTY bytes. UNDECODED: the VT parser owns interpretation,
    /// and decoding here would mean the transport had an opinion about a stream
    /// it does not understand.
    pub data: &'frame str,
    /// Whether this is the last chunk for the pane.
    pub final_: bool,
}

/// One server frame, in the union's own type.
///
/// `Box`ed only in the sense that a `ServerMessage` is large -- a snapshot
/// carries three vectors -- and this enum is stored one-per-connection. No
/// boxing: the alternative is boxing each arm's payload separately and
/// reconstructing a `ServerMessage` at every use, which is the conversion this
/// module's header explains we are avoiding.
#[derive(Debug, Clone)]
pub struct Frame(pub ServerMessage);

impl Frame {
    /// Borrowed views of a snapshot's collections, if this frame is one.
    ///
    /// Returns borrows rather than a clone: a snapshot is the largest frame on
    /// the bus and the client's apply path runs on the render task's thread, so
    /// copying three vectors per snapshot would be the allocation the client
    /// does not need to make. The item types are the union's own, which is why
    /// the client indexes `Vec<ServerMessage0JobsItem>` rather than `Vec<JobView>`
    /// -- see this module's header on the two hierarchies.
    #[must_use]
    pub fn snapshot(&self) -> Option<Snapshot<'_>> {
        match &self.0 {
            ServerMessage::StateSnapshot {
                sequence,
                node_id,
                tailscale,
                outbox_pending_count,
                jobs,
                panes,
                workspaces,
                ..
            } => Some(Snapshot {
                sequence: *sequence,
                node_id: node_id.as_str(),
                tailscale,
                outbox_pending_count: *outbox_pending_count,
                jobs,
                panes,
                workspaces,
            }),
            _ => None,
        }
    }

    /// Borrowed views of a diff's payload, if this frame is one.
    #[must_use]
    pub fn diff(&self) -> Option<Diff<'_>> {
        match &self.0 {
            ServerMessage::StateDiff {
                base_sequence,
                sequence,
                changes,
                ..
            } => Some(Diff {
                base_sequence: *base_sequence,
                sequence: *sequence,
                changes,
            }),
            _ => None,
        }
    }

    /// The PTY chunk's pane, sequence and base64 payload, if this frame is one.
    #[must_use]
    pub fn chunk(&self) -> Option<Chunk<'_>> {
        match &self.0 {
            ServerMessage::PtyChunk {
                pane_id,
                sequence,
                data,
                final_,
                ..
            } => Some(Chunk {
                pane_id: pane_id.as_str(),
                sequence: *sequence,
                data: data.as_str(),
                final_: *final_,
            }),
            _ => None,
        }
    }

    /// Whether this frame is a snapshot.
    #[must_use]
    pub fn is_snapshot(&self) -> bool {
        matches!(self.0, ServerMessage::StateSnapshot { .. })
    }

    /// Whether this frame is a diff.
    #[must_use]
    pub fn is_diff(&self) -> bool {
        matches!(self.0, ServerMessage::StateDiff { .. })
    }

    /// Whether this frame carries PTY bytes.
    #[must_use]
    pub fn is_chunk(&self) -> bool {
        matches!(self.0, ServerMessage::PtyChunk { .. })
    }

    /// This frame's tag.
    ///
    /// Borrowed from the payload rather than reconstructed, so it cannot
    /// disagree with what was actually decoded.
    #[must_use]
    pub fn tag(&self) -> MessageTag {
        match &self.0 {
            ServerMessage::StateSnapshot { .. } => MessageTag::StateSnapshot,
            ServerMessage::StateDiff { .. } => MessageTag::StateDiff,
            ServerMessage::PtyChunk { .. } => MessageTag::PtyChunk,
            ServerMessage::PtyExit { .. } => MessageTag::PtyExit,
            ServerMessage::Ack { .. } => MessageTag::Ack,
            ServerMessage::Error { .. } => MessageTag::Error,
        }
    }
}

/// Why a payload could not be decoded.
///
/// An unknown tag is a PROTOCOL error and is never tolerated. A client that
/// skipped a message it did not recognise would silently drop a `blocked`
/// transition and leave an operator believing an agent is still working.
#[derive(Debug)]
pub enum DecodeError {
    /// The payload is not a JSON object, so it carries no tag.
    NotAnObject,
    /// The `type` field is missing or is not one of the six known tags.
    UnknownTag(String),
    /// The payload was JSON but did not satisfy the union's contract.
    ///
    /// `serde_json::Error` names a field and an offset. It embeds no payload
    /// data, so it is safe to log verbatim.
    Contract(serde_json::Error),
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAnObject => write!(formatter, "frame payload is not a JSON object"),
            Self::UnknownTag(tag) => write!(formatter, "frame has unknown type tag `{tag}`"),
            Self::Contract(error) => write!(formatter, "frame violates its contract: {error}"),
        }
    }
}

impl std::error::Error for DecodeError {}

/// The tag read out of a payload.
fn peek_tag(payload: &[u8]) -> Result<MessageTag, DecodeError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(DecodeError::Contract)?;
    let object = value.as_object().ok_or(DecodeError::NotAnObject)?;
    let tag = object
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| DecodeError::UnknownTag("<absent>".to_owned()))?;
    serde_json::from_value(serde_json::Value::String(tag.to_owned()))
        .map_err(|_| DecodeError::UnknownTag(tag.to_owned()))
}

/// Decode one frame payload.
///
/// The tag is peeked FIRST so an unknown tag is reported as such rather than as
/// a contract failure against whichever arm happened to be tried first -- the
/// difference between "I do not know what this is" and "I know what this is and
/// it is malformed", which are different operator actions.
pub fn decode(payload: &[u8]) -> Result<Frame, DecodeError> {
    peek_tag(payload)?;
    serde_json::from_slice(payload)
        .map(Frame)
        .map_err(DecodeError::Contract)
}
