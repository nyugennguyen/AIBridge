import { describe, expect, it } from "vitest"
import type { ProcessRunner, HttpProbe, ProcessOptions, ProcessResult, ProbeOptions, ProbeResult } from "../../../src/host/types.js"
import {
  BRAND_COLORS,
  isTailscaleCgnatIp,
  probePortAvailability,
  probeNetwork,
  renderNetworkProbe,
  generateBearerToken,
  generateCsprngToken,
  isValidBearerToken,
  copyToClipboard,
  getDefaultSecurityCheckboxes,
  DEFAULT_SECURITY_INVARIANTS,
  renderTokenWidget,
  normalizeProjectPath,
  validateProjectPath,
  isSubpathContained,
  enforceFailClosedSubpath,
  detectProjectDirectories,
  toggleProjectDirectory,
  addProjectDirectory,
  renderDirectorySelector,
  probeRuntimes,
  renderRuntimeProbe,
  FAIL_CLOSED_SUBPATH_NOTICE,
} from "../../../src/cli/setup-step-widgets.js"

class FakeProcessRunner implements ProcessRunner {
  private readonly responses: Record<string, ProcessResult>

  constructor(responses: Record<string, ProcessResult> = {}) {
    this.responses = responses
  }

  async exec(argv: readonly string[], _options?: ProcessOptions): Promise<ProcessResult> {
    const key = argv.join(" ")
    const matched = this.responses[key]
    if (matched) return matched

    return { exitCode: 1, stdout: "", stderr: `command not found: ${key}` }
  }
}

class FakeHttpProbe implements HttpProbe {
  private readonly urlMap: Record<string, ProbeResult>

  constructor(urlMap: Record<string, ProbeResult> = {}) {
    this.urlMap = urlMap
  }

  async probe(url: string, _options?: ProbeOptions): Promise<ProbeResult> {
    const found = this.urlMap[url]
    if (found) return found
    return { ok: false, status: 503, body: "unavailable" }
  }
}

describe("Network Probe Widget", () => {
  describe("isTailscaleCgnatIp", () => {
    it("recognizes valid CGNAT IP addresses (100.64.0.0/10)", () => {
      expect(isTailscaleCgnatIp("100.64.0.1")).toBe(true)
      expect(isTailscaleCgnatIp("100.64.42.18")).toBe(true)
      expect(isTailscaleCgnatIp("100.100.100.100")).toBe(true)
      expect(isTailscaleCgnatIp("100.127.255.254")).toBe(true)
    })

    it("rejects non-CGNAT IP addresses", () => {
      expect(isTailscaleCgnatIp("192.168.1.1")).toBe(false)
      expect(isTailscaleCgnatIp("10.0.0.1")).toBe(false)
      expect(isTailscaleCgnatIp("100.63.255.255")).toBe(false)
      expect(isTailscaleCgnatIp("100.128.0.1")).toBe(false)
      expect(isTailscaleCgnatIp("invalid")).toBe(false)
      expect(isTailscaleCgnatIp("")).toBe(false)
    })
  })

  describe("probePortAvailability", () => {
    it("returns false for out-of-range port numbers", async () => {
      expect(await probePortAvailability(0)).toBe(false)
      expect(await probePortAvailability(70000)).toBe(false)
      expect(await probePortAvailability(-1)).toBe(false)
    })

    it("probes an unallocated high port successfully", async () => {
      // Ephemeral high port
      const avail = await probePortAvailability(59482)
      expect(typeof avail).toBe("boolean")
    })
  })

  describe("probeNetwork", () => {
    it("returns status objects with status and descriptive labels", async () => {
      const runner = new FakeProcessRunner({
        "tailscale ip -4": { exitCode: 0, stdout: "100.64.42.18\n", stderr: "" },
      })

      const result = await probeNetwork({
        processRunner: runner,
        checkSocket: async () => true,
        checkPort: async () => true,
        socketPath: "/var/run/tailscaled.sock",
      })

      expect(result.socket.status).toBe("ok")
      expect(result.socket.label).toBe("Tailscale Daemon (tailscaled)")
      expect(result.socket.exists).toBe(true)
      expect(result.socket.detail).toContain("/var/run/tailscaled.sock")

      expect(result.ip.status).toBe("ok")
      expect(result.ip.label).toBe("Tailscale Mesh IPv4 Coordinate")
      expect(result.ip.ipAddress).toBe("100.64.42.18")
      expect(result.ip.isCgnat).toBe(true)

      expect(result.ports.allAvailable).toBe(true)
      expect(result.ports.router.status).toBe("ok")
      expect(result.ports.router.port).toBe(4095)
      expect(result.ports.opencode.status).toBe("ok")
      expect(result.ports.opencode.port).toBe(4096)
      expect(result.ports.bridge.status).toBe("ok")
      expect(result.ports.bridge.port).toBe(8787)
    })

    it("handles socket missing, non-CGNAT IP, and port collisions", async () => {
      const runner = new FakeProcessRunner({
        "tailscale ip -4": { exitCode: 0, stdout: "192.168.1.50\n", stderr: "" },
      })

      const result = await probeNetwork({
        processRunner: runner,
        checkSocket: async () => false,
        checkPort: async (port) => port !== 4095, // 4095 in conflict
        socketPath: "/var/run/tailscaled.sock",
      })

      expect(result.socket.status).toBe("warn")
      expect(result.socket.exists).toBe(false)

      expect(result.ip.status).toBe("warn")
      expect(result.ip.isCgnat).toBe(false)
      expect(result.ip.ipAddress).toBe("192.168.1.50")

      expect(result.ports.allAvailable).toBe(false)
      expect(result.ports.router.status).toBe("warn")
      expect(result.ports.router.available).toBe(false)
      expect(result.ports.opencode.available).toBe(true)
      expect(result.ports.bridge.available).toBe(true)
    })

    it("handles missing Tailscale binary gracefully", async () => {
      const runner = new FakeProcessRunner({}) // No response mapped -> exitCode 1

      const result = await probeNetwork({
        processRunner: runner,
        checkSocket: async () => false,
        checkPort: async () => true,
      })

      expect(result.ip.status).toBe("warn")
      expect(result.ip.ipAddress).toBeNull()
      expect(result.ip.detail).toContain("No active Tailscale mesh IPv4")
    })

    it("renders formatted ANSI output via renderNetworkProbe", async () => {
      const runner = new FakeProcessRunner({
        "tailscale ip -4": { exitCode: 0, stdout: "100.64.42.18\n", stderr: "" },
      })

      const probe = await probeNetwork({
        processRunner: runner,
        checkSocket: async () => true,
        checkPort: async () => true,
      })

      const rendered = renderNetworkProbe(probe)
      expect(rendered).toContain("Tailscale Daemon")
      expect(rendered).toContain("100.64.42.18")
      expect(rendered).toContain("Port Availability Preflight Check")
    })
  })
})

describe("Token Generator Widget", () => {
  describe("generateBearerToken", () => {
    it("produces valid CSPRNG tokens with aibr_sec_ prefix by default", () => {
      const token = generateBearerToken()
      expect(token.startsWith("aibr_sec_")).toBe(true)
      const hex = token.slice("aibr_sec_".length)
      expect(hex).toHaveLength(32) // 16 bytes = 32 hex chars
      expect(/^[0-9a-f]{32}$/.test(hex)).toBe(true)
    })

    it("produces raw 64 hex characters when prefix is false", () => {
      const token = generateBearerToken({ prefix: false })
      expect(token.startsWith("aibr_sec_")).toBe(false)
      expect(token).toHaveLength(64) // 32 bytes = 64 hex chars
      expect(/^[0-9a-f]{64}$/.test(token)).toBe(true)
    })

    it("supports boolean false as prefix argument", () => {
      const token = generateBearerToken(false)
      expect(token).toHaveLength(64)
      expect(/^[0-9a-f]{64}$/.test(token)).toBe(true)
    })

    it("generates unique tokens on subsequent calls", () => {
      const t1 = generateBearerToken()
      const t2 = generateBearerToken()
      expect(t1).not.toBe(t2)
    })

    it("supports generateCsprngToken helper", () => {
      const token = generateCsprngToken(true)
      expect(token.startsWith("aibr_sec_")).toBe(true)
      expect(generateCsprngToken(false)).toHaveLength(64)
    })
  })

  describe("isValidBearerToken", () => {
    it("validates prefixed tokens", () => {
      expect(isValidBearerToken("aibr_sec_8f9024b81c2e4318a9942a1b94d1f05e")).toBe(true)
      expect(isValidBearerToken("aibr_sec_" + "a".repeat(64))).toBe(true)
      expect(isValidBearerToken("aibr_sec_short")).toBe(false)
      expect(isValidBearerToken("aibr_sec_nothex1234567890123456789012zz")).toBe(false)
    })

    it("validates raw 64 hex character tokens", () => {
      expect(isValidBearerToken("a".repeat(64))).toBe(true)
      expect(isValidBearerToken("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")).toBe(true)
      expect(isValidBearerToken("a".repeat(32))).toBe(false) // Raw requires 64
    })
  })

  describe("copyToClipboard", () => {
    it("executes without throwing in test environment", async () => {
      const success = await copyToClipboard("aibr_sec_test_token_123")
      expect(typeof success).toBe("boolean")
    })
  })

  describe("Security Checkboxes & Invariants", () => {
    it("provides the three required security floor checkboxes", () => {
      const checkboxes = getDefaultSecurityCheckboxes()
      expect(checkboxes).toHaveLength(3)

      const ids = checkboxes.map((c) => c.id)
      expect(ids).toContain("const-time")
      expect(ids).toContain("body-limit")
      expect(ids).toContain("redact")

      for (const item of checkboxes) {
        expect(item.checked).toBe(true)
        expect(item.title).toBeDefined()
        expect(item.description).toBeDefined()
      }
    })

    it("provides strict default invariants", () => {
      expect(DEFAULT_SECURITY_INVARIANTS.constantTimeComparison).toBe(true)
      expect(DEFAULT_SECURITY_INVARIANTS.maxBodyPayloadCapBytes).toBe(2 * 1024 * 1024) // 2 MB
      expect(DEFAULT_SECURITY_INVARIANTS.secretRedactionPipeline).toBe(true)
    })

    it("renders formatted token widget via renderTokenWidget", () => {
      const rendered = renderTokenWidget("aibr_sec_test1234")
      expect(rendered).toContain("Router Security")
      expect(rendered).toContain("aibr_sec_test1234")
      expect(rendered).toContain("Constant-Time")
      expect(rendered).toContain("2 MB Body Payload")
    })
  })
})

describe("Directory Selector Widget", () => {
  describe("normalizeProjectPath", () => {
    it("normalizes paths and removes redundant separators", () => {
      const norm = normalizeProjectPath("/tmp//test/../test/dir/")
      expect(norm).toBe("/tmp/test/dir")
    })

    it("expands tilde to user home", () => {
      const norm = normalizeProjectPath("~/my-project")
      expect(norm).not.toContain("~")
      expect(norm.endsWith("my-project")).toBe(true)
    })

    it("returns empty string for empty input", () => {
      expect(normalizeProjectPath("")).toBe("")
      expect(normalizeProjectPath("   ")).toBe("")
    })
  })

  describe("validateProjectPath", () => {
    it("validates existing directory paths", async () => {
      const res = await validateProjectPath(process.cwd())
      expect(res.valid).toBe(true)
      expect(res.exists).toBe(true)
      expect(res.isDirectory).toBe(true)
    })

    it("returns invalid for nonexistent directory", async () => {
      const res = await validateProjectPath("/nonexistent/directory/path/here")
      expect(res.valid).toBe(false)
      expect(res.exists).toBe(false)
      expect(res.error).toBeDefined()
    })
  })

  describe("isSubpathContained & enforceFailClosedSubpath", () => {
    const allowedRoots = ["/Users/mac/Projects/AIBrigde", "/Users/mac/Projects/paryaj-demo"]

    it("permits exact allowed roots", () => {
      expect(isSubpathContained("/Users/mac/Projects/AIBrigde", allowedRoots)).toBe(true)
      expect(isSubpathContained("/Users/mac/Projects/paryaj-demo", allowedRoots)).toBe(true)
    })

    it("permits deeper subdirectories within allowed roots", () => {
      expect(isSubpathContained("/Users/mac/Projects/AIBrigde/src/cli", allowedRoots)).toBe(true)
      expect(isSubpathContained("/Users/mac/Projects/paryaj-demo/pkg/test", allowedRoots)).toBe(true)
    })

    it("rejects traversal attempts and parent directories (fail-closed)", () => {
      expect(isSubpathContained("/Users/mac/Projects", allowedRoots)).toBe(false)
      expect(isSubpathContained("/Users/mac/Projects/other-project", allowedRoots)).toBe(false)
      expect(isSubpathContained("/etc/passwd", allowedRoots)).toBe(false)
    })

    it("prevents prefix collisions (e.g. /AIBrigde vs /AIBrigde-malicious)", () => {
      expect(isSubpathContained("/Users/mac/Projects/AIBrigde-evil", allowedRoots)).toBe(false)
    })

    it("enforces fail-closed subpath verdict with 403 Forbidden message", () => {
      const allowed = enforceFailClosedSubpath("/Users/mac/Projects/AIBrigde/sub", allowedRoots)
      expect(allowed.allowed).toBe(true)
      expect(allowed.reason).toBeUndefined()

      const rejected = enforceFailClosedSubpath("/etc/shadow", allowedRoots)
      expect(rejected.allowed).toBe(false)
      expect(rejected.reason).toContain("403 Forbidden")
      expect(rejected.reason).toContain("escapes authorized project containment roots")
    })

    it("includes fail-closed notice constant", () => {
      expect(FAIL_CLOSED_SUBPATH_NOTICE).toContain("403 Forbidden")
    })
  })

  describe("detectProjectDirectories & toggle/add helpers", () => {
    it("detects current working directory as selected item", async () => {
      const dirs = await detectProjectDirectories(process.cwd())
      expect(dirs.length).toBeGreaterThan(0)
      const current = dirs[0]
      expect(current?.selected).toBe(true)
      expect(current?.exists).toBe(true)
      expect(current?.path).toBe(process.cwd())
    })

    it("toggles directory selection", () => {
      const initial = [
        { path: "/a", selected: true, exists: true },
        { path: "/b", selected: false, exists: true },
      ]
      const toggled = toggleProjectDirectory(initial, "/a")
      expect(toggled[0]?.selected).toBe(false)
      expect(toggled[1]?.selected).toBe(false)

      const toggledAgain = toggleProjectDirectory(toggled, "/b")
      expect(toggledAgain[1]?.selected).toBe(true)
    })

    it("adds custom project directory with normalization", () => {
      const initial = [{ path: "/mock/repo1", selected: true, exists: true }]
      const { items, added, error } = addProjectDirectory(initial, "/mock/custom/path")

      expect(added).toBe(true)
      expect(error).toBeUndefined()
      expect(items).toHaveLength(2)
      expect(items[1]?.path).toBe("/mock/custom/path")
      expect(items[1]?.isCustom).toBe(true)
      expect(items[1]?.selected).toBe(true)
    })

    it("rejects empty or duplicate paths", () => {
      const initial = [{ path: "/mock/repo1", selected: true, exists: true }]
      const emptyRes = addProjectDirectory(initial, "   ")
      expect(emptyRes.added).toBe(false)
      expect(emptyRes.error).toContain("empty")

      const dupRes = addProjectDirectory(initial, "/mock/repo1")
      expect(dupRes.added).toBe(false)
      expect(dupRes.error).toContain("already exists")
    })

    it("renders directory selector output via renderDirectorySelector", () => {
      const items = [
        { path: "/path/a", selected: true, exists: true, description: "Repo A" },
        { path: "/path/b", selected: false, exists: true, description: "Repo B" },
      ]
      const rendered = renderDirectorySelector(items, "/path/custom")
      expect(rendered).toContain("Project Allowlists")
      expect(rendered).toContain("/path/a")
      expect(rendered).toContain("/path/custom")
      expect(rendered).toContain("Fail-Closed Subpath Policy")
    })
  })
})

describe("Runtime Probe Widget", () => {
  it("probes OpenCode loopback and reports ok on 200", async () => {
    const http = new FakeHttpProbe({
      "http://127.0.0.1:4096/health": { ok: true, status: 200, body: '{"status":"ok"}' },
    })
    const runner = new FakeProcessRunner({
      "claude --version": { exitCode: 0, stdout: "1.4.2\n", stderr: "" },
      "codex --version": { exitCode: 0, stdout: "0.9.1\n", stderr: "" },
    })

    const result = await probeRuntimes({
      httpProbe: http,
      processRunner: runner,
    })

    expect(result.opencode.status).toBe("ok")
    expect(result.opencode.label).toContain("OpenCode")
    expect(result.opencode.detail).toContain("CONNECTED (HTTP 200)")

    expect(result.claude.status).toBe("ok")
    expect(result.claude.label).toContain("Claude")
    expect(result.claude.detail).toContain("Detected (1.4.2)")

    expect(result.codex.status).toBe("ok")
    expect(result.codex.label).toContain("Codex")
    expect(result.codex.detail).toContain("Detected (0.9.1)")

    expect(result.allReady).toBe(true)
  })

  it("handles offline OpenCode and missing CLI binaries with warn status", async () => {
    const http = new FakeHttpProbe({}) // 503 response
    const runner = new FakeProcessRunner({}) // unmapped commands exitCode 1

    const result = await probeRuntimes({
      httpProbe: http,
      processRunner: runner,
    })

    expect(result.opencode.status).toBe("warn")
    expect(result.opencode.detail).toContain("UNAVAILABLE")

    expect(result.claude.status).toBe("warn")
    expect(result.claude.detail).toContain("Not detected on $PATH")

    expect(result.codex.status).toBe("warn")
    expect(result.codex.detail).toContain("Not detected on $PATH")
  })

  it("renders formatted runtime probe output via renderRuntimeProbe", async () => {
    const http = new FakeHttpProbe({
      "http://127.0.0.1:4096/health": { ok: true, status: 200, body: "ok" },
    })
    const runner = new FakeProcessRunner({
      "claude --version": { exitCode: 0, stdout: "1.4.2\n", stderr: "" },
      "codex --version": { exitCode: 0, stdout: "0.9.1\n", stderr: "" },
    })

    const result = await probeRuntimes({ httpProbe: http, processRunner: runner })
    const rendered = renderRuntimeProbe(result)

    expect(rendered).toContain("AI Agent Runtime Discovery")
    expect(rendered).toContain("OpenCode Serve Loopback")
    expect(rendered).toContain("Claude Code CLI Binary")
    expect(rendered).toContain("Codex CLI Runtime")
  })
})

describe("Brand Color Palette", () => {
  it("exports exact AIBridge design system colors", () => {
    expect(BRAND_COLORS.cyan).toBe("\x1b[38;2;0;240;255m")
    expect(BRAND_COLORS.violet).toBe("\x1b[38;2;168;85;247m")
    expect(BRAND_COLORS.emerald).toBe("\x1b[38;2;16;185;129m")
  })
})
