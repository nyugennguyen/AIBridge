/**
 * The barrel: every export reachable, and the dependency edges pointing the right
 * way.
 *
 * # THE TWO PROPERTIES, AND WHY THE SECOND IS THE ONE THAT EARNS THE FILE
 *
 * 1. **REACHABILITY.** A module reachable only by deep path is a module nobody wired
 *    up, and the tests that use it prove nothing about the shipped surface. The repo's
 *    convention is that callers import through a barrel, and every other test in
 *    `tests/unit/rules/` follows it — so this file asserts that the surface those
 *    tests use is the surface that exists. It asserts by NAME, for every export the
 *    three test files import, because a star-import assertion cannot catch a missing
 *    re-export of a name nobody happened to use.
 *
 * 2. **DIRECTION.** ADR 0007 section 1 declares `rules -> orchestration,
 *    mesh/protocol/safe-pattern, memory/ontology` and nothing else, and
 *    `tests/unit/workflows/barrel.test.ts` declares `workflows -> rules,
 *    orchestration`. Two things follow for a directory under `src/rules/`:
 *
 *    - It must not import `src/simulation/`, which does not exist yet — an import of
 *      a missing module is a build error, and a build error in a module nothing
 *      imports yet is exactly how an undeclared dependency sneaks in.
 *    - It must not import `src/workflows/` or `src/tui/`. The first would make two
 *      module barrels ambiguous to star-import and would reverse the declared edge; the
 *      second would put a presentation layer inside a language implementation, which is
 *      the direction `memory-view.ts` and `tui-adapter.ts` both refuse in prose.
 *
 *    Both are checked by SOURCE SCAN over the real `from "..."` statements, in the
 *    shape of `tests/unit/rules/barrel.test.ts:106-137`. An import cycle is exactly
 *    what a type checker will happily accept, so the edges are checked as text.
 *
 * # WHY THE SCAN IGNORES DOCBLOCKS
 *
 * A file that documents the direction it must not cross would otherwise fail the scan
 * for mentioning the forbidden path in prose. The scan therefore strips comments
 * before it reads import specifiers, and `stripsComments` is itself asserted — a
 * stripper that silently did nothing would make every case below vacuous. That
 * matters more than usual here, because THIS file is largely prose about
 * `src/workflows/` and `src/simulation/`.
 */

import { describe, expect, it } from "vitest"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import * as ruleTui from "../../../src/rules/tui/index.js"

const REPOSITORY_ROOT = join(import.meta.dirname, "../../..")
const RULE_TUI_DIRECTORY = join(REPOSITORY_ROOT, "src/rules/tui")

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
 * Comment stripping is by hand rather than by a parser, and deliberately so: a hand
 * stripper that got it wrong would make the scan read fewer specifiers, and the
 * failure mode is a VACUOUS test rather than a false alarm. So it is asserted below,
 * and the import extractor is asserted to still find imports in a file that also
 * mentions the forbidden path in prose.
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
      // String CONTENT is emitted, not swallowed: the import specifier this scan reads
      // IS a string, and a stripper that dropped string bodies would find no imports
      // at all — which is the vacuous-pass failure mode the assertion guards against.
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

/** Import specifiers in a source file, ignoring the ones inside docblocks. */
function importsOf(text: string): readonly string[] {
  return [...stripsComments(text).matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]!)
}

/**
 * Every name the M6.8 test files import from the barrel.
 *
 * Listed explicitly rather than derived from the tests, because deriving it would
 * make the assertion circular: a test importing a name would add the name to the list
 * that says the name is exported, and the check would pass for any name at all. The
 * list is the CONTRACT, written down, and the tests below assert each name is really
 * reachable.
 */
const EXPECTED_EXPORTS: readonly string[] = [
  // Screens, overlays and the declared action vocabularies.
  "RULE_TUI_SCREENS",
  "RULE_TUI_OVERLAYS",
  "RULE_TUI_ACTIONS",
  "RULE_TUI_KEY_PRODUCED_ACTIONS",
  "RULE_TUI_NON_KEY_ACTIONS",
  "RULE_TUI_DANGER_KINDS",
  "RULE_TUI_BUILDER_FIELDS",
  "RULE_TUI_MINIMUM_COLUMNS",
  "RULE_TUI_MINIMUM_ROWS",
  // Ordering helpers.
  "compareRuleTuiCodeUnits",
  "sortedRuleTuiStrings",
  // Schemas.
  "ruleTuiBuilderDraftSchema",
  "ruleTuiDangerSchema",
  "ruleTuiDimensionsSchema",
  // State.
  "initialRuleTuiState",
  "focusedBuilderField",
  "nextBuilderFocus",
  "reduceRuleTui",
  "routeRuleTuiKey",
  // Builder.
  "RULE_TUI_ACTION_KINDS",
  "RULE_TUI_OPERATORS_BY_FIELD",
  "RULE_TUI_PREDICATE_FIELDS",
  "RULE_TUI_SCOPE_BOUND_ACTION_KINDS",
  "RULE_TUI_DEFAULT_ACTION_VALUES",
  "RULE_TUI_DEFAULT_PREDICATE_VALUES",
  "analyzeBuilderDangers",
  "appendToBuilderField",
  "assembleRuleDocument",
  "backspaceBuilderField",
  "builderNormalizedPredicate",
  "captureRuleSetAsTemplate",
  "compileBuilderDocument",
  "currentBuilderFieldValue",
  "defaultActionValueFor",
  "defaultPredicateValueFor",
  "defaultRuleTuiDraft",
  "draftConstrainsScope",
  "nextActionKind",
  "nextInCycle",
  "nextPredicateField",
  "nextPredicateOperator",
  "unconstrainedReachAxesFor",
  "withBuilderField",
  // View model.
  "buildRuleTuiReachAxes",
  "buildRuleTuiConflicts",
  "buildRuleTuiView",
  "builderRuleTuiRows",
  "isUsableRuleTuiViewport",
  "summarizeRuleTuiText",
]

// ===========================================================================
// 1. Reachability
// ===========================================================================

describe("every symbol the M6.8 rule TUI tests import is reachable through its barrel", () => {
  it("exports every expected name, and the barrel is reading the real module", () => {
    const actual = ruleTui as unknown as Record<string, unknown>
    // Asserting the barrel carries AT LEAST the expected set before the per-name loop,
    // so a barrel that failed to load cannot make the loop vacuously pass on an empty
    // object. `toBeGreaterThanOrEqual` rather than `>`: the barrel re-exports exactly
    // the names in `EXPECTED_EXPORTS`, so equality is the true relationship and a
    // `>` assertion would fail on a correct barrel.
    expect(Object.keys(actual).length).toBeGreaterThanOrEqual(EXPECTED_EXPORTS.length)
    const missing = EXPECTED_EXPORTS.filter((name) => actual[name] === undefined)
    expect(missing).toEqual([])
    // And the reverse: the barrel exports NOTHING beyond the declared contract, so a
    // name added to the barrel without being written down here is visible.
    expect(Object.keys(actual).filter((name) => name !== "default").sort()).toEqual([...EXPECTED_EXPORTS].sort())
  })

  it("exports the functions as functions and the vocabularies as frozen arrays", () => {
    const functions = [
      "buildRuleTuiView",
      "builderRuleTuiRows",
      "buildRuleTuiConflicts",
      "buildRuleTuiReachAxes",
      "reduceRuleTui",
      "routeRuleTuiKey",
      "initialRuleTuiState",
      "compileBuilderDocument",
      "assembleRuleDocument",
      "analyzeBuilderDangers",
      "captureRuleSetAsTemplate",
    ]
    for (const name of functions) {
      expect(typeof (ruleTui as unknown as Record<string, unknown>)[name], name).toBe("function")
    }
    // The action and screen vocabularies are arrays a caller iterates. `Object.isFrozen`
    // is not asserted: they are `as const` arrays, which are not frozen at runtime, and
    // asserting frozenness would be asserting a property the declarations do not have.
    for (const name of ["RULE_TUI_SCREENS", "RULE_TUI_OVERLAYS", "RULE_TUI_ACTIONS", "RULE_TUI_DANGER_KINDS"]) {
      expect(Array.isArray((ruleTui as unknown as Record<string, unknown>)[name]), name).toBe(true)
    }
  })

  it("exports the schemas as Zod schemas with a parse method, not as constructors", () => {
    const schemas = ["ruleTuiBuilderDraftSchema", "ruleTuiDangerSchema", "ruleTuiDimensionsSchema"]
    for (const name of schemas) {
      const value = (ruleTui as unknown as Record<string, { parse?: unknown }>)[name]
      // Zod v4 schemas are OBJECTS. `typeof === "function"` would pass for a function
      // that is not a schema at all.
      expect(typeof value, name).toBe("object")
      expect(typeof value?.parse, `${name}.parse`).toBe("function")
    }
  })

  it("restates the shell's viewport minimum rather than importing it, and the values agree", () => {
    // The restatement exists because `src/tui` must not be imported from here. The
    // agreement is asserted here as well as in `tui.test.ts`, because this is the file
    // that states WHY the restatement is allowed — a restatement with no agreement
    // check is a second minimum.
    expect(ruleTui.RULE_TUI_MINIMUM_COLUMNS).toBe(60)
    expect(ruleTui.RULE_TUI_MINIMUM_ROWS).toBe(18)
    expect(ruleTui.isUsableRuleTuiViewport(60, 18)).toBe(true)
    expect(ruleTui.isUsableRuleTuiViewport(59, 18)).toBe(false)
  })

  it("exports no name that collides with a name a sibling M6 barrel is likely to want", () => {
    // A star-import of two M6 barrels is ambiguous if they share a name, and the
    // collision is only discovered at the call site. Every name here is either prefixed
    // by `RULE_TUI_` or prefixed by a domain word (`builder`, `compile`, `default`).
    const generic = ["ERROR_CODES", "SCREENS", "ACTIONS", "OVERLAYS", "Danger", "TYPES"]
    const names = Object.keys(ruleTui)
    for (const name of generic) {
      expect(names.some((candidate) => candidate === name), name).toBe(false)
    }
  })
})

// ===========================================================================
// 2. Direction
// ===========================================================================

describe("the rule TUI's dependency edges point the way ADR 0007 section 1 declares", () => {
  it("the comment stripper actually strips, so the scans below are not vacuous", () => {
    // Without this, a stripper that returned its input unchanged would make every
    // "no offenders" assertion pass for the wrong reason — and the FIRST case it would
    // wrongly fail is this module, whose docblock is mostly prose about the forbidden
    // paths.
    const text = [
      '// import { x } from "../../simulation/index.js"',
      '/* import { y } from "../../workflows/index.js" */',
      'import { z } from "../types.js"',
    ].join("\n")
    expect(importsOf(text)).toEqual(["../types.js"])
    expect(stripsComments(text)).not.toContain("simulation/index.js")
    expect(stripsComments(text)).not.toContain("workflows/index.js")
  })

  it("imports the language's own modules and nothing outside src/rules", () => {
    const specifiers = sourceFiles(RULE_TUI_DIRECTORY).flatMap((file) => importsOf(file.text))
    // The declared edges exist, so the scan is looking at a module that really does
    // consume the compiler and the explainer. `preview.js` is deliberately NOT among
    // them: this module consumes `previewCompiledRuleSet`'s OUTPUT through the state
    // and never calls it, which is why the state carries a preview TEXT rather than
    // building one. Asserting the compiler and explainer edges and saying nothing
    // about preview states the actual dependency rather than an assumed one.
    expect(specifiers.some((specifier) => specifier === "../compile.js")).toBe(true)
    expect(specifiers.some((specifier) => specifier === "../explain.js")).toBe(true)
    expect(specifiers.some((specifier) => specifier === "../types.js")).toBe(true)
    expect(specifiers.length).toBeGreaterThan(0)

    // And nothing leaves `src/rules/`.
    //
    // A file in `src/rules/tui/` reaches a sibling of `src/rules/` with `../x.js`
    // (one level), so the test for "climbed out of `src/rules/`" is TWO or more
    // leading `../` segments — which is exactly the shape every forbidden edge takes
    // (`../../simulation/index.js`, `../../workflows/index.js`, `../../tui/types.js`).
    const offenders = sourceFiles(RULE_TUI_DIRECTORY)
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => /^\.\.\/\.\.\//.test(specifier))
      .map(({ file, specifier }) => `${file.replace(`${REPOSITORY_ROOT}/`, "")} -> ${specifier}`)
    expect(offenders).toEqual([])

    // And every relative specifier is one of the DECLARED siblings — the four modules of
    // this directory plus the four language modules the ADR's `rules ->` edge allows —
    // so a new import inside `src/rules/` cannot slip in unnamed.
    const allowed = new Set([
      // This directory.
      "./types.js",
      "./state.js",
      "./builder.js",
      "./view-model.js",
      // The language's own modules, which is the `rules ->` edge ADR 0007 section 1
      // declares and which this module is entitled to use.
      "../types.js",
      "../compile.js",
      "../explain.js",
      "../preview.js",
    ])
    const unexpected = sourceFiles(RULE_TUI_DIRECTORY)
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => specifier.startsWith(".") && !allowed.has(specifier))
      .map(({ file, specifier }) => `${file.replace(`${REPOSITORY_ROOT}/`, "")} -> ${specifier}`)
    expect(unexpected).toEqual([])
  })

  it("imports src/simulation/ nowhere, because ADR 0007 declares simulation -> rules", () => {
    // The module EXISTS. The edge does not: ADR 0007 section 1 declares
    // `simulation -> rules, workflows, budgets, routing, orchestration, context` and
    // this module sits inside `rules`. So the simulation port is the structural
    // `RuleTuiSimulationReport`, and the shell maps a `DryRunPlan` onto it.
    const offenders = sourceFiles(RULE_TUI_DIRECTORY)
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => specifier.includes("/simulation/"))
      .map(({ file, specifier }) => `${file.replace(`${REPOSITORY_ROOT}/`, "")} -> ${specifier}`)
    expect(offenders).toEqual([])
    // And the module really exists, so the assertion above is guarding a real edge
    // rather than guarding nothing.
    expect(existsSync(join(REPOSITORY_ROOT, "src/simulation/index.ts"))).toBe(true)
  })

  it("imports src/workflows/ nowhere, because a template names a rule set by DIGEST", () => {
    const offenders = sourceFiles(RULE_TUI_DIRECTORY)
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => specifier.includes("/workflows/"))
      .map(({ file, specifier }) => `${file.replace(`${REPOSITORY_ROOT}/`, "")} -> ${specifier}`)
    expect(offenders).toEqual([])
    // Same anti-vacuity check: `src/workflows` exists, so this is a real edge.
    expect(existsSync(join(REPOSITORY_ROOT, "src/workflows/index.ts"))).toBe(true)
  })

  it("imports src/tui/ nowhere, because the shell consumes this module and not the reverse", () => {
    const offenders = sourceFiles(RULE_TUI_DIRECTORY)
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => /(^|\/)tui\//.test(specifier))
      .map(({ file, specifier }) => `${file.replace(`${REPOSITORY_ROOT}/`, "")} -> ${specifier}`)
    expect(offenders).toEqual([])
  })

  it("reaches no filesystem, no process, no network, and no ambient clock", () => {
    // The purity claim as a source scan. A module that read a file or spawned a process
    // could not be rendered twice and compared, and the determinism tests would be
    // asserting something the code does not guarantee.
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
      { pattern: /from\s+"@opentui/, why: "a renderer dependency; the view model must be testable with no renderer" },
      { pattern: /\bnew\s+RegExp\s*\(/, why: "a second pattern path, which ADR 0007 section 4 forbids" },
    ]
    const offenders: string[] = []
    for (const file of sourceFiles(RULE_TUI_DIRECTORY)) {
      const code = stripsComments(file.text)
      for (const rule of forbidden) {
        if (rule.pattern.test(code)) {
          offenders.push(`${file.path.replace(`${REPOSITORY_ROOT}/`, "")}: ${rule.why}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("uses UTF-16 code-unit comparison for every ordering, and never localeCompare", () => {
    const offenders = sourceFiles(RULE_TUI_DIRECTORY)
      .filter((file) => /\.localeCompare\s*\(/.test(stripsComments(file.text)))
      .map((file) => file.path.replace(`${REPOSITORY_ROOT}/`, ""))
    expect(offenders).toEqual([])
  })
})

// ===========================================================================
// 3. The barrel is the whole surface
// ===========================================================================

describe("every module under src/rules/tui/ is reachable from the barrel", () => {
  it("exports something from every source file, so no file is dead code", () => {
    const files = sourceFiles(RULE_TUI_DIRECTORY)
      .map((file) => file.path.replace(`${REPOSITORY_ROOT}/`, ""))
      .sort()
    // The closed list of five. A sixth file would be a module this assertion is
    // declaring reachable when the barrel does not re-export it, so the list is exact
    // rather than "at least these".
    expect(files).toEqual([
      "src/rules/tui/builder.ts",
      "src/rules/tui/index.ts",
      "src/rules/tui/state.ts",
      "src/rules/tui/types.ts",
      "src/rules/tui/view-model.ts",
    ])

    // Each non-barrel module is named in the barrel, so a star-import reaches all of
    // them.
    const barrel = readFileSync(join(RULE_TUI_DIRECTORY, "index.ts"), "utf8")
    for (const name of ["types.js", "state.js", "builder.js", "view-model.js"]) {
      expect(barrel, `the barrel must re-export ${name}`).toContain(`"./${name}"`)
    }
  })

  it("keeps every local import NodeNext-correct with a .js extension", () => {
    // A relative import without the extension compiles under some bundler settings and
    // fails under Node's own resolver, so the check is on the text rather than on
    // whether `tsc` happens to be configured to allow it.
    const offenders = sourceFiles(RULE_TUI_DIRECTORY)
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => specifier.startsWith(".") && !specifier.endsWith(".js"))
      .map(({ file, specifier }) => `${file.replace(`${REPOSITORY_ROOT}/`, "")} -> ${specifier}`)
    expect(offenders).toEqual([])
  })
})