import { describe, expect, it } from "vitest"
import {
  buildDoctorReport,
  fixForVerifyCheck,
  renderDoctorReport,
  type DoctorConfigFacts,
  type DoctorDeps,
  type DoctorReport,
} from "../../../src/cli/doctor.js"
import type { VerifyCheck, VerifyReport } from "../../../src/cli/verify.js"
import type { StatusFacts } from "../../../src/cli/service.js"
import type { PingOutcome } from "../../../src/mcp/bridge-tools.js"

const ENV = { HOME: "/home/me", USER: "me" }
const SECRETS = "/home/me/.local/share/aibridge/dev/secrets"

function verifyReport(checks: VerifyCheck[]): VerifyReport {
  return { ok: !checks.some((c) => c.status === "fail"), profile: "dev", configPath: "/c.json", checks, summary: "" }
}

const PASSING: VerifyCheck[] = [
  { name: "runtime-bun", status: "pass", message: "Bun ok" },
  { name: "prereq-tmux", status: "pass", message: "Dependency tmux: installed" },
]

function facts(overrides: { role?: "worker" | "orchestrator" | "both"; running?: boolean; manager?: "launchd" | "systemd"; tmux?: boolean; healthy?: boolean } = {}): StatusFacts {
  return {
    info: {
      profile: "dev",
      role: overrides.role ?? "worker",
      runtimeKind: "claude",
      ingressMode: "engine",
      bridgeHost: "100.64.0.1",
      bridgePort: 8787,
      agentId: "dev",
      publicUrl: "http://dev:8787",
      stateDir: "/s",
      logPath: "/s/logs/aibridge.log",
    },
    service: {
      supported: true,
      manager: overrides.manager ?? "launchd",
      unitPath: "/u",
      installed: overrides.running ?? true,
      running: overrides.running ?? true,
    },
    tmux: overrides.tmux ?? false,
    health: overrides.healthy === false ? { ok: false, status: 0, body: "" } : { ok: true, status: 200, body: "{}" },
  }
}

function config(overrides: Partial<DoctorConfigFacts> = {}): DoctorConfigFacts {
  return { role: "worker", runtime: "claude", agentId: "dev", agents: [], allowedSources: [], ...overrides }
}

function okPing(target: string, overrides: Partial<PingOutcome> = {}): PingOutcome {
  return {
    ok: true,
    target,
    url: `http://${target}.ts.net:8787`,
    jobId: "ping-1",
    stage: "done",
    rttMs: 12,
    callback: { status: "delivered" },
    pong: { agent_id: target, role: "worker", runtime: "claude", version: "3.0.0", capabilities: ["investigate"], projects: [] },
    ...overrides,
  }
}

function failedPing(target: string, code: string, extra: Partial<PingOutcome> = {}): PingOutcome {
  return { ok: false, target, url: `http://${target}.ts.net:8787`, stage: "dispatch", rttMs: 5, callback: { status: "unknown" }, error: "nope", code, ...extra }
}

function deps(overrides: Partial<DoctorDeps> & { checks?: VerifyCheck[]; cfg?: DoctorConfigFacts | null; status?: StatusFacts } = {}): DoctorDeps & { pinged: string[] } {
  const pinged: string[] = []
  return {
    pinged,
    platform: "darwin",
    env: ENV,
    verify: async () => verifyReport(overrides.checks ?? PASSING),
    config: async () => (overrides.cfg === undefined ? config() : overrides.cfg),
    statusFacts: async () => overrides.status ?? facts(),
    ping: async (_profile, target) => {
      pinged.push(target)
      return okPing(target)
    },
    ...overrides,
  }
}

function assertEveryFailHasFix(report: DoctorReport): void {
  for (const line of report.lines) {
    if (line.status === "fail") expect(line.fix, line.message).toBeTruthy()
  }
}

describe("fixForVerifyCheck", () => {
  const fail = (name: string, detail?: string): VerifyCheck => ({ name, status: "fail", message: name, ...(detail ? { detail } : {}) })

  it("maps prerequisites per platform", () => {
    expect(fixForVerifyCheck(fail("prereq-tmux"), "dev", "darwin", ENV)).toBe("brew install tmux")
    expect(fixForVerifyCheck(fail("prereq-tmux"), "dev", "linux", ENV)).toBe("sudo apt-get install -y tmux")
    expect(fixForVerifyCheck(fail("prereq-claude"), "dev", "linux", ENV)).toBe("npm install -g @anthropic-ai/claude-code")
    expect(fixForVerifyCheck(fail("prereq-weird", "Install with: foo bar"), "dev", "linux", ENV)).toBe("foo bar")
    expect(fixForVerifyCheck(fail("runtime-bun"), "dev", "linux", ENV)).toContain("bun.sh/install")
  })

  it("maps Tailscale, config, project and secret checks", () => {
    expect(fixForVerifyCheck(fail("tailscale-active"), "dev", "linux", ENV)).toBe("sudo tailscale up")
    expect(fixForVerifyCheck(fail("tailscale-active"), "dev", "darwin", ENV)).toContain("tailscale up")
    expect(fixForVerifyCheck(fail("config-exists"), "dev", "darwin", ENV)).toBe("aibr init --profile dev")
    expect(fixForVerifyCheck(fail("config-readable"), "dev", "darwin", ENV)).toBe("aibr init --profile dev")
    expect(fixForVerifyCheck(fail("config-valid"), "dev", "darwin", ENV)).toBe("aibr setup --profile dev")
    expect(fixForVerifyCheck(fail("project-app"), "dev", "darwin", ENV)).toContain("aibr setup --profile dev")
    expect(fixForVerifyCheck(fail("secret-bearer-token-mode"), "dev", "darwin", ENV)).toBe(`chmod 600 ${SECRETS}/bearer_token`)
    expect(fixForVerifyCheck(fail("secret-bearer-token"), "dev", "darwin", ENV)).toBe("aibr setup --profile dev")
    expect(fixForVerifyCheck({ name: "auth-mode-src-stale-secret", status: "warn", message: "" }, "dev", "darwin", ENV)).toBe(`rm ${SECRETS}/bearer_token`)
    expect(fixForVerifyCheck({ name: "tailscale-discovery", status: "warn", message: "" }, "dev", "darwin", ENV)).toContain("aibr enroll issue --profile dev")
  })

  it("falls back to aibr verify for an unknown failed check, nothing for an unknown warning", () => {
    expect(fixForVerifyCheck(fail("mystery"), "dev", "darwin", ENV)).toContain("aibr verify --profile dev")
    expect(fixForVerifyCheck({ name: "mystery", status: "warn", message: "" }, "dev", "darwin", ENV)).toBeUndefined()
  })
})

describe("buildDoctorReport", () => {
  it("passes end to end on a healthy worker whose peer answers the ping", async () => {
    const d = deps({ cfg: config({ agents: [{ id: "staging", url: "http://staging:8787" }], allowedSources: ["staging"] }) })
    const report = await buildDoctorReport("dev", d)
    expect(report.ok).toBe(true)
    expect(d.pinged).toEqual(["staging"])
    const peer = report.lines.find((l) => l.section === "peers")
    expect(peer).toMatchObject({ status: "pass" })
    expect(peer?.message).toContain("ping staging: 12 ms, report delivered back here; accepts investigate")
    expect(report.lines.find((l) => l.section === "bridge")).toMatchObject({ status: "pass", message: expect.stringContaining("launchd service") })
    expect(renderDoctorReport(report, "H")).toContain("All checks passed.")
  })

  it("gives every failed verify check its fix", async () => {
    const checks: VerifyCheck[] = [
      { name: "prereq-tmux", status: "fail", message: "Dependency tmux: missing" },
      { name: "tailscale-active", status: "fail", message: "Tailscale is not active" },
      { name: "secret-bearer-token-mode", status: "fail", message: "too open" },
      { name: "tailscale-discovery", status: "warn", message: "2 reachable, 0 enrolled", detail: "d" },
    ]
    const report = await buildDoctorReport("dev", deps({ checks }))
    assertEveryFailHasFix(report)
    expect(report.ok).toBe(false)
    const byMessage = (m: string) => report.lines.find((l) => l.message === m)
    expect(byMessage("Dependency tmux: missing")?.fix).toBe("brew install tmux")
    expect(byMessage("too open")?.fix).toBe(`chmod 600 ${SECRETS}/bearer_token`)
    expect(byMessage("2 reachable, 0 enrolled")).toMatchObject({ status: "warn", detail: "d", fix: expect.stringContaining("aibr enroll issue") })
    const text = renderDoctorReport(report, "H")
    expect(text).toContain("  ✗ Dependency tmux: missing\n      fix: brew install tmux")
    expect(text).toContain("3 problems found, 2 warnings.")
  })

  it("skips bridge and peers when the profile has no usable config", async () => {
    const report = await buildDoctorReport(
      "dev",
      deps({ cfg: null, checks: [{ name: "config-exists", status: "fail", message: "Configuration not found" }] }),
    )
    assertEveryFailHasFix(report)
    expect(report.lines.find((l) => l.message === "Configuration not found")?.fix).toBe("aibr init --profile dev")
    expect(report.lines.filter((l) => l.status === "skip").map((l) => l.section)).toEqual(["bridge", "peers"])
  })

  it("fails an orchestrator with no peers, with the join command", async () => {
    const d = deps({ cfg: config({ role: "orchestrator", runtime: null }) })
    let statusAsked = false
    const report = await buildDoctorReport("dev", {
      ...d,
      statusFacts: async () => {
        statusAsked = true
        return facts()
      },
    })
    expect(statusAsked).toBe(false)
    assertEveryFailHasFix(report)
    const peers = report.lines.find((l) => l.section === "peers")
    expect(peers).toMatchObject({ status: "fail", fix: expect.stringContaining("aibr enroll join <code> --profile dev") })
  })

  it("warns a worker nobody may send work to", async () => {
    const report = await buildDoctorReport("dev", deps())
    expect(report.ok).toBe(true)
    expect(report.lines.find((l) => l.section === "peers")).toMatchObject({ status: "warn", fix: expect.stringContaining("aibr enroll issue --profile dev") })
  })

  it("reports sources that may send work when the worker calls nobody", async () => {
    const report = await buildDoctorReport("dev", deps({ cfg: config({ allowedSources: ["orch"] }) }))
    expect(report.lines.find((l) => l.section === "peers")).toMatchObject({ status: "pass", message: expect.stringContaining("aibr ping dev") })
  })

  it("fails a bridge that is not running and skips the pings", async () => {
    const d = deps({
      cfg: config({ agents: [{ id: "staging", url: "u" }] }),
      status: facts({ running: false, healthy: false }),
    })
    const report = await buildDoctorReport("dev", d)
    assertEveryFailHasFix(report)
    expect(report.lines.find((l) => l.section === "bridge")).toMatchObject({ status: "fail", fix: "aibr start --profile dev" })
    expect(report.lines.find((l) => l.section === "peers")).toMatchObject({ status: "skip" })
    expect(d.pinged).toEqual([])
  })

  it("fails a running service whose /health does not answer, pointing at the logs", async () => {
    const report = await buildDoctorReport("dev", deps({ status: facts({ healthy: false }) }))
    expect(report.lines.find((l) => l.section === "bridge")).toMatchObject({ status: "fail", fix: "aibr logs --profile dev" })
  })

  it("maps ping failure codes to fixes", async () => {
    const outcomes: Record<string, PingOutcome> = {
      a: failedPing("a", "unreachable"),
      b: failedPing("b", "signature_required"),
      c: failedPing("c", "ping_unsupported"),
      d: failedPing("d", "forbidden"),
      e: failedPing("e", "callback_not_delivered", { stage: "callback", hint: "make d reach back" }),
      f: failedPing("f", "something_else"),
    }
    const report = await buildDoctorReport("dev", {
      ...deps({ cfg: config({ agents: Object.keys(outcomes).map((id) => ({ id, url: "u" })) }) }),
      ping: async (_p, target) => outcomes[target]!,
    })
    assertEveryFailHasFix(report)
    const fixOf = (target: string) => report.lines.find((l) => l.message.startsWith(`ping ${target} `))?.fix
    expect(fixOf("a")).toContain("tailscale ping a.ts.net")
    expect(fixOf("b")).toContain("aibr enroll issue")
    expect(fixOf("b")).toContain("aibr enroll join <code>")
    expect(fixOf("c")).toContain("bun install -g @nyugennguyen/aibridge")
    expect(fixOf("d")).toContain("--capabilities")
    expect(fixOf("e")).toBe("make d reach back")
    expect(fixOf("f")).toContain("aibr logs")
    expect(renderDoctorReport(report, "H")).toContain("6 problems found")
  })

  it("warns when a peer accepts nothing beyond ping", async () => {
    const report = await buildDoctorReport("dev", {
      ...deps({ cfg: config({ agents: [{ id: "s", url: "u" }] }) }),
      ping: async () => okPing("s", { pong: { agent_id: "s", role: "worker", runtime: "claude", version: "3", capabilities: [], projects: [] } }),
    })
    expect(report.lines.find((l) => l.section === "peers")).toMatchObject({ status: "warn", fix: expect.stringContaining("--capabilities") })
  })

  it("skips pings with ping: false", async () => {
    const d = deps({ cfg: config({ agents: [{ id: "s", url: "u" }] }) })
    const report = await buildDoctorReport("dev", d, { ping: false })
    expect(d.pinged).toEqual([])
    expect(report.lines.find((l) => l.section === "peers")).toMatchObject({ status: "skip", message: expect.stringContaining("--no-ping") })
  })

  it("warns about systemd linger on a systemd user service", async () => {
    const report = await buildDoctorReport("dev", {
      ...deps({ status: facts({ manager: "systemd" }) }),
      platform: "linux",
      linger: async () => false,
    })
    expect(report.lines.find((l) => l.message.includes("linger"))).toMatchObject({ status: "warn", fix: "sudo loginctl enable-linger me" })
  })

  it("warns when both the service and tmux run the profile", async () => {
    const report = await buildDoctorReport("dev", deps({ status: facts({ tmux: true }) }))
    expect(report.lines.find((l) => l.section === "bridge")).toMatchObject({
      status: "warn",
      fix: "aibr stop --profile dev && aibr start --profile dev",
    })
  })

  it("reports a status that cannot be gathered as a failure with a fix", async () => {
    const report = await buildDoctorReport("dev", {
      ...deps(),
      statusFacts: async () => {
        throw new Error("boom")
      },
    })
    assertEveryFailHasFix(report)
    expect(report.lines.find((l) => l.section === "bridge")).toMatchObject({ status: "fail", fix: "aibr status --profile dev" })
  })
})

describe("renderDoctorReport", () => {
  it("groups sections, shows details and fixes, and summarises", () => {
    const text = renderDoctorReport(
      {
        ok: false,
        profile: "dev",
        lines: [
          { section: "node", status: "pass", message: "ok thing", detail: "hidden" },
          { section: "bridge", status: "fail", message: "down", fix: "aibr start", detail: "why" },
          { section: "peers", status: "skip", message: "skipped" },
        ],
      },
      "HEADER",
    )
    expect(text.startsWith("HEADER\n\nThis node\n  ✓ ok thing\n")).toBe(true)
    expect(text).not.toContain("hidden")
    expect(text).toContain("Bridge\n  ✗ down\n      why\n      fix: aibr start\n")
    expect(text).toContain("Peers (end to end)\n  - skipped\n")
    expect(text).toContain("1 problem found. Run the fix lines above")
  })
})
