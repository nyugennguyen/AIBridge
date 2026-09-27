import { z } from "zod"
import { correlationIdSchema, schemaVersionSchema } from "./identifiers.js"

export const errorCategorySchema = z.enum([
  "validation",
  "unsupported_capability",
  "policy_denied",
  "approval_required",
  "conflict",
  "stale_epoch",
  "transient_transport",
  "timeout",
  "runtime_failure",
  "internal_failure",
])

export const contractErrorSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    category: errorCategorySchema,
    code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    message: z.string().min(1).max(4096),
    retryable: z.boolean(),
    correlationId: correlationIdSchema.optional(),
  })
  .strict()
  .superRefine((error, ctx) => {
    if (
      error.retryable &&
      ["validation", "unsupported_capability", "policy_denied", "approval_required", "conflict", "stale_epoch"].includes(error.category)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["retryable"],
        message: `${error.category} errors cannot be retried automatically`,
      })
    }
  })

export type ErrorCategory = z.infer<typeof errorCategorySchema>
export type ContractError = z.infer<typeof contractErrorSchema>
export type Result<T> = { ok: true; value: T } | { ok: false; error: ContractError }

export function createContractError(
  category: ErrorCategory,
  code: string,
  message: string,
  retryable = false,
  correlationId?: string,
): ContractError {
  return contractErrorSchema.parse({
    schemaVersion: 1,
    category,
    code,
    message,
    retryable,
    ...(correlationId ? { correlationId } : {}),
  })
}

export class InvalidStateTransitionError extends Error {
  readonly entity: string
  readonly fromState: string
  readonly toState: string
  readonly isTerminal: boolean
  readonly reason?: string

  constructor(
    entity: string,
    fromState: string,
    toState: string,
    options?: { isTerminal?: boolean; reason?: string } | string,
  ) {
    const isTerminal = typeof options === "object" ? (options.isTerminal ?? false) : false
    const reason = typeof options === "string" ? options : options?.reason
    const reasonText = reason ? `: ${reason}` : ""
    const msg = isTerminal
      ? `Cannot transition ${entity} from terminal state '${fromState}' to '${toState}': terminal states are strictly immutable${reasonText}`
      : `Illegal ${entity} state transition from '${fromState}' to '${toState}'${reasonText}`
    super(msg)
    this.name = "InvalidStateTransitionError"
    this.entity = entity
    this.fromState = fromState
    this.toState = toState
    this.isTerminal = isTerminal
    this.reason = reason
  }

  toContractError(): ContractError {
    return {
      schemaVersion: 1,
      category: "conflict",
      code: this.isTerminal ? "state.terminal_immutable" : "state.invalid_transition",
      message: this.message.slice(0, 4096),
      retryable: false,
    }
  }
}

export class InvariantViolationError extends Error {
  readonly invariant: string
  readonly category: ErrorCategory
  readonly code: string

  constructor(invariant: string, message: string, options?: { category?: ErrorCategory; code?: string }) {
    super(`Invariant violation [${invariant}]: ${message}`)
    this.name = "InvariantViolationError"
    this.invariant = invariant
    this.category = options?.category ?? "conflict"
    this.code = options?.code ?? "invariant.violation"
  }

  toContractError(): ContractError {
    return {
      schemaVersion: 1,
      category: this.category,
      code: this.code,
      message: this.message.slice(0, 4096),
      retryable: false,
    }
  }
}
