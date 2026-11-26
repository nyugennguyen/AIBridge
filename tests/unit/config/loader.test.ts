import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { TERMINAL_KEY_IGNORED, loadConfig } from "../../../src/config/loader.js"

const EXAMPLE = new URL("../../../config/dev-main.example.json", import.meta.url).pathname
const dirs: string[] = []

function writeConfig(terminal?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "aibr-loader-"))
  dirs.push(dir)
  const base = JSON.parse(readFileSync(EXAMPLE, "utf8")) as Record<string, unknown>
  delete base.terminal
  if (terminal) base.terminal = terminal
  const path = join(dir, "config.json")
  writeFileSync(path, JSON.stringify(base))
  return path
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("loadConfig — removed terminal key (3.2.0)", () => {
  it("still loads a 3.1.x profile that has a terminal block, and warns once", async () => {
    for (const terminal of [{ backend: "herdr" }, { backend: "tmux" }]) {
      const warnings: string[] = []
      const config = await loadConfig(writeConfig(terminal), (m) => warnings.push(m))
      expect("terminal" in config).toBe(false)
      expect(warnings).toEqual([TERMINAL_KEY_IGNORED])
    }
  })

  it("says nothing for a profile without a terminal block", async () => {
    const warnings: string[] = []
    await loadConfig(writeConfig(), (m) => warnings.push(m))
    expect(warnings).toEqual([])
  })
})
