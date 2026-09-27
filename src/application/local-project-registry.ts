import { realpath } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { arch, platform } from "node:process"
import type { BridgeConfig } from "../config/types.js"
import { digestJson } from "../orchestration/digest.js"
import type { ContractError, Result } from "../orchestration/errors.js"
import {
  installationIdSchema,
  leaseIdSchema,
  meshIdSchema,
  nodeIdSchema,
  projectIdSchema,
  projectPathIdSchema,
  roleIdSchema,
} from "../orchestration/identifiers.js"
import { projectSchema, roleTemplateSchema } from "../orchestration/schemas.js"
import { agentInstallationSchema, nodeContextSchema, runtimeCapabilitiesSchema } from "../runtime/schemas.js"
import type {
  LaunchPathAuthorizationRequest,
  LocalProjectDefinition,
  LocalProjectRegistry,
} from "./types.js"

function ok<T>(value: T): Result<T> { return { ok: true, value } }

function denied(code: string, message: string): Result<never> {
  const error: ContractError = { schemaVersion: 1, category: "policy_denied", code, message, retryable: false }
  return { ok: false, error }
}

function stableId(prefix: string, value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 96)
  return `${prefix}-${normalized || "local"}`
}

export function localOpencodeInstallationId(agentId: string) {
  return installationIdSchema.parse(stableId("installation-opencode", agentId))
}

/**
 * Converts the existing local profile allowlist into canonical M1 project
 * definitions. It re-resolves the exact configured path on every effect.
 */
export class ProfileLocalProjectRegistry implements LocalProjectRegistry {
  readonly #definitions: readonly LocalProjectDefinition[]
  readonly #pinnedRealPaths = new Map<string, string>()

  constructor(config: BridgeConfig, createdAt = new Date().toISOString()) {
    const nodeId = nodeIdSchema.parse(config.agent_id)
    const meshId = meshIdSchema.parse(stableId("mesh", config.agent_id))
    const installationId = localOpencodeInstallationId(config.agent_id)
    const capabilities = runtimeCapabilitiesSchema.parse({
      structuredPermissions: true,
      nativeSessionRestore: false,
      reliableCompletion: false,
      modelSelection: false,
      usageData: false,
      hooks: false,
      transcriptExport: false,
    })
    const installation = agentInstallationSchema.parse({
      schemaVersion: 1,
      installationId,
      nodeId,
      runtimeKind: "opencode",
      displayName: "OpenCode (loopback SDK)",
      capabilities,
    })
    const nodeContext = nodeContextSchema.parse({ schemaVersion: 1, nodeId, meshId, platform, architecture: arch })

    this.#definitions = config.projects.map((entry) => {
      const projectId = projectIdSchema.parse(entry.id)
      const projectPathId = projectPathIdSchema.parse(stableId("path", entry.id))
      try { this.#pinnedRealPaths.set(projectPathId, realpathSync(entry.path)) } catch { /* unavailable paths fail closed at launch */ }
      const allowed = [...new Set(entry.capabilities)].sort()
      const approvalCapabilities = allowed.filter((capability) =>
        config.planning.require_approval_for.includes(capability) ||
        config.permissions.require_plan_approval_for_tools.includes(capability),
      )
      const permissionEnvelope = {
        allowedCapabilities: allowed,
        deniedCapabilities: [] as string[],
        approvalRequirements: {
          destructiveEffects: true,
          externalEffects: true,
          capabilities: approvalCapabilities,
        },
      }
      const project = projectSchema.parse({
        schemaVersion: 1,
        projectId,
        meshId,
        name: entry.id,
        pathBindings: [{
          schemaVersion: 1,
          projectPathId,
          projectId,
          nodeId,
          configuredPath: entry.path,
          allowedCapabilities: allowed,
        }],
      })
      const roleSnapshot = roleTemplateSchema.parse({
        schemaVersion: 1,
        roleId: roleIdSchema.parse(stableId("role-local", entry.id)),
        templateVersion: 1,
        projectId,
        name: "Local approved task",
        purpose: "Complete one explicitly approved task in the selected local project.",
        instructions: "Work only inside the authorized project path and obey the displayed permission envelope.",
        requiredCapabilities: allowed,
        preferredRuntimeKinds: ["opencode"],
        contextSelectionPolicyReference: { namespace: "aibridge.m1", id: "no-shared-context" },
        permissionRestrictions: permissionEnvelope,
        author: { kind: "system", name: "aibridge" },
        createdAt,
      })
      return {
        project,
        projectPathId,
        nodeContext,
        installation,
        roleSnapshot,
        ruleSnapshots: [],
        contextManifest: { references: [], manifestDigest: digestJson({ references: [] }) },
        requestedCapabilities: allowed,
        permissionEnvelope,
        availableModels: [],
        controller: {
          controllerNodeId: nodeId,
          controllerEpoch: 1,
          leaseId: leaseIdSchema.parse(stableId("lease-local", config.agent_id)),
        },
      }
    })
  }

  async listAuthorizedProjects(): Promise<Result<readonly LocalProjectDefinition[]>> {
    return ok(this.#definitions.map((definition) => structuredClone(definition)))
  }

  async getAuthorizedProject(projectId: LocalProjectDefinition["project"]["projectId"]): Promise<Result<LocalProjectDefinition>> {
    const definition = this.#definitions.find((item) => item.project.projectId === projectId)
    return definition
      ? ok(structuredClone(definition))
      : denied("application.project.not_authorized", "The project is not authorized by this local profile.")
  }

  async authorizeLaunchPath(request: LaunchPathAuthorizationRequest) {
    const definition = this.#definitions.find((item) => item.project.projectId === request.projectId)
    const binding = definition?.project.pathBindings.find((item) => item.projectPathId === request.projectPathId)
    if (!definition || !binding || definition.nodeContext.nodeId !== request.nodeId || binding.configuredPath !== request.configuredPath) {
      return denied("application.project.path_binding_changed", "The project path binding is no longer authorized.")
    }
    try {
      const resolvedRequested = await realpath(request.configuredPath)
      const pinned = this.#pinnedRealPaths.get(binding.projectPathId)
      if (pinned === undefined || pinned !== resolvedRequested) {
        return denied("application.project.path_escape", "The resolved project path is outside the authorized binding.")
      }
      return ok({ ...request, realPath: resolvedRequested })
    } catch {
      return denied("application.project.path_unavailable", "The authorized project path cannot be resolved safely.")
    }
  }
}
