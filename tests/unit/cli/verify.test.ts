import { describe, expect, it } from "vitest"
import { runVerify } from "../../../src/cli/verify.js"
import type { AgentDiscoveryResult } from "../../../src/cli/setup-step-widgets.js"
import type { PlatformInspector, ProcessRunner } from "../../../src/host/types.js"

function makeFakeProcessRunner(params?: {
  tmuxInstalled?: boolean
  opencodeInstalled?: boolean
  tailscaleInstalled?: boolean
  tailscaleIp?: string
  tailscaleBackend?: string
  herdrInstalled?: boolean
  herdrPath?: string
  herdrSchemaStdout?: string
  herdrSchemaStderr?: string
  herdrSchemaExitCode?: number
}): ProcessRunner {
  const tmux = params?.tmuxInstalled ?? true
  const opencode = params?.opencodeInstalled ?? true
  const tailscale = params?.tailscaleInstalled ?? true
  const tsIp = params?.tailscaleIp ?? "100.64.0.1"
  const tsBackend = params?.tailscaleBackend ?? "Running"
  const herdr = params?.herdrInstalled ?? false
  const herdrPath = params?.herdrPath ?? "/usr/local/bin/herdr"
  const herdrSchemaStdout = params?.herdrSchemaStdout ?? ""
  const herdrSchemaStderr = params?.herdrSchemaStderr ?? ""
  const herdrSchemaExitCode = params?.herdrSchemaExitCode ?? 0
  return {
    async exec(argv) {
      const cmd = argv.join(" ")
      if (cmd === "which tmux") {
        return { exitCode: tmux ? 0 : 1, stdout: tmux ? "/usr/bin/tmux" : "", stderr: "" }
      }
      if (cmd === "which opencode") {
        return { exitCode: opencode ? 0 : 1, stdout: opencode ? "/usr/local/bin/opencode" : "", stderr: "" }
      }
      if (cmd === "which tailscale") {
        return { exitCode: tailscale ? 0 : 1, stdout: tailscale ? "/usr/bin/tailscale" : "", stderr: "" }
      }
      if (cmd === "which herdr") {
        return { exitCode: herdr ? 0 : 1, stdout: herdr ? herdrPath : "", stderr: herdr ? "" : "herdr not found" }
      }
      if (cmd === "herdr api schema" || cmd === "herdr api schema --json") {
        return { exitCode: herdrSchemaExitCode, stdout: herdrSchemaStdout, stderr: herdrSchemaStderr }
      }
      if (cmd === "tailscale status --json") {
        if (!tailscale) {
          return { exitCode: 1, stdout: "", stderr: "command not found" }
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            BackendState: tsBackend,
            Self: {
              TailscaleIPs: [tsIp],
              DNSName: "node.example.ts.net.",
              BackendState: tsBackend,
            },
          }),
          stderr: "",
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" }
    },
  }
}

function makeFakePlatformInspector(platform = "darwin"): PlatformInspector {
  return {
    inspect: () => ({
      platform,
      arch: "arm64",
      isTTY: true,
      hasColor: true,
    }),
  }
}

const validConfig = {
  agent_id: "test-agent",
  bridge: {
    host: "100.64.0.1",
    port: 8787,
    public_url: "http://100.64.0.1:8787",
  },
  opencode: {
    base_url: "http://127.0.0.1:4096",
    server_port: 4096,
    username: "opencode",
    password_env: "OPENCODE_SERVER_PASSWORD",
  },
  security: {
    auth_mode: "bearer-token",
    allowed_sources: [
      {
        source_agent_id: "peer",
        capabilities: ["development"],
        requires_plan_approval: [],
      },
    ],
  },
  permissions: {
    default_response: "reject",
    allow_tools: ["read", "grep"],
    require_plan_approval_for_tools: ["bash"],
  },
  projects: [
    {
      id: "p1",
      path: "/mock/project",
      capabilities: ["development"],
    },
  ],
  agents: [
    {
      id: "peer",
      url: "http://100.64.0.2:8787",
      capabilities: ["testing"],
    },
  ],
  timeouts: {
    default_job_seconds: 1800,
    callback_retry_attempts: 3,
  },
  planning: {
    plan_annotator_enabled: true,
    require_approval_for: ["deployment"],
  },
}

function makeFakeFileOps(overrides?: {
  config?: Record<string, unknown> | null
  configReadError?: boolean
  tokenFileMissing?: boolean
  tokenSymlink?: boolean
  tokenPerms?: number
  tokenContent?: string
  passwordFileMissing?: boolean
  passwordSymlink?: boolean
  passwordContent?: string
  projectExists?: boolean
  bearerTokenExists?: boolean
}) {
  return {
    readConfig: async (_path: string) => {
      if (overrides?.configReadError) throw new Error("Permission denied")
      if (overrides?.config === null) return null
      return overrides?.config ?? validConfig
    },
    stat: async (path: string) => {
      if (path.endsWith("bearer_token")) {
        if (overrides?.tokenFileMissing) throw new Error("ENOENT")
        return {
          mode: overrides?.tokenPerms ?? 0o100600,
          isSymbolicLink: () => Boolean(overrides?.tokenSymlink),
          isDirectory: () => false,
        }
      }
      if (path.endsWith("opencode_password")) {
        if (overrides?.passwordFileMissing) throw new Error("ENOENT")
        return {
          mode: 0o100600,
          isSymbolicLink: () => Boolean(overrides?.passwordSymlink),
          isDirectory: () => false,
        }
      }
      throw new Error(`ENOENT: ${path}`)
    },
    readFile: async (path: string) => {
      if (path.endsWith("bearer_token")) {
        if (overrides?.tokenFileMissing) throw new Error("ENOENT")
        return overrides?.tokenContent ?? "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      }
      if (path.endsWith("opencode_password")) {
        if (overrides?.passwordFileMissing) throw new Error("ENOENT")
        return overrides?.passwordContent ?? "secretpassword123"
      }
      throw new Error(`ENOENT: ${path}`)
    },
    pathExists: async (path: string) => {
      if (path.endsWith("bearer_token")) return overrides?.bearerTokenExists ?? false
      return overrides?.projectExists ?? true
    },
  }
}

/**
 * A discovery probe that reports exactly the given shape.
 *
 * The real one shells out to `tailscale` and dials every peer, so every test that
 * cares about the discovery CHECK injects one of these; no test here touches a
 * tailnet, and the ones that do not inject it fall through to the real probe with
 * the fake `ProcessRunner` above, which reports a tailnet with no peers.
 */
function fakeDiscovery(
  partial: Partial<AgentDiscoveryResult> & { readonly agents?: AgentDiscoveryResult["agents"] },
): (deps?: unknown) => Promise<AgentDiscoveryResult> {
  const agents = partial.agents ?? []
  return async () => ({
    agents,
    reachableCount: partial.reachableCount ?? agents.filter((a) => a.reachable).length,
    enrolledCount: partial.enrolledCount ?? agents.filter((a) => a.enrolled).length,
    peersFound: partial.peersFound ?? agents.length,
  })
}

function peer(overrides: Partial<AgentDiscoveryResult["agents"][number]> = {}) {
  return {
    ip: "100.64.0.2",
    hostname: "peer",
    os: "linux",
    online: true,
    bridgeUrl: "http://100.64.0.2:8787",
    reachable: true,
    agentId: "peer",
    capabilities: ["testing"],
    opencodeReachable: true,
    enrolled: true,
    ...overrides,
  }
}

describe("runVerify", () => {
  const env = {
    HOME: "/mock/home",
  }

  it("passes when all checks are valid", async () => {
    const report = await runVerify("test-profile", {
      processRunner: makeFakeProcessRunner(),
      platformInspector: makeFakePlatformInspector(),
      fileOps: makeFakeFileOps(),
      env,
      bunVersion: "1.3.14",
    })

    expect(report.ok).toBe(true)
    expect(report.profile).toBe("test-profile")
    expect(report.summary).toContain("Status: PASSED")
    expect(report.summary).toContain("Bun runtime")
    expect(report.summary).toContain("Dependency tmux")
    expect(report.summary).toContain("Tailscale active")
    expect(report.summary).toContain("Configuration valid")
    expect(report.summary).toContain("Bearer token secret valid")
  })

  it("fails when Bun version is below 1.3.0", async () => {
    const report = await runVerify("test-profile", {
      processRunner: makeFakeProcessRunner(),
      platformInspector: makeFakePlatformInspector(),
      fileOps: makeFakeFileOps(),
      env,
      bunVersion: "1.2.9",
    })

    expect(report.ok).toBe(false)
    expect(report.summary).toContain("Status: FAILED")
    expect(report.summary).toContain("Bun runtime >= 1.3.0 required")
  })

  it("fails when a prerequisite is missing", async () => {
    const report = await runVerify("test-profile", {
      processRunner: makeFakeProcessRunner({ tmuxInstalled: false }),
      platformInspector: makeFakePlatformInspector(),
      fileOps: makeFakeFileOps(),
      env,
      bunVersion: "1.3.0",
    })

    expect(report.ok).toBe(false)
    expect(report.summary).toContain("Dependency tmux: missing")
  })

  it("fails when Tailscale is not running", async () => {
    const report = await runVerify("test-profile", {
      processRunner: makeFakeProcessRunner({ tailscaleBackend: "Stopped" }),
      platformInspector: makeFakePlatformInspector(),
      fileOps: makeFakeFileOps(),
      env,
      bunVersion: "1.3.0",
    })

    expect(report.ok).toBe(false)
    expect(report.summary).toContain("Tailscale backend state is not Running")
  })

  it("fails when config file is not found", async () => {
    const report = await runVerify("test-profile", {
      processRunner: makeFakeProcessRunner(),
      platformInspector: makeFakePlatformInspector(),
      fileOps: makeFakeFileOps({ config: null }),
      env,
      bunVersion: "1.3.0",
    })

    expect(report.ok).toBe(false)
    expect(report.summary).toContain("Configuration not found")
  })

  it("fails when config schema is invalid", async () => {
    const report = await runVerify("test-profile", {
      processRunner: makeFakeProcessRunner(),
      platformInspector: makeFakePlatformInspector(),
      fileOps: makeFakeFileOps({
        config: {
          agent_id: "", // invalid empty string
          bridge: {},
        },
      }),
      env,
      bunVersion: "1.3.0",
    })

    expect(report.ok).toBe(false)
    expect(report.summary).toContain("Configuration schema validation failed")
  })

  it("fails when bearer token file is missing", async () => {
    const report = await runVerify("test-profile", {
      processRunner: makeFakeProcessRunner(),
      platformInspector: makeFakePlatformInspector(),
      fileOps: makeFakeFileOps({ tokenFileMissing: true }),
      env,
      bunVersion: "1.3.0",
    })

    expect(report.ok).toBe(false)
    expect(report.summary).toContain("Bearer token secret not found")
  })

  it("fails when bearer token is a symlink", async () => {
    const report = await runVerify("test-profile", {
      processRunner: makeFakeProcessRunner(),
      platformInspector: makeFakePlatformInspector(),
      fileOps: makeFakeFileOps({ tokenSymlink: true }),
      env,
      bunVersion: "1.3.0",
    })

    expect(report.ok).toBe(false)
    expect(report.summary).toContain("is a symlink (insecure)")
  })

  it("fails when bearer token permissions are overly permissive", async () => {
    const report = await runVerify("test-profile", {
      processRunner: makeFakeProcessRunner(),
      platformInspector: makeFakePlatformInspector(),
      fileOps: makeFakeFileOps({ tokenPerms: 0o100644 }), // world-readable
      env,
      bunVersion: "1.3.0",
    })

    expect(report.ok).toBe(false)
    expect(report.summary).toContain("overly permissive")
  })

  it("fails when project directory does not exist", async () => {
    const report = await runVerify("test-profile", {
      processRunner: makeFakeProcessRunner(),
      platformInspector: makeFakePlatformInspector(),
      fileOps: makeFakeFileOps({ projectExists: false }),
      env,
      bunVersion: "1.3.0",
    })

    expect(report.ok).toBe(false)
    expect(report.summary).toContain("Project directory not found")
  })

  it("rejects invalid profile name with traversal", async () => {
    const report = await runVerify("../etc", {
      processRunner: makeFakeProcessRunner(),
      platformInspector: makeFakePlatformInspector(),
      fileOps: makeFakeFileOps(),
      env,
    })

    expect(report.ok).toBe(false)
    expect(report.summary).toContain("Invalid profile")
  })

  it("warns rather than fails when auth_mode is none and no token exists", async () => {
    const report = await runVerify("test-profile", {
      processRunner: makeFakeProcessRunner(),
      platformInspector: makeFakePlatformInspector(),
      fileOps: makeFakeFileOps({ config: { ...validConfig, security: { ...validConfig.security, auth_mode: "none" } } }),
      env,
      bunVersion: "1.3.0",
    })

    // `ok` stays true: a missing bearer secret is the mode the operator chose, not
    // a fault. Reporting FAILED here would train people to ignore verify.
    expect(report.ok).toBe(true)
    expect(report.summary).toContain("accept unauthenticated requests")
    expect(report.summary).not.toContain("Bearer token secret not found")
  })

  it("flags a stale bearer secret that none mode will never read", async () => {
    const report = await runVerify("test-profile", {
      processRunner: makeFakeProcessRunner(),
      platformInspector: makeFakePlatformInspector(),
      fileOps: makeFakeFileOps({
        config: { ...validConfig, security: { ...validConfig.security, auth_mode: "none" } },
        bearerTokenExists: true,
      }),
      env,
      bunVersion: "1.3.0",
    })

    expect(report.ok).toBe(true)
    expect(report.summary).toContain("so it is never read")
  })

  it("still fails a bearer-token profile whose secret is missing", async () => {
    const report = await runVerify("test-profile", {
      processRunner: makeFakeProcessRunner(),
      platformInspector: makeFakePlatformInspector(),
      fileOps: makeFakeFileOps({ tokenFileMissing: true }),
      env,
      bunVersion: "1.3.0",
    })

    expect(report.ok).toBe(false)
    expect(report.summary).toContain("Bearer token secret not found")
  })

  // ── Tailnet discovery check (informational) ─────────────────────────
  //
  // The invariant this whole block protects: discovery never has authority over
  // `report.ok`. Everything below a healthy install must stay PASSED no matter what
  // the tailnet looks like, because a check that fails on "my peers are asleep"
  // trains operators to stop reading the report that tells them their bearer token
  // has bad permissions.

  const discoveryDeps = {
    processRunner: makeFakeProcessRunner(),
    platformInspector: makeFakePlatformInspector(),
    fileOps: makeFakeFileOps(),
    env,
    bunVersion: "1.3.0",
  }

  function discoveryCheck(report: { checks: readonly { name: string; status: string; message: string; detail?: string }[] }) {
    const check = report.checks.find((c) => c.name === "tailscale-discovery")
    expect(check, "expected a tailscale-discovery check").toBeDefined()
    return check!
  }

  it("reports reachable and enrolled peer counts", async () => {
    const report = await runVerify("test-profile", {
      ...discoveryDeps,
      discoverAgents: fakeDiscovery({
        agents: [
          peer({ hostname: "peer-a", ip: "100.64.0.2" }),
          peer({ hostname: "peer-b", ip: "100.64.0.3", agentId: "peer-b", enrolled: false }),
        ],
        reachableCount: 2,
        enrolledCount: 1,
        peersFound: 2,
      }),
    })

    const check = discoveryCheck(report)
    expect(check.status).toBe("pass")
    expect(check.message).toBe("Tailnet discovery: 2 peers reachable, 1 enrolled")
    expect(report.ok).toBe(true)
  })

  it("passes on a tailnet with no peers and says so plainly", async () => {
    const report = await runVerify("test-profile", {
      ...discoveryDeps,
      discoverAgents: fakeDiscovery({ agents: [], peersFound: 0 }),
    })

    const check = discoveryCheck(report)
    expect(check.status).toBe("pass")
    expect(check.message).toBe("Tailnet discovery: 0 peers reachable, 0 enrolled (no peers on the tailnet)")
    expect(check.detail).toContain("single-machine install")
    expect(report.ok).toBe(true)
    expect(report.summary).toContain("Status: PASSED")
  })

  it("passes when every peer is offline rather than failing", async () => {
    const report = await runVerify("test-profile", {
      ...discoveryDeps,
      discoverAgents: fakeDiscovery({
        agents: [
          peer({ reachable: false, enrolled: false, agentId: null, opencodeReachable: null }),
          peer({ hostname: "peer-b", ip: "100.64.0.3", reachable: false, enrolled: false, agentId: null }),
        ],
        reachableCount: 0,
        enrolledCount: 0,
        peersFound: 2,
      }),
    })

    const check = discoveryCheck(report)
    expect(check.status).toBe("pass")
    expect(check.message).toContain("0 peers reachable, 0 enrolled")
    expect(check.message).toContain("2 peer(s) on the tailnet")
    expect(check.message).toContain("none answering /health")
    expect(report.ok).toBe(true)
  })

  it("never emits a fail for discovery, whatever the tailnet says", async () => {
    const results = await Promise.all([
      runVerify("test-profile", { ...discoveryDeps, discoverAgents: fakeDiscovery({ agents: [] }) }),
      runVerify("test-profile", {
        ...discoveryDeps,
        discoverAgents: fakeDiscovery({ agents: [peer({ reachable: false, enrolled: false })], reachableCount: 0, peersFound: 1 }),
      }),
      runVerify("test-profile", {
        ...discoveryDeps,
        discoverAgents: fakeDiscovery({ agents: [peer({ enrolled: false })], enrolledCount: 0 }),
      }),
      runVerify("test-profile", {
        ...discoveryDeps,
        discoverAgents: async () => {
          throw new Error("tailscaled socket exploded")
        },
      }),
    ])

    for (const report of results) {
      expect(discoveryCheck(report).status).not.toBe("fail")
      expect(report.ok).toBe(true)
    }
  })

  it("warns when reachable peers are none of them enrolled in this profile", async () => {
    const report = await runVerify("test-profile", {
      ...discoveryDeps,
      discoverAgents: fakeDiscovery({
        agents: [peer({ agentId: "stranger", enrolled: false })],
        reachableCount: 1,
        enrolledCount: 0,
        peersFound: 1,
      }),
    })

    const check = discoveryCheck(report)
    // `warn`, not `fail`: this is a gap between what is visible and what is
    // configured, not a broken install.
    expect(check.status).toBe("warn")
    expect(report.ok).toBe(true)
    expect(report.summary).toContain("Status: PASSED")
    expect(check.detail).toContain("agents[]")
  })

  it("warns rather than crashing when the discovery probe throws", async () => {
    const report = await runVerify("test-profile", {
      ...discoveryDeps,
      discoverAgents: async () => {
        throw new Error("tailscaled socket exploded")
      },
    })

    const check = discoveryCheck(report)
    expect(check.status).toBe("warn")
    expect(check.detail).toContain("tailscaled socket exploded")
    expect(report.ok).toBe(true)
  })

  it("puts enrolled peers in the detail string, capped", async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      peer({ hostname: `peer-${i}`, ip: `100.64.0.${10 + i}`, agentId: `peer-${i}`, enrolled: true }),
    )
    const report = await runVerify("test-profile", {
      ...discoveryDeps,
      discoverAgents: fakeDiscovery({ agents: many, reachableCount: 8, enrolledCount: 8, peersFound: 8 }),
    })

    const check = discoveryCheck(report)
    // The counts are in the message; the identities are in the detail, and only five
    // of them — a long tailnet must not bury the checks below it.
    expect(check.message).toBe("Tailnet discovery: 8 peers reachable, 8 enrolled")
    expect(check.detail).toContain("Enrolled in this profile: peer-0 (100.64.0.10)")
    expect(check.detail).toContain("+3 more")
    expect(check.detail).not.toContain("peer-7")
  })

  it("states on every path that reachability is not trust", async () => {
    const reports = await Promise.all([
      runVerify("test-profile", { ...discoveryDeps, discoverAgents: fakeDiscovery({ agents: [] }) }),
      runVerify("test-profile", {
        ...discoveryDeps,
        discoverAgents: fakeDiscovery({ agents: [peer({ reachable: false, enrolled: false, agentId: null })], reachableCount: 0, peersFound: 1 }),
      }),
      runVerify("test-profile", {
        ...discoveryDeps,
        discoverAgents: fakeDiscovery({ agents: [peer({ enrolled: false })], enrolledCount: 0 }),
      }),
      runVerify("test-profile", {
        ...discoveryDeps,
        discoverAgents: async () => {
          throw new Error("boom")
        },
      }),
    ])

    for (const report of reports) {
      expect(discoveryCheck(report).detail).toContain(
        "not enrolled or trusted",
      )
    }
  })

  it("passes the enrolled ids and bridge port from config into discovery", async () => {
    let seenDeps: Record<string, unknown> | null = null
    await runVerify("test-profile", {
      ...discoveryDeps,
      fileOps: makeFakeFileOps({ config: { ...validConfig, bridge: { ...validConfig.bridge, port: 9911 } } }),
      discoverAgents: async (d) => {
        seenDeps = d as Record<string, unknown>
        return { agents: [], reachableCount: 0, enrolledCount: 0, peersFound: 0 }
      },
    })

    expect(seenDeps).not.toBeNull()
    expect(seenDeps!.enrolledAgentIds).toEqual(["peer"])
    expect(seenDeps!.bridgePort).toBe(9911)
    expect(seenDeps!.processRunner).toBeDefined()
  })

  it("keeps the discovery check out of the way of a failing install", async () => {
    const report = await runVerify("test-profile", {
      ...discoveryDeps,
      fileOps: makeFakeFileOps({ tokenFileMissing: true }),
      discoverAgents: fakeDiscovery({ agents: [peer()], reachableCount: 1, enrolledCount: 1, peersFound: 1 }),
    })

    expect(report.ok).toBe(false)
    // The real failure is still the thing the operator reads first.
    expect(discoveryCheck(report).status).toBe("pass")
    expect(report.summary.indexOf("Bearer token secret not found")).toBeLessThan(
      report.summary.indexOf("Tailnet discovery"),
    )
  })

  // ── Herdr workspace backend checks (informational) ─────────────────
  describe("Herdr workspace backend checks (informational)", () => {
    const forkSchema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "Herdr IPC API (fork)",
      definitions: {
        "pane.claim_input": { type: "object" },
        "pane.release_input": { type: "object" },
        Pane: {
          type: "object",
          properties: {
            id: { type: "string" },
            role: { type: "string" },
          },
        },
      },
    }

    const stockSchema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "Herdr IPC API (stock)",
      definitions: {
        "pane.split": { type: "object" },
        Pane: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
      },
    }

    it("reports herdr: not found when Herdr binary is absent", async () => {
      const report = await runVerify("test-profile", {
        processRunner: makeFakeProcessRunner({ herdrInstalled: false }),
        platformInspector: makeFakePlatformInspector(),
        fileOps: makeFakeFileOps(),
        env,
        bunVersion: "1.3.14",
      })

      const check = report.checks.find((c) => c.name === "herdr")
      expect(check).toBeDefined()
      expect(check!.status).toBe("pass")
      expect(check!.message).toBe("herdr: not found")
      expect(report.summary).toContain("herdr: not found")
      expect(report.ok).toBe(true)
    })

    it("reports both flags yes when Herdr exposes fork capabilities in schema", async () => {
      const report = await runVerify("test-profile", {
        processRunner: makeFakeProcessRunner({
          herdrInstalled: true,
          herdrSchemaStdout: JSON.stringify(forkSchema),
        }),
        platformInspector: makeFakePlatformInspector(),
        fileOps: makeFakeFileOps(),
        env,
        bunVersion: "1.3.14",
      })

      const check = report.checks.find((c) => c.name === "herdr")
      expect(check).toBeDefined()
      expect(check!.status).toBe("pass")
      expect(check!.message).toBe("herdr: found (fork capabilities: input-fencing=yes, first-class-role=yes)")
      expect(report.summary).toContain("herdr: found (fork capabilities: input-fencing=yes, first-class-role=yes)")
      expect(report.ok).toBe(true)
    })

    it("reports both flags no for stock Herdr without fork capabilities", async () => {
      const report = await runVerify("test-profile", {
        processRunner: makeFakeProcessRunner({
          herdrInstalled: true,
          herdrSchemaStdout: JSON.stringify(stockSchema),
        }),
        platformInspector: makeFakePlatformInspector(),
        fileOps: makeFakeFileOps(),
        env,
        bunVersion: "1.3.14",
      })

      const check = report.checks.find((c) => c.name === "herdr")
      expect(check).toBeDefined()
      expect(check!.status).toBe("pass")
      expect(check!.message).toBe("herdr: found (fork capabilities: input-fencing=no, first-class-role=no)")
      expect(report.summary).toContain("herdr: found (fork capabilities: input-fencing=no, first-class-role=no)")
      expect(report.ok).toBe(true)
    })

    it("reports flags unknown when herdr api schema output is malformed", async () => {
      const report = await runVerify("test-profile", {
        processRunner: makeFakeProcessRunner({
          herdrInstalled: true,
          herdrSchemaStdout: "{ malformed json",
        }),
        platformInspector: makeFakePlatformInspector(),
        fileOps: makeFakeFileOps(),
        env,
        bunVersion: "1.3.14",
      })

      const check = report.checks.find((c) => c.name === "herdr")
      expect(check).toBeDefined()
      expect(check!.status).toBe("pass")
      expect(check!.message).toBe("herdr: found (fork capabilities: input-fencing=unknown, first-class-role=unknown)")
      expect(report.summary).toContain("herdr: found (fork capabilities: input-fencing=unknown, first-class-role=unknown)")
      expect(report.ok).toBe(true)
    })

    it("reports flags unknown when herdr api schema exits with nonzero code", async () => {
      const report = await runVerify("test-profile", {
        processRunner: makeFakeProcessRunner({
          herdrInstalled: true,
          herdrSchemaExitCode: 1,
          herdrSchemaStderr: "daemon connection refused",
        }),
        platformInspector: makeFakePlatformInspector(),
        fileOps: makeFakeFileOps(),
        env,
        bunVersion: "1.3.14",
      })

      const check = report.checks.find((c) => c.name === "herdr")
      expect(check).toBeDefined()
      expect(check!.status).toBe("pass")
      expect(check!.message).toBe("herdr: found (fork capabilities: input-fencing=unknown, first-class-role=unknown)")
      expect(report.summary).toContain("herdr: found (fork capabilities: input-fencing=unknown, first-class-role=unknown)")
      expect(report.ok).toBe(true)
    })

    it("reports partial fork capability flags (input-fencing=yes, first-class-role=no)", async () => {
      const fencingOnlySchema = {
        $schema: "http://json-schema.org/draft-07/schema#",
        definitions: {
          "pane.claim_input": { type: "object" },
          "pane.release_input": { type: "object" },
          Pane: {
            type: "object",
            properties: { id: { type: "string" } },
          },
        },
      }

      const report = await runVerify("test-profile", {
        processRunner: makeFakeProcessRunner({
          herdrInstalled: true,
          herdrSchemaStdout: JSON.stringify(fencingOnlySchema),
        }),
        platformInspector: makeFakePlatformInspector(),
        fileOps: makeFakeFileOps(),
        env,
        bunVersion: "1.3.14",
      })

      const check = report.checks.find((c) => c.name === "herdr")
      expect(check).toBeDefined()
      expect(check!.status).toBe("pass")
      expect(check!.message).toBe("herdr: found (fork capabilities: input-fencing=yes, first-class-role=no)")
      expect(report.summary).toContain("herdr: found (fork capabilities: input-fencing=yes, first-class-role=no)")
      expect(report.ok).toBe(true)
    })
  })
})
