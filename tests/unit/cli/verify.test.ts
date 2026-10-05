import { describe, expect, it } from "vitest"
import { runVerify } from "../../../src/cli/verify.js"
import type { PlatformInspector, ProcessRunner } from "../../../src/host/types.js"

function makeFakeProcessRunner(params?: {
  tmuxInstalled?: boolean
  opencodeInstalled?: boolean
  tailscaleInstalled?: boolean
  tailscaleIp?: string
  tailscaleBackend?: string
}): ProcessRunner {
  const tmux = params?.tmuxInstalled ?? true
  const opencode = params?.opencodeInstalled ?? true
  const tailscale = params?.tailscaleInstalled ?? true
  const tsIp = params?.tailscaleIp ?? "100.64.0.1"
  const tsBackend = params?.tailscaleBackend ?? "Running"

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
    pathExists: async (_path: string) => {
      return overrides?.projectExists ?? true
    },
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
})
