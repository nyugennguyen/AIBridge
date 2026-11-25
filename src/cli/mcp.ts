/**
 * `aibr mcp serve|summary` entry points.
 *
 * Registration in src/cli.ts (done by the coordinator):
 *   aibr mcp serve   [--profile <p>]   -> runMcpServe(args)
 *   aibr mcp summary [--profile <p>]   -> runMcpSummary(args)
 * Both resolve with a process exit code. `serve` never writes to stdout except
 * protocol frames; `summary` always resolves 0 and stays silent on any error.
 */
import { BridgeTools, TERMINAL_STATUSES, defaultBridgeToolDeps, type BridgeToolDeps } from "../mcp/bridge-tools.js"
import { McpServer, serveStdio } from "../mcp/server.js"

export interface McpCliDeps {
  readonly tools: BridgeToolDeps
  readonly input: AsyncIterable<string | Uint8Array>
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

function defaultDeps(): McpCliDeps {
  return {
    tools: defaultBridgeToolDeps(),
    input: process.stdin,
    stdout: (text) => {
      process.stdout.write(text)
    },
    stderr: (text) => {
      process.stderr.write(text)
    },
  }
}

/** Pull `--profile <v>` / `--profile=<v>` out of argv. Empty string means "unset". */
export function parseProfileArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (arg === "--profile") return (argv[i + 1] ?? "").trim() || undefined
    if (arg.startsWith("--profile=")) return arg.slice("--profile=".length).trim() || undefined
  }
  return undefined
}

export async function runMcpServe(argv: readonly string[], deps: McpCliDeps = defaultDeps()): Promise<number> {
  const server = new McpServer(new BridgeTools(deps.tools, parseProfileArg(argv)))
  try {
    await serveStdio(server, { input: deps.input, write: (line) => deps.stdout(line) })
    return 0
  } catch (error) {
    deps.stderr(`aibridge mcp: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/** SessionStart summary: at most 5 lines; any failure yields no output and exit 0. */
export async function runMcpSummary(argv: readonly string[], deps: McpCliDeps = defaultDeps()): Promise<number> {
  try {
    const tools = new BridgeTools(deps.tools, parseProfileArg(argv))
    const profile = await tools.loadProfile()
    const peers = profile.config.agents
    if (peers.length === 0) return 0
    const reach = await Promise.all(peers.map(async (peer) => ({ peer, up: await tools.peerReachable(peer) })))
    const lines: string[] = [
      `AIBridge (${profile.name}): ` +
        reach.map(({ peer, up }) => `${peer.id} ${up ? "up" : "unreachable"} [${peer.capabilities.join(", ")}]`).join("; "),
    ]
    const ledger = (await tools.readLedger(profile)).slice(-5)
    const statuses = await Promise.all(ledger.map((entry) => tools.fetchJobStatus(profile, entry)))
    const running = ledger.flatMap((entry, i) => {
      const status = statuses[i]
      return status !== null && status !== undefined && !TERMINAL_STATUSES.has(status) ? [`${entry.job_id.slice(0, 8)}@${entry.target}:${status}`] : []
    })
    if (running.length > 0) lines.push(`Running jobs: ${running.join(", ")}`)
    lines.push("Use the aibridge-dispatch skill or /aibridge:bridge-send to hand work to a peer.")
    deps.stdout(lines.slice(0, 5).join("\n") + "\n")
  } catch {
    // silent by design
  }
  return 0
}
