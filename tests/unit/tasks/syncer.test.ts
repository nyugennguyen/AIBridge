// tests/unit/tasks/syncer.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileTaskGraphSyncer } from "../../../src/tasks/syncer.js"

describe("FileTaskGraphSyncer", () => {
  let dir: string
  let tasksPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aibridge-test-"))
    tasksPath = join(dir, "tasks.md")
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("reads tasks from file", async () => {
    await writeFile(tasksPath, `## #1 Test [status:done]\n- Key: value`, "utf8")
    const syncer = new FileTaskGraphSyncer(tasksPath)
    const tasks = await syncer.getTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe("#1")
  })

  it("returns empty array when file missing", async () => {
    const syncer = new FileTaskGraphSyncer(tasksPath)
    const tasks = await syncer.getTasks()
    expect(tasks).toEqual([])
  })

  it("syncJobToTask updates existing task status", async () => {
    await writeFile(tasksPath, `## #1 Test [status:running]`, "utf8")
    const syncer = new FileTaskGraphSyncer(tasksPath)
    await syncer.syncJobToTask("#1", "done", { Job: "job-123" })

    const content = await readFile(tasksPath, "utf8")
    expect(content).toContain("[status:done]")
    expect(content).toContain("Job: job-123")
  })

  it("syncJobToTask appends new task if not found", async () => {
    await writeFile(tasksPath, `## #1 Existing [status:done]`, "utf8")
    const syncer = new FileTaskGraphSyncer(tasksPath)
    await syncer.syncJobToTask("#2", "running", { Agent: "test-vps" })

    const content = await readFile(tasksPath, "utf8")
    expect(content).toContain("## #2")
    expect(content).toContain("[status:running]")
  })
})
