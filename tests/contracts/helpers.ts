import { contractErrorSchema, type ContractError, type Result } from "../../src/orchestration/errors.js"
import { correlationIdSchema, type CorrelationId } from "../../src/orchestration/identifiers.js"

export const CONTRACT_TIME = "2026-09-17T00:00:00.000Z"

/** A test-only UTC clock whose value changes only when a test asks it to. */
export class DeterministicClock {
  #milliseconds: number

  constructor(initial = CONTRACT_TIME) {
    this.#milliseconds = Date.parse(initial)
    if (!Number.isFinite(this.#milliseconds)) throw new TypeError("Initial clock time must be a valid UTC instant")
  }

  now(): string {
    return new Date(this.#milliseconds).toISOString()
  }

  advance(milliseconds: number): string {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new TypeError("Clock advance must be a nonnegative safe integer")
    }
    this.#milliseconds += milliseconds
    return this.now()
  }
}

/** Stable, opaque IDs for contract fixtures; never use this in production code. */
export class DeterministicIdSource {
  #sequence = 0

  next(kind: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(kind)) {
      throw new TypeError("ID kind must be an opaque-ID-safe token")
    }
    this.#sequence += 1
    return `${kind}-${String(this.#sequence).padStart(4, "0")}`
  }
}

export function typedFailure(
  category: ContractError["category"],
  code: string,
  message: string,
  correlationId?: string,
): Result<never> {
  return {
    ok: false,
    error: contractErrorSchema.parse({
      schemaVersion: 1,
      category,
      code,
      message,
      retryable: category === "transient_transport" || category === "timeout" || category === "runtime_failure" || category === "internal_failure",
      ...(correlationId === undefined ? {} : { correlationId: correlationIdSchema.parse(correlationId) }),
    }),
  }
}

export function success<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function requireSuccess<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`Expected contract success, got ${result.error.category}:${result.error.code}`)
  return result.value
}

export function correlation(value = "correlation-contract-1"): CorrelationId {
  return correlationIdSchema.parse(value)
}
