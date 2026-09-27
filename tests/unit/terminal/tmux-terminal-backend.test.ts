import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
import type {
  CreateTerminalRequest,
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

class FakeRunner implements ProcessRunner {
  readonly calls: Array<{ argv: readonly string[]; options?: ProcessOptions }> = []
  captureOutput = ""
  failCommands = new Set<string>()
  private sessionName = ""
  private owner = ""

  async exec(argv: readonly string[], options?: ProcessOptions): Promise<ProcessResult> {
    this.calls.push({ argv: [...argv], options })
    const command = argv[1] ?? ""
    if (this.failCommands.has(command)) return { exitCode: 1, stdout: "", stderr: "fake failure" }
    if (command === "new-session") {
      this.sessionName = argv[argv.indexOf("-s") + 1] ?? ""
      return { exitCode: 0, stdout: "%42", stderr: "" }
    }
    if (command === "display-message") return { exitCode: 0, stdout: `${this.sessionName}:%42`, stderr: "" }
    if (command === "show-options") return { exitCode: this.owner ? 0 : 1, stdout: this.owner, stderr: "" }
    if (command === "set-option") {
      this.owner = argv.includes("-u") ? "" : (argv.at(-1) ?? "")
      return { exitCode: 0, stdout: "", stderr: "" }
    }
    if (command === "capture-pane") return { exitCode: 0, stdout: this.captureOutput, stderr: "" }
    return { exitCode: 0, stdout: "", stderr: "" }
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
          message: "Denied by test policy",
          retryable: false,
          correlationId: request.operation.correlationId,
        },
      }
    }
    return { ok: true, value: undefined }
  }
}

const nodeId = nodeIdSchema.parse("node-local")
const projectId = projectIdSchema.parse("project-a")
const otherProjectId = projectIdSchema.parse("project-b")
const terminalId = terminalIdSchema.parse("term:opaque.with-dots")
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
    backendKind: "tmux",
    columns: 80,
    rows: 24,
    bufferByteLimit: 1024,
    ...overrides,
  }
}

async function fixture(overrides: { runner?: FakeRunner; authorizer?: FakeAuthorizer; directory?: string; sessionCommand?: () => Promise<Result<readonly [string, ...string[]]>> } = {}) {
  const runner = overrides.runner ?? new FakeRunner()
  const authorizer = overrides.authorizer ?? new FakeAuthorizer()
  const directory = overrides.directory ?? await mkdtemp(join(tmpdir(), "aibr-tmux-unit-"))
  const backend = new TmuxTerminalBackend({
    processRunner: runner,
    authorizer,
    recoveryDirectory: directory,
    clock: () => new Date("2026-09-17T09:00:00.000Z"),
    ...(overrides.sessionCommand === undefined ? {} : { sessionCommand: overrides.sessionCommand }),
  })
  return { runner, authorizer, directory, backend }
}

async function createTerminal(overrides: Parameters<typeof fixture>[0] = {}, request = createRequest()) {
  const built = await fixture(overrides)
  const created = await built.backend.create(request)
  expect(created.ok).toBe(true)
  if (!created.ok) throw new Error(created.error.message)
  return { ...built, reference: created.value }
}

describe("TmuxTerminalBackend", () => {
  it("creates with normalized dimensions and only fixed argv elements", async () => {
    const { runner, authorizer, directory, reference } = await createTerminal({}, createRequest({ columns: 5000.9, rows: 12.8 } as Partial<CreateTerminalRequest>))

    const createCall = runner.calls.find((call) => call.argv[1] === "new-session")
    expect(createCall?.argv).toEqual([
      "tmux", "new-session", "-d", "-P", "-F", "#{pane_id}", "-s", expect.stringMatching(/^aibr-tmux-[0-9a-f]{64}$/), "-x", "1000", "-y", "12",
    ])
    expect(createCall?.argv).not.toContain(reference.terminalId)
    expect(runner.calls.every((call) => Array.isArray(call.argv))).toBe(true)
    expect(authorizer.requests.find((request) => request.action === "create")?.reference).toEqual(reference)

    const persisted = JSON.parse(await readFile(join(directory, `${terminalId}.json`), "utf8")) as Record<string, unknown>
    expect(persisted.lifecycle).toBe("active")
    expect(JSON.stringify(persisted)).not.toContain("transcript")
  })

  it("starts the exact agent attachment command as argv without exposing credentials", async () => {
    const command = ["opencode", "attach", "http://127.0.0.1:4096", "--session", "provider-1", "--dir", "/workspace/local", "--mini"] as const
    const { runner } = await createTerminal({ sessionCommand: async () => ({ ok: true, value: command }) })
    const createCall = runner.calls.find((call) => call.argv[1] === "new-session")
    expect(createCall?.argv.slice(-command.length)).toEqual(command)
    expect(createCall?.argv.join(" ")).not.toContain("password")
    expect(createCall?.argv).not.toContain("sh")
    expect(createCall?.argv).not.toContain("-c")
  })

  it("attaches read-only, grants input separately, and encodes bytes without a shell", async () => {
    const { backend, runner, reference } = await createTerminal()
    const attached = await backend.attach(reference, operation())
    expect(attached.ok).toBe(true)
    if (!attached.ok) return

    const denied = await attached.value.write(Uint8Array.from([0x61]))
    expect(denied).toMatchObject({ ok: false, error: { code: "terminal.input_not_owned" } })

    const ownership = await attached.value.requestInputOwnership(operation())
    expect(ownership).toMatchObject({ ok: true, value: { ownerClientId: "client-a" } })
    const written = await attached.value.write(Uint8Array.from([0, 0x1d, 0x41, 0xff]))
    expect(written).toEqual({ ok: true, value: undefined })

    const send = runner.calls.find((call) => call.argv[1] === "send-keys")
    expect(send?.argv.slice(0, 6)).toEqual(["tmux", "send-keys", "-t", "%42", "-H", "00"])
    expect(send?.argv.slice(6)).toEqual(["1d", "41", "ff"])
    expect(send?.argv).not.toContain("sh")
    expect(send?.argv).not.toContain("-c")
  })

  it("enforces explicit takeover and rejects the former owner's queued writes", async () => {
    const { backend, runner, authorizer, reference } = await createTerminal()
    const first = await backend.attach(reference, operation("client-a"))
    const second = await backend.attach(reference, operation("client-b"))
    if (!first.ok || !second.ok) throw new Error("attach failed")
    expect(await first.value.requestInputOwnership(operation("client-a"))).toMatchObject({ ok: true })
    expect(await second.value.requestInputOwnership(operation("client-b"))).toMatchObject({ ok: false, error: { code: "terminal.input_owned" } })

    const takeover = await second.value.takeOverInput({
      schemaVersion: 1,
      operation: operation("client-b"),
      reason: "The original UI disconnected",
    })
    expect(takeover).toMatchObject({ ok: true, value: { ownerClientId: "client-b" } })
    const callsBeforeOldWrite = runner.calls.length
    expect(await first.value.write(new TextEncoder().encode("old"))).toMatchObject({ ok: false, error: { code: "terminal.input_not_owned" } })
    expect(runner.calls.slice(callsBeforeOldWrite).some((call) => call.argv[1] === "send-keys")).toBe(false)

    expect(await first.value.releaseInputOwnership(operation("client-a"))).toMatchObject({ ok: true, value: { ownerClientId: "client-b" } })
    expect(await second.value.write(new TextEncoder().encode("new"))).toMatchObject({ ok: true })
    expect(authorizer.requests.find((request) => request.action === "takeover_input")?.takeoverReason).toBe("The original UI disconnected")
  })

  it("shares input ownership across independent backend instances", async () => {
    const { backend: firstBackend, runner, authorizer, directory, reference } = await createTerminal()
    const secondBackend = new TmuxTerminalBackend({
      processRunner: runner,
      authorizer,
      recoveryDirectory: directory,
      clock: () => new Date("2026-09-17T09:00:00.000Z"),
    })
    expect(await secondBackend.recover(operation("client-b"))).toMatchObject({ ok: true })
    const first = await firstBackend.attach(reference, operation("client-a"))
    const second = await secondBackend.attach(reference, operation("client-b"))
    if (!first.ok || !second.ok) throw new Error("attach failed")

    expect(await first.value.requestInputOwnership(operation("client-a"))).toMatchObject({ ok: true, value: { ownerClientId: "client-a" } })
    expect(await second.value.requestInputOwnership(operation("client-b"))).toMatchObject({ ok: false, error: { code: "terminal.input_owned" } })
    expect(await second.value.takeOverInput({ schemaVersion: 1, operation: operation("client-b"), reason: "Explicit second-process takeover" })).toMatchObject({ ok: true })
    expect(await first.value.write(Uint8Array.of(0x61))).toMatchObject({ ok: false, error: { code: "terminal.input_not_owned" } })
    expect(await second.value.write(Uint8Array.of(0x62))).toEqual({ ok: true, value: undefined })
  })

  it("requires live authorization for takeover and every write", async () => {
    const authorizer = new FakeAuthorizer()
    const { backend, runner, reference } = await createTerminal({ authorizer })
    const first = await backend.attach(reference, operation("client-a"))
    const second = await backend.attach(reference, operation("client-b"))
    if (!first.ok || !second.ok) throw new Error("attach failed")
    await first.value.requestInputOwnership(operation("client-a"))

    authorizer.denied.add("takeover_input")
    expect(await second.value.takeOverInput({ schemaVersion: 1, operation: operation("client-b"), reason: "Need control" })).toMatchObject({ ok: false, error: { code: "test.denied" } })
    authorizer.denied.delete("takeover_input")
    authorizer.denied.add("write")
    const before = runner.calls.length
    expect(await first.value.write(Uint8Array.of(1))).toMatchObject({ ok: false, error: { code: "test.denied" } })
    expect(runner.calls).toHaveLength(before)
  })

  it("detach synchronously closes the channel, releases ownership, and preserves tmux", async () => {
    const { backend, runner, reference } = await createTerminal()
    const attached = await backend.attach(reference, operation())
    if (!attached.ok) throw new Error("attach failed")
    await attached.value.requestInputOwnership(operation())
    expect(await backend.detach(reference, operation())).toEqual({ ok: true, value: undefined })

    const before = runner.calls.length
    expect(await attached.value.write(Uint8Array.of(0x61))).toMatchObject({ ok: false, error: { code: "terminal.input_not_owned" } })
    expect(await attached.value.write(new Uint8Array())).toMatchObject({ ok: false, error: { code: "terminal.input_not_owned" } })
    expect(runner.calls).toHaveLength(before)
    expect(runner.calls.some((call) => call.argv[1] === "kill-pane")).toBe(false)
  })

  it("keeps terminate distinct and permanently rejects writes after termination begins", async () => {
    const { backend, runner, directory, reference } = await createTerminal()
    const attached = await backend.attach(reference, operation())
    if (!attached.ok) throw new Error("attach failed")
    await attached.value.requestInputOwnership(operation())
    expect(await backend.terminate(reference, control())).toEqual({ ok: true, value: undefined })
    expect(runner.calls.some((call) => call.argv[1] === "kill-pane")).toBe(true)
    expect(await attached.value.write(Uint8Array.of(0x61))).toMatchObject({ ok: false, error: { code: "terminal.input_not_owned" } })
    await expect(readFile(join(directory, `${terminalId}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects cross-project and altered session references with zero tmux effects", async () => {
    const { backend, runner, reference } = await createTerminal()
    const calls = runner.calls.length
    const wrongProject = await backend.attach(reference, operation("client-a", otherProjectId))
    expect(wrongProject).toMatchObject({ ok: false, error: { code: "terminal.binding_mismatch" } })
    const forged: TerminalReference = { ...reference, sessionId: sessionIdSchema.parse("session-other") }
    const wrongSession = await backend.attach(forged, operation())
    expect(wrongSession).toMatchObject({ ok: false, error: { code: "terminal.binding_mismatch" } })
    expect(runner.calls).toHaveLength(calls)
  })

  it("normalizes resize but only lets the active owner resize", async () => {
    const { backend, runner, reference } = await createTerminal()
    const attached = await backend.attach(reference, operation())
    if (!attached.ok) throw new Error("attach failed")
    expect(await backend.resize(reference, { columns: 140.9, rows: 2000 }, operation())).toMatchObject({ ok: false, error: { code: "terminal.input_not_owned" } })
    await attached.value.requestInputOwnership(operation())
    expect(await backend.resize(reference, { columns: 140.9, rows: 2000 }, operation())).toEqual({ ok: true, value: undefined })
    expect(runner.calls.find((call) => call.argv[1] === "resize-window")?.argv.slice(-4)).toEqual(["-x", "140", "-y", "1000"])
  })

  it("bounds snapshots, stream reads, and per-write input", async () => {
    const runner = new FakeRunner()
    runner.captureOutput = "abcdefgh"
    const { backend, reference } = await createTerminal({ runner }, createRequest({ bufferByteLimit: 4 }))
    const snap = await backend.snapshot(reference, operation())
    expect(snap).toMatchObject({ ok: true, value: { byteCount: 4, truncated: true } })
    if (snap.ok) expect(new TextDecoder().decode(snap.value.data)).toBe("efgh")

    const attached = await backend.attach(reference, operation())
    if (!attached.ok) throw new Error("attach failed")
    const read = await attached.value.read(2)
    expect(read.ok && new TextDecoder().decode(read.value)).toBe("gh")
    await attached.value.requestInputOwnership(operation())
    expect(await attached.value.write(new Uint8Array(64 * 1024 + 1))).toMatchObject({ ok: false, error: { code: "terminal.input_too_large" } })
  })

  it("freezes writes when the persisted pane no longer belongs to its exact tmux session", async () => {
    const { backend, runner, reference } = await createTerminal()
    const attached = await backend.attach(reference, operation())
    if (!attached.ok) throw new Error("attach failed")
    await attached.value.requestInputOwnership(operation())
    runner.failCommands.add("display-message")
    const sendsBefore = runner.calls.filter((call) => call.argv[1] === "send-keys").length
    expect(await attached.value.write(Uint8Array.of(0x61))).toMatchObject({ ok: false, error: { code: "terminal.target_unavailable" } })
    expect(runner.calls.filter((call) => call.argv[1] === "send-keys")).toHaveLength(sendsBefore)
    expect(await attached.value.write(Uint8Array.of(0x62))).toMatchObject({ ok: false, error: { code: "terminal.input_not_owned" } })
  })

  it("recovers only exact node/project bindings and defaults recovered sessions to read-only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibr-tmux-recover-"))
    const first = await createTerminal({ directory })
    const runner = first.runner
    const authorizer = new FakeAuthorizer()
    const restarted = (await fixture({ directory, runner, authorizer })).backend
    const recovered = await restarted.recover(operation())
    expect(recovered).toEqual({ ok: true, value: [first.reference] })
    const attached = recovered.ok ? await restarted.attach(recovered.value[0]!, operation()) : recovered
    expect(attached.ok).toBe(true)
    if (attached.ok) expect(await attached.value.write(Uint8Array.of(0x61))).toMatchObject({ ok: false, error: { code: "terminal.input_not_owned" } })

    expect(await restarted.recover(operation("client-a", otherProjectId))).toEqual({ ok: true, value: [] })
  })

  it("fails closed on corrupt or missing recovery metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibr-tmux-corrupt-"))
    await writeFile(join(directory, "broken.json"), "{not json", "utf8")
    const { backend } = await fixture({ directory })
    expect(await backend.recover(operation())).toMatchObject({ ok: false, error: { code: "terminal.recovery_corrupt" } })

    const clean = await fixture()
    const missing: TerminalReference = {
      schemaVersion: 1,
      terminalId: terminalIdSchema.parse("missing-terminal"),
      nodeId,
      projectId,
      sessionId,
      backendKind: "tmux",
      adapterMetadata: { recoveryVersion: "1" },
    }
    expect(await clean.backend.attach(missing, operation())).toMatchObject({ ok: false, error: { code: "terminal.binding_missing" } })
    expect(clean.runner.calls).toHaveLength(0)
  })
})
