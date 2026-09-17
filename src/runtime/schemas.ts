import { z } from "zod"
import {
  approvalIdSchema,
  commandIdSchema,
  correlationIdSchema,
  digestSchema,
  dispatchIdSchema,
  epochSchema,
  eventIdSchema,
  installationIdSchema,
  leaseIdSchema,
  meshIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  schemaVersionSchema,
  sessionIdSchema,
  taskIdSchema,
  timestampSchema,
} from "../orchestration/identifiers.js"
import { dispatchEnvelopeSchema, sessionSchema, sessionStateSchema } from "../orchestration/schemas.js"

const boundedTextSchema = z.string().trim().min(1).max(4096)
const boundedSummarySchema = z.string().trim().min(1).max(16_384)
const safeMetadataKeySchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/)
  .refine((key) => !/(?:credential|password|secret|token)/i.test(key), "Metadata keys must not name credentials")

export const runtimeKindSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)

export const runtimeCapabilitiesSchema = z
  .object({
    structuredPermissions: z.boolean(),
    nativeSessionRestore: z.boolean(),
    reliableCompletion: z.boolean(),
    modelSelection: z.boolean(),
    usageData: z.boolean(),
    hooks: z.boolean(),
    transcriptExport: z.boolean(),
  })
  .strict()

export const nodeContextSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    nodeId: nodeIdSchema,
    meshId: meshIdSchema,
    platform: z.string().trim().min(1).max(128),
    architecture: z.string().trim().min(1).max(128),
  })
  .strict()

export const agentInstallationSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    installationId: installationIdSchema,
    nodeId: nodeIdSchema,
    runtimeKind: runtimeKindSchema,
    displayName: boundedTextSchema,
    version: z.string().trim().min(1).max(128).optional(),
    executable: z.string().trim().min(1).max(1024).optional(),
    capabilities: runtimeCapabilitiesSchema,
  })
  .strict()

export const runtimeOperationContextSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: commandIdSchema,
    correlationId: correlationIdSchema,
    projectId: projectIdSchema,
    runId: runIdSchema,
    dispatchId: dispatchIdSchema,
    nodeId: nodeIdSchema,
    controllerNodeId: nodeIdSchema,
    controllerEpoch: epochSchema,
    leaseId: leaseIdSchema,
  })
  .strict()

export const runtimeSessionSchema = sessionSchema

export const runtimeMetadataSchema = z
  .record(safeMetadataKeySchema, z.string().trim().min(1).max(2048))
  .superRefine((metadata, context) => {
    if (Object.keys(metadata).length > 32) {
      context.addIssue({ code: "custom", message: "Runtime metadata may contain at most 32 entries" })
    }
  })

export const runtimeSessionReferenceSchema = runtimeSessionSchema
  .extend({
    adapterMetadata: runtimeMetadataSchema,
  })
  .strict()

export const launchAgentRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    operation: runtimeOperationContextSchema,
    dispatchEnvelope: dispatchEnvelopeSchema,
    dispatchEnvelopeDigest: digestSchema,
    approvalId: approvalIdSchema,
  })
  .strict()
  .superRefine((request, context) => {
    const { dispatchEnvelope: envelope, operation } = request
    if (operation.projectId !== envelope.projectId) {
      context.addIssue({ code: "custom", path: ["operation", "projectId"], message: "Operation project must match envelope" })
    }
    if (operation.runId !== envelope.runId) {
      context.addIssue({ code: "custom", path: ["operation", "runId"], message: "Operation run must match envelope" })
    }
    if (operation.dispatchId !== envelope.dispatchId) {
      context.addIssue({ code: "custom", path: ["operation", "dispatchId"], message: "Operation dispatch must match envelope" })
    }
    if (operation.nodeId !== envelope.targetNodeId) {
      context.addIssue({ code: "custom", path: ["operation", "nodeId"], message: "Operation node must match envelope target" })
    }
    if (operation.controllerEpoch !== envelope.controllerEpoch) {
      context.addIssue({ code: "custom", path: ["operation", "controllerEpoch"], message: "Operation epoch must match envelope" })
    }
  })

export const promptRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    operation: runtimeOperationContextSchema,
    prompt: boundedSummarySchema,
  })
  .strict()

export const agentResponseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    operation: runtimeOperationContextSchema,
    responseId: eventIdSchema,
    kind: z.enum(["permission", "input", "selection"]),
    value: boundedTextSchema,
  })
  .strict()

export const completionEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("reliable_provider"),
      mechanism: boundedTextSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("trusted_evidence"),
      digest: digestSchema,
      source: boundedTextSchema,
    })
    .strict(),
])

export const agentResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      schemaVersion: schemaVersionSchema,
      outcome: z.literal("succeeded"),
      summary: boundedSummarySchema,
      completionEvidence: completionEvidenceSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: schemaVersionSchema,
      outcome: z.literal("failed"),
      summary: boundedSummarySchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: schemaVersionSchema,
      outcome: z.literal("unknown"),
      summary: boundedSummarySchema,
    })
    .strict(),
])

export const agentRuntimeEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      schemaVersion: schemaVersionSchema,
      eventId: eventIdSchema,
      projectId: projectIdSchema,
      runId: runIdSchema,
      taskId: taskIdSchema,
      dispatchId: dispatchIdSchema,
      sessionId: sessionIdSchema,
      nodeId: nodeIdSchema,
      occurredAt: timestampSchema,
      type: z.literal("lifecycle"),
      state: sessionStateSchema,
      detail: boundedTextSchema.optional(),
    })
    .strict(),
  z
    .object({
      schemaVersion: schemaVersionSchema,
      eventId: eventIdSchema,
      projectId: projectIdSchema,
      runId: runIdSchema,
      taskId: taskIdSchema,
      dispatchId: dispatchIdSchema,
      sessionId: sessionIdSchema,
      nodeId: nodeIdSchema,
      occurredAt: timestampSchema,
      type: z.literal("permission_requested"),
      permission: boundedTextSchema,
      requestId: eventIdSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: schemaVersionSchema,
      eventId: eventIdSchema,
      projectId: projectIdSchema,
      runId: runIdSchema,
      taskId: taskIdSchema,
      dispatchId: dispatchIdSchema,
      sessionId: sessionIdSchema,
      nodeId: nodeIdSchema,
      occurredAt: timestampSchema,
      type: z.literal("result_available"),
      result: agentResultSchema,
    })
    .strict(),
])

export type RuntimeCapabilities = z.infer<typeof runtimeCapabilitiesSchema>
export type NodeContext = z.infer<typeof nodeContextSchema>
export type AgentInstallation = z.infer<typeof agentInstallationSchema>
export type RuntimeOperationContext = z.infer<typeof runtimeOperationContextSchema>
export type RuntimeSession = z.infer<typeof runtimeSessionSchema>
export type RuntimeSessionReference = z.infer<typeof runtimeSessionReferenceSchema>
export type LaunchAgentRequest = z.infer<typeof launchAgentRequestSchema>
export type PromptRequest = z.infer<typeof promptRequestSchema>
export type AgentResponse = z.infer<typeof agentResponseSchema>
export type CompletionEvidence = z.infer<typeof completionEvidenceSchema>
export type AgentResult = z.infer<typeof agentResultSchema>
export type AgentRuntimeEvent = z.infer<typeof agentRuntimeEventSchema>
