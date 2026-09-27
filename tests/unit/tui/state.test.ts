import { describe, expect, it } from "vitest"
import {
  buildTuiView,
  initialTuiState,
  reduceTui,
  routeTuiKey,
} from "../../../src/tui/index.js"

const snapshot = {
  workflow: "project-selection" as const,
  screen: "projects" as const,
  title: "Local projects",
  detail: ["No project selected."],
  status: "IDLE",
}

describe("TUI pure reducer and view model", () => {
  it("renders a useful minimum-size fallback without enabling actions", () => {
    const state = reduceTui(initialTuiState({ columns: 59, rows: 18 }), { type: "loaded", snapshot })

    expect(state.shell).toBe("too-small")
    expect(buildTuiView(state)).toContain("minimum is 60x18")
    expect(buildTuiView(state)).toContain("q: close UI; sessions continue")
    expect(routeTuiKey(state, { name: "f" })).toEqual({ type: "none" })
    expect(routeTuiKey(state, { name: "q" })).toEqual({ type: "close" })
  })

  it("preserves state across resize and uses compact/wide navigation layouts", () => {
    let state = reduceTui(initialTuiState({ columns: 100, rows: 18 }), { type: "loaded", snapshot })
    state = reduceTui(state, { type: "navigate", screen: "session" })
    expect(buildTuiView(state)).toContain("Projects | Draft | Proposal")

    state = reduceTui(state, { type: "resize", dimensions: { columns: 60, rows: 18 } })
    expect(state.shell).toBe("ready")
    expect(state.screen).toBe("session")
    expect(buildTuiView(state)).toContain("Compact layout")
  })

  it("routes close, help, refresh, and local navigation without effects", () => {
    const state = reduceTui(initialTuiState({ columns: 100, rows: 30 }), { type: "loaded", snapshot })

    expect(routeTuiKey(state, { name: "c", ctrl: true })).toEqual({ type: "close" })
    expect(routeTuiKey(state, { name: "f" })).toEqual({ type: "refresh" })
    expect(routeTuiKey(state, { name: "?" })).toEqual({ type: "dispatch", action: { type: "toggle-help" } })
    expect(routeTuiKey(state, { name: "t" })).toEqual({ type: "dispatch", action: { type: "navigate", screen: "terminal" } })
  })

  it("clears a new dirty draft and returns a discarded revision to its historical proposal", () => {
    const base = reduceTui(initialTuiState({ columns: 80, rows: 24 }), { type: "loaded", snapshot })
    const draft = {
      projectId: "project-ui", runId: "run-ui", taskId: "task-ui", revision: 1,
      fields: { goal: "g", taskTitle: "t", taskDescription: "d", prompt: "p", timeoutSeconds: 60 }, proposalRequired: true,
    } as any
    const dirty = reduceTui(reduceTui(base, { type: "draft-loaded", draft }), {
      type: "draft-changed", fields: { ...draft.fields, goal: "changed" },
    })
    const discarded = reduceTui(dirty, { type: "discard-draft" })
    expect(discarded).toMatchObject({ screen: "projects", draft: null, draftFields: null, draftDirty: false, overlay: "none" })

    const historical = { ...dirty, run: { draft, currentProposal: { dispatch: {} } } as any }
    const revisionDiscarded = reduceTui(historical, { type: "discard-draft" })
    expect(revisionDiscarded).toMatchObject({ screen: "proposal", draft, draftFields: draft.fields, draftDirty: false, overlay: "none" })

    const nextDraft = { ...draft, runId: "run-next", taskId: "task-next" }
    const nextDirty = reduceTui(reduceTui(historical, { type: "draft-loaded", draft: nextDraft }), {
      type: "draft-changed", fields: { ...nextDraft.fields, goal: "next changed" },
    })
    expect(nextDirty.run).toBeNull()
    const nextDiscarded = reduceTui(nextDirty, { type: "discard-draft" })
    expect(nextDiscarded).toMatchObject({ screen: "projects", run: null, draft: null, draftFields: null, draftDirty: false })
  })

  it("pages wrapped proposal content and keeps confirmation controls visible at 60x18", () => {
    const base = reduceTui(initialTuiState({ columns: 60, rows: 18 }), { type: "loaded", snapshot })
    const marker = "END_PROMPT_REVIEW_MARKER"
    const run = {
      draft: { runId: "run-ui", fields: {} }, cancellation: { state: "none" },
      currentProposal: {
        dispatch: {
          state: "proposed",
          envelopeDigest: `sha256:${"b".repeat(64)}`,
          envelope: {
            dispatchId: `dispatch-${"a".repeat(100)}`, attempt: 1, projectId: "project", projectPathId: "path",
            targetNodeId: "node", runtimeKind: "opencode", installationId: "installation", timeoutSeconds: 60,
            requestedCapabilities: ["filesystem.read"], permissionEnvelope: { allowedCapabilities: ["filesystem.read"], deniedCapabilities: [], approvalRequirements: {} },
            prompt: `${"word ".repeat(600)}${marker}`, roleSnapshot: { name: "role", templateVersion: 1, purpose: "purpose", instructions: "instructions" },
            ruleSnapshots: [], contextManifest: { manifestDigest: `sha256:${"c".repeat(64)}`, references: [] }, controllerEpoch: 1, dependencies: [],
          },
        },
        launchAdmission: { state: "not-requested" },
      },
    }
    let proposal = { ...base, screen: "proposal" as const, run: run as never, fullProposal: true }
    let found = false
    for (let offset = 0; offset <= 100; offset += 10) {
      proposal = { ...proposal, scrollOffset: offset }
      if (buildTuiView(proposal).includes(marker)) found = true
    }
    expect(found).toBe(true)

    const modal = { ...proposal, fullProposal: false, scrollOffset: 0, overlay: "approval-confirmation" as const }
    expect(buildTuiView(modal)).toContain("[Back]  Approve and start")
    expect(buildTuiView(modal).split("\n").length).toBeLessThanOrEqual(18)
  })

  it("renders the terminal tail with a sticky status and input footer", () => {
    const base = reduceTui(initialTuiState({ columns: 60, rows: 18 }), { type: "loaded", snapshot })
    const output = Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n")
    const state = {
      ...base,
      screen: "terminal" as const,
      terminalView: {
        mode: "input-owned", terminalLabel: "term", sessionLabel: "session", projectLabel: "project", status: "INPUT OWNED",
        output, outputByteCount: output.length, outputTruncated: false, footer: "INPUT — Ctrl+] returns to commands",
        ownerLabel: "client", takeoverConfirmation: null, message: null, error: null,
      },
    }
    const rendered = buildTuiView(state as never)
    expect(rendered).toContain("line-99")
    expect(rendered).not.toContain("line-0\n")
    expect(rendered).toContain("INPUT — Ctrl+] returns to commands")
    expect(rendered.split("\n").length).toBeLessThanOrEqual(18)
  })
})
