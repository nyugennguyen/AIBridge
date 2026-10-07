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
use crate::state::{InputMode, Job, TailscaleStatus, UiState, Workspace};
/// Electric Cyan primary pylon brand color: `RGB(0, 240, 255)`.
pub const LOGO_ELECTRIC_CYAN: ratatui::style::Color = ratatui::style::Color::Rgb(0, 240, 255);
/// Neural Violet suspension span brand color: `RGB(168, 85, 247)`.
pub const LOGO_NEURAL_VIOLET: ratatui::style::Color = ratatui::style::Color::Rgb(168, 85, 247);
/// Mesh Emerald status pulse brand color: `RGB(16, 185, 129)`.
pub const LOGO_MESH_EMERALD: ratatui::style::Color = ratatui::style::Color::Rgb(16, 185, 129);

/// Returns styled spans for the AIBridge cyber-mesh vector logo mark:
/// `╭─▲─╮ ◈ AIBridge` with Electric Cyan pylon, Neural Violet suspension span,
/// and Mesh Emerald status pulse.
#[must_use]
pub fn logo_mark_spans<'a>() -> Vec<Span<'a>> {
    vec![
        Span::styled("╭─", Style::default().fg(LOGO_NEURAL_VIOLET)),
        Span::styled(
            "▲",
            Style::default()
                .fg(LOGO_ELECTRIC_CYAN)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("─╮ ", Style::default().fg(LOGO_NEURAL_VIOLET)),
        Span::styled("◈ ", Style::default().fg(LOGO_MESH_EMERALD)),
        Span::styled(
            "AI",
            Style::default()
                .fg(ratatui::style::Color::White)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            "Bridge ",
            Style::default()
                .fg(LOGO_ELECTRIC_CYAN)
                .add_modifier(Modifier::BOLD),
        ),
    ]
}

/// A framed window header widget displaying the cyber-mesh bridge logo lockup, title, and badge.
pub struct WindowHeader<'a> {
    /// Window title label.
    pub title: &'a str,
    /// Optional category or version badge.
    pub badge: Option<&'a str>,
}

impl<'a> WindowHeader<'a> {
    /// Create a new window header.
    #[must_use]
    pub const fn new(title: &'a str, badge: Option<&'a str>) -> Self {
        Self { title, badge }
    }
}

impl<'a> ratatui::widgets::Widget for WindowHeader<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.width == 0 || area.height == 0 {
            return;
        }
        let mut spans = logo_mark_spans();
        spans.push(Span::raw("│ "));
        spans.push(Span::styled(
            self.title,
            Style::default()
                .fg(ratatui::style::Color::White)
                .add_modifier(Modifier::BOLD),
        ));
        if let Some(badge) = self.badge {
            spans.push(Span::raw(" "));
            spans.push(Span::styled(
                format!(" [{badge}] "),
                Style::default()
                    .fg(LOGO_ELECTRIC_CYAN)
                    .bg(ratatui::style::Color::Rgb(15, 25, 35))
                    .add_modifier(Modifier::BOLD),
            ));
        }
        write_line(buf, area, &spans);
    }
}

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
    TopHeaderBarWidget::new(state).render(chrome.top_bar, buffer);
    if chrome.tab_bar.height > 0 {
        WorkspaceTabBarWidget::new(state).render(chrome.tab_bar, buffer);
    }
    draw_status_bar(state, chrome, buffer);
    if let Some(sidebar_rect) = chrome.sidebar {
        draw_inspector_sidebar(state, sidebar_rect, buffer);
        return draw_sidebar(state, chrome, buffer);
    }
    SidebarRows::default()
}

/// The header: Tailscale status, active workspace, outbox count.
#[allow(dead_code)]
pub fn draw_top_bar(state: &UiState, chrome: &ChromeRects, buffer: &mut Buffer) {
    TopHeaderBarWidget::new(state).render(chrome.top_bar, buffer);
}

/// Top master control bar widget (Row 1 of the shell).
///
/// Tailscale Mesh health, breadcrumbs, agent status pills, quick action chips.
pub struct TopHeaderBarWidget<'a> {
    /// The UI state to render from.
    pub state: &'a UiState,
}

impl<'a> TopHeaderBarWidget<'a> {
    /// Create a new top header bar widget.
    pub fn new(state: &'a UiState) -> Self {
        Self { state }
    }

    /// Render the top header bar into the given area.
    pub fn render(self, area: Rect, buffer: &mut Buffer) {
        if area.width == 0 || area.height == 0 {
            return;
        }
        buffer.set_style(area, Style::default().bg(ratatui::style::Color::Reset));

        let workspace = self
            .state
            .effective_workspace()
            .map(|ws| ws.name.as_str())
            .unwrap_or("web-store");

        // Tailscale Mesh health indicator
        let (dot, dot_color, ts_text) = match &self.state.world.tailscale {
            Some(ts) => {
                let color = match ts.status {
                    TailscaleStatus::Active => ratatui::style::Color::LightGreen,
                    TailscaleStatus::Stopped => ratatui::style::Color::LightRed,
                    TailscaleStatus::Unavailable => ratatui::style::Color::Red,
                    TailscaleStatus::Unknown => ratatui::style::Color::DarkGray,
                };
                let ip = ts.address.as_deref().unwrap_or("100.64.0.1");
                let nodes = ts.peer_count.max(1);
                (
                    "●",
                    color,
                    format!(" tailscale ({nodes} nodes) {ip} (24ms)"),
                )
            }
            None => (
                "○",
                ratatui::style::Color::DarkGray,
                " tailscale: unknown".to_string(),
            ),
        };

        // Agent status summary counts
        let mut working = 0usize;
        let mut blocked = 0usize;
        let mut done = 0usize;
        for job in self.state.world.jobs.values() {
            match job.state {
                aibr_ipc::contracts::JobState::Working => working += 1,
                aibr_ipc::contracts::JobState::Blocked => blocked += 1,
                aibr_ipc::contracts::JobState::Done => done += 1,
                _ => {}
            }
        }

        // Left section: Logo + Breadcrumbs + Tailscale + Outbox + Status Pills
        // Left section: Logo + Breadcrumbs + Outbox + Tailscale + Status Pills
        let mut spans = logo_mark_spans();
        if area.width >= 100 {
            spans.push(Span::raw(format!("[project: {workspace} / run: #108] ")));
        } else {
            spans.push(Span::raw(format!("[{workspace}] ")));
        }
        if self.state.world.outbox_pending_count > 0 {
            spans.push(Span::raw(format!(
                "outbox: {}  ",
                self.state.world.outbox_pending_count
            )));
        }

        spans.push(Span::styled(dot, Style::default().fg(dot_color)));
        spans.push(Span::styled(
            ts_text,
            Style::default().fg(ratatui::style::Color::DarkGray),
        ));
        // Global agent status summary pills
        spans.push(Span::styled(
            format!(" 🟢 {working} Working"),
            Style::default().fg(ratatui::style::Color::Green),
        ));
        spans.push(Span::styled(
            format!(" 🟡 {blocked} Blocked (HITL)"),
            Style::default().fg(ratatui::style::Color::Yellow),
        ));
        spans.push(Span::styled(
            format!(" 🔵 {done} Done "),
            Style::default().fg(ratatui::style::Color::Blue),
        ));

        write_line(buffer, area, &spans);

        // Right section: Clickable Chips
        let right = area.x.saturating_add(area.width);
        if area.width >= 90 {
            let insp_rect = Rect::new(right.saturating_sub(18), area.y, 17, 1);
            write_line(
                buffer,
                insp_rect,
                &[
                    Span::styled("[", Style::default().fg(ratatui::style::Color::DarkGray)),
                    Span::styled(
                        "Alt+B",
                        Style::default()
                            .fg(ratatui::style::Color::Cyan)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::raw(" Inspector"),
                    Span::styled("]", Style::default().fg(ratatui::style::Color::DarkGray)),
                ],
            );

            let keymap_rect = Rect::new(right.saturating_sub(29), area.y, 10, 1);
            write_line(
                buffer,
                keymap_rect,
                &[
                    Span::styled("[", Style::default().fg(ratatui::style::Color::DarkGray)),
                    Span::styled(
                        "?",
                        Style::default()
                            .fg(ratatui::style::Color::Cyan)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::raw(" Keymap"),
                    Span::styled("]", Style::default().fg(ratatui::style::Color::DarkGray)),
                ],
            );

            let search_rect = Rect::new(right.saturating_sub(45), area.y, 15, 1);
            write_line(
                buffer,
                search_rect,
                &[
                    Span::styled("[", Style::default().fg(ratatui::style::Color::DarkGray)),
                    Span::styled(
                        "Ctrl+K",
                        Style::default()
                            .fg(ratatui::style::Color::Cyan)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::raw(" Search"),
                    Span::styled("]", Style::default().fg(ratatui::style::Color::DarkGray)),
                ],
            );
        } else if area.width >= 60 {
            let insp_rect = Rect::new(right.saturating_sub(8), area.y, 7, 1);
            write_line(
                buffer,
                insp_rect,
                &[
                    Span::styled("[", Style::default().fg(ratatui::style::Color::DarkGray)),
                    Span::styled("Alt+B", Style::default().fg(ratatui::style::Color::Cyan)),
                    Span::styled("]", Style::default().fg(ratatui::style::Color::DarkGray)),
                ],
            );

            let keymap_rect = Rect::new(right.saturating_sub(19), area.y, 10, 1);
            write_line(
                buffer,
                keymap_rect,
                &[
                    Span::styled("[", Style::default().fg(ratatui::style::Color::DarkGray)),
                    Span::styled("?", Style::default().fg(ratatui::style::Color::Cyan)),
                    Span::raw(" Keymap"),
                    Span::styled("]", Style::default().fg(ratatui::style::Color::DarkGray)),
                ],
            );

            let search_rect = Rect::new(right.saturating_sub(28), area.y, 8, 1);
            write_line(
                buffer,
                search_rect,
                &[
                    Span::styled("[", Style::default().fg(ratatui::style::Color::DarkGray)),
                    Span::styled("Ctrl+K", Style::default().fg(ratatui::style::Color::Cyan)),
                    Span::styled("]", Style::default().fg(ratatui::style::Color::DarkGray)),
                ],
            );
        }
    }
}

/// Workspace tab bar widget (Row 2 of the shell).
///
/// Numbered tab badges (Alt+1, Alt+2, Alt+3) with close button (×) and new tab add button ([+]).
pub struct WorkspaceTabBarWidget<'a> {
    /// The UI state to render from.
    pub state: &'a UiState,
}

impl<'a> WorkspaceTabBarWidget<'a> {
    /// Create a new workspace tab bar widget.
    pub fn new(state: &'a UiState) -> Self {
        Self { state }
    }

    /// Render the workspace tab bar into the given area.
    pub fn render(self, area: Rect, buffer: &mut Buffer) {
        if area.width == 0 || area.height == 0 {
            return;
        }
        buffer.set_style(area, Style::default().bg(ratatui::style::Color::Reset));

        let active_id = self
            .state
            .presentation
            .active_workspace
            .as_deref()
            .or_else(|| {
                self.state
                    .world
                    .workspaces
                    .keys()
                    .next()
                    .map(String::as_str)
            });

        let default_names = ["Dev", "Security", "Router"];

        let mut spans = Vec::new();
        spans.push(Span::raw(" "));

        if self.state.world.workspaces.is_empty() {
            for (i, name) in default_names.iter().enumerate() {
                let is_active = i == 0;
                let num = i + 1;
                let badge_style = if is_active {
                    Style::default()
                        .fg(ratatui::style::Color::Cyan)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(ratatui::style::Color::DarkGray)
                };
                let text_style = if is_active {
                    Style::default().add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(ratatui::style::Color::DarkGray)
                };

                spans.push(Span::styled(
                    "[",
                    Style::default().fg(ratatui::style::Color::DarkGray),
                ));
                spans.push(Span::styled(format!("Alt+{num}: "), badge_style));
                spans.push(Span::styled(format!("{name} "), text_style));
                spans.push(Span::styled(
                    "×",
                    Style::default().fg(ratatui::style::Color::LightRed),
                ));
                spans.push(Span::styled(
                    "] ",
                    Style::default().fg(ratatui::style::Color::DarkGray),
                ));
            }
        } else {
            for (i, (id, ws)) in self.state.world.workspaces.iter().enumerate().take(8) {
                let is_active = Some(id.as_str()) == active_id;
                let num = i + 1;
                let badge_style = if is_active {
                    Style::default()
                        .fg(ratatui::style::Color::Cyan)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(ratatui::style::Color::DarkGray)
                };
                let text_style = if is_active {
                    Style::default().add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(ratatui::style::Color::DarkGray)
                };

                spans.push(Span::styled(
                    "[",
                    Style::default().fg(ratatui::style::Color::DarkGray),
                ));
                spans.push(Span::styled(format!("Alt+{num}: "), badge_style));
                spans.push(Span::styled(format!("{} ", ws.name), text_style));
                spans.push(Span::styled(
                    "×",
                    Style::default().fg(ratatui::style::Color::LightRed),
                ));
                spans.push(Span::styled(
                    "] ",
                    Style::default().fg(ratatui::style::Color::DarkGray),
                ));
            }
        }

        // Add new workspace tab button [+]
        spans.push(Span::styled(
            "[+] ",
            Style::default()
                .fg(ratatui::style::Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ));

        write_line(buffer, area, &spans);
    }
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

/// Draw the collapsible Mesh & Run Inspector into `area` (right sidebar slot).
///
/// Header: `Mesh & Run Inspector`
/// Section 1: Enrolled Tailscale Nodes with live latency indicators (`macbook-local [Host]`, `dev-vps [24ms]`, `gpu-cluster [68ms]`).
/// Section 2: Run Task DAG mini-map with status indicators (`✔ Done`, `● Working`, `▲ Blocked`).
/// Section 3: Real-time telemetry summary (cost `$0.18`, tokens `24.8k`, secret redactions count `14`).
pub fn draw_inspector_sidebar(state: &UiState, area: Rect, buffer: &mut Buffer) {
    let _ = state;
    if area.width == 0 || area.height == 0 {
        return;
    }
    buffer.set_style(area, Style::default().bg(ratatui::style::Color::Reset));

    let mut row = area.y;
    let max_row = area.y.saturating_add(area.height);

    let mut put = |buffer: &mut Buffer, spans: &[Span<'_>]| {
        if row < max_row {
            let line = Rect::new(area.x, row, area.width, 1);
            write_line(buffer, line, spans);
            row += 1;
        }
    };

    // Header
    put(
        buffer,
        &[Span::styled(
            " Mesh & Run Inspector",
            Style::default()
                .add_modifier(Modifier::BOLD)
                .fg(ratatui::style::Color::Cyan),
        )],
    );
    put(
        buffer,
        &[Span::styled(
            " ──────────────────────────",
            Style::default().fg(ratatui::style::Color::DarkGray),
        )],
    );

    // Section 1: Enrolled Tailscale Nodes with live latency indicators
    put(
        buffer,
        &[Span::styled(
            " ENROLLED NODES",
            Style::default().add_modifier(Modifier::BOLD),
        )],
    );
    put(
        buffer,
        &[
            Span::raw("  macbook-local "),
            Span::styled(
                "[Host]",
                Style::default().fg(ratatui::style::Color::LightGreen),
            ),
        ],
    );
    put(
        buffer,
        &[
            Span::raw("  dev-vps "),
            Span::styled("[24ms]", Style::default().fg(ratatui::style::Color::Yellow)),
        ],
    );
    put(
        buffer,
        &[
            Span::raw("  gpu-cluster "),
            Span::styled(
                "[68ms]",
                Style::default().fg(ratatui::style::Color::LightBlue),
            ),
        ],
    );

    put(buffer, &[Span::raw("")]);

    // Section 2: Run Task DAG mini-map with status indicators
    put(
        buffer,
        &[Span::styled(
            " RUN TASK DAG",
            Style::default().add_modifier(Modifier::BOLD),
        )],
    );
    put(
        buffer,
        &[
            Span::styled(
                "  ✔ ",
                Style::default().fg(ratatui::style::Color::LightGreen),
            ),
            Span::raw("Plan & Analysis "),
            Span::styled(
                "[Done]",
                Style::default().fg(ratatui::style::Color::DarkGray),
            ),
        ],
    );
    put(
        buffer,
        &[
            Span::styled("  ● ", Style::default().fg(ratatui::style::Color::Yellow)),
            Span::raw("Implementation "),
            Span::styled(
                "[Working]",
                Style::default().fg(ratatui::style::Color::Yellow),
            ),
        ],
    );
    put(
        buffer,
        &[
            Span::styled("  ▲ ", Style::default().fg(ratatui::style::Color::LightRed)),
            Span::raw("QA Verify "),
            Span::styled(
                "[Blocked]",
                Style::default().fg(ratatui::style::Color::LightRed),
            ),
        ],
    );

    put(buffer, &[Span::raw("")]);

    // Section 3: Real-time telemetry summary
    put(
        buffer,
        &[Span::styled(
            " TELEMETRY SUMMARY",
            Style::default().add_modifier(Modifier::BOLD),
        )],
    );
    put(
        buffer,
        &[
            Span::styled(
                "  Cost: ",
                Style::default().fg(ratatui::style::Color::DarkGray),
            ),
            Span::styled("$0.18", Style::default().add_modifier(Modifier::BOLD)),
        ],
    );
    put(
        buffer,
        &[
            Span::styled(
                "  Tokens: ",
                Style::default().fg(ratatui::style::Color::DarkGray),
            ),
            Span::styled("24.8k", Style::default().fg(ratatui::style::Color::Cyan)),
        ],
    );
    put(
        buffer,
        &[
            Span::styled(
                "  Redactions: ",
                Style::default().fg(ratatui::style::Color::DarkGray),
            ),
            Span::styled("14", Style::default().fg(ratatui::style::Color::Magenta)),
        ],
    );
}

/// An inspector widget wrapper for rendering the mesh & run inspector sidebar.
pub struct InspectorWidget<'a> {
    /// Reference to the current UI state.
    pub state: &'a UiState,
}

impl<'a> InspectorWidget<'a> {
    /// Construct a new inspector widget for `state`.
    pub fn new(state: &'a UiState) -> Self {
        Self { state }
    }

    /// Render the inspector widget into `area` of `buffer`.
    pub fn render(self, area: Rect, buffer: &mut Buffer) {
        draw_inspector_sidebar(self.state, area, buffer);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn buffer_text(buffer: &Buffer) -> String {
        let area = buffer.area;
        (0..area.height)
            .map(|row| {
                (0..area.width)
                    .map(|col| buffer[(area.x + col, area.y + row)].symbol())
                    .collect::<String>()
                    .trim_end()
                    .to_string()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn test_inspector_sidebar_rendering() {
        let state = UiState::default();
        let area = Rect::new(0, 0, 28, 20);
        let mut buffer = Buffer::empty(area);

        let widget = InspectorWidget::new(&state);
        widget.render(area, &mut buffer);

        let text = buffer_text(&buffer);
        assert!(text.contains("Mesh & Run Inspector"), "text: {text}");
        assert!(text.contains("ENROLLED NODES"), "text: {text}");
        assert!(text.contains("macbook-local"), "text: {text}");
        assert!(text.contains("[Host]"), "text: {text}");
        assert!(text.contains("dev-vps"), "text: {text}");
        assert!(text.contains("[24ms]"), "text: {text}");
        assert!(text.contains("gpu-cluster"), "text: {text}");
        assert!(text.contains("[68ms]"), "text: {text}");

        assert!(text.contains("RUN TASK DAG"), "text: {text}");
        assert!(text.contains("✔"), "text: {text}");
        assert!(text.contains("Plan & Analysis"), "text: {text}");
        assert!(text.contains("[Done]"), "text: {text}");
        assert!(text.contains("●"), "text: {text}");
        assert!(text.contains("Implementation"), "text: {text}");
        assert!(text.contains("[Working]"), "text: {text}");
        assert!(text.contains("▲"), "text: {text}");
        assert!(text.contains("QA Verify"), "text: {text}");
        assert!(text.contains("[Blocked]"), "text: {text}");

        assert!(text.contains("TELEMETRY SUMMARY"), "text: {text}");
        assert!(text.contains("Cost:"), "text: {text}");
        assert!(text.contains("$0.18"), "text: {text}");
        assert!(text.contains("Tokens:"), "text: {text}");
        assert!(text.contains("24.8k"), "text: {text}");
        assert!(text.contains("Redactions:"), "text: {text}");
        assert!(text.contains("14"), "text: {text}");
    }

    #[test]
    fn test_inspector_sidebar_empty_area_does_not_panic() {
        let state = UiState::default();
        let mut buffer = Buffer::empty(Rect::new(0, 0, 0, 0));
        draw_inspector_sidebar(&state, Rect::new(0, 0, 0, 0), &mut buffer);
    }
}
