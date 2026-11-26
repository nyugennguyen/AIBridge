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
    const directoryWarnings = result.warnings.filter((w) => w.includes("not exempt"))
    expect(directoryWarnings).toHaveLength(1)
    expect(directoryWarnings[0]).toContain("src/dead")
  })

  it("does not warn below the threshold", () => {
    const small = new Map(sources)
    small.set("src/dead/big.ts", lines(499))
    expect(analyze(small, [exemption], "3.1.1").warnings.filter((w) => w.includes("not exempt"))).toEqual([])
  })

  const keptWarnings = (r: { warnings: readonly string[] }) => r.warnings.filter((w) => w.startsWith("src/kept"))

  it("before the wire deadline an unreachable exemption only warns", () => {
    const result = analyze(new Map(sources), [exemption], "3.2.9")
    expect(result.failures).toEqual([])
    expect(keptWarnings(result)).toHaveLength(1)
    expect(keptWarnings(result)[0]).toContain("wire by 3.3.0")
  })

  it("past the wire deadline and still unreachable fails, naming the entry and the three choices", () => {
    const result = analyze(new Map(sources), [exemption], "3.3.0")
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toContain("src/kept")
    expect(result.failures[0]).toContain("wire it")
    expect(result.failures[0]).toContain("extend")
    expect(result.failures[0]).toContain("delete it")
  })

  it("past the wire deadline but now reachable is ok and reported as removable", () => {
    const wired = new Map(sources)
    wired.set("src/cli.ts", `import "./live/a.js"\nimport "./kept/small.js"\nimport "./kept/exempt.js"\n`)
    const result = analyze(wired, [exemption], "3.4.0")
    expect(result.failures).toEqual([])
    expect(keptWarnings(result)).toEqual([])
    expect(result.removable).toHaveLength(1)
    expect(result.removable[0]).toContain("src/kept")
  })
})
