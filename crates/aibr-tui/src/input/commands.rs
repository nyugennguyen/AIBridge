//! Turning engine values into validated [`ControlCommand`]s.
//!
//! # WHY EVERY CONSTRUCTOR IS FALLIBLE
//!
//! The generated contracts are not plain `String` fields. `paneId` is
//! `ControlCommand5PaneId`, a newtype whose only constructor is `FromStr` against the
//! pattern `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, and `pty_input`'s `data` is
//! `ControlCommand5Data`, base64 with a length cap. That is the contract enforcing
//! that a pane id is something a daemon can route a message to, and it is worth
//! keeping.
//!
//! The consequence for this engine is that a keystroke CANNOT always become a
//! command. A pane id that fails the pattern -- which a client should never hold, but
//! which a daemon or a future feature might produce -- means the bytes are dropped
//! and the operator is told, rather than the command being sent and answered
//! `not_found`. Silently dropping input is the worse failure: the operator types into
//! an agent that never received the input and concludes the agent hung.
//!
//! So each constructor returns [`Result`], and the reducer maps the error to a
//! [`Toast`](crate::input::Toast) rather than to an empty action list.

use std::num::NonZeroU64;

use aibr_ipc::contracts::{
    ControlCommand1WorkspaceId, ControlCommand2Kind, ControlCommand3PaneId, ControlCommand4PaneId,
    ControlCommand5Data, ControlCommand5PaneId, ControlCommand6JobId, ControlCommand7JobId,
    ControlCommand7Justification0, ControlCommand8JobId,
};
use aibr_ipc::ControlCommand;

use crate::input::traits::ApproveScope;

/// An identifier or payload the contract rejected.
///
/// The generated `ConversionError` is a string-keyed type whose `Display` includes the
/// offending value, which for an identifier comes from the daemon and for `data`
/// comes from the keystrokes. It is deliberately not embedded here: a log line built
/// from it would carry untrusted text into the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidCommand {
    /// Which command could not be built.
    pub command: CommandKind,
}

/// Which command could not be built.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandKind {
    /// `pty_input`.
    PtyInput,
    /// `close_pane`.
    ClosePane,
    /// `resize_pane`.
    ResizePane,
    /// `set_active_workspace`.
    SetActiveWorkspace,
    /// `approve_plan`.
    ApprovePlan,
    /// `reject_plan`.
    RejectPlan,
    /// `cancel_job`.
    CancelJob,
}

impl CommandKind {
    /// The command's wire name, for the error toast.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::PtyInput => "pty_input",
            Self::ClosePane => "close_pane",
            Self::ResizePane => "resize_pane",
            Self::SetActiveWorkspace => "set_active_workspace",
            Self::ApprovePlan => "approve_plan",
            Self::RejectPlan => "reject_plan",
            Self::CancelJob => "cancel_job",
        }
    }
}

impl std::fmt::Display for InvalidCommand {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "the daemon's contract rejected a `{}` argument",
            self.command.name()
        )
    }
}

impl std::error::Error for InvalidCommand {}

/// `pty_input` for `pane_id` carrying `bytes`.
///
/// The bytes are base64-encoded, because the contract's `data` field is a base64
/// string with a 349,530-character cap rather than a byte array. That is not a
/// transport choice this crate made: it is the shape the TypeScript side parses, and
/// a JSON number cannot carry a byte.
pub fn pty_input(pane_id: &str, bytes: &[u8]) -> Result<ControlCommand, InvalidCommand> {
    let pane_id: ControlCommand5PaneId = parse(pane_id).map_err(|_| InvalidCommand {
        command: CommandKind::PtyInput,
    })?;
    let data: ControlCommand5Data = parse(&base64_encode(bytes)).map_err(|_| InvalidCommand {
        command: CommandKind::PtyInput,
    })?;
    Ok(ControlCommand::PtyInput { data, pane_id })
}

/// `close_pane`.
pub fn close_pane(pane_id: &str) -> Result<ControlCommand, InvalidCommand> {
    let pane_id: ControlCommand3PaneId = parse(pane_id).map_err(|_| InvalidCommand {
        command: CommandKind::ClosePane,
    })?;
    Ok(ControlCommand::ClosePane { pane_id })
}

/// `resize_pane`.
///
/// A zero dimension is rejected here rather than sent: `columns` and `rows` are
/// `NonZeroU64` in the contract because a PTY sized to 0x0 makes the process exit, and
/// the reason that fact lives in the type rather than in a daemon-side check is that
/// the client must not be able to construct one.
pub fn resize_pane(
    pane_id: &str,
    columns: u16,
    rows: u16,
) -> Result<ControlCommand, InvalidCommand> {
    let pane_id: ControlCommand4PaneId = parse(pane_id).map_err(|_| InvalidCommand {
        command: CommandKind::ResizePane,
    })?;
    let (Some(columns), Some(rows)) = (
        NonZeroU64::new(u64::from(columns)),
        NonZeroU64::new(u64::from(rows)),
    ) else {
        return Err(InvalidCommand {
            command: CommandKind::ResizePane,
        });
    };
    Ok(ControlCommand::ResizePane {
        columns,
        pane_id,
        rows,
    })
}

/// `set_active_workspace`.
pub fn set_active_workspace(workspace_id: &str) -> Result<ControlCommand, InvalidCommand> {
    let workspace_id: ControlCommand1WorkspaceId =
        parse(workspace_id).map_err(|_| InvalidCommand {
            command: CommandKind::SetActiveWorkspace,
        })?;
    Ok(ControlCommand::SetActiveWorkspace { workspace_id })
}

/// `approve_plan`.
///
/// `scope` is the modal's `Approve and Apply` versus `Approve Step-by-Step`; the
/// justification is left `None` because approving is the operator agreeing with the
/// agent's stated reason, and inventing one would put text in the audit log that the
/// operator did not write.
pub fn approve_plan(job_id: &str, scope: ApproveScope) -> Result<ControlCommand, InvalidCommand> {
    let job_id: ControlCommand6JobId = parse(job_id).map_err(|_| InvalidCommand {
        command: CommandKind::ApprovePlan,
    })?;
    let scope = match scope {
        ApproveScope::Apply => aibr_ipc::contracts::ControlCommand6Scope::Apply,
        ApproveScope::StepByStep => aibr_ipc::contracts::ControlCommand6Scope::StepByStep,
    };
    Ok(ControlCommand::ApprovePlan {
        job_id,
        justification: None,
        scope,
    })
}

/// `reject_plan`, with the operator's reason.
pub fn reject_plan(
    job_id: &str,
    justification: Option<&str>,
) -> Result<ControlCommand, InvalidCommand> {
    let job_id: ControlCommand7JobId = parse(job_id).map_err(|_| InvalidCommand {
        command: CommandKind::RejectPlan,
    })?;
    let justification: Option<ControlCommand7Justification0> = match justification {
        None => None,
        Some(text) => Some(parse(text).map_err(|_| InvalidCommand {
            command: CommandKind::RejectPlan,
        })?),
    };
    Ok(ControlCommand::RejectPlan {
        job_id,
        justification,
    })
}

/// `cancel_job`.
pub fn cancel_job(job_id: &str) -> Result<ControlCommand, InvalidCommand> {
    let job_id: ControlCommand8JobId = parse(job_id).map_err(|_| InvalidCommand {
        command: CommandKind::CancelJob,
    })?;
    Ok(ControlCommand::CancelJob { job_id })
}

/// The `kind` a spawned pane is created with.
#[must_use]
pub fn pane_kind(kind: crate::state::PaneKind) -> ControlCommand2Kind {
    match kind {
        crate::state::PaneKind::Terminal => ControlCommand2Kind::Terminal,
        crate::state::PaneKind::PlanReview => ControlCommand2Kind::PlanReview,
        crate::state::PaneKind::AuditLog => ControlCommand2Kind::AuditLog,
    }
}

/// Parse into one of the contract's validated newtypes.
///
/// The error is DISCARDED. It is a string naming the rejected value, and the rejected
/// value is untrusted; the caller replaces it with [`InvalidCommand`], which carries
/// the command name and nothing else.
fn parse<T: std::str::FromStr>(value: &str) -> Result<T, ()> {
    value.parse().map_err(|_| ())
}

/// Standard base64 with padding, as the contract's `^[A-Za-z0-9+/]*={0,2}$` demands.
///
/// Hand-rolled rather than a dependency because it is thirty lines and pulling a codec
/// crate in for one call site would be a larger supply-chain surface than the thing it
/// replaces. Tested against the RFC 4648 vectors in `tests/`.
#[must_use]
pub fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let group = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let bits = (u32::from(group[0]) << 16) | (u32::from(group[1]) << 8) | u32::from(group[2]);
        out.push(char::from(ALPHABET[(bits >> 18 & 0x3f) as usize]));
        out.push(char::from(ALPHABET[(bits >> 12 & 0x3f) as usize]));
        out.push(if chunk.len() > 1 {
            char::from(ALPHABET[(bits >> 6 & 0x3f) as usize])
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            char::from(ALPHABET[(bits & 0x3f) as usize])
        } else {
            '='
        });
    }
    out
}
