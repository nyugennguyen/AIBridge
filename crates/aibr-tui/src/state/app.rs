//! The client's local state and its reducer.
//!
//! # The state holds CLIENT types, not contract types
//!
//! This module declares its own [`Job`], [`Pane`], [`Workspace`] and
//! [`Tailscale`] structs and converts at the boundary. That is not a layering
//! preference -- it is forced by a property of the generated contracts, recorded
//! in `aibr_ipc::message`'s module header: `StateSnapshot` (the root schema) and
//! `ServerMessage::StateSnapshot` (the union arm) are two DIFFERENT Rust types
//! with the same wire shape. typify expands union arms in place, so a snapshot's
//! jobs are `ServerMessage0JobsItem` while a diff's `job_added` carries
//! `ServerMessage1Changes0Job`, and neither converts to the other.
//!
//! Storing generated types would mean picking one hierarchy and converting from
//! the other at every apply, which puts a hand-written field-by-field copy in
//! the one place where a dropped field becomes a silently wrong client -- a job
//! that never reaches `blocked`, so no approval modal. Owning the projection
//! makes that copy total and checked by the compiler: adding a contract field
//! fails the build here rather than being quietly ignored.
//!
//! Every function is pure. The render pass reads this state, the input handlers
//! reduce into it, and the IPC client reduces frames into it from another task.
//! A getter with a side effect would make render order observable, which is the
//! class of bug acceptance criterion 5 (no tearing while resizing) exists to
//! catch.

#![deny(missing_docs)]

use std::collections::BTreeMap;

use std::num::NonZeroU64;

use aibr_ipc::contracts::{
    JobState, ServerMessage0Tailscale, ServerMessage0TailscaleStatus, ServerMessage1ChangesItem,
};

/// How the operator's next keystroke will be interpreted.
///
/// Shown in the header and the status bar because it changes what a key MEANS:
/// `Ctrl+B` is two bytes to a PTY in [`InputMode::Terminal`] and a prefix in
/// [`InputMode::Prefix`]. Hiding that would make the client feel haunted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InputMode {
    /// Keystrokes go to the focused pane's PTY untranslated.
    #[default]
    Terminal,
    /// `Ctrl+B` was pressed; the NEXT key is a command, not input.
    Prefix,
    /// Vi-style scrollback navigation over the focused pane's history.
    Copy,
    /// A split, a context menu, or a border drag is in progress.
    ///
    /// Distinct from [`InputMode::Prefix`] because the mouse engine must know a
    /// `MouseDown` began a border drag, which it cannot infer from key state.
    Navigate,
}

/// Below this the layout cannot be drawn without overwriting its own borders.
///
/// 60x18 matches `MINIMUM_TUI_COLUMNS`/`MINIMUM_TUI_ROWS` in `src/tui/types.ts`,
/// so a terminal that works with today's TUI keeps working. Below it the client
/// shows a "too small" notice rather than a mangled layout.
pub const MINIMUM_COLUMNS: u16 = 60;
/// See [`MINIMUM_COLUMNS`].
pub const MINIMUM_ROWS: u16 = 18;

/// Why a job is waiting for a human.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockedReason {
    /// The agent proposed a plan and wants it approved.
    PlanReview,
    /// A tool call asked for permission.
    Permission,
    /// The agent asked a question.
    UserInput,
    /// A policy check refused the action.
    PolicyViolation,
}

/// What a pane displays, which decides what the client renders into it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaneKind {
    /// The embedded VT grid.
    Terminal,
    /// The plan review and diff widget.
    PlanReview,
    /// The redacted audit log.
    AuditLog,
}

/// A job, as the client knows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    /// The daemon's identifier for this job.
    pub id: String,
    /// The project it belongs to.
    pub project_id: String,
    /// The workspace whose sidebar lists it.
    pub workspace_id: String,
    /// The agent session driving it, once one exists.
    pub session_id: Option<String>,
    /// The four-state agent lifecycle.
    pub state: JobState,
    /// Why it is blocked; `Some` exactly when `state` is `Blocked`.
    pub blocked_reason: Option<BlockedReason>,
    /// Agent-authored free text, already redacted by the daemon.
    pub detail: Option<String>,
    /// When the state last changed.
    pub updated_at: String,
}

/// A pane, as the client knows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pane {
    /// The daemon's identifier for this pane.
    pub id: String,
    /// The workspace it belongs to.
    pub workspace_id: String,
    /// What it displays.
    pub kind: PaneKind,
    /// Title shown in the pane border.
    pub title: String,
    /// The job whose output it shows, if any.
    pub job_id: Option<String>,
    /// The agent session behind it, if any.
    pub session_id: Option<String>,
    /// The PTY's current width in columns.
    ///
    /// `NonZeroU64` because Zod's `.min(1)` generates `NonZeroU64`, and a
    /// zero-sized PTY is not a terminal: sizing one to 0x0 makes `opencode` exit
    /// rather than render, so the type is where that fact lives rather than a
    /// runtime check that would have to be repeated.
    pub columns: NonZeroU64,
    /// The PTY's current height in rows.
    pub rows: NonZeroU64,
    /// How far the operator has scrolled back, in lines.
    pub scroll_offset: i64,
}

/// A workspace, as the client knows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    /// The daemon's identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// The project it belongs to.
    pub project_id: String,
    /// The allowlist-checked project root. The daemon resolved it; the client
    /// never resolves a path.
    pub project_root: String,
    /// Whether the header names this one.
    pub selected: bool,
}

/// Tailscale connectivity, as the header shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tailscale {
    /// The four states, with `Unknown` deliberately distinct from `Stopped`.
    pub status: TailscaleStatus,
    /// The bound CGNAT address with prefix, when one is bound.
    pub address: Option<String>,
    /// Peers this node can see.
    pub peer_count: i64,
}

/// The four connectivity states.
///
/// `Unknown` is not a fallback for `Stopped`: "I asked and could not tell" and
/// "tailscaled said no" are different diagnoses, and collapsing them would make
/// the header lie about why ingress is unreachable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TailscaleStatus {
    /// Bound and connected.
    Active,
    /// tailscaled reported not connected.
    Stopped,
    /// tailscaled is not installed or not running.
    Unavailable,
    /// The status could not be determined.
    Unknown,
}

impl TailscaleStatus {
    /// The word the header prints.
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Stopped => "stopped",
            Self::Unavailable => "unavailable",
            Self::Unknown => "unknown",
        }
    }
}

/// Why the client stopped, and how the process should report it.
#[derive(Debug)]
pub enum ClientError {
    /// No usable terminal: stdin or stdout is not a TTY.
    ///
    /// Exit code 1. The daemon is unaffected and `aibr tui` works in a real
    /// terminal, so this is a usage error rather than a failure.
    NotATerminal,
    /// The terminal could not be queried or restored.
    Io(std::io::Error),
    /// An internal invariant broke, or the daemon violated its contract.
    ///
    /// Exit code 2, deliberately distinct: a contract violation is a bug, and
    /// reporting it with the same code as "no TTY" would have every operator's
    /// script log a software defect as a configuration problem.
    Invariant(String),
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotATerminal => write!(
                formatter,
                "a TTY is required; run `aibr tui` from a terminal, not a pipe"
            ),
            Self::Io(error) => write!(formatter, "terminal I/O failed: {error}"),
            Self::Invariant(message) => write!(formatter, "invariant broken: {message}"),
        }
    }
}

impl std::error::Error for ClientError {}

impl ClientError {
    /// The process exit code for this failure.
    #[must_use]
    pub fn exit_code(&self) -> std::process::ExitCode {
        match self {
            Self::NotATerminal | Self::Io(_) => std::process::ExitCode::from(1),
            Self::Invariant(_) => std::process::ExitCode::from(2),
        }
    }
}

/// What the client did before it exited.
#[derive(Debug, Default)]
pub struct RunOutcome {
    /// `true` when the operator detached and the daemon kept running.
    pub detached: bool,
    /// Diff frames applied over the session.
    pub diffs_applied: u64,
    /// PTY chunks fed to the terminal emulators.
    pub chunks_applied: u64,
    /// Render-loop iterations, so a caller can report the client's cadence.
    pub ticks: u64,
}

/// The daemon's world, as mirrored locally.
///
/// `BTreeMap` rather than `HashMap` throughout: the sidebar renders in a stable
/// order, and a `HashMap`'s iteration order would reshuffle panes on every
/// snapshot. Visible reordering on unrelated state changes is exactly the
/// "flickering" acceptance criterion 5 forbids.
#[derive(Debug, Clone, Default)]
pub struct DaemonWorld {
    /// The sequence applied up to, or `None` before the first snapshot.
    ///
    /// A diff whose `base_sequence` does not match is REJECTED rather than
    /// applied onto a gap -- applying it anyway is how a client comes to be
    /// quietly wrong about which panes exist.
    pub sequence: Option<i64>,
    /// This daemon's node id, for the header.
    pub node_id: String,
    /// Tailscale connectivity.
    pub tailscale: Option<Tailscale>,
    /// Rows still pending in `ingress_outbox`.
    pub outbox_pending_count: i64,
    /// Jobs by id.
    pub jobs: BTreeMap<String, Job>,
    /// Panes by id.
    pub panes: BTreeMap<String, Pane>,
    /// Workspaces by id.
    pub workspaces: BTreeMap<String, Workspace>,
}

/// Local presentation state. None of this is known to the daemon.
#[derive(Debug, Clone)]
pub struct Presentation {
    /// The pane receiving keystrokes.
    pub focused: Option<String>,
    /// The workspace the header names.
    pub active_workspace: Option<String>,
    /// Input interpretation mode.
    pub mode: InputMode,
    /// Whether the left sidebar is drawn.
    pub sidebar_visible: bool,
    /// The pane the zoom toggle applies to; `None` when not zoomed.
    pub zoomed: Option<String>,
    /// Terminal width in columns and height in rows.
    pub size: (u16, u16),
    /// Whether the terminal is too small to draw the layout.
    pub too_small: bool,
}

impl Default for Presentation {
    fn default() -> Self {
        Self {
            focused: None,
            active_workspace: None,
            mode: InputMode::Terminal,
            // VISIBLE BY DEFAULT, unlike tmux. The sidebar carries the queue
            // count and the blocked-job badges, which are the two things an
            // operator most needs to notice and cannot afford to have hidden.
            sidebar_visible: true,
            zoomed: None,
            size: (MINIMUM_COLUMNS, MINIMUM_ROWS),
            too_small: false,
        }
    }
}

/// The client's whole world: the daemon's, plus the local presentation.
#[derive(Debug, Clone, Default)]
pub struct UiState {
    /// What the daemon has told us.
    pub world: DaemonWorld,
    /// What this process has decided.
    pub presentation: Presentation,
}

impl UiState {
    /// Replace the world with a snapshot.
    ///
    /// Wholesale replacement rather than a merge is the point: a snapshot is the
    /// only frame that describes the whole world, and merging one would leave a
    /// pane that was closed while the client was away alive on screen forever.
    pub fn apply_snapshot(&mut self, snapshot: aibr_ipc::Snapshot<'_>) {
        self.world.sequence = Some(snapshot.sequence);
        self.world.node_id = snapshot.node_id.to_owned();
        self.world.outbox_pending_count = snapshot.outbox_pending_count;
        self.world.tailscale = Some(Tailscale::from(snapshot.tailscale));
        self.world.jobs = index_by(
            snapshot
                .jobs
                .iter()
                .map(|job| (job.job_id.as_str().to_owned(), Job::from(job))),
        );
        self.world.panes = index_by(
            snapshot
                .panes
                .iter()
                .map(|pane| (pane.pane_id.as_str().to_owned(), Pane::from(pane))),
        );
        self.world.workspaces = index_by(snapshot.workspaces.iter().map(|workspace| {
            (
                workspace.workspace_id.as_str().to_owned(),
                Workspace::from(workspace),
            )
        }));
        self.sync_focus_to_existing_pane();
    }

    /// Advance the world by one diff.
    ///
    /// Returns `false` -- having changed nothing -- when the diff does not
    /// continue from the sequence this client holds. The caller then re-requests
    /// a snapshot.
    pub fn apply_diff(&mut self, diff: aibr_ipc::Diff<'_>) -> bool {
        if self.world.sequence != Some(diff.base_sequence) {
            return false;
        }
        for change in diff.changes {
            self.apply_change(change);
        }
        self.world.sequence = Some(diff.sequence);
        self.sync_focus_to_existing_pane();
        true
    }

    /// Record a new terminal size and recompute whether the layout fits.
    pub fn set_size(&mut self, columns: u16, rows: u16) {
        self.presentation.size = (columns, rows);
        self.presentation.too_small = columns < MINIMUM_COLUMNS || rows < MINIMUM_ROWS;
    }

    /// The job that should open the approval modal, if any.
    ///
    /// Ordered by job id so the choice is deterministic when two jobs block in
    /// the same frame: the modal must not present a different job each render.
    #[must_use]
    pub fn blocked_job(&self) -> Option<&Job> {
        self.world
            .jobs
            .values()
            .filter(|job| job.state == JobState::Blocked)
            .min_by(|left, right| left.id.cmp(&right.id))
    }

    /// Panes belonging to one workspace, in a stable order.
    #[must_use]
    pub fn panes_in_workspace(&self, workspace_id: &str) -> Vec<&Pane> {
        let mut matching: Vec<&Pane> = self
            .world
            .panes
            .values()
            .filter(|pane| pane.workspace_id == workspace_id)
            .collect();
        matching.sort_by(|left, right| left.id.cmp(&right.id));
        matching
    }

    /// Jobs belonging to one workspace, in a stable order.
    #[must_use]
    pub fn jobs_in_workspace(&self, workspace_id: &str) -> Vec<&Job> {
        let mut matching: Vec<&Job> = self
            .world
            .jobs
            .values()
            .filter(|job| job.workspace_id == workspace_id)
            .collect();
        matching.sort_by(|left, right| left.id.cmp(&right.id));
        matching
    }

    /// The workspace the header should name: the daemon's selection, else the
    /// first by id.
    #[must_use]
    pub fn effective_workspace(&self) -> Option<&Workspace> {
        if let Some(active) = &self.presentation.active_workspace {
            if let Some(workspace) = self.world.workspaces.get(active) {
                return Some(workspace);
            }
        }
        self.world
            .workspaces
            .values()
            .find(|workspace| workspace.selected)
            .or_else(|| self.world.workspaces.values().next())
    }

    /// Drop a focus or zoom that names a pane the world no longer contains.
    ///
    /// Without this, closing the focused pane leaves keystrokes addressed to a
    /// `paneId` the daemon will answer `not_found`, and the status bar names a
    /// pane that is not drawn.
    fn sync_focus_to_existing_pane(&mut self) {
        if let Some(focused) = &self.presentation.focused {
            if !self.world.panes.contains_key(focused) {
                self.presentation.focused = None;
            }
        }
        if let Some(zoomed) = &self.presentation.zoomed {
            if !self.world.panes.contains_key(zoomed) {
                self.presentation.zoomed = None;
            }
        }
    }

    /// Fold one change into the world.
    fn apply_change(&mut self, change: &ServerMessage1ChangesItem) {
        match change {
            ServerMessage1ChangesItem::JobAdded { job } => {
                self.world
                    .jobs
                    .insert(job.job_id.as_str().to_owned(), Job::from(job));
            }
            ServerMessage1ChangesItem::JobStateChanged {
                job_id,
                state,
                blocked_reason,
                detail,
                updated_at,
            } => {
                if let Some(job) = self.world.jobs.get_mut(job_id.as_str()) {
                    job.state = job_state(state.to_string().as_str());
                    job.blocked_reason = blocked_reason
                        .as_ref()
                        .map(|reason| blocked_reason_from_tag(reason.to_string().as_str()));
                    job.detail = detail.as_ref().map(|detail| detail.as_str().to_owned());
                    job.updated_at = updated_at.as_str().to_owned();
                }
            }
            ServerMessage1ChangesItem::JobRemoved { job_id } => {
                self.world.jobs.remove(job_id.as_str());
            }
            ServerMessage1ChangesItem::OutboxCountChanged { pending_count } => {
                self.world.outbox_pending_count = *pending_count;
            }
            ServerMessage1ChangesItem::PaneAdded { pane } => {
                self.world
                    .panes
                    .insert(pane.pane_id.as_str().to_owned(), Pane::from(pane));
            }
            ServerMessage1ChangesItem::PaneRemoved { pane_id } => {
                self.world.panes.remove(pane_id.as_str());
            }
            ServerMessage1ChangesItem::PaneGeometryChanged {
                pane_id,
                columns,
                rows,
            } => {
                if let Some(pane) = self.world.panes.get_mut(pane_id.as_str()) {
                    // The diff arm already carries `NonZeroU64` -- Zod's
                    // `.min(1)` is generated the same way in both arms -- so
                    // this needs no reconciliation at all.
                    pane.columns = *columns;
                    pane.rows = *rows;
                }
            }
            ServerMessage1ChangesItem::WorkspaceSelected { workspace_id } => {
                self.presentation.active_workspace = Some(workspace_id.as_str().to_owned());
                for workspace in self.world.workspaces.values_mut() {
                    workspace.selected = workspace.id == workspace_id.as_str();
                }
            }
            // Queue and audit changes belong to the panes that display them. A
            // queue item is not a job until it is claimed, so inserting it into
            // `jobs` would make the sidebar list a job with no state; and an
            // audit line belongs to the audit pane's own buffer, which the VT
            // grid renders and the world projection does not own.
            ServerMessage1ChangesItem::QueueItemAdded { .. }
            | ServerMessage1ChangesItem::QueueItemRemoved { .. }
            | ServerMessage1ChangesItem::AuditLogAppended { .. } => {}
        }
    }
}

/// Build a map from id-bearing items, so every map in [`DaemonWorld`] is built
/// the same way.
fn index_by<T, I: IntoIterator<Item = (String, T)>>(items: I) -> BTreeMap<String, T> {
    items.into_iter().collect()
}

/// Map a snapshot's job item onto the client's [`Job`].
impl From<&aibr_ipc::contracts::ServerMessage0JobsItem> for Job {
    fn from(view: &aibr_ipc::contracts::ServerMessage0JobsItem) -> Self {
        Self {
            id: view.job_id.as_str().to_owned(),
            project_id: view.project_id.as_str().to_owned(),
            workspace_id: view.workspace_id.as_str().to_owned(),
            session_id: view
                .session_id
                .as_ref()
                .map(|session| session.as_str().to_owned()),
            state: job_state(view.state.to_string().as_str()),
            blocked_reason: view
                .blocked_reason
                .as_ref()
                .map(|reason| blocked_reason_from_tag(reason.to_string().as_str())),
            detail: view
                .detail
                .as_ref()
                .map(|detail| detail.as_str().to_owned()),
            updated_at: view.updated_at.as_str().to_owned(),
        }
    }
}

/// Map a diff's `job_added` payload onto the client's [`Job`].
///
/// Exists because the diff arm's job type is a DIFFERENT generated struct from
/// the snapshot's (see the module header). Writing both mappings rather than one
/// generic one is what makes a newly added contract field a compile error in both
/// places instead of a silently dropped value in one.
impl From<&aibr_ipc::contracts::ServerMessage1Changes0Job> for Job {
    fn from(view: &aibr_ipc::contracts::ServerMessage1Changes0Job) -> Self {
        Self {
            id: view.job_id.as_str().to_owned(),
            project_id: view.project_id.as_str().to_owned(),
            workspace_id: view.workspace_id.as_str().to_owned(),
            session_id: view
                .session_id
                .as_ref()
                .map(|session| session.as_str().to_owned()),
            state: job_state(view.state.to_string().as_str()),
            blocked_reason: view
                .blocked_reason
                .as_ref()
                .map(|reason| blocked_reason_from_tag(reason.to_string().as_str())),
            detail: view
                .detail
                .as_ref()
                .map(|detail| detail.as_str().to_owned()),
            updated_at: view.updated_at.as_str().to_owned(),
        }
    }
}

/// Map a snapshot's pane item onto the client's [`Pane`].
impl From<&aibr_ipc::contracts::ServerMessage0PanesItem> for Pane {
    fn from(view: &aibr_ipc::contracts::ServerMessage0PanesItem) -> Self {
        Self {
            id: view.pane_id.as_str().to_owned(),
            workspace_id: view.workspace_id.as_str().to_owned(),
            kind: pane_kind_from_tag(view.kind.to_string().as_str()),
            title: view.title.as_str().to_owned(),
            job_id: view.job_id.as_ref().map(|id| id.as_str().to_owned()),
            session_id: view
                .session_id
                .as_ref()
                .map(|session| session.as_str().to_owned()),
            columns: view.columns,
            rows: view.rows,
            scroll_offset: view.scroll_offset,
        }
    }
}

/// Map a diff's `pane_added` payload onto the client's [`Pane`].
impl From<&aibr_ipc::contracts::ServerMessage1Changes6Pane> for Pane {
    fn from(view: &aibr_ipc::contracts::ServerMessage1Changes6Pane) -> Self {
        Self {
            id: view.pane_id.as_str().to_owned(),
            workspace_id: view.workspace_id.as_str().to_owned(),
            kind: pane_kind_from_tag(view.kind.to_string().as_str()),
            title: view.title.as_str().to_owned(),
            job_id: view.job_id.as_ref().map(|id| id.as_str().to_owned()),
            session_id: view
                .session_id
                .as_ref()
                .map(|session| session.as_str().to_owned()),
            columns: view.columns,
            rows: view.rows,
            scroll_offset: view.scroll_offset,
        }
    }
}

/// Map a snapshot's workspace item onto the client's [`Workspace`].
impl From<&aibr_ipc::contracts::ServerMessage0WorkspacesItem> for Workspace {
    fn from(view: &aibr_ipc::contracts::ServerMessage0WorkspacesItem) -> Self {
        Self {
            id: view.workspace_id.as_str().to_owned(),
            name: view.name.as_str().to_owned(),
            project_id: view.project_id.as_str().to_owned(),
            project_root: view.project_root.as_str().to_owned(),
            selected: view.selected,
        }
    }
}

/// Map the snapshot's tailscale view onto the client's [`Tailscale`].
impl From<&ServerMessage0Tailscale> for Tailscale {
    fn from(view: &ServerMessage0Tailscale) -> Self {
        Self {
            status: match view.status {
                ServerMessage0TailscaleStatus::Active => TailscaleStatus::Active,
                ServerMessage0TailscaleStatus::Stopped => TailscaleStatus::Stopped,
                ServerMessage0TailscaleStatus::Unavailable => TailscaleStatus::Unavailable,
                ServerMessage0TailscaleStatus::Unknown => TailscaleStatus::Unknown,
            },
            address: view
                .address
                .as_ref()
                .map(|address| address.as_str().to_owned()),
            peer_count: view.peer_count,
        }
    }
}

/// Map a generated state enum onto the contract's [`JobState`], by its serde tag.
///
/// STRING-KEYED RATHER THAN A `match` PER GENERATED TYPE, and that is a
/// deliberate choice with a cost worth naming. The generated code declares a
/// SEPARATE enum type for every place the union nests a schema: the snapshot's
/// jobs carry `ServerMessage0JobsState`, a diff's `job_added` carries
/// `ServerMessage1Changes0JobState`, and a diff's `job_state_changed` carries
/// `ServerMessage1Changes1State`. Three types, four values, no shared trait and
/// no `From` between them -- so an exhaustive `match` would have to be written
/// once per type and a new contract state would fail to compile in one arm while
/// silently working in the others.
///
/// Every generated variant implements `Display` printing its serde rename, so one
/// string-keyed mapper covers all of them and is the single place a state name
/// is spelled. The `unreachable!` arms are the guarantee: an unrecognised tag
/// cannot reach here, because serde rejects it during decode, so hitting one
/// means the CONTRACT and this mapper disagree -- a bug worth panicking on in a
/// test run rather than rendering a job in a state the contract forbids.
fn job_state(tag: &str) -> JobState {
    match tag {
        "working" => JobState::Working,
        "blocked" => JobState::Blocked,
        "done" => JobState::Done,
        "idle" => JobState::Idle,
        other => unreachable!("unknown JobState tag `{other}` reached the client mapper"),
    }
}

/// Map a generated blocked-reason enum onto the client's [`BlockedReason`].
fn blocked_reason_from_tag(tag: &str) -> BlockedReason {
    match tag {
        "plan_review" => BlockedReason::PlanReview,
        "permission" => BlockedReason::Permission,
        "user_input" => BlockedReason::UserInput,
        "policy_violation" => BlockedReason::PolicyViolation,
        other => unreachable!("unknown blockedReason tag `{other}` reached the client mapper"),
    }
}

/// Map a generated pane-kind enum onto the client's [`PaneKind`].
fn pane_kind_from_tag(tag: &str) -> PaneKind {
    match tag {
        "terminal" => PaneKind::Terminal,
        "plan_review" => PaneKind::PlanReview,
        "audit_log" => PaneKind::AuditLog,
        other => unreachable!("unknown pane kind tag `{other}` reached the client mapper"),
    }
}
