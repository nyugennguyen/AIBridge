import { describe, expect, it } from "vitest"
import type {
  ProcessOptions,
  ProcessResult,
  ProcessRunner,
} from "../../../src/host/types.js"
import {
  discoverTailscalePeers,
  type TailscalePeer,
} from "../../../src/host/tailscale-discovery.js"

// ── Fake runner ────────────────────────────────────────────────────────

/**
 * Test-only ProcessRunner with a single scripted result, recording argv.
 *
 * Same shape as the runner in setup.test.ts and preflight.test.ts: discovery
 * makes exactly one call per invocation, so a queue would be ceremony.
 */
class FakeRunner implements ProcessRunner {
  public calls: Array<{ argv: readonly string[]; options?: ProcessOptions }> = []
  private readonly result: ProcessResult

  constructor(result: ProcessResult) {
    this.result = result
  }

  async exec(argv: readonly string[], options?: ProcessOptions): Promise<ProcessResult> {
    this.calls.push({ argv, options })
    return this.result
  }
}

function jsonResult(payload: unknown): ProcessResult {
  return { exitCode: 0, stdout: JSON.stringify(payload), stderr: "" }
}

function textResult(stdout: string): ProcessResult {
  return { exitCode: 0, stdout, stderr: "" }
}

function failureResult(stderr = "failed to connect to local tailscaled"): ProcessResult {
  return { exitCode: 1, stdout: "", stderr }
}

// ── Fixtures ───────────────────────────────────────────────────────────

const SELF = {
  BackendState: "Running",
  DNSName: "myhost.ts.net.",
  HostName: "myhost",
  TailscaleIPs: ["100.64.0.1"],
}

function peerNode(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    HostName: "peer",
    DNSName: "peer.ts.net.",
    TailscaleIPs: ["100.64.0.2"],
    OS: "linux",
    Online: true,
    ...overrides,
  }
}

const PLAIN_TEXT_STATUS = [
  "100.64.0.1  my-machine user@  darwin   active; direct 10.0.0.1:41641, tx 0 rx 0",
  "100.64.0.2  peer-one   user@  linux   active; direct 192.168.1.10:41641, tx 100 rx 200",
  "",
  "HealthStatus: healthy",
  "BackendState: Running",
].join("\n")

// ── Parsing the JSON Peer map ──────────────────────────────────────────

describe("discoverTailscalePeers", () => {
  describe("uses fixed argv", () => {
    it("runs tailscale status --json", async () => {
      const runner = new FakeRunner(jsonResult({ Self: SELF, Peer: {} }))

      await discoverTailscalePeers(runner)

      expect(runner.calls).toHaveLength(1)
      expect(runner.calls[0].argv).toEqual(["tailscale", "status", "--json"])
    })
  })

  describe("JSON Peer map", () => {
    it("parses peers, excludes Self, and sorts by hostname", async () => {
      const runner = new FakeRunner(jsonResult({
        BackendState: "Running",
        Self: SELF,
        Peer: {
          "nodekey-zulu": peerNode({
            HostName: "zulu",
            DNSName: "zulu.ts.net.",
            TailscaleIPs: ["100.64.0.9"],
            OS: "linux",
          }),
          "nodekey-alpha": peerNode({
            HostName: "alpha",
            DNSName: "alpha.ts.net.",
            TailscaleIPs: ["100.64.0.4"],
            OS: "darwin",
          }),
          "nodekey-self": peerNode({
            HostName: "myhost",
            DNSName: "myhost.ts.net.",
            TailscaleIPs: ["100.64.0.1"],
          }),
        },
      }))

      const peers = await discoverTailscalePeers(runner)

      expect(peers).toEqual<TailscalePeer[]>([
        { ip: "100.64.0.4", hostname: "alpha.ts.net", os: "darwin", online: true },
        { ip: "100.64.0.9", hostname: "zulu.ts.net", os: "linux", online: true },
      ])
    })

    it("prefers the IPv4 address when IPv6 is also listed", async () => {
      const runner = new FakeRunner(jsonResult({
        Self: SELF,
        Peer: {
          "nodekey-peer": peerNode({
            TailscaleIPs: ["fd7a:1234::1", "100.64.0.2", "fd7a:5678::2"],
          }),
        },
      }))

      const peers = await discoverTailscalePeers(runner)

      expect(peers).toHaveLength(1)
      expect(peers[0].ip).toBe("100.64.0.2")
    })

    it("skips a peer with only an IPv6 address", async () => {
      const runner = new FakeRunner(jsonResult({
        Self: SELF,
        Peer: {
          "nodekey-v6": peerNode({
            HostName: "v6only",
            DNSName: "v6only.ts.net.",
            TailscaleIPs: ["fd7a:1234::1"],
          }),
        },
      }))

      expect(await discoverTailscalePeers(runner)).toEqual([])
    })

    it("skips a peer with no address list at all", async () => {
      const runner = new FakeRunner(jsonResult({
        Self: SELF,
        Peer: { "nodekey-noip": peerNode({ TailscaleIPs: undefined }) },
      }))

      expect(await discoverTailscalePeers(runner)).toEqual([])
    })

    it("retains an offline peer with online=false", async () => {
      const runner = new FakeRunner(jsonResult({
        Self: SELF,
        Peer: {
          "nodekey-offline": peerNode({
            HostName: "offline-box",
            DNSName: "offline-box.ts.net.",
            Online: false,
          }),
        },
      }))

      const peers = await discoverTailscalePeers(runner)

      expect(peers).toHaveLength(1)
      expect(peers[0].online).toBe(false)
      expect(peers[0].hostname).toBe("offline-box.ts.net")
    })

    it("treats a missing Online flag as online, like the plain-text path", async () => {
      const runner = new FakeRunner(jsonResult({
        Self: SELF,
        Peer: { "nodekey-silent": peerNode({ Online: undefined }) },
      }))

      const peers = await discoverTailscalePeers(runner)

      expect(peers[0].online).toBe(true)
    })

    it("strips the trailing dot from DNSName", async () => {
      const runner = new FakeRunner(jsonResult({
        Self: SELF,
        Peer: { "nodekey-dot": peerNode({ DNSName: "dotted.ts.net." }) },
      }))

      const peers = await discoverTailscalePeers(runner)

      expect(peers[0].hostname).toBe("dotted.ts.net")
    })

    it("normalises os to lowercase and null when absent", async () => {
      const runner = new FakeRunner(jsonResult({
        Self: SELF,
        Peer: {
          "nodekey-upper": peerNode({ HostName: "upper", DNSName: "upper.ts.net.", OS: "  WINDOWS " }),
          "nodekey-none": peerNode({ HostName: "none", DNSName: "none.ts.net.", OS: undefined }),
        },
      }))

      const peers = await discoverTailscalePeers(runner)

      const upper = peers.find((p) => p.hostname === "upper.ts.net")
      const none = peers.find((p) => p.hostname === "none.ts.net")
      expect(upper?.os).toBe("windows")
      expect(none?.os).toBeNull()
    })

    it("falls back to HostName when DNSName is absent", async () => {
      const runner = new FakeRunner(jsonResult({
        Self: SELF,
        Peer: { "nodekey-nodns": peerNode({ HostName: "shortname", DNSName: undefined }) },
      }))

      const peers = await discoverTailscalePeers(runner)

      expect(peers[0].hostname).toBe("shortname")
    })

    it("excludes Self when only the IP matches", async () => {
      const runner = new FakeRunner(jsonResult({
        Self: { TailscaleIPs: ["100.64.0.1"] },
        Peer: { "nodekey-self": peerNode({ TailscaleIPs: ["100.64.0.1"] }) },
      }))

      expect(await discoverTailscalePeers(runner)).toEqual([])
    })

    it("excludes Self when only the name matches", async () => {
      const runner = new FakeRunner(jsonResult({
        Self: { DNSName: "myhost.ts.net." },
        Peer: { "nodekey-self": peerNode({ DNSName: "myhost.ts.net.", HostName: "myhost" }) },
      }))

      expect(await discoverTailscalePeers(runner)).toEqual([])
    })

    it("returns [] for a missing Peer key", async () => {
      const runner = new FakeRunner(jsonResult({ BackendState: "Running", Self: SELF }))

      expect(await discoverTailscalePeers(runner)).toEqual([])
    })

    it("returns [] for a null Peer value", async () => {
      const runner = new FakeRunner(textResult('{"Self": {"TailscaleIPs": ["100.64.0.1"]}, "Peer": null}'))

      expect(await discoverTailscalePeers(runner)).toEqual([])
    })

    it("returns [] for an empty Peer map", async () => {
      const runner = new FakeRunner(jsonResult({ Self: SELF, Peer: {} }))

      expect(await discoverTailscalePeers(runner)).toEqual([])
    })

    it("reports every peer when Self is absent from the document", async () => {
      const runner = new FakeRunner(jsonResult({
        Peer: { "nodekey-peer": peerNode() },
      }))

      const peers = await discoverTailscalePeers(runner)

      expect(peers).toHaveLength(1)
    })
  })

  describe("error handling", () => {
    it("returns [] on non-zero exit", async () => {
      const runner = new FakeRunner(failureResult("failed to connect to local tailscaled; it's not running"))

      expect(await discoverTailscalePeers(runner)).toEqual([])
    })

    it("returns [] on a null exitCode (killed by signal)", async () => {
      const runner = new FakeRunner({ exitCode: null, stdout: "", stderr: "killed" })

      expect(await discoverTailscalePeers(runner)).toEqual([])
    })

    it("returns [] for malformed JSON that still starts with a brace", async () => {
      const runner = new FakeRunner(textResult('{"Self": {"TailscaleIPs": [' ))

      expect(await discoverTailscalePeers(runner)).toEqual([])
    })

    it("returns [] when a Peer entry does not match the schema", async () => {
      const runner = new FakeRunner(textResult('{"Self": {"TailscaleIPs": ["100.64.0.1"]}, "Peer": {"nodekey-x": "not-an-object"}}'))

      expect(await discoverTailscalePeers(runner)).toEqual([])
    })

    it("returns [] for empty output", async () => {
      const runner = new FakeRunner(textResult(""))

      expect(await discoverTailscalePeers(runner)).toEqual([])
    })
  })

  describe("plain-text fallback", () => {
    it("parses peers from the human-readable listing", async () => {
      const runner = new FakeRunner(textResult(PLAIN_TEXT_STATUS))

      const peers = await discoverTailscalePeers(runner)

      expect(peers).toEqual<TailscalePeer[]>([
        { ip: "100.64.0.2", hostname: "peer-one", os: "linux", online: true },
      ])
    })

    it("parses every peer when several machines are listed", async () => {
      const runner = new FakeRunner(textResult([
        "100.64.0.1  my-machine user@  darwin   active; direct 10.0.0.1:41641, tx 0 rx 0",
        "100.64.0.3  peer-two   user@  linux   -; active; relay \"lax\", tx 5 rx 6",
        "100.64.0.2  peer-one   user@  linux   active; direct 192.168.1.10:41641, tx 100 rx 200",
        "",
        "HealthStatus: healthy",
        "BackendState: Running",
      ].join("\n")))

      const peers = await discoverTailscalePeers(runner)

      expect(peers).toEqual<TailscalePeer[]>([
        { ip: "100.64.0.2", hostname: "peer-one", os: "linux", online: true },
        { ip: "100.64.0.3", hostname: "peer-two", os: "linux", online: true },
      ])
    })

    it("marks a peer as offline when the status says offline", async () => {
      const runner = new FakeRunner(textResult([
        "100.64.0.1  my-machine user@  darwin   active",
        "100.64.0.9  asleep     user@  linux   -; offline",
      ].join("\n")))

      const peers = await discoverTailscalePeers(runner)

      expect(peers).toHaveLength(1)
      expect(peers[0].online).toBe(false)
      expect(peers[0].hostname).toBe("asleep")
    })

    it("skips malformed machine rows and keeps the rest", async () => {
      const runner = new FakeRunner(textResult([
        "not-an-ip  broken user@  linux   active",
        "100.64.0.1  my-machine user@  darwin   active",
        "100.64.0.2  peer-one   user@  linux   active",
        "",
        "HealthStatus: healthy",
      ].join("\n")))

      const peers = await discoverTailscalePeers(runner)

      expect(peers).toHaveLength(1)
      expect(peers[0].hostname).toBe("peer-one")
    })

    it("ignores Key: value trailer lines", async () => {
      const runner = new FakeRunner(textResult("BackendState: Running\nHealthStatus: healthy\n"))

      expect(await discoverTailscalePeers(runner)).toEqual([])
    })

    it("returns [] when the listing contains only the self machine", async () => {
      const runner = new FakeRunner(textResult([
        "100.64.0.1  my-machine user@  darwin   active",
        "",
        "BackendState: Running",
      ].join("\n")))

      expect(await discoverTailscalePeers(runner)).toEqual([])
    })

    it("returns os as null when the status column carries no OS", async () => {
      const runner = new FakeRunner(textResult([
        "100.64.0.1  my-machine user@",
        "100.64.0.2  peer-one   user@",
      ].join("\n")))

      const peers = await discoverTailscalePeers(runner)

      expect(peers).toHaveLength(1)
      expect(peers[0].os).toBeNull()
      expect(peers[0].online).toBe(true)
    })

    it("normalises os to lowercase", async () => {
      const runner = new FakeRunner(textResult([
        "100.64.0.1  my-machine user@  Darwin   active",
        "100.64.0.2  peer-one   user@  Linux    active",
      ].join("\n")))

      const peers = await discoverTailscalePeers(runner)

      expect(peers[0].os).toBe("linux")
    })
  })
})
