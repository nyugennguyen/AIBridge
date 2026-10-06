//! The plan review and diff pane.
//!
//! # This is the security-relevant surface of the TUI
//!
//! An operator approves a plan here. So the widget does not merely colour lines --
//! it flags the operations that matter, because a diff that looks identical is not:
//! one hunk adding a database migration and one hunk adding a comment are the same
//! six lines of green, and they deserve very different decisions.
//!
//! Every line the agent proposes is passed through [`crate::input::redact`] before
//! it is drawn. Acceptance criterion 8 requires that nothing an agent produced
//! reaches the screen unscrubbed, and a diff is the densest place agent-authored
//! text appears.
//!
//! # Redaction at draw time, not at parse time
//!
//! Scrubbing here rather than when the diff is parsed means the raw text is
//! available to the logic that decides what is risky -- a path check needs the real
//! path -- while the operator only ever sees the scrubbed version. Redacting earlier
//! would make the risk analysis operate on text that has already been altered.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Span;

use crate::input::redact::{redact_with_report, ConservativeRedactor};
use crate::input::traits::Redactor;

/// One line of a unified diff, already classified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffLine {
    /// `@@ -a,b +c,d @@` hunk header.
    Hunk(String),
    /// `+` addition.
    Added(String),
    /// `-` deletion.
    Removed(String),
    /// ` ` context.
    Context(String),
    /// A file header: `--- a/x`, `+++ b/x`, or `diff --git`.
    File(String),
}

/// A diff, and where the operator has scrolled to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DiffView {
    /// The classified lines.
    pub lines: Vec<DiffLine>,
    /// First visible line index.
    pub top: usize,
}

/// Why a line was flagged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Flag {
    /// The rule that fired.
    pub rule: &'static str,
    /// The matched text, scrubbed.
    pub evidence: String,
}

/// The operations that make a diff worth reading twice.
///
/// A list rather than a general "looks dangerous" score, because a score an
/// operator cannot inspect is a score they cannot act on: naming the rule means a
/// false positive is one they can dismiss rather than one they must re-derive.
const SENSITIVE: &[(&str, &[&str])] = &[
    (
        "destructive delete",
        &["rm -rf", "rm -fr", "mkfs", "dd if=", ":(){"],
    ),
    (
        "destructive sql",
        &[
            "drop table",
            "drop database",
            "truncate table",
            "delete from",
        ],
    ),
    (
        "history rewrite",
        &["git push --force", "git reset --hard", "git clean -fd"],
    ),
    (
        "privilege change",
        &["chmod 777", "chown root", "sudo ", "setuid"],
    ),
    (
        "credential path",
        &[".env", "id_rsa", "credentials", ".pem", ".aws/", "secrets."],
    ),
    ("network egress", &["curl ", "wget ", "nc ", "ssh "]),
];

/// Classify one line of a unified diff.
///
/// Returns the classified line and any flags. Flags are checked against the line
/// with its leading marker removed, so `+rm -rf /tmp` and `-rm -rf /tmp` both flag.
#[must_use]
pub fn classify(line: &str) -> (DiffLine, Vec<Flag>) {
    let mut flags = Vec::new();
    let content = line.strip_prefix(['+', '-', ' ']).unwrap_or(line);

    for (rule, patterns) in SENSITIVE {
        if patterns.iter().any(|pattern| content.contains(pattern)) {
            flags.push(Flag {
                rule,
                // The evidence is redacted for the same reason the rendered line is:
                // the matched text is agent-authored and may itself be a secret.
                evidence: redact_with_report(content).0,
            });
        }
    }

    let classified =
        if line.starts_with("diff --git") || line.starts_with("--- ") || line.starts_with("+++ ") {
            DiffLine::File(line.to_owned())
        } else if line.starts_with("@@") {
            DiffLine::Hunk(line.to_owned())
        } else if line.starts_with('+') {
            DiffLine::Added(line.to_owned())
        } else if line.starts_with('-') {
            DiffLine::Removed(line.to_owned())
        } else {
            DiffLine::Context(line.to_owned())
        };
    (classified, flags)
}

/// The redactor used for rendered diff text.
///
/// Constructed once per draw rather than threaded through the widget, because the
/// rules live in one place and a second copy here would drift from the input
/// engine's.
struct DefaultRedactor(ConservativeRedactor);

impl Redactor for DefaultRedactor {
    fn redact(&self, text: &str) -> String {
        redact_with_report(text).0
    }
}

/// Draw the diff pane into `area`.
pub fn draw_diff_pane(view: &DiffView, area: Rect, buffer: &mut Buffer) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let redactor = DefaultRedactor(ConservativeRedactor);
    let visible = view
        .lines
        .len()
        .saturating_sub(view.top)
        .min(usize::from(area.height));

    for (offset, line) in view.lines[view.top..view.top + visible].iter().enumerate() {
        let y = area.y + offset as u16;
        let (text, style) = match line {
            DiffLine::File(text) => (text.as_str(), Style::default().add_modifier(Modifier::BOLD)),
            DiffLine::Hunk(text) => (text.as_str(), Style::default().fg(Color::DarkGray)),
            DiffLine::Added(text) => (text.as_str(), Style::default().fg(Color::LightGreen)),
            DiffLine::Removed(text) => (text.as_str(), Style::default().fg(Color::LightRed)),
            DiffLine::Context(text) => (text.as_str(), Style::default().fg(Color::DarkGray)),
        };
        // Redacted on the way out, not on the way in: the risk analysis below needs
        // the real text (a path check has to see the actual path), while the
        // operator only ever sees the scrubbed version.
        write(
            buffer,
            Rect::new(area.x, y, area.width, 1),
            &redactor.redact(text),
            style,
        );

        // A flagged line gets a marker in the last column, so the flag is visible in
        // a glance rather than only in a hover the operator may never perform.
        if !sensitive_for(line).is_empty() {
            let marker = area.x.saturating_add(area.width.saturating_sub(1));
            if marker > area.x {
                buffer[(marker, y)].set_symbol("!").set_style(
                    Style::default()
                        .fg(Color::LightRed)
                        .add_modifier(Modifier::BOLD),
                );
            }
        }
    }
}

/// The raw text of a classified line, without its marker.
fn line_text(line: &DiffLine) -> &str {
    match line {
        DiffLine::Hunk(text)
        | DiffLine::Added(text)
        | DiffLine::Removed(text)
        | DiffLine::Context(text)
        | DiffLine::File(text) => text,
    }
}

/// Which sensitive rules a line matches.
///
/// A rule NAME, not a score. An operator who cannot see which rule fired cannot
/// dismiss a false positive -- they have to re-derive the judgement, which is the
/// thing this list exists to avoid.
fn sensitive_for(line: &DiffLine) -> Vec<&'static str> {
    let content = line_text(line);
    SENSITIVE
        .iter()
        .filter(|(_, patterns)| patterns.iter().any(|pattern| content.contains(pattern)))
        .map(|(rule, _)| *rule)
        .collect()
}

/// Write text into one row, truncated.
fn write(buffer: &mut Buffer, area: Rect, text: &str, style: Style) {
    let mut x = area.x;
    for grapheme in text.chars() {
        if x >= area.x.saturating_add(area.width) {
            return;
        }
        buffer[(x, area.y)]
            .set_symbol(&grapheme.to_string())
            .set_style(style);
        x += 1;
    }
    let _ = Span::raw("");
}
