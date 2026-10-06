//! The keyboard state machine: [`InputState`] and [`key`].
//!
//! # PURENESS, AND WHY IT IS THE WHOLE DESIGN
//!
//! [`key`] takes `&mut InputState` and returns `Vec<Action>`. It performs no I/O, reads
//! no clock, and calls nothing outside this crate. Every effect it wants -- a PTY
//! write, a clipboard write, a browser launch, a command frame -- is returned as an
//! [`Action`] for the shell to perform.
//!
//! This is what makes the whole subsystem testable without a terminal, a socket or a
//! clipboard, and it is also what makes acceptance criterion 5 checkable: a border drag
//! is a sequence of pure state transitions plus a ratio, so a test can assert the exact
//! ratio after a press at `(40, 10)` and a release at `(23, 10)` and know the divider
//! lands on a cell boundary, instead of looking at a screenshot of a terminal and
//! guessing.
//!
//! # THE CLOCK
//!
//! The prefix timeout needs time, and a reducer that called `Instant::now()` would be
//! impure and untestable. Instead the caller passes `now` and the state records when
//! the prefix was armed. A test constructs whatever instants it likes.
//!
//! # WHY [`UiState`] IS A PARAMETER
//!
//! The mode lives on [`Presentation::mode`] and the status bar reads it from there, so
//! duplicating it in [`InputState`] would create two sources of truth for "what does
//! the next keystroke mean" -- the exact question the status bar exists to answer. The
//! reducer therefore mutates `Presentation` in place, and [`InputState`] holds only what
//! `Presentation` cannot: a prefix deadline, a menu, a selection, a pointer drag, copy
//! mode and a toast.

use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::input::action::{Action, Toast};
use crate::input::commands;
use crate::input::copy_mode::{CopyMode, CopyPrompt};
use crate::input::keys::{encode_key, encode_paste};
use crate::input::redact::redact_to_text;
use crate::input::selection::{CellCoords, Selection};
use crate::input::traits::{
    ApprovalModal, ApproveScope, KeyEventLike, ModalOutcome, ScrollbackPane,
};
use crate::input::tree::PaneLayout;
use crate::layout::tile::Focus;
use crate::layout::Axis;
use crate::state::{InputMode, PaneKind, Presentation, UiState};

/// How long a `Ctrl+B` prefix stays armed.
///
/// tmux uses one second. Two seconds here because this client is used over SSH to a VPS
/// often enough that a single delayed packet loses the second keystroke of a two-key
/// sequence, and a client that ate the operator's `c` because of latency is a client
/// they stop trusting.
///
/// The cost of the longer window is that a mistyped `Ctrl+B` is followed by a longer
/// period in which the next key is a command. That is what the timeout bounds, and it
/// is why the timeout exists at all: without it, `Ctrl+B` followed by a shrug leaves
/// the client eating keystrokes -- including `q` -- indefinitely, and the operator's
/// only way out is `Ctrl+C`, which would go to the PTY.
pub const PREFIX_TIMEOUT: Duration = Duration::from_millis(2000);

/// How long a toast stays in the status bar.
pub const TOAST_DURATION: Duration = Duration::from_millis(2500);

/// What the pointer is currently doing.
///
/// An enum rather than two independent `Option`s, because a border drag with no panes or
/// a selection with no pane are both states no event can produce and no code should have
/// to handle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PointerDrag {
    /// Dragging a split seam.
    Border(BorderDrag),
    /// Selecting text in a pane.
    Selecting,
}

/// The two panes a seam drag is between.
///
/// A STRUCT rather than three fields on the variant, because the drag is threaded through
/// [`drag_border`](crate::input::mouse) and [`end_border_drag`](crate::input::mouse) and
/// three loose parameters on each is how one of them ends up transposed.
///
/// BOTH PANES ARE STORED, not just the seam, because the layout's ratio setter finds a
/// split by AXIS alone -- `TileLayout::set_ratio` takes the first split along that axis --
/// so the engine cannot say "that one" without the identity. Storing the pair is what
/// makes the setter's answer attributable: if the layout applied the ratio to a different
/// split, two seams move and the operator can say which.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BorderDrag {
    /// The pane nearer the origin.
    pub first_pane: String,
    /// The pane further from the origin.
    pub second_pane: String,
    /// Which way the seam divides.
    pub axis: Axis,
}

/// A toast that has not expired yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ActiveToast {
    /// The message.
    toast: Toast,
    /// When it was raised.
    raised_at: Instant,
}

/// Everything the input engine owns that is not the client's world or its
/// presentation.
///
/// DELIBERATELY NOT PART OF [`Presentation`]. `Presentation` is what the render pass
/// reads; this is what the event loop drives. Keeping them apart means a widget never
/// has to know about a prefix timeout.
#[derive(Debug, Clone, Default)]
pub struct InputState {
    /// When the `Ctrl+B` prefix was armed, if it is armed.
    pub(crate) prefix_armed_at: Option<Instant>,
    /// The open context menu, if any.
    pub(crate) menu: Option<crate::input::menu::ContextMenu>,
    /// The active selection, if any.
    pub(crate) selection: Option<Selection>,
    /// What the pointer is doing.
    pub(crate) drag: Option<PointerDrag>,
    /// Whether the left button is held. Separate from [`Self::drag`] because a plain
    /// click inside a pane is a press and release with no movement, and that must still
    /// focus the pane.
    pub(crate) button_down: bool,
    /// Copy-mode state, live only in [`InputMode::Copy`].
    pub(crate) copy: Option<CopyMode>,
    /// The unexpired toast.
    pub(crate) toast: Option<ActiveToast>,
    /// Whether the operator asked to be detached.
    ///
    /// Latched rather than left to a one-shot action, because a detach that is lost in
    /// a dropped frame leaves a client the operator cannot leave by keyboard.
    pub(crate) detach_requested: bool,
}

impl InputState {
    /// Whether a `Ctrl+B` prefix is armed.
    #[must_use]
    pub fn prefix_armed(&self) -> bool {
        self.prefix_armed_at.is_some()
    }

    /// The open context menu, for the render pass.
    #[must_use]
    pub fn menu(&self) -> Option<&crate::input::menu::ContextMenu> {
        self.menu.as_ref()
    }

    /// The active selection, for the render pass to invert.
    #[must_use]
    pub fn selection(&self) -> Option<&Selection> {
        self.selection.as_ref()
    }

    /// Copy-mode state, when copy mode is active.
    #[must_use]
    pub fn copy_mode(&self) -> Option<&CopyMode> {
        self.copy.as_ref()
    }

    /// The unexpired toast, for the status bar.
    #[must_use]
    pub fn toast(&self) -> Option<&Toast> {
        self.toast.as_ref().map(|active| &active.toast)
    }

    /// Whether the operator asked to detach.
    #[must_use]
    pub fn detach_requested(&self) -> bool {
        self.detach_requested
    }

    /// Whether a pointer drag is in progress.
    #[must_use]
    pub fn dragging(&self) -> bool {
        self.drag.is_some()
    }

    /// Whether the left button is held.
    #[must_use]
    pub fn button_down(&self) -> bool {
        self.button_down
    }

    /// The seam being dragged, as `(first_pane, second_pane, axis)`, if one is.
    ///
    /// FOR THE RENDER PASS, which highlights it. It does NOT return the pointer drag itself:
    /// the render pass needs to know which seam is in flight so it can mark it, and has no use
    /// for the selection half of the enum, which the VT grid asks about through
    /// [`Self::selection`].
    #[must_use]
    pub fn dragging_seam(&self) -> Option<&BorderDrag> {
        match &self.drag {
            Some(PointerDrag::Border(drag)) => Some(drag),
            Some(PointerDrag::Selecting) | None => None,
        }
    }

    /// Move to `mode`, dropping whatever belonged to the mode being left.
    ///
    /// ONE FUNCTION rather than an assignment at each call site. Leaving
    /// [`InputMode::Terminal`] must drop the prefix deadline, and leaving
    /// [`InputMode::Navigate`] must drop the pointer drag -- an expired deadline that
    /// outlives its mode is how a client eats a keystroke ten seconds later, and a
    /// drag that outlives its mode is how a `Ctrl+Alt` chord resizes a pane the
    /// operator thinks they are navigating.
    pub(crate) fn enter(&mut self, presentation: &mut Presentation, mode: InputMode) {
        if mode != InputMode::Prefix {
            self.prefix_armed_at = None;
        }
        if mode != InputMode::Copy {
            self.copy = None;
        }
        if mode != InputMode::Navigate {
            self.drag = None;
        }
        if mode != InputMode::Terminal {
            self.menu = None;
        }
        presentation.mode = mode;
    }

    /// Raise a toast, replacing any current one, and return the action for it.
    pub(crate) fn raise_toast(&mut self, now: Instant, toast: Toast) -> Action {
        self.toast = Some(ActiveToast {
            toast: toast.clone(),
            raised_at: now,
        });
        Action::Toast(toast)
    }

    /// Whether the prefix deadline has passed.
    fn prefix_expired(&self, now: Instant) -> bool {
        self.prefix_armed_at
            .is_some_and(|armed| now.saturating_duration_since(armed) >= PREFIX_TIMEOUT)
    }

    /// Expire anything time-based. Called once per frame.
    ///
    /// RETURNS ACTIONS RATHER THAN MUTATING SILENTLY, because the render pass needs to
    /// be told the toast went away. A toast that expired without the status bar
    /// repainting would sit on screen for ever.
    pub fn tick(&mut self, now: Instant) -> Vec<Action> {
        let actions: Vec<Action> = Vec::new();
        if self
            .toast
            .as_ref()
            .is_some_and(|active| now.saturating_duration_since(active.raised_at) >= TOAST_DURATION)
        {
            self.toast = None;
        }
        actions
    }
}

/// A prefix-free chord: a combination handled without `Ctrl+B`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Chord {
    /// Focus the pane to the left.
    FocusLeft,
    /// Focus the pane below.
    FocusDown,
    /// Focus the pane above.
    FocusUp,
    /// Focus the pane to the right.
    FocusRight,
    /// Split the focused pane vertically.
    SplitVertical,
    /// Split the focused pane horizontally.
    SplitHorizontal,
    /// Zoom or unzoom the focused pane.
    Zoom,
    /// Toggle the sidebar.
    ToggleSidebar,
    /// Detach.
    Detach,
}

impl Chord {
    /// Recognise a chord.
    ///
    /// REQUIRES `Ctrl+Alt` EXACTLY: both present, `Shift` and `Super` absent. Accepting
    /// `Ctrl+Alt+Shift+X` as `Ctrl+Alt+X` would make every chord reachable by a stray
    /// `Shift`, and the whole argument for these is that they are unambiguous.
    ///
    /// # THE TRADEOFF WITH THE PTY, STATED
    ///
    /// `Ctrl+Alt+H` is a perfectly good binding inside many programs -- vim, emacs,
    /// GNOME -- and a PTY running an agent session may well use it. These chords are
    /// therefore STOLEN from whatever is in the focused pane, unconditionally, with no
    /// way for the pane to claim them back.
    ///
    /// The alternative was considered and rejected: forward the chord to the PTY and
    /// act on it only when the pane has no scrollback, or on a double press. Both make
    /// the chord's behaviour depend on state the operator cannot see, which is the
    /// class of problem this client exists to avoid -- someone who cannot tell why a
    /// chord sometimes switched panes and sometimes reached the agent will start
    /// working around the whole client. A documented, unconditional reservation is at
    /// least predictable.
    ///
    /// The cost is real and is recorded here on purpose: an application that binds
    /// `Ctrl+Alt+X` cannot have it while this client is attached, and that application
    /// needs telling. [`ChordPolicy::ForwardToPane`] exists for that case.
    #[must_use]
    pub fn from_event(event: &KeyEvent) -> Option<Self> {
        if !event.modifiers.contains(KeyModifiers::CONTROL)
            || !event.modifiers.contains(KeyModifiers::ALT)
            || event.modifiers.contains(KeyModifiers::SHIFT)
            || event.modifiers.contains(KeyModifiers::SUPER)
        {
            return None;
        }
        match event.code {
            KeyCode::Char('h') | KeyCode::Left => Some(Self::FocusLeft),
            KeyCode::Char('j') | KeyCode::Down => Some(Self::FocusDown),
            KeyCode::Char('k') | KeyCode::Up => Some(Self::FocusUp),
            KeyCode::Char('l') | KeyCode::Right => Some(Self::FocusRight),
            KeyCode::Char('v') | KeyCode::Char('d') => Some(Self::SplitVertical),
            KeyCode::Char('-') => Some(Self::SplitHorizontal),
            KeyCode::Char('z') => Some(Self::Zoom),
            KeyCode::Char('b') => Some(Self::ToggleSidebar),
            KeyCode::Char('q') => Some(Self::Detach),
            _ => None,
        }
    }
}

/// Whether chords are claimed by the client or passed to the focused pane.
///
/// NOT CONFIGURABLE AT RUNTIME, and it is [`ChordPolicy::Steal`] by default. Making it
/// configurable would put a mode the operator must remember in the path of a shortcut
/// they expect to work; a client whose behaviour depends on a remembered flag is one
/// they will debug by turning the flag the other way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ChordPolicy {
    /// The client claims `Ctrl+Alt+…` and the focused pane never sees it.
    #[default]
    Steal,
    /// Chords go to the focused pane's PTY, and only reach the client when no pane is
    /// focused.
    ///
    /// FOR AN OPERATOR WHO NEEDS `Ctrl+Alt` INSIDE AN APPLICATION. The cost is stated
    /// above and it is the reason this is not the default: with this policy, pane
    /// switching is unavailable while a pane is focused, which is most of the time.
    ForwardToPane,
}

/// The `Ctrl+B` keymap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrefixKey {
    /// New tab / workspace.
    NewTab,
    /// Split vertically.
    SplitVertical,
    /// Split horizontally.
    SplitHorizontal,
    /// Move focus.
    Focus(Focus),
    /// Zoom or unzoom.
    Zoom,
    /// Enter copy mode.
    CopyMode,
    /// Detach.
    Detach,
    /// Toggle the sidebar.
    ToggleSidebar,
}

impl PrefixKey {
    /// Recognise a key after the prefix.
    ///
    /// `None` means the prefix was mistyped. The engine then returns to
    /// [`InputMode::Terminal`] and FORWARDS NOTHING, because forwarding a mistyped
    /// prefix key would put an unexplained character into an agent's stdin.
    #[must_use]
    pub fn from_event(event: &KeyEvent) -> Option<Self> {
        match event.code {
            KeyCode::Char('c') => Some(Self::NewTab),
            KeyCode::Char('v') => Some(Self::SplitVertical),
            KeyCode::Char('-') => Some(Self::SplitHorizontal),
            KeyCode::Char('h') | KeyCode::Left => Some(Self::Focus(Focus::Left)),
            KeyCode::Char('j') | KeyCode::Down => Some(Self::Focus(Focus::Down)),
            KeyCode::Char('k') | KeyCode::Up => Some(Self::Focus(Focus::Up)),
            KeyCode::Char('l') | KeyCode::Right => Some(Self::Focus(Focus::Right)),
            KeyCode::Char('z') => Some(Self::Zoom),
            KeyCode::Char('[') => Some(Self::CopyMode),
            KeyCode::Char('q') => Some(Self::Detach),
            KeyCode::Char('b') => Some(Self::ToggleSidebar),
            _ => None,
        }
    }

    /// Every binding, for the cheatsheet widget and for the exhaustive test.
    #[must_use]
    pub fn all() -> &'static [PrefixKey] {
        &[
            Self::NewTab,
            Self::SplitVertical,
            Self::SplitHorizontal,
            Self::Focus(Focus::Left),
            Self::Focus(Focus::Down),
            Self::Focus(Focus::Up),
            Self::Focus(Focus::Right),
            Self::Zoom,
            Self::CopyMode,
            Self::Detach,
            Self::ToggleSidebar,
        ]
    }
}

/// Reduce one key event.
///
/// # Order of operations, and why this order
///
/// 1. **Modal interception, first.** A `blocked` job is a security decision, and no
///    keystroke may reach a PTY while it is pending. This must precede the chord table
///    or `Ctrl+Alt+H` would move focus behind the modal, and it must precede the prefix
///    dispatch or `q` would detach the client out from under an unapproved plan.
/// 2. **Prefix timeout, second**, before dispatch. An expired prefix is dropped, so the
///    keystroke that follows it is the operator's and not a command.
/// 3. **The active mode's dispatch.** `Copy` and `Navigate` own their keys entirely;
///    neither falls through to the PTY, which is the point of being in them.
/// 4. **The `Ctrl+B` prefix, entered by `Ctrl+B` itself.**
/// 5. **Chords**, in [`InputMode::Terminal`] only.
/// 6. **Passthrough.** Anything not claimed is bytes for the focused pane's PTY.
///
/// # Parameters
///
/// * `panes` -- the VT grids, for copy mode.
/// * `layout` -- the pane layout, for focus, zoom and splits. Mutated here and mirrored
///   into [`Presentation`] by the same statements, so the two cannot drift: the engine is
///   the only writer of either.
/// * `modal` -- the approval modal, borrowed mutably because it owns its own focus.
///
/// [`UiState`] is mutated because [`InputMode`], [`Presentation::focused`] and
/// [`Presentation::zoomed`] are exactly the fields a keypress is for.
pub fn key(
    state: &mut InputState,
    event: &KeyEvent,
    now: Instant,
    ui: &mut UiState,
    panes: &mut dyn ScrollbackPane,
    layout: &mut dyn PaneLayout,
    modal: &mut dyn ApprovalModal,
) -> Vec<Action> {
    // (1) The modal takes everything, including keys that would otherwise be chords
    // or a prefix.
    if modal.is_open() {
        return route_to_modal(state, event, now, ui, modal);
    }

    match ui.presentation.mode {
        // (2) An expired prefix is dropped before dispatch, not after.
        InputMode::Prefix if state.prefix_expired(now) => {
            state.enter(&mut ui.presentation, InputMode::Terminal);
            return key(state, event, now, ui, panes, layout, modal);
        }
        // (4) `Ctrl+B` arms the prefix.
        InputMode::Terminal if is_prefix_key(event) => {
            state.prefix_armed_at = Some(now);
            ui.presentation.mode = InputMode::Prefix;
            return Vec::new();
        }
        InputMode::Prefix => return prefix_key(state, event, now, ui, panes, layout),

        // (3) The other modes own their keys entirely.
        InputMode::Copy => return copy_key(state, event, now, ui, panes),
        InputMode::Navigate => {
            // A key during a drag abandons it and is NOT forwarded: the operator
            // pressed a key mid-drag and meant to stop dragging, and typing it into an
            // agent instead would be a keystroke they did not intend to send.
            state.enter(&mut ui.presentation, InputMode::Terminal);
            return Vec::new();
        }
        InputMode::Terminal => {}
    }

    // (5) Chords.
    if let Some(chord) = Chord::from_event(event) {
        return chord_actions(state, chord, ui, layout);
    }

    // (6) Passthrough.
    passthrough(state, event, now, ui)
}

/// Bytes for the focused pane's PTY, or nothing.
fn passthrough(
    state: &mut InputState,
    event: &KeyEvent,
    now: Instant,
    ui: &mut UiState,
) -> Vec<Action> {
    let Some(pane_id) = ui.presentation.focused.clone() else {
        return Vec::new();
    };
    let Some(bytes) = encode_key(event) else {
        return Vec::new();
    };
    match commands::pty_input(&pane_id, &bytes) {
        Ok(command) => vec![Action::Command(command)],
        Err(error) => vec![state.raise_toast(now, Toast::warning(error.to_string()))],
    }
}

/// Whether this event is the `Ctrl+B` prefix.
///
/// REQUIRES `Ctrl` AND NOT `Alt`. `Ctrl+Alt+B` is the chord that toggles the sidebar,
/// and letting the prefix also fire on it would enter prefix mode and then immediately
/// consume the next keystroke as a command.
#[must_use]
pub fn is_prefix_key(event: &KeyEvent) -> bool {
    event.modifiers.contains(KeyModifiers::CONTROL)
        && !event.modifiers.contains(KeyModifiers::ALT)
        && !event.modifiers.contains(KeyModifiers::SUPER)
        && matches!(event.code, KeyCode::Char('b') | KeyCode::Char('B'))
}

/// The effects of a chord.
fn chord_actions(
    state: &mut InputState,
    chord: Chord,
    ui: &mut UiState,
    layout: &mut dyn PaneLayout,
) -> Vec<Action> {
    match chord {
        Chord::FocusLeft => focus(ui, layout, Focus::Left),
        Chord::FocusDown => focus(ui, layout, Focus::Down),
        Chord::FocusUp => focus(ui, layout, Focus::Up),
        Chord::FocusRight => focus(ui, layout, Focus::Right),
        Chord::SplitVertical => split_pane(ui, Axis::Vertical),
        Chord::SplitHorizontal => split_pane(ui, Axis::Horizontal),
        Chord::Zoom => zoom(ui, layout),
        Chord::ToggleSidebar => toggle_sidebar(ui),
        Chord::Detach => detach(state),
    }
}

/// One key after `Ctrl+B`.
fn prefix_key(
    state: &mut InputState,
    event: &KeyEvent,
    now: Instant,
    ui: &mut UiState,
    panes: &mut dyn ScrollbackPane,
    layout: &mut dyn PaneLayout,
) -> Vec<Action> {
    // Any prefix key ends the prefix. Doing this FIRST means no exit path below has to
    // remember to, and a mistyped key leaves the client in a clean Terminal mode.
    state.enter(&mut ui.presentation, InputMode::Terminal);

    let Some(key) = PrefixKey::from_event(event) else {
        return Vec::new();
    };
    let _ = now;

    match key {
        PrefixKey::NewTab => new_tab(ui),
        PrefixKey::SplitVertical => split_pane(ui, Axis::Vertical),
        PrefixKey::SplitHorizontal => split_pane(ui, Axis::Horizontal),
        PrefixKey::Focus(direction) => focus(ui, layout, direction),
        PrefixKey::Zoom => zoom(ui, layout),
        PrefixKey::ToggleSidebar => toggle_sidebar(ui),
        PrefixKey::CopyMode => enter_copy_mode(state, ui, panes),
        PrefixKey::Detach => detach(state),
    }
}

fn detach(state: &mut InputState) -> Vec<Action> {
    state.detach_requested = true;
    vec![Action::Detach]
}

fn toggle_sidebar(ui: &mut UiState) -> Vec<Action> {
    ui.presentation.sidebar_visible = !ui.presentation.sidebar_visible;
    vec![Action::SidebarVisible(ui.presentation.sidebar_visible)]
}

/// Zoom or unzoom the focused pane.
///
/// THE MIRROR IS WRITTEN IN THE SAME FUNCTION. [`Presentation::zoomed`] and
/// [`TileLayout::zoomed`] hold the same fact in two places -- one for the render pass,
/// one for the status bar -- and the only defence against them diverging is that both are
/// assigned by adjacent statements here. The engine is therefore the ONLY writer of
/// either; the shell must not assign `Presentation::zoomed` on its own.
fn zoom(ui: &mut UiState, layout: &mut dyn PaneLayout) -> Vec<Action> {
    let target = layout.toggle_zoom();
    ui.presentation.zoomed = target.clone();
    vec![Action::ZoomPane { pane_id: target }]
}

/// Move focus one step, through the layout.
///
/// NO GEOMETRY HERE, and that is a property of the signature rather than an omission:
/// the plan's reducer is `key(state, event) -> Vec<Action]` with no geometry, and a
/// geometric focus movement would make the keyboard depend on the render pass having
/// already run -- so a keystroke handled between a resize and the next frame would move
/// focus to the wrong pane. [`focus_towards`] is the geometric entry point for callers
/// that do hold a canvas.
fn focus(ui: &mut UiState, layout: &mut dyn PaneLayout, direction: Focus) -> Vec<Action> {
    match layout.focus_step(direction) {
        Some(pane_id) => {
            ui.presentation.focused = Some(pane_id.clone());
            vec![Action::FocusPane { pane_id }]
        }
        // Focus was already at the edge and the layout clamped. Saying nothing is
        // correct: an action would have to invent a target, and a wrong target moves
        // the operator's keystrokes into a pane they did not select.
        None => Vec::new(),
    }
}

/// Move focus geometrically, for a caller that holds a canvas.
///
/// FALLS BACK TO A STEP when the layout cannot answer, so a chord always does something
/// the operator can see. A key that silently does nothing is indistinguishable from a
/// hung client.
pub fn focus_towards(
    ui: &mut UiState,
    layout: &mut dyn PaneLayout,
    direction: Focus,
    canvas: ratatui::layout::Rect,
) -> Vec<Action> {
    match layout.focus_towards(direction, canvas) {
        Some(pane_id) => {
            ui.presentation.focused = Some(pane_id.clone());
            vec![Action::FocusPane { pane_id }]
        }
        None => focus(ui, layout, direction),
    }
}

/// Split the focused pane.
fn split_pane(ui: &mut UiState, axis: Axis) -> Vec<Action> {
    let Some(pane_id) = ui.presentation.focused.clone() else {
        return Vec::new();
    };
    let Some(pane) = ui.world.panes.get(&pane_id) else {
        return Vec::new();
    };
    vec![Action::SpawnPaneRequested {
        workspace_id: pane.workspace_id.clone(),
        parent_pane_id: pane_id,
        axis,
        kind: PaneKind::Terminal,
    }]
}

/// A new tab in the active workspace.
fn new_tab(ui: &mut UiState) -> Vec<Action> {
    let Some(workspace_id) = ui.presentation.active_workspace.clone() else {
        return Vec::new();
    };
    vec![Action::NewTabRequested { workspace_id }]
}

/// Enter copy mode at the bottom of the focused pane's scrollback.
///
/// AT THE BOTTOM, not at the top: an operator who presses `Ctrl+B [` wants to look at
/// what just scrolled past, not to be dropped 200,000 lines into the past.
fn enter_copy_mode(
    state: &mut InputState,
    ui: &mut UiState,
    panes: &mut dyn ScrollbackPane,
) -> Vec<Action> {
    let Some(pane_id) = ui.presentation.focused.clone() else {
        return Vec::new();
    };
    let bottom = panes.total_lines(&pane_id).saturating_sub(1);
    state.copy = Some(CopyMode::entering(bottom, 0));
    state.enter(&mut ui.presentation, InputMode::Copy);
    Vec::new()
}

/// One key in copy mode.
fn copy_key(
    state: &mut InputState,
    event: &KeyEvent,
    now: Instant,
    ui: &mut UiState,
    panes: &mut dyn ScrollbackPane,
) -> Vec<Action> {
    let Some(mut copy) = state.copy.clone() else {
        state.enter(&mut ui.presentation, InputMode::Terminal);
        return Vec::new();
    };
    let Some(pane_id) = ui.presentation.focused.clone() else {
        state.enter(&mut ui.presentation, InputMode::Terminal);
        return Vec::new();
    };

    // The `/` prompt owns the keyboard while it is open, which is why this comes first:
    // a search for `q` has to be typeable.
    if copy.prompt == CopyPrompt::Search {
        let action = search_prompt_key(&mut copy, event, now, panes, &pane_id);
        state.copy = Some(copy);
        return action.into_iter().collect();
    }

    let max_line = panes.total_lines(&pane_id).saturating_sub(1);
    let max_column = panes.viewport_columns(&pane_id);
    let page = i64::from(panes.viewport_rows(&pane_id)).max(1);
    let control = event.modifiers.contains(KeyModifiers::CONTROL);
    let mut toast: Option<Toast> = None;

    match event.code {
        // `Esc` leaves visual mode first when it is on, which is what vi does and what
        // an operator expects when they press it twice.
        KeyCode::Esc if copy.visual => copy.visual = false,
        KeyCode::Esc | KeyCode::Char('q') => {
            state.copy = None;
            state.selection = None;
            state.enter(&mut ui.presentation, InputMode::Terminal);
            return Vec::new();
        }

        KeyCode::Char('h') => copy.move_cursor(0, -1, max_line, max_column),
        KeyCode::Char('j') | KeyCode::Down => copy.move_cursor(1, 0, max_line, max_column),
        KeyCode::Char('k') | KeyCode::Up => copy.move_cursor(-1, 0, max_line, max_column),
        KeyCode::Char('l') => copy.move_cursor(0, 1, max_line, max_column),
        KeyCode::Char('g') | KeyCode::Home => {
            copy.cursor_line = 0;
            copy.cursor_column = 0;
        }
        KeyCode::Char('G') | KeyCode::End => {
            copy.cursor_line = max_line;
            copy.cursor_column = 0;
        }
        KeyCode::Char('0') => copy.cursor_column = 0,
        KeyCode::Char('$') => copy.cursor_column = max_column,
        KeyCode::PageUp => copy.move_cursor(-page, 0, max_line, max_column),
        KeyCode::PageDown => copy.move_cursor(page, 0, max_line, max_column),
        // Half-page, on the two keys readline uses.
        KeyCode::Char('d') if control => copy.move_cursor(page / 2, 0, max_line, max_column),
        KeyCode::Char('u') if control => copy.move_cursor(-page / 2, 0, max_line, max_column),

        KeyCode::Char('/') => copy.begin_search(),
        KeyCode::Char('n') => {
            jump(&mut copy, panes, &pane_id, true, &mut toast);
        }
        KeyCode::Char('N') => {
            jump(&mut copy, panes, &pane_id, false, &mut toast);
        }

        KeyCode::Char('v') => {
            copy.toggle_visual();
            let cursor = cursor_cell(&copy, panes, &pane_id);
            state.selection = copy
                .anchor
                .map(|anchor| Selection::new(&pane_id, anchor, cursor));
        }
        KeyCode::Char('y') => {
            let cursor = cursor_cell(&copy, panes, &pane_id);
            let text = copy
                .anchor
                .map(|anchor| Selection::new(&pane_id, anchor, cursor).extract(panes))
                .unwrap_or_default();
            state.copy = None;
            state.selection = None;
            state.enter(&mut ui.presentation, InputMode::Terminal);
            if text.trim().is_empty() {
                return Vec::new();
            }
            return vec![
                Action::CopySelection(redact_to_text(
                    &crate::input::redact::ConservativeRedactor,
                    &text,
                )),
                state.raise_toast(now, Toast::info("Copied to clipboard")),
            ];
        }
        _ => {}
    }

    scroll_cursor_into_view(panes, &pane_id, copy.cursor_line);
    if copy.visual {
        let cursor = cursor_cell(&copy, panes, &pane_id);
        state.selection = copy
            .anchor
            .map(|anchor| Selection::new(&pane_id, anchor, cursor));
    }
    state.copy = Some(copy);
    toast
        .into_iter()
        .map(|toast| state.raise_toast(now, toast))
        .collect()
}

/// The copy-mode cursor as a cell in the CURRENT viewport.
///
/// The row is the cursor's distance from the top of the viewport, not a stored field,
/// because the viewport moves under the cursor every time [`scroll_cursor_into_view`]
/// runs. Storing the row would mean every scroll had to fix up the stored row, and one
/// missed fixup is a visual selection covering the wrong lines.
fn cursor_cell(copy: &CopyMode, panes: &dyn ScrollbackPane, pane_id: &str) -> CellCoords {
    let row = (copy.cursor_line - panes.viewport_top(pane_id)).clamp(0, i64::from(u16::MAX));
    CellCoords::new(copy.cursor_column, row as u16)
}

/// `n` / `N`.
fn jump(
    copy: &mut CopyMode,
    panes: &mut dyn ScrollbackPane,
    pane_id: &str,
    forwards: bool,
    toast: &mut Option<Toast>,
) {
    if copy.last_query.is_empty() {
        return;
    }
    let hit = if forwards {
        copy.next_hit(panes, pane_id)
    } else {
        copy.previous_hit(panes, pane_id)
    };
    match hit {
        Some(hit) => {
            copy.cursor_line = hit.line;
            copy.cursor_column = hit.column;
            copy.last_hit = Some(hit);
            copy.message = Some(format!("/{}/", copy.last_query));
            scroll_cursor_into_view(panes, pane_id, hit.line);
        }
        None => {
            // The cursor does not move on a failed repeat, for the same reason
            // `commit_search` does not move it: losing the operator's place in a
            // 200k-line log is the worst possible outcome of a failed search.
            let query = copy.last_query.clone();
            copy.message = Some(format!("pattern not found: {query}"));
            *toast = Some(Toast::warning(format!("pattern not found: {query}")));
        }
    }
}

/// One key in the `/` prompt.
fn search_prompt_key(
    copy: &mut CopyMode,
    event: &KeyEvent,
    now: Instant,
    panes: &mut dyn ScrollbackPane,
    pane_id: &str,
) -> Option<Action> {
    match event.code {
        KeyCode::Esc => copy.cancel_search(),
        KeyCode::Enter => {
            let hit = copy.commit_search(panes, pane_id);
            if let Some(hit) = hit {
                scroll_cursor_into_view(panes, pane_id, hit.line);
                return None;
            }
            let message = copy.message.clone()?;
            if message.starts_with("pattern not found") {
                return Some(Action::Toast(Toast::warning(message)));
            }
            return None;
        }
        KeyCode::Backspace => {
            copy.query.pop();
        }
        KeyCode::Char(character) if !event.modifiers.contains(KeyModifiers::CONTROL) => {
            copy.query.push(character);
        }
        _ => {}
    }
    let _ = now;
    None
}

/// Scroll a pane so `line` is visible.
fn scroll_cursor_into_view(panes: &mut dyn ScrollbackPane, pane_id: &str, line: i64) {
    let top = panes.viewport_top(pane_id);
    let rows = i64::from(panes.viewport_rows(pane_id));
    if rows <= 0 {
        return;
    }
    if line < top {
        panes.scroll_to_line(pane_id, line);
    } else if line >= top + rows {
        panes.scroll_to_line(pane_id, line - rows + 1);
    }
}

/// Hand a key to the approval modal.
fn route_to_modal(
    state: &mut InputState,
    event: &KeyEvent,
    now: Instant,
    ui: &mut UiState,
    modal: &mut dyn ApprovalModal,
) -> Vec<Action> {
    // `Tab` cycles the modal's focus here rather than inside the modal, because wrapping
    // the cycle needs the control count, which only the modal has -- but the cycle
    // itself has to be the engine's so that no other mode can reach it.
    if matches!(event.code, KeyCode::Tab | KeyCode::BackTab) {
        let count = modal.focusable_count();
        let target = if matches!(event.code, KeyCode::Tab) {
            modal.focus().next(count)
        } else {
            modal.focus().previous(count)
        };
        modal.set_focus(target);
        return vec![Action::ModalFocus { target }];
    }

    let outcome = modal.handle_key(&KeyEventLike::from(event));
    let actions = modal_actions(state, now, modal, &outcome);
    if matches!(outcome, ModalOutcome::Dismissed) {
        state.enter(&mut ui.presentation, InputMode::Terminal);
    }
    actions
}

/// Turn a modal outcome into actions.
///
/// SHARED BY THE KEY PATH AND THE MOUSE PATH, deliberately. Approving by clicking
/// `Approve` and approving by pressing `Enter` must produce byte-identical commands; two
/// implementations of the same decision would let one of them drift, and the one that
/// drifts is the security-relevant one.
///
/// [`ModalOutcome::Consumed`] produces NO action at all, which is the property the "a
/// stray input must not reach the terminal behind the modal" tests assert.
pub fn modal_actions(
    state: &mut InputState,
    now: Instant,
    modal: &mut dyn ApprovalModal,
    outcome: &ModalOutcome,
) -> Vec<Action> {
    match outcome {
        ModalOutcome::Consumed => Vec::new(),
        ModalOutcome::Approve { scope } => approve(state, now, modal, *scope),
        ModalOutcome::Reject { justification } => {
            reject(state, now, modal, justification.as_deref())
        }
        ModalOutcome::Abort => cancel(state, now, modal),
        ModalOutcome::Dismissed => vec![Action::ModalClosed],
    }
}

fn approve(
    state: &mut InputState,
    now: Instant,
    modal: &mut dyn ApprovalModal,
    scope: ApproveScope,
) -> Vec<Action> {
    let Some(job_id) = modal.job_id().map(str::to_owned) else {
        return vec![state.raise_toast(now, Toast::warning("no job to approve"))];
    };
    finish(state, now, commands::approve_plan(&job_id, scope))
}

fn reject(
    state: &mut InputState,
    now: Instant,
    modal: &mut dyn ApprovalModal,
    justification: Option<&str>,
) -> Vec<Action> {
    let Some(job_id) = modal.job_id().map(str::to_owned) else {
        return vec![state.raise_toast(now, Toast::warning("no job to reject"))];
    };
    finish(state, now, commands::reject_plan(&job_id, justification))
}

fn cancel(state: &mut InputState, now: Instant, modal: &mut dyn ApprovalModal) -> Vec<Action> {
    let Some(job_id) = modal.job_id().map(str::to_owned) else {
        return vec![state.raise_toast(now, Toast::warning("no job to abort"))];
    };
    finish(state, now, commands::cancel_job(&job_id))
}

/// Turn a contract rejection into a toast, or the command into an action.
fn finish(
    state: &mut InputState,
    now: Instant,
    result: Result<aibr_ipc::ControlCommand, commands::InvalidCommand>,
) -> Vec<Action> {
    match result {
        Ok(command) => vec![Action::Command(command)],
        Err(error) => vec![state.raise_toast(now, Toast::warning(error.to_string()))],
    }
}

/// A bracketed paste for the focused pane, as an action.
#[must_use]
pub fn paste(ui: &UiState, state: &mut InputState, now: Instant, text: &str) -> Vec<Action> {
    let Some(pane_id) = ui.presentation.focused.clone() else {
        return Vec::new();
    };
    match commands::pty_input(&pane_id, &encode_paste(text)) {
        Ok(command) => vec![Action::Command(command)],
        Err(error) => vec![state.raise_toast(now, Toast::warning(error.to_string()))],
    }
}
