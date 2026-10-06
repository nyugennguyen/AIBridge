//! The right-click context menu.
//!
//! A model, not a widget: this decides what items exist, which one the cursor is on,
//! and what activating one means. `widgets` draws it and supplies the mouse events.
//! The split is the same one the rest of the crate makes -- anything that can be
//! decided without a screen buffer is decided here and tested here.

use crate::layout::HitTarget;

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
