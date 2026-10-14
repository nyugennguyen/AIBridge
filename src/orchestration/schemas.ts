import { z } from "zod"
import { createContractError, type Result } from "./errors.js"
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
  type Digest,
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
import { digestJson } from "./digest.js"

const SHORT_TEXT_MAX = 256
export const TEXT_MAX = 4_096
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
    compositionMode: z.enum(["intersection", "union"]).optional(),
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

/**
 * Determines whether a role's permission restrictions explicitly opt into union composition
 * for multi-role capability envelope calculation. Default is false (intersection).
 */
export function isUnionOptIn(restrictions?: {
  readonly compositionMode?: string
  readonly [key: string]: unknown
} | null): boolean {
  return restrictions?.compositionMode === "union"
}

/**
 * Error thrown when a role assignment set violates kernel invariants
 * (e.g. primary role count, uniqueness).
 */
export class RoleAssignmentError extends Error {
  readonly code = "role_assignment.invalid" as const
  readonly category = "validation" as const

  constructor(message: string) {
    super(message)
    this.name = "RoleAssignmentError"
  }
}

/**
 * Assignment of a role to an agent in a multi-role context (plan §6.2).
 * Exactly one role in an agent's assignment set must be primary (`primary: true`).
 * Secondary roles (`primary: false`) contribute bounded addenda instructions,
 * not full prompt instructions.
 */
export const roleAssignmentSchema = z
  .object({
    roleId: roleIdSchema.or(shortTextSchema),
    primary: z.boolean(),
    addendum: z
      .string()
      .max(TEXT_MAX)
      .refine(
        (val) => Buffer.byteLength(val, "utf8") <= TEXT_MAX,
        `Addendum must not exceed ${TEXT_MAX} bytes`,
      )
      .optional(),
    version: positiveSafeIntegerSchema.optional(),
    snapshotDigest: digestSchema.optional(),
  })
  .strict()
  .superRefine((assignment, ctx) => {
    if (assignment.primary && assignment.addendum !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["addendum"],
        message: "Primary role must not specify an addendum; secondary roles contribute addenda",
      })
    }
  })

/**
 * Validates that an assignment set contains exactly one primary role.
 * Throws `RoleAssignmentError` if zero or 2+ primaries are found.
 */
export function assertExactlyOnePrimaryRole(assignments: readonly RoleAssignment[]): void {
  const primaryCount = assignments.filter((a) => a.primary).length
  if (primaryCount !== 1) {
    throw new RoleAssignmentError(
      `Role assignments must contain exactly one primary role; found ${primaryCount}`,
    )
  }
}

/**
 * Validates role assignments against all kernel invariants:
 * - Exactly one primary role.
 * - Unique role IDs within the assignment set.
 */
export function validateRoleAssignments(assignments: readonly RoleAssignment[]): Result<void> {
  const primaryCount = assignments.filter((a) => a.primary).length
  if (primaryCount !== 1) {
    return {
      ok: false,
      error: createContractError(
        "validation",
        "role_assignment.invalid_primary_count",
        `Role assignments must contain exactly one primary role; found ${primaryCount}`,
      ),
    }
  }
  const roleIds = assignments.map((a) => a.roleId)
  if (new Set(roleIds).size !== roleIds.length) {
    return {
      ok: false,
      error: createContractError(
        "validation",
        "role_assignment.duplicate_role_id",
        "Role assignments must contain unique role IDs",
      ),
    }
  }
  return { ok: true, value: undefined }
}

/**
 * Schema for an agent's complete role assignment set.
 * Refines that:
 * 1. Exactly one primary role is present (zero or 2+ are refused).
 * 2. Role IDs are unique within the assignment set.
 */
export const roleAssignmentsSchema = z
  .array(roleAssignmentSchema)
  .max(ARRAY_MAX)
  .superRefine((assignments, ctx) => {
    const primaryCount = assignments.filter((a) => a.primary).length
    if (primaryCount !== 1) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: `Role assignments must contain exactly one primary role; found ${primaryCount}`,
      })
    }
    const roleIds = assignments.map((a) => a.roleId)
    if (new Set(roleIds).size !== roleIds.length) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: "Role assignments must have unique role IDs",
      })
    }
  })

export const roleAssignmentSetSchema = roleAssignmentsSchema

/**
 * Canonicalizes role assignments into a stable, deterministically sorted list
 * suitable for RoleBinder prompt stamping and digest calculation.
 * Primary role is placed first, followed by secondaries sorted by roleId.
 */
export function canonicalizeRoleAssignments(assignments: readonly RoleAssignment[]): readonly {
  readonly roleId: string
  readonly primary: boolean
  readonly version?: number
  readonly snapshotDigest?: string
  readonly addendum?: string
}[] {
  return [...assignments]
    .sort((a, b) => {
      if (a.primary && !b.primary) return -1
      if (!a.primary && b.primary) return 1
      return a.roleId.localeCompare(b.roleId)
    })
    .map((assignment) => ({
      roleId: assignment.roleId,
      primary: assignment.primary,
      ...(assignment.version !== undefined ? { version: assignment.version } : {}),
      ...(assignment.snapshotDigest !== undefined ? { snapshotDigest: assignment.snapshotDigest } : {}),
      ...(assignment.addendum !== undefined ? { addendum: assignment.addendum } : {}),
    }))
}

/**
 * Computes a deterministic canonical digest for a role assignment set.
 */
export function computeRoleAssignmentsDigest(assignments: readonly RoleAssignment[]): Digest {
  return digestJson(canonicalizeRoleAssignments(assignments))
}

export type RoleAssignment = z.infer<typeof roleAssignmentSchema>
export type RoleAssignments = z.infer<typeof roleAssignmentsSchema>
export type RoleAssignmentSet = RoleAssignments

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
    roleSnapshots: z.array(roleTemplateSchema).max(ARRAY_MAX).optional(),
    roleAssignments: roleAssignmentsSchema.optional(),
    ruleSnapshots: z.array(ruleSchema).max(ARRAY_MAX),
    contextManifest: contextManifestSchema,
    requestedCapabilities: capabilityListSchema,
    permissionEnvelope: permissionEnvelopeSchema,
    dependencies: z.array(taskDependencySchema).max(ARRAY_MAX),
    timeoutSeconds: z.number().int().positive().max(TIMEOUT_MAX_SECONDS).safe(),
    controllerEpoch: epochSchema,
    model: z.string().min(1).max(SHORT_TEXT_MAX).refine((value) => value === value.trim(), "Must not have surrounding whitespace").optional(),
    fanOut: positiveSafeIntegerSchema.optional(),
    parentDispatchId: dispatchIdSchema.optional(),
  })
  .strict()
  .superRefine((envelope, ctx) => {
    if (envelope.roleSnapshot.projectId !== envelope.projectId) {
      addMismatch(ctx, ["roleSnapshot", "projectId"], "Role project ID must match dispatch project")
    }
    if (envelope.roleSnapshots !== undefined) {
      envelope.roleSnapshots.forEach((role, index) => {
        if (role.projectId !== envelope.projectId) {
          addMismatch(ctx, ["roleSnapshots", index, "projectId"], "Role project ID must match dispatch project")
        }
      })
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

/**
 * Modes of discussion turn sequencing in a roundtable deliberation session.
 */
export const discussionModeSchema = z.enum([
  "sequential",
  "parallel",
  "until_objections_resolved",
])

/**
 * Structural kind of a post in a roundtable deliberation session.
 */
export const postKindSchema = z.enum([
  "proposal",
  "objection",
  "question",
  "answer",
  "note",
])

/**
 * Minimal membership record for a roundtable participant.
 *
 * Intentionally minimal: holds only `nodeId` and `roleId`.
 * Additional state (e.g. joined timestamp, readiness, status) is deliberately
 * excluded because roundtables are advisory deliberation sessions whose
 * turn-taking order and voting are governed by the charter's communication policy,
 * not by per-member session state machines.
 */
export const roundtableMemberSchema = z
  .object({
    nodeId: nodeIdSchema,
    roleId: roleIdSchema.or(shortTextSchema),
  })
  .strict()

/**
 * Roundtable deliberation aggregate.
 */
export const roundtableSchema = z
  .object({
    id: shortTextSchema,
    runId: runIdSchema,
    taskId: taskIdSchema.optional(),
    subject: shortTextSchema,
    mode: discussionModeSchema,
    chairNodeId: nodeIdSchema,
    members: z.array(roundtableMemberSchema).max(ARRAY_MAX),
    state: z.enum(["open", "closed"]),
  })
  .strict()

/**
 * Post record within a roundtable deliberation.
 */
export const postSchema = z
  .object({
    postId: shortTextSchema,
    discussionId: shortTextSchema,
    seq: nonnegativeSafeIntegerSchema,
    authorNodeId: nodeIdSchema,
    authorRoleId: roleIdSchema.or(shortTextSchema),
    kind: postKindSchema,
    replyTo: shortTextSchema.optional(),
    body: largeTextSchema,
    createdAt: timestampSchema,
  })
  .strict()

/**
 * Advisory deliberation outcome recorded at the conclusion of a roundtable.
 *
 * NOTE: ADVISORY ONLY.
 * This outcome is NEVER a state-transition trigger. Per ADR 0009 and the
 * orchestration design, a roundtable outcome provides recommendations and
 * records addressed/unresolved objections for dispatch proposals or human review,
 * but never directly triggers any kernel state transition or command execution.
 */
export const roundtableOutcomeSchema = z
  .object({
    summary: textSchema,
    recommendation: textSchema,
    addressedObjections: z.array(shortTextSchema).max(ARRAY_MAX),
    unresolvedObjections: z.array(shortTextSchema).max(ARRAY_MAX),
  })
  .strict()
// ============================================================================
// Charter and Roundtable Schemas (Phase 0 / Milestone 6)
// ============================================================================

/**
 * Error thrown when a charter carries an invalid version.
 *
 * `Charter.version` is the charter's REVISION counter — plan §7.4 lifecycle
 * (`charter.revise` creates the next version) and DoD #3 ("running dispatches
 * keep the old digest") — NOT a document-format enum. An earlier
 * `SUPPORTED_CHARTER_VERSIONS = [1]` pinning was an over-read of "unknown
 * versions refused" and made every revision above 1 unrepresentable. Version
 * validity is now a structural bound (`charterVersionSchema`) plus
 * repository-level refusal of versions not held (`charter/repository.ts`).
 */
export class UnsupportedCharterVersionError extends Error {
  readonly code = "charter.unsupported_version" as const
  readonly category = "validation" as const
  readonly version: unknown

  constructor(version: unknown, message?: string) {
    const desc = typeof version === "number" || typeof version === "string" ? String(version) : typeof version
    super(
      message ??
        `charter.unsupported_version: Invalid charter version '${desc}'. A charter version is a revision counter: a positive integer starting at 1.`,
    )
    this.name = "UnsupportedCharterVersionError"
    this.version = version
  }
}

/**
 * Charter revision version: a positive safe integer.
 *
 * Revisions 2, 3, … are first-class (`charter.revise` bumps the counter). The
 * bound is STRUCTURAL — it survives JSON Schema generation, so
 * `contracts/v1/charter.schema.json` refuses exactly what the runtime parser
 * refuses. The previous `.refine`-based version enum was silently dropped by
 * zod-to-json-schema, leaving the wire contract wider than the runtime.
 * Unknown REVISION numbers are refused at the repository layer, not here.
 */
export const charterVersionSchema = z.number().int().positive().safe()

/**
 * Charter author discriminator. Charters can be human-authored or proposed
 * by autonomous agents through deliberation.
 */
export const charterAuthorSchema = z.enum(["human", "agent"])

/**
 * Reference to a role template in a charter's role catalog.
 * Strict object pinning role identity and template version, with optional snapshot digest.
 */
export const charterRoleRefSchema = z
  .object({
    roleId: roleIdSchema.or(shortTextSchema),
    version: positiveSafeIntegerSchema,
    snapshotDigest: digestSchema.optional(),
  })
  .strict()

/**
 * Policy governing inter-agent deliberation turn-taking, required objection
 * triggers, and verbosity bounds during orchestration execution.
 */
export const communicationPolicySchema = z
  .object({
    turnTaking: z.enum(["chair_ordered", "free_for_all"]),
    objectionRequiredBefore: z.array(shortTextSchema).max(ARRAY_MAX),
    verbosity: z.enum(["terse", "normal", "detailed"]),
    mustStopAndAsk: z.array(shortTextSchema).max(ARRAY_MAX),
    objectionMustContain: z.array(shortTextSchema).max(ARRAY_MAX),
  })
  .strict()

/**
 * Policy specifying escalation thresholds, round caps, and deadlock resolution paths.
 */
export const escalationPolicySchema = z
  .object({
    maxRounds: positiveSafeIntegerSchema,
    onDeadlock: z.enum(["chair_decides", "human_decides", "fail_run"]),
    budgetScope: z.enum(["shared", "per_member"]),
  })
  .strict()

/**
 * Charter aggregate defining the orchestration system prompt, immutable-core link,
 * global rules, communication rules, escalation rules, and catalog of roles.
 */
export const charterSchema = z
  .object({
    charterId: shortTextSchema,
    version: charterVersionSchema,
    purpose: textSchema,
    globalRules: z.array(textSchema).max(ARRAY_MAX),
    communicationPolicy: communicationPolicySchema,
    escalationPolicy: escalationPolicySchema,
    roleCatalog: z.array(charterRoleRefSchema).max(ARRAY_MAX),
    immutableCoreDigest: digestSchema,
    snapshotDigest: digestSchema,
    capturedAt: timestampSchema,
    author: charterAuthorSchema,
  })
  .strict()

/**
 * Immutable-core change areas (plan §7.3 fixed list).
 * Any proposal carrying an operation targeting one of these areas must be refused
 * by kernel policy validation before becoming pending.
 */
export const CHARTER_CORE_CHANGE_AREAS = Object.freeze([
  "policy.safety_floor",
  "fencing.input_ownership",
  "security.allowed_sources",
  "security.project_allowlist",
  "roundtable.advisory_only",
  "budgets.ceilings",
  "kernel.event_store_authority",
] as const)

/**
 * Non-core sections of the charter document that can be legitimately proposed for revision.
 */
export const CHARTER_NON_CORE_CHANGE_AREAS = Object.freeze([
  "charter.purpose",
  "charter.global_rules",
  "charter.communication_policy",
  "charter.escalation_policy",
  "charter.role_catalog",
] as const)

/**
 * All recognized change areas for a charter revision proposal.
 */
export const CHARTER_CHANGE_AREAS = Object.freeze([
  ...CHARTER_NON_CORE_CHANGE_AREAS,
  ...CHARTER_CORE_CHANGE_AREAS,
] as const)

/**
 * Strict Zod enum discriminating the structural area targeted by a charter change operation.
 */
export const charterChangeAreaSchema = z.enum(CHARTER_CHANGE_AREAS)

/**
 * Structural change operation identifying an area touched by a charter proposal.
 *
 * WHY THIS EXISTS:
 * Per ADR 0009 and plan §7.3, a proposal that touches any of the immutable-core items
 * must be mechanically refused before becoming pending. Free-text heuristic detection
 * is deliberately out of scope because natural language cannot guarantee deterministic
 * enforcement across agent proposals. By requiring proposals to declare their change
 * targets structurally via `charterChangeAreaSchema`, kernel policy validators can
 * mechanically assert whether an operation touches the immutable core (e.g. attempting
 * to modify allowed_sources, safety floors, or budget ceilings). The human approval
 * gate (human-only, per settled plan §15) remains the final backstop.
 */
export const charterChangeOpSchema = z
  .object({
    area: charterChangeAreaSchema,
    note: shortTextSchema.optional(),
  })
  .strict()

/**
 * Agent- or operator-proposed revision to the active charter, carrying rationale,
 * evidence references back to deliberation sessions, and structural change operations.
 */
export const charterProposalSchema = z
  .object({
    charter: charterSchema,
    rationale: textSchema,
    evidenceRefs: z.array(shortTextSchema).max(ARRAY_MAX),
    changes: z.array(charterChangeOpSchema).max(ARRAY_MAX),
  })
  .strict()

/**
 * Computes the canonical snapshot digest of a charter document.
 *
 * Mirroring the snapshot digest convention in `src/orchestration/roles/repository.ts`:
 * - Uses canonical JSON encoding to ensure byte-identical digests across runs and key ordering.
 * - Excludes only its own `snapshotDigest` field so the digest covers all governed
 *   content (including `immutableCoreDigest` and role catalog digests) while avoiding
 *   circular self-reference.
 */
export function computeCharterSnapshotDigest(charter: {
  readonly charterId: string
  readonly version: number
  readonly purpose: string
  readonly globalRules: readonly string[]
  readonly communicationPolicy: z.infer<typeof communicationPolicySchema>
  readonly escalationPolicy: z.infer<typeof escalationPolicySchema>
  readonly roleCatalog: readonly {
    readonly roleId: string
    readonly version: number
    readonly snapshotDigest?: string
  }[]
  readonly capturedAt: string
  readonly author: z.infer<typeof charterAuthorSchema>
  readonly immutableCoreDigest: string
  readonly snapshotDigest?: string
}): Digest {
  return digestJson({
    author: charter.author,
    capturedAt: charter.capturedAt,
    charterId: charter.charterId,
    communicationPolicy: charter.communicationPolicy,
    escalationPolicy: charter.escalationPolicy,
    globalRules: [...charter.globalRules],
    immutableCoreDigest: charter.immutableCoreDigest,
    purpose: charter.purpose,
    roleCatalog: charter.roleCatalog.map((ref) => ({
      roleId: ref.roleId,
      version: ref.version,
      ...(ref.snapshotDigest !== undefined ? { snapshotDigest: ref.snapshotDigest } : {}),
    })),
    version: charter.version,
  })
}

/**
 * Verifies that a charter document's `snapshotDigest` matches its computed
 * canonical digest. Invalid digests return `false`.
 */
export function verifyCharterSnapshotDigest(charter: {
  readonly charterId: string
  readonly version: number
  readonly purpose: string
  readonly globalRules: readonly string[]
  readonly communicationPolicy: z.infer<typeof communicationPolicySchema>
  readonly escalationPolicy: z.infer<typeof escalationPolicySchema>
  readonly roleCatalog: readonly {
    readonly roleId: string
    readonly version: number
    readonly snapshotDigest?: string
  }[]
  readonly capturedAt: string
  readonly author: z.infer<typeof charterAuthorSchema>
  readonly immutableCoreDigest: string
  readonly snapshotDigest: string
}): boolean {
  try {
    const expected = computeCharterSnapshotDigest(charter)
    return expected === charter.snapshotDigest
  } catch {
    return false
  }
}

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
    z.object({ ...eventCommonShape, type: z.literal("roundtable.opened"), payload: z.object({ roundtable: roundtableSchema }).strict() }).strict(),
    z.object({ ...eventCommonShape, type: z.literal("roundtable.posted"), payload: z.object({ post: postSchema }).strict() }).strict(),
    z.object({ ...eventCommonShape, type: z.literal("roundtable.closed"), payload: z.object({ discussionId: shortTextSchema }).strict() }).strict(),
    z.object({ ...eventCommonShape, type: z.literal("roundtable.outcome_recorded"), payload: z.object({ discussionId: shortTextSchema, outcome: roundtableOutcomeSchema }).strict() }).strict(),
    z.object({ ...eventCommonShape, type: z.literal("charter.proposed"), payload: z.object({ proposal: charterProposalSchema, proposalId: shortTextSchema.optional() }).strict() }).strict(),
    z.object({ ...eventCommonShape, type: z.literal("charter.revised"), payload: z.object({ charter: charterSchema, proposalId: shortTextSchema.optional() }).strict() }).strict(),
    z.object({ ...eventCommonShape, type: z.literal("charter.rejected"), payload: z.object({ charterId: shortTextSchema, version: charterVersionSchema.optional(), proposalId: shortTextSchema.optional(), rationale: textSchema }).strict() }).strict(),
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
      case "roundtable.opened":
        if (event.payload.roundtable.runId !== event.runId) {
          addMismatch(ctx, ["payload", "roundtable", "runId"], "Roundtable run ID must match event")
        }
        break
      case "roundtable.posted":
      case "roundtable.closed":
      case "roundtable.outcome_recorded":
        break
      case "charter.proposed":
      case "charter.revised":
      case "charter.rejected":
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
        payload: z
          .object({
            sessionId: sessionIdSchema,
            prompt: largeTextSchema,
            roleAssignments: roleAssignmentsSchema.optional(),
            roleSnapshot: roleTemplateSchema.optional(),
          })
          .strict(),
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
    z.object({ ...commandCommonShape, type: z.literal("roundtable.open"), payload: z.object({ roundtable: roundtableSchema }).strict() }).strict(),
    z.object({ ...commandCommonShape, type: z.literal("roundtable.post"), payload: z.object({ post: postSchema }).strict() }).strict(),
    z.object({ ...commandCommonShape, type: z.literal("roundtable.inject_human"), payload: z.object({ post: postSchema }).strict() }).strict(),
    z.object({ ...commandCommonShape, type: z.literal("roundtable.close"), payload: z.object({ discussionId: shortTextSchema, outcome: roundtableOutcomeSchema }).strict() }).strict(),
    z.object({ ...commandCommonShape, type: z.literal("charter.propose"), payload: z.object({ proposal: charterProposalSchema, proposalId: shortTextSchema.optional() }).strict() }).strict(),
    z.object({ ...commandCommonShape, type: z.literal("charter.approve"), payload: z.object({ charterId: shortTextSchema, version: charterVersionSchema.optional(), proposalId: shortTextSchema.optional(), comment: textSchema.optional() }).strict() }).strict(),
    z.object({ ...commandCommonShape, type: z.literal("charter.revise"), payload: z.object({ charter: charterSchema, proposalId: shortTextSchema.optional(), rationale: textSchema.optional() }).strict() }).strict(),
    z.object({ ...commandCommonShape, type: z.literal("charter.reject"), payload: z.object({ charterId: shortTextSchema, version: charterVersionSchema.optional(), proposalId: shortTextSchema.optional(), rationale: textSchema }).strict() }).strict(),
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
    if (command.type === "roundtable.open") {
      const { roundtable } = command.payload
      if (roundtable.runId !== command.runId) {
        addMismatch(ctx, ["payload", "roundtable", "runId"], "Roundtable run ID must match command")
      }
      if (roundtable.state !== "open") {
        addMismatch(ctx, ["payload", "roundtable", "state"], "Roundtable must be opened in 'open' state")
      }
    }

    if (command.type === "roundtable.inject_human") {
      const { post } = command.payload
      if (post.authorRoleId !== "human") {
        addMismatch(ctx, ["payload", "post", "authorRoleId"], "Author role ID for inject_human must be 'human'")
      }
    }
  })


export type {
  Charter,
  CommunicationPolicy,
  EscalationPolicy,
  CharterRoleRef,
  CharterAuthor,
  Roundtable,
  RoundtableMember,
  Post,
  PostKind,
  DiscussionMode,
  RoundtableOutcome,
  CharterChangeArea,
  CharterCoreChangeArea,
  CharterChangeOp,
  CharterProposal,
} from "./charter/types.js"
