/**
 * Stops the runtime processes a dead bridge left running (block K follow-up).
 *
 * A bridge that is SIGKILLed or crashes cannot stop its children: Claude Code
 * (and a `pre` / `script` / `post` step) keeps working in the repository
 * while the next bridge reports the job `interrupted: bridge restarted`. The
 * runner records every process it spawns (`FileRuntimeProcessRegistry`); the
 * next bridge on the profile calls this once at startup, before it relaunches
 * anything or serves, and stops what the records still describe.
 *
 * The rule, per record (never anything else):
 * - PID ≤ 1, this process, or this process's group: refused, logged.
 * - PID dead: nothing to do.
 * - PID alive but its start time cannot be read, was not recorded, is of
 *   another form (`linux:` vs `ps:`) or differs: NOT signalled. A differing
 *   start is a reused PID (the original is gone); the other cases are logged
 *   as unverifiable, for manual recovery (Docs/operations/troubleshooting.md).
 * - PID alive with the recorded start time: SIGTERM (to its process group
 *   when it was spawned as a group leader and still leads that group), then
 *   polled for up to `graceMs`; SIGKILL if still there. Before the SIGKILL
 *   the leader is verified again; once it is gone, the group is signalled
 *   only if it was seen alive at every poll since the leader was verified
 *   (a group id is not reused while any member of the group lives).
 *
 * Every record is removed once handled, whatever the outcome, so a later
 * start never acts on it again. All records are handled in parallel; the
 * whole pass takes at most about `graceMs + killWaitMs`.
 *
 * Only safe while no process on the profile is running jobs: the caller holds
 * the profile's state lock and has launched nothing yet.
 */
import { compareProcessStart, isProcessAlive, readProcessGroupId, readProcessStartTime } from "../host/process-identity.js"
import type { FileRuntimeProcessRegistry, RuntimeProcessRecord } from "./process-registry.js"

export const ORPHAN_KILL_GRACE_MS = 5_000
const ORPHAN_KILL_WAIT_MS = 1_000
const ORPHAN_POLL_MS = 100

export type OrphanOutcome =
  /** The process had already exited. */
  | { readonly action: "gone"; readonly record: RuntimeProcessRecord }
  /** The PID now names another process (different start time): the recorded one is gone. */
  | { readonly action: "reused"; readonly record: RuntimeProcessRecord }
  /** A live PID that could not be proven to be the recorded process: left alone. */
  | { readonly action: "unverified"; readonly record: RuntimeProcessRecord; readonly reason: string }
  /** A record naming a PID that must never be signalled. */
  | { readonly action: "refused"; readonly record: RuntimeProcessRecord; readonly reason: string }
  /** Signalled and gone; `signal` is the last signal sent. */
  | { readonly action: "terminated"; readonly record: RuntimeProcessRecord; readonly signal: "SIGTERM" | "SIGKILL"; readonly group: boolean }
  /** Still present after SIGKILL (e.g. uninterruptible sleep). */
  | { readonly action: "survived"; readonly record: RuntimeProcessRecord; readonly group: boolean }
  /** A record file that could not be read. */
  | { readonly action: "unreadable"; readonly path: string; readonly reason: string }
  /** Not supported on this platform; nothing was signalled. */
  | { readonly action: "unsupported"; readonly record: RuntimeProcessRecord }

export interface OrphanTerminationOptions {
  readonly registry: Pick<FileRuntimeProcessRegistry, "list" | "remove">
  readonly log?: (level: "info" | "warn" | "error", message: string) => void
  readonly platform?: NodeJS.Platform
  readonly isAlive?: (pid: number) => boolean
  readonly startTimeOf?: (pid: number) => string | undefined
  readonly processGroupOf?: (pid: number) => number | undefined
  /** `process.kill` semantics: a negative target is a process group; signal 0 probes. Throws on failure. */
  readonly kill?: (target: number, signal: NodeJS.Signals | 0) => void
  readonly selfPid?: number
  /** This process's group; read once with `processGroupOf(selfPid)` when absent. */
  readonly selfPgid?: number
  readonly graceMs?: number
  readonly killWaitMs?: number
  readonly pollMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  readonly clock?: () => number
}

const defaultLog = (level: "info" | "warn" | "error", message: string): void => {
  process.stderr.write(`aibridge ${level}: ${message}\n`)
}

/**
 * Handles every record of `options.registry` (see the module comment) and
 * returns what was done with each. Never throws.
 */
export async function terminateOrphanedRuntimeProcesses(options: OrphanTerminationOptions): Promise<OrphanOutcome[]> {
  const log = options.log ?? defaultLog
  const platform = options.platform ?? process.platform
  const entries = options.registry.list()
  if (entries.length === 0) return []
  if (platform !== "win32" && options.selfPgid === undefined) {
    const selfPgid = (options.processGroupOf ?? ((pid: number) => readProcessGroupId(pid)))(options.selfPid ?? process.pid)
    if (selfPgid !== undefined) options = { ...options, selfPgid }
  }

  const outcomes = await Promise.all(
    entries.map(async (entry): Promise<OrphanOutcome> => {
      if ("error" in entry) {
        log("warn", `ignoring unreadable runtime process record ${entry.path} (${entry.error})`)
        options.registry.remove(entry.path)
        return { action: "unreadable", path: entry.path, reason: entry.error }
      }
      let outcome: OrphanOutcome
      try {
        outcome =
          platform === "win32"
            ? { action: "unsupported", record: entry.record }
            : await handleRecord(entry.record, options, log)
      } catch (error) {
        outcome = { action: "unverified", record: entry.record, reason: error instanceof Error ? error.message : String(error) }
      }
      logOutcome(outcome, log)
      options.registry.remove(entry.path)
      return outcome
    }),
  )
  return outcomes
}

function describe(record: RuntimeProcessRecord): string {
  return `${record.role} process ${record.pid} of job ${record.jobId}`
}

function logOutcome(outcome: OrphanOutcome, log: (level: "info" | "warn" | "error", message: string) => void): void {
  switch (outcome.action) {
    case "gone":
      log("info", `${describe(outcome.record)} left by the previous bridge had already exited`)
      return
    case "reused":
      log("info", `${describe(outcome.record)} left by the previous bridge has exited (PID ${outcome.record.pid} is now another process, left alone)`)
      return
    case "unverified":
      log(
        "warn",
        `${describe(outcome.record)} left by the previous bridge could not be verified (${outcome.reason}); NOT stopped. ` +
          `If it is still working on the job, stop it by hand (Docs/operations/troubleshooting.md)`,
      )
      return
    case "refused":
      log("warn", `refusing to signal ${describe(outcome.record)}: ${outcome.reason}`)
      return
    case "terminated":
      log("info", `stopped ${describe(outcome.record)} left by the previous bridge (${outcome.signal}${outcome.group ? ", process group" : ""})`)
      return
    case "survived":
      log("error", `${describe(outcome.record)} left by the previous bridge is still present after SIGKILL${outcome.group ? " (process group)" : ""}`)
      return
    case "unsupported":
      log(
        "warn",
        `${describe(outcome.record)} may have been left by the previous bridge; stopping it is not supported on Windows. ` +
          `Check it by hand (Docs/operations/troubleshooting.md)`,
      )
      return
    case "unreadable":
      return
  }
}

async function handleRecord(
  record: RuntimeProcessRecord,
  options: OrphanTerminationOptions,
  log: (level: "info" | "warn" | "error", message: string) => void,
): Promise<OrphanOutcome> {
  const isAlive = options.isAlive ?? isProcessAlive
  const startTimeOf = options.startTimeOf ?? ((pid: number) => readProcessStartTime(pid))
  const processGroupOf = options.processGroupOf ?? ((pid: number) => readProcessGroupId(pid))
  const kill = options.kill ?? ((target: number, signal: NodeJS.Signals | 0) => void process.kill(target, signal))
  const selfPid = options.selfPid ?? process.pid
  const selfPgid = options.selfPgid
  const graceMs = options.graceMs ?? ORPHAN_KILL_GRACE_MS
  const killWaitMs = options.killWaitMs ?? ORPHAN_KILL_WAIT_MS
  const pollMs = options.pollMs ?? ORPHAN_POLL_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const clock = options.clock ?? Date.now

  const { pid } = record
  if (!Number.isInteger(pid) || pid <= 1) return { action: "refused", record, reason: `PID ${pid} is never signalled` }
  if (pid === selfPid) return { action: "refused", record, reason: "it is this process" }
  if (selfPgid !== undefined && pid === selfPgid) return { action: "refused", record, reason: "it leads this process's group" }
  if (record.pgid !== undefined) {
    if (!Number.isInteger(record.pgid) || record.pgid <= 1 || record.pgid === selfPid || record.pgid === selfPgid) {
      return { action: "refused", record, reason: `its process group ${record.pgid} is this process's or invalid` }
    }
  }

  if (!isAlive(pid)) return { action: "gone", record }
  const verdict = compareProcessStart(record.start, startTimeOf(pid))
  if (verdict === "different") return isAlive(pid) ? { action: "reused", record } : { action: "gone", record }
  if (verdict === "unverifiable") {
    if (!isAlive(pid)) return { action: "gone", record }
    const reason =
      record.start === undefined || record.start.length === 0
        ? "no start time was recorded"
        : "its start time cannot be read now, or was read by another method"
    return { action: "unverified", record, reason }
  }

  // Verified: this is the process the previous bridge spawned. Signal its
  // group only when it still leads the group it was spawned with.
  let group = false
  if (record.pgid !== undefined) {
    const current = processGroupOf(pid)
    group = current === record.pgid
    if (!group) log("warn", `${describe(record)} no longer leads process group ${record.pgid}; signalling the process only`)
  }
  const target = group ? -record.pgid! : pid
  const present = (): boolean => {
    if (!group) return isAlive(pid)
    try {
      kill(target, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }
  const signal = (name: NodeJS.Signals): boolean => {
    try {
      kill(target, name)
      return true
    } catch {
      return false
    }
  }

  log("info", `stopping ${describe(record)} left by the previous bridge: SIGTERM${group ? ` to process group ${record.pgid}` : ""}`)
  if (!signal("SIGTERM")) return present() ? { action: "survived", record, group } : { action: "terminated", record, signal: "SIGTERM", group }

  // Resolves true as soon as the target is seen gone: from then on it is
  // never signalled again.
  const waitGone = async (budgetMs: number): Promise<boolean> => {
    const deadline = clock() + budgetMs
    while (clock() < deadline) {
      await sleep(Math.min(pollMs, Math.max(1, deadline - clock())))
      if (!present()) return true
    }
    return !present()
  }
  if (await waitGone(graceMs)) return { action: "terminated", record, signal: "SIGTERM", group }

  // Still there after the grace. Escalate only to what is still proven to be
  // the recorded process: the leader, verified again, or (group only) a group
  // that was present at every poll since the leader was verified, so its
  // members are the leader's descendants (a group id is not reused while any
  // member of the group lives).
  if (isAlive(pid)) {
    const again = compareProcessStart(record.start, startTimeOf(pid))
    // Process only: the recorded process exited and its PID was reused.
    if (again === "different" && !group) return { action: "terminated", record, signal: "SIGTERM", group }
    if (again !== "same") return { action: "unverified", record, reason: "it could not be verified again before SIGKILL" }
  } else if (!group) {
    return { action: "terminated", record, signal: "SIGTERM", group }
  }
  log("warn", `${describe(record)} ignored SIGTERM for ${graceMs} ms: SIGKILL${group ? ` to process group ${record.pgid}` : ""}`)
  signal("SIGKILL")
  if (await waitGone(killWaitMs)) return { action: "terminated", record, signal: "SIGKILL", group }
  return { action: "survived", record, group }
}
