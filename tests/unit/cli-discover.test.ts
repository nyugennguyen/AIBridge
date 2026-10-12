import { describe, expect, it } from "vitest"
import { runCli, type CliDeps, type CliExitCode } from "../../src/cli.js"
import type { AgentDiscoveryResult, DiscoveredAgent } from "../../src/cli/setup-step-widgets.js"

/**
 * `aibr discover` — the scriptable, state-free tailnet query.
 *
 * Every test here drives the command through an injected `discoverAgents`, so
 * none of them needs a Tailscale daemon, a second machine, or a network. A
 * discovery test that shelled out to the real binary would be a test that
 * passes or fails depending on the machine it runs on.
 */

// ── Local fixtures ──────────────────────────────────────────────────────
// Defined here rather than in `tests/integration/fixtures.ts`: this file owns
// the discover surface and needs no bridge, so it takes no such dependency.

class FakeWriter {
  public readonly chunks: string[] = []

  write(data: string): void {
    this.chunks.push(data)
  }

  get output(): string {
    return this.chunks.join("")
  }
}

function agent(overrides: Partial<DiscoveredAgent> = {}): DiscoveredAgent {
  return {
    ip: "100.64.0.9",
    hostname: "peer-one",
    os: "linux",
    online: true,
    bridgeUrl: "http://100.64.0.9:8787",
    reachable: true,
    agentId: "worker-a",
    capabilities: ["code", "review"],
    opencodeReachable: true,
    enrolled: false,
    ...overrides,
  }
}

function result(overrides: Partial<AgentDiscoveryResult> = {}): AgentDiscoveryResult {
  const agents = overrides.agents ?? []
  return {
    agents,
    reachableCount: overrides.reachableCount ?? agents.filter((a) => a.reachable).length,
    enrolledCount: overrides.enrolledCount ?? agents.filter((a) => a.enrolled).length,
    peersFound: overrides.peersFound ?? agents.length,
  }
}

const EMPTY: AgentDiscoveryResult = { agents: [], reachableCount: 0, enrolledCount: 0, peersFound: 0 }

type DiscoveryRunner = NonNullable<CliDeps["discoverAgents"]>

/**
 * Minimal-but-complete `CliDeps`.
 *
 * Every command other than `discover` is wired to a thrower: the point of the
 * shared fixture is that if a future edit wires discovery up to a config read,
 * a bridge start, or a profile lookup, it fails here instead of passing a
 * suite on a machine where those happen to be harmless.
 */
function fakeDeps(overrides: {
  readonly discover?: DiscoveryRunner
  readonly isTTY?: boolean
}): { readonly deps: CliDeps; readonly writer: FakeWriter } {
  const writer = new FakeWriter()
  const refuse = async (): Promise<never> => {
    throw new Error("discover must not touch any side-effecting dependency")
  }

  const deps: CliDeps = {
    writer: (s: string) => writer.write(s),
    isTTY: overrides.isTTY ?? true,
    isInputTTY: true,
    runSetup: refuse,
    startProfile: refuse,
    serveBridge: refuse,
    runWorker: refuse,
    statusProfile: refuse,
    runOpencode: refuse,
    runTui: (async () => { throw new Error("discover must not start a TUI") }) as CliDeps["runTui"],
    runBundle: (async () => { throw new Error("discover must not build a bundle") }) as CliDeps["runBundle"],
    verifyProfile: refuse,
    runUpdate: refuse,
    discoverAgents: overrides.discover ?? (async () => EMPTY),
    version: "1.0.0",
  }

  return { deps, writer }
}

async function run(
  argv: readonly string[],
  overrides: Parameters<typeof fakeDeps>[0] = {},
): Promise<{ readonly exitCode: CliExitCode; readonly output: string; readonly writer: FakeWriter }> {
  const { deps, writer } = fakeDeps(overrides)
  const exitCode = await runCli(argv, deps)
  return { exitCode, output: writer.output, writer }
}

/** The one document `--json` promises, parsed rather than string-matched. */
function parseSingleDocument(output: string): Record<string, unknown> {
  expect(output.trimEnd().endsWith("}")).toBe(true)
  return JSON.parse(output) as Record<string, unknown>
}

// ── Help ────────────────────────────────────────────────────────────────

describe("cli discover — help", () => {
  it("is listed in help output", async () => {
    const { output } = await run(["--help"])

    expect(output).toContain("discover")
    expect(output).toContain("--json")
  })

  it("describes discover as read-only", async () => {
    const { output } = await run(["--help"])

    expect(output).toMatch(/discover .*read-only/)
  })
})

// ── Dispatch ────────────────────────────────────────────────────────────

describe("cli discover — dispatch", () => {
  it("runs with no --profile at all", async () => {
    let called = false
    let received: { readonly profile?: string } | undefined
    const { exitCode } = await run(["discover"], {
      discover: async (options) => {
        called = true
        received = options
        return EMPTY
      },
    })

    expect(exitCode).toBe(0)
    expect(called).toBe(true)
    // `undefined`, not a defaulted name: the command must not invent a profile
    // it then claims to have consulted.
    expect(received).toBeUndefined()
  })

  it("passes an explicit --profile through for enrolled labels", async () => {
    let received: string | undefined
    const { exitCode } = await run(["discover", "--profile", "dev-main"], {
      discover: async (options) => {
        received = options?.profile
        return EMPTY
      },
    })

    expect(exitCode).toBe(0)
    expect(received).toBe("dev-main")
  })

  it("accepts the -p shorthand", async () => {
    let received: string | undefined
    await run(["discover", "-p", "vps"], {
      discover: async (options) => {
        received = options?.profile
        return EMPTY
      },
    })

    expect(received).toBe("vps")
  })

  it("rejects an invalid profile name without probing", async () => {
    let called = false
    const { exitCode, output } = await run(["discover", "--profile", "../etc/passwd"], {
      discover: async () => {
        called = true
        return EMPTY
      },
    })

    expect(exitCode).not.toBe(0)
    expect(output).toContain("Invalid profile name")
    expect(output).not.toContain("passwd")
    expect(called).toBe(false)
  })

  it("treats --json as a known flag, not an unknown one", async () => {
    const { exitCode, output } = await run(["discover", "--json"])

    expect(exitCode).toBe(0)
    expect(output).not.toContain("unknown flag")
  })

  it("still rejects a genuinely unknown flag", async () => {
    let called = false
    const { exitCode, output } = await run(["discover", "--bogus"], {
      discover: async () => {
        called = true
        return EMPTY
      },
    })

    expect(exitCode).not.toBe(0)
    expect(output).toContain("unknown flag --bogus")
    expect(called).toBe(false)
  })

  it("touches no side-effecting dependency", async () => {
    // `fakeDeps` throws from every other command's runner; reaching this exit
    // code is the assertion that discovery is a read-only query.
    const { exitCode } = await run(["discover", "--profile", "dev-main"])

    expect(exitCode).toBe(0)
  })
})

// ── Human output ────────────────────────────────────────────────────────

describe("cli discover — human output", () => {
  it("renders the probe widget", async () => {
    const { output } = await run(["discover"], {
      discover: async () => result({ agents: [agent()] }),
    })

    expect(output).toContain("Tailnet Agent Discovery")
    expect(output).toContain("peer-one")
    expect(output).toContain("100.64.0.9")
  })

  it("adds a summary line", async () => {
    const { output } = await run(["discover"], {
      discover: async () => result({
        agents: [agent({ enrolled: true }), agent({ hostname: "peer-two", ip: "100.64.0.10", reachable: false, agentId: null })],
        reachableCount: 1,
        enrolledCount: 1,
        peersFound: 2,
      }),
    })

    expect(output).toContain("Discovered 2 peer(s); 1 answered /health; 1 enrolled.")
  })

  it("says plainly that an empty tailnet is not an error", async () => {
    const { exitCode, output } = await run(["discover"], { discover: async () => EMPTY })

    expect(exitCode).toBe(0)
    expect(output).toContain("No peers found")
    expect(output).toContain("Nothing was enrolled and nothing was changed.")
  })

  it("labels an answering-but-unidentified peer as not enrolled", async () => {
    // The documented misread this command exists to prevent: something answered
    // on 8787, but nothing said it is an AIBridge bridge.
    const { output } = await run(["discover"], {
      discover: async () => result({ agents: [agent({ agentId: null, enrolled: false })] }),
    })

    expect(output).toContain("NOT ENROLLED")
    expect(output).toContain("unidentified")
  })

  it("does not imply a reachable peer is trusted", async () => {
    const { output } = await run(["discover"], {
      discover: async () => result({ agents: [agent({ reachable: true, enrolled: false })] }),
    })

    expect(output).toContain("Reachability is not authentication")
    expect(output).not.toMatch(/trusted peer|authenticated peer/i)
  })
})

// ── JSON output ─────────────────────────────────────────────────────────

describe("cli discover — --json", () => {
  const peers = result({
    agents: [
      agent({ enrolled: true }),
      agent({
        ip: "100.64.0.10",
        hostname: "peer-two",
        os: null,
        online: false,
        bridgeUrl: "http://100.64.0.10:8787",
        reachable: false,
        agentId: null,
        capabilities: [],
        opencodeReachable: null,
        enrolled: false,
      }),
    ],
    reachableCount: 1,
    enrolledCount: 1,
    peersFound: 2,
  })

  it("emits exactly one parseable JSON document", async () => {
    const { exitCode, output } = await run(["discover", "--json"], {
      discover: async () => peers,
    })

    expect(exitCode).toBe(0)
    const doc = parseSingleDocument(output)
    expect(doc.schemaVersion).toBe(1)
    expect(doc.ok).toBe(true)
  })

  it("emits nothing but the document on stdout", async () => {
    const { output } = await run(["discover", "--json"], { discover: async () => peers })

    // Nothing before the `{` and nothing after the closing brace: a caller
    // piping this into a JSON parser must not have to strip a banner first.
    expect(output.trimStart().startsWith("{")).toBe(true)
    expect(output.trimEnd().endsWith("}")).toBe(true)
    expect(output).not.toContain("Tailnet Agent Discovery")
  })

  it("keeps the top-level shape stable", async () => {
    const { output } = await run(["discover", "--json"], { discover: async () => peers })
    const doc = parseSingleDocument(output)

    // Pinned deliberately: this list is the contract a downstream plugin codes
    // against, so a rename here is a breaking change and must fail loudly.
    expect(Object.keys(doc).sort()).toEqual([
      "enrolledCount",
      "enrolledSource",
      "notice",
      "ok",
      "peers",
      "peersFound",
      "reachableCount",
      "schemaVersion",
    ])
  })

  it("carries the counts a caller needs", async () => {
    const { output } = await run(["discover", "--json"], { discover: async () => peers })
    const doc = parseSingleDocument(output)

    expect(doc.peersFound).toBe(2)
    expect(doc.reachableCount).toBe(1)
    expect(doc.enrolledCount).toBe(1)
    expect(doc.peers).toHaveLength(2)
  })

  it("keeps each peer's field names stable", async () => {
    const { output } = await run(["discover", "--json"], { discover: async () => peers })
    const doc = parseSingleDocument(output)
    const entries = doc.peers as Record<string, unknown>[]

    expect(Object.keys(entries[0]!).sort()).toEqual([
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

  it("preserves nulls rather than dropping unknown facts", async () => {
    const { output } = await run(["discover", "--json"], { discover: async () => peers })
    const doc = parseSingleDocument(output)
    const silent = (doc.peers as Record<string, unknown>[])[1]!

    // `null` means "we were not told"; collapsing it to `false` would invent a
    // fact the probe never learned.
    expect(silent.agentId).toBeNull()
    expect(silent.os).toBeNull()
    expect(silent.opencodeReachable).toBeNull()
  })

  it("reports a null enrolledSource when no profile was given", async () => {
    const { output } = await run(["discover", "--json"], { discover: async () => peers })

    expect(parseSingleDocument(output).enrolledSource).toBeNull()
  })

  it("reports which profile supplied the enrolled labels", async () => {
    const { output } = await run(["discover", "--json", "--profile", "dev-main"], {
      discover: async () => peers,
    })

    expect(parseSingleDocument(output).enrolledSource).toBe("dev-main")
  })

  it("states the trust caveat inside the payload", async () => {
    const { output } = await run(["discover", "--json"], { discover: async () => peers })
    const notice = String(parseSingleDocument(output).notice)

    expect(notice).toContain("Reachability is not authentication")
    expect(notice).toContain("Discovery enrols nothing")
  })

  it("reports an empty tailnet as success, not failure", async () => {
    const { exitCode, output } = await run(["discover", "--json"], { discover: async () => EMPTY })
    const doc = parseSingleDocument(output)

    expect(exitCode).toBe(0)
    expect(doc.ok).toBe(true)
    expect(doc.peers).toEqual([])
    expect(doc.peersFound).toBe(0)
  })

  it("is byte-identical across runs", async () => {
    const first = await run(["discover", "--json"], { discover: async () => peers })
    const second = await run(["discover", "--json"], { discover: async () => peers })

    // A consumer diffing or caching this output must not see it churn for
    // reasons that have nothing to do with the tailnet.
    expect(first.output).toBe(second.output)
  })

  it("never emits a node-enrollment credential", async () => {
    const { output } = await run(["discover", "--json"], {
      discover: async () => result({
        agents: [agent({ agentId: "tskey-abc123-secret-enrollment-key" })],
      }),
    })
    const doc = parseSingleDocument(output)

    // `tskey-` strings are reusable against the node, and `agentId` here came
    // from an unauthenticated `/health` on a tailnet any process can join. The
    // daemon's raw output never reaches this command; this is the guard over
    // the one field that crosses the network in the response direction.
    expect(output).not.toContain("tskey-")
    // Dropped rather than masked: a peer whose only self-description is a
    // credential-shaped string has not identified itself.
    expect((doc.peers as Record<string, unknown>[])[0]!.agentId).toBeNull()
  })

  it("scrubs the credential from the human widget too", async () => {
    const { output } = await run(["discover"], {
      discover: async () => result({
        agents: [agent({ agentId: "tskey-abc123-secret-enrollment-key" })],
      }),
    })

    expect(output).not.toContain("tskey-")
    expect(output).toContain("unidentified")
  })

  it("never surfaces the raw tailscale status document", async () => {
    const { output } = await run(["discover", "--json"], {
      discover: async () => result({ agents: [agent()] }),
    })

    expect(output).not.toContain("BackendState")
    expect(output).not.toContain("TailscaleIPs")
    expect(output).not.toContain("PublicKey")
  })
})

// ── Failures ────────────────────────────────────────────────────────────

describe("cli discover — failures", () => {
  it("exits nonzero when the probe throws", async () => {
    const { exitCode, output } = await run(["discover"], {
      discover: async () => {
        throw new Error("spawn /Users/somebody/Library/tailscale failed")
      },
    })

    expect(exitCode).not.toBe(0)
    expect(output).toContain("discovery failed")
    // The thrown message carried a path, and the CLI's rule is that operator
    // output never does.
    expect(output).not.toContain("/Users/somebody")
  })

  it("still emits a parseable document in --json mode", async () => {
    const { exitCode, output } = await run(["discover", "--json"], {
      discover: async () => {
        throw new Error("boom")
      },
    })
    const doc = parseSingleDocument(output)

    expect(exitCode).not.toBe(0)
    expect(doc.ok).toBe(false)
    expect(doc.schemaVersion).toBe(1)
    expect(doc.peers).toEqual([])
    expect(doc.error).toBe("discovery failed")
  })

  it("keeps the error document's shape aligned with the success document", async () => {
    const failure = parseSingleDocument(
      (await run(["discover", "--json"], {
        discover: async () => { throw new Error("boom") },
      })).output,
    )
    const success = parseSingleDocument(
      (await run(["discover", "--json"], { discover: async () => EMPTY })).output,
    )

    // A consumer switches on `ok`, not on which keys happen to be present.
    for (const key of ["schemaVersion", "enrolledSource", "peers", "peersFound", "reachableCount", "enrolledCount", "notice"]) {
      expect(failure).toHaveProperty(key)
      expect(success).toHaveProperty(key)
    }
  })
})
