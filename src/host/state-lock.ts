/**
 * One executing process per profile state directory.
 *
 * `aibr serve` (engine ingress) and `aibr worker` (router ingress) reconcile
 * the job store when they start: anything the store says is in flight is
 * taken to be left by a dead process and is interrupted (block K). A second
 * process started on the same profile (for example `aibr start --foreground`
 * while the user service is running) would therefore interrupt the live
 * process's jobs. Both take this lock first and hold it for their lifetime;
 * the second one refuses to start and touches nothing.
 *
 * The lock is `<stateDir>/aibridge.lock`, a JSON file with the holder's PID,
 * the PID's start time (`readProcessStartTime`) and a random token. The start
 * time is a raw string compared exactly, never parsed, and is independent of
 * time zone and locale: on Linux the boot id plus `/proc/<pid>/stat` field 22
 * (clock ticks since boot), elsewhere `ps -o lstart=` run with `TZ=UTC` and
 * `LC_ALL=C`.
 *
 * The lock is STALE only when its PID is dead, or when both start times (the
 * stored one and the PID's current one) were read and differ: a PID reused
 * after a crash or a reboot. Anything that cannot be verified (start time
 * unreadable now, or missing from the file, as in the pre-3.2 format) with a
 * live PID counts as HELD: a rare manual recovery is safer than two bridges
 * reconciling the same jobs.
 *
 * Taking a stale lock over: the stale file is first renamed to a unique name;
 * only the process whose rename succeeds goes on, and it re-checks what it
 * moved (a live lock moved by mistake is put back). The new lock is created
 * atomically (`link`, which fails if the file exists) and then read back to
 * confirm it holds this process's token.
 */
import { randomUUID } from "node:crypto"
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { compareProcessStart, isProcessAlive, readProcessStartTime } from "./process-identity.js"

// The PID start-time reader lives in `process-identity.ts` (shared with the
// runtime process registry); re-exported for existing importers.
export { isProcessAlive, readProcessStartTime, type StartTimeSources } from "./process-identity.js"

export const STATE_LOCK_FILE = "aibridge.lock"

export class StateLockHeldError extends Error {
  readonly code = "state_dir_locked"
  constructor(
    readonly path: string,
    readonly pid: number,
  ) {
    super(
      `Another AIBridge process (PID ${pid}) is already running on this profile (lock ${path}). ` +
        `Stop it first (aibr stop). If PID ${pid} is not AIBridge, remove ${path} and start again ` +
        `(manual recovery: Docs/operations/troubleshooting.md). No job was touched.`,
    )
  }
}

export interface StateLock {
  readonly path: string
  /** Removes the lock if this process still owns it. Idempotent. */
  release(): void
}

export interface StateLockOptions {
  readonly pid?: number
  /** Whether a PID is a live process. Injectable for tests. */
  readonly isAlive?: (pid: number) => boolean
  /** A PID's start time, or `undefined` when it cannot be read. Injectable for tests. */
  readonly startTimeOf?: (pid: number) => string | undefined
  /** Test seam: called after a lock was judged stale, before it is moved aside. */
  readonly beforeTakeover?: () => void
}

interface LockContent {
  readonly pid: number
  readonly start: string
  readonly token: string
}

/**
 * The lock's holder. A pre-3.2 file (`"<pid> <token>"`) or one without a
 * start time yields `start: ""` (unverifiable); a file with no PID at all
 * yields `undefined`.
 */
function parseLock(text: string | undefined): LockContent | undefined {
  if (text === undefined) return undefined
  try {
    const value = JSON.parse(text) as Partial<LockContent>
    if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return undefined
    return {
      pid: value.pid,
      start: typeof value.start === "string" ? value.start : "",
      token: typeof value.token === "string" ? value.token : "",
    }
  } catch {
    const pid = Number.parseInt(text.trim().split(/\s+/)[0] ?? "", 10)
    return Number.isInteger(pid) && pid > 0 ? { pid, start: "", token: "" } : undefined
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

/**
 * Takes the lock of `stateDir`, or throws `StateLockHeldError` naming the
 * live holder. Another holder in this same process counts as live.
 */
export function acquireStateLock(stateDir: string, options: StateLockOptions = {}): StateLock {
  const pid = options.pid ?? process.pid
  const isAlive = options.isAlive ?? isProcessAlive
  const startTimeOf = options.startTimeOf ?? ((target: number) => readProcessStartTime(target))
  mkdirSync(stateDir, { recursive: true })
  const path = join(stateDir, STATE_LOCK_FILE)
  const token = randomUUID()
  const mine: LockContent = { pid, start: startTimeOf(pid) ?? "", token }

  // Stale only if the PID is dead, or both start times were read and differ.
  // Unverifiable (either start time unknown) with a live PID: held.
  const isHeld = (holder: LockContent | undefined): holder is LockContent => {
    if (holder === undefined || !isAlive(holder.pid)) return false
    if (holder.start.length === 0) return true
    // Unverifiable (current start unreadable, or readings from different
    // methods, `linux:` vs `ps:`, e.g. two PID namespaces sharing the state
    // dir): held. Only a proven different start time makes it stale.
    return compareProcessStart(holder.start, startTimeOf(holder.pid)) !== "different"
  }

  // Bounded, but generous: under contention a round can be lost to another
  // process's rename and simply starts again.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    // Written in full first, then linked into place: a reader never sees a
    // half-written lock, and `link` fails if the lock exists (as O_EXCL would).
    const staged = `${path}.${randomUUID()}.tmp`
    writeFileSync(staged, `${JSON.stringify(mine)}\n`, { mode: 0o600 })
    let created = false
    try {
      linkSync(staged, path)
      created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    } finally {
      try {
        unlinkSync(staged)
      } catch {
        /* nothing to clean */
      }
    }

    if (created) {
      const written = parseLock(readText(path))
      if (written?.token === token) return lockHandle(path, token)
      // Someone moved ours aside and took over: theirs decides.
      if (isHeld(written)) throw new StateLockHeldError(path, written.pid)
      continue
    }

    const holder = parseLock(readText(path))
    // Ours, put back by a process that moved it aside by mistake.
    if (holder?.token === token) return lockHandle(path, token)
    if (isHeld(holder)) throw new StateLockHeldError(path, holder.pid)

    // Stale (dead or reused PID, unreadable, old format). Only the process
    // whose rename succeeds takes it over; the others start again.
    options.beforeTakeover?.()
    const aside = `${path}.stale-${randomUUID()}`
    try {
      renameSync(path, aside)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    const moved = parseLock(readText(aside))
    if (isHeld(moved)) {
      // A live lock was created between our read and our rename: put it back.
      try {
        linkSync(aside, path)
      } catch {
        /* someone else is already there */
      }
      try {
        unlinkSync(aside)
      } catch {
        /* gone */
      }
      throw new StateLockHeldError(path, moved.pid)
    }
    try {
      unlinkSync(aside)
    } catch {
      /* gone */
    }
  }
  const last = parseLock(readText(path))
  if (last !== undefined && last.token !== token) throw new StateLockHeldError(path, last.pid)
  throw new Error(`Could not take the state lock ${path}`)
}

function lockHandle(path: string, token: string): StateLock {
  let released = false
  return {
    path,
    release() {
      if (released) return
      released = true
      if (parseLock(readText(path))?.token === token) {
        try {
          unlinkSync(path)
        } catch {
          /* already gone */
        }
      }
    },
  }
}
