import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { isStorableJobId } from "./job-id.js"
import type { JobRecord, JobStatus } from "./types.js"

export interface JobStore {
  get(id: string): Promise<JobRecord | undefined>
  list(): Promise<JobRecord[]>
  listByStatus(status: JobStatus): Promise<JobRecord[]>
  save(job: JobRecord): Promise<void>
  /**
   * Saves a job that must not exist yet, atomically with that check: of two
   * concurrent creates of one id, one fails with "Job already exists".
   * Optional; without it `JobManager.createJob` checks with `get` first.
   */
  create?(job: JobRecord): Promise<void>
}

/**
 * A job id the store will not write: it would leave the jobs directory, or it
 * is the same as an existing job's id but for letter case (one file on a
 * case-insensitive filesystem such as macOS's default APFS).
 *
 * The message of a case collision starts with "Job already exists" so every
 * caller that already answers a duplicate id with 409 does so for this one too.
 */
export class JobIdRejectedError extends Error {
  constructor(
    message: string,
    readonly code: "job_id_unsafe" | "job_id_case_conflict",
  ) {
    super(message)
    this.name = "JobIdRejectedError"
  }
}

export interface JsonFileJobStoreOptions {
  /**
   * Told about a job file that cannot be read as a job (truncated, not JSON,
   * no string `id`). The store loads every other job, and renames the file to
   * `<name>.unreadable` so it is kept for inspection and not read again.
   * Default: one line on stderr.
   */
  readonly onUnreadable?: (file: string, reason: string) => void
}

export class JsonFileJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>()
  /**
   * Lower-cased id -> the id stored under it, or being created under it. A
   * new id is entered here synchronously, before the first write yields, so
   * of two concurrent creates of the same id (or of ids differing only in
   * case) exactly one proceeds; the entry is removed if its write fails.
   */
  private readonly byFoldedId = new Map<string, string>()
  private readonly root: string
  private loading: Promise<void> | undefined
  private readonly onUnreadable: (file: string, reason: string) => void

  constructor(
    private readonly directory: string,
    options: JsonFileJobStoreOptions = {},
  ) {
    this.root = resolve(directory)
    this.onUnreadable =
      options.onUnreadable ??
      ((file, reason) => {
        process.stderr.write(`aibridge: ignoring unreadable job file ${file} (${reason}); kept as ${file}.unreadable\n`)
      })
  }

  /**
   * An exact lookup in memory: a job id is never turned into a path to read,
   * so a crafted id (`../x`, `%2e%2e`, an absolute path) finds nothing.
   */
  async get(id: string): Promise<JobRecord | undefined> {
    if (!isStorableJobId(id)) return undefined
    await this.ensureLoaded()
    return this.jobs.get(id)
  }

  async list(): Promise<JobRecord[]> {
    await this.ensureLoaded()
    return [...this.jobs.values()]
  }

  async listByStatus(status: JobStatus): Promise<JobRecord[]> {
    await this.ensureLoaded()
    return [...this.jobs.values()].filter((j) => j.status === status)
  }

  save(job: JobRecord): Promise<void> {
    return this.write(job, false)
  }

  create(job: JobRecord): Promise<void> {
    return this.write(job, true)
  }

  private async write(job: JobRecord, mustBeNew: boolean): Promise<void> {
    await this.ensureLoaded()
    const destination = this.fileFor(job.id)
    const folded = job.id.toLowerCase()
    // From here to the reservation below nothing awaits: the check and the
    // reservation are one step for every concurrent write.
    const isNew = !this.jobs.has(job.id)
    if (mustBeNew && !isNew) throw new Error(`Job already exists: ${job.id}`)
    if (isNew) {
      const existing = this.byFoldedId.get(folded)
      if (existing === job.id) {
        // The same id, still being created by a concurrent save.
        throw new Error(`Job already exists: ${job.id}`)
      }
      // Only a NEW id is refused: two older jobs that already differ only in
      // case (written on a case-sensitive filesystem) both keep working.
      if (existing !== undefined) {
        throw new JobIdRejectedError(
          `Job already exists: "${job.id}" differs from the existing job "${existing}" only in letter case, and both would be one file on a case-insensitive filesystem. Use another job_id.`,
          "job_id_case_conflict",
        )
      }
      this.byFoldedId.set(folded, job.id)
    }
    // A temporary name of its own per write, never derived from the id: two
    // writes can never share one, whatever the filesystem folds together.
    const temporary = join(this.directory, `.job-${process.pid}-${randomUUID()}.tmp`)
    try {
      await mkdir(this.directory, { recursive: true })
      await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, "utf8")
      await rename(temporary, destination)
    } catch (error) {
      if (isNew && this.byFoldedId.get(folded) === job.id) this.byFoldedId.delete(folded)
      await unlink(temporary).catch(() => undefined)
      throw error
    }
    this.jobs.set(job.id, job)
  }

  /** `<dir>/<id>.json`, or a refusal when that path would not be directly inside the jobs directory. */
  private fileFor(id: string): string {
    const refuse = (): never => {
      throw new JobIdRejectedError(`Refusing to store job id ${JSON.stringify(id.slice(0, 64))}: it is not a safe file name.`, "job_id_unsafe")
    }
    if (!isStorableJobId(id)) refuse()
    const file = resolve(this.root, `${id}.json`)
    if (dirname(file) !== this.root) refuse()
    return join(this.directory, `${id}.json`)
  }

  /** Loads the directory once; concurrent first callers share one load. */
  private ensureLoaded(): Promise<void> {
    this.loading ??= this.load().catch((error: unknown) => {
      this.loading = undefined
      throw error
    })
    return this.loading
  }

  private async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const entries = await readdir(this.directory)
    const jsonEntries = entries.filter((e) => e.endsWith(".json"))
    const jobs = await Promise.all(jsonEntries.map((entry) => this.readJobFile(entry)))
    // Ids written by an older release are loaded as they are, whatever their
    // charset: they stay readable and can still change state (see job-id.ts).
    for (const job of jobs) {
      if (job === undefined) continue
      this.jobs.set(job.id, job)
      this.byFoldedId.set(job.id.toLowerCase(), job.id)
    }
  }

  /** One job file, or `undefined` (reported and set aside) when it is not a readable job. */
  private async readJobFile(entry: string): Promise<JobRecord | undefined> {
    const file = join(this.directory, entry)
    // A read error (permissions, too many open files) is NOT a bad file:
    // it fails the load as before rather than setting a good job aside.
    const raw = await readFile(file, "utf8")
    let reason: string
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === "object" && typeof (parsed as { id?: unknown }).id === "string") return parsed as JobRecord
      reason = "not a job record"
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
    }
    await rename(file, `${file}.unreadable`).catch(() => undefined)
    this.onUnreadable(file, reason)
    return undefined
  }
}
