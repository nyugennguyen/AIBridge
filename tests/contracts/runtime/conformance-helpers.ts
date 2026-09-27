import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { digestDispatchEnvelope } from "../../../src/orchestration/digest.js"
import type { Result } from "../../../src/orchestration/errors.js"
import {
  launchAgentRequestSchema,
  nodeContextSchema,
  promptRequestSchema,
  runtimeOperationContextSchema,
  runtimeSessionReferenceSchema,
  type LaunchAgentRequest,
  type NodeContext,
  type PromptRequest,
  type RuntimeOperationContext,
  type RuntimeSession,
  type RuntimeSessionReference,
} from "../../../src/runtime/schemas.js"

const examplesDirectory = fileURLToPath(new URL("../examples/", import.meta.url))

export async function readExample(name: string): Promise<unknown> {
  return JSON.parse(await readFile(`${examplesDirectory}${name}.v1.json`, "utf8"))
}

export interface TestLaunchOptions {
  commandId?: string
  projectId?: string
  nodeId?: string
  installationId?: string
  runtimeKind?: string
  dispatchId?: string
  runId?: string
  taskId?: string
  prompt?: string
  model?: string
}

export async function createTestLaunchRequest(options: TestLaunchOptions = {}): Promise<LaunchAgentRequest> {
  const dispatch = (await readExample("dispatch")) as { envelope: Record<string, unknown>; envelopeDigest: string }
  const approval = (await readExample("approval")) as { approvalId: string }

  const projectId = options.projectId ?? "project-contract"
  const nodeId = options.nodeId ?? "node-contract"
  const installationId = options.installationId ?? "installation-contract"
  const runtimeKind = options.runtimeKind ?? "contract-fake"
  const dispatchId = options.dispatchId ?? "dispatch-contract"
  const runId = options.runId ?? "run-contract"
  const taskId = options.taskId ?? "task-contract"
  const commandId = options.commandId ?? "command-contract"

  const envelope = {
    ...dispatch.envelope,
    projectId,
    targetNodeId: nodeId,
    installationId,
    runtimeKind,
    dispatchId,
    runId,
    taskId,
    roleSnapshot: {
      ...(dispatch.envelope.roleSnapshot as Record<string, unknown>),
      projectId,
    },
    ruleSnapshots: ((dispatch.envelope.ruleSnapshots as Array<Record<string, unknown>>) ?? []).map((rule) => ({
      ...rule,
      projectId,
    })),
    prompt: options.prompt ?? (dispatch.envelope.prompt as string),
    ...(options.model !== undefined ? { model: options.model } : {}),
  }
  if (options.model === undefined) {
    delete (envelope as Record<string, unknown>).model
  }

  const envelopeDigest = digestDispatchEnvelope(envelope)

  return launchAgentRequestSchema.parse({
    schemaVersion: 1,
    operation: {
      schemaVersion: 1,
      commandId,
      correlationId: "correlation-contract",
      projectId,
      runId,
      dispatchId,
      nodeId,
      controllerNodeId: nodeId,
      controllerEpoch: 1,
      leaseId: "lease-contract",
    },
    dispatchEnvelope: envelope,
    dispatchEnvelopeDigest: envelopeDigest,
    approvalId: approval.approvalId,
  })
}

export function createTestNodeContext(options: { nodeId?: string } = {}): NodeContext {
  return nodeContextSchema.parse({
    schemaVersion: 1,
    nodeId: options.nodeId ?? "node-contract",
    meshId: "mesh-contract",
    platform: "darwin",
    architecture: "arm64",
  })
}

export function createTestOperationContext(
  commandId = "command-op",
  options: { projectId?: string; nodeId?: string; dispatchId?: string; runId?: string } = {},
): RuntimeOperationContext {
  return runtimeOperationContextSchema.parse({
    schemaVersion: 1,
    commandId,
    correlationId: "correlation-contract",
    projectId: options.projectId ?? "project-contract",
    runId: options.runId ?? "run-contract",
    dispatchId: options.dispatchId ?? "dispatch-contract",
    nodeId: options.nodeId ?? "node-contract",
    controllerNodeId: options.nodeId ?? "node-contract",
    controllerEpoch: 1,
    leaseId: "lease-contract",
  })
}

export function createTestPromptRequest(
  session: RuntimeSession,
  prompt: string,
  commandId = "command-prompt",
): PromptRequest {
  return promptRequestSchema.parse({
    schemaVersion: 1,
    operation: createTestOperationContext(commandId, {
      projectId: session.projectId,
      nodeId: session.nodeId,
      dispatchId: session.dispatchId,
      runId: session.runId,
    }),
    prompt,
  })
}

export function createTestSessionReference(
  session: RuntimeSession,
  handle?: string,
): RuntimeSessionReference {
  return runtimeSessionReferenceSchema.parse({
    ...session,
    adapterMetadata: {
      handle: handle ?? session.sessionId,
    },
  })
}

export function requireFailure<T>(result: Result<T>) {
  if (result.ok) throw new Error("Expected a typed contract failure")
  return result.error
}
