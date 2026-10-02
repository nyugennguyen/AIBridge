/**
 * `instantiateTemplate`: binding, graph resolution, the safety refusals, and the
 * digest.
 *
 * WHY THIS FILE TESTS `resolveStepDependencyGraph` DIRECTLY. The repository
 * refuses to store a template whose graph is cyclic, so no template reachable
 * through `createTemplate` can produce a cycle at instantiation time. Testing the
 * instantiation refusal therefore requires either breaking the repository first
 * — which would test the wrong thing — or calling the exported graph function
 * with a hand-built graph. This file does the latter, and
 * `immutability.test.ts` separately proves the repository is the only way in.
 *
 * WHY THE GRAPH FUNCTION IS ALSO CROSS-CHECKED AGAINST THE KERNEL'S OWN. It is a
 * deliberate reimplementation of the DFS in `src/orchestration/scheduler/dag.ts`,
 * and a reimplementation that disagrees with the original is exactly the drift
 * the module docblock says it avoids. The cross-check runs both on the same
 * graphs and asserts the same verdict, so a change to either that made them
 * diverge fails here.
 *
 * WHY SAFETY IS IN THIS FILE AND NOT IN `schema.test.ts`. The floor applies to
 * what a RUN needs, and a run is the snapshot, so the check belongs at the point
 * where the snapshot is built. `schema.test.ts` asserts the complementary
 * property: that a template with a too-long timeout IS storable, which is what
 * gives the instantiation refusal something to report.
 */

import { describe, expect, it } from "vitest"
import { validateDag } from "../../../src/orchestration/scheduler/dag.js"
import { DependencyCycleError } from "../../../src/orchestration/scheduler/types.js"
import type { TaskId } from "../../../src/orchestration/identifiers.js"
import {
  SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS,
  RunTemplateRepository,
  compareCodeUnits,
  computeRunTemplateSnapshotDigest,
  instantiateTemplate,
  resolveStepDependencyGraph,
  sortedUniqueStrings,
  verifyRunTemplateSnapshotDigest,
  type ResolvedStep,
  type RunTemplateSnapshot,
} from "../../../src/workflows/index.js"
import {
  BASE_STEPS,
  FIXED_NOW,
  LATER_NOW,
  OTHER_ROLE_ID,
  ROLE_CAPABILITIES,
  ROLE_ID,
  clone,
  noRoles,
  resolvedStep,
  roleCapabilitiesGranting,
  validTemplateInput,
} from "./fixtures.js"

/** A repository holding the base fixture at version 1. */
function repositoryWithTemplate(overrides: Parameters<typeof validTemplateInput>[0] = {}): RunTemplateRepository {
  const repository = new RunTemplateRepository()
  repository.createTemplate(validTemplateInput(overrides))
  return repository
}

/** Instantiates the base fixture, asserting success. */
function instantiateOk(
  repository: RunTemplateRepository,
  inputs: Readonly<Record<string, unknown>> = { target_env: "staging" },
  now = FIXED_NOW,
  roleCapabilities?: Parameters<typeof instantiateTemplate>[3]["roleCapabilities"],
): RunTemplateSnapshot {
  const result = instantiateTemplate(
    repository,
    { templateId: "tmpl-release" },
    inputs,
    roleCapabilities === undefined ? { now } : { now, roleCapabilities },
  )
  if (!result.ok) throw new Error(`expected a snapshot, got ${result.error.code}: ${result.error.message}`)
  return result.value
}

/** Instantiates and returns the refusal, asserting that there was one. */
function instantiateErr(
  repository: RunTemplateRepository,
  inputs: Readonly<Record<string, unknown>>,
  options: Parameters<typeof instantiateTemplate>[3] = { now: FIXED_NOW },
): { code: string; message: string } {
  const result = instantiateTemplate(repository, { templateId: "tmpl-release" }, inputs, options)
  if (result.ok) throw new Error("expected a refusal, got a snapshot")
  return { code: result.error.code, message: result.error.message }
}

describe("a successful instantiation", () => {
  it("produces a snapshot that records the template identity and the captured instant", () => {
    const snapshot = instantiateOk(repositoryWithTemplate(), { target_env: "staging" }, FIXED_NOW)
    expect(snapshot.templateId).toBe("tmpl-release")
    expect(snapshot.templateVersion).toBe(1)
    expect(snapshot.capturedAt).toBe(FIXED_NOW)
    expect(snapshot.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("binds the supplied value for a required parameter and the declared defaults for the rest", () => {
    const snapshot = instantiateOk(repositoryWithTemplate(), { target_env: "staging" })
    expect(snapshot.boundParameters).toEqual({ target_env: "staging", retries: 2, path: "path-1", stage: "canary", dry_run: false })
  })

  it("lets a supplied value override a declared default", () => {
    const snapshot = instantiateOk(repositoryWithTemplate(), { target_env: "prod", retries: 5, stage: "stable", dry_run: true })
    expect(snapshot.boundParameters.retries).toBe(5)
    expect(snapshot.boundParameters.stage).toBe("stable")
    expect(snapshot.boundParameters.dry_run).toBe(true)
  })

  it("omits an optional parameter that has neither a supplied value nor a default, rather than binding a placeholder", () => {
    const repository = repositoryWithTemplate({
      parameterDefinitions: [
        { name: "target_env", type: "string", required: true, minLength: 1, maxLength: 8 },
        { name: "optional_note", type: "string", required: false, minLength: 0, maxLength: 32 },
      ],
      steps: [{ ...BASE_STEPS[0]! }],
    })
    const snapshot = instantiateOk(repository, { target_env: "prod" })
    // A placeholder would put a value in the digest that the author never chose,
    // and would make "left unbound" indistinguishable from "bound to that".
    expect(Object.keys(snapshot.boundParameters)).toEqual(["target_env"])
    expect("optional_note" in snapshot.boundParameters).toBe(false)
  })

  it("binds an optional parameter that WAS supplied, so absent and unbound are different outcomes", () => {
    const repository = repositoryWithTemplate({
      parameterDefinitions: [
        { name: "target_env", type: "string", required: true, minLength: 1, maxLength: 8 },
        { name: "optional_note", type: "string", required: false, minLength: 0, maxLength: 32 },
      ],
      steps: [{ ...BASE_STEPS[0]! }],
    })
    expect(instantiateOk(repository, { target_env: "prod", optional_note: "checked by hand" }).boundParameters.optional_note).toBe(
      "checked by hand",
    )
  })

  it("resolves each step's label bindings to the bound values, sorted by label key", () => {
    const snapshot = instantiateOk(repositoryWithTemplate(), { target_env: "prod", stage: "stable" })
    expect(resolvedStep(snapshot, "build").labelValues).toEqual({ env: "prod" })
    expect(resolvedStep(snapshot, "ship").labelValues).toEqual({ env: "prod", stage: "stable" })
    expect(Object.keys(resolvedStep(snapshot, "ship").labelValues)).toEqual(["env", "stage"])
  })

  it("renders an enum label binding as the member that was bound, so a display shows the choice not its index", () => {
    const repository = repositoryWithTemplate({
      steps: [{ ...BASE_STEPS[0]!, labelValues: { channel: "stage" } }],
    })
    expect(resolvedStep(instantiateOk(repository, { target_env: "prod", stage: "stable" }), "build").labelValues).toEqual({
      channel: "stable",
    })
  })

  it("renders a project path label as the opaque id that was bound, never as text a filesystem could interpret", () => {
    const repository = repositoryWithTemplate({
      steps: [{ ...BASE_STEPS[0]!, labelValues: { path: "path" } }],
    })
    expect(resolvedStep(instantiateOk(repository, { target_env: "prod", path: "path-9" }), "build").labelValues).toEqual({
      path: "path-9",
    })
  })

  it("refuses a label bound to an optional TEXTUAL parameter that was left unbound", () => {
    // Reachable even though the document is valid: the schema only knows that the
    // parameter exists, and whether it is bound is an instantiation-time fact.
    const repository = repositoryWithTemplate({
      parameterDefinitions: [
        { name: "target_env", type: "string", required: true, minLength: 1, maxLength: 8 },
        { name: "optional_channel", type: "enum", required: false, enumValues: ["alpha", "beta"] },
      ],
      steps: [{ ...BASE_STEPS[0]!, labelValues: { channel: "optional_channel" } }],
    })
    expect(instantiateErr(repository, { target_env: "prod" }).code).toBe("workflow.label_unbound")
    expect(instantiateErr(repository, { target_env: "prod" }).message).toContain("optional_channel")
  })

  it("carries each step's role, capabilities, timeout, and budget into the resolved step", () => {
    const repository = repositoryWithTemplate({
      steps: [{ ...BASE_STEPS[0]!, budget: { maximumFanOut: 4, usageUnit: "tokens" } }],
    })
    const build = resolvedStep(instantiateOk(repository, { target_env: "prod" }), "build")
    expect(build.roleId).toBe(ROLE_ID)
    expect(build.timeoutSeconds).toBe(600)
    expect(build.budget).toEqual({ maximumFanOut: 4, usageUnit: "tokens" })
  })

  it("omits the budget entirely when the step declares none, rather than recording an empty object", () => {
    const build = resolvedStep(instantiateOk(repositoryWithTemplate(), { target_env: "prod" }), "build")
    expect("budget" in build).toBe(false)
  })

  it("resolves the template's declared rule set digest into the snapshot without re-parsing anything", () => {
    const digest = `sha256:${"b".repeat(64)}`
    const snapshot = instantiateOk(repositoryWithTemplate({ ruleSetDigest: digest }), { target_env: "prod" })
    expect(snapshot.ruleSetDigest).toBe(digest)
  })

  it("records a null rule set digest for a template that declares none", () => {
    expect(instantiateOk(repositoryWithTemplate(), { target_env: "prod" }).ruleSetDigest).toBeNull()
  })

  it("instantiates the LATEST version when no version is named, and records which one it used", () => {
    const repository = repositoryWithTemplate()
    repository.updateTemplate({ templateId: "tmpl-release" }, { name: "v2", createdAt: LATER_NOW })
    const snapshot = instantiateOk(repository, { target_env: "prod" })
    expect(snapshot.templateVersion).toBe(2)
  })

  it("instantiates an explicitly named version even when a newer one exists", () => {
    const repository = repositoryWithTemplate()
    repository.updateTemplate({ templateId: "tmpl-release" }, { name: "v2", createdAt: LATER_NOW })
    const pinned = instantiateTemplate(repository, { templateId: "tmpl-release", templateVersion: 1 }, { target_env: "prod" }, { now: FIXED_NOW })
    if (!pinned.ok) throw new Error(`expected a snapshot, got ${pinned.error.code}`)
    expect(pinned.value.templateVersion).toBe(1)
  })

  it("refuses a template that does not exist, rather than throwing across a Result-returning function", () => {
    const repository = new RunTemplateRepository()
    const result = instantiateTemplate(repository, { templateId: "absent" }, {}, { now: FIXED_NOW })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.error.code).toBe("workflow.template_not_found")
    expect(result.error.category).toBe("validation")
  })

  it("names the missing version in the refusal, so 'no template' and 'no version' are distinguishable", () => {
    const result = instantiateTemplate(repositoryWithTemplate(), { templateId: "tmpl-release", templateVersion: 4 }, { target_env: "prod" }, { now: FIXED_NOW })
    if (result.ok) throw new Error("unreachable")
    expect(result.error.message).toMatch(/version 4 does not exist/)
  })
})

describe("the dependency graph", () => {
  const linear = [
    { stepId: "build", dependsOn: [] },
    { stepId: "ship", dependsOn: ["build"] },
  ]

  it("orders an acyclic graph so every step follows the ones it depends on", () => {
    const result = resolveStepDependencyGraph(linear)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.value).toEqual(["build", "ship"])
  })

  it("orders independent steps by code unit, so the order is total rather than insertion-dependent", () => {
    const result = resolveStepDependencyGraph([
      { stepId: "zulu", dependsOn: [] },
      { stepId: "alpha", dependsOn: [] },
      { stepId: "mike", dependsOn: [] },
    ])
    if (!result.ok) throw new Error("unreachable")
    expect(result.value).toEqual(["alpha", "mike", "zulu"])
  })

  it("accepts a diamond, because a diamond is not a cycle", () => {
    const result = resolveStepDependencyGraph([
      { stepId: "build", dependsOn: [] },
      { stepId: "lint", dependsOn: ["build"] },
      { stepId: "ship", dependsOn: ["build"] },
      { stepId: "announce", dependsOn: ["lint", "ship"] },
    ])
    if (!result.ok) throw new Error(`expected a graph, got ${result.error.code}`)
    expect(result.value[0]).toBe("build")
    expect(result.value[result.value.length - 1]).toBe("announce")
  })

  it("refuses a self-dependency and names the step once", () => {
    const result = resolveStepDependencyGraph([{ stepId: "build", dependsOn: ["build"] }])
    if (result.ok) throw new Error("unreachable")
    expect(result.error.code).toBe("workflow.dependency_cycle")
    expect(result.error.message).toMatch(/depends on itself/)
  })

  it("refuses a direct two-step cycle and names both steps in the path", () => {
    const result = resolveStepDependencyGraph([
      { stepId: "build", dependsOn: ["ship"] },
      { stepId: "ship", dependsOn: ["build"] },
    ])
    if (result.ok) throw new Error("unreachable")
    expect(result.error.code).toBe("workflow.dependency_cycle")
    expect(result.error.message).toContain("build")
    expect(result.error.message).toContain("ship")
  })

  it("refuses an indirect three-step cycle and names every step in the cycle", () => {
    const result = resolveStepDependencyGraph([
      { stepId: "build", dependsOn: ["verify"] },
      { stepId: "ship", dependsOn: ["build"] },
      { stepId: "verify", dependsOn: ["ship"] },
    ])
    if (result.ok) throw new Error("unreachable")
    expect(result.error.code).toBe("workflow.dependency_cycle")
    expect(result.error.message).toMatch(/Indirect cycle/)
    for (const stepId of ["build", "ship", "verify"]) expect(result.error.message).toContain(stepId)
  })

  it("reports the same offending step ids for the same graph on every run, so two refusals can be compared", () => {
    const cyclic = [
      { stepId: "build", dependsOn: ["verify"] },
      { stepId: "ship", dependsOn: ["build"] },
      { stepId: "verify", dependsOn: ["ship"] },
    ]
    const first = resolveStepDependencyGraph(cyclic)
    const second = resolveStepDependencyGraph([...cyclic].reverse())
    if (first.ok || second.ok) throw new Error("unreachable")
    // Supplied in a different order, refused with the same path.
    expect(second.error.message).toBe(first.error.message)
  })

  it("refuses a dependsOn naming a step that does not exist, with a DIFFERENT code from a cycle", () => {
    // Two different author mistakes: a misspelled id and an unorderable graph.
    const result = resolveStepDependencyGraph([{ stepId: "build", dependsOn: ["compile"] }])
    if (result.ok) throw new Error("unreachable")
    expect(result.error.code).toBe("workflow.unknown_dependency")
    expect(result.error.message).toMatch(/depends on 'compile'/)
  })

  it("agrees with the kernel's own DAG validator on every graph this module claims to agree with", () => {
    // The reimplementation is deliberate (see the module docblock) and this is
    // what keeps it honest. The kernel throws where this module returns a Result,
    // so each verdict is reduced to a boolean and compared.
    const cases: readonly (readonly { stepId: string; dependsOn: readonly string[] }[])[] = [
      linear,
      [{ stepId: "build", dependsOn: [] }],
      [{ stepId: "build", dependsOn: ["build"] }],
      [
        { stepId: "build", dependsOn: ["ship"] },
        { stepId: "ship", dependsOn: ["build"] },
      ],
      [
        { stepId: "build", dependsOn: ["verify"] },
        { stepId: "ship", dependsOn: ["build"] },
        { stepId: "verify", dependsOn: ["ship"] },
      ],
      [
        { stepId: "build", dependsOn: [] },
        { stepId: "lint", dependsOn: ["build"] },
        { stepId: "ship", dependsOn: ["build"] },
        { stepId: "announce", dependsOn: ["lint", "ship"] },
      ],
    ]
    for (const steps of cases) {
      const ours = resolveStepDependencyGraph(steps)
      let kernelAccepted = true
      let kernelCycle = false
      try {
        validateDag(
          steps.map((step) => ({
            taskId: step.stepId as unknown as TaskId,
            dependencies: step.dependsOn.map((taskId) => ({ taskId: taskId as unknown as TaskId, failurePolicy: "fail" as const })),
          })),
        )
      } catch (error) {
        kernelAccepted = false
        if (error instanceof DependencyCycleError) kernelCycle = true
      }
      if (ours.ok) {
        expect(kernelAccepted, JSON.stringify(steps)).toBe(true)
      } else {
        expect(kernelAccepted, JSON.stringify(steps)).toBe(false)
        // A dangling dependency is `DanglingDependencyError` in the kernel and a
        // different code here; only the CYCLE verdict is compared directly.
        if (ours.error.code === "workflow.dependency_cycle") expect(kernelCycle, JSON.stringify(steps)).toBe(true)
      }
    }
  })

  it("accepts an acyclic template through instantiation, so the graph path is exercised end to end", () => {
    const snapshot = instantiateOk(repositoryWithTemplate(), { target_env: "prod" })
    expect(snapshot.resolvedSteps.map((step) => step.stepId)).toEqual(["build", "ship"])
    expect(resolvedStep(snapshot, "ship").dependsOn).toEqual(["build"])
  })
})

describe("a step cannot need a wider permission than its role or the safety floor allows", () => {
  it("refuses a step whose timeout exceeds the safety floor, and names the value and the floor", () => {
    // The repository accepts it (the authoring ceiling is wider, deliberately),
    // so this refusal is the only thing standing between an authored template and
    // a run that would need more wall-clock than the floor permits.
    const repository = repositoryWithTemplate({
      steps: [{ ...BASE_STEPS[0]!, timeoutSeconds: SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS + 1 }],
    })
    const refusal = instantiateErr(repository, { target_env: "prod" })
    expect(refusal.code).toBe("workflow.timeout_exceeds_safety_floor")
    expect(refusal.message).toContain(String(SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS + 1))
    expect(refusal.message).toContain("build")
  })

  it("accepts a step timeout exactly at the safety floor, because a limit that rejects its own boundary is a different limit", () => {
    const repository = repositoryWithTemplate({
      steps: [{ ...BASE_STEPS[0]!, timeoutSeconds: SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS }],
    })
    expect(resolvedStep(instantiateOk(repository, { target_env: "prod" }), "build").timeoutSeconds).toBe(
      SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS,
    )
  })

  it("refuses a step requesting a capability its role does not grant", () => {
    const repository = repositoryWithTemplate({
      steps: [{ ...BASE_STEPS[0]!, capabilities: ["fs.read", "net.fetch"] }],
    })
    const refusal = instantiateErr(repository, { target_env: "prod" }, { now: FIXED_NOW, roleCapabilities: roleCapabilitiesGranting(["fs.read"]) })
    expect(refusal.code).toBe("workflow.capability_exceeds_role")
    expect(refusal.message).toContain("net.fetch")
    expect(refusal.message).toContain(ROLE_ID)
  })

  it("accepts a step requesting exactly what its role grants", () => {
    const repository = repositoryWithTemplate({
      steps: [{ ...BASE_STEPS[0]!, capabilities: ["fs.read", "shell.run"] }],
    })
    const snapshot = instantiateOk(repository, { target_env: "prod" }, FIXED_NOW, roleCapabilitiesGranting(ROLE_CAPABILITIES))
    expect(resolvedStep(snapshot, "build").capabilities).toEqual(["fs.read", "shell.run"])
  })

  it("refuses a step naming a role no snapshot was supplied for", () => {
    const refusal = instantiateErr(repositoryWithTemplate(), { target_env: "prod" }, { now: FIXED_NOW, roleCapabilities: noRoles() })
    expect(refusal.code).toBe("workflow.role_not_found")
    expect(refusal.message).toContain(ROLE_ID)
  })

  it("does not run the role check for a step that requests no capabilities, so a role-only template still instantiates", () => {
    const repository = repositoryWithTemplate({ steps: [{ ...BASE_STEPS[0]!, capabilities: [] }] })
    const result = instantiateTemplate(repository, { templateId: "tmpl-release" }, { target_env: "prod" }, { now: FIXED_NOW, roleCapabilities: noRoles() })
    expect(result.ok).toBe(true)
  })

  it("skips the role check entirely when no resolver is supplied, which is the documented limitation", () => {
    // Named here so the limitation is a stated behaviour with a test, rather than
    // a gap a reader has to discover. The kernel remains the enforcement point.
    const repository = repositoryWithTemplate({
      steps: [{ ...BASE_STEPS[0]!, capabilities: ["net.fetch"] }],
    })
    expect(instantiateOk(repository, { target_env: "prod" }).resolvedSteps).toHaveLength(1)
  })

  it("cannot express allowDestructiveEffects or allowExternalEffects at all, because no step schema declares them", () => {
    // The ADR's representability mechanism (section 7.7, first of three): a
    // schema-valid step has no field that could enable an effect the floor
    // denies, so the refusal path cannot be reached by a valid document. There
    // is no branch here that handles the escalation because there is nothing to
    // handle.
    const steps = clone(BASE_STEPS) as unknown as Record<string, unknown>[]
    steps[0]!["allowDestructiveEffects"] = true
    let thrown: unknown
    try {
      repositoryWithTemplate({ steps: steps as never })
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error).message).toMatch(/allowDestructiveEffects/)
    expect((thrown as { code?: string }).code).toBe("workflow.invalid_template")
  })

  it("declares no such field on the resolved step either, so a derived value cannot introduce one", () => {
    const snapshot = instantiateOk(repositoryWithTemplate(), { target_env: "prod" })
    expect(Object.keys(snapshot.resolvedSteps[0]!).sort()).toEqual([
      "capabilities",
      "dependsOn",
      "kind",
      "labelValues",
      "roleId",
      "runtimeKind",
      "stepId",
      "timeoutSeconds",
      "title",
    ])
  })
})

describe("the snapshot digest", () => {
  it("verifies against its own recorded value immediately after instantiation", () => {
    expect(verifyRunTemplateSnapshotDigest(instantiateOk(repositoryWithTemplate(), { target_env: "prod" }))).toBe(true)
  })

  it("is identical across two independent repository instances holding the same template", () => {
    const first = instantiateOk(repositoryWithTemplate(), { target_env: "prod" })
    const second = instantiateOk(repositoryWithTemplate(), { target_env: "prod" })
    expect(second.snapshotDigest).toBe(first.snapshotDigest)
    expect(second).toEqual(first)
  })

  it("does not change when the captured instant changes, because a clock reading is not the run's behaviour", () => {
    const early = instantiateOk(repositoryWithTemplate(), { target_env: "prod" }, FIXED_NOW)
    const late = instantiateOk(repositoryWithTemplate(), { target_env: "prod" }, LATER_NOW)
    expect(late.capturedAt).not.toBe(early.capturedAt)
    expect(late.snapshotDigest).toBe(early.snapshotDigest)
  })

  it("changes when a single bound parameter value changes", () => {
    const a = instantiateOk(repositoryWithTemplate(), { target_env: "prod" })
    const b = instantiateOk(repositoryWithTemplate(), { target_env: "stage" })
    expect(b.snapshotDigest).not.toBe(a.snapshotDigest)
  })

  it("changes when a single bound parameter changes from its default to the same value as a neighbour", () => {
    // The point: the digest covers the BOUND values, so two runs that agree on
    // every step still differ when a parameter differs.
    const a = instantiateOk(repositoryWithTemplate(), { target_env: "prod", retries: 0 })
    const b = instantiateOk(repositoryWithTemplate(), { target_env: "prod", retries: 5 })
    expect(b.snapshotDigest).not.toBe(a.snapshotDigest)
  })

  it("changes when one step's timeout changes", () => {
    const base = repositoryWithTemplate({ steps: BASE_STEPS })
    const slower = repositoryWithTemplate({ steps: BASE_STEPS.map((step) => (step.stepId === "ship" ? { ...step, timeoutSeconds: 1_200 } : step)) })
    expect(instantiateOk(slower, { target_env: "prod" }).snapshotDigest).not.toBe(instantiateOk(base, { target_env: "prod" }).snapshotDigest)
  })

  it("changes when one step's role changes", () => {
    const base = repositoryWithTemplate()
    const otherRole = repositoryWithTemplate({ steps: BASE_STEPS.map((step) => ({ ...step, roleId: OTHER_ROLE_ID })) })
    expect(instantiateOk(otherRole, { target_env: "prod" }).snapshotDigest).not.toBe(instantiateOk(base, { target_env: "prod" }).snapshotDigest)
  })

  it("changes when the template version changes, so a snapshot names the definition it came from", () => {
    const repository = repositoryWithTemplate()
    const v1 = instantiateOk(repository, { target_env: "prod" })
    repository.updateTemplate({ templateId: "tmpl-release" }, { name: "renamed only", createdAt: LATER_NOW })
    const v2 = instantiateOk(repository, { target_env: "prod" })
    // A rename alone does not change behaviour, but the two versions are two
    // definitions and the snapshot has to say which one it came from.
    expect(v2.templateVersion).toBe(2)
    expect(v2.snapshotDigest).not.toBe(v1.snapshotDigest)
  })

  it("changes when the declared rule set digest changes", () => {
    const base = repositoryWithTemplate({ ruleSetDigest: `sha256:${"a".repeat(64)}` })
    const other = repositoryWithTemplate({ ruleSetDigest: `sha256:${"c".repeat(64)}` })
    expect(instantiateOk(other, { target_env: "prod" }).snapshotDigest).not.toBe(instantiateOk(base, { target_env: "prod" }).snapshotDigest)
  })

  it("does not change when only the template's description changes, because a description is a label", () => {
    const base = repositoryWithTemplate({ steps: BASE_STEPS })
    const redescribed = repositoryWithTemplate({ steps: BASE_STEPS, description: "A different sentence entirely." })
    expect(instantiateOk(redescribed, { target_env: "prod" }).snapshotDigest).toBe(instantiateOk(base, { target_env: "prod" }).snapshotDigest)
  })

  it("can be recomputed by a caller from the snapshot's own fields, which is what makes it checkable", () => {
    const snapshot = instantiateOk(repositoryWithTemplate(), { target_env: "prod" })
    const recomputed = computeRunTemplateSnapshotDigest({
      templateId: snapshot.templateId,
      templateVersion: snapshot.templateVersion,
      boundParameters: snapshot.boundParameters,
      resolvedSteps: snapshot.resolvedSteps,
      ruleSetDigest: snapshot.ruleSetDigest,
    })
    expect(recomputed).toBe(snapshot.snapshotDigest)
  })

  it("reports a tampered snapshot as unverifiable rather than throwing", () => {
    const snapshot = instantiateOk(repositoryWithTemplate(), { target_env: "prod" })
    const tampered = { ...snapshot, boundParameters: { ...snapshot.boundParameters, target_env: "attacker" } }
    expect(verifyRunTemplateSnapshotDigest(tampered)).toBe(false)
  })

  it("reports a snapshot whose steps were replaced as unverifiable, because the digest covers the steps", () => {
    const snapshot = instantiateOk(repositoryWithTemplate(), { target_env: "prod" })
    const tampered = { ...snapshot, resolvedSteps: [snapshot.resolvedSteps[0]!] as readonly ResolvedStep[] }
    expect(verifyRunTemplateSnapshotDigest(tampered)).toBe(false)
  })

  it("is stable when the same steps are supplied in a different order, so the author's sequence is not the run's identity", () => {
    const forwards = repositoryWithTemplate({ steps: BASE_STEPS })
    const backwards = repositoryWithTemplate({ steps: [...BASE_STEPS].reverse() })
    expect(instantiateOk(backwards, { target_env: "prod" }).snapshotDigest).toBe(instantiateOk(forwards, { target_env: "prod" }).snapshotDigest)
  })
})

describe("ordering inside the snapshot", () => {
  it("sorts the resolved steps by step id, independently of the order they were authored in", () => {
    const repository = repositoryWithTemplate({ steps: [...BASE_STEPS].reverse() })
    expect(instantiateOk(repository, { target_env: "prod" }).resolvedSteps.map((step) => step.stepId)).toEqual(["build", "ship"])
  })

  it("sorts and de-duplicates a step's capabilities", () => {
    const repository = repositoryWithTemplate({
      steps: [{ ...BASE_STEPS[0]!, capabilities: ["shell.run", "fs.read", "shell.run"] }],
    })
    expect(resolvedStep(instantiateOk(repository, { target_env: "prod" }), "build").capabilities).toEqual(["fs.read", "shell.run"])
  })

  it("sorts and de-duplicates a step's dependencies", () => {
    const repository = repositoryWithTemplate({
      steps: [
        BASE_STEPS[0]!,
        { ...BASE_STEPS[1]!, dependsOn: ["build", "build"] },
        { stepId: "lint", kind: "task", title: "Lint", roleId: ROLE_ID, dependsOn: [], capabilities: [], runtimeKind: "opencode", timeoutSeconds: 60, labelValues: {} },
        { stepId: "verify", kind: "task", title: "Verify", roleId: ROLE_ID, dependsOn: ["lint", "build"], capabilities: [], runtimeKind: "opencode", timeoutSeconds: 60, labelValues: {} },
      ],
    })
    expect(resolvedStep(instantiateOk(repository, { target_env: "prod" }), "verify").dependsOn).toEqual(["build", "lint"])
  })

  it("inserts the bound parameters in sorted key order, so the value a caller reads and the value that was hashed are built alike", () => {
    const keys = Object.keys(instantiateOk(repositoryWithTemplate(), { target_env: "prod" }).boundParameters)
    expect(keys).toEqual([...keys].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1)))
  })

  it("orders step ids by UTF-16 code unit, not by the reader's collation", () => {
    // Every legal step id is lowercase, so a step id cannot distinguish the two
    // orderings. What CAN is the ordering HELPER, which every sort in this module
    // routes through, and the label-value keys (opaque tokens, which may be
    // mixed case). Both are asserted here so a future `localeCompare` is a failing
    // test rather than a digest that depends on the machine it was computed on.
    expect(compareCodeUnits("Zebra", "apple")).toBeLessThan(0)
    expect(compareCodeUnits("apple", "Zebra")).toBeGreaterThan(0)
    expect(compareCodeUnits("a", "a")).toBe(0)
    // The locale answer for the same pair, which is what makes this a real test
    // rather than a restatement of the definition. If a future runtime's locale
    // ever agreed with code-unit order, this line would need replacing, not
    // deleting — and the deletion would be noticed in review.
    expect("Zebra".localeCompare("apple")).toBeGreaterThan(0)

    const repository = repositoryWithTemplate({
      steps: [{ ...BASE_STEPS[0]!, labelValues: { Zebra: "target_env", apple: "stage" } }],
    })
    expect(Object.keys(resolvedStep(instantiateOk(repository, { target_env: "prod" }), "build").labelValues)).toEqual([
      "Zebra",
      "apple",
    ])
  })

  it("sorts a helper's output with the same comparator, so a caller sorting for display agrees with the digest", () => {
    expect(sortedUniqueStrings(["b", "A", "a", "b"])).toEqual(["A", "a", "b"])
  })
})

describe("determinism: fifty instantiations of one template are fifty identical artifacts", () => {
  it("produces one digest across fifty calls, in one repository and across fifty repositories", () => {
    // Fifty rather than two, because the failure this guards against is an
    // ACCUMULATING one — a set that grows, a counter that increments, a closure
    // that captures something — and two calls cannot see a state that only a
    // third would expose. Fifty fresh repositories additionally rules out the
    // digest depending on the store's history rather than on the inputs.
    const shared = repositoryWithTemplate()
    const fromOneRepository = Array.from({ length: 50 }, () => instantiateOk(shared, { target_env: "prod" }))
    const fromFiftyRepositories = Array.from({ length: 50 }, () => instantiateOk(repositoryWithTemplate(), { target_env: "prod" }))

    const digests = new Set([...fromOneRepository, ...fromFiftyRepositories].map((snapshot) => snapshot.snapshotDigest))
    expect(digests.size).toBe(1)
    for (const snapshot of fromOneRepository) expect(verifyRunTemplateSnapshotDigest(snapshot)).toBe(true)
  })

  it("keeps every collection in every one of the fifty snapshots sorted and de-duplicated", () => {
    // Deliberately fed an unsorted, duplicated template so the sorting has
    // something to do: a fixture whose collections were already sorted would let
    // a missing sort pass unnoticed.
    const repository = repositoryWithTemplate({
      steps: [
        { ...BASE_STEPS[1]!, dependsOn: ["verify", "build", "verify"] },
        { ...BASE_STEPS[0]!, capabilities: ["shell.run", "fs.read", "shell.run", "fs.write"] },
        { stepId: "verify", kind: "task", title: "Verify", roleId: ROLE_ID, dependsOn: ["build"], capabilities: [], runtimeKind: "opencode", timeoutSeconds: 60, labelValues: { stage: "stage" } },
      ],
    })
    const isSorted = (values: readonly string[]): boolean =>
      values.every((value, index) => index === 0 || values[index - 1]! < value)

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const snapshot = instantiateOk(repository, { target_env: "prod" })
      expect(isSorted(snapshot.resolvedSteps.map((step) => step.stepId)), "steps").toBe(true)
      expect(isSorted(Object.keys(snapshot.boundParameters)), "bound parameter keys").toBe(true)
      for (const step of snapshot.resolvedSteps) {
        expect(isSorted(step.capabilities), `capabilities of ${step.stepId}`).toBe(true)
        expect(isSorted(step.dependsOn), `dependsOn of ${step.stepId}`).toBe(true)
        expect(isSorted(Object.keys(step.labelValues)), `labelValues of ${step.stepId}`).toBe(true)
      }
    }
  })

  it("produces the same digest whether the steps were authored forwards or backwards", () => {
    // The ordering decision, asserted end to end: declaration order is visible to
    // the reader but is not part of the run's identity.
    const forwards = repositoryWithTemplate({ steps: BASE_STEPS })
    const backwards = repositoryWithTemplate({ steps: [...BASE_STEPS].reverse() })
    const digests = new Set([
      instantiateOk(forwards, { target_env: "prod" }).snapshotDigest,
      instantiateOk(backwards, { target_env: "prod" }).snapshotDigest,
    ])
    expect(digests.size).toBe(1)
  })

  it("produces the same digest whether a step's capabilities were authored in either order, or with duplicates", () => {
    const ordered = repositoryWithTemplate({ steps: [{ ...BASE_STEPS[0]!, capabilities: ["fs.read", "shell.run"] }] })
    const reversed = repositoryWithTemplate({ steps: [{ ...BASE_STEPS[0]!, capabilities: ["shell.run", "fs.read"] }] })
    const duplicated = repositoryWithTemplate({ steps: [{ ...BASE_STEPS[0]!, capabilities: ["fs.read", "shell.run", "fs.read"] }] })
    const digests = new Set(
      [ordered, reversed, duplicated].map((repository) => instantiateOk(repository, { target_env: "prod" }).snapshotDigest),
    )
    expect(digests.size).toBe(1)
  })

  it("produces the same digest whichever order the caller's inputs are written in", () => {
    const repository = repositoryWithTemplate()
    const forwards = instantiateOk(repository, { target_env: "prod", retries: 3, stage: "stable" }).snapshotDigest
    const backwards = instantiateOk(repository, { stage: "stable", retries: 3, target_env: "prod" }).snapshotDigest
    expect(backwards).toBe(forwards)
  })
})
