import { describe, expect, it } from "vitest"
import {
  analyze,
  computeReachable,
  extractRelativeSpecifiers,
  isDeadlinePassed,
  resolveSpecifier,
  type Exemption,
} from "../../../scripts/docs/check-reachability.js"

const lines = (count: number): string => `${"x\n".repeat(count)}`

describe("extractRelativeSpecifiers", () => {
  it("finds import, export-from, side-effect and dynamic imports, and skips packages and comments", () => {
    const source = [
      `import { a } from "./a.js"`,
      `import type { B } from "../b.js"`,
      `export * from "./c.js"`,
      `export { d } from "./d.js"`,
      `import "./side.js"`,
      `const e = await import("./e.js")`,
      `import fs from "node:fs"`,
      `// import { z } from "./commented.js"`,
      `/* import { y } from "./block.js" */`,
    ].join("\n")
    expect(extractRelativeSpecifiers(source).sort()).toEqual(["../b.js", "./a.js", "./c.js", "./d.js", "./e.js", "./side.js"])
  })
})

describe("resolveSpecifier", () => {
  const files = new Set(["src/a/x.ts", "src/a/dir/index.ts", "src/b.ts"])
  it("maps .js to .ts and directories to index.ts", () => {
    expect(resolveSpecifier("src/a/y.ts", "./x.js", files)).toBe("src/a/x.ts")
    expect(resolveSpecifier("src/a/y.ts", "./dir/index.js", files)).toBe("src/a/dir/index.ts")
    expect(resolveSpecifier("src/a/y.ts", "../b.js", files)).toBe("src/b.ts")
    expect(resolveSpecifier("src/a/y.ts", "./missing.js", files)).toBeUndefined()
  })
})

describe("computeReachable", () => {
  it("follows chains and cycles and leaves leaves-of-nothing unreachable", () => {
    const sources = new Map([
      ["src/cli.ts", `import "./one.js"`],
      ["src/index.ts", `export * from "./two.js"`],
      ["src/one.ts", `import { t } from "./two.js"`],
      ["src/two.ts", `import "./one.js"`],
      ["src/dead/a.ts", `import "./b.js"`],
      ["src/dead/b.ts", ""],
    ])
    expect([...computeReachable(sources, ["src/cli.ts", "src/index.ts"])].sort()).toEqual(["src/cli.ts", "src/index.ts", "src/one.ts", "src/two.ts"])
  })
})

describe("isDeadlinePassed", () => {
  it("compares releases numerically", () => {
    expect(isDeadlinePassed("3.1.1", "3.3.0")).toBe(false)
    expect(isDeadlinePassed("3.3.0", "3.3.0")).toBe(true)
    expect(isDeadlinePassed("3.10.0", "3.3.0")).toBe(true)
  })
})

describe("analyze", () => {
  const sources = new Map<string, string>([
    ["src/cli.ts", `import "./live/a.js"\n`],
    ["src/live/a.ts", lines(10)],
    ["src/dead/big.ts", lines(600)],
    ["src/kept/small.ts", lines(100)],
    ["src/kept/exempt.ts", lines(700)],
  ])
  const exemption: Exemption = { path: "src/kept", reason: "r", wireDeadline: "3.3.0", deleteDeadline: "3.4.0", adr: "ADR 0016" }

  it("counts lines per directory and warns for non-exempt directories at 500 lines", () => {
    const result = analyze(sources, [exemption], "3.1.1")
    const byDir = Object.fromEntries(result.directories.map((d) => [d.directory, d]))
    expect(byDir["src/dead"]?.unreachableLines).toBe(600)
    expect(byDir["src/kept"]).toMatchObject({ unreachableLines: 800, exemptLines: 800, unexemptedLines: 0 })
    expect(byDir["src/live"]?.unreachableLines).toBe(0)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain("src/dead")
  })

  it("does not warn below the threshold", () => {
    const small = new Map(sources)
    small.set("src/dead/big.ts", lines(499))
    expect(analyze(small, [exemption], "3.1.1").warnings).toEqual([])
  })

  it("warns when an exemption is past its wire or delete deadline", () => {
    const wire = analyze(new Map(sources), [exemption], "3.3.0").warnings.filter((w) => w.startsWith("src/kept"))
    expect(wire).toHaveLength(1)
    expect(wire[0]).toContain("wire deadline 3.3.0 passed")
    const del = analyze(new Map(sources), [exemption], "3.4.0").warnings.filter((w) => w.startsWith("src/kept"))
    expect(del[0]).toContain("delete deadline 3.4.0 passed")
  })

  it("ignores an exemption whose code became reachable", () => {
    const wired = new Map(sources)
    wired.set("src/cli.ts", `import "./live/a.js"\nimport "./kept/small.js"\nimport "./kept/exempt.js"\n`)
    expect(analyze(wired, [exemption], "3.4.0").warnings.filter((w) => w.startsWith("src/kept"))).toEqual([])
  })
})
