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
 * the PID's start time (`ps -o lstart=`) and a random token. It is HELD only
 * while that PID is alive AND still has that start time: a PID reused after a
 * crash or a reboot has another start time, so the lock is stale and is
 * replaced. A file in another format, or a holder whose start time cannot be
 * read, is stale too: a lock that cannot be verified must not keep the
 * service from starting.
 *
 * Taking a stale lock over: the stale file is first renamed to a unique name;
 * only the process whose rename succeeds goes on, and it re-checks what it
 * moved (a live lock moved by mistake is put back). The new lock is created
 * atomically (`link`, which fails if the file exists) and then read back to
 * confirm it holds this process's token.
 */
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const STATE_LOCK_FILE = "aibridge.lock"

export class StateLockHeldError extends Error {
  readonly code = "state_dir_locked"
  constructor(
    readonly path: string,
    readonly pid: number,
  ) {
    super(
      `Another AIBridge process (PID ${pid}) is already running on this profile (lock ${path}). ` +
        `Stop it first (aibr stop). If PID ${pid} is not AIBridge, remove the lock file and start again. No job was touched.`,
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

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, owned by another user. Its start time decides.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * The start time `ps` reports for a PID (`lstart`, same format on macOS and
 * Linux under the C locale), or `undefined` if the PID does not exist or `ps`
 * fails.
 */
export function processStartTime(pid: number): string | undefined {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    })
    const start = out.trim().replace(/\s+/g, " ")
    return start.length > 0 ? start : undefined
  } catch {
    return undefined
  }
}

function parseLock(text: string | undefined): LockContent | undefined {
  if (text === undefined) return undefined
  try {
    const value = JSON.parse(text) as Partial<LockContent>
    if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return undefined
    if (typeof value.start !== "string" || typeof value.token !== "string") return undefined
    return { pid: value.pid, start: value.start, token: value.token }
  } catch {
    return undefined
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
  const startTimeOf = options.startTimeOf ?? processStartTime
  mkdirSync(stateDir, { recursive: true })
  const path = join(stateDir, STATE_LOCK_FILE)
  const token = randomUUID()
  const mine: LockContent = { pid, start: startTimeOf(pid) ?? "", token }

  const isHeld = (holder: LockContent | undefined): holder is LockContent => {
    if (holder === undefined || holder.start.length === 0 || !isAlive(holder.pid)) return false
    return startTimeOf(holder.pid) === holder.start
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
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
