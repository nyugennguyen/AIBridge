//! The floating human-in-the-loop approval modal.
//!
//! # It must not be dismissible by accident
//!
//! A `blocked` job is waiting for a human decision, and the modal is the only
//! surface that offers one. Acceptance criterion 4 requires it to appear the
//! instant a job blocks, and criterion 5 requires mouse parity -- which together
//! mean a click intended for the terminal behind it must NOT approve or reject
//! anything. So the modal is drawn with `Clear` (genuinely clearing the background
//! cells rather than overdrawing them) and the buttons occupy their own rects that
//! the input engine hit-tests. A click outside the modal's rect reaches the
//! terminal, and a click inside it that is not a button changes focus only.
//!
//! # The decision is a control command, not a local flag
//!
//! Approving sends `ControlCommand::approve_plan` with a scope. `apply` and
//! `step_by_step` are separate grants rather than a boolean because the daemon has
//! to persist WHICH one it was given before resuming the PTY, and "apply the whole
//! plan" and "apply this step and ask again" are not the same permission.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Widget, Wrap};

use crate::input::traits::{ApproveScope, FocusTarget, ModalOutcome};
use crate::state::{BlockedReason, Job};

/// One action the modal offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModalAction {
    /// Apply the whole plan now.
    Approve,
    /// Apply one step, then ask again.
    ApproveStepByStep,
    /// Refuse, with an optional justification.
    Reject,
    /// Cancel the job entirely.
    Abort,
}

impl ModalAction {
    /// The button's label.
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Approve => " Approve and apply ",
            Self::ApproveStepByStep => " Step-by-step ",
            Self::Reject => " Reject ",
            Self::Abort => " Abort job ",
        }
    }

    /// Which focus target this button is.
    #[must_use]
    pub fn target(self) -> FocusTarget {
        match self {
            Self::Approve => FocusTarget::Approve,
            Self::ApproveStepByStep => FocusTarget::ApproveStepByStep,
            Self::Reject => FocusTarget::Reject,
            Self::Abort => FocusTarget::Abort,
        }
    }

    /// Every action, in the order they are drawn.
    pub const ALL: [ModalAction; 4] = [
        ModalAction::Approve,
        ModalAction::ApproveStepByStep,
        ModalAction::Reject,
        ModalAction::Abort,
    ];
}

/// What the modal is currently showing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalModalState {
    /// The job awaiting a decision.
    pub job: Job,
    /// Which button has focus.
    pub focused: FocusTarget,
    /// The rejection justification being typed.
    pub justification: String,
    /// Whether the justification field has focus.
    pub typing: bool,
    /// Whether the agent's secret inspection found anything.
    pub secrets_clean: bool,
}

impl ApprovalModalState {
    /// A modal for `job`, focused on Approve.
    ///
    /// Approve is the default focus because it is the action a reviewer reaching for
    /// the keyboard expects `Enter` to mean. That is also why Reject requires
    /// reaching for `Esc` and Abort requires navigating to it: an accidental `Enter`
    /// applying a plan is the expensive mistake, and it is the one to make hard.
    #[must_use]
    pub fn new(job: Job) -> Self {
        Self {
            job,
            focused: FocusTarget::Approve,
            justification: String::new(),
            typing: false,
            secrets_clean: true,
        }
    }

    /// The reason, in words.
    #[must_use]
    pub fn reason(&self) -> &'static str {
        match self.job.blocked_reason {
            Some(BlockedReason::PlanReview) => "the agent proposed a plan",
            Some(BlockedReason::Permission) => "a tool call asked for permission",
            Some(BlockedReason::UserInput) => "the agent asked a question",
            Some(BlockedReason::PolicyViolation) => "a policy check refused the action",
            None => "the agent is waiting",
        }
    }

    /// The buttons' rects, in draw order.
    ///
    /// Returned alongside the drawing so the input engine hit-tests the SAME rects
    /// that were painted. Recomputing them at the click site is how a click lands on
    /// Reject and approves instead.
    #[must_use]
    pub fn button_rects(&self, area: Rect) -> Vec<(ModalAction, Rect)> {
        // One row of buttons, centred. Wide terminals get them on one line; a narrow
        // one stacks them so a label is never truncated to an unreadable stub.
        let stacked = area.width < 60;
        let mut rects = Vec::with_capacity(ModalAction::ALL.len());
        let mut x = area.x + 2;
        let mut y = area.y.saturating_add(area.height.saturating_sub(3));
        for action in ModalAction::ALL {
            let label_width = u16::try_from(action.label().chars().count()).unwrap_or(u16::MAX);
            let width = label_width.saturating_add(2);
            let rect = if stacked {
                Rect::new(area.x + 2, y, area.width.saturating_sub(4), 1)
            } else {
                Rect::new(x, y, width, 1)
            };
            if stacked {
                y = y.saturating_add(1);
            } else {
                x = x.saturating_add(width + 1);
            }
            rects.push((action, rect));
        }
        rects
    }

    /// Which action a coordinate lands on, if any.
    #[must_use]
    pub fn action_at(&self, area: Rect, column: u16, row: u16) -> Option<ModalAction> {
        self.button_rects(area)
            .into_iter()
            .find(|(_, rect)| {
                column >= rect.x
                    && column < rect.x.saturating_add(rect.width)
                    && row >= rect.y
                    && row < rect.y.saturating_add(rect.height)
            })
            .map(|(action, _)| action)
    }

    /// Turn the current state into a command outcome.
    #[must_use]
    pub fn outcome(&self) -> ModalOutcome {
        match self.focused {
            FocusTarget::Approve => ModalOutcome::Approve {
                scope: ApproveScope::Apply,
            },
            FocusTarget::ApproveStepByStep => ModalOutcome::Approve {
                scope: ApproveScope::StepByStep,
            },
            FocusTarget::Reject => ModalOutcome::Reject {
                justification: (!self.justification.trim().is_empty())
                    .then(|| self.justification.clone()),
            },
            // `typing` is a fifth focus target the buttons do not cover; committing
            // from it means the operator typed a justification and pressed enter.
            FocusTarget::Justification => ModalOutcome::Reject {
                justification: (!self.justification.trim().is_empty())
                    .then(|| self.justification.clone()),
            },
            // Abort has no `outcome`: it cancels the job rather than deciding this
            // prompt, and the shell sends `cancel_job` for it. Returning `Rejected`
            // here would be a lie about what the operator asked for.
            FocusTarget::Abort => ModalOutcome::Dismissed,
        }
    }
}

/// Draw the modal, centred in `area`, and return the rects it used.
pub fn draw_approval_modal(state: &ApprovalModalState, area: Rect, buffer: &mut Buffer) -> Rect {
    // Centred, and never larger than the area: a modal wider than the terminal
    // would have its buttons off-screen, which for an approval prompt means the
    // operator cannot decline.
    let width = area.width.saturating_sub(4).clamp(20, 72);
    let height = area.height.saturating_sub(4).clamp(6, 14);
    let modal = Rect::new(
        area.x
            .saturating_add((area.width.saturating_sub(width)) / 2),
        area.y
            .saturating_add((area.height.saturating_sub(height)) / 2),
        width,
        height,
    );

    // `Clear` rather than overdrawing: an overlay that draws spaces over the pane
    // leaves whatever it did not cover, and the operator reads a half-modal as a
    // whole one.
    Clear.render(modal, buffer);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::LightYellow))
        .title(format!(
            " Human-in-the-Loop Plan Review -- {} ",
            state.job.id
        ));
    let inner = block.inner(modal);
    block.render(modal, buffer);

    let secret_line = if state.secrets_clean {
        "Secret inspection: clean".to_owned()
    } else {
        "Secret inspection: REDACTED CONTENT DETECTED".to_owned()
    };

    let mut lines = vec![
        Line::from(vec![
            Span::raw("Workspace: "),
            Span::styled(
                state.job.workspace_id.clone(),
                Style::default().add_modifier(Modifier::BOLD),
            ),
        ]),
        Line::from(format!("Reason: {}", state.reason())),
        Line::from(format!(
            "Details: {}",
            state.job.detail.as_deref().unwrap_or("(none)")
        )),
        Line::from(Span::styled(
            secret_line,
            Style::default().fg(if state.secrets_clean {
                Color::LightGreen
            } else {
                Color::LightRed
            }),
        )),
    ];
    if state.focused == FocusTarget::Justification || !state.justification.is_empty() {
        lines.push(Line::from(format!(
            "Justification: {}",
            state.justification
        )));
    }

    let body_height = u16::try_from(lines.len()).unwrap_or(u16::MAX);
    Paragraph::new(lines).wrap(Wrap { trim: false }).render(
        Rect::new(
            inner.x,
            inner.y,
            inner.width,
            inner.height.saturating_sub(body_height),
        ),
        buffer,
    );

    for (action, rect) in state.button_rects(modal) {
        let focused = state.focused == action.target();
        let style = if focused {
            Style::default()
                .bg(Color::LightYellow)
                .fg(Color::Black)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::Gray)
        };
        let mut x = rect.x;
        for grapheme in action.label().chars() {
            if x >= rect.x.saturating_add(rect.width) {
                break;
            }
            if rect.y < modal.y.saturating_add(modal.height) {
                buffer[(x, rect.y)]
                    .set_symbol(&grapheme.to_string())
                    .set_style(style);
            }
            x += 1;
        }
    }

    modal
}
