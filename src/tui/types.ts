/**
 * Ephemeral UI state for the Milestone 1 shell. Canonical records remain
 * owned by the application service; these fields only preserve presentation,
 * focus and in-progress form edits.
 */
import type { DraftFields, DraftSnapshot, ProjectSummary, RecoverySummary, RunSnapshot } from "../application/types.js"
import type { TerminalViewModel } from "./terminal/types.js"

export const MINIMUM_TUI_COLUMNS = 60
export const MINIMUM_TUI_ROWS = 18

export type TuiScreen = "projects" | "draft" | "proposal" | "session" | "terminal" | "result"
export type TuiWorkflow =
  | "booting" | "project-selection" | "run-draft" | "proposal-review" | "proposal-rejected"
  | "proposal-revised" | "starting" | "agent-idle" | "agent-working" | "agent-blocked"
  | "agent-unknown" | "agent-completed" | "agent-failed" | "run-cancelled" | "result-review" | "recovering"

export type TuiOverlay =
  | "none" | "help" | "approval-confirmation" | "rejection-confirmation"
  | "cancel-confirmation" | "termination-confirmation" | "discard-confirmation" | "takeover-confirmation" | "permission-confirmation"

/** Legacy-safe shell snapshot, used while the project feature is loading. */
export interface TuiSnapshot {
  readonly workflow: TuiWorkflow
  readonly screen: TuiScreen
  readonly title: string
  readonly detail: readonly string[]
  readonly status: string
  readonly canRefresh?: boolean
}

export interface TuiDimensions { readonly columns: number; readonly rows: number }
export type TuiDraftField = keyof DraftFields
export type TuiActionControl =
  | "select-project" | "new-run" | "review-proposal" | "toggle-detail" | "approve" | "reject" | "revise"
  | "refresh" | "terminal" | "result" | "cancel" | "terminate" | "allow-once" | "deny"
  | "request-input" | "takeover" | "detach" | "back"

export interface TuiTailscaleNodeInfo {
  readonly name: string
  readonly latency?: string
  readonly isHost?: boolean
}

export interface TuiTaskDagNode {
  readonly name: string
  readonly status: "Done" | "Working" | "Blocked" | "Idle" | string
}

export interface TuiTelemetrySummary {
  readonly cost?: string | number
  readonly tokens?: string | number
  readonly secretRedactions?: number
  readonly enrolledNodes?: readonly TuiTailscaleNodeInfo[]
  readonly tasks?: readonly TuiTaskDagNode[]
}

export interface TuiUiState {
  readonly shell: "booting" | "ready" | "too-small" | "fatal" | "closing" | "closed"
  readonly snapshot: TuiSnapshot | null
  readonly screen: TuiScreen
  readonly overlay: TuiOverlay
  readonly dimensions: TuiDimensions
  readonly error: string | null
  readonly projects: readonly ProjectSummary[]
  readonly recoveries: readonly RecoverySummary[]
  readonly selectedProjectIndex: number
  readonly selectedProject: ProjectSummary | null
  readonly run: RunSnapshot | null
  readonly draft: DraftSnapshot | null
  readonly draftFields: DraftFields | null
  readonly draftDirty: boolean
  readonly focusedField: TuiDraftField | null
  readonly focusedAction: TuiActionControl | null
  readonly fullProposal: boolean
  readonly scrollOffset: number
  readonly pending: string | null
  /** Dialogs begin on Back; destructive confirmation requires an explicit focus move. */
  readonly confirmationArmed: boolean
  /** Non-sensitive service error/status scoped to the current screen. */
  readonly notice: string | null
  readonly terminalView: TerminalViewModel | null
  readonly takeoverReason: string
  readonly permissionDecision: "allow_once" | "deny" | null
  readonly telemetry?: TuiTelemetrySummary | null
  readonly inspectorVisible?: boolean
}

export type TuiAction =
  | { readonly type: "loaded"; readonly snapshot: TuiSnapshot }
  | { readonly type: "projects-loaded"; readonly projects: readonly ProjectSummary[] }
  | { readonly type: "recoveries-loaded"; readonly recoveries: readonly RecoverySummary[] }
  | { readonly type: "project-selected"; readonly project: ProjectSummary; readonly index: number }
  | { readonly type: "draft-loaded"; readonly draft: DraftSnapshot }
  | { readonly type: "draft-changed"; readonly fields: DraftFields }
  | { readonly type: "run-loaded"; readonly run: RunSnapshot; readonly screen?: TuiScreen }
  | { readonly type: "set-notice"; readonly notice: string | null }
  | { readonly type: "terminal-view"; readonly model: TerminalViewModel | null }
  | { readonly type: "takeover-reason"; readonly reason: string }
  | { readonly type: "permission-decision"; readonly decision: "allow_once" | "deny" | null }
  | { readonly type: "discard-draft" }
  | { readonly type: "set-pending"; readonly pending: string | null }
  | { readonly type: "set-overlay"; readonly overlay: TuiOverlay }
  | { readonly type: "set-confirmation-armed"; readonly armed: boolean }
  | { readonly type: "focus-field"; readonly field: TuiDraftField | null }
  | { readonly type: "focus-action"; readonly action: TuiActionControl | null }
  | { readonly type: "toggle-proposal-detail" }
  | { readonly type: "scroll"; readonly delta: number }
  | { readonly type: "navigate"; readonly screen: TuiScreen }
  | { readonly type: "toggle-help" }
  | { readonly type: "dismiss-overlay" }
  | { readonly type: "resize"; readonly dimensions: TuiDimensions }
  | { readonly type: "fatal"; readonly message: string }
  | { readonly type: "closing" }
  | { readonly type: "closed" }
  | { readonly type: "toggle-inspector" }
  | { readonly type: "telemetry-updated"; readonly telemetry: TuiTelemetrySummary | null }

export type TuiKeyIntent =
  | { readonly type: "dispatch"; readonly action: TuiAction }
  | { readonly type: "refresh" }
  | { readonly type: "close" }
  | { readonly type: "none" }

export interface TuiKey {
  readonly name: string
  readonly ctrl?: boolean
  readonly sequence?: string
  readonly shift?: boolean
  readonly meta?: boolean
  readonly alt?: boolean
}
