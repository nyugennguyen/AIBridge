import { createHash } from "node:crypto"
import type { ProcessResult, ProcessRunner } from "../host/types.js"
import { terminalClientIdSchema } from "../orchestration/identifiers.js"
import type { ContractError, Result } from "../orchestration/errors.js"
import {
  createTerminalRequestSchema,
  inputTakeoverRequestSchema,
  terminalControlOperationContextSchema,
  terminalDimensionsSchema,
  terminalOperationContextSchema,
  terminalReferenceSchema,
  terminalSnapshotSchema,
  type CreateTerminalRequest,
  type InputTakeoverRequest,
  type TerminalControlOperationContext,
  type TerminalDimensions,
  type TerminalInputOwnership,
  type TerminalOperationContext,
  type TerminalReference,
  type TerminalSnapshot,
} from "./schemas.js"
import { RecoveryStoreError, TmuxRecoveryStore, type TmuxRecoveryRecord } from "./recovery-store.js"
import type { TerminalBackend, TerminalChannel } from "./types.js"

const TMUX_KIND = "tmux"
const MIN_DIMENSION = 1
const MAX_DIMENSION = 1000
const MAX_INPUT_BYTES = 64 * 1024
const SEND_KEYS_CHUNK_BYTES = 1024
const DEFAULT_TIMEOUT_MS = 5_000
const OWNER_OPTION = "@aibr_input_owner"

export type TerminalAction =
  | "create"
  | "attach"
  | "read"
  | "write"
  | "request_input"
  | "release_input"
  | "takeover_input"
  | "resize"
  | "snapshot"
  | "detach"
  | "terminate"
  | "recover"

export interface TerminalAuthorizationRequest {
  readonly action: TerminalAction
  readonly operation: TerminalOperationContext | TerminalControlOperationContext
  readonly reference?: TerminalReference
  readonly takeoverReason?: string
}

/** The application service supplies this live authorization check. */
export interface TerminalAuthorizer {
  authorize(request: TerminalAuthorizationRequest): Promise<Result<void>>
}

export interface TmuxTerminalBackendOptions {
  readonly processRunner: ProcessRunner
  readonly authorizer: TerminalAuthorizer
  readonly recoveryDirectory: string
  readonly clock?: () => Date
  readonly tmuxExecutable?: string
  readonly commandTimeoutMs?: number
  readonly maxRecoveryRecords?: number
  /** Resolves the exact agent-session command; argv is passed directly to tmux, never through a shell. */
  readonly sessionCommand?: (request: CreateTerminalRequest) => Promise<Result<readonly [string, ...string[]]>>
}

interface AttachmentState {
  readonly token: symbol
  readonly clientId: TerminalOperationContext["clientId"]
  readonly operation: TerminalOperationContext
  active: boolean
  lastCapture: Uint8Array
}

interface LiveTerminalState {
  record: TmuxRecoveryRecord
  ownerClientId: TerminalOperationContext["clientId"] | null
  acceptingWrites: boolean
  readonly attachments: Map<string, AttachmentState>
  readonly mutex: AsyncMutex
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(action: () => Promise<T>): Promise<T> {
    const predecessor = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await predecessor
    try {
      return await action()
    } finally {
      release()
    }
  }
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

function failure(
  category: ContractError["category"],
  code: string,
  message: string,
  operation?: TerminalOperationContext,
  retryable = false,
): Result<never> {
  return {
    ok: false,
    error: {
      schemaVersion: 1,
      category,
      code,
      message,
      retryable,
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

function tmuxName(terminalId: string): string {
  return `aibr-tmux-${createHash("sha256").update(terminalId, "utf8").digest("hex")}`
}

function exactTarget(sessionName: string): string {
  return `=${sessionName}`
}

function sameReference(left: TerminalReference, right: TerminalReference): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.terminalId === right.terminalId &&
    left.nodeId === right.nodeId &&
    left.projectId === right.projectId &&
    left.sessionId === right.sessionId &&
    left.backendKind === right.backendKind &&
    JSON.stringify(left.adapterMetadata) === JSON.stringify(right.adapterMetadata)
  )
}

function startsWith(value: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.byteLength > value.byteLength) return false
  for (let index = 0; index < prefix.byteLength; index += 1) {
    if (value[index] !== prefix[index]) return false
  }
  return true
}

function tailBytes(value: Uint8Array, limit: number): Uint8Array {
  if (value.byteLength <= limit) return value
  return value.slice(value.byteLength - limit)
}

export class TmuxTerminalBackend implements TerminalBackend {
  readonly kind = TMUX_KIND

  private readonly runner: ProcessRunner
  private readonly authorizer: TerminalAuthorizer
  private readonly store: TmuxRecoveryStore
  private readonly clock: () => Date
  private readonly executable: string
  private readonly timeoutMs: number
  private readonly states = new Map<string, LiveTerminalState>()
  private readonly createMutex = new AsyncMutex()
  private readonly sessionCommand?: TmuxTerminalBackendOptions["sessionCommand"]

  constructor(options: TmuxTerminalBackendOptions) {
    this.runner = options.processRunner
    this.authorizer = options.authorizer
    this.store = new TmuxRecoveryStore(options.recoveryDirectory, options.maxRecoveryRecords)
    this.clock = options.clock ?? (() => new Date())
    this.executable = options.tmuxExecutable ?? "tmux"
    this.timeoutMs = options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.sessionCommand = options.sessionCommand
  }

  async create(request: CreateTerminalRequest): Promise<Result<TerminalReference>> {
    const dimensions = normalizeDimensions({ columns: request.columns, rows: request.rows })
    if (dimensions === null) return failure("validation", "terminal.invalid_dimensions", "Terminal dimensions must be finite and positive", request.operation)

    const parsed = createTerminalRequestSchema.safeParse({ ...request, ...dimensions })
    if (!parsed.success) return failure("validation", "terminal.invalid_create_request", "Terminal create request is invalid", request.operation)
    const value = parsed.data
    if (value.backendKind !== this.kind) {
      return failure("unsupported_capability", "terminal.backend_mismatch", "Requested terminal backend is not tmux", value.operation)
    }

    return this.createMutex.run(async () => {
      const reference = terminalReferenceSchema.parse({
      schemaVersion: 1,
      terminalId: value.terminalId,
      nodeId: value.operation.nodeId,
      projectId: value.operation.projectId,
      sessionId: value.sessionId,
      backendKind: this.kind,
      adapterMetadata: { recoveryVersion: "1" },
    })
      const authorization = await this.authorize("create", value.operation, reference)
      if (!authorization.ok) return authorization

      let existing: TmuxRecoveryRecord | null
      try {
        existing = await this.store.read(value.terminalId)
      } catch (error) {
        return this.storeFailure(error, value.operation)
      }
      if (existing !== null || this.states.has(value.terminalId)) {
        return failure("conflict", "terminal.already_exists", "Terminal identifier is already bound", value.operation)
      }

      const now = this.timestamp()
      if (now === null) return failure("internal_failure", "terminal.invalid_clock", "Terminal clock produced an invalid timestamp", value.operation)
      const record: TmuxRecoveryRecord = {
      schemaVersion: 1,
      reference,
      tmuxSessionName: tmuxName(value.terminalId),
      tmuxPaneId: null,
      bufferByteLimit: value.bufferByteLimit,
      columns: dimensions.columns,
      rows: dimensions.rows,
      lifecycle: "creating",
      createdAt: now,
      updatedAt: now,
      }

      try {
        await this.store.write(record)
      } catch (error) {
        return this.storeFailure(error, value.operation)
      }

      let sessionCommand: readonly string[] = []
      if (this.sessionCommand) {
        const resolved = await this.sessionCommand(value)
        if (!resolved.ok) {
          await this.store.remove(value.terminalId).catch(() => undefined)
          return resolved
        }
        if (resolved.value.some((argument) => argument.length === 0 || argument.includes("\0"))) {
          await this.store.remove(value.terminalId).catch(() => undefined)
          return failure("validation", "terminal.invalid_session_command", "The terminal session command is invalid", value.operation)
        }
        sessionCommand = resolved.value
      }
      const created = await this.run([
      this.executable,
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-s",
      record.tmuxSessionName,
      "-x",
      String(record.columns),
      "-y",
      String(record.rows),
      ...sessionCommand,
      ])
      const paneId = created !== null && /^%[0-9]+$/.test(created.stdout) ? created.stdout : null
      if (created?.exitCode !== 0 || paneId === null) {
        if (created?.exitCode === 0) {
          await this.exec([this.executable, "kill-session", "-t", exactTarget(record.tmuxSessionName)])
        }
        try {
          await this.store.remove(value.terminalId)
        } catch {
          // A leftover `creating` record intentionally blocks unsafe recreation.
        }
        return failure("runtime_failure", "terminal.create_failed", "tmux could not create the terminal session", value.operation)
      }

      const activeRecord = { ...record, tmuxPaneId: paneId, lifecycle: "active" as const, updatedAt: this.timestamp() ?? now }
      try {
        await this.store.write(activeRecord)
      } catch (error) {
        await this.exec([this.executable, "kill-session", "-t", exactTarget(record.tmuxSessionName)])
        return this.storeFailure(error, value.operation)
      }
      this.states.set(value.terminalId, this.makeState(activeRecord))
      return ok(reference)
    })
  }

  async attach(reference: TerminalReference, operation: TerminalOperationContext): Promise<Result<TerminalChannel>> {
    const resolved = await this.resolve(reference, operation)
    if (!resolved.ok) return resolved
    const state = resolved.value
    const authorization = await this.authorize("attach", operation, state.record.reference)
    if (!authorization.ok) return authorization
    if (!(await this.targetMatches(state.record))) {
      return failure("conflict", "terminal.target_unavailable", "The canonical tmux terminal target is unavailable", operation)
    }

    return state.mutex.run(async () => {
      if (!state.acceptingWrites || state.record.lifecycle !== "active") {
        return failure("conflict", "terminal.not_active", "Terminal is not active", operation)
      }
      const previous = state.attachments.get(operation.clientId)
      if (previous !== undefined) previous.active = false
      if (state.ownerClientId === operation.clientId) state.ownerClientId = null

      const attachment: AttachmentState = {
        token: Symbol("terminal-attachment"),
        clientId: operation.clientId,
        operation,
        active: true,
        lastCapture: new Uint8Array(),
      }
      state.attachments.set(operation.clientId, attachment)
      const channel: TerminalChannel = {
        reference: state.record.reference,
        clientId: operation.clientId,
        read: (maxBytes) => this.readChannel(state, attachment, maxBytes),
        write: (data) => this.writeChannel(state, attachment, data),
        requestInputOwnership: (context) => this.requestInput(state, attachment, context),
        releaseInputOwnership: (context) => this.releaseInput(state, attachment, context),
        takeOverInput: (takeover) => this.takeOverInput(state, attachment, takeover),
      }
      return ok(channel)
    })
  }

  async resize(reference: TerminalReference, dimensions: TerminalDimensions, operation: TerminalOperationContext): Promise<Result<void>> {
    const normalized = normalizeDimensions(dimensions)
    if (normalized === null || !terminalDimensionsSchema.safeParse(normalized).success) {
      return failure("validation", "terminal.invalid_dimensions", "Terminal dimensions must be finite and positive", operation)
    }
    const resolved = await this.resolve(reference, operation)
    if (!resolved.ok) return resolved
    const state = resolved.value
    const authorization = await this.authorize("resize", operation, state.record.reference)
    if (!authorization.ok) return authorization

    return state.mutex.run(async () => {
      const attachment = state.attachments.get(operation.clientId)
      const owner = await this.readSharedOwner(state)
      state.ownerClientId = owner
      if (!this.isCurrentAttachment(state, attachment) || owner !== operation.clientId) {
        return failure("policy_denied", "terminal.input_not_owned", "Only the current input owner may resize the live terminal", operation)
      }
      if (!(await this.targetMatches(state.record))) {
        state.acceptingWrites = false
        return failure("conflict", "terminal.target_unavailable", "The canonical tmux terminal target is unavailable", operation)
      }
      const resized = await this.exec([
        this.executable,
        "resize-window",
        "-t",
        exactTarget(state.record.tmuxSessionName),
        "-x",
        String(normalized.columns),
        "-y",
        String(normalized.rows),
      ])
      if (!resized) return failure("runtime_failure", "terminal.resize_failed", "tmux could not resize the terminal", operation)
      state.record = { ...state.record, columns: normalized.columns, rows: normalized.rows, updatedAt: this.timestamp() ?? state.record.updatedAt }
      try {
        await this.store.write(state.record)
      } catch (error) {
        state.acceptingWrites = false
        return this.storeFailure(error, operation)
      }
      return ok(undefined)
    })
  }

  async snapshot(reference: TerminalReference, operation: TerminalOperationContext): Promise<Result<TerminalSnapshot>> {
    const resolved = await this.resolve(reference, operation)
    if (!resolved.ok) return resolved
    const state = resolved.value
    const authorization = await this.authorize("snapshot", operation, state.record.reference)
    if (!authorization.ok) return authorization
    const captured = await this.capture(state, operation)
    if (!captured.ok) return captured
    const timestamp = this.timestamp()
    if (timestamp === null) return failure("internal_failure", "terminal.invalid_clock", "Terminal clock produced an invalid timestamp", operation)
    const bounded = tailBytes(captured.value, state.record.bufferByteLimit)
    return ok(terminalSnapshotSchema.parse({
      schemaVersion: 1,
      terminalId: state.record.reference.terminalId,
      nodeId: state.record.reference.nodeId,
      projectId: state.record.reference.projectId,
      sessionId: state.record.reference.sessionId,
      capturedAt: timestamp,
      byteCount: bounded.byteLength,
      truncated: bounded.byteLength < captured.value.byteLength,
      data: Uint8Array.from(bounded),
    }))
  }

  async detach(reference: TerminalReference, operation: TerminalOperationContext): Promise<Result<void>> {
    const resolved = await this.resolve(reference, operation)
    if (!resolved.ok) return resolved
    const state = resolved.value
    const attachmentAtStart = state.attachments.get(operation.clientId)
    const authorization = await this.authorize("detach", operation, state.record.reference)
    if (!authorization.ok) return authorization
    return state.mutex.run(async () => {
      const attachment = state.attachments.get(operation.clientId)
      if (attachmentAtStart !== undefined && attachment?.token !== attachmentAtStart.token) {
        return failure("conflict", "terminal.stale_detach", "Terminal attachment changed before detach completed", operation)
      }
      if (attachment !== undefined) attachment.active = false
      state.attachments.delete(operation.clientId)
      if (await this.readSharedOwner(state) === operation.clientId) {
        await this.withOwnershipLock(state, operation, async () => {
          if (await this.readSharedOwner(state) === operation.clientId) await this.writeSharedOwner(state, null)
          state.ownerClientId = null
          return ok(undefined)
        })
      }
      return ok(undefined)
    })
  }

  async terminate(reference: TerminalReference, operation: TerminalControlOperationContext): Promise<Result<void>> {
    const parsed = terminalControlOperationContextSchema.safeParse(operation)
    if (!parsed.success) return failure("validation", "terminal.invalid_operation", "Terminal control operation is invalid", operation)
    const resolved = await this.resolve(reference, parsed.data)
    if (!resolved.ok) return resolved
    const state = resolved.value
    const authorization = await this.authorize("terminate", parsed.data, state.record.reference)
    if (!authorization.ok) return authorization
    if (!(await this.targetMatches(state.record))) {
      state.acceptingWrites = false
      return failure("conflict", "terminal.target_unavailable", "The canonical tmux terminal target is unavailable", parsed.data)
    }

    state.acceptingWrites = false
    for (const attachment of state.attachments.values()) attachment.active = false
    state.ownerClientId = null

    return state.mutex.run(async () => {
      const now = this.timestamp() ?? state.record.updatedAt
      state.record = { ...state.record, lifecycle: "terminating", updatedAt: now }
      try {
        await this.store.write(state.record)
      } catch (error) {
        return this.storeFailure(error, parsed.data)
      }
      const terminated = await this.exec([this.executable, "kill-pane", "-t", state.record.tmuxPaneId!])
      if (!terminated) {
        return failure("runtime_failure", "terminal.terminate_failed", "tmux could not confirm terminal termination", parsed.data)
      }
      try {
        await this.store.remove(state.record.reference.terminalId)
      } catch (error) {
        return this.storeFailure(error, parsed.data)
      }
      this.states.delete(state.record.reference.terminalId)
      return ok(undefined)
    })
  }

  async recover(operation: TerminalOperationContext): Promise<Result<TerminalReference[]>> {
    const parsed = terminalOperationContextSchema.safeParse(operation)
    if (!parsed.success) return failure("validation", "terminal.invalid_operation", "Terminal recovery operation is invalid", operation)
    const authorization = await this.authorize("recover", parsed.data)
    if (!authorization.ok) return authorization

    let records: TmuxRecoveryRecord[]
    try {
      records = await this.store.list()
    } catch (error) {
      return this.storeFailure(error, parsed.data)
    }

    const references: TerminalReference[] = []
    for (const record of records) {
      if (record.reference.nodeId !== parsed.data.nodeId || record.reference.projectId !== parsed.data.projectId) continue
      if (record.lifecycle !== "active") {
        return failure("internal_failure", "terminal.recovery_incomplete", "Terminal recovery metadata records an incomplete lifecycle", parsed.data)
      }
      if (!(await this.targetMatches(record))) continue
      const existing = this.states.get(record.reference.terminalId)
      if (existing !== undefined) {
        if (
          !sameReference(existing.record.reference, record.reference) ||
          existing.record.tmuxSessionName !== record.tmuxSessionName ||
          existing.record.tmuxPaneId !== record.tmuxPaneId
        ) {
          return failure("internal_failure", "terminal.recovery_conflict", "Recovered terminal binding conflicts with live state", parsed.data)
        }
      } else {
        this.states.set(record.reference.terminalId, this.makeState(record))
      }
      references.push(record.reference)
    }
    return ok(references)
  }

  private async readChannel(state: LiveTerminalState, attachment: AttachmentState, maxBytes: number): Promise<Result<Uint8Array>> {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      return failure("validation", "terminal.invalid_read_limit", "Terminal read limit must be finite and positive", attachment.operation)
    }
    const limit = Math.min(state.record.bufferByteLimit, Math.floor(maxBytes))
    const authorization = await this.authorize("read", attachment.operation, state.record.reference)
    if (!authorization.ok) return authorization
    if (!this.isCurrentAttachment(state, attachment)) {
      return failure("conflict", "terminal.channel_closed", "Terminal attachment is no longer active", attachment.operation)
    }
    const captured = await this.capture(state, attachment.operation)
    if (!captured.ok) return captured
    const previous = attachment.lastCapture
    const delta = startsWith(captured.value, previous) ? captured.value.slice(previous.byteLength) : captured.value
    attachment.lastCapture = tailBytes(captured.value, state.record.bufferByteLimit)
    return ok(tailBytes(delta, limit))
  }

  private async writeChannel(state: LiveTerminalState, attachment: AttachmentState, data: Uint8Array): Promise<Result<void>> {
    if (!(data instanceof Uint8Array) || data.byteLength > MAX_INPUT_BYTES) {
      return failure("validation", "terminal.input_too_large", "Terminal input exceeds the per-write byte limit", attachment.operation)
    }
    if (data.byteLength === 0) {
      return state.mutex.run(async () => {
        if (!this.isCurrentAttachment(state, attachment)) {
          return failure("policy_denied", "terminal.input_not_owned", "Terminal input is not owned by this attachment", attachment.operation)
        }
        const owner = await this.readSharedOwner(state)
        if (owner !== attachment.clientId) {
          state.ownerClientId = owner
          return failure("policy_denied", "terminal.input_not_owned", "Terminal input is not owned by this attachment", attachment.operation)
        }
        return this.authorize("write", attachment.operation, state.record.reference)
      })
    }
    for (let offset = 0; offset < data.byteLength; offset += SEND_KEYS_CHUNK_BYTES) {
      const chunk = data.slice(offset, Math.min(data.byteLength, offset + SEND_KEYS_CHUNK_BYTES))
      const result = await state.mutex.run(async (): Promise<Result<void>> => {
        if (!this.isCurrentAttachment(state, attachment)) {
          return failure("policy_denied", "terminal.input_not_owned", "Terminal input is not owned by this attachment", attachment.operation)
        }
        const authorization = await this.authorize("write", attachment.operation, state.record.reference)
        if (!authorization.ok) return authorization
        return this.withOwnershipLock(state, attachment.operation, async () => {
          const owner = await this.readSharedOwner(state)
          state.ownerClientId = owner
          if (!this.isCurrentAttachment(state, attachment) || owner !== attachment.clientId) {
            return failure("policy_denied", "terminal.input_not_owned", "Terminal input is not owned by this attachment", attachment.operation)
          }
          if (!(await this.targetMatches(state.record))) {
            state.acceptingWrites = false
            return failure("conflict", "terminal.target_unavailable", "The canonical tmux terminal target is unavailable", attachment.operation)
          }
          const hexBytes = Array.from(chunk, (byte) => byte.toString(16).padStart(2, "0"))
          const written = await this.exec([
            this.executable,
            "send-keys",
            "-t",
            state.record.tmuxPaneId!,
            "-H",
            ...hexBytes,
          ])
          return written ? ok(undefined) : failure("runtime_failure", "terminal.write_failed", "tmux could not write terminal input", attachment.operation)
        })
      })
      if (!result.ok) return result
    }
    return ok(undefined)
  }

  private async requestInput(state: LiveTerminalState, attachment: AttachmentState, operation: TerminalOperationContext): Promise<Result<TerminalInputOwnership>> {
    const checked = this.checkChannelOperation(state, attachment, operation)
    if (!checked.ok) return checked
    const authorization = await this.authorize("request_input", checked.value, state.record.reference)
    if (!authorization.ok) return authorization
    return state.mutex.run(async () => {
      if (!this.isCurrentAttachment(state, attachment)) return failure("conflict", "terminal.channel_closed", "Terminal attachment is no longer active", checked.value)
      return this.withOwnershipLock(state, checked.value, async () => {
        const owner = await this.readSharedOwner(state)
        if (owner !== null && owner !== attachment.clientId) {
          state.ownerClientId = owner
          return failure("conflict", "terminal.input_owned", "Terminal input is owned by another client", checked.value)
        }
        if (!await this.writeSharedOwner(state, attachment.clientId)) {
          return failure("runtime_failure", "terminal.ownership_write_failed", "tmux could not record input ownership", checked.value)
        }
        state.ownerClientId = attachment.clientId
        return this.ownership(state, checked.value)
      })
    })
  }

  private async releaseInput(state: LiveTerminalState, attachment: AttachmentState, operation: TerminalOperationContext): Promise<Result<TerminalInputOwnership>> {
    const checked = this.checkChannelOperation(state, attachment, operation)
    if (!checked.ok) return checked
    const authorization = await this.authorize("release_input", checked.value, state.record.reference)
    if (!authorization.ok) return authorization
    return state.mutex.run(async () => {
      return this.withOwnershipLock(state, checked.value, async () => {
        const owner = await this.readSharedOwner(state)
        if (owner === attachment.clientId && !await this.writeSharedOwner(state, null)) {
          return failure("runtime_failure", "terminal.ownership_release_failed", "tmux could not release input ownership", checked.value)
        }
        state.ownerClientId = owner === attachment.clientId ? null : owner
        return this.ownership(state, checked.value)
      })
    })
  }

  private async takeOverInput(state: LiveTerminalState, attachment: AttachmentState, request: InputTakeoverRequest): Promise<Result<TerminalInputOwnership>> {
    const parsed = inputTakeoverRequestSchema.safeParse(request)
    if (!parsed.success) return failure("validation", "terminal.invalid_takeover", "Terminal takeover request is invalid", request.operation)
    const checked = this.checkChannelOperation(state, attachment, parsed.data.operation)
    if (!checked.ok) return checked
    const authorization = await this.authorize("takeover_input", checked.value, state.record.reference, parsed.data.reason)
    if (!authorization.ok) return authorization
    return state.mutex.run(async () => {
      if (!this.isCurrentAttachment(state, attachment)) return failure("conflict", "terminal.channel_closed", "Terminal attachment is no longer active", checked.value)
      return this.withOwnershipLock(state, checked.value, async () => {
        if (!await this.writeSharedOwner(state, attachment.clientId)) {
          return failure("runtime_failure", "terminal.ownership_write_failed", "tmux could not record input ownership", checked.value)
        }
        state.ownerClientId = attachment.clientId
        return this.ownership(state, checked.value)
      })
    })
  }

  private ownershipLockName(state: LiveTerminalState): string {
    return `aibr-owner-${createHash("sha256").update(state.record.reference.terminalId, "utf8").digest("hex")}`
  }

  private async withOwnershipLock<T>(state: LiveTerminalState, operation: TerminalOperationContext, action: () => Promise<Result<T>>): Promise<Result<T>> {
    const name = this.ownershipLockName(state)
    if (!await this.exec([this.executable, "wait-for", "-L", name])) {
      return failure("runtime_failure", "terminal.ownership_lock_failed", "tmux could not lock input ownership", operation)
    }
    try {
      return await action()
    } finally {
      await this.exec([this.executable, "wait-for", "-U", name])
    }
  }

  private async readSharedOwner(state: LiveTerminalState): Promise<TerminalOperationContext["clientId"] | null> {
    const result = await this.run([this.executable, "show-options", "-p", "-v", "-t", state.record.tmuxPaneId!, OWNER_OPTION])
    const value = result?.exitCode === 0 ? result.stdout.trim() : ""
    const parsed = terminalClientIdSchema.safeParse(value)
    return parsed.success ? parsed.data : null
  }

  private async writeSharedOwner(state: LiveTerminalState, owner: TerminalOperationContext["clientId"] | null): Promise<boolean> {
    return owner === null
      ? this.exec([this.executable, "set-option", "-p", "-u", "-t", state.record.tmuxPaneId!, OWNER_OPTION])
      : this.exec([this.executable, "set-option", "-p", "-t", state.record.tmuxPaneId!, OWNER_OPTION, owner])
  }

  private checkChannelOperation(
    state: LiveTerminalState,
    attachment: AttachmentState,
    operation: TerminalOperationContext,
  ): Result<TerminalOperationContext> {
    const parsed = terminalOperationContextSchema.safeParse(operation)
    if (!parsed.success) return failure("validation", "terminal.invalid_operation", "Terminal operation is invalid", operation)
    if (
      parsed.data.clientId !== attachment.clientId ||
      parsed.data.nodeId !== state.record.reference.nodeId ||
      parsed.data.projectId !== state.record.reference.projectId
    ) {
      return failure("policy_denied", "terminal.binding_mismatch", "Terminal operation does not match the attached client and scope", parsed.data)
    }
    if (!this.isCurrentAttachment(state, attachment)) return failure("conflict", "terminal.channel_closed", "Terminal attachment is no longer active", parsed.data)
    return ok(parsed.data)
  }

  private ownership(state: LiveTerminalState, operation: TerminalOperationContext): Result<TerminalInputOwnership> {
    const timestamp = this.timestamp()
    if (timestamp === null) return failure("internal_failure", "terminal.invalid_clock", "Terminal clock produced an invalid timestamp", operation)
    return ok({
      schemaVersion: 1,
      terminalId: state.record.reference.terminalId,
      ownerClientId: state.ownerClientId,
      changedAt: timestamp,
    })
  }

  private async capture(state: LiveTerminalState, operation: TerminalOperationContext): Promise<Result<Uint8Array>> {
    if (!state.acceptingWrites || state.record.lifecycle !== "active") {
      return failure("conflict", "terminal.not_active", "Terminal is not active", operation)
    }
    if (!(await this.targetMatches(state.record))) {
      state.acceptingWrites = false
      return failure("conflict", "terminal.target_unavailable", "The canonical tmux terminal target is unavailable", operation)
    }
    const lines = Math.max(state.record.rows, Math.ceil(state.record.bufferByteLimit / state.record.columns) + state.record.rows)
    const result = await this.run(
      [this.executable, "capture-pane", "-p", "-e", "-J", "-S", `-${lines}`, "-t", state.record.tmuxPaneId!],
    )
    if (result === null || result.exitCode !== 0) return failure("runtime_failure", "terminal.capture_failed", "tmux could not capture the terminal", operation)
    return ok(new TextEncoder().encode(result.stdout))
  }

  private async resolve(reference: TerminalReference, operation: TerminalOperationContext): Promise<Result<LiveTerminalState>> {
    const parsedReference = terminalReferenceSchema.safeParse(reference)
    const parsedOperation = terminalOperationContextSchema.safeParse(operation)
    if (!parsedReference.success || !parsedOperation.success) {
      return failure("validation", "terminal.invalid_binding", "Terminal reference or operation is invalid", operation)
    }
    if (
      parsedReference.data.backendKind !== this.kind ||
      parsedOperation.data.nodeId !== parsedReference.data.nodeId ||
      parsedOperation.data.projectId !== parsedReference.data.projectId
    ) {
      return failure("policy_denied", "terminal.binding_mismatch", "Terminal reference does not match the authorized node and project", parsedOperation.data)
    }

    let state = this.states.get(parsedReference.data.terminalId)
    if (state === undefined) {
      let record: TmuxRecoveryRecord | null
      try {
        record = await this.store.read(parsedReference.data.terminalId)
      } catch (error) {
        return this.storeFailure(error, parsedOperation.data)
      }
      if (record === null) return failure("policy_denied", "terminal.binding_missing", "Terminal binding metadata is unavailable", parsedOperation.data)
      state = this.makeState(record)
      this.states.set(parsedReference.data.terminalId, state)
    }
    if (!sameReference(state.record.reference, parsedReference.data)) {
      return failure("policy_denied", "terminal.binding_mismatch", "Terminal reference does not match its canonical binding", parsedOperation.data)
    }
    if (state.record.lifecycle !== "active") {
      return failure("conflict", "terminal.not_active", "Terminal lifecycle is incomplete", parsedOperation.data)
    }
    return ok(state)
  }

  private makeState(record: TmuxRecoveryRecord): LiveTerminalState {
    return {
      record,
      ownerClientId: null,
      acceptingWrites: record.lifecycle === "active",
      attachments: new Map(),
      mutex: new AsyncMutex(),
    }
  }

  private isCurrentAttachment(state: LiveTerminalState, attachment: AttachmentState | undefined): boolean {
    return (
      attachment !== undefined &&
      attachment.active &&
      state.acceptingWrites &&
      state.record.lifecycle === "active" &&
      state.attachments.get(attachment.clientId)?.token === attachment.token
    )
  }

  private async authorize(
    action: TerminalAction,
    operation: TerminalOperationContext | TerminalControlOperationContext,
    reference?: TerminalReference,
    takeoverReason?: string,
  ): Promise<Result<void>> {
    try {
      return await this.authorizer.authorize({
        action,
        operation,
        ...(reference === undefined ? {} : { reference }),
        ...(takeoverReason === undefined ? {} : { takeoverReason }),
      })
    } catch {
      return failure("internal_failure", "terminal.authorization_failed", "Terminal authorization could not be verified", operation)
    }
  }

  private async exec(argv: readonly string[]): Promise<boolean> {
    const result = await this.run(argv)
    return result?.exitCode === 0
  }

  private async targetMatches(record: TmuxRecoveryRecord): Promise<boolean> {
    if (record.tmuxPaneId === null) return false
    const result = await this.run(
      [this.executable, "display-message", "-p", "-t", record.tmuxPaneId, "#{session_name}:#{pane_id}"],
    )
    return result !== null && result.exitCode === 0 && result.stdout === `${record.tmuxSessionName}:${record.tmuxPaneId}`
  }

  private async run(argv: readonly string[]): Promise<ProcessResult | null> {
    try {
      return await this.runner.exec(argv, { timeoutMs: this.timeoutMs })
    } catch {
      return null
    }
  }

  private timestamp(): string | null {
    const date = this.clock()
    if (!Number.isFinite(date.getTime())) return null
    return date.toISOString()
  }

  private storeFailure(error: unknown, operation: TerminalOperationContext): Result<never> {
    const code = error instanceof RecoveryStoreError && error.reason === "corrupt"
      ? "terminal.recovery_corrupt"
      : "terminal.recovery_unavailable"
    return failure("internal_failure", code, "Terminal recovery metadata could not be verified", operation)
  }
}
