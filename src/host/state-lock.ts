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
 * The lock is a file created atomically (`link`, which fails if the file
 * exists) holding the owner's PID. A file whose PID is no longer alive is
 * stale (the owner crashed) and is replaced. Two processes replacing the same
 * stale file at the same instant is not fully excluded; that needs a crash and
 * two simultaneous starts.
 */
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
        `Stop it first (aibr stop), or check that PID ${pid} is not AIBridge and remove the lock. No job was touched.`,
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
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, owned by someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function readHolder(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").split(/\s/)[0] ?? "", 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
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
  mkdirSync(stateDir, { recursive: true })
  const path = join(stateDir, STATE_LOCK_FILE)
  const token = `${pid} ${randomUUID()}`

  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Written in full first, then linked into place: a reader never sees a
    // half-written lock, and `link` fails if the lock exists.
    const staged = `${path}.${randomUUID()}.tmp`
    writeFileSync(staged, `${token}\n`, { mode: 0o600 })
    try {
      linkSync(staged, path)
      let released = false
      return {
        path,
        release() {
          if (released) return
          released = true
          try {
            if (readFileSync(path, "utf8").trim() === token) unlinkSync(path)
          } catch {
            /* already gone */
          }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    } finally {
      try {
        unlinkSync(staged)
      } catch {
        /* nothing to clean */
      }
    }

    const holder = readHolder(path)
    if (holder !== undefined && isAlive(holder)) throw new StateLockHeldError(path, holder)
    // Stale (the holder died) or unreadable: move it aside and try again.
    const aside = `${path}.stale-${randomUUID()}`
    try {
      renameSync(path, aside)
      unlinkSync(aside)
    } catch {
      /* someone else moved it; retry */
    }
  }
  throw new Error(`Could not take the state lock ${path}`)
}
