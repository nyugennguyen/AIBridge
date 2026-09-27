import type { DispatchEnvelope } from "../types.js"
import {
  SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS,
  permissionNarrowingSchema,
  safetyFloorSchema,
  type EffectivePolicyState,
  type NarrowingOutcome,
  type PermissionNarrowing,
  type PolicyLayerId,
  type SafetyFloor,
} from "./types.js"

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

/**
 * The unconditional safety floor. It is intentionally built here, outside of
 * any caller-supplied input surface, so that no project policy, role template,
 * rule, pre-approval or dispatch envelope can relax it.
 */
export const SAFETY_FLOOR: SafetyFloor = deepFreeze(
  safetyFloorSchema.parse({
    requireApprovalForDispatch: true,
    requireApprovalForDestructiveEffects: true,
    requireApprovalForExternalEffects: true,
    allowDestructiveEffects: false,
    allowExternalEffects: false,
    maximumTimeoutSeconds: SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS,
  }),
)

/** The safety floor expressed as a narrowing layer applied on top of the seed state. */
export const SAFETY_FLOOR_NARROWING: PermissionNarrowing = deepFreeze(
  permissionNarrowingSchema.parse({
    deniedCapabilities: [],
    requireApprovalForCapabilities: [],
    requireApprovalForDispatch: true,
    requireApprovalForDestructiveEffects: true,
    requireApprovalForExternalEffects: true,
    allowDestructiveEffects: false,
    allowExternalEffects: false,
    maximumTimeoutSeconds: SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS,
  }),
)

export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

function intersect(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right)
  return left.filter((value) => rightSet.has(value))
}

/**
 * The widest possible starting state: every capability the dispatch asks for is
 * permitted, no approvals are demanded, and no effect is denied. Every real
 * restriction therefore comes from a layer, which keeps the widening-attempt
 * detection honest.
 */
export function seedPolicyState(envelope: DispatchEnvelope): EffectivePolicyState {
  return {
    allowedCapabilities: sortedUnique(envelope.requestedCapabilities),
    deniedCapabilities: [],
    approvalRequiredCapabilities: [],
    dispatchApprovalDemands: [],
    requireApprovalForDestructiveEffects: false,
    requireApprovalForExternalEffects: false,
    allowDestructiveEffects: true,
    allowExternalEffects: true,
    maximumTimeoutSeconds: envelope.timeoutSeconds,
    destructiveEffectsRequested: envelope.permissionEnvelope.approvalRequirements.destructiveEffects,
    externalEffectsRequested: envelope.permissionEnvelope.approvalRequirements.externalEffects,
  }
}

/**
 * The single narrowing primitive. Every layer of the policy stack, including the
 * safety floor itself, is expressed through this function, which is why widening
 * is impossible: each field of the result is a monotone function (intersection,
 * union, `min`, logical AND, append) of the previous state and the layer.
 */
export interface NarrowingOptions {
  /**
   * Set for the safety floor only. The seed state is "no policy at all", so a
   * conflict detected while applying the very first layer is not a widening
   * attempt by a competing layer and is not reported as one.
   */
  readonly baseline?: boolean
}

export function narrowPolicyState(
  state: EffectivePolicyState,
  layerId: PolicyLayerId,
  narrowing: PermissionNarrowing,
  options?: NarrowingOptions,
): NarrowingOutcome {
  const removed: string[] = []
  const denied: string[] = []
  const wideningAttempts: string[] = []
  const isBaseline = options?.baseline === true
  const report = (message: string): void => {
    if (!isBaseline) wideningAttempts.push(message)
  }

  let allowedCapabilities = state.allowedCapabilities
  if (narrowing.allowedCapabilities !== undefined) {
    const next = intersect(allowedCapabilities, narrowing.allowedCapabilities)
    const nextSet = new Set(next)
    for (const capability of allowedCapabilities) {
      if (!nextSet.has(capability)) removed.push(capability)
    }
    const attempted = narrowing.allowedCapabilities.filter((capability) => !allowedCapabilities.includes(capability))
    if (attempted.length > 0) {
      report(
        `allowedCapabilities: layer '${layerId}' proposed ${attempted.length} capability set(s) the effective set already excludes; ignored`,
      )
    }
    allowedCapabilities = next
  }

  const deniedSet = new Set(state.deniedCapabilities)
  for (const capability of narrowing.deniedCapabilities) {
    if (!deniedSet.has(capability)) {
      deniedSet.add(capability)
      denied.push(capability)
    }
  }
  // `deniedCapabilities` is a union: no layer can shrink it, so there is no
  // widening attempt to detect here by construction.
  const deniedCapabilities = sortedUnique(deniedSet)

  let allowedAfterDenials = allowedCapabilities.filter((capability) => !deniedSet.has(capability))
  if (allowedAfterDenials.length !== allowedCapabilities.length) {
    for (const capability of allowedCapabilities) {
      if (deniedSet.has(capability) && !removed.includes(capability)) removed.push(capability)
    }
  }
  allowedCapabilities = allowedAfterDenials

  const approvalRequiredCapabilities = sortedUnique([
    ...state.approvalRequiredCapabilities,
    ...narrowing.requireApprovalForCapabilities,
  ])

  const dispatchApprovalDemands = [...state.dispatchApprovalDemands]
  // Approval demands are monotone unions. A layer declaring `false` means "this
  // layer does not demand approval", not "clear the accumulated demand", so it
  // is not reported as a widening attempt: the union already ignores it.
  if (narrowing.requireApprovalForDispatch === true && !dispatchApprovalDemands.includes(layerId)) {
    dispatchApprovalDemands.push(layerId)
  }
  const requireApprovalForDestructiveEffects = state.requireApprovalForDestructiveEffects || narrowing.requireApprovalForDestructiveEffects === true
  const requireApprovalForExternalEffects = state.requireApprovalForExternalEffects || narrowing.requireApprovalForExternalEffects === true

  let allowDestructiveEffects = state.allowDestructiveEffects
  if (narrowing.allowDestructiveEffects !== undefined) {
    const next = allowDestructiveEffects && narrowing.allowDestructiveEffects
    if (narrowing.allowDestructiveEffects && !allowDestructiveEffects) {
      report(
        `allowDestructiveEffects: layer '${layerId}' attempted to enable an effect the safety floor denies; ignored`,
      )
    }
    allowDestructiveEffects = next
  }

  let allowExternalEffects = state.allowExternalEffects
  if (narrowing.allowExternalEffects !== undefined) {
    const next = allowExternalEffects && narrowing.allowExternalEffects
    if (narrowing.allowExternalEffects && !allowExternalEffects) {
      report(
        `allowExternalEffects: layer '${layerId}' attempted to enable an effect the safety floor denies; ignored`,
      )
    }
    allowExternalEffects = next
  }

  let maximumTimeoutSeconds = state.maximumTimeoutSeconds
  if (narrowing.maximumTimeoutSeconds !== undefined) {
    if (narrowing.maximumTimeoutSeconds > maximumTimeoutSeconds) {
      report(
        `maximumTimeoutSeconds: layer '${layerId}' raised the ceiling ${maximumTimeoutSeconds} -> ${narrowing.maximumTimeoutSeconds}; ignored`,
      )
    }
    maximumTimeoutSeconds = Math.min(maximumTimeoutSeconds, narrowing.maximumTimeoutSeconds)
  }

  const next: EffectivePolicyState = {
    allowedCapabilities: sortedUnique(allowedCapabilities),
    deniedCapabilities,
    approvalRequiredCapabilities,
    dispatchApprovalDemands,
    requireApprovalForDestructiveEffects,
    requireApprovalForExternalEffects,
    allowDestructiveEffects,
    allowExternalEffects,
    maximumTimeoutSeconds,
    destructiveEffectsRequested: state.destructiveEffectsRequested,
    externalEffectsRequested: state.externalEffectsRequested,
  }

  const changed =
    next.allowedCapabilities.length !== state.allowedCapabilities.length ||
    next.deniedCapabilities.length !== state.deniedCapabilities.length ||
    next.approvalRequiredCapabilities.length !== state.approvalRequiredCapabilities.length ||
    next.dispatchApprovalDemands.length !== state.dispatchApprovalDemands.length ||
    next.requireApprovalForDestructiveEffects !== state.requireApprovalForDestructiveEffects ||
    next.requireApprovalForExternalEffects !== state.requireApprovalForExternalEffects ||
    next.allowDestructiveEffects !== state.allowDestructiveEffects ||
    next.allowExternalEffects !== state.allowExternalEffects ||
    next.maximumTimeoutSeconds !== state.maximumTimeoutSeconds

  return {
    state: next,
    removedCapabilities: sortedUnique(removed),
    deniedCapabilities: sortedUnique(denied),
    wideningAttempts,
    changed,
  }
}

/** The dispatch envelope's own restriction layer. */
export function dispatchNarrowing(envelope: DispatchEnvelope): PermissionNarrowing {
  return permissionNarrowingSchema.parse({
    allowedCapabilities: envelope.permissionEnvelope.allowedCapabilities,
    deniedCapabilities: envelope.permissionEnvelope.deniedCapabilities,
    requireApprovalForCapabilities: envelope.permissionEnvelope.approvalRequirements.capabilities,
    requireApprovalForDestructiveEffects: envelope.permissionEnvelope.approvalRequirements.destructiveEffects,
    requireApprovalForExternalEffects: envelope.permissionEnvelope.approvalRequirements.externalEffects,
    maximumTimeoutSeconds: envelope.timeoutSeconds,
  })
}
