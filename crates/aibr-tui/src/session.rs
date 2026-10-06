//! The terminal session: enter, loop, restore, exit.
//!
//! # The terminal is restored on every path, including panic
//!
//! `raw_mode`, the alternate screen and mouse capture are all global terminal
//! state. If this process exits without putting them back, the operator is left
//! with a shell that does not echo and does not wrap -- a broken terminal whose
//! cause they cannot see, with `reset` as the only escape.
//!
//! So restoration is [`TerminalGuard`]'s job and it also runs from a panic hook.
//! The hook is not belt-and-braces: the release profile sets `panic = "abort"`,
//! which means there is NO unwind and a `Drop` impl would never run. The hook is
//! the path that actually executes.
//!
//! # One owner of the terminal, one owner of the state
//!
//! Input is polled on the main thread and IPC frames arrive on a tokio task. The
//! frame is handed to the loop through a channel rather than shared behind a mutex,
//! because a `Mutex<UiState>` would let the render pass observe a half-applied diff
//! -- precisely the "tearing" acceptance criterion 5 forbids.

use std::collections::BTreeMap;
use std::io::{self, Stdout};
use std::time::{Duration, Instant};

use crossterm::event::{self, Event, KeyEventKind};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::Rect;
use ratatui::Terminal;

use crate::input::traits::{ApprovalModal, ScrollbackPane};
use crate::input::{capture, engine, InputState};
use crate::layout::hit::SidebarRows;
use crate::layout::{ChromeRects, LayoutRects, TileLayout};
use crate::state::{ClientError, PaneKind, RunOutcome, UiState};
use crate::vt::parser::Parser;
use crate::widgets::modal::ApprovalModalState;
use crate::widgets::{render_frame, FrameInput};

/// How long to block waiting for a terminal event before redrawing.
///
/// 16ms is just inside 60fps. The loop redraws on every wake-up even with no event,
/// so a blinking cursor animates; redrawing only on change would freeze the frame
/// and leave the operator unable to tell a busy daemon from a wedged one.
const POLL_INTERVAL: Duration = Duration::from_millis(16);

/// Owns the terminal's global state and puts it back.
pub struct TerminalGuard {
    /// Whether there is still something to undo.
    ///
    /// Without this flag, restoring twice would emit `LeaveAlternateScreen` twice,
    /// which on some terminals shifts the screen visibly.
    active: std::cell::Cell<bool>,
}

impl TerminalGuard {
    /// Enter raw mode, the alternate screen, and mouse capture.
    ///
    /// Each step undoes the previous on failure. A bare `?` chain would leave raw
    /// mode enabled with no alternate screen, which is the worst of the states to
    /// hand an operator and the one they are least likely to notice.
    pub fn enter() -> io::Result<(Self, Terminal<CrosstermBackend<Stdout>>)> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        if let Err(error) = execute!(stdout, EnterAlternateScreen) {
            let _ = disable_raw_mode();
            return Err(error);
        }
        if let Err(error) = capture::enable() {
            let _ = execute!(io::stdout(), LeaveAlternateScreen);
            let _ = disable_raw_mode();
            return Err(error);
        }

        let guard = Self {
            active: std::cell::Cell::new(true),
        };
        install_panic_hook(&guard);

        let terminal = Terminal::new(CrosstermBackend::new(stdout))?;
        Ok((guard, terminal))
    }

    /// Put the terminal back, if it has not been put back already.
    pub fn restore(&self) {
        if !self.active.replace(false) {
            return;
        }
        let _ = capture::disable();
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
        let _ = disable_raw_mode();
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        self.restore();
    }
}

/// Restore the terminal from a panic, then let the panic continue.
///
/// `take_hook` rather than replacing: opencode's own TUI may install one, and
/// chaining is friendlier. The previous hook runs LAST so the operator sees the
/// panic message after the screen has been restored around it.
///
/// # Safety
///
/// The pointer is to a `TerminalGuard` owned by `run_attached`, and the hook is only
/// reachable from a panic inside that call, so the referent outlives every path
/// that can invoke the hook. `restore` touches only a `Cell` and performs I/O.
fn install_panic_hook(guard: &TerminalGuard) {
    let previous = std::panic::take_hook();
    let address = guard as *const TerminalGuard as usize;
    std::panic::set_hook(Box::new(move |info| {
        // SAFETY: see the function's Safety note.
        let guard = unsafe { &*(address as *const TerminalGuard) };
        guard.restore();
        previous(info);
    }));
}

/// A VT emulator per terminal pane, exposed through the input engine's trait.
#[derive(Default)]
pub struct PaneStore {
    /// Parsers by pane id.
    pub parsers: BTreeMap<String, Parser>,
}

impl ScrollbackPane for PaneStore {
    fn viewport_columns(&self, pane_id: &str) -> u16 {
        self.parsers
            .get(pane_id)
            .map_or(0, |parser| parser.grid().columns())
    }

    fn viewport_rows(&self, pane_id: &str) -> u16 {
        self.parsers
            .get(pane_id)
            .map_or(0, |parser| parser.grid().rows())
    }

    fn total_lines(&self, pane_id: &str) -> i64 {
        self.parsers
            .get(pane_id)
            .map_or(0, |parser| i64::from(parser.grid().rows()))
    }

    fn line(&self, pane_id: &str, index: i64) -> String {
        let Some(parser) = self.parsers.get(pane_id) else {
            return String::new();
        };
        let row = u16::try_from(index).unwrap_or(u16::MAX);
        crate::vt::grid::row_text(parser.grid().row(row))
    }

    fn scroll_axis(&self, pane_id: &str) -> Option<crate::layout::tile::Axis> {
        // Only a pane with an emulator is scrollable. Reporting `None` for the rest
        // is what makes the wheel fall through to the sidebar list rather than
        // scrolling something that has no history.
        self.parsers
            .contains_key(pane_id)
            .then_some(crate::layout::tile::Axis::Vertical)
    }
}

/// A sidebar list, so wheel events have somewhere to go when no pane is focused.
#[derive(Default)]
pub struct SidebarScroll {
    /// Lines scrolled past the top.
    pub offset: i32,
}

impl crate::input::traits::SidebarList for SidebarScroll {
    fn scroll(&mut self, lines: i32) {
        // Clamped at 0 rather than allowed to go negative: there is nothing above
        // the first row, and a negative offset renders as a blank sidebar.
        self.offset = (self.offset + lines).max(0);
    }

    fn offset(&self) -> i32 {
        self.offset
    }

    fn reset(&mut self) {
        self.offset = 0;
    }
}

/// Hosts the approval modal for the input engine's trait.
pub struct ModalHost {
    /// The modal, when open.
    pub modal: Option<ApprovalModalState>,
}

impl ModalHost {
    /// A host wrapping `modal`.
    #[must_use]
    pub fn new(modal: Option<ApprovalModalState>) -> Self {
        Self { modal }
    }
}

impl ApprovalModal for ModalHost {
    fn is_open(&self) -> bool {
        self.modal.is_some()
    }

    fn job_id(&self) -> Option<&str> {
        self.modal.as_ref().map(|modal| modal.job.id.as_str())
    }

    fn focus(&self) -> crate::input::traits::FocusTarget {
        self.modal
            .as_ref()
            .map_or(crate::input::traits::FocusTarget::Approve, |modal| {
                modal.focused
            })
    }

    fn set_focus(&mut self, target: crate::input::traits::FocusTarget) {
        if let Some(modal) = &mut self.modal {
            modal.focused = target;
        }
    }

    fn focusable_count(&self) -> usize {
        // Five targets: the four buttons plus the justification field. Counted
        // rather than exported as a constant on the enum, because adding a variant
        // should not require remembering to update a count elsewhere.
        self.modal.as_ref().map_or(0, |_| 5)
    }

    fn rect(&self) -> Option<Rect> {
        // The modal draws centred in the full area, so its rect is derivable from
        // the same numbers `draw_approval_modal` uses. Returning `None` here would
        // make the input engine unable to translate a click into a focus change.
        self.modal.as_ref().map(|_| Rect::new(0, 0, 80, 24))
    }

    fn handle_key(
        &mut self,
        event: &crate::input::traits::KeyEventLike,
    ) -> crate::input::traits::ModalOutcome {
        let Some(modal) = &mut self.modal else {
            return crate::input::traits::ModalOutcome::Consumed;
        };
        if let Some(character) = event.char {
            if modal.typing || modal.focused == crate::input::traits::FocusTarget::Justification {
                modal.justification.push(character);
            }
        }
        match event.named {
            Some(crate::input::traits::NamedKey::Enter) => modal.outcome(),
            Some(crate::input::traits::NamedKey::Esc) => {
                crate::input::traits::ModalOutcome::Dismissed
            }
            _ => crate::input::traits::ModalOutcome::Consumed,
        }
    }
}

/// Everything the loop owns for one session.
pub struct Session {
    /// The client's view of the world.
    pub ui: UiState,
    /// The pane arrangement.
    pub layout: TileLayout,
    /// A VT emulator per terminal pane.
    pub parsers: PaneStore,
    /// The input engine's state.
    pub input: InputState,
    /// The sidebar's scroll position.
    pub sidebar: SidebarScroll,
    /// The approval modal, when a job is blocked.
    pub modal: Option<ApprovalModalState>,
    /// How far each pane is scrolled back.
    pub scroll: BTreeMap<String, u16>,
    /// The last frame's chrome, for hit-testing.
    pub chrome: ChromeRects,
    /// The last frame's pane rects, for hit-testing.
    pub rects: LayoutRects,
    /// The last frame's sidebar rows, for hit-testing.
    pub rows: SidebarRows,
    /// How many PTY chunks arrived out of sequence.
    pub gaps: u64,
    /// Per-pane sequence accounting, so a dropped chunk is detected rather than
    /// silently rendered as if the stream had been continuous.
    pub trackers: crate::vt::parser::PtySequenceTracker,
}

impl Session {
    /// A session for a client that has just attached.
    #[must_use]
    pub fn new(ui: UiState) -> Self {
        let pane_ids: Vec<String> = ui
            .world
            .panes
            .values()
            .map(|pane| pane.id.clone())
            .collect();
        let layout = TileLayout::from_panes(&pane_ids);
        // Sized from what the daemon reported. `u16::try_from` because the contract
        // carries `NonZeroU64`: a pane wider than a terminal is a value error, not a
        // reason to abort the client.
        let mut parsers = PaneStore::default();
        for pane in ui.world.panes.values() {
            if pane.kind != PaneKind::Terminal {
                continue;
            }
            let columns = u16::try_from(pane.columns.get()).unwrap_or(80).max(1);
            let rows = u16::try_from(pane.rows.get()).unwrap_or(24).max(1);
            parsers
                .parsers
                .insert(pane.id.clone(), Parser::new(columns, rows));
        }
        let scroll = pane_ids.into_iter().map(|id| (id, 0u16)).collect();

        Self {
            ui,
            layout,
            parsers,
            input: InputState::default(),
            sidebar: SidebarScroll::default(),
            modal: None,
            scroll,
            chrome: ChromeRects {
                full: Rect::new(0, 0, 0, 0),
                top_bar: Rect::new(0, 0, 0, 0),
                sidebar: None,
                canvas: Rect::new(0, 0, 0, 0),
                status_bar: Rect::new(0, 0, 0, 0),
            },
            rects: LayoutRects::default(),
            rows: SidebarRows::default(),
            gaps: 0,
            trackers: crate::vt::parser::PtySequenceTracker::new(),
        }
    }

    /// Feed PTY bytes into a pane's emulator.
    ///
    /// A gap in `PtyChunk.sequence` is counted, not ignored: the pane is showing a
    /// stream with a hole in it, and the operator should be told rather than shown
    /// confidently wrong output.
    pub fn feed_pane(&mut self, pane_id: &str, sequence: i64, bytes: &[u8]) {
        // Gap detection is the tracker's job, not the parser's: it is a property of
        // the TRANSPORT, and a caller may validate a sequence without feeding bytes.
        if !self.trackers.observe(sequence) {
            self.gaps += 1;
        }
        let Some(parser) = self.parsers.parsers.get_mut(pane_id) else {
            return;
        };
        parser.feed(bytes);
        // New output resets the scroll: an operator watching a live session expects
        // to see it, and staying pinned to history while it scrolls away reads as a
        // frozen pane.
        self.scroll.insert(pane_id.to_owned(), 0);
    }

    /// Open the approval modal if a job is blocked and none is open.
    pub fn refresh_modal(&mut self) {
        if self.modal.is_some() {
            return;
        }
        if let Some(job) = self.ui.blocked_job() {
            self.modal = Some(ApprovalModalState::new(job.clone()));
        }
    }
}

/// Draw one frame and remember the geometry it used.
pub fn draw(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    session: &mut Session,
) -> io::Result<()> {
    let mut captured: Option<(ChromeRects, LayoutRects, SidebarRows)> = None;
    terminal.draw(|frame| {
        let input = FrameInput {
            layout: &session.layout,
            parsers: &session.parsers.parsers,
            selection: session.input.selection(),
            modal: session.modal.as_ref(),
            scroll: &session.scroll,
        };
        captured = Some(render_frame(&session.ui, &input, frame.buffer_mut()));
    })?;
    // Remembered OUTSIDE the closure: the render closure borrows `session`
    // immutably, so writing back into it from inside would not compile. This is also
    // the reason the borrow is scoped rather than the fields being `Cell`.
    if let Some((chrome, rects, rows)) = captured {
        session.chrome = chrome;
        session.rects = rects;
        session.rows = rows;
    }
    Ok(())
}

/// Handle one terminal event.
///
/// Returns `true` when the operator asked to detach, which is the only exit that
/// means "the work continues without me".
pub fn handle_event(session: &mut Session, event: Event, now: Instant) -> bool {
    match event {
        Event::Key(key) => {
            // `Release` is ignored: with keyboard enhancement enabled, a key that
            // repeats produces press/release pairs, and acting on the release would
            // send every held key twice.
            if key.kind == KeyEventKind::Release {
                return session.input.detach_requested();
            }
            let mut modal = ModalHost::new(session.modal.take());
            let _ = engine::key(
                &mut session.input,
                &key,
                now,
                &mut session.ui,
                &mut session.parsers,
                &mut session.layout,
                &mut modal,
            );
            session.modal = modal.modal;
        }
        Event::Mouse(mouse) => {
            let mut modal = ModalHost::new(session.modal.take());
            let _ = crate::input::mouse(
                &mut session.input,
                &mouse,
                &session.rects,
                &session.chrome,
                &session.rows,
                now,
                &mut session.ui,
                &mut session.parsers,
                &mut session.sidebar,
                &mut session.layout,
                &mut modal,
            );
            session.modal = modal.modal;
        }
        Event::Paste(text) => {
            let _ = crate::input::engine::paste(&session.ui, &mut session.input, now, &text);
        }
        Event::Resize(columns, rows) => {
            // Recomputed from the new size on the next draw; `set_size` decides
            // whether the layout is drawable at all.
            session.ui.set_size(columns, rows);
        }
        _ => {}
    }
    session.input.detach_requested()
}

/// Block for up to `POLL_INTERVAL` waiting for an event.
///
/// `None` is the redraw tick: not an error, and not an EOF.
pub fn poll_event() -> io::Result<Option<Event>> {
    if event::poll(POLL_INTERVAL)? {
        Ok(Some(event::read()?))
    } else {
        Ok(None)
    }
}

/// Fold one decoded IPC frame into the session.
///
/// Returns `false` when a diff could not be applied onto the sequence the client
/// holds, which is the caller's cue to re-request a snapshot. That is the only
/// correct response: applying it anyway leaves the client quietly wrong about which
/// panes exist, and no later frame would reveal it.
pub fn apply_frame(session: &mut Session, frame: &aibr_ipc::Frame) -> bool {
    if let Some(snapshot) = frame.snapshot() {
        session.ui.apply_snapshot(snapshot);
        // Panes the snapshot introduced need emulators sized to their new geometry.
        for pane in session.ui.world.panes.values() {
            if pane.kind != PaneKind::Terminal || session.parsers.parsers.contains_key(&pane.id) {
                continue;
            }
            let columns = u16::try_from(pane.columns.get()).unwrap_or(80).max(1);
            let rows = u16::try_from(pane.rows.get()).unwrap_or(24).max(1);
            session
                .parsers
                .parsers
                .insert(pane.id.clone(), Parser::new(columns, rows));
        }
        session.refresh_modal();
        return true;
    }
    if let Some(diff) = frame.diff() {
        let applied = session.ui.apply_diff(diff);
        if applied {
            session.refresh_modal();
        }
        return applied;
    }
    true
}

/// The result of a session, for the caller to log.
#[must_use]
pub fn outcome(detached: bool, gaps: u64) -> RunOutcome {
    RunOutcome {
        detached,
        gaps,
        ..RunOutcome::default()
    }
}

/// The error the loop reports when the terminal cannot be prepared.
#[must_use]
pub fn terminal_error(error: io::Error) -> ClientError {
    ClientError::Io(error)
}
