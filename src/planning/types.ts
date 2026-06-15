import type { z } from "zod"
import type { planMetadataSchema, planStatusSchema } from "../config/schemas.js"

export type PlanMetadata = z.infer<typeof planMetadataSchema>
export type PlanStatus = z.infer<typeof planStatusSchema>
