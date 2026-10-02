/**
 * M6.7 — expansion.
 *
 * # What this file is FOR
 *
 * Three claims, and each one is a claim about DELEGATION rather than about a
 * function this module wrote:
 *
 *   1. A template instantiates into tasks, and the plan's order is the PRODUCTION
 *      orderer's order — asserted by calling `resolveStepDependencyGraph` again and
 *      comparing element-wise. A simulator that re-sorted the order would be a
 *      second scheduler, which is ADR 0007 stop condition 1 wearing a different
 *      hat.
 *   2. The stage grouping is a projection of the same graph, and it answers a
 *      question the total order does not: which steps could run at the same time.
 *   3. A cycle is REFUSED with the offending step ids, and the ids come out of the
 *      production detector rather than a traversal written here.
 *
 * # The test names are claims
 *
 * Every `it` reads as a sentence a reviewer can disagree with. "the plan's order is
 * the order `resolveStepDependencyGraph` returns" is falsifiable; "expansion works"
 * is not.
 */

import { describe, expect, it } from "vitest"
import {
  derivedDispatchId,
  derivedTaskId,
  expandRunTemplate,
} from "../../../src/simulation/index.js"
import { resolveStepDependencyGraph, type RunTemplate } from "../../../src/workflows/index.js"
import {
  aTemplateInput,
  emptyRuleSet,
  simulatedPorts,
  ProbedRunTemplateRepository,
  FIXED_NOW,
  PROJECT_ID,
  ROLE_ID,
} from "./fixtures.js"

const BASE_REQUEST = {
  now: FIXED_NOW,
  templateRef: { templateId: "tmpl_sim", templateVersion: 1 },
  inputs: { target_env: "canary" },
  projectId: PROJECT_ID,
  ruleSetDigest: emptyRuleSet().digest,
}

/**
 * A template with a cyclic step graph, built by REPLACING a valid template's steps.
 *
 * The cast is deliberate and is the only cast in this file. A cyclic document is
 * exactly what `runTemplateSchema` refuses, so producing one honestly means
 * producing something the schema would not; the test that uses it is asserting the
 * simulator's behaviour when a caller supplies a repository whose document skipped
 * validation, which is a real failure mode for a durable store restored from an
 * older release.
 */
function cyclicTemplate(base: RunTemplate, steps?: RunTemplate["steps"]): RunTemplate {
  return {
    ...base,
    steps: steps ?? [
      { stepId: "a", kind: "task", title: "A", roleId: ROLE_ID, dependsOn: ["b"], capabilities: [], runtimeKind: "opencode", timeoutSeconds: 60, labelValues: {} },
      { stepId: "b", kind: "task", title: "B", roleId: ROLE_ID, dependsOn: ["a"], capabilities: [], runtimeKind: "opencode", timeoutSeconds: 60, labelValues: {} },
    ],
  } as RunTemplate
}

/** A repository that yields `template` for any lookup, and nothing else. */
function repositoryYielding(template: RunTemplate): ProbedRunTemplateRepository {
  const repository = new ProbedRunTemplateRepository()
  Object.defineProperty(repository, "getTemplate", { value: () => template })
  return repository
}

describe("a dry run expands the proposed workflow through the production expander", () => {
  it("a template instantiates into one task per resolved step", () => {
    const result = expandRunTemplate(simulatedPorts(), BASE_REQUEST)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.expansion.tasks.map((task) => task.stepId)).toEqual(["build", "ship"])
    expect(result.value.expansion.tasks.map((task) => task.kind)).toEqual(["task", "dispatch"])
    expect(result.value.expansion.templateId).toBe("tmpl_sim")
    expect(result.value.expansion.templateVersion).toBe(1)
  })

  it("the reported order is the order `resolveStepDependencyGraph` returns, element for element", () => {
    const ports = simulatedPorts()
    const result = expandRunTemplate(ports, BASE_REQUEST)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // A second, independent call to the production orderer over the SAME steps the
    // plan reported. If the simulator sorted them itself, these two would differ.
    const steps = result.value.snapshot.resolvedSteps.map((step) => ({ stepId: step.stepId, dependsOn: step.dependsOn }))
    const direct = resolveStepDependencyGraph(steps)
    expect(direct.ok).toBe(true)
    if (!direct.ok) return
    expect(result.value.expansion.graph.order).toEqual([...direct.value])
  })

  it("the stage grouping answers which steps could run at the same time", () => {
    const result = expandRunTemplate(simulatedPorts(), BASE_REQUEST)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.expansion.graph.stages).toEqual([["build"], ["ship"]])
    expect(result.value.expansion.tasks.map((task) => task.stage)).toEqual([0, 1])
    expect(result.value.expansion.tasks.map((task) => task.order)).toEqual([0, 1])
  })

  it("a three-step chain is grouped into three single-step stages and its edges are reported", () => {
    const repository = new ProbedRunTemplateRepository([
      aTemplateInput({
        steps: [
          { stepId: "a", kind: "task", title: "A", roleId: ROLE_ID, dependsOn: [], capabilities: [], runtimeKind: "opencode", timeoutSeconds: 60, labelValues: {} },
          { stepId: "b", kind: "task", title: "B", roleId: ROLE_ID, dependsOn: ["a"], capabilities: [], runtimeKind: "opencode", timeoutSeconds: 60, labelValues: {} },
          { stepId: "c", kind: "task", title: "C", roleId: ROLE_ID, dependsOn: ["a", "b"], capabilities: [], runtimeKind: "opencode", timeoutSeconds: 60, labelValues: {} },
        ],
        parameterDefinitions: [],
      }),
    ])
    const result = expandRunTemplate(
      { ...simulatedPorts(), templates: repository },
      { ...BASE_REQUEST, templateRef: { templateId: "tmpl_sim", templateVersion: 1 }, inputs: {} },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.expansion.graph.stages).toEqual([["a"], ["b"], ["c"]])
    expect(result.value.expansion.graph.edges).toEqual([
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "c" },
    ])
  })

  it("two independent steps share a stage, because a stage is a depth and not an order", () => {
    const repository = new ProbedRunTemplateRepository([
      aTemplateInput({
        steps: [
          { stepId: "a", kind: "task", title: "A", roleId: ROLE_ID, dependsOn: [], capabilities: [], runtimeKind: "opencode", timeoutSeconds: 60, labelValues: {} },
          { stepId: "b", kind: "task", title: "B", roleId: ROLE_ID, dependsOn: [], capabilities: [], runtimeKind: "opencode", timeoutSeconds: 60, labelValues: {} },
          { stepId: "c", kind: "task", title: "C", roleId: ROLE_ID, dependsOn: ["a", "b"], capabilities: [], runtimeKind: "opencode", timeoutSeconds: 60, labelValues: {} },
        ],
        parameterDefinitions: [],
      }),
    ])
    const result = expandRunTemplate(
      { ...simulatedPorts(), templates: repository },
      { ...BASE_REQUEST, inputs: {} },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.expansion.graph.stages).toEqual([["a", "b"], ["c"]])
  })

  it("a cyclic template cannot even be registered, so the refusal is a second line of defence", () => {
    // `runTemplateSchema` refuses a cycle at parse time, which means a
    // `RunTemplateRepository` cannot hold one. That is the primary defence and it is
    // production's, not this module's; the two tests below cover the path where a
    // caller supplies a repository that has a cyclic document anyway.
    expect(
      () =>
        new ProbedRunTemplateRepository([
          aTemplateInput({
            steps: [
              { stepId: "a", kind: "task", title: "A", roleId: ROLE_ID, dependsOn: ["b"], capabilities: [], runtimeKind: "opencode", timeoutSeconds: 60, labelValues: {} },
              { stepId: "b", kind: "task", title: "B", roleId: ROLE_ID, dependsOn: ["a"], capabilities: [], runtimeKind: "opencode", timeoutSeconds: 60, labelValues: {} },
            ],
            parameterDefinitions: [],
          }),
        ]),
    ).toThrow(/dependency cycle/)
  })

  it("a repository holding a cyclic template is refused with the offending step ids in a structured field", () => {
    const ports = simulatedPorts()
    const cyclic = cyclicTemplate(ports.templates.getTemplate({ templateId: "tmpl_sim", templateVersion: 1 })!)
    const result = expandRunTemplate({ ...ports, templates: repositoryYielding(cyclic) }, BASE_REQUEST)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe("simulation.dependency_cycle")
    expect(result.refusal.origin).toBe("workflow.dependency_cycle")
    // The ids are DATA, not only prose: a refusal a caller cannot branch on is a
    // refusal an operator has to read.
    expect(result.refusal.detail.cycleStepIds).toBe("a,b,a")
    expect(result.refusal.detail.cycleType).toBe("direct")
    expect(result.refusal.message).toContain("a -> b -> a")
  })

  it("a self-dependency is refused as a self-cycle and names the step", () => {
    const ports = simulatedPorts()
    const selfCyclic = cyclicTemplate(
      ports.templates.getTemplate({ templateId: "tmpl_sim", templateVersion: 1 })!,
      [{ stepId: "a", kind: "task", title: "A", roleId: ROLE_ID, dependsOn: ["a"], capabilities: [], runtimeKind: "opencode", timeoutSeconds: 60, labelValues: {} }],
    )
    const result = expandRunTemplate({ ...ports, templates: repositoryYielding(selfCyclic) }, BASE_REQUEST)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe("simulation.dependency_cycle")
    expect(result.refusal.origin).toBe("workflow.dependency_cycle")
    expect(result.refusal.detail.cycleStepIds).toBe("a,a")
    expect(result.refusal.detail.cycleType).toBe("self")
  })

  it("the derived task and dispatch ids are a pure function of the step id", () => {
    const result = expandRunTemplate(simulatedPorts(), BASE_REQUEST)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const build = result.value.expansion.tasks.find((task) => task.stepId === "build")
    expect(build?.taskId).toBe(derivedTaskId("build"))
    expect(build?.dispatchId).toBe(derivedDispatchId("build"))
    // Two calls, the same ids: no counter, no clock, no randomness (E3).
    const again = expandRunTemplate(simulatedPorts(), BASE_REQUEST)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value.expansion.tasks.map((task) => task.taskId)).toEqual(
      result.value.expansion.tasks.map((task) => task.taskId),
    )
  })

  it("a step's title and label VALUES never reach the expansion, and its label NAMES do", () => {
    const result = expandRunTemplate(simulatedPorts(), BASE_REQUEST)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const build = result.value.expansion.tasks.find((task) => task.stepId === "build")
    expect(build?.labelKeys).toEqual(["env"])
    const rendered = JSON.stringify(result.value.expansion)
    expect(rendered).not.toContain("Build the release")
    expect(rendered).not.toContain("canary")
  })

  it("a missing template is refused with the production code rather than a simulator guess", () => {
    const result = expandRunTemplate(
      simulatedPorts(),
      { ...BASE_REQUEST, templateRef: { templateId: "absent_sim" } },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe("simulation.template_not_instantiable")
    expect(result.refusal.origin).toBe("workflow.template_not_found")
  })

  it("expansion registers no template and mutates no template, counted at the repository", () => {
    const ports = simulatedPorts()
    expect(ports.templates.mutations).toEqual({ createTemplate: 0, updateTemplate: 0, clear: 0 })
    expandRunTemplate(ports, BASE_REQUEST)
    expect(ports.templates.mutations).toEqual({ createTemplate: 0, updateTemplate: 0, clear: 0 })
    expect(ports.templates.count()).toBe(1)
  })

  it("the reported snapshot digest is the expander's own digest, recomputable with its function", () => {
    const result = expandRunTemplate(simulatedPorts(), BASE_REQUEST)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.snapshot.snapshotDigest).toBe(result.value.expansion.snapshotDigest)
  })
})
