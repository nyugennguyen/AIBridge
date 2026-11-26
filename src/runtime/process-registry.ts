/**
 * Durable record of the runtime processes a bridge spawned for its jobs (the
 * Claude Code process and every `pre` / `script` / `post` step), so that the
 * next bridge on the profile can stop the ones a killed bridge left running
 * (`terminateOrphanedRuntimeProcesses`).
 *
 * One small JSON file per live process in `<stateDir>/runtime-processes/`:
 * the job id, the PID, the process group id (always the PID: every runtime
 * process leads its own group) and the PID's start time
 * (`readProcessStartTime`). The record is written synchronously right after
 * `spawn` returns (no `await` in between, so no other work of the bridge runs
 * first), with a write-then-rename so a reader never sees half a record, and
 * removed when the process exits.
 *
 * The start time: on Linux it is two small `/proc` reads and goes into that
 * first write. Elsewhere it needs `ps`, which is not run synchronously on
 * every spawn: the record is written first without it, and rewritten with it
 * when the asynchronous read answers (unless the process exited meanwhile).
 * A record without a start time is unverifiable, so a bridge killed in that
 * window leaves a process the next start logs but does not signal. The read
 * is correct even if the process exits first: it stays this process's child,
 * and its PID cannot be reused, until Node reaps it and emits `exit`, which
 * clears the record before the read's answer is handled.
 *
 * Why a sidecar directory and not a field on the job record: the record is
 * written in the same synchronous step as the spawn instead of behind the
 * job's write queue; it is independent of the job's state machine (a
 * terminal job record is never written again, yet its process may still be
 * being stopped); it is not served by `GET /jobs/:id` nor sent in reports;
 * and the job store's `*.json` loader never sees it.
 *
 * Durability: the file survives the bridge being SIGKILLed or crashing (the
 * write is complete in the kernel when `writeFileSync` returns). It is not
 * fsynced: losing it needs the whole host to lose power, which also ends
 * every process it describes.
 */
import { randomUUID } from "node:crypto"
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readProcessStartTimeAsync } from "../host/process-identity.js"

export const RUNTIME_PROCESSES_DIR = "runtime-processes"

export type RuntimeProcessRole = "claude" | "script"

export interface RuntimeProcessRecord {
  readonly jobId: string
  readonly role: RuntimeProcessRole
  readonly pid: number
  /** The PID's start time; absent until read, or when it could not be read. */
  readonly start?: string
  /** Set when the process was spawned as the leader of its own process group: always equal to `pid`. */
  readonly pgid?: number
  readonly recordedAt: string
  /** The bridge process that spawned it. */
  readonly ownerPid: number
}

export interface TrackProcessInput {
  readonly jobId: string
  readonly role: RuntimeProcessRole
  readonly pid: number
  /** True when the process leads its own process group. */
  readonly processGroup: boolean
}

/** What the runner records spawned processes through. `track` never throws; it returns the function that clears the record. */
export interface RuntimeProcessTracker {
  track(input: TrackProcessInput): () => void
}

/** A file of the registry: its record, or why it could not be read. */
export type RegistryEntry =
  | { readonly path: string; readonly record: RuntimeProcessRecord }
  | { readonly path: string; readonly error: string }

export interface FileRuntimeProcessRegistryOptions {
  /**
   * The PID's start time. A string (or `undefined`) goes into the first
   * write; a promise is awaited and the record rewritten with its answer.
   * Default: `readProcessStartTimeAsync` (on Linux it is read synchronously
   * from `/proc`, see the module comment).
   */
  readonly startTimeOf?: (pid: number) => string | undefined | Promise<string | undefined>
  readonly now?: () => string
  readonly ownerPid?: number
  /** Told when a record cannot be written or removed. Default: one line on stderr. */
  readonly onError?: (message: string) => void
}

/** On Linux, the start time from `/proc` alone (two tiny reads, no `ps`). */
function linuxStartTimeSync(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
    const startTicks = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[22 - 3]
    return bootId.length > 0 && startTicks !== undefined && /^\d+$/.test(startTicks) ? `linux:${bootId}:${startTicks}` : undefined
  } catch {
    return undefined
  }
}

const defaultStartTimeOf = (pid: number): string | undefined | Promise<string | undefined> =>
  process.platform === "linux" ? (linuxStartTimeSync(pid) ?? readProcessStartTimeAsync(pid)) : readProcessStartTimeAsync(pid, { timeoutMs: 5_000 })

export class FileRuntimeProcessRegistry implements RuntimeProcessTracker {
  readonly #startTimeOf: (pid: number) => string | undefined | Promise<string | undefined>
  readonly #now: () => string
  readonly #ownerPid: number
  readonly #onError: (message: string) => void

  constructor(
    readonly directory: string,
    options: FileRuntimeProcessRegistryOptions = {},
  ) {
    this.#startTimeOf = options.startTimeOf ?? defaultStartTimeOf
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#ownerPid = options.ownerPid ?? process.pid
    this.#onError = options.onError ?? ((message) => process.stderr.write(`aibridge: ${message}\n`))
  }

  /**
   * Records a just-spawned process. Synchronous on purpose: call it right
   * after `spawn` returns. A failed write is reported and the job goes on
   * untracked (its process is then not stopped after a bridge crash).
   */
  track(input: TrackProcessInput): () => void {
    let start: string | undefined | Promise<string | undefined>
    try {
      start = this.#startTimeOf(input.pid)
    } catch {
      start = undefined
    }
    const base: RuntimeProcessRecord = {
      jobId: input.jobId,
      role: input.role,
      pid: input.pid,
      ...(input.processGroup ? { pgid: input.pid } : {}),
      recordedAt: this.#now(),
      ownerPid: this.#ownerPid,
    }
    const path = join(this.directory, `${input.pid}-${randomUUID()}.json`)
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      this.#write(path, typeof start === "string" ? { ...base, start } : base)
    } catch (error) {
      this.#onError(
        `could not record ${input.role} process ${input.pid} of job ${input.jobId} in ${this.directory} ` +
          `(${error instanceof Error ? error.message : String(error)}); it will not be stopped if the bridge is killed`,
      )
      return () => undefined
    }
    let cleared = false
    if (start instanceof Promise) {
      void start
        .catch(() => undefined)
        .then((value) => {
          // Exited meanwhile: `exit` cleared the record, which stays gone.
          if (cleared || value === undefined) return
          try {
            this.#write(path, { ...base, start: value })
          } catch (error) {
            this.#onError(
              `could not add the start time of ${input.role} process ${input.pid} of job ${input.jobId} ` +
                `(${error instanceof Error ? error.message : String(error)}); it will not be stopped if the bridge is killed`,
            )
          }
        })
    }
    return () => {
      if (cleared) return
      cleared = true
      this.remove(path)
    }
  }

  #write(path: string, record: RuntimeProcessRecord): void {
    const staged = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(staged, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      renameSync(staged, path)
    } catch (error) {
      try {
        unlinkSync(staged)
      } catch {
        /* never written */
      }
      throw error
    }
  }

  /**
   * Whether the directory can be trusted: absent, or a real directory (not a
   * symlink) owned by this user. One that is group- or world-writable is
   * tightened to 0700. Anything else answers `ok: false`: its records must
   * not be acted on.
   */
  checkDirectory(): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    let info: ReturnType<typeof lstatSync>
    try {
      info = lstatSync(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true }
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return { ok: false, reason: "it is not a directory (or is a symlink)" }
    const uid = process.getuid?.()
    if (uid !== undefined && info.uid !== uid) return { ok: false, reason: `it is owned by uid ${info.uid}, not ${uid}` }
    if ((info.mode & 0o077) !== 0) {
      try {
        chmodSync(this.directory, 0o700)
      } catch (error) {
        return { ok: false, reason: `it is accessible to other users and could not be made private (${error instanceof Error ? error.message : String(error)})` }
      }
    }
    return { ok: true }
  }

  /** Every record in the directory. An unreadable file, a symlink or anything but a regular file is listed with its error. */
  list(): RegistryEntry[] {
    let names: string[]
    try {
      names = readdirSync(this.directory)
    } catch {
      return []
    }
    const entries: RegistryEntry[] = []
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue
      const path = join(this.directory, name)
      try {
        const info = lstatSync(path)
        if (info.isSymbolicLink() || !info.isFile()) {
          entries.push({ path, error: "not a regular file" })
          continue
        }
        const value = JSON.parse(readFileSync(path, "utf8")) as Partial<RuntimeProcessRecord>
        if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || typeof value.jobId !== "string") {
          entries.push({ path, error: "not a runtime process record" })
          continue
        }
        entries.push({ path, record: value as RuntimeProcessRecord })
      } catch (error) {
        entries.push({ path, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return entries
  }

  remove(path: string): void {
    try {
      unlinkSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      this.#onError(`could not remove runtime process record ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
