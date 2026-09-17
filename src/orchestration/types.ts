import type { z } from "zod"
import type {
  actorSchema,
  approvalSchema,
  artifactSchema,
  contextManifestSchema,
  controllerLeaseSchema,
  dispatchEnvelopeSchema,
  dispatchSchema,
  dispatchStateSchema,
  externalReferenceSchema,
  memoryRecordSchema,
  meshSchema,
  nodeSchema,
  orchestrationCommandSchema,
  orchestrationEventSchema,
  permissionEnvelopeSchema,
  projectPathSchema,
  projectSchema,
  roleTemplateSchema,
  ruleSchema,
  runSchema,
  runStateSchema,
  sessionSchema,
  sessionStateSchema,
  taskDependencySchema,
  taskSchema,
  taskStateSchema,
} from "./schemas.js"

export type Actor = z.infer<typeof actorSchema>
export type ExternalReference = z.infer<typeof externalReferenceSchema>
export type Mesh = z.infer<typeof meshSchema>
export type Node = z.infer<typeof nodeSchema>
export type ProjectPath = z.infer<typeof projectPathSchema>
export type Project = z.infer<typeof projectSchema>
export type Run = z.infer<typeof runSchema>
export type RunState = z.infer<typeof runStateSchema>
export type TaskDependency = z.infer<typeof taskDependencySchema>
export type Task = z.infer<typeof taskSchema>
export type TaskState = z.infer<typeof taskStateSchema>
export type RoleTemplate = z.infer<typeof roleTemplateSchema>
export type Rule = z.infer<typeof ruleSchema>
export type PermissionEnvelope = z.infer<typeof permissionEnvelopeSchema>
export type ContextManifest = z.infer<typeof contextManifestSchema>
export type DispatchEnvelope = z.infer<typeof dispatchEnvelopeSchema>
export type Dispatch = z.infer<typeof dispatchSchema>
export type DispatchState = z.infer<typeof dispatchStateSchema>
export type Approval = z.infer<typeof approvalSchema>
export type Session = z.infer<typeof sessionSchema>
export type SessionState = z.infer<typeof sessionStateSchema>
export type MemoryRecord = z.infer<typeof memoryRecordSchema>
export type Artifact = z.infer<typeof artifactSchema>
export type ControllerLease = z.infer<typeof controllerLeaseSchema>
export type OrchestrationEvent = z.infer<typeof orchestrationEventSchema>
export type OrchestrationCommand = z.infer<typeof orchestrationCommandSchema>
