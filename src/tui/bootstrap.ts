import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { InMemoryLocalApplicationService } from "../application/service.js"
import { localOpencodeInstallationId, ProfileLocalProjectRegistry } from "../application/local-project-registry.js"
import { bridgeConfigSchema } from "../config/schemas.js"
import { BunProcessRunner } from "../host/runtime.js"
import { readConfig } from "../host/profile-store.js"
import { resolveProfilePaths } from "../host/paths.js"
import { SdkOpencodeClientAdapter } from "../opencode/client.js"
import {
  commandIdSchema,
  correlationIdSchema,
  nodeIdSchema,
  terminalClientIdSchema,
  userIdSchema,
} from "../orchestration/identifiers.js"
import type { Result } from "../orchestration/errors.js"
import { OpencodeRuntimeAdapter } from "../runtime/opencode-adapter.js"
import { TmuxTerminalBackend, type TerminalAuthorizationRequest } from "../terminal/tmux-terminal-backend.js"
import { createTuiShell } from "./shell.js"
import { createTerminalViewController } from "./terminal/controller.js"
import { terminalOperationContextSchema } from "../terminal/schemas.js"

function ok(): Result<void> { return { ok: true, value: undefined } }

/** Compose the real local M1 boundaries for the public `aibr tui` command. */
export async function runLocalTui(profile: string): Promise<0 | 1> {
  const paths = resolveProfilePaths(profile)
  const raw = await readConfig(join(paths.configDir, "config.json"))
  if (raw === null) throw new Error(`Profile "${profile}" not found. Run "aibr setup --profile ${profile}" first.`)
  const config = bridgeConfigSchema.parse(raw)
  const projects = new ProfileLocalProjectRegistry(config)
  const nodeId = nodeIdSchema.parse(config.agent_id)
  const installationId = localOpencodeInstallationId(config.agent_id)
  const client = new SdkOpencodeClientAdapter({
    baseUrl: config.opencode.base_url,
    username: config.opencode.username,
    password: process.env[config.opencode.password_env],
  })
  const runtime = new OpencodeRuntimeAdapter({
    client,
    baseUrl: config.opencode.base_url,
    nodeId,
    installationId,
    projects: {
      resolve: async (scope) => {
        const definition = await projects.getAuthorizedProject(scope.projectId as never)
        if (!definition.ok) return definition
        const binding = definition.value.project.pathBindings.find((item) => item.projectPathId === scope.projectPathId)
        if (!binding || binding.nodeId !== scope.nodeId) {
          return {
            ok: false,
            error: { schemaVersion: 1, category: "policy_denied", code: "runtime.project.binding_denied", message: "The runtime project binding is not authorized.", retryable: false },
          }
        }
        const authorized = await projects.authorizeLaunchPath({
          projectId: binding.projectId,
          projectPathId: binding.projectPathId,
          nodeId: binding.nodeId,
          configuredPath: binding.configuredPath,
        })
        return authorized.ok ? { ok: true, value: authorized.value.realPath } : authorized
      },
    },
  })
  const terminal = new TmuxTerminalBackend({
    processRunner: new BunProcessRunner(),
    recoveryDirectory: join(paths.stateDir, "terminals"),
    sessionCommand: async (request) => {
      const binding = runtime.terminalBinding(request.sessionId)
      if (!binding.ok) return binding
      return {
        ok: true,
        value: [
          process.execPath,
          fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./session-terminal-runner.ts" : "./session-terminal-runner.js", import.meta.url)),
          config.opencode.base_url,
          config.opencode.username,
          config.opencode.password_env,
          binding.value.providerSessionId,
          binding.value.directory,
          String(binding.value.timeoutSeconds),
        ] as const,
      }
    },
    authorizer: {
      authorize: async (request: TerminalAuthorizationRequest): Promise<Result<void>> => {
        const definition = await projects.getAuthorizedProject(request.operation.projectId)
        if (!definition.ok) return definition
        if (definition.value.nodeContext.nodeId !== request.operation.nodeId) {
          return { ok: false, error: { schemaVersion: 1, category: "policy_denied", code: "terminal.node_denied", message: "The terminal is outside this local node.", retryable: false } }
        }
        if (request.reference && (request.reference.projectId !== request.operation.projectId || request.reference.nodeId !== request.operation.nodeId)) {
          return { ok: false, error: { schemaVersion: 1, category: "policy_denied", code: "terminal.binding_denied", message: "The terminal binding is outside the authorized project.", retryable: false } }
        }
        const authority = request.operation.controllerAuthority
        if (authority !== undefined && (
          authority.controllerNodeId !== definition.value.controller.controllerNodeId ||
          authority.controllerEpoch !== definition.value.controller.controllerEpoch ||
          authority.leaseId !== definition.value.controller.leaseId
        )) {
          return { ok: false, error: { schemaVersion: 1, category: "stale_epoch", code: "terminal.authority_stale", message: "The terminal controller authority is stale.", retryable: false } }
        }
        if ((request.action === "create" || request.action === "terminate") && request.operation.controllerAuthority === undefined) {
          return { ok: false, error: { schemaVersion: 1, category: "stale_epoch", code: "terminal.authority_required", message: "Current controller authority is required.", retryable: false } }
        }
        return ok()
      },
    },
  })
  const service = new InMemoryLocalApplicationService({
    runtime,
    terminal,
    projects,
    clock: { now: () => new Date().toISOString() },
    ids: { next: (kind) => `${kind}-${randomUUID()}` },
  })
  const correlationId = correlationIdSchema.parse(`correlation-${randomUUID()}`)
  const terminalClientId = terminalClientIdSchema.parse(`client-${randomUUID()}`)
  const shell = createTuiShell({
    service,
    correlationId,
    operationId: () => commandIdSchema.parse(`operation-${randomUUID()}`),
    userId: userIdSchema.parse("local-user"),
    terminalClientId,
    terminalConnector: {
      open: async (run, view) => {
        const definition = await projects.getAuthorizedProject(run.draft.projectId)
        if (!definition.ok) return definition
        const operation = () => terminalOperationContextSchema.parse({
          schemaVersion: 1,
          commandId: commandIdSchema.parse(`operation-${randomUUID()}`),
          correlationId,
          projectId: run.draft.projectId,
          nodeId: definition.value.nodeContext.nodeId,
          clientId: terminalClientId,
          controllerAuthority: definition.value.controller,
        })
        const recovered = await terminal.recover(operation())
        if (!recovered.ok) return recovered
        const reference = recovered.value.find((item) =>
          item.terminalId === run.session?.terminalId && item.sessionId === run.session.sessionId,
        )
        if (!reference) {
          return { ok: false, error: { schemaVersion: 1, category: "conflict", code: "terminal.binding_unavailable", message: "The exact terminal binding is unavailable.", retryable: false, correlationId } }
        }
        const controller = createTerminalViewController(terminal, { operation, view })
        const attached = await controller.attach(reference, {
          terminal: String(reference.terminalId),
          session: String(reference.sessionId),
          project: definition.value.project.name,
        })
        if (!attached.ok) {
          await controller.close()
          return attached
        }
        return { ok: true, value: controller }
      },
      openRecovery: async (recovery, view) => {
        const definition = await projects.getAuthorizedProject(recovery.projectId)
        if (!definition.ok) return definition
        const operation = () => terminalOperationContextSchema.parse({
          schemaVersion: 1,
          commandId: commandIdSchema.parse(`operation-${randomUUID()}`),
          correlationId,
          projectId: recovery.projectId,
          nodeId: recovery.nodeId,
          clientId: terminalClientId,
          controllerAuthority: definition.value.controller,
        })
        const recovered = await terminal.recover(operation())
        if (!recovered.ok) return recovered
        const reference = recovered.value.find((item) =>
          item.terminalId === recovery.terminalId && item.sessionId === recovery.sessionId,
        )
        if (!reference) {
          return { ok: false, error: { schemaVersion: 1, category: "conflict", code: "terminal.recovery_binding_unavailable", message: "The recovered terminal binding is unavailable.", retryable: false, correlationId } }
        }
        const controller = createTerminalViewController(terminal, { operation, view, mutationAllowed: recovery.mutationAllowed })
        const attached = await controller.attach(reference, {
          terminal: String(reference.terminalId),
          session: "Recovered session; run history unavailable",
          project: recovery.projectName,
        })
        if (!attached.ok) {
          await controller.close()
          return attached
        }
        return { ok: true, value: controller }
      },
    },
  })
  return shell.run(profile)
}
