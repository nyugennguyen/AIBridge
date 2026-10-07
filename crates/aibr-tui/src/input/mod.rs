//! Mouse routing and keyboard modes: the whole input subsystem.
//!
//! # THE TWO REDUCERS
//!
//! * [`key`] -- one key event to [`Action`]s.
//! * [`mouse`] -- one mouse event to [`Action`]s, given the geometry the render pass
//!   used.
//!
//! Both are pure. They read no clock, perform no I/O, and call nothing outside this crate.
//! Every effect they want -- a PTY write, a clipboard write, a browser launch, a command
//! frame -- is RETURNED as an [`Action`] for the shell to perform. That is what makes this
//! subsystem testable without a terminal, a socket or a clipboard, and it is also what
//! makes acceptance criterion 5 checkable: a border drag is a sequence of pure state
//! transitions plus a ratio, so a test can assert the exact ratio after a press at
//! `(40, 10)` and a release at `(23, 10)` and know the seam lands on a character boundary.
//!
//! The one impure edge is [`capture`], which writes escape sequences to the terminal, and
//! it is a separate module so that importing the engine does not import the terminal.
//!
//! # WHY THE MODE LIVES ON `Presentation` AND NOT HERE
//!
//! [`InputMode`](crate::state::InputMode) is read by the status bar on every frame. If the
//! engine kept its own copy, the status bar would be rendering a field that the reducer
//! updates somewhere else, and the one thing the status bar exists to say -- what the next
//! keystroke means -- would be the first thing allowed to lie. So the reducers take
//! `&mut UiState` and write `Presentation::mode` in place.
//!
//! [`InputState`] holds what `Presentation` cannot: a prefix deadline, an open menu, a
//! selection, a pointer drag, copy mode, and a toast.
//!
//! # WHAT LIVES IN `layout` AND WHY NONE OF IT IS HERE
//!
//! [`crate::layout::LayoutRects`], [`crate::layout::HitTest`], [`crate::layout::HitTarget`]
//! and [`crate::layout::Axis`] belong to the layout workstream and are CONSUMED, not
//! redeclared. The plan's own instruction is that hit-testing must consume the rectangles
//! the render pass used and never recompute geometry, and a second `HitTarget` enum here
//! would make that instruction impossible to keep. What this crate owns is the part
//! layout does not: what a click MEANS.
//!
//! The two facts that live in both places -- which pane has focus, and which pane is
//! zoomed -- are written by adjacent statements in [`engine`], which is therefore the only
//! writer of either. [`tree::PaneLayout`] is the seam for the layout object, and it is
//! implemented for [`crate::layout::TileLayout`] in this crate.
//!
//! # MODULE MAP
//!
//! * [`action`] -- what a reducer decided, as values.
//! * [`commands`] -- engine values into validated `ControlCommand`s.
//! * [`keys`] -- crossterm key events to PTY bytes.
//! * [`redact`] -- secret redaction on the way out.
//! * [`sanitize`] -- URL validation for `Ctrl+Click`.
//! * [`selection`] -- the anchor/cursor model and text extraction.
//! * [`copy_mode`] -- vi-style scrollback navigation and search.
//! * [`menu`] -- the right-click context menu model.
//! * [`tree`] -- the seam to `layout::TileLayout`, and the seam-drag arithmetic.
//! * [`traits`] -- the seams for the workstreams that have not landed.
//! * [`engine`] -- the keyboard state machine.
//! * [`mouse`] -- hit-test routing.
//! * [`system`] -- the clipboard and URL-handler implementations.
//! * [`capture`] -- terminal mouse reporting.

#![deny(missing_docs)]

pub mod action;
pub mod capture;
pub mod commands;
pub mod copy_mode;
pub mod engine;
pub mod keys;
pub mod menu;
pub mod mouse;
pub mod redact;
pub mod sanitize;
pub mod selection;
pub mod system;
pub mod traits;
pub mod tree;

pub use action::{Action, Toast, ToastKind};
pub use commands::InvalidCommand;
pub use engine::{key, Chord, ChordPolicy, InputState, PrefixKey, PREFIX_TIMEOUT, TOAST_DURATION};
pub use menu::{
    CommandPaletteState, ContextMenu, KeybindingRow, KeymapModalState, KeymapOutcome, MenuItem,
    PaletteCommand, PaletteOutcome, KEYBINDING_ROWS,
};
pub use mouse::{mouse, WHEEL_LINES};
pub use redact::{redact_to_text, ConservativeRedactor, RedactedText};
pub use sanitize::{sanitize_url, SanitizedUrl, UrlRejection};
pub use selection::{CellCoords, Selection};
pub use system::{
    NullClipboard, RecordingClipboard, RecordingUrlOpener, SystemClipboard, SystemUrlOpener,
};
pub use traits::{
    ApprovalModal, ApproveScope, Clipboard, ClipboardError, FocusTarget, KeyEventLike,
    ModalOutcome, NamedKey, NoScrollback, NoSidebar, Redactor, ScrollbackPane, SidebarList,
    UrlOpenError, UrlOpener,
};
pub use tree::{ratio_for_drag, DragGeometry, PaneLayout};

/// Re-exported so a shell can pass the layout's own geometry to [`mouse`] without also
/// naming `layout` at every call site.
pub use crate::layout::hit::SidebarRows;
pub use crate::layout::{Axis, ChromeRects, HitTarget, HitTest, LayoutRects};

/// The mode this subsystem sets, re-exported because the status bar and the engine's
/// callers both need it and neither should have to reach past `input` for it.
pub use crate::state::InputMode;
