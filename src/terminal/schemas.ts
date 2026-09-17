import { z } from "zod"
import {
  commandIdSchema,
  correlationIdSchema,
  epochSchema,
  leaseIdSchema,
  nodeIdSchema,
  projectIdSchema,
  schemaVersionSchema,
  sessionIdSchema,
  terminalClientIdSchema,
  terminalIdSchema,
  timestampSchema,
} from "../orchestration/identifiers.js"

const boundedReasonSchema = z.string().trim().min(1).max(1024)
const backendKindSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
const positiveDimensionSchema = z.number().int().positive().max(1000)
const byteLimitSchema = z.number().int().positive().safe().max(1_048_576)
const safeMetadataKeySchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/)
  .refine((key) => !/(?:credential|password|secret|token)/i.test(key), "Metadata keys must not name credentials")

export const terminalControllerAuthoritySchema = z
  .object({
    controllerNodeId: nodeIdSchema,
    controllerEpoch: epochSchema,
    leaseId: leaseIdSchema,
  })
  .strict()

/**
 * A client context authenticates the attachment separately from controller
 * liveness. Controller authority is required by create/terminate requests.
 */
export const terminalOperationContextSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: commandIdSchema,
    correlationId: correlationIdSchema,
    projectId: projectIdSchema,
    nodeId: nodeIdSchema,
    clientId: terminalClientIdSchema,
    controllerAuthority: terminalControllerAuthoritySchema.optional(),
  })
  .strict()

export const terminalControlOperationContextSchema = terminalOperationContextSchema
  .extend({
    controllerAuthority: terminalControllerAuthoritySchema,
  })
  .strict()

export const terminalMetadataSchema = z
  .record(safeMetadataKeySchema, z.string().trim().min(1).max(2048))
  .superRefine((metadata, context) => {
    if (Object.keys(metadata).length > 32) {
      context.addIssue({ code: "custom", message: "Terminal metadata may contain at most 32 entries" })
    }
  })

export const terminalReferenceSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    terminalId: terminalIdSchema,
    nodeId: nodeIdSchema,
    projectId: projectIdSchema,
    sessionId: sessionIdSchema,
    backendKind: backendKindSchema,
    adapterMetadata: terminalMetadataSchema,
  })
  .strict()

export const createTerminalRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    operation: terminalControlOperationContextSchema,
    terminalId: terminalIdSchema,
    sessionId: sessionIdSchema,
    backendKind: backendKindSchema,
    columns: positiveDimensionSchema,
    rows: positiveDimensionSchema,
    bufferByteLimit: byteLimitSchema,
  })
  .strict()

export const terminalDimensionsSchema = z
  .object({
    columns: positiveDimensionSchema,
    rows: positiveDimensionSchema,
  })
  .strict()

export const terminalSnapshotSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    terminalId: terminalIdSchema,
    nodeId: nodeIdSchema,
    projectId: projectIdSchema,
    sessionId: sessionIdSchema,
    capturedAt: timestampSchema,
    byteCount: z.number().int().nonnegative().safe().max(1_048_576),
    truncated: z.boolean(),
    data: z.instanceof(Uint8Array).refine((data) => data.byteLength <= 1_048_576, "Snapshot exceeds byte cap"),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.byteCount !== snapshot.data.byteLength) {
      context.addIssue({ code: "custom", path: ["byteCount"], message: "Byte count must match snapshot data" })
    }
  })

export const terminalInputOwnershipSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    terminalId: terminalIdSchema,
    ownerClientId: terminalClientIdSchema.nullable(),
    changedAt: timestampSchema,
  })
  .strict()

export const inputTakeoverRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    operation: terminalOperationContextSchema,
    reason: boundedReasonSchema,
  })
  .strict()

export type TerminalControllerAuthority = z.infer<typeof terminalControllerAuthoritySchema>
export type TerminalOperationContext = z.infer<typeof terminalOperationContextSchema>
export type TerminalControlOperationContext = z.infer<typeof terminalControlOperationContextSchema>
export type TerminalReference = z.infer<typeof terminalReferenceSchema>
export type CreateTerminalRequest = z.infer<typeof createTerminalRequestSchema>
export type TerminalDimensions = z.infer<typeof terminalDimensionsSchema>
export type TerminalSnapshot = z.infer<typeof terminalSnapshotSchema>
export type TerminalInputOwnership = z.infer<typeof terminalInputOwnershipSchema>
export type InputTakeoverRequest = z.infer<typeof inputTakeoverRequestSchema>
