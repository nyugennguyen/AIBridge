import { describe, expect, it } from "vitest"
import { runCli, type CliDeps } from "../../../src/cli.js"

function deps(overrides: Partial<CliDeps> = {}): { deps: CliDeps; text: () => string; calls: string[] } {
  const out: string[] = []
  const calls: string[] = []
  const base: CliDeps = {
    writer: (s) => void out.push(s),
    isTTY: false,
    isInputTTY: false,
    runSetup: async () => {
      throw new Error("runSetup not expected")
    },
    startProfile: async (profile) => {
      calls.push(`startProfile:${profile}`)
      return { kind: "started", sessionName: `aibridge-${profile}` }
    },
    startService: async (profile) => {
      calls.push(`startService:${profile}`)
      return 0
    },
    serveBridge: async (profile, options) => {
      calls.push(`serve:${profile}:${JSON.stringify(options)}`)
    },
    runWorker: async () => undefined,
    statusProfile: async () => ({ kind: "healthy", sessionName: "aibridge-p", body: "{}" }),
    runOpencode: async () => undefined,
    version: "9.9.9",
    ...overrides,
  }
  return { deps: base, text: () => out.join(""), calls }
}

describe("quickstart command routing", () => {
  for (const command of ["init", "doctor", "ping", "send", "logs"] as const) {
    it(`${command} dispatches the remaining argv and passes the exit code through`, async () => {
      const seen: Array<readonly string[]> = []
      const handler = async (args: readonly string[]): Promise<number> => {
        seen.push(args)
        return command === "ping" ? 1 : 0
      }
      const key = { init: "runInit", doctor: "runDoctor", ping: "runPing", send: "runSend", logs: "runLogs" }[command]
      const h = deps({ [key]: handler } as Partial<CliDeps>)
      const code = await runCli([command, "peer", "--profile", "dev", "--json"], h.deps)
      expect(seen).toEqual([["peer", "--profile", "dev", "--json"]])
      expect(code).toBe(command === "ping" ? 1 : 0)
    })
  }

  it("a throwing handler prints the error and exits 1", async () => {
    const h = deps({
      runDoctor: async () => {
        throw new Error("doctor exploded")
      },
    })
    expect(await runCli(["doctor"], h.deps)).toBe(1)
    expect(h.text()).toBe("Error: doctor exploded\n")
  })

  it("an out-of-range exit code becomes 1", async () => {
    const h = deps({ runLogs: async () => 42 })
    expect(await runCli(["logs"], h.deps)).toBe(1)
  })
})

describe("start", () => {
  it("starts the user service by default", async () => {
    const h = deps()
    expect(await runCli(["start", "--profile", "p"], h.deps)).toBe(0)
    expect(h.calls).toEqual(["startService:p"])
  })

  it("passes a failing service start through", async () => {
    const h = deps({ startService: async () => 1 })
    expect(await runCli(["start", "--profile", "p"], h.deps)).toBe(1)
  })

  for (const flag of ["--foreground", "--tmux"]) {
    it(`${flag} runs the tmux session and prints how to attach`, async () => {
      const h = deps()
      expect(await runCli(["start", "--profile", "p", flag], h.deps)).toBe(0)
      expect(h.calls).toEqual(["startProfile:p"])
      expect(h.text()).toContain("Started tmux session: aibridge-p")
      expect(h.text()).toContain("Attach: tmux attach -t aibridge-p")
      expect(h.text()).toContain("aibr logs --profile p")
    })
  }

  it("--foreground is refused on other commands", async () => {
    const h = deps()
    expect(await runCli(["status", "--profile", "p", "--foreground"], h.deps)).toBe(1)
    expect(h.text()).toBe("Error: --foreground is only supported by start\n")
  })
})

describe("serve", () => {
  it("--with-opencode reaches serveBridge", async () => {
    const h = deps()
    expect(await runCli(["serve", "--profile", "p", "--with-opencode"], h.deps)).toBe(0)
    expect(h.calls).toEqual([`serve:p:${JSON.stringify({ shadowMode: false, withOpencode: true })}`])
  })

  it("serve without it does not set withOpencode", async () => {
    const h = deps()
    await runCli(["serve", "--profile", "p"], h.deps)
    expect(h.calls).toEqual([`serve:p:${JSON.stringify({ shadowMode: false })}`])
  })

  it("--with-opencode is refused on other commands", async () => {
    const h = deps()
    expect(await runCli(["start", "--profile", "p", "--with-opencode"], h.deps)).toBe(1)
    expect(h.text()).toBe("Error: --with-opencode is only supported by serve\n")
  })
})

describe("status", () => {
  it("not_running exits 1 and prints the hint", async () => {
    const h = deps({ statusProfile: async () => ({ kind: "not_running", sessionName: "aibridge-p", hint: "start it with: aibr start --profile p" }) })
    expect(await runCli(["status", "--profile", "p"], h.deps)).toBe(1)
    expect(h.text()).toBe("not_running: p\n  start it with: aibr start --profile p\n")
  })

  it("no_bridge exits 0", async () => {
    const h = deps({ statusProfile: async () => ({ kind: "no_bridge", sessionName: "aibridge-p", hint: "orchestrator" }) })
    expect(await runCli(["status", "--profile", "p"], h.deps)).toBe(0)
    expect(h.text()).toContain("no_bridge: p")
  })

  it("healthy names what runs the bridge", async () => {
    const h = deps({ statusProfile: async () => ({ kind: "healthy", sessionName: "launchd:p", runner: "launchd", body: "summary" }) })
    expect(await runCli(["status", "--profile", "p"], h.deps)).toBe(0)
    expect(h.text()).toBe("healthy: launchd:p (launchd)\nsummary\n")
  })

  it("bridge_unavailable exits 1 with the runner and hint", async () => {
    const h = deps({
      statusProfile: async () => ({ kind: "bridge_unavailable", sessionName: "aibridge-p", runner: "tmux", probeStatus: 0, hint: "see logs" }),
    })
    expect(await runCli(["status", "--profile", "p"], h.deps)).toBe(1)
    expect(h.text()).toBe("bridge_unavailable: aibridge-p (tmux) (status 0)\n  see logs\n")
  })
})

describe("--help", () => {
  it("lists the quickstart commands", async () => {
    const h = deps()
    expect(await runCli(["--help"], h.deps)).toBe(0)
    for (const command of ["init", "doctor", "ping", "send", "logs"]) {
      expect(h.text()).toMatch(new RegExp(`^  ${command}\\s`, "m"))
    }
    expect(h.text()).toContain("--foreground, --tmux")
  })
})
