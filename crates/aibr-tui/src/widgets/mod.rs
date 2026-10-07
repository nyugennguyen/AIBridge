//! The widgets that draw a pane and the chrome around it.
//!
//! # Rendering is a pure function of `(state, layout)`
//!
//! Every widget here takes its inputs and writes cells. Nothing in this module
//! reads the clock, queries the terminal, or mutates client state. That is what
//! lets the whole render path be tested with Ratatui's `TestBackend` and asserted
//! on cells rather than compared against a screenshot -- and a screenshot diff
//! cannot tell you *which* cell is wrong, which is the information needed when a
//! pane's border is one column off.
//!
//! # One geometry source
//!
//! Widgets receive [`LayoutRects`](crate::layout::LayoutRects) from the shell and
//! never compute a rectangle themselves. A widget that derived its own `Rect`
//! would be free to disagree with the hit-test, and that disagreement is the
//! "tearing" acceptance criterion 5 forbids.
//!
//! # Colour is 24-bit because the stream is
//!
//! [`vt::grid::Color::Rgb`] maps straight to `ratatui::Color::Rgb` with no
//! quantisation. Indexed colours resolve through one table so the widget and the
//! emulator cannot disagree about what index 196 means.

pub mod chrome;
pub mod diff;
pub mod frame;
pub mod modal;
pub mod setup;
pub mod terminal;

pub use chrome::{
    draw_chrome, draw_inspector_sidebar, logo_mark_spans, InspectorWidget, SidebarSection,
    TopHeaderBarWidget, WindowHeader, WorkspaceTabBarWidget, LOGO_ELECTRIC_CYAN, LOGO_MESH_EMERALD,
    LOGO_NEURAL_VIOLET,
};
pub use diff::{
    classify_diff_risk, draw_diff_pane, draw_embedded_diff_card, DiffLine, DiffView, RiskBadge,
    RiskLevel,
};
pub use frame::{draw_overlays, render_frame, FrameInput};
pub use modal::{
    command_palette_rect, draw_approval_modal, draw_command_palette, draw_embedded_approval_card,
    draw_keymap_modal, draw_setup_wizard_modal, embedded_card_rect, keymap_modal_rect,
    setup_wizard_modal_rect, ApprovalModalState, CardAction, CommandPaletteWidget,
    KeymapSetupModalWidget, ModalAction, OnboardingWizardModal, SetupWizardModalState,
    SetupWizardModalWidget, BRAND_ELECTRIC_CYAN, BRAND_MESH_EMERALD, BRAND_NEURAL_VIOLET,
};
pub use setup::{
    DirectorySelectorState, DirectorySelectorWidget, NetworkProbeState, NetworkProbeWidget,
    ProbeStatus, ProjectDirectoryItem, RuntimeProbeState, RuntimeProbeWidget, StepperNavWidget,
    TokenGeneratorState, TokenGeneratorWidget,
};
// `FocusTarget` lives in the input engine, which defines the modal's focus model;
// re-exported so a widget consumer needs one `use`.
pub use crate::input::traits::FocusTarget;
pub use terminal::{draw_terminal_pane, NoScrollback, ScrollbackPaneAdapter, TerminalPane};
