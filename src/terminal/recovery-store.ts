import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { terminalIdSchema, timestampSchema } from "../orchestration/identifiers.js"
import { terminalReferenceSchema } from "./schemas.js"

const MAX_RECORD_BYTES = 64 * 1024
const tmuxSessionNameSchema = z.string().regex(/^aibr-tmux-[0-9a-f]{64}$/)
const tmuxPaneIdSchema = z.string().regex(/^%[0-9]+$/)

export const tmuxRecoveryRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    reference: terminalReferenceSchema,
    tmuxSessionName: tmuxSessionNameSchema,
    tmuxPaneId: tmuxPaneIdSchema.nullable(),
    bufferByteLimit: z.number().int().positive().safe().max(1_048_576),
    columns: z.number().int().positive().max(1000),
    rows: z.number().int().positive().max(1000),
    lifecycle: z.enum(["creating", "active", "terminating"]),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.reference.backendKind !== "tmux") {
      context.addIssue({
        code: "custom",
        path: ["reference", "backendKind"],
        message: "Recovery metadata is not for the tmux backend",
      })
    }
    if (record.lifecycle !== "creating" && record.tmuxPaneId === null) {
      context.addIssue({
        code: "custom",
        path: ["tmuxPaneId"],
        message: "Active or terminating recovery metadata requires a pane binding",
      })
    }
  })

export type TmuxRecoveryRecord = z.infer<typeof tmuxRecoveryRecordSchema>

export class RecoveryStoreError extends Error {
  constructor(
    readonly reason: "corrupt" | "io" | "too_many_records",
    message: string,
  ) {
    super(message)
    this.name = "RecoveryStoreError"
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

/** Strict, bounded metadata store. It never stores terminal output or input. */
export class TmuxRecoveryStore {
  constructor(
    private readonly directory: string,
    private readonly maxRecords = 1024,
  ) {}

  private pathFor(terminalId: string): string {
    const parsed = terminalIdSchema.parse(terminalId)
    return join(this.directory, `${parsed}.json`)
  }

  private async ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const info = await lstat(this.directory)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new RecoveryStoreError("io", "Recovery path is not a trusted directory")
      }
      await chmod(this.directory, 0o700)
    } catch (error) {
      if (error instanceof RecoveryStoreError) throw error
      throw new RecoveryStoreError("io", "Unable to access terminal recovery metadata")
    }
  }

  async read(terminalId: string): Promise<TmuxRecoveryRecord | null> {
    await this.ensureDirectory()
    const path = this.pathFor(terminalId)
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_BYTES) {
        throw new RecoveryStoreError("corrupt", "Terminal recovery metadata is invalid")
      }
      const raw = await readFile(path, "utf8")
      return tmuxRecoveryRecordSchema.parse(JSON.parse(raw))
    } catch (error) {
      if (isMissing(error)) return null
      if (error instanceof RecoveryStoreError) throw error
      throw new RecoveryStoreError("corrupt", "Terminal recovery metadata is corrupt")
    }
  }

  async list(): Promise<TmuxRecoveryRecord[]> {
    await this.ensureDirectory()
    let entries: string[]
    try {
      entries = (await readdir(this.directory)).filter((entry) => entry.endsWith(".json")).sort()
    } catch {
      throw new RecoveryStoreError("io", "Unable to enumerate terminal recovery metadata")
    }
    if (entries.length > this.maxRecords) {
      throw new RecoveryStoreError("too_many_records", "Terminal recovery metadata exceeds its record limit")
    }

    const records: TmuxRecoveryRecord[] = []
    for (const entry of entries) {
      const terminalId = entry.slice(0, -5)
      const parsedId = terminalIdSchema.safeParse(terminalId)
      if (!parsedId.success) {
        throw new RecoveryStoreError("corrupt", "Terminal recovery metadata has an invalid filename")
      }
      const record = await this.read(parsedId.data)
      if (record === null || record.reference.terminalId !== parsedId.data) {
        throw new RecoveryStoreError("corrupt", "Terminal recovery metadata identity does not match its filename")
      }
      records.push(record)
    }
    return records
  }

  async write(record: TmuxRecoveryRecord): Promise<void> {
    await this.ensureDirectory()
    const parsed = tmuxRecoveryRecordSchema.parse(record)
    const serialized = `${JSON.stringify(parsed)}\n`
    if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) {
      throw new RecoveryStoreError("corrupt", "Terminal recovery metadata exceeds its byte limit")
    }

    const destination = this.pathFor(parsed.reference.terminalId)
    const temporary = join(this.directory, `.${parsed.reference.terminalId}.${randomUUID()}.tmp`)
    try {
      const handle = await open(temporary, "wx", 0o600)
      try {
        await handle.writeFile(serialized, "utf8")
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, destination)
    } catch (error) {
      try {
        await unlink(temporary)
      } catch {
        // The temporary file may never have been created.
      }
      throw new RecoveryStoreError("io", "Unable to persist terminal recovery metadata")
    }
  }

  async remove(terminalId: string): Promise<void> {
    await this.ensureDirectory()
    try {
      await unlink(this.pathFor(terminalId))
    } catch (error) {
      if (!isMissing(error)) {
        throw new RecoveryStoreError("io", "Unable to remove terminal recovery metadata")
      }
    }
  }
}
