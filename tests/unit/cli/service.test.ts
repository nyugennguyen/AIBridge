import { describe, expect, it } from "vitest"
import {
  ProfileNotFoundError,
  START_HEALTH_TIMEOUT_MS,
  decideStatus,
  healthUrl,
  loadProfileRunInfo,
  runStartService,
  waitForHealth,
  type ProfileRunInfo,
  type ServiceCommandDeps,
  type StatusFacts,
} from "../../../src/cli/service.js"
import type { UserServiceDeps, UserServiceState } from "../../../src/host/daemonizer.js"
import type { LogFileReader } from "../../../src/host/logs.js"
import type { ProbeResult, ProcessResult, ProcessRunner } from "../../../src/host/types.js"

const INFO: ProfileRunInfo = {
  profile: "dev",
  role: "worker",
  runtimeKind: "claude",
  ingressMode: "engine",
  bridgeHost: "100.64.0.1",
  bridgePort: 8787,
  agentId: "dev-agent",
  publicUrl: "http://dev.ts.net:8787",
  stateDir: "/state/dev",
  logPath: "/state/dev/logs/aibridge.log",
}

const NO_SERVICE: UserServiceState = { supported: true, manager: "launchd", unitPath: "/p.plist", installed: false, running: false }
const LAUNCHD_UP: UserServiceState = { supported: true, manager: "launchd", unitPath: "/p.plist", installed: true, running: true, pid: 9 }
const HEALTHY = { ok: true, status: 200, body: '{"ok":true}' }
const DOWN = { ok: false, status: 0, body: "" }

function facts(overrides: Partial<StatusFacts> = {}): StatusFacts {
  return { info: INFO, service: NO_SERVICE, tmux: false, health: HEALTHY, ...overrides }
}

describe("decideStatus", () => {
  it("healthy under the launchd service", () => {
    expect(decideStatus(facts({ service: LAUNCHD_UP }))).toEqual({ kind: "healthy", sessionName: "launchd:dev", runner: "launchd", body: '{"ok":true}' })
  })

  it("healthy in tmux", () => {
    expect(decideStatus(facts({ tmux: true }))).toEqual({ kind: "healthy", sessionName: "aibridge-dev", runner: "tmux", body: '{"ok":true}' })
  })

  it("healthy but unmanaged gets a hint", () => {
    const status = decideStatus(facts())
    expect(status).toMatchObject({ kind: "healthy", runner: "unmanaged" })
    expect(status.hint).toMatch(/neither the user service nor the tmux session/)
  })

  it("not running anywhere points at aibr start", () => {
    expect(decideStatus(facts({ health: DOWN }))).toEqual({ kind: "not_running", sessionName: "aibridge-dev", hint: "start it with: aibr start --profile dev" })
  })

  it("a runner that is up without /health points at aibr logs", () => {
    const status = decideStatus(facts({ service: LAUNCHD_UP, health: { ok: false, status: 503, body: "" } }))
    expect(status).toMatchObject({ kind: "bridge_unavailable", runner: "launchd", probeStatus: 503 })
    expect(status.hint).toContain("aibr logs --profile dev")
    expect(status.hint).toContain("http://100.64.0.1:8787/health")
    const tmux = decideStatus(facts({ tmux: true, health: DOWN }))
    expect(tmux).toMatchObject({ kind: "bridge_unavailable", runner: "tmux" })
    expect(tmux.hint).toContain("tmux session")
  })

  it("an orchestrator has no bridge", () => {
    const status = decideStatus(facts({ info: { ...INFO, role: "orchestrator" }, health: DOWN }))
    expect(status.kind).toBe("no_bridge")
    expect(status.hint).toContain("aibr doctor --profile dev")
  })

  it("warns when both the service and tmux run the profile", () => {
    const status = decideStatus(facts({ service: LAUNCHD_UP, tmux: true }))
    expect(status).toMatchObject({ kind: "healthy", runner: "launchd" })
    expect(status.hint).toContain("aibr stop --profile dev")
  })

  it("points at aibr start to replace a legacy shared unit", () => {
    const status = decideStatus(facts({ service: { ...LAUNCHD_UP, legacyUnitPath: "/old.plist" } }))
    expect(status.hint).toContain("/old.plist")
    expect(status.hint).toContain("aibr start --profile dev")
  })

  it("a systemd service is named in the session", () => {
    expect(decideStatus(facts({ service: { ...LAUNCHD_UP, manager: "systemd" } }))).toMatchObject({ runner: "systemd", sessionName: "systemd:dev" })
  })
})

describe("healthUrl", () => {
  it("brackets an IPv6 host", () => {
    expect(healthUrl({ bridgeHost: "fd7a::1", bridgePort: 8787 })).toBe("http://[fd7a::1]:8787/health")
    expect(healthUrl(INFO)).toBe("http://100.64.0.1:8787/health")
  })
})

describe("loadProfileRunInfo", () => {
  it("throws ProfileNotFoundError mentioning aibr init when the config is missing or unreadable", async () => {
    await expect(loadProfileRunInfo("dev", { HOME: "/h" }, async () => null)).rejects.toBeInstanceOf(ProfileNotFoundError)
    await expect(loadProfileRunInfo("dev", { HOME: "/h" }, async () => null)).rejects.toThrow(/aibr init --profile dev/)
    await expect(
      loadProfileRunInfo("dev", { HOME: "/h" }, async () => {
        throw new Error("EACCES")
      }),
    ).rejects.toBeInstanceOf(ProfileNotFoundError)
  })

  it("reads role, runtime, ingress, bridge and paths", async () => {
    const seen: string[] = []
    const info = await loadProfileRunInfo("dev", { HOME: "/h" }, async (path) => {
      seen.push(path)
      return {
        agent_id: "a1",
        role: "both",
        runtime: { kind: "opencode" },
        bridge: { host: "100.64.0.9", port: 9999, public_url: "http://x:9999", ingress_mode: "router" },
        opencode: { server_port: 4097 },
      }
    })
    expect(seen).toEqual(["/h/.config/aibridge/dev/config.json"])
    expect(info).toEqual({
      profile: "dev",
      role: "both",
      runtimeKind: "opencode",
      ingressMode: "router",
      bridgeHost: "100.64.0.9",
      bridgePort: 9999,
      opencodePort: 4097,
      agentId: "a1",
      publicUrl: "http://x:9999",
      stateDir: "/h/.local/state/aibridge/dev",
      logPath: "/h/.local/state/aibridge/dev/logs/aibridge.log",
    })
  })

  it("defaults an old config to worker/opencode/engine on 127.0.0.1:8787", async () => {
    const info = await loadProfileRunInfo("dev", { HOME: "/h" }, async () => ({}))
    expect(info).toMatchObject({ role: "worker", runtimeKind: "opencode", ingressMode: "engine", bridgeHost: "127.0.0.1", bridgePort: 8787, agentId: "dev" })
  })
})

// ── runStartService ──────────────────────────────────────────────────────

function runner(script: (argv: readonly string[]) => ProcessResult | undefined = () => undefined): ProcessRunner & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async exec(argv) {
      calls.push(argv.join(" "))
      return script(argv) ?? { exitCode: 0, stdout: "", stderr: "" }
    },
  }
}

/** No tmux session, and launchd has no such job loaded yet. */
const NO_TMUX = (argv: readonly string[]): ProcessResult | undefined =>
  argv[0] === "tmux"
    ? { exitCode: 1, stdout: "", stderr: "no server running" }
    : argv[0] === "launchctl" && argv[1] === "print"
      ? { exitCode: 113, stdout: "", stderr: "Could not find service" }
      : undefined

function serviceDeps(platform: string, run: ProcessRunner, files: Record<string, string> = {}): UserServiceDeps {
  return {
    platform,
    uid: 501,
    home: "/h",
    runner: run,
    env: { PATH: "/bin" },
    entry: ["/opt/bun", "/opt/cli.js"],
    writeFile: async (path, data) => {
      files[path] = data
    },
    readFile: async (path) => files[path] ?? null,
    removeFile: async (path) => {
      delete files[path]
    },
    fileExists: (path) => files[path] !== undefined,
    sleep: async () => undefined,
  }
}

function startDeps(options: {
  platform?: string
  run?: ProcessRunner
  probe?: (url: string) => ProbeResult
  info?: ProfileRunInfo
  log?: string
}): ServiceCommandDeps & { probes: string[]; slept: number[] } {
  let clock = 0
  const probes: string[] = []
  const slept: number[] = []
  const run = options.run ?? runner(NO_TMUX)
  const reader: LogFileReader = {
    size: () => (options.log === undefined ? null : Buffer.byteLength(options.log)),
    read: (_p, s, e) => (options.log ?? "").slice(s, e),
  }
  return {
    env: { HOME: "/h" },
    runner: run,
    probe: {
      probe: async (url) => {
        probes.push(url)
        return options.probe?.(url) ?? HEALTHY
      },
    },
    service: serviceDeps(options.platform ?? "darwin", run),
    sleep: async (ms) => {
      slept.push(ms)
      clock += ms
    },
    now: () => clock,
    logReader: reader,
    loadInfo: async () => options.info ?? INFO,
    probes,
    slept,
  }
}

async function start(d: ServiceCommandDeps) {
  const out: string[] = []
  const code = await runStartService("dev", d, (t) => out.push(t))
  return { code, text: out.join("") }
}

describe("runStartService", () => {
  it("starts nothing for an orchestrator", async () => {
    const d = startDeps({ info: { ...INFO, role: "orchestrator" } })
    const { code, text } = await start(d)
    expect(code).toBe(0)
    expect(text).toContain("Nothing to start")
    expect(d.probes).toEqual([])
  })

  it("refuses while the tmux session runs the profile", async () => {
    const run = runner()
    const { code, text } = await start(startDeps({ run }))
    expect(code).toBe(1)
    expect(text).toContain("tmux session aibridge-dev")
    expect(text).toContain("aibr stop --profile dev")
    expect(run.calls).toEqual(["tmux has-session -t aibridge-dev"])
  })

  it("loads the service, waits for /health, and says how to see logs and stop", async () => {
    let calls = 0
    const d = startDeps({ probe: () => (++calls < 3 ? DOWN : HEALTHY) })
    const { code, text } = await start(d)
    expect(code).toBe(0)
    expect(text).toContain('Started the launchd service for "dev" (/h/Library/LaunchAgents/com.aibridge.dev.plist)')
    expect(text).toContain("Bridge healthy at http://dev.ts.net:8787 (agent dev-agent)")
    expect(text).toContain("aibr logs --profile dev")
    expect(d.probes).toEqual(Array(3).fill("http://100.64.0.1:8787/health"))
    expect(d.slept).toEqual([500, 500])
  })

  it("supervises opencode beside an OpenCode worker in engine mode", async () => {
    const run = runner(NO_TMUX)
    const files: Record<string, string> = {}
    const d = { ...startDeps({ run, info: { ...INFO, runtimeKind: "opencode" } }), service: serviceDeps("darwin", run, files) }
    expect((await start(d)).code).toBe(0)
    expect(files["/h/Library/LaunchAgents/com.aibridge.dev.plist"]).toContain("<string>--with-opencode</string>")
  })

  it("reports a health timeout with the last log lines", async () => {
    const d = startDeps({ probe: () => DOWN, log: "2026 INFO starting\n2026 ERROR cannot listen on 100.64.0.1:8787: EADDRINUSE\n" })
    const { code, text } = await start(d)
    expect(code).toBe(1)
    expect(text).toContain(`did not answer within ${START_HEALTH_TIMEOUT_MS / 1000}s`)
    expect(text).toContain("  2026 ERROR cannot listen on 100.64.0.1:8787: EADDRINUSE")
    expect(text).toContain("aibr logs --profile dev")
  })

  it("says when there is no log yet", async () => {
    const { text } = await start(startDeps({ probe: () => DOWN }))
    expect(text).toContain("(no log at /state/dev/logs/aibridge.log yet)")
  })

  it("fails on an unsupported platform", async () => {
    const { code, text } = await start(startDeps({ platform: "win32" }))
    expect(code).toBe(1)
    expect(text).toContain("--foreground")
  })

  it("fails when the supervisor refuses, pointing at --foreground", async () => {
    const run = runner((argv) => NO_TMUX(argv) ?? (argv[1] === "bootstrap" ? { exitCode: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" } : undefined))
    const { code, text } = await start(startDeps({ run }))
    expect(code).toBe(1)
    expect(text).toContain("could not load the launchd service: Bootstrap failed")
    expect(text).toContain("aibr start --foreground --profile dev")
  })

  it("reports a missing profile", async () => {
    const d = {
      ...startDeps({}),
      loadInfo: async () => {
        throw new ProfileNotFoundError('Profile "dev" not found. Run "aibr init --profile dev" first.')
      },
    }
    const { code, text } = await start(d)
    expect(code).toBe(1)
    expect(text).toContain("aibr init --profile dev")
  })
})

describe("waitForHealth", () => {
  it("returns the last probe at the deadline", async () => {
    let clock = 0
    const result = await waitForHealth(
      { probe: { probe: async () => ({ ok: false, status: 502, body: "x" }) }, sleep: async (ms) => void (clock += ms), now: () => clock },
      "http://h/health",
      1200,
    )
    expect(result).toEqual({ ok: false, status: 502, body: "x" })
    expect(clock).toBe(1500)
  })
})
