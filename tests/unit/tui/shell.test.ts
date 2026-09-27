import { describe, expect, it, vi } from "vitest"
import {
  createTuiShell,
  type SignalSource,
  type TuiDimensions,
  type TuiRenderer,
  type TuiRendererFactory,
} from "../../../src/tui/index.js"
import type { KeyEvent, MouseEvent, PasteEvent } from "@opentui/core"
import type { LocalApplicationService } from "../../../src/application/types.js"
import type { CorrelationId } from "../../../src/orchestration/identifiers.js"

const snapshot = {
  workflow: "project-selection" as const,
  screen: "projects" as const,
  title: "Local projects",
  detail: ["No project selected."],
  status: "IDLE",
  canRefresh: true,
}

class FakeRenderer implements TuiRenderer {
  public readonly renders: string[] = []
  public destroyCount = 0
  private keyListener: ((key: KeyEvent) => void) | undefined
  private resizeListener: ((dimensions: TuiDimensions) => void) | undefined
  private pasteListener: ((event: PasteEvent) => void) | undefined
  private mouseListener: ((event: MouseEvent) => void) | undefined
  private errorListener: ((error: Error) => void) | undefined

  constructor(public readonly dimensions: TuiDimensions = { columns: 100, rows: 30 }) {}

  render(content: string): void { this.renders.push(content) }
  onKey(listener: (key: KeyEvent) => void): () => void {
    this.keyListener = listener
    return () => { this.keyListener = undefined }
  }
  onPaste(listener: (event: PasteEvent) => void): () => void {
    this.pasteListener = listener
    return () => { this.pasteListener = undefined }
  }
  onMouseUp(listener: (event: MouseEvent) => void): () => void {
    this.mouseListener = listener
    return () => { this.mouseListener = undefined }
  }
  onResize(listener: (dimensions: TuiDimensions) => void): () => void {
    this.resizeListener = listener
    return () => { this.resizeListener = undefined }
  }
  onRenderError(listener: (error: Error) => void): () => void {
    this.errorListener = listener
    return () => { this.errorListener = undefined }
  }
  destroy(): void { this.destroyCount++ }
  key(name: string, ctrl = false): void { this.keyListener?.({ name, ctrl } as KeyEvent) }
  paste(text: string): void { this.pasteListener?.({ bytes: new TextEncoder().encode(text) } as PasteEvent) }
  click(x: number, y: number): void { this.mouseListener?.({ x, y, type: "up", button: 0 } as MouseEvent) }
  resize(dimensions: TuiDimensions): void { this.resizeListener?.(dimensions) }
  fail(message: string): void { this.errorListener?.(new Error(message)) }
}

class FakeSignals implements SignalSource {
  public readonly listeners = new Map<NodeJS.Signals, Set<() => void>>()
  on(signal: NodeJS.Signals, listener: () => void): void {
    const values = this.listeners.get(signal) ?? new Set<() => void>()
    values.add(listener)
    this.listeners.set(signal, values)
  }
  off(signal: NodeJS.Signals, listener: () => void): void { this.listeners.get(signal)?.delete(listener) }
  emit(signal: NodeJS.Signals): void { for (const listener of this.listeners.get(signal) ?? []) listener() }
  count(): number { return [...this.listeners.values()].reduce((total, values) => total + values.size, 0) }
}

function service(projects: readonly { name: string; pathLabel: string; runtimeName: string }[] = []): LocalApplicationService {
  return {
    execute: vi.fn(async () => ({ ok: true, value: projects })),
    events: () => [],
  } as unknown as LocalApplicationService
}

const correlationId = "corr-tui-test" as CorrelationId

async function settleShell(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe("TUI shell lifecycle", () => {
  it("admits no project/run or approval effects below the minimum viewport", async () => {
    const renderer = new FakeRenderer({ columns: 59, rows: 18 })
    const app = service([{ name: "P", pathLabel: "/safe", runtimeName: "Fake" }])
    const shell = createTuiShell({ service: app, correlationId, rendererFactory: { create: async () => renderer } })
    const completion = shell.run("dev")
    await settleShell()
    renderer.key("n")
    renderer.key("a")
    await settleShell()
    expect(app.execute).toHaveBeenCalledTimes(2)
    expect((app.execute as ReturnType<typeof vi.fn>).mock.calls.map(([command]) => command.type)).toEqual([
      "projects.list",
      "sessions.recover",
    ])
    expect(renderer.renders.at(-1)).toContain("minimum is 60x18")
    renderer.key("q")
    await expect(completion).resolves.toBe(0)
  })

  it("binds an approval confirmation to the exact service proposal and leaves an uncertain launch visibly unknown", async () => {
    const renderer = new FakeRenderer()
    const project = {
      projectId: "project-ui", name: "UI project", projectPathId: "path-ui", pathLabel: "/safe/project",
      nodeId: "node-ui", installationId: "install-ui", runtimeKind: "fake", runtimeName: "Fake", availableModels: [],
    } as any
    const draft = {
      projectId: "project-ui", runId: "run-ui", taskId: "task-ui", revision: 1,
      fields: { goal: "g", taskTitle: "t", taskDescription: "d", prompt: "p", timeoutSeconds: 60 }, proposalRequired: true,
    } as any
    const envelope = {
      dispatchId: "dispatch-ui", attempt: 4, projectId: "project-ui", runId: "run-ui", taskId: "task-ui",
      targetNodeId: "node-ui", installationId: "install-ui", runtimeKind: "fake", projectPathId: "path-ui", prompt: "p",
      roleSnapshot: { name: "role", templateVersion: 1, purpose: "p", instructions: "i" }, ruleSnapshots: [],
      contextManifest: { manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", references: [] },
      requestedCapabilities: [], permissionEnvelope: { allowedCapabilities: [], deniedCapabilities: [], approvalRequirements: {} }, dependencies: [], timeoutSeconds: 60, controllerEpoch: 1,
    }
    const proposed = { draft, proposalHistory: [], session: undefined, result: undefined, cancellation: { state: "none" }, currentProposal: {
      draftRevision: 1, dispatch: { envelope, envelopeDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", state: "proposed" }, launchAdmission: { state: "not-requested" },
    } } as never
    const approved = structuredClone(proposed) as typeof proposed
    ;(approved as any).currentProposal.dispatch.state = "approved"
    ;(approved as any).currentProposal.approval = { approvalId: "approval-ui", decision: "approved" }
    const unknown = structuredClone(approved) as typeof proposed
    ;(unknown as any).currentProposal.launchAdmission = { state: "unknown", commandId: "launch-ui", error: { message: "unknown" } }
    const execute = vi.fn(async (command: any) => {
      switch (command.type) {
        case "projects.list": return { ok: true, value: [project] }
        case "projects.select": return { ok: true, value: { project } }
        case "draft.create": return { ok: true, value: draft }
        case "draft.edit": return { ok: true, value: { ...draft, revision: 2, fields: { ...draft.fields, ...command.patch } } }
        case "proposal.create": return { ok: true, value: proposed }
        case "proposal.decide": return { ok: true, value: approved }
        case "dispatch.launch": return { ok: true, value: { outcome: "unknown", snapshot: unknown, error: { message: "unknown" } } }
        default: return { ok: false, error: { message: "unexpected command" } }
      }
    })
    const shell = createTuiShell({ service: { execute, events: () => [] } as unknown as LocalApplicationService, correlationId, rendererFactory: { create: async () => renderer } })
    const completion = shell.run("dev")
    await settleShell()
    renderer.key("n")
    await settleShell()
    renderer.paste(" pasted\ntext")
    expect(shell.getState().draftFields?.goal).toContain("pasted text")
    renderer.key("escape")
    renderer.key("return")
    await settleShell()
    expect(renderer.renders.at(-1)).toContain("Dispatch: dispatch-ui  attempt: 4")
    renderer.key("a")
    expect(renderer.renders.at(-1)).toContain("[Back]")
    renderer.key("return")
    expect(execute.mock.calls.map(([command]) => command.type)).not.toContain("proposal.decide")
    renderer.key("a")
    renderer.key("tab")
    const armedBackRow = renderer.renders.at(-1)!.split("\n").findIndex((line) => line.startsWith("Back  [Approve and start]"))
    expect(armedBackRow).toBeGreaterThanOrEqual(0)
    renderer.click(0, armedBackRow)
    expect(execute.mock.calls.map(([command]) => command.type)).not.toContain("proposal.decide")
    expect(shell.getState().overlay).toBe("none")
    renderer.key("a")
    renderer.key("tab")
    const armedApproveRow = renderer.renders.at(-1)!.split("\n").findIndex((line) => line.startsWith("Back  [Approve and start]"))
    renderer.click(8, armedApproveRow)
    await settleShell()
    const decision = execute.mock.calls.map(([command]) => command).find((command) => command.type === "proposal.decide")
    const launch = execute.mock.calls.map(([command]) => command).find((command) => command.type === "dispatch.launch")
    expect(decision).toMatchObject({ dispatchId: "dispatch-ui", attempt: 4, envelopeDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })
    expect(launch).toMatchObject({ dispatchId: "dispatch-ui", approvalId: "approval-ui" })
    expect(renderer.renders.at(-1)).toContain("[UNKNOWN]")
    shell.close()
    await expect(completion).resolves.toBe(0)
  })

  it("renders through its injected renderer and cleans listeners/renderer once on q", async () => {
    const renderer = new FakeRenderer()
    const signals = new FakeSignals()
    const app = service()
    const shell = createTuiShell({
      service: app,
      correlationId,
      rendererFactory: { create: async () => renderer },
      signals,
    })

    const result = shell.run("dev")
    await settleShell()
    expect(renderer.renders.at(-1)).toContain("No authorized local projects.")
    expect(signals.count()).toBe(3)
    const renderCount = renderer.renders.length
    renderer.key("f")
    await settleShell()
    expect(renderer.renders.length).toBeGreaterThan(renderCount)
    renderer.key("q")

    await expect(result).resolves.toBe(0)
    expect(renderer.destroyCount).toBe(1)
    expect(signals.count()).toBe(0)
    shell.close()
    expect(renderer.destroyCount).toBe(1)
  })

  it("makes command actions reachable through Tab and Enter", async () => {
    const renderer = new FakeRenderer()
    const app = service()
    const shell = createTuiShell({ service: app, correlationId, rendererFactory: { create: async () => renderer } })
    const completion = shell.run("dev")
    await settleShell()
    const before = (app.execute as ReturnType<typeof vi.fn>).mock.calls.length
    renderer.key("tab")
    expect(shell.getState().focusedAction).toBe("refresh")
    expect(renderer.renders.at(-1)).toContain("focused action [refresh]")
    renderer.key("return")
    await settleShell()
    expect((app.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before)
    shell.close()
    await expect(completion).resolves.toBe(0)
  })

  it("keeps every draft field and action reachable after leaving edit mode", async () => {
    const renderer = new FakeRenderer()
    const project = {
      projectId: "project-focus", name: "Focus project", projectPathId: "path-focus", pathLabel: "/safe/focus",
      nodeId: "node-focus", installationId: "install-focus", runtimeKind: "fake", runtimeName: "Fake", availableModels: [],
    } as any
    const draft = {
      projectId: "project-focus", runId: "run-focus", taskId: "task-focus", revision: 1,
      fields: { goal: "", taskTitle: "", taskDescription: "", prompt: "", timeoutSeconds: 60 }, proposalRequired: true,
    } as any
    const execute = vi.fn(async (command: any) => {
      if (command.type === "projects.list") return { ok: true, value: [project] }
      if (command.type === "projects.select") return { ok: true, value: { project } }
      if (command.type === "draft.create") return { ok: true, value: draft }
      if (command.type === "sessions.recover") return { ok: true, value: { sessions: [] } }
      return { ok: false, error: { message: "unexpected command" } }
    })
    const shell = createTuiShell({ service: { execute, events: () => [] } as unknown as LocalApplicationService, correlationId, rendererFactory: { create: async () => renderer } })
    const completion = shell.run("dev")
    await settleShell()
    renderer.key("n")
    await settleShell()
    expect(shell.getState().focusedField).toBe("goal")
    renderer.key("x")
    renderer.key("backspace")
    expect(shell.getState().draftDirty).toBe(true)
    renderer.key("escape")
    renderer.key("tab")
    expect(shell.getState().focusedField).toBe("goal")
    renderer.key("tab", false)
    renderer.key("tab", false)
    renderer.key("tab", false)
    renderer.key("tab", false)
    renderer.key("tab", false)
    expect(shell.getState().focusedField).toBe("timeoutSeconds")
    renderer.key("tab")
    expect(shell.getState().focusedAction).toBe("review-proposal")
    renderer.key("tab")
    expect(shell.getState().focusedAction).toBe("back")
    renderer.key("return")
    expect(shell.getState().screen).toBe("draft")
    expect(shell.getState().overlay).toBe("discard-confirmation")
    renderer.key("escape")
    renderer.key("tab")
    expect(shell.getState().focusedField).toBe("goal")
    renderer.key("escape")
    renderer.key("return")
    expect(shell.getState().focusedField).toBe("goal")
    expect(shell.getState().notice).toBe("Goal is required.")
    renderer.key("escape")
    renderer.key("q")
    renderer.key("tab")
    renderer.key("return")
    expect(shell.getState().screen).toBe("projects")
    expect(shell.getState().draftDirty).toBe(false)
    expect(shell.getState().draft).toBeNull()
    shell.close()
    await expect(completion).resolves.toBe(0)
  })

  it("uses the same idempotent cleanup path for interrupts and renderer exceptions", async () => {
    const renderer = new FakeRenderer()
    const signals = new FakeSignals()
    const messages: string[] = []
    const shell = createTuiShell({
      service: service(),
      correlationId,
      rendererFactory: { create: async () => renderer },
      signals,
      writer: (message) => messages.push(message),
    })

    const result = shell.run("dev")
    await settleShell()
    expect(signals.count()).toBe(3)
    renderer.fail("render failed")
    signals.emit("SIGINT")

    await expect(result).resolves.toBe(1)
    expect(renderer.destroyCount).toBe(1)
    expect(signals.count()).toBe(0)
    expect(messages.join("")).toContain("internal renderer failure")
  })

  it("cleans a partially initialized renderer when listener setup throws", async () => {
    const renderer = new FakeRenderer()
    renderer.onResize = (): (() => void) => { throw new Error("resize listener failed") }
    const messages: string[] = []
    const factory: TuiRendererFactory = { create: async () => renderer }
    const shell = createTuiShell({ service: service(), correlationId, rendererFactory: factory, writer: (message) => messages.push(message) })

    await expect(shell.run("dev")).resolves.toBe(1)
    expect(renderer.destroyCount).toBe(1)
    expect(messages.join("")).toContain("internal renderer failure")
  })

  it("does not apply a late application response after closing", async () => {
    const renderer = new FakeRenderer()
    let resolveProjects: ((value: unknown) => void) | undefined
    const app = {
      execute: vi.fn(() => new Promise((resolve) => { resolveProjects = resolve })),
      events: () => [],
    } as unknown as LocalApplicationService
    const shell = createTuiShell({
      service: app,
      correlationId,
      rendererFactory: { create: async () => renderer },
    })

    const result = shell.run("dev")
    await settleShell()
    shell.close()
    await expect(result).resolves.toBe(0)
    resolveProjects?.({ ok: true, value: [] })
    await settleShell()

    expect(shell.getState().shell).toBe("closed")
    expect(renderer.destroyCount).toBe(1)
  })
})
