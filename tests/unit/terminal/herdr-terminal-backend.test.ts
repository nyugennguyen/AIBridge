import { describe, expect, it } from "vitest"
import type { ProcessOptions, ProcessResult, ProcessRunner } from "../../../src/host/types.js"
import type { Result } from "../../../src/orchestration/errors.js"
import {
  commandIdSchema,
  correlationIdSchema,
  leaseIdSchema,
  nodeIdSchema,
  projectIdSchema,
  sessionIdSchema,
  terminalClientIdSchema,
  terminalIdSchema,
} from "../../../src/orchestration/identifiers.js"
import { runTerminalBackendConformance } from "../../../src/sdk/conformance.js"
import { createTerminalBackend } from "../../../src/terminal/factory.js"
import {
  CliHerdrClient,
  HERDR_KIND,
  HerdrTerminalBackend,
  InMemoryHerdrClient,
  type HerdrClaimResult,
  type HerdrClient,
  type HerdrWriteOptions,
} from "../../../src/terminal/herdr-terminal-backend.js"
import type {
  CreateTerminalRequest,
  InputTakeoverRequest,
  TerminalControlOperationContext,
  TerminalOperationContext,
  TerminalReference,
} from "../../../src/terminal/schemas.js"
import {
  TmuxTerminalBackend,
  type TerminalAction,
  type TerminalAuthorizationRequest,
  type TerminalAuthorizer,
} from "../../../src/terminal/tmux-terminal-backend.js"

// ── Test Fixtures & Fakes ────────────────────────────────────────────────

const nodeId = nodeIdSchema.parse("node-local")
const projectId = projectIdSchema.parse("project-a")
const otherProjectId = projectIdSchema.parse("project-b")
const terminalId = terminalIdSchema.parse("term:herdr.pane-1")
const sessionId = sessionIdSchema.parse("session-a")

function operation(client = "client-a", project = projectId): TerminalOperationContext {
  return {
    schemaVersion: 1,
    commandId: commandIdSchema.parse(`command-${client}`),
    correlationId: correlationIdSchema.parse(`correlation-${client}`),
    projectId: project,
    nodeId,
    clientId: terminalClientIdSchema.parse(client),
  }
}

function control(client = "client-a"): TerminalControlOperationContext {
  return {
    ...operation(client),
    controllerAuthority: {
      controllerNodeId: nodeId,
      controllerEpoch: 1,
      leaseId: leaseIdSchema.parse("lease-1"),
    },
  }
}

function createRequest(overrides: Partial<CreateTerminalRequest> = {}): CreateTerminalRequest {
  return {
    schemaVersion: 1,
    operation: control(),
    terminalId,
    sessionId,
    backendKind: HERDR_KIND,
    columns: 80,
    rows: 24,
    bufferByteLimit: 1024,
    ...overrides,
  }
}

class FakeAuthorizer implements TerminalAuthorizer {
  readonly requests: TerminalAuthorizationRequest[] = []
  denied = new Set<TerminalAction>()

  async authorize(request: TerminalAuthorizationRequest): Promise<Result<void>> {
    this.requests.push(request)
    if (this.denied.has(request.action)) {
      return {
        ok: false,
        error: {
          schemaVersion: 1,
          category: "policy_denied",
          code: "test.denied",
          message: `Denied action ${request.action} by test policy`,
          retryable: false,
          correlationId: request.operation.correlationId,
        },
      }
    }
    return { ok: true, value: undefined }
  }
}

class FakeRecordingHerdrClient implements HerdrClient {
  readonly callLog: Array<{ method: string; args: Record<string, unknown> }> = []
  claimResponse: HerdrClaimResult = { granted: true, epoch: 1, holder: "orchestrator" }
  writeShouldFailWithInputFenced = false
  writeShouldThrow = false
  storedOutput = "line 1\nline 2\n"

  async claimInput(paneId: string, holder: string, epoch: number): Promise<Result<HerdrClaimResult>> {
    this.callLog.push({ method: "claimInput", args: { paneId, holder, epoch } })
    return { ok: true, value: this.claimResponse }
  }

  async releaseInput(paneId: string, holder: string, epoch: number): Promise<Result<void>> {
    this.callLog.push({ method: "releaseInput", args: { paneId, holder, epoch } })
    return { ok: true, value: undefined }
  }

  async sendText(paneId: string, text: string, options?: HerdrWriteOptions): Promise<Result<void>> {
    this.callLog.push({ method: "sendText", args: { paneId, text, ...options } })
    if (this.writeShouldThrow) {
      throw new Error("transport socket dropped unexpectedly")
    }
    if (this.writeShouldFailWithInputFenced) {
      return {
        ok: false,
        error: {
          schemaVersion: 1,
          category: "policy_denied",
          code: "input_fenced",
          message: "pane input is fenced: unheld write rejected",
          retryable: false,
        },
      }
    }
    this.storedOutput += text
    return { ok: true, value: undefined }
  }

  async sendKeys(paneId: string, keys: readonly string[], options?: HerdrWriteOptions): Promise<Result<void>> {
    this.callLog.push({ method: "sendKeys", args: { paneId, keys, ...options } })
    return this.sendText(paneId, keys.join(""), options)
  }

  async readPane(paneId: string, options?: { lines?: number; source?: "scrollback" | "visible" | "recent"; stripAnsi?: boolean }): Promise<Result<string>> {
    this.callLog.push({ method: "readPane", args: { paneId, ...options } })
    return { ok: true, value: this.storedOutput }
  }

  async createPane(options?: { cwd?: string; env?: Record<string, string>; title?: string; command?: readonly string[] }): Promise<Result<{ paneId: string }>> {
    this.callLog.push({ method: "createPane", args: { ...options } })
    return { ok: true, value: { paneId: "fake-pane-42" } }
  }

  async closePane(paneId: string): Promise<Result<void>> {
    this.callLog.push({ method: "closePane", args: { paneId } })
    return { ok: true, value: undefined }
  }

  async resizePane(paneId: string, columns: number, rows: number): Promise<Result<void>> {
    this.callLog.push({ method: "resizePane", args: { paneId, columns, rows } })
    return { ok: true, value: undefined }
  }

  async listPanes(): Promise<Result<readonly { paneId: string }[]>> {
    this.callLog.push({ method: "listPanes", args: {} })
    return { ok: true, value: [{ paneId: "fake-pane-42" }] }
  }

  async getPane(paneId: string): Promise<Result<{ paneId: string } | null>> {
    this.callLog.push({ method: "getPane", args: { paneId } })
    return { ok: true, value: { paneId } }
  }
}

class FakeCliRunner implements ProcessRunner {
  readonly calls: Array<{ argv: readonly string[]; options?: ProcessOptions }> = []
  stdoutByCommand: Record<string, string> = {}
  stderrByCommand: Record<string, string> = {}
  exitCodeByCommand: Record<string, number> = {}

  async exec(argv: readonly string[], options?: ProcessOptions): Promise<ProcessResult> {
    this.calls.push({ argv: [...argv], options })
    const sub = argv[2] ?? ""
    const exitCode = this.exitCodeByCommand[sub] ?? 0
    const stdout = this.stdoutByCommand[sub] ?? ""
    const stderr = this.stderrByCommand[sub] ?? ""
    return { exitCode, stdout, stderr }
  }
}

// ── Test Suites ──────────────────────────────────────────────────────────

describe("HerdrTerminalBackend", () => {
  describe("1. Conformance Suite Integration", () => {
    it("satisfies TerminalBackend contract and passes SDK conformance checks", async () => {
      const backend = new HerdrTerminalBackend()
      const report = await runTerminalBackendConformance(backend)

      expect(report.ok).toBe(true)
      expect(report.suite).toBe("terminal")
      expect(report.targetKind).toBe("herdr")
      expect(report.passedTests).toEqual(["kind", "recover"])
      expect(report.failures).toHaveLength(0)
    })
  })

  describe("2. F1 Fence Discipline (Non-negotiable)", () => {
    it("strictly brackets every write: claim_input -> write -> release_input", async () => {
      const fakeClient = new FakeRecordingHerdrClient()
      const backend = new HerdrTerminalBackend({ client: fakeClient })

      const created = await backend.create(createRequest())
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const attached = await backend.attach(created.value, operation("client-a"))
      expect(attached.ok).toBe(true)
      if (!attached.ok) return

      const channel = attached.value
      fakeClient.callLog.length = 0 // Clear create calls

      // Write data to the channel
      const inputBytes = new TextEncoder().encode("echo 'prompt intent'\n")
      const writeResult = await channel.write(inputBytes)
      expect(writeResult.ok).toBe(true)

      // Verify exact call sequence
      const methods = fakeClient.callLog.map((c) => c.method)
      expect(methods).toEqual(["claimInput", "sendText", "releaseInput"])

      // Verify parameters
      expect(fakeClient.callLog[0].args).toMatchObject({
        paneId: "fake-pane-42",
        holder: "client-a",
        epoch: 0,
      })
      expect(fakeClient.callLog[1].args).toMatchObject({
        paneId: "fake-pane-42",
        text: "echo 'prompt intent'\n",
        holder: "client-a",
        epoch: 1,
      })
      expect(fakeClient.callLog[2].args).toMatchObject({
        paneId: "fake-pane-42",
        holder: "client-a",
        epoch: 1,
      })
    })

    it("respects defaultHolder option when configured", async () => {
      const fakeClient = new FakeRecordingHerdrClient()
      const backend = new HerdrTerminalBackend({
        client: fakeClient,
        defaultHolder: "orchestrator",
      })

      const created = await backend.create(createRequest())
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const attached = await backend.attach(created.value, operation("client-a"))
      expect(attached.ok).toBe(true)
      if (!attached.ok) return

      fakeClient.callLog.length = 0
      const writeResult = await attached.value.write(new TextEncoder().encode("ls\n"))
      expect(writeResult.ok).toBe(true)

      expect(fakeClient.callLog[0].args.holder).toBe("orchestrator")
      expect(fakeClient.callLog[1].args.holder).toBe("orchestrator")
      expect(fakeClient.callLog[2].args.holder).toBe("orchestrator")
    })

    it("human-focused pane refusal (granted: false, holder: 'human') fails clearly and NEVER writes", async () => {
      const fakeClient = new FakeRecordingHerdrClient()
      // Simulate human-focused pane refusal per Herdr fork semantics
      fakeClient.claimResponse = { granted: false, epoch: 0, holder: "human" }

      const backend = new HerdrTerminalBackend({ client: fakeClient })
      const created = await backend.create(createRequest())
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const attached = await backend.attach(created.value, operation("client-a"))
      expect(attached.ok).toBe(true)
      if (!attached.ok) return

      fakeClient.callLog.length = 0
      const writeResult = await attached.value.write(new TextEncoder().encode("interleaved typing\n"))

      // Must fail clearly
      expect(writeResult.ok).toBe(false)
      if (writeResult.ok) return

      expect(writeResult.error.category).toBe("policy_denied")
      expect(writeResult.error.code).toBe("terminal.input_fenced")
      expect(writeResult.error.message).toContain("human-focused")
      expect(writeResult.error.retryable).toBe(false)

      // Inviolable invariant: NEVER write when claim refused; NO release when unheld
      const methods = fakeClient.callLog.map((c) => c.method)
      expect(methods).toEqual(["claimInput"])
      expect(methods).not.toContain("sendText")
      expect(methods).not.toContain("releaseInput")
    })

    it("conflicting external holder refusal fails clearly and NEVER writes", async () => {
      const fakeClient = new FakeRecordingHerdrClient()
      fakeClient.claimResponse = { granted: false, epoch: 7, holder: "other-agent" }

      const backend = new HerdrTerminalBackend({ client: fakeClient })
      const created = await backend.create(createRequest())
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const attached = await backend.attach(created.value, operation("client-a"))
      expect(attached.ok).toBe(true)
      if (!attached.ok) return

      fakeClient.callLog.length = 0
      const writeResult = await attached.value.write(new TextEncoder().encode("test\n"))

      expect(writeResult.ok).toBe(false)
      if (writeResult.ok) return
      expect(writeResult.error.code).toBe("terminal.input_fenced")
      expect(writeResult.error.message).toContain("other-agent")

      // Neither sendText nor releaseInput may run
      const methods = fakeClient.callLog.map((c) => c.method)
      expect(methods).toEqual(["claimInput"])
    })

    it("surfaces input_fenced write rejection as a typed non-retryable failure without retrying around fence", async () => {
      const fakeClient = new FakeRecordingHerdrClient()
      // Claim succeeds, but write rejects with input_fenced
      fakeClient.claimResponse = { granted: true, epoch: 2, holder: "orchestrator" }
      fakeClient.writeShouldFailWithInputFenced = true

      const backend = new HerdrTerminalBackend({ client: fakeClient })
      const created = await backend.create(createRequest())
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const attached = await backend.attach(created.value, operation("client-a"))
      expect(attached.ok).toBe(true)
      if (!attached.ok) return

      fakeClient.callLog.length = 0
      const writeResult = await attached.value.write(new TextEncoder().encode("write to fenced pane\n"))

      expect(writeResult.ok).toBe(false)
      if (writeResult.ok) return

      expect(writeResult.error.category).toBe("policy_denied")
      expect(writeResult.error.code).toBe("terminal.input_fenced")
      expect(writeResult.error.retryable).toBe(false)

      // Verified: sendText was called exactly ONCE (never retried around fence), and releaseInput ran in finally
      const methods = fakeClient.callLog.map((c) => c.method)
      expect(methods).toEqual(["claimInput", "sendText", "releaseInput"])
    })

    it("always releases input fence even if write throws an unexpected exception", async () => {
      const fakeClient = new FakeRecordingHerdrClient()
      fakeClient.writeShouldThrow = true

      const backend = new HerdrTerminalBackend({ client: fakeClient })
      const created = await backend.create(createRequest())
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const attached = await backend.attach(created.value, operation("client-a"))
      expect(attached.ok).toBe(true)
      if (!attached.ok) return

      fakeClient.callLog.length = 0
      const writeResult = await attached.value.write(new TextEncoder().encode("throwing write\n"))

      expect(writeResult.ok).toBe(false)
      if (writeResult.ok) return
      expect(writeResult.error.category).toBe("runtime_failure")

      // releaseInput MUST still be called in finally block
      const methods = fakeClient.callLog.map((c) => c.method)
      expect(methods).toEqual(["claimInput", "sendText", "releaseInput"])
    })
  })

  describe("3. Lifecycle & Channel Operations", () => {
    it("creates terminal with normalized dimensions and attaches channel", async () => {
      const backend = new HerdrTerminalBackend()
      const req = createRequest({ columns: 5000, rows: 0.5 })
      const created = await backend.create(req)

      expect(created.ok).toBe(true)
      if (!created.ok) return
      expect(created.value.backendKind).toBe("herdr")
      expect(created.value.terminalId).toBe(terminalId)
      expect(created.value.adapterMetadata.paneId).toBeDefined()

      const attached = await backend.attach(created.value, operation("client-a"))
      expect(attached.ok).toBe(true)
      if (!attached.ok) return
      expect(attached.value.clientId).toBe("client-a")
    })

    it("rejects create request with mismatched backendKind", async () => {
      const backend = new HerdrTerminalBackend()
      const created = await backend.create(createRequest({ backendKind: "tmux" }))
      expect(created.ok).toBe(false)
      if (created.ok) return
      expect(created.error.category).toBe("unsupported_capability")
      expect(created.error.code).toBe("terminal.backend_mismatch")
    })

    it("rejects duplicate terminal identifier creation", async () => {
      const backend = new HerdrTerminalBackend()
      const first = await backend.create(createRequest())
      expect(first.ok).toBe(true)

      const second = await backend.create(createRequest())
      expect(second.ok).toBe(false)
      if (second.ok) return
      expect(second.error.category).toBe("conflict")
      expect(second.error.code).toBe("terminal.already_exists")
    })

    it("executes sessionCommand if configured during create", async () => {
      const resolvedCommand = ["/usr/bin/opencode", "attach", "4096"] as const
      const backend = new HerdrTerminalBackend({
        sessionCommand: async () => ({ ok: true, value: resolvedCommand }),
      })
      const created = await backend.create(createRequest())
      expect(created.ok).toBe(true)
    })

    it("reads output from pane and computes deltas on subsequent reads", async () => {
      const fakeClient = new FakeRecordingHerdrClient()
      fakeClient.storedOutput = "first output\n"
      const backend = new HerdrTerminalBackend({ client: fakeClient })

      const created = await backend.create(createRequest())
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const attached = await backend.attach(created.value, operation("client-a"))
      expect(attached.ok).toBe(true)
      if (!attached.ok) return

      const firstRead = await attached.value.read(1024)
      expect(firstRead.ok).toBe(true)
      if (!firstRead.ok) return
      expect(new TextDecoder().decode(firstRead.value)).toBe("first output\n")

      // Subsequent read with appended output returns only the delta
      fakeClient.storedOutput = "first output\nsecond line\n"
      const secondRead = await attached.value.read(1024)
      expect(secondRead.ok).toBe(true)
      if (!secondRead.ok) return
      expect(new TextDecoder().decode(secondRead.value)).toBe("second line\n")
    })

    it("captures bounded terminal snapshots", async () => {
      const fakeClient = new FakeRecordingHerdrClient()
      fakeClient.storedOutput = "complete terminal scrollback buffer content"
      const backend = new HerdrTerminalBackend({ client: fakeClient })

      const created = await backend.create(createRequest({ bufferByteLimit: 20 }))
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const snap = await backend.snapshot(created.value, operation("client-a"))
      expect(snap.ok).toBe(true)
      if (!snap.ok) return

      expect(snap.value.byteCount).toBe(20)
      expect(snap.value.truncated).toBe(true)
      expect(snap.value.terminalId).toBe(terminalId)
      expect(snap.value.nodeId).toBe(nodeId)
      expect(snap.value.projectId).toBe(projectId)
    })

    it("resizes terminal with valid dimensions", async () => {
      const fakeClient = new FakeRecordingHerdrClient()
      const backend = new HerdrTerminalBackend({ client: fakeClient })

      const created = await backend.create(createRequest())
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const resized = await backend.resize(created.value, { columns: 120, rows: 40 }, operation("client-a"))
      expect(resized.ok).toBe(true)

      const resizeCalls = fakeClient.callLog.filter((c) => c.method === "resizePane")
      expect(resizeCalls).toHaveLength(1)
      expect(resizeCalls[0].args).toMatchObject({ columns: 120, rows: 40 })
    })

    it("detaches active client channel and cleans ownership", async () => {
      const backend = new HerdrTerminalBackend()
      const created = await backend.create(createRequest())
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const attached = await backend.attach(created.value, operation("client-a"))
      expect(attached.ok).toBe(true)
      if (!attached.ok) return

      await attached.value.requestInputOwnership(operation("client-a"))

      const detached = await backend.detach(created.value, operation("client-a"))
      expect(detached.ok).toBe(true)

      // Subsequent write on detached channel is refused
      const writeOnDetached = await attached.value.write(new TextEncoder().encode("data\n"))
      expect(writeOnDetached.ok).toBe(false)
    })

    it("terminates terminal, closes pane, and unbinds state", async () => {
      const fakeClient = new FakeRecordingHerdrClient()
      const backend = new HerdrTerminalBackend({ client: fakeClient })

      const created = await backend.create(createRequest())
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const termResult = await backend.terminate(created.value, control("client-a"))
      expect(termResult.ok).toBe(true)

      const closeCalls = fakeClient.callLog.filter((c) => c.method === "closePane")
      expect(closeCalls).toHaveLength(1)

      // Subsequent attach to terminated terminal fails with not_found
      const reattach = await backend.attach(created.value, operation("client-a"))
      expect(reattach.ok).toBe(false)
    })

    it("recovers active terminals matching scope", async () => {
      const backend = new HerdrTerminalBackend()
      const createdA = await backend.create(createRequest({ terminalId: terminalIdSchema.parse("term:1") }))
      const createdB = await backend.create(createRequest({ terminalId: terminalIdSchema.parse("term:2"), operation: control("client-b") }))
      expect(createdA.ok).toBe(true)
      expect(createdB.ok).toBe(true)

      const recovered = await backend.recover(operation("client-a", projectId))
      expect(recovered.ok).toBe(true)
      if (!recovered.ok) return
      expect(recovered.value).toHaveLength(2)

      const otherProjectRecovered = await backend.recover(operation("client-a", otherProjectId))
      expect(otherProjectRecovered.ok).toBe(true)
      if (!otherProjectRecovered.ok) return
      expect(otherProjectRecovered.value).toHaveLength(0)
    })
  })

  describe("4. AIBridge Input Ownership Coordination", () => {
    it("coordinates single-owner input claims, releases, and takeovers", async () => {
      const backend = new HerdrTerminalBackend()
      const created = await backend.create(createRequest())
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const attachedA = await backend.attach(created.value, operation("client-a"))
      const attachedB = await backend.attach(created.value, operation("client-b"))
      expect(attachedA.ok).toBe(true)
      expect(attachedB.ok).toBe(true)
      if (!attachedA.ok || !attachedB.ok) return

      const channelA = attachedA.value
      const channelB = attachedB.value

      // Client A claims input ownership
      const claimedA = await channelA.requestInputOwnership(operation("client-a"))
      expect(claimedA.ok).toBe(true)
      if (!claimedA.ok) return
      expect(claimedA.value.ownerClientId).toBe("client-a")

      // Client B cannot claim while held by A
      const claimB = await channelB.requestInputOwnership(operation("client-b"))
      expect(claimB.ok).toBe(false)
      if (claimB.ok) return
      expect(claimB.error.code).toBe("terminal.input_owned")

      // Client B cannot write while held by A
      const writeB = await channelB.write(new TextEncoder().encode("unauthorized\n"))
      expect(writeB.ok).toBe(false)
      if (writeB.ok) return
      expect(writeB.error.code).toBe("terminal.input_not_owned")

      // Client B takes over input ownership
      const takeoverReq: InputTakeoverRequest = {
        schemaVersion: 1,
        operation: operation("client-b"),
        reason: "operator override",
      }
      const takeoverB = await channelB.takeOverInput(takeoverReq)
      expect(takeoverB.ok).toBe(true)
      if (!takeoverB.ok) return
      expect(takeoverB.value.ownerClientId).toBe("client-b")

      // Now Client B can write
      const writeBAllowed = await channelB.write(new TextEncoder().encode("authorized\n"))
      expect(writeBAllowed.ok).toBe(true)

      // Client B releases input ownership
      const releaseB = await channelB.releaseInputOwnership(operation("client-b"))
      expect(releaseB.ok).toBe(true)
      if (!releaseB.ok) return
      expect(releaseB.value.ownerClientId).toBeNull()
    })
  })

  describe("5. InMemoryHerdrClient Conformance", () => {
    it("implements human focus and fence epoch semantics accurately", async () => {
      const client = new InMemoryHerdrClient()
      const pane = await client.createPane()
      expect(pane.ok).toBe(true)
      if (!pane.ok) return
      const paneId = pane.value.paneId

      // 1. Initial claim on unfocused pane succeeds at epoch 1
      const claim1 = await client.claimInput(paneId, "orchestrator", 0)
      expect(claim1.ok).toBe(true)
      if (!claim1.ok) return
      expect(claim1.value).toEqual({ granted: true, epoch: 1, holder: "orchestrator" })

      // 2. Write while holding fence succeeds
      const write1 = await client.sendText(paneId, "prompt text\n", { holder: "orchestrator", epoch: 1 })
      expect(write1.ok).toBe(true)

      // 3. Release fence succeeds
      const rel1 = await client.releaseInput(paneId, "orchestrator", 1)
      expect(rel1.ok).toBe(true)

      // 4. Set pane human focused
      client.setHumanFocused(paneId, true)

      // 5. Claim on human focused pane is refused with holder: 'human'
      const claimHuman = await client.claimInput(paneId, "orchestrator", 1)
      expect(claimHuman.ok).toBe(true)
      if (!claimHuman.ok) return
      expect(claimHuman.value.granted).toBe(false)
      expect(claimHuman.value.holder).toBe("human")

      // 6. Direct write on human-focused pane is rejected with input_fenced
      const writeHuman = await client.sendText(paneId, "blocked\n", { holder: "orchestrator", epoch: 1 })
      expect(writeHuman.ok).toBe(false)
      if (writeHuman.ok) return
      expect(writeHuman.error.code).toBe("input_fenced")
    })
  })

  describe("6. CliHerdrClient Unit Execution", () => {
    it("executes CLI commands via ProcessRunner", async () => {
      const runner = new FakeCliRunner()
      runner.stdoutByCommand["claim-input"] = JSON.stringify({ granted: true, epoch: 1, holder: "orchestrator" })
      runner.stdoutByCommand["read"] = "pane output line\n"
      runner.stdoutByCommand["split"] = "pane-101\n"

      const client = new CliHerdrClient(runner)

      const claim = await client.claimInput("pane-1", "orchestrator", 0)
      expect(claim.ok).toBe(true)
      if (!claim.ok) return
      expect(claim.value.granted).toBe(true)

      const write = await client.sendText("pane-1", "data\n")
      expect(write.ok).toBe(true)

      const read = await client.readPane("pane-1")
      expect(read.ok).toBe(true)
      if (!read.ok) return
      expect(read.value).toBe("pane output line\n")

      const release = await client.releaseInput("pane-1", "orchestrator", 1)
      expect(release.ok).toBe(true)

      const split = await client.createPane()
      expect(split.ok).toBe(true)

      const close = await client.closePane("pane-1")
      expect(close.ok).toBe(true)

      expect(runner.calls.length).toBe(6)
    })

    it("surfaces input_fenced exit code or stderr as typed policy error", async () => {
      const runner = new FakeCliRunner()
      runner.exitCodeByCommand["send-text"] = 1
      runner.stderrByCommand["send-text"] = "error: input_fenced: pane input is fenced"

      const client = new CliHerdrClient(runner)
      const write = await client.sendText("pane-1", "interleave\n")

      expect(write.ok).toBe(false)
      if (write.ok) return
      expect(write.error.category).toBe("policy_denied")
      expect(write.error.code).toBe("input_fenced")
    })
  })

  describe("7. DI Terminal Backend Factory Selection", () => {
    it("constructs TmuxTerminalBackend when backend is 'tmux'", () => {
      const runner = new FakeCliRunner()
      const backend = createTerminalBackend({ backend: "tmux" }, { processRunner: runner })

      expect(backend).toBeInstanceOf(TmuxTerminalBackend)
      expect(backend.kind).toBe("tmux")
    })

    it("constructs HerdrTerminalBackend when backend is 'herdr'", () => {
      const runner = new FakeCliRunner()
      const backend = createTerminalBackend({ backend: "herdr" }, { processRunner: runner })

      expect(backend).toBeInstanceOf(HerdrTerminalBackend)
      expect(backend.kind).toBe("herdr")
    })
  })
})
