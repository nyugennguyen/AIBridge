/**
 * Shared fixtures for `tests/unit/rules/`.
 *
 * WHY these live in one file: every test in this directory needs a valid rule
 * document and a valid evaluation context, and a fixture that is subtly different
 * in each file is a fixture whose differences nobody can account for. Each
 * builder takes a partial override, applies it at the TOP level, and validates
 * the result through the module's OWN schema before returning it — so a fixture
 * that has drifted out of the language is a loud failure at the first test that
 * uses it rather than a subtly-wrong input to a predicate test.
 *
 * The mutation helpers exist for the adversarial tests and are deliberately
 * crude: they clone through `structuredClone`, drop a key, replace a value, or
 * inject one. Crude is right here — a clever generator that produced only
 * plausible inputs would not be a fuzzer.
 */

import {
  ruleEvaluationContextSchema,
  ruleSourceDocumentSchema,
  type RuleEvaluationContext,
  type RuleSourceDocument,
} from "../../../src/rules/index.js"
import { digestJson } from "../../../src/orchestration/digest.js"
import { userIdSchema } from "../../../src/orchestration/identifiers.js"
import { dispatchEnvelopeSchema } from "../../../src/orchestration/schemas.js"
import type { DispatchEnvelope } from "../../../src/orchestration/types.js"

/** The project every fixture belongs to. */
export const PROJECT_ID = "proj-1"
export const ROLE_ID = "role-1"
export const PATH_ID = "path-1"
export const NODE_ID = "node-1"
export const USER_ID = "user-1"

/** A moment inside every schedule window the fixtures declare. Monday, 12:00 UTC. */
export const INSIDE_WINDOW_INSTANT = "2026-02-02T12:00:00Z"

/**
 * A minimal VALID rule document: one identifier predicate and one
 * `deny_with_reason`, which is the combination with the fewest possible
 * interactions, so a test that mutates it is mutating exactly one thing.
 */
export function validRuleDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return ruleSourceDocumentSchema.parse(rawRuleDocument(overrides))
}

/**
 * The same document WITHOUT validation.
 *
 * The limits tests need to build documents the schema would REFUSE — one over the
 * note length, one over the fan-out ceiling — and a fixture that validates cannot
 * produce those. Every such test asserts that `compileRule` refuses, so the input
 * never has to be a valid document; it has to be a document-shaped object that is
 * wrong in exactly one way.
 */
export function rawRuleDocument(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    languageVersion: 2,
    ruleId: "rule-a",
    templateVersion: 1,
    projectId: PROJECT_ID,
    name: "deny deploys on fridays",
    description: "A deny scoped to one role.",
    enabled: true,
    activation: {
      state: "activated" as const,
      activatedAt: "2026-01-01T00:00:00Z",
      activatedBy: { kind: "user" as const, userId: USER_ID },
    },
    predicates: [{ field: "roleId" as const, operator: "eq" as const, value: ROLE_ID }],
    actions: [{ kind: "deny_with_reason" as const, reason: "deploys are frozen on fridays" }],
    expiresAt: null,
    author: { kind: "user" as const, userId: USER_ID },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

/** A rule carrying only `require_approval`, for restriction-layer tests. */
export function requireApprovalDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return validRuleDocument({
    ruleId: "rule-require",
    actions: [{ kind: "require_approval", requireApprovalForDispatch: true }],
    ...overrides,
  })
}

/**
 * A `pre_approve_within_bounds` document WITHOUT validation.
 *
 * The escalation tests need to build the documents the schema is supposed to make
 * unrepresentable — `allowDestructiveEffects: true` — and asserting that they are
 * refused requires constructing them. The construction lives here, in a test
 * fixture, so the production module never contains a spelling of the escalation.
 */
export function rawPreApprovalDocument(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return rawRuleDocument({
    ruleId: "rule-pre",
    name: "pre-approve reads in this project",
    predicates: [{ field: "projectId", operator: "eq", value: PROJECT_ID }],
    actions: [
      {
        kind: "pre_approve_within_bounds",
        approvedCapabilities: ["fs.read"],
        maximumTimeoutSeconds: 900,
        allowDestructiveEffects: false,
        allowExternalEffects: false,
        maximumSensitivity: "restricted",
      },
    ],
    ...overrides,
  })
}

/**
 * A `pre_approve_within_bounds` rule, scoped to a project predicate.
 *
 * `projectId` is the scope field used throughout these tests because it is the
 * one the universal-predicate check names first and the one that never needs a
 * nullable context field to evaluate.
 */
export function preApprovalDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return ruleSourceDocumentSchema.parse(rawPreApprovalDocument(overrides))
}

/** A `set_stricter_budget` rule. */
export function budgetDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return validRuleDocument({
    ruleId: "rule-budget",
    actions: [{ kind: "set_stricter_budget", budget: { maximumFanOut: 4 } }],
    ...overrides,
  })
}

/** A `select_routing_preference` rule. */
export function routingDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return validRuleDocument({
    ruleId: "rule-route",
    predicates: [{ field: "projectId", operator: "eq", value: PROJECT_ID }],
    actions: [{ kind: "select_routing_preference", preference: { preferredNodeIds: ["node-2"] } }],
    ...overrides,
  })
}

/**
 * A fully-populated evaluation context, every field present.
 *
 * Populated rather than minimal so that a test asserting "an absent `roleId` is
 * unsatisfied" is asserting the ABSENCE and not the fact that the fixture never
 * had one.
 */
export function validContext(overrides: Partial<Record<string, unknown>> = {}): RuleEvaluationContext {
  return ruleEvaluationContextSchema.parse({
    projectId: PROJECT_ID,
    roleId: ROLE_ID,
    roleVersion: 3,
    requestedCapabilities: ["fs.read", "net.fetch"],
    toolCategories: ["shell", "fs"],
    runtimeKind: "opencode",
    targetNodeId: NODE_ID,
    nodeAdvertisedCapabilities: ["fs.read"],
    projectPathId: PATH_ID,
    taskLabels: ["release", "urgent"],
    dependencyOutcomes: ["succeeded", "failed"],
    requestedFanOut: 2,
    requestedConcurrency: 2,
    requestedRetryLimit: 1,
    declaredTimeoutSeconds: 600,
    taskTitle: "deploy the api to staging",
    evaluatedAt: INSIDE_WINDOW_INSTANT,
    contextManifestSensitivity: "restricted",
    currentBudget: null,
    ...overrides,
  })
}

// ===========================================================================
// The M0 dispatch envelope, for the kernel-composition tests
// ===========================================================================

/**
 * A real, schema-valid `DispatchEnvelope`, for the tests that hand the KERNEL an
 * envelope rather than only the M6 evaluator a context.
 *
 * It lives here rather than in one test file because the kernel-composition
 * claims — a pre-approval the floor refuses, a rule demand that survives a
 * pre-approval, the four restriction members the M0 `restrict` effect cannot
 * carry — are all claims about the SAME envelope. A second hand-rolled envelope
 * in a second file would be a second set of answers to "what does the kernel
 * decide for a one-capability dispatch", and the two could differ for reasons
 * nobody is testing.
 *
 * The envelope's own permission layer grants everything; `deniedByRole` is what
 * the ROLE removes, so a capability denial is attributable to the role rather
 * than to the dispatch.
 */
export function dispatchEnvelope(
  overrides: Record<string, unknown> = {},
  capabilities: readonly string[] = ["fs.read"],
  deniedByRole: readonly string[] = [],
): DispatchEnvelope {
  return dispatchEnvelopeSchema.parse({
    schemaVersion: 1,
    dispatchId: "disp-1",
    attempt: 1,
    projectId: PROJECT_ID,
    runId: "run-1",
    taskId: "task-1",
    targetNodeId: NODE_ID,
    installationId: "inst-1",
    runtimeKind: "opencode",
    projectPathId: PATH_ID,
    prompt: "deploy the api",
    roleSnapshot: {
      schemaVersion: 1,
      roleId: ROLE_ID,
      templateVersion: 1,
      projectId: PROJECT_ID,
      name: "Runner",
      purpose: "execute deployments",
      instructions: "Execute the task",
      requiredCapabilities: [...capabilities],
      preferredRuntimeKinds: ["opencode"],
      contextSelectionPolicyReference: { namespace: "test", id: "ref-1" },
      permissionRestrictions: {
        // A capability the role REMOVES appears in `deniedCapabilities` and is
        // ABSENT from `allowedCapabilities`: the permission-envelope schema
        // refuses a capability that is both, so "removed by the role" is
        // expressed as allowed-minus-denied rather than as a separate flag.
        allowedCapabilities: capabilities.filter((capability) => !deniedByRole.includes(capability)),
        deniedCapabilities: [...deniedByRole],
        approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
      },
      author: { kind: "user", userId: userIdSchema.parse(USER_ID) },
      createdAt: "2026-01-01T00:00:00Z",
    },
    ruleSnapshots: [],
    contextManifest: { references: [], manifestDigest: digestJson({ manifest: "empty" }) },
    requestedCapabilities: [...capabilities],
    permissionEnvelope: {
      allowedCapabilities: [...capabilities],
      deniedCapabilities: [],
      approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
    },
    dependencies: [],
    timeoutSeconds: 600,
    controllerEpoch: 3,
    ...overrides,
  })
}

// ===========================================================================
// Mutation helpers, for the adversarial tests
// ===========================================================================

/** A deep structural clone, so a mutation cannot reach back into a shared fixture. */
export function clone<T>(value: T): T {
  return structuredClone(value)
}

/** Drops one top-level key. */
export function withoutKey(document: Record<string, unknown>, key: string): Record<string, unknown> {
  const next = clone(document)
  delete next[key]
  return next
}

/** Replaces one top-level key. */
export function withKey(document: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const next = clone(document)
  next[key] = value
  return next
}

/** Wraps a value in an array of `depth`, the cheapest "absurd nesting" there is. */
export function nestedArrays(depth: number, leaf: unknown = 1): unknown {
  let value: unknown = leaf
  for (let index = 0; index < depth; index += 1) value = [value]
  return value
}

/** A `not` chain of `depth`, each level wrapping the next. */
export function notChain(depth: number): unknown {
  let value: unknown = { field: "roleId", operator: "eq", value: ROLE_ID }
  for (let index = 0; index < depth; index += 1) value = { field: "not", predicate: value }
  return value
}

/**
 * A deterministic pseudo-random generator.
 *
 * A LINEAR CONGRUENTIAL generator seeded from a constant, never `Math.random`.
 * A fuzzer whose seed changes per run reports a different failure set per run,
 * so a failure that cannot be reproduced is a failure nobody can fix; and a
 * fuzzer seeded from the clock has the same problem plus a run that depends on
 * when it was started. LCG is the weakest generator there is, which is the right
 * trade here: these tests are not searching for a needle, they are asserting that
 * a whole class of malformed inputs is refused, and the only property that
 * matters is that the same class is visited every time.
 *
 * The modulus is 2^32 and the constants are the Numerical Recipes ones, so the
 * sequence is fully determined by the seed on every platform.
 */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 4_294_967_296
  }
}

/**
 * Every error code the rule compiler and evaluator can return.
 *
 * Declared HERE, in the test fixtures, rather than imported from the module, so
 * the adversarial tests assert against the union as a CONTRACT. If the module
 * grew a code the fixtures do not list, `invalid-inputs.test.ts` would not see it
 * — which is the direction that matters, because a code a caller does not know
 * about is a code a caller falls through on. The module's own union is asserted
 * to be a subset of this list, so adding a code there without adding it here is
 * a test failure.
 */
export const RULE_ERROR_CODES = [
  "rule.invalid_source",
  "rule.limit_exceeded",
  "rule.pattern_refused",
  "rule.universal_pre_approval",
  "rule.empty_enum",
  "rule.language_version_unsupported",
  "rule.project_scope_mismatch",
  "rule.evaluation_failed",
  "rule.conflicting_action_effects",
] as const

/** One of `members`, chosen by the generator. */
export function pick<T>(random: () => number, members: readonly T[]): T {
  const index = Math.floor(random() * members.length)
  const value = members[index]
  if (value === undefined) throw new Error("pick() called with an empty member list")
  return value
}

/** An integer in `[minimum, maximum]`. */
export function randomInt(random: () => number, minimum: number, maximum: number): number {
  return minimum + Math.floor(random() * (maximum - minimum + 1))
}

/** A string of `length` characters drawn from the opaque-token alphabet. */
export function randomToken(random: () => number, length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789.-_"
  let out = ""
  for (let index = 0; index < length; index += 1) {
    out += alphabet[Math.floor(random() * alphabet.length)]
  }
  return out
}
