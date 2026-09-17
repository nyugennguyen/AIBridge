import { z } from "zod"

const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export const meshIdSchema = z.string().regex(opaqueIdPattern).brand<"MeshId">()
export const nodeIdSchema = z.string().regex(opaqueIdPattern).brand<"NodeId">()
export const projectIdSchema = z.string().regex(opaqueIdPattern).brand<"ProjectId">()
export const projectPathIdSchema = z.string().regex(opaqueIdPattern).brand<"ProjectPathId">()
export const runIdSchema = z.string().regex(opaqueIdPattern).brand<"RunId">()
export const taskIdSchema = z.string().regex(opaqueIdPattern).brand<"TaskId">()
export const dispatchIdSchema = z.string().regex(opaqueIdPattern).brand<"DispatchId">()
export const approvalIdSchema = z.string().regex(opaqueIdPattern).brand<"ApprovalId">()
export const sessionIdSchema = z.string().regex(opaqueIdPattern).brand<"SessionId">()
export const roleIdSchema = z.string().regex(opaqueIdPattern).brand<"RoleId">()
export const ruleIdSchema = z.string().regex(opaqueIdPattern).brand<"RuleId">()
export const memoryIdSchema = z.string().regex(opaqueIdPattern).brand<"MemoryId">()
export const artifactIdSchema = z.string().regex(opaqueIdPattern).brand<"ArtifactId">()
export const leaseIdSchema = z.string().regex(opaqueIdPattern).brand<"LeaseId">()
export const installationIdSchema = z.string().regex(opaqueIdPattern).brand<"InstallationId">()
export const terminalIdSchema = z.string().regex(opaqueIdPattern).brand<"TerminalId">()
export const terminalClientIdSchema = z.string().regex(opaqueIdPattern).brand<"TerminalClientId">()
export const userIdSchema = z.string().regex(opaqueIdPattern).brand<"UserId">()
export const eventIdSchema = z.string().regex(opaqueIdPattern).brand<"EventId">()
export const commandIdSchema = z.string().regex(opaqueIdPattern).brand<"CommandId">()
export const correlationIdSchema = z.string().regex(opaqueIdPattern).brand<"CorrelationId">()

export const schemaVersionSchema = z.literal(1)

const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/

export const timestampSchema = z.string().regex(utcTimestampPattern).refine((value) => {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return false

  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value)
  if (!match) return false

  const date = new Date(milliseconds)
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3]) &&
    date.getUTCHours() === Number(match[4]) &&
    date.getUTCMinutes() === Number(match[5]) &&
    date.getUTCSeconds() === Number(match[6])
  )
}, "Must be a real RFC 3339 UTC timestamp")

export const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/).brand<"Digest">()
export const epochSchema = z.number().int().positive().safe()
export const capabilitySchema = z.string().regex(opaqueIdPattern)

export type MeshId = z.infer<typeof meshIdSchema>
export type NodeId = z.infer<typeof nodeIdSchema>
export type ProjectId = z.infer<typeof projectIdSchema>
export type ProjectPathId = z.infer<typeof projectPathIdSchema>
export type RunId = z.infer<typeof runIdSchema>
export type TaskId = z.infer<typeof taskIdSchema>
export type DispatchId = z.infer<typeof dispatchIdSchema>
export type ApprovalId = z.infer<typeof approvalIdSchema>
export type SessionId = z.infer<typeof sessionIdSchema>
export type RoleId = z.infer<typeof roleIdSchema>
export type RuleId = z.infer<typeof ruleIdSchema>
export type MemoryId = z.infer<typeof memoryIdSchema>
export type ArtifactId = z.infer<typeof artifactIdSchema>
export type LeaseId = z.infer<typeof leaseIdSchema>
export type InstallationId = z.infer<typeof installationIdSchema>
export type TerminalId = z.infer<typeof terminalIdSchema>
export type TerminalClientId = z.infer<typeof terminalClientIdSchema>
export type UserId = z.infer<typeof userIdSchema>
export type EventId = z.infer<typeof eventIdSchema>
export type CommandId = z.infer<typeof commandIdSchema>
export type CorrelationId = z.infer<typeof correlationIdSchema>
export type SchemaVersion = z.infer<typeof schemaVersionSchema>
export type Timestamp = z.infer<typeof timestampSchema>
export type Digest = z.infer<typeof digestSchema>
export type Epoch = z.infer<typeof epochSchema>
export type Capability = z.infer<typeof capabilitySchema>
