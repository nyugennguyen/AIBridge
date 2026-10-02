/**
 * Turning a versioned template into an immutable, digested snapshot.
 *
 * ============================== THE ONE ENTRY POINT ==============================
 *
 * `instantiateTemplate` is the SINGLE way to produce a `RunTemplateSnapshot`, for
 * the reason ADR 0007 section 3 gives for `compileRuleSet`: a second way to build
 * one is a second implementation of binding, ordering, and digesting, and the
 * first time the two disagreed about whether a given set of inputs is the same
 * run, nothing would notice. It is a PURE function — no clock but the injected
 * `now`, no randomness, no filesystem, no network, no mutable module state — so
 * "the same inputs produce the same snapshot" is a property of the code rather
 * than of a deployment.
 *
 * ============================== WHAT THE DIGEST COVERS ==============================
 *
 * `snapshotDigest` covers exactly what defines the run's BEHAVIOUR:
 *
 *   in    templateId, templateVersion, boundParameters, resolvedSteps, ruleSetDigest
 *   out   capturedAt, name, description, author, schemaVersion
 *
 * `capturedAt` is excluded because it is a reading of the clock, and two
 * identical runs started at different instants are the same run; including it
 * would make "is this the same run?" answer no. The same reasoning excludes
 * `name` and `description`, which is the rule compiler's own precedent at
 * `src/rules/compile.ts:1005` — "renaming a rule must not invalidate an approval
 * taken against it". An author who fixes a typo in a description must not
 * invalidate every snapshot they ever created.
 *
 * What the digest DOES cover is everything that would change what the run does:
 * a different role, a different capability list, a different timeout, a different
 * dependency edge, a different bound value, a different starting rule set.
 * `tests/unit/workflows/immutability.test.ts` asserts the "changing one step
 * changes the digest" direction by changing exactly one field.
 *
 * ============================== ORDERING ==============================
 *
 * `resolvedSteps` is sorted by `stepId` by code unit, and every collection inside
 * a step (its `dependsOn`, its `capabilities`, its `labelValues` keys) is sorted
 * and de-duplicated. Execution ORDER is a different question and is a separate
 * exported function, `resolveStepDependencyGraph`, which returns a topological
 * order. Keeping them separate is what makes "the same template instantiates to
 * the same bytes" independent of the order the author typed the steps in: two
 * authors who disagree about sequence produce identical snapshots and only
 * disagree about execution order, which is a scheduling question.
 *
 * ============================== WHY THE GRAPH IS RE-CHECKED HERE ==============================
 *
 * `runTemplateSchema` already refuses a cyclic or dangling `dependsOn` at
 * authoring time, so a template that reached this module should already be
 * acyclic. The check is repeated anyway, and it is the kernel's own idiom: the
 * M6 rule evaluator re-checks a `pre_approve` grant against the
 * POST-narrowing state in a second pass precisely because the first pass could
 * have been looking at a different state (`src/orchestration/policy/evaluate.ts:520`).
 * Here the re-check runs on the RESOLVED steps rather than the authored ones, so
 * it is a genuine second look at a different value rather than a copy of the
 * first. `tests/unit/workflows/instantiate.test.ts` calls
 * `resolveStepDependencyGraph` directly, because the repository will not store a
 * cyclic template and a test that could only reach this path by breaking the
 * repository first would be testing the wrong thing.
 *
 * ============================== SAFETY ==============================
 *
 * Two refusals, and neither depends on the caller having read a document:
 *
 *   1. `workflow.timeout_exceeds_safety_floor` — a step whose `timeoutSeconds` is
 *      above `SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS`. The authored ceiling
 *      (`MAX_TEMPLATE_STEP_TIMEOUT_SECONDS`) is deliberately wider so that this
 *      refusal has a code; the floor is not negotiable and is not a default.
 *   2. `workflow.capability_exceeds_role` — a step that requests a capability its
 *      `roleId` does not grant, evaluated against the caller's injected
 *      `roleCapabilities` resolver. Documented limitation: with no resolver
 *      supplied there is no role to compare against, so the check does not run
 *      and the kernel remains the enforcement point. That is the ADR's layering —
 *      a template is an INPUT to policy, not a second policy — but it means this
 *      module is not, on its own, the thing that stops a step from asking for a
 *      capability its role lacks.
 *
 * There is no `allowDestructiveEffects` or `allowExternalEffects` anywhere in a
 * template step, which is the ADR 0007 section 7.7 "representability" mechanism
 * applied by absence: a template cannot express the escalation, so the refusal
 * path cannot be reached by a schema-valid document.
 */

import { digestJson } from "../orchestration/digest.js"
import { createContractError, type ContractError, type Result } from "../orchestration/errors.js"
import type { Digest, RoleId } from "../orchestration/identifiers.js"
import { SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS } from "../orchestration/policy/types.js"
import type { CycleType } from "../orchestration/scheduler/types.js"
import type { RunTemplateRef, RunTemplateRepository } from "./repository.js"
import {
  WorkflowTemplateError,
  checkParameterValue,
  compareCodeUnits,
  deepFreezeWorkflow,
  findStepDependencyCycle,
  runTemplateSnapshotSchema,
  sortedUniqueStrings,
  type ResolvedStep,
  type RunTemplate,
  type RunTemplateSnapshot,
  type TemplateParameterValue,
  type TemplateStep,
  type WorkflowErrorCode,
} from "./types.js"

/**
 * The capability set granted by a role, or `undefined` when the role is unknown
 * to the resolver.
 *
 * `undefined` and `[]` are deliberately different: `undefined` means "I have no
 * role snapshot for this id", which is a refusal (`workflow.role_not_found`),
 * while `[]` means "I have a role snapshot that grants nothing", which is a
 * refusal only if the step asks for something.
 */
export type RoleCapabilityResolver = (roleId: RoleId) => readonly string[] | undefined

export interface InstantiateTemplateOptions {
  /**
   * The instant the run starts. Required, never defaulted.
   *
   * There is no clock in this module. A snapshot that stamped its own time would
   * make two identical instantiations differ in a field a caller can see, and
   * would make `capturedAt` untestable without a fake timer at every call site.
   */
  readonly now: string
  /**
   * How to look up what a role grants. Omit it and the role containment check
   * does not run; see the module docblock's SAFETY section for why that is the
   * documented behaviour rather than a refusal.
   */
  readonly roleCapabilities?: RoleCapabilityResolver
}

/**
 * The subset of a snapshot that the digest covers.
 *
 * A named parameter rather than an inline object so that
 * `computeRunTemplateSnapshotDigest(snapshot)` is the call a verifier makes, and
 * so adding a field to the snapshot cannot silently add it to the digest: the
 * digest input is this type, and `capturedAt` is not a member of it.
 */
export interface RunTemplateSnapshotDigestInput {
  readonly templateId: RunTemplate["templateId"]
  readonly templateVersion: number
  readonly boundParameters: Readonly<Record<string, TemplateParameterValue>>
  readonly resolvedSteps: readonly ResolvedStep[]
  readonly ruleSetDigest: Digest | null
}

/**
 * The canonical digest of an instantiation.
 *
 * A sibling of `computeRoleSnapshotDigest` (`src/orchestration/roles/repository.ts:80`)
 * with the same signature shape and the same reason for existing: a digest nobody
 * can recompute is a digest nobody can check, and `verifyRunTemplateSnapshotDigest`
 * needs the exact same function that produced the value.
 */
export function computeRunTemplateSnapshotDigest(input: RunTemplateSnapshotDigestInput): Digest {
  return digestJson({
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    // Rebuilt in sorted order rather than spread, so the digest does not depend
    // on the insertion order of a plain object. `canonicalJson` sorts keys, so
    // this is belt-and-braces, but it also means the value a caller can read and
    // the value that was hashed are built the same way.
    boundParameters: Object.fromEntries(
      Object.keys(input.boundParameters)
        .sort(compareCodeUnits)
        .map((key) => [key, input.boundParameters[key]]),
    ),
    // Sorted by stepId here as well, so the digest is stable even for a caller
    // that built the steps by hand rather than through `instantiateTemplate`.
    resolvedSteps: [...input.resolvedSteps]
      .sort((left, right) => compareCodeUnits(left.stepId, right.stepId))
      // Spread into fresh arrays and records: the digest input is built by
      // derivation, so it cannot alias anything the caller handed in. That is
      // what lets `computeRunTemplateSnapshotDigest` be a pure function of a
      // mutable-looking argument.
      .map((step) => ({ ...step, dependsOn: [...step.dependsOn], capabilities: [...step.capabilities] }))
      .map((step) => ({
        stepId: step.stepId,
        kind: step.kind,
        title: step.title,
        roleId: step.roleId,
        dependsOn: sortedUniqueStrings(step.dependsOn),
        capabilities: sortedUniqueStrings(step.capabilities),
        runtimeKind: step.runtimeKind,
        timeoutSeconds: step.timeoutSeconds,
        labelValues: Object.fromEntries(Object.keys(step.labelValues).sort(compareCodeUnits).map((key) => [key, step.labelValues[key]])),
        budget: step.budget ?? null,
      })),
    ruleSetDigest: input.ruleSetDigest,
  })
}

/**
 * Recomputes a snapshot's digest and reports whether it matches the recorded one.
 *
 * `false` is the whole answer; the reason is deliberately not returned, because
 * the two reasons a snapshot fails verification — it was edited, or it was never
 * a snapshot — lead to the same response, and a caller that branched on them
 * would be building a distinction the system cannot actually make. Returns
 * `false` rather than throwing on an unencodable value, matching
 * `verifySnapshotDigest`.
 */
export function verifyRunTemplateSnapshotDigest(snapshot: RunTemplateSnapshot): boolean {
  try {
    return (
      computeRunTemplateSnapshotDigest({
        templateId: snapshot.templateId,
        templateVersion: snapshot.templateVersion,
        boundParameters: snapshot.boundParameters,
        resolvedSteps: snapshot.resolvedSteps,
        ruleSetDigest: snapshot.ruleSetDigest,
      }) === snapshot.snapshotDigest
    )
  } catch {
    return false
  }
}

/** A failure with a code, ready to become a `ContractError`. */
function refuse(
  category: "validation" | "conflict",
  code: WorkflowErrorCode,
  message: string,
): Result<never> {
  return { ok: false, error: createContractError(category, code, message.slice(0, 4_096)) }
}

/**
 * Orders a step graph and refuses it if it is not a DAG.
 *
 * The offending step ids are named in the refusal, and always in the same order
 * for the same graph, because the traversal is driven by sorted ids rather than
 * by the order the steps were supplied in. A refusal message that varied run to
 * run would be a refusal an operator could not compare against a later one.
 *
 * A `dependsOn` naming a step that does not exist is a DIFFERENT refusal from a
 * cycle, with its own code, because the two mean different things to an author:
 * one of them misspelled a step id, and the other built a graph no scheduler can
 * order. The scheduler's own `DanglingDependencyError` makes the same
 * distinction (`src/orchestration/scheduler/types.ts:60`).
 */
export function resolveStepDependencyGraph(
  steps: readonly Pick<TemplateStep, "stepId" | "dependsOn">[],
): Result<readonly string[]> {
  const ids = new Set(steps.map((step) => step.stepId))
  for (const step of [...steps].sort((left, right) => compareCodeUnits(left.stepId, right.stepId))) {
    for (const dependency of sortedUniqueStrings(step.dependsOn)) {
      if (!ids.has(dependency)) {
        return refuse(
          "validation",
          "workflow.unknown_dependency",
          `workflow.unknown_dependency: step '${step.stepId}' depends on '${dependency}', which is not a step of this template`,
        )
      }
    }
  }

  const cycle = findStepDependencyCycle(steps)
  if (cycle !== null) {
    return refuse(
      "validation",
      "workflow.dependency_cycle",
      `workflow.dependency_cycle: ${describeCycle(cycle.cycle, cycle.cycleType)}`,
    )
  }

  // Kahn's algorithm, tie-broken by code unit, which is what makes the returned
  // order total rather than merely valid.
  const remaining = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const step of steps) {
    remaining.set(step.stepId, sortedUniqueStrings(step.dependsOn).length)
    dependents.set(step.stepId, [])
  }
  for (const step of steps) {
    for (const dependency of sortedUniqueStrings(step.dependsOn)) {
      dependents.get(dependency)!.push(step.stepId)
    }
  }

  const ready = [...remaining.entries()].filter(([, degree]) => degree === 0).map(([stepId]) => stepId).sort(compareCodeUnits)
  const order: string[] = []
  while (ready.length > 0) {
    const stepId = ready.shift()!
    order.push(stepId)
    for (const dependent of (dependents.get(stepId) ?? []).sort(compareCodeUnits)) {
      const degree = (remaining.get(dependent) ?? 0) - 1
      remaining.set(dependent, degree)
      if (degree === 0) {
        // Insertion sort into a sorted array: `ready` is at most one template's
        // width, and a total order is worth more here than an O(log n) insert.
        let index = 0
        while (index < ready.length && compareCodeUnits(ready[index]!, stepId) < 0) index += 1
        ready.splice(index, 0, dependent)
      }
    }
  }

  if (order.length !== steps.length) {
    // Unreachable while the cycle check above runs, and kept anyway: a graph
    // check that can be defeated by an arithmetic slip is not a check, and the
    // cost of the branch is one comparison per instantiation.
    return refuse(
      "validation",
      "workflow.dependency_cycle",
      `workflow.dependency_cycle: only ${order.length} of ${steps.length} steps could be ordered, so the graph contains a cycle`,
    )
  }
  return { ok: true, value: Object.freeze(order) }
}

function describeCycle(cycle: readonly string[], cycleType: CycleType): string {
  const path = cycle.join(" -> ")
  if (cycleType === "self") return `step '${cycle[0]}' depends on itself (${path})`
  const length = cycleType === "direct" ? "Direct" : "Indirect"
  return `${length} cycle among steps ${path}`
}

/**
 * Binds parameters and resolves every step's labels, or refuses.
 *
 * Ordering is: unknown names first, then each definition in declared order. The
 * unknown-name check runs before anything else because a typo silently ignored is
 * the worst failure this function can have — the run would start with a value the
 * author believed they had overridden and had not.
 */
function bindParameters(
  template: RunTemplate,
  inputs: Readonly<Record<string, unknown>>,
): Result<Readonly<Record<string, TemplateParameterValue>>> {
  const definitions = new Map(template.parameterDefinitions.map((definition) => [definition.name, definition]))

  const unknown = Object.keys(inputs).filter((name) => !definitions.has(name)).sort(compareCodeUnits)
  if (unknown.length > 0) {
    return refuse(
      "validation",
      "workflow.unknown_parameter",
      `workflow.unknown_parameter: template '${template.templateId}' has no parameter(s) named ${unknown.join(", ")}; declared parameters are ${
        sortedUniqueStrings(definitions.keys()).join(", ") || "(none)"
      }`,
    )
  }

  const bound: Record<string, TemplateParameterValue> = {}
  for (const name of sortedUniqueStrings(definitions.keys())) {
    const definition = definitions.get(name)!
    const supplied = Object.prototype.hasOwnProperty.call(inputs, name) ? inputs[name] : undefined
    const value = supplied !== undefined ? supplied : definition.defaultValue

    if (value === undefined) {
      if (definition.required) {
        return refuse(
          "validation",
          "workflow.missing_parameter",
          `workflow.missing_parameter: required parameter '${name}' of template '${template.templateId}' has no supplied value and declares no default`,
        )
      }
      // Optional and unbound: absent from `boundParameters` rather than bound to
      // a placeholder. A placeholder would put a value in the digest that the
      // author never chose, and would make an unbound optional parameter
      // indistinguishable from one bound to its own placeholder.
      continue
    }

    const checked = checkParameterValue(definition, value)
    if (!checked.ok) {
      return refuse("validation", checked.code, `${checked.message} (template '${template.templateId}')`)
    }
    bound[name] = checked.value
  }

  return { ok: true, value: Object.freeze(bound) }
}

/** Builds one resolved step: sorted collections, bound label values, safety checked. */
function resolveStep(
  template: RunTemplate,
  step: TemplateStep,
  bound: Readonly<Record<string, TemplateParameterValue>>,
  roleCapabilities: RoleCapabilityResolver | undefined,
): Result<ResolvedStep> {
  const labelValues: Record<string, string> = {}
  for (const key of Object.keys(step.labelValues).sort(compareCodeUnits)) {
    const parameterName = step.labelValues[key]!
    const value = bound[parameterName]
    if (value === undefined) {
      return refuse(
        "validation",
        "workflow.label_unbound",
        `workflow.label_unbound: step '${step.stepId}' binds label '${key}' to parameter '${parameterName}', which is optional and was left unbound`,
      )
    }
    labelValues[key] = String(value)
  }

  if (step.timeoutSeconds > SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS) {
    return refuse(
      "validation",
      "workflow.timeout_exceeds_safety_floor",
      `workflow.timeout_exceeds_safety_floor: step '${step.stepId}' declares timeoutSeconds ${step.timeoutSeconds}, above the safety floor maximum of ${SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS}`,
    )
  }

  const capabilities = sortedUniqueStrings(step.capabilities)
  if (roleCapabilities !== undefined && capabilities.length > 0) {
    const granted = roleCapabilities(step.roleId)
    if (granted === undefined) {
      return refuse(
        "validation",
        "workflow.role_not_found",
        `workflow.role_not_found: step '${step.stepId}' names role '${step.roleId}' and no capability snapshot for it was supplied`,
      )
    }
    const grantedSet = new Set(granted)
    const exceeding = capabilities.filter((capability) => !grantedSet.has(capability)).sort(compareCodeUnits)
    if (exceeding.length > 0) {
      return refuse(
        "validation",
        "workflow.capability_exceeds_role",
        `workflow.capability_exceeds_role: step '${step.stepId}' requests ${exceeding.join(", ")}, which role '${step.roleId}' does not grant`,
      )
    }
  }

  return {
    ok: true,
    value: {
      stepId: step.stepId,
      kind: step.kind,
      title: step.title,
      roleId: step.roleId,
      dependsOn: sortedUniqueStrings(step.dependsOn),
      capabilities,
      runtimeKind: step.runtimeKind,
      timeoutSeconds: step.timeoutSeconds,
      labelValues,
      ...(step.budget === undefined ? {} : { budget: step.budget }),
    },
  }
}

/**
 * Instantiates a template version into an immutable, digested snapshot.
 *
 * Returns a `Result` rather than throwing, because every failure here is a
 * decision about an authored document and a caller — the TUI, the simulator, a
 * bridge handler — wants to render the refusal rather than catch it. The
 * repository's own methods throw, which is the split `RoleRepository` already
 * draws: a missing template is a programming error at the call site, and a
 * parameter that fails validation is a user-visible outcome.
 *
 * `templateRef.templateVersion` omitted instantiates the latest version. A caller
 * that wants a run reproducible against a future edit must pass the version
 * explicitly, because "latest" is a moving target — the snapshot records which
 * version it came from either way, so the audit trail survives the difference.
 */
export function instantiateTemplate(
  repository: RunTemplateRepository,
  templateRef: RunTemplateRef,
  inputs: Readonly<Record<string, unknown>>,
  options: InstantiateTemplateOptions,
): Result<RunTemplateSnapshot> {
  // Non-throwing lookup, so a missing template is a refusal rather than an
  // exception crossing a function whose signature promises a Result.
  const template = repository.getTemplate(templateRef)
  if (template === undefined) {
    return refuse(
      "validation",
      "workflow.template_not_found",
      `workflow.template_not_found: template '${templateRef.templateId}'${
        templateRef.templateVersion === undefined ? "" : ` version ${templateRef.templateVersion}`
      } does not exist`,
    )
  }

  let bound: Readonly<Record<string, TemplateParameterValue>>
  try {
    const boundResult = bindParameters(template, inputs)
    if (!boundResult.ok) return boundResult
    bound = boundResult.value
  } catch (error) {
    return refuse("validation", "workflow.invalid_template", describeUnexpected(error, template.templateId))
  }

  // The graph is checked on the AUTHORED steps before anything is built, so a
  // cycle is reported as a cycle rather than as whatever the resolver made of
  // it. `resolveStepDependencyGraph` is called twice on purpose: once here for
  // the authored graph, and once below on the resolved graph, which is a
  // different value and is the defence-in-depth re-check the module docblock
  // describes.
  const authoredGraph = resolveStepDependencyGraph(template.steps)
  if (!authoredGraph.ok) {
    return authoredGraph
  }

  const resolvedSteps: ResolvedStep[] = []
  for (const step of [...template.steps].sort((left, right) => compareCodeUnits(left.stepId, right.stepId))) {
    let resolved: ResolvedStep
    try {
      const resolvedResult = resolveStep(template, step, bound, options.roleCapabilities)
      if (!resolvedResult.ok) return resolvedResult
      resolved = resolvedResult.value
    } catch (error) {
      return refuse("validation", "workflow.invalid_template", describeUnexpected(error, template.templateId))
    }
    resolvedSteps.push(resolved)
  }

  const resolvedGraph = resolveStepDependencyGraph(resolvedSteps)
  if (!resolvedGraph.ok) return resolvedGraph

  const snapshotDigest = computeRunTemplateSnapshotDigest({
    templateId: template.templateId,
    templateVersion: template.templateVersion,
    boundParameters: bound,
    resolvedSteps,
    ruleSetDigest: template.ruleSetDigest,
  })

  // The snapshot is validated through its OWN schema before it is returned.
  // Freezing an unvalidated snapshot would make the freeze an assertion about a
  // document nobody checked; this way the artifact a caller holds is one that
  // satisfies `runTemplateSnapshotSchema`, including the safety-floor bound on
  // `timeoutSeconds` that `resolvedStepSchema` expresses.
  const parsed = runTemplateSnapshotSchema.safeParse({
    templateId: template.templateId,
    templateVersion: template.templateVersion,
    snapshotDigest,
    boundParameters: bound,
    resolvedSteps,
    capturedAt: options.now,
    ruleSetDigest: template.ruleSetDigest,
  })
  if (!parsed.success) {
    return refuse(
      "validation",
      "workflow.invalid_template",
      `workflow.invalid_template: the derived snapshot does not satisfy runTemplateSnapshotSchema: ${parsed.error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`,
    )
  }

  return { ok: true, value: deepFreezeWorkflow(parsed.data) }
}

/** One line for an unexpected throw, with the template named. Never the stack. */
function describeUnexpected(error: unknown, templateId: string): string {
  if (error instanceof WorkflowTemplateError) return error.message
  return `workflow.invalid_template: instantiating template '${templateId}' raised an unexpected error: ${error instanceof Error ? error.message : String(error)}`
}
