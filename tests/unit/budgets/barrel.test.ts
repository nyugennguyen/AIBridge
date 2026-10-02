/**
 * M6.5 barrel reachability and the dependency-direction guard.
 *
 * Two jobs, and the second is the one that earns the file its place:
 *
 *   1. **Reachability.** The repo convention is that callers import through the
 *      barrel. A module reachable only by deep path import is a module nobody wired
 *      up, and the tests that use it prove nothing about the shipped surface. This
 *      file also pins the EXACT export list M6.7 (dry run) is told to import, so the
 *      list in the `index.ts` docblock is a checked claim rather than a comment that
 *      rots.
 *   2. **Direction.** ADR 0007 section 13.2 makes reservation an INPUT to dispatch
 *      eligibility, so budgets sit between the kernel and the callers and the only
 *      edge they may have is `budgets -> orchestration`. Two failure modes are
 *      checked by source scan:
 *
 *        - `src/budgets/**` reaching UP into a subsystem that owns persistence
 *          (`src/rules`, `src/routing`, `src/workflows`, `src/application`,
 *          `src/notifications`, `src/tui`). A budget that could reach the rule engine
 *          would be able to decide which rules apply to it; a budget that could
 *          reach a repository would make "the effective budget" a function of
 *          whatever that repository happened to return.
 *        - any of `src/orchestration/**`, `src/rules/**`, `src/routing/**`,
 *          `src/workflows/**`, `src/application/**`, `src/tui/**` importing
 *          `src/budgets/**`. This is the edge that would turn the budget ledger
 *          from a component into a hidden dependency of the rule engine or the
 *          kernel, and it is the one that creates an IMPORT CYCLE — which is exactly
 *          the thing a type checker accepts happily and a source scan does not.
 *
 * WHY a source scan and not a runtime assertion: an import cycle is a compile-time
 * fact, and the only way to see it is to read the specifiers. The shape follows
 * `tests/unit/context/barrel.test.ts:30-42`.
 */

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import * as budgets from "../../../src/budgets/index.js"

const REPOSITORY_ROOT = join(import.meta.dirname, "../../..")
const BUDGETS_DIRECTORY = join(REPOSITORY_ROOT, "src/budgets")

/**
 * Directories `src/budgets/**` must not depend on.
 *
 * `src/orchestration` is deliberately ABSENT: it is the one edge the module is
 * allowed, and `budgets -> orchestration` is asserted positively below rather than
 * taken on trust.
 */
const UPWARD_FORBIDDEN: readonly string[] = [
  "application",
  "callback",
  "config",
  "context",
  "host",
  "jobs",
  "memory",
  "mesh",
  "notifications",
  "opencode",
  "planning",
  "registry",
  "routing",
  "rules",
  "runtime",
  "security",
  "server",
  "tasks",
  "terminal",
  "tui",
  "workflows",
]

/** Directories that must not import `src/budgets/**`. */
const DOWNWARD_FORBIDDEN: readonly string[] = [
  "application",
  "orchestration",
  "routing",
  "rules",
  "tui",
  "workflows",
]

function sourceFiles(directory: string): readonly { path: string; text: string }[] {
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

/** The sibling directory a specifier leaves `src/budgets` for, or `null` for a local one. */
function outwardHopOf(specifier: string): string | null {
  if (!specifier.startsWith("../")) return null
  return specifier.slice("../".length).split("/")[0] ?? null
}

function relativeToSource(path: string): string {
  return path.replace(`${REPOSITORY_ROOT}/`, "")
}

/**
 * A source file's CODE, with comments and docblocks removed.
 *
 * Necessary for the forbidden-token scans below. `src/budgets/types.ts:746` and
 * `src/budgets/compose.ts:456` both DISCUSS `localeCompare` in prose to explain why
 * they do not use it, and `addBudgetSeconds` documents `new Date(x)` in its
 * docblock; a scan over raw text would report every one of those explanations as a
 * violation, which is a scan that cannot ever go green and so checks nothing.
 *
 * Deliberately a crude strip rather than a parser: it removes block comments, line
 * comments, and template literals. A `//` inside a URL in a string literal would
 * over-strip and could hide a violation, which is accepted because the alternative
 * is a scan that fails on the module's own explanation of itself.
 */
function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ").replace(/`(?:[^`\\]|\\.)*`/g, "``")
}

// ===========================================================================
// Reachability
// ===========================================================================

describe("the M6.5 surface is reachable through its barrel", () => {
  it("exports the composition algebra, the ledger, and recovery", () => {
    // The three things `index.ts`'s docblock tells M6.7 to import.
    expect(typeof budgets.composeBudgets).toBe("function")
    expect(typeof budgets.composeBudgetsOrRefuse).toBe("function")
    expect(typeof budgets.admitUsage).toBe("function")
    expect(typeof budgets.scopeCeiling).toBe("function")
    expect(typeof budgets.compareByCodeUnit).toBe("function")
    expect(typeof budgets.BudgetLedger).toBe("function")
    expect(typeof budgets.InMemoryBudgetLedgerStore).toBe("function")
    expect(typeof budgets.recoverLeaked).toBe("function")
    expect(typeof budgets.recoveryReasonFor).toBe("function")
    expect(typeof budgets.replayDurableReservations).toBe("function")
  })

  it("exports the schemas M6.7 needs, as objects with a parse method", () => {
    // Zod v4 schemas are OBJECTS, not constructors, so the check is "has a parse
    // method" rather than `typeof === "function"` — the latter would pass for a
    // function that is not a schema at all.
    for (const name of [
      "budgetLimitsSchema",
      "budgetDecisionSchema",
      "budgetEnforceabilityRecordSchema",
      "budgetReservationSchema",
      "reserveRequestSchema",
      "reservationDraftSchema",
      "budgetRefusalSchema",
      "durableReservationRecordSchema",
      "usageObservationSchema",
      "budgetObservationSchema",
      "reclaimedReservationSchema",
    ] as const) {
      expect(typeof budgets[name], name).toBe("object")
      expect(typeof budgets[name].parse, name).toBe("function")
    }
  })

  it("exports the interfaces M6.7 names, checked as types rather than as values", () => {
    // Types are erased at runtime, so this assertion is a COMPILE-TIME one: the
    // function below is annotated with a return type naming every interface in the
    // docblock's list, each reached through the BARREL. If one were renamed, or
    // dropped from `index.ts`, the annotation would fail to resolve and the build
    // would break — which is the only way a type can be tested at all.
    //
    // The runtime half is only that the function is callable; the value of the test
    // is entirely in whether `tsc` accepts the annotation.
    expect(interfacesM6_7Needs().length).toBe(0)
  })

  it("exports the observation constructors and the pessimistic default", () => {
    // `NO_BUDGET_OBSERVATION` is what a caller that forgets to pass an observation
    // gets, and it is the reason "the pessimistic default" is testable rather than
    // a comment.
    expect(budgets.NO_BUDGET_OBSERVATION.usage.reported).toBe(false)
    expect(budgets.NO_BUDGET_OBSERVATION.usage.reliable).toBe(false)
    expect(budgets.NO_BUDGET_OBSERVATION.usage.consumedUnits).toBeNull()
    expect(budgets.NO_BUDGET_OBSERVATION.retryCounting).toBe(false)
    expect(Object.isFrozen(budgets.NO_BUDGET_OBSERVATION)).toBe(true)
    expect(typeof budgets.reportedUsageObservation).toBe("function")
  })

  it("exports the closed vocabularies a caller renders, and the helpers that order them", () => {
    for (const name of [
      "BUDGET_FIELDS",
      "BUDGET_NUMERIC_FIELDS",
      "BUDGET_REFUSALS",
      "BUDGET_SCOPES",
      "BUDGET_ENFORCEMENT_OWNERS",
      "RESERVATION_STATES",
      "RESERVATION_TRANSITIONS",
      "RECOVERY_REASONS",
      "REPLAY_REJECTION_REASONS",
      "USAGE_ADMISSION_REASONS",
      "USAGE_UNITS",
    ] as const) {
      expect(Array.isArray(budgets[name]), name).toBe(true)
      expect((budgets[name] as readonly unknown[]).length, name).toBeGreaterThan(0)
    }
    expect(typeof budgets.sortedUniqueBudgets).toBe("function")
    expect(typeof budgets.sortedUniqueIds).toBe("function")
    expect(typeof budgets.addBudgetSeconds).toBe("function")
    expect(typeof budgets.budgetScopeKey).toBe("function")
    expect(typeof budgets.deepFreezeBudgets).toBe("function")
    expect(typeof budgets.occupiesCapacity).toBe("function")
    expect(typeof budgets.isHeld).toBe("function")
    expect(typeof budgets.isTerminalReservationState).toBe("function")
    expect(typeof budgets.toContractError).toBe("function")
  })

  it("exports the replay surface a recovery caller needs, because the replay is now a second admission decision", () => {
    // The replay grew a REPORT and a CEILING input when MED-5 was fixed, so the
    // surface a recovery caller depends on is wider than `{ target, records }`. This
    // pins the members that widening added: without them a caller cannot find out
    // what the replay refused, which is the whole point of refusing anything.
    expect(typeof budgets.replayDurableReservations).toBe("function")
    expect(typeof budgets.replayRejectionSchema).toBe("object")
    expect(typeof budgets.replayScopeTotalSchema).toBe("object")
    expect(Array.isArray(budgets.REPLAY_REJECTION_REASONS)).toBe(true)
    // The refusal vocabulary is CLOSED (types.ts I11) and is the finite answer to
    // "what did the replay throw away and why", so its members are enumerable and
    // in code-unit order.
    expect([...budgets.REPLAY_REJECTION_REASONS]).toEqual([...budgets.REPLAY_REJECTION_REASONS].sort())
    // And a sweep's report gained the bucket that makes an unconfirmed reclamation
    // visible, so `RecoveryReport` is not silently a narrower type than it was.
    expect(typeof budgets.recoverLeaked).toBe("function")
  })

  it("declares the ceiling constants the ledger enforces against", () => {
    // Restated rather than imported from `src/rules/limits.ts` (types.ts:108-118),
    // so these four numbers are the ones a caller can check a rule's budget against.
    expect(budgets.BUDGET_MAX_FAN_OUT).toBe(256)
    expect(budgets.BUDGET_MAX_CONCURRENCY).toBe(256)
    expect(budgets.BUDGET_MAX_RETRY_LIMIT).toBe(16)
    expect(budgets.BUDGET_MAX_WALL_CLOCK_SECONDS).toBeGreaterThan(0)
  })

  it("exports the eligibility definition and the state predicates it is built from", () => {
    // `eligible` is `reservationState(dispatchId) === "held"` and nothing else. A
    // barrel without `reservationState` would leave a caller reaching into the store
    // to answer the question the ledger is supposed to answer, which is how a
    // second eligibility check gets written.
    const { ledger } = budgets_fixtureLedger()
    expect(typeof ledger.eligible).toBe("function")
    expect(typeof ledger.reservationState).toBe("function")
    expect(typeof ledger.reservationForDispatch).toBe("function")
    expect(typeof ledger.reserve).toBe("function")
    expect(typeof ledger.commit).toBe("function")
    expect(typeof ledger.release).toBe("function")
    expect(typeof ledger.expire).toBe("function")
    expect(typeof ledger.budgetFor).toBe("function")
    expect(typeof ledger.heldUnits).toBe("function")
    expect(typeof ledger.list).toBe("function")
    expect(typeof ledger.listHeld).toBe("function")
    // Before any reserve, nothing is eligible. The definition, with no budget set.
    expect(ledger.eligible("disp-anything")).toBe(false)
  })

  it("exports the store seam, so a dry run can supply a fail-closed fake", () => {
    // ADR 0007 section 16 requires the simulator to be the same planners with every
    // sink replaced by a fake, and the store is the sink that matters here. The
    // interface being exported is what makes that possible without M6.7 depending on
    // this module's internals.
    const store: budgets.BudgetLedgerStore = new budgets.InMemoryBudgetLedgerStore()
    expect(typeof store.reserveInTransaction).toBe("function")
    expect(typeof store.transition).toBe("function")
    expect(typeof store.read).toBe("function")
    expect(typeof store.list).toBe("function")
    expect(typeof store.listHeld).toBe("function")
    // And the shape is the one that makes atomicity expressible: the DECISION is a
    // synchronous callback receiving the held total, not a total the caller compares
    // for itself. A `heldUnits()`-then-`insert()` interface could not offer that.
    expect(store.reserveInTransaction.length).toBe(3)
  })
})

/** A ledger over an empty in-memory store, for the barrel's surface check. */
function budgets_fixtureLedger(): { ledger: budgets.BudgetLedger } {
  return {
    ledger: new budgets.BudgetLedger({
      store: new budgets.InMemoryBudgetLedgerStore(),
      resolveLimits: () => ({ maximumConcurrency: 1 }),
    }),
  }
}

/**
 * A COMPILE-TIME assertion that every interface `index.ts`'s docblock names as an
 * M6.7 import is reachable through the barrel.
 *
 * Written as a function's return-type annotation rather than a `type` alias plus a
 * runtime `expect`, because a bare type alias has no runtime binding: referencing it
 * in an assertion is a `ReferenceError`, which is what the first version of this
 * test did. The annotation is checked by `tsc` and nowhere else, which is exactly the
 * right place for a statement about types, and the body exists only so the function
 * is callable.
 */
function interfacesM6_7Needs(): Array<
  | budgets.BudgetLedgerStore
  | budgets.LedgerState
  | budgets.BudgetLimitResolver
  | budgets.BudgetComposition
  | budgets.BudgetDecision
  | budgets.BudgetLimits
  | budgets.BudgetRefusal
  | budgets.BudgetRefusalCode
  | budgets.BudgetReservation
  | budgets.ReservationDraft
  | budgets.ReservationId
  | budgets.ReservationState
  | budgets.BudgetScope
  | budgets.RecoveryReport
  | budgets.ReclaimedReservation
  | budgets.BudgetContribution
  | budgets.BudgetObservation
  | budgets.UsageUnit
> {
  return []
}

// ===========================================================================
// Direction
// ===========================================================================

describe("the dependency edge runs one way", () => {
  it("src/budgets imports src/orchestration and nothing else outside itself", () => {
    const hops = sourceFiles(BUDGETS_DIRECTORY)
      .flatMap((file) => importsOf(file.text))
      .flatMap((specifier) => {
        const hop = outwardHopOf(specifier)
        return hop === null ? [] : [hop]
      })
    // De-duplicated and sorted, so a failure names the directory rather than
    // repeating it once per import.
    expect([...new Set(hops)].sort()).toEqual(["orchestration"])
  })

  it("src/budgets reaches no subsystem that owns persistence, routing, rules, or presentation", () => {
    // The forbidden list is the whole of `src/` minus the module itself and
    // `orchestration`. A budget that could reach a rule evaluator would be one edit
    // away from deciding which rules apply to it; a budget that could reach a
    // repository would make "the effective budget" a function of storage.
    const offenders = sourceFiles(BUDGETS_DIRECTORY)
      .flatMap((file) =>
        importsOf(file.text).flatMap((specifier) => {
          const hop = outwardHopOf(specifier)
          return hop !== null && UPWARD_FORBIDDEN.includes(hop) ? [`${relativeToSource(file.path)} -> ${hop}`] : []
        }),
      )
      .sort()
    expect(offenders).toEqual([])
  })

  it("src/budgets does not reach outside the repository at all", () => {
    // No `node:fs`, no `node:net`, no bare package specifier. The module reads no
    // file, opens no socket and starts no process (types.ts I7), and its tests
    // inject a clock, so an import of any of these would be an I/O edge a source
    // scan is the only place to catch.
    const external = sourceFiles(BUDGETS_DIRECTORY)
      .flatMap((file) =>
        importsOf(file.text)
          .filter((specifier) => !specifier.startsWith("."))
          .map((specifier) => `${relativeToSource(file.path)} -> ${specifier}`),
      )
      .sort()
    // `zod` only, and only from the module that owns the schemas. A validator is not
    // an edge.
    expect(external).toEqual(["src/budgets/types.ts -> zod"])
  })

  it("no module in orchestration, rules, routing, workflows, application or tui imports src/budgets", () => {
    // The direction that would create an IMPORT CYCLE, and the one a type checker
    // accepts without complaint. Checked per directory so a failure names the
    // subsystem that reached, rather than reporting one anonymous offender.
    for (const directory of DOWNWARD_FORBIDDEN) {
      const absolute = join(REPOSITORY_ROOT, "src", directory)
      const offenders = sourceFiles(absolute)
        .flatMap((file) =>
          importsOf(file.text)
            .filter((specifier) => specifier.includes("/budgets/") || specifier.endsWith("/budgets.js"))
            .map((specifier) => `${relativeToSource(file.path)} -> ${specifier}`),
        )
        .sort()
      expect(offenders, directory).toEqual([])
    }
  })

  it("does not import src/rules even to restate a limit, because a budget is an INPUT to rule evaluation", () => {
    // ADR 0007 section 13.1's ceilings are restated in `types.ts:119-133` rather
    // than imported, and this asserts the restatement is still what ships. A budget
    // that imported `src/rules/limits.ts` would invert the narrowing direction: the
    // rule engine narrows a budget, so an edge budgets -> rules would let the budget
    // constrain the rules that narrow it.
    const specifiers = sourceFiles(BUDGETS_DIRECTORY).flatMap((file) => importsOf(file.text))
    expect(specifiers.filter((specifier) => specifier.includes("rules"))).toEqual([])
    // And the edges it DOES take are the three it documents, all into orchestration.
    expect(specifiers.filter((specifier) => specifier.startsWith("../orchestration/")).sort()).toEqual([
      "../orchestration/errors.js",
      "../orchestration/identifiers.js",
      "../orchestration/policy/types.js",
      "../orchestration/transitions.js",
    ])
  })

  it("never orders a list with localeCompare, so two machines produce byte-identical reports", () => {
    // I8 / C6. A report whose order depends on the host's ICU data is a report
    // nobody can diff, and this is the only check that sees a `localeCompare`
    // reintroduced in a helper added later.
    const offenders = sourceFiles(BUDGETS_DIRECTORY)
      .flatMap((file) => (codeOf(file.text).includes("localeCompare") ? [relativeToSource(file.path)] : []))
      .sort()
    expect(offenders).toEqual([])
  })

  it("reads no host clock and no random source in the module itself", () => {
    // The tests inject `now` and use a seeded LCG so that they are deterministic;
    // the module must be deterministic for the same reason to be worth anything. A
    // `Date.now()` or a `Math.random()` here would make every sweep result
    // unreproducible.
    //
    // `new Date(` is on the list and IS used — by `addBudgetSeconds`
    // (`types.ts:770-776`), which only does arithmetic on a supplied instant and
    // formats the result. It never reads the host clock, which is why the two
    // `Date.now` forms are listed separately rather than the constructor alone: a
    // bare `new Date()` with no argument WOULD be a clock read, so the scan asserts
    // the constructor only ever appears with an argument.
    const offenders = sourceFiles(BUDGETS_DIRECTORY)
      .flatMap((file) => {
        const code = codeOf(file.text)
        return ["Date.now(", "Math.random(", "new Date()"].filter((needle) => code.includes(needle)).map((needle) => `${relativeToSource(file.path)} -> ${needle}`)
      })
      .sort()
    expect(offenders).toEqual([])
  })
})

// ===========================================================================
// The documented M6.7 import list
// ===========================================================================

describe("the surface index.ts documents for M6.7 is the surface that ships", () => {
  it("exports every name in the docblock's import list, so the list cannot rot", () => {
    // Copied verbatim from `src/budgets/index.ts:54-60`. A dry run that followed the
    // docblock would import these; if one were renamed, this fails rather than the
    // dry run failing to compile halfway through its own task.
    const documented = [
      "composeBudgets",
      "composeBudgetsOrRefuse",
      "admitUsage",
      "BudgetLedger",
      "InMemoryBudgetLedgerStore",
      "recoverLeaked",
      "replayDurableReservations",
      "budgetLimitsSchema",
      "budgetDecisionSchema",
      "budgetReservationSchema",
      "NO_BUDGET_OBSERVATION",
      "reportedUsageObservation",
    ] as const
    const exported = budgets as Record<string, unknown>
    for (const name of documented) {
      expect(exported[name], name).toBeDefined()
    }
    // `BudgetLedgerStore`, `LedgerState`, `RecoveryReport`, `BudgetComposition`,
    // `BudgetDecision`, `BudgetLimits`, `BudgetRefusalCode` and `BudgetReservation`
    // are TYPES and are erased at runtime, so they are covered by the type-only
    // assertion above rather than here.
  })

  it("does not leak a `default` export, so a star-import of it is unambiguous", () => {
    expect((budgets as Record<string, unknown>)["default"]).toBeUndefined()
  })
})
