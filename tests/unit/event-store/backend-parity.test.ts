import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { createSqliteDriver } from "../../../src/orchestration/event-store/sqlite-driver.js"
import type { Backend } from "./outbox-helpers.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "../../..")
const RUNNER = join(HERE, "backend-parity-runner.ts")
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx")

const BACKEND_LIST: Backend[] = ["node", "bun"]

export interface ParityVerdict {
  backend: string
  runtime: string
  total: number
  failed: number
  checks: { name: string, ok: boolean, detail?: string }[]
  ok: boolean
}

/** Whether the requested driver can be loaded inside *this* runtime. */
export function backendAvailable(backend: Backend): boolean {
  try {
    const driver = createSqliteDriver({ path: ":memory:", backend })
    driver.close()
    return true
  } catch {
    return false
  }
}

/**
 * `bun:sqlite` only exists under bun and `node:sqlite` only under node, so the
 * only way to prove parity from a single runner is to execute the battery in a
 * child process using the matching interpreter. Every `describe.each` case
 * therefore spawns its own child.
 */
function runParity(backend: Backend): ParityVerdict {
  const isBunRuntime = typeof (globalThis as any).Bun !== "undefined"
  const useBun = backend === "bun"

  let command: string
  let args: string[]
  if (useBun) {
    command = isBunRuntime ? process.execPath : "bun"
    args = [RUNNER, "bun"]
  } else {
    if (!existsSync(TSX_BIN)) {
      throw new Error(`Cannot run the ${backend} backend: ${TSX_BIN} is missing (run 'bun install')`)
    }
    command = TSX_BIN
    args = [RUNNER, "node"]
  }

  const output = execFileSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  return JSON.parse(output.trim().split("\n").at(-1)!) as ParityVerdict
}

describe("SQLite backend parity: bun:sqlite vs node:sqlite", () => {
  const verdicts = new Map<Backend, ParityVerdict>()
  const cache = new Map<Backend, ParityVerdict>()

  const verdictFor = (backend: Backend): ParityVerdict => {
    const cached = cache.get(backend)
    if (cached) return cached
    const fresh = runParity(backend)
    cache.set(backend, fresh)
    return fresh
  }

  describe.each(BACKEND_LIST)("backend %s", (backend: Backend) => {
    it(`runs the full parity battery on ${backend}`, () => {
      const verdict = verdictFor(backend)
      verdicts.set(backend, verdict)

      // Report every divergence, not just the first.
      const failures = verdict.checks
        .filter((c) => !c.ok)
        .map((c) => `${c.name}: ${c.detail}`)
        .join("\n")
      expect(failures).toBe("")
      expect(verdict.ok).toBe(true)
      expect(verdict.failed).toBe(0)
      expect(verdict.total).toBeGreaterThan(10)
    }, 120_000)

    it(`actually loaded the ${backend} driver`, () => {
      const verdict = verdictFor(backend)
      expect(verdict.backend).toBe(backend)
      // The child must have run on the interpreter that owns that driver.
      const expectedRuntime = backend === "bun" ? "bun" : "node"
      expect(verdict.runtime).toBe(expectedRuntime)
    }, 120_000)
  })

  it("both backends agree on every check name and outcome", () => {
    const collected = BACKEND_LIST.map((b) => [b, verdictFor(b)] as const)
    const [firstBackend, first] = collected[0]
    const [secondBackend, second] = collected[1]

    expect(firstBackend).not.toBe(secondBackend)
    expect(second.checks.map((c) => c.name)).toEqual(first.checks.map((c) => c.name))

    const divergences = first.checks
      .map((c, i) => ({ name: c.name, first: c.ok, second: second.checks[i].ok }))
      .filter((d) => d.first !== d.second)
      .map((d) => `${d.name}: ${firstBackend}=${d.first} ${secondBackend}=${d.second}`)
    expect(divergences.join("\n")).toBe("")
  }, 120_000)

  it("no backend reported a failed UPDATE/transaction/migration check", () => {
    for (const backend of BACKEND_LIST) {
      const verdict = verdictFor(backend)
      expect(
        verdict.checks.filter((c) => !c.ok).map((c) => c.name),
        `${backend} reported failures`
      ).toEqual([])
    }
  }, 120_000)
})
