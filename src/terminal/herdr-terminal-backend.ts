/**
 * Herdr Terminal Backend (Phase 3).
 *
 * Implements the provider-neutral TerminalBackend contract beside TmuxTerminalBackend,
 * driving the Herdr autonomous agent workspace manager daemon fork.
 *
 * ARCHITECTURAL INVARIANT:
 * "Herdr owns the terminal. AIBridge owns the intent. Never both."
 *
 * WHY FENCE DISCIPLINE (F1 / ADR 0009 SF-10):
 * In Herdr's multiplexed environment, human operators and AIBridge orchestrators
 * interact with panes concurrently. To eliminate race conditions, keystroke interleaving,
 * and unsolicited input corruption, every write to a pane (text, keys, input commands)
 * MUST strictly adhere to the atomic input-ownership fence protocol:
 *
 *   1. Atomic claim: pane.claim_input { pane_id, holder, epoch }
 *      - If pane is human-focused, Herdr REFUSES the claim (granted: false, holder: "human").
 *        The backend MUST NOT attempt to write or bypass the fence; it fails cleanly.
 *      - If another external holder holds the fence at current epoch, claim is refused.
 *      - When granted, epoch advances monotonically.
 *   2. Guarded write: pane.send_text / pane.send_keys / pane.send_input with { holder, epoch }
 *      - If write fails with `input_fenced`, the backend MUST surface this as a typed,
 *        non-retryable failure; under NO circumstance may the backend retry around the fence.
 *   3. Guaranteed release: pane.release_input { pane_id, holder, epoch } in a finally block
 *      - Input ownership is promptly relinquished back to the human operator or next claimant.
 */

import type { ProcessRunner } from "../host/types.js"
import type { ContractError, Result } from "../orchestration/errors.js"
import { terminalClientIdSchema } from "../orchestration/identifiers.js"
import {
  createTerminalRequestSchema,
  inputTakeoverRequestSchema,
  terminalControlOperationContextSchema,
  terminalDimensionsSchema,
  terminalInputOwnershipSchema,
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
import type { TerminalAction, TerminalAuthorizer } from "./tmux-terminal-backend.js"
import type { TerminalBackend, TerminalChannel } from "./types.js"

export const HERDR_KIND = "herdr"
const MIN_DIMENSION = 1
const MAX_DIMENSION = 1000
const MAX_INPUT_BYTES = 64 * 1024

// ── Client Port Contracts ────────────────────────────────────────────────

export interface HerdrClaimResult {
  readonly granted: boolean
  readonly epoch: number
  readonly holder: string
}

export interface HerdrPaneInfo {
  readonly paneId: string
  readonly terminalId?: string
  readonly workspaceId?: string
  readonly focused?: boolean
  readonly isHumanFocused?: boolean
}

export interface HerdrWriteOptions {
  readonly holder?: string
  readonly epoch?: number
}

/**
 * Injectable client port driving the Herdr daemon IPC surface.
 *
 * Mirrors the socket API / CLI commands defined in Herdr's IPC schema:
 * - pane.claim_input / pane.release_input (F1 atomic fencing)
 * - pane.send_text / pane.send_keys / pane.send_input
 * - pane.read / pane.split / pane.close / pane.resize / pane.list
 */
export interface HerdrClient {
  claimInput(paneId: string, holder: string, epoch: number): Promise<Result<HerdrClaimResult>>
  releaseInput(paneId: string, holder: string, epoch: number): Promise<Result<void>>
  sendText(paneId: string, text: string, options?: HerdrWriteOptions): Promise<Result<void>>
  sendKeys(paneId: string, keys: readonly string[], options?: HerdrWriteOptions): Promise<Result<void>>
  sendInput?(paneId: string, text?: string, keys?: readonly string[], options?: HerdrWriteOptions): Promise<Result<void>>
  readPane(paneId: string, options?: { lines?: number; source?: "scrollback" | "visible" | "recent"; stripAnsi?: boolean }): Promise<Result<string>>
  createPane(options?: { cwd?: string; env?: Record<string, string>; title?: string; command?: readonly string[] }): Promise<Result<{ paneId: string }>>
  closePane(paneId: string): Promise<Result<void>>
  resizePane(paneId: string, columns: number, rows: number): Promise<Result<void>>
  listPanes(): Promise<Result<readonly HerdrPaneInfo[]>>
  getPane(paneId: string): Promise<Result<HerdrPaneInfo | null>>
}

// ── Internal Helpers ─────────────────────────────────────────────────────

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
  if (columns === null || rows === null) return null
  return { columns, rows }
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

// ── State Structures ─────────────────────────────────────────────────────

interface HerdrAttachmentState {
  readonly token: symbol
  readonly clientId: TerminalOperationContext["clientId"]
  readonly operation: TerminalOperationContext
  active: boolean
  lastCapture: Uint8Array
}

interface LiveHerdrTerminalState {
  reference: TerminalReference
  readonly paneId: string
  readonly bufferByteLimit: number
  columns: number
  rows: number
  lifecycle: "active" | "terminated"
  ownerClientId: string | null
  epoch: number
  createdAt: string
  updatedAt: string
  readonly attachments: Map<string, HerdrAttachmentState>
  readonly mutex: AsyncMutex
  acceptingWrites: boolean
}

// ── Options ──────────────────────────────────────────────────────────────

export interface HerdrTerminalBackendOptions {
  readonly client?: HerdrClient
  readonly processRunner?: ProcessRunner
  readonly authorizer?: TerminalAuthorizer
  readonly clock?: () => Date
  readonly defaultHolder?: string
  readonly herdrExecutable?: string
  readonly sessionCommand?: (request: CreateTerminalRequest) => Promise<Result<readonly [string, ...string[]]>>
}

// ── HerdrTerminalBackend Implementation ──────────────────────────────────

export class HerdrTerminalBackend implements TerminalBackend {
  readonly kind = HERDR_KIND

  private readonly client: HerdrClient
  private readonly authorizer?: TerminalAuthorizer
  private readonly clock: () => Date
  private readonly defaultHolder?: string
  private readonly sessionCommand?: HerdrTerminalBackendOptions["sessionCommand"]
  private readonly states = new Map<string, LiveHerdrTerminalState>()
  private readonly createMutex = new AsyncMutex()

  constructor(options?: HerdrTerminalBackendOptions) {
    if (options?.client) {
      this.client = options.client
    } else if (options?.processRunner) {
      this.client = new CliHerdrClient(options.processRunner, {
        executable: options.herdrExecutable,
      })
    } else {
      this.client = new InMemoryHerdrClient()
    }
    this.authorizer = options?.authorizer
    this.clock = options?.clock ?? (() => new Date())
    this.defaultHolder = options?.defaultHolder
    this.sessionCommand = options?.sessionCommand
  }

  /** Expose the active client instance for verification and inspection. */
  getClient(): HerdrClient {
    return this.client
  }

  async create(request: CreateTerminalRequest): Promise<Result<TerminalReference>> {
    const dimensions = normalizeDimensions({ columns: request.columns, rows: request.rows })
    if (dimensions === null) {
      return failure("validation", "terminal.invalid_dimensions", "Terminal dimensions must be finite and positive", request.operation)
    }

    const parsed = createTerminalRequestSchema.safeParse({ ...request, ...dimensions })
    if (!parsed.success) {
      return failure("validation", "terminal.invalid_create_request", "Terminal create request is invalid", request.operation)
    }
    const value = parsed.data
    if (value.backendKind !== this.kind) {
      return failure("unsupported_capability", "terminal.backend_mismatch", `Requested terminal backend '${value.backendKind}' is not '${this.kind}'`, value.operation)
    }

    return this.createMutex.run(async () => {
      const terminalIdStr = String(value.terminalId)
      if (this.states.has(terminalIdStr)) {
        return failure("conflict", "terminal.already_exists", "Terminal identifier is already bound", value.operation)
      }

      const reference: TerminalReference = {
        schemaVersion: 1,
        terminalId: value.terminalId,
        nodeId: value.operation.nodeId,
        projectId: value.operation.projectId,
        sessionId: value.sessionId,
        backendKind: this.kind,
        adapterMetadata: {},
      }

      const authorization = await this.authorize("create", value.operation, reference)
      if (!authorization.ok) return authorization

      let command: readonly string[] | undefined
      if (this.sessionCommand) {
        const resolved = await this.sessionCommand(value)
        if (!resolved.ok) return resolved
        if (resolved.value.some((arg) => arg.length === 0 || arg.includes("\0"))) {
          return failure("validation", "terminal.invalid_session_command", "The terminal session command is invalid", value.operation)
        }
        command = resolved.value
      }

      const paneResult = await this.client.createPane({
        title: terminalIdStr,
        command,
      })
      if (!paneResult.ok) {
        return failure("runtime_failure", "terminal.create_failed", paneResult.error.message, value.operation)
      }

      const paneId = paneResult.value.paneId
      const now = this.timestamp()
      if (now === null) {
        return failure("internal_failure", "terminal.invalid_clock", "Terminal clock produced an invalid timestamp", value.operation)
      }

      const liveState: LiveHerdrTerminalState = {
        reference: {
          ...reference,
          adapterMetadata: { paneId },
        },
        paneId,
        bufferByteLimit: value.bufferByteLimit,
        columns: dimensions.columns,
        rows: dimensions.rows,
        lifecycle: "active",
        ownerClientId: null,
        epoch: 0,
        createdAt: now,
        updatedAt: now,
        attachments: new Map(),
        mutex: new AsyncMutex(),
        acceptingWrites: true,
      }

      this.states.set(terminalIdStr, liveState)
      return ok(liveState.reference)
    })
  }

  async attach(reference: TerminalReference, operation: TerminalOperationContext): Promise<Result<TerminalChannel>> {
    const resolved = this.resolveState(reference, operation)
    if (!resolved.ok) return resolved
    const state = resolved.value

    const authorization = await this.authorize("attach", operation, state.reference)
    if (!authorization.ok) return authorization

    return state.mutex.run(async () => {
      if (!state.acceptingWrites || state.lifecycle !== "active") {
        return failure("conflict", "terminal.not_active", "Terminal is not active", operation)
      }

      const previous = state.attachments.get(operation.clientId)
      if (previous !== undefined) previous.active = false
      if (state.ownerClientId === operation.clientId) state.ownerClientId = null

      const attachment: HerdrAttachmentState = {
        token: Symbol("herdr-terminal-attachment"),
        clientId: operation.clientId,
        operation,
        active: true,
        lastCapture: new Uint8Array(),
      }
      state.attachments.set(operation.clientId, attachment)

      const channel: TerminalChannel = {
        reference: state.reference,
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

  async resize(
    reference: TerminalReference,
    dimensions: TerminalDimensions,
    operation: TerminalOperationContext,
  ): Promise<Result<void>> {
    const normalized = normalizeDimensions(dimensions)
    if (normalized === null || !terminalDimensionsSchema.safeParse(normalized).success) {
      return failure("validation", "terminal.invalid_dimensions", "Terminal dimensions must be finite and positive", operation)
    }
    const resolved = this.resolveState(reference, operation)
    if (!resolved.ok) return resolved
    const state = resolved.value

    const authorization = await this.authorize("resize", operation, state.reference)
    if (!authorization.ok) return authorization

    return state.mutex.run(async () => {
      if (state.ownerClientId !== null && state.ownerClientId !== operation.clientId) {
        return failure("policy_denied", "terminal.input_not_owned", "Only the current input owner may resize the live terminal", operation)
      }
      const resizeResult = await this.client.resizePane(state.paneId, normalized.columns, normalized.rows)
      if (!resizeResult.ok) {
        return failure("runtime_failure", "terminal.resize_failed", resizeResult.error.message, operation)
      }
      state.columns = normalized.columns
      state.rows = normalized.rows
      state.updatedAt = this.timestamp() ?? state.updatedAt
      return ok(undefined)
    })
  }

  async snapshot(reference: TerminalReference, operation: TerminalOperationContext): Promise<Result<TerminalSnapshot>> {
    const resolved = this.resolveState(reference, operation)
    if (!resolved.ok) return resolved
    const state = resolved.value

    const authorization = await this.authorize("snapshot", operation, state.reference)
    if (!authorization.ok) return authorization

    const readResult = await this.client.readPane(state.paneId, { source: "scrollback" })
    if (!readResult.ok) {
      return failure("runtime_failure", "terminal.snapshot_failed", readResult.error.message, operation)
    }

    const bytes = new TextEncoder().encode(readResult.value)
    const bounded = tailBytes(bytes, state.bufferByteLimit)
    const timestamp = this.timestamp()
    if (timestamp === null) {
      return failure("internal_failure", "terminal.invalid_clock", "Terminal clock produced an invalid timestamp", operation)
    }

    return ok(terminalSnapshotSchema.parse({
      schemaVersion: 1,
      terminalId: state.reference.terminalId,
      nodeId: state.reference.nodeId,
      projectId: state.reference.projectId,
      sessionId: state.reference.sessionId,
      capturedAt: timestamp,
      byteCount: bounded.byteLength,
      truncated: bounded.byteLength < bytes.byteLength,
      data: Uint8Array.from(bounded),
    }))
  }

  async detach(reference: TerminalReference, operation: TerminalOperationContext): Promise<Result<void>> {
    const resolved = this.resolveState(reference, operation)
    if (!resolved.ok) return resolved
    const state = resolved.value

    const authorization = await this.authorize("detach", operation, state.reference)
    if (!authorization.ok) return authorization

    return state.mutex.run(async () => {
      const attachment = state.attachments.get(operation.clientId)
      if (attachment !== undefined) {
        attachment.active = false
        state.attachments.delete(operation.clientId)
      }
      if (state.ownerClientId === operation.clientId) {
        state.ownerClientId = null
      }
      return ok(undefined)
    })
  }

  async terminate(reference: TerminalReference, operation: TerminalControlOperationContext): Promise<Result<void>> {
    const parsed = terminalControlOperationContextSchema.safeParse(operation)
    if (!parsed.success) {
      return failure("validation", "terminal.invalid_operation", "Terminal control operation is invalid", operation)
    }
    const resolved = this.resolveState(reference, parsed.data)
    if (!resolved.ok) return resolved
    const state = resolved.value

    const authorization = await this.authorize("terminate", parsed.data, state.reference)
    if (!authorization.ok) return authorization

    state.acceptingWrites = false
    for (const attachment of state.attachments.values()) {
      attachment.active = false
    }
    state.ownerClientId = null
    state.lifecycle = "terminated"

    return state.mutex.run(async () => {
      await this.client.closePane(state.paneId).catch(() => undefined)
      this.states.delete(String(state.reference.terminalId))
      return ok(undefined)
    })
  }

  async recover(operation: TerminalOperationContext): Promise<Result<TerminalReference[]>> {
    const parsed = terminalOperationContextSchema.safeParse(operation)
    if (!parsed.success) {
      return failure("validation", "terminal.invalid_operation", "Terminal recovery operation is invalid", operation)
    }
    const authorization = await this.authorize("recover", parsed.data)
    if (!authorization.ok) return authorization

    const references: TerminalReference[] = []
    for (const state of this.states.values()) {
      if (state.lifecycle !== "active") continue
      if (state.reference.nodeId !== parsed.data.nodeId || state.reference.projectId !== parsed.data.projectId) continue
      references.push(state.reference)
    }
    return ok(references)
  }

  // ── Channel I/O & Fence Discipline ─────────────────────────────────────

  private async readChannel(
    state: LiveHerdrTerminalState,
    attachment: HerdrAttachmentState,
    maxBytes: number,
  ): Promise<Result<Uint8Array>> {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      return failure("validation", "terminal.invalid_read_limit", "Terminal read limit must be finite and positive", attachment.operation)
    }
    const limit = Math.min(state.bufferByteLimit, Math.floor(maxBytes))
    const authorization = await this.authorize("read", attachment.operation, state.reference)
    if (!authorization.ok) return authorization
    if (!this.isCurrentAttachment(state, attachment)) {
      return failure("conflict", "terminal.channel_closed", "Terminal attachment is no longer active", attachment.operation)
    }

    const readResult = await this.client.readPane(state.paneId, { source: "recent" })
    if (!readResult.ok) {
      return failure("runtime_failure", "terminal.read_failed", readResult.error.message, attachment.operation)
    }

    const bytes = new TextEncoder().encode(readResult.value)
    const previous = attachment.lastCapture
    const delta = startsWith(bytes, previous) ? bytes.slice(previous.byteLength) : bytes
    attachment.lastCapture = tailBytes(bytes, state.bufferByteLimit)
    return ok(tailBytes(delta, limit))
  }

  /**
   * Performs a fenced write to a Herdr pane.
   *
   * STRICT F1 FENCE DISCIPLINE:
   * 1. Claim: pane.claim_input { pane_id, holder, epoch }
   *    - Human focus refusal (granted: false, holder: "human") -> fail clearly, NEVER write.
   *    - Holder conflict refusal -> fail clearly, NEVER write.
   * 2. Write: sendText with { holder, epoch }
   *    - If daemon returns `input_fenced`, surface as typed failure, NEVER retry around fence.
   * 3. Release: pane.release_input { pane_id, holder, epoch } in finally block.
   */
  private async writeChannel(
    state: LiveHerdrTerminalState,
    attachment: HerdrAttachmentState,
    data: Uint8Array,
  ): Promise<Result<void>> {
    if (!(data instanceof Uint8Array) || data.byteLength > MAX_INPUT_BYTES) {
      return failure("validation", "terminal.input_too_large", "Terminal input exceeds the per-write byte limit", attachment.operation)
    }

    return state.mutex.run(async (): Promise<Result<void>> => {
      if (!this.isCurrentAttachment(state, attachment)) {
        return failure("policy_denied", "terminal.input_not_owned", "Terminal input is not owned by this attachment", attachment.operation)
      }

      const authorization = await this.authorize("write", attachment.operation, state.reference)
      if (!authorization.ok) return authorization

      // Internal ownership check: if input ownership was claimed by another AIBridge client, refuse
      if (state.ownerClientId !== null && state.ownerClientId !== attachment.clientId) {
        return failure("policy_denied", "terminal.input_not_owned", "Terminal input is not owned by this attachment", attachment.operation)
      }

      if (!state.acceptingWrites || state.lifecycle !== "active") {
        return failure("conflict", "terminal.not_active", "Terminal is not active", attachment.operation)
      }

      // F1 Input Fence with Herdr daemon
      const holder = this.holderFor(attachment.operation)
      const claimEpoch = state.epoch

      // Step 1: Claim input fence
      const claimResult = await this.client.claimInput(state.paneId, holder, claimEpoch)
      if (!claimResult.ok) {
        return failure(
          claimResult.error.category ?? "policy_denied",
          claimResult.error.code ?? "terminal.claim_failed",
          claimResult.error.message,
          attachment.operation,
          false,
        )
      }

      const { granted, epoch: grantedEpoch, holder: currentHolder } = claimResult.value
      if (!granted) {
        // Human-focused pane refusal
        if (currentHolder === "human") {
          return failure(
            "policy_denied",
            "terminal.input_fenced",
            "Terminal input claim refused: pane is human-focused (holder 'human')",
            attachment.operation,
            false,
          )
        }
        // Conflict with another external holder or stale epoch
        return failure(
          "conflict",
          "terminal.input_fenced",
          `Terminal input claim refused: fence is currently held by '${currentHolder}' (epoch ${grantedEpoch})`,
          attachment.operation,
          false,
        )
      }

      // Claim granted: record new monotonic epoch
      state.epoch = grantedEpoch

      // Step 2 & 3: Bracketed write and release
      let writeFailure: Result<never> | null = null
      try {
        const text = new TextDecoder().decode(data)
        const writeResult = await this.client.sendText(state.paneId, text, {
          holder,
          epoch: grantedEpoch,
        })
        if (!writeResult.ok) {
          // An unheld write rejects input_fenced — the backend must never retry around the fence.
          const errorCode =
            writeResult.error.code === "input_fenced"
              ? "terminal.input_fenced"
              : (writeResult.error.code ?? "terminal.input_fenced")
          writeFailure = failure(
            writeResult.error.category ?? "policy_denied",
            errorCode,
            writeResult.error.message,
            attachment.operation,
            false, // NEVER retry around the fence
          )
        }
      } catch (err) {
        writeFailure = failure(
          "runtime_failure",
          "terminal.write_failed",
          err instanceof Error ? err.message : String(err),
          attachment.operation,
          false,
        )
      } finally {
        // Step 3: Always release input fence after write attempt
        const releaseResult = await this.client.releaseInput(state.paneId, holder, grantedEpoch)
        if (!releaseResult.ok && writeFailure === null) {
          writeFailure = failure(
            releaseResult.error.category ?? "runtime_failure",
            releaseResult.error.code ?? "terminal.release_failed",
            releaseResult.error.message,
            attachment.operation,
            false,
          )
        }
      }

      if (writeFailure !== null) {
        return writeFailure
      }

      return ok(undefined)
    })
  }

  // ── Input Ownership (AIBridge Layer) ───────────────────────────────────

  private async requestInput(
    state: LiveHerdrTerminalState,
    attachment: HerdrAttachmentState,
    operation: TerminalOperationContext,
  ): Promise<Result<TerminalInputOwnership>> {
    const checked = this.checkChannelOperation(state, attachment, operation)
    if (!checked.ok) return checked
    const authorization = await this.authorize("request_input", checked.value, state.reference)
    if (!authorization.ok) return authorization

    return state.mutex.run(async () => {
      if (!this.isCurrentAttachment(state, attachment)) {
        return failure("conflict", "terminal.channel_closed", "Terminal attachment is no longer active", checked.value)
      }
      if (state.ownerClientId !== null && state.ownerClientId !== attachment.clientId) {
        return failure("conflict", "terminal.input_owned", "Terminal input is owned by another client", checked.value)
      }
      state.ownerClientId = attachment.clientId
      return this.ownership(state, checked.value)
    })
  }

  private async releaseInput(
    state: LiveHerdrTerminalState,
    attachment: HerdrAttachmentState,
    operation: TerminalOperationContext,
  ): Promise<Result<TerminalInputOwnership>> {
    const checked = this.checkChannelOperation(state, attachment, operation)
    if (!checked.ok) return checked
    const authorization = await this.authorize("release_input", checked.value, state.reference)
    if (!authorization.ok) return authorization

    return state.mutex.run(async () => {
      if (state.ownerClientId === attachment.clientId) {
        state.ownerClientId = null
      }
      return this.ownership(state, checked.value)
    })
  }

  private async takeOverInput(
    state: LiveHerdrTerminalState,
    attachment: HerdrAttachmentState,
    request: InputTakeoverRequest,
  ): Promise<Result<TerminalInputOwnership>> {
    const parsed = inputTakeoverRequestSchema.safeParse(request)
    if (!parsed.success) {
      return failure("validation", "terminal.invalid_takeover", "Terminal takeover request is invalid", request.operation)
    }
    const checked = this.checkChannelOperation(state, attachment, parsed.data.operation)
    if (!checked.ok) return checked
    const authorization = await this.authorize("takeover_input", checked.value, state.reference, parsed.data.reason)
    if (!authorization.ok) return authorization

    return state.mutex.run(async () => {
      if (!this.isCurrentAttachment(state, attachment)) {
        return failure("conflict", "terminal.channel_closed", "Terminal attachment is no longer active", checked.value)
      }
      state.ownerClientId = attachment.clientId
      return this.ownership(state, checked.value)
    })
  }

  private ownership(state: LiveHerdrTerminalState, operation: TerminalOperationContext): Result<TerminalInputOwnership> {
    const timestamp = this.timestamp()
    if (timestamp === null) {
      return failure("internal_failure", "terminal.invalid_clock", "Terminal clock produced an invalid timestamp", operation)
    }
    return ok(terminalInputOwnershipSchema.parse({
      schemaVersion: 1,
      terminalId: state.reference.terminalId,
      ownerClientId: state.ownerClientId,
      changedAt: timestamp,
    }))
  }

  private checkChannelOperation(
    state: LiveHerdrTerminalState,
    attachment: HerdrAttachmentState,
    operation: TerminalOperationContext,
  ): Result<TerminalOperationContext> {
    const parsed = terminalOperationContextSchema.safeParse(operation)
    if (!parsed.success) {
      return failure("validation", "terminal.invalid_operation", "Terminal channel operation is invalid", operation)
    }
    if (parsed.data.clientId !== attachment.clientId) {
      return failure("policy_denied", "terminal.client_mismatch", "The operation client identifier does not match this channel", parsed.data)
    }
    if (parsed.data.nodeId !== state.reference.nodeId || parsed.data.projectId !== state.reference.projectId) {
      return failure("policy_denied", "terminal.scope_mismatch", "The operation scope does not match this terminal", parsed.data)
    }
    return ok(parsed.data)
  }

  private resolveState(reference: TerminalReference, operation: TerminalOperationContext): Result<LiveHerdrTerminalState> {
    const parsed = terminalReferenceSchema.safeParse(reference)
    if (!parsed.success) {
      return failure("validation", "terminal.invalid_reference", "Terminal reference is invalid", operation)
    }
    const state = this.states.get(String(parsed.data.terminalId))
    if (!state) {
      return failure("conflict", "terminal.not_found", "Terminal reference was not found on this backend", operation)
    }
    if (state.reference.nodeId !== operation.nodeId || state.reference.projectId !== operation.projectId) {
      return failure("policy_denied", "terminal.scope_mismatch", "Terminal reference does not match the operation scope", operation)
    }
    return ok(state)
  }

  private isCurrentAttachment(state: LiveHerdrTerminalState, attachment: HerdrAttachmentState): boolean {
    const current = state.attachments.get(attachment.clientId)
    return current !== undefined && current.active && current.token === attachment.token
  }

  private holderFor(operation?: TerminalOperationContext): string {
    return this.defaultHolder ?? (operation ? String(operation.clientId) : "aibr-orchestrator")
  }

  private timestamp(): string | null {
    try {
      const now = this.clock()
      return Number.isNaN(now.getTime()) ? null : now.toISOString()
    } catch {
      return null
    }
  }

  private async authorize(
    action: TerminalAction,
    operation: TerminalOperationContext,
    reference?: TerminalReference,
    reason?: string,
  ): Promise<Result<void>> {
    if (!this.authorizer) return ok(undefined)
    return this.authorizer.authorize({
      action,
      operation,
      ...(reference === undefined ? {} : { reference }),
      ...(reason === undefined ? {} : { takeoverReason: reason }),
    })
  }
}

// ── In-Memory Herdr Client (Fakes & Unit Testing) ─────────────────────────

export interface FakeHerdrCall {
  readonly method: string
  readonly args: Record<string, unknown>
}

/**
 * Deterministic in-memory fake Herdr client implementing F1 input-ownership fencing.
 *
 * Records all call sequences (`calls`) to verify bracketed claim -> write -> release semantics.
 */
export class InMemoryHerdrClient implements HerdrClient {
  readonly calls: FakeHerdrCall[] = []
  private readonly panes = new Map<string, {
    output: string
    isHumanFocused: boolean
    holder: string | null
    epoch: number
  }>()
  nextPaneId = 1
  failWritesWithInputFenced = false

  constructor(options?: {
    panes?: Array<{ paneId: string; isHumanFocused?: boolean; output?: string }>
  }) {
    if (options?.panes) {
      for (const p of options.panes) {
        this.panes.set(p.paneId, {
          output: p.output ?? "",
          isHumanFocused: p.isHumanFocused ?? false,
          holder: null,
          epoch: 0,
        })
      }
    }
  }

  setHumanFocused(paneId: string, focused: boolean): void {
    const pane = this.ensurePane(paneId)
    pane.isHumanFocused = focused
  }

  private ensurePane(paneId: string) {
    let pane = this.panes.get(paneId)
    if (!pane) {
      pane = { output: "", isHumanFocused: false, holder: null, epoch: 0 }
      this.panes.set(paneId, pane)
    }
    return pane
  }

  async claimInput(paneId: string, holder: string, epoch: number): Promise<Result<HerdrClaimResult>> {
    this.calls.push({ method: "claimInput", args: { paneId, holder, epoch } })
    const pane = this.ensurePane(paneId)

    if (pane.isHumanFocused) {
      return ok({
        granted: false,
        epoch: pane.epoch,
        holder: "human",
      })
    }

    if (epoch < pane.epoch) {
      return ok({
        granted: false,
        epoch: pane.epoch,
        holder: pane.holder ?? "human",
      })
    }

    if (pane.holder !== null && pane.holder !== holder && epoch === pane.epoch) {
      return ok({
        granted: false,
        epoch: pane.epoch,
        holder: pane.holder,
      })
    }

    const nextEpoch = Math.max(pane.epoch + 1, epoch + 1)
    pane.epoch = nextEpoch
    pane.holder = holder
    return ok({
      granted: true,
      epoch: nextEpoch,
      holder,
    })
  }

  async releaseInput(paneId: string, holder: string, epoch: number): Promise<Result<void>> {
    this.calls.push({ method: "releaseInput", args: { paneId, holder, epoch } })
    const pane = this.ensurePane(paneId)
    if (pane.holder === holder && pane.epoch === epoch) {
      pane.holder = null
    }
    return ok(undefined)
  }

  async sendText(paneId: string, text: string, options?: HerdrWriteOptions): Promise<Result<void>> {
    this.calls.push({ method: "sendText", args: { paneId, text, ...options } })
    if (this.failWritesWithInputFenced) {
      return {
        ok: false,
        error: {
          schemaVersion: 1,
          category: "policy_denied",
          code: "input_fenced",
          message: "pane input is fenced",
          retryable: false,
        },
      }
    }
    const pane = this.ensurePane(paneId)
    if (pane.isHumanFocused) {
      return {
        ok: false,
        error: {
          schemaVersion: 1,
          category: "policy_denied",
          code: "input_fenced",
          message: "pane input is fenced: pane is human-focused",
          retryable: false,
        },
      }
    }
    if (options?.holder !== pane.holder || (options?.epoch !== undefined && options.epoch !== pane.epoch)) {
      return {
        ok: false,
        error: {
          schemaVersion: 1,
          category: "policy_denied",
          code: "input_fenced",
          message: "pane input is fenced: holder or epoch mismatch",
          retryable: false,
        },
      }
    }
    pane.output += text
    return ok(undefined)
  }

  async sendKeys(paneId: string, keys: readonly string[], options?: HerdrWriteOptions): Promise<Result<void>> {
    this.calls.push({ method: "sendKeys", args: { paneId, keys, ...options } })
    return this.sendText(paneId, keys.join(""), options)
  }

  async readPane(paneId: string): Promise<Result<string>> {
    this.calls.push({ method: "readPane", args: { paneId } })
    const pane = this.ensurePane(paneId)
    return ok(pane.output)
  }

  async createPane(options?: { cwd?: string; env?: Record<string, string>; title?: string; command?: readonly string[] }): Promise<Result<{ paneId: string }>> {
    const paneId = `herdr-pane-${this.nextPaneId++}`
    this.calls.push({ method: "createPane", args: { paneId, ...options } })
    this.ensurePane(paneId)
    return ok({ paneId })
  }

  async closePane(paneId: string): Promise<Result<void>> {
    this.calls.push({ method: "closePane", args: { paneId } })
    this.panes.delete(paneId)
    return ok(undefined)
  }

  async resizePane(paneId: string, columns: number, rows: number): Promise<Result<void>> {
    this.calls.push({ method: "resizePane", args: { paneId, columns, rows } })
    return ok(undefined)
  }

  async listPanes(): Promise<Result<readonly HerdrPaneInfo[]>> {
    this.calls.push({ method: "listPanes", args: {} })
    const list: HerdrPaneInfo[] = []
    for (const [paneId, state] of this.panes.entries()) {
      list.push({ paneId, isHumanFocused: state.isHumanFocused })
    }
    return ok(list)
  }

  async getPane(paneId: string): Promise<Result<HerdrPaneInfo | null>> {
    this.calls.push({ method: "getPane", args: { paneId } })
    const pane = this.panes.get(paneId)
    if (!pane) return ok(null)
    return ok({ paneId, isHumanFocused: pane.isHumanFocused })
  }
}

// ── ProcessRunner-driven CLI Herdr Client ────────────────────────────────

/**
 * Adapter translating HerdrClient port operations to `herdr pane ...` CLI executions.
 */
export class CliHerdrClient implements HerdrClient {
  private readonly runner: ProcessRunner
  private readonly executable: string

  constructor(runner: ProcessRunner, options?: { executable?: string }) {
    this.runner = runner
    this.executable = options?.executable ?? "herdr"
  }

  async claimInput(paneId: string, holder: string, epoch: number): Promise<Result<HerdrClaimResult>> {
    const result = await this.runner.exec([
      this.executable,
      "pane",
      "claim-input",
      paneId,
      holder,
      String(epoch),
    ])
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          schemaVersion: 1,
          category: "policy_denied",
          code: "herdr.claim_failed",
          message: result.stderr || "claim-input failed",
          retryable: false,
        },
      }
    }
    try {
      const parsed = JSON.parse(result.stdout)
      return ok({
        granted: Boolean(parsed.granted),
        epoch: Number(parsed.epoch ?? epoch),
        holder: String(parsed.holder ?? holder),
      })
    } catch {
      return ok({ granted: true, epoch: epoch + 1, holder })
    }
  }

  async releaseInput(paneId: string, holder: string, epoch: number): Promise<Result<void>> {
    const result = await this.runner.exec([
      this.executable,
      "pane",
      "release-input",
      paneId,
      holder,
      String(epoch),
    ])
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          schemaVersion: 1,
          category: "runtime_failure",
          code: "herdr.release_failed",
          message: result.stderr || "release-input failed",
          retryable: false,
        },
      }
    }
    return ok(undefined)
  }

  async sendText(paneId: string, text: string, _options?: HerdrWriteOptions): Promise<Result<void>> {
    const result = await this.runner.exec([
      this.executable,
      "pane",
      "send-text",
      paneId,
      text,
    ])
    if (result.exitCode !== 0) {
      const isFenced = result.stderr.includes("input_fenced")
      return {
        ok: false,
        error: {
          schemaVersion: 1,
          category: isFenced ? "policy_denied" : "runtime_failure",
          code: isFenced ? "input_fenced" : "herdr.send_text_failed",
          message: result.stderr || "send-text failed",
          retryable: false,
        },
      }
    }
    return ok(undefined)
  }

  async sendKeys(paneId: string, keys: readonly string[], _options?: HerdrWriteOptions): Promise<Result<void>> {
    const result = await this.runner.exec([
      this.executable,
      "pane",
      "send-keys",
      paneId,
      ...keys,
    ])
    if (result.exitCode !== 0) {
      const isFenced = result.stderr.includes("input_fenced")
      return {
        ok: false,
        error: {
          schemaVersion: 1,
          category: isFenced ? "policy_denied" : "runtime_failure",
          code: isFenced ? "input_fenced" : "herdr.send_keys_failed",
          message: result.stderr || "send-keys failed",
          retryable: false,
        },
      }
    }
    return ok(undefined)
  }

  async readPane(paneId: string, options?: { lines?: number; source?: "scrollback" | "visible" | "recent"; stripAnsi?: boolean }): Promise<Result<string>> {
    const args = [this.executable, "pane", "read", paneId]
    if (options?.source) args.push(`--source=${options.source}`)
    if (options?.lines !== undefined) args.push(`--lines=${options.lines}`)
    const result = await this.runner.exec(args)
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          schemaVersion: 1,
          category: "runtime_failure",
          code: "herdr.read_failed",
          message: result.stderr || "read failed",
          retryable: false,
        },
      }
    }
    return ok(result.stdout)
  }

  async createPane(options?: { cwd?: string; env?: Record<string, string>; title?: string; command?: readonly string[] }): Promise<Result<{ paneId: string }>> {
    const args = [this.executable, "pane", "split"]
    if (options?.cwd) args.push(`--cwd=${options.cwd}`)
    const result = await this.runner.exec(args)
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          schemaVersion: 1,
          category: "runtime_failure",
          code: "herdr.create_pane_failed",
          message: result.stderr || "split failed",
          retryable: false,
        },
      }
    }
    const paneId = result.stdout.trim() || `pane-${Date.now()}`
    return ok({ paneId })
  }

  async closePane(paneId: string): Promise<Result<void>> {
    const result = await this.runner.exec([this.executable, "pane", "close", paneId])
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          schemaVersion: 1,
          category: "runtime_failure",
          code: "herdr.close_failed",
          message: result.stderr || "close failed",
          retryable: false,
        },
      }
    }
    return ok(undefined)
  }

  async resizePane(_paneId: string, _columns: number, _rows: number): Promise<Result<void>> {
    return ok(undefined)
  }

  async listPanes(): Promise<Result<readonly HerdrPaneInfo[]>> {
    const result = await this.runner.exec([this.executable, "pane", "list"])
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          schemaVersion: 1,
          category: "runtime_failure",
          code: "herdr.list_failed",
          message: result.stderr || "list failed",
          retryable: false,
        },
      }
    }
    return ok([])
  }

  async getPane(paneId: string): Promise<Result<HerdrPaneInfo | null>> {
    return ok({ paneId })
  }
}
