//! What a reducer decides, as values.
//!
//! # WHY ACTIONS AND NOT DIRECT MUTATION
//!
//! Both reducers are pure functions of `(state, event)`. Something has to happen to
//! the outside: bytes go to a PTY, a clipboard is written, the browser opens, the
//! daemon is told to approve a plan. Those are effects, and a pure reducer cannot
//! perform one, so it RETURNS them.
//!
//! Returning them rather than performing them is what makes the whole engine testable
//! without a socket, a clipboard or a screen. It is also what makes a missed effect
//! visible: an effect the reducer forgot to emit is an absent variant in a test's
//! assertion, whereas an effect performed inline is invisible by construction.
//!
//! # WHAT IS *NOT* AN ACTION
//!
//! The mode is not an action. [`InputMode`](crate::state::InputMode) lives on
//! [`Presentation`](crate::state::Presentation) and the reducers mutate it in place,
//! because it is state the render pass reads on the next frame rather than a thing
//! that happened once. Keeping it out of the action stream means the status bar and
//! the reducer can never disagree about the current mode.

use aibr_ipc::ControlCommand;

use crate::input::redact::RedactedText;
use crate::layout::Axis;

/// Something a reducer decided should happen.
///
/// [`PartialEq`] IS HAND-WRITTEN. The generated `ControlCommand` does not derive it --
/// typify emits `Debug`, `Clone` and `Serialize` but no `PartialEq`, because the
/// contract's equality is JSON equality and not Rust structural equality. Action
/// equality is needed by every test in this subsystem ("this drag produced exactly this
/// ratio"), and comparing the ENCODED FRAME is the only comparison that means what the
/// daemon will see. Two commands with the same JSON are the same command on the wire,
/// which is the property a reducer test is asserting.
#[derive(Debug, Clone)]
pub enum Action {
    /// Send a control command to the daemon.
    Command(ControlCommand),
    /// Leave the TUI, leaving every PTY and job running.
    ///
    /// SEPARATE FROM [`Action::Command`] ON PURPOSE. Detaching is a local decision
    /// the client makes about its own lifetime, and it must not be expressible as
    /// something the daemon could have asked for. If it were a command, a future
    /// "the daemon wants the client to disconnect" feature would be one variant away,
    /// and that feature is precisely what the Phase 6 invariant forbids.
    Detach,
    /// Focus a pane locally.
    FocusPane {
        /// The pane to focus.
        pane_id: String,
    },
    /// Make a workspace the active one, locally and on the daemon.
    SetActiveWorkspace {
        /// The workspace to activate.
        workspace_id: String,
    },
    /// Spawn a pane by splitting an existing one.
    ///
    /// NOT A [`Action::Command`], and the reason is specific: `spawn_pane` requires the
    /// command to run and the working directory, and NEITHER IS IN THE INPUT ENGINE'S
    /// HANDS. The operator's click says "split this pane"; it does not say `opencode
    /// --model ...` in `/srv/api`. The shell that already holds a
    /// [`UiState`](crate::state::UiState) knows both, and turning this into a
    /// `spawn_pane` command is its job. Encoding it here would mean inventing a
    /// working directory here too.
    SpawnPaneRequested {
        /// The workspace the new pane belongs to.
        workspace_id: String,
        /// The pane being split.
        parent_pane_id: String,
        /// Which way to split it.
        axis: Axis,
        /// What the new pane shows.
        kind: crate::state::PaneKind,
    },
    /// Open a new tab in a workspace.
    NewTabRequested {
        /// The workspace to add the tab to.
        workspace_id: String,
    },
    /// Show or hide the sidebar.
    SidebarVisible(bool),
    /// Zoom a pane, or unzoom when `pane_id` is `None`.
    ZoomPane {
        /// The pane to zoom, or `None` to restore the split view.
        pane_id: Option<String>,
    },
    /// A split ratio changed and the layout must be recomputed before the next draw.
    ///
    /// NOT a [`Action::Command`]. The layout tree is local presentation state, and the
    /// daemon is told the new pane SIZES once on mouse-up rather than on every motion
    /// event -- see [`Action::PaneResized`] for why.
    ///
    /// The ratio is the one the layout STORED, which is the clamped value. Reporting the
    /// value that was requested would let the status bar disagree with the seam on screen
    /// at exactly the ends of the range, which is where an operator is watching.
    SetSplitRatio {
        /// Which way the seam divides.
        axis: Axis,
        /// The pane nearer the origin.
        first_pane: String,
        /// The pane further from the origin.
        second_pane: String,
        /// The stored ratio, clamped and snapped to a whole cell.
        ratio: f64,
    },
    /// A pane's PTY is now a different size.
    PaneResized {
        /// The pane that was resized.
        pane_id: String,
        /// Its new content width in columns.
        columns: u16,
        /// Its new content height in rows.
        rows: u16,
    },
    /// Scroll a pane's scrollback.
    ScrollPane {
        /// The pane to scroll.
        pane_id: String,
        /// Lines. Positive is further back in history.
        lines: i16,
    },
    /// Scroll the sidebar list.
    ScrollSidebar(i32),
    /// Put already-redacted text on the system clipboard.
    ///
    /// Carries a [`RedactedText`], whose constructor is crate-private, so a caller
    /// outside this crate cannot put an unredacted string on the clipboard even by
    /// constructing the action by hand. Redaction is enforced by the type, not by a
    /// comment.
    CopySelection(RedactedText),
    /// Open an already-validated URL in the system browser.
    ///
    /// Carries a [`SanitizedUrl`](crate::input::SanitizedUrl), not a `String`, so a
    /// URI that failed validation cannot be opened even by mistake. A refused link
    /// produces a [`Action::Toast`] and NO variant of this.
    OpenLink(crate::input::SanitizedUrl),
    /// Copy a pane's raw log to the clipboard, redacted.
    ///
    /// Separate from [`Action::CopySelection`] because "what I dragged over" and "the
    /// whole log" are different requests with different risks, and a right-click menu
    /// that conflates them makes the second one too easy to trigger by accident.
    CopyRawLog(RedactedText),
    /// Show a transient message in the status bar.
    Toast(Toast),
    /// Move the approval modal's focus.
    ///
    /// The modal's own state is behind [`ApprovalModal`](crate::input::ApprovalModal)
    /// and is mutated through that trait; this carries the intent so the render pass
    /// and the modal cannot disagree about where focus is.
    ModalFocus {
        /// The control to focus.
        target: crate::input::FocusTarget,
    },
    /// The approval modal closed and input returns to the underlying mode.
    ModalClosed,
    /// Close a pane.
    ClosePane {
        /// The pane to close.
        pane_id: String,
    },
    /// Jump focus directly to a pending HITL approval card.
    FocusApprovalCard,
    /// Open the universal command palette.
    OpenCommandPalette,
    /// Open the keymap setup modal and cheatsheet.
    OpenKeymapModal,
    /// Switch active keybinding profile.
    SwitchProfile(crate::state::KeybindingProfile),
}

/// A short-lived status-bar message.
///
/// [`Action::Toast`] is emitted for outcomes the operator asked for and cannot see:
/// a copy that happened, a link that was refused, a search that found nothing. It is
/// separate from the copy-mode message so a copy-mode search's message does not
/// overwrite a "Copied to clipboard" the operator just triggered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Toast {
    /// The text.
    pub message: String,
    /// How it is styled.
    pub kind: ToastKind,
}

/// Toast styling, and whether the operator needs to look away from what they were
/// doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToastKind {
    /// Neutral confirmation.
    Info,
    /// Something was refused or failed. The only kind that uses the attention colour,
    /// because it is the only one where NOT reading it has a consequence.
    Warning,
}

impl PartialEq for Action {
    fn eq(&self, other: &Self) -> bool {
        use aibr_ipc::frame::encode;

        match (self, other) {
            (Self::Command(left), Self::Command(right)) => {
                // Encoded frames rather than structural equality; see the type's docs.
                // Two encodings that both failed are treated as equal because the caller
                // cannot tell them apart either, and a test comparing them is asserting
                // something about the reducer, not about the codec.
                encode(left).ok() == encode(right).ok()
            }
            (Self::Detach, Self::Detach) => true,
            (Self::FocusPane { pane_id: left }, Self::FocusPane { pane_id: right }) => {
                left == right
            }
            (
                Self::SetActiveWorkspace { workspace_id: left },
                Self::SetActiveWorkspace {
                    workspace_id: right,
                },
            ) => left == right,
            (
                Self::SpawnPaneRequested {
                    workspace_id: left_workspace,
                    parent_pane_id: left_parent,
                    axis: left_axis,
                    kind: left_kind,
                },
                Self::SpawnPaneRequested {
                    workspace_id: right_workspace,
                    parent_pane_id: right_parent,
                    axis: right_axis,
                    kind: right_kind,
                },
            ) => {
                left_workspace == right_workspace
                    && left_parent == right_parent
                    && left_axis == right_axis
                    && left_kind == right_kind
            }
            (
                Self::NewTabRequested { workspace_id: left },
                Self::NewTabRequested {
                    workspace_id: right,
                },
            ) => left == right,
            (Self::SidebarVisible(left), Self::SidebarVisible(right)) => left == right,
            (Self::ZoomPane { pane_id: left }, Self::ZoomPane { pane_id: right }) => left == right,
            (
                Self::SetSplitRatio {
                    axis: left_axis,
                    first_pane: left_first,
                    second_pane: left_second,
                    ratio: left_ratio,
                },
                Self::SetSplitRatio {
                    axis: right_axis,
                    first_pane: right_first,
                    second_pane: right_second,
                    ratio: right_ratio,
                },
            ) => {
                // Exact, not epsilon: the ratio is a `f64` derived from integers, and a
                // test asserting a clamped or snapped value wants bit equality. An epsilon
                // here would hide a snapping regression, which is the bug this comparison
                // exists to catch.
                left_axis == right_axis
                    && left_first == right_first
                    && left_second == right_second
                    && left_ratio == right_ratio
            }
            (
                Self::PaneResized {
                    pane_id: left_pane,
                    columns: left_columns,
                    rows: left_rows,
                },
                Self::PaneResized {
                    pane_id: right_pane,
                    columns: right_columns,
                    rows: right_rows,
                },
            ) => {
                left_pane == right_pane && left_columns == right_columns && left_rows == right_rows
            }
            (
                Self::ScrollPane {
                    pane_id: left,
                    lines: left_lines,
                },
                Self::ScrollPane {
                    pane_id: right,
                    lines: right_lines,
                },
            ) => left == right && left_lines == right_lines,
            (Self::ScrollSidebar(left), Self::ScrollSidebar(right)) => left == right,
            (Self::CopySelection(left), Self::CopySelection(right)) => left == right,
            (Self::OpenLink(left), Self::OpenLink(right)) => left == right,
            (Self::CopyRawLog(left), Self::CopyRawLog(right)) => left == right,
            (Self::Toast(left), Self::Toast(right)) => left == right,
            (Self::ModalFocus { target: left }, Self::ModalFocus { target: right }) => {
                left == right
            }
            (Self::ModalClosed, Self::ModalClosed) => true,
            (Self::ClosePane { pane_id: left }, Self::ClosePane { pane_id: right }) => {
                left == right
            }
            (Self::FocusApprovalCard, Self::FocusApprovalCard) => true,
            (Self::OpenCommandPalette, Self::OpenCommandPalette) => true,
            (Self::OpenKeymapModal, Self::OpenKeymapModal) => true,
            (Self::SwitchProfile(left), Self::SwitchProfile(right)) => left == right,
            _ => false,
        }
    }
}

impl Toast {
    /// A neutral confirmation.
    #[must_use]
    pub fn info(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            kind: ToastKind::Info,
        }
    }

    /// A refusal or failure.
    #[must_use]
    pub fn warning(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            kind: ToastKind::Warning,
        }
    }
}
