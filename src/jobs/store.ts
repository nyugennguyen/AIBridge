import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { isStorableJobId } from "./job-id.js"
import type { JobRecord, JobStatus } from "./types.js"

export interface JobStore {
  get(id: string): Promise<JobRecord | undefined>
  list(): Promise<JobRecord[]>
  listByStatus(status: JobStatus): Promise<JobRecord[]>
  save(job: JobRecord): Promise<void>
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

export class JsonFileJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>()
  /** Lower-cased id -> the id stored under it. */
  private readonly byFoldedId = new Map<string, string>()
  private readonly root: string
  private loaded = false

  constructor(private readonly directory: string) {
    this.root = resolve(directory)
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

  async save(job: JobRecord): Promise<void> {
    await this.ensureLoaded()
    const destination = this.fileFor(job.id)
    const folded = job.id.toLowerCase()
    const existing = this.byFoldedId.get(folded)
    // Only a NEW id is refused: two older jobs that already differ only in case
    // (written on a case-sensitive filesystem) both keep working.
    if (!this.jobs.has(job.id) && existing !== undefined && existing !== job.id) {
      throw new JobIdRejectedError(
        `Job already exists: "${job.id}" differs from the existing job "${existing}" only in letter case, and both would be one file on a case-insensitive filesystem. Use another job_id.`,
        "job_id_case_conflict",
      )
    }
    await mkdir(this.directory, { recursive: true })
    const temporary = `${destination}.tmp`
    const serialized = `${JSON.stringify(job, null, 2)}\n`
    await writeFile(temporary, serialized, "utf8")
    await rename(temporary, destination)
    this.jobs.set(job.id, job)
    this.byFoldedId.set(folded, job.id)
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

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    await mkdir(this.directory, { recursive: true })
    const entries = await readdir(this.directory)
    const jsonEntries = entries.filter((e) => e.endsWith(".json"))
    const jobs = await Promise.all(
      jsonEntries.map(async (entry) => {
        const raw = await readFile(join(this.directory, entry), "utf8")
        return JSON.parse(raw) as JobRecord
      }),
    )
    // Ids written by an older release are loaded as they are, whatever their
    // charset: they stay readable and can still change state (see job-id.ts).
    for (const job of jobs) {
      this.jobs.set(job.id, job)
      this.byFoldedId.set(job.id.toLowerCase(), job.id)
    }
    this.loaded = true
  }
}
