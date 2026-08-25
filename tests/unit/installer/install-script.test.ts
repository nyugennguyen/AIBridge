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

describe("install.sh — prereq checks", () => {
  it("defines fixed argv install commands per OS (no curl|sh)", async () => {
    const s = await readFile(SCRIPT, "utf8")
    expect(s).toContain("brew install tmux")
    expect(s).toContain("brew install tailscale")
    expect(s).toContain("apt-get install -y tmux")
    // Table itself must not use curl pipes; bun bootstrap is allowed elsewhere
    const start = s.indexOf("install_cmd_for")
    const end = s.indexOf("check_prereqs")
    const table = start !== -1 && end !== -1 ? s.slice(start, end) : s
    expect(table).not.toMatch(/curl.*\|.*sh/)
    expect(table).not.toMatch(/curl.*\|.*bash/)
  })
  it("checks for tmux/opencode/tailscale via 'command -v' or 'which'", async () => {
    const s = await readFile(SCRIPT, "utf8")
    expect(s).toMatch(/command -v|which tmux/)
    expect(s).toContain("tmux")
    expect(s).toContain("opencode")
    expect(s).toContain("tailscale")
  })
  it("marks opencode as missing without auto-install (manual instruction)", async () => {
    const s = await readFile(SCRIPT, "utf8")
    expect(s).toMatch(/opencode.*manual|opencode.*bun install -g opencode-ai/i)
  })
})

describe("install.sh — bun and package install", () => {
  it("checks bun version >=1.3.0 and handles missing bun", async () => {
    const s = await readFile(SCRIPT, "utf8")
    expect(s).toContain("bun --version")
    expect(s).toContain("1.3.0")
    expect(s).toMatch(/curl.*bun\.sh.*install|https:\/\/bun\.sh\/install/i)
  })
  it("installs aibridge via bun global install", async () => {
    const s = await readFile(SCRIPT, "utf8")
    expect(s).toContain("bun install -g @nyugennguyen/aibridge")
  })
  it("supports AIBRIDGE_VERSION env override", async () => {
    const s = await readFile(SCRIPT, "utf8")
    expect(s).toContain("AIBRIDGE_VERSION")
  })
  it("verifies aibr is on PATH and advises bun pm bin -g", async () => {
    const s = await readFile(SCRIPT, "utf8")
    expect(s).toContain("bun pm bin -g")
    expect(s).toContain("aibr --version")
  })
  it("uses set -euo pipefail and no sudo by default (user confirms)", async () => {
    const s = await readFile(SCRIPT, "utf8")
    expect(s).toContain("set -euo pipefail")
    expect(s).not.toMatch(/^\s*sudo apt-get/m)
  })
})

describe("install.sh — confirmation gating", () => {
  it("prompts before brew/apt installs and respects --yes", async () => {
    const s = await readFile(SCRIPT, "utf8")
    expect(s).toContain("--yes")
    expect(s).toMatch(/read.*install.*tmux|prompt.*confirm/i)
    expect(s).toContain("Install tmux?")
  })
  it("supports --help and --version flags", async () => {
    const s = await readFile(SCRIPT, "utf8")
    expect(s).toContain("--help")
    expect(s).toContain("--version")
  })
  it("never auto-sudos without confirmation", async () => {
    const s = await readFile(SCRIPT, "utf8")
    const sudoLines = s.split("\n").filter((l) => l.includes("sudo"))
    expect(sudoLines.length).toBeGreaterThan(0)
    expect(s.indexOf("confirm") < s.indexOf("sudo")).toBe(true)
  })
})
