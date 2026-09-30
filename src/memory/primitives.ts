/**
 * Small shared Zod primitives for the memory subsystem.
 *
 * The orchestration kernel keeps these private inside `src/orchestration/schemas.ts`
 * because that file is inside the M0 contract digest and must not export new
 * names. Re-declaring them here is the alternative to editing a signed file, and
 * these are the same three-line shapes, not a new vocabulary: bounds and
 * helpers, nothing domain-shaped.
 */

import { z } from "zod"

export const SHORT_TEXT_MAX = 256
export const TEXT_MAX = 4_096
export const LARGE_TEXT_MAX = 65_536
export const ARRAY_MAX = 128

export const shortTextSchema = z
  .string()
  .min(1)
  .max(SHORT_TEXT_MAX)
  .refine((value) => value === value.trim(), "Must not have surrounding whitespace")

export const textSchema = z.string().min(1).max(TEXT_MAX)
export const largeTextSchema = z.string().min(1).max(LARGE_TEXT_MAX)
export const positiveSafeIntegerSchema = z.number().int().positive().safe()
export const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().safe()

export function isUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

export function addMismatch(ctx: z.RefinementCtx, path: PropertyKey[], message: string): void {
  ctx.addIssue({ code: "custom", path, message })
}
