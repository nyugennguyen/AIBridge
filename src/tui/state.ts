import {
  MINIMUM_TUI_COLUMNS,
  MINIMUM_TUI_ROWS,
  type TuiAction,
  type TuiDimensions,
  type TuiKey,
  type TuiKeyIntent,
  type TuiUiState,
} from "./types.js"

export function isUsableViewport(dimensions: TuiDimensions): boolean {
  return dimensions.columns >= MINIMUM_TUI_COLUMNS && dimensions.rows >= MINIMUM_TUI_ROWS
}

export function initialTuiState(dimensions: TuiDimensions): TuiUiState {
  return {
    shell: "booting",
    snapshot: null,
    screen: "projects",
    overlay: "none",
    dimensions,
    error: null,
    projects: [],
    recoveries: [],
    selectedProjectIndex: 0,
    selectedProject: null,
    run: null,
    draft: null,
    draftFields: null,
    draftDirty: false,
    focusedField: null,
    focusedAction: null,
    fullProposal: false,
    scrollOffset: 0,
    pending: null,
    confirmationArmed: false,
    notice: null,
    terminalView: null,
    takeoverReason: "",
    permissionDecision: null,
  }
}

/** Pure state transition; renderer and service effects are intentionally absent. */
export function reduceTui(state: TuiUiState, action: TuiAction): TuiUiState {
  switch (action.type) {
    case "loaded": {
      const usable = isUsableViewport(state.dimensions)
      return {
        ...state,
        shell: usable ? "ready" : "too-small",
        snapshot: action.snapshot,
        screen: action.snapshot.screen,
        error: null,
      }
    }
    case "projects-loaded": {
      const selected = state.selectedProject && action.projects.some((project) => project.projectId === state.selectedProject?.projectId)
        ? state.selectedProject
        : (action.projects[0] ?? null)
      const index = selected === null ? 0 : Math.max(0, action.projects.findIndex((project) => project.projectId === selected.projectId))
      return { ...state, projects: action.projects, selectedProject: selected, selectedProjectIndex: index, notice: null }
    }
    case "recoveries-loaded":
      return { ...state, recoveries: action.recoveries }
    case "project-selected":
      return { ...state, selectedProject: action.project, selectedProjectIndex: action.index, screen: "projects", notice: null }
    case "draft-loaded": {
      const sameRun = state.run?.draft.runId === action.draft.runId
        && state.run.draft.projectId === action.draft.projectId
        && state.run.draft.taskId === action.draft.taskId
      return { ...state, run: sameRun ? state.run : null, draft: action.draft, draftFields: action.draft.fields, draftDirty: false, focusedField: "goal", focusedAction: null, screen: "draft", overlay: "none", notice: null }
    }
    case "draft-changed":
      return { ...state, draftFields: action.fields, draftDirty: true }
    case "run-loaded":
      return {
        ...state,
        run: action.run,
        draft: action.run.draft,
        draftFields: action.run.draft.fields,
        draftDirty: false,
        focusedField: null,
        focusedAction: null,
        screen: action.screen ?? state.screen,
        overlay: "none",
        pending: null,
      }
    case "set-notice": return { ...state, notice: action.notice }
    case "terminal-view": return { ...state, terminalView: action.model }
    case "takeover-reason": return { ...state, takeoverReason: action.reason }
    case "permission-decision": return { ...state, permissionDecision: action.decision }
    case "discard-draft": {
      const returnsToProposal = state.run?.currentProposal !== undefined
        && state.draft?.runId === state.run.draft.runId
        && state.draft.projectId === state.run.draft.projectId
        && state.draft.taskId === state.run.draft.taskId
      return {
        ...state,
        screen: returnsToProposal ? "proposal" : "projects",
        overlay: "none",
        confirmationArmed: false,
        draft: returnsToProposal ? state.run!.draft : null,
        draftFields: returnsToProposal ? state.run!.draft.fields : null,
        draftDirty: false,
        focusedField: null,
        focusedAction: null,
        notice: null,
        scrollOffset: 0,
      }
    }
    case "set-pending": return { ...state, pending: action.pending }
    case "set-overlay": return state.shell === "ready" ? { ...state, overlay: action.overlay, confirmationArmed: false, scrollOffset: 0 } : state
    case "set-confirmation-armed": return state.overlay === "none" ? state : { ...state, confirmationArmed: action.armed }
    case "focus-field": return { ...state, focusedField: action.field, focusedAction: action.field === null ? state.focusedAction : null }
    case "focus-action": return { ...state, focusedAction: action.action, focusedField: action.action === null ? state.focusedField : null }
    case "toggle-proposal-detail": return { ...state, fullProposal: !state.fullProposal, scrollOffset: 0 }
    case "scroll": return { ...state, scrollOffset: Math.max(0, state.scrollOffset + action.delta) }
    case "navigate":
      return state.shell === "ready" ? { ...state, screen: action.screen, overlay: "none", focusedField: null, focusedAction: null, scrollOffset: 0 } : state
    case "toggle-help":
      return state.shell === "ready"
        ? { ...state, overlay: state.overlay === "help" ? "none" : "help" }
        : state
    case "dismiss-overlay":
      return { ...state, overlay: "none", confirmationArmed: false, notice: null, scrollOffset: 0 }
    case "resize": {
      if (state.shell === "fatal" || state.shell === "closing" || state.shell === "closed") {
        return { ...state, dimensions: action.dimensions }
      }
      return {
        ...state,
        dimensions: action.dimensions,
        shell: isUsableViewport(action.dimensions) ? (state.snapshot === null ? "booting" : "ready") : "too-small",
        overlay: isUsableViewport(action.dimensions) ? state.overlay : "none",
      }
    }
    case "fatal":
      return { ...state, shell: "fatal", overlay: "none", error: action.message }
    case "closing":
      return state.shell === "closed" ? state : { ...state, shell: "closing", overlay: "none" }
    case "closed":
      return { ...state, shell: "closed", overlay: "none" }
  }
}

/** Pure key routing. It has no access to process, renderer, or application service. */
export function routeTuiKey(state: TuiUiState, key: TuiKey): TuiKeyIntent {
  if (key.ctrl && key.name.toLowerCase() === "c") return { type: "close" }
  if (state.shell === "too-small") return key.name === "q" ? { type: "close" } : { type: "none" }
  if (state.shell !== "ready") return { type: "none" }

  if (key.name === "f1" || key.name === "?") return { type: "dispatch", action: { type: "toggle-help" } }
  if (key.name === "escape" && state.overlay !== "none") return { type: "dispatch", action: { type: "dismiss-overlay" } }
  if (key.name === "q" && state.overlay === "none") return { type: "close" }
  if (key.name === "f" && state.overlay === "none" && state.snapshot?.canRefresh !== false) return { type: "refresh" }

  // Shell navigation is local and deliberately has no authorization/effect semantics.
  const screenByKey = {
    p: "projects",
    d: "draft",
    a: "proposal",
    s: "session",
    t: "terminal",
    v: "result",
  } as const
  const screen = screenByKey[key.name as keyof typeof screenByKey]
  return screen === undefined ? { type: "none" } : { type: "dispatch", action: { type: "navigate", screen } }
}
