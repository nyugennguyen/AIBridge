import { existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  createSqliteDriver,
  openInMemoryDriver,
  type SqliteDriver,
} from "../../../src/orchestration/event-store/sqlite-driver.js"

describe("SqliteDriver", () => {
  let driver: SqliteDriver
  let tempDbPath: string | null = null

  beforeEach(() => {
    driver = openInMemoryDriver()
  })

  afterEach(() => {
    if (driver.isOpen()) {
      driver.close()
    }
    if (tempDbPath && existsSync(tempDbPath)) {
      try {
        rmSync(tempDbPath, { force: true })
      } catch {
        // ignore cleanup error
      }
      tempDbPath = null
    }
  })

  describe("Pragmas and configuration", () => {
    it("enforces foreign_keys = ON", () => {
      const fk = driver.get<{ foreign_keys: number }>("PRAGMA foreign_keys")
      expect(fk?.foreign_keys).toBe(1)
    })

    it("enforces busy_timeout = 5000", () => {
      const bt = driver.get<{ timeout: number }>("PRAGMA busy_timeout")
      expect(bt?.timeout).toBe(5000)
    })

    it("enforces synchronous = FULL (2)", () => {
      const sync = driver.get<{ synchronous: number }>("PRAGMA synchronous")
      expect(sync?.synchronous).toBe(2)
    })

    it("sets journal_mode = WAL on disk databases", () => {
      tempDbPath = join(tmpdir(), `test-driver-wal-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
      const fileDriver = createSqliteDriver(tempDbPath)
      try {
        const jm = fileDriver.get<{ journal_mode: string }>("PRAGMA journal_mode")
        expect(jm?.journal_mode.toLowerCase()).toBe("wal")
      } finally {
        fileDriver.close()
      }
    })
  })

  describe("Statements and parameter binding", () => {
    beforeEach(() => {
      driver.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          age INTEGER NOT NULL
        )
      `)
    })

    it("supports spread positional parameters", () => {
      const res = driver.run("INSERT INTO users (id, name, age) VALUES (?, ?, ?)", "u1", "Alice", 30)
      expect(res.changes).toBe(1)

      const row = driver.get<{ id: string, name: string, age: number }>(
        "SELECT * FROM users WHERE id = ?",
        "u1"
      )
      expect(row).toEqual({ id: "u1", name: "Alice", age: 30 })
    })

    it("supports array positional parameters", () => {
      const res = driver.run("INSERT INTO users (id, name, age) VALUES (?, ?, ?)", ["u2", "Bob", 25])
      expect(res.changes).toBe(1)

      const rows = driver.all<{ id: string, name: string, age: number }>(
        "SELECT * FROM users WHERE age >= ?",
        [25]
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe("u2")
    })

    it("returns undefined for get() when no row matches", () => {
      const row = driver.get("SELECT * FROM users WHERE id = ?", "non-existent")
      expect(row).toBeUndefined()
    })

    it("returns empty array for all() when no rows match", () => {
      const rows = driver.all("SELECT * FROM users WHERE age > ?", 100)
      expect(rows).toEqual([])
    })

    it("reuses prepared statements cleanly", () => {
      const stmt = driver.prepare("INSERT INTO users (id, name, age) VALUES (?, ?, ?)")
      stmt.run("u3", "Charlie", 40)
      stmt.run("u4", "Dave", 35)

      const count = driver.get<{ count: number }>("SELECT COUNT(*) as count FROM users")
      expect(count?.count).toBe(2)
    })
  })

  describe("Transactions and rollback", () => {
    beforeEach(() => {
      driver.exec(`
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          balance INTEGER NOT NULL
        )
      `)
      driver.run("INSERT INTO accounts VALUES (?, ?)", "acc-1", 100)
    })

    it("commits successfully on normal transaction completion", () => {
      driver.transaction(() => {
        driver.run("UPDATE accounts SET balance = balance + 50 WHERE id = ?", "acc-1")
        driver.run("INSERT INTO accounts VALUES (?, ?)", "acc-2", 200)
      })

      const acc1 = driver.get<{ balance: number }>("SELECT balance FROM accounts WHERE id = ?", "acc-1")
      const acc2 = driver.get<{ balance: number }>("SELECT balance FROM accounts WHERE id = ?", "acc-2")
      expect(acc1?.balance).toBe(150)
      expect(acc2?.balance).toBe(200)
    })

    it("rolls back all changes when an error is thrown inside transaction", () => {
      expect(() => {
        driver.transaction(() => {
          driver.run("UPDATE accounts SET balance = balance + 999 WHERE id = ?", "acc-1")
          driver.run("INSERT INTO accounts VALUES (?, ?)", "acc-fail", 500)
          throw new Error("Intentional transaction abort")
        })
      }).toThrow("Intentional transaction abort")

      const acc1 = driver.get<{ balance: number }>("SELECT balance FROM accounts WHERE id = ?", "acc-1")
      const accFail = driver.get("SELECT * FROM accounts WHERE id = ?", "acc-fail")
      expect(acc1?.balance).toBe(100)
      expect(accFail).toBeUndefined()
    })

    it("enforces foreign key constraints and triggers rollback on FK violation", () => {
      driver.exec(`
        CREATE TABLE orders (
          order_id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id)
        )
      `)

      expect(() => {
        driver.transaction(() => {
          driver.run("INSERT INTO orders VALUES (?, ?)", "ord-1", "non-existent-account")
        })
      }).toThrow()

      const order = driver.get("SELECT * FROM orders WHERE order_id = ?", "ord-1")
      expect(order).toBeUndefined()
    })

    it("supports nested savepoints and rolls back inner savepoint without aborting outer", () => {
      driver.transaction(() => {
        driver.run("INSERT INTO accounts VALUES (?, ?)", "acc-outer", 10)

        try {
          driver.transaction(() => {
            driver.run("INSERT INTO accounts VALUES (?, ?)", "acc-inner-failed", 20)
            throw new Error("Inner failed")
          })
        } catch {
          // Handled inner failure
        }

        driver.run("INSERT INTO accounts VALUES (?, ?)", "acc-outer-2", 30)
      })

      const outer = driver.get("SELECT * FROM accounts WHERE id = ?", "acc-outer")
      const inner = driver.get("SELECT * FROM accounts WHERE id = ?", "acc-inner-failed")
      const outer2 = driver.get("SELECT * FROM accounts WHERE id = ?", "acc-outer-2")

      expect(outer).toBeDefined()
      expect(inner).toBeUndefined()
      expect(outer2).toBeDefined()
    })
  })

  describe("Backup and recovery", () => {
    it("creates a consistent backup that can be opened and read", async () => {
      tempDbPath = join(tmpdir(), `test-driver-backup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
      const backupPath = join(tmpdir(), `test-driver-dest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)

      const originalDriver = createSqliteDriver(tempDbPath)
      try {
        originalDriver.exec("CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT)")
        originalDriver.run("INSERT INTO items VALUES (?, ?)", "item-1", "value-1")
        originalDriver.run("INSERT INTO items VALUES (?, ?)", "item-2", "value-2")

        await originalDriver.backup(backupPath)

        const restoredDriver = createSqliteDriver(backupPath)
        try {
          const rows = restoredDriver.all<{ id: string, value: string }>("SELECT * FROM items ORDER BY id ASC")
          expect(rows).toEqual([
            { id: "item-1", value: "value-1" },
            { id: "item-2", value: "value-2" },
          ])
        } finally {
          restoredDriver.close()
        }
      } finally {
        originalDriver.close()
        if (existsSync(backupPath)) {
          rmSync(backupPath, { force: true })
        }
      }
    })
  })

  describe("Lifecycle", () => {
    it("reports isOpen status and rejects calls after close", () => {
      expect(driver.isOpen()).toBe(true)
      driver.close()
      expect(driver.isOpen()).toBe(false)
      expect(() => driver.exec("SELECT 1")).toThrow("closed")
    })
  })
})
