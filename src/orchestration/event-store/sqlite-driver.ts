import { createRequire } from "node:module"
import { existsSync, mkdirSync, unlinkSync } from "node:fs"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)

export interface SqliteStatement<T = Record<string, unknown>> {
  run(...params: unknown[]): { changes: number, lastInsertRowid: number | bigint }
  get(...params: unknown[]): T | undefined
  all(...params: unknown[]): T[]
  finalize(): void
}

export interface SqliteDriverOptions {
  path?: string
  backend?: "bun" | "node"
  readonly?: boolean
  create?: boolean
}

export interface SqliteDriver {
  readonly path: string
  readonly backend: "bun" | "node"
  exec(sql: string): void
  prepare<T = Record<string, unknown>>(sql: string): SqliteStatement<T>
  run(sql: string, ...params: unknown[]): { changes: number, lastInsertRowid: number | bigint }
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[]
  beginTransaction(): void
  commit(): void
  rollback(): void
  transaction<T>(fn: () => T): T
  backup(destinationPath: string): Promise<void>
  close(): void
  isOpen(): boolean
}

function normalizeParams(params: unknown[]): unknown[] {
  if (params.length === 1 && Array.isArray(params[0])) {
    return params[0]
  }
  return params
}

function isNamedParamObject(params: unknown[]): boolean {
  return (
    params.length === 1 &&
    typeof params[0] === "object" &&
    params[0] !== null &&
    !Array.isArray(params[0]) &&
    !(params[0] instanceof Uint8Array)
  )
}

class BaseSqliteDriver implements SqliteDriver {
  readonly path: string
  readonly backend: "bun" | "node"
  protected db: any
  protected open = true
  private transactionDepth = 0
  private statementCache = new Map<string, SqliteStatement<any>>()

  constructor(path: string, backend: "bun" | "node", db: any) {
    this.path = path
    this.backend = backend
    this.db = db
    this.applyStandardPragmas()
  }

  private applyStandardPragmas(): void {
    this.exec("PRAGMA journal_mode = WAL")
    this.exec("PRAGMA synchronous = FULL")
    this.exec("PRAGMA foreign_keys = ON")
    this.exec("PRAGMA busy_timeout = 5000")
  }

  exec(sql: string): void {
    if (!this.open) throw new Error("Database connection is closed")
    this.db.exec(sql)
  }

  prepare<T = Record<string, unknown>>(sql: string): SqliteStatement<T> {
    if (!this.open) throw new Error("Database connection is closed")
    const cached = this.statementCache.get(sql)
    if (cached) return cached as SqliteStatement<T>

    const rawStmt = this.db.prepare(sql)
    const statement: SqliteStatement<T> = {
      run: (...params: unknown[]) => {
        if (!this.open) throw new Error("Database connection is closed")
        const norm = normalizeParams(params)
        const res = isNamedParamObject(norm) ? rawStmt.run(norm[0]) : rawStmt.run(...norm)
        return {
          changes: Number(res.changes ?? 0),
          lastInsertRowid: res.lastInsertRowid,
        }
      },
      get: (...params: unknown[]) => {
        if (!this.open) throw new Error("Database connection is closed")
        const norm = normalizeParams(params)
        const row = isNamedParamObject(norm) ? rawStmt.get(norm[0]) : rawStmt.get(...norm)
        if (row === null || row === undefined) return undefined
        return row as T
      },
      all: (...params: unknown[]) => {
        if (!this.open) throw new Error("Database connection is closed")
        const norm = normalizeParams(params)
        const rows = isNamedParamObject(norm) ? rawStmt.all(norm[0]) : rawStmt.all(...norm)
        return (rows ?? []) as T[]
      },
      finalize: () => {
        if (typeof rawStmt.finalize === "function") {
          rawStmt.finalize()
        }
        this.statementCache.delete(sql)
      },
    }

    this.statementCache.set(sql, statement)
    return statement
  }

  run(sql: string, ...params: unknown[]): { changes: number, lastInsertRowid: number | bigint } {
    return this.prepare(sql).run(...params)
  }

  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.prepare<T>(sql).get(...params)
  }

  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.prepare<T>(sql).all(...params)
  }

  beginTransaction(): void {
    this.exec("BEGIN IMMEDIATE")
  }

  commit(): void {
    this.exec("COMMIT")
  }

  rollback(): void {
    this.exec("ROLLBACK")
  }

  transaction<T>(fn: () => T): T {
    if (this.transactionDepth === 0) {
      this.transactionDepth += 1
      this.beginTransaction()
      try {
        const result = fn()
        this.commit()
        return result
      } catch (error) {
        try {
          this.rollback()
        } catch {
          // Keep primary error on rollback failure
        }
        throw error
      } finally {
        this.transactionDepth = 0
      }
    } else {
      const savepoint = `sp_${this.transactionDepth}`
      this.transactionDepth += 1
      this.exec(`SAVEPOINT ${savepoint}`)
      try {
        const result = fn()
        this.exec(`RELEASE SAVEPOINT ${savepoint}`)
        return result
      } catch (error) {
        try {
          this.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
        } catch {
          // Keep primary error on rollback failure
        }
        throw error
      } finally {
        this.transactionDepth -= 1
      }
    }
  }

  async backup(destinationPath: string): Promise<void> {
    if (!this.open) throw new Error("Database connection is closed")
    const resolved = resolve(destinationPath)
    mkdirSync(dirname(resolved), { recursive: true })
    if (existsSync(resolved)) {
      unlinkSync(resolved)
    }
    const escaped = resolved.replace(/'/g, "''")
    this.exec(`VACUUM INTO '${escaped}'`)
  }

  close(): void {
    if (!this.open) return
    this.open = false
    for (const stmt of this.statementCache.values()) {
      stmt.finalize()
    }
    this.statementCache.clear()
    this.db.close()
  }

  isOpen(): boolean {
    return this.open
  }
}

export function createSqliteDriver(options?: string | SqliteDriverOptions): SqliteDriver {
  const opts: SqliteDriverOptions = typeof options === "string" ? { path: options } : (options ?? {})
  const dbPath = opts.path ?? ":memory:"
  const isBunRuntime = typeof (globalThis as any).Bun !== "undefined"
  const backend = opts.backend ?? (isBunRuntime ? "bun" : "node")

  if (dbPath !== ":memory:") {
    const resolved = resolve(dbPath)
    mkdirSync(dirname(resolved), { recursive: true })
  }

  if (backend === "bun") {
    const { Database } = require("bun:sqlite")
    const db = new Database(dbPath, {
      readonly: opts.readonly,
      create: opts.create ?? true,
    })
    return new BaseSqliteDriver(dbPath, "bun", db)
  }

  const { DatabaseSync } = require("node:sqlite")
  const db = new DatabaseSync(dbPath, {
    readOnly: opts.readonly,
    open: true,
  })
  return new BaseSqliteDriver(dbPath, "node", db)
}

export function openSqliteDriver(options?: string | SqliteDriverOptions): SqliteDriver {
  return createSqliteDriver(options)
}

export function openInMemoryDriver(): SqliteDriver {
  return createSqliteDriver({ path: ":memory:" })
}
