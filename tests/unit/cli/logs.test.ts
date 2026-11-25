import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { LOGS_HELP, parseLogsArgs, runLogsCommand } from "../../../src/cli/logs.js"

const homes: string[] = []
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "aibr-logs-cli-"))
  homes.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeLog(homeDir: string, profile: string, content: string): string {
  const dir = join(homeDir, ".local", "state", "aibridge", profile, "logs")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "aibridge.log")
  writeFileSync(path, content)
  return path
}

async function run(argv: string[], env: Record<string, string | undefined>) {
  const out: string[] = []
  const code = await runLogsCommand(argv, { env, write: (t) => out.push(t) })
  return { code, text: out.join("") }
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n"

describe("aibr logs", () => {
  it("says there is no log yet and how to start the bridge", async () => {
    const h = home()
    const { code, text } = await run(["--profile", "dev"], { HOME: h })
    expect(code).toBe(1)
    expect(text).toContain('No log yet for profile "dev"')
    expect(text).toContain("aibr start --profile dev")
  })

  it("prints the last 100 lines by default", async () => {
    const h = home()
    writeLog(h, "dev", lines(150))
    const { code, text } = await run(["-p", "dev"], { HOME: h })
    expect(code).toBe(0)
    const printed = text.trimEnd().split("\n")
    expect(printed).toHaveLength(100)
    expect(printed[0]).toBe("line 51")
    expect(printed.at(-1)).toBe("line 150")
  })

  it("honours -n / --lines", async () => {
    const h = home()
    writeLog(h, "dev", lines(10))
    expect((await run(["--profile", "dev", "-n", "3"], { HOME: h })).text).toBe("line 8\nline 9\nline 10\n")
    expect((await run(["--profile", "dev", "--lines", "0"], { HOME: h })).text).toBe("")
  })

  it("takes the profile from AIBR_PROFILE, then default", async () => {
    const h = home()
    writeLog(h, "staging", "from staging\n")
    writeLog(h, "default", "from default\n")
    expect((await run([], { HOME: h, AIBR_PROFILE: "staging" })).text).toBe("from staging\n")
    expect((await run([], { HOME: h })).text).toBe("from default\n")
  })

  it("rejects bad arguments with 64", async () => {
    const h = home()
    for (const argv of [["--bogus"], ["-n"], ["-n", "x"], ["-n", "-1"], ["--profile"], ["extra"]]) {
      const { code, text } = await run(argv, { HOME: h })
      expect(code).toBe(64)
      expect(text).toMatch(/^Error: /)
    }
    const bad = await run(["--profile", "../etc"], { HOME: h })
    expect(bad.code).toBe(64)
    expect(bad.text).toContain("Invalid profile name")
  })

  it("prints help", async () => {
    const { code, text } = await run(["--help"], { HOME: home() })
    expect(code).toBe(0)
    expect(text).toBe(LOGS_HELP)
  })

  it("follows: prints the tail, then appended lines, until interrupted", async () => {
    const h = home()
    const path = writeLog(h, "dev", "a\n")
    const out: string[] = []
    let release: () => void = () => undefined
    const interrupted = new Promise<void>((resolve) => {
      release = resolve
    })
    let sleeps = 0
    const code = await runLogsCommand(["--profile", "dev", "-f"], {
      env: { HOME: h },
      write: (t) => out.push(t),
      interrupted: () => interrupted,
      sleep: async () => {
        sleeps += 1
        if (sleeps === 1) writeFileSync(path, "a\nb\n")
        if (sleeps === 2) release()
        await Promise.resolve()
      },
    })
    expect(code).toBe(0)
    expect(out.join("")).toBe("a\nb\n")
  })

  it("parses flags", () => {
    expect(parseLogsArgs(["-f", "-n", "5", "-p", "x"])).toEqual({ profile: "x", follow: true, lines: 5, help: false })
    expect(parseLogsArgs([])).toEqual({ follow: false, lines: 100, help: false })
  })
})
