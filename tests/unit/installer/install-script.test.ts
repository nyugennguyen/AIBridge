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
