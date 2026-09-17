import type { Result } from "../orchestration/errors.js"
import type {
  CreateTerminalRequest,
  InputTakeoverRequest,
  TerminalDimensions,
  TerminalInputOwnership,
  TerminalControlOperationContext,
  TerminalOperationContext,
  TerminalReference,
  TerminalSnapshot,
} from "./schemas.js"

export type {
  CreateTerminalRequest,
  InputTakeoverRequest,
  TerminalDimensions,
  TerminalInputOwnership,
  TerminalControlOperationContext,
  TerminalOperationContext,
  TerminalReference,
  TerminalSnapshot,
} from "./schemas.js"

/** A live, bounded terminal attachment. It is never an orchestration event. */
export interface TerminalChannel {
  readonly reference: TerminalReference
  readonly clientId: TerminalOperationContext["clientId"]
  read(maxBytes: number): Promise<Result<Uint8Array>>
  write(data: Uint8Array): Promise<Result<void>>
  requestInputOwnership(operation: TerminalOperationContext): Promise<Result<TerminalInputOwnership>>
  releaseInputOwnership(operation: TerminalOperationContext): Promise<Result<TerminalInputOwnership>>
  takeOverInput(request: InputTakeoverRequest): Promise<Result<TerminalInputOwnership>>
}

/** Provider-neutral terminal lifecycle and attachment boundary. */
export interface TerminalBackend {
  readonly kind: string

  create(request: CreateTerminalRequest): Promise<Result<TerminalReference>>
  attach(reference: TerminalReference, operation: TerminalOperationContext): Promise<Result<TerminalChannel>>
  resize(
    reference: TerminalReference,
    dimensions: TerminalDimensions,
    operation: TerminalOperationContext,
  ): Promise<Result<void>>
  snapshot(reference: TerminalReference, operation: TerminalOperationContext): Promise<Result<TerminalSnapshot>>
  detach(reference: TerminalReference, operation: TerminalOperationContext): Promise<Result<void>>
  terminate(reference: TerminalReference, operation: TerminalControlOperationContext): Promise<Result<void>>
  recover(operation: TerminalOperationContext): Promise<Result<TerminalReference[]>>
}
