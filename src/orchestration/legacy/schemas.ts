import { z } from "zod"
import {
  capabilitySchema,
  digestSchema,
  epochSchema,
  installationIdSchema,
  meshIdSchema,
  nodeIdSchema,
  projectIdSchema,
  projectPathIdSchema,
  schemaVersionSchema,
  taskIdSchema,
  timestampSchema,
} from "../identifiers.js"
import { dispatchSchema, memoryRecordSchema, runSchema, taskSchema } from "../schemas.js"

const SHORT_TEXT_MAX = 256
const TEXT_MAX = 4_096
const LARGE_TEXT_MAX = 65_536
const ARRAY_MAX = 128

const nonemptyTextSchema = z.string().min(1).max(LARGE_TEXT_MAX)
const shortTextSchema = z.string().min(1).max(SHORT_TEXT_MAX)
const legacyCapabilityListSchema = z.array(z.string().min(1).max(SHORT_TEXT_MAX)).max(ARRAY_MAX)

export const legacyPlanStatusSchema = z.enum(["none", "submitted", "approved", "rejected"])

export const legacyPlanMetadataSchema = z
  .object({
    plan_status: legacyPlanStatusSchema,
    plan_reference: z.string().min(1).max(TEXT_MAX).optional(),
    approved_by: z.string().min(1).max(SHORT_TEXT_MAX).optional(),
    approved_at: z.string().min(1).max(SHORT_TEXT_MAX).optional(),
  })
  .strict()

export const legacyAllowedSourceSchema = z
  .object({
    source_agent_id: shortTextSchema,
    capabilities: legacyCapabilityListSchema,
    requires_plan_approval: legacyCapabilityListSchema.default([]),
  })
  .strict()

export const legacyAgentConfigSchema = z
  .object({
    id: shortTextSchema,
    url: z.url(),
    capabilities: legacyCapabilityListSchema,
  })
  .strict()

export const legacyProjectConfigSchema = z
  .object({
    id: shortTextSchema,
    path: nonemptyTextSchema,
    capabilities: legacyCapabilityListSchema,
  })
  .strict()

export const legacyBridgeConfigSchema = z
  .object({
    agent_id: shortTextSchema,
    bridge: z
      .object({
        host: shortTextSchema,
        port: z.number().int().positive().max(65_535),
        public_url: z.url(),
      })
      .strict(),
    opencode: z
      .object({
        base_url: z.url(),
        server_port: z.number().int().positive().max(65_535),
        username: shortTextSchema.default("opencode"),
        password_env: shortTextSchema.default("OPENCODE_SERVER_PASSWORD"),
      })
      .strict(),
    security: z
      .object({
        auth_mode: z.literal("bearer-token"),
        allowed_sources: z.array(legacyAllowedSourceSchema).max(ARRAY_MAX),
      })
      .strict(),
    permissions: z
      .object({
        default_response: z.enum(["reject", "once", "always"]),
        allow_tools: legacyCapabilityListSchema,
        require_plan_approval_for_tools: legacyCapabilityListSchema,
      })
      .strict(),
    projects: z.array(legacyProjectConfigSchema).max(ARRAY_MAX),
    agents: z.array(legacyAgentConfigSchema).max(ARRAY_MAX),
    timeouts: z
      .object({
        default_job_seconds: z.number().int().positive().safe(),
        callback_retry_attempts: z.number().int().nonnegative().safe(),
      })
      .strict(),
    planning: z
      .object({
        plan_annotator_enabled: z.boolean(),
        require_approval_for: legacyCapabilityListSchema,
      })
      .strict(),
  })
  .strict()

export const legacyRemoteDependencySchema = z
  .object({
    agent_id: shortTextSchema,
    job_id: shortTextSchema,
  })
  .strict()

export const legacyDependencyReferenceSchema = z.union([shortTextSchema, legacyRemoteDependencySchema])

export const legacyTriggerSchema = z
  .object({
    job_id: shortTextSchema.optional(),
    source_agent_id: shortTextSchema,
    target_agent_id: shortTextSchema,
    capability: shortTextSchema,
    project_dir: nonemptyTextSchema,
    prompt: nonemptyTextSchema,
    callback_url: z.url(),
    timeout_seconds: z.number().int().positive().max(86_400).safe(),
    depends_on: z.array(legacyDependencyReferenceSchema).max(ARRAY_MAX).default([]).optional(),
    task_id: z.string().min(1).max(SHORT_TEXT_MAX).optional(),
    metadata: legacyPlanMetadataSchema.optional(),
  })
  .strict()

export const legacyJobStatusSchema = z.enum([
  "received",
  "accepted",
  "blocked",
  "session_created",
  "running",
  "reporting",
  "completed",
  "failed",
  "timed_out",
  "callback_failed",
])

export const legacyRemoteDependencyStateSchema = legacyRemoteDependencySchema.extend({
  status: z.enum(["completed", "failed", "timed_out", "callback_failed"]).optional(),
  reportedAt: timestampSchema.optional(),
}).strict()

export const legacyCallbackDeliverySchema = z
  .object({
    status: z.enum(["pending", "delivered", "failed"]),
    attemptedAt: timestampSchema,
    error: z.string().min(1).max(TEXT_MAX).optional(),
  })
  .strict()

export const legacyJobRecordSchema = z
  .object({
    id: shortTextSchema,
    trigger: legacyTriggerSchema,
    status: legacyJobStatusSchema,
    opencodeSessionId: shortTextSchema.optional(),
    error: z.string().min(1).max(TEXT_MAX).optional(),
    depends_on: z.array(shortTextSchema).max(ARRAY_MAX).optional(),
    remoteDependencies: z.array(legacyRemoteDependencyStateSchema).max(ARRAY_MAX).optional(),
    callbackDelivery: legacyCallbackDeliverySchema.optional(),
    blockedAt: timestampSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((job, ctx) => {
    if (Date.parse(job.updatedAt) < Date.parse(job.createdAt)) {
      ctx.addIssue({ code: "custom", path: ["updatedAt"], message: "Updated time cannot precede creation time" })
    }
    if (job.trigger.job_id !== undefined && job.trigger.job_id !== job.id) {
      ctx.addIssue({ code: "custom", path: ["trigger", "job_id"], message: "Trigger job ID must match record ID" })
    }
  })

export const legacyJobsSchema = z
  .array(legacyJobRecordSchema)
  .max(10_000)
  .superRefine((jobs, ctx) => {
    const seen = new Set<string>()
    jobs.forEach((job, index) => {
      if (seen.has(job.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "Legacy job IDs must be unique" })
      seen.add(job.id)
    })
  })

export const legacyTaskStatusSchema = z.enum(["pending", "blocked", "running", "done", "failed"])

export const legacyTaskEntrySchema = z
  .object({
    id: z.string().regex(/^#[0-9]+$/),
    title: shortTextSchema,
    agent: shortTextSchema.optional(),
    status: legacyTaskStatusSchema,
    depends_on: z.array(z.string().regex(/^#[0-9]+$/)).max(ARRAY_MAX),
    metadata: z.record(z.string().min(1).max(SHORT_TEXT_MAX), z.string().max(TEXT_MAX)),
  })
  .strict()

export const legacyTasksSchema = z
  .array(legacyTaskEntrySchema)
  .max(10_000)
  .superRefine((tasks, ctx) => {
    const seen = new Set<string>()
    tasks.forEach((task, index) => {
      if (seen.has(task.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "Legacy task IDs must be unique" })
      seen.add(task.id)
    })
  })

export const legacyDecisionSchema = z
  .object({
    id: shortTextSchema,
    timestamp: timestampSchema,
    agent: shortTextSchema,
    content: nonemptyTextSchema,
  })
  .strict()

export const legacyHandoffSchema = z
  .object({
    id: shortTextSchema,
    from: shortTextSchema,
    to: shortTextSchema,
    context: nonemptyTextSchema,
    status: z.enum(["pending", "accepted", "completed"]),
    createdAt: timestampSchema,
  })
  .strict()

export const legacyMemoryDataSchema = z
  .object({
    projectId: shortTextSchema,
    decisions: z.array(legacyDecisionSchema).max(10_000),
    constraints: z.array(nonemptyTextSchema).max(10_000),
    handoffs: z.array(legacyHandoffSchema).max(10_000),
  })
  .strict()

export const legacyMigrationSourceSchema = z
  .object({
    config: legacyBridgeConfigSchema,
    jobs: legacyJobsSchema,
    tasksMarkdown: z.string().max(4_000_000),
    memory: legacyMemoryDataSchema,
  })
  .strict()

export const legacyAgentMappingSchema = z
  .object({
    legacyAgentId: shortTextSchema,
    nodeId: nodeIdSchema,
    installationId: installationIdSchema,
    runtimeKind: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  })
  .strict()

export const legacyProjectMappingSchema = z
  .object({
    legacyProjectId: shortTextSchema,
    projectId: projectIdSchema,
    projectPathId: projectPathIdSchema,
    targetNodeId: nodeIdSchema,
    configuredPath: nonemptyTextSchema,
  })
  .strict()

export const legacyMigrationContextSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    sourceProfileId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    meshId: meshIdSchema,
    importedAt: timestampSchema,
    controllerNodeId: nodeIdSchema,
    controllerEpoch: epochSchema,
    pathResolutionBase: nonemptyTextSchema,
    agentMappings: z.array(legacyAgentMappingSchema).max(ARRAY_MAX),
    projectMappings: z.array(legacyProjectMappingSchema).max(ARRAY_MAX),
  })
  .strict()
  .superRefine((context, ctx) => {
    const agentIds = new Set<string>()
    const nodeIds = new Set<string>()
    context.agentMappings.forEach((mapping, index) => {
      if (agentIds.has(mapping.legacyAgentId)) {
        ctx.addIssue({ code: "custom", path: ["agentMappings", index, "legacyAgentId"], message: "Legacy agent mappings must be unique" })
      }
      if (nodeIds.has(mapping.nodeId)) {
        ctx.addIssue({ code: "custom", path: ["agentMappings", index, "nodeId"], message: "Node mappings must be one-to-one" })
      }
      agentIds.add(mapping.legacyAgentId)
      nodeIds.add(mapping.nodeId)
    })

    const projectIds = new Set<string>()
    const canonicalProjectIds = new Set<string>()
    const pathIds = new Set<string>()
    context.projectMappings.forEach((mapping, index) => {
      if (projectIds.has(mapping.legacyProjectId)) {
        ctx.addIssue({ code: "custom", path: ["projectMappings", index, "legacyProjectId"], message: "Legacy project mappings must be unique" })
      }
      if (canonicalProjectIds.has(mapping.projectId)) {
        ctx.addIssue({ code: "custom", path: ["projectMappings", index, "projectId"], message: "Canonical project mappings must be one-to-one" })
      }
      if (pathIds.has(mapping.projectPathId)) {
        ctx.addIssue({ code: "custom", path: ["projectMappings", index, "projectPathId"], message: "Project path IDs must be unique" })
      }
      projectIds.add(mapping.legacyProjectId)
      canonicalProjectIds.add(mapping.projectId)
      pathIds.add(mapping.projectPathId)
    })
  })

export const migrationDiagnosticSchema = z
  .object({
    severity: z.enum(["warning", "error"]),
    code: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/),
    message: z.string().min(1).max(TEXT_MAX),
    source: z
      .object({
        namespace: shortTextSchema,
        id: z.string().min(1).max(TEXT_MAX),
      })
      .strict()
      .optional(),
  })
  .strict()

export const legacyAuthorizationEvidenceSchema = z
  .object({
    bearerAuthentication: z.literal("required_not_persisted"),
    targetMatchesLocalAgent: z.boolean(),
    sourceCapabilityAllowed: z.boolean(),
    projectPathAllowed: z.boolean(),
    planApprovalRequired: z.boolean(),
    legacyPlanAnnotationApproved: z.boolean(),
    canonicalApprovalCreated: z.literal(false),
    historicalChecksPass: z.boolean(),
  })
  .strict()

export const legacyJobMigrationSchema = z
  .object({
    importKey: z.string().min(1).max(TEXT_MAX),
    sourceDigest: digestSchema,
    mappingFingerprint: digestSchema,
    legacyRecord: legacyJobRecordSchema,
    disposition: z.enum(["historical", "paused", "rejected"]),
    executionPolicy: z.literal("inert"),
    requiresReconciliation: z.boolean(),
    authorization: legacyAuthorizationEvidenceSchema,
    legacyStatus: legacyJobStatusSchema,
    callbackDelivery: legacyCallbackDeliverySchema.optional(),
    localDependencyReferences: z.array(z.object({ namespace: z.literal("legacy.job"), id: shortTextSchema }).strict()).max(ARRAY_MAX),
    remoteDependencyReferences: z
      .array(
        z
          .object({
            namespace: z.literal("legacy.remote-job"),
            id: z.string().min(1).max(TEXT_MAX),
            status: z.enum(["completed", "failed", "timed_out", "callback_failed"]).optional(),
            reportedAt: timestampSchema.optional(),
          })
          .strict(),
      )
      .max(ARRAY_MAX),
    providerSessionReference: z.object({ namespace: z.literal("opencode.session"), id: shortTextSchema }).strict().optional(),
    run: runSchema,
    task: taskSchema,
    dispatch: dispatchSchema,
  })
  .strict()

export const legacyTaskMigrationSchema = z
  .object({
    reference: z.object({ namespace: z.literal("legacy.task"), id: z.string().min(1).max(TEXT_MAX) }).strict(),
    disposition: z.enum(["linked", "rejected"]),
    canonicalTaskId: taskIdSchema.optional(),
    legacyStatus: legacyTaskStatusSchema,
    legacyRecord: legacyTaskEntrySchema,
  })
  .strict()

export const legacyConfigurationMigrationSchema = z
  .object({
    sourceDigest: digestSchema,
    mappingFingerprint: digestSchema,
    sourceProfileId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    legacyRecord: legacyBridgeConfigSchema,
    authentication: z
      .object({
        mode: z.literal("bearer-token"),
        disposition: z.literal("compatibility_only"),
        tokenMaterial: z.literal("not_imported"),
      })
      .strict(),
    localAgentId: shortTextSchema,
    allowedSources: z.array(legacyAllowedSourceSchema).max(ARRAY_MAX),
    projects: z
      .array(
        z
          .object({
            legacyProjectId: shortTextSchema,
            configuredPath: nonemptyTextSchema,
            resolvedPath: nonemptyTextSchema,
            capabilities: legacyCapabilityListSchema,
            canonicalProjectId: projectIdSchema.optional(),
            canonicalProjectPathId: projectPathIdSchema.optional(),
          })
          .strict(),
      )
      .max(ARRAY_MAX),
  })
  .strict()

export const legacyMigrationDryRunSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    mode: z.literal("dry-run"),
    canCommit: z.boolean(),
    sourceDigest: digestSchema.optional(),
    mappingFingerprint: digestSchema.optional(),
    configuration: legacyConfigurationMigrationSchema.optional(),
    jobs: z.array(legacyJobMigrationSchema),
    tasks: z.array(legacyTaskMigrationSchema),
    memory: z.array(memoryRecordSchema),
    diagnostics: z.array(migrationDiagnosticSchema),
  })
  .strict()
