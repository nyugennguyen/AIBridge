/**
 * Shared fixtures for `tests/unit/workflows/`.
 *
 * WHY ONE FILE. Every test in this directory needs a valid template, and a
 * fixture that is subtly different in each file is a fixture whose differences
 * nobody can account for. Each builder applies its overrides at the TOP level
 * and validates through the module's OWN schema before returning, so a fixture
 * that has drifted out of the language fails loudly at the first test that uses
 * it rather than producing a subtly wrong input to a predicate test.
 *
 * The RAW builders exist for the adversarial tests. They return a
 * document-shaped object with no validation, because the whole point of
 * `schema.test.ts` is to build documents the schema is supposed to REFUSE — a
 * duplicate step id, a cycle, a default that breaks its own constraint. A
 * validating fixture cannot produce those, so the construction lives here, in a
 * test file, and the production module never contains a spelling of an invalid
 * document.
 *
 * ONE CLOCK, INJECTED EVERYWHERE. `FIXED_NOW` is the only instant any fixture
 * mentions. A fixture that called `new Date()` would make every determinism
 * assertion in this directory depend on when the suite ran, which is the exact
 * failure mode invariant I1 forbids.
 */

import { projectIdSchema, roleIdSchema } from "../../../src/orchestration/identifiers.js"
import {
  runTemplateSchema,
  type ResolvedStep,
  type RunTemplate,
  type RunTemplateInput,
  type TemplateParameterDefinition,
  type TemplateStep,
} from "../../../src/workflows/index.js"

/**
 * The project every fixture belongs to.
 *
 * Parsed through the kernel's own schema rather than written as a bare string,
 * because `RunTemplate.projectId` is the branded `ProjectId` and a fixture that
 * is not would make every test file need a cast.
 */
export const PROJECT_ID = projectIdSchema.parse("proj-1")

/** The instant every fixture is created at, and the instant every snapshot is captured at. */
export const FIXED_NOW = "2026-02-02T12:00:00Z"

/** A second instant, used where a test needs two distinct clocks. */
export const LATER_NOW = "2026-03-14T09:30:00Z"

/** The author every fixture is attributed to. */
export const AUTHOR = { kind: "user" as const, userId: "user-1" }

/** The role the fixture steps name. Branded, for the same reason as `PROJECT_ID`. */
export const ROLE_ID = roleIdSchema.parse("role-dev")

/**
 * A second role, for the tests that change a step's role and therefore need the
 * change to be a real change of authority rather than a re-spelling.
 */
export const OTHER_ROLE_ID = roleIdSchema.parse("role-ops")

/**
 * Every capability `ROLE_ID` grants.
 *
 * The role fixture exists so the containment check has something to compare
 * against, and it is deliberately NARROWER than what a step could ask for: a step
 * requesting `net.fetch` is refused, which is the case
 * `instantiate.test.ts` needs to construct.
 */
export const ROLE_CAPABILITIES = ["fs.read", "fs.write", "shell.run"] as const

/**
 * The parameter definitions every fixture starts from.
 *
 * One of each type, so a test that mutates one parameter is mutating exactly one
 * thing. `retries` is optional with a default, `target_env` is required, and the
 * two optional-without-default cases live in the tests that need them.
 */
export const BASE_PARAMETER_DEFINITIONS: readonly TemplateParameterDefinition[] = [
  { name: "target_env", type: "string", required: true, minLength: 1, maxLength: 16 },
  { name: "retries", type: "integer", required: false, defaultValue: 2, minimum: 0, maximum: 5 },
  { name: "path", type: "project_path_id", required: false, defaultValue: "path-1" },
  { name: "stage", type: "enum", required: false, defaultValue: "canary", enumValues: ["canary", "stable"] },
  { name: "dry_run", type: "boolean", required: false, defaultValue: false },
]

/**
 * The steps every fixture starts from: a two-step chain, so a dependency edge
 * exists and a test that adds a cycle has something to add it to.
 *
 * `capabilities` is written UNSORTED on purpose. The STORED template preserves
 * declared order, so a test that asserts `["shell.run", "fs.read"]` here is
 * asserting that the repository did not silently reorder a human's list, and the
 * snapshot tests assert the opposite — that the resolved step IS sorted. Between
 * them, both halves of the ordering decision are covered.
 */
export const BASE_STEPS: readonly TemplateStep[] = [
  {
    stepId: "build",
    kind: "task",
    title: "Build the release",
    roleId: ROLE_ID,
    dependsOn: [],
    capabilities: ["shell.run", "fs.read"],
    runtimeKind: "opencode",
    timeoutSeconds: 600,
    labelValues: { env: "target_env" },
  },
  {
    stepId: "ship",
    kind: "dispatch",
    title: "Ship the release",
    roleId: ROLE_ID,
    dependsOn: ["build"],
    capabilities: ["fs.read"],
    runtimeKind: "opencode",
    timeoutSeconds: 900,
    labelValues: { env: "target_env", stage: "stage" },
  },
]

/** A minimal VALID template input, with every required field present. */
export function validTemplateInput(overrides: Partial<RunTemplateInput> = {}): RunTemplateInput {
  return {
    templateId: "tmpl-release",
    projectId: PROJECT_ID,
    name: "release",
    description: "Build and ship a release.",
    parameterDefinitions: BASE_PARAMETER_DEFINITIONS,
    steps: BASE_STEPS,
    ruleSetDigest: null,
    author: AUTHOR,
    createdAt: FIXED_NOW,
    ...overrides,
  }
}

/** The same input, validated. A test that mutates a VALID template is not building an invalid one. */
export function validTemplate(overrides: Partial<RunTemplate> = {}): RunTemplate {
  const parsed = runTemplateSchema.safeParse({ ...validTemplateInput(), templateVersion: 1 })
  if (!parsed.success) {
    throw new Error(`validTemplate() produced an invalid template: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`)
  }
  return { ...parsed.data, ...overrides }
}

/**
 * A template document WITHOUT validation.
 *
 * For the tests that must build something the schema refuses. Every one of those
 * tests asserts a refusal, so the input never has to be valid — it has to be
 * wrong in exactly one way, which is what applying top-level overrides gives.
 */
export function rawTemplateDocument(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    templateId: "tmpl-release",
    templateVersion: 1,
    projectId: PROJECT_ID,
    name: "release",
    description: "Build and ship a release.",
    parameterDefinitions: structuredClone(BASE_PARAMETER_DEFINITIONS) as unknown[],
    steps: structuredClone(BASE_STEPS) as unknown[],
    ruleSetDigest: null,
    author: AUTHOR,
    createdAt: FIXED_NOW,
    schemaVersion: 1,
    ...overrides,
  }
}

/** One step, by step id, from a step list. Throws rather than returning undefined. */
export function stepWithId(steps: readonly TemplateStep[], stepId: string): TemplateStep {
  const step = steps.find((candidate) => candidate.stepId === stepId)
  if (step === undefined) throw new Error(`fixture has no step '${stepId}'`)
  return step
}

/** One definition, by name, from a definition list. Throws rather than returning undefined. */
export function definitionNamed(
  definitions: readonly TemplateParameterDefinition[],
  name: string,
): TemplateParameterDefinition {
  const definition = definitions.find((candidate) => candidate.name === name)
  if (definition === undefined) throw new Error(`fixture has no parameter definition '${name}'`)
  return definition
}

/** A role resolver over `ROLE_CAPABILITIES`, for the containment check. */
export function roleCapabilitiesGranting(capabilities: readonly string[]): (roleId: string) => readonly string[] | undefined {
  return (roleId: string) => (roleId === ROLE_ID ? [...capabilities] : undefined)
}

/** A role resolver that knows about no roles at all. */
export function noRoles(): (roleId: string) => readonly string[] | undefined {
  return () => undefined
}

/** A deep structural clone, so a mutation in one test cannot reach a shared fixture. */
export function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * The resolved steps a base fixture produces, as a lookup by step id.
 *
 * Only used where a test asserts against the resolution rather than re-deriving
 * it; a test that wants to check resolution should read `snapshot.resolvedSteps`
 * directly, because a fixture that re-implements the production normalization is a
 * second implementation of it.
 */
export function resolvedStep(snapshot: { readonly resolvedSteps: readonly ResolvedStep[] }, stepId: string): ResolvedStep {
  const step = snapshot.resolvedSteps.find((candidate) => candidate.stepId === stepId)
  if (step === undefined) throw new Error(`snapshot has no step '${stepId}'`)
  return step
}
