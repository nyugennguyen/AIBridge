import { OpenTuiRendererFactory, type TuiRenderer, type TuiRendererFactory } from "./renderer.js"
import { initialTuiState, reduceTui, routeTuiKey } from "./state.js"
import type { DraftFields, LocalApplicationService, ProjectSummary, RecoverySummary, RunSnapshot } from "../application/types.js"
import type { CommandId, CorrelationId, TerminalClientId, UserId } from "../orchestration/identifiers.js"
import type { Result } from "../orchestration/errors.js"
import type { TuiActionControl, TuiDimensions, TuiDraftField, TuiKey, TuiUiState } from "./types.js"
import { buildTuiView } from "./view-model.js"
import type { TerminalViewController, TerminalViewPort } from "./terminal/types.js"

export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): void
  off(signal: NodeJS.Signals, listener: () => void): void
}

export interface TuiShellDeps {
  /** M1.3-owned command boundary; the shell never accesses adapters or stores. */
  readonly service: LocalApplicationService
  readonly correlationId: CorrelationId
  /** Composition should supply a per-client operation source. The fallback is process-local for tests only. */
  readonly operationId?: () => CommandId
  /** The authenticated local actor supplied by composition. */
  readonly userId?: UserId
  /** Stable for this renderer lifetime; recovered attachments still begin read-only. */
  readonly terminalClientId?: TerminalClientId
  readonly terminalConnector?: {
    open(run: RunSnapshot, view: TerminalViewPort): Promise<Result<TerminalViewController>>
    openRecovery(recovery: RecoverySummary, view: TerminalViewPort): Promise<Result<TerminalViewController>>
  }
  readonly rendererFactory?: TuiRendererFactory
  readonly signals?: SignalSource
  readonly writer?: (message: string) => void
}

export interface TuiShell { run(profile: string): Promise<0 | 1>; close(): void; getState(): TuiUiState }

const PROCESS_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]
const fields: readonly TuiDraftField[] = ["goal", "taskTitle", "taskDescription", "prompt", "model", "timeoutSeconds"]

function processSignals(): SignalSource {
  return { on: (signal, listener) => process.on(signal, listener), off: (signal, listener) => process.off(signal, listener) }
}

function safeDiagnostic(error: unknown): string {
  return error instanceof Error ? "The TUI encountered an internal renderer failure." : "TUI initialization failed"
}

function safeServiceError(_error: unknown): string {
  return "The requested operation could not be completed safely."
}

function nextField(current: TuiDraftField | null, backwards = false): TuiDraftField {
  const index = Math.max(0, current === null ? 0 : fields.indexOf(current))
  return fields[(index + (backwards ? fields.length - 1 : 1)) % fields.length]!
}

/**
 * Imperative renderer controller. It only translates keystrokes into typed
 * LocalApplicationService commands and renders the pure view-model; no UI
 * code can reach filesystem, runtime, tmux, terminal or network APIs.
 */
export function createTuiShell(deps: TuiShellDeps): TuiShell {
  const rendererFactory = deps.rendererFactory ?? new OpenTuiRendererFactory()
  const signals = deps.signals ?? processSignals()
  const writer = deps.writer ?? ((message: string) => process.stderr.write(message))
  let operationCounter = 0
  const operationId = (): CommandId => deps.operationId?.() ?? (`tui-operation-${++operationCounter}` as CommandId)
  const userId = deps.userId ?? ("local-user" as UserId)
  const terminalClientId = deps.terminalClientId ?? ("local-tui-client" as TerminalClientId)
  let state = initialTuiState({ columns: 0, rows: 0 })
  let renderer: TuiRenderer | undefined
  let cleanups: Array<() => void> = []
  let finish: ((code: 0 | 1) => void) | undefined
  let closed = false
  let terminalController: TerminalViewController | null = null
  let recoveryMutationAllowed = true
  let terminalPoller: ReturnType<typeof setInterval> | null = null
  let terminalRefreshPending = false
  let cleanupTask: Promise<void> | null = null

  const stopTerminalPolling = (): void => {
    if (terminalPoller !== null) clearInterval(terminalPoller)
    terminalPoller = null
    terminalRefreshPending = false
  }
  const startTerminalPolling = (): void => {
    stopTerminalPolling()
    terminalPoller = setInterval(() => {
      const controller = terminalController
      if (controller === null || terminalRefreshPending || closed || state.screen !== "terminal") return
      terminalRefreshPending = true
      void controller.refreshOutput().finally(() => { terminalRefreshPending = false })
    }, 100)
    terminalPoller.unref()
  }

  const render = (): void => renderer?.render(buildTuiView(state))
  const dispatch = (action: Parameters<typeof reduceTui>[1]): void => {
    // A completion racing renderer teardown must not resurrect a screen or
    // make an optimistic effect visible after the user has closed the UI.
    if (closed && action.type !== "closed") return
    state = reduceTui(state, action)
    render()
  }
  const cleanup = (code: 0 | 1, diagnostic?: string): Promise<void> => {
    if (cleanupTask !== null) return cleanupTask
    closed = true
    stopTerminalPolling()
    const controller = terminalController
    controller?.revokeInput("TUI is closing")
    terminalController = null
    state = reduceTui(state, { type: "closing" })
    for (const remove of cleanups.splice(0).reverse()) try { remove() } catch { /* best effort */ }
    try { renderer?.destroy() } catch { /* best effort */ }
    renderer = undefined
    cleanupTask = (async () => {
      try { await controller?.close() } catch { /* local input is already revoked; preserve managed session */ }
      state = reduceTui(state, { type: "closed" })
      if (diagnostic) writer(`Error: ${diagnostic}\n`)
      finish?.(code)
    })()
    return cleanupTask
  }
  const close = (): void => { void cleanup(0) }
  const fatal = (error: unknown): void => {
    const message = safeDiagnostic(error)
    try { dispatch({ type: "fatal", message }) } finally { void cleanup(1, message) }
  }

  const reportResult = <T>(result: Result<T>): result is { readonly ok: true; readonly value: T } => {
    if (result.ok) return true
    dispatch({ type: "set-notice", notice: result.error?.message ?? "The operation was rejected safely." })
    return false
  }
  const busy = async (label: string, work: () => Promise<void>): Promise<void> => {
    if (state.pending || closed) return
    dispatch({ type: "set-pending", pending: label })
    try { await work() } catch (error) { if (!closed) dispatch({ type: "set-notice", notice: safeServiceError(error) }) }
    finally { if (!closed) dispatch({ type: "set-pending", pending: null }) }
  }

  const refreshProjects = async (): Promise<void> => {
    const result = await deps.service.execute({ type: "projects.list", correlationId: deps.correlationId })
    if (closed) return
    if (!reportResult(result)) {
      dispatch({ type: "loaded", snapshot: { workflow: "project-selection", screen: "projects", title: "Local projects", detail: [], status: "ERROR", canRefresh: true } })
      return
    }
    dispatch({ type: "projects-loaded", projects: result.value })
    const recovered = await deps.service.execute({
      type: "sessions.recover",
      operationId: operationId(),
      correlationId: deps.correlationId,
      clientId: terminalClientId,
    })
    if (!closed && recovered.ok) dispatch({ type: "recoveries-loaded", recoveries: recovered.value.sessions })
    // Preserve M1.2's simple loading snapshot for legacy consumers.
    dispatch({ type: "loaded", snapshot: { workflow: "project-selection", screen: "projects", title: "Local projects", detail: [], status: "READY", canRefresh: true } })
  }
  const selectProject = async (project: ProjectSummary, index: number): Promise<boolean> => {
    const result = await deps.service.execute({ type: "projects.select", projectId: project.projectId, correlationId: deps.correlationId })
    if (closed) return false
    if (!reportResult(result)) return false
    dispatch({ type: "project-selected", project: result.value.project, index })
    return true
  }
  const createDraft = async (): Promise<void> => {
    const project = state.selectedProject
    if (!project) { dispatch({ type: "set-notice", notice: "Select an authorized project first." }); return }
    await busy("Creating one-task draft…", async () => {
      if (!await selectProject(project, state.selectedProjectIndex)) return
      const result = await deps.service.execute({ type: "draft.create", operationId: operationId(), correlationId: deps.correlationId, projectId: project.projectId })
      if (reportResult(result)) dispatch({ type: "draft-loaded", draft: result.value })
    })
  }
  const saveDraftAndReview = async (): Promise<void> => {
    const draft = state.draft
    const fieldsNow = state.draftFields
    if (!draft || !fieldsNow) { dispatch({ type: "set-notice", notice: "Create a draft before reviewing a proposal." }); return }
    const required: ReadonlyArray<readonly [TuiDraftField, string]> = [
      ["goal", "Goal"], ["taskTitle", "Task title"], ["taskDescription", "Task description"], ["prompt", "Prompt"],
    ]
    const missing = required.find(([field]) => String(fieldsNow[field] ?? "").trim().length === 0)
    if (missing) {
      dispatch({ type: "set-notice", notice: `${missing[1]} is required.` })
      dispatch({ type: "focus-field", field: missing[0] })
      return
    }
    if (!Number.isSafeInteger(fieldsNow.timeoutSeconds) || fieldsNow.timeoutSeconds < 1 || fieldsNow.timeoutSeconds > 86_400) {
      dispatch({ type: "set-notice", notice: "Timeout must be a whole number from 1 to 86400 seconds." })
      dispatch({ type: "focus-field", field: "timeoutSeconds" })
      return
    }
    await busy("Building immutable dispatch proposal…", async () => {
      const prior = state.run?.draft.runId === draft.runId
        && state.run.draft.projectId === draft.projectId
        && state.run.draft.taskId === draft.taskId
        ? state.run.currentProposal
        : undefined
      if (prior) {
        const revised = await deps.service.execute({ type: "proposal.revise", operationId: operationId(), correlationId: deps.correlationId, runId: draft.runId, dispatchId: prior.dispatch.envelope.dispatchId, envelopeDigest: prior.dispatch.envelopeDigest, patch: fieldsNow })
        if (reportResult(revised)) dispatch({ type: "run-loaded", run: revised.value, screen: "proposal" })
        return
      }
      let revision = draft.revision
      if (state.draftDirty) {
        const edited = await deps.service.execute({ type: "draft.edit", operationId: operationId(), correlationId: deps.correlationId, runId: draft.runId, expectedRevision: revision, patch: fieldsNow })
        if (!reportResult(edited)) return
        revision = edited.value.revision
        dispatch({ type: "draft-loaded", draft: edited.value })
      }
      const created = await deps.service.execute({ type: "proposal.create", operationId: operationId(), correlationId: deps.correlationId, runId: draft.runId, expectedRevision: revision })
      if (reportResult(created)) dispatch({ type: "run-loaded", run: created.value, screen: "proposal" })
    })
  }
  const decideAndLaunch = async (): Promise<void> => {
    const run = state.run
    const proposal = run?.currentProposal
    if (!run || !proposal) return
    await busy("Recording approval and admitting launch…", async () => {
      // Bind all decision fields to the exact proposal presented in the modal.
      const decision = await deps.service.execute({ type: "proposal.decide", operationId: operationId(), correlationId: deps.correlationId, runId: run.draft.runId, dispatchId: proposal.dispatch.envelope.dispatchId, attempt: proposal.dispatch.envelope.attempt, envelopeDigest: proposal.dispatch.envelopeDigest, decision: "approved", userId })
      if (!reportResult(decision)) return
      const approved = decision.value.currentProposal
      if (!approved?.approval || approved.approval.decision !== "approved") { dispatch({ type: "set-notice", notice: "Approval was not recorded; launch remains blocked." }); return }
      const launch = await deps.service.execute({ type: "dispatch.launch", operationId: operationId(), correlationId: deps.correlationId, runId: run.draft.runId, dispatchId: approved.dispatch.envelope.dispatchId, envelopeDigest: approved.dispatch.envelopeDigest, approvalId: approved.approval.approvalId })
      if (!reportResult(launch)) return
      dispatch({ type: "run-loaded", run: launch.value.snapshot, screen: launch.value.outcome === "started" ? "session" : "proposal" })
      if (launch.value.outcome === "unknown") dispatch({ type: "set-notice", notice: "Launch outcome unknown. Reconcile; do not retry launch." })
    })
  }
  const reject = async (): Promise<void> => {
    const run = state.run; const proposal = run?.currentProposal
    if (!run || !proposal) return
    await busy("Recording rejection…", async () => {
      const result = await deps.service.execute({ type: "proposal.decide", operationId: operationId(), correlationId: deps.correlationId, runId: run.draft.runId, dispatchId: proposal.dispatch.envelope.dispatchId, attempt: proposal.dispatch.envelope.attempt, envelopeDigest: proposal.dispatch.envelopeDigest, decision: "rejected", userId })
      if (reportResult(result)) dispatch({ type: "run-loaded", run: result.value, screen: "proposal" })
    })
  }
  const beginRevision = async (): Promise<void> => {
    const run = state.run
    const proposal = run?.currentProposal
    if (!run || !proposal) return
    await busy("Invalidating prior approval…", async () => {
      const result = await deps.service.execute({
        type: "proposal.begin-revision",
        operationId: operationId(),
        correlationId: deps.correlationId,
        runId: run.draft.runId,
        dispatchId: proposal.dispatch.envelope.dispatchId,
        envelopeDigest: proposal.dispatch.envelopeDigest,
      })
      if (reportResult(result)) dispatch({ type: "draft-loaded", draft: result.value.draft })
    })
  }
  const control = async (kind: "run.cancel" | "session.terminate"): Promise<void> => {
    const run = state.run
    if (!run) return
    await busy(kind === "run.cancel" ? "Cancelling run…" : "Terminating session…", async () => {
      const result = kind === "run.cancel"
        ? await deps.service.execute({ type: "run.cancel", operationId: operationId(), correlationId: deps.correlationId, runId: run.draft.runId, reason: "Requested from local TUI." })
        : await deps.service.execute({ type: "session.terminate", operationId: operationId(), correlationId: deps.correlationId, runId: run.draft.runId, reason: "Requested from local TUI." })
      if (reportResult(result)) dispatch({ type: "run-loaded", run: result.value.snapshot, screen: "session" })
    })
  }
  const refresh = async (): Promise<void> => {
    if (state.screen === "projects") { await busy("Refreshing authorized projects…", refreshProjects); return }
    if (state.screen === "terminal" && terminalController) {
      await busy("Refreshing terminal output…", async () => { reportResult(await terminalController!.refreshOutput()) })
      return
    }
    const run = state.run
    if (!run) return
    await busy("Refreshing session state…", async () => {
      const result = run.session
        ? await deps.service.execute({ type: "session.refresh", operationId: operationId(), correlationId: deps.correlationId, runId: run.draft.runId })
        : await deps.service.execute({ type: "run.get", correlationId: deps.correlationId, runId: run.draft.runId })
      if (reportResult(result)) dispatch({ type: "run-loaded", run: result.value, screen: state.screen })
    })
  }
  const reviewResult = async (): Promise<void> => {
    const run = state.run
    if (!run) return
    await busy("Reading verified result evidence…", async () => {
      const result = await deps.service.execute({ type: "result.get", operationId: operationId(), correlationId: deps.correlationId, runId: run.draft.runId })
      if (reportResult(result)) dispatch({ type: "run-loaded", run: result.value.snapshot, screen: "result" })
    })
  }
  const attachTerminal = async (): Promise<void> => {
    const run = state.run
    if (!run?.session?.terminalId) {
      dispatch({ type: "set-notice", notice: "No verified terminal binding is available for this session." })
      return
    }
    if (!deps.terminalConnector) {
      dispatch({ type: "set-notice", notice: "The local terminal connector is unavailable." })
      return
    }
    await busy("Attaching terminal read-only…", async () => {
      await terminalController?.close()
      terminalController = null
      const opened = await deps.terminalConnector!.open(run, {
        render: (model) => dispatch({ type: "terminal-view", model }),
      })
      if (!reportResult(opened)) return
      terminalController = opened.value
      recoveryMutationAllowed = true
      dispatch({ type: "terminal-view", model: opened.value.getViewModel() })
      dispatch({ type: "navigate", screen: "terminal" })
      startTerminalPolling()
    })
  }
  const attachRecovery = async (recovery: RecoverySummary): Promise<void> => {
    if (!deps.terminalConnector) {
      dispatch({ type: "set-notice", notice: "The local terminal connector is unavailable." })
      return
    }
    await busy("Recovering terminal read-only…", async () => {
      await terminalController?.close()
      terminalController = null
      const opened = await deps.terminalConnector!.openRecovery(recovery, {
        render: (model) => dispatch({ type: "terminal-view", model }),
      })
      if (!reportResult(opened)) return
      terminalController = opened.value
      recoveryMutationAllowed = recovery.mutationAllowed
      dispatch({ type: "terminal-view", model: opened.value.getViewModel() })
      dispatch({ type: "navigate", screen: "terminal" })
      startTerminalPolling()
    })
  }
  const detachTerminal = async (): Promise<void> => {
    stopTerminalPolling()
    const controller = terminalController
    terminalController = null
    if (controller) await controller.detach()
    dispatch({ type: "terminal-view", model: null })
    dispatch({ type: "navigate", screen: "session" })
  }
  const requestTerminalInput = async (): Promise<void> => {
    if (!terminalController) return
    if (!recoveryMutationAllowed) {
      dispatch({ type: "set-notice", notice: "Recovered terminal history is incomplete; mutation remains disabled." })
      return
    }
    const result = await terminalController.requestInput()
    if (!reportResult(result)) return
    dispatch({ type: "terminal-view", model: terminalController.getViewModel() })
  }
  const confirmTakeover = async (): Promise<void> => {
    if (!terminalController) return
    const result = await terminalController.confirmTakeover(state.takeoverReason)
    if (reportResult(result)) {
      dispatch({ type: "dismiss-overlay" })
      dispatch({ type: "takeover-reason", reason: "" })
      dispatch({ type: "terminal-view", model: terminalController.getViewModel() })
    }
  }
  const respondToPermission = async (): Promise<void> => {
    const run = state.run
    const request = run?.pendingRequest
    const decision = state.permissionDecision
    if (!run || !request || !decision) return
    await busy("Submitting permission response…", async () => {
      const result = await deps.service.execute({
        type: "session.respond",
        operationId: operationId(),
        correlationId: deps.correlationId,
        runId: run.draft.runId,
        requestId: request.requestId,
        decision,
      })
      if (reportResult(result)) {
        dispatch({ type: "run-loaded", run: result.value.snapshot, screen: "session" })
        dispatch({ type: "permission-decision", decision: null })
      }
    })
  }
  const editKey = (key: TuiKey): boolean => {
    const field = state.focusedField; const value = state.draftFields
    if (!field || !value) return false
    if (key.name === "escape") { dispatch({ type: "focus-field", field: null }); return true }
    if (key.name === "tab") {
      if ((!key.shift && field === fields.at(-1)) || (key.shift && field === fields[0])) {
        dispatch({ type: "focus-action", action: key.shift ? "back" : "review-proposal" })
      } else dispatch({ type: "focus-field", field: nextField(field, key.shift) })
      return true
    }
    if (key.name === "backspace") {
      const previous = field === "timeoutSeconds" ? String(value[field]).slice(0, -1) : String(value[field] ?? "").slice(0, -1)
      const updated = field === "timeoutSeconds" ? Number(previous || 0) : previous
      dispatch({ type: "draft-changed", fields: { ...value, [field]: updated } as DraftFields }); return true
    }
    const text = key.sequence ?? (key.name.length === 1 ? key.name : "")
    if (!text || key.ctrl) return true
    const updated = field === "timeoutSeconds" ? Number(`${value[field]}${text}`.replace(/[^0-9]/g, "")) : `${value[field] ?? ""}${text}`
    dispatch({ type: "draft-changed", fields: { ...value, [field]: updated } as DraftFields }); return true
  }
  const handlePaste = (bytes: Uint8Array): void => {
    if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024 || closed || state.shell !== "ready") return
    if (state.screen === "terminal" && state.terminalView?.mode === "input-owned") {
      void terminalController?.sendInput(bytes)
      return
    }
    const field = state.focusedField
    const value = state.draftFields
    if (!field || !value) return
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
    const normalized = field === "prompt" || field === "taskDescription" ? text : text.replace(/[\r\n]+/g, " ")
    const updated = field === "timeoutSeconds"
      ? Number(`${value[field]}${normalized}`.replace(/[^0-9]/g, ""))
      : `${value[field] ?? ""}${normalized}`
    dispatch({ type: "draft-changed", fields: { ...value, [field]: updated } as DraftFields })
  }
  const confirmOverlay = (): void => {
    switch (state.overlay) {
      case "approval-confirmation": void decideAndLaunch(); break
      case "rejection-confirmation": void reject(); break
      case "cancel-confirmation": void control("run.cancel"); break
      case "termination-confirmation": void control("session.terminate"); break
      case "discard-confirmation": dispatch({ type: "discard-draft" }); break
      case "takeover-confirmation": void confirmTakeover(); break
      case "permission-confirmation": void respondToPermission(); break
      default: dispatch({ type: "dismiss-overlay" })
    }
  }
  const availableActions = (): TuiActionControl[] => {
    switch (state.screen) {
      case "projects": return state.selectedProject ? ["select-project", "new-run", "refresh"] : ["refresh"]
      case "draft": return ["review-proposal", "back"]
      case "proposal": return ["toggle-detail", "approve", "reject", "revise", "back"]
      case "session": return [
        ...(state.run?.pendingRequest ? ["allow-once", "deny"] as const : []),
        ...(state.run?.session?.terminalId ? ["terminal"] as const : []),
        "refresh", "result", "cancel", "terminate", "back",
      ]
      case "terminal": return ["request-input", "takeover", "detach"]
      case "result": return ["back"]
    }
  }
  const activateAction = (action: TuiActionControl): void => {
    switch (action) {
      case "select-project": if (state.selectedProject) void busy("Selecting project…", async () => { await selectProject(state.selectedProject!, state.selectedProjectIndex) }); return
      case "new-run": void createDraft(); return
      case "review-proposal": void saveDraftAndReview(); return
      case "toggle-detail": dispatch({ type: "toggle-proposal-detail" }); return
      case "approve": dispatch({ type: "set-overlay", overlay: "approval-confirmation" }); return
      case "reject": dispatch({ type: "set-overlay", overlay: "rejection-confirmation" }); return
      case "revise": void beginRevision(); return
      case "refresh": void refresh(); return
      case "terminal": void attachTerminal(); return
      case "result": void reviewResult(); return
      case "cancel": dispatch({ type: "set-overlay", overlay: "cancel-confirmation" }); return
      case "terminate": dispatch({ type: "set-overlay", overlay: "termination-confirmation" }); return
      case "allow-once": dispatch({ type: "permission-decision", decision: "allow_once" }); dispatch({ type: "set-overlay", overlay: "permission-confirmation" }); return
      case "deny": dispatch({ type: "permission-decision", decision: "deny" }); dispatch({ type: "set-overlay", overlay: "permission-confirmation" }); return
      case "request-input": void requestTerminalInput(); return
      case "takeover": {
        if (!terminalController) return
        const begun = terminalController.beginTakeover(state.terminalView?.ownerLabel ?? "another client")
        if (reportResult(begun)) { dispatch({ type: "takeover-reason", reason: "" }); dispatch({ type: "set-overlay", overlay: "takeover-confirmation" }) }
        return
      }
      case "detach": void detachTerminal(); return
      case "back":
        if (state.screen === "terminal") void detachTerminal()
        else if (state.screen === "draft" && state.draftDirty) dispatch({ type: "set-overlay", overlay: "discard-confirmation" })
        else dispatch({ type: "navigate", screen: state.screen === "result" ? "session" : "projects" })
    }
  }
  const destructiveOverlayLabel = (): string | undefined => {
    switch (state.overlay) {
      case "approval-confirmation": return "Approve and start"
      case "rejection-confirmation": return "Reject"
      case "cancel-confirmation": return "Cancel run"
      case "termination-confirmation": return "Terminate"
      case "discard-confirmation": return "Discard draft"
      case "takeover-confirmation": return "Take over input"
      case "permission-confirmation": return "Submit response"
      default: return undefined
    }
  }
  const handleMouseUp = (x: number, y: number): void => {
    if (closed || state.shell !== "ready") return
    const lines = buildTuiView(state).split("\n")
    const line = lines[y]
    if (line === undefined) return
    const label = destructiveOverlayLabel()
    if (label === undefined) return

    // Mouse activation is intentionally limited to exact, state-derived modal
    // controls. Rendered project/task/provider text is untrusted and must never
    // become an action target merely because it contains a control-like label.
    if (state.confirmationArmed) {
      if (!line.startsWith(`Back  [${label}]`)) return
      if (x >= 0 && x < "Back".length) {
        dispatch({ type: "dismiss-overlay" })
        return
      }
      const start = "Back  ".length
      if (x >= start && x < start + `[${label}]`.length) confirmOverlay()
      return
    }

    if (!line.startsWith(`[Back]  ${label}`)) return
    if (x >= 0 && x < "[Back]".length) {
      dispatch({ type: "dismiss-overlay" })
      return
    }
    const start = "[Back]  ".length
    if (x >= start && x < start + label.length) dispatch({ type: "set-confirmation-armed", armed: true })
  }
  const handleKey = (key: TuiKey): void => {
    // The minimum-size fallback is deliberately effect-free. In particular,
    // a remembered shortcut must not approve, launch, or forward input while
    // the UI cannot show its binding and confirmation state safely.
    if (state.shell === "too-small") {
      terminalController?.revokeInput("Viewport below 60x18")
      if (key.name === "q" || (key.ctrl && key.name.toLowerCase() === "c")) close()
      return
    }
    if (state.shell !== "ready") return
    if (state.screen === "terminal" && state.terminalView?.mode === "input-owned") {
      const bytes = key.ctrl && key.name === "]"
        ? Uint8Array.of(0x1d)
        : new TextEncoder().encode(key.sequence ?? (key.ctrl && key.name.toLowerCase() === "c" ? "\u0003" : key.name.length === 1 ? key.name : ""))
      if (bytes.byteLength > 0) void terminalController?.sendInput(bytes)
      return
    }
    if (key.ctrl && key.name.toLowerCase() === "c") { close(); return }
    if (key.ctrl && key.name.toLowerCase() === "d") { close(); return }
    if (!state.focusedField && key.name === "q") {
      if (state.draftDirty) dispatch({ type: "set-overlay", overlay: "discard-confirmation" })
      else close()
      return
    }
    if (state.pending) return
    if (state.overlay !== "none") {
      if (key.name === "pageup" || key.name === "pagedown") {
        dispatch({ type: "scroll", delta: key.name === "pageup" ? -Math.max(1, state.dimensions.rows - 4) : Math.max(1, state.dimensions.rows - 4) })
        return
      }
      if (state.overlay === "takeover-confirmation" && !state.confirmationArmed) {
        if (key.name === "backspace") {
          dispatch({ type: "takeover-reason", reason: state.takeoverReason.slice(0, -1) })
          return
        }
        const text = key.sequence ?? (key.name.length === 1 ? key.name : "")
        if (text && !key.ctrl && key.name !== "tab" && key.name !== "enter" && key.name !== "escape") {
          dispatch({ type: "takeover-reason", reason: `${state.takeoverReason}${text}`.slice(0, 1024) })
          return
        }
      }
      if (key.name === "escape") dispatch({ type: "dismiss-overlay" })
      else if (key.name === "tab" && state.overlay !== "help") dispatch({ type: "set-confirmation-armed", armed: !key.shift })
      else if (key.name === "enter" && state.overlay !== "help") {
        if (state.confirmationArmed) confirmOverlay()
        else dispatch({ type: "dismiss-overlay" })
      }
      else if (key.name === "f1" || key.name === "?") dispatch({ type: "dismiss-overlay" })
      return
    }
    if (editKey(key)) return
    if (key.name === "tab") {
      const actions = availableActions()
      if (actions.length === 0) return
      if (state.screen === "draft" && state.draftFields) {
        if (state.focusedAction === null) {
          dispatch({ type: "focus-field", field: key.shift ? fields.at(-1)! : fields[0]! })
          return
        }
        const current = actions.indexOf(state.focusedAction)
        if ((!key.shift && current === actions.length - 1) || (key.shift && current === 0)) {
          dispatch({ type: "focus-field", field: key.shift ? fields.at(-1)! : fields[0]! })
          return
        }
      }
      const current = state.focusedAction === null ? -1 : actions.indexOf(state.focusedAction)
      const delta = key.shift ? -1 : 1
      const index = (current + delta + actions.length) % actions.length
      dispatch({ type: "focus-action", action: actions[index]! })
      return
    }
    if ((key.name === "pageup" || key.name === "pagedown") && state.screen === "proposal" && state.fullProposal) {
      dispatch({ type: "scroll", delta: key.name === "pageup" ? -Math.max(1, state.dimensions.rows - 6) : Math.max(1, state.dimensions.rows - 6) })
      return
    }
    if (key.name === "escape") {
      if (state.screen === "terminal") void detachTerminal()
      else if (state.screen === "result") dispatch({ type: "navigate", screen: "session" })
      else if (state.screen === "draft" && state.draftDirty) dispatch({ type: "set-overlay", overlay: "discard-confirmation" })
      else dispatch({ type: "navigate", screen: "projects" })
      return
    }
    if (key.name === "up" || key.name === "down") {
      if (state.screen === "projects" && state.projects.length) {
        const delta = key.name === "up" ? -1 : 1
        const index = (state.selectedProjectIndex + delta + state.projects.length) % state.projects.length
        dispatch({ type: "project-selected", project: state.projects[index]!, index })
      }
      return
    }
    if (key.name === "enter") {
      if (state.focusedAction) { activateAction(state.focusedAction); return }
      if (state.screen === "projects" && state.selectedProject) void busy("Selecting project…", async () => { await selectProject(state.selectedProject!, state.selectedProjectIndex) })
      else if (state.screen === "draft") void saveDraftAndReview()
      else if (state.screen === "proposal") dispatch({ type: "toggle-proposal-detail" })
      else if (state.screen === "result") dispatch({ type: "navigate", screen: "session" })
      return
    }
    switch (key.name) {
      case "n":
        if (state.screen === "projects") void createDraft()
        else if (state.screen === "session" && state.run?.pendingRequest) {
          dispatch({ type: "permission-decision", decision: "deny" })
          dispatch({ type: "set-overlay", overlay: "permission-confirmation" })
        }
        return
      case "a": if (state.screen === "proposal" && state.run?.currentProposal?.dispatch.state === "proposed") dispatch({ type: "set-overlay", overlay: "approval-confirmation" }); return
      case "r":
        if (state.screen === "proposal" && state.run?.currentProposal?.dispatch.state === "proposed") dispatch({ type: "set-overlay", overlay: "rejection-confirmation" })
        else if (state.screen === "projects" && state.recoveries[0]) void attachRecovery(state.recoveries[0])
        return
      case "e": if (state.screen === "proposal" && state.run) void beginRevision(); return
      case "c": if (state.run) dispatch({ type: "set-overlay", overlay: "cancel-confirmation" }); return
      case "x": if (state.screen === "session" && state.run?.session) dispatch({ type: "set-overlay", overlay: "termination-confirmation" }); return
      case "1": if (state.screen === "session" && state.run?.pendingRequest) {
        dispatch({ type: "permission-decision", decision: "allow_once" })
        dispatch({ type: "set-overlay", overlay: "permission-confirmation" })
        return
      }
      case "v": if (state.screen === "session") void reviewResult(); return
      case "t": if (state.screen === "session" && state.run?.session?.terminalId) void attachTerminal(); return
      case "i": if (state.screen === "terminal") void requestTerminalInput(); return
      case "o": if (state.screen === "terminal" && terminalController) {
        const owner = state.terminalView?.ownerLabel ?? "another client"
        const begun = terminalController.beginTakeover(owner)
        if (reportResult(begun)) {
          dispatch({ type: "takeover-reason", reason: "" })
          dispatch({ type: "set-overlay", overlay: "takeover-confirmation" })
        }
        return
      }
      case "d": if (state.screen === "terminal") void detachTerminal(); return
      case "f": void refresh(); return
      case "q": if (state.draftDirty) dispatch({ type: "set-overlay", overlay: "discard-confirmation" }); else close(); return
    }
    const intent = routeTuiKey(state, key)
    if (intent.type === "close") close()
    else if (intent.type === "refresh") void refresh()
    else if (intent.type === "dispatch") dispatch(intent.action)
  }

  return {
    async run(_profile: string): Promise<0 | 1> {
      if (closed) return 0
      return new Promise<0 | 1>((resolve) => {
        finish = resolve
        void (async () => {
          try {
            const created = await rendererFactory.create()
            if (closed) { created.destroy(); return }
            renderer = created
            state = initialTuiState(renderer.dimensions)
            cleanups.push(renderer.onKey((key) => handleKey({ name: key.name === "return" ? "enter" : key.name, ctrl: key.ctrl, sequence: key.sequence, shift: key.shift })))
            cleanups.push(renderer.onPaste((event) => handlePaste(event.bytes)))
            cleanups.push(renderer.onMouseUp((event) => handleMouseUp(event.x, event.y)))
            cleanups.push(renderer.onResize((dimensions: TuiDimensions) => {
              dispatch({ type: "resize", dimensions })
              if (dimensions.columns < 60 || dimensions.rows < 18) terminalController?.revokeInput("Viewport below 60x18")
              else terminalController?.resizeContent({ columns: Math.max(1, dimensions.columns - 2), rows: Math.max(1, dimensions.rows - 8) })
            }))
            cleanups.push(renderer.onRenderError((error) => fatal(error)))
            for (const signal of PROCESS_SIGNALS) { const handler = (): void => close(); signals.on(signal, handler); cleanups.push(() => signals.off(signal, handler)) }
            render()
            await refreshProjects()
          } catch (error) { fatal(error) }
        })()
      })
    },
    close,
    getState: () => state,
  }
}
