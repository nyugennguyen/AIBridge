/**
 * RoleBinder: Deterministic Prompt Compilation and Tool Policy Binding
 *
 * Implements docs/implementation-plans/aibridge-herdr-orchestration.md:
 * - §7.1: Deterministic compilation
 *     `system = Charter(v).globalRules + primaryRole.instructions + Σ secondaryRole.addendum + Charter(v).communicationPolicy + taskPrompt`
 *     Stamped with `charterDigest + roleDigests + ruleDigests`.
 * - §10 Phase 1: RoleBinder (RoleTemplate → runtime kind + system prompt + tool policy)
 * - §11 Acceptance: Byte-identical output for same inputs; digest stamping; order independence
 *   via canonicalizeRoleAssignments; hard-cap budget refusal on Σ secondary addenda.
 *
 * Single Compiler Discipline:
 * Absorbs the inline secondary-addendum assembly previously duplicated across
 * `opencode-adapter.ts`, `claude-adapter.ts`, and `codex-adapter.ts`. All three adapters
 * route prompt assembly and tool policy derivation through this module.
 */

import { createHash } from "node:crypto"
import { canonicalJson, digestJson } from "../orchestration/digest.js"
import { createContractError, type ContractError } from "../orchestration/errors.js"
import { digestSchema, type Digest } from "../orchestration/identifiers.js"
import {
  canonicalizeRoleAssignments,
  computeRoleAssignmentsDigest,
  type RoleAssignment,
} from "../orchestration/schemas.js"
import { computeRoleSnapshotDigest } from "../orchestration/roles/repository.js"
import type { RoleSnapshot, RoleTemplate } from "../orchestration/roles/types.js"
import type { RoleTemplate as EnvelopeRoleTemplate } from "../orchestration/types.js"

export type BinderRoleInput = RoleTemplate | RoleSnapshot | EnvelopeRoleTemplate
import type { Charter, CommunicationPolicy } from "../orchestration/charter/types.js"
import type { LaunchAgentRequest } from "./schemas.js"
import { computeCapabilityEnvelope } from "./opencode-adapter.js"
import type { ComputedCapabilityEnvelope } from "./types.js"
import type { OpencodePromptPolicy } from "../opencode/types.js"

// ============================================================================
// Constants and Limits (plan §7.1, §10)
// ============================================================================

/**
 * Hard cap on the cumulative byte size of all secondary role addenda combined
 * in a single prompt compilation (plan §7.1: "Σ secondaryRole.addendum (bounded budget, hard cap)").
 *
 * WHY this exists separately and explicitly:
 * An individual role addendum is bounded by `TEXT_MAX` (4,096 bytes) per
 * `roleAssignmentSchema`. Across all secondary roles assigned to an agent,
 * the cumulative addenda budget is strictly capped to 16,384 bytes (16 KiB = 4 * TEXT_MAX)
 * to prevent prompt bloat, LLM context dilution, and accidental instruction override.
 *
 * Exceeding this budget REFUSES compilation immediately with `RoleAddendaBudgetExceededError`.
 * Compilation NEVER silently truncates or drops secondary addenda.
 */
export const MAX_SECONDARY_ADDENDA_BYTES = 16_384


/**
 * Live agent runtime kinds supported by AIBridge (plan §10).
 */
export const LIVE_RUNTIME_KINDS = ["opencode", "claude", "codex"] as const

export type LiveRuntimeKind = (typeof LIVE_RUNTIME_KINDS)[number]

// ============================================================================
// Errors
// ============================================================================

/**
 * Thrown when cumulative secondary role addenda exceed `MAX_SECONDARY_ADDENDA_BYTES`.
 * Refusal is strict: compilation never truncates silently.
 */
export class RoleAddendaBudgetExceededError extends Error {
  readonly code = "binder.addenda_budget_exceeded" as const
  readonly category = "validation" as const
  readonly totalBytes: number
  readonly maxBytes: number

  constructor(totalBytes: number, maxBytes: number, message?: string) {
    super(
      message ??
        `binder.addenda_budget_exceeded: Cumulative secondary addenda size (${totalBytes} bytes) exceeds maximum hard cap (${maxBytes} bytes)`,
    )
    this.name = "RoleAddendaBudgetExceededError"
    this.totalBytes = totalBytes
    this.maxBytes = maxBytes
  }

  toContractError(): ContractError {
    return createContractError("validation", this.code, this.message, false)
  }
}

/**
 * Thrown when a role template's `preferredRuntimeKinds` cannot be resolved to any
 * live runtime kind supported by the engine.
 */
export class UnresolvableRuntimeKindError extends Error {
  readonly code = "binder.unresolvable_runtime_kind" as const
  readonly category = "unsupported_capability" as const
  readonly roleId: string
  readonly preferredRuntimeKinds: readonly string[]

  constructor(roleId: string, preferredRuntimeKinds: readonly string[], message?: string) {
    super(
      message ??
        `binder.unresolvable_runtime_kind: Role '${roleId}' preferred runtime kinds [${preferredRuntimeKinds.join(", ")}] could not be resolved to any live runtime kind (opencode, claude, codex)`,
    )
    this.name = "UnresolvableRuntimeKindError"
    this.roleId = roleId
    this.preferredRuntimeKinds = Object.freeze([...preferredRuntimeKinds])
  }

  toContractError(): ContractError {
    return createContractError("unsupported_capability", this.code, this.message, false)
  }
}

// ============================================================================
// Tool Policy Types per Runtime Kind
// ============================================================================

export interface BaseToolPolicy {
  readonly runtimeKind: LiveRuntimeKind
  readonly allowedCapabilities: readonly string[]
  readonly deniedCapabilities: readonly string[]
}

export interface OpencodeToolPolicy extends BaseToolPolicy {
  readonly runtimeKind: "opencode"
  readonly tools: Readonly<Record<string, boolean>>
}

export interface ClaudeToolPolicy extends BaseToolPolicy {
  readonly runtimeKind: "claude"
  readonly tools?: Readonly<Record<string, boolean>>
}

export interface CodexToolPolicy extends BaseToolPolicy {
  readonly runtimeKind: "codex"
  readonly sandbox: "workspace-write" | "read-only"
}

export type RuntimeToolPolicy =
  | OpencodeToolPolicy
  | ClaudeToolPolicy
  | CodexToolPolicy

// ============================================================================
// Compilation Types
// ============================================================================

export interface CompiledPrompt {
  readonly systemPrompt: string
  readonly taskPrompt?: string
  readonly runtimeKind: LiveRuntimeKind
  readonly toolPolicy: RuntimeToolPolicy
  readonly charterDigest?: Digest
  readonly roleDigests: readonly Digest[]
  readonly ruleDigests: readonly Digest[]
  readonly promptDigest: Digest
  readonly compositeDigest: Digest
}

export interface BinderCompileOptions {
  /**
   * The primary role template or snapshot.
   */
  readonly primaryRole: BinderRoleInput

  /**
   * Optional secondary role templates or snapshots.
   */
  readonly secondaryRoles?: readonly BinderRoleInput[]

  /**
   * Complete role assignments array defining primary/secondary status and addenda.
   */
  readonly roleAssignments?: readonly RoleAssignment[]

  /**
   * Active charter document (plan §7.1).
   */
  readonly charter?:
    | Charter
    | {
        readonly charterId?: string
        readonly version?: number
        readonly globalRules?: readonly string[]
        readonly communicationPolicy?: CommunicationPolicy | string
        readonly snapshotDigest?: Digest
      }

  /**
   * Rule snapshots contributing active restrictions and rule digests.
   */
  readonly ruleSnapshots?: readonly {
    readonly ruleId: string
    readonly templateVersion?: number
    readonly enabled?: boolean
    readonly effect?: unknown
    readonly snapshotDigest?: Digest
  }[]

  /**
   * The dispatch or task prompt text.
   */
  readonly taskPrompt?: string

  /**
   * Explicit target runtime kind. If omitted, resolved from `preferredRuntimeKinds`.
   */
  readonly runtimeKind?: string

  /**
   * Requested capability list and permission envelope for computing capability envelope.
   */
  readonly requestedCapabilities?: readonly string[]
  readonly permissionEnvelope?: {
    readonly allowedCapabilities: readonly string[]
    readonly deniedCapabilities: readonly string[]
  }

}

// ============================================================================
// Helpers: Addenda Extraction, Runtime Resolution, Formatting
// ============================================================================

/**
 * Hashes a string using UTF-8 encoding and returns a valid `Digest`.
 */
export function digestString(text: string): Digest {
  const hex = createHash("sha256").update(text, "utf8").digest("hex")
  return digestSchema.parse(`sha256:${hex}`)
}

/**
 * Extracts and canonicalizes secondary role addenda from an assignment set (plan §7.1).
 *
 * Invariants:
 * 1. Secondaries contribute addenda ONLY (primary role instructions are distinct).
 * 2. Order is canonicalized via `canonicalizeRoleAssignments` (stable, lexicographical by roleId).
 * 3. Total byte size across all secondary addenda must not exceed `maxBytes`.
 *    Exceeding the cap throws `RoleAddendaBudgetExceededError` (never silently truncates).
 */
export function extractCanonicalSecondaryAddenda(
  assignments?: readonly RoleAssignment[],
): readonly string[] {
  if (!assignments || assignments.length === 0) {
    return Object.freeze([])
  }

  // Canonicalize order: primary first, secondaries sorted by roleId ascending
  const canonical = canonicalizeRoleAssignments(assignments)

  const addenda: string[] = []
  let totalBytes = 0

  for (const item of canonical) {
    if (!item.primary && item.addendum && item.addendum.trim().length > 0) {
      const byteLength = Buffer.byteLength(item.addendum, "utf8")
      totalBytes += byteLength
      if (totalBytes > MAX_SECONDARY_ADDENDA_BYTES) {
        throw new RoleAddendaBudgetExceededError(totalBytes, MAX_SECONDARY_ADDENDA_BYTES)
      }
      addenda.push(item.addendum)
    }
  }

  return Object.freeze(addenda)
}

/**
 * Resolves the target runtime kind from role template preferences and optional explicit request.
 *
 * Evaluation:
 * 1. If explicit `requestedKind` is provided and supported, use it.
 * 2. Otherwise scan `role.preferredRuntimeKinds` in declared order and pick the first
 *    supported live kind (opencode, claude, codex).
 * 3. If preferences are declared but none are supported, throws `UnresolvableRuntimeKindError`.
 * 4. If no preferences are declared, defaults to "opencode".
 */
export function resolveRuntimeKind(
  role: { readonly roleId?: string; readonly preferredRuntimeKinds?: readonly string[] },
  requestedKind?: string,
): LiveRuntimeKind {
  if (requestedKind && LIVE_RUNTIME_KINDS.includes(requestedKind as LiveRuntimeKind)) {
    return requestedKind as LiveRuntimeKind
  }

  if (role.preferredRuntimeKinds && role.preferredRuntimeKinds.length > 0) {
    for (const kind of role.preferredRuntimeKinds) {
      if (LIVE_RUNTIME_KINDS.includes(kind as LiveRuntimeKind)) {
        return kind as LiveRuntimeKind
      }
    }
    throw new UnresolvableRuntimeKindError(
      role.roleId ?? "unknown",
      role.preferredRuntimeKinds,
    )
  }

  return "opencode"
}

/**
 * Formats a charter's global rules into a clean string representation.
 */
export function formatCharterGlobalRules(rules: readonly string[]): string {
  return rules
    .map((rule) => rule.trim())
    .filter((rule) => rule.length > 0)
    .join("\n")
}

/**
 * Formats a charter's communication policy into a deterministic prompt section.
 */
export function formatCommunicationPolicy(policy: CommunicationPolicy | string): string {
  if (typeof policy === "string") return policy
  const parts: string[] = [
    `Turn-taking: ${policy.turnTaking}`,
    `Verbosity: ${policy.verbosity}`,
  ]
  if (policy.objectionRequiredBefore && policy.objectionRequiredBefore.length > 0) {
    parts.push(`Objection required before: ${policy.objectionRequiredBefore.join(", ")}`)
  }
  if (policy.mustStopAndAsk && policy.mustStopAndAsk.length > 0) {
    parts.push(`Must stop and ask: ${policy.mustStopAndAsk.join(", ")}`)
  }
  if (policy.objectionMustContain && policy.objectionMustContain.length > 0) {
    parts.push(`Objection must contain: ${policy.objectionMustContain.join(", ")}`)
  }
  return parts.join("\n")
}

/**
 * Core deterministic compilation formula (plan §7.1):
 * `system = Charter(v).globalRules + primaryRole.instructions + Σ secondaryRole.addendum + Charter(v).communicationPolicy + taskPrompt`
 */
export function compileSystemPrompt(options: {
  readonly charter?: {
    readonly globalRules?: readonly string[]
    readonly communicationPolicy?: CommunicationPolicy | string
  }
  readonly primaryRoleInstructions?: string
  readonly secondaryAddenda?: readonly string[]
  readonly taskPrompt?: string
}): string {
  const parts: string[] = []

  if (options.charter?.globalRules && options.charter.globalRules.length > 0) {
    const rulesStr = formatCharterGlobalRules(options.charter.globalRules)
    if (rulesStr.trim().length > 0) {
      parts.push(rulesStr)
    }
  }

  if (options.primaryRoleInstructions && options.primaryRoleInstructions.trim().length > 0) {
    parts.push(options.primaryRoleInstructions)
  }

  if (options.secondaryAddenda && options.secondaryAddenda.length > 0) {
    for (const addendum of options.secondaryAddenda) {
      if (addendum.trim().length > 0) {
        parts.push(addendum)
      }
    }
  }

  if (options.charter?.communicationPolicy) {
    const commStr = formatCommunicationPolicy(options.charter.communicationPolicy)
    if (commStr.trim().length > 0) {
      parts.push(commStr)
    }
  }

  if (options.taskPrompt && options.taskPrompt.trim().length > 0) {
    parts.push(options.taskPrompt)
  }

  return parts.join("\n\n")
}

// ============================================================================
// Tool Policy Derivation
// ============================================================================

export function computeRuntimeToolPolicy(
  runtimeKind: LiveRuntimeKind,
  envelope: ComputedCapabilityEnvelope,
): RuntimeToolPolicy {
  switch (runtimeKind) {
    case "opencode":
      return {
        runtimeKind: "opencode",
        tools: envelope.tools,
        allowedCapabilities: envelope.allowed,
        deniedCapabilities: envelope.denied,
      }
    case "claude":
      return {
        runtimeKind: "claude",
        tools: envelope.tools,
        allowedCapabilities: envelope.allowed,
        deniedCapabilities: envelope.denied,
      }
    case "codex":
      return {
        runtimeKind: "codex",
        sandbox: envelope.allowedSet.has("filesystem.write") ? "workspace-write" : "read-only",
        allowedCapabilities: envelope.allowed,
        deniedCapabilities: envelope.denied,
      }
  }
}

// ============================================================================
// Main Compiler: RoleBinder
// ============================================================================

export class RoleBinder {
  static readonly MAX_SECONDARY_ADDENDA_BYTES = MAX_SECONDARY_ADDENDA_BYTES
  static readonly LIVE_RUNTIME_KINDS = LIVE_RUNTIME_KINDS

  /**
   * Deterministic RoleBinder compilation (plan §7.1 + §10).
   *
   * 1. Resolves target runtime kind from role template preferences.
   * 2. Canonicalizes secondary addenda in stable lexicographical order, enforcing hard cap.
   * 3. Compiles system prompt according to §7.1 composition:
   *    `Charter(v).globalRules + primaryRole.instructions + Σ secondaryRole.addendum + Charter(v).communicationPolicy + taskPrompt`
   * 4. Computes runtime tool policy (tools map for opencode, sandbox mode for codex, capabilities for claude).
   * 5. Stamps output with charterDigest, roleDigests, ruleDigests, promptDigest, and compositeDigest.
   */
  static compile(options: BinderCompileOptions): CompiledPrompt {
    const primary = options.primaryRole
    if (!primary) {
      throw new Error("RoleBinder.compile requires primaryRole")
    }

    const runtimeKind = resolveRuntimeKind(primary, options.runtimeKind)

    // Canonicalize secondary addenda with hard cap enforcement
    const secondaryAddenda = extractCanonicalSecondaryAddenda(options.roleAssignments)

    const taskPrompt = options.taskPrompt

    // Deterministic §7.1 prompt composition
    const systemPrompt = compileSystemPrompt({
      charter: options.charter
        ? {
            globalRules: options.charter.globalRules,
            communicationPolicy: options.charter.communicationPolicy,
          }
        : undefined,
      primaryRoleInstructions:
        "instructions" in primary && typeof primary.instructions === "string"
          ? primary.instructions
          : undefined,
      secondaryAddenda,
      taskPrompt,
    })

    // Prepare role array for capability envelope computation
    const secondaryList = options.secondaryRoles ?? []
    const allRoles = [primary, ...secondaryList]

    // Compute effective capability envelope
    const primaryAny = primary as unknown as Record<string, unknown>
    const envelopeInput = {
      requestedCapabilities:
        options.requestedCapabilities ??
        (primaryAny.capabilities as string[] | undefined) ??
        (primaryAny.requiredCapabilities as string[] | undefined) ??
        [],
      permissionEnvelope:
        options.permissionEnvelope ??
        (primaryAny.permissionRestrictions as
          | { allowedCapabilities: string[]; deniedCapabilities: string[] }
          | undefined) ?? {
          allowedCapabilities: [],
          deniedCapabilities: [],
        },
      ruleSnapshots: options.ruleSnapshots?.map((r) => ({
        enabled: r.enabled ?? true,
        effect: (r.effect as { kind: string; deniedCapabilities?: string[] }) ?? { kind: "allow" },
      })),
      roles: allRoles.map((r) => {
        const rAny = r as unknown as Record<string, unknown>
        return {
          roleId: r.roleId,
          name: (rAny.name as string) ?? r.roleId,
          instructions:
            "instructions" in r && typeof r.instructions === "string"
              ? r.instructions
              : undefined,
          permissionRestrictions: (rAny.permissionRestrictions as {
            allowedCapabilities: string[]
            deniedCapabilities: string[]
            compositionMode?: string
          }) ?? {
            allowedCapabilities: [],
            deniedCapabilities: [],
          },
        }
      }),
      roleAssignments: options.roleAssignments,
    }

    const computedEnvelope = computeCapabilityEnvelope(envelopeInput)
    const toolPolicy = computeRuntimeToolPolicy(runtimeKind, computedEnvelope)

    // Digest stamping discipline (plan §7.1)
    let charterDigest: Digest | undefined
    if (options.charter) {
      charterDigest = options.charter.snapshotDigest ?? digestJson(options.charter)
    }

    const roleDigests: Digest[] = []
    for (const r of allRoles) {
      const rAny = r as unknown as Record<string, unknown>
      if (typeof rAny.snapshotDigest === "string" && rAny.snapshotDigest.startsWith("sha256:")) {
        roleDigests.push(rAny.snapshotDigest as Digest)
      } else {
        const rawCapabilities = (rAny.capabilities as string[]) ?? (rAny.requiredCapabilities as string[]) ?? []
        const version = (rAny.version as number) ?? (rAny.templateVersion as number) ?? 1
        const rules = (rAny.rules as unknown[]) ?? []
        roleDigests.push(
          computeRoleSnapshotDigest({
            roleId: r.roleId,
            version,
            capabilities: rawCapabilities,
            rules,
          }),
        )
      }
    }

    const ruleDigests: Digest[] = []
    if (options.ruleSnapshots) {
      for (const rule of options.ruleSnapshots) {
        if (rule.snapshotDigest) {
          ruleDigests.push(rule.snapshotDigest)
        } else {
          ruleDigests.push(
            digestJson({
              ruleId: rule.ruleId,
              templateVersion: rule.templateVersion ?? 1,
              effect: rule.effect,
            }),
          )
        }
      }
    }
    const promptDigest = digestString(systemPrompt)

    const compositePayload: Record<string, unknown> = {
      promptDigest,
      roleDigests: [...roleDigests],
      ruleDigests: [...ruleDigests],
      ...(charterDigest !== undefined ? { charterDigest } : {}),
    }

    const compositeDigest = digestJson(compositePayload)

    return {
      systemPrompt,
      ...(taskPrompt !== undefined ? { taskPrompt } : {}),
      runtimeKind,
      toolPolicy,
      ...(charterDigest !== undefined ? { charterDigest } : {}),
      roleDigests: Object.freeze(roleDigests),
      ruleDigests: Object.freeze(ruleDigests),
      promptDigest,
      compositeDigest,
    }
  }

  /**
   * Compiles the OpenCode prompt policy for a launch request.
   *
   * Cutover: Replaces inline addenda assembly in `OpencodeRuntimeAdapter.#promptPolicy`.
   * Preserves exact single-role string formatting for byte-identical regression safety.
   */
  static compileForOpenCode(request: LaunchAgentRequest): OpencodePromptPolicy {
    const envelope = request.dispatchEnvelope
    const roles =
      envelope.roleSnapshots && envelope.roleSnapshots.length > 0
        ? envelope.roleSnapshots
        : [envelope.roleSnapshot]

    const computed = computeCapabilityEnvelope({
      requestedCapabilities: envelope.requestedCapabilities,
      permissionEnvelope: envelope.permissionEnvelope,
      ruleSnapshots: envelope.ruleSnapshots,
      roles,
      roleAssignments: envelope.roleAssignments,
    })

    const rules = envelope.ruleSnapshots
      .map((rule) => `${rule.ruleId}: ${JSON.stringify(rule.effect)}`)
      .join("\n")

    // Extract secondary addenda using the canonicalized, hard-cap-enforced compiler
    const secondaryAddenda = extractCanonicalSecondaryAddenda(envelope.roleAssignments)

    const roleHeader =
      roles.length === 1
        ? `Role: ${envelope.roleSnapshot.name}`
        : `Roles: ${roles.map((r) => r.name).join(", ")}`

    const system = [
      roleHeader,
      envelope.roleSnapshot.instructions,
      ...secondaryAddenda,
      rules ? `Rules:\n${rules}` : "",
      `Approved capability envelope: ${computed.allowed.join(", ") || "none"}. Denied: ${computed.denied.join(", ") || "none"}.`,
      `This dispatch requests a timeout of ${envelope.timeoutSeconds} seconds.`,
    ]
      .filter(Boolean)
      .join("\n\n")

    return {
      system,
      tools: computed.tools,
    }
  }

  /**
   * Compiles the Claude CLI system prompt for a launch request.
   *
   * Cutover: Replaces inline addenda assembly in `ClaudeCodeRuntimeAdapter.launch`.
   * Preserves exact single-role string formatting for byte-identical regression safety.
   */
  static compileForClaude(request: LaunchAgentRequest): { readonly systemPrompt: string } {
    const envelope = request.dispatchEnvelope
    const secondaryAddenda = extractCanonicalSecondaryAddenda(envelope.roleAssignments)

    const systemPrompt = [
      envelope.roleSnapshot.instructions,
      ...secondaryAddenda,
    ]
      .filter(Boolean)
      .join("\n\n")

    return { systemPrompt }
  }

  /**
   * Compiles prompt and tool sandbox policy for Codex CLI.
   *
   * Cutover: Replaces inline capability inspection in `CodexRuntimeAdapter.launch`.
   * Preserves exact single-role string formatting for byte-identical regression safety.
   */
  static compileForCodex(request: LaunchAgentRequest): {
    readonly prompt: string
    readonly toolPolicy: CodexToolPolicy
  } {
    const envelope = request.dispatchEnvelope
    const roles =
      envelope.roleSnapshots && envelope.roleSnapshots.length > 0
        ? envelope.roleSnapshots
        : [envelope.roleSnapshot]

    const computed = computeCapabilityEnvelope({
      requestedCapabilities: envelope.requestedCapabilities,
      permissionEnvelope: envelope.permissionEnvelope,
      ruleSnapshots: envelope.ruleSnapshots,
      roles,
      roleAssignments: envelope.roleAssignments,
    })

    const secondaryAddenda = extractCanonicalSecondaryAddenda(envelope.roleAssignments)

    // For single-role, envelope.prompt is passed byte-identically
    const promptParts = [...secondaryAddenda, envelope.prompt].filter(Boolean)
    const prompt = promptParts.join("\n\n")

    const sandbox = computed.allowedSet.has("filesystem.write") ? "workspace-write" : "read-only"

    return {
      prompt,
      toolPolicy: {
        runtimeKind: "codex",
        sandbox,
        allowedCapabilities: computed.allowed,
        deniedCapabilities: computed.denied,
      },
    }
  }

  // Instance methods delegating to static methods for ergonomic caller usage
  compile(options: BinderCompileOptions): CompiledPrompt {
    return RoleBinder.compile(options)
  }

  compileForOpenCode(request: LaunchAgentRequest): OpencodePromptPolicy {
    return RoleBinder.compileForOpenCode(request)
  }

  compileForClaude(request: LaunchAgentRequest): { readonly systemPrompt: string } {
    return RoleBinder.compileForClaude(request)
  }

  compileForCodex(request: LaunchAgentRequest): {
    readonly prompt: string
    readonly toolPolicy: CodexToolPolicy
  } {
    return RoleBinder.compileForCodex(request)
  }
}

export function compilePrompt(options: BinderCompileOptions): CompiledPrompt {
  return RoleBinder.compile(options)
}
