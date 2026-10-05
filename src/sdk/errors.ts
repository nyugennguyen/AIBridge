/**
 * AIBridge Extension SDK — Error taxonomy and Result primitives (M8.7).
 */

import {
  createContractError,
  type ContractError,
  type ErrorCategory,
  type Result,
} from "../orchestration/errors.js"

export type { ContractError, ErrorCategory, Result }

export type SdkResult<T> = Result<T>
export type SdkContractError = ContractError

export function sdkOk<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function sdkErr<T = never>(
  category: ErrorCategory,
  code: string,
  message: string,
  retryable = false,
  correlationId?: string,
): Result<T> {
  return {
    ok: false,
    error: createContractError(category, code, message, retryable, correlationId),
  }
}

export function isSdkOk<T>(result: Result<T>): result is { ok: true; value: T } {
  return result.ok === true
}

export function isSdkErr<T>(result: Result<T>): result is { ok: false; error: ContractError } {
  return result.ok === false
}
