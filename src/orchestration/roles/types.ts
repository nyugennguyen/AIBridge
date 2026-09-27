import { z } from "zod"
import {
  digestSchema,
  roleIdSchema,
  timestampSchema,
  type Digest,
  type RoleId,
} from "../identifiers.js"

export const positiveSafeIntegerSchema = z.number().int().positive().safe()

export const roleTemplateV1Schema = z
  .object({
    roleId: roleIdSchema.or(z.string().min(1).max(128)),
    version: positiveSafeIntegerSchema,
    name: z.string().min(1).max(256),
    description: z.string().max(4096).default(""),
    capabilities: z.array(z.string().min(1).max(128)).default([]),
    rules: z.array(z.unknown()).default([]),
    metadata: z.record(z.string(), z.unknown()).default({}),
    createdAt: timestampSchema,
    schemaVersion: z.number().int().optional(),
    templateVersion: positiveSafeIntegerSchema.optional(),
    purpose: z.string().max(4096).optional(),
    instructions: z.string().max(65536).optional(),
    requiredCapabilities: z.array(z.string().min(1).max(128)).optional(),
    projectId: z.string().min(1).max(128).optional(),
    author: z.unknown().optional(),
    permissionRestrictions: z.unknown().optional(),
    contextSelectionPolicyReference: z.unknown().optional(),
    preferredRuntimeKinds: z.array(z.string().min(1).max(128)).optional(),
  })

export interface RoleTemplateInput {
  readonly roleId: string
  readonly version?: number
  readonly templateVersion?: number
  readonly name: string
  readonly description?: string
  readonly purpose?: string
  readonly instructions?: string
  readonly capabilities?: readonly string[]
  readonly requiredCapabilities?: readonly string[]
  readonly rules?: readonly unknown[]
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly createdAt?: string
  readonly schemaVersion?: number
  readonly projectId?: string
  readonly author?: unknown
  readonly permissionRestrictions?: unknown
  readonly contextSelectionPolicyReference?: unknown
  readonly preferredRuntimeKinds?: readonly string[]
}

export interface RoleTemplate {
  readonly roleId: string
  readonly version: number
  readonly templateVersion: number
  readonly name: string
  readonly description: string
  readonly purpose: string
  readonly capabilities: readonly string[]
  readonly requiredCapabilities: readonly string[]
  readonly rules: readonly unknown[]
  readonly metadata: Readonly<Record<string, unknown>>
  readonly createdAt: string
  readonly schemaVersion: number
  readonly projectId?: string
  readonly instructions?: string
  readonly author?: unknown
  readonly permissionRestrictions?: unknown
  readonly contextSelectionPolicyReference?: unknown
  readonly preferredRuntimeKinds?: readonly string[]
}

export const roleSnapshotSchema = z
  .object({
    roleId: roleIdSchema.or(z.string().min(1).max(128)),
    version: positiveSafeIntegerSchema,
    snapshotDigest: digestSchema,
    capabilities: z.array(z.string().min(1).max(128)),
    rules: z.array(z.unknown()),
    capturedAt: timestampSchema,
    name: z.string().optional(),
    description: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })

export interface RoleSnapshot {
  readonly roleId: string
  readonly version: number
  readonly snapshotDigest: Digest
  readonly capabilities: readonly string[]
  readonly rules: readonly unknown[]
  readonly capturedAt: string
  readonly name?: string
  readonly description?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly templateVersion?: number
  readonly requiredCapabilities?: readonly string[]
}

export const compatibilityRequirementsSchema = z
  .object({
    requiredCapabilities: z.array(z.string().min(1).max(128)).optional(),
    allowedCapabilities: z.array(z.string().min(1).max(128)).optional(),
    deniedCapabilities: z.array(z.string().min(1).max(128)).optional(),
    runtimeKind: z.string().min(1).max(128).optional(),
    requireDestructiveApproval: z.boolean().optional(),
    requireExternalApproval: z.boolean().optional(),
    constraints: z.record(z.string(), z.unknown()).optional(),
  })

export interface CompatibilityRequirements {
  readonly requiredCapabilities?: readonly string[]
  readonly allowedCapabilities?: readonly string[]
  readonly deniedCapabilities?: readonly string[]
  readonly runtimeKind?: string
  readonly requireDestructiveApproval?: boolean
  readonly requireExternalApproval?: boolean
  readonly constraints?: Readonly<Record<string, unknown>>
}

export const compatibilityResultSchema = z.object({
  compatible: z.boolean(),
  ok: z.boolean(),
  satisfiedCapabilities: z.array(z.string()),
  missingCapabilities: z.array(z.string()),
  prohibitedCapabilities: z.array(z.string()),
  reasons: z.array(z.string()),
  errors: z.array(z.string()),
})

export interface CompatibilityResult {
  readonly compatible: boolean
  readonly ok: boolean
  readonly satisfiedCapabilities: readonly string[]
  readonly missingCapabilities: readonly string[]
  readonly prohibitedCapabilities: readonly string[]
  readonly reasons: readonly string[]
  readonly errors: readonly string[]
}

export const roleFilterOptionsSchema = z.object({
  roleId: z.string().optional(),
  projectId: z.string().optional(),
  name: z.string().optional(),
  capability: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  latestOnly: z.boolean().optional(),
  query: z.string().optional(),
})

export interface RoleFilterOptions {
  readonly roleId?: string
  readonly projectId?: string
  readonly name?: string
  readonly capability?: string
  readonly capabilities?: readonly string[]
  readonly latestOnly?: boolean
  readonly query?: string
}
