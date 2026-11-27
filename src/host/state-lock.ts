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
 * Taking a stale lock over never leaves the lock path empty, so a newcomer
 * always finds either the stale lock or its successor, never a free slot:
 * - The taker claims that exact stale content: it creates
 *   `aibridge.lock.claim-<sha256 of the content>-<n>` with `link` (fails if
 *   it exists, as O_EXCL would). Only one process wins a given claim.
 * - A claim whose claimant is live (same rule as the lock) makes the lock
 *   HELD. One whose claimant is dead (a takeover left half done) is skipped:
 *   the next claim is `<n + 1>`. Claims are never removed while contended.
 * - The winner re-reads the lock; if it still holds the claimed content, the
 *   new lock replaces it in one `rename`. Otherwise someone else got there
 *   first and the round starts again.
 * - The winner then removes the claims of the content it replaced. A late
 *   taker that claims that content afterwards re-reads the lock, sees it
 *   changed and backs off.
 *
 * Up to 3.2.1 a stale lock was renamed aside and a live lock moved by
 * mistake was put back. Between the two the path was empty, and a third
 * process could take it while the first holder still believed it held it.
 *
 * A new lock on an empty path is created atomically (`link`) and then read
 * back to confirm it holds this process's token.
 */
import { createHash, randomUUID } from "node:crypto"
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
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
  /** Test seam: called after a lock was judged stale, before it is claimed. */
  readonly beforeTakeover?: () => void
  /** Test seam: called once this process holds the claim on a stale lock, before replacing it. */
  readonly afterClaim?: () => void
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

  /** Written in full first, so whoever links or renames it into place never exposes a half-written file. */
  const stage = (content: LockContent): string => {
    const staged = `${path}.${randomUUID()}.tmp`
    writeFileSync(staged, `${JSON.stringify(content)}\n`, { mode: 0o600 })
    return staged
  }
  const remove = (target: string): void => {
    try {
      unlinkSync(target)
    } catch {
      /* already gone */
    }
  }

  // Bounded, but generous: under contention a round can be lost to another
  // process's takeover and simply starts again.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    // `link` fails if the lock exists (as O_EXCL would).
    const staged = stage(mine)
    let created = false
    try {
      linkSync(staged, path)
      created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    } finally {
      remove(staged)
    }

    if (created) {
      const written = parseLock(readText(path))
      if (written?.token === token) return lockHandle(path, token)
      if (isHeld(written)) throw new StateLockHeldError(path, written.pid)
      continue
    }

    const text = readText(path)
    // Released between our `link` and our read: try again.
    if (text === undefined) continue
    const holder = parseLock(text)
    if (holder?.token === token) return lockHandle(path, token)
    if (isHeld(holder)) throw new StateLockHeldError(path, holder.pid)

    // Stale (dead or reused PID, or no PID at all). Claim this exact content.
    options.beforeTakeover?.()
    const claimPrefix = `${STATE_LOCK_FILE}.claim-${createHash("sha256").update(text).digest("hex")}-`
    const claimed = claim(path, claimPrefix, mine, stage, isHeld)
    if (claimed.held !== undefined) {
      // A live claimant is taking this content over, unless the content is
      // already gone (a late claimant about to back off): then look again.
      if (readText(path) !== text) continue
      throw new StateLockHeldError(path, claimed.held)
    }
    if (claimed.path === undefined) continue

    options.afterClaim?.()
    if (readText(path) !== text) {
      // Replaced or released since we read it: our claim is moot.
      remove(claimed.path)
      continue
    }
    // Nobody else can act on this content while we hold its claim, and the
    // path is never empty: `rename` replaces the stale lock in one step.
    const replacement = stage(mine)
    try {
      renameSync(replacement, path)
    } catch (error) {
      remove(replacement)
      remove(claimed.path)
      throw error
    }
    removeClaims(stateDir, claimPrefix)
    const written = parseLock(readText(path))
    if (written?.token === token) return lockHandle(path, token)
    if (isHeld(written)) throw new StateLockHeldError(path, written.pid)
  }
  const last = parseLock(readText(path))
  if (last !== undefined && last.token !== token) throw new StateLockHeldError(path, last.pid)
  throw new Error(`Could not take the state lock ${path}`)
}

/**
 * Claims the stale content whose claims are named `<prefix><n>`: creates the
 * first `n` not taken yet. A taken claim whose claimant is live makes the lock
 * held (`held`: that PID); one whose claimant is dead is passed over. Returns
 * neither when the claim could not be made in a bounded number of steps.
 */
function claim(
  lockPath: string,
  prefix: string,
  mine: LockContent,
  stage: (content: LockContent) => string,
  isHeld: (holder: LockContent | undefined) => holder is LockContent,
): { path?: string; held?: number } {
  const directory = dirname(lockPath)
  for (let n = 0; n < 64; n += 1) {
    const claimPath = join(directory, `${prefix}${n}`)
    const staged = stage(mine)
    try {
      linkSync(staged, claimPath)
      return { path: claimPath }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    } finally {
      try {
        unlinkSync(staged)
      } catch {
        /* nothing to clean */
      }
    }
    const claimant = parseLock(readText(claimPath))
    if (isHeld(claimant)) return { held: claimant.pid }
    // A dead claimant (or a claim removed since our link): the next one.
  }
  return {}
}

/** Removes the claims named `<prefix><n>` (the content they claimed is gone). */
function removeClaims(stateDir: string, prefix: string): void {
  let names: string[]
  try {
    names = readdirSync(stateDir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    try {
      unlinkSync(join(stateDir, name))
    } catch {
      /* already gone */
    }
  }
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
