/**
 * M5.2 — the durable memory store: one JSONL line per record, plus two side
 * files for the facts that are *not* part of a record's bytes.
 *
 * ## Layout
 *
 * ```
 * <directory>/
 *   records.jsonl     append-only; one MemoryRecordV1|V2 per line, never rewritten
 *   decisions.jsonl   append-only; one trust decision per line
 *   index.json        { schemaVersion, tombstones: MemoryTombstone[] }
 * ```
 *
 * ## Why trust decisions are not written onto the record
 *
 * Because `records.jsonl` is append-only, a trust decision cannot be a
 * rewrite of the record's line — and it must not be an in-place edit of an
 * append-only log either. So a decision is its own line in its own log, and the
 * loader replays decisions over the records. Two properties follow: a record's
 * bytes never change once written (the property
 * `tests/unit/memory/supersession.test.ts` asserts), and a decision is itself
 * auditable with the same append-only property as the record it concerns.
 *
 * ## Why a tombstone erases a line
 *
 * A tombstone is the one operation that *does* remove bytes, and that is the
 * point: it exists for an explicit retention or privacy deletion, which is a
 * different thing from a correction. Supersession keeps the old line forever.
 * So `tombstone()` records the tombstone first, then rewrites `records.jsonl`
 * without that record's line, atomically (write a temporary file, then rename).
 * The ordering is deliberate: if the process dies between the two steps, the
 * loader sees a tombstone for an id that is still on disk and refuses to serve
 * it — a deletion that over-deletes nothing is safe; a deletion that is lost
 * is not.
 *
 * ## Why a bad line is an error, not a skipped line
 *
 * A truncated trailing line is what a crash mid-append looks like. Skipping it
 * would produce a store that loads cleanly, reports a shorter history, and
 * leaves a reader believing a memory record was never written. So every line is
 * parsed, and an unreadable one raises `MemoryCorruptStoreError` naming the
 * file and line, with the file left exactly as found. The operator decides
 * whether to truncate; the repository does not decide for them.
 */

import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  MemoryRepositoryEngine,
  type MemoryRepositoryOptions,
  type MemoryStorage,
  type MemoryStorageSnapshot,
  type StoredTrustDecision,
} from "./in-memory-repository.js"
import { parseMemoryRecord, type MemoryRecordV1, type MemoryRecordV2 } from "./record.js"
import type { MemoryTombstone } from "./ports.js"
import { MemoryCorruptStoreError, storeIoError } from "./repository-errors.js"
import { actorSchema } from "../orchestration/schemas.js"
import { memoryIdSchema, projectIdSchema, schemaVersionSchema, timestampSchema } from "../orchestration/identifiers.js"
import { memoryKindSchema } from "./ontology.js"
import { z } from "zod"

const RECORDS_FILE = "records.jsonl"
const DECISIONS_FILE = "decisions.jsonl"
const INDEX_FILE = "index.json"

/** The tombstone side file. Parsed, not trusted: a corrupt index is corruption. */
const memoryTombstoneSchema = z
  .object({
    schemaVersion: z.literal(1),
    memoryId: memoryIdSchema,
    projectId: projectIdSchema,
    kind: memoryKindSchema,
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    deletedAt: timestampSchema,
    deletedBy: actorSchema,
    reason: z.string().min(1).max(1024),
    nonSensitive: z.literal(true),
  })
  .strict()

const memoryIndexSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    tombstones: z.array(memoryTombstoneSchema).max(1_000_000),
  })
  .strict()

const storedTrustDecisionSchema = z
  .object({
    memoryId: memoryIdSchema,
    trust: z.enum(["accepted", "rejected"]),
    decidedBy: actorSchema,
    decidedAt: timestampSchema,
    reason: z.string().min(1).max(256).optional(),
  })
  .strict()

/** The durable backend: JSONL append log, JSON tombstone index. */
export class JsonlMemoryStorage implements MemoryStorage {
  private readonly recordsPath: string
  private readonly decisionsPath: string
  private readonly indexPath: string

  constructor(private readonly directory: string) {
    this.recordsPath = join(directory, RECORDS_FILE)
    this.decisionsPath = join(directory, DECISIONS_FILE)
    this.indexPath = join(directory, INDEX_FILE)
  }

  async load(): Promise<MemoryStorageSnapshot> {
    await this.ensureDirectory()
    const recordLines = await this.readLines(this.recordsPath)
    const decisionLines = await this.readLines(this.decisionsPath)

    const records: (MemoryRecordV1 | MemoryRecordV2)[] = []
    recordLines.forEach((line, index) => {
      const parsed = parseJsonLine(line, this.recordsPath, index)
      if (parsed === undefined) return
      try {
        records.push(parseMemoryRecord(parsed.value))
      } catch (error) {
        throw new MemoryCorruptStoreError({
          file: this.recordsPath,
          line: index + 1,
          detail: `the record does not satisfy the shape of its own declared version (${describe(error)})`,
          cause: error,
        })
      }
    })

    const decisions: StoredTrustDecision[] = []
    decisionLines.forEach((line, index) => {
      const parsed = parseJsonLine(line, this.decisionsPath, index)
      if (parsed === undefined) return
      const decision = storedTrustDecisionSchema.safeParse(parsed.value)
      if (!decision.success) {
        throw new MemoryCorruptStoreError({
          file: this.decisionsPath,
          line: index + 1,
          detail: `the trust decision is not a valid decision record (${decision.error.issues
            .slice(0, 4)
            .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
            .join("; ")})`,
        })
      }
      decisions.push(decision.data)
    })

    const tombstones = await this.loadTombstones()
    return { records, decisions, tombstones }
  }

  async insertRecords(records: readonly MemoryRecordV2[]): Promise<void> {
    if (records.length === 0) return
    await this.ensureDirectory()
    const payload = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
    try {
      await appendFile(this.recordsPath, payload, "utf8")
    } catch (error) {
      throw storeIoError(this.recordsPath, error)
    }
  }

  async insertDecision(decision: StoredTrustDecision): Promise<void> {
    await this.ensureDirectory()
    try {
      await appendFile(this.decisionsPath, `${JSON.stringify(storedTrustDecisionSchema.parse(decision))}\n`, "utf8")
    } catch (error) {
      throw storeIoError(this.decisionsPath, error)
    }
  }

  async insertTombstone(tombstone: MemoryTombstone): Promise<void> {
    const index = await this.loadIndex()
    const tombstones = [...index.tombstones, memoryTombstoneSchema.parse(tombstone)]
    await this.writeIndex(tombstones)
  }

  /**
   * Erase a record's line, atomically.
   *
   * The file is rewritten from its own lines minus the one being removed, so the
   * surviving records keep their exact bytes. A temporary file plus a rename
   * makes the swap atomic: a crash mid-rewrite leaves the original intact rather
   * than a half-written log.
   *
   * A line that does not parse is kept rather than dropped. It is not this
   * method's job to decide what an unreadable line means — the load refuses the
   * store loudly for that — and dropping it here would erase the evidence
   * before anyone had looked at it.
   */
  async eraseContent(memoryId: string): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.recordsPath, "utf8")
    } catch (error) {
      if (isNotFound(error)) return
      throw storeIoError(this.recordsPath, error)
    }
    const kept = raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .filter((line) => memoryIdOfLine(line) !== memoryId)
    const trailingNewline = raw.endsWith("\n")
    const contents = kept.length === 0 ? "" : `${kept.join("\n")}${trailingNewline ? "\n" : ""}`
    await this.replaceFile(this.recordsPath, contents)
  }

  private async loadTombstones(): Promise<MemoryTombstone[]> {
    return (await this.loadIndex()).tombstones
  }

  private async loadIndex(): Promise<{ schemaVersion: number; tombstones: MemoryTombstone[] }> {
    let raw: string
    try {
      raw = await readFile(this.indexPath, "utf8")
    } catch (error) {
      if (isNotFound(error)) return { schemaVersion: 1, tombstones: [] }
      throw storeIoError(this.indexPath, error)
    }
    if (raw.trim() === "") return { schemaVersion: 1, tombstones: [] }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (error) {
      throw new MemoryCorruptStoreError({ file: this.indexPath, detail: "index.json is not valid JSON", cause: error })
    }
    const parsed = memoryIndexSchema.safeParse(value)
    if (!parsed.success) {
      throw new MemoryCorruptStoreError({
        file: this.indexPath,
        detail: `index.json does not satisfy the tombstone index shape (${parsed.error.issues
          .slice(0, 4)
          .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
          .join("; ")})`,
      })
    }
    return parsed.data
  }

  private async writeIndex(tombstones: readonly MemoryTombstone[]): Promise<void> {
    await this.ensureDirectory()
    await this.replaceFile(
      this.indexPath,
      `${JSON.stringify({ schemaVersion: 1, tombstones: tombstones.map((tombstone) => memoryTombstoneSchema.parse(tombstone)) }, null, 2)}\n`,
    )
  }

  private async replaceFile(path: string, contents: string): Promise<void> {
    const temporary = `${path}.tmp`
    try {
      await writeFile(temporary, contents, "utf8")
      await rename(temporary, path)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw storeIoError(path, error)
    }
  }

  private async readLines(path: string): Promise<string[]> {
    let raw: string
    try {
      raw = await readFile(path, "utf8")
    } catch (error) {
      if (isNotFound(error)) return []
      throw storeIoError(path, error)
    }
    return raw.split("\n")
  }

  private async ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true })
    } catch (error) {
      throw storeIoError(this.directory, error)
    }
  }
}

/** The `MemoryRepository` backed by a directory of append-only JSONL files. */
export class FileMemoryRepository extends MemoryRepositoryEngine {
  constructor(
    private readonly directory: string,
    options: MemoryRepositoryOptions,
    storage: MemoryStorage = new JsonlMemoryStorage(directory),
  ) {
    super(storage, options)
  }

  /** The directory this repository reads and writes. */
  get directoryPath(): string {
    return this.directory
  }
}

interface ParsedLine {
  readonly value: unknown
}

/**
 * Parse one line, or report it as corruption.
 *
 * A blank line is not a record and is not corruption: every JSONL file ends
 * with a newline, and `split("\n")` yields a trailing empty string for every
 * well-formed file. Everything else must parse, or the load fails.
 */
function parseJsonLine(line: string, file: string, index: number): ParsedLine | undefined {
  if (line.trim() === "") return undefined
  try {
    return { value: JSON.parse(line) }
  } catch (error) {
    throw new MemoryCorruptStoreError({
      file,
      line: index + 1,
      detail: "the line is not valid JSON (a partially written trailing line is the usual cause)",
      cause: error,
    })
  }
}

/**
 * The `memoryId` a line claims, or `undefined` if the line does not say.
 *
 * Parsed rather than pattern-matched, because a record's own content is free
 * text: a regex looking for `"memoryId":"` can be satisfied by a `detail` object
 * that happens to have a key of that name, and an erase keyed on the wrong id
 * would delete somebody else's memory.
 */
function memoryIdOfLine(line: string): string | undefined {
  try {
    const value = JSON.parse(line) as { memoryId?: unknown }
    return typeof value.memoryId === "string" ? value.memoryId : undefined
  } catch {
    return undefined
  }
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: string } | undefined)?.code === "ENOENT"
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
