import { describe, expect, it } from "vitest"
import type {
  ProcessOptions,
  ProcessResult,
  ProcessRunner,
  ProbeOptions,
  ProbeResult,
  HttpProbe,
} from "../../../src/host/types.js"
import {
  startProfile,
  statusProfile,
  type TmuxProfile,
  type StartProfileResult,
  type StatusProfileResult,
  type TmuxDeps,
} from "../../../src/host/tmux.js"

// ── Test fakes ──────────────────────────────────────────────────────────

/**
 * Sequence-based ProcessRunner that maps argv key → result.
 * Supports a fallback function for dynamic behavior.
 */
class SequenceProcessRunner implements ProcessRunner {
  public calls: Array<{ argv: readonly string[]; options?: ProcessOptions }> = []
  private readonly resultMap: Map<string, ProcessResult>
  private readonly fallback?: (argv: readonly string[]) => ProcessResult

  constructor(
    resultMap: Map<string, ProcessResult>,
    fallback?: (argv: readonly string[]) => ProcessResult,
  ) {
    this.resultMap = resultMap
    this.fallback = fallback
  }

  async exec(argv: readonly string[], options?: ProcessOptions): Promise<ProcessResult> {
    this.calls.push({ argv, options })
    const key = argv.join(" ")
    const mapped = this.resultMap.get(key)
    if (mapped !== undefined) return mapped
    if (this.fallback !== undefined) return this.fallback(argv)
    return { exitCode: 1, stdout: "", stderr: "unmapped command" }
  }
}

/**
 * Configurable HttpProbe that returns a fixed result.
 */
class FakeHttpProbe implements HttpProbe {
  public calls: Array<{ url: string; options?: ProbeOptions }> = []
  private readonly result: ProbeResult
  private readonly fallback?: (url: string, options?: ProbeOptions) => ProbeResult

  constructor(
    result: ProbeResult,
    fallback?: (url: string, options?: ProbeOptions) => ProbeResult,
  ) {
    this.result = result
    this.fallback = fallback
  }

  async probe(url: string, options?: ProbeOptions): Promise<ProbeResult> {
    this.calls.push({ url, options })
    if (this.fallback !== undefined) return this.fallback(url, options)
    return this.result
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function successResult(stdout = ""): ProcessResult {
  return { exitCode: 0, stdout, stderr: "" }
}

function failureResult(stderr = "command failed"): ProcessResult {
  return { exitCode: 1, stdout: "", stderr }
}

function okProbe(body = '{"status":"ok"}'): ProbeResult {
  return { status: 200, ok: true, body }
}

function failProbe(status = 0): ProbeResult {
  return { status, ok: false, body: "" }
}

function entries(arr: Array<[string, ProcessResult]>): Map<string, ProcessResult> {
  return new Map(arr)
}

function testProfile(overrides?: Partial<TmuxProfile>): TmuxProfile {
  return {
    name: "test-profile",
    bridgePort: 8787,
    opencodePort: 4096,
    sessionName: "aibridge-test-profile",
    ...overrides,
  }
}

function testDeps(overrides?: {
  runner?: ProcessRunner
  probe?: HttpProbe
  env?: Record<string, string | undefined>
}): TmuxDeps {
  return {
    processRunner: overrides?.runner ?? new SequenceProcessRunner(entries([])),
    httpProbe: overrides?.probe ?? new FakeHttpProbe(okProbe()),
    env: overrides?.env ?? {},
  }
}

// ── startProfile ────────────────────────────────────────────────────────

describe("startProfile", () => {
  it("returns already_running when tmux session exists", async () => {
    const runner = new SequenceProcessRunner(
      entries([
        [
          "tmux has-session -t aibridge-test-profile",
          successResult(""),
        ],
      ]),
    )
    const deps = testDeps({ runner })
    const profile = testProfile()

    const result = await startProfile(deps, profile)

    expect(result.kind).toBe("already_running")
    expect(result.sessionName).toBe("aibridge-test-profile")
    // Should NOT have attempted to create windows
    expect(runner.calls).toHaveLength(1)
  })

  it("starts two tmux windows when no session exists", async () => {
    const runner = new SequenceProcessRunner(
      entries([
        [
          "tmux has-session -t aibridge-test-profile",
          failureResult("no server running"),
        ],
        [
          "tmux new-session -d -s aibridge-test-profile -n opencode aibr _opencode --profile test-profile",
          successResult(""),
        ],
        [
          "tmux new-window -t aibridge-test-profile -n bridge aibr serve --profile test-profile",
          successResult(""),
        ],
      ]),
    )
    const deps = testDeps({ runner })
    const profile = testProfile()

    const result = await startProfile(deps, profile)

    expect(result.kind).toBe("started")
    expect(result.sessionName).toBe("aibridge-test-profile")
    expect(runner.calls).toHaveLength(3)
  })

  it("opencode window binds to 127.0.0.1 via env, never in argv", async () => {
    const runner = new SequenceProcessRunner(
      entries([
        ["tmux has-session -t aibridge-test-profile", failureResult()],
        [
          "tmux new-session -d -s aibridge-test-profile -n opencode aibr _opencode --profile test-profile",
          successResult(),
        ],
        [
          "tmux new-window -t aibridge-test-profile -n bridge aibr serve --profile test-profile",
          successResult(),
        ],
      ]),
    )
    const deps = testDeps({ runner })
    const profile = testProfile()

    await startProfile(deps, profile)

    // The opencode new-session call should have env with bind address
    const ocCall = runner.calls[1]!
    expect(ocCall.argv).not.toContain("0.0.0.0")
    expect(ocCall.argv).not.toContain("--hostname")
    // Env should include OPENCODE_HOSTNAME=127.0.0.1
    expect(ocCall.options?.env?.OPENCODE_HOSTNAME).toBe("127.0.0.1")
  })

  it("never places secrets in argv — secrets go via env only", async () => {
    const runner = new SequenceProcessRunner(
      entries([
        ["tmux has-session -t aibridge-test-profile", failureResult()],
        [
          "tmux new-session -d -s aibridge-test-profile -n opencode aibr _opencode --profile test-profile",
          successResult(),
        ],
        [
          "tmux new-window -t aibridge-test-profile -n bridge aibr serve --profile test-profile",
          successResult(),
        ],
      ]),
    )
    const deps = testDeps({
      runner,
      env: {
        OPENCODE_SERVER_PASSWORD: "super-secret-123",
        AIBRIDGE_AGENT_ID: "test-agent",
      },
    })
    const profile = testProfile()

    await startProfile(deps, profile)

    // Inspect every argv array for secret leakage
    for (const call of runner.calls) {
      const argvStr = call.argv.join(" ")
      expect(argvStr).not.toContain("super-secret-123")
      expect(argvStr).not.toContain("OPENCODE_SERVER_PASSWORD")
    }

    // Secrets should be in the env of the tmux window commands
    const ocCall = runner.calls[1]!
    expect(ocCall.options?.env?.OPENCODE_SERVER_PASSWORD).toBe("super-secret-123")
    const bridgeCall = runner.calls[2]!
    expect(bridgeCall.options?.env?.AIBRIDGE_AGENT_ID).toBe("test-agent")
  })

  it("propagates AIBRIDGE_CONFIG env to bridge window", async () => {
    const runner = new SequenceProcessRunner(
      entries([
        ["tmux has-session -t aibridge-test-profile", failureResult()],
        [
          "tmux new-session -d -s aibridge-test-profile -n opencode aibr _opencode --profile test-profile",
          successResult(),
        ],
        [
          "tmux new-window -t aibridge-test-profile -n bridge aibr serve --profile test-profile",
          successResult(),
        ],
      ]),
    )
    const deps = testDeps({
      runner,
      env: { AIBRIDGE_CONFIG: "/home/user/.config/aibridge/test-profile/config.json" },
    })
    const profile = testProfile()

    await startProfile(deps, profile)

    const bridgeCall = runner.calls[2]!
    expect(bridgeCall.options?.env?.AIBRIDGE_CONFIG).toBe(
      "/home/user/.config/aibridge/test-profile/config.json",
    )
  })

  it("returns tmux_error when new-session fails", async () => {
    const runner = new SequenceProcessRunner(
      entries([
        ["tmux has-session -t aibridge-test-profile", failureResult()],
        [
          "tmux new-session -d -s aibridge-test-profile -n opencode aibr _opencode --profile test-profile",
          failureResult("sessions should be nested"),
        ],
      ]),
    )
    const deps = testDeps({ runner })
    const profile = testProfile()

    const result = await startProfile(deps, profile)

    expect(result.kind).toBe("tmux_error")
    expect(result.sessionName).toBe("aibridge-test-profile")
    if (result.kind === "tmux_error") {
      expect(result.stderr).toContain("sessions should be nested")
    }
  })

  it("returns tmux_error when new-window fails", async () => {
    const runner = new SequenceProcessRunner(
      entries([
        ["tmux has-session -t aibridge-test-profile", failureResult()],
        [
          "tmux new-session -d -s aibridge-test-profile -n opencode aibr _opencode --profile test-profile",
          successResult(),
        ],
        [
          "tmux new-window -t aibridge-test-profile -n bridge aibr serve --profile test-profile",
          failureResult("can't find window: bridge"),
        ],
      ]),
    )
    const deps = testDeps({ runner })
    const profile = testProfile()

    const result = await startProfile(deps, profile)

    expect(result.kind).toBe("tmux_error")
    if (result.kind === "tmux_error") {
      expect(result.stderr).toContain("can't find window")
    }
  })

  it("uses custom session name from profile", async () => {
    const runner = new SequenceProcessRunner(
      entries([
        ["tmux has-session -t custom-session", failureResult()],
        [
          "tmux new-session -d -s custom-session -n opencode aibr _opencode --profile my-proj",
          successResult(),
        ],
        [
          "tmux new-window -t custom-session -n bridge aibr serve --profile my-proj",
          successResult(),
        ],
      ]),
    )
    const deps = testDeps({ runner })
    const profile = testProfile({ name: "my-proj", sessionName: "custom-session" })

    const result = await startProfile(deps, profile)

    expect(result.kind).toBe("started")
    expect(result.sessionName).toBe("custom-session")
  })
})

// ── statusProfile ───────────────────────────────────────────────────────

describe("statusProfile", () => {
  it("returns session_missing when tmux session does not exist", async () => {
    const runner = new SequenceProcessRunner(
      entries([
        [
          "tmux has-session -t aibridge-test-profile",
          failureResult("no server running"),
        ],
      ]),
    )
    const probe = new FakeHttpProbe(okProbe())
    const deps = testDeps({ runner, probe })
    const profile = testProfile()

    const result = await statusProfile(deps, profile)

    expect(result.kind).toBe("session_missing")
    expect(result.sessionName).toBe("aibridge-test-profile")
    // Should NOT probe HTTP when session is missing
    expect(probe.calls).toHaveLength(0)
  })

  it("returns bridge_unavailable when session exists but probe fails", async () => {
    const runner = new SequenceProcessRunner(
      entries([
        [
          "tmux has-session -t aibridge-test-profile",
          successResult(""),
        ],
      ]),
    )
    const probe = new FakeHttpProbe(failProbe(0))
    const deps = testDeps({ runner, probe })
    const profile = testProfile()

    const result = await statusProfile(deps, profile)

    expect(result.kind).toBe("bridge_unavailable")
    expect(result.sessionName).toBe("aibridge-test-profile")
    expect(probe.calls).toHaveLength(1)
    expect(probe.calls[0]!.url).toBe("http://127.0.0.1:8787/health")
  })

  it("returns healthy when session exists and bridge responds ok", async () => {
    const runner = new SequenceProcessRunner(
      entries([
        [
          "tmux has-session -t aibridge-test-profile",
          successResult(""),
        ],
      ]),
    )
    const probe = new FakeHttpProbe(okProbe('{"status":"ok","uptime":123}'))
    const deps = testDeps({ runner, probe })
    const profile = testProfile()

    const result = await statusProfile(deps, profile)

    expect(result.kind).toBe("healthy")
    expect(result.sessionName).toBe("aibridge-test-profile")
    if (result.kind === "healthy") {
      expect(result.body).toContain('"status":"ok"')
    }
  })

  it("probes http://127.0.0.1:<bridgePort>/health", async () => {
    const runner = new SequenceProcessRunner(
      entries([
        ["tmux has-session -t aibridge-my-proj", successResult()],
      ]),
    )
    const probe = new FakeHttpProbe(okProbe())
    const deps = testDeps({ runner, probe })
    const profile = testProfile({ name: "my-proj", bridgePort: 9999, sessionName: "aibridge-my-proj" })

    await statusProfile(deps, profile)

    expect(probe.calls).toHaveLength(1)
    expect(probe.calls[0]!.url).toBe("http://127.0.0.1:9999/health")
  })

  it("returns bridge_unavailable when probe returns non-ok status", async () => {
    const runner = new SequenceProcessRunner(
      entries([
        ["tmux has-session -t aibridge-test-profile", successResult()],
      ]),
    )
    const probe = new FakeHttpProbe({ status: 503, ok: false, body: '{"status":"degraded"}' })
    const deps = testDeps({ runner, probe })
    const profile = testProfile()

    const result = await statusProfile(deps, profile)

    expect(result.kind).toBe("bridge_unavailable")
    if (result.kind === "bridge_unavailable") {
      expect(result.probeStatus).toBe(503)
    }
  })

  it("uses custom session name for tmux check", async () => {
    const runner = new SequenceProcessRunner(
      entries([
        ["tmux has-session -t custom-session", failureResult()],
      ]),
    )
    const probe = new FakeHttpProbe(okProbe())
    const deps = testDeps({ runner, probe })
    const profile = testProfile({ sessionName: "custom-session" })

    const result = await statusProfile(deps, profile)

    expect(result.kind).toBe("session_missing")
    expect(result.sessionName).toBe("custom-session")
  })
})
