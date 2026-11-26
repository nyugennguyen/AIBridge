/**
 * Durable record of the runtime processes a bridge spawned for its jobs (the
 * Claude Code process and every `pre` / `script` / `post` step), so that the
 * next bridge on the profile can stop the ones a killed bridge left running
 * (`terminateOrphanedRuntimeProcesses`).
 *
 * One small JSON file per live process in `<stateDir>/runtime-processes/`:
 * the job id, the PID, the PID's start time (`readProcessStartTime`) and the
 * process group id when the process leads its own group. It is written
 * synchronously right after `spawn` returns (no `await` in between, so no
 * other work of the bridge runs first), with a write-then-rename so a reader
 * never sees half a record, and removed when the process exits.
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
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readProcessStartTime } from "../host/process-identity.js"

export const RUNTIME_PROCESSES_DIR = "runtime-processes"

export type RuntimeProcessRole = "claude" | "script"

export interface RuntimeProcessRecord {
  readonly jobId: string
  readonly role: RuntimeProcessRole
  readonly pid: number
  /** `readProcessStartTime(pid)` read right after spawn; absent when it could not be read. */
  readonly start?: string
  /** Set when the process was spawned as the leader of its own process group (pgid = pid). */
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
  readonly startTimeOf?: (pid: number) => string | undefined
  readonly now?: () => string
  readonly ownerPid?: number
  /** Told when a record cannot be written or removed. Default: one line on stderr. */
  readonly onError?: (message: string) => void
}

export class FileRuntimeProcessRegistry implements RuntimeProcessTracker {
  readonly #startTimeOf: (pid: number) => string | undefined
  readonly #now: () => string
  readonly #ownerPid: number
  readonly #onError: (message: string) => void

  constructor(
    readonly directory: string,
    options: FileRuntimeProcessRegistryOptions = {},
  ) {
    this.#startTimeOf = options.startTimeOf ?? ((pid) => readProcessStartTime(pid))
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
    const start = this.#startTimeOf(input.pid)
    const record: RuntimeProcessRecord = {
      jobId: input.jobId,
      role: input.role,
      pid: input.pid,
      ...(start !== undefined ? { start } : {}),
      ...(input.processGroup ? { pgid: input.pid } : {}),
      recordedAt: this.#now(),
      ownerPid: this.#ownerPid,
    }
    const path = join(this.directory, `${input.pid}-${randomUUID()}.json`)
    const staged = `${path}.tmp`
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      writeFileSync(staged, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      renameSync(staged, path)
    } catch (error) {
      try {
        unlinkSync(staged)
      } catch {
        /* never written */
      }
      this.#onError(
        `could not record ${input.role} process ${input.pid} of job ${input.jobId} in ${this.directory} ` +
          `(${error instanceof Error ? error.message : String(error)}); it will not be stopped if the bridge is killed`,
      )
      return () => undefined
    }
    let cleared = false
    return () => {
      if (cleared) return
      cleared = true
      this.remove(path)
    }
  }

  /** Every record in the directory (an unreadable file is listed with its error). */
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
