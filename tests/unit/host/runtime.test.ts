import { describe, expect, it } from "vitest"
import type {
  HttpProbe,
  PlatformInspector,
  PlatformInfo,
  ProbeOptions,
  ProbeResult,
  ProcessOptions,
  ProcessResult,
  ProcessRunner,
  Sleeper,
} from "../../../src/host/types.js"
import {
  BunPlatformInspector,
  BunProcessRunner,
  BunSleeper,
} from "../../../src/host/runtime.js"
import {
  FakeHttpProbe,
  FakePlatformInspector,
  FakeProcessRunner,
  FakeSleeper,
} from "./fixtures.js"

// ── ProcessRunner tests ────────────────────────────────────────────────

describe("ProcessRunner", () => {
  describe("FakeProcessRunner (manual fake)", () => {
    it("returns the configured result", async () => {
      const expected: ProcessResult = { exitCode: 0, stdout: "hello\n", stderr: "" }
      const runner = new FakeProcessRunner(expected)

      const result = await runner.exec(["echo", "hello"])

      expect(result).toEqual(expected)
    })

    it("records every call with argv and options", async () => {
      const runner = new FakeProcessRunner({ exitCode: 0, stdout: "", stderr: "" })
      const opts: ProcessOptions = { cwd: "/tmp", timeoutMs: 5000 }

      await runner.exec(["ls", "-la"], opts)

      expect(runner.calls).toHaveLength(1)
      expect(runner.calls[0]?.argv).toEqual(["ls", "-la"])
      expect(runner.calls[0]?.options).toBe(opts)
    })

    it("preserves argv as individual strings, never a shell command", async () => {
      const runner = new FakeProcessRunner({ exitCode: 0, stdout: "", stderr: "" })

      await runner.exec(["git", "status", "--porcelain"])

      expect(runner.calls[0]?.argv).toEqual(["git", "status", "--porcelain"])
      expect(runner.calls[0]?.argv).toHaveLength(3)
    })
  })

  describe("BunProcessRunner", () => {
    it("executes a real process and normalizes output", async () => {
      const runner = new BunProcessRunner()

      const result = await runner.exec(["echo", "hello world"])

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("hello world")
      expect(result.stderr).toBe("")
    })

    it("captures stderr separately from stdout", async () => {
      const runner = new BunProcessRunner()

      const result = await runner.exec(["node", "-e", "process.stderr.write('err-msg')"])

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain("err-msg")
    })

    it("returns non-zero exit code for failing commands", async () => {
      const runner = new BunProcessRunner()

      const result = await runner.exec(["node", "-e", "process.exit(42)"])

      expect(result.exitCode).toBe(42)
    })

    it("trims trailing whitespace from output", async () => {
      const runner = new BunProcessRunner()

      const result = await runner.exec(["echo", "trimmed"])

      expect(result.stdout).toBe("trimmed")
      expect(result.stdout.endsWith("\n")).toBe(false)
    })

    it("respects the cwd option", async () => {
      const runner = new BunProcessRunner()

      const result = await runner.exec(["pwd"], { cwd: "/tmp" })

      expect(result.stdout).toContain("/tmp")
    })

    it("respects the timeout option and kills on expiry", async () => {
      const runner = new BunProcessRunner()

      const result = await runner.exec(
        ["node", "-e", "setTimeout(() => {}, 10000)"],
        { timeoutMs: 100 },
      )

      expect(result.exitCode === null || result.exitCode !== 0).toBe(true)
    })

    it("does not invoke a shell", async () => {
      const runner = new BunProcessRunner()

      // If a shell were invoked, "$SHELL" would expand.
      const result = await runner.exec(["echo", "$SHELL"])

      expect(result.stdout).toBe("$SHELL")
    })

    it("passes env variables to the child process", async () => {
      const runner = new BunProcessRunner()

      const result = await runner.exec(
        ["node", "-e", "process.stdout.write(process.env.AIBRIDGE_TEST_VAR ?? 'unset')"],
        { env: { AIBRIDGE_TEST_VAR: "injected" } },
      )

      expect(result.stdout).toBe("injected")
    })

    it("returns empty exitCode when process errors", async () => {
      const runner = new BunProcessRunner()

      // Non-existent command should produce exitCode null or non-zero
      const result = await runner.exec(["/nonexistent-binary-xyz"])

      expect(result.exitCode === null || result.exitCode !== 0).toBe(true)
    })
  })
})

// ── PlatformInspector tests ────────────────────────────────────────────

describe("PlatformInspector", () => {
  describe("FakePlatformInspector", () => {
    it("returns the configured platform info", () => {
      const info: PlatformInfo = { platform: "linux", arch: "arm64", isTTY: false }
      const inspector = new FakePlatformInspector(info)

      expect(inspector.inspect()).toEqual(info)
    })
  })

  describe("BunPlatformInspector", () => {
    it("reports a valid platform string", () => {
      const inspector = new BunPlatformInspector()
      const info = inspector.inspect()

      expect(["linux", "darwin", "win32"]).toContain(info.platform)
    })

    it("reports a valid architecture string", () => {
      const inspector = new BunPlatformInspector()
      const info = inspector.inspect()

      expect(["x64", "arm64", "ia32", "arm"]).toContain(info.arch)
    })

    it("reports isTTY as a boolean", () => {
      const inspector = new BunPlatformInspector()
      const info = inspector.inspect()

      expect(typeof info.isTTY).toBe("boolean")
    })

    it("returns a frozen PlatformInfo object", () => {
      const inspector = new BunPlatformInspector()
      const info = inspector.inspect()

      expect(Object.isFrozen(info)).toBe(true)
    })
  })
})

// ── HttpProbe tests ────────────────────────────────────────────────────

describe("HttpProbe", () => {
  it("returns the configured probe result", async () => {
    const expected: ProbeResult = { status: 200, ok: true, body: '{"status":"ok"}' }
    const probe = new FakeHttpProbe(expected)

    const result = await probe.probe("http://localhost:8787/health")

    expect(result).toEqual(expected)
  })

  it("records the URL and options", async () => {
    const probe = new FakeHttpProbe({ status: 200, ok: true, body: "" })
    const opts: ProbeOptions = { method: "HEAD", timeoutMs: 1000 }

    await probe.probe("http://example.com", opts)

    expect(probe.calls).toHaveLength(1)
    expect(probe.calls[0]?.url).toBe("http://example.com")
    expect(probe.calls[0]?.options).toBe(opts)
  })

  it("distinguishes ok and not-ok responses", async () => {
    const okProbe = new FakeHttpProbe({ status: 200, ok: true, body: "" })
    const failProbe = new FakeHttpProbe({ status: 503, ok: false, body: "unavailable" })

    expect((await okProbe.probe("http://a")).ok).toBe(true)
    expect((await failProbe.probe("http://b")).ok).toBe(false)
    expect((await failProbe.probe("http://b")).status).toBe(503)
  })
})

// ── Sleeper tests ──────────────────────────────────────────────────────

describe("Sleeper", () => {
  describe("FakeSleeper", () => {
    it("records sleep durations", async () => {
      const sleeper = new FakeSleeper()

      await sleeper.sleep(100)
      await sleeper.sleep(250)

      expect(sleeper.sleptMs).toEqual([100, 250])
    })

    it("resolves immediately (no real delay)", async () => {
      const sleeper = new FakeSleeper()
      const start = Date.now()

      await sleeper.sleep(10_000)

      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(1000)
    })
  })

  describe("BunSleeper", () => {
    it("sleeps for approximately the requested duration", async () => {
      const sleeper = new BunSleeper()
      const start = Date.now()

      await sleeper.sleep(50)

      const elapsed = Date.now() - start
      expect(elapsed).toBeGreaterThanOrEqual(40)
      expect(elapsed).toBeLessThan(200)
    })

    it("resolves to void (no return value)", async () => {
      const sleeper = new BunSleeper()

      const result = await sleeper.sleep(1)

      expect(result).toBeUndefined()
    })
  })
})

// ── Type-level checks ──────────────────────────────────────────────────

describe("Type compatibility", () => {
  it("fakes satisfy their interface contracts at compile time", () => {
    const runner: ProcessRunner = new FakeProcessRunner({ exitCode: 0, stdout: "", stderr: "" })
    const inspector: PlatformInspector = new FakePlatformInspector({
      platform: "linux",
      arch: "x64",
      isTTY: true,
    })
    const probe: HttpProbe = new FakeHttpProbe({ status: 200, ok: true, body: "" })
    const sleeper: Sleeper = new FakeSleeper()

    expect(runner).toBeDefined()
    expect(inspector).toBeDefined()
    expect(probe).toBeDefined()
    expect(sleeper).toBeDefined()
  })

  it("BunProcessRunner satisfies ProcessRunner", () => {
    const runner: ProcessRunner = new BunProcessRunner()
    expect(runner).toBeDefined()
  })

  it("BunPlatformInspector satisfies PlatformInspector", () => {
    const inspector: PlatformInspector = new BunPlatformInspector()
    expect(inspector).toBeDefined()
  })

  it("BunSleeper satisfies Sleeper", () => {
    const sleeper: Sleeper = new BunSleeper()
    expect(sleeper).toBeDefined()
  })

})
