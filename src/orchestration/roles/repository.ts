import { canonicalJson, digestJson } from "../digest.js"
import { createContractError, type ContractError } from "../errors.js"
import type { Digest } from "../identifiers.js"
import type {
  CompatibilityRequirements,
  CompatibilityResult,
  RoleFilterOptions,
  RoleSnapshot,
  RoleTemplate,
  RoleTemplateInput,
} from "./types.js"

export class RoleVersionConflictError extends Error {
  readonly code = "role.version_conflict" as const
  readonly category = "conflict" as const
  readonly roleId: string
  readonly version: number

  constructor(roleId: string, version: number, message?: string) {
    super(message ?? `role.version_conflict: Role '${roleId}' version ${version} already exists with different content`)
    this.name = "RoleVersionConflictError"
    this.roleId = roleId
    this.version = version
  }

  toContractError(): ContractError {
    return createContractError("conflict", this.code, this.message, false)
  }
}

export class RoleNotFoundError extends Error {
  readonly code = "role.not_found" as const
  readonly category = "validation" as const
  readonly roleId: string
  readonly version?: number

  constructor(roleId: string, version?: number, message?: string) {
    const detail = version !== undefined ? ` version ${version}` : ""
    super(message ?? `role.not_found: Role '${roleId}'${detail} does not exist`)
    this.name = "RoleNotFoundError"
    this.roleId = roleId
    this.version = version
  }

  toContractError(): ContractError {
    return createContractError("validation", this.code, this.message, false)
  }
}

export class InvalidRoleVersionError extends Error {
  readonly code = "role.invalid_version" as const
  readonly category = "validation" as const
  readonly roleId: string
  readonly version: number

  constructor(roleId: string, version: number, message?: string) {
    super(message ?? `role.invalid_version: Invalid version ${version} for role '${roleId}'. Versions must be positive integers starting at 1`)
    this.name = "InvalidRoleVersionError"
    this.roleId = roleId
    this.version = version
  }

  toContractError(): ContractError {
    return createContractError("validation", this.code, this.message, false)
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value
  Object.freeze(value)
  for (const key of Object.keys(value)) {
    const prop = (value as Record<string, unknown>)[key]
    if (prop !== null && typeof prop === "object" && !Object.isFrozen(prop)) {
      deepFreeze(prop)
    }
  }
  return value
}

export function computeRoleSnapshotDigest(snapshot: {
  roleId: string
  version: number
  capabilities: readonly string[]
  rules?: readonly unknown[]
}): Digest {
  return digestJson({
    capabilities: [...snapshot.capabilities],
    roleId: snapshot.roleId,
    rules: snapshot.rules ? [...snapshot.rules] : [],
    version: snapshot.version,
  })
}

export function verifySnapshotDigest(snapshot: RoleSnapshot): boolean {
  try {
    const expected = computeRoleSnapshotDigest(snapshot)
    return expected === snapshot.snapshotDigest
  } catch {
    return false
  }
}

function normalizeRoleTemplate(input: RoleTemplateInput, explicitVersion?: number): RoleTemplate {
  const version = explicitVersion ?? input.version ?? input.templateVersion ?? 1
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new InvalidRoleVersionError(input.roleId, version)
  }

  const name = input.name ? input.name.trim() : ""
  if (!name) {
    throw new Error(`Role '${input.roleId}' name must not be empty`)
  }

  const description = input.description ?? input.purpose ?? ""
  const rawCapabilities = input.capabilities ?? input.requiredCapabilities ?? []
  const capabilities = [...new Set(rawCapabilities.map((c) => c.trim()).filter(Boolean))]
  const rules = input.rules ?? []
  const metadata = input.metadata ?? {}
  const createdAt = input.createdAt ?? new Date().toISOString()
  const schemaVersion = input.schemaVersion ?? 1

  const template: RoleTemplate = {
    roleId: input.roleId,
    version,
    templateVersion: version,
    name,
    description,
    purpose: description,
    capabilities: Object.freeze([...capabilities]),
    requiredCapabilities: Object.freeze([...capabilities]),
    rules: deepFreeze([...rules]),
    metadata: deepFreeze({ ...metadata }),
    createdAt,
    schemaVersion,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
    ...(input.author !== undefined ? { author: deepFreeze(input.author) } : {}),
    ...(input.permissionRestrictions !== undefined ? { permissionRestrictions: deepFreeze(input.permissionRestrictions) } : {}),
    ...(input.contextSelectionPolicyReference !== undefined ? { contextSelectionPolicyReference: deepFreeze(input.contextSelectionPolicyReference) } : {}),
    ...(input.preferredRuntimeKinds !== undefined ? { preferredRuntimeKinds: Object.freeze([...input.preferredRuntimeKinds]) } : {}),
  }

  return Object.freeze(template)
}

function areTemplatesEqual(existing: RoleTemplate, incoming: RoleTemplate): boolean {
  if (existing.roleId !== incoming.roleId) return false
  if (existing.version !== incoming.version) return false
  if (existing.name !== incoming.name) return false
  if (existing.description !== incoming.description) return false

  if (existing.capabilities.length !== incoming.capabilities.length) return false
  for (let i = 0; i < existing.capabilities.length; i++) {
    if (existing.capabilities[i] !== incoming.capabilities[i]) return false
  }

  if (canonicalJson(existing.rules) !== canonicalJson(incoming.rules)) return false
  if (canonicalJson(existing.metadata) !== canonicalJson(incoming.metadata)) return false

  if (incoming.projectId !== undefined && existing.projectId !== incoming.projectId) return false
  if (incoming.instructions !== undefined && existing.instructions !== incoming.instructions) return false

  if (incoming.preferredRuntimeKinds !== undefined) {
    if (canonicalJson(existing.preferredRuntimeKinds ?? []) !== canonicalJson(incoming.preferredRuntimeKinds)) return false
  }

  if (incoming.permissionRestrictions !== undefined) {
    if (canonicalJson(existing.permissionRestrictions) !== canonicalJson(incoming.permissionRestrictions)) return false
  }

  if (incoming.author !== undefined) {
    if (canonicalJson(existing.author) !== canonicalJson(incoming.author)) return false
  }

  return true
}

export function validateCompatibility(
  snapshot: RoleSnapshot,
  requirements: CompatibilityRequirements | readonly string[],
): CompatibilityResult {
  const reqObj: CompatibilityRequirements = Array.isArray(requirements)
    ? { requiredCapabilities: requirements as readonly string[] }
    : (requirements as CompatibilityRequirements)

  const roleCaps = new Set(snapshot.capabilities)
  const satisfied: string[] = []
  const missing: string[] = []
  const prohibited: string[] = []
  const reasons: string[] = []

  const required = reqObj.requiredCapabilities ?? []
  for (const cap of required) {
    if (roleCaps.has(cap)) {
      satisfied.push(cap)
    } else {
      missing.push(cap)
      reasons.push(`Missing required capability: '${cap}'`)
    }
  }

  const denied = new Set(reqObj.deniedCapabilities ?? [])
  for (const cap of snapshot.capabilities) {
    if (denied.has(cap)) {
      prohibited.push(cap)
      reasons.push(`Role grants prohibited capability: '${cap}'`)
    }
  }

  if (reqObj.allowedCapabilities && reqObj.allowedCapabilities.length > 0) {
    const allowed = new Set(reqObj.allowedCapabilities)
    for (const cap of snapshot.capabilities) {
      if (!allowed.has(cap)) {
        if (!prohibited.includes(cap)) prohibited.push(cap)
        reasons.push(`Role capability '${cap}' exceeds allowed capability ceiling`)
      }
    }
  }

  for (const rule of snapshot.rules) {
    if (typeof rule === "object" && rule !== null) {
      const r = rule as Record<string, unknown>
      if (r.enabled !== false && typeof r.effect === "object" && r.effect !== null) {
        const effect = r.effect as Record<string, unknown>
        if (effect.kind === "restrict" && Array.isArray(effect.deniedCapabilities)) {
          for (const deniedCap of effect.deniedCapabilities as string[]) {
            if (required.includes(deniedCap)) {
              if (!missing.includes(deniedCap)) missing.push(deniedCap)
              const ruleId = typeof r.ruleId === "string" ? r.ruleId : "anonymous"
              reasons.push(`Capability '${deniedCap}' is restricted by role rule '${ruleId}'`)
            }
          }
        }
      }
      if (r.enabled !== false && Array.isArray(r.deniedCapabilities)) {
        for (const deniedCap of r.deniedCapabilities as string[]) {
          if (required.includes(deniedCap)) {
            if (!missing.includes(deniedCap)) missing.push(deniedCap)
            const ruleName = typeof r.name === "string" ? r.name : (typeof r.ruleId === "string" ? r.ruleId : "anonymous")
            reasons.push(`Capability '${deniedCap}' is denied by rule '${ruleName}'`)
          }
        }
      }
    } else if (typeof rule === "string") {
      if (rule.startsWith("deny:") || rule.startsWith("restrict:")) {
        const deniedCap = rule.slice(rule.indexOf(":") + 1)
        if (required.includes(deniedCap)) {
          if (!missing.includes(deniedCap)) missing.push(deniedCap)
          reasons.push(`Capability '${deniedCap}' is denied by string rule '${rule}'`)
        }
      }
    }
  }

  const uniqueMissing = [...new Set(missing)]
  const uniqueProhibited = [...new Set(prohibited)]
  const uniqueSatisfied = [...new Set(satisfied.filter((c) => !uniqueMissing.includes(c)))]
  const uniqueReasons = [...new Set(reasons)]

  const compatible = uniqueMissing.length === 0 && uniqueProhibited.length === 0 && uniqueReasons.length === 0

  return {
    compatible,
    ok: compatible,
    satisfiedCapabilities: Object.freeze(uniqueSatisfied),
    missingCapabilities: Object.freeze(uniqueMissing),
    prohibitedCapabilities: Object.freeze(uniqueProhibited),
    reasons: Object.freeze(uniqueReasons),
    errors: Object.freeze(uniqueReasons),
  }
}

export class RoleRepository {
  private readonly roles = new Map<string, Map<number, RoleTemplate>>()

  constructor(initialRoles?: readonly (RoleTemplate | RoleTemplateInput)[]) {
    if (initialRoles) {
      for (const role of initialRoles) {
        this.registerRole(role)
      }
    }
  }

  registerRole(input: RoleTemplateInput): RoleTemplate {
    const roleId = input.roleId
    if (!roleId || typeof roleId !== "string" || !roleId.trim()) {
      throw new Error("roleId must be a non-empty string")
    }

    let versionsMap = this.roles.get(roleId)
    if (!versionsMap) {
      versionsMap = new Map<number, RoleTemplate>()
      this.roles.set(roleId, versionsMap)
    }

    const requestedVersion = input.version ?? input.templateVersion
    let targetVersion: number

    if (requestedVersion !== undefined) {
      if (!Number.isSafeInteger(requestedVersion) || requestedVersion < 1) {
        throw new InvalidRoleVersionError(roleId, requestedVersion)
      }
      targetVersion = requestedVersion
    } else {
      if (versionsMap.size === 0) {
        targetVersion = 1
      } else {
        const maxVersion = Math.max(...versionsMap.keys())
        targetVersion = maxVersion + 1
      }
    }

    const normalized = normalizeRoleTemplate(input, targetVersion)

    const existing = versionsMap.get(targetVersion)
    if (existing) {
      if (areTemplatesEqual(existing, normalized)) {
        return existing
      }
      throw new RoleVersionConflictError(roleId, targetVersion)
    }

    if (versionsMap.size > 0 && targetVersion > 1) {
      const maxVersion = Math.max(...versionsMap.keys())
      if (targetVersion > maxVersion + 1) {
        throw new InvalidRoleVersionError(
          roleId,
          targetVersion,
          `role.invalid_version: Version must increment sequentially without gaps: latest is ${maxVersion}, requested ${targetVersion}`,
        )
      }
    }

    versionsMap.set(targetVersion, normalized)
    return normalized
  }

  createRole(input: RoleTemplateInput): RoleTemplate {
    return this.registerRole(input)
  }

  updateRole(roleId: string, updates: Partial<RoleTemplateInput>): RoleTemplate {
    const latest = this.getLatestRole(roleId)
    if (!latest) {
      throw new RoleNotFoundError(roleId)
    }

    const nextVersion = latest.version + 1
    if (updates.version !== undefined && updates.version !== nextVersion) {
      throw new InvalidRoleVersionError(
        roleId,
        updates.version,
        `role.invalid_version: Updating role '${roleId}' must increment version from ${latest.version} to ${nextVersion}, got ${updates.version}`,
      )
    }

    const mergedInput: RoleTemplateInput = {
      roleId,
      version: nextVersion,
      name: updates.name ?? latest.name,
      description: updates.description ?? updates.purpose ?? latest.description,
      capabilities: updates.capabilities ?? updates.requiredCapabilities ?? latest.capabilities,
      rules: updates.rules ?? latest.rules,
      metadata: { ...latest.metadata, ...(updates.metadata ?? {}) },
      createdAt: updates.createdAt ?? new Date().toISOString(),
      projectId: updates.projectId ?? latest.projectId,
      instructions: updates.instructions ?? latest.instructions,
      author: updates.author ?? latest.author,
      permissionRestrictions: updates.permissionRestrictions ?? latest.permissionRestrictions,
      contextSelectionPolicyReference: updates.contextSelectionPolicyReference ?? latest.contextSelectionPolicyReference,
      preferredRuntimeKinds: updates.preferredRuntimeKinds ?? latest.preferredRuntimeKinds,
    }

    return this.registerRole(mergedInput)
  }

  getRole(roleId: string, version?: number): RoleTemplate | undefined {
    const versionsMap = this.roles.get(roleId)
    if (!versionsMap || versionsMap.size === 0) return undefined

    if (version !== undefined) {
      return versionsMap.get(version)
    }

    const maxVersion = Math.max(...versionsMap.keys())
    return versionsMap.get(maxVersion)
  }

  requireRole(roleId: string, version?: number): RoleTemplate {
    const role = this.getRole(roleId, version)
    if (!role) {
      throw new RoleNotFoundError(roleId, version)
    }
    return role
  }

  getLatestRole(roleId: string): RoleTemplate | undefined {
    return this.getRole(roleId)
  }

  hasRole(roleId: string, version?: number): boolean {
    const versionsMap = this.roles.get(roleId)
    if (!versionsMap) return false
    if (version !== undefined) {
      return versionsMap.has(version)
    }
    return versionsMap.size > 0
  }

  listRoleIds(): readonly string[] {
    return Object.freeze([...this.roles.keys()].sort())
  }

  listVersions(roleId: string): readonly RoleTemplate[] {
    const versionsMap = this.roles.get(roleId)
    if (!versionsMap) return Object.freeze([])
    const sorted = [...versionsMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, template]) => template)
    return Object.freeze(sorted)
  }

  listRoles(options?: RoleFilterOptions): readonly RoleTemplate[] {
    const result: RoleTemplate[] = []

    for (const [roleId, versionsMap] of this.roles.entries()) {
      if (options?.roleId && roleId !== options.roleId) continue

      const sortedVersions = [...versionsMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, t]) => t)

      const candidates = options?.latestOnly
        ? sortedVersions.slice(-1)
        : sortedVersions

      for (const template of candidates) {
        if (options?.projectId && template.projectId !== options.projectId) continue
        if (options?.name && !template.name.toLowerCase().includes(options.name.toLowerCase())) continue
        if (options?.capability && !template.capabilities.includes(options.capability)) continue
        if (options?.capabilities && !options.capabilities.every((c) => template.capabilities.includes(c))) continue
        if (options?.query) {
          const q = options.query.toLowerCase()
          const match =
            template.roleId.toLowerCase().includes(q) ||
            template.name.toLowerCase().includes(q) ||
            template.description.toLowerCase().includes(q)
          if (!match) continue
        }
        result.push(template)
      }
    }

    return Object.freeze(result)
  }

  createSnapshot(roleId: string, version?: number, options?: { capturedAt?: string }): RoleSnapshot {
    const template = version !== undefined ? this.getRole(roleId, version) : this.getLatestRole(roleId)
    if (!template) {
      throw new RoleNotFoundError(roleId, version)
    }

    const capturedAt = options?.capturedAt ?? template.createdAt
    const snapshotDigest = computeRoleSnapshotDigest({
      roleId: template.roleId,
      version: template.version,
      capabilities: template.capabilities,
      rules: template.rules,
    })

    const snapshot: RoleSnapshot = {
      roleId: template.roleId,
      version: template.version,
      snapshotDigest,
      capabilities: Object.freeze([...template.capabilities]),
      rules: deepFreeze([...template.rules]),
      capturedAt,
      name: template.name,
      description: template.description,
      metadata: deepFreeze({ ...template.metadata }),
      templateVersion: template.version,
      requiredCapabilities: Object.freeze([...template.capabilities]),
    }

    return Object.freeze(snapshot)
  }

  getSnapshot(roleId: string, version?: number): RoleSnapshot {
    return this.createSnapshot(roleId, version)
  }

  verifySnapshot(snapshot: RoleSnapshot): boolean {
    return verifySnapshotDigest(snapshot)
  }

  validateCompatibility(snapshot: RoleSnapshot, requirements: CompatibilityRequirements | readonly string[]): CompatibilityResult {
    return validateCompatibility(snapshot, requirements)
  }

  count(): number {
    let total = 0
    for (const versionsMap of this.roles.values()) {
      total += versionsMap.size
    }
    return total
  }

  roleCount(): number {
    return this.roles.size
  }

  clear(): void {
    this.roles.clear()
  }
}
