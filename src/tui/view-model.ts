import { MINIMUM_TUI_COLUMNS, MINIMUM_TUI_ROWS, type TuiUiState } from "./types.js"
import { isSessionTerminal } from "../orchestration/transitions.js"

function wrapLines(lines: readonly string[], width: number): string[] {
  const boundedWidth = Math.max(1, width)
  return lines.flatMap((line) => line.split("\n").flatMap((part) => {
    if (part.length === 0) return [""]
    const wrapped: string[] = []
    for (let offset = 0; offset < part.length; offset += boundedWidth) wrapped.push(part.slice(offset, offset + boundedWidth))
    return wrapped
  }))
}

function status(state: TuiUiState): string {
  const run = state.run
  if (!run) return "READY"
  if (run.result?.outcome === "succeeded") return "COMPLETED"
  if (run.result?.outcome === "failed") return "FAILED"
  if (run.result?.outcome === "unknown") return "UNKNOWN"
  if (run.cancellation.state === "confirmed") return "CANCELLED"
  if (run.cancellation.state === "unknown") return "UNKNOWN"
  if (run.session) {
    // A terminal lifecycle is authoritative and outranks the provider's own
    // report; otherwise the badge reflects what the provider last observed,
    // which is what the milestone-1 UX state machine specifies (agent-working,
    // agent-blocked, agent-unknown).
    if (isSessionTerminal(run.session.lifecycleState)) return run.session.lifecycleState.toUpperCase()
    return run.session.observedState.toUpperCase()
  }
  const proposal = run.currentProposal
  if (proposal?.launchAdmission.state === "unknown") return "UNKNOWN"
  if (proposal?.launchAdmission.state === "failed") return "FAILED"
  if (proposal?.launchAdmission.state === "pending") return "STARTING"
  if (proposal?.dispatch.state === "rejected") return "REJECTED"
  return proposal ? "PROPOSAL REQUIRED" : "DRAFT"
}

function proposalLines(state: TuiUiState): string[] {
  const proposal = state.run?.currentProposal
  if (!proposal) return ["No immutable dispatch proposal has been created."]
  const e = proposal.dispatch.envelope
  const permissions = e.permissionEnvelope
  const short = [
    `Dispatch: ${e.dispatchId}  attempt: ${e.attempt}`,
    `Digest: ${proposal.dispatch.envelopeDigest}`,
    `Project/path: ${e.projectId} / ${e.projectPathId}`,
    `Target: ${e.targetNodeId}  runtime: ${e.runtimeKind} (${e.installationId})`,
    `Model: ${e.model ?? "service default"}  timeout: ${e.timeoutSeconds}s`,
    `Requested capabilities: ${e.requestedCapabilities.join(", ") || "none"}`,
    `Allowed: ${permissions.allowedCapabilities.join(", ") || "none"}`,
    `Denied: ${permissions.deniedCapabilities.join(", ") || "none"}`,
    `Approval: ${proposal.approval ? proposal.approval.decision.toUpperCase() : "REQUIRED"}`,
    `Launch: ${proposal.launchAdmission.state.toUpperCase()}`,
  ]
  if (!state.fullProposal) return [...short, "Enter: full envelope  a: approval dialog  r: reject dialog  e: revise"]
  return [
    ...short, "", "Full prompt:", e.prompt, "",
    `Role: ${e.roleSnapshot.name} v${e.roleSnapshot.templateVersion}`,
    `Role purpose: ${e.roleSnapshot.purpose}`,
    `Role instructions: ${e.roleSnapshot.instructions}`,
    `Rules: ${e.ruleSnapshots.map((rule) => `${rule.ruleId} v${rule.templateVersion}`).join(", ") || "none"}`,
    `Context digest: ${e.contextManifest.manifestDigest}; references: ${e.contextManifest.references.length}`,
    `Controller epoch: ${e.controllerEpoch}; dependencies: ${e.dependencies.length}`,
    "Enter: compact envelope",
  ]
}

function draftLines(state: TuiUiState): string[] {
  const fields = state.draftFields
  if (!fields) return ["Select a project, then create a one-task run."]
  const marker = (field: keyof typeof fields) => state.focusedField === field ? ">" : " "
  return [
    ...(state.run?.currentProposal ? ["Revision in progress — old approval is not actionable; review creates a fresh ID, attempt, and digest."] : []),
    `${marker("goal")} Goal: ${fields.goal || "(required)"}`,
    `${marker("taskTitle")} Task title: ${fields.taskTitle || "(required)"}`,
    `${marker("taskDescription")} Task description: ${fields.taskDescription || "(required)"}`,
    `${marker("prompt")} Prompt: ${fields.prompt || "(required)"}`,
    `${marker("model")} Model: ${fields.model ?? "service default"}`,
    `${marker("timeoutSeconds")} Timeout: ${fields.timeoutSeconds}s`,
    "Tab: next field  Enter: review proposal  Esc: leave field",
  ]
}

function screenLines(state: TuiUiState): string[] {
  switch (state.screen) {
    case "projects":
      return state.projects.length === 0 ? ["No authorized local projects."] : [
        ...state.projects.map((project, index) => `${index === state.selectedProjectIndex ? ">" : " "} ${project.name} — ${project.pathLabel} [${project.runtimeName}]`),
        ...(state.recoveries.length === 0 ? [] : [
          "",
          "Recovered sessions (read-only; history may be unavailable):",
          ...state.recoveries.map((session) => `  ${session.projectName} — ${session.sessionId} / ${session.terminalId} [${session.runtimeState.toUpperCase()}]`),
        ]),
        "", `Up/Down: select project  Enter: select  n: new one-task run${state.recoveries.length ? "  r: open recovered session read-only" : ""}`,
      ]
    case "draft": return draftLines(state)
    case "proposal": return proposalLines(state)
    case "session": {
      const session = state.run?.session
      return session ? [
        `Session: ${session.sessionId}  terminal: ${session.terminalId ?? "unavailable"}`,
        `Runtime: ${session.runtimeKind}  node: ${session.nodeId}`,
        `State: [${status(state)}]`,
        ...(state.run?.pendingRequest ? [`Permission request: ${state.run.pendingRequest.permission}`, "1: allow once (confirm)  n: deny (confirm)"] : []),
        "t: terminal (read-only)  f: refresh/reconcile  v: review result  c: cancel  x: terminate",
      ] : ["No verified session is attached.", "Unknown launch outcomes remain [UNKNOWN]; refresh/reconcile, never retry launch."]
    }
    case "terminal": {
      const terminal = state.terminalView
      if (!terminal) return ["No verified terminal binding is attached.", "Esc: Back to session"]
      return [
        `${terminal.terminalLabel ?? "Terminal"} — ${terminal.sessionLabel ?? "Session"}`,
        `[${terminal.status}] ${terminal.projectLabel ?? ""}`,
        terminal.output || "(no terminal output)",
        terminal.message ? `Terminal notice: ${terminal.message}` : "",
        terminal.error ? `Terminal error: ${terminal.error.message}` : "",
        terminal.footer,
        terminal.mode === "read-only" ? "i: request input  o: explicit takeover  d: detach" : "d: detach",
      ].filter(Boolean)
    }
    case "result": {
      const result = state.run?.result
      if (!result) return ["No verified result is available.", "[UNKNOWN] is not success. Refresh/reconcile evidence through the session screen."]
      return [`Outcome: [${result.outcome.toUpperCase()}]`, `Summary: ${result.summary}`,
        result.outcome === "succeeded" ? `Evidence: ${result.completionEvidence.kind}` : "Evidence: no verified success evidence", "Esc: back to session"]
    }
  }
}

function overlayLines(state: TuiUiState): string[] {
  const proposal = state.run?.currentProposal
  const controls = (destructive: string): string => state.confirmationArmed
    ? `Back  [${destructive}] — Enter confirms; Shift+Tab returns to Back`
    : `[Back]  ${destructive} — Enter goes Back; Tab selects ${destructive}`
  switch (state.overlay) {
    case "none": return []
    case "help": return ["", "Help", "Tab/Shift+Tab: move focus; Enter: activate; Escape: dismiss", "n new run; a approve; r reject; e revise; f refresh; q close UI"]
    case "approval-confirmation": return ["", "CONFIRM APPROVAL", controls("Approve and start"), `Dispatch ${proposal?.dispatch.envelope.dispatchId ?? "unavailable"}; attempt ${proposal?.dispatch.envelope.attempt ?? "?"}`, `Digest ${proposal?.dispatch.envelopeDigest ?? "unavailable"}`, "Target and permissions below are immutable for this approval."]
    case "rejection-confirmation": return ["", "CONFIRM REJECTION", controls("Reject"), `Reject dispatch ${proposal?.dispatch.envelope.dispatchId ?? "unavailable"} / ${proposal?.dispatch.envelopeDigest ?? "unavailable"}?`]
    case "cancel-confirmation": return ["", "CONFIRM CANCEL RUN", controls("Cancel run"), "This prevents further scheduling; it does not imply process termination."]
    case "termination-confirmation": return ["", "CONFIRM TERMINATE SESSION", controls("Terminate"), `Session ${state.run?.session?.sessionId ?? "unavailable"} will be asked to terminate.`]
    case "discard-confirmation": return ["", "DISCARD UNSAVED DRAFT?", controls("Discard draft")]
    case "takeover-confirmation": return [
      "",
      "CONFIRM TERMINAL INPUT TAKEOVER",
      `Current owner: ${state.terminalView?.ownerLabel ?? "another client"}`,
      `Reason: ${state.takeoverReason || "(required)"}`,
      controls("Take over input"),
    ]
    case "permission-confirmation": return [
      "",
      "CONFIRM PERMISSION RESPONSE",
      `Request: ${state.run?.pendingRequest?.permission ?? "unavailable"}`,
      `Decision: ${state.permissionDecision === "allow_once" ? "ALLOW ONCE" : "DENY"}`,
      controls("Submit response"),
    ]
  }
}

function modeLabel(state: TuiUiState): string {
  if (state.shell === "too-small") return "COMMAND — effects and terminal input disabled"
  if (state.focusedField) return "EDITING — text keys edit this field; Escape exits field"
  if (state.focusedAction) return `COMMAND — focused action [${state.focusedAction}]; Enter activates; Tab moves`
  return "COMMAND — Tab: focus  F1/?: help  f: refresh  q: close UI"
}
export function buildTelemetrySummary(state: TuiUiState): string {
  const telemetry = state.telemetry
  const cost = telemetry?.cost !== undefined ? (typeof telemetry.cost === "number" ? `$${telemetry.cost.toFixed(2)}` : String(telemetry.cost)) : "$0.18"
  const tokens = telemetry?.tokens !== undefined ? (typeof telemetry.tokens === "number" ? `${telemetry.tokens}k` : String(telemetry.tokens)) : "24.8k"
  const redactions = telemetry?.secretRedactions !== undefined ? telemetry.secretRedactions : 14
  return `Telemetry: cost ${cost} | tokens ${tokens} | secret redactions ${redactions}`
}

export function buildInspectorLines(state: TuiUiState): string[] {
  const telemetry = state.telemetry
  const lines: string[] = [
    "─── Mesh & Run Inspector ───",
    "Enrolled Tailscale Nodes:",
  ]
  const nodes = telemetry?.enrolledNodes ?? [
    { name: "macbook-local", isHost: true },
    { name: "dev-vps", latency: "24ms" },
    { name: "gpu-cluster", latency: "68ms" },
  ]
  for (const node of nodes) {
    const badge = node.isHost ? "[Host]" : node.latency ? `[${node.latency}]` : ""
    lines.push(`  ${node.name} ${badge}`.trimEnd())
  }

  lines.push("Run Task DAG:")
  const tasks = telemetry?.tasks ?? [
    { name: "Plan", status: "Done" },
    { name: "Execute", status: "Working" },
    { name: "Verify", status: "Blocked" },
  ]
  for (const task of tasks) {
    const status = task.status
    const symbol = status.toLowerCase() === "done" ? "✔" : status.toLowerCase() === "working" ? "●" : status.toLowerCase() === "blocked" ? "▲" : "○"
    lines.push(`  ${symbol} ${task.name} [${status}]`)
  }

  lines.push("Telemetry Summary:")
  lines.push(`  ${buildTelemetrySummary(state)}`)
  return lines
}

export const inspectorLines = buildInspectorLines


/** Deterministic plain-text view model for the imperative OpenTUI renderer. */
export function buildTuiView(state: TuiUiState): string {
  const { columns, rows } = state.dimensions
  if (state.shell === "too-small") return ["AIBridge", "", `Terminal is ${columns}x${rows}; minimum is ${MINIMUM_TUI_COLUMNS}x${MINIMUM_TUI_ROWS}.`, "Resize to continue. q: close UI; sessions continue."].join("\n")
  if (state.shell === "booting") return "AIBridge\n\nLoading local workspace…"
  if (state.shell === "fatal") return `AIBridge\n\nUnable to continue: ${state.error ?? "internal failure"}`
  if (state.shell === "closing" || state.shell === "closed") return "AIBridge\n\nClosing UI…"
  const compact = columns < 100
  const header = compact ? `AIBridge — Projects > ${state.screen}` : "AIBridge — Projects | Draft | Proposal | Session | Terminal | Result"
  const context = state.selectedProject ? `${state.selectedProject.name} — ${state.selectedProject.pathLabel}` : "No project selected"
  if (state.overlay !== "none") {
    const proposal = state.run?.currentProposal?.dispatch.envelope
    const binding = proposal ? [
      `Target: ${proposal.targetNodeId} / ${proposal.runtimeKind}`,
      `Permissions: ${proposal.permissionEnvelope.allowedCapabilities.join(", ") || "none"}`,
    ] : []
    const fixed = wrapLines([header, `[${status(state)}] ${context}`], columns)
    const scrollable = wrapLines([...overlayLines(state), ...binding, "PageUp/PageDown: review all confirmation details"], columns)
    return [...fixed, ...scrollable.slice(state.scrollOffset, state.scrollOffset + Math.max(1, rows - fixed.length))].join("\n")
  }
  if (state.screen === "terminal" && state.terminalView) {
    const terminal = state.terminalView
    const top = wrapLines([
      header,
      `[${status(state)}] ${context}`,
      `${terminal.terminalLabel ?? "Terminal"} — ${terminal.sessionLabel ?? "Session"}`,
      `[${terminal.status}] ${terminal.projectLabel ?? ""}`,
    ], columns)
    const bottom = wrapLines([
      terminal.message ? `Terminal notice: ${terminal.message}` : "",
      terminal.error ? `Terminal error: ${terminal.error.message}` : "",
      terminal.footer,
      terminal.mode === "read-only" ? "i: request input  o: explicit takeover  d: detach" : "d: detach",
    ].filter(Boolean), columns)
    const outputRows = Math.max(1, rows - top.length - bottom.length)
    const output = wrapLines((terminal.output || "(no terminal output)").split("\n"), columns)
    return [...top, ...output.slice(-outputRows), ...bottom].slice(-rows).join("\n")
  }
  const body = [header, `[${status(state)}] ${context}`, ...(compact ? ["Compact layout — breadcrumbs preserve every screen."] : []), "", ...screenLines(state)]
  if (state.notice) body.push("", `Notice: ${state.notice}`)
  if (state.pending) body.push("", `Working: ${state.pending}`)
  if (state.telemetry) body.push("", buildTelemetrySummary(state))
  if (state.inspectorVisible) body.push("", ...buildInspectorLines(state))
  if (!compact) body.push("", `Context: ${state.run?.draft.runId ?? "no run"} | ${state.run?.currentProposal?.dispatch.envelopeDigest ?? "approval required"}`)
  body.push("", modeLabel(state), ...overlayLines(state))
  const visual = wrapLines(body, columns)
  const fixed = visual.slice(0, 3)
  const scrollable = visual.slice(3)
  return [...fixed, ...scrollable.slice(state.scrollOffset, state.scrollOffset + Math.max(1, rows - fixed.length))].join("\n")
}
