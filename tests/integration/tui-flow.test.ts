import { describe, expect, it } from "vitest"
import { SdkOpencodeClientAdapter } from "../../src/opencode/client.js"
import { digestDispatchEnvelope } from "../../src/orchestration/digest.js"
import { approvalIdSchema } from "../../src/orchestration/identifiers.js"
import { agentResultSchema } from "../../src/runtime/schemas.js"
import { createTerminalViewController, createTuiShell } from "../../src/tui/index.js"
import {
  Deferred,
  M1Harness,
  ManualScheduler,
  RecordingTerminalView,
  ScriptedRenderer,
  correlationId,
  decode,
  errorOf,
  primaryClientId,
  secondaryClientId,
  settle,
  text,
  userId,
  valueOf,
  waitForShell,
} from "./fixtures/m1/harness.js"

async function createProposal(harness: M1Harness, prompt = "Complete the deterministic M1 task.") {
  const projectId = harness.projects.current.project.projectId
  valueOf(await harness.service.execute({ type: "projects.select", projectId, correlationId }))
  const draft = valueOf(await harness.service.execute({
    type: "draft.create",
    operationId: harness.operationId(),
    correlationId,
    projectId,
  }))
  const edited = valueOf(await harness.service.execute({
    type: "draft.edit",
    operationId: harness.operationId(),
    correlationId,
    runId: draft.runId,
    expectedRevision: draft.revision,
    patch: {
      goal: "Prove the one-task workflow",
      taskTitle: "Run M1 acceptance",
      taskDescription: "Exercise every local deterministic boundary.",
      prompt,
      model: "fixture-model",
      timeoutSeconds: 900,
    },
  }))
  return valueOf(await harness.service.execute({
    type: "proposal.create",
    operationId: harness.operationId(),
    correlationId,
    runId: edited.runId,
    expectedRevision: edited.revision,
  }))
}

async function approve(harness: M1Harness, snapshot: Awaited<ReturnType<typeof createProposal>>) {
  const proposal = snapshot.currentProposal!
  return valueOf(await harness.service.execute({
    type: "proposal.decide",
    operationId: harness.operationId(),
    correlationId,
    runId: snapshot.draft.runId,
    dispatchId: proposal.dispatch.envelope.dispatchId,
    attempt: proposal.dispatch.envelope.attempt,
    envelopeDigest: proposal.dispatch.envelopeDigest,
    decision: "approved",
    userId,
  }))
}

async function launch(harness: M1Harness, approved: Awaited<ReturnType<typeof approve>>) {
  const proposal = approved.currentProposal!
  return valueOf(await harness.service.execute({
    type: "dispatch.launch",
    operationId: harness.operationId(),
    correlationId,
    runId: approved.draft.runId,
    dispatchId: proposal.dispatch.envelope.dispatchId,
    envelopeDigest: proposal.dispatch.envelopeDigest,
    approvalId: proposal.approval!.approvalId,
  }))
}

describe("Milestone 1 deterministic one-task acceptance flow", () => {
  it("drives project, draft, exact approval, runtime evidence, terminal safety, result, and recovery without external services", async () => {
    const harness = new M1Harness()
    const renderer = new ScriptedRenderer()
    const shell = createTuiShell({
      service: harness.service,
      correlationId,
      operationId: () => harness.operationId(),
      userId,
      rendererFactory: { create: async () => renderer },
      terminalClientId: primaryClientId,
      terminalConnector: {
        open: async (run, view) => {
          const reference = harness.terminal.reference
          if (!reference || reference.terminalId !== run.session?.terminalId) {
            return { ok: false, error: { schemaVersion: 1, category: "conflict", code: "fixture.terminal_missing", message: "Terminal missing.", retryable: false, correlationId } }
          }
          const controller = createTerminalViewController(harness.terminal, {
            operation: () => harness.terminalOperation(primaryClientId),
            view,
          })
          const attached = await controller.attach(reference, { terminal: "Fixture terminal", session: "Fixture OpenCode session", project: "M1 fixture project" })
          return attached.ok ? { ok: true, value: controller } : attached
        },
        openRecovery: async (recovery, view) => {
          const reference = harness.terminal.reference
          if (!reference || reference.terminalId !== recovery.terminalId) {
            return { ok: false, error: { schemaVersion: 1, category: "conflict", code: "fixture.terminal_missing", message: "Terminal missing.", retryable: false, correlationId } }
          }
          const controller = createTerminalViewController(harness.terminal, {
            operation: () => harness.terminalOperation(primaryClientId),
            view,
          })
          const attached = await controller.attach(reference, { terminal: "Recovered fixture terminal", session: "Recovered session; run history unavailable", project: recovery.projectName })
          return attached.ok ? { ok: true, value: controller } : attached
        },
      },
    })
    const shellCompletion = shell.run("fixture")

    await waitForShell(harness.service, () => shell.getState().shell === "ready" && shell.getState().projects.length === 1)
    expect(renderer.renders.at(-1)).toContain("M1 fixture project")
    renderer.key("enter")
    await waitForShell(harness.service, () => shell.getState().selectedProject?.name === "M1 fixture project" && shell.getState().pending === null)
    renderer.key("n")
    await waitForShell(harness.service, () => shell.getState().screen === "draft" && shell.getState().pending === null)

    renderer.type("Prove the approved flow")
    renderer.key("tab")
    renderer.type("One deterministic task")
    renderer.key("tab")
    renderer.type("Exercise the integrated M1 boundaries")
    renderer.key("tab")
    renderer.type("Inspect, interact, and report verified completion")
    renderer.key("tab")
    renderer.type("fixture-model")
    renderer.key("tab")
    for (let index = 0; index < 4; index += 1) renderer.key("backspace")
    renderer.type("900")
    renderer.key("escape")
    renderer.key("enter")
    await waitForShell(harness.service, () => shell.getState().screen === "proposal" && shell.getState().pending === null)

    const proposed = shell.getState().run!
    const proposal = proposed.currentProposal!
    expect(proposal.dispatch.envelopeDigest).toBe(digestDispatchEnvelope(proposal.dispatch.envelope))
    expect(renderer.renders.at(-1)).toContain(`Digest: ${proposal.dispatch.envelopeDigest}`)
    expect(proposal.approval).toBeUndefined()
    expect(harness.runtime.launches).toHaveLength(0)

    const premature = await harness.service.execute({
      type: "dispatch.launch",
      operationId: harness.operationId(),
      correlationId,
      runId: proposed.draft.runId,
      dispatchId: proposal.dispatch.envelope.dispatchId,
      envelopeDigest: proposal.dispatch.envelopeDigest,
      approvalId: approvalIdSchema.parse("approval-not-recorded"),
    })
    expect(errorOf(premature)).toMatchObject({ category: "approval_required", code: "application.launch.approval_required" })
    expect(harness.runtime.launches).toHaveLength(0)

    renderer.key("a")
    expect(renderer.renders.at(-1)).toContain(proposal.dispatch.envelope.dispatchId)
    expect(renderer.renders.at(-1)).toContain(proposal.dispatch.envelopeDigest)
    renderer.key("enter")
    expect(harness.runtime.launches).toHaveLength(0)
    renderer.key("a")
    renderer.key("tab")
    renderer.key("enter")
    await waitForShell(harness.service, () => shell.getState().run?.session?.state === "starting" && shell.getState().pending === null)

    expect(harness.runtime.launches).toHaveLength(1)
    expect(harness.runtime.launches[0]).toMatchObject({
      dispatchEnvelopeDigest: proposal.dispatch.envelopeDigest,
      dispatchEnvelope: { dispatchId: proposal.dispatch.envelope.dispatchId },
    })
    expect(harness.projects.authorizationRequests).toHaveLength(1)

    harness.runtime.queueLifecycle("working")
    renderer.key("f")
    await waitForShell(harness.service, () => shell.getState().run?.session?.state === "working")
    expect(renderer.renders.at(-1)).toContain("[WORKING]")

    harness.runtime.queueLifecycle("unknown")
    renderer.key("f")
    await waitForShell(harness.service, () => shell.getState().run?.session?.state === "unknown")
    expect(renderer.renders.at(-1)).toContain("[UNKNOWN]")
    expect(harness.runtime.launches).toHaveLength(1)

    harness.runtime.queueLifecycle("blocked")
    renderer.key("f")
    await waitForShell(harness.service, () => shell.getState().run?.session?.state === "blocked")
    const requestId = harness.runtime.queuePermission()
    renderer.key("f")
    await waitForShell(harness.service, () => shell.getState().run?.pendingRequest?.requestId === requestId)
    expect(renderer.renders.at(-1)).toContain("Permission request")
    renderer.key("1")
    renderer.key("enter")
    expect(harness.runtime.responses).toHaveLength(0)
    renderer.key("1")
    renderer.key("tab")
    renderer.key("enter")
    await waitForShell(harness.service, () => shell.getState().run?.pendingRequest === undefined && shell.getState().pending === null)
    expect(harness.runtime.responses).toHaveLength(1)

    harness.terminal.output.push(text("agent> working\n"))
    renderer.key("t")
    await waitForShell(harness.service, () => shell.getState().screen === "terminal" && shell.getState().pending === null)
    expect(shell.getState().terminalView).toMatchObject({ mode: "read-only", output: "agent> working\n" })
    renderer.key("i")
    await waitForShell(harness.service, () => shell.getState().terminalView?.mode === "input-owned")
    renderer.type("via-shell")
    await waitForShell(harness.service, () => harness.terminal.acceptedWrites.length === 9)
    renderer.key("]", { ctrl: true, sequence: "\u001d" })
    await waitForShell(harness.service, () => shell.getState().terminalView?.mode === "read-only")
    expect(harness.terminal.acceptedWrites.map(({ data }) => decode(data)).join("")).toBe("via-shell")
    const terminalReference = harness.terminal.reference!
    const terminalView = new RecordingTerminalView()
    const scheduler = new ManualScheduler()
    const terminal = createTerminalViewController(harness.terminal, {
      operation: () => harness.terminalOperation(primaryClientId),
      view: terminalView,
      scheduler,
      presentationByteLimit: 128,
    })
    harness.terminal.output.push(text("agent> working\n"))
    await expect(terminal.attach(terminalReference, {
      terminal: "Fixture terminal",
      session: "Fixture OpenCode session",
      project: "M1 fixture project",
    })).resolves.toEqual({ ok: true, value: undefined })
    expect(terminal.getViewModel()).toMatchObject({ mode: "read-only", status: "READ ONLY", output: "agent> working\n" })

    await expect(terminal.requestInput()).resolves.toEqual({ ok: true, value: undefined })
    expect(terminal.getViewModel().footer).toBe("INPUT — Ctrl+] returns to commands")
    await Promise.all([terminal.sendInput(text("first")), terminal.sendInput(text("second"))])
    const escaped = await terminal.sendInput(Uint8Array.of(0x6f, 0x6b, 0x1d, 0x74, 0x61, 0x69, 0x6c))
    expect(escaped).toEqual({ ok: true, value: { forwardedBytes: 2, discardedBytes: 5, escapedToCommandMode: true } })
    expect(harness.terminal.acceptedWrites.map(({ data }) => decode(data))).toEqual(["v", "i", "a", "-", "s", "h", "e", "l", "l", "first", "second", "ok"])
    expect(terminal.getViewModel().mode).toBe("read-only")

    await terminal.requestInput()
    terminal.resizeContent({ columns: 90.9, rows: 20.8 })
    terminal.resizeContent({ columns: 2_000, rows: 31.9 })
    scheduler.flush()
    await settle()
    expect(harness.terminal.resizeCalls.at(-1)).toMatchObject({
      clientId: primaryClientId,
      dimensions: { columns: 1_000, rows: 31 },
    })
    terminal.revokeInput("Viewport below 60x18")
    renderer.resize({ columns: 59, rows: 17 })
    expect(renderer.renders.at(-1)).toContain("minimum is 60x18")
    expect(terminal.getViewModel()).toMatchObject({ mode: "read-only", message: "Viewport below 60x18" })
    renderer.resize({ columns: 100, rows: 30 })
    expect(shell.getState()).toMatchObject({ shell: "ready", screen: "terminal" })
    expect(terminal.getViewModel().mode).toBe("read-only")
    await terminal.detach()
    expect(harness.terminal.terminateCount).toBe(0)

    const verifiedResult = agentResultSchema.parse({
      schemaVersion: 1,
      outcome: "succeeded",
      summary: "The deterministic task completed with provider evidence.",
      completionEvidence: { kind: "reliable_provider", mechanism: "scripted completion event" },
    })
    harness.runtime.queueResult(verifiedResult)
    renderer.key("escape")
    renderer.key("f")
    await waitForShell(harness.service, () => shell.getState().run?.session?.state === "completed")
    expect(renderer.renders.at(-1)).toContain("[COMPLETED]")
    renderer.key("v")
    await waitForShell(harness.service, () => shell.getState().screen === "result" && shell.getState().pending === null)
    expect(renderer.renders.at(-1)).toContain("Evidence: reliable_provider")

    renderer.key("q")
    await expect(shellCompletion).resolves.toBe(0)
    expect(renderer.destroyCount).toBe(1)
    expect(harness.runtime.launches).toHaveLength(1)
    expect(harness.terminal.terminateCount).toBe(0)

    const reopenedService = harness.newService()
    const recovered = valueOf(await reopenedService.execute({
      type: "sessions.recover",
      operationId: harness.operationId(),
      correlationId,
      clientId: secondaryClientId,
    }))
    expect(recovered).toEqual({
      sessions: [expect.objectContaining({
        sessionId: terminalReference.sessionId,
        terminalId: terminalReference.terminalId,
        runtimeState: "unknown",
        historyAvailable: false,
        mutationAllowed: false,
        attachmentMode: "read-only",
      })],
      quarantinedCount: 0,
    })
    const reopenedRenderer = new ScriptedRenderer()
    const reopenedShell = createTuiShell({
      service: reopenedService,
      correlationId,
      operationId: () => harness.operationId(),
      userId,
      terminalClientId: secondaryClientId,
      rendererFactory: { create: async () => reopenedRenderer },
      terminalConnector: {
        open: async () => ({ ok: false, error: { schemaVersion: 1, category: "conflict", code: "fixture.no_live_run", message: "No live history.", retryable: false, correlationId } }),
        openRecovery: async (summary, view) => {
          const controller = createTerminalViewController(harness.terminal, { operation: () => harness.terminalOperation(secondaryClientId), view })
          const attached = await controller.attach(terminalReference, { terminal: "Recovered fixture terminal", session: "Recovered session; run history unavailable", project: summary.projectName })
          return attached.ok ? { ok: true, value: controller } : attached
        },
      },
    })
    const reopenedCompletion = reopenedShell.run("fixture")
    await waitForShell(reopenedService, () => reopenedShell.getState().recoveries.length === 1)
    reopenedRenderer.key("r")
    await waitForShell(reopenedService, () => reopenedShell.getState().screen === "terminal" && reopenedShell.getState().pending === null)
    expect(reopenedShell.getState().terminalView).toMatchObject({ mode: "read-only", status: "READ ONLY" })
    reopenedShell.close()
    await expect(reopenedCompletion).resolves.toBe(0)
    const reopenedTerminal = createTerminalViewController(harness.terminal, {
      operation: () => harness.terminalOperation(secondaryClientId),
    })
    await reopenedTerminal.attach(terminalReference, {
      terminal: "Recovered fixture terminal",
      session: "Recovered session; run history unavailable",
      project: "M1 fixture project",
    })
    expect(reopenedTerminal.getViewModel()).toMatchObject({ mode: "read-only", status: "READ ONLY" })
    expect(harness.runtime.launches).toHaveLength(1)
    await reopenedTerminal.close()
    expect(harness.terminal.terminateCount).toBe(0)
  })

  it("keeps rejected and approved revisions non-actionable after any material edit", async () => {
    const harness = new M1Harness()
    const first = await createProposal(harness, "Proposal A")
    const proposalA = first.currentProposal!
    const rejected = valueOf(await harness.service.execute({
      type: "proposal.decide",
      operationId: harness.operationId(),
      correlationId,
      runId: first.draft.runId,
      dispatchId: proposalA.dispatch.envelope.dispatchId,
      attempt: proposalA.dispatch.envelope.attempt,
      envelopeDigest: proposalA.dispatch.envelopeDigest,
      decision: "rejected",
      userId,
    }))
    expect(rejected.currentProposal?.approval?.decision).toBe("rejected")
    expect(harness.runtime.launches).toHaveLength(0)

    const revisedB = valueOf(await harness.service.execute({
      type: "proposal.revise",
      operationId: harness.operationId(),
      correlationId,
      runId: first.draft.runId,
      dispatchId: proposalA.dispatch.envelope.dispatchId,
      envelopeDigest: proposalA.dispatch.envelopeDigest,
      patch: { prompt: "Proposal B" },
    }))
    const proposalB = revisedB.currentProposal!
    expect(revisedB.proposalHistory[0]?.approval?.decision).toBe("rejected")
    expect(proposalB.dispatch.envelope.attempt).toBe(2)
    expect(proposalB.dispatch.envelope.dispatchId).not.toBe(proposalA.dispatch.envelope.dispatchId)
    expect(proposalB.dispatch.envelopeDigest).not.toBe(proposalA.dispatch.envelopeDigest)
    expect(proposalB.approval).toBeUndefined()

    const approvedB = await approve(harness, revisedB)
    const approvedProposalB = approvedB.currentProposal!
    const revisedC = valueOf(await harness.service.execute({
      type: "proposal.revise",
      operationId: harness.operationId(),
      correlationId,
      runId: first.draft.runId,
      dispatchId: approvedProposalB.dispatch.envelope.dispatchId,
      envelopeDigest: approvedProposalB.dispatch.envelopeDigest,
      patch: { goal: "Proposal C requires another explicit decision" },
    }))
    expect(revisedC.proposalHistory.at(-1)?.approval?.decision).toBe("approved")
    expect(revisedC.currentProposal?.approval).toBeUndefined()
    expect(revisedC.currentProposal?.dispatch.envelope.attempt).toBe(3)

    const staleLaunch = await harness.service.execute({
      type: "dispatch.launch",
      operationId: harness.operationId(),
      correlationId,
      runId: first.draft.runId,
      dispatchId: approvedProposalB.dispatch.envelope.dispatchId,
      envelopeDigest: approvedProposalB.dispatch.envelopeDigest,
      approvalId: approvedProposalB.approval!.approvalId,
    })
    expect(errorOf(staleLaunch)).toMatchObject({ category: "conflict", code: "application.proposal.stale" })
    expect(harness.runtime.launches).toHaveLength(0)
  })

  it("records an uncertain launch once and refuses every replay", async () => {
    const harness = new M1Harness()
    harness.runtime.launchMode = "timeout"
    const approved = await approve(harness, await createProposal(harness))
    const proposal = approved.currentProposal!
    const command = {
      type: "dispatch.launch" as const,
      operationId: harness.operationId(),
      correlationId,
      runId: approved.draft.runId,
      dispatchId: proposal.dispatch.envelope.dispatchId,
      envelopeDigest: proposal.dispatch.envelopeDigest,
      approvalId: proposal.approval!.approvalId,
    }
    const uncertain = valueOf(await harness.service.execute(command))
    expect(uncertain).toMatchObject({ outcome: "unknown", snapshot: { currentProposal: { launchAdmission: { state: "unknown" } } } })
    expect(harness.runtime.launches).toHaveLength(1)

    expect(valueOf(await harness.service.execute(structuredClone(command)))).toEqual(uncertain)
    const replay = await harness.service.execute({ ...command, operationId: harness.operationId() })
    expect(errorOf(replay)).toMatchObject({ category: "conflict", code: "application.launch.already_attempted" })
    expect(harness.runtime.launches).toHaveLength(1)
  })

  it("enforces ownership loss at the backend, drops queued bytes, and cleans up safely after channel failure", async () => {
    const harness = new M1Harness()
    const started = await launch(harness, await approve(harness, await createProposal(harness)))
    expect(started.outcome).toBe("started")
    const reference = harness.terminal.reference!
    const primary = createTerminalViewController(harness.terminal, {
      operation: () => harness.terminalOperation(primaryClientId),
    })
    const secondary = createTerminalViewController(harness.terminal, {
      operation: () => harness.terminalOperation(secondaryClientId),
    })
    await primary.attach(reference, { terminal: "T", session: "S", project: "P" })
    await secondary.attach(reference, { terminal: "T", session: "S", project: "P" })
    await primary.requestInput()

    harness.terminal.writeGate = new Deferred<void>()
    const inFlight = primary.sendInput(text("in-flight"))
    await settle()
    const queued = primary.sendInput(text("must-not-arrive"))
    await expect(secondary.requestInput()).resolves.toMatchObject({ ok: false, error: { code: "terminal.input_owned" } })
    expect(secondary.beginTakeover("primary client")).toEqual({ ok: true, value: undefined })
    await expect(secondary.confirmTakeover("Primary client is no longer authoritative")).resolves.toEqual({ ok: true, value: undefined })
    primary.observeOwnership(harness.terminal.ownership())

    await expect(queued).resolves.toMatchObject({ ok: false, error: { code: "terminal_view.forwarding_stopped" } })
    harness.terminal.writeGate.resolve()
    await expect(inFlight).resolves.toMatchObject({ ok: false, error: { code: "terminal.input_not_owned" } })
    expect(harness.terminal.acceptedWrites.filter(({ clientId }) => clientId === primaryClientId)).toHaveLength(0)
    expect(primary.getViewModel()).toMatchObject({ mode: "read-only", ownerLabel: secondaryClientId })

    harness.terminal.writeGate = null
    await expect(secondary.sendInput(text("owner-byte"))).resolves.toMatchObject({ ok: true, value: { forwardedBytes: 10 } })
    harness.terminal.failNextWrite = true
    await expect(secondary.sendInput(text("fail"))).resolves.toMatchObject({ ok: false, error: { code: "terminal.write_failed" } })
    expect(secondary.getViewModel().mode).toBe("read-only")
    await Promise.all([primary.close(), secondary.close()])
    expect(harness.terminal.terminateCount).toBe(0)
    expect(harness.runtime.terminateCount).toBe(0)
  })

  it("restores renderer state on fatal output failure without terminating the managed session", async () => {
    const harness = new M1Harness()
    await launch(harness, await approve(harness, await createProposal(harness)))
    const renderer = new ScriptedRenderer()
    const diagnostics: string[] = []
    const shell = createTuiShell({
      service: harness.service,
      correlationId,
      rendererFactory: { create: async () => renderer },
      writer: (message) => diagnostics.push(message),
    })
    const completion = shell.run("fixture")
    await waitForShell(harness.service, () => shell.getState().shell === "ready")
    renderer.fail("fixture renderer failure")
    await expect(completion).resolves.toBe(1)
    expect(renderer.destroyCount).toBe(1)
    expect(diagnostics.join("")).toContain("internal renderer failure")
    expect(harness.runtime.terminateCount).toBe(0)
    expect(harness.terminal.terminateCount).toBe(0)
    expect(harness.terminal.reference).not.toBeNull()
  })
})

const realAgentSmoke = process.env.AIBRIDGE_M1_REAL_AGENT_SMOKE === "1" ? it : it.skip

describe("Milestone 1 optional real-agent smoke", () => {
  realAgentSmoke("creates, prompts, and aborts one local OpenCode session only when explicitly enabled", async () => {
    const baseUrl = process.env.AIBRIDGE_M1_OPENCODE_URL
    const directory = process.env.AIBRIDGE_M1_PROJECT_PATH
    if (!baseUrl || !directory) {
      throw new Error("AIBRIDGE_M1_OPENCODE_URL and AIBRIDGE_M1_PROJECT_PATH are required for the opt-in smoke test")
    }
    const client = new SdkOpencodeClientAdapter({
      baseUrl,
      username: process.env.OPENCODE_SERVER_USERNAME ?? "opencode",
      password: process.env.OPENCODE_SERVER_PASSWORD,
    })
    expect(await client.health()).toBe(true)
    const session = await client.createSession("AIBridge M1 opt-in smoke", directory)
    try {
      await client.sendPromptAsync(
        session.id,
        "Reply with a short acknowledgement. Do not edit files or access the network.",
        directory,
      )
      expect(session.id.length).toBeGreaterThan(0)
    } finally {
      await client.abortSession(session.id)
    }
  })
})
