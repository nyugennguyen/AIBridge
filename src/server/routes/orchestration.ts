/**
 * Orchestration Command Ingress & Capability Preview Routes.
 *
 * ## Why this seam exists
 *
 * The orchestration kernel is the sole authority for state transitions,
 * charter proposals/approvals, and roundtable deliberations. External
 * controllers and human operators (such as the Herdr manager plugin `aibr-manager`)
 * interact with the local AIBridge node over HTTP to submit commands and preview
 * capability intersections.
 *
 * Two routes are exposed per the interface contract:
 * 1. `POST /orchestration/commands`: submits one `OrchestrationCommand` to the kernel's
 *    coordinator. Returns the coordinator result verbatim (`{ ok, value: { events, duplicate } }`
 *    or `{ ok: false, error }`). Refusals (including `charter_core_violation` from
 *    `assertCharterDoesNotRelaxCore`) are preserved unchanged so the caller can render
 *    them inline.
 * 2. `POST /orchestration/capability-preview`: evaluates effective capability envelopes
 *    using the kernel's pure `computeCapabilityEnvelope` function. This endpoint is
 *    strictly a preview for UI calculation and never grants permissions or modifies state.
 *
 * ## Auth and Authorization Discipline
 *
 * Matches `/trigger` and `/report` identically:
 * - In `bearer-token` mode, `createAuthProvider` validates the `Authorization: Bearer <token>`
 *   header. Missing or invalid credentials yield 401 `{ error: "Unauthorized" }`.
 * - User-kind `actor` claims additionally require the operator credential
 *   (`AIBRIDGE_OPERATOR_TOKEN`); without it they are refused with 403. The
 *   payload `actor` field is a claim, not an identity (ADR 0008 §4).
 * - Optional project allowlist enforcement: when projects are configured, the command's
 *   `projectId` must match an allowlisted project ID or path, yielding 403 on mismatch.
 * - Optional source agent authorization: if an inbound source agent is specified (via
 *   headers `x-source-agent-id` or `x-aibr-source-agent`), `assertSourceAuthorized` verifies
 *   the source agent and its declared capability against `config.security.allowed_sources`,
 *   yielding 403 on violation.
 */

import { resolve } from "node:path"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import type { AllowedSource, ProjectConfig } from "../../config/types.js"
import { bearerTokenMatches, createAuthProvider } from "../../security/auth-provider.js"
import { assertSourceAuthorized } from "../../security/source-authorization.js"
import { orchestrationCommandSchema } from "../../orchestration/schemas.js"
import type { OrchestrationCommand } from "../../orchestration/types.js"
import type { CoordinatorResult } from "../../orchestration/coordinator/types.js"
import { computeCapabilityEnvelope } from "../../runtime/opencode-adapter.js"
import type { CapabilityEnvelopeInput } from "../../runtime/types.js"
import type { AppDependencies } from "../app.js"

// ============================================================================
// Schemas
// ============================================================================

const previewRoleRestrictionsSchema = z.object({
  allowedCapabilities: z.array(z.string()).default([]),
  deniedCapabilities: z.array(z.string()).default([]),
  compositionMode: z.string().optional(),
})

const previewRoleWithRestrictionsSchema = z.object({
  roleId: z.string().optional(),
  name: z.string().optional(),
  instructions: z.string().optional(),
  permissionRestrictions: previewRoleRestrictionsSchema,
})

const previewRoleFlatSchema = z.object({
  roleId: z.string().optional(),
  name: z.string().optional(),
  instructions: z.string().optional(),
  allowedCapabilities: z.array(z.string()).default([]),
  deniedCapabilities: z.array(z.string()).default([]),
  compositionMode: z.string().optional(),
})

const previewRoleObjectSchema = z.union([
  previewRoleWithRestrictionsSchema,
  previewRoleFlatSchema,
])

const previewRoleAssignmentSchema = z.object({
  roleId: z.string(),
  primary: z.boolean().default(false),
  addendum: z.string().optional(),
})

const previewRuleSnapshotSchema = z.object({
  enabled: z.boolean(),
  effect: z.object({
    kind: z.string(),
    deniedCapabilities: z.array(z.string()).optional(),
  }),
})

const previewSingleRoleSnapshotSchema = z.object({
  roleId: z.string().optional(),
  name: z.string().optional(),
  instructions: z.string().optional(),
  permissionRestrictions: previewRoleRestrictionsSchema,
})

export const capabilityPreviewRequestSchema = z.object({
  requestedCapabilities: z.array(z.string()).default([]),
  permissionEnvelope: z
    .object({
      allowedCapabilities: z.array(z.string()).default([]),
      deniedCapabilities: z.array(z.string()).default([]),
    })
    .optional(),
  roles: z.array(previewRoleObjectSchema).optional(),
  roleAssignments: z.array(previewRoleAssignmentSchema).optional(),
  ruleSnapshots: z.array(previewRuleSnapshotSchema).optional(),
  roleSnapshot: previewSingleRoleSnapshotSchema.optional(),
  projectId: z.string().optional(),
})

export type CapabilityPreviewRequestBody = z.infer<typeof capabilityPreviewRequestSchema>

// ============================================================================
// Helpers
// ============================================================================

function assertProjectInAllowlist(projectIdOrDir: string, projects: ProjectConfig[]): ProjectConfig {
  const requested = resolve(projectIdOrDir)
  const project = projects.find(
    (candidate) => candidate.id === projectIdOrDir || resolve(candidate.path) === requested,
  )
  if (!project) {
    throw new Error(`Project is not allowlisted: ${projectIdOrDir}`)
  }
  return project
}

function verifySourceAuthorization(
  request: FastifyRequest,
  project: ProjectConfig | undefined,
  allowedSources: AllowedSource[],
): void {
  const sourceAgentId =
    (request.headers["x-source-agent-id"] as string | undefined) ??
    (request.headers["x-aibr-source-agent"] as string | undefined)
  if (sourceAgentId) {
    const capability =
      (request.headers["x-capability"] as string | undefined) ??
      project?.capabilities[0] ??
      "testing"
    assertSourceAuthorized(sourceAgentId, capability, allowedSources)
  }
}

// ============================================================================
// Route Registration
// ============================================================================

export function registerOrchestrationRoutes(app: FastifyInstance, dependencies: AppDependencies): void {
  // Built at registration, not per request: matching trigger.ts and report.ts discipline.
  const auth = createAuthProvider(
    dependencies.config.security.auth_mode,
    dependencies.bearerToken,
  )

  /**
   * POST /orchestration/commands
   *
   * Submits a single kernel OrchestrationCommand to the coordinator.
   */
  app.post("/orchestration/commands", async (request, reply) => {
    const operatorAuthed = bearerTokenMatches(request.headers.authorization, dependencies.operatorToken ?? null)
    if (!operatorAuthed && !auth.validate(request.headers.authorization)) {
      return reply.code(401).send({ error: "Unauthorized" })
    }

    const parsed = orchestrationCommandSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid command payload", details: parsed.error.issues })
    }
    const command = parsed.data

    // `actor` in the payload is a CLAIM, not an identity (ADR 0008 §4:
    // authorization must rest on authenticated state, never on self-asserted
    // payload fields). The peer bearer secret carries no per-caller identity, so
    // a payload claiming `kind: "user"` is self-asserted — and `kind: "user"` is
    // exactly the authority `charter.approve` and direct `charter.revise` gate
    // on. The operator credential is the only basis for that claim; forging it
    // over a peer credential is refused HERE rather than trusted downstream.
    if (command.actor.kind === "user" && !operatorAuthed) {
      return reply.code(403).send({ error: "Forbidden" })
    }

    try {
      let project: ProjectConfig | undefined
      if (dependencies.config.projects.length > 0) {
        project = assertProjectInAllowlist(command.projectId, dependencies.config.projects)
      }
      verifySourceAuthorization(request, project, dependencies.config.security.allowed_sources)
    } catch (error) {
      return reply.code(403).send({ error: error instanceof Error ? error.message : "Forbidden" })
    }

    const coordinator = dependencies.orchestration?.coordinator
    if (!coordinator) {
      return reply.code(503).send({
        ok: false,
        error: {
          schemaVersion: 1,
          category: "internal_failure",
          code: "coordinator_unavailable",
          message: "Orchestration coordinator not available",
          retryable: true,
        },
      })
    }

    try {
      let result: CoordinatorResult<{ readonly events: readonly string[]; readonly duplicate: boolean }>
      if (
        command.type === "session.prompt" &&
        "submitPrompt" in coordinator &&
        typeof coordinator.submitPrompt === "function"
      ) {
        result = await coordinator.submitPrompt(command)
      } else {
        result = await coordinator.submit(command)
      }

      return reply.code(200).send(result)
    } catch (error) {
      return reply.code(500).send({
        ok: false,
        error: {
          schemaVersion: 1,
          category: "internal_failure",
          code: "coordinator_execution_error",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
      })
    }
  })

  /**
   * POST /orchestration/capability-preview
   *
   * Computes the effective capability envelope intersection across assigned roles.
   * Preview only; never mutates kernel state.
   */
  app.post("/orchestration/capability-preview", async (request, reply) => {
    const operatorAuthed = bearerTokenMatches(request.headers.authorization, dependencies.operatorToken ?? null)
    if (!operatorAuthed && !auth.validate(request.headers.authorization)) {
      return reply.code(401).send({ error: "Unauthorized" })
    }

    const parsed = capabilityPreviewRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid capability preview payload", details: parsed.error.issues })
    }
    const body = parsed.data

    try {
      let project: ProjectConfig | undefined
      if (body.projectId && dependencies.config.projects.length > 0) {
        project = assertProjectInAllowlist(body.projectId, dependencies.config.projects)
      }
      verifySourceAuthorization(request, project, dependencies.config.security.allowed_sources)
    } catch (error) {
      return reply.code(403).send({ error: error instanceof Error ? error.message : "Forbidden" })
    }

    const normalizedRoles = body.roles?.map((r) => {
      if ("permissionRestrictions" in r) {
        return {
          roleId: r.roleId,
          name: r.name,
          instructions: r.instructions,
          permissionRestrictions: {
            allowedCapabilities: r.permissionRestrictions.allowedCapabilities,
            deniedCapabilities: r.permissionRestrictions.deniedCapabilities,
            compositionMode: r.permissionRestrictions.compositionMode,
          },
        }
      }
      return {
        roleId: r.roleId,
        name: r.name,
        instructions: r.instructions,
        permissionRestrictions: {
          allowedCapabilities: r.allowedCapabilities,
          deniedCapabilities: r.deniedCapabilities,
          compositionMode: r.compositionMode,
        },
      }
    })

    const envelopeInput: CapabilityEnvelopeInput = {
      requestedCapabilities: body.requestedCapabilities,
      permissionEnvelope: body.permissionEnvelope ?? {
        allowedCapabilities: body.requestedCapabilities,
        deniedCapabilities: [],
      },
      roles: normalizedRoles,
      roleAssignments: body.roleAssignments,
      ruleSnapshots: body.ruleSnapshots,
      roleSnapshot: body.roleSnapshot,
    }

    const computed = computeCapabilityEnvelope(envelopeInput)

    return reply.code(200).send({
      allowed: computed.allowed,
      denied: computed.denied,
      allowedSet: [...computed.allowedSet],
      deniedSet: [...computed.deniedSet],
      tools: computed.tools,
    })
  })
}
