//! Dedicated step widgets for the 5-step onboarding setup wizard (`aibr setup`).
//!
//! Implements the pure rendering widgets corresponding to:
//! - Step 1: Network & Tailscale Discovery ([`NetworkProbeWidget`])
//! - Step 2: Router Security & Bearer Credentials ([`TokenGeneratorWidget`])
//! - Step 3: Project Allowlists & Containment Boundaries ([`DirectorySelectorWidget`])
//! - Step 4: AI Agent Runtime Diagnostics ([`RuntimeProbeWidget`])
//! - Stepper navigation bar ([`StepperNavWidget`])
//!
//! Follows the Ratatui architecture where rendering is a pure function of `(state, layout)`
//! with zero side-effects or I/O.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Widget};

/// Primary Electric Cyan brand color: `RGB(0, 240, 255)`.
pub const COLOR_ELECTRIC_CYAN: Color = Color::Rgb(0, 240, 255);
/// Neural Violet suspension span color: `RGB(168, 85, 247)`.
pub const COLOR_NEURAL_VIOLET: Color = Color::Rgb(168, 85, 247);
/// Mesh Emerald status pulse color: `RGB(16, 185, 129)`.
pub const COLOR_MESH_EMERALD: Color = Color::Rgb(16, 185, 129);
/// Warning Amber color: `RGB(245, 158, 11)`.
pub const COLOR_AMBER_WARN: Color = Color::Rgb(245, 158, 11);
/// Primary foreground text color: `RGB(240, 246, 252)`.
pub const COLOR_TEXT_PRIMARY: Color = Color::Rgb(240, 246, 252);
/// Secondary muted text color: `RGB(139, 148, 158)`.
pub const COLOR_TEXT_MUTED: Color = Color::Rgb(139, 148, 158);
/// Subtle border divider color: `RGB(48, 54, 61)`.
pub const COLOR_BORDER_SUBTLE: Color = Color::Rgb(48, 54, 61);

/// Diagnostic probe outcome status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeStatus {
    /// Probe succeeded and resource is available.
    Ok,
    /// Probe detected a non-fatal warning or absence.
    Warn,
    /// Probe encountered an error condition.
    Error,
}

impl ProbeStatus {
    /// Returns the UI badge color for this probe status.
    #[must_use]
    pub fn badge_color(self) -> Color {
        match self {
            Self::Ok => COLOR_MESH_EMERALD,
            Self::Warn => COLOR_AMBER_WARN,
            Self::Error => Color::Rgb(239, 68, 68),
        }
    }

    /// Returns human-readable status text for this probe status.
    #[must_use]
    pub fn badge_text(self) -> &'static str {
        match self {
            Self::Ok => "● RUNNING / READY",
            Self::Warn => "▲ NOT DETECTED",
            Self::Error => "✖ ERROR",
        }
    }
}

// ── Stepper Navigation Bar Widget ──────────────────────────────────────────

/// Renders the horizontal 5-step stepper bar across the top of the wizard modal.
pub struct StepperNavWidget<'a> {
    /// 1-based index of the currently active step.
    pub current_step: usize,
    /// Ordered titles of all stepper steps.
    pub step_titles: &'a [&'a str],
}

impl<'a> StepperNavWidget<'a> {
    /// Construct a new stepper bar widget.
    #[must_use]
    pub const fn new(current_step: usize, step_titles: &'a [&'a str]) -> Self {
        Self {
            current_step,
            step_titles,
        }
    }
}

impl<'a> Widget for StepperNavWidget<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        let mut spans = Vec::new();
        spans.push(Span::raw(" "));

        for (idx, title) in self.step_titles.iter().enumerate() {
            let step_num = idx + 1;
            let is_current = step_num == self.current_step;
            let is_completed = step_num < self.current_step;

            if is_current {
                spans.push(Span::styled(
                    format!(" [{step_num}] {title} "),
                    Style::default()
                        .fg(Color::Rgb(10, 15, 25))
                        .bg(COLOR_ELECTRIC_CYAN)
                        .add_modifier(Modifier::BOLD),
                ));
            } else if is_completed {
                spans.push(Span::styled(
                    format!(" ✔ {step_num}. {title} "),
                    Style::default()
                        .fg(COLOR_MESH_EMERALD)
                        .add_modifier(Modifier::BOLD),
                ));
            } else {
                spans.push(Span::styled(
                    format!(" {step_num}. {title} "),
                    Style::default().fg(COLOR_TEXT_MUTED),
                ));
            }

            if idx + 1 < self.step_titles.len() {
                spans.push(Span::styled(
                    " ──▶ ",
                    Style::default().fg(COLOR_NEURAL_VIOLET),
                ));
            }
        }

        let paragraph = Paragraph::new(Line::from(spans));
        paragraph.render(area, buf);
    }
}

// ── 1. Network Probe Widget ───────────────────────────────────────────────

/// State for Step 1: Network & Tailscale interface discovery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkProbeState {
    /// Path to local tailscaled daemon socket.
    pub socket_path: String,
    /// Whether the daemon socket was verified on disk.
    pub socket_exists: bool,
    /// Discovered Tailscale IPv4 coordinate, if available.
    pub mesh_ipv4: Option<String>,
    /// Whether the discovered IPv4 address is in 100.64.0.0/10 CGNAT.
    pub is_cgnat: bool,
    /// Whether required ports (4095, 4096, 8787) are free to bind.
    pub ports_available: bool,
}

impl Default for NetworkProbeState {
    fn default() -> Self {
        Self {
            socket_path: "/var/run/tailscaled.sock".to_string(),
            socket_exists: true,
            mesh_ipv4: Some("100.64.42.18".to_string()),
            is_cgnat: true,
            ports_available: true,
        }
    }
}

/// Renders the network interface probe cards for Step 1.
pub struct NetworkProbeWidget<'a> {
    /// The network probe state reference.
    pub state: &'a NetworkProbeState,
}

impl<'a> NetworkProbeWidget<'a> {
    /// Construct a new network probe widget.
    #[must_use]
    pub const fn new(state: &'a NetworkProbeState) -> Self {
        Self { state }
    }
}

impl<'a> Widget for NetworkProbeWidget<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        let mut lines = Vec::new();

        // Title & Description
        lines.push(Line::from(vec![
            Span::styled("🌐 ", Style::default().fg(COLOR_ELECTRIC_CYAN)),
            Span::styled(
                "Network & Tailscale Interface Discovery",
                Style::default()
                    .fg(COLOR_TEXT_PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ),
        ]));
        lines.push(Line::from(vec![Span::styled(
            "Verify local network topology and auto-detect private Tailscale mesh coordinates.",
            Style::default().fg(COLOR_TEXT_MUTED),
        )]));
        lines.push(Line::raw(""));

        // Row 1: Tailscale daemon socket
        let (socket_status_badge, socket_color) = if self.state.socket_exists {
            ("● RUNNING", COLOR_MESH_EMERALD)
        } else {
            ("▲ NOT DETECTED", COLOR_AMBER_WARN)
        };
        lines.push(Line::from(vec![
            Span::styled(
                "  🔒 Tailscale Daemon (tailscaled)  ",
                Style::default()
                    .fg(COLOR_TEXT_PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                socket_status_badge,
                Style::default()
                    .fg(socket_color)
                    .add_modifier(Modifier::BOLD),
            ),
        ]));
        lines.push(Line::from(vec![Span::styled(
            format!("     Socket: {}", self.state.socket_path),
            Style::default().fg(COLOR_TEXT_MUTED),
        )]));
        lines.push(Line::raw(""));

        // Row 2: Mesh IPv4 coordinate
        let ip_str = self.state.mesh_ipv4.as_deref().unwrap_or("No IP detected");
        let (ip_badge, ip_color) = if self.state.mesh_ipv4.is_some() {
            (ip_str, COLOR_ELECTRIC_CYAN)
        } else {
            ("OFFLINE", COLOR_AMBER_WARN)
        };
        lines.push(Line::from(vec![
            Span::styled(
                "  📡 Tailscale Mesh IPv4 Coordinate  ",
                Style::default()
                    .fg(COLOR_TEXT_PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                ip_badge,
                Style::default().fg(ip_color).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                if self.state.is_cgnat {
                    " (100.64.0.0/10 CGNAT)"
                } else {
                    ""
                },
                Style::default().fg(COLOR_TEXT_MUTED),
            ),
        ]));
        lines.push(Line::from(vec![Span::styled(
            "     Bound to utun interface (Carrier Grade NAT)",
            Style::default().fg(COLOR_TEXT_MUTED),
        )]));
        lines.push(Line::raw(""));

        // Row 3: Port checks
        let (port_badge, port_color) = if self.state.ports_available {
            ("✔ AVAILABLE (NO CONFLICTS)", COLOR_MESH_EMERALD)
        } else {
            ("▲ PORT COLLISION DETECTED", COLOR_AMBER_WARN)
        };
        lines.push(Line::from(vec![
            Span::styled(
                "  🔌 Port Availability Preflight Check  ",
                Style::default()
                    .fg(COLOR_TEXT_PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                port_badge,
                Style::default().fg(port_color).add_modifier(Modifier::BOLD),
            ),
        ]));
        lines.push(Line::from(vec![Span::styled(
            "     4095 (Ingress Router) & 8787 (Fastify Bridge) & 4096 (OpenCode)",
            Style::default().fg(COLOR_TEXT_MUTED),
        )]));
        lines.push(Line::raw(""));

        // Bottom notice card
        lines.push(Line::from(vec![
            Span::styled("  ◈ Tailnet Verification: ", Style::default().fg(COLOR_ELECTRIC_CYAN).add_modifier(Modifier::BOLD)),
            Span::styled("Traffic to AIBridge port 4095 is constrained strictly to private tailnet peers via constant-time token comparison.", Style::default().fg(COLOR_TEXT_MUTED)),
        ]));

        Paragraph::new(lines).render(area, buf);
    }
}

// ── 2. Token Generator Widget ─────────────────────────────────────────────

/// State for Step 2: Router security, CSPRNG token generator, and invariant checkboxes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenGeneratorState {
    /// Ingress router listening port.
    pub listen_port: u16,
    /// 256-bit CSPRNG bearer authentication token string.
    pub bearer_token: String,
    /// Invariant: constant-time comparison enforced.
    pub enforce_const_time: bool,
    /// Invariant: 2 MB maximum body limit enforced.
    pub enforce_body_limit: bool,
    /// Invariant: secret redaction pipeline active.
    pub enforce_secret_redaction: bool,
    /// Form field index with current input focus.
    pub focused_field: usize,
}

impl Default for TokenGeneratorState {
    fn default() -> Self {
        Self {
            listen_port: 4095,
            bearer_token: "aibr_sec_8f9024b81c2e4318a9942a1b94d1f05e".to_string(),
            enforce_const_time: true,
            enforce_body_limit: true,
            enforce_secret_redaction: true,
            focused_field: 0,
        }
    }
}

/// Renders the token generator card and security checkboxes for Step 2.
pub struct TokenGeneratorWidget<'a> {
    /// The token generator state reference.
    pub state: &'a TokenGeneratorState,
}

impl<'a> TokenGeneratorWidget<'a> {
    /// Construct a new token generator widget.
    #[must_use]
    pub const fn new(state: &'a TokenGeneratorState) -> Self {
        Self { state }
    }
}

impl<'a> Widget for TokenGeneratorWidget<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        let mut lines = Vec::new();

        lines.push(Line::from(vec![
            Span::styled("🛡️ ", Style::default().fg(COLOR_NEURAL_VIOLET)),
            Span::styled(
                "Router Security & Invariants Enforcement",
                Style::default()
                    .fg(COLOR_TEXT_PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ),
        ]));
        lines.push(Line::from(vec![Span::styled(
            "Configure constant-time bearer credentials and hard safety floor rules.",
            Style::default().fg(COLOR_TEXT_MUTED),
        )]));
        lines.push(Line::raw(""));

        // Listening Port
        lines.push(Line::from(vec![
            Span::styled(
                "  Listening Port: ",
                Style::default().fg(COLOR_TEXT_PRIMARY),
            ),
            Span::styled(
                format!("{}", self.state.listen_port),
                Style::default()
                    .fg(COLOR_ELECTRIC_CYAN)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" (Ingress Router)", Style::default().fg(COLOR_TEXT_MUTED)),
        ]));
        lines.push(Line::raw(""));

        // Bearer Token box with action keys
        lines.push(Line::from(vec![
            Span::styled(
                "  Bearer Authentication Token: ",
                Style::default().fg(COLOR_TEXT_PRIMARY),
            ),
            Span::styled(
                &self.state.bearer_token,
                Style::default()
                    .fg(COLOR_ELECTRIC_CYAN)
                    .add_modifier(Modifier::BOLD),
            ),
        ]));
        lines.push(Line::from(vec![
            Span::styled("  Actions: ", Style::default().fg(COLOR_TEXT_MUTED)),
            Span::styled(
                " [r] Regenerate ",
                Style::default()
                    .fg(COLOR_NEURAL_VIOLET)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                " [c] Copy Token ",
                Style::default()
                    .fg(COLOR_MESH_EMERALD)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                " (Generated via 256-bit CSPRNG, stored 0600)",
                Style::default().fg(COLOR_TEXT_MUTED),
            ),
        ]));
        lines.push(Line::raw(""));

        // Security Invariant Checkboxes
        lines.push(Line::from(vec![Span::styled(
            "  Security Floor Invariants:",
            Style::default()
                .fg(COLOR_TEXT_PRIMARY)
                .add_modifier(Modifier::BOLD),
        )]));

        let checkboxes = [
            (
                "Enforce Constant-Time Token Comparison",
                "Prevents timing side-channel attacks during admission handshake.",
                self.state.enforce_const_time,
            ),
            (
                "Enforce Strict 2 MB Body Payload Cap",
                "Disallows oversized JSON injections and memory exhaustion DoS vectors.",
                self.state.enforce_body_limit,
            ),
            (
                "Automated Secret Redaction Pipeline",
                "Scrubs API keys, passwords, and tokens before writing to disk/telemetry.",
                self.state.enforce_secret_redaction,
            ),
        ];

        for (title, desc, checked) in checkboxes {
            let mark = if checked { "✔" } else { " " };
            let color = if checked {
                COLOR_MESH_EMERALD
            } else {
                COLOR_TEXT_MUTED
            };
            lines.push(Line::from(vec![
                Span::styled(
                    format!("    [{mark}] "),
                    Style::default().fg(color).add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    title,
                    Style::default()
                        .fg(COLOR_TEXT_PRIMARY)
                        .add_modifier(Modifier::BOLD),
                ),
            ]));
            lines.push(Line::from(vec![Span::styled(
                format!("        {desc}"),
                Style::default().fg(COLOR_TEXT_MUTED),
            )]));
        }

        Paragraph::new(lines).render(area, buf);
    }
}

// ── 3. Directory Selector Widget ──────────────────────────────────────────

/// Single project allowlist entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectDirectoryItem {
    /// Canonical filesystem directory path.
    pub path: String,
    /// Descriptive label or detected repository summary.
    pub description: String,
    /// Whether this directory is selected for authorization.
    pub selected: bool,
}

/// State for Step 3: Project Allowlists & Containment Boundaries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectorySelectorState {
    /// List of candidate project directories.
    pub items: Vec<ProjectDirectoryItem>,
    /// Buffer for custom path input field.
    pub custom_input: String,
}

impl Default for DirectorySelectorState {
    fn default() -> Self {
        Self {
            items: vec![
                ProjectDirectoryItem {
                    path: "/Users/mac/Projects/AIBrigde".to_string(),
                    description: "Active repository root (contains AGENTS.md, src/, crates/)"
                        .to_string(),
                    selected: true,
                },
                ProjectDirectoryItem {
                    path: "/Users/mac/Projects/paryaj-demo".to_string(),
                    description: "Secondary project linked to OpenDesign prototypes".to_string(),
                    selected: true,
                },
                ProjectDirectoryItem {
                    path: "/Users/mac/Projects/scratchpad".to_string(),
                    description: "Optional sandbox directory for temporary spikes".to_string(),
                    selected: false,
                },
            ],
            custom_input: String::new(),
        }
    }
}

/// Renders allowlisted project directories and containment notice for Step 3.
pub struct DirectorySelectorWidget<'a> {
    /// The directory selector state reference.
    pub state: &'a DirectorySelectorState,
}

impl<'a> DirectorySelectorWidget<'a> {
    /// Construct a new directory selector widget.
    #[must_use]
    pub const fn new(state: &'a DirectorySelectorState) -> Self {
        Self { state }
    }
}

impl<'a> Widget for DirectorySelectorWidget<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        let mut lines = vec![Line::from(vec![
            Span::styled("📁 ", Style::default().fg(COLOR_ELECTRIC_CYAN)),
            Span::styled(
                "Project Allowlists & Containment Boundaries",
                Style::default()
                    .fg(COLOR_TEXT_PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ),
        ])];
        lines.push(Line::from(vec![Span::styled(
            "Specify canonical project roots. Agents are strictly contained to authorized paths.",
            Style::default().fg(COLOR_TEXT_MUTED),
        )]));
        lines.push(Line::raw(""));

        lines.push(Line::from(vec![Span::styled(
            "  Allowlisted Workspaces (Space to toggle):",
            Style::default()
                .fg(COLOR_TEXT_PRIMARY)
                .add_modifier(Modifier::BOLD),
        )]));

        for item in &self.state.items {
            let mark = if item.selected { "✔" } else { " " };
            let color = if item.selected {
                COLOR_MESH_EMERALD
            } else {
                COLOR_TEXT_MUTED
            };
            lines.push(Line::from(vec![
                Span::styled(
                    format!("    [{mark}] "),
                    Style::default().fg(color).add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    &item.path,
                    Style::default()
                        .fg(COLOR_TEXT_PRIMARY)
                        .add_modifier(Modifier::BOLD),
                ),
            ]));
            lines.push(Line::from(vec![Span::styled(
                format!("        {}", item.description),
                Style::default().fg(COLOR_TEXT_MUTED),
            )]));
        }

        lines.push(Line::raw(""));

        // Fail-Closed subpath policy callout
        lines.push(Line::from(vec![
            Span::styled("  ▲ Fail-Closed Subpath Policy: ", Style::default().fg(COLOR_AMBER_WARN).add_modifier(Modifier::BOLD)),
            Span::styled("Any path outside these roots or symlink target escaping this boundary triggers immediate 403 Forbidden rejection.", Style::default().fg(COLOR_TEXT_MUTED)),
        ]));

        Paragraph::new(lines).render(area, buf);
    }
}

// ── 4. Runtime Probe Widget ───────────────────────────────────────────────

/// State for Step 4: AI Agent Runtime Diagnostics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeProbeState {
    /// Whether OpenCode loopback (http://127.0.0.1:4096/health) is responsive.
    pub opencode_connected: bool,
    /// Whether the claude CLI executable was detected on system PATH.
    pub claude_installed: bool,
    /// Whether the codex CLI executable was detected on system PATH.
    pub codex_installed: bool,
}

impl Default for RuntimeProbeState {
    fn default() -> Self {
        Self {
            opencode_connected: true,
            claude_installed: true,
            codex_installed: true,
        }
    }
}

/// Renders the AI agent runtime diagnostics card for Step 4.
pub struct RuntimeProbeWidget<'a> {
    /// The runtime probe state reference.
    pub state: &'a RuntimeProbeState,
}

impl<'a> RuntimeProbeWidget<'a> {
    /// Construct a new runtime probe widget.
    #[must_use]
    pub const fn new(state: &'a RuntimeProbeState) -> Self {
        Self { state }
    }
}

impl<'a> Widget for RuntimeProbeWidget<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        let mut lines = Vec::new();

        lines.push(Line::from(vec![
            Span::styled("🤖 ", Style::default().fg(COLOR_ELECTRIC_CYAN)),
            Span::styled(
                "AI Agent Runtime Discovery & Loopback Ping",
                Style::default()
                    .fg(COLOR_TEXT_PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ),
        ]));
        lines.push(Line::from(vec![Span::styled(
            "Test loopback connectivity and PTY capabilities of local CLI agent tools.",
            Style::default().fg(COLOR_TEXT_MUTED),
        )]));
        lines.push(Line::raw(""));

        // OpenCode Loopback
        let (oc_badge, oc_color) = if self.state.opencode_connected {
            ("✔ CONNECTED (HTTP 200)", COLOR_MESH_EMERALD)
        } else {
            ("▲ OFFLINE (PORT 4096)", COLOR_AMBER_WARN)
        };
        lines.push(Line::from(vec![
            Span::styled(
                "  ⚡ OpenCode Serve Loopback (127.0.0.1:4096)  ",
                Style::default()
                    .fg(COLOR_TEXT_PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                oc_badge,
                Style::default().fg(oc_color).add_modifier(Modifier::BOLD),
            ),
        ]));
        lines.push(Line::from(vec![Span::styled(
            "     Loopback password auth & SSE event stream",
            Style::default().fg(COLOR_TEXT_MUTED),
        )]));
        lines.push(Line::raw(""));

        // Claude Code CLI
        let (claude_badge, claude_color) = if self.state.claude_installed {
            ("✔ READY", COLOR_MESH_EMERALD)
        } else {
            ("○ NOT DETECTED", COLOR_TEXT_MUTED)
        };
        lines.push(Line::from(vec![
            Span::styled(
                "  🧠 Claude Code CLI Binary  ",
                Style::default()
                    .fg(COLOR_TEXT_PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                claude_badge,
                Style::default()
                    .fg(claude_color)
                    .add_modifier(Modifier::BOLD),
            ),
        ]));
        lines.push(Line::from(vec![Span::styled(
            "     Detected on $PATH • Headless mode verified",
            Style::default().fg(COLOR_TEXT_MUTED),
        )]));
        lines.push(Line::raw(""));

        // Codex CLI
        let (codex_badge, codex_color) = if self.state.codex_installed {
            ("✔ READY", COLOR_MESH_EMERALD)
        } else {
            ("○ NOT DETECTED", COLOR_TEXT_MUTED)
        };
        lines.push(Line::from(vec![
            Span::styled(
                "  🛠️  Codex CLI Runtime  ",
                Style::default()
                    .fg(COLOR_TEXT_PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                codex_badge,
                Style::default()
                    .fg(codex_color)
                    .add_modifier(Modifier::BOLD),
            ),
        ]));
        lines.push(Line::from(vec![Span::styled(
            "     Detected on $PATH • Exec session handle verified",
            Style::default().fg(COLOR_TEXT_MUTED),
        )]));

        Paragraph::new(lines).render(area, buf);
    }
}
