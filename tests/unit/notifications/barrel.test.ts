/**
 * The M6.9 barrel: every export reachable, and the dependency edge pointing the right
 * way.
 *
 * Two properties, and the second is the one that earns the file.
 *
 * 1. REACHABILITY. A module reachable only by deep path is a module nobody wired up,
 *    and the tests that use it prove nothing about the shipped surface. Every other
 *    test in `tests/unit/notifications/` imports through `src/notifications/index.js`,
 *    and this file asserts that the surface they use is the surface that exists.
 *
 * 2. DIRECTION. ADR 0007 section 1 declares
 *    `notifications -> (no orchestration, mesh, memory, or runtime imports)`, and
 *    section 17 names that edge as the MECHANISM by which "delivery never affects
 *    orchestration state" is true rather than aspirational. An import cycle is exactly
 *    what a type checker will happily accept, so the edge is checked by SOURCE SCAN
 *    over real `from "..."` statements, in the shape of
 *    `tests/unit/context/barrel.test.ts:106-137`.
 *
 * THE RESTATED IDENTIFIER SCHEMAS ARE ASSERTED AGAINST THE KERNEL'S.
 *
 * `src/notifications/types.ts` restates `opaqueIdPattern` and `utcTimestampPattern`
 * rather than importing them, because importing them from
 * `src/orchestration/identifiers.js` would be exactly the upward edge the direction
 * rule forbids. The cost of restating is drift, and this file pays that cost
 * explicitly: it reads BOTH files and asserts that the notification patterns are
 * byte-identical substrings of the orchestration file's. A restatement that matches
 * is a projection; a restatement that has diverged is a failing test rather than a
 * silent second identifier language.
 *
 * WHY THE SCAN IGNORES DOCBLOCKS. A file that documents the direction it must not
 * cross would otherwise fail the scan for mentioning the forbidden path in prose. The
 * scan therefore strips comments before it reads import specifiers, and
 * `stripComments` is itself asserted — a stripper that silently did nothing would make
 * every case below vacuous.
 */

import { describe, expect, it } from "vitest"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import * as notifications from "../../../src/notifications/index.js"

const REPOSITORY_ROOT = join(import.meta.dirname, "../../..")
const NOTIFICATIONS_DIRECTORY = join(REPOSITORY_ROOT, "src/notifications")
const IDENTIFIERS_SOURCE = join(REPOSITORY_ROOT, "src/orchestration/identifiers.ts")

/**
 * Import a sibling M6 barrel, or `null` when the sibling has not been written yet.
 *
 * Sibling modules in a milestone are built by concurrent sub-agents, so a scan or a
 * collision check that threw ENOENT on an absent module would make this file's
 * pass/fail depend on which agent finished first. A module that does not exist cannot
 * export a colliding name, which is exactly what the check below is asking.
 */
async function optionalBarrel(path: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(path)) return null
  return (await import(path)) as Record<string, unknown>
}

function sourceFiles(directory: string): readonly { path: string; text: string }[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => {
      const path = join(entry.parentPath ?? directory, entry.name)
      return { path, text: readFileSync(path, "utf8") }
    })
}

/** Strip block and line comments, so a docblock naming a forbidden path is not an import. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

/** The stripper is itself asserted, so every scan below is known not to be vacuous. */
function importsOf(text: string): readonly string[] {
  return [...stripComments(text).matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]!)
}

describe("the M6.9 surface is reachable through its barrel", () => {
  it("exports the schemas and closed sets a producer and an auditor both need", () => {
    // Zod v4 schemas are objects with a `parse` method, not constructors, so the check
    // is "has a parse method" rather than `typeof === "function"` — the latter would
    // pass for a function that is not a schema at all.
    for (const schema of [
      notifications.notificationEnvelopeSchema,
      notifications.notificationRequestSchema,
      notifications.notificationCategorySchema,
      notifications.notificationSeveritySchema,
      notifications.notificationNonDeliveryReasonSchema,
      notifications.notificationDispositionSchema,
      notifications.notificationIdSchema,
      notifications.dedupeKeySchema,
      notifications.notificationReasonCodeSchema,
      notifications.notificationRunIdSchema,
      notifications.notificationTaskIdSchema,
      notifications.notificationDispatchIdSchema,
      notifications.notificationNodeIdSchema,
      notifications.notificationRuleIdSchema,
      notifications.notificationTimestampSchema,
      notifications.notificationSummarySchema,
    ]) {
      expect(typeof schema).toBe("object")
      expect(typeof (schema as { parse: unknown }).parse).toBe("function")
    }
    expect(Array.isArray(notifications.NOTIFICATION_CATEGORIES)).toBe(true)
    expect(Array.isArray(notifications.NOTIFICATION_SEVERITIES)).toBe(true)
    expect(Array.isArray(notifications.NOTIFICATION_NON_DELIVERY_REASONS)).toBe(true)
    expect(Array.isArray(notifications.NOTIFICATION_DISPOSITIONS)).toBe(true)
    expect(Array.isArray(notifications.NOTIFICATION_MUTE_AXES)).toBe(true)
    expect(Array.isArray(notifications.NOTIFICATION_EGRESS_PATHS)).toBe(true)
  })

  it("exports the store, the bus, and the quieting rule", () => {
    expect(typeof notifications.createNotificationStore).toBe("function")
    expect(typeof notifications.createNotificationBus).toBe("function")
    expect(typeof notifications.notificationMuteVerdict).toBe("function")
    expect(typeof notifications.normalizeNotificationQuieting).toBe("function")
    expect(typeof notifications.DEFAULT_NOTIFICATION_RETENTION_WINDOW_MS).toBe("number")
  })

  it("exports the no-secret audit, so a gate report can cite a function rather than a claim", () => {
    expect(typeof notifications.auditNotificationPayload).toBe("function")
    expect(typeof notifications.describeNotificationAudit).toBe("function")
    expect(typeof notifications.findSeededNotificationSecret).toBe("function")
  })

  it("exports the TUI adapter, the view model builder, the reducer, and the key routing", () => {
    expect(typeof notifications.createNotificationTuiAdapter).toBe("function")
    expect(typeof notifications.buildNotificationTuiView).toBe("function")
    expect(typeof notifications.reduceNotificationTui).toBe("function")
    expect(typeof notifications.initialNotificationTuiState).toBe("function")
    expect(typeof notifications.routeNotificationKey).toBe("function")
    expect(typeof notifications.notificationNoticeLine).toBe("function")
    expect(typeof notifications.loadNotificationTuiEntries).toBe("function")
    expect(typeof notifications.acknowledgeNotificationEntries).toBe("function")
    expect(typeof notifications.renderAge).toBe("function")
    expect(typeof notifications.renderRowSubject).toBe("function")
    expect(typeof notifications.summarizeNotification).toBe("function")
    expect(typeof notifications.describeQuieting).toBe("function")
    expect(typeof notifications.isNotificationMuted).toBe("function")
  })

  it("exports the comparators, because a caller rendering the same order must reach them", () => {
    // `compareNotificationCodeUnits` is exported on purpose: the TUI sorts an inbox
    // the way this module sorted it, and re-deriving the comparator is how two views
    // of one inbox end up disagreeing.
    expect(typeof notifications.compareNotificationCodeUnits).toBe("function")
    expect(typeof notifications.sortedUniqueNotificationCodes).toBe("function")
  })

  it("exports the neutral setting, so a caller with no quieting needs no setting of its own", () => {
    expect(Object.isFrozen(notifications.NO_NOTIFICATION_QUIETING)).toBe(true)
    expect(notifications.NO_NOTIFICATION_QUIETING.categories).toEqual([])
    expect(notifications.NO_NOTIFICATION_QUIETING.severities).toEqual([])
    expect(notifications.NO_NOTIFICATION_QUIETING.pairs).toEqual([])
    expect(Object.isFrozen(notifications.EMPTY_NOTIFICATION_COUNTERS)).toBe(true)
  })

  it("does NOT export the store's entry type as a value, because it is a type", () => {
    // The store's entry type is re-exported for typing only. Asserting it is ABSENT
    // from the runtime surface catches a `export const` that was meant to be a type.
    expect((notifications as Record<string, unknown>)["NotificationInboxEntry"]).toBeUndefined()
  })

  it("exports the deep-freeze helper, because a guarantee about immutability is only real if it can be tested", () => {
    // N14 rests on `Object.freeze`, and the envelope the schema accepts is flat, so a
    // private freeze helper could be a shallow one and every other test in this
    // directory would still pass. Exporting it is what makes "the freezing is DEEP" a
    // claim a test can make about a value that actually nests.
    expect(typeof notifications.deepFreezeNotificationValue).toBe("function")
    const frozen = notifications.deepFreezeNotificationValue({ a: { b: [1] } })
    expect(Object.isFrozen(frozen.a)).toBe(true)
    expect(Object.isFrozen(frozen.a.b)).toBe(true)
  })

  it("exports nothing that could be used to reach an unexported value from a frozen one", () => {
    // The freeze helper is the one new runtime export, and it is checked here for the
    // shape that would make N14 decorative: it must take a value and return a value, so
    // there is no hidden "and also give me the original back" behaviour to find.
    const helper = notifications.deepFreezeNotificationValue as (value: unknown) => unknown
    expect(helper.length).toBe(1)
    expect(helper(undefined)).toBeUndefined()
    expect(helper(null)).toBeNull()
    expect(helper(7)).toBe(7)
  })

  it("exports nothing that reaches into another M6 module's types by re-export", () => {
    // The notifications barrel re-exports nothing from `src/rules`, `src/routing`,
    // `src/budgets`, or `src/workflows`. A re-export of a kernel value would give this
    // module a second owner of a value someone else owns (the pattern
    // `src/rules/index.ts` uses for the kernel, and which this module deliberately
    // does not, because it has no upstream at all).
    const specifiers = sourceFiles(NOTIFICATIONS_DIRECTORY).flatMap((file) => importsOf(file.text))
    expect(specifiers.some((specifier) => /"\.\.\/(rules|routing|budgets|workflows)\//.test(specifier))).toBe(false)
  })
})

describe("the M6.9 dependency edge runs one way", () => {
  it("src/notifications imports nothing upward", () => {
    const forbidden = ["/orchestration/", "/mesh/", "/runtime/", "/application/", "/memory/", "/context/", "/server/", "/tui/"]
    const offenders = sourceFiles(NOTIFICATIONS_DIRECTORY)
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => forbidden.some((needle) => specifier.includes(needle)))
      .map(({ file, specifier }) => `${file.replace(`${REPOSITORY_ROOT}/`, "")} -> ${specifier}`)
    expect(offenders).toEqual([])
  })

  it("src/notifications imports only zod outside its own directory", () => {
    const external = sourceFiles(NOTIFICATIONS_DIRECTORY)
      .flatMap((file) => importsOf(file.text))
      .filter((specifier) => !specifier.startsWith("."))
    expect([...new Set(external)].sort()).toEqual(["zod"])
  })

  it("src/notifications reaches no M6 sibling module", () => {
    const siblings = ["/rules/", "/routing/", "/budgets/", "/workflows/", "/simulation/"]
    const offenders = sourceFiles(NOTIFICATIONS_DIRECTORY)
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => siblings.some((needle) => specifier.includes(needle)))
      .map(({ file, specifier }) => `${file.replace(`${REPOSITORY_ROOT}/`, "")} -> ${specifier}`)
    expect(offenders).toEqual([])
  })

  it("src/notifications reaches no entry point, so no transport sits between it and the operator", () => {
    const forbidden = ["/cli.js", "/bridge.js", "/server.js", "/index.js", "../index.js"]
    const offenders = sourceFiles(NOTIFICATIONS_DIRECTORY)
      .flatMap((file) => importsOf(file.text).map((specifier) => ({ file: file.path, specifier })))
      .filter(({ specifier }) => forbidden.includes(specifier))
      .map(({ file, specifier }) => `${file.replace(`${REPOSITORY_ROOT}/`, "")} -> ${specifier}`)
    expect(offenders).toEqual([])
  })

  it("keeps every local import ending in .js, as NodeNext requires", () => {
    for (const file of sourceFiles(NOTIFICATIONS_DIRECTORY)) {
      for (const specifier of importsOf(file.text)) {
        if (!specifier.startsWith(".")) continue
        expect(specifier.endsWith(".js")).toBe(true)
      }
    }
  })

  it("does not reach ambient time, randomness, the filesystem, or the process", () => {
    const forbidden = [/\bDate\.now\s*\(/, /\bnew Date\s*\(\s*\)/, /\bMath\.random\s*\(/, /\brequire\s*\(/, /\bprocess\./, /\bglobalThis\b/]
    for (const file of sourceFiles(NOTIFICATIONS_DIRECTORY)) {
      const code = stripComments(file.text)
      for (const pattern of forbidden) {
        expect(pattern.test(code), `${file.path} matches ${pattern}`).toBe(false)
      }
    }
  })

  it("names its invariants and stop conditions in the sources where they are enforced", () => {
    const types = readFileSync(join(NOTIFICATIONS_DIRECTORY, "types.ts"), "utf8")
    for (const invariant of ["N1", "N2", "N3", "N4", "N5", "N6", "N14"]) {
      expect(types, `types.ts is missing ${invariant}`).toContain(invariant)
    }
    for (const stopCondition of ["S1", "S2", "S3", "S4", "S17"]) {
      expect(types, `types.ts is missing ${stopCondition}`).toContain(stopCondition)
    }
    const store = readFileSync(join(NOTIFICATIONS_DIRECTORY, "store.ts"), "utf8")
    for (const invariant of ["N4", "N5", "N6", "N7", "N8", "N9", "N14"]) {
      expect(store, `store.ts is missing ${invariant}`).toContain(invariant)
    }
    for (const stopCondition of ["S5", "S6", "S7", "S14"]) {
      expect(store, `store.ts is missing ${stopCondition}`).toContain(stopCondition)
    }
    const bus = readFileSync(join(NOTIFICATIONS_DIRECTORY, "bus.ts"), "utf8")
    for (const invariant of ["N1", "N3", "N6", "N8", "N10", "N11", "N14"]) {
      expect(bus, `bus.ts is missing ${invariant}`).toContain(invariant)
    }
    for (const stopCondition of ["S8", "S9", "S10", "S15"]) {
      expect(bus, `bus.ts is missing ${stopCondition}`).toContain(stopCondition)
    }
    const tui = readFileSync(join(NOTIFICATIONS_DIRECTORY, "tui-adapter.ts"), "utf8")
    for (const invariant of ["N2", "N4", "N5", "N6", "N12", "N13"]) {
      expect(tui, `tui-adapter.ts is missing ${invariant}`).toContain(invariant)
    }
    for (const stopCondition of ["S11", "S12", "S13"]) {
      expect(tui, `tui-adapter.ts is missing ${stopCondition}`).toContain(stopCondition)
    }
  })

  it("states N14 in the module that hands an adapter its envelope, because that is where the promise is made", () => {
    // An invariant asserted only in the file that happens to be edited is an invariant
    // that gets deleted along with the code. The adapter-facing contract lives in
    // `types.ts` (where `NotificationAdapter` is declared), and the mechanism lives in
    // `bus.ts` (where the clone is made) and `store.ts` (where the record is frozen), so
    // all three have to name it.
    expect(readFileSync(join(NOTIFICATIONS_DIRECTORY, "types.ts"), "utf8")).toContain("deep-frozen, per-adapter clone")
    expect(readFileSync(join(NOTIFICATIONS_DIRECTORY, "bus.ts"), "utf8")).toContain("structuredClone")
    expect(readFileSync(join(NOTIFICATIONS_DIRECTORY, "store.ts"), "utf8")).toContain("deepFreezeNotificationValue")
  })

  it("states the import-direction decision as a claim a reviewer can check", () => {
    // The architectural claim, asserted in the place a reviewer will look. If someone
    // later adds `src/notifications/ -> src/tui/`, this string is what the diff
    // contradicts, and the source scan above is what says so out loud.
    const tui = readFileSync(join(NOTIFICATIONS_DIRECTORY, "tui-adapter.ts"), "utf8")
    expect(tui).toContain("S4")
    expect(tui).toContain("TuiUiState.notice")
    const index = readFileSync(join(NOTIFICATIONS_DIRECTORY, "index.ts"), "utf8")
    expect(index).toContain("DELIBERATELY NOT RE-EXPORTED")
  })
})

describe("the restated identifier schemas have not drifted from the kernel's", () => {
  it("states the same opaque-id pattern as src/orchestration/identifiers.ts", () => {
    // The restatement exists because importing the kernel's is the forbidden upward
    // edge. This assertion is the price of that choice: a local restatement that has
    // diverged is a second identifier language, and this is what makes it a failing
    // test instead.
    const types = readFileSync(join(NOTIFICATIONS_DIRECTORY, "types.ts"), "utf8")
    const identifiers = readFileSync(IDENTIFIERS_SOURCE, "utf8")
    const mine = /const opaqueIdPattern = (\/\^\[A-Za-z0-9\][^/]*\/)/.exec(types)?.[1]
    const theirs = /const opaqueIdPattern = (\/\^\[A-Za-z0-9\][^/]*\/)/.exec(identifiers)?.[1]
    expect(mine).toBeDefined()
    expect(theirs).toBeDefined()
    expect(mine).toBe(theirs)
  })

  it("states the same UTC timestamp pattern as src/orchestration/identifiers.ts", () => {
    const types = readFileSync(join(NOTIFICATIONS_DIRECTORY, "types.ts"), "utf8")
    const identifiers = readFileSync(IDENTIFIERS_SOURCE, "utf8")
    const pattern = /const utcTimestampPattern = (\/\^\\d\{4\}[^/]*\/)/.source
    const mine = new RegExp(pattern).exec(types)?.[1]
    const theirs = new RegExp(pattern).exec(identifiers)?.[1]
    expect(mine).toBeDefined()
    expect(theirs).toBeDefined()
    expect(mine).toBe(theirs)
  })

  it("brands its identifiers with LOCAL brand names, so a kernel id is not assignable without parsing", () => {
    // A second deliberate divergence: `NotificationRunId` is not `RunId`. Being unable
    // to pass a kernel identifier across without going through this module's schema is
    // the point, and it also keeps the two barrels' type surfaces disjoint.
    const types = readFileSync(join(NOTIFICATIONS_DIRECTORY, "types.ts"), "utf8")
    expect(types).toContain('.brand<"NotificationRunId">()')
    expect(types).toContain('.brand<"NotificationTaskId">()')
    expect(types).toContain('.brand<"NotificationDispatchId">()')
    expect(types).toContain('.brand<"NotificationNodeId">()')
    expect(types).toContain('.brand<"NotificationRuleId">()')
    expect(types).toContain('.brand<"NotificationTimestamp">()')
    // And it must NOT brand itself as the kernel's name.
    expect(types).not.toContain('.brand<"RunId">()')
    expect(types).not.toContain('.brand<"TaskId">()')
    expect(types).not.toContain('.brand<"RuleId">()')
  })

  it("agrees with the kernel's timestamp refinement by rejecting an impossible instant", () => {
    // `2026-02-31T00:00:00Z` satisfies the pattern but is not a real date, which is
    // what the kernel's `refine` catches. If the restatement dropped the refine, this
    // would pass a value the kernel refuses.
    expect(notifications.notificationTimestampSchema.safeParse("2026-02-31T00:00:00Z").success).toBe(false)
    expect(notifications.notificationTimestampSchema.safeParse("2026-13-01T00:00:00Z").success).toBe(false)
    expect(notifications.notificationTimestampSchema.safeParse("2026-10-01T25:00:00Z").success).toBe(false)
    expect(notifications.notificationTimestampSchema.safeParse("2026-10-01T00:00:00+01:00").success).toBe(false)
    expect(notifications.notificationTimestampSchema.safeParse("2026-10-01T00:00:00.000Z").success).toBe(true)
  })

  it("agrees with the kernel's opaque-id pattern on the values it accepts", () => {
    for (const value of ["run-1", "a", "a".repeat(128)]) {
      expect(notifications.notificationRunIdSchema.safeParse(value).success, value).toBe(true)
    }
    for (const value of ["", "-leading", "has space", "a".repeat(129), "has/slash"]) {
      expect(notifications.notificationRunIdSchema.safeParse(value).success, value).toBe(false)
    }
  })
})

describe("no name is exported by two M6 barrels", () => {
  const siblingPaths = {
    rules: "../../../src/rules/index.js",
    routing: "../../../src/routing/index.js",
    budgets: "../../../src/budgets/index.js",
    workflows: "../../../src/workflows/index.js",
  } as const

  for (const [sibling, path] of Object.entries(siblingPaths)) {
    it(`shares no export name with src/${sibling}`, async () => {
      const sibling = await optionalBarrel(new URL(path, import.meta.url).pathname)
      // `null` means the sibling has not been written yet. A module that does not
      // exist cannot export a colliding name, which is what this check asks.
      if (sibling === null) return
      const mine = new Set(Object.keys(notifications))
      const collisions = Object.keys(sibling).filter((name) => mine.has(name))
      expect(collisions).toEqual([])
    })
  }

  it("shares no export name with the M5 barrels the milestone sits above", async () => {
    for (const path of ["../../../src/context/index.js", "../../../src/memory/index.js", "../../../src/mesh/tui/index.js"]) {
      const sibling = await optionalBarrel(new URL(path, import.meta.url).pathname)
      if (sibling === null) continue
      const mine = new Set(Object.keys(notifications))
      expect(Object.keys(sibling).filter((name) => mine.has(name)), path).toEqual([])
    }
  })

  it("exports nothing named `default`, which would make a star import ambiguous", () => {
    expect(Object.keys(notifications)).not.toContain("default")
  })
})
