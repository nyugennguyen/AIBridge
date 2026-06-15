import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { JobRecord } from "./types.js"

export interface JobStore {
  get(id: string): Promise<JobRecord | undefined>
  list(): Promise<JobRecord[]>
  save(job: JobRecord): Promise<void>
}

export class JsonFileJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>()
  private loaded = false

  constructor(private readonly directory: string) {}

  async get(id: string): Promise<JobRecord | undefined> {
    await this.ensureLoaded()
    return this.jobs.get(id)
  }

  async list(): Promise<JobRecord[]> {
    await this.ensureLoaded()
    return [...this.jobs.values()]
  }

  async save(job: JobRecord): Promise<void> {
    await this.ensureLoaded()
    await mkdir(this.directory, { recursive: true })
    const destination = join(this.directory, `${job.id}.json`)
    const temporary = join(this.directory, `${job.id}.json.tmp`)
    const serialized = `${JSON.stringify(job, null, 2)}\n`
    await writeFile(temporary, serialized, "utf8")
    await rename(temporary, destination)
    this.jobs.set(job.id, job)
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    await mkdir(this.directory, { recursive: true })
    const entries = await readdir(this.directory)
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue
      const raw = await readFile(join(this.directory, entry), "utf8")
      const job = JSON.parse(raw) as JobRecord
      this.jobs.set(job.id, job)
    }
    this.loaded = true
  }
}
