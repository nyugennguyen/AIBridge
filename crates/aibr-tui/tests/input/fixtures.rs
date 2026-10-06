//! Fakes for the traits the input engine depends on.
//!
//! # WHY A REAL IN-MEMORY GRID AND NOT A `no_op` STUB
//!
//! Every test that touches selection, search or link handling has to assert on TEXT. A
//! trait that returns `""` from `line` would make "copy-on-select extracts the right text"
//! untestable, which is the assertion that matters most here: a selection that extracts
//! the wrong cells is a clipboard bug the operator only notices after pasting.
//!
//! So [`FakePane`] is a real scrollback: lines, a viewport offset, per-line continuation
//! flags, and a hyperlink map. It is small, and it is the reference implementation of the
//! contract [`ScrollbackPane`] states -- which also makes it documentation.

#![allow(dead_code)]

use std::collections::BTreeMap;

use aibr_tui::input::{
    ApprovalModal, ApproveScope, FocusTarget, KeyEventLike, ModalOutcome, NamedKey, ScrollbackPane,
    SidebarList,
};
use aibr_tui::layout::Axis;

/// An in-memory scrollback with a viewport.
#[derive(Debug, Clone, Default)]
pub struct FakePane {
    /// Every retained line, oldest first.
    pub lines: Vec<String>,
    /// Which lines continue the previous one (a soft wrap) rather than ending it.
    pub continuations: Vec<bool>,
    /// Columns the viewport shows.
    pub columns: u16,
    /// Rows the viewport shows.
    pub rows: u16,
    /// How far back from the bottom the viewport is scrolled.
    pub offset: i64,
    /// OSC 8 links, keyed by pane, then ABSOLUTE line, then pane-content column.
    pub links: BTreeMap<(String, i64, u16), String>,
    /// The raw byte log this pane pretends to have.
    pub raw: String,
    /// Whether this pane scrolls at all. `None` models a `PlanReview` pane.
    pub scrollable: Option<Axis>,
    /// Every scroll the engine asked for, for assertions.
    pub scrolls: Vec<(String, i64)>,
}

impl FakePane {
    /// A pane showing `lines`, scrolled to the bottom.
    #[must_use]
    pub fn new(lines: &[&str], columns: u16, rows: u16) -> Self {
        Self {
            lines: lines.iter().map(|line| (*line).to_owned()).collect(),
            continuations: vec![false; lines.len()],
            columns,
            rows,
            offset: 0,
            links: BTreeMap::new(),
            raw: String::new(),
            scrollable: Some(Axis::Vertical),
            scrolls: Vec::new(),
        }
    }

    /// Mark one line as a soft-wrap continuation of the line before it.
    #[must_use]
    pub fn wrapping(mut self, index: usize) -> Self {
        if index < self.continuations.len() {
            self.continuations[index] = true;
        }
        self
    }

    /// Attach a hyperlink at an absolute line and column.
    #[must_use]
    pub fn with_link(mut self, pane: &str, line: i64, column: u16, url: &str) -> Self {
        self.links
            .insert((pane.to_owned(), line, column), url.to_owned());
        self
    }

    /// A pane with no scrollback, like a diff widget.
    #[must_use]
    pub fn unscrollable(mut self) -> Self {
        self.scrollable = None;
        self
    }
}

impl ScrollbackPane for FakePane {
    fn viewport_top(&self, _pane_id: &str) -> i64 {
        // CLAMPED AT ZERO, as a real grid is: a pane showing ten rows of a two-line buffer
        // starts at line 0, not at line -8. Without the clamp every selection in a short
        // buffer would extract from negative lines.
        (self.lines.len() as i64 - i64::from(self.rows) - self.offset).max(0)
    }

    fn viewport_rows(&self, _pane_id: &str) -> u16 {
        self.rows
    }

    fn viewport_columns(&self, _pane_id: &str) -> u16 {
        self.columns
    }

    fn scroll_offset(&self, _pane_id: &str) -> i64 {
        self.offset
    }

    fn total_lines(&self, _pane_id: &str) -> i64 {
        self.lines.len() as i64
    }

    fn scroll_back(&mut self, pane_id: &str, lines: u16) {
        self.offset = (self.offset + i64::from(lines))
            .min((self.lines.len() as i64 - i64::from(self.rows)).max(0));
        self.scrolls.push((pane_id.to_owned(), i64::from(lines)));
    }

    fn scroll_forward(&mut self, pane_id: &str, lines: u16) {
        self.offset = (self.offset - i64::from(lines)).max(0);
        self.scrolls.push((pane_id.to_owned(), -i64::from(lines)));
    }

    fn scroll_to_line(&mut self, _pane_id: &str, index: i64) {
        self.offset = (self.lines.len() as i64 - i64::from(self.rows) - index).clamp(0, i64::MAX);
    }

    fn line(&self, _pane_id: &str, index: i64) -> String {
        if index < 0 {
            return String::new();
        }
        self.lines.get(index as usize).cloned().unwrap_or_default()
    }

    fn line_is_continuation(&self, _pane_id: &str, index: i64) -> bool {
        index >= 0
            && self
                .continuations
                .get(index as usize)
                .copied()
                .unwrap_or(false)
    }

    fn hyperlink_at(&self, pane_id: &str, column: u16, row: u16) -> Option<String> {
        // The caller passes PANE-CONTENT coordinates, so the fake resolves the absolute line
        // the way a grid would: the viewport's first line plus the row.
        let top = self.viewport_top(pane_id);
        self.links
            .get(&(pane_id.to_owned(), top + i64::from(row), column))
            .cloned()
    }

    fn raw_log(&self, _pane_id: &str) -> String {
        self.raw.clone()
    }

    fn scroll_axis(&self, _pane_id: &str) -> Option<Axis> {
        self.scrollable
    }
}

/// A sidebar list that records what it was told.
#[derive(Debug, Clone, Default)]
pub struct FakeList {
    /// Every scroll amount, in order.
    pub scrolls: Vec<i32>,
}

impl SidebarList for FakeList {
    fn scroll(&mut self, lines: i32) {
        self.scrolls.push(lines);
    }
}

/// An approval modal whose answer is scripted.
///
/// SCRIPTED RATHER THAN STATEFUL so a test says what the modal does with an event, rather
/// than depending on a modal implementation that has not been written yet. That is the
/// whole reason the modal is a trait: this file is the specification the widgets
/// workstream is writing against.
#[derive(Debug, Clone)]
pub struct FakeModal {
    /// Whether the modal is shown.
    pub open: bool,
    /// The job awaiting a decision.
    pub job: Option<String>,
    /// Where focus is.
    pub focus: FocusTarget,
    /// How many controls are focusable.
    pub controls: usize,
    /// What to answer a key with.
    pub key_answer: ModalOutcome,
    /// What to answer a click with.
    pub click_answer: ModalOutcome,
    /// Where the modal claims to be, for coordinate translation.
    pub area: Option<ratatui::layout::Rect>,
    /// Every key the engine handed over.
    pub keys: Vec<KeyEventLike>,
    /// Every click's coordinates, relative to `area`.
    pub clicks: Vec<(u16, u16)>,
}

impl Default for FakeModal {
    fn default() -> Self {
        Self {
            open: false,
            job: None,
            focus: FocusTarget::Approve,
            controls: 4,
            key_answer: ModalOutcome::Consumed,
            click_answer: ModalOutcome::Consumed,
            area: None,
            keys: Vec::new(),
            clicks: Vec::new(),
        }
    }
}

impl FakeModal {
    /// A modal open on `job`, answering everything with [`ModalOutcome::Consumed`].
    #[must_use]
    pub fn open_on(job: &str) -> Self {
        Self {
            open: true,
            job: Some(job.to_owned()),
            ..Self::default()
        }
    }

    /// Answer keys with `outcome`.
    #[must_use]
    pub fn answering_keys(mut self, outcome: ModalOutcome) -> Self {
        self.key_answer = outcome;
        self
    }

    /// Answer clicks with `outcome`.
    #[must_use]
    pub fn answering_clicks(mut self, outcome: ModalOutcome) -> Self {
        self.click_answer = outcome;
        self
    }

    /// Publish a position, so the engine can translate coordinates.
    #[must_use]
    pub fn at(mut self, area: ratatui::layout::Rect) -> Self {
        self.area = Some(area);
        self
    }
}

impl ApprovalModal for FakeModal {
    fn is_open(&self) -> bool {
        self.open
    }

    fn job_id(&self) -> Option<&str> {
        self.job.as_deref()
    }

    fn focus(&self) -> FocusTarget {
        self.focus
    }

    fn set_focus(&mut self, target: FocusTarget) {
        self.focus = target;
    }

    fn focusable_count(&self) -> usize {
        self.controls
    }

    fn rect(&self) -> Option<ratatui::layout::Rect> {
        self.area
    }

    fn handle_key(&mut self, event: &KeyEventLike) -> ModalOutcome {
        self.keys.push(*event);
        self.key_answer.clone()
    }

    fn handle_click(&mut self, column: u16, row: u16, _target: FocusTarget) -> ModalOutcome {
        self.clicks.push((column, row));
        self.click_answer.clone()
    }
}

/// The scope an approval asked for, for assertions.
#[must_use]
pub fn approve_scope(outcome: &ModalOutcome) -> Option<ApproveScope> {
    match outcome {
        ModalOutcome::Approve { scope } => Some(*scope),
        _ => None,
    }
}

/// The named key an event carried.
#[must_use]
pub fn named(event: &KeyEventLike) -> Option<NamedKey> {
    event.named
}
