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

/**
 * The schema versions this build is able to READ.
 *
 * M4-V. This used to be `z.literal(1)`, which made a persisted-record shape
 * change *unversionable*: the only writable value was the only readable one, so
 * widening the shape had to be a silent in-place overwrite of records the older
 * binary still claimed to understand. Milestone 3 did exactly that — `run` gained
 * `paused`, `task` gained `failurePolicy`, `session` replaced `state` with
 * `lifecycleState` + `observedState` — and the resulting break could not be named,
 * let alone migrated, because there was no second version to name it with.
 *
 * The set is a *reader* capability, not a writer preference: a record at any
 * listed version is understood, and anything outside the set is rejected loudly
 * by `schemaVersionSchema` rather than coerced. New records are written at
 * `CURRENT_SCHEMA_VERSION`; existing records are never rewritten just to move
 * them up a version, because a version bump must mean "the shape changed", not
 * "this file was touched".
 *
 * Note the database version is deliberately NOT in this list. `runMigrations`'
 * v1 -> v2 step covers the storage layout only; event-payload compatibility is a
 * record-version question and is answered here.
 */
export const SCHEMA_VERSIONS = [1, 2] as const

export type SupportedSchemaVersion = (typeof SCHEMA_VERSIONS)[number]

/**
 * Zod 4's `z.enum` accepts only string members, so a numeric version union is
 * spelled as a union of literals. It is annotated with the narrowed type rather
 * than left to inference so the two declarations above cannot drift apart: if a
 * version is added to `SCHEMA_VERSIONS` and not here, this stops compiling.
 *
 * The two must also agree at RUNTIME — a version listed as readable but refused
 * by the schema (or the reverse) would be a silent hole in the version
 * contract, so `tests/unit/orchestration/versioning.test.ts` asserts both
 * directions.
 */
export const schemaVersionSchema: z.ZodType<SupportedSchemaVersion> = z.union([
  z.literal(1),
  z.literal(2),
])

/**
 * The version newly written records carry.
 *
 * Version 2 is adopted by the Milestone 4 mesh wire families (enrollment,
 * heartbeat, command envelope, ack, event, lease, reconciliation, terminal
 * stream), which are new record families rather than shape changes to the frozen
 * M0 domain aggregates. The M0 domain records keep writing
 * `FROZEN_DOMAIN_SCHEMA_VERSION`, because their shapes did not change and
 * restamping them would falsely claim they did.
 */
export const CURRENT_SCHEMA_VERSION: SupportedSchemaVersion = 2

/**
 * The version of the frozen M0 canonical domain aggregates
 * (`run`, `task`, `dispatch`, `approval`, `session`, `project`, `mesh`, `node`,
 * `role`, `rule`, `memory`, `artifact`, `controllerLease`, and the
 * `orchestrationEvent` / `orchestrationCommand` envelopes).
 *
 * These shapes are the M0 contract freeze. They are accepted at version 1
 * forever and are only moved to a new version by a deliberate, re-approved shape
 * change.
 */
export const FROZEN_DOMAIN_SCHEMA_VERSION: SupportedSchemaVersion = 1

/**
 * A bare version literal, for declaring a record family at exactly one version.
 *
 * `version(2)` is `z.literal(2)`, so a family declared with it can never be
 * satisfied by a record at any other version — which is what lets
 * `parseVersioned` in `./versioning.js` reject a wrong version loudly instead of
 * guessing at a shape.
 */
export function version<T extends SupportedSchemaVersion>(value: T) {
  return z.literal(value)
}

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
