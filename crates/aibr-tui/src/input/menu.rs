//! The right-click context menu.
//!
//! A model, not a widget: this decides what items exist, which one the cursor is on,
//! and what activating one means. `widgets` draws it and supplies the mouse events.
//! The split is the same one the rest of the crate makes -- anything that can be
//! decided without a screen buffer is decided here and tested here.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::Rect;

use crate::layout::HitTarget;
use crate::state::KeybindingProfile;

/// One menu entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuItem {
    /// Split the clicked pane left/right.
    SplitVertical,
    /// Split the clicked pane top/bottom.
    SplitHorizontal,
    /// Close the clicked pane.
    ClosePane,
    /// Open the clicked ingress queue item.
    ViewOutboxItem,
    /// Copy the clicked pane's raw log to the clipboard.
    CopyRawLogs,
}

impl MenuItem {
    /// The label the render pass draws.
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::SplitVertical => "Split Vertical",
            Self::SplitHorizontal => "Split Horizontal",
            Self::ClosePane => "Close Pane",
            Self::ViewOutboxItem => "View Outbox Item",
            Self::CopyRawLogs => "Copy Raw Logs",
        }
    }

    /// Whether the item needs a pane id to act on.
    #[must_use]
    pub fn needs_pane(self) -> bool {
        matches!(
            self,
            Self::SplitVertical | Self::SplitHorizontal | Self::ClosePane | Self::CopyRawLogs
        )
    }

    /// Whether the item needs a queue item id to act on.
    #[must_use]
    pub fn needs_queue_item(self) -> bool {
        matches!(self, Self::ViewOutboxItem)
    }
}

/// An open context menu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextMenu {
    /// Where it was opened, in terminal coordinates.
    ///
    /// ABSOLUTE, because the click that opened it was absolute and the menu has to be
    /// drawn at the operator's cursor, not at an offset from something else.
    pub at: (u16, u16),
    /// The pane under the click, when there was one.
    pub pane_id: Option<String>,
    /// The queue item under the click, when there was one.
    pub queue_item_id: Option<String>,
    /// The items, in draw order.
    pub items: Vec<MenuItem>,
    /// The highlighted item.
    pub selected: usize,
}

impl ContextMenu {
    /// Open a menu at a hit target.
    ///
    /// The item list is DERIVED from what was clicked rather than being a fixed five.
    /// A fixed list would offer `Close Pane` on a queue row and `View Outbox Item` on
    /// a pane, both of which would be no-ops at best. An empty list -- clicking the
    /// top bar -- produces no menu at all.
    #[must_use]
    pub fn open(at: (u16, u16), target: &HitTarget) -> Option<Self> {
        let mut menu = Self {
            at,
            pane_id: None,
            queue_item_id: None,
            items: Vec::new(),
            selected: 0,
        };
        match target {
            HitTarget::Pane { pane_id } => {
                menu.pane_id = Some(pane_id.clone());
                menu.items = vec![
                    MenuItem::SplitVertical,
                    MenuItem::SplitHorizontal,
                    MenuItem::ClosePane,
                    MenuItem::ViewOutboxItem,
                    MenuItem::CopyRawLogs,
                ];
            }
            HitTarget::SidebarQueueItem { job_id } => {
                menu.queue_item_id = Some(job_id.clone());
                menu.items = vec![MenuItem::ViewOutboxItem];
            }
            // Chrome has nothing to act on. `None` means "do not open a menu", and the
            // caller must not open an empty one: a menu with no items is a rectangle the
            // operator has to click away from.
            HitTarget::TopBar
            | HitTarget::StatusBar
            | HitTarget::HeaderChipSearch
            | HitTarget::HeaderChipKeymap
            | HitTarget::HeaderChipInspector
            | HitTarget::WorkspaceTab { .. }
            | HitTarget::WorkspaceTabClose { .. }
            | HitTarget::WorkspaceTabNew
            | HitTarget::SidebarWorkspace { .. }
            | HitTarget::SidebarJob { .. }
            | HitTarget::Sidebar
            | HitTarget::Border { .. }
            | HitTarget::Canvas
            | HitTarget::None => return None,
        }
        Some(menu)
    }

    /// Move the highlight, wrapping.
    #[must_use]
    pub fn with_highlight(mut self, index: usize) -> Self {
        if !self.items.is_empty() {
            self.selected = index % self.items.len();
        }
        self
    }

    /// The highlighted item.
    #[must_use]
    pub fn selected_item(&self) -> Option<MenuItem> {
        self.items.get(self.selected).copied()
    }

    /// Where the menu was opened.
    #[must_use]
    pub fn at(&self) -> (u16, u16) {
        self.at
    }

    /// The items, in draw order.
    #[must_use]
    pub fn items(&self) -> &[MenuItem] {
        &self.items
    }

    /// Whether an activation is possible, and with what ids.
    ///
    /// A single function rather than a switch in the reducer, so the "which items are
    /// actionable" decision lives next to the "which items exist" decision and the
    /// two cannot drift.
    #[must_use]
    pub fn activation(&self) -> Option<Activation> {
        let item = self.selected_item()?;
        let pane_id = self.pane_id.clone();
        let queue_item_id = self.queue_item_id.clone();
        if item.needs_pane() && pane_id.is_none() {
            return None;
        }
        if item.needs_queue_item() && queue_item_id.is_none() {
            return None;
        }
        Some(Activation {
            item,
            pane_id,
            queue_item_id,
        })
    }

    /// How many rows the menu occupies, so the render pass can position it without
    /// duplicating the item count.
    ///
    /// THE SAME NUMBER THE HIT TEST USES. [`crate::input::mouse`] decides whether a
    /// click landed on the menu with `height()` and `width()`, and the widget draws with
    /// them, so "the row that is highlighted" and "the row I clicked" cannot be different
    /// rows unless one of them stops using these.
    #[must_use]
    pub fn height(&self) -> u16 {
        // One row per item plus a border top and bottom.
        self.items.len() as u16 + 2
    }

    /// How many columns the menu occupies.
    ///
    /// The widest label plus a border on each side. Computed rather than fixed, because a
    /// fixed width either clips `View Outbox Item` or wastes columns on a menu opened on a
    /// pane; the hit test and the render pass both use this value, so they cannot
    /// disagree about where the menu's right edge is.
    #[must_use]
    pub fn width(&self) -> u16 {
        let widest = self
            .items
            .iter()
            .map(|item| item.label().chars().count())
            .max()
            .unwrap_or(0);
        (widest as u16).saturating_add(2)
    }
}

/// What activating a menu item resolves to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Activation {
    /// The chosen item.
    pub item: MenuItem,
    /// The pane it applies to, for pane-scoped items.
    pub pane_id: Option<String>,
    /// The queue item it applies to, for queue-scoped items.
    pub queue_item_id: Option<String>,
}

/// One command available in the command palette.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaletteCommand {
    /// Approve pending plan.
    ApprovePlan,
    /// Reject pending plan.
    RejectPlan,
    /// Split pane vertically.
    SplitVertical,
    /// Split pane horizontally.
    SplitHorizontal,
    /// Toggle pane zoom.
    ToggleZoom,
    /// Toggle inspector/sidebar visibility.
    ToggleInspector,
    /// Switch active keybinding profile to Modern Ergonomic.
    SwitchModernErgonomic,
    /// Switch active keybinding profile to Tmux Classic.
    SwitchTmuxClassic,
    /// Switch active keybinding profile to Vim-Centric.
    SwitchVimCentric,
    /// Safely detach from session without terminating jobs.
    SafeDetach,
}

impl PaletteCommand {
    /// All available commands in default display order.
    pub const ALL: [Self; 10] = [
        Self::ApprovePlan,
        Self::RejectPlan,
        Self::SplitVertical,
        Self::SplitHorizontal,
        Self::ToggleZoom,
        Self::ToggleInspector,
        Self::SwitchModernErgonomic,
        Self::SwitchTmuxClassic,
        Self::SwitchVimCentric,
        Self::SafeDetach,
    ];

    /// Human-readable label with shortcut hint.
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::ApprovePlan => "Approve Plan (y)",
            Self::RejectPlan => "Reject Plan (d)",
            Self::SplitVertical => "Split Vertical (Alt+V)",
            Self::SplitHorizontal => "Split Horizontal (Alt+S)",
            Self::ToggleZoom => "Toggle Zoom (Alt+Z)",
            Self::ToggleInspector => "Toggle Inspector (Alt+B)",
            Self::SwitchModernErgonomic => "Switch to Modern Ergonomic Profile",
            Self::SwitchTmuxClassic => "Switch to Tmux Classic Profile",
            Self::SwitchVimCentric => "Switch to Vim-Centric Profile",
            Self::SafeDetach => "Safe Detach (Alt+Q)",
        }
    }

    /// Action title without shortcut.
    #[must_use]
    pub fn title(self) -> &'static str {
        match self {
            Self::ApprovePlan => "Approve Plan",
            Self::RejectPlan => "Reject Plan",
            Self::SplitVertical => "Split Vertical",
            Self::SplitHorizontal => "Split Horizontal",
            Self::ToggleZoom => "Toggle Zoom",
            Self::ToggleInspector => "Toggle Inspector",
            Self::SwitchModernErgonomic => "Switch to Modern Ergonomic Profile",
            Self::SwitchTmuxClassic => "Switch to Tmux Classic Profile",
            Self::SwitchVimCentric => "Switch to Vim-Centric Profile",
            Self::SafeDetach => "Safe Detach",
        }
    }

    /// Keyboard shortcut string if available.
    #[must_use]
    pub fn shortcut(self) -> Option<&'static str> {
        match self {
            Self::ApprovePlan => Some("y"),
            Self::RejectPlan => Some("d"),
            Self::SplitVertical => Some("Alt+V"),
            Self::SplitHorizontal => Some("Alt+S"),
            Self::ToggleZoom => Some("Alt+Z"),
            Self::ToggleInspector => Some("Alt+B"),
            Self::SwitchModernErgonomic => None,
            Self::SwitchTmuxClassic => None,
            Self::SwitchVimCentric => None,
            Self::SafeDetach => Some("Alt+Q"),
        }
    }

    /// Convert this command into an application action given current UI state.
    #[must_use]
    pub fn to_actions(self, ui: &crate::state::UiState) -> Vec<crate::input::Action> {
        match self {
            Self::ApprovePlan => {
                let blocked_job = ui
                    .world
                    .jobs
                    .values()
                    .find(|j| j.state == aibr_ipc::contracts::JobState::Blocked);
                if let Some(job) = blocked_job {
                    if let Ok(cmd) = crate::input::commands::approve_plan(
                        &job.id,
                        crate::input::ApproveScope::Apply,
                    ) {
                        return vec![crate::input::Action::Command(cmd)];
                    }
                }
                vec![crate::input::Action::FocusApprovalCard]
            }
            Self::RejectPlan => {
                let blocked_job = ui
                    .world
                    .jobs
                    .values()
                    .find(|j| j.state == aibr_ipc::contracts::JobState::Blocked);
                if let Some(job) = blocked_job {
                    if let Ok(cmd) = crate::input::commands::reject_plan(&job.id, None) {
                        return vec![crate::input::Action::Command(cmd)];
                    }
                }
                Vec::new()
            }
            Self::SplitVertical => {
                let workspace_id = ui
                    .presentation
                    .active_workspace
                    .clone()
                    .or_else(|| ui.world.workspaces.keys().next().cloned());
                let parent_pane_id = ui
                    .presentation
                    .focused
                    .clone()
                    .or_else(|| ui.world.panes.keys().next().cloned());
                if let (Some(workspace_id), Some(parent_pane_id)) = (workspace_id, parent_pane_id) {
                    vec![crate::input::Action::SpawnPaneRequested {
                        workspace_id,
                        parent_pane_id,
                        axis: crate::layout::Axis::Vertical,
                        kind: crate::state::PaneKind::Terminal,
                    }]
                } else {
                    Vec::new()
                }
            }
            Self::SplitHorizontal => {
                let workspace_id = ui
                    .presentation
                    .active_workspace
                    .clone()
                    .or_else(|| ui.world.workspaces.keys().next().cloned());
                let parent_pane_id = ui
                    .presentation
                    .focused
                    .clone()
                    .or_else(|| ui.world.panes.keys().next().cloned());
                if let (Some(workspace_id), Some(parent_pane_id)) = (workspace_id, parent_pane_id) {
                    vec![crate::input::Action::SpawnPaneRequested {
                        workspace_id,
                        parent_pane_id,
                        axis: crate::layout::Axis::Horizontal,
                        kind: crate::state::PaneKind::Terminal,
                    }]
                } else {
                    Vec::new()
                }
            }
            Self::ToggleZoom => {
                if ui.presentation.zoomed.is_some() {
                    vec![crate::input::Action::ZoomPane { pane_id: None }]
                } else {
                    vec![crate::input::Action::ZoomPane {
                        pane_id: ui.presentation.focused.clone(),
                    }]
                }
            }
            Self::ToggleInspector => {
                vec![crate::input::Action::SidebarVisible(
                    !ui.presentation.sidebar_visible,
                )]
            }
            Self::SwitchModernErgonomic => {
                vec![crate::input::Action::SwitchProfile(
                    KeybindingProfile::ModernErgonomic,
                )]
            }
            Self::SwitchTmuxClassic => {
                vec![crate::input::Action::SwitchProfile(
                    KeybindingProfile::TmuxClassic,
                )]
            }
            Self::SwitchVimCentric => {
                vec![crate::input::Action::SwitchProfile(
                    KeybindingProfile::VimCentric,
                )]
            }
            Self::SafeDetach => {
                vec![crate::input::Action::Detach]
            }
        }
    }
}

/// Outcome of a command palette interaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaletteOutcome {
    /// Keystroke or click consumed internally.
    Consumed,
    /// Execute the selected command.
    Execute(PaletteCommand),
    /// Palette dismissed.
    Dismissed,
}

/// Match a query pattern against text. Returns match score, where higher means better match.
#[must_use]
pub fn fuzzy_match(pattern: &str, text: &str) -> Option<i32> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Some(0);
    }
    let p_lower: Vec<char> = pattern.to_lowercase().chars().collect();
    let t_lower: Vec<char> = text.to_lowercase().chars().collect();

    let text_lower_str = text.to_lowercase();
    let pat_lower_str = pattern.to_lowercase();
    if let Some(pos) = text_lower_str.find(&pat_lower_str) {
        let score = 200 - (pos as i32) * 2;
        return Some(score);
    }

    let mut p_idx = 0;
    let mut score = 0;
    let mut prev_matched_idx = None;

    for (t_idx, &tc) in t_lower.iter().enumerate() {
        if p_idx < p_lower.len() && tc == p_lower[p_idx] {
            if let Some(prev) = prev_matched_idx {
                if prev + 1 == t_idx {
                    score += 15;
                }
            }
            score += 10;
            prev_matched_idx = Some(t_idx);
            p_idx += 1;
        }
    }

    if p_idx == p_lower.len() {
        Some(score)
    } else {
        None
    }
}

/// State of the universal command palette.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CommandPaletteState {
    /// Search query string.
    pub query: String,
    /// Highlighted item index in filtered results.
    pub selected: usize,
}

impl CommandPaletteState {
    /// Create a new command palette with empty search query.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Get filtered commands based on live query fuzzy search.
    #[must_use]
    pub fn filtered_items(&self) -> Vec<PaletteCommand> {
        let query = self.query.trim();
        if query.is_empty() {
            return PaletteCommand::ALL.to_vec();
        }

        let mut scored: Vec<(PaletteCommand, i32)> = PaletteCommand::ALL
            .iter()
            .copied()
            .filter_map(|cmd| fuzzy_match(query, cmd.label()).map(|score| (cmd, score)))
            .collect();

        // Higher score first
        scored.sort_by_key(|(_, score)| std::cmp::Reverse(*score));
        scored.into_iter().map(|(cmd, _)| cmd).collect()
    }

    /// The currently selected command, if any items match.
    #[must_use]
    pub fn selected_command(&self) -> Option<PaletteCommand> {
        let items = self.filtered_items();
        if items.is_empty() {
            None
        } else {
            Some(items[self.selected.min(items.len().saturating_sub(1))])
        }
    }

    /// Move selection to previous item, wrapping.
    pub fn select_prev(&mut self) {
        let count = self.filtered_items().len();
        if count > 0 {
            if self.selected == 0 {
                self.selected = count - 1;
            } else {
                self.selected -= 1;
            }
        }
    }

    /// Move selection to next item, wrapping.
    pub fn select_next(&mut self) {
        let count = self.filtered_items().len();
        if count > 0 {
            self.selected = (self.selected + 1) % count;
        }
    }

    /// Append a character to search query.
    pub fn push_char(&mut self, c: char) {
        self.query.push(c);
        self.selected = 0;
    }

    /// Remove the last character from search query.
    pub fn backspace(&mut self) {
        self.query.pop();
        self.selected = 0;
    }

    /// Clear the search query.
    pub fn clear_query(&mut self) {
        self.query.clear();
        self.selected = 0;
    }

    /// Process a crossterm key event.
    pub fn handle_key(&mut self, event: &KeyEvent) -> PaletteOutcome {
        match event.code {
            KeyCode::Esc => PaletteOutcome::Dismissed,
            KeyCode::Enter => {
                if let Some(cmd) = self.selected_command() {
                    PaletteOutcome::Execute(cmd)
                } else {
                    PaletteOutcome::Dismissed
                }
            }
            KeyCode::Up => {
                self.select_prev();
                PaletteOutcome::Consumed
            }
            KeyCode::Down => {
                self.select_next();
                PaletteOutcome::Consumed
            }
            KeyCode::Backspace => {
                self.backspace();
                PaletteOutcome::Consumed
            }
            KeyCode::Char('k') if event.modifiers.contains(KeyModifiers::CONTROL) => {
                PaletteOutcome::Dismissed
            }
            KeyCode::Char(c)
                if !event.modifiers.contains(KeyModifiers::CONTROL)
                    && !event.modifiers.contains(KeyModifiers::ALT) =>
            {
                self.push_char(c);
                PaletteOutcome::Consumed
            }
            _ => PaletteOutcome::Consumed,
        }
    }

    /// Process an abstract KeyEventLike event.
    pub fn handle_key_like(
        &mut self,
        event: &crate::input::traits::KeyEventLike,
    ) -> PaletteOutcome {
        if let Some(named) = event.named {
            match named {
                crate::input::traits::NamedKey::Esc => return PaletteOutcome::Dismissed,
                crate::input::traits::NamedKey::Enter => {
                    return if let Some(cmd) = self.selected_command() {
                        PaletteOutcome::Execute(cmd)
                    } else {
                        PaletteOutcome::Dismissed
                    };
                }
                crate::input::traits::NamedKey::Up => {
                    self.select_prev();
                    return PaletteOutcome::Consumed;
                }
                crate::input::traits::NamedKey::Down => {
                    self.select_next();
                    return PaletteOutcome::Consumed;
                }
                crate::input::traits::NamedKey::Backspace => {
                    self.backspace();
                    return PaletteOutcome::Consumed;
                }
                _ => {}
            }
        }
        if let Some(c) = event.char {
            if !event.ctrl && !event.alt {
                self.push_char(c);
                return PaletteOutcome::Consumed;
            }
        }
        PaletteOutcome::Consumed
    }

    /// Mouse click hit-test against the command palette area.
    pub fn click_at(&mut self, modal_rect: Rect, col: u16, row: u16) -> PaletteOutcome {
        if col < modal_rect.x
            || col >= modal_rect.x.saturating_add(modal_rect.width)
            || row < modal_rect.y
            || row >= modal_rect.y.saturating_add(modal_rect.height)
        {
            return PaletteOutcome::Dismissed;
        }
        let items_start_y = modal_rect.y.saturating_add(3);
        let items = self.filtered_items();
        if row >= items_start_y && (row - items_start_y) < items.len() as u16 {
            let index = (row - items_start_y) as usize;
            self.selected = index;
            if let Some(cmd) = self.selected_command() {
                return PaletteOutcome::Execute(cmd);
            }
        }
        PaletteOutcome::Consumed
    }
}

/// One entry in the keybinding cheatsheet table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeybindingRow {
    /// Action description.
    pub action: &'static str,
    /// Modern Ergonomic shortcut.
    pub modern: &'static str,
    /// Tmux Classic shortcut.
    pub tmux: &'static str,
    /// Vim-Centric shortcut.
    pub vim: &'static str,
}

/// Cheatsheet table rows comparing shortcuts across the three keybinding profiles.
pub const KEYBINDING_ROWS: &[KeybindingRow] = &[
    KeybindingRow {
        action: "Focus Navigation",
        modern: "Alt+H/J/K/L or Alt+Arrows",
        tmux: "Ctrl+B + Arrows / h/j/k/l",
        vim: "Ctrl+W + h/j/k/l",
    },
    KeybindingRow {
        action: "Split Vertical",
        modern: "Alt+V",
        tmux: "Ctrl+B % or v",
        vim: "Ctrl+W v",
    },
    KeybindingRow {
        action: "Split Horizontal",
        modern: "Alt+S",
        tmux: "Ctrl+B \" or -",
        vim: "Ctrl+W s",
    },
    KeybindingRow {
        action: "Toggle Zoom",
        modern: "Alt+Z",
        tmux: "Ctrl+B z",
        vim: "Ctrl+W o",
    },
    KeybindingRow {
        action: "Close Pane",
        modern: "Alt+W",
        tmux: "Ctrl+B x",
        vim: "Ctrl+W c",
    },
    KeybindingRow {
        action: "Workspace / Tabs",
        modern: "Alt+1..9, Alt+T",
        tmux: "Ctrl+B 1..9, Ctrl+B c",
        vim: "gt, gT, Alt+1..9",
    },
    KeybindingRow {
        action: "Toggle Inspector",
        modern: "Alt+B",
        tmux: "Ctrl+B b",
        vim: "Alt+B",
    },
    KeybindingRow {
        action: "Command Palette",
        modern: "Ctrl+K",
        tmux: "Ctrl+K / Ctrl+B :",
        vim: "Ctrl+K / :",
    },
    KeybindingRow {
        action: "Copy / Scrollback",
        modern: "Alt+[ or PageUp",
        tmux: "Ctrl+B [",
        vim: "Ctrl+W [",
    },
    KeybindingRow {
        action: "Safe Detach",
        modern: "Alt+Q",
        tmux: "Ctrl+B d or q",
        vim: "ZZ or Alt+Q",
    },
];

/// Outcome of a keymap modal interaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeymapOutcome {
    /// Event consumed internally.
    Consumed,
    /// Active profile changed.
    SwitchProfile(KeybindingProfile),
    /// Modal dismissed.
    Dismissed,
}

/// State of the keymap modal and cheatsheet comparison.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeymapModalState {
    /// Currently active keybinding profile.
    pub active_profile: KeybindingProfile,
    /// Selected cheatsheet table row index.
    pub selected_row: usize,
    /// Cheatsheet table scroll offset.
    pub scroll_offset: usize,
}

impl Default for KeymapModalState {
    fn default() -> Self {
        Self {
            active_profile: KeybindingProfile::ModernErgonomic,
            selected_row: 0,
            scroll_offset: 0,
        }
    }
}

impl KeymapModalState {
    /// Create a keymap modal state with the specified active profile.
    #[must_use]
    pub fn new(active_profile: KeybindingProfile) -> Self {
        Self {
            active_profile,
            selected_row: 0,
            scroll_offset: 0,
        }
    }

    /// Set active profile.
    pub fn set_profile(&mut self, profile: KeybindingProfile) {
        self.active_profile = profile;
    }

    /// Cycle to the next profile.
    pub fn cycle_profile_next(&mut self) -> KeybindingProfile {
        self.active_profile = match self.active_profile {
            KeybindingProfile::ModernErgonomic => KeybindingProfile::TmuxClassic,
            KeybindingProfile::TmuxClassic => KeybindingProfile::VimCentric,
            KeybindingProfile::VimCentric => KeybindingProfile::ModernErgonomic,
        };
        self.active_profile
    }

    /// Cycle to the previous profile.
    pub fn cycle_profile_prev(&mut self) -> KeybindingProfile {
        self.active_profile = match self.active_profile {
            KeybindingProfile::ModernErgonomic => KeybindingProfile::VimCentric,
            KeybindingProfile::TmuxClassic => KeybindingProfile::ModernErgonomic,
            KeybindingProfile::VimCentric => KeybindingProfile::TmuxClassic,
        };
        self.active_profile
    }

    /// Scroll cheatsheet table up.
    pub fn scroll_up(&mut self) {
        if self.selected_row > 0 {
            self.selected_row -= 1;
        }
        if self.selected_row < self.scroll_offset {
            self.scroll_offset = self.selected_row;
        }
    }

    /// Scroll cheatsheet table down.
    pub fn scroll_down(&mut self, max_rows: usize) {
        if self.selected_row + 1 < KEYBINDING_ROWS.len() {
            self.selected_row += 1;
        }
        if max_rows > 0 && self.selected_row >= self.scroll_offset + max_rows {
            self.scroll_offset = self.selected_row + 1 - max_rows;
        }
    }

    /// Process a crossterm key event.
    pub fn handle_key(&mut self, event: &KeyEvent) -> KeymapOutcome {
        match event.code {
            KeyCode::Esc => KeymapOutcome::Dismissed,
            KeyCode::Char('1') => {
                self.set_profile(KeybindingProfile::ModernErgonomic);
                KeymapOutcome::SwitchProfile(KeybindingProfile::ModernErgonomic)
            }
            KeyCode::Char('2') => {
                self.set_profile(KeybindingProfile::TmuxClassic);
                KeymapOutcome::SwitchProfile(KeybindingProfile::TmuxClassic)
            }
            KeyCode::Char('3') => {
                self.set_profile(KeybindingProfile::VimCentric);
                KeymapOutcome::SwitchProfile(KeybindingProfile::VimCentric)
            }
            KeyCode::Tab | KeyCode::Right => {
                let p = self.cycle_profile_next();
                KeymapOutcome::SwitchProfile(p)
            }
            KeyCode::BackTab | KeyCode::Left => {
                let p = self.cycle_profile_prev();
                KeymapOutcome::SwitchProfile(p)
            }
            KeyCode::Up => {
                self.scroll_up();
                KeymapOutcome::Consumed
            }
            KeyCode::Down => {
                self.scroll_down(8);
                KeymapOutcome::Consumed
            }
            _ => KeymapOutcome::Consumed,
        }
    }

    /// Process an abstract KeyEventLike event.
    pub fn handle_key_like(&mut self, event: &crate::input::traits::KeyEventLike) -> KeymapOutcome {
        if let Some(named) = event.named {
            match named {
                crate::input::traits::NamedKey::Esc => return KeymapOutcome::Dismissed,
                crate::input::traits::NamedKey::Tab | crate::input::traits::NamedKey::Right => {
                    let p = self.cycle_profile_next();
                    return KeymapOutcome::SwitchProfile(p);
                }
                crate::input::traits::NamedKey::BackTab | crate::input::traits::NamedKey::Left => {
                    let p = self.cycle_profile_prev();
                    return KeymapOutcome::SwitchProfile(p);
                }
                crate::input::traits::NamedKey::Up => {
                    self.scroll_up();
                    return KeymapOutcome::Consumed;
                }
                crate::input::traits::NamedKey::Down => {
                    self.scroll_down(8);
                    return KeymapOutcome::Consumed;
                }
                _ => {}
            }
        }
        if let Some(c) = event.char {
            match c {
                '1' => {
                    self.set_profile(KeybindingProfile::ModernErgonomic);
                    return KeymapOutcome::SwitchProfile(KeybindingProfile::ModernErgonomic);
                }
                '2' => {
                    self.set_profile(KeybindingProfile::TmuxClassic);
                    return KeymapOutcome::SwitchProfile(KeybindingProfile::TmuxClassic);
                }
                '3' => {
                    self.set_profile(KeybindingProfile::VimCentric);
                    return KeymapOutcome::SwitchProfile(KeybindingProfile::VimCentric);
                }
                _ => {}
            }
        }
        KeymapOutcome::Consumed
    }

    /// Mouse click hit-test against the keymap modal area.
    pub fn click_at(&mut self, modal_rect: Rect, col: u16, row: u16) -> KeymapOutcome {
        if col < modal_rect.x
            || col >= modal_rect.x.saturating_add(modal_rect.width)
            || row < modal_rect.y
            || row >= modal_rect.y.saturating_add(modal_rect.height)
        {
            return KeymapOutcome::Dismissed;
        }
        // Profile buttons row: modal_rect.y + 1
        if row == modal_rect.y.saturating_add(1) {
            let b1_start = modal_rect.x.saturating_add(2);
            let b1_end = b1_start.saturating_add(23);
            let b2_start = b1_end.saturating_add(2);
            let b2_end = b2_start.saturating_add(19);
            let b3_start = b2_end.saturating_add(2);
            let b3_end = b3_start.saturating_add(18);

            if col >= b1_start && col < b1_end {
                self.set_profile(KeybindingProfile::ModernErgonomic);
                return KeymapOutcome::SwitchProfile(KeybindingProfile::ModernErgonomic);
            }
            if col >= b2_start && col < b2_end {
                self.set_profile(KeybindingProfile::TmuxClassic);
                return KeymapOutcome::SwitchProfile(KeybindingProfile::TmuxClassic);
            }
            if col >= b3_start && col < b3_end {
                self.set_profile(KeybindingProfile::VimCentric);
                return KeymapOutcome::SwitchProfile(KeybindingProfile::VimCentric);
            }
        }
        KeymapOutcome::Consumed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_command_palette_fuzzy_filtering() {
        let mut state = CommandPaletteState::new();
        assert_eq!(state.filtered_items().len(), 10);

        state.query = "vert".to_string();
        let filtered = state.filtered_items();
        assert!(!filtered.is_empty());
        assert_eq!(filtered[0], PaletteCommand::SplitVertical);

        state.query = "tmux".to_string();
        let filtered = state.filtered_items();
        assert_eq!(filtered[0], PaletteCommand::SwitchTmuxClassic);

        state.query = "alt+q".to_string();
        let filtered = state.filtered_items();
        assert_eq!(filtered[0], PaletteCommand::SafeDetach);
    }

    #[test]
    fn test_command_palette_navigation() {
        let mut state = CommandPaletteState::new();
        assert_eq!(state.selected, 0);
        state.select_next();
        assert_eq!(state.selected, 1);
        state.select_prev();
        assert_eq!(state.selected, 0);
        state.select_prev();
        assert_eq!(state.selected, 9);
    }

    #[test]
    fn test_keymap_modal_profile_switching() {
        let mut state = KeymapModalState::new(KeybindingProfile::ModernErgonomic);
        assert_eq!(state.active_profile, KeybindingProfile::ModernErgonomic);

        let ev = KeyEvent::new(KeyCode::Char('2'), KeyModifiers::empty());
        let outcome = state.handle_key(&ev);
        assert_eq!(
            outcome,
            KeymapOutcome::SwitchProfile(KeybindingProfile::TmuxClassic)
        );
        assert_eq!(state.active_profile, KeybindingProfile::TmuxClassic);

        let ev = KeyEvent::new(KeyCode::Char('3'), KeyModifiers::empty());
        let outcome = state.handle_key(&ev);
        assert_eq!(
            outcome,
            KeymapOutcome::SwitchProfile(KeybindingProfile::VimCentric)
        );
        assert_eq!(state.active_profile, KeybindingProfile::VimCentric);
    }
}
