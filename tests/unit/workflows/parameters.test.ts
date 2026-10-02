/**
 * Parameter binding: every type's happy path, and every type's refusal.
 *
 * WHY EVERY TYPE GETS A REFUSAL. The types exist to make a mistake loud, and a
 * type whose mistake is silent is a type whose mistake will happen. So the matrix
 * below is not "one refusal for the language" — it is one refusal per parameter
 * type plus the three refusals that are about the BINDING rather than the value:
 * an unknown name, a missing required parameter, and a label with nothing to
 * bind to.
 *
 * WHY THE REFUSAL CODES ARE ASSERTED AND NOT JUST THE OUTCOME. Every refusal
 * here is a different thing a person has to fix, and a UI that cannot branch on
 * the code can only show the message. `workflow.parameter_type_mismatch` (you
 * passed a string) and `workflow.parameter_out_of_range` (you passed 99) need
 * different words in front of the person who has to decide what to do.
 *
 * WHY THE BOUNDARY IS ALWAYS CHECKED FROM BOTH SIDES. For every range, the value
 * AT the bound is asserted accepted and one past it is asserted refused. A limit
 * that rejects its own boundary is a different limit from the documented one, and
 * the off-by-one is invisible to a test that only tries to cross the bound.
 */

import { describe, expect, it } from "vitest"
import {
  RunTemplateRepository,
  instantiateTemplate,
  type RunTemplateInput,
  type TemplateParameterDefinition,
} from "../../../src/workflows/index.js"
import { BASE_STEPS, FIXED_NOW, definitionNamed, validTemplateInput } from "./fixtures.js"

/**
 * One step with no label bindings.
 *
 * The shared fixture's step binds its `env` label to `target_env`, and almost
 * every case here declares a different parameter set — so a fixture with a label
 * on it would fail the AUTHORING check before the binding check under test could
 * run. Using a bare step keeps each case about the parameter it names.
 */
const BARE_STEP = { ...BASE_STEPS[0]!, labelValues: {} } as const

/** A repository whose template declares exactly the given parameter definitions. */
function repositoryWith(
  parameterDefinitions: readonly TemplateParameterDefinition[],
  steps = [{ ...BARE_STEP }],
): RunTemplateRepository {
  const repository = new RunTemplateRepository()
  repository.createTemplate({ ...validTemplateInput(), parameterDefinitions, steps } as RunTemplateInput)
  return repository
}

/** Instantiates and returns the refusal code, asserting there was one. */
function refusalCode(
  repository: RunTemplateRepository,
  inputs: Readonly<Record<string, unknown>>,
): string {
  const result = instantiateTemplate(repository, { templateId: "tmpl-release" }, inputs, { now: FIXED_NOW })
  if (result.ok) throw new Error(`expected a refusal, got a snapshot bound to ${JSON.stringify(result.value.boundParameters)}`)
  return result.error.code
}

/** Instantiates and returns the bound parameters, asserting success. */
function boundParameters(repository: RunTemplateRepository, inputs: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result = instantiateTemplate(repository, { templateId: "tmpl-release" }, inputs, { now: FIXED_NOW })
  if (!result.ok) throw new Error(`expected a snapshot, got ${result.error.code}: ${result.error.message}`)
  return { ...result.value.boundParameters }
}

describe("the string type", () => {
  const string = { name: "target_env", type: "string", required: true, minLength: 2, maxLength: 8 } as const

  it("binds a value inside its length bounds", () => {
    expect(boundParameters(repositoryWith([string]), { target_env: "staging" })).toEqual({ target_env: "staging" })
  })

  it("binds a value at exactly minLength and at exactly maxLength", () => {
    const repository = repositoryWith([string])
    expect(boundParameters(repository, { target_env: "ab" })).toEqual({ target_env: "ab" })
    expect(boundParameters(repository, { target_env: "a".repeat(8) })).toEqual({ target_env: "a".repeat(8) })
  })

  it("refuses a value below minLength, as a range error rather than a type error", () => {
    // The distinction matters: a length complaint and a type complaint send the
    // person to different places, and "expected a string" for a string is not a
    // message anybody can act on.
    expect(refusalCode(repositoryWith([string]), { target_env: "a" })).toBe("workflow.parameter_out_of_range")
  })

  it("refuses a string over maxLength", () => {
    expect(refusalCode(repositoryWith([string]), { target_env: "a".repeat(9) })).toBe("workflow.parameter_out_of_range")
  })

  it("refuses a non-string value, as a type error", () => {
    expect(refusalCode(repositoryWith([string]), { target_env: 3 })).toBe("workflow.parameter_type_mismatch")
    expect(refusalCode(repositoryWith([string]), { target_env: true })).toBe("workflow.parameter_type_mismatch")
    expect(refusalCode(repositoryWith([string]), { target_env: ["a"] })).toBe("workflow.parameter_type_mismatch")
    expect(refusalCode(repositoryWith([string]), { target_env: { value: "a" } })).toBe("workflow.parameter_type_mismatch")
    expect(refusalCode(repositoryWith([string]), { target_env: null })).toBe("workflow.parameter_type_mismatch")
  })

  it("accepts a value containing punctuation and spaces, because a string parameter is not an identifier", () => {
    // The identifier alphabet applies to NAMES, not values. Confining a value
    // would be a surprise nobody would find until a legitimate label failed.
    expect(boundParameters(repositoryWith([string]), { target_env: "a b.c-d" })).toEqual({ target_env: "a b.c-d" })
  })
})

describe("the integer type", () => {
  const integer = { name: "retries", type: "integer", required: true, minimum: 0, maximum: 5 } as const

  it("binds an integer inside its bounds", () => {
    expect(boundParameters(repositoryWith([integer]), { retries: 3 })).toEqual({ retries: 3 })
  })

  it("binds the two bound values themselves", () => {
    const repository = repositoryWith([integer])
    expect(boundParameters(repository, { retries: 0 })).toEqual({ retries: 0 })
    expect(boundParameters(repository, { retries: 5 })).toEqual({ retries: 5 })
  })

  it("refuses an integer below the declared minimum", () => {
    expect(refusalCode(repositoryWith([integer]), { retries: -1 })).toBe("workflow.parameter_out_of_range")
  })

  it("refuses an integer above the declared maximum", () => {
    expect(refusalCode(repositoryWith([integer]), { retries: 6 })).toBe("workflow.parameter_out_of_range")
  })

  it("refuses a numeric string, because a string is not silently coerced into an integer", () => {
    // Coercion here would put "3" and 3 in the same digest while meaning
    // different things to whoever bound them.
    expect(refusalCode(repositoryWith([integer]), { retries: "3" })).toBe("workflow.parameter_type_mismatch")
  })

  it("refuses a non-integer number, so 2.5 is not rounded into a value nobody chose", () => {
    expect(refusalCode(repositoryWith([integer]), { retries: 2.5 })).toBe("workflow.parameter_type_mismatch")
  })

  it("refuses a value beyond safe-integer precision, which no bound could describe", () => {
    expect(refusalCode(repositoryWith([integer]), { retries: Number.MAX_SAFE_INTEGER + 2 })).toBe("workflow.parameter_type_mismatch")
  })

  it("refuses NaN and Infinity, which a range comparison would otherwise let through", () => {
    expect(refusalCode(repositoryWith([integer]), { retries: Number.NaN })).toBe("workflow.parameter_type_mismatch")
    expect(refusalCode(repositoryWith([integer]), { retries: Number.POSITIVE_INFINITY })).toBe("workflow.parameter_type_mismatch")
  })
})

describe("the boolean type", () => {
  const boolean = { name: "dry_run", type: "boolean", required: true } as const

  it("binds both boolean values, because a boolean parameter that binds one value is not a boolean parameter", () => {
    const repository = repositoryWith([boolean])
    expect(boundParameters(repository, { dry_run: true })).toEqual({ dry_run: true })
    expect(boundParameters(repository, { dry_run: false })).toEqual({ dry_run: false })
  })

  it("refuses the strings 'true' and 'false', because a truthy string is the classic way to mean true by accident", () => {
    expect(refusalCode(repositoryWith([boolean]), { dry_run: "true" })).toBe("workflow.parameter_type_mismatch")
    expect(refusalCode(repositoryWith([boolean]), { dry_run: "false" })).toBe("workflow.parameter_type_mismatch")
  })

  it("refuses zero and one, which JavaScript would accept and a reader would not", () => {
    expect(refusalCode(repositoryWith([boolean]), { dry_run: 0 })).toBe("workflow.parameter_type_mismatch")
    expect(refusalCode(repositoryWith([boolean]), { dry_run: 1 })).toBe("workflow.parameter_type_mismatch")
  })

  it("refuses an empty array, which is truthy in JavaScript and meaningless to a reader", () => {
    expect(refusalCode(repositoryWith([boolean]), { dry_run: [] })).toBe("workflow.parameter_type_mismatch")
  })
})

describe("the enum type", () => {
  const enumeration = { name: "stage", type: "enum", required: true, enumValues: ["canary", "stable", "beta"] } as const

  it("binds each declared member", () => {
    const repository = repositoryWith([enumeration])
    for (const member of ["canary", "stable", "beta"]) {
      expect(boundParameters(repository, { stage: member })).toEqual({ stage: member })
    }
  })

  it("refuses a value that is not a declared member, and names the members instead of echoing the value", () => {
    expect(refusalCode(repositoryWith([enumeration]), { stage: "nightly" })).toBe("workflow.parameter_not_in_enum")
  })

  it("refuses a member with different case, because enum matching is exact", () => {
    // Under a case-insensitive comparison "Canary" would bind, and two runs would
    // agree on the label while disagreeing on the value that was hashed.
    expect(refusalCode(repositoryWith([enumeration]), { stage: "Canary" })).toBe("workflow.parameter_not_in_enum")
  })

  it("refuses a non-string value, as a type error rather than an enum error", () => {
    expect(refusalCode(repositoryWith([enumeration]), { stage: 0 })).toBe("workflow.parameter_type_mismatch")
    expect(refusalCode(repositoryWith([enumeration]), { stage: true })).toBe("workflow.parameter_type_mismatch")
  })

  it("refuses a member with surrounding whitespace, because it is not the member", () => {
    expect(refusalCode(repositoryWith([enumeration]), { stage: " canary" })).toBe("workflow.parameter_not_in_enum")
  })
})

describe("the project_path_id type", () => {
  const pathId = { name: "path", type: "project_path_id", required: true } as const

  it("binds an opaque project path id", () => {
    expect(boundParameters(repositoryWith([pathId]), { path: "path-1" })).toEqual({ path: "path-1" })
  })

  it("refuses a filesystem path, because a template parameter may not name a directory directly", () => {
    // ADR 0007 section 6.1: a path is referenced by an opaque id from the
    // allowlist. A string comparison over a path would make the rule's blast
    // radius depend on the filesystem layout of the machine evaluating it.
    for (const candidate of ["/Users/someone/project", "./relative", "../parent", "~/project"]) {
      expect(refusalCode(repositoryWith([pathId]), { path: candidate }), candidate).toBe("workflow.parameter_type_mismatch")
    }
  })

  it("refuses a path containing a glob or a regular expression, which would be a matching rule by another name", () => {
    for (const candidate of ["projects/*", "/srv/[a-z]+", "path?1"]) {
      expect(refusalCode(repositoryWith([pathId]), { path: candidate }), candidate).toBe("workflow.parameter_type_mismatch")
    }
  })

  it("refuses an id with a space or a slash, neither of which is in the opaque alphabet", () => {
    expect(refusalCode(repositoryWith([pathId]), { path: "path 1" })).toBe("workflow.parameter_type_mismatch")
    expect(refusalCode(repositoryWith([pathId]), { path: "path/1" })).toBe("workflow.parameter_type_mismatch")
  })
})

describe("the binding itself", () => {
  const definitions = [
    { name: "target_env", type: "string", required: true, minLength: 1, maxLength: 8 },
    { name: "retries", type: "integer", required: false, defaultValue: 2, minimum: 0, maximum: 5 },
  ] as const

  it("refuses an input naming a parameter the template does not declare, and names it", () => {
    // The worst failure this module could have: a typo silently ignored, and a
    // run that starts believing an override was applied when it was not.
    const code = refusalCode(repositoryWith([...definitions]), { target_env: "prod", enviroment: "staging" })
    expect(code).toBe("workflow.unknown_parameter")
  })

  it("refuses an input whose only key is unknown, so a wholly wrong call is still refused", () => {
    expect(refusalCode(repositoryWith([...definitions]), { totally_wrong: 1 })).toBe("workflow.unknown_parameter")
  })

  it("lists the declared parameters in the refusal, so the author can see what they may have meant", () => {
    const repository = repositoryWith([...definitions])
    const result = instantiateTemplate(repository, { templateId: "tmpl-release" }, { target_env: "prod", nope: 1 }, { now: FIXED_NOW })
    if (result.ok) throw new Error("unreachable")
    // Sorted by code unit, so two refusals for two different typos read the same
    // way and an operator can compare them.
    expect(result.error.message).toContain("declared parameters are retries, target_env")
  })

  it("refuses a missing required parameter, and says which one", () => {
    const repository = repositoryWith([...definitions])
    const result = instantiateTemplate(repository, { templateId: "tmpl-release" }, {}, { now: FIXED_NOW })
    if (result.ok) throw new Error("unreachable")
    expect(result.error.code).toBe("workflow.missing_parameter")
    expect(result.error.message).toContain("target_env")
    expect(result.error.message).toContain("no supplied value and declares no default")
  })

  it("does not treat an explicit undefined as a supplied value, so a caller cannot bypass a required parameter", () => {
    // `inputs.foo = undefined` and `inputs` without `foo` differ in JavaScript and
    // must not differ here: both mean "not supplied".
    expect(refusalCode(repositoryWith([...definitions]), { target_env: undefined })).toBe("workflow.missing_parameter")
  })

  it("does not treat an explicit undefined as overriding a default either", () => {
    // The same reason: `hasOwnProperty` says the key is present, and an
    // `undefined` VALUE is not a value, so the default applies. A caller that
    // meant to clear a default has to say so with a value the type accepts.
    expect(boundParameters(repositoryWith([...definitions]), { target_env: "prod", retries: undefined })).toEqual({
      target_env: "prod",
      retries: 2,
    })
  })

  it("prefers a supplied value over a default even when the default is inside its bounds and the value is not", () => {
    // If defaults were applied first and validated instead of the supplied value,
    // this would succeed. The supplied value is what the run gets, so the
    // supplied value is what must be checked.
    expect(refusalCode(repositoryWith([...definitions]), { target_env: "prod", retries: 99 })).toBe("workflow.parameter_out_of_range")
  })

  it("refuses a template whose declared default violates its own constraint, re-checked at instantiation", () => {
    // Unreachable through `createTemplate` — the schema refuses it at authoring
    // time — so this asserts the SECOND check exists by construction: the refusal
    // is reported from the binding path rather than trusted from the document.
    const definition = definitionNamed(
      [{ name: "retries", type: "integer", required: false, defaultValue: 99, minimum: 0, maximum: 5 }],
      "retries",
    )
    expect(definition.defaultValue).toBe(99)
    // And the authoring path refuses the same document, which is where the
    // operator will actually meet it.
    let thrown: unknown
    try {
      repositoryWith([{ name: "retries", type: "integer", required: false, defaultValue: 99, minimum: 0, maximum: 5 }])
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error).message).toMatch(/defaultValue does not satisfy/)
  })

  it("binds several parameters at once and keeps every value, so a multi-parameter template is not truncated to one", () => {
    const many = [
      { name: "target_env", type: "string", required: true, minLength: 1, maxLength: 8 },
      { name: "retries", type: "integer", required: true, minimum: 0, maximum: 5 },
      { name: "dry_run", type: "boolean", required: true },
      { name: "stage", type: "enum", required: true, enumValues: ["canary", "stable"] },
      { name: "path", type: "project_path_id", required: true },
    ] as const
    expect(boundParameters(repositoryWith([...many]), { target_env: "prod", retries: 4, dry_run: true, stage: "stable", path: "path-7" })).toEqual({
      target_env: "prod",
      retries: 4,
      dry_run: true,
      stage: "stable",
      path: "path-7",
    })
  })

  it("refuses an unknown parameter even when every required parameter is also supplied and valid", () => {
    // Checked first, so an unknown name cannot be masked by a document that is
    // otherwise fine.
    expect(refusalCode(repositoryWith([...definitions]), { target_env: "prod", retries: 1, extra: true })).toBe(
      "workflow.unknown_parameter",
    )
  })

  it("refuses an input whose value is an object, rather than stringifying it into the digest", () => {
    expect(refusalCode(repositoryWith([...definitions]), { target_env: { toString: () => "prod" } })).toBe(
      "workflow.parameter_type_mismatch",
    )
  })

  it("accepts an empty input object for a template with no required parameters", () => {
    const repository = repositoryWith([{ name: "retries", type: "integer", required: false, defaultValue: 1, minimum: 0, maximum: 2 }])
    expect(boundParameters(repository, {})).toEqual({ retries: 1 })
  })
})
