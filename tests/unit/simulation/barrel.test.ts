/**
 * M6.7 — the barrel, and the dependency direction.
 *
 * # What this file is FOR
 *
 * Two claims, of the same shape as `tests/unit/context/barrel.test.ts` and
 * `tests/unit/rules/barrel.test.ts`:
 *
 *   1. **Reachability.** The repo's convention is that callers import through a
 *      module's barrel, and every test in this directory does. A module reachable
 *      only by deep path import is a module nobody wired up, and the tests that use
 *      it would prove nothing about the shipped surface. M6.8 (the TUI) and the
 *      integration tests will import from `src/simulation/index.js`, so the members
 *      they need are named here explicitly — a caller that has to reach into
 *      `./plan.js` is a caller the barrel is not serving.
 *   2. **Direction.** ADR 0007 section 1 gives `simulation` the edges `rules,
 *      workflows, budgets, routing, orchestration, context`, and says that nothing
 *      under `src/orchestration/` may import any of the six M6 modules. The second
 *      is the one that matters most HERE, and for a reason specific to this module:
 *      a reverse edge would let a `dryRun` flag be threaded backwards into production
 *      code, which is precisely the second code path ADR 0007 section 16 exists to
 *      prevent. A source scan is the check, because an import cycle is exactly what a
 *      type checker will happily accept.
 *
 * The scan reads source with its comments stripped, for the reason
 * `tests/unit/simulation/determinism.test.ts` records: these modules are
 * heavily documented, and a scan that cannot tell prose from an import statement
 * fails on the docblock that NAMES the edge it is asserting.
 */

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import * as simulation from "../../../src/simulation/index.js"
import {
  CONTEXT_SENSITIVITY_LEVELS,
  SIMULATION_REFUSALS,
  SIMULATION_SINK_NAMES,
  SIMULATION_WARNING_KINDS,
  contextSensitivityRank,
  createBudgetLedgerProbe,
  createFailClosedSinks,
  emptySinkTally,
  expandRunTemplate,
  isBudgetStoreProbe,
  isSimulationRefusal,
  simulateDryRun,
  simulationRefuse,
  simulationRequestSchema,
  simulationWarning,
  toBudgetDecision,
} from "../../../src/simulation/index.js"

const REPOSITORY_ROOT = join(import.meta.dirname, "../../..")
const SOURCE_ROOT = join(REPOSITORY_ROOT, "src")

/**
 * Directories that may not import `src/simulation/**`, by ADR 0007 section 1.
 *
 * A superset of the ones the ADR names: the rule it states is "nothing under
 * `src/orchestration/` may import any of the six", and the same hazard — a dry-run
 * flag threaded backwards into production — applies to every module that already
 * depends on the ones `simulation` composes. Naming them here makes the scan above
 * a statement about the whole repository rather than about one directory.
 */
const FORBIDDEN_IMPORTERS = [
  "orchestration",
  "rules",
  "routing",
  "workflows",
  "budgets",
  "application",
  "tui",
  "context",
  "memory",
  "mesh",
  "notifications",
] as const

/** Directories `simulation` is allowed to import, by ADR 0007 section 1. */
const ALLOWED_EDGES = ["rules", "workflows", "budgets", "routing", "orchestration", "context"] as const

function sourceFiles(directory: string): readonly { path: string; text: string }[] {
  if (!directory.startsWith(SOURCE_ROOT)) return []
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => {
      const path = join(entry.parentPath ?? directory, entry.name)
      return { path, text: codeOnly(readFileSync(path, "utf8")) }
    })
}

/** The file with its comments removed, so a docblock naming an edge is not an import. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[^\S\n]*\/\/[^\n]*$/gm, " ")
}

/** Relative import AND re-export specifiers in a source file, ignoring comments. */
function importsOf(text: string): readonly string[] {
  const stripped = codeOnly(text)
  return [
    ...[...stripped.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]!),
    ...[...stripped.matchAll(/^\s*export\s[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]!),
  ]
}

describe("the M6.7 surface is reachable through its barrel", () => {
  it("the barrel exports the entry point, the plan digest, the expansion and the sinks", () => {
    // Zod v4 schemas are objects, not constructors, so the check for a schema is
    // "has a parse method" rather than `typeof === "function"`.
    expect(typeof simulation.simulateDryRun).toBe("function")
    expect(typeof simulation.computeDryRunPlanDigest).toBe("function")
    expect(typeof simulation.dryRunPlanDigestInput).toBe("function")
    expect(typeof simulation.expandRunTemplate).toBe("function")
    expect(typeof simulation.derivedTaskId).toBe("function")
    expect(typeof simulation.derivedDispatchId).toBe("function")
    expect(typeof simulation.createFailClosedSinks).toBe("function")
    expect(typeof simulation.createBudgetLedgerProbe).toBe("function")
    expect(typeof simulation.isBudgetStoreProbe).toBe("function")
    expect(typeof simulation.emptySinkTally).toBe("function")
    expect(typeof simulation.readSinkCounters).toBe("function")
    expect(typeof simulation.assertNoRetainedSideEffects).toBe("function")
    expect(typeof simulation.simulationRefuse).toBe("function")
    expect(typeof simulation.isSimulationRefusal).toBe("function")
    expect(typeof simulation.simulationWarning).toBe("function")
    expect(typeof simulation.contextSensitivityRank).toBe("function")
    expect(typeof simulation.toBudgetDecision).toBe("function")
    expect(typeof simulationRequestSchema.parse).toBe("function")
    expect(typeof simulation.simulatedExpansionSchema.parse).toBe("function")
    expect(typeof simulation.simulatedDispatchSchema.parse).toBe("function")
    expect(typeof simulation.simulatedGraphSchema.parse).toBe("function")
    expect(typeof simulation.simulatedTaskSchema.parse).toBe("function")
    expect(typeof simulation.simulatedContextSummarySchema.parse).toBe("function")
    expect(typeof simulation.simulatedRoleSummarySchema.parse).toBe("function")
    expect(typeof simulation.simulatedPolicySchema.parse).toBe("function")
    expect(typeof simulation.simulatedRoutingSchema.parse).toBe("function")
    expect(typeof simulation.simulatedBudgetPlanSchema.parse).toBe("function")
    expect(typeof simulation.simulatedRejectionSchema.parse).toBe("function")
    expect(typeof simulation.simulatedApprovalRequirementSchema.parse).toBe("function")
    expect(typeof simulation.simulatedPreApprovalMatchSchema.parse).toBe("function")
    expect(typeof simulation.budgetDecisionProjectionSchema.parse).toBe("function")
    expect(typeof simulation.simulatedRuleVerdictSchema.parse).toBe("function")
    expect(typeof simulation.simulationRequestSchema.parse).toBe("function")
    expect(typeof simulation.simulationProposalSchema.parse).toBe("function")
    expect(typeof simulation.simulationRegistrySnapshotSchema.parse).toBe("function")
    expect(typeof simulation.simulationMemorySnapshotSchema.parse).toBe("function")
    expect(typeof simulation.simulationBudgetInputSchema.parse).toBe("function")
    expect(typeof simulation.simulationTemplateRefSchema.parse).toBe("function")
    expect(typeof simulation.simulationStageSchema.parse).toBe("function")
    expect(typeof simulation.simulationRefusalSchema.parse).toBe("function")
    expect(typeof simulation.simulationWarningSchema.parse).toBe("function")
  })

  it("the closed vocabularies are reachable, so a caller can switch on them exhaustively", () => {
    expect([...SIMULATION_REFUSALS]).toEqual([...SIMULATION_REFUSALS].sort())
    expect([...SIMULATION_WARNING_KINDS]).toEqual([...SIMULATION_WARNING_KINDS].sort())
    expect([...SIMULATION_SINK_NAMES]).toEqual([...SIMULATION_SINK_NAMES].sort())
    expect(SIMULATION_REFUSALS.length).toBeGreaterThan(0)
    expect(SIMULATION_WARNING_KINDS).toContain("budget_not_enforceable")
    expect(SIMULATION_WARNING_KINDS).toContain("capability_unavailable")
    expect(SIMULATION_WARNING_KINDS).toContain("capability_unknown_to_role")
  })

  it("the sensitivity lattice the module restates is reachable, and its rank is its index", () => {
    expect([...CONTEXT_SENSITIVITY_LEVELS]).toEqual(["public_to_project", "restricted", "secret_reference_only", "prohibited"])
    expect(contextSensitivityRank("public_to_project")).toBe(0)
    expect(contextSensitivityRank("prohibited")).toBe(3)
  })

  it("a caller can build a refusal and a warning through the barrel without a deep import", () => {
    const refusal = simulationRefuse("simulation.input_invalid", "refused on purpose")
    expect(isSimulationRefusal(refusal)).toBe(true)
    if (refusal.ok) return
    expect(refusal.refusal.code).toBe("simulation.input_invalid")
    expect(refusal.refusal.origin).toBeNull()
    const warning = simulationWarning("capability_unavailable", "disp:build", ["gpu", "fs.read", "gpu"])
    expect(warning.detail).toEqual(["fs.read", "gpu"])
    expect(warning.message).toContain("No node in the registry snapshot")
  })

  it("the barrel re-exports nothing from a module outside ADR 0007 section 1's edge list", () => {
    // Reachability in the OTHER direction: a barrel is the natural place for a
    // convenience re-export to creep in, and `src/simulation/index.ts` re-exports
    // only its own four files, so this is a cheap guard against that.
    const barrel = sourceFiles(join(SOURCE_ROOT, "simulation")).find((file) => file.path.endsWith("index.ts"))
    expect(barrel).toBeDefined()
    const ownFiles = importsOf(barrel?.text ?? "")
    expect(ownFiles.every((specifier) => specifier.startsWith("./"))).toBe(true)
  })

  it("no module under `src/` imports `src/simulation/`, so a dry-run flag cannot reach production code", () => {
    const offenders: string[] = []
    for (const entry of readdirSync(SOURCE_ROOT, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue
      const path = join(entry.parentPath ?? SOURCE_ROOT, entry.name)
      if (path.includes(`${SOURCE_ROOT}/simulation/`)) continue
      for (const specifier of importsOf(readFileSync(path, "utf8"))) {
        if (/(^|\/)\.\.\/simulation\//.test(specifier) || specifier.endsWith("/simulation/index.js")) {
          offenders.push(`${path}: ${specifier}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("`src/simulation/` imports only the modules ADR 0007 section 1 names, and nothing else", () => {
    const offenders: string[] = []
    for (const file of sourceFiles(join(SOURCE_ROOT, "simulation"))) {
      for (const specifier of importsOf(file.text)) {
        if (!specifier.startsWith("..")) continue
        const target = specifier.replace(/^\.\.\//, "").replace(/\.js$/, "").split("/")[0]
        if (target === undefined) continue
        if (!(ALLOWED_EDGES as readonly string[]).includes(target)) offenders.push(`${file.path}: ${specifier}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("the listed forbidden importers each exist, so the scan above is not vacuous", () => {
    // A source scan over a directory that does not exist passes. Naming the
    // directories makes the assertion above falsifiable, and this is the assertion
    // that would notice if the repository were reorganised out from under it.
    const missing = FORBIDDEN_IMPORTERS.filter((name) => {
      try {
        readdirSync(join(SOURCE_ROOT, name))
        return false
      } catch {
        return true
      }
    })
    expect(missing).toEqual([])
  })

  it("`src/simulation/` is the ONLY module outside `src/workflows/` that imports it, which is the edge ADR 0007 section 1 names", () => {
    // `tests/unit/workflows/barrel.test.ts:390` asserts, in its exhaustive form, that
    // NOTHING under `src/` outside `src/workflows/` imports `src/workflows/`. That
    // assertion was written before this module existed and does not yet know about
    // the edge ADR 0007 section 1 gives `simulation`. This test pins the CURRENT
    // truth, which is the shape that assertion should end up asserting: exactly one
    // directory, and it is this one. A future second importer of `src/workflows/`
    // fails here first, with a message that says so.
    const workflowsDirectory = join(SOURCE_ROOT, "workflows")
    const importers = new Set<string>()
    for (const entry of readdirSync(SOURCE_ROOT, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue
      const path = join(entry.parentPath ?? SOURCE_ROOT, entry.name)
      if (path.startsWith(workflowsDirectory)) continue
      if (importsOf(readFileSync(path, "utf8")).some((specifier) => specifier.includes("/workflows/"))) {
        importers.add(path.split("/src/")[1]?.split("/")[0] ?? path)
      }
    }
    expect([...importers].sort()).toEqual(["simulation"])
  })

  it("the plan digest function is reachable under exactly the two names the handoff names", () => {
    // A barrel that exported the same function under two names would let a caller
    // import either and a future edit would have to keep both in step.
    const names = Object.keys(simulation).filter((name) => /digest/i.test(name)).sort()
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(["computeDryRunPlanDigest", "dryRunPlanDigestInput"])
  })
})

describe("the barrel's re-export order is the pipeline order, and says so", () => {
  it("the four files are exported types, sinks, expand, plan — the order the data flows", () => {
    const barrel = sourceFiles(join(SOURCE_ROOT, "simulation")).find((file) => file.path.endsWith("index.ts"))
    const ownFiles = (barrel === undefined ? [] : importsOf(barrel.text)).map((specifier) =>
      specifier.replace(/^\.\//, "").replace(/\.js$/, ""),
    )
    expect(ownFiles).toEqual(["types", "sinks", "expand", "plan"])
  })
})
