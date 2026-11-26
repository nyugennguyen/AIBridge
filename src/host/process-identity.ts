/**
 * Telling one process apart from another that later got the same PID.
 *
 * A PID alone names a process only while it lives: after it exits (or after
 * a reboot) the number is handed out again. Whoever stores a PID to act on it
 * later (the state lock, the runtime process registry) also stores the PID's
 * start time and compares it before acting.
 *
 * The start time is a raw string compared exactly, never parsed, and is
 * independent of time zone and locale: on Linux the boot id plus
 * `/proc/<pid>/stat` field 22 (clock ticks since boot), elsewhere
 * `ps -o lstart=` run with `TZ=UTC` and `LC_ALL=C`. The two forms carry a
 * prefix (`linux:`, `ps:`) and are never compared with each other.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

/** Whether `pid` names a live process. EPERM (alive, another user's) counts as alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, owned by another user. Its start time decides.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** What `readProcessStartTime` and `readProcessGroupId` read through. Injectable so both paths are testable anywhere. */
export interface StartTimeSources {
  readonly platform: NodeJS.Platform
  /** A file's text, or `undefined` if it cannot be read. */
  readonly readFile: (path: string) => string | undefined
  /** `ps -o lstart= -p <pid>` under `env`; `undefined` on failure. */
  readonly runPs: (pid: number, env: Record<string, string | undefined>) => string | undefined
  /** The environment `ps` starts from (TZ and locale are overridden). */
  readonly env: Record<string, string | undefined>
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

function runPsColumn(column: string, pid: number, env: Record<string, string | undefined>): string | undefined {
  try {
    return execFileSync("ps", ["-o", `${column}=`, "-p", String(pid)], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    })
  } catch {
    return undefined
  }
}

const defaultSources: StartTimeSources = {
  platform: process.platform,
  readFile: (path) => readText(path),
  runPs: (pid, env) => runPsColumn("lstart", pid, env),
  env: process.env,
}

/** The fields of `/proc/<pid>/stat` after `comm`, which is parenthesised and may hold spaces. */
function statFieldsAfterComm(stat: string): string[] {
  return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)
}

/**
 * A raw, time-zone- and locale-independent start time for `pid`, or
 * `undefined` if it cannot be read. Two readings of the same process compare
 * equal as strings; a different process (a reused PID, or any PID after a
 * reboot) reads differently.
 *
 * - Linux: `linux:<boot_id>:<starttime>`, from `/proc/sys/kernel/random/boot_id`
 *   and field 22 of `/proc/<pid>/stat` (clock ticks since boot). No `ps`.
 * - Elsewhere (macOS): `ps:<lstart>` with `TZ=UTC`, `LC_ALL=C`, `LANG=C`.
 */
export function readProcessStartTime(pid: number, sources: Partial<StartTimeSources> = {}): string | undefined {
  const source = { ...defaultSources, ...sources }
  if (source.platform === "linux") {
    const stat = source.readFile(`/proc/${pid}/stat`)
    const bootId = source.readFile("/proc/sys/kernel/random/boot_id")?.trim()
    if (stat !== undefined && bootId !== undefined && bootId.length > 0) {
      const startTicks = statFieldsAfterComm(stat)[22 - 3]
      if (startTicks !== undefined && /^\d+$/.test(startTicks)) return `linux:${bootId}:${startTicks}`
    }
  }
  const out = source.runPs(pid, { ...source.env, TZ: "UTC", LC_ALL: "C", LANG: "C" })
  const start = out?.trim().replace(/\s+/g, " ")
  return start !== undefined && start.length > 0 ? `ps:${start}` : undefined
}

/** The method prefix of a start time (`linux`, `ps`), or "" for an unprefixed value. */
export function startTimeForm(start: string): string {
  return /^(linux|ps):/.exec(start)?.[1] ?? ""
}

/**
 * Whether a recorded start time and the PID's current one name the same process:
 * - `same`: both read, of the same form, equal;
 * - `different`: both read, of the same form, not equal (the PID was reused);
 * - `unverifiable`: either is missing or empty, or the forms differ (`linux:`
 *   against `ps:`, e.g. two PID namespaces sharing a state directory).
 */
export function compareProcessStart(
  recorded: string | undefined,
  current: string | undefined,
): "same" | "different" | "unverifiable" {
  if (recorded === undefined || recorded.length === 0 || current === undefined || current.length === 0) return "unverifiable"
  if (startTimeForm(recorded) !== startTimeForm(current)) return "unverifiable"
  return recorded === current ? "same" : "different"
}

/** What `readProcessGroupId` reads through. */
export interface ProcessGroupSources {
  readonly platform: NodeJS.Platform
  readonly readFile: (path: string) => string | undefined
  /** `ps -o pgid= -p <pid>`; `undefined` on failure. */
  readonly runPs: (pid: number) => string | undefined
}

const defaultGroupSources: ProcessGroupSources = {
  platform: process.platform,
  readFile: (path) => readText(path),
  runPs: (pid) => runPsColumn("pgid", pid, { ...process.env, LC_ALL: "C", LANG: "C" }),
}

/**
 * The process group id of `pid`, or `undefined` when it cannot be read.
 * Linux: field 5 of `/proc/<pid>/stat`; elsewhere `ps -o pgid=`.
 */
export function readProcessGroupId(pid: number, sources: Partial<ProcessGroupSources> = {}): number | undefined {
  const source = { ...defaultGroupSources, ...sources }
  let raw: string | undefined
  if (source.platform === "linux") {
    const stat = source.readFile(`/proc/${pid}/stat`)
    if (stat !== undefined) raw = statFieldsAfterComm(stat)[5 - 3]
  }
  raw ??= source.runPs(pid)?.trim()
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined
  const pgid = Number.parseInt(raw, 10)
  return pgid > 0 ? pgid : undefined
}
