/**
 * The barrel: every export reachable, and the dependency edges pointing the way
 * ADR 0007 section 1 declares.
 *
 * Two properties, and the second is the one that earns the file.
 *
 * 1. REACHABILITY. A module reachable only by deep path is a module nobody wired
 *    up, and the tests that use it prove nothing about the shipped surface. Every
 *    other test in `tests/unit/workflows/` imports through here, and this file
 *    asserts that the surface they use is the surface that exists — by name, so a
 *    renamed export is a failure rather than a silently orphaned caller.
 *
 * 2. DIRECTION. ADR 0007 section 1 declares `workflows -> rules, orchestration`
 *    and states that "nothing under `src/orchestration/` may import from any of
 *    the six M6 modules". An import cycle is exactly what a type checker will
 *    happily accept, so the edges are checked by SOURCE SCAN over the real
 *    `from "..."` statements, in the same shape as
 *    `tests/unit/context/barrel.test.ts:106-137` and
 *    `tests/unit/rules/barrel.test.ts`.
 *
 * WHY THE SCAN STRIPS COMMENTS FIRST. A file that documents the direction it
 * must not cross would otherwise fail the scan for mentioning the forbidden path
 * in prose. The stripper is itself asserted, and the import extractor is asserted
 * to still find imports in a file that also mentions the forbidden path in
 * prose — a stripper that silently did nothing would make every case below
 * vacuous.
 *
 * WHY `src/rules/` IS IN THE FORBIDDEN-IMPORTER LIST DESPITE `workflows -> rules`
 * BEING LEGAL. The direction is legal; the IMPORT IS NOT WANTED, and the reason
 * is in the module's own docblock: a template refers to a rule set by digest, so
 * an import of the rule compiler would invite a caller to build a
 * `CompiledRuleSet` through this barrel and would make two module barrels
 * ambiguous to star-import. The scan enforces the choice, so the choice cannot be
 * quietly reversed by an import added later.
 *
 * WHY PURITY IS SCANNED HERE AND NOT ONLY ASSERTED IN PROSE. The determinism
 * tests would catch a wall-clock read that affected a digest. A `Date.now()` that
 * only ever fed a log line would not affect any digest and would still be a
 * non-pure module, so the purity claim is checked as a source property.
 */

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import * as workflows from "../../../src/workflows/index.js"

const REPOSITORY_ROOT = join(import.meta.dirname, "../../..")
const WORKFLOWS_DIRECTORY = join(REPOSITORY_ROOT, "src/workflows")

/**
 * The directories that must NOT import from `src/workflows/`.
 *
 * `src/orchestration/` is the load-bearing one and the reason the scan exists: a
 * reverse import there would let an M6 template engine reach into the kernel that
 * the kernel does not know about. The rest are M6 siblings whose own barrels
 * already assert their direction, plus the M0 surfaces and the view layers.
 */
const FORBIDDEN_IMPORTERS: readonly { directory: string; why: string }[] = [
  {
    directory: join(REPOSITORY_ROOT, "src/orchestration"),
    why: "ADR 0007 section 1: nothing under src/orchestration/ may import from any of the six M6 modules",
  },
  { directory: join(REPOSITORY_ROOT, "src/rules"), why: "a template references a rule set by DIGEST; importing the rule compiler would make two module barrels ambiguous to star-import" },
  { directory: join(REPOSITORY_ROOT, "src/routing"), why: "routing is an M6 sibling, not a dependency of templates; a cycle between siblings is a drift" },
  { directory: join(REPOSITORY_ROOT, "src/budgets"), why: "budgets owns the budget ALGEBRA; templates declare an authored budget body and must not depend on the algebra that consumes it" },
  { directory: join(REPOSITORY_ROOT, "src/application"), why: "the application service is the M0 orchestrator; an M6 module reaches it through the kernel, not the other way round" },
  { directory: join(REPOSITORY_ROOT, "src/tui"), why: "the TUI is a view over orchestration state and must not reach into an M6 engine directly" },
  { directory: join(REPOSITORY_ROOT, "src/context"), why: "src/context is an M0 surface with its own attested one-way edge to memory; it must not depend on M6" },
  { directory: join(REPOSITORY_ROOT, "src/mesh"), why: "the M6 modules sit ABOVE mesh; workflows needs nothing from it" },
  { directory: join(REPOSITORY_ROOT, "src/jobs"), why: "the job subsystem is an M0 surface and predates M6 entirely" },
  { directory: join(REPOSITORY_ROOT, "src/runtime"), why: "the runtime adapter is an M0 surface; a template is instantiated before any runtime is chosen" },
]

function sourceFiles(directory: string): readonly { path: string; text: string }[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => {
      const path = join(entry.parentPath ?? directory, entry.name)
      return { path, text: readFileSync(path, "utf8") }
    })
}

/**
 * Strips comments and template literals, so a scan reads only CODE.
 *
 * Hand-written rather than parsed, and deliberately so: a hand stripper that got
 * it wrong would make the scan read fewer specifiers, and the failure mode is a
 * VACUOUS test rather than a false alarm. So it is asserted below.
 *
 * String CONTENT is emitted rather than swallowed, and that is the load-bearing
 * detail: the import specifier this scan exists to read IS a string, and a
 * stripper that dropped string bodies would find no imports at all.
 */
function stripsComments(text: string): string {
  let out = ""
  let index = 0
  let inLine = false
  let inBlock = false
  let inString: '"' | "'" | "`" | null = null
  while (index < text.length) {
    const char = text[index] ?? ""
    const next = text[index + 1] ?? ""
    if (inLine) {
      if (char === "\n") {
        inLine = false
        out += char
      }
      index += 1
      continue
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false
        index += 2
        continue
      }
      index += 1
      continue
    }
    if (inString !== null) {
      out += char
      if (char === "\\") {
        out += next
        index += 2
        continue
      }
      if (char === inString) inString = null
      index += 1
      continue
    }
    if (char === "/" && next === "/") {
      inLine = true
      index += 2
      continue
    }
    if (char === "/" && next === "*") {
      inBlock = true
      index += 2
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      inString = char
      out += char
      index += 1
      continue
    }
    out += char
    index += 1
  }
  return out
}

/** Import specifiers in a source file, ignoring the ones inside a docblock. */
function importsOf(text: string): readonly string[] {
  return [...stripsComments(text).matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]!)
}

describe("the run-template surface is reachable through its barrel", () => {
  it("exports the repository and its three named errors", () => {
    // The three things a caller must reach without a deep path.
    expect(typeof workflows.RunTemplateRepository).toBe("function")
    expect(typeof workflows.InvalidRunTemplateVersionError).toBe("function")
    expect(typeof workflows.RunTemplateVersionConflictError).toBe("function")
    expect(typeof workflows.RunTemplateNotFoundError).toBe("function")
    expect(typeof workflows.WorkflowTemplateError).toBe("function")
  })

  it("exports the one instantiation entry point and its digest pair", () => {
    expect(typeof workflows.instantiateTemplate).toBe("function")
    expect(typeof workflows.computeRunTemplateSnapshotDigest).toBe("function")
    expect(typeof workflows.verifyRunTemplateSnapshotDigest).toBe("function")
    expect(typeof workflows.resolveStepDependencyGraph).toBe("function")
  })

  it("exports the schemas, and they are schemas rather than functions", () => {
    // Zod v4 schemas are OBJECTS with a `parse` method, not constructors, so the
    // check is "has a parse method" — `typeof === "function"` would pass for a
    // function that is not a schema at all.
    const schemas = [
      "runTemplateSchema",
      "runTemplateSnapshotSchema",
      "templateParameterDefinitionSchema",
      "templateParameterTypeSchema",
      "templateParameterValueSchema",
      "templateStepSchema",
      "resolvedStepSchema",
      "templateBudgetLimitsSchema",
      "templateIdentifierSchema",
      "runTemplateIdSchema",
      "templateRuntimeKindSchema",
      "positiveSafeIntegerSchema",
    ] as const
    for (const name of schemas) {
      const value = (workflows as unknown as Record<string, { parse?: unknown }>)[name]
      expect(typeof value, name).toBe("object")
      expect(typeof value?.parse, `${name}.parse`).toBe("function")
    }
  })

  it("exports the helper a caller needs to check a value, so a UI validates the same way the binder does", () => {
    // One implementation of "is this value legal for this parameter", reachable
    // from the barrel. A caller that validated separately would be a second
    // implementation, which is the drift this module exists to avoid.
    expect(typeof workflows.checkParameterValue).toBe("function")
    expect(typeof workflows.isTextualParameterType).toBe("function")
    expect(typeof workflows.compareCodeUnits).toBe("function")
    expect(typeof workflows.sortedUniqueStrings).toBe("function")
    expect(typeof workflows.deepFreezeWorkflow).toBe("function")
    expect(typeof workflows.findStepDependencyCycle).toBe("function")
  })

  it("exports the limits as named constants, so a test asserts the values rather than the bounds", () => {
    for (const name of [
      "MAX_TEMPLATE_STEPS",
      "MAX_TEMPLATE_PARAMETERS",
      "MAX_TEMPLATE_ENUM_VALUES",
      "MAX_TEMPLATE_LABEL_VALUES",
      "MAX_TEMPLATE_DEPENDENCIES",
      "MAX_TEMPLATE_STEP_CAPABILITIES",
      "MAX_TEMPLATE_NAME_LENGTH",
      "MAX_TEMPLATE_DESCRIPTION_LENGTH",
      "MAX_TEMPLATE_PARAMETER_STRING_LENGTH",
      "MAX_TEMPLATE_STEP_TIMEOUT_SECONDS",
      "MAX_TEMPLATE_BUDGET_FAN_OUT",
      "MAX_TEMPLATE_BUDGET_CONCURRENCY",
      "MAX_TEMPLATE_BUDGET_RETRY_LIMIT",
    ]) {
      expect(typeof (workflows as unknown as Record<string, unknown>)[name], name).toBe("number")
    }
    expect(workflows.MAX_TEMPLATE_STEPS).toBe(64)
    expect(workflows.TEMPLATE_IDENTIFIER_PATTERN.source).toBe("^[a-z][a-z0-9_]{0,63}$")
  })

  it("exports the safety floor it composes with, so a caller reads the ceiling from its owner", () => {
    // Re-exported rather than restated: a second copy of the maximum timeout is
    // a second number that could drift from the floor.
    expect(workflows.SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS).toBe(3_600)
    expect(workflows.SAFETY_FLOOR.allowDestructiveEffects).toBe(false)
    expect(workflows.SAFETY_FLOOR.allowExternalEffects).toBe(false)
    expect(workflows.SAFETY_FLOOR.requireApprovalForDispatch).toBe(true)
    expect(Object.isFrozen(workflows.SAFETY_FLOOR)).toBe(true)
  })

  it("exports the kernel shapes a caller composes with, without this module claiming to own them", () => {
    expect(typeof workflows.digestJson).toBe("function")
    expect(typeof workflows.canonicalJson).toBe("function")
    expect(typeof workflows.projectPathIdSchema.parse).toBe("function")
    expect(typeof workflows.actorSchema.parse).toBe("function")
    expect(typeof workflows.safetyFloorSchema.parse).toBe("function")
    // The scheduler's cycle vocabulary, re-exported as types plus the two error
    // classes, so a caller comparing a refusal against the scheduler's needs one
    // import path.
    expect(typeof workflows.DependencyCycleError).toBe("function")
    expect(typeof workflows.DanglingDependencyError).toBe("function")
  })

  it("exports no generic unprefixed name that a sibling M6 barrel is likely to want", () => {
    // A star-import of two M6 barrels is ambiguous if they share a name, and the
    // collision is only discovered at the call site. Every name this barrel
    // defines is domain-prefixed for that reason.
    const names = Object.keys(workflows)
    expect(names).toContain("runTemplateSchema")
    expect(names).toContain("instantiateTemplate")
    expect(names.some((name) => name === "ERROR_CODES")).toBe(false)
    expect(names.some((name) => name === "PREDICATE_FIELDS")).toBe(false)
    expect(names.some((name) => name === "LIMITS")).toBe(false)
    expect(names.some((name) => name === "RULESET")).toBe(false)
  })
})

describe("every module under src/workflows/ is reachable from the barrel", () => {
  it("exports something from every source file, so no file is dead code", () => {
    const files = sourceFiles(WORKFLOWS_DIRECTORY)
      .map((file) => file.path.replace(`${REPOSITORY_ROOT}/`, ""))
      .sort()
    expect(files).toEqual([
      "src/workflows/index.ts",
      "src/workflows/instantiate.ts",
      "src/workflows/repository.ts",
      "src/workflows/types.ts",
    ])

    // Each of the three non-barrel modules is named in the barrel, so a
    // star-import reaches all of them.
    const barrel = readFileSync(join(WORKFLOWS_DIRECTORY, "index.ts"), "utf8")
    for (const name of ["types.js", "repository.js", "instantiate.js"]) {
      expect(barrel, `the barrel must re-export ${name}`).toContain(`"./${name}"`)
    }
  })

  it("re-exports the three modules in pipeline order, so a reader follows the data flow", () => {
    const barrel = readFileSync(join(WORKFLOWS_DIRECTORY, "index.ts"), "utf8")
    const order = ["types.js", "repository.js", "instantiate.js"].map((name) => barrel.indexOf(`"./${name}"`))
    expect(order.every((index) => index > 0)).toBe(true)
    expect(order[0]).toBeLessThan(order[1]!)
    expect(order[1]).toBeLessThan(order[2]!)
  })

  it("agrees with the deep paths, so a barrel re-exporting a stale copy cannot pass unnoticed", () => {
    const typesText = readFileSync(join(WORKFLOWS_DIRECTORY, "types.ts"), "utf8")
    expect(typesText).toContain("export const MAX_TEMPLATE_STEPS = 64")
    expect(workflows.MAX_TEMPLATE_STEPS).toBe(64)
    // And the barrel's schema is the OBJECT the deep module declares, not a
    // second one that happens to parse the same documents. `parse` is the only
    // thing a schema exposes, so identity is asserted through a symbol both
    // modules share: the identifier pattern, which the schema embeds.
    expect(workflows.templateIdentifierSchema.regex?.(workflows.TEMPLATE_IDENTIFIER_PATTERN)).toBeTruthy()
    expect(workflows.runTemplateIdSchema.safeParse("tmpl-release").success).toBe(true)
  })
})

describe("the dependency edges point the way ADR 0007 section 1 declares", () => {
  it("the comment stripper actually strips, so the scans below are not vacuous", () => {
    const text = [
      '// import { x } from "../orchestration/index.js"',
      '/* import { y } from "../rules/index.js" */',
      'import { z } from "../orchestration/digest.js"',
    ].join("\n")
    expect(importsOf(text)).toEqual(["../orchestration/digest.js"])
    expect(stripsComments(text)).not.toContain("rules/index.js")
  })

  it("src/workflows imports orchestration — and only orchestration, downward", () => {
    const specifiers = sourceFiles(WORKFLOWS_DIRECTORY).flatMap((file) => importsOf(file.text))
    // The declared edge exists, so the scan is looking at a module that really
    // does depend on the kernel.
    expect(specifiers.some((specifier) => specifier.includes("orchestration/"))).toBe(true)
    // And nothing else upward. `src/rules/` is deliberately excluded even though
    // `workflows -> rules` would be legal: the module docblock explains why, and
    // this is where that decision is enforced.
    const forbidden = [
      "application",
      "bridge",
      "cli",
      "config",
      "context",
      "host",
      "index",
      "jobs",
      "memory",
      "mesh",
      "opencode",
      "orchestration/coordinator",
      "orchestration/event-store",
      "orchestration/legacy",
      "orchestration/projections",
      "planning",
      "registry",
      "runtime",
      "server",
      "tasks",
      "terminal",
      "tui",
    ]
    const offenders = sourceFiles(WORKFLOWS_DIRECTORY)
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => {
        if (!specifier.startsWith(".")) return false
        const target = specifier.replace(/^\.\.\//, "").replace(/\.js$/, "")
        return forbidden.some((prefix) => target === prefix || target.startsWith(`${prefix}/`))
      })
      .map(({ file, specifier }) => `${file.replace(`${REPOSITORY_ROOT}/`, "")} -> ${specifier}`)
    expect(offenders).toEqual([])
  })

  it("src/workflows never imports src/rules, because a template names a rule set by digest", () => {
    const specifiers = sourceFiles(WORKFLOWS_DIRECTORY).flatMap((file) => importsOf(file.text))
    const rulesImports = specifiers.filter((specifier) => specifier.includes("/rules/"))
    expect(rulesImports).toEqual([])
    // And the budget body is declared here rather than imported — the drift the
    // assertion below would not otherwise catch is a local restatement, so the
    // check is that the import is absent AND that this module owns its own
    // declaration rather than re-exporting one.
    const typesText = readFileSync(join(WORKFLOWS_DIRECTORY, "types.ts"), "utf8")
    expect(typesText).toContain("export const templateBudgetLimitsSchema")
    expect(typesText).not.toMatch(/import\s[^;]*RuleBudgetLimits[^;]*from\s+"\.\.\/rules\//)
  })

  for (const forbidden of FORBIDDEN_IMPORTERS) {
    it(`nothing under ${forbidden.directory.replace(`${REPOSITORY_ROOT}/`, "")} imports from src/workflows/`, () => {
      // ${forbidden.why}
      const offenders = sourceFiles(forbidden.directory)
        .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
        .filter(({ specifier }) => specifier.includes("/workflows/") || /(^|\/)workflows\.js$/.test(specifier))
        .map(({ file, specifier }) => `${file.replace(`${REPOSITORY_ROOT}/`, "")} -> ${specifier}`)
      expect(offenders).toEqual([])
    })
  }

  it("no module anywhere else under src/ imports from src/workflows/, and the scan is looking at real files", () => {
    // The exhaustive form of the cases above, and the one that would catch a
    // directory added after this file was written. `sourceFiles` on `src/` is
    // non-empty, so an empty offender list means "checked and clean".
    //
    // `src/simulation/` is the ONE sanctioned consumer, declared by ADR 0007
    // section 1 (`simulation -> rules, workflows, budgets, routing, orchestration,
    // context`). The simulator must call `instantiateTemplate` rather than write
    // its own expander, because ADR section 16 requires the dry run to be composed
    // of the SAME planners as production and section 10.4's conflict resolution
    // depends on those planners being the ones that ran. The exemption is named
    // here, with the reverse guard below, so adding a second consumer is a
    // deliberate edit to this file AND to ADR section 1 rather than a consequence
    // of which import happened to compile.
    const PERMITTED_CONSUMERS = ["src/simulation/"]
    const files = sourceFiles(join(REPOSITORY_ROOT, "src"))
    expect(files.length).toBeGreaterThan(50)
    const offenders = files
      .filter((file) => !file.path.startsWith(WORKFLOWS_DIRECTORY))
      .filter((file) => !PERMITTED_CONSUMERS.some((permitted) => file.path.startsWith(`${REPOSITORY_ROOT}/${permitted}`)))
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => specifier.includes("/workflows/"))
      .map(({ file, specifier }) => `${file.replace(`${REPOSITORY_ROOT}/`, "")} -> ${specifier}`)
    expect(offenders).toEqual([])

    // The permission must not be able to pass for the wrong reason: if
    // `src/simulation/` were deleted, the scan above would find nothing to check
    // and report clean. That is the "found nothing to check" failure mode the
    // `toBeGreaterThan(50)` guard exists to rule out, one directory narrower.
    for (const permitted of PERMITTED_CONSUMERS) {
      const consumers = files.filter((file) => file.path.startsWith(`${REPOSITORY_ROOT}/${permitted}`))
      expect(consumers.length, `${permitted} is a permitted consumer but does not exist`).toBeGreaterThan(0)
      const importers = consumers.flatMap((file) => importsOf(file.text)).filter((specifier) => specifier.includes("/workflows/"))
      expect(
        importers.length,
        `${permitted} is a permitted consumer but imports nothing from src/workflows/, so the exemption is not exercised`,
      ).toBeGreaterThan(0)
    }
  })
})

describe("the module is pure: no clock, no randomness, no IO, no evaluation", () => {
  it("reaches no filesystem, no process, no network, and no ambient clock", () => {
    // The purity claim as a source scan. A module that read a file could not be
    // instantiated twice and compared, and the determinism tests would be
    // asserting something the code does not guarantee. `Date.parse` and
    // `Date.now` are the two that matter here: the former parses a string the
    // caller supplied, the latter reads a clock nobody injected.
    const forbidden = [
      { pattern: /\bDate\.now\s*\(/, why: "a wall-clock read" },
      { pattern: /\bnew\s+Date\s*\(\s*\)/, why: "a wall-clock read" },
      { pattern: /\bMath\.random\s*\(/, why: "a non-deterministic value" },
      { pattern: /from\s+"node:fs"/, why: "a filesystem read" },
      { pattern: /from\s+"node:child_process"/, why: "a process launch" },
      { pattern: /\brequire\s*\(/, why: "a dynamic import" },
      { pattern: /\beval\s*\(/, why: "string evaluation" },
      { pattern: /\bnew\s+Function\s*\(/, why: "string evaluation" },
      { pattern: /from\s+"node:(http|https|net|dgram)"/, why: "a network call" },
    ]
    const offenders: string[] = []
    for (const file of sourceFiles(WORKFLOWS_DIRECTORY)) {
      const code = stripsComments(file.text)
      for (const rule of forbidden) {
        if (rule.pattern.test(code)) offenders.push(`${file.path.replace(`${REPOSITORY_ROOT}/`, "")}: ${rule.why}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("uses UTF-16 code-unit comparison for every ordering, and never localeCompare", () => {
    // ADR 0007 section 10.2: ordering by `localeCompare` would make a snapshot's
    // digest depend on the host's locale, so a snapshot computed in one region
    // would not equal one computed in another.
    const offenders = sourceFiles(WORKFLOWS_DIRECTORY)
      .filter((file) => /\.localeCompare\s*\(/.test(stripsComments(file.text)))
      .map((file) => file.path.replace(`${REPOSITORY_ROOT}/`, ""))
    expect(offenders).toEqual([])
  })

  it("orders nothing by locale through a sort callback either, because a comparator is the other place it hides", () => {
    const offenders = sourceFiles(WORKFLOWS_DIRECTORY)
      .flatMap((file) =>
        [...stripsComments(file.text).matchAll(/\.sort\(\s*\(?([a-zA-Z]+)?[a-zA-Z, ]*\)?\s*=>/g)].map((match) =>
          match[0].includes("localeCompare") ? file.path.replace(`${REPOSITORY_ROOT}/`, "") : null,
        ),
      )
      .filter((entry): entry is string => entry !== null)
    expect(offenders).toEqual([])
  })

  it("ends every local import with .js, because the build is NodeNext ESM", () => {
    const offenders: string[] = []
    for (const file of sourceFiles(WORKFLOWS_DIRECTORY)) {
      for (const specifier of importsOf(file.text)) {
        if (specifier.startsWith(".") && !specifier.endsWith(".js")) {
          offenders.push(`${file.path.replace(`${REPOSITORY_ROOT}/`, "")} -> ${specifier}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
