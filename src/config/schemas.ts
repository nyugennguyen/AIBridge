import { z } from "zod"

export const planStatusSchema = z.enum(["none", "submitted", "approved", "rejected"])
export const permissionResponseSchema = z.enum(["reject", "once", "always"])

export const allowedSourceSchema = z.object({
  source_agent_id: z.string().min(1),
  capabilities: z.array(z.string().min(1)),
  requires_plan_approval: z.array(z.string().min(1)).default([]),
})

export const agentConfigSchema = z.object({
  id: z.string().min(1),
  url: z.url(),
  capabilities: z.array(z.string().min(1)),
})

export const projectConfigSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  capabilities: z.array(z.string().min(1)),
})

export const bridgeConfigSchema = z.object({
  agent_id: z.string().min(1),
  bridge: z.object({
    host: z.string().min(1),
    port: z.number().int().positive(),
    public_url: z.url(),
    ingress_mode: z.enum(["engine", "router"]).default("engine"),
  }),
  opencode: z.object({
    base_url: z.url(),
    server_port: z.number().int().positive(),
    username: z.string().default("opencode"),
    password_env: z.string().default("OPENCODE_SERVER_PASSWORD"),
  }),
  security: z.object({
    auth_mode: z.literal("bearer-token"),
    allowed_sources: z.array(allowedSourceSchema),
  }),
  permissions: z.object({
    default_response: permissionResponseSchema,
    allow_tools: z.array(z.string().min(1)),
    require_plan_approval_for_tools: z.array(z.string().min(1)),
  }),
  projects: z.array(projectConfigSchema),
  agents: z.array(agentConfigSchema),
  timeouts: z.object({
    default_job_seconds: z.number().int().positive(),
    callback_retry_attempts: z.number().int().nonnegative(),
  }),
  planning: z.object({
    plan_annotator_enabled: z.boolean(),
    require_approval_for: z.array(z.string().min(1)),
  }),
})

export const planMetadataSchema = z
  .object({
    plan_status: planStatusSchema,
    plan_reference: z.string().min(1).optional(),
    approved_by: z.string().min(1).optional(),
    approved_at: z.string().min(1).optional(),
  })
  .optional()

export const remoteDependencySchema = z.object({
  agent_id: z.string().min(1),
  job_id: z.string().min(1),
})

export const dependencyReferenceSchema = z.union([z.string().min(1), remoteDependencySchema])

export const triggerRequestSchema = z.object({
  job_id: z.string().min(1).optional(),
  source_agent_id: z.string().min(1),
  target_agent_id: z.string().min(1),
  capability: z.string().min(1),
  project_dir: z.string().min(1),
  prompt: z.string().min(1),
  callback_url: z.url(),
  timeout_seconds: z.number().int().positive(),
  depends_on: z.array(dependencyReferenceSchema).default([]).optional(),
  task_id: z.string().optional(),
  metadata: planMetadataSchema,
})

export const triggerResponseSchema = z.object({
  accepted: z.boolean(),
  job_id: z.string().min(1),
  target_agent_id: z.string().min(1),
  opencode_session_id: z.string().min(1).optional(),
  status_url: z.url(),
  status: z.enum(["accepted", "blocked", "failed"]).optional(),
  task_id: z.string().optional(),
})

export const reportCallbackSchema = z.object({
  job_id: z.string().min(1),
  source_agent_id: z.string().min(1),
  target_agent_id: z.string().min(1),
  opencode_session_id: z.string().min(1).optional(),
  status: z.enum(["completed", "failed", "timed_out", "callback_failed"]),
  summary: z.string().min(1),
  findings: z.array(
    z.object({
      severity: z.enum(["low", "medium", "high", "critical"]),
      title: z.string(),
      details: z.string(),
      reproduction: z.string().optional(),
    }),
  ),
  artifacts: z.array(z.object({ type: z.string(), path: z.string() })),
  started_at: z.string(),
  completed_at: z.string(),
})
