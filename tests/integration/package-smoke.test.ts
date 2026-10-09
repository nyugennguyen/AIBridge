import { exec } from "node:child_process"
import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { promisify } from "node:util"
import { resolve } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"

import {
  SUPPORTED_PLATFORM_PACKAGES,
  findRouterBinary,
  findTuiBinary,
} from "../../src/host/binaries.js"

const execAsync = promisify(exec)

const ROOT = resolve(import.meta.dirname, "..", "..")

beforeAll(async () => {
  const result = await run("bun run build")
  if (result.exitCode !== 0) throw new Error(result.stderr)
}, 60_000)

it("builds the package before release smoke tests", async () => {
  const manifest = await readFile(resolve(ROOT, "package.json"), "utf8")

  expect(manifest).toContain('"release:check": "bun install --frozen-lockfile && bun run build && bun test')
})

/**
 * Run a command in the project root and return stdout.
 */
async function run(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execAsync(cmd, { cwd: ROOT, timeout: 60_000 })
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code ?? 1 }
  }
}

/**
 * Parse `bun pm pack --dry-run` output to extract the list of packed file paths.
 * Output may come from stdout or stderr depending on bun version.
 */
function parsePackFiles(stdout: string, stderr: string): string[] {
  const files: string[] = []
  const combined = stdout + "\n" + stderr
  for (const line of combined.split("\n")) {
    const match = line.match(/^packed\s+\S+\s+(.+)$/)
    if (match) {
      files.push(match[1]!.trim())
    }
  }
  return files
}

describe("package smoke — pack manifest", () => {
  it("includes LICENSE in the tarball", async () => {
    const { stdout, stderr } = await run("bun pm pack --dry-run")
    const files = parsePackFiles(stdout, stderr)

    expect(files).toContain("LICENSE")
  })

  it("includes README.md in the tarball", async () => {
    const { stdout, stderr } = await run("bun pm pack --dry-run")
    const files = parsePackFiles(stdout, stderr)

    expect(files).toContain("README.md")
  })

  it("includes dist/cli.js in the tarball", async () => {
    const { stdout, stderr } = await run("bun pm pack --dry-run")
    const files = parsePackFiles(stdout, stderr)

    expect(files).toContain("dist/cli.js")
  })

  it("includes package.json in the tarball", async () => {
    const { stdout, stderr } = await run("bun pm pack --dry-run")
    const files = parsePackFiles(stdout, stderr)

    expect(files).toContain("package.json")
  })

  it("does NOT include source TypeScript files", async () => {
    const { stdout, stderr } = await run("bun pm pack --dry-run")
    const files = parsePackFiles(stdout, stderr)
    const tsFiles = files.filter((f) => f.endsWith(".ts"))

    expect(tsFiles).toEqual([])
  })

  it("does NOT include test files", async () => {
    const { stdout, stderr } = await run("bun pm pack --dry-run")
    const files = parsePackFiles(stdout, stderr)
    const testFiles = files.filter((f) => f.includes("test") || f.includes("spec"))

    expect(testFiles).toEqual([])
  })

  it("does NOT include config example files", async () => {
    const { stdout, stderr } = await run("bun pm pack --dry-run")
    const files = parsePackFiles(stdout, stderr)
    const configFiles = files.filter((f) => f.startsWith("config/"))

    expect(configFiles).toEqual([])
  })

  it("does NOT include .omo directory", async () => {
    const { stdout, stderr } = await run("bun pm pack --dry-run")
    const files = parsePackFiles(stdout, stderr)
    const omoFiles = files.filter((f) => f.startsWith(".omo"))

    expect(omoFiles).toEqual([])
  })

  it("does NOT include scripts directory", async () => {
    const { stdout, stderr } = await run("bun pm pack --dry-run")
    const files = parsePackFiles(stdout, stderr)
    const scriptFiles = files.filter((f) => f.startsWith("scripts/"))

    expect(scriptFiles).toEqual([])
  })

  it("does NOT include node_modules", async () => {
    const { stdout, stderr } = await run("bun pm pack --dry-run")
    const files = parsePackFiles(stdout, stderr)
    const nodeModulesFiles = files.filter((f) => f.startsWith("node_modules"))

    expect(nodeModulesFiles).toEqual([])
  })

  it("does NOT include .git directory", async () => {
    const { stdout, stderr } = await run("bun pm pack --dry-run")
    const files = parsePackFiles(stdout, stderr)
    const gitFiles = files.filter((f) => f.startsWith(".git"))

    expect(gitFiles).toEqual([])
  })

  it("does NOT include bun.lock", async () => {
    const { stdout, stderr } = await run("bun pm pack --dry-run")
    const files = parsePackFiles(stdout, stderr)

    expect(files).not.toContain("bun.lock")
  })

  it("only includes dist/, bin/, README.md, LICENSE, and package.json", async () => {
    const { stdout, stderr } = await run("bun pm pack --dry-run")
    const files = parsePackFiles(stdout, stderr)

    for (const file of files) {
      const allowed =
        file === "package.json" ||
        file === "README.md" ||
        file === "LICENSE" ||
        file.startsWith("dist/") ||
        file.startsWith("bin/")
      if (!allowed) {
        throw new Error(`Unexpected file in pack: ${file}`)
      }
    }
  })

  it("includes prebuilt binaries in bin/ in the pack tarball", async () => {
    const { stdout, stderr } = await run("bun pm pack --dry-run")
    const files = parsePackFiles(stdout, stderr)

    expect(files).toContain("bin/aibr-tui")
    expect(files).toContain("bin/aibr-router")
  })

  // The regression this guards: the tarball shipped `bin/aibr-tui` as a native
  // build committed to git. Because one tarball is downloaded by every platform,
  // Linux installs received the darwin-arm64 binary and `aibr tui` died with
  // ENOEXEC. Asserting the file EXISTS is what let that pass CI -- the file was
  // there, it was just the wrong architecture. `bin/` must therefore hold only
  // the launcher shims, and the real binaries must come from the per-platform
  // optionalDependencies.
  it("ships no native machine-code binary in bin/", async () => {
    const { stdout, stderr } = await run("bun pm pack --dry-run")
    const files = parsePackFiles(stdout, stderr)

    for (const file of files.filter((f) => f.startsWith("bin/"))) {
      const bytes = readFileSync(resolve(ROOT, file))
      // A shebang means it is a script. Anything without one in `bin/` would be
      // a compiled artefact, which is exactly what must not be committed here.
      expect(
        bytes[0] === 0x23 && bytes[1] === 0x21,
        `${file} is a compiled binary, not a launcher shim. Native binaries must ` +
          `ship as per-platform optionalDependencies (see scripts/package-binaries.ts), ` +
          `because a single committed build reaches every platform.`,
      ).toBe(true)
    }
  })

  it("declares an optionalDependencies entry for every supported platform", () => {
    const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"))
    const optional = manifest.optionalDependencies ?? {}

    for (const pkg of SUPPORTED_PLATFORM_PACKAGES) {
      expect(
        optional[pkg],
        `${pkg} is missing from optionalDependencies; installs on that platform ` +
          `would resolve the launcher shim with no binary behind it.`,
      ).toBeDefined()
      expect(optional[pkg]).toBe(manifest.version)
    }
  })
})

describe("package smoke — CLI", () => {
  it("built cli.js --help exits 0 and shows commands", async () => {
    const { stdout, exitCode } = await run("bun dist/cli.js --help")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("setup")
    expect(stdout).toContain("start")
    expect(stdout).toContain("serve")
    expect(stdout).toContain("status")
  })

  it("built cli.js --version matches manifest", async () => {
    const manifest = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"))
    const { stdout, exitCode } = await run("bun dist/cli.js --version")

    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe(manifest.version)
  })

  it("built cli.js --help does NOT show _opencode", async () => {
    const { stdout } = await run("bun dist/cli.js --help")

    expect(stdout).not.toContain("_opencode")
  })

  it("built cli.js with no args exits nonzero", async () => {
    const { exitCode } = await run("bun dist/cli.js")

    expect(exitCode).not.toBe(0)
  })

  it("built cli.js with unknown command exits nonzero", async () => {
    const { exitCode, stdout } = await run("bun dist/cli.js bogus")

    expect(exitCode).not.toBe(0)
    expect(stdout).toContain("unknown")
  })
})

describe("package smoke — manifest contract", () => {
  it("manifest declares correct scoped name", async () => {
    const manifest = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"))

    expect(manifest.name).toBe("@nyugennguyen/aibridge")
  })

  it("manifest is not private", async () => {
    const manifest = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"))

    expect(manifest.private).toBeFalsy()
  })

  it("manifest declares MIT license", async () => {
    const manifest = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"))

    expect(manifest.license).toBe("MIT")
  })

  it("manifest declares aibr bin targets", async () => {
    const manifest = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"))

    expect(manifest.bin?.aibr).toBe("./dist/cli.js")
    expect(manifest.bin?.["aibr-tui"]).toBe("./bin/aibr-tui")
    expect(manifest.bin?.["aibr-router"]).toBe("./bin/aibr-router")
  })

  it("manifest declares exact dependency versions (no ranges)", async () => {
    const manifest = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"))
    const deps = manifest.dependencies ?? {}

    for (const [name, version] of Object.entries(deps)) {
      expect(version).not.toMatch(/^\^|^\~|^>=|^>/)
    }
  })

  it("manifest has release:check script", async () => {
    const manifest = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"))

    expect(manifest.scripts?.["release:check"]).toBeDefined()
    expect(typeof manifest.scripts["release:check"]).toBe("string")
  })

})

describe("package smoke — native binaries discovery", () => {
  it("findTuiBinary resolves to a path ending in aibr-tui or null when unbuilt", () => {
    const tuiPath = findTuiBinary()
    if (tuiPath !== null) {
      expect(typeof tuiPath).toBe("string")
      expect(tuiPath).toMatch(/aibr-tui$/)
    } else {
      expect(tuiPath).toBeNull()
    }
  })

  it("findRouterBinary resolves to a path ending in aibr-router or null when unbuilt", () => {
    const routerPath = findRouterBinary()
    if (routerPath !== null) {
      expect(typeof routerPath).toBe("string")
      expect(routerPath).toMatch(/aibr-router$/)
    } else {
      expect(routerPath).toBeNull()
    }
  })

  it("resolves binary when override environment variable is provided", () => {
    const sampleBin = resolve(ROOT, "scripts", "install.sh")
    expect(findTuiBinary({ AIBRIDGE_TUI_BIN: sampleBin })).toBe(sampleBin)
    expect(findRouterBinary({ AIBRIDGE_ROUTER_BIN: sampleBin })).toBe(sampleBin)
  })
})
