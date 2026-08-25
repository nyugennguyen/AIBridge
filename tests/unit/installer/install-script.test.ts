import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const SCRIPT = new URL("../../../scripts/install.sh", import.meta.url)

describe("install.sh — file contract", () => {
  it("exists and starts with POSIX shebang + set -euo pipefail", async () => {
    const content = await readFile(SCRIPT, "utf8")
    expect(content.startsWith("#!/usr/bin/env bash")).toBe(true)
    expect(content).toContain("set -euo pipefail")
  })
})

describe("install.sh — platform detection", () => {
  it("detects darwin and maps to macos", async () => {
    const s = await readFile(SCRIPT, "utf8")
    expect(s).toContain('case "$(uname -s)" in')
    expect(s).toContain('Darwin*) OS="macos"')
    expect(s).toContain('Linux*)')
  })
  it("fails on unsupported platform (win32/freebsd) with error", async () => {
    const s = await readFile(SCRIPT, "utf8")
    expect(s).toContain("Unsupported platform")
    expect(s).toMatch(/exit 1/)
  })
  it("parses /etc/os-release for debian vs ubuntu", async () => {
    const s = await readFile(SCRIPT, "utf8")
    expect(s).toContain("/etc/os-release")
    expect(s).toContain("ID=")
  })
  it("never references win32 install commands", async () => {
    const s = await readFile(SCRIPT, "utf8")
    expect(s).not.toContain("choco")
    expect(s).not.toContain("winget")
  })
})
