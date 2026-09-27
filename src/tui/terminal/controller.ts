import type { ContractError, ErrorCategory, Result } from "../../orchestration/errors.js"
import type { TerminalBackend, TerminalChannel, TerminalDimensions, TerminalInputOwnership, TerminalOperationContext, TerminalReference } from "../../terminal/types.js"
import { BoundedTerminalOutput } from "./output-buffer.js"
import { presentTerminalBytes, terminalFooter, terminalStatus } from "./presentation.js"
import {
  DEFAULT_TERMINAL_PRESENTATION_BYTES,
  DEFAULT_TERMINAL_READ_BYTES,
  MAX_TERMINAL_PRESENTATION_BYTES,
  TERMINAL_ESCAPE_BYTE,
  type TerminalAttachmentMode,
  type TerminalBindingLabels,
  type TerminalControllerOptions,
  type TerminalInputDisposition,
  type TerminalTakeoverConfirmation,
  type TerminalViewController,
  type TerminalViewModel,
} from "./types.js"

const MIN_DIMENSION = 1
const MAX_DIMENSION = 1000
const MAX_INPUT_BYTES = 64 * 1024
const MAX_QUEUED_INPUT_BYTES = 64 * 1024

interface PendingWrite {
  readonly kind: "write"
  readonly generation: number
  readonly inputEpoch: number
  readonly channel: TerminalChannel
  readonly data: Uint8Array
  readonly resolve: (result: Result<void>) => void
}

interface PendingRelease {
  readonly kind: "release"
  readonly generation: number
  readonly inputEpoch: number
  readonly channel: TerminalChannel
  readonly operation: TerminalOperationContext
  readonly resolve: (result: Result<void>) => void
}

type PendingInputOperation = PendingWrite | PendingRelease

interface PendingResize {
  readonly generation: number
  readonly dimensions: TerminalDimensions
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

function failure(category: ErrorCategory, code: string, message: string, operation?: TerminalOperationContext): { ok: false; error: ContractError } {
  return {
    ok: false,
    error: {
      schemaVersion: 1,
      category,
      code,
      message,
      retryable: false,
      ...(operation === undefined ? {} : { correlationId: operation.correlationId }),
    },
  }
}

function normalizeDimension(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.max(MIN_DIMENSION, Math.min(MAX_DIMENSION, Math.floor(value)))
}

function normalizeDimensions(dimensions: TerminalDimensions): TerminalDimensions | null {
  const columns = normalizeDimension(dimensions.columns)
  const rows = normalizeDimension(dimensions.rows)
  return columns === null || rows === null ? null : { columns, rows }
}

function validByteLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TERMINAL_PRESENTATION_BYTES
}

/**
 * Ephemeral terminal presentation/input controller. It coordinates only the
 * injected provider-neutral TerminalBackend and a renderer-ready view port.
 */
export class DefaultTerminalViewController implements TerminalViewController {
  private mode: TerminalAttachmentMode = "detached"
  private reference: TerminalReference | null = null
  private labels: TerminalBindingLabels | null = null
  private channel: TerminalChannel | null = null
  private ownerLabel: string | null = null
  private takeover: TerminalTakeoverConfirmation | null = null
  private message: string | null = null
  private error: ContractError | null = null
  private generation = 0
  private inputEpoch = 0
  private acceptingInput = false
  private ownershipOperationPending = false
  private readonly output: BoundedTerminalOutput
  private readonly readByteLimit: number
  private readonly scheduler: NonNullable<TerminalControllerOptions["scheduler"]>
  private readTail: Promise<void> = Promise.resolve()
  private readonly inputQueue: PendingInputOperation[] = []
  private queuedInputBytes = 0
  private pumpingInput = false
  private resizeScheduled = false
  private pendingResize: PendingResize | null = null
  private detachTask: Promise<Result<void>> | null = null
  private closeTask: Promise<void> | null = null

  constructor(private readonly backend: TerminalBackend, private readonly options: TerminalControllerOptions) {
    const presentationByteLimit = options.presentationByteLimit ?? DEFAULT_TERMINAL_PRESENTATION_BYTES
    const readByteLimit = options.readByteLimit ?? DEFAULT_TERMINAL_READ_BYTES
    if (!validByteLimit(presentationByteLimit)) throw new RangeError("Terminal presentation byte limit is invalid")
    if (!validByteLimit(readByteLimit)) throw new RangeError("Terminal read byte limit is invalid")
    this.output = new BoundedTerminalOutput(presentationByteLimit)
    this.readByteLimit = Math.min(readByteLimit, presentationByteLimit)
    this.scheduler = options.scheduler ?? { schedule: (task) => queueMicrotask(task) }
    this.render()
  }

  getViewModel(): TerminalViewModel {
    const output = presentTerminalBytes(this.output.bytes())
    return {
      mode: this.mode,
      terminalLabel: this.labels?.terminal ?? null,
      sessionLabel: this.labels?.session ?? null,
      projectLabel: this.labels?.project ?? null,
      status: terminalStatus(this.mode),
      output: this.output.truncated ? `[earlier terminal output truncated]\n${output}` : output,
      outputByteCount: this.output.byteLength,
      outputTruncated: this.output.truncated,
      footer: terminalFooter(this.mode),
      ownerLabel: this.ownerLabel,
      takeoverConfirmation: this.takeover,
      message: this.message,
      error: this.error,
    }
  }

  async attach(reference: TerminalReference, labels: TerminalBindingLabels): Promise<Result<void>> {
    if (this.mode === "closed") return failure("conflict", "terminal_view.closed", "Terminal view is closed")
    if (this.mode !== "detached") return failure("conflict", "terminal_view.already_attached", "A terminal is already attached or attaching")
    const operation = this.getOperation()
    if (!operation.ok) return operation
    const generation = ++this.generation
    this.reference = reference
    this.labels = labels
    this.mode = "attaching"
    this.error = null
    this.message = "Attaching read-only"
    this.render()

    const attached = await this.backend.attach(reference, operation.value)
    if (generation !== this.generation) {
      if (attached.ok) await this.bestEffortDetach(reference)
      return failure("conflict", "terminal_view.stale_attach", "Terminal attachment was superseded", operation.value)
    }
    if (!attached.ok) {
      this.mode = "detached"
      this.reference = null
      this.labels = null
      this.error = attached.error
      this.message = null
      this.render()
      return attached
    }

    this.channel = attached.value
    this.mode = "read-only"
    this.acceptingInput = false
    this.ownerLabel = null
    this.message = "Attached read-only"
    this.render()
    await this.refreshOutput()
    return ok(undefined)
  }

  refreshOutput(): Promise<Result<void>> {
    const channel = this.channel
    const generation = this.generation
    if (channel === null || this.reference === null || this.mode === "detached" || this.mode === "closed") {
      return Promise.resolve(failure("conflict", "terminal_view.not_attached", "No terminal is attached"))
    }
    let resolveResult!: (result: Result<void>) => void
    const result = new Promise<Result<void>>((resolve) => { resolveResult = resolve })
    this.readTail = this.readTail.then(async () => {
      if (!this.isCurrent(generation, channel)) {
        resolveResult(failure("conflict", "terminal_view.stale_read", "Terminal read was superseded"))
        return
      }
      const read = await channel.read(this.readByteLimit)
      if (!this.isCurrent(generation, channel)) {
        resolveResult(failure("conflict", "terminal_view.stale_read", "Terminal read was superseded"))
        return
      }
      if (!read.ok) {
        this.error = read.error
        this.message = "Terminal output is temporarily unavailable"
        if (read.error.code === "terminal.channel_closed" || read.error.code === "terminal.target_unavailable") {
          this.stopForwarding(read.error.message, false)
        }
        this.render()
        resolveResult(read)
        return
      }
      this.output.append(read.value)
      this.error = null
      this.render()
      resolveResult(ok(undefined))
    }).catch(() => {
      resolveResult(failure("internal_failure", "terminal_view.read_failed", "Terminal output could not be read safely"))
    })
    return result
  }

  async requestInput(): Promise<Result<void>> {
    if (this.options.mutationAllowed === false) return failure("policy_denied", "terminal_view.recovery_read_only", "Recovered terminal history is incomplete; mutation is disabled")
    const ready = this.requireReadOnly("request input")
    if (!ready.ok) return ready
    const { channel, generation } = ready.value
    if (this.ownershipOperationPending) return failure("conflict", "terminal_view.ownership_pending", "A terminal ownership operation is already pending")
    const operation = this.getOperation()
    if (!operation.ok) return operation
    this.ownershipOperationPending = true
    this.mode = "requesting-input"
    this.takeover = null
    this.error = null
    this.message = "Requesting input ownership"
    this.render()

    const requested = await channel.requestInputOwnership(operation.value)
    if (!this.isCurrent(generation, channel) || this.mode !== "requesting-input" || !this.ownershipOperationPending) {
      if (requested.ok && requested.value.ownerClientId === channel.clientId) {
        await channel.releaseInputOwnership(operation.value)
      }
      return failure("conflict", "terminal_view.stale_ownership", "Input ownership response was superseded", operation.value)
    }
    this.ownershipOperationPending = false
    if (!requested.ok) {
      this.mode = "read-only"
      this.acceptingInput = false
      this.error = requested.error
      if (requested.error.code === "terminal.input_owned") this.ownerLabel = "another client"
      this.message = requested.error.message
      this.render()
      return requested
    }
    return this.acceptOwnership(requested.value, operation.value)
  }

  beginTakeover(ownerLabel: string): Result<void> {
    if (this.options.mutationAllowed === false) return failure("policy_denied", "terminal_view.recovery_read_only", "Recovered terminal history is incomplete; mutation is disabled")
    const ready = this.requireReadOnly("take over input")
    if (!ready.ok) return ready
    if (this.ownershipOperationPending) return failure("conflict", "terminal_view.ownership_pending", "A terminal ownership operation is already pending")
    const label = ownerLabel.trim()
    if (label.length === 0) return failure("validation", "terminal_view.owner_required", "Current input owner is required for takeover confirmation")
    this.takeover = {
      ownerLabel: label,
      sessionLabel: this.labels?.session ?? "selected session",
      reasonRequired: true,
    }
    this.ownerLabel = label
    this.message = "Confirm authorized takeover and provide a reason"
    this.error = null
    this.render()
    return ok(undefined)
  }

  cancelTakeover(): void {
    this.takeover = null
    this.message = null
    this.render()
  }

  async confirmTakeover(reason: string): Promise<Result<void>> {
    if (this.options.mutationAllowed === false) return failure("policy_denied", "terminal_view.recovery_read_only", "Recovered terminal history is incomplete; mutation is disabled")
    const ready = this.requireReadOnly("take over input")
    if (!ready.ok) return ready
    if (this.takeover === null) return failure("conflict", "terminal_view.takeover_not_confirmed", "Open the takeover confirmation before taking input")
    const boundedReason = reason.trim()
    if (boundedReason.length === 0) return failure("validation", "terminal_view.takeover_reason_required", "A takeover reason is required")
    if (this.ownershipOperationPending) return failure("conflict", "terminal_view.ownership_pending", "A terminal ownership operation is already pending")
    const operation = this.getOperation()
    if (!operation.ok) return operation
    const { channel, generation } = ready.value
    this.ownershipOperationPending = true
    this.mode = "requesting-input"
    this.error = null
    this.message = "Requesting authorized takeover"
    this.render()

    const taken = await channel.takeOverInput({ schemaVersion: 1, operation: operation.value, reason: boundedReason })
    if (!this.isCurrent(generation, channel) || this.mode !== "requesting-input" || !this.ownershipOperationPending) {
      if (taken.ok && taken.value.ownerClientId === channel.clientId) await channel.releaseInputOwnership(operation.value)
      return failure("conflict", "terminal_view.stale_ownership", "Input takeover response was superseded", operation.value)
    }
    this.ownershipOperationPending = false
    if (!taken.ok) {
      this.mode = "read-only"
      this.acceptingInput = false
      this.error = taken.error
      this.message = taken.error.message
      this.render()
      return taken
    }
    this.takeover = null
    return this.acceptOwnership(taken.value, operation.value)
  }

  async sendInput(data: Uint8Array): Promise<Result<TerminalInputDisposition>> {
    if (this.options.mutationAllowed === false) return failure("policy_denied", "terminal_view.recovery_read_only", "Recovered terminal history is incomplete; mutation is disabled")
    if (!(data instanceof Uint8Array) || data.byteLength > MAX_INPUT_BYTES) {
      return failure("validation", "terminal_view.input_too_large", "Terminal input exceeds the per-chunk byte limit")
    }
    const channel = this.channel
    if (channel === null || this.mode !== "input-owned" || !this.acceptingInput) {
      return failure("policy_denied", "terminal_view.input_not_owned", "Terminal input is read-only")
    }
    const escapeIndex = data.indexOf(TERMINAL_ESCAPE_BYTE)
    const forwarded = escapeIndex < 0 ? data.byteLength : escapeIndex
    const discarded = escapeIndex < 0 ? 0 : data.byteLength - escapeIndex
    const generation = this.generation
    const inputEpoch = this.inputEpoch
    const write = forwarded === 0
      ? Promise.resolve(ok(undefined))
      : this.enqueueWrite(channel, data.subarray(0, forwarded), generation, inputEpoch)

    let release = Promise.resolve<Result<void>>(ok(undefined))
    if (escapeIndex >= 0) {
      this.acceptingInput = false
      this.mode = "read-only"
      this.message = "Input mode ended; releasing ownership"
      this.error = null
      const operation = this.getOperation()
      release = operation.ok
        ? this.enqueueRelease(channel, operation.value, generation, inputEpoch)
        : Promise.resolve(operation)
      this.render()
    }

    const written = await write
    if (!written.ok) return written
    const released = await release
    if (!released.ok) return released
    return ok({ forwardedBytes: forwarded, discardedBytes: discarded, escapedToCommandMode: escapeIndex >= 0 })
  }

  resizeContent(dimensions: TerminalDimensions): boolean {
    const normalized = normalizeDimensions(dimensions)
    if (normalized === null || this.channel === null || this.reference === null || this.mode === "detached" || this.mode === "closed") return false
    this.pendingResize = { generation: this.generation, dimensions: normalized }
    if (this.resizeScheduled) return true
    this.resizeScheduled = true
    this.scheduler.schedule(() => { void this.flushResize() })
    return true
  }

  observeOwnership(ownership: TerminalInputOwnership): void {
    if (this.reference === null || ownership.terminalId !== this.reference.terminalId || this.channel === null) return
    this.ownerLabel = ownership.ownerClientId
    if ((this.mode === "input-owned" || this.mode === "requesting-input") && ownership.ownerClientId !== this.channel.clientId) {
      this.stopForwarding(
        ownership.ownerClientId === null ? "Input ownership was released" : `Input ownership moved to ${ownership.ownerClientId}`,
        true,
      )
      return
    }
    this.render()
  }

  revokeInput(reason: string): void {
    this.stopForwarding(reason, true)
  }

  detach(): Promise<Result<void>> {
    if (this.mode === "closed" || this.mode === "detached") return Promise.resolve(ok(undefined))
    if (this.closeTask !== null) return Promise.resolve(failure("conflict", "terminal_view.closing", "Terminal view is closing"))
    if (this.detachTask !== null) return this.detachTask
    const task = this.performDetach()
    this.detachTask = task
    void task.finally(() => {
      if (this.detachTask === task) this.detachTask = null
    })
    return task
  }

  close(): Promise<void> {
    if (this.closeTask !== null) return this.closeTask
    const task = this.performClose()
    this.closeTask = task
    return task
  }

  private async performDetach(): Promise<Result<void>> {
    const reference = this.reference
    const operation = this.getOperation()
    ++this.generation
    this.stopForwarding("Terminal detached; session continues", false)
    this.mode = "detaching"
    this.takeover = null
    this.pendingResize = null
    this.message = "Detaching view; session continues"
    this.render()

    const detached = reference === null || !operation.ok
      ? operation.ok ? ok(undefined) : operation
      : await this.backend.detach(reference, operation.value)
    this.channel = null
    this.reference = null
    this.labels = null
    this.ownerLabel = null
    this.output.clear()
    this.mode = "detached"
    this.error = detached.ok ? null : detached.error
    this.message = detached.ok ? "Detached; managed session continues" : "View closed locally; managed session was not terminated"
    this.render()
    return detached
  }

  private async performClose(): Promise<void> {
    if (this.mode === "closed") return
    if (this.detachTask !== null) await this.detachTask
    const reference = this.reference
    const operation = this.getOperation()
    ++this.generation
    this.stopForwarding("Terminal view closed; session continues", false)
    this.mode = "detaching"
    this.takeover = null
    this.pendingResize = null
    this.render()
    if (reference !== null && operation.ok) await this.backend.detach(reference, operation.value)
    this.channel = null
    this.reference = null
    this.labels = null
    this.ownerLabel = null
    this.output.clear()
    this.mode = "closed"
    this.message = "Terminal view closed; managed session continues"
    this.render()
  }

  private async flushResize(): Promise<void> {
    this.resizeScheduled = false
    const pending = this.pendingResize
    this.pendingResize = null
    const reference = this.reference
    const channel = this.channel
    if (pending === null || reference === null || channel === null || pending.generation !== this.generation) return
    if (this.mode !== "input-owned" || !this.acceptingInput) {
      await this.refreshOutput()
      return
    }
    const operation = this.getOperation()
    if (!operation.ok) {
      this.error = operation.error
      this.render()
      return
    }
    const resized = await this.backend.resize(reference, pending.dimensions, operation.value)
    if (!this.isCurrent(pending.generation, channel)) return
    if (!resized.ok) {
      this.error = resized.error
      this.stopForwarding(resized.error.message, true)
      return
    }
    this.error = null
    this.render()
  }

  private acceptOwnership(ownership: TerminalInputOwnership, operation: TerminalOperationContext): Result<void> {
    if (this.reference === null || this.channel === null || ownership.terminalId !== this.reference.terminalId || ownership.ownerClientId !== this.channel.clientId) {
      this.mode = "read-only"
      this.acceptingInput = false
      const rejected = failure("conflict", "terminal_view.ownership_mismatch", "Backend did not confirm this attachment as input owner", operation)
      this.error = rejected.error
      this.message = rejected.error.message
      this.render()
      return rejected
    }
    this.mode = "input-owned"
    this.acceptingInput = true
    this.ownerLabel = ownership.ownerClientId
    this.error = null
    this.message = "Input ownership confirmed"
    this.render()
    return ok(undefined)
  }

  private requireReadOnly(action: string): Result<{ channel: TerminalChannel; generation: number }> {
    if (this.channel === null || this.reference === null || this.mode !== "read-only") {
      return failure("policy_denied", "terminal_view.not_read_only", `Cannot ${action} unless the terminal is attached read-only`)
    }
    return ok({ channel: this.channel, generation: this.generation })
  }

  private enqueueWrite(channel: TerminalChannel, data: Uint8Array, generation: number, inputEpoch: number): Promise<Result<void>> {
    if (this.queuedInputBytes + data.byteLength > MAX_QUEUED_INPUT_BYTES) {
      this.stopForwarding("Terminal input queue limit reached; input ownership was released", true)
      return Promise.resolve(failure("conflict", "terminal_view.input_queue_full", "Terminal input queue limit was reached"))
    }
    this.queuedInputBytes += data.byteLength
    return new Promise((resolve) => {
      this.inputQueue.push({ kind: "write", channel, data: Uint8Array.from(data), generation, inputEpoch, resolve })
      void this.pumpInput()
    })
  }

  private enqueueRelease(channel: TerminalChannel, operation: TerminalOperationContext, generation: number, inputEpoch: number): Promise<Result<void>> {
    this.ownershipOperationPending = true
    return new Promise((resolve) => {
      this.inputQueue.push({ kind: "release", channel, operation, generation, inputEpoch, resolve })
      void this.pumpInput()
    })
  }

  private async pumpInput(): Promise<void> {
    if (this.pumpingInput) return
    this.pumpingInput = true
    try {
      while (this.inputQueue.length > 0) {
        const pending = this.inputQueue.shift()!
        if (!this.isPendingCurrent(pending)) {
          if (pending.kind === "write") {
            this.queuedInputBytes = Math.max(0, this.queuedInputBytes - pending.data.byteLength)
            pending.data.fill(0)
          }
          pending.resolve(failure("policy_denied", "terminal_view.forwarding_stopped", "Queued terminal input was discarded"))
          continue
        }
        if (pending.kind === "write") {
          const written = await pending.channel.write(pending.data)
          this.queuedInputBytes = Math.max(0, this.queuedInputBytes - pending.data.byteLength)
          pending.data.fill(0)
          pending.resolve(written)
          if (!written.ok && this.isCurrent(pending.generation, pending.channel)) {
            this.error = written.error
            this.stopForwarding(written.error.message, true)
          }
          continue
        }

        const released = await pending.channel.releaseInputOwnership(pending.operation)
        if (this.isCurrent(pending.generation, pending.channel)) {
          this.ownershipOperationPending = false
          this.ownerLabel = released.ok ? released.value.ownerClientId : this.ownerLabel
          this.error = released.ok ? null : released.error
          this.message = released.ok ? "Input released; terminal remains attached read-only" : "Input stopped locally; ownership release was not confirmed"
          this.render()
        }
        pending.resolve(released.ok ? ok(undefined) : released)
      }
    } finally {
      this.pumpingInput = false
    }
  }

  private stopForwarding(reason: string, releaseBestEffort: boolean): void {
    const channel = this.channel
    const wasOwned = this.acceptingInput || this.mode === "input-owned" || this.mode === "requesting-input"
    this.acceptingInput = false
    this.ownershipOperationPending = false
    ++this.inputEpoch
    this.clearQueuedInput()
    if (this.mode !== "detached" && this.mode !== "detaching" && this.mode !== "closed") this.mode = "read-only"
    this.takeover = null
    this.message = reason
    if (releaseBestEffort && wasOwned && channel !== null) {
      const operation = this.getOperation()
      if (operation.ok) void channel.releaseInputOwnership(operation.value)
    }
    this.render()
  }

  private clearQueuedInput(): void {
    const discarded = this.inputQueue.splice(0)
    for (const pending of discarded) {
      if (pending.kind === "write") pending.data.fill(0)
      if (pending.kind === "write") this.queuedInputBytes = Math.max(0, this.queuedInputBytes - pending.data.byteLength)
      pending.resolve(failure("policy_denied", "terminal_view.forwarding_stopped", "Queued terminal input was discarded"))
    }
  }

  private isPendingCurrent(pending: PendingInputOperation): boolean {
    return pending.generation === this.generation && pending.inputEpoch === this.inputEpoch && this.isCurrent(pending.generation, pending.channel)
  }

  private isCurrent(generation: number, channel: TerminalChannel): boolean {
    return generation === this.generation && channel === this.channel && this.mode !== "detached" && this.mode !== "closed"
  }

  private getOperation(): Result<TerminalOperationContext> {
    try {
      return ok(this.options.operation())
    } catch {
      return failure("internal_failure", "terminal_view.operation_unavailable", "Terminal authorization context is unavailable")
    }
  }

  private async bestEffortDetach(reference: TerminalReference): Promise<void> {
    const operation = this.getOperation()
    if (operation.ok) await this.backend.detach(reference, operation.value)
  }

  private render(): void {
    this.options.view?.render(this.getViewModel())
  }
}

export function createTerminalViewController(backend: TerminalBackend, options: TerminalControllerOptions): TerminalViewController {
  return new DefaultTerminalViewController(backend, options)
}
