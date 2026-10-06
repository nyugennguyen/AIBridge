//! The seams between this engine and the workstreams that have not landed.
//!
//! # WHY TRAITS WITH NO-OP DEFAULTS
//!
//! Four things the input engine needs do not exist yet: a VT grid with scrollback
//! and selection (workstream 4), a layout renderer that produces [`LayoutRects`],
//! a clipboard, and an approval modal. Each is declared here as a trait with a
//! no-op default so the whole engine builds and is testable before any of them
//! lands, and supplying a real implementation is the only change integration
//! makes.
//!
//! THE DEFAULTS ARE NOT STUBS, AND THAT IS THE POINT. A trait method with a default
//! body is a documented promise that the engine keeps working without the
//! implementation. Every default here is the SAFE degradation, never the interesting
//! behaviour: [`ScrollbackPane::hyperlink_at`] returns `None` so a `Ctrl+Click`
//! opens nothing rather than opening something unvalidated; [`ScrollbackPane::line`]
//! returns `""` so a selection copies empty rather than copying something the engine
//! reconstructed wrongly. Where a no-op default would hide a bug rather than absorb
//! one, the method has no default at all and the compile error is the signal.
//!
//! No trait here performs I/O *from inside the reducer*. The clipboard and the
//! browser opener are consumed by the shell acting on an [`Action`](crate::input::Action);
//! the reducer never calls them. That is what keeps `key` and `mouse` pure.

use crate::input::sanitize::SanitizedUrl;
use crate::layout::Axis;

/// A pane's scrollback: what the operator can read, search, select and scroll.
///
/// ONE IMPLEMENTATION MUST SERVE EVERY PANE, so every method takes a `pane_id`
/// rather than the trait being implemented per-pane. A per-pane trait would force
/// the engine to hold a swappable trait object and re-point it on every focus change,
/// and the object that got re-pointed would be the one carrying the scrollback
/// cursor.
pub trait ScrollbackPane {
    /// The absolute index of the first visible line. `0` is the oldest retained line.
    ///
    /// ABSOLUTE, unlike the cell coordinates below: a search hit has to be reportable as
    /// "line 4,201" in a log, which means it cannot be relative to the viewport.
    fn viewport_top(&self, _pane_id: &str) -> i64 {
        0
    }

    /// How many rows the pane's content area shows.
    fn viewport_rows(&self, _pane_id: &str) -> u16 {
        0
    }

    /// How many columns the pane's content area shows.
    ///
    /// Used as the exclusive upper bound when a selection or a copy-mode movement
    /// reaches the right edge, so it must be the pane's CONTENT width and not its
    /// outer width: including the border would put one extra cell of every line into
    /// a copied selection.
    fn viewport_columns(&self, _pane_id: &str) -> u16 {
        0
    }

    /// Lines currently scrolled back from the live bottom.
    fn scroll_offset(&self, pane_id: &str) -> i64 {
        self.total_lines(pane_id)
            - i64::from(self.viewport_rows(pane_id))
            - self.viewport_top(pane_id)
    }

    /// Total retained lines, scrollback plus the live screen.
    fn total_lines(&self, _pane_id: &str) -> i64 {
        0
    }

    /// Scroll `lines` further back in history.
    fn scroll_back(&mut self, _pane_id: &str, _lines: u16) {}

    /// Scroll `lines` forward toward the live bottom.
    fn scroll_forward(&mut self, _pane_id: &str, _lines: u16) {}

    /// Put `index` at the top of the viewport. Used to keep a copy-mode cursor
    /// visible, so the implementation must clamp rather than refuse.
    fn scroll_to_line(&mut self, _pane_id: &str, _index: i64) {}

    /// Jump to the oldest retained line.
    fn scroll_to_top(&mut self, _pane_id: &str) {}

    /// Jump to the live bottom.
    fn scroll_to_bottom(&mut self, _pane_id: &str) {}

    /// The text of one absolute line, without its terminator.
    fn line(&self, _pane_id: &str, _index: i64) -> String {
        String::new()
    }

    /// Whether `index` continues the line before it because the terminal WRAPPED
    /// rather than because the program emitted a newline.
    ///
    /// This is what lets a copy-mode search and a copy-on-select run across a soft
    /// wrap: a query of `foo bar` matches a pane that shows `foo` at the end of one
    /// row and `bar` at the start of the next. Defaulting to `false` treats every
    /// line as hard-terminated, which is wrong for wrapped output and merely
    /// imprecise for real newlines.
    fn line_is_continuation(&self, _pane_id: &str, _index: i64) -> bool {
        false
    }

    /// Columns `from_col`..`to_col` of one line, half-open, in DISPLAY columns.
    ///
    /// Display columns, not byte offsets and not `char` indices: a CJK cell occupies
    /// two, and an emoji occupies two or four depending on the terminal. The default
    /// indexes `char`s, which is correct only for single-width text -- which is why
    /// an implementation that has a grid must override this rather than inherit it.
    fn slice_line(&self, pane_id: &str, index: i64, from_col: u16, to_col: u16) -> String {
        let line = self.line(pane_id, index);
        if to_col <= from_col {
            return String::new();
        }
        line.chars()
            .skip(from_col as usize)
            .take((to_col - from_col) as usize)
            .collect()
    }

    /// The OSC 8 hyperlink under a cell, as the URI exactly as the pane holds it --
    /// UNVALIDATED.
    ///
    /// `column` and `row` are PANE-CONTENT coordinates: row 0 is the first line the pane
    /// shows, column 0 the pane's first column. The grid does not know where it is drawn on
    /// the screen and must not be told, or it would depend on the render pass.
    ///
    /// Returning the raw URI is deliberate. Validation happens once, in
    /// [`sanitize_url`](crate::input::sanitize_url), so that the rule "only `http`
    /// and `https` reach a browser" is enforced in exactly one function rather than
    /// in every producer of a URI. An implementation that pre-validates is not
    /// wrong, but it must not be the only validation.
    fn hyperlink_at(&self, _pane_id: &str, _column: u16, _row: u16) -> Option<String> {
        None
    }

    /// The pane's unredacted raw byte log, for `Copy Raw Logs`.
    ///
    /// May be empty. Whatever it returns is passed through the [`Redactor`] before
    /// it reaches the clipboard, which is the whole reason the method is allowed to
    /// be raw.
    fn raw_log(&self, _pane_id: &str) -> String {
        String::new()
    }

    /// The axis the pane's scrollbar acts along.
    ///
    /// `None` for a pane that does not scroll. The engine routes wheel events to
    /// scrollback only when this is `Some`; a [`PaneKind::PlanReview`](crate::state::PaneKind)
    /// diff has no scrollback and silently ignoring the wheel is better than
    /// scrolling a buffer that does not exist.
    fn scroll_axis(&self, _pane_id: &str) -> Option<Axis> {
        None
    }
}

/// The sidebar's scrolling list.
pub trait SidebarList {
    /// Scroll by `lines`, negative toward the top.
    fn scroll(&mut self, _lines: i32) {}

    /// The current scroll offset, for the render pass.
    fn offset(&self) -> i32 {
        0
    }

    /// Return to the top. Called on focus change so the operator always sees the
    /// job they just selected.
    fn reset(&mut self) {}
}

/// Secret redaction, applied to everything that leaves the client as text.
///
/// Criteria 7 and 8 are "no secret reaches the operator's clipboard and no secret
/// reaches the status bar". Both are only enforceable if redaction happens on the way
/// OUT, because the client cannot know what a pane's output contains; a pane showing
/// a raw log is a pane showing whatever the peer sent. So the extracted selection and
/// the yanked copy-mode line are both redacted here, before the [`Action`] is
/// constructed.
///
/// THE PRODUCTION IMPLEMENTATION IS THE VT WORKSTREAM'S, not this crate's. The
/// engine must not grow a second, weaker rule set: one redactor, one rule set, one
/// place it can be wrong. See [`RedactingClipboard`] for what happens if the default
/// is ever left in place.
pub trait Redactor {
    /// Return `text` with secrets replaced.
    fn redact(&self, text: &str) -> String;
}

/// Writes text to the operating system clipboard.
///
/// Not called from the reducer. The shell calls it when it acts on
/// [`Action::CopySelection`](crate::input::Action::CopySelection), because a
/// clipboard write can block on an X11 selection owner and a reducer that blocks is
/// a reducer whose tests are timing-dependent.
pub trait Clipboard {
    /// Put `text` on the clipboard, replacing whatever was there.
    fn copy(&mut self, text: &str) -> Result<(), ClipboardError>;
}

/// Why a clipboard write failed.
///
/// `arboard` returns a plain error on every platform, so this exists to name the
/// two failures that mean different things to an operator: no clipboard mechanism at
/// all (`WAYLAND_DISPLAY` unset on a Wayland session, no `pbcopy` on a bare
/// container), versus a clipboard that exists and refused the write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClipboardError {
    /// No clipboard mechanism is reachable in this environment.
    Unavailable(String),
    /// The clipboard exists but rejected the write.
    Rejected(String),
}

impl std::fmt::Display for ClipboardError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(detail) => write!(formatter, "no clipboard available: {detail}"),
            Self::Rejected(detail) => write!(formatter, "clipboard refused the write: {detail}"),
        }
    }
}

impl std::error::Error for ClipboardError {}

/// Opens a URL in the operating system browser.
///
/// Takes an ALREADY-SANITISED URL. The type carries [`SanitizedUrl`](crate::input::SanitizedUrl)
/// rather than `&str` so that a caller cannot hand this trait an unsanitised string
/// by accident: the only way to obtain one is
/// [`sanitize_url`](crate::input::sanitize_url), which refuses everything that is
/// not `http` or `https`.
pub trait UrlOpener {
    /// Open `url`, or report why not.
    fn open(&mut self, url: &SanitizedUrl) -> Result<(), UrlOpenError>;
}

/// Why a URL could not be opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UrlOpenError {
    /// The platform has no opener this client knows how to invoke.
    UnsupportedPlatform,
    /// The opener was invoked and failed.
    Failed(String),
}

impl std::fmt::Display for UrlOpenError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedPlatform => write!(formatter, "no system URL opener on this platform"),
            Self::Failed(detail) => write!(formatter, "the URL opener failed: {detail}"),
        }
    }
}

impl std::error::Error for UrlOpenError {}

/// Which control the operator is addressing inside the approval modal.
///
/// Owned here, not by the modal, because the input engine's job is to decide whether
/// an event belongs to the modal and the modal's job is to render. The enum is
/// declared at the boundary so neither side has to declare it twice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusTarget {
    /// `Approve and Apply`.
    Approve,
    /// `Approve Step-by-Step`.
    ApproveStepByStep,
    /// `Reject with Instructions`, which opens the justification text input.
    Reject,
    /// `Abort Job`.
    Abort,
    /// The free-text field inside the reject flow.
    Justification,
}

impl FocusTarget {
    /// Every focusable control, in tab order.
    const ORDER: [FocusTarget; 5] = [
        FocusTarget::Approve,
        FocusTarget::ApproveStepByStep,
        FocusTarget::Reject,
        FocusTarget::Abort,
        FocusTarget::Justification,
    ];

    /// Move focus, wrapping within the first `count` controls.
    ///
    /// WRAPPING rather than stopping at the end: a modal where `Tab` stops at the last
    /// control is a modal that can be left by accident and is then sitting there
    /// swallowing every keystroke, including the ones meant to dismiss it.
    #[must_use]
    pub fn next(self, count: usize) -> Self {
        let count = count.clamp(1, Self::ORDER.len());
        let index = Self::ORDER
            .iter()
            .position(|target| *target == self)
            .unwrap_or(0);
        Self::ORDER[(index + 1) % count]
    }

    /// See [`Self::next`].
    #[must_use]
    pub fn previous(self, count: usize) -> Self {
        let count = count.clamp(1, Self::ORDER.len());
        let index = Self::ORDER
            .iter()
            .position(|target| *target == self)
            .unwrap_or(0);
        Self::ORDER[(index + count - 1) % count]
    }
}

/// The approval modal, as the input engine sees it.
///
/// The engine owns ONE rule about the modal and it is the reason this trait exists:
/// while the modal is open, every event goes to it. Not every key EVENT -- every
/// event, mouse included. A `blocked` job is the one moment the operator is being
/// asked to make a security decision, and a stray click that lands on the terminal
/// behind the modal and types a character into an agent's PTY is a way for the agent
/// to act while the human believes they are reading.
pub trait ApprovalModal {
    /// Whether the modal is currently shown.
    fn is_open(&self) -> bool {
        false
    }

    /// The job awaiting a decision, for the `approve_plan` / `reject_plan` commands
    /// the outcome is turned into.
    fn job_id(&self) -> Option<&str> {
        None
    }

    /// Which control has focus, for the render pass and for `Tab` cycling.
    fn focus(&self) -> FocusTarget {
        FocusTarget::Approve
    }

    /// Move focus to a control.
    ///
    /// Called by the engine, not by the modal: `Tab` cycling has to wrap around the
    /// control list, and the modal is the only thing that knows the list, so the cycle
    /// lives here and the assignment lives there.
    fn set_focus(&mut self, target: FocusTarget) {
        let _ = target;
    }

    /// Number of focusable controls, so `Tab` wraps correctly.
    fn focusable_count(&self) -> usize {
        0
    }

    /// Give the modal a key event.
    fn handle_key(&mut self, _event: &KeyEventLike) -> ModalOutcome {
        ModalOutcome::Consumed
    }

    /// The modal's own rectangle, so the engine can translate a click into it.
    ///
    /// `None` means the modal is not drawn anywhere the engine can reach -- a modal
    /// that is open but has no rectangle still intercepts every event, which is the
    /// safe direction: an unlocatable modal cannot be clicked through.
    fn rect(&self) -> Option<ratatui::layout::Rect> {
        None
    }

    /// Give the modal a mouse event.
    ///
    /// Coordinates are RELATIVE to [`Self::rect`] because the modal floats: a widget
    /// that renders itself centred must hit-test its own buttons without the engine
    /// knowing where the renderer put the dialog. The engine passes `(0, 0)` when
    /// [`Self::rect`] is `None`, which the modal must read as "outside me".
    fn handle_click(&mut self, _column: u16, _row: u16, _target: FocusTarget) -> ModalOutcome {
        ModalOutcome::Consumed
    }
}

/// What the modal decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModalOutcome {
    /// Swallowed. No action leaves the client.
    Consumed,
    /// Approve with a scope.
    Approve {
        /// Apply at once, or step by step.
        scope: ApproveScope,
    },
    /// Reject, with the operator's reason.
    Reject {
        /// Free text, or `None` if the operator rejected without typing one.
        justification: Option<String>,
    },
    /// Abort the job entirely.
    Abort,
    /// The modal closed without a decision, e.g. `Esc`.
    Dismissed,
}

/// How far an approval extends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApproveScope {
    /// `Approve and Apply`.
    Apply,
    /// `Approve Step-by-Step`.
    StepByStep,
}

/// A key event, reduced to what the modal needs.
///
/// A STRUCT RATHER THAN `crossterm::event::KeyEvent` so the modal is testable and so
/// the boundary the widgets workstream implements is explicit. A conversion from
/// crossterm lives in [`crate::input::keys`] and is total.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct KeyEventLike {
    /// The key, if it is a printable character.
    pub char: Option<char>,
    /// Whether `Ctrl` was held.
    pub ctrl: bool,
    /// Whether `Alt` was held.
    pub alt: bool,
    /// Whether `Shift` was held.
    pub shift: bool,
    /// The named key, when it is not a character.
    pub named: Option<NamedKey>,
}

/// A non-character key the modal cares about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NamedKey {
    /// Return.
    Enter,
    /// Escape.
    Esc,
    /// Tab.
    Tab,
    /// Back-tab.
    BackTab,
    /// Backspace.
    Backspace,
    /// Left arrow.
    Left,
    /// Right arrow.
    Right,
    /// Up arrow.
    Up,
    /// Down arrow.
    Down,
}

/// Total, so the modal's key handling never has to know about crossterm.
impl From<&crossterm::event::KeyEvent> for KeyEventLike {
    fn from(event: &crossterm::event::KeyEvent) -> Self {
        use crossterm::event::{KeyCode, KeyModifiers};

        let named = match event.code {
            KeyCode::Enter => Some(NamedKey::Enter),
            KeyCode::Esc => Some(NamedKey::Esc),
            KeyCode::Tab => Some(NamedKey::Tab),
            KeyCode::BackTab => Some(NamedKey::BackTab),
            KeyCode::Backspace => Some(NamedKey::Backspace),
            KeyCode::Left => Some(NamedKey::Left),
            KeyCode::Right => Some(NamedKey::Right),
            KeyCode::Up => Some(NamedKey::Up),
            KeyCode::Down => Some(NamedKey::Down),
            _ => None,
        };
        Self {
            // A character key keeps its character even when `Ctrl` is held, because the
            // modal's text field needs to know whether `Ctrl+W` is a word-delete
            // binding rather than the letter `w`.
            char: match event.code {
                KeyCode::Char(character) => Some(character),
                _ => None,
            },
            ctrl: event.modifiers.contains(KeyModifiers::CONTROL),
            alt: event.modifiers.contains(KeyModifiers::ALT),
            shift: event.modifiers.contains(KeyModifiers::SHIFT),
            named,
        }
    }
}

/// A [`ScrollbackPane`] that remembers nothing and answers nothing.
///
/// NOT a general-purpose mock. It exists for the case where the client is running
/// before the VT grid has produced a viewport for a pane the operator clicked -- a
/// real state during startup, when a click can arrive before the first frame has
/// been rendered for that pane. Returning empty text and `None` there means a click
/// copies nothing, which is correct: there is nothing on screen to copy.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoScrollback;

impl ScrollbackPane for NoScrollback {}

/// A [`SidebarList`] that does nothing.
///
/// FOR THE CASE WHERE THE SIDEBAR HAS NO LIST TO SCROLL -- a wheel event that landed
/// on the canvas, or one that arrived before the sidebar's rows were built. Scrolling
/// it by zero keeps the "a wheel notch produces a scroll amount" invariant true on
/// every path rather than making each caller special-case the empty list.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoSidebar;

impl SidebarList for NoSidebar {}
