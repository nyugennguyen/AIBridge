/**
 * `aibr logs [--profile <p>] [-f] [-n <lines>]` — print the bridge log of a
 * profile (`<stateDir>/logs/aibridge.log`, see src/host/logs.ts).
 */
import { resolveProfilePaths, validateProfileName } from "../host/paths.js"
import { bridgeLogPath, followLog, fsLogFileReader, tailLines, type LogFileReader } from "../host/logs.js"
import { needsValue, unexpectedArgument, unknownFlag } from "./arg-errors.js"

export const LOGS_HELP = [
  "aibr logs — print the bridge log of a profile",
  "",
  "Usage:",
  "  aibr logs [--profile <name>] [-f|--follow] [-n|--lines <count>]",
  "",
  "Prints the last lines (default 100) of <state dir>/logs/aibridge.log. The bridge",
  "writes its own lines there (startup, listen address, one line per request:",
  "method, path, status, duration; never headers or bodies), and the user service",
  "started by \"aibr start\" sends its stdout and stderr there too, so a crash at",
  "startup is in this file. -f keeps printing new lines until Ctrl-C.",
  "--profile defaults to AIBR_PROFILE, then \"default\".",
  "",
].join("\n")

export interface LogsCliDeps {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly write: (text: string) => void
  readonly reader?: LogFileReader
  readonly sleep?: (ms: number) => Promise<void>
  /** Resolves when the user interrupts (Ctrl-C). Default: SIGINT/SIGTERM. */
  readonly interrupted?: () => Promise<void>
}

interface ParsedLogsArgs {
  readonly profile?: string
  readonly follow: boolean
  readonly lines: number
  readonly help: boolean
}

export function parseLogsArgs(argv: readonly string[]): ParsedLogsArgs | string {
  let profile: string | undefined
  let follow = false
  let lines = 100
  let help = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === "--profile" || arg === "-p") {
      const value = argv[++i]
      if (value === undefined || value === "") return needsValue(arg, "logs")
      profile = value
    } else if (arg === "-f" || arg === "--follow") {
      follow = true
    } else if (arg === "-n" || arg === "--lines") {
      const value = argv[++i]
      const parsed = value === undefined ? Number.NaN : Number(value)
      if (!Number.isInteger(parsed) || parsed < 0) return `${arg} needs a whole number: aibr logs ${arg} <count>`
      lines = parsed
    } else if (arg === "--help" || arg === "-h") {
      help = true
    } else {
      return arg.startsWith("-") ? unknownFlag(arg, "logs") : unexpectedArgument(arg, "logs")
    }
  }
  return { ...(profile !== undefined ? { profile } : {}), follow, lines, help }
}

export async function runLogsCommand(argv: readonly string[], deps: LogsCliDeps): Promise<number> {
  const parsed = parseLogsArgs(argv)
  if (typeof parsed === "string") {
    deps.write(`Error: ${parsed}\n`)
    return 64
  }
  if (parsed.help) {
    deps.write(LOGS_HELP)
    return 0
  }
  let profile: string
  try {
    profile = validateProfileName(parsed.profile ?? deps.env.AIBR_PROFILE ?? "default")
  } catch {
    deps.write("Error: Invalid profile name (use alphanumeric and hyphens, 1-64 chars)\n")
    return 64
  }
  const path = bridgeLogPath(resolveProfilePaths(profile, { ...deps.env }).stateDir)
  const reader = deps.reader ?? fsLogFileReader
  const tail = tailLines(reader, path, parsed.lines)
  if (tail === null && !parsed.follow) {
    deps.write(
      `No log yet for profile "${profile}" (${path}).\n` +
        `The bridge writes it once it runs: aibr start --profile ${profile}\n`,
    )
    return 1
  }
  if (tail !== null) deps.write(tail.text)
  if (!parsed.follow) return 0

  if (tail === null) deps.write(`Waiting for ${path} ...\n`)
  let stop = false
  void (deps.interrupted ?? onInterrupt)().then(() => {
    stop = true
  })
  await followLog({
    reader,
    path,
    from: tail?.end ?? 0,
    write: deps.write,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    stopped: () => stop,
  })
  return 0
}

function onInterrupt(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve())
    process.once("SIGTERM", () => resolve())
  })
}
