import type { ContractError, Result } from "../../../../src/orchestration/errors.js"
import {
  commandIdSchema,
  correlationIdSchema,
  nodeIdSchema,
  projectIdSchema,
  sessionIdSchema,
  terminalClientIdSchema,
  terminalIdSchema,
} from "../../../../src/orchestration/identifiers.js"
import type {
  CreateTerminalRequest,
  InputTakeoverRequest,
  TerminalBackend,
  TerminalChannel,
  TerminalControlOperationContext,
  TerminalDimensions,
  TerminalInputOwnership,
  TerminalOperationContext,
  TerminalReference,
  TerminalSnapshot,
} from "../../../../src/terminal/types.js"
import type { TerminalControllerScheduler, TerminalViewModel, TerminalViewPort } from "../../../../src/tui/terminal/index.js"

export const clientId = terminalClientIdSchema.parse("terminal-ui-a")
export const otherClientId = terminalClientIdSchema.parse("terminal-ui-b")

export const reference: TerminalReference = {
  schemaVersion: 1,
  terminalId: terminalIdSchema.parse("terminal-a"),
  nodeId: nodeIdSchema.parse("node-a"),
  projectId: projectIdSchema.parse("project-a"),
  sessionId: sessionIdSchema.parse("session-a"),
  backendKind: "tmux",
  adapterMetadata: { recoveryVersion: "1" },
}

let operationSequence = 0
export function operation(): TerminalOperationContext {
  operationSequence += 1
  return {
    schemaVersion: 1,
    commandId: commandIdSchema.parse(`terminal-command-${operationSequence}`),
    correlationId: correlationIdSchema.parse(`terminal-correlation-${operationSequence}`),
    nodeId: reference.nodeId,
    projectId: reference.projectId,
    clientId,
  }
}

export function error(code: string, message = "fixture failure"): ContractError {
  return { schemaVersion: 1, category: "conflict", code, message, retryable: false }
}

export function ownership(ownerClientId: typeof clientId | typeof otherClientId | null): TerminalInputOwnership {
  return {
    schemaVersion: 1,
    terminalId: reference.terminalId,
    ownerClientId,
    changedAt: "2026-09-17T09:00:00.000Z",
  }
}

export class Deferred<T> {
  readonly promise: Promise<T>
  resolve!: (value: T) => void

  constructor() {
    this.promise = new Promise<T>((resolve) => { this.resolve = resolve })
  }
}

export class FakeTerminalChannel implements TerminalChannel {
  readonly reference = reference
  readonly clientId = clientId
  readonly reads: number[] = []
  readonly writes: Uint8Array[] = []
  readonly takeoverReasons: string[] = []
  releaseCount = 0
  owner: typeof clientId | typeof otherClientId | null = null
  readChunks: Uint8Array[] = []
  writeGate: Deferred<void> | null = null

  async read(maxBytes: number): Promise<Result<Uint8Array>> {
    this.reads.push(maxBytes)
    return { ok: true, value: Uint8Array.from(this.readChunks.shift() ?? []) }
  }

  async write(data: Uint8Array): Promise<Result<void>> {
    this.writes.push(Uint8Array.from(data))
    if (this.writeGate !== null) await this.writeGate.promise
    if (this.owner !== this.clientId) return { ok: false, error: error("terminal.input_not_owned") }
    return { ok: true, value: undefined }
  }

  async requestInputOwnership(_operation: TerminalOperationContext): Promise<Result<TerminalInputOwnership>> {
    if (this.owner !== null && this.owner !== this.clientId) {
      return { ok: false, error: error("terminal.input_owned", "Terminal input is owned by another client") }
    }
    this.owner = this.clientId
    return { ok: true, value: ownership(this.owner) }
  }

  async releaseInputOwnership(_operation: TerminalOperationContext): Promise<Result<TerminalInputOwnership>> {
    this.releaseCount += 1
    if (this.owner === this.clientId) this.owner = null
    return { ok: true, value: ownership(this.owner) }
  }

  async takeOverInput(request: InputTakeoverRequest): Promise<Result<TerminalInputOwnership>> {
    this.takeoverReasons.push(request.reason)
    this.owner = this.clientId
    return { ok: true, value: ownership(this.owner) }
  }
}

export class FakeTerminalBackend implements TerminalBackend {
  readonly kind = "fixture"
  readonly channel = new FakeTerminalChannel()
  readonly resizeCalls: TerminalDimensions[] = []
  readonly detachCalls: TerminalReference[] = []
  terminateCount = 0

  async create(_request: CreateTerminalRequest): Promise<Result<TerminalReference>> {
    return { ok: true, value: reference }
  }

  async attach(_reference: TerminalReference, _operation: TerminalOperationContext): Promise<Result<TerminalChannel>> {
    return { ok: true, value: this.channel }
  }

  async resize(_reference: TerminalReference, dimensions: TerminalDimensions, _operation: TerminalOperationContext): Promise<Result<void>> {
    this.resizeCalls.push(dimensions)
    return this.channel.owner === this.channel.clientId
      ? { ok: true, value: undefined }
      : { ok: false, error: error("terminal.input_not_owned") }
  }

  async snapshot(_reference: TerminalReference, _operation: TerminalOperationContext): Promise<Result<TerminalSnapshot>> {
    return {
      ok: true,
      value: {
        schemaVersion: 1,
        terminalId: reference.terminalId,
        nodeId: reference.nodeId,
        projectId: reference.projectId,
        sessionId: reference.sessionId,
        capturedAt: "2026-09-17T09:00:00.000Z",
        byteCount: 0,
        truncated: false,
        data: new Uint8Array(),
      },
    }
  }

  async detach(detached: TerminalReference, _operation: TerminalOperationContext): Promise<Result<void>> {
    this.detachCalls.push(detached)
    this.channel.owner = null
    return { ok: true, value: undefined }
  }

  async terminate(_reference: TerminalReference, _operation: TerminalControlOperationContext): Promise<Result<void>> {
    this.terminateCount += 1
    return { ok: true, value: undefined }
  }

  async recover(_operation: TerminalOperationContext): Promise<Result<TerminalReference[]>> {
    return { ok: true, value: [reference] }
  }
}

export class RecordingView implements TerminalViewPort {
  readonly models: TerminalViewModel[] = []
  render(model: TerminalViewModel): void { this.models.push(model) }
}

export class ManualScheduler implements TerminalControllerScheduler {
  private readonly tasks: Array<() => void> = []
  schedule(task: () => void): void { this.tasks.push(task) }
  get size(): number { return this.tasks.length }
  flush(): void { for (const task of this.tasks.splice(0)) task() }
}

export const labels = { terminal: "Local tmux", session: "Session A", project: "Project A" }

export function text(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

export function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value)
}

export async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
