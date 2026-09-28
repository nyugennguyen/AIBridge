import { orchestrationCommandSchema } from "../../../src/orchestration/schemas.js"
import type { OrchestrationCommand } from "../../../src/orchestration/types.js"
import type { Timestamp } from "../../../src/orchestration/identifiers.js"

export const PROJECT_ID = "project-alpha"
export const RUN_ID = "run-101"
export const DIGEST_A = "sha256:1111111111111111111111111111111111111111111111111111111111111111" as const
export const DIGEST_B = "sha256:2222222222222222222222222222222222222222222222222222222222222222" as const

export interface MakeCommandOptions {
  commandId: string
  projectId?: string
  runId?: string
  epoch?: number
  reason?: string
  issuedAt?: string
  expiresAt?: string
  correlationId?: string
  actor?: { kind: "user", userId: string } | { kind: "system", name: string }
  leaseId?: string
  controllerNodeId?: string
}

export function makeCommand(options: MakeCommandOptions): OrchestrationCommand {
  return orchestrationCommandSchema.parse({
    schemaVersion: 1,
    commandId: options.commandId,
    projectId: options.projectId ?? PROJECT_ID,
    runId: options.runId ?? RUN_ID,
    actor: options.actor ?? { kind: "user", userId: "user-test" },
    controllerNodeId: options.controllerNodeId ?? "node-test",
    controllerEpoch: options.epoch ?? 1,
    leaseId: options.leaseId ?? "lease-test",
    issuedAt: options.issuedAt ?? "2026-09-17T00:00:00.000Z",
    expiresAt: options.expiresAt ?? "2026-09-17T00:10:00.000Z",
    correlationId: options.correlationId ?? "corr-test",
    causation: null,
    type: "run.cancel",
    payload: {
      reason: options.reason ?? "Test cancel reason",
    },
  })
}

export function makeDispatchProposedEvent(options: {
  eventId: string
  commandId?: string
  runId?: string
  projectId?: string
  dispatchId?: string
  attempt?: number
  envelopeDigest?: string
  prompt?: string
  occurredAt?: string
}): any {
  const runId = options.runId ?? RUN_ID
  const projectId = options.projectId ?? PROJECT_ID
  const dispatchId = options.dispatchId ?? "disp-1"
  // Deliberately not parsed here: the store assigns `sequence` during append.
  return {
    schemaVersion: 1,
    eventId: options.eventId,
    projectId,
    runId,
    actor: { kind: "system", name: "kernel" },
    occurredAt: options.occurredAt ?? "2026-09-17T00:00:01.000Z",
    correlationId: "corr-test",
    causation: null,
    controllerEpoch: 1,
    commandId: options.commandId ?? "cmd-1",
    type: "dispatch.proposed",
    payload: {
      dispatch: {
        schemaVersion: 1,
        envelope: makeEnvelope({ projectId, runId, dispatchId, attempt: options.attempt, prompt: options.prompt }),
        envelopeDigest: options.envelopeDigest ?? DIGEST_A,
        state: "proposed",
        createdAt: options.occurredAt ?? "2026-09-17T00:00:01.000Z",
        externalReferences: [],
      },
    },
  }
}

export function makeEnvelope(options: {
  projectId?: string
  runId?: string
  dispatchId: string
  taskId?: string
  attempt?: number
  prompt?: string
}): any {
  const projectId = options.projectId ?? PROJECT_ID
  const runId = options.runId ?? RUN_ID
  return {
    schemaVersion: 1,
    dispatchId: options.dispatchId,
    attempt: options.attempt ?? 1,
    projectId,
    runId,
    taskId: options.taskId ?? "task-test",
    targetNodeId: "node-test",
    installationId: "install-test",
    runtimeKind: "contract-fake",
    projectPathId: "path-test",
    prompt: options.prompt ?? "Execute task prompt",
    roleSnapshot: {
      schemaVersion: 1,
      roleId: "role-test",
      templateVersion: 1,
      projectId,
      name: "Tester",
      purpose: "Testing",
      instructions: "Run tests",
      requiredCapabilities: ["read"],
      preferredRuntimeKinds: ["contract-fake"],
      contextSelectionPolicyReference: { namespace: "test", id: "ref-1" },
      permissionRestrictions: {
        allowedCapabilities: ["read"],
        deniedCapabilities: ["write"],
        approvalRequirements: {
          destructiveEffects: true,
          externalEffects: true,
          capabilities: ["read"],
        },
      },
      author: { kind: "user", userId: "user-tester" },
      createdAt: "2026-09-17T00:00:00.000Z",
    },
    ruleSnapshots: [],
    contextManifest: {
      references: [],
      manifestDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
    requestedCapabilities: ["read"],
    permissionEnvelope: {
      allowedCapabilities: ["read"],
      deniedCapabilities: ["write"],
      approvalRequirements: {
        destructiveEffects: true,
        externalEffects: true,
        capabilities: ["read"],
      },
    },
    dependencies: [],
    timeoutSeconds: 300,
    controllerEpoch: 1,
  }
}

export const T0 = "2026-09-17T00:00:00.000Z" as Timestamp
export const T_PLUS_1S = "2026-09-17T00:00:01.000Z" as Timestamp
export const T_PLUS_30S = "2026-09-17T00:00:30.000Z" as Timestamp
export const T_PLUS_60S = "2026-09-17T00:01:00.000Z" as Timestamp
export const T_PLUS_5M = "2026-09-17T00:05:00.000Z" as Timestamp
