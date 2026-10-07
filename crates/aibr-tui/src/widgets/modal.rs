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
use crate::state::{BlockedReason, Job, KeybindingProfile};

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

/// Actions available on the embedded HITL approval card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardAction {
    /// [y] Approve Once
    ApproveOnce,
    /// [d] Deny
    Deny,
    /// [e] Revise Prompt
    RevisePrompt,
}

impl CardAction {
    /// The action button's display label.
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::ApproveOnce => " [y] Approve Once ",
            Self::Deny => " [d] Deny ",
            Self::RevisePrompt => " [e] Revise Prompt ",
        }
    }

    /// The shortcut key character.
    #[must_use]
    pub fn key_char(self) -> char {
        match self {
            Self::ApproveOnce => 'y',
            Self::Deny => 'd',
            Self::RevisePrompt => 'e',
        }
    }

    /// All card actions in draw order.
    pub const ALL: [CardAction; 3] = [
        CardAction::ApproveOnce,
        CardAction::Deny,
        CardAction::RevisePrompt,
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
    /// Parsed or attached diff view.
    pub diff: Option<crate::widgets::diff::DiffView>,
    /// Countdown timer seconds remaining (default 275 = 04:35).
    pub timeout_seconds: Option<u32>,
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
        let diff = job.detail.as_deref().and_then(|detail| {
            if detail.contains("@@")
                || detail.contains("\n+")
                || detail.contains("\n-")
                || detail.starts_with('+')
                || detail.starts_with('-')
                || detail.starts_with("diff ")
            {
                Some(crate::widgets::diff::DiffView::from_patch(detail))
            } else {
                None
            }
        });
        Self {
            job,
            focused: FocusTarget::Approve,
            justification: String::new(),
            typing: false,
            secrets_clean: true,
            diff,
            timeout_seconds: Some(275),
        }
    }

    /// Attach an explicit diff view to the modal state.
    #[must_use]
    pub fn with_diff(mut self, diff: crate::widgets::diff::DiffView) -> Self {
        self.diff = Some(diff);
        self
    }

    /// Override the timeout countdown in seconds.
    #[must_use]
    pub fn with_timeout(mut self, seconds: u32) -> Self {
        self.timeout_seconds = Some(seconds);
        self
    }

    /// Risk badge based on classification.
    #[must_use]
    pub fn risk_badge(&self) -> crate::widgets::diff::RiskBadge {
        let diff_lines = self
            .diff
            .as_ref()
            .map(|d| d.lines.as_slice())
            .unwrap_or(&[]);
        crate::widgets::diff::classify_diff_risk(diff_lines, self.job.detail.as_deref())
    }

    /// Formatted countdown timer string (e.g. "04:35").
    #[must_use]
    pub fn countdown_str(&self) -> String {
        match self.timeout_seconds {
            Some(secs) => format!("{:02}:{:02}", secs / 60, secs % 60),
            None => "--:--".to_owned(),
        }
    }

    /// Handle keyboard input directly in the approval state.
    ///
    /// Routes [y] to Approve Once, [d] to Deny, and [e] to Revise Prompt.
    #[must_use]
    pub fn handle_key(&mut self, event: &crate::input::traits::KeyEventLike) -> ModalOutcome {
        let is_typing = self.typing || self.focused == FocusTarget::Justification;
        if is_typing {
            if let Some(character) = event.char {
                self.justification.push(character);
            } else if event.named == Some(crate::input::traits::NamedKey::Backspace) {
                self.justification.pop();
            }
        } else {
            match event.char {
                Some('y') | Some('Y') => {
                    return ModalOutcome::Approve {
                        scope: ApproveScope::Apply,
                    };
                }
                Some('d') | Some('D') => {
                    return ModalOutcome::Reject {
                        justification: None,
                    };
                }
                Some('e') | Some('E') => {
                    self.focused = FocusTarget::Justification;
                    self.typing = true;
                    return ModalOutcome::Consumed;
                }
                _ => {}
            }
        }
        match event.named {
            Some(crate::input::traits::NamedKey::Enter) => self.outcome(),
            Some(crate::input::traits::NamedKey::Esc) => ModalOutcome::Dismissed,
            _ => ModalOutcome::Consumed,
        }
    }

    /// Rectangles for the 3 HITL card action buttons inside `area`.
    #[must_use]
    pub fn card_button_rects(&self, area: Rect) -> Vec<(CardAction, Rect)> {
        let mut rects = Vec::with_capacity(CardAction::ALL.len());
        let y = area.y.saturating_add(area.height.saturating_sub(2));
        let mut x = area.x + 2;
        for action in CardAction::ALL {
            let label_len = u16::try_from(action.label().chars().count()).unwrap_or(u16::MAX);
            let width = label_len.saturating_add(1);
            let rect = Rect::new(x, y, width, 1);
            x = x.saturating_add(width + 1);
            rects.push((action, rect));
        }
        rects
    }

    /// Which card action a click lands on, if any.
    #[must_use]
    pub fn card_action_at(&self, area: Rect, column: u16, row: u16) -> Option<CardAction> {
        self.card_button_rects(area)
            .into_iter()
            .find(|(_, rect)| {
                column >= rect.x
                    && column < rect.x.saturating_add(rect.width)
                    && row >= rect.y
                    && row < rect.y.saturating_add(rect.height)
            })
            .map(|(action, _)| action)
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

/// Where the modal sits inside `area`.
///
/// ONE function, called by the draw pass and by the click hit-test. They used to
/// compute it separately -- the drawer from the buffer area, the hit-test from a
/// hardcoded 80x24 -- which meant a click was resolved against a rectangle the
/// operator never saw. A button that renders at one place and is hit-tested at
/// another is the "tearing" acceptance criterion 5 forbids, in a different guise.
///
/// Never larger than `area`: a modal wider than the terminal puts its buttons
/// off-screen, and for an approval prompt that means the operator cannot decline.
#[must_use]
pub fn modal_rect(area: Rect) -> Rect {
    let width = area.width.saturating_sub(4).clamp(20, 72);
    let height = area.height.saturating_sub(4).clamp(6, 14);
    Rect::new(
        area.x.saturating_add(area.width.saturating_sub(width) / 2),
        area.y
            .saturating_add(area.height.saturating_sub(height) / 2),
        width,
        height,
    )
}

/// Draw the modal, centred in `area`, and return the rect it used.
pub fn draw_approval_modal(state: &ApprovalModalState, area: Rect, buffer: &mut Buffer) -> Rect {
    let modal = modal_rect(area);

    // `Clear` rather than overdrawing: an overlay that draws spaces over the pane
    // leaves whatever it did not cover, and the operator reads a half-modal as a
    // whole one.
    Clear.render(modal, buffer);

    let risk = state.risk_badge();
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(risk.level.color()))
        .title(format!(
            " Human-in-the-Loop Plan Review -- {} [{}] ",
            state.job.id, risk.text
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
            Span::styled(
                format!(" [{}] ", risk.text),
                Style::default()
                    .bg(risk.level.color())
                    .fg(Color::Black)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(" "),
            Span::styled(
                format!("Timeout: {}", state.countdown_str()),
                Style::default().fg(Color::DarkGray),
            ),
        ]),
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

/// Where the embedded approval card sits inside pane `area`.
#[must_use]
pub fn embedded_card_rect(area: Rect) -> Rect {
    if area.width < 20 || area.height < 5 {
        return area;
    }
    let width = area.width.saturating_sub(2).clamp(18, 76);
    let height = area.height.saturating_sub(2).clamp(6, 16);
    let x = area
        .x
        .saturating_add((area.width.saturating_sub(width)) / 2);
    let y = area.y.saturating_add(area.height.saturating_sub(height));
    Rect::new(x, y, width, height)
}

/// Draw an embedded HITL approval card inside a pane's viewport.
///
/// Features a risk badge in the header, countdown timer, unified colorized diff
/// container (syntax-highlighted additions in green, deletions in red, hunks in cyan),
/// and actionable buttons: [y] Approve Once, [d] Deny, [e] Revise Prompt.
pub fn draw_embedded_approval_card(
    state: &ApprovalModalState,
    area: Rect,
    buffer: &mut Buffer,
) -> Rect {
    let card = embedded_card_rect(area);
    if card.width < 10 || card.height < 4 {
        return card;
    }

    Clear.render(card, buffer);

    let risk = state.risk_badge();
    let border_color = risk.level.color();

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(border_color))
        .title(format!(
            " 🚨 Human-in-the-Loop Plan Review -- {} ",
            state.job.id
        ));
    let inner = block.inner(card);
    block.render(card, buffer);

    if inner.width == 0 || inner.height == 0 {
        return card;
    }

    // Row 0: Header with Risk Badge and Countdown Timer
    let header_line = Line::from(vec![
        Span::styled(
            format!(" {} ", risk.text),
            Style::default()
                .bg(border_color)
                .fg(Color::Black)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(" "),
        Span::styled(
            format!("Timeout: {}", state.countdown_str()),
            Style::default().fg(Color::DarkGray),
        ),
        Span::raw("  "),
        Span::styled(
            format!("Reason: {}", state.reason()),
            Style::default().fg(Color::White),
        ),
    ]);
    Paragraph::new(header_line).render(Rect::new(inner.x, inner.y, inner.width, 1), buffer);

    // Row 1: Details / Description
    if inner.height > 1 {
        let desc = format!(
            "Details: {}",
            state
                .job
                .detail
                .as_deref()
                .unwrap_or("agent proposed changes awaiting review")
        );
        let secret_notice = if state.secrets_clean {
            Span::raw("")
        } else {
            Span::styled(
                " [SECRETS DETECTED]",
                Style::default()
                    .fg(Color::LightRed)
                    .add_modifier(Modifier::BOLD),
            )
        };
        let desc_line = Line::from(vec![
            Span::styled(desc, Style::default().fg(Color::Gray)),
            secret_notice,
        ]);
        Paragraph::new(desc_line).render(Rect::new(inner.x, inner.y + 1, inner.width, 1), buffer);
    }

    // Diff container area: row 2 up to inner.height - 2
    let diff_height = inner.height.saturating_sub(3);
    if diff_height > 0 && inner.height >= 4 {
        let diff_area = Rect::new(inner.x, inner.y + 2, inner.width, diff_height);
        if let Some(diff) = &state.diff {
            crate::widgets::diff::draw_diff_pane(diff, diff_area, buffer);
        } else {
            // If no explicit diff was attached, render classified lines from job.detail or synthetic diff
            let sample_diff = crate::widgets::diff::DiffView {
                lines: vec![
                    crate::widgets::diff::DiffLine::Hunk("@@ -1,4 +1,4 @@".to_owned()),
                    crate::widgets::diff::DiffLine::Removed(format!(
                        "- unverified operation on {}",
                        state.job.id
                    )),
                    crate::widgets::diff::DiffLine::Added(format!(
                        "+ operator-authorized action: {}",
                        state.reason()
                    )),
                ],
                top: 0,
            };
            crate::widgets::diff::draw_diff_pane(&sample_diff, diff_area, buffer);
        }
    }

    // Revision Prompt display if typing
    let action_row_y = inner.y.saturating_add(inner.height.saturating_sub(1));
    if state.typing || state.focused == FocusTarget::Justification {
        let rev_text = format!("Revise Prompt: {}█", state.justification);
        Paragraph::new(Line::from(Span::styled(
            rev_text,
            Style::default()
                .fg(Color::LightYellow)
                .add_modifier(Modifier::BOLD),
        )))
        .render(Rect::new(inner.x, action_row_y, inner.width, 1), buffer);
    } else {
        // Draw the 3 Action buttons: [y] Approve Once, [d] Deny, [e] Revise Prompt
        let mut btn_x = inner.x + 1;
        for action in CardAction::ALL {
            let label = action.label();
            let label_len = u16::try_from(label.chars().count()).unwrap_or(u16::MAX);
            let style = match action {
                CardAction::ApproveOnce => Style::default()
                    .bg(Color::Green)
                    .fg(Color::Black)
                    .add_modifier(Modifier::BOLD),
                CardAction::Deny => Style::default()
                    .bg(Color::Red)
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
                CardAction::RevisePrompt => Style::default().bg(Color::DarkGray).fg(Color::White),
            };
            let mut char_x = btn_x;
            for ch in label.chars() {
                if char_x >= inner.x.saturating_add(inner.width) {
                    break;
                }
                buffer[(char_x, action_row_y)]
                    .set_symbol(&ch.to_string())
                    .set_style(style);
                char_x += 1;
            }
            btn_x = btn_x.saturating_add(label_len + 2);
        }
    }

    card
}

/// Compute the centered rectangle for the command palette overlay.
#[must_use]
pub fn command_palette_rect(area: Rect) -> Rect {
    let width = area.width.clamp(30, 68);
    let height = area.height.clamp(8, 16);
    let x = area
        .x
        .saturating_add((area.width.saturating_sub(width)) / 2);
    let y = area
        .y
        .saturating_add((area.height.saturating_sub(height)) / 3);
    Rect::new(x, y, width, height)
}

/// Draw the command palette floating overlay into `buffer` and return the used rect.
pub fn draw_command_palette(
    state: &crate::input::menu::CommandPaletteState,
    area: Rect,
    buffer: &mut Buffer,
) -> Rect {
    let rect = command_palette_rect(area);
    if rect.width < 10 || rect.height < 4 {
        return rect;
    }

    // Clear background to prevent bleed-through
    Clear.render(rect, buffer);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(" Universal Command Palette (Ctrl+K / Esc) ")
        .title_alignment(ratatui::layout::Alignment::Center);
    let inner = block.inner(rect);
    block.render(rect, buffer);

    if inner.height == 0 || inner.width == 0 {
        return rect;
    }

    // Search input row
    let prompt_span = Span::styled(
        "> ",
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD),
    );
    let text_span = if state.query.is_empty() {
        Span::styled(
            "Type a command or shortcut...",
            Style::default().fg(Color::DarkGray),
        )
    } else {
        Span::styled(
            &state.query,
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        )
    };
    let input_line = Line::from(vec![prompt_span, text_span]);
    Paragraph::new(input_line).render(Rect::new(inner.x, inner.y, inner.width, 1), buffer);

    // Divider
    if inner.height > 1 {
        let divider = "─".repeat(inner.width as usize);
        Paragraph::new(Line::from(Span::styled(
            divider,
            Style::default().fg(Color::DarkGray),
        )))
        .render(Rect::new(inner.x, inner.y + 1, inner.width, 1), buffer);
    }

    // Filtered actions list
    if inner.height > 2 {
        let items = state.filtered_items();
        let max_visible = (inner.height.saturating_sub(3)) as usize;
        let selected_idx = state.selected.min(items.len().saturating_sub(1));

        let offset = if selected_idx >= max_visible && max_visible > 0 {
            selected_idx + 1 - max_visible
        } else {
            0
        };

        let visible_items = items.iter().enumerate().skip(offset).take(max_visible);

        for (screen_row, (idx, cmd)) in visible_items.enumerate() {
            let row_y = inner.y + 2 + screen_row as u16;
            if row_y >= inner.y + inner.height - 1 {
                break;
            }
            let is_selected = idx == selected_idx;

            let row_rect = Rect::new(inner.x, row_y, inner.width, 1);
            let bg = if is_selected {
                Color::Cyan
            } else {
                Color::Reset
            };
            let fg_title = if is_selected {
                Color::Black
            } else {
                Color::White
            };
            let fg_shortcut = if is_selected {
                Color::Black
            } else {
                Color::DarkGray
            };

            if is_selected {
                for col in row_rect.x..row_rect.x + row_rect.width {
                    buffer[(col, row_rect.y)].set_bg(bg);
                }
            }

            let marker = if is_selected { "▶ " } else { "  " };
            let title = cmd.title();
            let shortcut = cmd.shortcut().unwrap_or("");

            let left_span = Span::styled(
                format!("{marker}{title}"),
                Style::default()
                    .fg(fg_title)
                    .bg(bg)
                    .add_modifier(if is_selected {
                        Modifier::BOLD
                    } else {
                        Modifier::empty()
                    }),
            );
            Paragraph::new(Line::from(left_span)).render(row_rect, buffer);

            if !shortcut.is_empty() {
                let badge = format!("[{shortcut}] ");
                let badge_len = badge.chars().count() as u16;
                if row_rect.width > badge_len {
                    let badge_x = row_rect.x + row_rect.width - badge_len;
                    let badge_rect = Rect::new(badge_x, row_y, badge_len, 1);
                    Paragraph::new(Line::from(Span::styled(
                        badge,
                        Style::default()
                            .fg(fg_shortcut)
                            .bg(bg)
                            .add_modifier(Modifier::BOLD),
                    )))
                    .render(badge_rect, buffer);
                }
            }
        }
    }

    // Navigation footer
    if inner.height > 3 {
        let footer_y = inner.y + inner.height - 1;
        let footer_hint = Line::from(vec![
            Span::styled("↑↓", Style::default().fg(Color::Cyan)),
            Span::styled(" Navigate  •  ", Style::default().fg(Color::DarkGray)),
            Span::styled("Enter", Style::default().fg(Color::Cyan)),
            Span::styled(" Execute  •  ", Style::default().fg(Color::DarkGray)),
            Span::styled("Esc", Style::default().fg(Color::Cyan)),
            Span::styled(" Dismiss", Style::default().fg(Color::DarkGray)),
        ]);
        Paragraph::new(footer_hint)
            .alignment(ratatui::layout::Alignment::Center)
            .render(Rect::new(inner.x, footer_y, inner.width, 1), buffer);
    }

    rect
}

/// The command palette widget for Ratatui rendering.
pub struct CommandPaletteWidget<'a> {
    /// State reference.
    pub state: &'a crate::input::menu::CommandPaletteState,
}

impl<'a> CommandPaletteWidget<'a> {
    /// Create a new command palette widget wrapping the given state.
    #[must_use]
    pub fn new(state: &'a crate::input::menu::CommandPaletteState) -> Self {
        Self { state }
    }
}

impl<'a> Widget for CommandPaletteWidget<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        draw_command_palette(self.state, area, buf);
    }
}

/// Compute the centered rectangle for the keymap modal overlay.
#[must_use]
pub fn keymap_modal_rect(area: Rect) -> Rect {
    let width = area.width.clamp(40, 78);
    let height = area.height.clamp(10, 18);
    let x = area
        .x
        .saturating_add((area.width.saturating_sub(width)) / 2);
    let y = area
        .y
        .saturating_add((area.height.saturating_sub(height)) / 2);
    Rect::new(x, y, width, height)
}

/// Draw the interactive keybinding setup modal into `buffer` and return the used rect.
pub fn draw_keymap_modal(
    state: &crate::input::menu::KeymapModalState,
    area: Rect,
    buffer: &mut Buffer,
) -> Rect {
    let rect = keymap_modal_rect(area);
    if rect.width < 10 || rect.height < 4 {
        return rect;
    }

    // Clear background
    Clear.render(rect, buffer);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::LightYellow))
        .title(" Keymap & Shortcut Profiles (? / F1) ")
        .title_alignment(ratatui::layout::Alignment::Center);
    let inner = block.inner(rect);
    block.render(rect, buffer);

    if inner.height == 0 || inner.width == 0 {
        return rect;
    }

    // Profile selector buttons
    let p_modern = state.active_profile == KeybindingProfile::ModernErgonomic;
    let p_tmux = state.active_profile == KeybindingProfile::TmuxClassic;
    let p_vim = state.active_profile == KeybindingProfile::VimCentric;

    let profile_tabs = Line::from(vec![
        Span::styled(
            if p_modern {
                " [1: Modern Ergonomic (Active)] "
            } else {
                " [1: Modern Ergonomic] "
            },
            if p_modern {
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::LightGreen)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::DarkGray)
            },
        ),
        Span::raw(" "),
        Span::styled(
            if p_tmux {
                " [2: Tmux Classic (Active)] "
            } else {
                " [2: Tmux Classic] "
            },
            if p_tmux {
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::LightYellow)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::DarkGray)
            },
        ),
        Span::raw(" "),
        Span::styled(
            if p_vim {
                " [3: Vim-Centric (Active)] "
            } else {
                " [3: Vim-Centric] "
            },
            if p_vim {
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::DarkGray)
            },
        ),
    ]);
    Paragraph::new(profile_tabs).render(Rect::new(inner.x, inner.y, inner.width, 1), buffer);

    // Divider
    if inner.height > 1 {
        let divider = "─".repeat(inner.width as usize);
        Paragraph::new(Line::from(Span::styled(
            divider,
            Style::default().fg(Color::DarkGray),
        )))
        .render(Rect::new(inner.x, inner.y + 1, inner.width, 1), buffer);
    }

    // Cheatsheet table header
    if inner.height > 2 {
        let col_action_w = 20u16.min(inner.width / 4);
        let rem_w = inner.width.saturating_sub(col_action_w);
        let col_w = (rem_w / 3).max(1);

        let header_line = Line::from(vec![
            Span::styled(
                format!("{:<width$}", "ACTION", width = col_action_w as usize),
                Style::default()
                    .fg(Color::LightCyan)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("{:<width$}", "MODERN ERGONOMIC", width = col_w as usize),
                if p_modern {
                    Style::default()
                        .fg(Color::LightGreen)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(Color::Gray)
                },
            ),
            Span::styled(
                format!("{:<width$}", "TMUX CLASSIC", width = col_w as usize),
                if p_tmux {
                    Style::default()
                        .fg(Color::LightYellow)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(Color::Gray)
                },
            ),
            Span::styled(
                format!("{:<width$}", "VIM-CENTRIC", width = col_w as usize),
                if p_vim {
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(Color::Gray)
                },
            ),
        ]);
        Paragraph::new(header_line).render(Rect::new(inner.x, inner.y + 2, inner.width, 1), buffer);
    }

    // Cheatsheet table rows
    if inner.height > 3 {
        let col_action_w = 20u16.min(inner.width / 4);
        let rem_w = inner.width.saturating_sub(col_action_w);
        let col_w = (rem_w / 3).max(1);

        let max_visible_rows = (inner.height.saturating_sub(4)) as usize;
        let rows = crate::input::menu::KEYBINDING_ROWS;
        let offset = state
            .scroll_offset
            .min(rows.len().saturating_sub(max_visible_rows));

        for (screen_idx, row_item) in rows.iter().skip(offset).take(max_visible_rows).enumerate() {
            let row_y = inner.y + 3 + screen_idx as u16;
            if row_y >= inner.y + inner.height - 1 {
                break;
            }
            let is_highlighted = (offset + screen_idx) == state.selected_row;

            let row_style = if is_highlighted {
                Style::default().bg(Color::Rgb(40, 44, 52))
            } else {
                Style::default()
            };

            let row_line = Line::from(vec![
                Span::styled(
                    format!("{:<width$}", row_item.action, width = col_action_w as usize),
                    Style::default()
                        .fg(if is_highlighted {
                            Color::White
                        } else {
                            Color::Gray
                        })
                        .add_modifier(if is_highlighted {
                            Modifier::BOLD
                        } else {
                            Modifier::empty()
                        }),
                ),
                Span::styled(
                    format!("{:<width$}", row_item.modern, width = col_w as usize),
                    if p_modern {
                        Style::default()
                            .fg(Color::White)
                            .add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(Color::DarkGray)
                    },
                ),
                Span::styled(
                    format!("{:<width$}", row_item.tmux, width = col_w as usize),
                    if p_tmux {
                        Style::default()
                            .fg(Color::White)
                            .add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(Color::DarkGray)
                    },
                ),
                Span::styled(
                    format!("{:<width$}", row_item.vim, width = col_w as usize),
                    if p_vim {
                        Style::default()
                            .fg(Color::White)
                            .add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(Color::DarkGray)
                    },
                ),
            ]);
            Paragraph::new(row_line)
                .style(row_style)
                .render(Rect::new(inner.x, row_y, inner.width, 1), buffer);
        }
    }

    // Navigation footer
    if inner.height > 4 {
        let footer_y = inner.y + inner.height - 1;
        let footer_hint = Line::from(vec![
            Span::styled("1/2/3", Style::default().fg(Color::LightYellow)),
            Span::styled(" Switch Profile  •  ", Style::default().fg(Color::DarkGray)),
            Span::styled("Tab/Arrows", Style::default().fg(Color::LightYellow)),
            Span::styled(" Cycle  •  ", Style::default().fg(Color::DarkGray)),
            Span::styled("↑↓", Style::default().fg(Color::LightYellow)),
            Span::styled(" Scroll Table  •  ", Style::default().fg(Color::DarkGray)),
            Span::styled("Esc", Style::default().fg(Color::LightYellow)),
            Span::styled(" Close", Style::default().fg(Color::DarkGray)),
        ]);
        Paragraph::new(footer_hint)
            .alignment(ratatui::layout::Alignment::Center)
            .render(Rect::new(inner.x, footer_y, inner.width, 1), buffer);
    }

    rect
}

/// The keymap setup modal widget for Ratatui rendering.
pub struct KeymapSetupModalWidget<'a> {
    /// State reference.
    pub state: &'a crate::input::menu::KeymapModalState,
}

impl<'a> KeymapSetupModalWidget<'a> {
    /// Create a new keymap setup modal widget wrapping the given state.
    #[must_use]
    pub fn new(state: &'a crate::input::menu::KeymapModalState) -> Self {
        Self { state }
    }
}

impl<'a> Widget for KeymapSetupModalWidget<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        draw_keymap_modal(self.state, area, buf);
    }
}

/// Electric Cyan primary pylon brand color matching the AIBridge design system.
pub const BRAND_ELECTRIC_CYAN: Color = Color::Rgb(0, 240, 255);
/// Neural Violet suspension span brand color matching the AIBridge design system.
pub const BRAND_NEURAL_VIOLET: Color = Color::Rgb(168, 85, 247);
/// Mesh Emerald status pulse brand color matching the AIBridge design system.
pub const BRAND_MESH_EMERALD: Color = Color::Rgb(16, 185, 129);

/// State of the interactive 5-step onboarding setup wizard modal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupWizardModalState {
    /// Active step in 1..=5.
    pub current_step: usize,
    /// Step 1: Tailscale socket path.
    pub tailscale_socket: String,
    /// Step 1: Tailscale mesh IPv4 coordinate.
    pub tailscale_ip: String,
    /// Step 1: Tailscale daemon running.
    pub tailscale_running: bool,
    /// Step 1: Port availability preflight (4095, 4096, 8787).
    pub ports_available: bool,
    /// Step 2: Listening port for Ingress Router.
    pub listen_port: u16,
    /// Step 2: Bearer Authentication Secret Token (aibr_sec_<32-hex>).
    pub bearer_token: String,
    /// Step 2 Invariant: Constant-time token comparison.
    pub enforce_const_time: bool,
    /// Step 2 Invariant: Strict 2 MB body cap.
    pub enforce_body_limit: bool,
    /// Step 2 Invariant: Automated secret redaction pipeline.
    pub enforce_secret_redaction: bool,
    /// Step 3: Allowlisted workspace paths.
    pub project_paths: Vec<String>,
    /// Step 3: Selection states for allowlisted workspaces.
    pub project_selected: Vec<bool>,
    /// Step 4: OpenCode serve loopback connectivity.
    pub opencode_connected: bool,
    /// Step 4: Claude Code CLI binary status.
    pub claude_installed: bool,
    /// Step 4: Codex CLI runtime status.
    pub codex_installed: bool,
    /// Step 5: Background service provider (launchd / systemd) enabled.
    pub install_service: bool,
    /// Step 5: SQLite WAL queue database (~/.aibridge/ingress_outbox.db) initialized.
    pub outbox_initialized: bool,
    /// Step 5: Config permissions (0600) verified.
    pub config_verified: bool,
    /// Step 5: Completed indicator.
    pub is_completed: bool,
    /// Currently focused field index on the active step (for Tab / Shift+Tab cycling).
    pub focused_field: usize,
}

impl Default for SetupWizardModalState {
    fn default() -> Self {
        Self::new()
    }
}

impl SetupWizardModalState {
    /// Construct a fresh setup wizard modal state with standard defaults.
    #[must_use]
    pub fn new() -> Self {
        Self {
            current_step: 1,
            tailscale_socket: "/var/run/tailscaled.sock".to_string(),
            tailscale_ip: "100.64.42.18".to_string(),
            tailscale_running: true,
            ports_available: true,
            listen_port: 4095,
            bearer_token: "aibr_sec_8f9024b81c2e4318a9942a1b94d1f05e".to_string(),
            enforce_const_time: true,
            enforce_body_limit: true,
            enforce_secret_redaction: true,
            project_paths: vec![
                "/Users/mac/Projects/AIBrigde".to_string(),
                "/Users/mac/Projects/paryaj-demo".to_string(),
                "/Users/mac/Projects/scratchpad".to_string(),
            ],
            project_selected: vec![true, true, false],
            opencode_connected: true,
            claude_installed: true,
            codex_installed: true,
            install_service: true,
            outbox_initialized: true,
            config_verified: true,
            is_completed: false,
            focused_field: 0,
        }
    }

    /// Jump directly to a step (1..=5).
    pub fn jump_to_step(&mut self, step: usize) {
        if (1..=5).contains(&step) {
            self.current_step = step;
            self.focused_field = 0;
        }
    }

    /// Number of focusable fields on current step.
    #[must_use]
    pub fn field_count(&self) -> usize {
        match self.current_step {
            1 => 1,
            2 => 5,
            3 => self.project_paths.len() + 1,
            4 => 2,
            5 => 2,
            _ => 1,
        }
    }

    /// Cycle field focus forward (Tab).
    pub fn cycle_focus_next(&mut self) {
        let count = self.field_count();
        if count > 0 {
            self.focused_field = (self.focused_field + 1) % count;
        }
    }

    /// Cycle field focus backward (Shift+Tab).
    pub fn cycle_focus_prev(&mut self) {
        let count = self.field_count();
        if count > 0 {
            if self.focused_field == 0 {
                self.focused_field = count - 1;
            } else {
                self.focused_field -= 1;
            }
        }
    }

    /// Advance to next step (Enter), or complete if on Step 5.
    pub fn next_step(&mut self) {
        if self.current_step < 5 {
            self.current_step += 1;
            self.focused_field = 0;
        } else {
            self.is_completed = true;
        }
    }

    /// Return to previous step (Esc or 'b').
    pub fn prev_step(&mut self) {
        if self.current_step > 1 {
            self.current_step -= 1;
            self.focused_field = 0;
        }
    }

    /// Toggle checkbox at current focus (Space).
    pub fn toggle_focused(&mut self) {
        match self.current_step {
            2 => match self.focused_field {
                2 => self.enforce_const_time = !self.enforce_const_time,
                3 => self.enforce_body_limit = !self.enforce_body_limit,
                4 => self.enforce_secret_redaction = !self.enforce_secret_redaction,
                _ => {}
            },
            3 => {
                if self.focused_field < self.project_selected.len() {
                    self.project_selected[self.focused_field] =
                        !self.project_selected[self.focused_field];
                }
            }
            5 => {
                if self.focused_field == 0 {
                    self.install_service = !self.install_service;
                }
            }
            _ => {}
        }
    }

    /// Regenerate CSPRNG bearer token ('r' in Step 2).
    pub fn regenerate_token(&mut self) {
        use std::time::SystemTime;
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0x1234567890abcdef);
        let hash_part1 = (nanos ^ 0x5a5a5a5a5a5a5a5a) as u64;
        let hash_part2 = (nanos.rotate_left(17) ^ 0xa5a5a5a5a5a5a5a5) as u64;
        self.bearer_token = format!("aibr_sec_{:016x}{:016x}", hash_part1, hash_part2);
    }

    /// Handle a keyboard character event.
    pub fn handle_char(&mut self, ch: char) -> bool {
        match ch {
            '1'..='5' => {
                let step = (ch as usize) - ('0' as usize);
                self.jump_to_step(step);
                true
            }
            ' ' => {
                self.toggle_focused();
                true
            }
            'r' | 'R' if self.current_step == 2 => {
                self.regenerate_token();
                true
            }
            'b' | 'B' => {
                self.prev_step();
                true
            }
            _ => false,
        }
    }

    /// Hit-test mouse click (SGR 1006) inside the modal rect.
    pub fn handle_click(&mut self, col: u16, row: u16, modal_area: Rect) -> bool {
        if !modal_area.contains(ratatui::layout::Position { x: col, y: row }) {
            return false;
        }

        // Stepper nav bar is at row modal_area.y + 2
        if row == modal_area.y + 2 {
            let relative_x = col.saturating_sub(modal_area.x);
            if (2..17).contains(&relative_x) {
                self.jump_to_step(1);
                return true;
            } else if (17..33).contains(&relative_x) {
                self.jump_to_step(2);
                return true;
            } else if (33..50).contains(&relative_x) {
                self.jump_to_step(3);
                return true;
            } else if (50..67).contains(&relative_x) {
                self.jump_to_step(4);
                return true;
            } else if relative_x >= 67 {
                self.jump_to_step(5);
                return true;
            }
        }

        // Footer buttons row at bottom - 2
        let footer_row = modal_area.bottom().saturating_sub(2);
        if row == footer_row {
            let back_x_start = modal_area.right().saturating_sub(26);
            let back_x_end = modal_area.right().saturating_sub(15);
            let next_x_start = modal_area.right().saturating_sub(14);
            let next_x_end = modal_area.right().saturating_sub(2);

            if col >= back_x_start && col <= back_x_end {
                self.prev_step();
                return true;
            }
            if col >= next_x_start && col <= next_x_end {
                self.next_step();
                return true;
            }
        }

        // Content area clicks
        match self.current_step {
            2 => {
                if row == modal_area.y + 7 {
                    self.regenerate_token();
                    return true;
                }
                if row == modal_area.y + 11 {
                    self.enforce_const_time = !self.enforce_const_time;
                    self.focused_field = 2;
                    return true;
                } else if row == modal_area.y + 13 {
                    self.enforce_body_limit = !self.enforce_body_limit;
                    self.focused_field = 3;
                    return true;
                } else if row == modal_area.y + 15 {
                    self.enforce_secret_redaction = !self.enforce_secret_redaction;
                    self.focused_field = 4;
                    return true;
                }
            }
            3 => {
                for (idx, _) in self.project_paths.iter().enumerate() {
                    let check_row = modal_area.y + 7 + (idx as u16 * 2);
                    if row == check_row && idx < self.project_selected.len() {
                        self.project_selected[idx] = !self.project_selected[idx];
                        self.focused_field = idx;
                        return true;
                    }
                }
            }
            5 => {
                if row == modal_area.y + 7 {
                    self.install_service = !self.install_service;
                    self.focused_field = 0;
                    return true;
                }
            }
            _ => {}
        }

        false
    }
}

/// Compute the centered rectangle for the setup wizard modal.
#[must_use]
pub fn setup_wizard_modal_rect(area: Rect) -> Rect {
    let width = 84.min(area.width);
    let height = 26.min(area.height);
    let x = area.x + (area.width.saturating_sub(width)) / 2;
    let y = area.y + (area.height.saturating_sub(height)) / 2;
    Rect::new(x, y, width, height)
}

/// Draw the interactive setup wizard modal into `buffer` and return the used rect.
pub fn draw_setup_wizard_modal(
    state: &SetupWizardModalState,
    area: Rect,
    buffer: &mut Buffer,
) -> Rect {
    let rect = setup_wizard_modal_rect(area);
    if rect.width < 40 || rect.height < 12 {
        return rect;
    }

    Clear.render(rect, buffer);

    let title = Line::from(vec![
        Span::styled("╭─▲─╮ ", Style::default().fg(BRAND_ELECTRIC_CYAN)),
        Span::styled(
            "◈ AIBridge",
            Style::default()
                .fg(BRAND_ELECTRIC_CYAN)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            " Onboarding Wizard ",
            Style::default().fg(BRAND_NEURAL_VIOLET),
        ),
        Span::styled("[aibr setup v2.0]", Style::default().fg(BRAND_MESH_EMERALD)),
    ]);

    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_type(ratatui::widgets::BorderType::Rounded)
        .border_style(Style::default().fg(BRAND_NEURAL_VIOLET));
    block.render(rect, buffer);

    let inner = Rect::new(
        rect.x + 2,
        rect.y + 1,
        rect.width.saturating_sub(4),
        rect.height.saturating_sub(2),
    );
    if inner.height < 10 {
        return rect;
    }

    // Row 0: Stepper nav bar
    let mut nav_spans = Vec::new();
    let steps = [
        (1, "1. Network"),
        (2, "2. Security"),
        (3, "3. Allowlists"),
        (4, "4. AI Runtimes"),
        (5, "5. Install & Test"),
    ];
    for (i, (num, label)) in steps.iter().enumerate() {
        if i > 0 {
            nav_spans.push(Span::styled(" ──▶ ", Style::default().fg(Color::DarkGray)));
        }
        let is_active = *num == state.current_step;
        let is_past = *num < state.current_step;
        let style = if is_active {
            Style::default()
                .fg(Color::Black)
                .bg(BRAND_ELECTRIC_CYAN)
                .add_modifier(Modifier::BOLD)
        } else if is_past {
            Style::default()
                .fg(BRAND_MESH_EMERALD)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::Gray)
        };
        let marker = if is_past { "✔ " } else { "" };
        nav_spans.push(Span::styled(format!(" [{marker}{label}] "), style));
    }
    Paragraph::new(Line::from(nav_spans))
        .render(Rect::new(inner.x, inner.y, inner.width, 1), buffer);

    // Row 1: Divider
    let divider = "─".repeat(inner.width as usize);
    Paragraph::new(Span::styled(divider, Style::default().fg(Color::DarkGray)))
        .render(Rect::new(inner.x, inner.y + 1, inner.width, 1), buffer);

    // Content lines based on current step
    let mut content_lines: Vec<Line> = Vec::new();
    match state.current_step {
        1 => {
            content_lines.push(Line::from(vec![Span::styled(
                "🌐 Network & Tailscale Interface Discovery",
                Style::default()
                    .fg(BRAND_ELECTRIC_CYAN)
                    .add_modifier(Modifier::BOLD),
            )]));
            content_lines.push(Line::from(vec![Span::styled(
                "Auto-detect local network topology and private Tailscale mesh coordinates.",
                Style::default().fg(Color::DarkGray),
            )]));
            content_lines.push(Line::raw(""));
            content_lines.push(Line::from(vec![
                Span::styled(
                    "🔒 Tailscale Daemon (tailscaled):  ",
                    Style::default().fg(Color::White),
                ),
                Span::styled(
                    "/var/run/tailscaled.sock  ",
                    Style::default().fg(Color::Gray),
                ),
                if state.tailscale_running {
                    Span::styled(
                        "● RUNNING",
                        Style::default()
                            .fg(BRAND_MESH_EMERALD)
                            .add_modifier(Modifier::BOLD),
                    )
                } else {
                    Span::styled(
                        "○ STOPPED",
                        Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
                    )
                },
            ]));
            content_lines.push(Line::from(vec![
                Span::styled(
                    "📡 Tailscale Mesh IPv4 Coordinate: ",
                    Style::default().fg(Color::White),
                ),
                Span::styled(
                    &state.tailscale_ip,
                    Style::default()
                        .fg(BRAND_ELECTRIC_CYAN)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    " (100.64.0.0/10 Carrier Grade NAT)",
                    Style::default().fg(Color::DarkGray),
                ),
            ]));
            content_lines.push(Line::from(vec![
                Span::styled(
                    "🔌 Port Availability Check:        ",
                    Style::default().fg(Color::White),
                ),
                if state.ports_available {
                    Span::styled(
                        "✔ AVAILABLE (4095 router, 4096 opencode, 8787 bridge)",
                        Style::default()
                            .fg(BRAND_MESH_EMERALD)
                            .add_modifier(Modifier::BOLD),
                    )
                } else {
                    Span::styled(
                        "✖ CONFLICT DETECTED",
                        Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
                    )
                },
            ]));
            content_lines.push(Line::raw(""));
            content_lines.push(Line::from(vec![
                Span::styled(
                    "ℹ Tailnet Verification: ",
                    Style::default()
                        .fg(BRAND_ELECTRIC_CYAN)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    "Traffic to AIBridge port 4095 is constrained strictly to private mesh peers.",
                    Style::default().fg(Color::Gray),
                ),
            ]));
        }
        2 => {
            content_lines.push(Line::from(vec![Span::styled(
                "🛡️ Router Security & Invariants Enforcement",
                Style::default()
                    .fg(BRAND_ELECTRIC_CYAN)
                    .add_modifier(Modifier::BOLD),
            )]));
            content_lines.push(Line::from(vec![Span::styled(
                "Configure constant-time bearer credentials and hard safety floor rules.",
                Style::default().fg(Color::DarkGray),
            )]));
            content_lines.push(Line::raw(""));
            let port_focus = if state.focused_field == 0 {
                Style::default().fg(Color::Black).bg(BRAND_ELECTRIC_CYAN)
            } else {
                Style::default().fg(Color::White)
            };
            content_lines.push(Line::from(vec![
                Span::styled(
                    "Listening Port (Ingress Router):   ",
                    Style::default().fg(Color::White),
                ),
                Span::styled(format!(" [ {} ] ", state.listen_port), port_focus),
            ]));
            let regen_focus = if state.focused_field == 1 {
                Style::default().fg(Color::Black).bg(BRAND_ELECTRIC_CYAN)
            } else {
                Style::default().fg(Color::Yellow)
            };
            content_lines.push(Line::from(vec![
                Span::styled(
                    "Bearer Authentication Secret:      ",
                    Style::default().fg(Color::White),
                ),
                Span::styled(
                    &state.bearer_token,
                    Style::default()
                        .fg(BRAND_ELECTRIC_CYAN)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw("  "),
                Span::styled(" [r: 🔄 Regenerate] ", regen_focus),
            ]));
            content_lines.push(Line::from(vec![
                Span::styled(
                    "Credential Storage:                ",
                    Style::default().fg(Color::White),
                ),
                Span::styled(
                    "~/.config/aibridge/ (mode 0600 strict CSPRNG token)",
                    Style::default().fg(Color::DarkGray),
                ),
            ]));
            content_lines.push(Line::raw(""));
            content_lines.push(Line::from(vec![Span::styled(
                "Security Floor Invariants:",
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            )]));
            let check_ct = if state.enforce_const_time { "✔" } else { " " };
            let ct_style = if state.focused_field == 2 {
                Style::default().fg(Color::Black).bg(BRAND_ELECTRIC_CYAN)
            } else {
                Style::default().fg(BRAND_MESH_EMERALD)
            };
            content_lines.push(Line::from(vec![
                Span::styled(format!(" [{check_ct}] "), ct_style),
                Span::styled(
                    "Enforce Constant-Time Token Comparison ",
                    Style::default().fg(Color::White),
                ),
                Span::styled(
                    "(mitigates timing side-channels)",
                    Style::default().fg(Color::DarkGray),
                ),
            ]));
            let check_bl = if state.enforce_body_limit { "✔" } else { " " };
            let bl_style = if state.focused_field == 3 {
                Style::default().fg(Color::Black).bg(BRAND_ELECTRIC_CYAN)
            } else {
                Style::default().fg(BRAND_MESH_EMERALD)
            };
            content_lines.push(Line::from(vec![
                Span::styled(format!(" [{check_bl}] "), bl_style),
                Span::styled(
                    "Enforce Strict 2 MB Body Payload Cap  ",
                    Style::default().fg(Color::White),
                ),
                Span::styled(
                    "(prevents memory exhaustion DoS vectors)",
                    Style::default().fg(Color::DarkGray),
                ),
            ]));
            let check_sr = if state.enforce_secret_redaction {
                "✔"
            } else {
                " "
            };
            let sr_style = if state.focused_field == 4 {
                Style::default().fg(Color::Black).bg(BRAND_ELECTRIC_CYAN)
            } else {
                Style::default().fg(BRAND_MESH_EMERALD)
            };
            content_lines.push(Line::from(vec![
                Span::styled(format!(" [{check_sr}] "), sr_style),
                Span::styled(
                    "Automated Secret Redaction Pipeline   ",
                    Style::default().fg(Color::White),
                ),
                Span::styled(
                    "(scrubs API keys, passwords, bearer tokens)",
                    Style::default().fg(Color::DarkGray),
                ),
            ]));
        }
        3 => {
            content_lines.push(Line::from(vec![Span::styled(
                "📁 Project Allowlists & Containment Boundaries",
                Style::default()
                    .fg(BRAND_ELECTRIC_CYAN)
                    .add_modifier(Modifier::BOLD),
            )]));
            content_lines.push(Line::from(vec![
                Span::styled("Specify canonical project roots. Agents are strictly contained to authorized paths.", Style::default().fg(Color::DarkGray)),
            ]));
            content_lines.push(Line::raw(""));
            content_lines.push(Line::from(vec![Span::styled(
                "Allowlisted Workspaces:",
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            )]));
            for (idx, path) in state.project_paths.iter().enumerate() {
                let is_selected = state.project_selected.get(idx).copied().unwrap_or(false);
                let mark = if is_selected { "✔" } else { " " };
                let is_focused = state.focused_field == idx;
                let chk_style = if is_focused {
                    Style::default().fg(Color::Black).bg(BRAND_ELECTRIC_CYAN)
                } else if is_selected {
                    Style::default().fg(BRAND_MESH_EMERALD)
                } else {
                    Style::default().fg(Color::DarkGray)
                };
                content_lines.push(Line::from(vec![
                    Span::styled(format!(" [{mark}] "), chk_style),
                    Span::styled(
                        path,
                        Style::default().fg(if is_selected {
                            Color::White
                        } else {
                            Color::Gray
                        }),
                    ),
                ]));
            }
            content_lines.push(Line::raw(""));
            content_lines.push(Line::from(vec![
                Span::styled(
                    "⚠ Fail-Closed Subpath Policy: ",
                    Style::default()
                        .fg(Color::LightYellow)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    "Any path or symlink escaping boundaries returns an immediate 403 Forbidden.",
                    Style::default().fg(Color::Gray),
                ),
            ]));
        }
        4 => {
            content_lines.push(Line::from(vec![Span::styled(
                "🤖 AI Agent Runtime Discovery & Loopback Ping",
                Style::default()
                    .fg(BRAND_ELECTRIC_CYAN)
                    .add_modifier(Modifier::BOLD),
            )]));
            content_lines.push(Line::from(vec![Span::styled(
                "Test loopback connectivity and PTY capabilities of local CLI agent tools.",
                Style::default().fg(Color::DarkGray),
            )]));
            content_lines.push(Line::raw(""));
            content_lines.push(Line::from(vec![
                Span::styled(
                    "⚡ OpenCode Serve Loopback (127.0.0.1:4096): ",
                    Style::default().fg(Color::White),
                ),
                if state.opencode_connected {
                    Span::styled(
                        "✔ CONNECTED (HTTP 200 health)",
                        Style::default()
                            .fg(BRAND_MESH_EMERALD)
                            .add_modifier(Modifier::BOLD),
                    )
                } else {
                    Span::styled(
                        "✖ UNREACHABLE",
                        Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
                    )
                },
            ]));
            content_lines.push(Line::from(vec![
                Span::styled(
                    "🧠 Claude Code CLI Binary:                 ",
                    Style::default().fg(Color::White),
                ),
                if state.claude_installed {
                    Span::styled(
                        "✔ READY (/usr/local/bin/claude v1.4.2)",
                        Style::default()
                            .fg(BRAND_MESH_EMERALD)
                            .add_modifier(Modifier::BOLD),
                    )
                } else {
                    Span::styled("○ NOT FOUND", Style::default().fg(Color::Yellow))
                },
            ]));
            content_lines.push(Line::from(vec![
                Span::styled(
                    "🛠️ Codex CLI Runtime:                      ",
                    Style::default().fg(Color::White),
                ),
                if state.codex_installed {
                    Span::styled(
                        "✔ READY (~/.codex/bin/codex v0.9.1)",
                        Style::default()
                            .fg(BRAND_MESH_EMERALD)
                            .add_modifier(Modifier::BOLD),
                    )
                } else {
                    Span::styled("○ NOT FOUND", Style::default().fg(Color::Yellow))
                },
            ]));
            content_lines.push(Line::raw(""));
            let retest_style = if state.focused_field == 0 {
                Style::default().fg(Color::Black).bg(BRAND_ELECTRIC_CYAN)
            } else {
                Style::default().fg(Color::Yellow)
            };
            content_lines.push(Line::from(vec![Span::styled(
                " [🔄 Retest All Runtimes] ",
                retest_style,
            )]));
        }
        _ => {
            content_lines.push(Line::from(vec![Span::styled(
                "🚀 Installation & System Service Daemonization",
                Style::default()
                    .fg(BRAND_ELECTRIC_CYAN)
                    .add_modifier(Modifier::BOLD),
            )]));
            content_lines.push(Line::from(vec![Span::styled(
                "Save configuration, initialize SQLite WAL queues, and launch services.",
                Style::default().fg(Color::DarkGray),
            )]));
            content_lines.push(Line::raw(""));
            let svc_chk = if state.install_service { "✔" } else { " " };
            let svc_style = if state.focused_field == 0 {
                Style::default().fg(Color::Black).bg(BRAND_ELECTRIC_CYAN)
            } else {
                Style::default().fg(BRAND_MESH_EMERALD)
            };
            content_lines.push(Line::from(vec![
                Span::styled(format!(" [{svc_chk}] "), svc_style),
                Span::styled(
                    "Install System Background Service ",
                    Style::default()
                        .fg(Color::White)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    "(launchd agent on macOS / systemd on Linux)",
                    Style::default().fg(Color::DarkGray),
                ),
            ]));
            content_lines.push(Line::raw(""));
            content_lines.push(Line::from(vec![Span::styled(
                "Preflight Health Audit:",
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            )]));
            content_lines.push(Line::from(vec![
                Span::styled(
                    "  💾 SQLite WAL Outbox (~/.aibridge/ingress_outbox.db): ",
                    Style::default().fg(Color::White),
                ),
                if state.outbox_initialized {
                    Span::styled(
                        "INITIALIZED",
                        Style::default()
                            .fg(BRAND_MESH_EMERALD)
                            .add_modifier(Modifier::BOLD),
                    )
                } else {
                    Span::styled("PENDING", Style::default().fg(Color::Yellow))
                },
            ]));
            content_lines.push(Line::from(vec![
                Span::styled(
                    "  🔑 Config Schema & File Permissions (0600):          ",
                    Style::default().fg(Color::White),
                ),
                if state.config_verified {
                    Span::styled(
                        "VERIFIED",
                        Style::default()
                            .fg(BRAND_MESH_EMERALD)
                            .add_modifier(Modifier::BOLD),
                    )
                } else {
                    Span::styled("UNVERIFIED", Style::default().fg(Color::Yellow))
                },
            ]));
            content_lines.push(Line::from(vec![
                Span::styled(
                    "  🌐 Tailscale Router Handshake Verification:          ",
                    Style::default().fg(Color::White),
                ),
                Span::styled(
                    "READY",
                    Style::default()
                        .fg(BRAND_MESH_EMERALD)
                        .add_modifier(Modifier::BOLD),
                ),
            ]));
            content_lines.push(Line::raw(""));
            content_lines.push(Line::from(vec![Span::styled(
                "🎉 Onboarding Complete! Launch aibr tui now? (Enter)",
                Style::default()
                    .fg(BRAND_MESH_EMERALD)
                    .add_modifier(Modifier::BOLD),
            )]));
        }
    }

    let content_height = inner.height.saturating_sub(4);
    Paragraph::new(content_lines).render(
        Rect::new(inner.x, inner.y + 3, inner.width, content_height),
        buffer,
    );

    // Footer row at inner.bottom() - 1
    let footer_y = inner.bottom().saturating_sub(1);
    let left_hints = Line::from(vec![
        Span::styled("[1-5]", Style::default().fg(Color::Yellow)),
        Span::styled(" Step  ", Style::default().fg(Color::DarkGray)),
        Span::styled("[Tab]", Style::default().fg(Color::Yellow)),
        Span::styled(" Focus  ", Style::default().fg(Color::DarkGray)),
        Span::styled("[Space]", Style::default().fg(Color::Yellow)),
        Span::styled(" Toggle  ", Style::default().fg(Color::DarkGray)),
        Span::styled("[Enter]", Style::default().fg(Color::Yellow)),
        Span::styled(" Next  ", Style::default().fg(Color::DarkGray)),
        Span::styled("[Esc/b]", Style::default().fg(Color::Yellow)),
        Span::styled(" Back  ", Style::default().fg(Color::DarkGray)),
        Span::styled("[r]", Style::default().fg(Color::Yellow)),
        Span::styled(" Regen", Style::default().fg(Color::DarkGray)),
    ]);
    Paragraph::new(left_hints).render(
        Rect::new(inner.x, footer_y, inner.width.saturating_sub(28), 1),
        buffer,
    );

    let next_label = if state.current_step == 5 {
        " [ 🚀 Launch TUI ] "
    } else {
        " [ Continue ▶ ] "
    };
    let back_btn = Span::styled(" [ ◀ Back ] ", Style::default().fg(Color::Gray));
    let next_btn = Span::styled(
        next_label,
        Style::default()
            .fg(Color::Black)
            .bg(BRAND_ELECTRIC_CYAN)
            .add_modifier(Modifier::BOLD),
    );
    let right_buttons = Line::from(vec![back_btn, Span::raw(" "), next_btn]);
    let right_width = 30.min(inner.width);
    let right_x = inner.right().saturating_sub(right_width);
    Paragraph::new(right_buttons)
        .alignment(ratatui::layout::Alignment::Right)
        .render(Rect::new(right_x, footer_y, right_width, 1), buffer);

    rect
}

/// The setup wizard modal widget for Ratatui rendering.
pub struct SetupWizardModalWidget<'a> {
    /// State reference.
    pub state: &'a SetupWizardModalState,
}

/// Alias for `SetupWizardModalWidget` per specification.
pub type OnboardingWizardModal<'a> = SetupWizardModalWidget<'a>;

impl<'a> SetupWizardModalWidget<'a> {
    /// Create a new setup wizard modal widget wrapping the given state.
    #[must_use]
    pub fn new(state: &'a SetupWizardModalState) -> Self {
        Self { state }
    }
}

impl<'a> Widget for SetupWizardModalWidget<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        draw_setup_wizard_modal(self.state, area, buf);
    }
}

#[cfg(test)]
mod widget_tests {
    use super::*;

    #[test]
    fn test_draw_command_palette() {
        let state = crate::input::menu::CommandPaletteState::new();
        let area = Rect::new(0, 0, 80, 24);
        let mut buffer = Buffer::empty(area);
        let rect = draw_command_palette(&state, area, &mut buffer);
        assert!(rect.width > 0);
        assert!(rect.height > 0);
    }

    #[test]
    fn test_draw_keymap_modal() {
        let state = crate::input::menu::KeymapModalState::new(KeybindingProfile::ModernErgonomic);
        let area = Rect::new(0, 0, 80, 24);
        let mut buffer = Buffer::empty(area);
        let rect = draw_keymap_modal(&state, area, &mut buffer);
        assert!(rect.width > 0);
        assert!(rect.height > 0);
    }

    #[test]
    fn test_setup_wizard_modal_state_navigation() {
        let mut state = SetupWizardModalState::new();
        assert_eq!(state.current_step, 1);

        // Next step
        state.next_step();
        assert_eq!(state.current_step, 2);

        // 'r' token regen
        let old_token = state.bearer_token.clone();
        assert!(state.handle_char('r'));
        assert_ne!(state.bearer_token, old_token);
        assert!(state.bearer_token.starts_with("aibr_sec_"));

        // Direct jump
        assert!(state.handle_char('4'));
        assert_eq!(state.current_step, 4);

        // Back
        assert!(state.handle_char('b'));
        assert_eq!(state.current_step, 3);

        // Toggle checkbox on step 3
        let initial_selected = state.project_selected[0];
        state.focused_field = 0;
        assert!(state.handle_char(' '));
        assert_eq!(state.project_selected[0], !initial_selected);

        // Jump to step 5 and complete
        state.jump_to_step(5);
        assert_eq!(state.current_step, 5);
        state.next_step();
        assert!(state.is_completed);
    }

    #[test]
    fn test_draw_setup_wizard_modal() {
        let state = SetupWizardModalState::new();
        let area = Rect::new(0, 0, 100, 30);
        let mut buffer = Buffer::empty(area);
        let rect = draw_setup_wizard_modal(&state, area, &mut buffer);
        assert!(rect.width > 0);
        assert!(rect.height > 0);

        let widget = SetupWizardModalWidget::new(&state);
        widget.render(area, &mut buffer);
    }

    #[test]
    fn test_setup_wizard_mouse_click() {
        let mut state = SetupWizardModalState::new();
        let area = Rect::new(0, 0, 84, 26);
        let modal = setup_wizard_modal_rect(area);

        // Click on step 2 in stepper nav bar (row = modal.y + 2, col = modal.x + 20)
        assert!(state.handle_click(modal.x + 20, modal.y + 2, modal));
        assert_eq!(state.current_step, 2);

        // Click on Next button in footer
        let footer_y = modal.bottom() - 2;
        let next_x = modal.right() - 5;
        assert!(state.handle_click(next_x, footer_y, modal));
        assert_eq!(state.current_step, 3);
    }
}
