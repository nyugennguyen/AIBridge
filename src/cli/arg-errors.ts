/**
 * User-facing argument errors, phrased so the reader knows what to type next.
 *
 * Every message names the flag AND shows it with a `<placeholder>` for the
 * value it takes ("--profile needs a value: aibr status --profile <name>"),
 * because "--profile is required" alone leaves the user guessing whether the
 * flag is wrong, its value is missing, or which value would do. Errors about a
 * missing profile also list the profiles this machine has, since that list is
 * the answer the user is about to go and look for.
 */
import { existsSync, readdirSync } from "node:fs"
import { dirname } from "node:path"
import { resolveProfilePaths, validateProfileName } from "../host/paths.js"

const PROG = "aibr"

/** The value each flag takes, as shown to the user. */
const PLACEHOLDERS: Readonly<Record<string, string>> = {
  "--profile": "<name>",
  "-p": "<name>",
  "--config": "<path>",
  "--capabilities": "<capability,capability>",
  "--capability": "<capability>",
  "--ttl": "<duration, e.g. 30m>",
  "--timeout": "<seconds>",
  "--timeout-seconds": "<seconds>",
  "--project": "<project>",
  "--node": "<agent_id>",
  "--status": "<status>",
  "--limit": "<count>",
  "--lines": "<count>",
  "-n": "<count>",
  "--reason": "<text>",
  "--role": "<worker|orchestrator|both>",
  "--runtime": "<opencode|claude>",
  "--port": "<port>",
  "--join": "<pairing code>",
  "--scope": "<user|project|local>",
  "--marketplace": "<bundled|github>",
}

/** `--profile <name>`: the flag with the placeholder of the value it takes. */
export function flagWithPlaceholder(flag: string): string {
  const placeholder = PLACEHOLDERS[flag]
  return placeholder === undefined ? flag : `${flag} ${placeholder}`
}

function commandPrefix(command: string | undefined): string {
  return command === undefined || command === "" ? PROG : `${PROG} ${command}`
}

/** `--profile needs a value: aibr status --profile <name>` */
export function needsValue(flag: string, command?: string): string {
  return `${flag} needs a value: ${commandPrefix(command)} ${flagWithPlaceholder(flag)}`
}

/** `unknown flag --x (see: aibr status --help)` */
export function unknownFlag(arg: string, command?: string): string {
  return `unknown flag ${arg} (see: ${commandPrefix(command)} --help)`
}

/** `unexpected argument x (see: aibr logs --help)` */
export function unexpectedArgument(arg: string, command?: string): string {
  return `unexpected argument ${arg} (see: ${commandPrefix(command)} --help)`
}

/**
 * The profiles that exist on this machine (a directory holding a
 * `config.json`), sorted. Empty when there are none or the config root cannot
 * be read.
 */
export function listProfileNames(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  try {
    const root = dirname(resolveProfilePaths("default", { ...env }).configDir)
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          validateProfileName(name)
        } catch {
          return false
        }
        return existsSync(`${root}/${name}/config.json`)
      })
      .sort()
  } catch {
    return []
  }
}

/** The lines after "Error: ..." that say which profiles exist and what to run. */
function profileHint(command: string, profiles: readonly string[]): string {
  if (profiles.length === 0) return `  No profile on this machine yet. Create one with: ${PROG} init`
  const lines = [`  Profiles on this machine: ${profiles.join(", ")}`]
  if (profiles.length === 1) lines.push(`  Try: ${PROG} ${command} --profile ${profiles[0]}`)
  return lines.join("\n")
}

/**
 * The whole message for a command run without a profile it needs, or with
 * `--profile` and no value after it. Multi-line; does not end in a newline.
 */
export function profileMissing(
  command: string,
  flagGivenWithoutValue: boolean,
  profiles: readonly string[],
  alternative?: string,
): string {
  const first = flagGivenWithoutValue
    ? needsValue("--profile", command)
    : `${PROG} ${command} needs a profile: ${PROG} ${command} --profile <name>${alternative !== undefined ? ` (${alternative})` : ""}`
  return `${first}\n${profileHint(command, profiles)}`
}
