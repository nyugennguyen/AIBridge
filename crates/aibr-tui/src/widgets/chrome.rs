//! The top bar, the sidebar, and the status bar.
//!
//! # Stable ordering is not cosmetic
//!
//! The sidebar is built from `BTreeMap`s in `DaemonWorld`, which iterate in key
//! order. A `HashMap` would reshuffle the list on every snapshot, and the result is
//! panes and jobs jumping while the operator is trying to click one -- the
//! "flickering" acceptance criterion 5 forbids. So the order here is by id, always.
//!
//! # `unknown` is not `stopped`
//!
//! The header shows Tailscale connectivity, and `unknown` ("nobody asked") is a
//! different diagnosis from `stopped` ("tailscaled said no"). Collapsing them makes
//! the header lie about why ingress is unreachable.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use crate::layout::hit::{HitTarget, SidebarRows};
use crate::layout::ChromeRects;
use crate::state::{InputMode, Job, UiState, Workspace};

/// A section of the sidebar, in the order it is drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidebarSection {
    /// Workspace names, with the selected one marked.
    Workspaces,
    /// Jobs belonging to the active workspace, with their state badges.
    Jobs,
    /// Rows still pending in `ingress_outbox`.
    IngressQueue,
}

/// The one-line badge for an agent state.
///
/// ASCII rather than the plan's mockup glyphs, which are not guaranteed
/// single-width across terminals and would shift the sidebar by a column where they
/// are not. The letters are unambiguous in a grep and in a screenshot.
fn state_badge(state: aibr_ipc::contracts::JobState) -> (&'static str, ratatui::style::Color) {
    use aibr_ipc::contracts::JobState as AgentState;
    match state {
        AgentState::Working => ("~", ratatui::style::Color::Yellow),
        AgentState::Blocked => ("!", ratatui::style::Color::LightRed),
        AgentState::Done => ("+", ratatui::style::Color::LightGreen),
        AgentState::Idle => (".", ratatui::style::Color::DarkGray),
    }
}

/// Draw the chrome bands into `area`.
///
/// Returns the sidebar's rows so the caller can hand the SAME rects to
/// [`crate::layout::HitTest`]. Building them here rather than in the hit-test is
/// what keeps a click landing on the row the operator saw.
pub fn draw_chrome(state: &UiState, chrome: &ChromeRects, buffer: &mut Buffer) -> SidebarRows {
    draw_top_bar(state, chrome, buffer);
    draw_status_bar(state, chrome, buffer);
    if chrome.sidebar.is_some() {
        return draw_sidebar(state, chrome, buffer);
    }
    SidebarRows::default()
}

/// The header: Tailscale status, active workspace, outbox count.
fn draw_top_bar(state: &UiState, chrome: &ChromeRects, buffer: &mut Buffer) {
    let area = chrome.top_bar.intersection(chrome.full);
    buffer.set_style(area, Style::default().bg(ratatui::style::Color::Reset));

    let workspace = state
        .effective_workspace()
        .map(|workspace| workspace.name.as_str())
        .unwrap_or("no workspace");

    let tailscale = match &state.world.tailscale {
        // `unknown` is printed as `unknown`, never folded into `stopped`: the two
        // mean different operator actions.
        Some(tailscale) => tailscale.status.label(),
        None => "unknown",
    };

    let spans = vec![
        Span::styled(" AIBridge ", Style::default().add_modifier(Modifier::BOLD)),
        Span::raw(format!(" {workspace} ")),
        Span::styled(
            format!("| tailscale: {tailscale}"),
            Style::default().fg(match state.world.tailscale.as_ref().map(|t| t.status) {
                Some(crate::state::TailscaleStatus::Active) => ratatui::style::Color::LightGreen,
                Some(crate::state::TailscaleStatus::Stopped) => ratatui::style::Color::LightRed,
                _ => ratatui::style::Color::DarkGray,
            }),
        ),
        Span::raw(format!(" | outbox: {} ", state.world.outbox_pending_count)),
    ];
    write_line(buffer, area, &spans);
}

/// The footer: the input mode, and what the keys do right now.
fn draw_status_bar(state: &UiState, chrome: &ChromeRects, buffer: &mut Buffer) {
    let area = chrome.status_bar.intersection(chrome.full);
    let (label, hint) = match state.presentation.mode {
        InputMode::Terminal => (
            "TERMINAL",
            "Ctrl+B prefix | Ctrl+Alt+ hjkl switch pane | wheel scroll",
        ),
        InputMode::Prefix => (
            "PREFIX",
            "c tab | v split | - split | hjkl move | z zoom | q detach",
        ),
        InputMode::Copy => ("COPY", "hjkl move | / search | v select | y yank | q exit"),
        InputMode::Navigate => ("NAVIGATE", "drag borders | click to focus"),
    };
    let spans = vec![
        Span::styled(
            format!(" {label} "),
            Style::default().add_modifier(Modifier::REVERSED),
        ),
        Span::raw(format!(" {hint}")),
    ];
    write_line(buffer, area, &spans);
}

/// Draw the sidebar and return its row rects.
fn draw_sidebar(state: &UiState, chrome: &ChromeRects, buffer: &mut Buffer) -> SidebarRows {
    let Some(sidebar) = chrome.sidebar else {
        return SidebarRows::default();
    };
    let area = sidebar.intersection(chrome.full);
    let mut rows = SidebarRows::default();
    let mut row = area.y;

    // One-row section headers, drawn in a fixed order.
    for heading in ["WORKSPACES", "JOBS", "INGRESS QUEUE"] {
        if row >= area.y.saturating_add(area.height) {
            return rows;
        }
        let line = Rect::new(area.x, row, area.width, 1);
        write_line(
            buffer,
            line,
            &[Span::styled(
                format!(" {heading}"),
                Style::default().add_modifier(Modifier::BOLD),
            )],
        );
        row += 1;
    }

    // Workspaces.
    for workspace in state.world.workspaces.values() {
        let Some(line) = next_line(area, row) else {
            return rows;
        };
        row = line.y + 1;
        rows.entries.push((
            line,
            HitTarget::SidebarWorkspace {
                workspace_id: workspace.id.clone(),
            },
        ));
        write_line(buffer, line, &[workspace_span(workspace)]);
    }

    // Jobs, for the active workspace only: the sidebar is a view of what is
    // running now, not an index of everything this node has ever run.
    let active = state
        .effective_workspace()
        .map(|workspace| workspace.id.clone());
    if let Some(active) = active {
        for job in state.jobs_in_workspace(&active) {
            let Some(line) = next_line(area, row) else {
                return rows;
            };
            row = line.y + 1;
            rows.entries.push((
                line,
                HitTarget::SidebarJob {
                    job_id: job.id.clone(),
                },
            ));
            write_line(buffer, line, &[job_span(job)]);
        }
    }

    rows
}

/// One workspace row.
fn workspace_span(workspace: &Workspace) -> Span<'_> {
    let marker = if workspace.selected { ">" } else { " " };
    let style = if workspace.selected {
        Style::default().add_modifier(Modifier::BOLD)
    } else {
        Style::default()
    };
    Span::styled(format!("{marker} {}", workspace.name), style)
}

/// One job row, with its state badge.
fn job_span(job: &Job) -> Span<'_> {
    let (badge, colour) = state_badge(job.state);
    let detail = job.detail.as_deref().unwrap_or("");
    Span::styled(
        format!("  [{badge}] {} {detail}", job.id),
        Style::default().fg(colour),
    )
}

/// The next free one-row line in `area`, or `None` when the sidebar is full.
fn next_line(area: Rect, row: u16) -> Option<Rect> {
    if row >= area.y.saturating_add(area.height) {
        return None;
    }
    Some(Rect::new(area.x, row, area.width, 1))
}

/// Write spans into one row, truncated to the row's width.
fn write_line(buffer: &mut Buffer, area: Rect, spans: &[Span<'_>]) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let line = Line::from(spans.to_vec());
    let rendered = ratatui::text::Text::from(vec![line]);
    // `Paragraph` would pad with spaces; writing cells directly is cheaper and does
    // not clear anything the caller already drew.
    let mut x = area.x;
    for span in rendered
        .lines
        .first()
        .into_iter()
        .flat_map(|line| line.spans.iter())
    {
        for grapheme in span.content.chars() {
            if x >= area.x.saturating_add(area.width) {
                return;
            }
            buffer[(x, area.y)]
                .set_symbol(&grapheme.to_string())
                .set_style(span.style);
            x += 1;
        }
    }
}
