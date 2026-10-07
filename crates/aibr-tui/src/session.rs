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

use crate::daemon::Outbound;
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
    /// The terminal area, so a click can be resolved against the modal's real
    /// rectangle.
    ///
    /// Needed because the trait's `handle_click` takes coordinates but no geometry,
    /// and the alternative -- a hardcoded 80x24 -- resolved every click against a
    /// rectangle the operator never saw. At any other window size the buttons were
    /// drawn in one place and clickable in another.
    pub screen: Rect,
}

impl ModalHost {
    /// A host wrapping `modal`, drawing into `screen`.
    #[must_use]
    pub fn new(modal: Option<ApprovalModalState>, screen: Rect) -> Self {
        Self { modal, screen }
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
        self.modal
            .as_ref()
            .map(|_| crate::widgets::modal::modal_rect(self.screen))
    }

    fn handle_click(
        &mut self,
        column: u16,
        row: u16,
        target: crate::input::traits::FocusTarget,
    ) -> crate::input::traits::ModalOutcome {
        // Same take-and-restore rule as `handle_key`: a click on a button is a
        // decision and closes the prompt; a click anywhere else is swallowed and
        // leaves it open, because a stray click meant for the terminal behind the
        // modal must not approve or reject anything.
        let Some(mut modal) = self.modal.take() else {
            return crate::input::traits::ModalOutcome::Consumed;
        };
        let area = crate::widgets::modal::modal_rect(self.screen);
        let card_area = crate::widgets::modal::embedded_card_rect(self.screen);

        let card_action = modal.card_action_at(card_area, column, row);
        let outcome = match card_action {
            Some(crate::widgets::modal::CardAction::ApproveOnce) => {
                crate::input::traits::ModalOutcome::Approve {
                    scope: crate::input::traits::ApproveScope::Apply,
                }
            }
            Some(crate::widgets::modal::CardAction::Deny) => {
                crate::input::traits::ModalOutcome::Reject {
                    justification: None,
                }
            }
            Some(crate::widgets::modal::CardAction::RevisePrompt) => {
                modal.focused = crate::input::traits::FocusTarget::Justification;
                modal.typing = true;
                crate::input::traits::ModalOutcome::Consumed
            }
            None => match modal.action_at(area, column, row) {
                Some(action) => {
                    modal.focused = action.target();
                    if action == crate::widgets::modal::ModalAction::Abort {
                        crate::input::traits::ModalOutcome::Abort
                    } else {
                        modal.outcome()
                    }
                }
                None if (column >= area.x
                    && column < area.x.saturating_add(area.width)
                    && row >= area.y
                    && row < area.y.saturating_add(area.height))
                    || (column >= card_area.x
                        && column < card_area.x.saturating_add(card_area.width)
                        && row >= card_area.y
                        && row < card_area.y.saturating_add(card_area.height)) =>
                {
                    modal.focused = target;
                    crate::input::traits::ModalOutcome::Consumed
                }
                None => crate::input::traits::ModalOutcome::Consumed,
            },
        };
        if outcome == crate::input::traits::ModalOutcome::Consumed {
            self.modal = Some(modal);
        }
        outcome
    }

    fn handle_key(
        &mut self,
        event: &crate::input::traits::KeyEventLike,
    ) -> crate::input::traits::ModalOutcome {
        let Some(mut modal) = self.modal.take() else {
            return crate::input::traits::ModalOutcome::Consumed;
        };
        let outcome = modal.handle_key(event);
        if outcome == crate::input::traits::ModalOutcome::Consumed {
            self.modal = Some(modal);
        }
        outcome
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
    /// Control commands produced by event handling, awaiting the caller's turn to
    /// send them.
    ///
    /// Queued rather than sent because this module holds no channel: the shell owns
    /// the connection and is the only thing that can write to it.
    pub outbound: Vec<Outbound>,
    /// Actions from the input engine, awaiting the caller's turn to send them.
    ///
    /// Buffered rather than acted on inside `handle_event` so this module holds no
    /// channel: an action that is a control command has to reach the daemon, and
    /// sending is the shell's job.
    pub pending_actions: Vec<crate::input::Action>,
    /// How many PTY chunks arrived out of sequence.
    pub gaps: u64,
    /// Per-pane sequence accounting, so a dropped chunk is detected rather than
    /// silently rendered as if the stream had been continuous.
    pub trackers: crate::vt::parser::PtySequenceTracker,
}

impl Session {
    /// A session for a client that has just attached.
    ///
    /// `ui` already has its snapshot applied -- `daemon::attach` consumed the
    /// snapshot frame before this is called. So the modal is opened HERE as well as
    /// on every later frame: a job that was ALREADY blocked when the client attached
    /// must prompt immediately, and waiting for the next diff would leave the agent
    /// waiting for a decision nobody is being asked for. Acceptance criterion 4 says
    /// "immediately", and that includes "at startup" -- which is the common case for
    /// an operator re-attaching to a session that blocked while they were away.
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

        let mut session = Self {
            ui,
            layout,
            parsers,
            input: InputState::default(),
            sidebar: SidebarScroll::default(),
            modal: None,
            scroll,
            chrome: ChromeRects::default(),
            rects: LayoutRects::default(),
            rows: SidebarRows::default(),
            outbound: Vec::new(),
            pending_actions: Vec::new(),
            gaps: 0,
            trackers: crate::vt::parser::PtySequenceTracker::new(),
        };
        // The snapshot this session was built from has ALREADY been applied, so no
        // frame will arrive to trigger this. A job that blocked before the operator
        // attached would otherwise sit waiting for a decision that is never asked
        // for -- the worst failure an approval workflow has, because it looks like
        // the agent is still thinking.
        session.refresh_modal();
        session
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
        if let Some(palette) = &session.input.command_palette {
            crate::widgets::draw_command_palette(palette, frame.area(), frame.buffer_mut());
        }
        if let Some(keymap) = &session.input.keymap_modal {
            crate::widgets::draw_keymap_modal(keymap, frame.area(), frame.buffer_mut());
        }
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
    let mut actions: Vec<crate::input::Action> = Vec::new();
    let mut commands: Vec<Outbound> = Vec::new();
    match event {
        Event::Key(key) => {
            // `Release` is ignored: with keyboard enhancement enabled, a key that
            // repeats produces press/release pairs, and acting on the release would
            if key.kind == KeyEventKind::Release {
                return session.input.detach_requested();
            }
            if let Some(mut palette) = session.input.command_palette.take() {
                let outcome = palette.handle_key(&key);
                match outcome {
                    crate::input::PaletteOutcome::Consumed => {
                        session.input.command_palette = Some(palette);
                    }
                    crate::input::PaletteOutcome::Execute(cmd) => {
                        actions.extend(cmd.to_actions(&session.ui));
                    }
                    crate::input::PaletteOutcome::Dismissed => {}
                }
                session.pending_actions.extend(actions);
                return session.input.detach_requested();
            }
            if let Some(mut keymap) = session.input.keymap_modal.take() {
                let outcome = keymap.handle_key(&key);
                match outcome {
                    crate::input::KeymapOutcome::Consumed => {
                        session.input.keymap_modal = Some(keymap);
                    }
                    crate::input::KeymapOutcome::SwitchProfile(profile) => {
                        session.ui.presentation.keybinding_profile = profile;
                        actions.push(crate::input::Action::SwitchProfile(profile));
                        session.input.keymap_modal = Some(keymap);
                    }
                    crate::input::KeymapOutcome::Dismissed => {}
                }
                session.pending_actions.extend(actions);
                return session.input.detach_requested();
            }
            let mut modal = ModalHost::new(session.modal.take(), session.chrome.full);
            actions = engine::key(
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
            if let Some(mut palette) = session.input.command_palette.take() {
                let outcome = palette.click_at(
                    crate::widgets::command_palette_rect(session.chrome.full),
                    mouse.column,
                    mouse.row,
                );
                match outcome {
                    crate::input::PaletteOutcome::Consumed => {
                        session.input.command_palette = Some(palette);
                    }
                    crate::input::PaletteOutcome::Execute(cmd) => {
                        actions.extend(cmd.to_actions(&session.ui));
                    }
                    crate::input::PaletteOutcome::Dismissed => {}
                }
                session.pending_actions.extend(actions);
                return session.input.detach_requested();
            }
            if let Some(mut keymap) = session.input.keymap_modal.take() {
                let outcome = keymap.click_at(
                    crate::widgets::keymap_modal_rect(session.chrome.full),
                    mouse.column,
                    mouse.row,
                );
                match outcome {
                    crate::input::KeymapOutcome::Consumed => {
                        session.input.keymap_modal = Some(keymap);
                    }
                    crate::input::KeymapOutcome::SwitchProfile(profile) => {
                        session.ui.presentation.keybinding_profile = profile;
                        actions.push(crate::input::Action::SwitchProfile(profile));
                        session.input.keymap_modal = Some(keymap);
                    }
                    crate::input::KeymapOutcome::Dismissed => {}
                }
                session.pending_actions.extend(actions);
                return session.input.detach_requested();
            }
            let mut modal = ModalHost::new(session.modal.take(), session.chrome.full);
            actions = crate::input::mouse(
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
            actions = crate::input::engine::paste(&session.ui, &mut session.input, now, &text);
        }
        Event::Resize(columns, rows) => {
            // Recomputed from the new size on the next draw; `set_size` decides
            // whether the layout is drawable at all.
            session.ui.set_size(columns, rows);
            // Every pane's PTY is a different size now, and the daemon must be told
            // for each. Without this the agent keeps rendering at the old geometry
            // while the client displays the new one -- which the operator reads as
            // the agent ignoring their resize.
            commands = resize_commands(&session.ui);
        }
        _ => {}
    }

    // Commands queue immediately; actions are buffered for `drain_actions`, which the
    // caller invokes after this returns.
    session.outbound.extend(commands);
    session.pending_actions.extend(actions);
    session.input.detach_requested()
}

/// A `resize_pane` for every open pane, after a terminal resize.
///
/// Skips the whole batch if ANY pane id fails the contract's pattern. The ids came
/// from the daemon, so all of them should satisfy it; one that does not means the two
/// disagree about the wire, and sending a partial batch would leave the workspace in
/// a state neither side intended.
fn resize_commands(ui: &UiState) -> Vec<Outbound> {
    ui.world
        .panes
        .values()
        .filter_map(|pane| {
            Some(Outbound::ResizePane {
                pane_id: aibr_ipc::contracts::ControlCommand4PaneId::try_from(pane.id.as_str())
                    .ok()?,
                columns: pane.columns,
                rows: pane.rows,
            })
        })
        .collect()
}

/// Apply the input engine's actions and collect the commands to send.
///
/// COLLECTED RATHER THAN SENT because the engine is a pure reducer with no channel,
/// and because order matters: a `SetSplitRatio` followed by a `PaneResized` must
/// land in that order, since the second is computed from the first.
///
/// Every non-command variant is local presentation (focus, zoom, split ratio,
/// scroll) or a shell-level request needing information the engine does not have --
/// `spawn_pane` needs a command and a working directory, and neither is something
/// a keystroke or a click can say.
pub fn drain_actions(session: &mut Session) -> Vec<Outbound> {
    let actions = std::mem::take(&mut session.pending_actions);
    let mut commands = Vec::new();
    for action in actions {
        match action {
            crate::input::Action::Command(command) => commands.push(command),
            // The engine deliberately emits a RESIZE as its own variant rather than a
            // command: it knows the pane is a different size but not that the daemon
            // has to hear about it, and it does not know the contract's non-zero
            // geometry type. Translating here is that conversion, and it is the only
            // place pane geometry becomes a wire command.
            //
            // Sent once per mouse-up rather than per motion event, which is the whole
            // point: 60 `resize_pane`s a second would make the agent reflow
            // continuously while a seam is being dragged.
            crate::input::Action::PaneResized {
                pane_id,
                columns,
                rows,
            } => {
                let width = std::num::NonZeroU64::new(u64::from(columns));
                let height = std::num::NonZeroU64::new(u64::from(rows));
                if let (Some(width), Some(height), Ok(id)) = (
                    width,
                    height,
                    aibr_ipc::contracts::ControlCommand4PaneId::try_from(pane_id.as_str()),
                ) {
                    commands.push(Outbound::ResizePane {
                        pane_id: id,
                        columns: width,
                        rows: height,
                    });
                }
            }
            crate::input::Action::SetActiveWorkspace { workspace_id } => {
                if let Ok(id) =
                    aibr_ipc::contracts::ControlCommand1WorkspaceId::try_from(workspace_id.as_str())
                {
                    commands.push(Outbound::SetActiveWorkspace { workspace_id: id });
                }
            }
            crate::input::Action::Detach => {}
            crate::input::Action::FocusApprovalCard => {
                if let Some(job) = session.ui.blocked_job() {
                    if let Some(pane) = session
                        .ui
                        .world
                        .panes
                        .values()
                        .find(|p| p.job_id.as_deref() == Some(&job.id))
                    {
                        session.layout.focused = Some(pane.id.clone());
                    }
                    if session.modal.is_none() {
                        session.modal =
                            Some(crate::widgets::modal::ApprovalModalState::new(job.clone()));
                    }
                }
            }
            crate::input::Action::OpenCommandPalette => {
                session.input.command_palette =
                    Some(crate::input::menu::CommandPaletteState::new());
            }
            crate::input::Action::OpenKeymapModal => {
                session.input.keymap_modal = Some(crate::input::menu::KeymapModalState::new(
                    session.ui.presentation.keybinding_profile,
                ));
            }
            crate::input::Action::SwitchProfile(profile) => {
                session.ui.presentation.keybinding_profile = profile;
            }
            _ => {}
        }
    }
    commands
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

    // PTY output. Decoded HERE rather than in `daemon`, because base64 is
    // transport encoding and the emulator should only ever see PTY bytes.
    if let Some(chunk) = frame.chunk() {
        // An undecodable payload is dropped, not fatal: one bad chunk must not take
        // down a session with running jobs behind it.
        if let Ok(bytes) = base64_decode(chunk.data) {
            session.feed_pane(chunk.pane_id, chunk.sequence, &bytes);
        }
    }

    true
}

/// Decode standard base64.
///
/// Hand-written rather than a dependency: the alphabet is 64 characters and the
/// only operation needed is decode, and a TUI client pulling in a base64 crate for
/// it would be a dependency for thirty lines. Invalid input yields `Err` rather
/// than a partial decode, because a chunk that is half-decoded is worse than one
/// that is dropped -- the emulator would render a stream that never existed.
fn base64_decode(encoded: &str) -> Result<Vec<u8>, String> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let mut accumulator: u32 = 0;
    let mut bits = 0u32;
    let mut padding = 0usize;

    for &byte in bytes {
        if byte == b'=' {
            padding += 1;
            continue;
        }
        if padding > 0 {
            return Err("base64 data after padding".to_owned());
        }
        let Some(value) = ALPHABET.iter().position(|candidate| *candidate == byte) else {
            return Err(format!("invalid base64 character {byte:#x}"));
        };
        accumulator = (accumulator << 6) | u32::try_from(value).map_err(|_| "overflow")?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((accumulator >> bits) & 0xFF).map_err(|_| "overflow")?);
        }
    }
    Ok(out)
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
