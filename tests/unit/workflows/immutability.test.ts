/**
 * THE HEADLINE INVARIANT.
 *
 * > A `RunTemplateSnapshot` obtained from version N of a template is unchanged,
 * > in every field and in its digest, by any number of subsequent
 * > `updateTemplate` calls on that template.
 *
 * ADR 0007 section 15 states the requirement as a property of the snapshot
 * being a separate frozen value with its own digest, "not of a convention about
 * how templates are updated". So this file does not test the convention — it
 * attacks the property. It:
 *
 *   1. Snapshots, edits the template, and compares every field AND the digest.
 *   2. Edits the template repeatedly and confirms the earliest snapshot never
 *      drifts — because one edit passing does not prove that the tenth does not
 *      reach back.
 *   3. Checks `Object.isFrozen` at every level, and MUTATES A NESTED VALUE,
 *      asserting the real observed behaviour rather than the desired one. The
 *      top-level case is the one that passes trivially; `resolvedSteps[0]` and
 *      `resolvedSteps[0].dependsOn` are where a shallow freeze would leak.
 *   4. Proves the snapshot shares NO OBJECT with the template it came from, at
 *      any depth, by mutating the template the repository hands out afterwards
 *      and confirming the snapshot does not move.
 *   5. Confirms the digest still verifies after all of the above, because a
 *      snapshot whose fields are intact but whose digest no longer matches is
 *      not a snapshot either.
 */

import { describe, expect, it } from "vitest"
import {
  RunTemplateRepository,
  instantiateTemplate,
  verifyRunTemplateSnapshotDigest,
  type RunTemplateSnapshot,
} from "../../../src/workflows/index.js"
import {
  BASE_STEPS,
  FIXED_NOW,
  LATER_NOW,
  OTHER_ROLE_ID,
  ROLE_ID,
  clone,
  resolvedStep,
  validTemplateInput,
} from "./fixtures.js"

/** A repository holding the base fixture at version 1. */
function repositoryWithTemplate(): RunTemplateRepository {
  const repository = new RunTemplateRepository()
  repository.createTemplate(validTemplateInput())
  return repository
}

/** The instantiating call every case in this file uses. */
function snapshotOf(repository: RunTemplateRepository, inputs: Readonly<Record<string, unknown>> = { target_env: "prod" }): RunTemplateSnapshot {
  const result = instantiateTemplate(repository, { templateId: "tmpl-release" }, inputs, { now: FIXED_NOW })
  if (!result.ok) throw new Error(`expected a snapshot, got ${result.error.code}: ${result.error.message}`)
  return result.value
}

/** A snapshot captured at the base fixture's version, from a fresh repository. */
function snapshotAtVersionOne(): { repository: RunTemplateRepository; snapshot: RunTemplateSnapshot } {
  const repository = repositoryWithTemplate()
  return { repository, snapshot: snapshotOf(repository) }
}

describe("editing a template after instantiating it", () => {
  it("leaves the snapshot's bound parameters, steps, and digest all unchanged", () => {
    const { repository, snapshot } = snapshotAtVersionOne()
    const before = { bound: { ...snapshot.boundParameters }, steps: clone(snapshot.resolvedSteps), digest: snapshot.snapshotDigest }

    repository.updateTemplate(
      { templateId: "tmpl-release" },
      {
        name: "a different name entirely",
        description: "a different description entirely",
        createdAt: LATER_NOW,
        steps: BASE_STEPS.map((step) =>
          step.stepId === "ship"
            ? { ...step, timeoutSeconds: 1_200, capabilities: ["fs.read", "net.fetch"], dependsOn: ["build"] }
            : { ...step, title: "Rebuilt", roleId: OTHER_ROLE_ID },
        ),
      },
    )

    expect(snapshot.boundParameters).toEqual(before.bound)
    expect(snapshot.resolvedSteps).toEqual(before.steps)
    expect(snapshot.snapshotDigest).toBe(before.digest)
    // And the identity it recorded still says where it came from.
    expect(snapshot.templateVersion).toBe(1)
    expect(snapshot.templateId).toBe("tmpl-release")
  })

  it("leaves the snapshot's digest verifiable after the edit, which is what makes it still a snapshot", () => {
    const { repository, snapshot } = snapshotAtVersionOne()
    expect(verifyRunTemplateSnapshotDigest(snapshot)).toBe(true)
    repository.updateTemplate({ templateId: "tmpl-release" }, { name: "v2", createdAt: LATER_NOW })
    expect(verifyRunTemplateSnapshotDigest(snapshot)).toBe(true)
  })

  it("never lets an earlier snapshot drift across ten successive edits", () => {
    // One edit passing does not prove the tenth does not reach back. Each edit
    // here changes something the snapshot contains, so a leak would show up as a
    // diff on some iteration rather than as a slow accumulation nobody notices.
    const { repository, snapshot } = snapshotAtVersionOne()
    const before = { bound: { ...snapshot.boundParameters }, steps: clone(snapshot.resolvedSteps), digest: snapshot.snapshotDigest }

    for (let version = 2; version <= 11; version += 1) {
      repository.updateTemplate(
        { templateId: "tmpl-release" },
        {
          name: `release v${version}`,
          createdAt: LATER_NOW,
          parameterDefinitions: [
            // `target_env` and `stage` stay declared because the fixture's `ship`
            // step binds a label to each of them; `added_in` is the new one, and
            // its default moves with the version so the NEW snapshots really do
            // differ from each other.
            { name: "target_env", type: "string", required: true, minLength: 1, maxLength: 16 },
            { name: "stage", type: "enum", required: false, defaultValue: "canary", enumValues: ["canary", "stable"] },
            { name: "added_in", type: "integer", required: false, defaultValue: version, minimum: 0, maximum: 20 },
          ],
          steps: BASE_STEPS.map((step) => ({ ...step, timeoutSeconds: step.timeoutSeconds + version })),
        },
      )
      expect(snapshot.boundParameters, `after edit to v${version}`).toEqual(before.bound)
      expect(snapshot.resolvedSteps, `after edit to v${version}`).toEqual(before.steps)
      expect(snapshot.snapshotDigest, `after edit to v${version}`).toBe(before.digest)
    }

    // The new versions really did change, so the assertions above were not
    // vacuous: a template that never changed would let them all pass.
    const latest = snapshotOf(repository)
    expect(latest.templateVersion).toBe(11)
    expect(latest.snapshotDigest).not.toBe(before.digest)
    expect(latest.boundParameters.added_in).toBe(11)
  })

  it("leaves a v1 snapshot alone when a NEW version is pinned and instantiated alongside it", () => {
    // The realistic shape of the bug: two runs in flight, one from before an edit
    // and one from after. The older one must not acquire the newer definition.
    const { repository, snapshot } = snapshotAtVersionOne()
    repository.updateTemplate(
      { templateId: "tmpl-release" },
      { name: "v2", createdAt: LATER_NOW, steps: BASE_STEPS.map((step) => ({ ...step, timeoutSeconds: 1 })) },
    )
    const fromV2 = instantiateTemplate(repository, { templateId: "tmpl-release", templateVersion: 2 }, { target_env: "prod" }, { now: LATER_NOW })
    if (!fromV2.ok) throw new Error("expected a v2 snapshot")

    expect(snapshot.templateVersion).toBe(1)
    expect(resolvedStep(snapshot, "ship").timeoutSeconds).toBe(900)
    expect(resolvedStep(fromV2.value, "ship").timeoutSeconds).toBe(1)
    expect(fromV2.value.snapshotDigest).not.toBe(snapshot.snapshotDigest)
  })

  it("leaves the snapshot alone when the template it came from is edited through the repository's own returned copy", () => {
    // The second attack surface: not `updateTemplate` but a caller mutating the
    // template the repository handed it. Clone-on-read is what makes this a no-op
    // on stored state, and the snapshot is a further derivation away.
    const { repository, snapshot } = snapshotAtVersionOne()
    // Cast to the mutable shape on purpose: the clone IS mutable at runtime, and
    // the declared type is `readonly` because every schema in this module uses
    // `.readonly()`. The cast is the honest way to say "I am deliberately doing
    // what the type forbids, to prove the repository does not care".
    const template = repository.getLatestTemplate("tmpl-release")! as unknown as {
      name: string
      steps: { timeoutSeconds: number; capabilities: string[] }[]
    }
    template.name = "mutated"
    template.steps[0]!.timeoutSeconds = 1
    template.steps[0]!.capabilities.push("net.fetch")
    expect(snapshot.resolvedSteps[0]!.timeoutSeconds).toBe(600)
    expect(snapshot.resolvedSteps[0]!.capabilities).not.toContain("net.fetch")
    expect(verifyRunTemplateSnapshotDigest(snapshot)).toBe(true)
  })

  it("shares no object between a snapshot and the template it was derived from, at any depth", () => {
    // The structural claim underneath all of the above. If any object were
    // shared, immutability would be a coincidence of freezing rather than a
    // property of the derivation.
    const { repository, snapshot } = snapshotAtVersionOne()
    const template = repository.requireTemplate({ templateId: "tmpl-release", templateVersion: 1 })
    expect(snapshot.resolvedSteps).not.toBe(template.steps as unknown as typeof snapshot.resolvedSteps)
    expect(snapshot.resolvedSteps[0]).not.toBe(template.steps[0])
    expect(snapshot.resolvedSteps[0]!.dependsOn).not.toBe(template.steps[0]!.dependsOn)
    expect(snapshot.resolvedSteps[0]!.labelValues).not.toBe(template.steps[0]!.labelValues)
    expect(snapshot.boundParameters).not.toBe(template.parameterDefinitions)
    expect(snapshot.resolvedSteps[0]!.roleId).toBe(ROLE_ID)
  })
})

describe("a snapshot is frozen all the way down", () => {
  it("is frozen at the top level, at the step array, and at each step object", () => {
    const snapshot = snapshotOf(repositoryWithTemplate())
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.boundParameters)).toBe(true)
    expect(Object.isFrozen(snapshot.resolvedSteps)).toBe(true)
    for (const step of snapshot.resolvedSteps) expect(Object.isFrozen(step)).toBe(true)
  })

  it("is frozen at each step's nested collections, which is where a shallow freeze leaks", () => {
    const snapshot = snapshotOf(repositoryWithTemplate())
    for (const step of snapshot.resolvedSteps) {
      expect(Object.isFrozen(step.dependsOn)).toBe(true)
      expect(Object.isFrozen(step.capabilities)).toBe(true)
      expect(Object.isFrozen(step.labelValues)).toBe(true)
    }
  })

  it("throws when a caller pushes onto the resolved step array, and the array is unchanged", () => {
    // The REAL behaviour in a strict-mode ES module, not the desired one. The
    // push is attempted, the throw is observed, and the array is read afterwards
    // to prove the attempt changed nothing.
    const snapshot = snapshotOf(repositoryWithTemplate())
    expect(() => (snapshot.resolvedSteps as unknown as unknown[]).push({})).toThrow()
    expect(snapshot.resolvedSteps).toHaveLength(2)
  })

  it("throws when a caller pushes onto a nested dependency array, and the array is unchanged", () => {
    // The case a shallow freeze passes. `resolvedSteps[0].dependsOn` is a second
    // level down, and it is the array whose contents the digest covers.
    const snapshot = snapshotOf(repositoryWithTemplate())
    const dependencies = snapshot.resolvedSteps[1]!.dependsOn as unknown as string[]
    expect(() => dependencies.push("sneaky")).toThrow()
    expect(snapshot.resolvedSteps[1]!.dependsOn).toEqual(["build"])
  })

  it("throws when a caller overwrites a scalar field, and the field is unchanged", () => {
    const snapshot = snapshotOf(repositoryWithTemplate())
    const step = snapshot.resolvedSteps[0]! as unknown as Record<string, unknown>
    expect(() => {
      step.timeoutSeconds = 1
    }).toThrow()
    expect(snapshot.resolvedSteps[0]!.timeoutSeconds).toBe(600)
  })

  it("throws when a caller overwrites a key of the bound parameters, and the value is unchanged", () => {
    const snapshot = snapshotOf(repositoryWithTemplate())
    const bound = snapshot.boundParameters as unknown as Record<string, unknown>
    expect(() => {
      bound.target_env = "attacker"
    }).toThrow()
    expect(snapshot.boundParameters.target_env).toBe("prod")
  })

  it("throws when a caller overwrites a key of a nested label record, and the value is unchanged", () => {
    const snapshot = snapshotOf(repositoryWithTemplate())
    const labels = snapshot.resolvedSteps[0]!.labelValues as unknown as Record<string, unknown>
    expect(() => {
      labels.env = "attacker"
    }).toThrow()
    expect(snapshot.resolvedSteps[0]!.labelValues.env).toBe("prod")
  })

  it("throws when a caller replaces the snapshotDigest, which is what would stop it verifying", () => {
    const snapshot = snapshotOf(repositoryWithTemplate())
    const mutable = snapshot as unknown as Record<string, unknown>
    const original = snapshot.snapshotDigest
    expect(() => {
      mutable.snapshotDigest = `sha256:${"f".repeat(64)}`
    }).toThrow()
    expect(snapshot.snapshotDigest).toBe(original)
    expect(verifyRunTemplateSnapshotDigest(snapshot)).toBe(true)
  })

  it("still verifies after every one of those mutation attempts, so none of them landed", () => {
    const snapshot = snapshotOf(repositoryWithTemplate())
    const attemptAll = (): void => {
      const mutable = snapshot as unknown as Record<string, unknown>
      const steps = snapshot.resolvedSteps as unknown as unknown[]
      const step = snapshot.resolvedSteps[0]! as unknown as Record<string, unknown>
      const bound = snapshot.boundParameters as unknown as Record<string, unknown>
      for (const attempt of [
        () => steps.push({}),
        () => steps.pop(),
        () => (step["dependsOn"] as string[]).push("x"),
        () => (step["capabilities"] as string[]).splice(0, 1),
        () => {
          step["title"] = "x"
        },
        () => {
          bound["target_env"] = "x"
        },
        () => {
          mutable["snapshotDigest"] = "sha256:x"
        },
      ]) {
        try {
          attempt()
        } catch {
          // Expected: this module is strict-mode ESM, so a write to a frozen
          // property throws. Swallowed deliberately so one attempt cannot stop
          // the others from being tried.
        }
      }
    }
    attemptAll()
    attemptAll()
    expect(verifyRunTemplateSnapshotDigest(snapshot)).toBe(true)
    expect(snapshot.resolvedSteps).toHaveLength(2)
    expect(snapshot.resolvedSteps[0]!.title).toBe("Build the release")
    expect(snapshot.resolvedSteps[0]!.capabilities).toEqual(["fs.read", "shell.run"])
  })

  it("freezes the step objects themselves, which a `isFrozen(value) return` guard would have skipped", () => {
    // The regression this exists for. Zod's `.readonly()` already freezes the
    // arrays and records it produces, so the conventional `deepFreeze` guard
    // (`if (Object.isFrozen(value)) return value`) returns on the FIRST array it
    // meets and never reaches the step objects inside it. The result would look
    // frozen at every level a test usually checks — top level, step array — and
    // be fully mutable one level below. This asserts the level below.
    const snapshot = snapshotOf(repositoryWithTemplate())
    // Each step object is an element of an already-frozen array, so it is
    // reachable but no array-level check would have told us about it.
    for (const step of snapshot.resolvedSteps) {
      expect(Object.isFrozen(step)).toBe(true)
      expect(() => {
        ;(step as unknown as Record<string, unknown>)["title"] = "rewritten"
      }).toThrow()
    }
  })

  it("gives two separate instantiations of the same inputs two separate frozen values", () => {
    // Independence matters: a caller that freezes, annotates, or caches one
    // snapshot must not be able to reach the other.
    const repository = repositoryWithTemplate()
    const first = snapshotOf(repository)
    const second = snapshotOf(repository)
    expect(first).not.toBe(second)
    expect(first.resolvedSteps).not.toBe(second.resolvedSteps)
    expect(first.resolvedSteps[0]).not.toBe(second.resolvedSteps[0])
    expect(first.snapshotDigest).toBe(second.snapshotDigest)
  })
})

describe("an edit is the only way to change what a snapshot describes", () => {
  it("produces a different snapshot after an edit, so 'unchanged' is a property rather than a constant", () => {
    const { repository, snapshot } = snapshotAtVersionOne()
    repository.updateTemplate(
      { templateId: "tmpl-release" },
      { name: "v2", createdAt: LATER_NOW, steps: BASE_STEPS.map((step) => ({ ...step, timeoutSeconds: step.timeoutSeconds * 2 })) },
    )
    const after = snapshotOf(repository)
    expect(after.snapshotDigest).not.toBe(snapshot.snapshotDigest)
    expect(after.resolvedSteps[1]!.timeoutSeconds).toBe(1_800)
    expect(snapshot.resolvedSteps[1]!.timeoutSeconds).toBe(900)
  })

  it("produces a byte-identical snapshot from an untouched template in a brand new repository", () => {
    // The negative control for every assertion above: nothing about the second
    // repository differs, so the snapshots must not either.
    const { snapshot } = snapshotAtVersionOne()
    const fresh = snapshotOf(repositoryWithTemplate())
    expect(fresh).toEqual(snapshot)
    expect(fresh.snapshotDigest).toBe(snapshot.snapshotDigest)
  })
})
