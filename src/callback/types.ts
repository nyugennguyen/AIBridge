import type { z } from "zod"
import type { reportCallbackSchema } from "../config/schemas.js"

export type ReportCallback = z.infer<typeof reportCallbackSchema>
