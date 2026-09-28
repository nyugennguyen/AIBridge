import { z } from "zod"
import {
  APPROVAL_STATES,
  DISPATCH_STATES,
  RUN_STATES,
  SESSION_OBSERVED_STATES,
  SESSION_STATES,
  TASK_STATES,
  isRunTerminal,
  isSessionTerminal,
} from "./transitions.js"
import {
  approvalIdSchema,
  artifactIdSchema,
  capabilitySchema,
  commandIdSchema,
  correlationIdSchema,
  digestSchema,
  dispatchIdSchema,
  epochSchema,
  eventIdSchema,
  installationIdSchema,
  leaseIdSchema,
  memoryIdSchema,
  meshIdSchema,
  nodeIdSchema,
  projectIdSchema,
  projectPathIdSchema,
  roleIdSchema,
  ruleIdSchema,
  runIdSchema,
  schemaVersionSchema,
  sessionIdSchema,
  taskIdSchema,
  terminalIdSchema,
  timestampSchema,
  userIdSchema,
} from "./identifiers.js"

const SHORT_TEXT_MAX = 256
const TEXT_MAX = 4_096
const LARGE_TEXT_MAX = 65_536
const ARRAY_MAX = 128
const TIMEOUT_MAX_SECONDS = 86_400

const shortTextSchema = z.string().min(1).max(SHORT_TEXT_MAX).refine((value) => value === value.trim(), "Must not have surrounding whitespace")
const textSchema = z.string().min(1).max(TEXT_MAX)
const largeTextSchema = z.string().min(1).max(LARGE_TEXT_MAX)
const positiveSafeIntegerSchema = z.number().int().positive().safe()
const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().safe()
const runtimeKindSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
const capabilityListSchema = z.array(capabilitySchema).max(ARRAY_MAX).refine(isUnique, "Capabilities must be unique")

function isUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

function addMismatch(ctx: z.RefinementCtx, path: PropertyKey[], message: string): void {
  ctx.addIssue({ code: "custom", path, message })
}

function timestampAfter(later: string, earlier: string): boolean {
  return Date.parse(later) > Date.parse(earlier)
}

export const externalReferenceSchema = z
  .object({
    namespace: shortTextSchema,
    id: z.string().min(1).max(TEXT_MAX),
  })
  .strict()

export const actorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: userIdSchema }).strict(),
  z.object({ kind: z.literal("node"), nodeId: nodeIdSchema }).strict(),
  z.object({ kind: z.literal("session"), sessionId: sessionIdSchema }).strict(),
  z.object({ kind: z.literal("system"), name: shortTextSchema }).strict(),
])

export const meshSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    meshId: meshIdSchema,
    displayName: shortTextSchema,
    createdAt: timestampSchema,
  })
  .strict()

const enrollmentSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("enrolled"), enrolledAt: timestampSchema }).strict(),
  z
    .object({
      status: z.literal("revoked"),
      enrolledAt: timestampSchema,
      revokedAt: timestampSchema,
    })
    .strict()
    .refine((value) => timestampAfter(value.revokedAt, value.enrolledAt), {
      path: ["revokedAt"],
      message: "Revocation must be later than enrollment",
    }),
])

export const nodeSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    nodeId: nodeIdSchema,
    meshId: meshIdSchema,
    displayName: shortTextSchema,
    enrollment: enrollmentSchema,
    externalReferences: z.array(externalReferenceSchema).max(ARRAY_MAX),
  })
  .strict()

const absolutePathSchema = z
  .string()
  .min(1)
  .max(TEXT_MAX)
  .refine((value) => (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value)) && !value.includes("\0"), "Must be an absolute configured path")

export const projectPathSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    projectPathId: projectPathIdSchema,
    projectId: projectIdSchema,
    nodeId: nodeIdSchema,
    configuredPath: absolutePathSchema,
    allowedCapabilities: capabilityListSchema,
  })
  .strict()

export const projectSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    projectId: projectIdSchema,
    meshId: meshIdSchema,
    name: shortTextSchema,
    pathBindings: z.array(projectPathSchema).max(ARRAY_MAX),
  })
  .strict()
  .superRefine((project, ctx) => {
    const pathIds = project.pathBindings.map((binding) => binding.projectPathId)
    if (!isUnique(pathIds)) addMismatch(ctx, ["pathBindings"], "Project path IDs must be unique")
    project.pathBindings.forEach((binding, index) => {
      if (binding.projectId !== project.projectId) {
        addMismatch(ctx, ["pathBindings", index, "projectId"], "Path binding project ID must match project")
      }
    })
  })

export const runStateSchema = z.enum(RUN_STATES)

export const runSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    runId: runIdSchema,
    projectId: projectIdSchema,
    goal: largeTextSchema,
    state: runStateSchema,
    paused: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    externalReferences: z.array(externalReferenceSchema).max(ARRAY_MAX),
  })
  .strict()
  .superRefine((run, ctx) => {
    // `paused` is a run-level GATE on non-terminal work, not a lifecycle state.
    // Before the split, `state: "paused"` was itself mutually exclusive with the
    // terminal states, so this combination was unrepresentable. Splitting the
    // axis into a boolean silently gave that up, so it is restored explicitly
    // here: pausing finished work is a contradiction, and a terminal run is
    // absorbing, so it can never be re-opened by a pause.
    if (run.paused && isRunTerminal(run.state)) {
      addMismatch(
        ctx,
        ["paused"],
        `A run in terminal state '${run.state}' cannot be paused; pausing gates work that has not finished`,
      )
    }
  })
  .refine((run) => Date.parse(run.updatedAt) >= Date.parse(run.createdAt), {
    path: ["updatedAt"],
    message: "Updated time cannot precede creation time",
  })

export const taskDependencySchema = z
  .object({
    taskId: taskIdSchema,
    failurePolicy: z.enum(["block", "fail"]),
  })
  .strict()

export const taskStateSchema = z.enum(TASK_STATES)

export const taskFailurePolicySchema = z.enum(["block", "fail"])

export const taskSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    taskId: taskIdSchema,
    runId: runIdSchema,
    projectId: projectIdSchema,
    title: shortTextSchema,
    description: largeTextSchema,
    state: taskStateSchema,
    failurePolicy: taskFailurePolicySchema,
    dependencies: z.array(taskDependencySchema).max(ARRAY_MAX),
    externalReferences: z.array(externalReferenceSchema).max(ARRAY_MAX),
  })
  .strict()
  .superRefine((task, ctx) => {
    const dependencyIds = task.dependencies.map((dependency) => dependency.taskId)
    if (!isUnique(dependencyIds)) addMismatch(ctx, ["dependencies"], "Task dependencies must be unique")
    task.dependencies.forEach((dependency, index) => {
      if (dependency.taskId === task.taskId) {
        addMismatch(ctx, ["dependencies", index, "taskId"], "A task cannot depend on itself")
      }
    })
  })

export const permissionEnvelopeSchema = z
  .object({
    allowedCapabilities: capabilityListSchema,
    deniedCapabilities: capabilityListSchema,
    approvalRequirements: z
      .object({
        destructiveEffects: z.boolean(),
        externalEffects: z.boolean(),
        capabilities: capabilityListSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((permission, ctx) => {
    const denied = new Set(permission.deniedCapabilities)
    permission.allowedCapabilities.forEach((capability, index) => {
      if (denied.has(capability)) {
        addMismatch(ctx, ["allowedCapabilities", index], "A capability cannot be both allowed and denied")
      }
    })
    const allowed = new Set(permission.allowedCapabilities)
    permission.approvalRequirements.capabilities.forEach((capability, index) => {
      if (!allowed.has(capability)) {
        addMismatch(ctx, ["approvalRequirements", "capabilities", index], "Approval requirements must name an allowed capability")
      }
    })
  })

export const roleTemplateSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    roleId: roleIdSchema,
    templateVersion: positiveSafeIntegerSchema,
    projectId: projectIdSchema,
    name: shortTextSchema,
    purpose: textSchema,
    instructions: largeTextSchema,
    requiredCapabilities: capabilityListSchema,
    preferredRuntimeKinds: z.array(runtimeKindSchema).max(ARRAY_MAX).refine(isUnique, "Runtime kinds must be unique"),
    contextSelectionPolicyReference: externalReferenceSchema,
    permissionRestrictions: permissionEnvelopeSchema,
    author: actorSchema,
    createdAt: timestampSchema,
  })
  .strict()

const ruleMatchSchema = z
  .object({
    taskTitlePattern: z.string().min(1).max(SHORT_TEXT_MAX).optional(),
    requestedCapabilitiesAny: capabilityListSchema.optional(),
    runtimeKinds: z.array(runtimeKindSchema).max(ARRAY_MAX).refine(isUnique, "Runtime kinds must be unique").optional(),
  })
  .strict()

const restrictiveRuleEffectSchema = z
  .object({
    kind: z.literal("restrict"),
    deniedCapabilities: capabilityListSchema,
    requireApprovalForDestructiveEffects: z.boolean(),
    requireApprovalForExternalEffects: z.boolean(),
  })
  .strict()

const preApprovalRuleEffectSchema = z
  .object({
    kind: z.literal("pre_approve"),
    approvedCapabilities: capabilityListSchema.min(1),
    maximumTimeoutSeconds: z.number().int().positive().max(TIMEOUT_MAX_SECONDS).safe(),
    allowDestructiveEffects: z.boolean(),
    allowExternalEffects: z.boolean(),
  })
  .strict()

export const ruleSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    ruleId: ruleIdSchema,
    templateVersion: positiveSafeIntegerSchema,
    projectId: projectIdSchema,
    enabled: z.boolean(),
    match: ruleMatchSchema,
    effect: z.discriminatedUnion("kind", [restrictiveRuleEffectSchema, preApprovalRuleEffectSchema]),
    author: actorSchema,
    createdAt: timestampSchema,
  })
  .strict()

const contextReferenceSchema = z.discriminatedUnion("sourceKind", [
  z
    .object({
      sourceKind: z.literal("memory"),
      sourceId: memoryIdSchema,
      contentDigest: digestSchema,
      sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
      byteCount: nonnegativeSafeIntegerSchema,
    })
    .strict(),
  z
    .object({
      sourceKind: z.literal("artifact"),
      sourceId: artifactIdSchema,
      contentDigest: digestSchema,
      sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
      byteCount: nonnegativeSafeIntegerSchema,
    })
    .strict(),
  z
    .object({
      sourceKind: z.literal("task"),
      sourceId: taskIdSchema,
      contentDigest: digestSchema,
      sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
      byteCount: nonnegativeSafeIntegerSchema,
    })
    .strict(),
  z
    .object({
      sourceKind: z.literal("dispatch"),
      sourceId: dispatchIdSchema,
      contentDigest: digestSchema,
      sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
      byteCount: nonnegativeSafeIntegerSchema,
    })
    .strict(),
  z
    .object({
      sourceKind: z.literal("external"),
      sourceId: z.string().min(1).max(TEXT_MAX),
      contentDigest: digestSchema,
      sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
      byteCount: nonnegativeSafeIntegerSchema,
    })
    .strict(),
])

export const contextManifestSchema = z
  .object({
    references: z.array(contextReferenceSchema).max(ARRAY_MAX),
    manifestDigest: digestSchema,
  })
  .strict()

export const dispatchEnvelopeSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    dispatchId: dispatchIdSchema,
    attempt: positiveSafeIntegerSchema,
    projectId: projectIdSchema,
    runId: runIdSchema,
    taskId: taskIdSchema,
    targetNodeId: nodeIdSchema,
    installationId: installationIdSchema,
    runtimeKind: runtimeKindSchema,
    projectPathId: projectPathIdSchema,
    prompt: largeTextSchema,
    roleSnapshot: roleTemplateSchema,
    ruleSnapshots: z.array(ruleSchema).max(ARRAY_MAX),
    contextManifest: contextManifestSchema,
    requestedCapabilities: capabilityListSchema,
    permissionEnvelope: permissionEnvelopeSchema,
    dependencies: z.array(taskDependencySchema).max(ARRAY_MAX),
    timeoutSeconds: z.number().int().positive().max(TIMEOUT_MAX_SECONDS).safe(),
    controllerEpoch: epochSchema,
    model: z.string().min(1).max(SHORT_TEXT_MAX).refine((value) => value === value.trim(), "Must not have surrounding whitespace").optional(),
  })
  .strict()
  .superRefine((envelope, ctx) => {
    if (envelope.roleSnapshot.projectId !== envelope.projectId) {
      addMismatch(ctx, ["roleSnapshot", "projectId"], "Role project ID must match dispatch project")
    }
    envelope.ruleSnapshots.forEach((rule, index) => {
      if (rule.projectId !== envelope.projectId) {
        addMismatch(ctx, ["ruleSnapshots", index, "projectId"], "Rule project ID must match dispatch project")
      }
    })
    const ruleVersions = envelope.ruleSnapshots.map((rule) => `${rule.ruleId}:${rule.templateVersion}`)
    if (!isUnique(ruleVersions)) addMismatch(ctx, ["ruleSnapshots"], "Rule snapshots must be unique by ID and version")
    const dependencyIds = envelope.dependencies.map((dependency) => dependency.taskId)
    if (!isUnique(dependencyIds)) addMismatch(ctx, ["dependencies"], "Dispatch dependencies must be unique")
    envelope.dependencies.forEach((dependency, index) => {
      if (dependency.taskId === envelope.taskId) {
        addMismatch(ctx, ["dependencies", index, "taskId"], "A dispatch task cannot depend on itself")
      }
    })
    const declared = new Set([
      ...envelope.permissionEnvelope.allowedCapabilities,
      ...envelope.permissionEnvelope.deniedCapabilities,
    ])
    envelope.requestedCapabilities.forEach((capability, index) => {
      if (!declared.has(capability)) {
        addMismatch(ctx, ["requestedCapabilities", index], "Every requested capability must have an explicit permission decision")
      }
    })
  })

export const dispatchStateSchema = z.enum(DISPATCH_STATES)

export const dispatchSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    envelope: dispatchEnvelopeSchema,
    envelopeDigest: digestSchema,
    state: dispatchStateSchema,
    createdAt: timestampSchema,
    externalReferences: z.array(externalReferenceSchema).max(ARRAY_MAX),
  })
  .strict()

const approvalBasisSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }).strict(),
  z
    .object({
      kind: z.literal("rule"),
      ruleId: ruleIdSchema,
      ruleVersion: positiveSafeIntegerSchema,
    })
    .strict(),
])

export const approvalStateSchema = z.enum(APPROVAL_STATES)

export const approvalSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    approvalId: approvalIdSchema,
    projectId: projectIdSchema,
    runId: runIdSchema,
    dispatchId: dispatchIdSchema,
    envelopeDigest: digestSchema,
    decision: z.enum(["approved", "rejected"]),
    /**
     * Durable approval lifecycle, owned by `./transitions.js`.
     *
     * `decision` records what the actor chose; `state` records whether that
     * choice is still binding. They are different questions: an `approved`
     * decision whose envelope digest no longer matches the current dispatch is
     * still an approval that was granted, but its state is `invalidated`. The
     * Milestone 3 criterion "approval becomes invalid after any envelope
     * mutation" is unreachable without this field.
     *
     * The pair is constrained so the record can never claim, for example, a
     * `rejected` decision in state `approved`.
     *
     * `pending` is additionally unreachable alongside a decision. `decision` and
     * `decidedAt` are both required, so a record carrying either decision HAS
     * been decided; the only way to build `decision:"approved", state:"pending"`
     * is to fabricate a decision that was never taken. ADR 0001 states that "an
     * undecided dispatch has no decision record", so a pending approval is
     * represented by the ABSENCE of one, not by a half-populated record.
     */
    state: approvalStateSchema,
    basis: approvalBasisSchema,
    actor: actorSchema,
    decidedAt: timestampSchema,
  })
  .strict()
  .superRefine((approval, ctx) => {
    if (approval.decision === "rejected" && approval.state !== "rejected") {
      addMismatch(
        ctx,
        ["state"],
        `A rejected approval is terminally 'rejected' and cannot be in state '${approval.state}'`,
      )
    }
    if (approval.decision === "approved" && approval.state === "rejected") {
      addMismatch(ctx, ["state"], "An approved decision cannot be in the terminal 'rejected' state")
    }
    // `decision` and `decidedAt` are both required, so any Approval record HAS
    // been decided. `pending` therefore contradicts the record's own existence,
    // and allowing it would let a caller fabricate an undecided approval that
    // later reads as a live one. An undecided dispatch has no record at all.
    if (approval.state === "pending") {
      addMismatch(
        ctx,
        ["state"],
        "An approval record carries a decision and a decision time, so it cannot be 'pending'; an undecided dispatch has no approval record",
      )
    }
  })

export const sessionStateSchema = z.enum(SESSION_OBSERVED_STATES)

export const sessionLifecycleStateSchema = z.enum(SESSION_STATES)

/**
 * Provider observations compatible with a TERMINAL session lifecycle.
 *
 * `unknown` is included because it is the absence of a claim rather than a
 * competing one, which is exactly what an ambiguous disconnect reports. A
 * `completed` or `failed` lifecycle agrees with its matching observation.
 */
const SESSION_TERMINAL_OBSERVATIONS: ReadonlySet<string> = new Set(["completed", "failed", "unknown"])

export const sessionSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    sessionId: sessionIdSchema,
    projectId: projectIdSchema,
    runId: runIdSchema,
    taskId: taskIdSchema,
    dispatchId: dispatchIdSchema,
    nodeId: nodeIdSchema,
    installationId: installationIdSchema,
    runtimeKind: runtimeKindSchema,
    lifecycleState: sessionLifecycleStateSchema,
    observedState: sessionStateSchema,
    terminalId: terminalIdSchema.optional(),
  })
  .strict()
  .superRefine((session, ctx) => {
    // The two axes are separate, but they are not unconstrained. A finished
    // session cannot simultaneously be reporting that it is working: that pair
    // would let an audit view claim a live session and a terminal dispatch at
    // once. `unknown` is the one observation compatible with a terminal
    // lifecycle, because it is the absence of a claim rather than a competing
    // one. The `approvalSchema` constraint added in the same change established
    // this pattern; omitting it here left the session unconstrained.
    if (isSessionTerminal(session.lifecycleState) && !SESSION_TERMINAL_OBSERVATIONS.has(session.observedState)) {
      addMismatch(
        ctx,
        ["observedState"],
        `A session with terminal lifecycle '${session.lifecycleState}' cannot be observed as '${session.observedState}'; a finished session is only compatible with a completed, failed or unknown observation`,
      )
    }
  })

const memoryScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project") }).strict(),
  z.object({ kind: z.literal("run"), runId: runIdSchema }).strict(),
  z.object({ kind: z.literal("task"), runId: runIdSchema, taskId: taskIdSchema }).strict(),
  z
    .object({ kind: z.literal("session"), runId: runIdSchema, taskId: taskIdSchema, sessionId: sessionIdSchema })
    .strict(),
])

export const memoryRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    memoryId: memoryIdSchema,
    projectId: projectIdSchema,
    kind: z.enum(["decision", "constraint", "finding", "handoff", "summary", "artifact_reference", "user_correction", "run_outcome"]),
    content: largeTextSchema,
    contentDigest: digestSchema,
    scope: memoryScopeSchema,
    author: actorSchema,
    createdAt: timestampSchema,
    sourceReferences: z.array(externalReferenceSchema).max(ARRAY_MAX),
    trustState: z.enum(["proposed", "accepted", "rejected"]),
    sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
    retention: z.enum(["run", "project", "permanent"]),
    supersedesMemoryId: memoryIdSchema.optional(),
  })
  .strict()
  .refine((memory) => memory.supersedesMemoryId !== memory.memoryId, {
    path: ["supersedesMemoryId"],
    message: "A memory record cannot supersede itself",
  })

const artifactSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), sessionId: sessionIdSchema }).strict(),
  z.object({ kind: z.literal("external"), reference: externalReferenceSchema }).strict(),
])

const artifactLocationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("locator"), locator: z.string().min(1).max(TEXT_MAX) }).strict(),
  z.object({ kind: z.literal("external_reference"), reference: externalReferenceSchema }).strict(),
])

export const artifactSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    artifactId: artifactIdSchema,
    projectId: projectIdSchema,
    runId: runIdSchema,
    dispatchId: dispatchIdSchema,
    sessionId: sessionIdSchema.optional(),
    name: shortTextSchema,
    mediaType: z.string().regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/).max(SHORT_TEXT_MAX),
    digest: digestSchema,
    byteCount: nonnegativeSafeIntegerSchema,
    source: artifactSourceSchema,
    location: artifactLocationSchema,
  })
  .strict()
  .superRefine((artifact, ctx) => {
    if (artifact.source.kind === "session" && artifact.sessionId !== artifact.source.sessionId) {
      addMismatch(ctx, ["source", "sessionId"], "Artifact source session ID must match artifact session ID")
    }
  })

export const controllerLeaseSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    leaseId: leaseIdSchema,
    projectId: projectIdSchema,
    runId: runIdSchema,
    controllerNodeId: nodeIdSchema,
    epoch: epochSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict()
  .refine((lease) => timestampAfter(lease.expiresAt, lease.issuedAt), {
    path: ["expiresAt"],
    message: "Lease expiry must be later than issue time",
  })

const causationSchema = z.union([
  z.null(),
  z.object({ kind: z.literal("command"), commandId: commandIdSchema }).strict(),
  z.object({ kind: z.literal("event"), eventId: eventIdSchema }).strict(),
])

const eventCommonShape = {
  schemaVersion: schemaVersionSchema,
  eventId: eventIdSchema,
  sequence: positiveSafeIntegerSchema,
  projectId: projectIdSchema,
  runId: runIdSchema,
  actor: actorSchema,
  occurredAt: timestampSchema,
  correlationId: correlationIdSchema,
  causation: causationSchema,
  controllerEpoch: epochSchema,
  commandId: commandIdSchema.optional(),
}

export const orchestrationEventSchema = z
  .discriminatedUnion("type", [
    z.object({ ...eventCommonShape, type: z.literal("run.created"), payload: z.object({ run: runSchema }).strict() }).strict(),
    z.object({ ...eventCommonShape, type: z.literal("task.created"), payload: z.object({ task: taskSchema }).strict() }).strict(),
    z.object({ ...eventCommonShape, type: z.literal("dispatch.proposed"), payload: z.object({ dispatch: dispatchSchema }).strict() }).strict(),
    z.object({ ...eventCommonShape, type: z.literal("approval.decided"), payload: z.object({ approval: approvalSchema }).strict() }).strict(),
    z
      .object({
        ...eventCommonShape,
        type: z.literal("approval.invalidated"),
        payload: z
          .object({
            approvalId: approvalIdSchema,
            projectId: projectIdSchema,
            runId: runIdSchema,
            dispatchId: dispatchIdSchema,
            envelopeDigest: digestSchema,
            reason: z.string().min(1).max(4_096),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...eventCommonShape,
        type: z.literal("run.cancelled"),
        payload: z.object({ runId: runIdSchema, reason: textSchema }).strict(),
      })
      .strict(),
    z
      .object({
        ...eventCommonShape,
        type: z.literal("run.paused"),
        payload: z.object({ runId: runIdSchema, reason: textSchema }).strict(),
      })
      .strict(),
    z
      .object({
        ...eventCommonShape,
        type: z.literal("run.resumed"),
        payload: z.object({ runId: runIdSchema, reason: textSchema }).strict(),
      })
      .strict(),
    z
      .object({
        ...eventCommonShape,
        type: z.literal("dispatch.cancel.requested"),
        payload: z
          .object({ runId: runIdSchema, dispatchId: dispatchIdSchema, reason: textSchema, sessionId: sessionIdSchema.optional() })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...eventCommonShape,
        type: z.literal("dispatch.timeout.requested"),
        payload: z
          .object({ runId: runIdSchema, dispatchId: dispatchIdSchema, reason: textSchema, sessionId: sessionIdSchema.optional() })
          .strict(),
      })
      .strict(),
    z.object({ ...eventCommonShape, type: z.literal("dispatch.started"), payload: z.object({ session: sessionSchema }).strict() }).strict(),
    z
      .object({
        ...eventCommonShape,
        type: z.literal("dispatch.finished"),
        payload: z
          .object({
            dispatchId: dispatchIdSchema,
            sessionId: sessionIdSchema.optional(),
            outcome: z.enum(["completed", "failed", "timed_out", "cancelled"]),
            summary: textSchema.optional(),
          })
          .strict(),
      })
      .strict(),
    z.object({ ...eventCommonShape, type: z.literal("session.observed"), payload: z.object({ session: sessionSchema }).strict() }).strict(),
    z.object({ ...eventCommonShape, type: z.literal("memory.proposed"), payload: z.object({ memory: memoryRecordSchema }).strict() }).strict(),
    z.object({ ...eventCommonShape, type: z.literal("memory.accepted"), payload: z.object({ memory: memoryRecordSchema }).strict() }).strict(),
    z.object({ ...eventCommonShape, type: z.literal("artifact.registered"), payload: z.object({ artifact: artifactSchema }).strict() }).strict(),
    z.object({ ...eventCommonShape, type: z.literal("controller.lease.changed"), payload: z.object({ lease: controllerLeaseSchema }).strict() }).strict(),
    z
      .object({
        ...eventCommonShape,
        type: z.literal("legacy.imported"),
        payload: z
          .object({
            recordKind: z.enum(["job", "task", "memory", "configuration"]),
            reference: externalReferenceSchema,
            disposition: z.enum(["historical", "paused", "rejected"]),
          })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((event, ctx) => {
    if (event.commandId !== undefined && event.causation?.kind === "command" && event.commandId !== event.causation.commandId) {
      addMismatch(ctx, ["commandId"], "Event command ID must match command causation")
    }
    const compareScope = (projectId: string, runId: string): void => {
      if (projectId !== event.projectId) addMismatch(ctx, ["payload", "projectId"], "Payload project ID must match event")
      if (runId !== event.runId) addMismatch(ctx, ["payload", "runId"], "Payload run ID must match event")
    }

    switch (event.type) {
      case "run.created":
        compareScope(event.payload.run.projectId, event.payload.run.runId)
        break
      case "task.created":
        compareScope(event.payload.task.projectId, event.payload.task.runId)
        break
      case "dispatch.proposed":
        compareScope(event.payload.dispatch.envelope.projectId, event.payload.dispatch.envelope.runId)
        break
      case "approval.decided":
        compareScope(event.payload.approval.projectId, event.payload.approval.runId)
        break
      case "approval.invalidated":
        compareScope(event.payload.projectId, event.payload.runId)
        break
      case "run.cancelled":
      case "dispatch.cancel.requested":
      case "dispatch.timeout.requested":
        if (event.payload.runId !== event.runId) {
          addMismatch(ctx, ["payload", "runId"], "Payload run ID must match event")
        }
        break
      case "dispatch.started":
      case "session.observed":
        compareScope(event.payload.session.projectId, event.payload.session.runId)
        break
      case "memory.proposed":
      case "memory.accepted":
        if (event.payload.memory.projectId !== event.projectId) {
          addMismatch(ctx, ["payload", "memory", "projectId"], "Memory project ID must match event")
        }
        if (event.payload.memory.scope.kind !== "project" && event.payload.memory.scope.runId !== event.runId) {
          addMismatch(ctx, ["payload", "memory", "scope", "runId"], "Memory run ID must match event")
        }
        if (event.type === "memory.proposed" && event.payload.memory.trustState !== "proposed") {
          addMismatch(ctx, ["payload", "memory", "trustState"], "Proposed memory event requires proposed trust state")
        }
        if (event.type === "memory.accepted" && event.payload.memory.trustState !== "accepted") {
          addMismatch(ctx, ["payload", "memory", "trustState"], "Accepted memory event requires accepted trust state")
        }
        break
      case "artifact.registered":
        compareScope(event.payload.artifact.projectId, event.payload.artifact.runId)
        break
      case "controller.lease.changed":
        compareScope(event.payload.lease.projectId, event.payload.lease.runId)
        if (event.payload.lease.epoch !== event.controllerEpoch) {
          addMismatch(ctx, ["payload", "lease", "epoch"], "Lease epoch must match event controller epoch")
        }
        break
      case "dispatch.finished":
      case "legacy.imported":
        break
    }
  })

const commandCommonShape = {
  schemaVersion: schemaVersionSchema,
  commandId: commandIdSchema,
  projectId: projectIdSchema,
  runId: runIdSchema,
  actor: actorSchema,
  controllerNodeId: nodeIdSchema,
  controllerEpoch: epochSchema,
  leaseId: leaseIdSchema,
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
  correlationId: correlationIdSchema,
  causation: causationSchema,
}

export const orchestrationCommandSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        ...commandCommonShape,
        type: z.literal("run.create"),
        payload: z
          .object({
            run: runSchema,
            tasks: z.array(taskSchema).max(ARRAY_MAX),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...commandCommonShape,
        type: z.literal("run.pause"),
        payload: z.object({ reason: textSchema }).strict(),
      })
      .strict(),
    z
      .object({
        ...commandCommonShape,
        type: z.literal("run.resume"),
        payload: z.object({ reason: textSchema }).strict(),
      })
      .strict(),
    z
      .object({
        ...commandCommonShape,
        type: z.literal("dispatch.propose"),
        payload: z.object({ dispatch: dispatchSchema }).strict(),
      })
      .strict(),
    z
      .object({
        ...commandCommonShape,
        type: z.literal("dispatch.approve"),
        payload: z.object({ dispatch: dispatchSchema, approval: approvalSchema }).strict(),
      })
      .strict(),
    z
      .object({
        ...commandCommonShape,
        type: z.literal("dispatch.retry"),
        payload: z
          .object({
            dispatch: dispatchSchema,
            previousDispatchId: dispatchIdSchema,
            previousAttempt: positiveSafeIntegerSchema,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...commandCommonShape,
        type: z.literal("dispatch.timeout.request"),
        payload: z.object({ dispatchId: dispatchIdSchema, reason: textSchema }).strict(),
      })
      .strict(),
    z
      .object({
        ...commandCommonShape,
        type: z.literal("dispatch.execute"),
        payload: z.object({ dispatch: dispatchSchema, approval: approvalSchema }).strict(),
      })
      .strict(),
    z
      .object({
        ...commandCommonShape,
        type: z.literal("session.prompt"),
        payload: z.object({ sessionId: sessionIdSchema, prompt: largeTextSchema }).strict(),
      })
      .strict(),
    z
      .object({
        ...commandCommonShape,
        type: z.literal("session.respond"),
        payload: z
          .object({
            sessionId: sessionIdSchema,
            requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
            decision: z.enum(["allow_once", "allow_always", "deny"]),
            reason: textSchema.optional(),
          })
          .strict(),
      })
      .strict(),
    z.object({ ...commandCommonShape, type: z.literal("session.interrupt"), payload: z.object({ sessionId: sessionIdSchema, reason: textSchema }).strict() }).strict(),
    z.object({ ...commandCommonShape, type: z.literal("session.terminate"), payload: z.object({ sessionId: sessionIdSchema, reason: textSchema }).strict() }).strict(),
    z.object({ ...commandCommonShape, type: z.literal("run.cancel"), payload: z.object({ reason: textSchema }).strict() }).strict(),
  ])
  .superRefine((command, ctx) => {
    if (!timestampAfter(command.expiresAt, command.issuedAt)) {
      addMismatch(ctx, ["expiresAt"], "Command expiry must be later than issue time")
    }
    if (command.type === "run.create") {
      const { run, tasks } = command.payload
      if (run.projectId !== command.projectId) addMismatch(ctx, ["payload", "run", "projectId"], "Run project ID must match command")
      if (run.runId !== command.runId) addMismatch(ctx, ["payload", "run", "runId"], "Run ID must match command")
      const taskIds = tasks.map((task) => task.taskId)
      if (!isUnique(taskIds)) addMismatch(ctx, ["payload", "tasks"], "Created task IDs must be unique")
      tasks.forEach((task, index) => {
        if (task.projectId !== command.projectId) addMismatch(ctx, ["payload", "tasks", index, "projectId"], "Task project ID must match command")
        if (task.runId !== command.runId) addMismatch(ctx, ["payload", "tasks", index, "runId"], "Task run ID must match command")
      })
    }

    if (command.type === "dispatch.approve" || command.type === "dispatch.execute") {
      const { dispatch, approval } = command.payload
      const envelope = dispatch.envelope
      if (envelope.projectId !== command.projectId) addMismatch(ctx, ["payload", "dispatch", "envelope", "projectId"], "Dispatch project ID must match command")
      if (envelope.runId !== command.runId) addMismatch(ctx, ["payload", "dispatch", "envelope", "runId"], "Dispatch run ID must match command")
      if (envelope.controllerEpoch !== command.controllerEpoch) addMismatch(ctx, ["payload", "dispatch", "envelope", "controllerEpoch"], "Dispatch epoch must match command")
      if (approval.projectId !== command.projectId) addMismatch(ctx, ["payload", "approval", "projectId"], "Approval project ID must match command")
      if (approval.runId !== command.runId) addMismatch(ctx, ["payload", "approval", "runId"], "Approval run ID must match command")
      if (approval.dispatchId !== envelope.dispatchId) addMismatch(ctx, ["payload", "approval", "dispatchId"], "Approval dispatch ID must match dispatch")
      if (approval.envelopeDigest !== dispatch.envelopeDigest) addMismatch(ctx, ["payload", "approval", "envelopeDigest"], "Approval digest must match dispatch")
      if (approval.state === "invalidated") {
        addMismatch(ctx, ["payload", "approval", "state"], "An invalidated approval cannot authorize a command")
      }
    }

    if (command.type === "dispatch.execute") {
      const { approval } = command.payload
      if (approval.decision !== "approved") addMismatch(ctx, ["payload", "approval", "decision"], "Execution requires an approved decision record")
      if (approval.state !== "approved") addMismatch(ctx, ["payload", "approval", "state"], "Execution requires an approval in state 'approved'")
    }

    if (command.type === "dispatch.retry") {
      const { dispatch, previousDispatchId, previousAttempt } = command.payload
      const envelope = dispatch.envelope
      if (envelope.projectId !== command.projectId) addMismatch(ctx, ["payload", "dispatch", "envelope", "projectId"], "Dispatch project ID must match command")
      if (envelope.runId !== command.runId) addMismatch(ctx, ["payload", "dispatch", "envelope", "runId"], "Dispatch run ID must match command")
      if (envelope.controllerEpoch !== command.controllerEpoch) addMismatch(ctx, ["payload", "dispatch", "envelope", "controllerEpoch"], "Dispatch epoch must match command")
      if (envelope.dispatchId === previousDispatchId) {
        addMismatch(ctx, ["payload", "dispatch", "envelope", "dispatchId"], "A retry must propose a new dispatch identity so failure history is preserved")
      }
      if (envelope.attempt <= previousAttempt) {
        addMismatch(ctx, ["payload", "dispatch", "envelope", "attempt"], "A retry must use a strictly greater attempt number")
      }
    }
  })
