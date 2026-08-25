import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const README = new URL("../../../README.md", import.meta.url)

describe("README — curl|bash installer", () => {
  it("documents curl|bash one-liner as primary install", async () => {
    const readme = await readFile(README, "utf8")
    expect(readme).toContain(
      "curl -fsSL https://raw.githubusercontent.com/nyugennguyen/AIBridge/main/scripts/install.sh | bash",
    )
  })
  it("documents --yes flag for non-interactive install", async () => {
    const readme = await readFile(README, "utf8")
    expect(readme).toContain("--yes")
  })
  it("keeps manual bun install -g as fallback", async () => {
    const readme = await readFile(README, "utf8")
    expect(readme).toContain("bun install -g @nyugennguyen/aibridge")
  })
})
