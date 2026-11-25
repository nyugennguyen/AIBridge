import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { CLI_VERSION } from "../../../src/version.js"

const root = resolve(import.meta.dirname, "../../..")
const read = (p: string) => readFileSync(resolve(root, p), "utf8")
const json = (p: string) => JSON.parse(read(p)) as Record<string, any>

describe("claude plugin static contract", () => {
  const pkg = json("package.json")
  const plugin = json("plugins/aibridge/.claude-plugin/plugin.json")
  const marketplace = json(".claude-plugin/marketplace.json")

  it("plugin.json has the required shape", () => {
    expect(plugin.name).toBe("aibridge")
    expect(typeof plugin.description).toBe("string")
    expect(plugin.userConfig.profile).toMatchObject({ type: "string", sensitive: false })
  })

  it("versions equal package.json (and src/version.ts)", () => {
    expect(plugin.version).toBe(pkg.version)
    expect(marketplace.plugins[0].version).toBe(pkg.version)
    expect(CLI_VERSION).toBe(pkg.version)
  })

  it("marketplace.json points at the bundled plugin with a ./ relative source", () => {
    expect(marketplace.name).toBe("aibridge")
    expect(marketplace.owner.name).toBeTruthy()
    expect(marketplace.plugins[0]).toMatchObject({ name: "aibridge", source: "./plugins/aibridge" })
    expect(marketplace.plugins[0].source.startsWith("./")).toBe(true)
  })

  it(".mcp.json launches aibr mcp serve and contains no secrets", () => {
    const raw = read("plugins/aibridge/.mcp.json")
    const mcp = JSON.parse(raw)
    expect(mcp.mcpServers.aibridge.command).toBe("aibr")
    expect(mcp.mcpServers.aibridge.args).toEqual(["mcp", "serve", "--profile", "${user_config.profile}"])
    expect(mcp.mcpServers.aibridge.env).toBeUndefined()
    expect(raw).not.toMatch(/token|secret|password|bearer/i)
  })

  it("hooks use an explicit short timeout", () => {
    const hooks = json("plugins/aibridge/hooks/hooks.json").hooks
    const entries = Object.values(hooks).flat() as { hooks: { timeout?: number; command: string }[] }[]
    const all = entries.flatMap((e) => e.hooks)
    expect(all.length).toBeGreaterThan(0)
    for (const hook of all) {
      expect(hook.timeout).toBeGreaterThan(0)
      expect(hook.timeout).toBeLessThanOrEqual(10)
      expect(hook.command).toContain("aibr mcp summary")
    }
  })

  it("skill and commands have front matter; the skill forbids retrying approval_required", () => {
    const skill = read("plugins/aibridge/skills/aibridge-dispatch/SKILL.md")
    expect(skill.startsWith("---\nname: aibridge-dispatch\n")).toBe(true)
    expect(skill).toMatch(/approval_required/)
    expect(skill).toMatch(/bridge_await/)
    for (const file of ["bridge-send", "bridge-status"]) {
      expect(read(`plugins/aibridge/commands/${file}.md`).startsWith("---\n")).toBe(true)
    }
  })

  it("npm tarball ships the plugin and marketplace", () => {
    expect(pkg.files).toContain("plugins")
    expect(pkg.files).toContain(".claude-plugin")
  })
})
