/**
 * The harness reads NO wall clock, NO timer and NO random source.
 *
 * This is a source-level guard rather than a behavioural one, and that is the
 * only way it can be a guard at all: `Date.now` inside a seam is invisible to
 * every assertion in the rest of this directory until the day it makes a
 * delivery depend on machine speed. The rule the harness states in
 * `src/mesh/fault/types.ts` — "a fault that fires roughly here is a fault a
 * reader cannot reproduce" — is only enforceable if the forbidden calls are
 * absent from the text, so this file reads the text.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const FAULT_DIRECTORY = join(process.cwd(), "src", "mesh", "fault")
const MESH_DIRECTORY = join(process.cwd(), "src", "mesh")

function sourcesIn(directory: string, prefix: string): { name: string; text: string }[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => ({ name: `${prefix}/${name}`, text: readFileSync(join(directory, name), "utf8") }))
}

const SOURCES = sourcesIn(FAULT_DIRECTORY, "fault").map((source) => ({
  name: source.name.split("/").pop() ?? source.name,
  text: source.text,
}))

/**
 * The WHOLE mesh tree, which is where the rule actually lives.
 *
 * The guard started over `src/mesh/fault/` because that is where determinism was
 * first needed, and the milestone-wide rule is wider than that: a gateway whose
 * retention is aged by `Date.now` is non-deterministic in exactly the way a fault
 * harness is, and it is reachable by an SSE client that disconnects at a
 * convenient moment. So the sweep covers every subdirectory of `src/mesh/`, read
 * recursively so a subdirectory added later is guarded without editing this file.
 */
function meshSources(): { name: string; text: string }[] {
  const found: { name: string; text: string }[] = []
  for (const entry of readdirSync(MESH_DIRECTORY, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...sourcesIn(join(MESH_DIRECTORY, entry.name), `mesh/${entry.name}`))
      continue
    }
    if (entry.name.endsWith(".ts")) {
      found.push({ name: `mesh/${entry.name}`, text: readFileSync(join(MESH_DIRECTORY, entry.name), "utf8") })
    }
  }
  return found.sort((left, right) => left.name.localeCompare(right.name))
}

const MESH_SOURCES = meshSources()

/**
 * Strip comments and string literals, so a prohibition on `Date.now` is not
 * tripped by this file's own prose about `Date.now` inside a module's doc block.
 *
 * Deliberately crude: a regex that removed a doc comment containing a forbidden
 * call would let the forbidden call be reintroduced behind a comment, and a
 * crude stripper that occasionally leaves a fragment is the safer direction to
 * fail in.
 */
function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
}

describe("the fault harness is deterministic at the source level", () => {
  it("reads the fault directory rather than a hand-written file list", () => {
    // A guard over a hard-coded list would stop guarding the moment a module
    // was added, which is how "declared and typed but never invoked" survives a
    // milestone.
    expect(SOURCES.map((source) => source.name)).toEqual(
      expect.arrayContaining([
        "boundary.ts",
        "controller.ts",
        "durable.ts",
        "harness.ts",
        "proxy.ts",
        "records.ts",
        "transport.ts",
        "types.ts",
        "worker.ts",
      ]),
    )
    expect(SOURCES.length).toBeGreaterThanOrEqual(9)
  })

  for (const forbidden of [
    { pattern: /\bDate\.now\s*\(/g, name: "Date.now" },
    { pattern: /\bnew\s+Date\s*\(\s*\)/g, name: "new Date() with no argument" },
    { pattern: /\bperformance\.now\s*\(/g, name: "performance.now" },
    { pattern: /\bMath\.random\s*\(/g, name: "Math.random" },
    { pattern: /\bsetTimeout\s*\(/g, name: "setTimeout" },
    { pattern: /\bsetInterval\s*\(/g, name: "setInterval" },
    { pattern: /\bsetImmediate\s*\(/g, name: "setImmediate" },
    { pattern: /\bqueueMicrotask\s*\(/g, name: "queueMicrotask" },
  ]) {
    it(`never calls ${forbidden.name}`, () => {
      const offenders = SOURCES.filter((source) => forbidden.pattern.test(codeOf(source.text))).map((source) => source.name)
      expect([forbidden.name, offenders]).toEqual([forbidden.name, []])
      // `RegExp.test` with a /g/ flag is stateful, so the pattern is rebuilt
      // after the sweep above; without this a second `it` would start at the
      // last index and find nothing.
      forbidden.pattern.lastIndex = 0
    })
  }

  it("reads time from the injected clock and nowhere else", () => {
    // `Date.parse` appears in exactly two places, and neither is a reading of
    // the wall clock: `harness.ts` parses the fixed T0 literal, and `records.ts`
    // parses a stamp a caller already supplied in order to DERIVE the next one.
    // Any third appearance would be a fixture inventing an instant.
    const parseSites = SOURCES.flatMap((source) => [...codeOf(source.text).matchAll(/\bDate\.parse\s*\(/g)].map(() => source.name))
    expect(parseSites).toEqual(["harness.ts", "records.ts"])
    expect(SOURCES.find((source) => source.name === "harness.ts")?.text).toContain('Date.parse("2026-09-28T00:00:00.000Z")')

    // `new Date` is only ever constructed FROM a number: an argument-less
    // construction is the forbidden case and the loop above already proved
    // there is none, so what is asserted here is that the argument is not a
    // string that could be a "now".
    const stringly = SOURCES.filter((source) => /new\s+Date\s*\(\s*["'`]/.test(codeOf(source.text))).map((source) => source.name)
    expect(stringly).toEqual([])

    // `ScriptedClock` is the only clock implementation, and the proxy is handed
    // a `FaultClock` rather than a clock class.
    const clockImplementations = SOURCES.filter((source) => /class\s+\w*Clock\b/.test(source.text)).map((source) => source.name)
    expect(clockImplementations).toEqual(["types.ts"])
  })

  it("never sleeps, and never asserts on how long anything took", () => {
    for (const source of SOURCES) {
      expect([source.name, /await\s+new\s+Promise/.test(codeOf(source.text))]).toEqual([source.name, false])
    }
  })
})

describe("the whole mesh tree is deterministic at the source level", () => {
  it("reads every mesh subdirectory rather than a hand-written list", () => {
    // A guard over a hard-coded list stops guarding the day a directory is
    // added, which is the same failure mode as the matrix that was declared and
    // never read: the guard looks present and protects nothing.
    const directories = MESH_SOURCES.map((source) => source.name.split("/")[1] ?? "")
    expect([...new Set(directories)].sort()).toEqual([
      "fault",
      "gateway",
      "identity",
      "inbox",
      "lease",
      "outbox",
      "protocol",
      "registry",
      "tui",
    ])
  })

  for (const forbidden of [
    { pattern: /\bDate\.now\s*\(/g, name: "Date.now" },
    { pattern: /\bMath\.random\s*\(/g, name: "Math.random" },
    { pattern: /\bsetTimeout\s*\(/g, name: "setTimeout" },
    { pattern: /\bsetInterval\s*\(/g, name: "setInterval" },
  ]) {
    it(`no mesh module calls ${forbidden.name}`, () => {
      const offenders = MESH_SOURCES.filter((source) => forbidden.pattern.test(codeOf(source.text))).map(
        (source) => source.name,
      )
      expect([forbidden.name, offenders]).toEqual([forbidden.name, []])
      forbidden.pattern.lastIndex = 0
    })
  }

  it("takes every clock reading as a parameter rather than reading one", () => {
    // `new Date(<number>)` is allowed — it converts a supplied instant — while a
    // `new Date()` is a reading. The distinction is the whole rule, so it is
    // asserted rather than left to the reader.
    const argumentless = MESH_SOURCES.filter((source) => /\bnew\s+Date\s*\(\s*\)/.test(codeOf(source.text))).map(
      (source) => source.name,
    )
    expect(argumentless).toEqual([])
    const stringly = MESH_SOURCES.filter((source) => /new\s+Date\s*\(\s*["'`]/.test(codeOf(source.text))).map(
      (source) => source.name,
    )
    expect(stringly).toEqual([])
  })
})
