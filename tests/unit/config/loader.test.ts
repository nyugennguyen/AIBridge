import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { HERDR_BACKEND_DEPRECATION, loadConfig } from "../../../src/config/loader.js"

const EXAMPLE = new URL("../../../config/dev-main.example.json", import.meta.url).pathname
const dirs: string[] = []

function writeConfig(terminal?: { backend: string }): string {
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

describe("loadConfig — deprecated terminal.backend \"herdr\" (3.1.1)", () => {
  it("still loads a profile written with the Herdr backend, and warns once", async () => {
    const warnings: string[] = []
    const config = await loadConfig(writeConfig({ backend: "herdr" }), (m) => warnings.push(m))
    expect(config.terminal.backend).toBe("herdr")
    expect(warnings).toEqual([HERDR_BACKEND_DEPRECATION])
  })

  it("says nothing for tmux or an absent terminal block", async () => {
    const warnings: string[] = []
    await loadConfig(writeConfig({ backend: "tmux" }), (m) => warnings.push(m))
    await loadConfig(writeConfig(), (m) => warnings.push(m))
    expect(warnings).toEqual([])
  })
})
