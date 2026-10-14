/**
 * Versioned Charter Repository with canonical snapshot digest and immutable core stamping.
 *
 * Implements the charter store requirements of docs/implementation-plans/aibridge-herdr-orchestration.md §10
 * and §15 (settled architecture decisions):
 *
 * 1. Profile Scope (§15 decision #1):
 *    A charter governs a PROFILE (one charter per profile id, multiple sequential versions).
 *    Role catalogs remain per-project. The charter repository is keyed by profile identifier (`charterId`),
 *    storing monotonically versioned snapshots for that machine/profile boundary.
 *
 * 2. Immutable Core Stamping (§7.3, §10):
 *    On initial creation (version 1), the charter stamps `immutableCoreDigest` computed via
 *    `computeImmutableCoreDigest(floor)` from `src/orchestration/policy/immutable-core.ts`.
 *    Once created, the immutable core digest is immutable and invariant across revisions:
 *    subsequent revisions retain the exact same `immutableCoreDigest` stamped at creation.
 *
 * 3. Canonical Snapshot Digest Discipline (§7.1, §10):
 *    Every stored version computes and stamps `snapshotDigest` via `computeCharterSnapshotDigest`.
 *    Stored charters are deep-frozen and defensive: retrieving by `(charterId, version)` returns
 *    the exact stamped document. A running dispatch keeps the version it started with.
 *    Any read from the store asserts `verifyCharterSnapshotDigest`: a tampered stored document
 *    is refused immediately with `CharterIntegrityError`.
 *
 * 4. Monotonic Versioning & Conflict Refusal (mirror of `roles/repository.ts`):
 *    - Creation stamps `version: 1`.
 *    - Revisions increment sequentially without gaps: version N -> version N + 1.
 *    - Conflicting write of an existing version with different content throws `CharterVersionConflictError`.
 *    - Idempotent re-registration of identical content returns the existing frozen document.
 *    - Unknown or invalid versions throw `InvalidCharterVersionError` or `CharterNotFoundError`.
 */

import { canonicalJson } from "../digest.js"
import { createContractError, type ContractError } from "../errors.js"
import type { Digest } from "../identifiers.js"
import { SAFETY_FLOOR } from "../policy/floor.js"
import { computeImmutableCoreDigest } from "../policy/immutable-core.js"
import type { SafetyFloor } from "../policy/types.js"
import {
  computeCharterSnapshotDigest,
  UnsupportedCharterVersionError,
  verifyCharterSnapshotDigest,
} from "../schemas.js"
import type {
  Charter,
  CharterAuthor,
  CharterRoleRef,
  CommunicationPolicy,
  EscalationPolicy,
} from "./types.js"

// ============================================================================
// Errors (Mirror of roles/repository.ts error hierarchy)
// ============================================================================

/**
 * Thrown when attempting to write an existing version of a charter with conflicting content.
 * Mirrors `RoleVersionConflictError` in `roles/repository.ts`.
 */
export class CharterVersionConflictError extends Error {
  readonly code = "charter.version_conflict" as const
  readonly category = "conflict" as const
  readonly charterId: string
  readonly version: number

  constructor(charterId: string, version: number, message?: string) {
    super(
      message ??
        `charter.version_conflict: Charter '${charterId}' version ${version} already exists with different content`,
    )
    this.name = "CharterVersionConflictError"
    this.charterId = charterId
    this.version = version
  }

  toContractError(): ContractError {
    return createContractError("conflict", this.code, this.message, false)
  }
}

/**
 * Thrown when a requested charter or charter version does not exist.
 * Mirrors `RoleNotFoundError` in `roles/repository.ts`.
 */
export class CharterNotFoundError extends Error {
  readonly code = "charter.not_found" as const
  readonly category = "validation" as const
  readonly charterId: string
  readonly version?: number

  constructor(charterId: string, version?: number, message?: string) {
    const detail = version !== undefined ? ` version ${version}` : ""
    super(message ?? `charter.not_found: Charter '${charterId}'${detail} does not exist`)
    this.name = "CharterNotFoundError"
    this.charterId = charterId
    this.version = version
  }

  toContractError(): ContractError {
    return createContractError("validation", this.code, this.message, false)
  }
}

/**
 * Thrown when an invalid or unsupported version number is supplied (non-positive, non-integer, or sequential gap).
 * Mirrors `InvalidRoleVersionError` in `roles/repository.ts` while carrying `charter.unsupported_version`
 * to align with the schema-level version error convention.
 */
export class InvalidCharterVersionError extends UnsupportedCharterVersionError {
  readonly charterId?: string

  constructor(charterId: string | undefined, version: unknown, message?: string) {
    super(
      version,
      message ??
        `charter.unsupported_version: Invalid version ${String(version)}${charterId ? ` for charter '${charterId}'` : ""}. Versions must be positive integers starting at 1`,
    )
    this.name = "InvalidCharterVersionError"
    this.charterId = charterId
  }

  toContractError(): ContractError {
    return createContractError("validation", this.code, this.message, false)
  }
}

// Re-export UnsupportedCharterVersionError from schemas for single-import convenience
export { UnsupportedCharterVersionError }
/**
 * Thrown when a stored charter fails snapshot digest verification on read.
 * Guarantees that tampered documents are refused before entering any dispatch or compilation pipeline.
 */
export class CharterIntegrityError extends Error {
  readonly code = "charter.integrity_violation" as const
  readonly category = "validation" as const
  readonly charterId: string
  readonly version: number
  readonly expectedDigest?: string
  readonly storedDigest?: string

  constructor(
    charterId: string,
    version: number,
    expectedDigest?: string,
    storedDigest?: string,
    message?: string,
  ) {
    const detail =
      expectedDigest && storedDigest ? ` (expected ${expectedDigest}, got ${storedDigest})` : ""
    super(
      message ??
        `charter.integrity_violation: Stored charter '${charterId}' version ${version} failed snapshot digest verification${detail}`,
    )
    this.name = "CharterIntegrityError"
    this.charterId = charterId
    this.version = version
    this.expectedDigest = expectedDigest
    this.storedDigest = storedDigest
  }

  toContractError(): ContractError {
    return createContractError("validation", this.code, this.message, false)
  }
}

// ============================================================================
// Types
// ============================================================================

/**
 * Input for registering or creating a charter in the repository.
 * `snapshotDigest` and `immutableCoreDigest` are computed automatically if omitted.
 */
export interface CharterInput {
  readonly charterId: string
  readonly version?: number
  readonly purpose: string
  readonly globalRules?: readonly string[]
  readonly communicationPolicy: CommunicationPolicy
  readonly escalationPolicy: EscalationPolicy
  readonly roleCatalog?: readonly CharterRoleRef[]
  readonly author?: CharterAuthor
  readonly capturedAt?: string
  readonly safetyFloor?: SafetyFloor
  readonly immutableCoreDigest?: Digest
  readonly snapshotDigest?: Digest
}

/**
 * Input for revising an existing charter.
 * Revisions monotonically increment version and retain the creation-time `immutableCoreDigest`.
 */
export interface ReviseCharterInput {
  readonly version?: number
  readonly purpose?: string
  readonly globalRules?: readonly string[]
  readonly communicationPolicy?: CommunicationPolicy
  readonly escalationPolicy?: EscalationPolicy
  readonly roleCatalog?: readonly CharterRoleRef[]
  readonly author?: CharterAuthor
  readonly capturedAt?: string
}

/**
 * Filter options for listing charters in the repository.
 */
export interface CharterFilterOptions {
  readonly charterId?: string
  readonly author?: CharterAuthor
  readonly query?: string
  readonly latestOnly?: boolean
}

// ============================================================================
// Internal Helpers
// ============================================================================

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

// ============================================================================
// Repository Implementation
// ============================================================================

/**
 * In-memory versioned repository for profile-governing charter documents.
 *
 * Scope (§15): Charters are scoped to a PROFILE identifier (`charterId`).
 * A machine profile has exactly one charter with sequential versions.
 * Dispatches bind to `(charterId, version)` snapshots that never mutate.
 */
export class CharterRepository {
  /**
   * Internal store mapping charterId (profile) -> version -> frozen Charter snapshot.
   */
  private readonly charters = new Map<string, Map<number, Charter>>()

  constructor(initialCharters?: readonly (Charter | CharterInput)[]) {
    if (initialCharters) {
      for (const charter of initialCharters) {
        this.registerCharter(charter)
      }
    }
  }

  /**
   * Registers a charter in the store.
   *
   * - If no version is specified, stamps version 1 (or maxVersion + 1 if versions exist).
   * - If version is specified, validates sequential continuity (no gaps).
   * - Computes `immutableCoreDigest` if not provided (stamped at creation; invariant across revisions).
   * - Computes canonical `snapshotDigest` via `computeCharterSnapshotDigest`.
   * - Re-registering an identical version is idempotent.
   * - Re-registering an existing version with different content throws `CharterVersionConflictError`.
   */
  registerCharter(input: CharterInput): Charter {
    const charterId = input.charterId
    if (!charterId || typeof charterId !== "string" || !charterId.trim()) {
      throw new Error("charterId must be a non-empty string")
    }

    let versionsMap = this.charters.get(charterId)
    if (!versionsMap) {
      versionsMap = new Map<number, Charter>()
      this.charters.set(charterId, versionsMap)
    }

    const requestedVersion = input.version
    let targetVersion: number

    if (requestedVersion !== undefined) {
      if (!Number.isSafeInteger(requestedVersion) || requestedVersion < 1) {
        throw new InvalidCharterVersionError(charterId, requestedVersion)
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

    // Continuity check: no gaps allowed in version sequence
    if (versionsMap.size > 0 && targetVersion > 1) {
      const maxVersion = Math.max(...versionsMap.keys())
      if (targetVersion > maxVersion + 1) {
        throw new InvalidCharterVersionError(
          charterId,
          targetVersion,
          `charter.invalid_version: Version must increment sequentially without gaps: latest is ${maxVersion}, requested ${targetVersion}`,
        )
      }
    } else if (versionsMap.size === 0 && targetVersion > 1) {
      throw new InvalidCharterVersionError(
        charterId,
        targetVersion,
        `charter.invalid_version: Initial charter version must be 1, requested ${targetVersion}`,
      )
    }

    // Determine immutableCoreDigest:
    // At creation (v1), stamp computeImmutableCoreDigest(floor).
    // On subsequent revisions, inherit from the existing root version — it NEVER changes afterwards (§7.3).
    let immutableCoreDigest: Digest
    if (versionsMap.size > 0 && versionsMap.has(1)) {
      const v1 = versionsMap.get(1)!
      immutableCoreDigest = v1.immutableCoreDigest
      if (input.immutableCoreDigest !== undefined && input.immutableCoreDigest !== immutableCoreDigest) {
        throw new Error(
          `Cannot mutate immutableCoreDigest on revision of charter '${charterId}'. Stamped core digest: ${immutableCoreDigest}, proposed: ${input.immutableCoreDigest}`,
        )
      }
    } else if (input.immutableCoreDigest) {
      immutableCoreDigest = input.immutableCoreDigest
    } else {
      const floor = input.safetyFloor ?? SAFETY_FLOOR
      immutableCoreDigest = computeImmutableCoreDigest(floor)
    }

    const capturedAt = input.capturedAt ?? new Date().toISOString()
    const author: CharterAuthor = input.author ?? "human"
    const globalRules = input.globalRules ? [...input.globalRules] : []
    const roleCatalog = input.roleCatalog
      ? input.roleCatalog.map((r) => ({
          roleId: r.roleId,
          version: r.version,
          ...(r.snapshotDigest !== undefined ? { snapshotDigest: r.snapshotDigest } : {}),
        }))
      : []

    // Pre-calculate canonical snapshot digest
    const digestPayload = {
      charterId,
      version: targetVersion,
      purpose: input.purpose,
      globalRules,
      communicationPolicy: input.communicationPolicy,
      escalationPolicy: input.escalationPolicy,
      roleCatalog,
      capturedAt,
      author,
      immutableCoreDigest,
    }

    const computedSnapshotDigest = computeCharterSnapshotDigest(digestPayload)

    // If caller provided a snapshotDigest, verify it matches
    if (input.snapshotDigest !== undefined && input.snapshotDigest !== computedSnapshotDigest) {
      throw new CharterIntegrityError(
        charterId,
        targetVersion,
        computedSnapshotDigest,
        input.snapshotDigest,
      )
    }

    const normalized: Charter = {
      charterId,
      version: targetVersion,
      purpose: input.purpose,
      globalRules: [...globalRules],
      communicationPolicy: { ...input.communicationPolicy },
      escalationPolicy: { ...input.escalationPolicy },
      roleCatalog: roleCatalog.map((r) => ({ ...r })),
      immutableCoreDigest,
      snapshotDigest: computedSnapshotDigest,
      capturedAt,
      author,
    }

    const frozenCharter = deepFreeze(normalized)

    // Check existing version
    const existing = versionsMap.get(targetVersion)
    if (existing) {
      const identical =
        existing.snapshotDigest === frozenCharter.snapshotDigest &&
        existing.immutableCoreDigest === frozenCharter.immutableCoreDigest &&
        canonicalJson(existing) === canonicalJson(frozenCharter)

      if (identical) {
        return existing
      }
      throw new CharterVersionConflictError(charterId, targetVersion)
    }

    versionsMap.set(targetVersion, frozenCharter)
    return frozenCharter
  }

  /**
   * Creates a new charter document starting at version 1.
   */
  createCharter(input: CharterInput): Charter {
    if (input.version !== undefined && input.version !== 1) {
      throw new InvalidCharterVersionError(
        input.charterId,
        input.version,
        `charter.invalid_version: Creating a new charter must stamp version 1, got ${input.version}`,
      )
    }
    return this.registerCharter({ ...input, version: 1 })
  }

  /**
   * Revises an existing charter, automatically incrementing version from latest to latest + 1.
   * Retains the creation-time immutableCoreDigest.
   */
  reviseCharter(charterId: string, updates: ReviseCharterInput): Charter {
    const latest = this.getLatestCharter(charterId)
    if (!latest) {
      throw new CharterNotFoundError(charterId)
    }

    const nextVersion = latest.version + 1
    if (updates.version !== undefined && updates.version !== nextVersion) {
      throw new InvalidCharterVersionError(
        charterId,
        updates.version,
        `charter.invalid_version: Revising charter '${charterId}' must increment version from ${latest.version} to ${nextVersion}, got ${updates.version}`,
      )
    }

    const mergedInput: CharterInput = {
      charterId,
      version: nextVersion,
      purpose: updates.purpose ?? latest.purpose,
      globalRules: updates.globalRules ?? latest.globalRules,
      communicationPolicy: updates.communicationPolicy ?? latest.communicationPolicy,
      escalationPolicy: updates.escalationPolicy ?? latest.escalationPolicy,
      roleCatalog: updates.roleCatalog ?? latest.roleCatalog,
      author: updates.author ?? latest.author,
      capturedAt: updates.capturedAt ?? new Date().toISOString(),
      // Invariant: immutable core digest stays identical to creation
      immutableCoreDigest: latest.immutableCoreDigest,
    }

    return this.registerCharter(mergedInput)
  }

  /**
   * Retrieves a charter by charterId and optional version.
   * If version is omitted, returns the latest version.
   * Refuses reads on tampered charters with CharterIntegrityError.
   */
  getCharter(charterId: string, version?: number): Charter | undefined {
    if (version !== undefined) {
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new InvalidCharterVersionError(charterId, version)
      }
    }

    const versionsMap = this.charters.get(charterId)
    if (!versionsMap || versionsMap.size === 0) return undefined

    let charter: Charter | undefined
    if (version !== undefined) {
      charter = versionsMap.get(version)
    } else {
      const maxVersion = Math.max(...versionsMap.keys())
      charter = versionsMap.get(maxVersion)
    }

    if (!charter) return undefined

    // Integrity discipline: every read verifies snapshot digest
    if (!verifyCharterSnapshotDigest(charter)) {
      throw new CharterIntegrityError(charter.charterId, charter.version)
    }

    return charter
  }

  /**
   * Retrieves a charter or throws CharterNotFoundError if it does not exist.
   */
  requireCharter(charterId: string, version?: number): Charter {
    const charter = this.getCharter(charterId, version)
    if (!charter) {
      throw new CharterNotFoundError(charterId, version)
    }
    return charter
  }

  /**
   * Returns the latest version of a charter, or undefined if none exists.
   */
  getLatestCharter(charterId: string): Charter | undefined {
    return this.getCharter(charterId)
  }

  /**
   * Checks whether a charter exists, optionally at a specific version.
   */
  hasCharter(charterId: string, version?: number): boolean {
    const versionsMap = this.charters.get(charterId)
    if (!versionsMap) return false
    if (version !== undefined) {
      return versionsMap.has(version)
    }
    return versionsMap.size > 0
  }

  /**
   * Lists all unique charterIds in sorted order.
   */
  listCharterIds(): readonly string[] {
    return Object.freeze([...this.charters.keys()].sort())
  }

  /**
   * Lists all versions for a given charterId in ascending version order.
   * Verifies integrity on each returned document.
   */
  listVersions(charterId: string): readonly Charter[] {
    const versionsMap = this.charters.get(charterId)
    if (!versionsMap) return Object.freeze([])
    const sorted = [...versionsMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, charter]) => {
        if (!verifyCharterSnapshotDigest(charter)) {
          throw new CharterIntegrityError(charter.charterId, charter.version)
        }
        return charter
      })
    return Object.freeze(sorted)
  }

  /**
   * Lists charters matching the specified filter options.
   * Verifies integrity on each returned document.
   */
  listCharters(options?: CharterFilterOptions): readonly Charter[] {
    const result: Charter[] = []

    for (const [charterId, versionsMap] of this.charters.entries()) {
      if (options?.charterId && charterId !== options.charterId) continue

      const sortedVersions = [...versionsMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, c]) => c)

      const candidates = options?.latestOnly ? sortedVersions.slice(-1) : sortedVersions

      for (const charter of candidates) {
        if (!verifyCharterSnapshotDigest(charter)) {
          throw new CharterIntegrityError(charter.charterId, charter.version)
        }
        if (options?.author && charter.author !== options.author) continue
        if (options?.query) {
          const q = options.query.toLowerCase()
          const match =
            charter.charterId.toLowerCase().includes(q) ||
            charter.purpose.toLowerCase().includes(q)
          if (!match) continue
        }
        result.push(charter)
      }
    }

    return Object.freeze(result)
  }

  /**
   * Verifies that a charter document's snapshot digest matches its content.
   */
  verifyCharter(charter: Charter): boolean {
    return verifyCharterSnapshotDigest(charter)
  }

  /**
   * Returns total number of stored charter versions across all charters.
   */
  count(): number {
    let total = 0
    for (const versionsMap of this.charters.values()) {
      total += versionsMap.size
    }
    return total
  }

  /**
   * Returns the count of distinct profile charters stored.
   */
  charterCount(): number {
    return this.charters.size
  }

  /**
   * Clears all stored charters.
   */
  clear(): void {
    this.charters.clear()
  }

  /**
   * Test-only helper to simulate storage corruption or tampering.
   * Bypasses normal hashing and stores the corrupted document directly.
   */
  _injectTamperedForTesting(tampered: Charter): void {
    let versionsMap = this.charters.get(tampered.charterId)
    if (!versionsMap) {
      versionsMap = new Map<number, Charter>()
      this.charters.set(tampered.charterId, versionsMap)
    }
    versionsMap.set(tampered.version, deepFreeze({ ...tampered }))
  }
}
