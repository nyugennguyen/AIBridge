/**
 * M6.6 — reachability and dependency direction.
 *
 * Two claims, both asserted by source scan rather than by inspection, because a
 * type checker will happily accept an import cycle and a module reachable only by
 * deep path is a module nobody wired up:
 *
 *   1. **REACHABILITY.** Everything a caller needs is exported from
 *      `src/routing/index.js`. This matters more here than in most modules because
 *      a Milestone 6.7 dry-run is about to be written against this surface: if the
 *      names it needs are not on the barrel, it will deep-import, and then the
 *      shipped surface and the tested surface are different surfaces.
 *   2. **DIRECTION.** ADR 0007 section 1 gives `routing` exactly two downward
 *      edges — `orchestration` and `mesh/registry` — and gives the other five M6
 *      modules no upward edge to it. Nothing in `src/mesh/registry/`,
 *      `src/orchestration/`, `src/rules/`, `src/budgets/`, `src/workflows/`,
 *      `src/application/`, or `src/tui/` may import `src/routing/`. A reverse edge
 *      would give the mesh registry a way to reach a scheduling preference, which
 *      is precisely the edge `no-scheduling-edges.test.ts` exists to keep it from
 *      growing.
 *   3. **NO STORE.** `src/routing/` imports no migrations file and no store
 *      implementation. Routing is an adapter over a registry; if it owned
 *      persistence it would be a second registry, and the projection it hands to
 *      the ranker would no longer be a snapshot of anything.
 *
 * The source-scan shape is the one already used at
 * `tests/unit/context/barrel.test.ts:30-42`, deliberately: one scanner, used twice,
 * is a scanner whose bugs are worth looking for once.
 */

import { describe, expect, it } from "vitest"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import * as routing from "../../../src/routing/index.js"

const REPOSITORY_ROOT = join(import.meta.dirname, "../../..")
const ROUTING_DIRECTORY = join(REPOSITORY_ROOT, "src/routing")

/** Modules that must not reach UP into routing. */
const FORBIDDEN_IMPORTERS: readonly { readonly directory: string; readonly label: string }[] = [
  { directory: join(REPOSITORY_ROOT, "src/mesh/registry"), label: "src/mesh/registry" },
  { directory: join(REPOSITORY_ROOT, "src/orchestration"), label: "src/orchestration" },
  { directory: join(REPOSITORY_ROOT, "src/rules"), label: "src/rules" },
  { directory: join(REPOSITORY_ROOT, "src/budgets"), label: "src/budgets" },
  { directory: join(REPOSITORY_ROOT, "src/workflows"), label: "src/workflows" },
  { directory: join(REPOSITORY_ROOT, "src/application"), label: "src/application" },
  { directory: join(REPOSITORY_ROOT, "src/tui"), label: "src/tui" },
]

/**
 * Every `.ts` file under a directory, or nothing if the directory does not exist
 * YET.
 *
 * `src/budgets`, `src/workflows`, `src/simulation`, and `src/notifications` are
 * built by sibling sub-agents in this milestone, so a scan that threw ENOENT on
 * an absent module would make this test's pass/fail depend on which agent finished
 * first. A module that does not exist cannot import routing, which is what the
 * scan is checking.
 */
function sourceFiles(directory: string): readonly { path: string; text: string }[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => {
      const path = join(entry.parentPath ?? directory, entry.name)
      return { path, text: readFileSync(path, "utf8") }
    })
}

/** Import specifiers in a source file, ignoring the ones inside a docblock. */
function importsOf(text: string): readonly string[] {
  return [...text.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]!)
}

function relative(filePath: string): string {
  return filePath.replace(`${process.cwd()}/`, "")
}

describe("the M6.6 routing surface is reachable through its barrel", () => {
  it("exports the adapter and the ranker, which are the only two ways to produce an answer", () => {
    expect(typeof routing.buildRoutingSnapshot).toBe("function")
    expect(typeof routing.buildRoutingSnapshotForNode).toBe("function")
    expect(typeof routing.rankNodes).toBe("function")
  })

  it("exports the schemas and closed sets a caller needs to read and validate an answer", () => {
    // Zod v4 schemas are objects with a `parse` method, not constructors, so the
    // check is "has a parse method" rather than `typeof === "function"`.
    for (const schema of [
      routing.routingNodeSnapshotSchema,
      routing.routingRequestSchema,
      routing.routingExclusionReasonSchema,
      routing.routingExclusionSchema,
      routing.routingCandidateResultSchema,
      routing.routingIgnoredPreferenceSchema,
      routing.routingHealthReasonSchema,
    ]) {
      expect(typeof schema).toBe("object")
      expect(typeof (schema as { parse: unknown }).parse).toBe("function")
    }
    expect(Array.isArray(routing.ROUTING_EXCLUSION_REASONS)).toBe(true)
    expect(Array.isArray(routing.ROUTING_HEALTH_REASONS)).toBe(true)
    expect(Array.isArray(routing.ROUTING_REFUSALS)).toBe(true)
    expect(Array.isArray(routing.ROUTING_CHECK_ORDER)).toBe(true)
  })

  it("exports the comparators, because a caller rendering the same order must reach them", () => {
    // `compareByCodeUnit` is exported on purpose: a TUI or a dry-run that sorts a
    // node list has to sort it the way routing sorted it, and re-deriving the
    // comparator is how two views of one decision end up disagreeing.
    expect(typeof routing.compareByCodeUnit).toBe("function")
    expect(typeof routing.sortedUnique).toBe("function")
    expect(typeof routing.digestRoutingResult).toBe("function")
    expect(typeof routing.renderExplanation).toBe("function")
  })

  it("exports the neutral preference, so a caller with no rules needs no preference of its own", () => {
    expect(Object.isFrozen(routing.EMPTY_ROUTING_PREFERENCE)).toBe(true)
    expect(routing.EMPTY_ROUTING_PREFERENCE.preferredNodeIds).toEqual([])
    expect(routing.EMPTY_ROUTING_PREFERENCE.requiredRuntimeKind).toBeNull()
  })

  it("exports the deep freeze, so a caller building snapshots shares the same immutability rule", () => {
    expect(typeof routing.deepFreezeRouting).toBe("function")
  })
})

describe("the M6.6 dependency edges run one way", () => {
  it("no module in a lower layer imports src/routing", () => {
    const offenders: string[] = []
    for (const { directory, label } of FORBIDDEN_IMPORTERS) {
      const files = sourceFiles(directory)
      for (const file of files) {
        for (const specifier of importsOf(file.text)) {
          if (specifier.includes("/routing/") || specifier.endsWith("/routing.js")) {
            offenders.push(`${label}: ${relative(file.path)} -> ${specifier}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("src/routing imports mesh/registry and orchestration, and nothing above them", () => {
    const specifiers = sourceFiles(ROUTING_DIRECTORY).flatMap((file) => importsOf(file.text))
    expect(specifiers.some((specifier) => specifier.includes("/mesh/registry/"))).toBe(true)
    expect(specifiers.some((specifier) => specifier.includes("/orchestration/"))).toBe(true)
    // The two directions the ADR explicitly denies. `rules` in particular: routing
    // consumes the unioned preference BY SHAPE, so a caller can hand
    // `RuleEvaluationResult.routing` straight in without an edge that would put the
    // rule language underneath the thing that ranks nodes.
    const forbidden = ["/rules/", "/budgets/", "/workflows/", "/simulation/", "/notifications/", "/application/", "/tui/", "/server/"]
    const offenders = sourceFiles(ROUTING_DIRECTORY)
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => forbidden.some((needle) => specifier.includes(needle)))
      .map(({ file, specifier }) => `${relative(file)} -> ${specifier}`)
    expect(offenders).toEqual([])
  })

  it("src/routing imports no migration file and no store implementation", () => {
    // Routing is an ADAPTER over a registry. If it imported `migrations.ts`,
    // `sqlite-registry.ts`, or `memory-registry.ts`, it would own persistence, and
    // the "immutable snapshot of the mesh" the ranker receives would be a snapshot
    // of a database this module had opened itself. The mesh registry's own
    // module docblock makes the same promise ("only ./sqlite-registry.js and
    // ./migrations.js may touch storage"), and the two together leave exactly one
    // owner of persistence in that directory.
    const forbidden = [
      "/migrations.js",
      "sqlite-registry",
      "memory-registry",
      "sqlite-driver",
      "event-store",
      "/bridge.js",
      "/cli.js",
      "/server/",
    ]
    const offenders = sourceFiles(ROUTING_DIRECTORY)
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => forbidden.some((needle) => specifier.includes(needle)))
      .map(({ file, specifier }) => `${relative(file)} -> ${specifier}`)
    expect(offenders).toEqual([])
  })

  it("src/routing reaches the mesh registry only through its public read surface", () => {
    const specifiers = sourceFiles(ROUTING_DIRECTORY)
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => specifier.includes("/mesh/registry/"))
    expect(specifiers.length).toBeGreaterThan(0)
    for (const { file, specifier } of specifiers) {
      // Every registry import is a sibling-directory hop out of `src/routing`, and
      // a bare `"../registry.js"` would be a DIFFERENT file with a similar name.
      expect(specifier.startsWith("../mesh/registry/")).toBe(true)
      expect(relative(file).startsWith("src/routing/")).toBe(true)
    }
    // The three it names, so a reader sees the adapter's declared dependencies
    // without opening the files.
    expect(specifiers.map((entry) => entry.specifier)).toContain("../mesh/registry/registry.js")
    expect(specifiers.map((entry) => entry.specifier)).toContain("../mesh/registry/schemas.js")
  })

  it("imports nothing through the top-level barrel, which would hide which file is actually read", () => {
    // A `"../../index.js"` hop would make the dependency unreadable from the
    // import line, and the direction assertions above would be reading a lie.
    const offenders = sourceFiles(ROUTING_DIRECTORY)
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => specifier === "../../index.js" || specifier === "../index.js")
      .map(({ file, specifier }) => `${relative(file)} -> ${specifier}`)
    expect(offenders).toEqual([])
  })
})

describe("the M6.6 module boundary is documented in the source", () => {
  it("gives every module a docblock that states what the module is for", () => {
    const files = sourceFiles(ROUTING_DIRECTORY)
    expect(files.length).toBe(4)
    for (const file of files) {
      expect(file.text.startsWith("/**")).toBe(true)
      // A docblock that does not say WHY is a comment, and a comment is not a
      // constraint anyone can check.
      expect(file.text.length).toBeGreaterThan(1_000)
    }
  })

  it("states the invariants and the stop conditions by name where they are enforced", () => {
    const types = readFileSync(join(ROUTING_DIRECTORY, "types.ts"), "utf8")
    for (const invariant of ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "S1", "S2", "S3"]) {
      expect(types).toContain(invariant)
    }
    // A3 and A4 are the adapter's, and A2 is cited from the ranker, so all three
    // must be in the adapter's docblock rather than only in the module that reads
    // the values they govern.
    const snapshot = readFileSync(join(ROUTING_DIRECTORY, "snapshot.ts"), "utf8")
    for (const invariant of ["A1", "A2", "A3", "A4", "A5", "A6", "S1"]) {
      expect(snapshot).toContain(invariant)
    }
    // The ranker consumes A3 (fail-closed authorization) and A4 (reused verdicts)
    // and cites them at the points where it depends on them, which is the test that
    // a future edit cannot quietly stop honouring the adapter's guarantees.
    const rank = readFileSync(join(ROUTING_DIRECTORY, "rank.ts"), "utf8")
    expect(rank).toContain("A3")
    expect(rank).toContain("A4")
  })

  it("names the projection as the reason the mesh registry needed no change", () => {
    // The architectural claim, asserted in the place a reviewer will look for it.
    // If someone later adds a scheduling field to the registry, these two strings
    // are what the diff will contradict, and this test is what says so out loud.
    const types = readFileSync(join(ROUTING_DIRECTORY, "types.ts"), "utf8")
    expect(types).toContain("no-scheduling-edges.test.ts")
    expect(types).toContain("PROJECTION")
    const snapshot = readFileSync(join(ROUTING_DIRECTORY, "snapshot.ts"), "utf8")
    expect(snapshot).toContain("Nothing in `src/mesh/registry/` is modified")
  })

  it("keeps every local import ending in .js, as NodeNext requires", () => {
    for (const file of sourceFiles(ROUTING_DIRECTORY)) {
      for (const specifier of importsOf(file.text)) {
        if (!specifier.startsWith(".")) continue
        expect(specifier.endsWith(".js")).toBe(true)
      }
    }
  })
})
