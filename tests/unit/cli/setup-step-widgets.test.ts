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
  probeDiscoveredAgents,
  renderAgentDiscoveryProbe,
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

describe("Tailnet Agent Discovery Widget", () => {
  // ── Fakes ────────────────────────────────────────────────────────────

  interface FetchCall {
    readonly url: string
    readonly init: RequestInit | undefined
  }

  type FetchBehavior =
    | { readonly kind: "json"; readonly status?: number; readonly body: unknown }
    | { readonly kind: "text"; readonly status?: number; readonly body: string }
    | { readonly kind: "throw"; readonly error: unknown }

  /**
   * Per-URL scripted fetch.
   *
   * Behaviours are per-URL rather than a single canned response because the
   * loop-completeness test needs three peers to fail in three DIFFERENT ways
   * in one call, which a single-response fake cannot express.
   */
  class FakeFetch {
    public calls: FetchCall[] = []
    private readonly behaviors: Map<string, FetchBehavior>

    constructor(behaviors: Record<string, FetchBehavior>) {
      this.behaviors = new Map(Object.entries(behaviors))
    }

    get fetch(): typeof fetch {
      const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input.toString()
        this.calls.push({ url, init })
        const behavior = this.behaviors.get(url)
        if (behavior === undefined) {
          return new Response("not found", { status: 404 })
        }
        if (behavior.kind === "throw") throw behavior.error
        const status = behavior.status ?? 200
        if (behavior.kind === "text") return new Response(behavior.body, { status })
        return new Response(JSON.stringify(behavior.body), { status })
      }
      return impl as unknown as typeof fetch
    }
  }

  // ── Fixtures ─────────────────────────────────────────────────────────

  const SELF = {
    BackendState: "Running",
    DNSName: "myhost.ts.net.",
    HostName: "myhost",
    TailscaleIPs: ["100.64.0.1"],
  }

  function peerNode(ip: string, host: string, overrides?: Record<string, unknown>) {
    return {
      HostName: host,
      DNSName: `${host}.ts.net.`,
      TailscaleIPs: [ip],
      OS: "linux",
      Online: true,
      ...overrides,
    }
  }

  /** Runner that answers `tailscale status --json` with the given Peer map. */
  function tailnetRunner(peers: Record<string, Record<string, unknown>>): FakeProcessRunner {
    return new FakeProcessRunner({
      "tailscale status --json": {
        exitCode: 0,
        stdout: JSON.stringify({ BackendState: "Running", Self: SELF, Peer: peers }),
        stderr: "",
      },
    })
  }

  const HEALTH_BODY = {
    ok: true,
    opencode: true,
    agent_id: "probe-target",
    capabilities: ["analysis", "deployment"],
  }

  // ── Tests ────────────────────────────────────────────────────────────

  it("returns an empty result when the tailnet has no peers", async () => {
    const result = await probeDiscoveredAgents({
      processRunner: tailnetRunner({}),
      fetchFn: new FakeFetch({}).fetch,
    })

    expect(result).toEqual({ agents: [], reachableCount: 0, enrolledCount: 0, peersFound: 0 })
  })

  it("does not throw when the daemon itself is unavailable", async () => {
    // `FakeProcessRunner` with no mapping answers exitCode 1, which
    // `discoverTailscalePeers` degrades to an empty peer list.
    const result = await probeDiscoveredAgents({
      processRunner: new FakeProcessRunner({}),
      fetchFn: new FakeFetch({}).fetch,
    })

    expect(result.agents).toEqual([])
    expect(result.peersFound).toBe(0)
  })

  it("dials the bridge /health on the default port with no Authorization header", async () => {
    const http = new FakeFetch({
      "http://100.64.0.4:8787/health": { kind: "json", body: HEALTH_BODY },
    })

    await probeDiscoveredAgents({
      processRunner: tailnetRunner({ "nodekey-alpha": peerNode("100.64.0.4", "alpha") }),
      fetchFn: http.fetch,
    })

    expect(http.calls).toHaveLength(1)
    expect(http.calls[0].url).toBe("http://100.64.0.4:8787/health")
    const headers = http.calls[0].init?.headers as Record<string, string> | undefined
    expect(headers?.Authorization).toBeUndefined()
    expect(http.calls[0].init?.headers).toBeUndefined()
  })

  it("honours a custom bridge port", async () => {
    const http = new FakeFetch({
      "http://100.64.0.4:9999/health": { kind: "json", body: HEALTH_BODY },
    })

    const result = await probeDiscoveredAgents({
      processRunner: tailnetRunner({ "nodekey-alpha": peerNode("100.64.0.4", "alpha") }),
      fetchFn: http.fetch,
      bridgePort: 9999,
    })

    expect(result.agents[0]?.bridgeUrl).toBe("http://100.64.0.4:9999")
    expect(result.agents[0]?.reachable).toBe(true)
  })

  it("maps a full /health body onto a reachable DiscoveredAgent", async () => {
    const http = new FakeFetch({
      "http://100.64.0.4:8787/health": { kind: "json", body: HEALTH_BODY },
    })

    const result = await probeDiscoveredAgents({
      processRunner: tailnetRunner({ "nodekey-alpha": peerNode("100.64.0.4", "alpha") }),
      fetchFn: http.fetch,
    })

    expect(result.peersFound).toBe(1)
    expect(result.reachableCount).toBe(1)
    expect(result.agents[0]).toEqual({
      ip: "100.64.0.4",
      hostname: "alpha.ts.net",
      os: "linux",
      online: true,
      bridgeUrl: "http://100.64.0.4:8787",
      reachable: true,
      agentId: "probe-target",
      capabilities: ["analysis", "deployment"],
      opencodeReachable: true,
      enrolled: false,
    })
  })

  it("preserves the tailnet's online flag independently of the HTTP probe", async () => {
    const http = new FakeFetch({
      "http://100.64.0.4:8787/health": { kind: "json", body: HEALTH_BODY },
    })

    const result = await probeDiscoveredAgents({
      processRunner: tailnetRunner({
        "nodekey-alpha": peerNode("100.64.0.4", "alpha", { Online: false }),
      }),
      fetchFn: http.fetch,
    })

    expect(result.agents[0]?.online).toBe(false)
    expect(result.agents[0]?.reachable).toBe(true)
  })

  it("sorts and de-duplicates capabilities", async () => {
    const http = new FakeFetch({
      "http://100.64.0.4:8787/health": {
        kind: "json",
        body: {
          ok: true,
          opencode: false,
          agent_id: "probe-target",
          capabilities: ["deployment", "analysis", "deployment", "audit"],
        },
      },
    })

    const result = await probeDiscoveredAgents({
      processRunner: tailnetRunner({ "nodekey-alpha": peerNode("100.64.0.4", "alpha") }),
      fetchFn: http.fetch,
    })

    expect(result.agents[0]?.capabilities).toEqual(["analysis", "audit", "deployment"])
    expect(result.agents[0]?.opencodeReachable).toBe(false)
  })

  it("treats a network error, a non-2xx, and a timeout as unreachable but still probes every peer", async () => {
    // Three failure modes across three peers in one call: the assertion that
    // matters is that the third peer's result is present at all.
    const http = new FakeFetch({
      "http://100.64.0.2:8787/health": {
        kind: "throw",
        error: new TypeError("fetch failed: ECONNREFUSED"),
      },
      "http://100.64.0.3:8787/health": { kind: "text", status: 503, body: "unavailable" },
      "http://100.64.0.4:8787/health": { kind: "json", body: HEALTH_BODY },
    })

    const result = await probeDiscoveredAgents({
      processRunner: tailnetRunner({
        "nodekey-bravo": peerNode("100.64.0.2", "bravo"),
        "nodekey-charlie": peerNode("100.64.0.3", "charlie"),
        "nodekey-alpha": peerNode("100.64.0.4", "alpha"),
      }),
      fetchFn: http.fetch,
    })

    expect(http.calls).toHaveLength(3)
    expect(result.peersFound).toBe(3)
    expect(result.reachableCount).toBe(1)

    const byHost = new Map(result.agents.map((a) => [a.hostname, a]))

    const bravo = byHost.get("bravo.ts.net")
    expect(bravo?.reachable).toBe(false)
    expect(bravo?.agentId).toBeNull()
    expect(bravo?.capabilities).toEqual([])
    expect(bravo?.opencodeReachable).toBeNull()

    const charlie = byHost.get("charlie.ts.net")
    expect(charlie?.reachable).toBe(false)
    expect(charlie?.agentId).toBeNull()

    // The loop did not abort: the peer after the two failures was still probed.
    const alpha = byHost.get("alpha.ts.net")
    expect(alpha?.reachable).toBe(true)
    expect(alpha?.agentId).toBe("probe-target")
  })

  it("reports unreachable when the fetch exceeds the timeout budget", async () => {
    const http = new FakeFetch({
      "http://100.64.0.4:8787/health": {
        kind: "throw",
        error: Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }),
      },
    })

    const result = await probeDiscoveredAgents({
      processRunner: tailnetRunner({ "nodekey-alpha": peerNode("100.64.0.4", "alpha") }),
      fetchFn: http.fetch,
      timeoutMs: 25,
    })

    expect(result.agents[0]?.reachable).toBe(false)
    expect(result.agents[0]?.agentId).toBeNull()
  })

  it("passes an AbortSignal so a hung peer cannot stall the probe", async () => {
    const http = new FakeFetch({
      "http://100.64.0.4:8787/health": { kind: "json", body: HEALTH_BODY },
    })

    await probeDiscoveredAgents({
      processRunner: tailnetRunner({ "nodekey-alpha": peerNode("100.64.0.4", "alpha") }),
      fetchFn: http.fetch,
      timeoutMs: 1500,
    })

    expect(http.calls[0].init?.signal).toBeInstanceOf(AbortSignal)
  })

  it("treats a garbage body as unreachable without throwing", async () => {
    const http = new FakeFetch({
      "http://100.64.0.4:8787/health": { kind: "text", body: "<html>not aibridge</html>" },
      "http://100.64.0.5:8787/health": { kind: "text", body: "" },
    })

    const result = await probeDiscoveredAgents({
      processRunner: tailnetRunner({
        "nodekey-alpha": peerNode("100.64.0.4", "alpha"),
        "nodekey-bravo": peerNode("100.64.0.5", "bravo"),
      }),
      fetchFn: http.fetch,
    })

    expect(result.reachableCount).toBe(0)
    for (const agent of result.agents) {
      expect(agent.reachable).toBe(false)
      expect(agent.agentId).toBeNull()
      expect(agent.capabilities).toEqual([])
      expect(agent.opencodeReachable).toBeNull()
    }
  })

  it("treats a structurally wrong JSON body as unreachable", async () => {
    const http = new FakeFetch({
      "http://100.64.0.4:8787/health": {
        kind: "json",
        body: { agent_id: 42, capabilities: "analysis" },
      },
    })

    const result = await probeDiscoveredAgents({
      processRunner: tailnetRunner({ "nodekey-alpha": peerNode("100.64.0.4", "alpha") }),
      fetchFn: http.fetch,
    })

    expect(result.agents[0]?.reachable).toBe(false)
  })

  it("keeps reachable: true when agent_id is absent from the body", async () => {
    const http = new FakeFetch({
      "http://100.64.0.4:8787/health": { kind: "json", body: { ok: true, opencode: true } },
    })

    const result = await probeDiscoveredAgents({
      processRunner: tailnetRunner({ "nodekey-alpha": peerNode("100.64.0.4", "alpha") }),
      fetchFn: http.fetch,
    })

    expect(result.agents[0]?.reachable).toBe(true)
    expect(result.agents[0]?.agentId).toBeNull()
    expect(result.agents[0]?.capabilities).toEqual([])
    expect(result.agents[0]?.opencodeReachable).toBe(true)
  })

  it("marks enrolled when the agent id matches, and separately when the ip matches", async () => {
    const http = new FakeFetch({
      "http://100.64.0.2:8787/health": { kind: "json", body: { agent_id: "worker-b", opencode: true } },
      "http://100.64.0.4:8787/health": { kind: "json", body: { agent_id: "worker-a", opencode: true } },
      "http://100.64.0.5:8787/health": { kind: "throw", error: new Error("down") },
    })

    const result = await probeDiscoveredAgents({
      processRunner: tailnetRunner({
        "nodekey-bravo": peerNode("100.64.0.2", "bravo"),
        "nodekey-alpha": peerNode("100.64.0.4", "alpha"),
        "nodekey-charlie": peerNode("100.64.0.5", "charlie"),
      }),
      fetchFn: http.fetch,
      // `worker-a` matches by id; `100.64.0.5` matches by address even though
      // that peer never answered, because "known but down" is still enrolled.
      enrolledAgentIds: ["worker-a", "100.64.0.5"],
    })

    const byHost = new Map(result.agents.map((a) => [a.hostname, a]))
    expect(byHost.get("alpha.ts.net")?.enrolled).toBe(true)
    expect(byHost.get("charlie.ts.net")?.enrolled).toBe(true)
    expect(byHost.get("charlie.ts.net")?.reachable).toBe(false)
    expect(byHost.get("bravo.ts.net")?.enrolled).toBe(false)
    expect(result.enrolledCount).toBe(2)
  })

  it("does not infer enrolment from a peer that merely answered", async () => {
    const http = new FakeFetch({
      "http://100.64.0.4:8787/health": { kind: "json", body: HEALTH_BODY },
    })

    const result = await probeDiscoveredAgents({
      processRunner: tailnetRunner({ "nodekey-alpha": peerNode("100.64.0.4", "alpha") }),
      fetchFn: http.fetch,
      enrolledAgentIds: ["some-other-agent"],
    })

    expect(result.agents[0]?.reachable).toBe(true)
    expect(result.agents[0]?.enrolled).toBe(false)
    expect(result.enrolledCount).toBe(0)
  })

  it("orders agents deterministically by hostname regardless of input order", async () => {
    const peers = {
      "nodekey-zulu": peerNode("100.64.0.9", "zulu"),
      "nodekey-alpha": peerNode("100.64.0.4", "alpha"),
      "nodekey-mike": peerNode("100.64.0.7", "mike"),
      "nodekey-bravo": peerNode("100.64.0.2", "bravo"),
    }
    const behavior = { kind: "json" as const, body: HEALTH_BODY }
    const behaviors = Object.fromEntries(
      ["100.64.0.2", "100.64.0.4", "100.64.0.7", "100.64.0.9"].map((ip) => [
        `http://${ip}:8787/health`,
        behavior,
      ]),
    )

    const first = await probeDiscoveredAgents({
      processRunner: tailnetRunner(peers),
      fetchFn: new FakeFetch(behaviors).fetch,
    })
    const second = await probeDiscoveredAgents({
      processRunner: tailnetRunner(peers),
      fetchFn: new FakeFetch(behaviors).fetch,
    })

    expect(first.agents.map((a) => a.hostname)).toEqual([
      "alpha.ts.net",
      "bravo.ts.net",
      "mike.ts.net",
      "zulu.ts.net",
    ])
    expect(second.agents.map((a) => a.hostname)).toEqual(first.agents.map((a) => a.hostname))
  })

  it("breaks hostname ties on the ip", async () => {
    // Two nodes publishing the same DNS name: ordering must still be total.
    const http = new FakeFetch({
      "http://100.64.0.20:8787/health": { kind: "json", body: HEALTH_BODY },
      "http://100.64.0.10:8787/health": { kind: "json", body: HEALTH_BODY },
    })

    const result = await probeDiscoveredAgents({
      processRunner: tailnetRunner({
        "nodekey-b": peerNode("100.64.0.20", "twin"),
        "nodekey-a": peerNode("100.64.0.10", "twin"),
      }),
      fetchFn: http.fetch,
    })

    expect(result.agents.map((a) => a.ip)).toEqual(["100.64.0.10", "100.64.0.20"])
  })

  it("renders hostname and ip for every peer", async () => {
    const http = new FakeFetch({
      "http://100.64.0.2:8787/health": { kind: "json", body: HEALTH_BODY },
    })

    const result = await probeDiscoveredAgents({
      processRunner: tailnetRunner({
        "nodekey-alpha": peerNode("100.64.0.4", "alpha"),
        "nodekey-bravo": peerNode("100.64.0.2", "bravo"),
      }),
      fetchFn: http.fetch,
      enrolledAgentIds: ["probe-target"],
    })

    const rendered = renderAgentDiscoveryProbe(result)
    expect(rendered).toContain("Tailnet Agent Discovery")
    expect(rendered).toContain("alpha.ts.net")
    expect(rendered).toContain("100.64.0.4")
    expect(rendered).toContain("bravo.ts.net")
    expect(rendered).toContain("100.64.0.2")
    expect(rendered).toContain("REACHABLE")
    expect(rendered).toContain("UNREACHABLE")
    expect(rendered).toContain("probe-target")
    expect(rendered).toContain("ENROLLED")
    expect(rendered).toContain("NOT ENROLLED")
    // Assertions run against the plain text: ANSI codes sit between the count
    // and its noun, so a raw substring match would be asserting on styling.
    const plain = rendered.replace(/\x1b\[[0-9;]*m/g, "")
    expect(plain).toContain("2 capabilities")
    expect(plain).toContain("capabilities unknown")
  })

  it("renders an empty tailnet without throwing", () => {
    const rendered = renderAgentDiscoveryProbe({
      agents: [],
      reachableCount: 0,
      enrolledCount: 0,
      peersFound: 0,
    })

    expect(rendered).toContain("Tailnet Agent Discovery")
    expect(rendered).toContain("NO PEERS FOUND")
  })

  it("never renders raw daemon output or credentials", async () => {
    // The Peer map carries a `tskey-` enrollment credential — a reusable node
    // credential, which is exactly why discovery must not echo the listing.
    const http = new FakeFetch({
      "http://100.64.0.4:8787/health": { kind: "json", body: HEALTH_BODY },
    })

    const result = await probeDiscoveredAgents({
      processRunner: tailnetRunner({
        "nodekey-alpha": peerNode("100.64.0.4", "alpha", {
          ExtraField: "tskey-abcdef0123456789-secret",
          NodeKey: "nodekey:0123456789abcdef",
        }),
      }),
      fetchFn: http.fetch,
    })

    const rendered = renderAgentDiscoveryProbe(result)
    expect(rendered).not.toContain("tskey-")
    expect(rendered).not.toContain("nodekey")
    expect(rendered).not.toContain("ExtraField")
    // The projected agent exposes only the normalised fields, so the daemon's
    // extra keys have nowhere to survive into.
    expect(Object.keys(result.agents[0] ?? {}).sort()).toEqual([
      "agentId",
      "bridgeUrl",
      "capabilities",
      "enrolled",
      "hostname",
      "ip",
      "online",
      "opencodeReachable",
      "os",
      "reachable",
    ])
  })

  it("is pure with respect to configuration", async () => {
    // Enrolment is a separate, credentialed step: discovery reports and writes
    // nothing. The deps surface has no config or allowlist input at all, and
    // the result is plain data with no back-reference to any mutable state.
    const http = new FakeFetch({
      "http://100.64.0.4:8787/health": { kind: "json", body: HEALTH_BODY },
    })

    const enrolled: string[] = ["worker-a"]
    const before = [...enrolled]

    const result = await probeDiscoveredAgents({
      processRunner: tailnetRunner({ "nodekey-alpha": peerNode("100.64.0.4", "alpha") }),
      fetchFn: http.fetch,
      enrolledAgentIds: enrolled,
    })

    expect(enrolled).toEqual(before)
    expect(Object.keys(result).sort()).toEqual([
      "agents",
      "enrolledCount",
      "peersFound",
      "reachableCount",
    ])
    expect(result.agents).toHaveLength(1)
    // Freezing the result and then mutating the input list must not move the
    // reported state: the ids were snapshotted at call time.
    enrolled.push("worker-b")
    expect(result.agents[0]?.enrolled).toBe(false)
  })

  it("snapshots enrolledAgentIds so later mutation cannot retro-enrol a peer", async () => {
    const http = new FakeFetch({
      "http://100.64.0.4:8787/health": { kind: "json", body: HEALTH_BODY },
    })
    const enrolled: string[] = []

    const pending = probeDiscoveredAgents({
      processRunner: tailnetRunner({ "nodekey-alpha": peerNode("100.64.0.4", "alpha") }),
      fetchFn: http.fetch,
      enrolledAgentIds: enrolled,
    })
    enrolled.push("probe-target")

    const result = await pending
    expect(result.enrolledCount).toBe(0)
  })
})

describe("Brand Color Palette", () => {
  it("exports exact AIBridge design system colors", () => {
    expect(BRAND_COLORS.cyan).toBe("\x1b[38;2;0;240;255m")
    expect(BRAND_COLORS.violet).toBe("\x1b[38;2;168;85;247m")
    expect(BRAND_COLORS.emerald).toBe("\x1b[38;2;16;185;129m")
  })
})
