import { describe, expect, it } from "vitest"
import {
  nodeRoleFromConfig,
  parseNodeRole,
  parseRuntimeKind,
  prereqsFor,
} from "../../../src/host/node-role.js"
import { DEFAULT_PREREQS, planPreflight, runPreflight } from "../../../src/host/preflight.js"
import type { ProcessRunner } from "../../../src/host/types.js"

describe("node role", () => {
  it("prereqsFor maps each role and runtime to its binaries", () => {
    expect(prereqsFor("worker", "opencode")).toEqual(["tmux", "opencode", "tailscale"])
    expect(prereqsFor("worker", "claude")).toEqual(["tmux", "claude", "tailscale"])
    expect(prereqsFor("orchestrator", null)).toEqual(["claude", "tailscale"])
    expect(prereqsFor("both", "opencode")).toEqual(["tmux", "opencode", "claude", "tailscale"])
    expect(prereqsFor("both", "claude")).toEqual(["tmux", "claude", "tailscale"])
  })

  it("parses roles and runtimes, including short forms, and rejects the rest", () => {
    expect(parseNodeRole("Worker")).toBe("worker")
    expect(parseNodeRole("o")).toBe("orchestrator")
    expect(parseNodeRole("b")).toBe("both")
    expect(parseNodeRole("manager")).toBeNull()
    expect(parseNodeRole(42)).toBeNull()
    expect(parseRuntimeKind("claude-code")).toBe("claude")
    expect(parseRuntimeKind("OpenCode")).toBe("opencode")
    expect(parseRuntimeKind("codex")).toBeNull()
  })

  it("nodeRoleFromConfig reads old profiles as worker + opencode", () => {
    expect(nodeRoleFromConfig({})).toEqual({ role: "worker", runtime: "opencode" })
    expect(nodeRoleFromConfig(null)).toEqual({ role: "worker", runtime: "opencode" })
    expect(nodeRoleFromConfig({ role: "orchestrator", runtime: { kind: "claude" } })).toEqual({
      role: "orchestrator",
      runtime: null,
    })
    expect(nodeRoleFromConfig({ role: "both", runtime: { kind: "claude" } })).toEqual({
      role: "both",
      runtime: "claude",
    })
    expect(nodeRoleFromConfig({ role: "bogus", runtime: { kind: "bogus" } })).toEqual({
      role: "worker",
      runtime: "opencode",
    })
  })
})

describe("role-aware preflight", () => {
  const inspector = { inspect: () => ({ platform: "darwin", arch: "arm64", isTTY: true }) }

  function runner(installed: readonly string[], calls: string[]): ProcessRunner {
    return {
      async exec(argv) {
        calls.push(argv.join(" "))
        if (argv[0] === "which") {
          return { exitCode: installed.includes(argv[1] ?? "") ? 0 : 1, stdout: "", stderr: "" }
        }
        return { exitCode: 1, stdout: "", stderr: "" }
      },
    }
  }

  it("defaults to the released worker + opencode list", async () => {
    expect(DEFAULT_PREREQS).toEqual(["tmux", "opencode", "tailscale"])
    const calls: string[] = []
    const result = await planPreflight({ platformInspector: inspector, processRunner: runner([], calls) })
    expect(result.checks.map((c) => c.name)).toEqual(["tmux", "opencode", "tailscale"])
  })

  it("does not block a Claude-only orchestrator on opencode or tmux", async () => {
    const calls: string[] = []
    const result = await planPreflight({
      platformInspector: inspector,
      processRunner: runner(["claude", "tailscale"], calls),
      prereqs: prereqsFor("orchestrator", null),
    })

    expect(result.ok).toBe(true)
    expect(result.checks.map((c) => c.name)).toEqual(["claude", "tailscale"])
    expect(calls).not.toContain("which opencode")
    expect(calls).not.toContain("which tmux")
  })

  it("reports a missing claude for a Claude worker without offering an install command", async () => {
    const calls: string[] = []
    const result = await runPreflight({
      platformInspector: inspector,
      processRunner: runner(["tmux", "tailscale"], calls),
      prereqs: prereqsFor("worker", "claude"),
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((c) => c.name === "claude")).toEqual({
      name: "claude",
      status: "missing",
      installCmd: null,
      error: null,
    })
  })
})
