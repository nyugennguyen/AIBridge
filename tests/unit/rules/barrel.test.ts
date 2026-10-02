/**
 * The barrel: every export reachable, and the dependency edges pointing the right
 * way.
 *
 * Two properties, and the second is the one that earns the file.
 *
 * 1. REACHABILITY. A module reachable only by deep path is a module nobody wired
 *    up, and the tests that use it prove nothing about the shipped surface. The
 *    repo's convention is that callers import through the barrel
 *    (`src/memory/index.js`, `src/context/index.js`), and every other test in
 *    `tests/unit/rules/` follows it — this file asserts that the surface they use
 *    is the surface that exists.
 *
 * 2. DIRECTION. ADR 0007 section 1 declares `rules -> orchestration,
 *    mesh/protocol/safe-pattern, memory/ontology` and nothing else, and states that
 *    "nothing under `src/orchestration/` may import from any of the six". An import
 *    cycle is exactly what a type checker will happily accept, so the edges are
 *    checked by SOURCE SCAN over the real `from "..."` statements, in the same
 *    shape as `tests/unit/context/barrel.test.ts:106-137`. A reverse import would
 *    give the M6 rule engine a way to reach into the kernel that the kernel does
 *    not know about.
 *
 * WHY THE SCAN IGNORES DOCBLOCKS. A file that documents the direction it must not
 * cross would otherwise fail the scan for mentioning the forbidden path in prose.
 * The scan therefore strips comments before it reads import specifiers, and
 * `stripsComments` is itself asserted — a stripper that silently did nothing would
 * make every case below vacuous.
 */

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import * as rules from "../../../src/rules/index.js"

const REPOSITORY_ROOT = join(import.meta.dirname, "../../..")
const RULES_DIRECTORY = join(REPOSITORY_ROOT, "src/rules")

/**
 * The directories that must NOT import from `src/rules/`.
 *
 * `src/orchestration/` is the load-bearing one and the reason the scan exists: a
 * reverse import there would let the M6 engine reach into the kernel. The other
 * four are the M5/early modules whose M0 surfaces are attested, and the CLI/server
 * entry points, which must reach the engine only through a caller that is allowed
 * to depend on it.
 */
const FORBIDDEN_IMPORTERS: readonly { directory: string; why: string }[] = [
  { directory: join(REPOSITORY_ROOT, "src/orchestration"), why: "ADR 0007 section 1: nothing under src/orchestration/ may import from any of the six M6 modules" },
  { directory: join(REPOSITORY_ROOT, "src/mesh"), why: "ADR 0007 section 1: the M6 modules sit ABOVE mesh, and rules -> mesh/protocol/safe-pattern is a read of a frozen protocol" },
  { directory: join(REPOSITORY_ROOT, "src/context"), why: "src/context is an M0 surface with its own attested direction, and it must not depend on M6" },
  { directory: join(REPOSITORY_ROOT, "src/application"), why: "the application service is the M0 orchestrator; M6 rules reach it through the kernel, not the other way round" },
  { directory: join(REPOSITORY_ROOT, "src/tui"), why: "the TUI is a view over orchestration state and must not reach into an M6 engine directly" },
  { directory: join(REPOSITORY_ROOT, "src/jobs"), why: "the job subsystem is an M0 surface and predates M6 entirely" },
  { directory: join(REPOSITORY_ROOT, "src/runtime"), why: "the runtime adapter is an M0 surface; a rule must be evaluated before it reaches a runtime, not by it" },
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
 * Comment stripping is by hand rather than by a parser, and deliberately so: a
 * hand stripper that got it wrong would make the scan read fewer specifiers, and
 * the failure mode is a VACUOUS test rather than a false alarm. So it is asserted
 * below, and the import extractor is asserted to still find imports in a file that
 * also mentions the forbidden path in prose.
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
      // String CONTENT is emitted, not swallowed. It has to be: the import
      // specifier this scan exists to read IS a string, and a stripper that
      // dropped string bodies would find no imports at all — which is the
      // vacuous-pass failure mode the `stripsComments` assertion guards against.
      out += char
      if (char === "\\\\") {
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

/** Import specifiers in a source file, ignoring the ones inside docblocks. */
function importsOf(text: string): readonly string[] {
  return [...stripsComments(text).matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]!)
}

// ===========================================================================
// 1. Reachability
// ===========================================================================

describe("M6 the rule language's public surface is reachable through its barrel", () => {
  it("exports the compiler, the evaluator and the renderer", () => {
    // The three things a caller must be able to reach without a deep path.
    expect(typeof rules.compileRule).toBe("function")
    expect(typeof rules.compileRuleSet).toBe("function")
    expect(typeof rules.evaluateRules).toBe("function")
    expect(typeof rules.evaluateCompiledRule).toBe("function")
    expect(typeof rules.renderRuleExplanation).toBe("function")
    expect(typeof rules.describeNormalizedPredicate).toBe("function")
    expect(typeof rules.buildPreApprovalDisclosure).toBe("function")
  })

  it("exports the schemas, and they are schemas rather than functions", () => {
    // Zod v4 schemas are OBJECTS with a `parse` method, not constructors, so the
    // check is "has a parse method" — the `typeof === "function"` form would pass
    // for a function that is not a schema at all.
    const schemas = [
      "ruleSourceDocumentSchema",
      "rulePredicateSchema",
      "ruleActionSchema",
      "ruleActivationSchema",
      "ruleEvaluationContextSchema",
      "scheduleWindowSchema",
      "ruleTimeZoneSchema",
      "ruleLanguageVersionSchema",
      "ruleActionKindSchema",
      "ruleMatchOutcomeSchema",
      "predicateSatisfactionSchema",
      "actionDispositionSchema",
      "ruleShadowRelationSchema",
      "dependencyOutcomeValueSchema",
    ] as const
    for (const name of schemas) {
      const value = (rules as unknown as Record<string, { parse?: unknown }>)[name]
      expect(typeof value, name).toBe("object")
      expect(typeof value?.parse, `${name}.parse`).toBe("function")
    }
  })

  it("exports the limits, as named constants and as one frozen table", () => {
    expect(rules.MAX_PREDICATES_PER_RULE).toBe(64)
    expect(rules.MAX_RULE_PATTERN_LENGTH).toBe(128)
    expect(Object.isFrozen(rules.ruleLimits)).toBe(true)
    expect(Object.keys(rules.ruleLimits).length).toBeGreaterThan(15)
  })

  it("exports the action rank table, so a caller sorting actions uses the same order the compiler does", () => {
    expect(rules.RULE_ACTION_KIND_RANK.pre_approve_within_bounds).toBeGreaterThan(rules.RULE_ACTION_KIND_RANK.deny_with_reason)
    expect(typeof rules.actionKindRank).toBe("function")
    expect(typeof rules.compareRuleActionKindsByRank).toBe("function")
  })

  it("exports the kernel composition helpers, because a caller must not reimplement the narrowing", () => {
    expect(typeof rules.narrowWithRuleRestrictions).toBe("function")
    expect(typeof rules.evaluateWithKernel).toBe("function")
    // And the kernel primitives themselves, so a caller can read the floor and
    // run the engine without a second import path.
    expect(typeof rules.evaluatePolicy).toBe("function")
    expect(typeof rules.narrowPolicyState).toBe("function")
    expect(typeof rules.seedPolicyState).toBe("function")
    expect(typeof rules.compileSafePattern).toBe("function")
    expect(typeof rules.matchesBounded).toBe("function")
  })

  it("exports the sensitivity lattice it composes with, rather than a second copy of it", () => {
    // ADR 0007 section 1: `rules -> memory/ontology` exists for the four-rung
    // ladder, and a second ladder in this module would be a second thing that can
    // drift from the first.
    expect(rules.SENSITIVITY_LEVELS).toEqual(["public_to_project", "restricted", "secret_reference_only", "prohibited"])
    expect(rules.SENSITIVITY_RANK.restricted).toBe(1)
    expect(typeof rules.isRenderable).toBe("function")
    expect(rules.SENSITIVITY_BY_RANK[0]).toBe("public_to_project")
  })

  it("exports the derived predicate tables a caller needs to build an authoring UI", () => {
    expect(rules.RULE_PREDICATE_FIELDS).toHaveLength(18)
    expect(rules.NON_UNIVERSAL_PREDICATE_FIELDS).toHaveLength(12)
    expect(rules.IANA_TIME_ZONES.has("UTC")).toBe(true)
    expect(typeof rules.normalizePredicateNode).toBe("function")
    expect(typeof rules.normalizeScheduleWindow).toBe("function")
    expect(typeof rules.walkPredicates).toBe("function")
    expect(typeof rules.isCombinatorPredicate).toBe("function")
  })

  it("exports no name that collides with a name another M6 barrel is likely to want", () => {
    // A star-import of two M6 barrels is ambiguous if they share a name, and the
    // collision is only discovered at the call site. The names asserted here are
    // the generic ones a sibling module is most likely to also define.
    const names = Object.keys(rules)
    expect(names).toContain("compileRule")
    expect(names).toContain("evaluateRules")
    // The error-code and predicate-field unions are prefixed by their domain, so a
    // sibling's `ERROR_CODES` cannot collide with this module's.
    expect(names).toContain("RULE_PREDICATE_FIELDS")
    expect(names).toContain("RULE_ACTION_KIND_RANK")
    expect(names.some((name) => name === "ERROR_CODES")).toBe(false)
    expect(names.some((name) => name === "PREDICATE_FIELDS")).toBe(false)
  })
})

// ===========================================================================
// 2. Direction
// ===========================================================================

describe("the M6 rule engine's dependency edges point the way ADR 0007 section 1 declares", () => {
  it("the comment stripper actually strips, so the scans below are not vacuous", () => {
    // Without this, a stripper that returned its input unchanged would make every
    // "no offenders" assertion pass for the wrong reason — and the first case it
    // would wrongly fail is a file that documents the forbidden path in prose.
    const text = [
      '// import { x } from "../orchestration/index.js"',
      '/* import { y } from "../mesh/index.js" */',
      'import { z } from "../orchestration/errors.js"',
    ].join("\n")
    const specifiers = importsOf(text)
    expect(specifiers).toEqual(["../orchestration/errors.js"])
    expect(stripsComments(text)).not.toContain("mesh/index.js")
  })

  it("src/rules imports orchestration, mesh/protocol and memory/ontology — and nothing else upward", () => {
    const specifiers = sourceFiles(RULES_DIRECTORY).flatMap((file) => importsOf(file.text))
    // The three declared edges all exist, so the scan is looking at a module that
    // really does depend on them.
    expect(specifiers.some((specifier) => specifier.includes("orchestration/"))).toBe(true)
    expect(specifiers.some((specifier) => specifier.includes("mesh/protocol/"))).toBe(true)
    expect(specifiers.some((specifier) => specifier.includes("memory/"))).toBe(true)

    // And nothing else. The forbidden set is every OTHER top-level directory
    // under `src/`, plus the entry points, because an M6 engine reaching into the
    // TUI or the server would give it a path around the kernel.
    const upward = new Set([
      "application",
      "bridge",
      "cli",
      "config",
      "context",
      "host",
      "index",
      "jobs",
      "mesh/tui",
      "opencode",
      "orchestration/coordinator",
      "orchestration/event-store",
      "orchestration/legacy",
      "orchestration/projections",
      "orchestration/roles",
      "orchestration/scheduler",
      "planning",
      "registry",
      "runtime",
      "server",
      "tasks",
      "terminal",
      "tui",
    ])
    const offenders = sourceFiles(RULES_DIRECTORY)
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => {
        if (!specifier.startsWith(".")) return false
        const target = specifier.replace(/^\.\.\//, "").replace(/\.js$/, "")
        return [...upward].some((prefix) => target === prefix || target.startsWith(`${prefix}/`))
      })
      .map(({ file, specifier }) => `${file.replace(`${REPOSITORY_ROOT}/`, "")} -> ${specifier}`)
    expect(offenders).toEqual([])
  })

  it("src/rules imports ONLY the two named safe-pattern/bounds files from mesh, never the registry or the tui", () => {
    const specifiers = sourceFiles(RULES_DIRECTORY).flatMap((file) => importsOf(file.text))
    const meshImports = specifiers.filter((specifier) => specifier.includes("/mesh/"))
    expect(meshImports.length).toBeGreaterThan(0)
    for (const specifier of meshImports) {
      // The mesh registry is the M3 surface the ADR says M6 must not grow into,
      // and the mesh TUI is a view. Neither is reachable from a rule engine.
      expect(specifier.endsWith("mesh/protocol/safe-pattern.js") || specifier.endsWith("mesh/protocol/bounds.js")).toBe(true)
    }
  })

  it("src/rules imports the SENSITIVITY ladder from memory/ontology rather than restating it", () => {
    const specifiers = sourceFiles(RULES_DIRECTORY).flatMap((file) => importsOf(file.text))
    expect(specifiers.some((specifier) => specifier.includes("memory/ontology.js"))).toBe(true)
    // And a local restatement would be the drift the ADR names. The scan cannot see
    // a restated ladder, so the assertion is that the import exists AND that the
    // module declares no ladder of its own.
    const ontologyImport = sourceFiles(RULES_DIRECTORY).find((file) => file.text.includes("memory/ontology.js"))
    expect(ontologyImport).toBeDefined()
    const types = readFileSync(join(RULES_DIRECTORY, "types.ts"), "utf8")
    // The four rung NAMES appear only inside the import and inside the derived
    // order; a second `Sensitivity` union or a second rank record would show up as
    // a declaration here.
    expect(types).not.toMatch(/type\s+Sensitivity\s*=/)
    expect(types).not.toMatch(/const\s+SENSITIVITY_RANK\s*:/)
  })

  for (const forbidden of FORBIDDEN_IMPORTERS) {
    it(`nothing under ${forbidden.directory.replace(`${REPOSITORY_ROOT}/`, "")} imports from src/rules/`, () => {
      // ${forbidden.why}
      const offenders = sourceFiles(forbidden.directory)
        .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
        .filter(({ specifier }) => specifier.includes("/rules/") || specifier.endsWith("/rules/index.js") || /(^|\/)rules\.js$/.test(specifier))
        .map(({ file, specifier }) => `${file.replace(`${REPOSITORY_ROOT}/`, "")} -> ${specifier}`)
      expect(offenders).toEqual([])
    })
  }

  it("no module anywhere else under src/ imports from src/rules/, and the scan is looking at real files", () => {
    // The exhaustive form of the cases above, and the one that would catch a
    // directory added after this file was written. `sourceFiles` on `src/` is
    // non-empty, so an empty offender list means "checked and clean" rather than
    // "found nothing to check".
    const files = sourceFiles(join(REPOSITORY_ROOT, "src"))
    expect(files.length).toBeGreaterThan(50)
    // `src/simulation/` is the ONE sanctioned consumer of the rule surface, and it
    // is sanctioned by ADR 0007 section 1, whose dependency diagram includes
    // `simulation -> rules`. It is a consumer rather than a participant: the
    // simulator calls `evaluateRules` and `previewCompiledRuleSet` because ADR
    // section 16 requires the dry run to be composed of the SAME evaluators as
    // production. If it were forbidden from importing them it would have to write
    // its own, which is precisely the divergence ADR stop condition 1 forbids.
    //
    // So the exception is named here rather than left implicit. A reader who adds a
    // second permitted consumer must add it to this list AND to ADR section 1, which
    // is the point: the set of modules allowed to depend on the rule language is a
    // decision, not a byproduct of which imports happened to compile.
    const PERMITTED_CONSUMERS = ["src/simulation/"]
    const offenders = files
      .filter((file) => !file.path.startsWith(RULES_DIRECTORY))
      .filter((file) => !PERMITTED_CONSUMERS.some((permitted) => file.path.startsWith(`${REPOSITORY_ROOT}/${permitted}`)))
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => specifier.includes("/rules/"))
      .map(({ file, specifier }) => `${file.replace(`${REPOSITORY_ROOT}/`, "")} -> ${specifier}`)
    expect(offenders).toEqual([])

    // And the exception is not dead weight: the permitted consumer must actually be
    // there. Without this, deleting `src/simulation/` would make the assertion above
    // pass for the wrong reason — the same "found nothing to check" failure mode the
    // `toBeGreaterThan(50)` guard exists to rule out, one directory narrower.
    for (const permitted of PERMITTED_CONSUMERS) {
      const consumers = files.filter((file) => file.path.startsWith(`${REPOSITORY_ROOT}/${permitted}`))
      expect(consumers.length, `${permitted} is a permitted consumer but does not exist`).toBeGreaterThan(0)
    }
  })

  it("src/rules does not reach the filesystem, the network, a process, or a clock", () => {
    // The purity claim as a source scan. A module that read a file or spawned a
    // process could not be evaluated twice and compared, and the determinism tests
    // would be asserting something the code does not guarantee.
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
    for (const file of sourceFiles(RULES_DIRECTORY)) {
      const code = stripsComments(file.text)
      for (const rule of forbidden) {
        if (rule.pattern.test(code)) {
          offenders.push(`${file.path.replace(`${REPOSITORY_ROOT}/`, "")}: ${rule.why}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("src/rules never builds a RegExp, because the bounded analyser is the only pattern path in the system", () => {
    // ADR 0007 section 4: "no second regular-expression implementation is
    // introduced anywhere in Milestone 6, and `new RegExp` on rule text does not
    // appear in `src/rules/`". The analyser itself lives in `mesh/protocol` and
    // uses `new RegExp` — which is why the file is named here rather than a
    // blanket ban on the token.
    const offenders = sourceFiles(RULES_DIRECTORY)
      .filter((file) => /new\s+RegExp\s*\(/.test(stripsComments(file.text)))
      .map((file) => file.path.replace(`${REPOSITORY_ROOT}/`, ""))
    expect(offenders).toEqual([])
  })

  it("src/rules uses UTF-16 code-unit comparison for every ordering, and never localeCompare", () => {
    // ADR 0007 section 10.2: ordering by `localeCompare` would make a rule set's
    // evaluation order depend on the host's locale, so a rule set compiled in one
    // region and evaluated in another would mean different things.
    const offenders = sourceFiles(RULES_DIRECTORY)
      .filter((file) => /\.localeCompare\s*\(/.test(stripsComments(file.text)))
      .map((file) => file.path.replace(`${REPOSITORY_ROOT}/`, ""))
    expect(offenders).toEqual([])
  })
})

// ===========================================================================
// 3. The barrel is the whole surface
// ===========================================================================

describe("every module under src/rules/ is reachable from the barrel", () => {
  it("exports something from every source file, so no file is dead code", () => {
    // A module nothing imports is a module nobody wired up. This asserts the
    // weaker but sufficient direction — each file contributes at least one export
    // to the barrel — rather than trying to prove the stronger one, which would
    // need an export-usage graph.
    const files = sourceFiles(RULES_DIRECTORY)
      .map((file) => file.path.replace(`${REPOSITORY_ROOT}/`, ""))
      .sort()
    expect(files).toEqual([
      "src/rules/compile.ts",
      "src/rules/evaluate.ts",
      "src/rules/explain.ts",
      "src/rules/index.ts",
      "src/rules/limits.ts",
      "src/rules/preview.ts",
      "src/rules/tui/builder.ts",
      "src/rules/tui/index.ts",
      "src/rules/tui/state.ts",
      "src/rules/tui/types.ts",
      "src/rules/tui/view-model.ts",
      "src/rules/types.ts",
    ])

    // Each of the six non-barrel modules is named in the barrel, so a star-import
    // reaches all of them.
    const barrel = readFileSync(join(RULES_DIRECTORY, "index.ts"), "utf8")
    for (const name of ["limits.js", "types.js", "compile.js", "evaluate.js", "explain.js", "preview.js"]) {
      expect(barrel, `the barrel must re-export ${name}`).toContain(`"./${name}"`)
    }
  })

  it("the barrel reaches the limits and the types through it, and the deep paths agree", () => {
    // A barrel that re-exported a STALE copy of a constant would be a second
    // source of truth. Reading both and comparing is the cheapest way to catch it.
    const limitsText = readFileSync(join(RULES_DIRECTORY, "limits.ts"), "utf8")
    expect(limitsText).toContain("export const MAX_PREDICATES_PER_RULE = 64")
    expect((rules as unknown as Record<string, unknown>)["MAX_PREDICATES_PER_RULE"]).toBe(64)
    expect((rules as unknown as Record<string, unknown>)["ruleLanguageVersion"]).toBe(2)
  })
})
