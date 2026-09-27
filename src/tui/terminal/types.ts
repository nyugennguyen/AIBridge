import type { ContractError, Result } from "../../orchestration/errors.js"
import type { TerminalDimensions, TerminalInputOwnership, TerminalOperationContext, TerminalReference } from "../../terminal/types.js"

export const TERMINAL_ESCAPE_BYTE = 0x1d
export const MAX_TERMINAL_PRESENTATION_BYTES = 1_048_576
export const DEFAULT_TERMINAL_PRESENTATION_BYTES = 256 * 1024
export const DEFAULT_TERMINAL_READ_BYTES = 64 * 1024

export type TerminalAttachmentMode =
  | "detached"
  | "attaching"
  | "read-only"
  | "requesting-input"
  | "input-owned"
  | "detaching"
  | "closed"

export interface TerminalTakeoverConfirmation {
  readonly ownerLabel: string
  readonly sessionLabel: string
  readonly reasonRequired: true
}

/** Safe, renderer-ready state. Raw terminal bytes are never exposed to the UI. */
export interface TerminalViewModel {
  readonly mode: TerminalAttachmentMode
  readonly terminalLabel: string | null
  readonly sessionLabel: string | null
  readonly projectLabel: string | null
  readonly status: "DETACHED" | "ATTACHING" | "READ ONLY" | "REQUESTING INPUT" | "INPUT OWNED" | "DETACHING" | "CLOSED"
  readonly output: string
  readonly outputByteCount: number
  readonly outputTruncated: boolean
  readonly footer: string
  readonly ownerLabel: string | null
  readonly takeoverConfirmation: TerminalTakeoverConfirmation | null
  readonly message: string | null
  readonly error: ContractError | null
}

/** Injectable rendering boundary. It has no backend, process, or tmux access. */
export interface TerminalViewPort {
  render(model: TerminalViewModel): void
}

export interface TerminalBindingLabels {
  readonly terminal: string
  readonly session: string
  readonly project: string
}

export interface TerminalControllerScheduler {
  schedule(task: () => void): void
}

export interface TerminalControllerOptions {
  readonly operation: () => TerminalOperationContext
  readonly view?: TerminalViewPort
  readonly presentationByteLimit?: number
  readonly readByteLimit?: number
  readonly scheduler?: TerminalControllerScheduler
  /** Recovery without canonical run history is permanently inspect-only. */
  readonly mutationAllowed?: boolean
}

export interface TerminalInputDisposition {
  readonly forwardedBytes: number
  readonly discardedBytes: number
  readonly escapedToCommandMode: boolean
}

export interface TerminalViewController {
  getViewModel(): TerminalViewModel
  attach(reference: TerminalReference, labels: TerminalBindingLabels): Promise<Result<void>>
  refreshOutput(): Promise<Result<void>>
  requestInput(): Promise<Result<void>>
  beginTakeover(ownerLabel: string): Result<void>
  cancelTakeover(): void
  confirmTakeover(reason: string): Promise<Result<void>>
  sendInput(data: Uint8Array): Promise<Result<TerminalInputDisposition>>
  resizeContent(dimensions: TerminalDimensions): boolean
  observeOwnership(ownership: TerminalInputOwnership): void
  revokeInput(reason: string): void
  detach(): Promise<Result<void>>
  close(): Promise<void>
}
