/**
 * `RunTemplateRepository`: append-only versioning, the three named errors, and
 * the clone-on-read guarantee that makes template edits unable to reach stored
 * state.
 *
 * WHY THE VERSIONING TESTS ARE THE BULK OF THIS FILE. The repository's only job
 * is to make "version N of this template" a stable name. Everything else in the
 * module rests on that: the snapshot records the version it came from, so a run
 * can be traced to a definition; the conflict error exists so two definitions
 * cannot share one name. So the cases below are about the name, and they cover
 * the three ways it can go wrong — a reused version with new content, a version
 * that skips, and a version that is not a positive integer.
 *
 * WHY CLONE-ON-READ IS TESTED RATHER THAN DESCRIBED. The module chooses
 * `structuredClone` over `RoleRepository`'s return-the-frozen-object, and the
 * argument for that choice rests entirely on the repository never handing out its
 * own objects. A comment claiming that is worth nothing; a test that mutates a
 * returned template and then reads it again is worth everything.
 */

import { describe, expect, it } from "vitest"
import {
  InvalidRunTemplateVersionError,
  RunTemplateNotFoundError,
  RunTemplateRepository,
  RunTemplateVersionConflictError,
  WorkflowTemplateError,
} from "../../../src/workflows/index.js"
import {
  BASE_STEPS,
  FIXED_NOW,
  LATER_NOW,
  ROLE_ID,
  clone,
  validTemplateInput,
} from "./fixtures.js"

/** A repository holding one template at version 1. */
function repositoryWithOneTemplate(): RunTemplateRepository {
  const repository = new RunTemplateRepository()
  repository.createTemplate(validTemplateInput())
  return repository
}

describe("creating a template", () => {
  it("assigns version 1 to the first template and stores what it was given", () => {
    const repository = new RunTemplateRepository()
    const template = repository.createTemplate(validTemplateInput())
    expect(template.templateVersion).toBe(1)
    expect(template.name).toBe("release")
    expect(template.projectId).toBe("proj-1")
    expect(repository.count()).toBe(1)
    expect(repository.templateCount()).toBe(1)
  })

  it("registers the templates it is constructed with", () => {
    const repository = new RunTemplateRepository([
      validTemplateInput(),
      validTemplateInput({ templateId: "tmpl-hotfix" }),
    ])
    expect(repository.listTemplateIds()).toEqual(["tmpl-hotfix", "tmpl-release"])
    expect(repository.count()).toBe(2)
  })

  it("preserves the order the author declared, because the stored document is the one a person reads", () => {
    // Deliberately NOT sorted here, and that is the design: sorting belongs to
    // the SNAPSHOT, which is the digest-covered artifact. A stored template that
    // silently reordered a human's list would display a shape the author never
    // wrote, and the ADR's rule is that declaration order is part of the
    // normalized form and therefore visible to the user (section 10.2).
    // `instantiate.test.ts` asserts the snapshot IS sorted.
    const repository = new RunTemplateRepository()
    const template = repository.createTemplate(validTemplateInput())
    expect(template.steps.find((step) => step.stepId === "build")!.capabilities).toEqual(["shell.run", "fs.read"])
    expect(template.steps.map((step) => step.stepId)).toEqual(["build", "ship"])
  })

  it("keeps the declared parameter order, because declaration order is part of the document a reader sees", () => {
    const template = new RunTemplateRepository().createTemplate(validTemplateInput())
    expect(template.parameterDefinitions.map((definition) => definition.name)).toEqual([
      "target_env",
      "retries",
      "path",
      "stage",
      "dry_run",
    ])
  })

  it("defaults a missing description to the empty string rather than refusing the template", () => {
    const template = new RunTemplateRepository().createTemplate(validTemplateInput({ description: undefined }))
    expect(template.description).toBe("")
  })

  it("defaults a missing rule set digest to null, which is the default-installation shape", () => {
    const template = new RunTemplateRepository().createTemplate(validTemplateInput({ ruleSetDigest: undefined }))
    expect(template.ruleSetDigest).toBeNull()
  })

  it("refuses a template that does not satisfy its own schema, with the failing path named", () => {
    const repository = new RunTemplateRepository()
    let thrown: unknown
    try {
      repository.createTemplate(validTemplateInput({ steps: [] }))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(WorkflowTemplateError)
    expect((thrown as WorkflowTemplateError).code).toBe("workflow.invalid_template")
    expect((thrown as WorkflowTemplateError).message).toMatch(/workflow.invalid_template/)
  })

  it("refuses an empty template id", () => {
    const repository = new RunTemplateRepository()
    expect(() => repository.createTemplate(validTemplateInput({ templateId: "" }))).toThrow(WorkflowTemplateError)
  })

  it("converts every refusal into a ContractError a caller can render", () => {
    try {
      new RunTemplateRepository().createTemplate(validTemplateInput({ steps: [] }))
      throw new Error("unreachable")
    } catch (error) {
      const contract = (error as WorkflowTemplateError).toContractError()
      expect(contract.category).toBe("validation")
      expect(contract.code).toBe("workflow.invalid_template")
      expect(contract.retryable).toBe(false)
    }
  })
})

describe("a version is immutable and append-only", () => {
  it("refuses to reuse an existing version number for different content", () => {
    const repository = repositoryWithOneTemplate()
    let thrown: unknown
    try {
      repository.createTemplate(validTemplateInput({ templateVersion: 1, name: "something else" }))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RunTemplateVersionConflictError)
    expect((thrown as RunTemplateVersionConflictError).code).toBe("workflow.version_conflict")
    expect((thrown as RunTemplateVersionConflictError).category).toBe("conflict")
    expect((thrown as RunTemplateVersionConflictError).version).toBe(1)
    // And the stored version is untouched: the refusal did not half-apply.
    expect(repository.getLatestTemplate("tmpl-release")!.name).toBe("release")
  })

  it("returns the existing version when a re-registration is identical in behaviour", () => {
    const repository = repositoryWithOneTemplate()
    const again = repository.createTemplate(validTemplateInput({ templateVersion: 1, createdAt: LATER_NOW }))
    expect(again.name).toBe("release")
    // The FIRST registration's `createdAt` survives, because `createdAt` is not
    // part of the behavioural comparison: two registrations of the same content
    // at two instants are the same version.
    expect(again.createdAt).toBe(FIXED_NOW)
    expect(repository.count()).toBe(1)
  })

  it("refuses a version that skips one, because a gap is a version this store cannot show an operator", () => {
    const repository = repositoryWithOneTemplate()
    let thrown: unknown
    try {
      repository.createTemplate(validTemplateInput({ templateVersion: 3 }))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(InvalidRunTemplateVersionError)
    expect((thrown as InvalidRunTemplateVersionError).message).toMatch(/without gaps/)
  })

  it("refuses a version that is not a positive safe integer", () => {
    const repository = repositoryWithOneTemplate()
    for (const templateVersion of [0, -3, 1.5]) {
      expect(() => repository.createTemplate(validTemplateInput({ templateVersion })), String(templateVersion)).toThrow(
        InvalidRunTemplateVersionError,
      )
    }
  })

  it("accepts an explicit version one above the latest, because that is how a caller records its own numbering", () => {
    const repository = repositoryWithOneTemplate()
    repository.createTemplate(validTemplateInput({ templateVersion: 2, name: "release two" }))
    expect(repository.listVersions("tmpl-release").map((template) => template.templateVersion)).toEqual([1, 2])
  })
})

describe("updateTemplate always writes a new version", () => {
  it("increments the version and inherits every field the update does not name", () => {
    const repository = repositoryWithOneTemplate()
    const updated = repository.updateTemplate(
      { templateId: "tmpl-release" },
      { name: "release v2", createdAt: LATER_NOW },
    )
    expect(updated.templateVersion).toBe(2)
    expect(updated.name).toBe("release v2")
    expect(updated.createdAt).toBe(LATER_NOW)
    expect(updated.projectId).toBe("proj-1")
    expect(updated.parameterDefinitions).toHaveLength(5)
    expect(updated.steps.map((step) => step.stepId)).toEqual(["build", "ship"])
    // The prior version is untouched and still readable.
    expect(repository.getTemplate({ templateId: "tmpl-release", templateVersion: 1 })!.name).toBe("release")
  })

  it("bumps the version even when the edit changes nothing, so the version records content rather than intent", () => {
    const repository = repositoryWithOneTemplate()
    const updated = repository.updateTemplate({ templateId: "tmpl-release" }, { name: "release" })
    expect(updated.templateVersion).toBe(2)
    expect(repository.count()).toBe(2)
  })

  it("does not default createdAt to a clock read, so the stored value depends only on the caller", () => {
    const repository = repositoryWithOneTemplate()
    const updated = repository.updateTemplate({ templateId: "tmpl-release" }, { name: "v2" })
    // Inherits the latest version's `createdAt` rather than stamping "now".
    expect(updated.createdAt).toBe(FIXED_NOW)
  })

  it("refuses an update that names a version other than latest-plus-one", () => {
    const repository = repositoryWithOneTemplate()
    let thrown: unknown
    try {
      repository.updateTemplate({ templateId: "tmpl-release" }, { name: "v9", templateVersion: 9 })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(InvalidRunTemplateVersionError)
    expect((thrown as InvalidRunTemplateVersionError).message).toMatch(/must increment version from 1 to 2/)
  })

  it("refuses to update a template that does not exist", () => {
    const repository = new RunTemplateRepository()
    let thrown: unknown
    try {
      repository.updateTemplate({ templateId: "absent" }, { name: "v2" })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RunTemplateNotFoundError)
    expect((thrown as RunTemplateNotFoundError).code).toBe("workflow.template_not_found")
  })

  it("applies a step edit to the new version only, and leaves the prior version's steps alone", () => {
    const repository = repositoryWithOneTemplate()
    const updatedSteps = clone(BASE_STEPS).map((step) =>
      step.stepId === "ship" ? { ...step, timeoutSeconds: 1_200 } : step,
    )
    const updated = repository.updateTemplate({ templateId: "tmpl-release" }, { steps: updatedSteps, name: "slower ship" })
    const shipV2 = updated.steps.find((step) => step.stepId === "ship")!
    const shipV1 = repository.requireTemplate({ templateId: "tmpl-release", templateVersion: 1 }).steps.find(
      (step) => step.stepId === "ship",
    )!
    expect(shipV2.timeoutSeconds).toBe(1_200)
    expect(shipV1.timeoutSeconds).toBe(900)
  })

  it("grows the version chain without bound, and every version stays readable", () => {
    const repository = repositoryWithOneTemplate()
    for (let version = 2; version <= 8; version += 1) {
      repository.updateTemplate({ templateId: "tmpl-release" }, { name: `release v${version}` })
    }
    expect(repository.listVersions("tmpl-release").map((template) => template.templateVersion)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(repository.getLatestTemplate("tmpl-release")!.name).toBe("release v8")
  })
})

describe("lookups", () => {
  it("returns the latest version when none is named", () => {
    const repository = repositoryWithOneTemplate()
    repository.updateTemplate({ templateId: "tmpl-release" }, { name: "v2" })
    expect(repository.getTemplate({ templateId: "tmpl-release" })!.templateVersion).toBe(2)
    expect(repository.getLatestTemplate("tmpl-release")!.templateVersion).toBe(2)
  })

  it("returns undefined for an unknown template, and a named refusal for requireTemplate", () => {
    const repository = repositoryWithOneTemplate()
    expect(repository.getTemplate({ templateId: "absent" })).toBeUndefined()
    expect(() => repository.requireTemplate({ templateId: "absent" })).toThrow(RunTemplateNotFoundError)
  })

  it("returns undefined for an unknown VERSION of a known template, so a caller can ask about history", () => {
    const repository = repositoryWithOneTemplate()
    expect(repository.getTemplate({ templateId: "tmpl-release", templateVersion: 7 })).toBeUndefined()
    expect(() => repository.requireTemplate({ templateId: "tmpl-release", templateVersion: 7 })).toThrow(
      RunTemplateNotFoundError,
    )
  })

  it("names the version in the not-found refusal, because 'no such template' and 'no such version' need different words", () => {
    try {
      repositoryWithOneTemplate().requireTemplate({ templateId: "tmpl-release", templateVersion: 7 })
      throw new Error("unreachable")
    } catch (error) {
      expect((error as RunTemplateNotFoundError).message).toMatch(/version 7 does not exist/)
      expect((error as RunTemplateNotFoundError).templateVersion).toBe(7)
    }
  })

  it("reports existence for a template and for a specific version", () => {
    const repository = repositoryWithOneTemplate()
    expect(repository.hasTemplate({ templateId: "tmpl-release" })).toBe(true)
    expect(repository.hasTemplate({ templateId: "tmpl-release", templateVersion: 1 })).toBe(true)
    expect(repository.hasTemplate({ templateId: "tmpl-release", templateVersion: 2 })).toBe(false)
    expect(repository.hasTemplate({ templateId: "absent" })).toBe(false)
  })

  it("returns an empty list of versions for an unknown template rather than throwing", () => {
    expect(repositoryWithOneTemplate().listVersions("absent")).toEqual([])
  })
})

describe("listing", () => {
  it("lists versions of one template in ascending order", () => {
    const repository = repositoryWithOneTemplate()
    for (let version = 2; version <= 4; version += 1) {
      repository.updateTemplate({ templateId: "tmpl-release" }, { name: `v${version}` })
    }
    expect(repository.listVersions("tmpl-release").map((template) => template.templateVersion)).toEqual([1, 2, 3, 4])
  })

  it("lists template ids sorted by code unit, independently of insertion order", () => {
    const repository = new RunTemplateRepository([
      validTemplateInput({ templateId: "tmpl-zulu" }),
      validTemplateInput({ templateId: "tmpl-alpha" }),
      validTemplateInput({ templateId: "tmpl-mike" }),
    ])
    expect(repository.listTemplateIds()).toEqual(["tmpl-alpha", "tmpl-mike", "tmpl-zulu"])
  })

  it("lists every version of every template when no filter is given", () => {
    const repository = new RunTemplateRepository([validTemplateInput(), validTemplateInput({ templateId: "tmpl-other" })])
    repository.updateTemplate({ templateId: "tmpl-release" }, { name: "v2" })
    expect(repository.listTemplates()).toHaveLength(3)
  })

  it("filters by project, name, and a case-sensitive substring query", () => {
    const repository = new RunTemplateRepository([
      validTemplateInput(),
      validTemplateInput({
        templateId: "tmpl-other",
        projectId: "proj-2",
        name: "hotfix",
        description: "Patch one already-shipped release.",
      }),
    ])
    expect(repository.listTemplates({ projectId: "proj-2" }).map((template) => template.templateId)).toEqual(["tmpl-other"])
    expect(repository.listTemplates({ name: "release" }).map((template) => template.templateId)).toEqual(["tmpl-release"])
    // The query matches the description as well as the name, so it finds the
    // template by a phrase only the description carries.
    expect(repository.listTemplates({ query: "ship a release" }).map((template) => template.templateId)).toEqual(["tmpl-release"])
    // Case-sensitive, so a query in the wrong case finds nothing rather than
    // something: a search that matches under the reader's collation is a search
    // whose result depends on the machine it ran on.
    expect(repository.listTemplates({ query: "RELEASE" })).toEqual([])
  })

  it("narrows to the latest version per template when asked, so a filtered list has one row per template", () => {
    const repository = repositoryWithOneTemplate()
    repository.updateTemplate({ templateId: "tmpl-release" }, { name: "v2" })
    const latest = repository.listTemplates({ latestOnly: true })
    expect(latest).toHaveLength(1)
    expect(latest[0]!.templateVersion).toBe(2)
  })

  it("ANDs every filter field rather than unioning them", () => {
    const repository = repositoryWithOneTemplate()
    expect(repository.listTemplates({ projectId: "proj-1", name: "nope" })).toEqual([])
  })

  it("counts versions and template ids separately, because the two numbers are both useful", () => {
    const repository = repositoryWithOneTemplate()
    repository.updateTemplate({ templateId: "tmpl-release" }, { name: "v2" })
    repository.createTemplate(validTemplateInput({ templateId: "tmpl-other" }))
    expect(repository.count()).toBe(3)
    expect(repository.templateCount()).toBe(2)
  })

  it("empties itself on clear", () => {
    const repository = repositoryWithOneTemplate()
    repository.clear()
    expect(repository.count()).toBe(0)
    expect(repository.listTemplateIds()).toEqual([])
  })
})

describe("the repository hands out copies, never its own objects", () => {
  it("returns a value a caller can mutate, because that is what makes the copy meaningful", () => {
    const repository = repositoryWithOneTemplate()
    // Cast to the mutable shape: every schema here declares `.readonly()`, so the
    // stored type says `readonly` while the clone handed out is genuinely mutable.
    const template = repository.getLatestTemplate("tmpl-release")! as unknown as {
      name: string
      steps: { timeoutSeconds: number }[]
    }
    template.name = "mutated by the caller"
    template.steps[0]!.timeoutSeconds = 1
    expect(template.name).toBe("mutated by the caller")
  })

  it("leaves the stored version unchanged after a caller mutates what it was handed", () => {
    const repository = repositoryWithOneTemplate()
    // The cast is deliberate: every schema in this module declares `.readonly()`, so
    // the STORED type is `readonly`. The clone handed out is mutable at runtime —
    // that is the whole point of clone-on-read — and this proves it.
    const template = repository.getLatestTemplate("tmpl-release")! as unknown as {
      name: string
      steps: { timeoutSeconds: number }[]
      parameterDefinitions: { name: string }[]
    }
    template.name = "mutated by the caller"
    template.steps[0]!.timeoutSeconds = 1
    template.parameterDefinitions[0]!.name = "renamed"
    template.steps.push({ ...template.steps[0]! })
    // The next read is a fresh copy of the stored state, not the mutated object.
    const fresh = repository.getLatestTemplate("tmpl-release")!
    expect(fresh.name).toBe("release")
    expect(fresh.steps[0]!.timeoutSeconds).toBe(600)
    expect(fresh.parameterDefinitions[0]!.name).toBe("target_env")
    expect(fresh.steps).toHaveLength(2)
  })

  it("returns two reads as two distinct objects, so mutating one cannot reach the other", () => {
    const repository = repositoryWithOneTemplate()
    const first = repository.getLatestTemplate("tmpl-release")!
    const second = repository.getLatestTemplate("tmpl-release")!
    expect(first).not.toBe(second)
    expect(first.steps[0]).not.toBe(second.steps[0])
    first.steps[0]!.title = "changed"
    expect(second.steps[0]!.title).toBe("Build the release")
  })

  it("shares no object between a stored template and the one a caller holds, at any depth", () => {
    // The depth check is the one that matters: a copy that shared one nested
    // array would leave that array reachable from stored state, and an edit that
    // pushed onto it would be a template edit nobody made.
    const repository = repositoryWithOneTemplate()
    const template = repository.getLatestTemplate("tmpl-release")!
    const stored = repository.getLatestTemplate("tmpl-release")!
    expect(template.steps).not.toBe(stored.steps)
    expect(template.steps[0]!.dependsOn).not.toBe(stored.steps[0]!.dependsOn)
    expect(template.steps[0]!.labelValues).not.toBe(stored.steps[0]!.labelValues)
    expect(template.parameterDefinitions).not.toBe(stored.parameterDefinitions)
  })

  it("hands out an UNfrozen copy, because a caller must be able to derive from a template", () => {
    // The stored value is deep-frozen; the copy is not. Both halves are
    // deliberate and the asymmetry is the design: the freeze makes the stored
    // object safe to keep, and the clone means callers never receive it, so a
    // caller who wants to compute something from a template can.
    //
    // Note what this test does NOT claim: that the stored object is frozen. That
    // is unobservable through every read path, precisely because each one
    // clones — which is the strongest statement the design can make about it.
    const copy = repositoryWithOneTemplate().getLatestTemplate("tmpl-release")!
    expect(Object.isFrozen(copy)).toBe(false)
    expect(Object.isFrozen(copy.steps)).toBe(false)
    expect(Object.isFrozen(copy.steps[0]!.dependsOn)).toBe(false)
    expect(Object.isFrozen(copy.parameterDefinitions)).toBe(false)
  })

  it("round-trips a template whose steps carry a budget, so the clone covers every legal field", () => {
    const repository = new RunTemplateRepository()
    const withBudget = validTemplateInput({
      steps: [{ ...BASE_STEPS[0]!, budget: { maximumFanOut: 4, usageUnit: "tokens" } }, BASE_STEPS[1]!],
    })
    const stored = repository.createTemplate(withBudget)
    const read = repository.requireTemplate({ templateId: "tmpl-release" })
    expect(read.steps[0]!.budget).toEqual({ maximumFanOut: 4, usageUnit: "tokens" })
    expect(stored.steps[0]!.budget).toEqual(read.steps[0]!.budget)
  })

  it("preserves the role id on every step through a clone, because that is the field the policy engine reads", () => {
    const read = repositoryWithOneTemplate().requireTemplate({ templateId: "tmpl-release" })
    for (const step of read.steps) expect(step.roleId).toBe(ROLE_ID)
  })
})

describe("the snapshot a template produces is not the template", () => {
  it("gives every read a template that is not identical to the one before it, so a snapshot cannot alias either", () => {
    // This is the precondition for the headline invariant in
    // `immutability.test.ts`: if the repository handed back one shared object,
    // that object could be reachable from a snapshot's derivation.
    const repository = repositoryWithOneTemplate()
    const reads = [1, 2, 3].map(() => repository.getLatestTemplate("tmpl-release")!)
    expect(new Set(reads).size).toBe(3)
  })

  it("leaves the prior version's stored content byte-identical across the update that supersedes it", () => {
    // The prior version's stored object is what a v1 snapshot was derived from,
    // so the update must not have been able to reach it. The clone-on-read path
    // makes these two reads different objects; the content equality is what says
    // the WRITE did not touch the stored one.
    const repository = repositoryWithOneTemplate()
    const before = repository.requireTemplate({ templateId: "tmpl-release", templateVersion: 1 })
    repository.updateTemplate(
      { templateId: "tmpl-release" },
      { name: "v2", steps: BASE_STEPS.map((step) => ({ ...step, timeoutSeconds: step.timeoutSeconds * 2 })) },
    )
    const after = repository.requireTemplate({ templateId: "tmpl-release", templateVersion: 1 })
    expect(after).not.toBe(before)
    expect(after).toEqual(before)
    expect(after.steps.map((step) => step.timeoutSeconds)).toEqual([600, 900])
  })
})
