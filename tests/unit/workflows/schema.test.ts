/**
 * `runTemplateSchema` and everything under it: the parameter-definition rules,
 * the cross-field checks on the step graph, and the safety floor on a resolved
 * step.
 *
 * WHY THE SCHEMA IS TESTED SEPARATELY FROM INSTANTIATION. A template that is
 * refused at authoring time and a template that is refused at instantiation are
 * different events with different audiences: the first is a person who typed
 * something wrong, the second is a run that cannot start. The ADR's own rule is
 * that a mistake is reported at compile time with a named code rather than
 * absorbed (section 4), so this file asserts that the authoring refusals happen
 * and are named.
 *
 * WHY THE LIMITS ARE CROSSED ONE AT A TIME. A limit test that overshoots two
 * limits at once is satisfied by either of them, so it proves nothing about
 * either. Every case below moves exactly one value past exactly one bound, and
 * every case also asserts that the value AT the bound is accepted — a limit that
 * rejects its own boundary is a different limit from the documented one, and that
 * off-by-one is the one nobody notices until a legitimate value is refused.
 */

import { describe, expect, it } from "vitest"
import {
  MAX_TEMPLATE_BUDGET_FAN_OUT,
  MAX_TEMPLATE_DEPENDENCIES,
  MAX_TEMPLATE_ENUM_VALUES,
  MAX_TEMPLATE_LABEL_VALUES,
  MAX_TEMPLATE_NAME_LENGTH,
  MAX_TEMPLATE_PARAMETERS,
  MAX_TEMPLATE_PARAMETER_STRING_LENGTH,
  MAX_TEMPLATE_STEPS,
  MAX_TEMPLATE_STEP_TIMEOUT_SECONDS,
  SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS,
  checkParameterValue,
  isTextualParameterType,
  runTemplateSchema,
  resolvedStepSchema,
  templateParameterDefinitionSchema,
  templateStepSchema,
} from "../../../src/workflows/index.js"
import {
  BASE_PARAMETER_DEFINITIONS,
  FIXED_NOW,
  definitionNamed,
  rawTemplateDocument,
  validTemplateInput,
} from "./fixtures.js"

/** The message a refusal reports for an out-of-enum value: the members, never the value. */
const NOT_A_MEMBER = /not one of the declared members \[canary, stable\]/

/** Parses a raw template and returns the joined issue messages, or `null` when it parsed. */
function refusalMessages(document: Record<string, unknown>): string | null {
  const parsed = runTemplateSchema.safeParse(document)
  if (parsed.success) return null
  return parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("\n")
}

/** Asserts a raw document is refused, and returns the message so the caller can read it. */
function expectRefusal(document: Record<string, unknown>): string {
  const messages = refusalMessages(document)
  expect(messages, "this document should have been refused").not.toBeNull()
  return messages!
}

describe("a valid run template document is accepted as authored", () => {
  it("accepts one parameter of every type and a two-step dependency chain", () => {
    const parsed = runTemplateSchema.safeParse(rawTemplateDocument())
    expect(parsed.success).toBe(true)
  })

  it("accepts a template with no parameters at all, and with no rule set digest", () => {
    // The steps' label bindings go with them: a label may only bind to a
    // declared parameter, so "no parameters" means "no labels".
    const steps = structuredClone(rawTemplateDocument()["steps"]) as Record<string, unknown>[]
    for (const step of steps) step["labelValues"] = {}
    expect(refusalMessages(rawTemplateDocument({ parameterDefinitions: [], ruleSetDigest: null, steps }))).toBeNull()
  })

  it("accepts every boundable parameter type, so the type vocabulary is not a superset of what it accepts", () => {
    for (const definition of BASE_PARAMETER_DEFINITIONS) {
      expect(templateParameterDefinitionSchema.safeParse(definition).success, definition.type).toBe(true)
    }
  })
})

describe("strictness: an unknown field is refused rather than dropped", () => {
  it("refuses an unknown top-level field, because a dropped field is indistinguishable from an absent one", () => {
    // The mechanism this guards: "I wrote `enabled: false`" and "I wrote nothing"
    // must never be the same document.
    const messages = expectRefusal(rawTemplateDocument({ enabled: false }))
    expect(messages).toMatch(/enabled/)
  })

  it("refuses an unknown field on a step", () => {
    const steps = structuredClone(rawTemplateDocument()["steps"]) as Record<string, unknown>[]
    steps[0]!["allowDestructiveEffects"] = true
    const messages = expectRefusal(rawTemplateDocument({ steps }))
    expect(messages).toMatch(/allowDestructiveEffects/)
  })

  it("refuses an unknown field on a parameter definition", () => {
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions[0]!["unit"] = "seconds"
    expect(expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions }))).toMatch(/unit/)
  })
})

describe("parameter identifiers", () => {
  it("accepts a lowercase name with digits and underscores", () => {
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions[0]!["name"] = "target_env_2"
    // The rename invalidates the label binding, which is itself the point: a
    // renamed parameter is a name that nothing binds to any more.
    const steps = structuredClone(rawTemplateDocument()["steps"]) as Record<string, unknown>[]
    for (const step of steps) step["labelValues"] = {}
    expect(refusalMessages(rawTemplateDocument({ parameterDefinitions: definitions, steps }))).toBeNull()
  })

  it("refuses a parameter name containing a space, because it appears in normalized display text", () => {
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions[0]!["name"] = "target env"
    expect(expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions }))).toMatch(/name/)
  })

  it("refuses an uppercase parameter name, because case-insensitive comparison is a second rule nobody wrote down", () => {
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions[0]!["name"] = "Target_Env"
    expect(expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions }))).toMatch(/name/)
  })

  it("refuses a parameter name containing a quote or a dollar sign, which are the quoting bugs waiting to happen", () => {
    for (const name of ['a"b', "a${b}", "a`b", "a\nb"]) {
      const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
      definitions[0]!["name"] = name
      expect(expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions })), name).toMatch(/name/)
    }
  })

  it("refuses a parameter name longer than 64 characters", () => {
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions[0]!["name"] = `a${"b".repeat(64)}`
    expect(expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions }))).toMatch(/name/)
  })

  it("refuses two parameter definitions that claim the same name", () => {
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions.push({ ...definitions[0]! })
    expect(expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions }))).toMatch(/already declared/)
  })
})

describe("parameter constraint fields are present exactly when they apply", () => {
  it("refuses an enum parameter with no members, because an empty enum is unsatisfiable rather than permissive", () => {
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions[3]!["enumValues"] = []
    expect(expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions }))).toMatch(/at least one member/)
  })

  it("refuses enumValues on a non-enum parameter, which would be a constraint nobody applies", () => {
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions[0]!["enumValues"] = ["a", "b"]
    expect(expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions }))).toMatch(/applies only to a parameter of type 'enum'/)
  })

  it("refuses duplicate enum members, because a duplicate list is two spellings of one choice", () => {
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions[3]!["enumValues"] = ["canary", "canary"]
    expect(expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions }))).toMatch(/Duplicate enum member/)
  })

  it("refuses an integer parameter with no minimum or no maximum", () => {
    for (const field of ["minimum", "maximum"]) {
      const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
      delete definitions[1]![field]
      expect(expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions })), field).toMatch(
        new RegExp(`must declare ${field}`),
      )
    }
  })

  it("refuses minimum or maximum on a non-integer parameter", () => {
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions[0]!["minimum"] = 1
    definitions[0]!["maximum"] = 4
    const messages = expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions }))
    expect(messages).toMatch(/applies only to a parameter of type 'integer'/)
  })

  it("refuses a minimum above its maximum, which would be a range with no members", () => {
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions[1]!["minimum"] = 9
    definitions[1]!["maximum"] = 2
    expect(expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions }))).toMatch(/is above maximum/)
  })

  it("refuses a string parameter with no length bounds, so the bound is always declared rather than sometimes", () => {
    for (const field of ["minLength", "maxLength"]) {
      const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
      delete definitions[0]![field]
      expect(expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions })), field).toMatch(
        new RegExp(`'string' parameter must declare ${field}`),
      )
    }
  })

  it("refuses a length bound on an enum, whose members are already enumerated", () => {
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions[3]!["maxLength"] = 4
    expect(expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions }))).toMatch(
      /applies only to a parameter of type 'string'/,
    )
  })

  it("refuses a length bound on a boolean, which is a bound on a value with no length", () => {
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions[4]!["minLength"] = 1
    definitions[4]!["maxLength"] = 4
    expect(expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions }))).toMatch(
      /applies only to a parameter of type 'string'/,
    )
  })

  it("refuses a minLength above its maxLength", () => {
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions[0]!["minLength"] = 9
    definitions[0]!["maxLength"] = 2
    expect(expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions }))).toMatch(/is above maxLength/)
  })

  it("accepts a definition at exactly every one of its declared bounds", () => {
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions[1]!["defaultValue"] = 0
    definitions[1]!["minimum"] = 0
    definitions[1]!["maximum"] = 5
    definitions[0]!["defaultValue"] = "a"
    definitions[0]!["minLength"] = 1
    definitions[0]!["maxLength"] = 16
    expect(refusalMessages(rawTemplateDocument({ parameterDefinitions: definitions }))).toBeNull()
  })
})

describe("a declared default must satisfy its own definition", () => {
  it("refuses a string default longer than its own maxLength", () => {
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions[0]!["defaultValue"] = "x".repeat(17)
    expect(expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions }))).toMatch(
      /defaultValue does not satisfy this parameter's own definition/,
    )
  })

  it("refuses an integer default below its own minimum", () => {
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions[1]!["defaultValue"] = -1
    expect(expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions }))).toMatch(
      /below the declared minimum/,
    )
  })

  it("refuses an enum default that is not one of its own members", () => {
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions[3]!["defaultValue"] = "nightly"
    expect(expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions }))).toMatch(NOT_A_MEMBER)
  })

  it("refuses a boolean default that is a string, so the type is not something a string quietly satisfies", () => {
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions[4]!["defaultValue"] = "true"
    expect(expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions }))).toMatch(
      /expected a boolean, received a string/,
    )
  })

  it("refuses a project_path_id default that is a filesystem path rather than an opaque id", () => {
    // ADR 0007 section 6.1: a path is referenced by an opaque identifier, never
    // by its text. A parameter is the easiest place for that rule to be forgotten.
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions[2]!["defaultValue"] = "/Users/someone/project"
    expect(expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions }))).toMatch(
      /not an opaque project path id/,
    )
  })
})

describe("the step graph is checked on the document", () => {
  it("refuses two steps that share a step id, because a dependency edge would be ambiguous", () => {
    const steps = structuredClone(rawTemplateDocument()["steps"]) as Record<string, unknown>[]
    steps.push({ ...steps[0]! })
    expect(expectRefusal(rawTemplateDocument({ steps }))).toMatch(/is already declared/)
  })

  it("refuses a dependsOn naming a step the template does not declare", () => {
    const steps = structuredClone(rawTemplateDocument()["steps"]) as Record<string, unknown>[]
    steps[1]!["dependsOn"] = ["compile"]
    expect(expectRefusal(rawTemplateDocument({ steps }))).toMatch(/does not declare/)
  })

  it("refuses a step that depends on itself, and names it as a cycle rather than as a typo", () => {
    const steps = structuredClone(rawTemplateDocument()["steps"]) as Record<string, unknown>[]
    steps[0]!["dependsOn"] = ["build"]
    expect(expectRefusal(rawTemplateDocument({ steps }))).toMatch(/cycle: build -> build \(self\)/)
  })

  it("refuses a direct two-step cycle and names both step ids", () => {
    const steps = structuredClone(rawTemplateDocument()["steps"]) as Record<string, unknown>[]
    steps[0]!["dependsOn"] = ["ship"]
    const messages = expectRefusal(rawTemplateDocument({ steps }))
    expect(messages).toMatch(/cycle/)
    expect(messages).toContain("build")
    expect(messages).toContain("ship")
  })

  it("refuses an indirect three-step cycle and names every step id in the cycle", () => {
    const steps = structuredClone(rawTemplateDocument()["steps"]) as Record<string, unknown>[]
    steps.push({
      stepId: "verify",
      kind: "task",
      title: "Verify the release",
      roleId: "role-dev",
      dependsOn: ["ship"],
      capabilities: [],
      runtimeKind: "opencode",
      timeoutSeconds: 60,
      labelValues: {},
    })
    steps[0]!["dependsOn"] = ["verify"]
    const messages = expectRefusal(rawTemplateDocument({ steps }))
    expect(messages).toMatch(/cycle/)
    for (const stepId of ["build", "ship", "verify"]) expect(messages).toContain(stepId)
  })

  it("refuses a template with no steps, because a run with no work is not a template", () => {
    expect(expectRefusal(rawTemplateDocument({ steps: [] }))).toMatch(/steps/)
  })

  it("accepts a diamond, because a diamond is not a cycle", () => {
    const steps = structuredClone(rawTemplateDocument()["steps"]) as Record<string, unknown>[]
    steps.push(
      {
        stepId: "lint",
        kind: "task",
        title: "Lint",
        roleId: "role-dev",
        dependsOn: ["build"],
        capabilities: [],
        runtimeKind: "opencode",
        timeoutSeconds: 60,
        labelValues: {},
      },
      {
        stepId: "announce",
        kind: "task",
        title: "Announce",
        roleId: "role-dev",
        dependsOn: ["lint", "ship"],
        capabilities: [],
        runtimeKind: "opencode",
        timeoutSeconds: 60,
        labelValues: {},
      },
    )
    expect(refusalMessages(rawTemplateDocument({ steps }))).toBeNull()
  })
})

describe("label bindings name declared parameters", () => {
  it("refuses a label bound to a parameter the template does not declare", () => {
    const steps = structuredClone(rawTemplateDocument()["steps"]) as Record<string, unknown>[]
    steps[0]!["labelValues"] = { env: "environment" }
    expect(expectRefusal(rawTemplateDocument({ steps }))).toMatch(/binds to parameter 'environment'/)
  })

  it("refuses a label bound to an integer parameter, because a label is text", () => {
    const steps = structuredClone(rawTemplateDocument()["steps"]) as Record<string, unknown>[]
    steps[0]!["labelValues"] = { count: "retries" }
    expect(expectRefusal(rawTemplateDocument({ steps }))).toMatch(/a label is text/)
  })

  it("refuses a label bound to a boolean parameter, for the same reason", () => {
    const steps = structuredClone(rawTemplateDocument()["steps"]) as Record<string, unknown>[]
    steps[0]!["labelValues"] = { flag: "dry_run" }
    expect(expectRefusal(rawTemplateDocument({ steps }))).toMatch(/a label is text/)
  })

  it("names the three parameter types a label may bind to, so the rule is stated rather than implied", () => {
    expect(isTextualParameterType("string")).toBe(true)
    expect(isTextualParameterType("enum")).toBe(true)
    expect(isTextualParameterType("project_path_id")).toBe(true)
    expect(isTextualParameterType("integer")).toBe(false)
    expect(isTextualParameterType("boolean")).toBe(false)
  })
})

describe("every limit is applied, and the boundary value is accepted", () => {
  it("accepts exactly MAX_TEMPLATE_STEPS steps and refuses one more", () => {
    const base = structuredClone(rawTemplateDocument()["steps"]) as Record<string, unknown>[]
    const makeStep = (index: number): Record<string, unknown> => ({
      stepId: `s${String(index).padStart(3, "0")}`,
      kind: "task",
      title: `Step ${index}`,
      roleId: "role-dev",
      dependsOn: [],
      capabilities: [],
      runtimeKind: "opencode",
      timeoutSeconds: 60,
      labelValues: {},
    })
    const atLimit = Array.from({ length: MAX_TEMPLATE_STEPS }, (_unused, index) => makeStep(index))
    expect(refusalMessages(rawTemplateDocument({ steps: atLimit }))).toBeNull()
    expect(refusalMessages(rawTemplateDocument({ steps: [...atLimit, makeStep(MAX_TEMPLATE_STEPS)] }))).not.toBeNull()
    expect(base.length).toBe(2)
  })

  it("accepts exactly MAX_TEMPLATE_PARAMETERS parameter definitions and refuses one more", () => {
    const atLimit = Array.from({ length: MAX_TEMPLATE_PARAMETERS }, (_unused, index) => ({
      name: `p${String(index).padStart(3, "0")}`,
      type: "string" as const,
      required: false,
      minLength: 0,
      maxLength: 4,
    }))
    const steps = structuredClone(rawTemplateDocument()["steps"]) as Record<string, unknown>[]
    for (const step of steps) step["labelValues"] = {}
    expect(refusalMessages(rawTemplateDocument({ parameterDefinitions: atLimit, steps }))).toBeNull()
    expect(
      refusalMessages(rawTemplateDocument({ parameterDefinitions: [...atLimit, { ...atLimit[0]!, name: "p999" }], steps })),
    ).not.toBeNull()
  })

  it("accepts exactly MAX_TEMPLATE_ENUM_VALUES enum members and refuses one more", () => {
    const members = Array.from({ length: MAX_TEMPLATE_ENUM_VALUES }, (_unused, index) => `m${String(index).padStart(3, "0")}`)
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions[3]!["enumValues"] = members
    definitions[3]!["defaultValue"] = members[0]
    expect(refusalMessages(rawTemplateDocument({ parameterDefinitions: definitions }))).toBeNull()

    const tooMany = [...members, "one_too_many"]
    definitions[3]!["enumValues"] = tooMany
    expect(refusalMessages(rawTemplateDocument({ parameterDefinitions: definitions }))).not.toBeNull()
  })

  it("refuses a maxLength above MAX_TEMPLATE_PARAMETER_STRING_LENGTH, and accepts the value at it", () => {
    const definitions = structuredClone(rawTemplateDocument()["parameterDefinitions"]) as Record<string, unknown>[]
    definitions[0]!["maxLength"] = MAX_TEMPLATE_PARAMETER_STRING_LENGTH + 1
    expect(expectRefusal(rawTemplateDocument({ parameterDefinitions: definitions }))).toMatch(/MAX_TEMPLATE_PARAMETER_STRING_LENGTH/)

    definitions[0]!["maxLength"] = MAX_TEMPLATE_PARAMETER_STRING_LENGTH
    definitions[0]!["minLength"] = 0
    expect(refusalMessages(rawTemplateDocument({ parameterDefinitions: definitions }))).toBeNull()
  })

  it("refuses a step timeout above the authoring ceiling and accepts the value at it", () => {
    const steps = structuredClone(rawTemplateDocument()["steps"]) as Record<string, unknown>[]
    steps[0]!["timeoutSeconds"] = MAX_TEMPLATE_STEP_TIMEOUT_SECONDS
    expect(refusalMessages(rawTemplateDocument({ steps }))).toBeNull()
    steps[0]!["timeoutSeconds"] = MAX_TEMPLATE_STEP_TIMEOUT_SECONDS + 1
    expect(refusalMessages(rawTemplateDocument({ steps }))).not.toBeNull()
  })

  it("accepts a step timeout above the SAFETY FLOOR at authoring time, because the floor is applied where it binds", () => {
    // The authoring ceiling is deliberately wider than the floor so that a
    // too-long timeout is refused at INSTANTIATION with a code that says which
    // of three things is wrong. A schema bound at the floor would report all
    // three as one shape error and name none.
    const steps = structuredClone(rawTemplateDocument()["steps"]) as Record<string, unknown>[]
    steps[0]!["timeoutSeconds"] = SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS + 1
    expect(refusalMessages(rawTemplateDocument({ steps }))).toBeNull()
    expect(SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS).toBeLessThan(MAX_TEMPLATE_STEP_TIMEOUT_SECONDS)
  })

  it("refuses a name longer than MAX_TEMPLATE_NAME_LENGTH", () => {
    expect(refusalMessages(rawTemplateDocument({ name: "a".repeat(MAX_TEMPLATE_NAME_LENGTH) }))).toBeNull()
    expect(refusalMessages(rawTemplateDocument({ name: "a".repeat(MAX_TEMPLATE_NAME_LENGTH + 1) }))).not.toBeNull()
  })

  it("refuses a step budget with no members, which is indistinguishable from no budget at all", () => {
    const steps = structuredClone(rawTemplateDocument()["steps"]) as Record<string, unknown>[]
    steps[0]!["budget"] = {}
    expect(expectRefusal(rawTemplateDocument({ steps }))).toMatch(/at least one member/)
  })

  it("accepts exactly MAX_TEMPLATE_LABEL_VALUES label bindings and refuses one more", () => {
    const steps = structuredClone(rawTemplateDocument()["steps"]) as Record<string, unknown>[]
    const step = steps[0]!
    const atLimit = Object.fromEntries(
      Array.from({ length: MAX_TEMPLATE_LABEL_VALUES }, (_unused, index) => [`label_${String(index).padStart(3, "0")}`, "target_env"]),
    )
    step["labelValues"] = atLimit
    expect(refusalMessages(rawTemplateDocument({ steps: [step] }))).toBeNull()

    const tooMany = { ...atLimit, one_too_many: "target_env" }
    step["labelValues"] = tooMany
    expect(expectRefusal(rawTemplateDocument({ steps: [step] }))).toMatch(/MAX_TEMPLATE_LABEL_VALUES/)
  })

  it("accepts exactly MAX_TEMPLATE_DEPENDENCIES dependencies on one step and refuses one more", () => {
    // Checked on the STEP schema rather than on a whole template, because the
    // two bounds interact: a step with the full `MAX_TEMPLATE_DEPENDENCIES`
    // dependencies needs that many sibling steps, which would exceed
    // `MAX_TEMPLATE_STEPS` and make the wrong limit the one under test. The
    // template-level case is covered by the steps-bound case above.
    const makeStep = (count: number): Record<string, unknown> => ({
      stepId: "join",
      kind: "task",
      title: "Join",
      roleId: "role-dev",
      dependsOn: Array.from({ length: count }, (_unused, index) => `p${String(index).padStart(3, "0")}`),
      capabilities: [],
      runtimeKind: "opencode",
      timeoutSeconds: 60,
      labelValues: {},
    })
    const atLimit = templateStepSchema.safeParse(makeStep(MAX_TEMPLATE_DEPENDENCIES))
    expect(atLimit.success).toBe(true)
    expect(templateStepSchema.safeParse(makeStep(MAX_TEMPLATE_DEPENDENCIES + 1)).success).toBe(false)
  })

  it("refuses a resolved step with more dependencies than an authored step may declare", () => {
    // Defence in depth on the SNAPSHOT: the same bound is expressed on
    // `resolvedStepSchema`, so a step derived by some path other than this
    // module's instantiator still cannot exceed it.
    const makeStep = (count: number): Record<string, unknown> => ({
      stepId: "join",
      kind: "task",
      title: "Join",
      roleId: "role-dev",
      dependsOn: Array.from({ length: count }, (_unused, index) => `p${String(index).padStart(3, "0")}`),
      capabilities: [],
      runtimeKind: "opencode",
      timeoutSeconds: 60,
      labelValues: {},
    })
    expect(resolvedStepSchema.safeParse(makeStep(MAX_TEMPLATE_DEPENDENCIES)).success).toBe(true)
    expect(resolvedStepSchema.safeParse(makeStep(MAX_TEMPLATE_DEPENDENCIES + 1)).success).toBe(false)
  })

  it("refuses a resolved step above the safety floor, so the artifact itself cannot carry a wider timeout", () => {
    const atFloor = {
      stepId: "build",
      kind: "task",
      title: "Build",
      roleId: "role-dev",
      dependsOn: [],
      capabilities: [],
      runtimeKind: "opencode",
      timeoutSeconds: SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS,
      labelValues: {},
    }
    expect(resolvedStepSchema.safeParse(atFloor).success).toBe(true)
    expect(resolvedStepSchema.safeParse({ ...atFloor, timeoutSeconds: SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS + 1 }).success).toBe(false)
    // And the authored step schema is WIDER, which is what makes the
    // instantiation refusal reachable rather than a schema error.
    expect(templateStepSchema.safeParse({ ...atFloor, timeoutSeconds: SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS + 1 }).success).toBe(true)
  })

  it("refuses a step budget field above its own ceiling and accepts the value at it", () => {
    const steps = structuredClone(rawTemplateDocument()["steps"]) as Record<string, unknown>[]
    steps[0]!["budget"] = { maximumFanOut: MAX_TEMPLATE_BUDGET_FAN_OUT }
    expect(refusalMessages(rawTemplateDocument({ steps }))).toBeNull()
    steps[0]!["budget"] = { maximumFanOut: MAX_TEMPLATE_BUDGET_FAN_OUT + 1 }
    expect(refusalMessages(rawTemplateDocument({ steps }))).not.toBeNull()
  })

  it("refuses an unknown field on a step budget, because a budget nobody reads is not a budget", () => {
    const steps = structuredClone(rawTemplateDocument()["steps"]) as Record<string, unknown>[]
    steps[0]!["budget"] = { maximumFanOut: 2, maximumCostDollars: 5 }
    expect(expectRefusal(rawTemplateDocument({ steps }))).toMatch(/maximumCostDollars/)
  })
})

describe("the rule set is referenced by digest and never by document", () => {
  it("accepts a null rule set digest, which is the default-installation shape", () => {
    expect(refusalMessages(rawTemplateDocument({ ruleSetDigest: null }))).toBeNull()
  })

  it("accepts a well-formed digest reference", () => {
    const digest = `sha256:${"a".repeat(64)}`
    expect(refusalMessages(rawTemplateDocument({ ruleSetDigest: digest }))).toBeNull()
  })

  it("refuses a rule document in place of a digest, because re-parsing rules here would be a second parser", () => {
    const messages = expectRefusal(rawTemplateDocument({ ruleSetDigest: { rules: [{ field: "projectId" }] } }))
    expect(messages).toMatch(/ruleSetDigest/)
  })

  it("refuses a rule set digest that is not a digest", () => {
    expect(expectRefusal(rawTemplateDocument({ ruleSetDigest: "latest" }))).toMatch(/ruleSetDigest/)
  })
})

describe("checkParameterValue is the single implementation of value legality", () => {
  it("names the parameter and the exact constraint it broke, so a refusal is actionable", () => {
    const retries = definitionNamed(BASE_PARAMETER_DEFINITIONS, "retries")
    const outcome = checkParameterValue(retries, 99)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("unreachable")
    expect(outcome.code).toBe("workflow.parameter_out_of_range")
    expect(outcome.message).toContain("retries")
    expect(outcome.message).toContain("maximum 5")
  })

  it("distinguishes a type error from a range error from an enum error, so a caller can branch without parsing prose", () => {
    const retries = definitionNamed(BASE_PARAMETER_DEFINITIONS, "retries")
    const stage = definitionNamed(BASE_PARAMETER_DEFINITIONS, "stage")
    const dryRun = definitionNamed(BASE_PARAMETER_DEFINITIONS, "dry_run")
    expect(checkParameterValue(retries, "2")).toMatchObject({ code: "workflow.parameter_type_mismatch" })
    expect(checkParameterValue(retries, 9)).toMatchObject({ code: "workflow.parameter_out_of_range" })
    expect(checkParameterValue(stage, "nightly")).toMatchObject({ code: "workflow.parameter_not_in_enum" })
    expect(checkParameterValue(dryRun, "false")).toMatchObject({ code: "workflow.parameter_type_mismatch" })
  })

  it("never echoes the value it refused, only its JSON shape", () => {
    // ADR 0007 section 12: a refusal is read by an operator and may be rendered.
    // A supplied value is user content, and this message ends up in logs.
    const stage = definitionNamed(BASE_PARAMETER_DEFINITIONS, "stage")
    const outcome = checkParameterValue(stage, "a-secret-that-was-never-an-enum-member")
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("unreachable")
    expect(outcome.message).not.toContain("a-secret-that-was-never-an-enum-member")
  })
})

describe("the document's own identity fields are checked", () => {
  it("refuses a template version that is not a positive integer", () => {
    for (const templateVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(refusalMessages(rawTemplateDocument({ templateVersion })), String(templateVersion)).not.toBeNull()
    }
  })

  it("refuses a createdAt that is not a UTC RFC 3339 timestamp", () => {
    expect(refusalMessages(rawTemplateDocument({ createdAt: "2026-02-02" }))).not.toBeNull()
    expect(refusalMessages(rawTemplateDocument({ createdAt: "2026-02-02T12:00:00+01:00" }))).not.toBeNull()
    expect(refusalMessages(rawTemplateDocument({ createdAt: FIXED_NOW }))).toBeNull()
  })

  it("refuses an author that is not one of the kernel's four actor kinds", () => {
    expect(refusalMessages(rawTemplateDocument({ author: { kind: "robot", name: "r2" } }))).not.toBeNull()
    expect(refusalMessages(rawTemplateDocument({ author: { kind: "system", name: "installer" } }))).toBeNull()
  })

  it("refuses a schema version outside the readable set, rather than coercing it", () => {
    expect(refusalMessages(rawTemplateDocument({ schemaVersion: 99 }))).not.toBeNull()
  })

  it("accepts the authoring input the fixtures use, once the repository's two defaults are supplied", () => {
    // `RunTemplateInput` leaves `templateVersion` and `schemaVersion` to the
    // repository, so the document the repository hands to the schema is the
    // input plus those two. Asserting the parsed shape HERE is what stops the
    // repository's defaults and this file's idea of a valid document drifting.
    const input = validTemplateInput()
    const parsed = runTemplateSchema.safeParse({ ...input, templateVersion: 1, schemaVersion: 1 })
    expect(parsed.success).toBe(true)
    expect(parsed.success ? parsed.data.parameterDefinitions.length : 0).toBe(BASE_PARAMETER_DEFINITIONS.length)
  })
})
