import { describe, expect, it } from "vitest"
import { runVerify, type VerifyFileOps } from "../../../src/cli/verify.js"
import type { PlatformInspector, ProcessRunner } from "../../../src/host/types.js"

/**
 * `aibr verify` applies the same per-role prerequisite list as `aibr setup`:
 * worker+opencode → tmux, opencode, tailscale; worker+claude → tmux, claude,
 * tailscale; orchestrator → claude, tailscale. A profile with no `role` key
 * predates roles and is checked as worker + opencode.
 */

const baseConfig = {
  agent_id: "a",
  bridge: { host: "100.64.0.1", port: 8787, public_url: "http://100.64.0.1:8787" },
  opencode: {
    base_url: "http://127.0.0.1:4096",
    server_port: 4096,
    username: "opencode",
    password_env: "OPENCODE_SERVER_PASSWORD",
  },
  security: { auth_mode: "bearer-token", allowed_sources: [] },
  permissions: { default_response: "reject", allow_tools: [], require_plan_approval_for_tools: [] },
  projects: [{ id: "p", path: "/mock/project", capabilities: ["development"] }],
  agents: [],
  timeouts: { default_job_seconds: 1800, callback_retry_attempts: 3 },
  planning: { plan_annotator_enabled: true, require_approval_for: [] },
}

const inspector: PlatformInspector = {
  inspect: () => ({ platform: "darwin", arch: "arm64", isTTY: true }),
}

function runner(installed: readonly string[], calls: string[]): ProcessRunner {
  return {
    async exec(argv) {
      const cmd = argv.join(" ")
      calls.push(cmd)
      if (argv[0] === "which") {
        return { exitCode: installed.includes(argv[1] ?? "") ? 0 : 1, stdout: "", stderr: "" }
      }
      if (cmd === "tailscale status --json") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            BackendState: "Running",
            Self: { TailscaleIPs: ["100.64.0.1"], DNSName: "n.ts.net.", BackendState: "Running" },
          }),
          stderr: "",
        }
      }
      return { exitCode: 1, stdout: "", stderr: "" }
    },
  }
}

/** A profile whose bearer token is fine and which has NO OpenCode password file. */
function fileOps(config: Record<string, unknown>): VerifyFileOps {
  return {
    readConfig: async () => config,
    stat: async (path) => {
      if (path.endsWith("bearer_token")) {
        return { mode: 0o100600, isSymbolicLink: () => false, isDirectory: () => false }
      }
      throw new Error(`ENOENT: ${path}`)
    },
    readFile: async (path) => {
      if (path.endsWith("bearer_token")) return "0123456789abcdef0123456789abcdef"
      throw new Error(`ENOENT: ${path}`)
    },
    pathExists: async () => true,
  }
}

async function verifyWith(config: Record<string, unknown>, installed: readonly string[]) {
  const calls: string[] = []
  const report = await runVerify("p", {
    processRunner: runner(installed, calls),
    platformInspector: inspector,
    fileOps: fileOps(config),
    env: { HOME: "/mock/home" },
    bunVersion: "1.3.14",
    discoverAgents: async () => ({ agents: [], peersFound: 0, reachableCount: 0, enrolledCount: 0 }),
  })
  const probed = calls.filter((c) => c.startsWith("which ") && c !== "which herdr")
  return { report, probed }
}

describe("runVerify per node role", () => {
  it("checks a profile without a role as worker + opencode, including the OpenCode password", async () => {
    const { report, probed } = await verifyWith(baseConfig, ["tmux", "opencode", "tailscale"])

    expect(probed).toEqual(["which tmux", "which opencode", "which tailscale"])
    expect(report.checks.find((c) => c.name === "node-role")?.message).toBe(
      "Node role: worker (runtime: opencode)",
    )
    // The password file is absent in this fixture, so the OpenCode worker fails on it.
    expect(report.checks.find((c) => c.name === "secret-opencode-password")?.status).toBe("fail")
  })

  it("worker + claude: requires claude, not opencode, and does not want an OpenCode password", async () => {
    const { report, probed } = await verifyWith(
      { ...baseConfig, role: "worker", runtime: { kind: "claude" } },
      ["tmux", "claude", "tailscale"],
    )

    expect(probed).toEqual(["which tmux", "which claude", "which tailscale"])
    expect(report.checks.some((c) => c.name.startsWith("secret-opencode-password"))).toBe(false)
    expect(report.ok).toBe(true)
  })

  it("orchestrator: requires only claude and tailscale", async () => {
    const { report, probed } = await verifyWith(
      { ...baseConfig, role: "orchestrator" },
      ["claude", "tailscale"],
    )

    expect(probed).toEqual(["which claude", "which tailscale"])
    expect(report.checks.find((c) => c.name === "node-role")?.message).toBe("Node role: orchestrator")
    expect(report.ok).toBe(true)
  })

  it("orchestrator: fails when claude is missing", async () => {
    const { report } = await verifyWith({ ...baseConfig, role: "orchestrator" }, ["tailscale"])

    expect(report.ok).toBe(false)
    expect(report.checks.find((c) => c.name === "prereq-claude")?.status).toBe("fail")
  })
})
