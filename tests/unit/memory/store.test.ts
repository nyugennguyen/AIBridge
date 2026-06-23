import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileMemoryStore } from "../../../src/memory/store.js"

describe("FileMemoryStore", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aibridge-test-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("returns empty decisions initially", async () => {
    const store = new FileMemoryStore(dir, "github.com:test/repo")
    expect(await store.getDecisions()).toEqual([])
  })

  it("adds and retrieves decisions", async () => {
    const store = new FileMemoryStore(dir, "github.com:test/repo")
    await store.addDecision({ id: "d1", timestamp: "2026-06-23", agent: "dev", content: "Use bcrypt" })
    const decisions = await store.getDecisions()
    expect(decisions).toHaveLength(1)
    expect(decisions[0].content).toBe("Use bcrypt")
  })

  it("returns project id", async () => {
    const store = new FileMemoryStore(dir, "github.com:test/repo")
    expect(await store.getProjectId()).toBe("github.com:test/repo")
  })

  it("manages constraints", async () => {
    const store = new FileMemoryStore(dir, "github.com:test/repo")
    expect(await store.getConstraints()).toEqual([])
    await store.addConstraint("No DB changes without approval")
    expect(await store.getConstraints()).toEqual(["No DB changes without approval"])
  })

  it("creates and retrieves handoffs", async () => {
    const store = new FileMemoryStore(dir, "github.com:test/repo")
    const handoff = await store.createHandoff({ from: "dev", to: "test", context: "Auth complete" })
    expect(handoff.id).toBeDefined()
    expect(handoff.status).toBe("pending")

    const pending = await store.getPendingHandoffs("test")
    expect(pending).toHaveLength(1)
  })
})
