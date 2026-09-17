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
