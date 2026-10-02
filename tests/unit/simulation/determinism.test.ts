/**
 * M6.7 — determinism.
 *
 * # What this file is FOR
 *
 * One property, tested three ways, because each way fails differently:
 *
 *   1. **Byte-identical output.** Fifty invocations over the same snapshots and the
 *      same proposed workflow, with the snapshot ARRAYS SHUFFLED between runs.
 *      Shuffling is the part that matters: a plan whose order depended on input
 *      order would be stable across identical inputs and unstable across two
 *      orderings of the same facts, and only the second is a bug anyone notices.
 *   2. **A stable digest.** The plan's digest is equal across all fifty, and
 *      recomputable with the function that produced it.
 *   3. **No ambient input.** `Date.now` and `Math.random` do not appear anywhere in
 *      `src/simulation/`, by source scan. This is the one assertion here that is a
 *      scan rather than a count, and the reason is that a behavioural test cannot
 *      observe a clock that happens to return the same value twice: fifty identical
 *      plans would be consistent with a plan that read the clock if the clock did not
 *      advance. The scan closes that hole; the counts close the rest.
 *
 * # Why the shuffle is deterministic
 *
 * The shuffle is a seeded linear congruential generator, never `Math.random`. A
 * shuffle whose seed changes per run reports a different input order each time,
 * which is right for a fuzzer and wrong for a determinism test: a failure that
 * cannot be reproduced is a failure nobody can fix. This is the same discipline
 * `tests/unit/rules/fixtures.ts` documents for its own generator.
 */

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { computeDryRunPlanDigest, simulateDryRun } from "../../../src/simulation/index.js"
import { aBudgetDocument, aDenyDocument, aPreApprovalDocument, aRoutingDocument, aRequest, compiledFrom, simulatedPorts } from "./fixtures.js"

const REPOSITORY_ROOT = join(import.meta.dirname, "../../..")
const SIMULATION_DIRECTORY = join(REPOSITORY_ROOT, "src/simulation")

/**
 * A deterministic shuffle.
 *
 * Fisher–Yates driven by a linear congruential generator, so run N always shuffles
 * the same way. Returns a NEW array; the input is never mutated, because a fixture
 * that a test mutated would make the SECOND run the odd one out and the failure
 * would look like a determinism bug in the simulator.
 */
function shuffled<T>(values: readonly T[], seed: number): T[] {
  let state = seed >>> 0
  const next = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 4_294_967_296
  }
  const copy = [...values]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1))
    const left = copy[index]!
    copy[index] = copy[swap]!
    copy[swap] = left
  }
  return copy
}

function simulationSources(): readonly { path: string; text: string }[] {
  return readdirSync(SIMULATION_DIRECTORY, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => {
      const path = join(entry.parentPath ?? SIMULATION_DIRECTORY, entry.name)
      return { path, text: codeOnly(readFileSync(path, "utf8")) }
    })
}

/**
 * The file with its comments removed.
 *
 * Same discipline as `importsOf` in `tests/unit/context/barrel.test.ts:40`: a
 * source scan that cannot tell a comment from code fails on a docblock that
 * NAMES the thing it forbids, which is exactly how these modules are written — the
 * invariant "never `Date.now()`" has to be written down somewhere. Stripping
 * comments first is what makes the scan measure behaviour rather than prose.
 */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[^\S\n]*\/\/[^\n]*$/gm, " ")
}

/** The request, with the registry, role and manifest arrays in the given order. */
function requestWithArrays(seed: number): Record<string, unknown> {
  const base = aRequest({ rules: compiledFrom(aBudgetDocument(), aRoutingDocument()) })
  const registry = base.registry as { nodes: unknown[] }
  const roles = base.roles as unknown[]
  const memory = base.memory as { manifests: unknown[] }
  return {
    ...base,
    registry: { nodes: shuffled(registry.nodes, seed) },
    roles: shuffled(roles, seed + 1),
    memory: { ...memory, manifests: shuffled(memory.manifests, seed + 2) },
  }
}

describe("the same snapshots and the same proposed workflow produce the same plan", () => {
  it("fifty invocations produce byte-identical plans and one digest, with the snapshot arrays shuffled between runs", async () => {
    const first = await simulateDryRun(requestWithArrays(1), simulatedPorts())
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const reference = JSON.stringify(first.value)
    const digests = new Set<string>([first.value.digest])

    for (let run = 2; run <= 50; run += 1) {
      const result = await simulateDryRun(requestWithArrays(run), simulatedPorts())
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // Byte-identical, not merely deep-equal: a member the plan emits with a
      // different KEY ORDER would satisfy `toEqual` and break a digest comparison,
      // and key order is exactly what a shuffled input is most likely to perturb.
      expect(JSON.stringify(result.value)).toBe(reference)
      expect(result.value.digest).toBe(first.value.digest)
      expect(result.value.lines).toEqual(first.value.lines)
      digests.add(result.value.digest)
    }
    expect(digests.size).toBe(1)
    expect(computeDryRunPlanDigest(first.value)).toBe(first.value.digest)
  })

  it("the same request over the SAME array order is identical too, so the shuffle is what is being tested", async () => {
    const request = aRequest({ rules: compiledFrom(aDenyDocument()) })
    const first = await simulateDryRun(request, simulatedPorts())
    const second = await simulateDryRun(request, simulatedPorts())
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(JSON.stringify(second.value)).toBe(JSON.stringify(first.value))
  })

  it("two plans differing only in the injected clock differ, so the clock is genuinely the input", async () => {
    const earlier = await simulateDryRun(aRequest({ now: "2026-05-04T09:00:00Z" }), simulatedPorts())
    const later = await simulateDryRun(aRequest({ now: "2026-05-04T10:00:00Z" }), simulatedPorts())
    expect(earlier.ok && later.ok).toBe(true)
    if (!earlier.ok || !later.ok) return
    expect(later.value.digest).not.toBe(earlier.value.digest)
    expect(later.value.generatedAt).toBe("2026-05-04T10:00:00Z")
  })

  it("a plan over a rule set with a pre-approval is stable too, disclosures and all", async () => {
    const rules = compiledFrom(aPreApprovalDocument())
    const digests = new Set<string>()
    for (let run = 1; run <= 10; run += 1) {
      const result = await simulateDryRun(aRequest({ rules, now: "2026-05-04T09:00:00Z" }), simulatedPorts())
      expect(result.ok).toBe(true)
      if (!result.ok) return
      digests.add(result.value.digest)
    }
    expect(digests.size).toBe(1)
  })

  it("a refused plan is stable too, down to the refusal message", async () => {
    const request = { ...aRequest(), surprise: true }
    const first = await simulateDryRun(request, simulatedPorts())
    const second = await simulateDryRun(request, simulatedPorts())
    expect(first.ok).toBe(false)
    expect(second.ok).toBe(false)
    if (first.ok || second.ok) return
    expect(JSON.stringify(second.refusal)).toBe(JSON.stringify(first.refusal))
  })

  it("the derived ids do not vary between invocations, because nothing counts them", async () => {
    const first = await simulateDryRun(aRequest(), simulatedPorts())
    const second = await simulateDryRun(aRequest(), simulatedPorts())
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.value.dispatches.map((dispatch) => dispatch.task.dispatchId)).toEqual(
      first.value.dispatches.map((dispatch) => dispatch.task.dispatchId),
    )
    expect(first.value.dispatches.map((dispatch) => dispatch.task.dispatchId)).toEqual(["disp:build", "disp:ship"])
  })
})

describe("no ambient input reaches the plan", () => {
  it("no file under `src/simulation/` calls `Date.now`", () => {
    const offenders = simulationSources()
      .filter((file) => /Date\.now\s*\(/.test(file.text))
      .map((file) => file.path)
    expect(offenders).toEqual([])
  })

  it("no file under `src/simulation/` calls `Math.random`", () => {
    const offenders = simulationSources()
      .filter((file) => /Math\.random\s*\(/.test(file.text))
      .map((file) => file.path)
    expect(offenders).toEqual([])
  })

  it("no file under `src/simulation/` imports `node:` or reaches the filesystem, the network or a process", () => {
    // The module is pure by construction, and the three edges a dry run must not
    // have are named explicitly because each is the mechanism by which a simulator
    // becomes a real run: a clock, a socket, a shell.
    //
    // `fetch` is matched as a CALL (`await fetch(` / `globalThis.fetch`) rather than
    // as a bare identifier, because `./sinks.ts` deliberately declares a `fetch`
    // METHOD on the network sink — the interface that makes the fake possible — and a
    // scan that could not tell a method declaration from a call would fail on the very
    // code this milestone is built out of.
    const forbidden = [
      /from\s+"node:/,
      /require\s*\(\s*["']node:/,
      /from\s+["']fs["']/,
      /from\s+["']node:fs["']/,
      /\bawait\s+fetch\s*\(/,
      /globalThis\.fetch/,
      /child_process/,
      /\bnew\s+Date\s*\(\s*\)/,
    ]
    const offenders: string[] = []
    for (const file of simulationSources()) {
      for (const pattern of forbidden) {
        if (pattern.test(file.text)) offenders.push(`${file.path}: ${String(pattern)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("the only clock in the module is the injected one, and it is the only `Date` arithmetic", () => {
    // `Date.parse` of an injected timestamp is arithmetic, not a reading; a bare
    // `new Date()` would be a reading. The scan allows the first and refuses the
    // second, and the test above already refuses `new Date()`.
    const arithmetic = simulationSources()
      .flatMap((file) => [...file.text.matchAll(/Date\.\w+/g)].map((match) => `${file.path}: ${match[0]}`))
      .filter((entry) => !entry.endsWith("Date.parse"))
    expect(arithmetic).toEqual([])
  })
})
