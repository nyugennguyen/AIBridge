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

  describe("parseTaskDependencies", () => {
    it("returns dependency map from tasks with depends_on", async () => {
      await writeFile(
        tasksPath,
        [
          "# Project Tasks",
          "",
          "## #1 Implement auth [agent:mac-dev] [status:done]",
          "",
          "## #2 Deploy staging [agent:vps-deploy] [status:running] [needs: #1]",
          "",
          "## #3 Integration tests [agent:mac-dev] [status:blocked] [needs: #1, #2]",
          "",
        ].join("\n"),
        "utf8",
      )
      const syncer = new FileTaskGraphSyncer(tasksPath)
      const deps = await syncer.parseTaskDependencies()

      expect(deps.size).toBe(3)
      expect(deps.get("#1")).toEqual([])
      expect(deps.get("#2")).toEqual(["#1"])
      expect(deps.get("#3")).toEqual(["#1", "#2"])
    })

    it("returns empty map when file does not exist", async () => {
      const syncer = new FileTaskGraphSyncer(tasksPath)
      const deps = await syncer.parseTaskDependencies()

      expect(deps.size).toBe(0)
    })

    it("returns tasks with empty depends_on arrays when no dependencies declared", async () => {
      await writeFile(
        tasksPath,
        ["# Project Tasks", "", "## #1 Task A [status:pending]", "", "## #2 Task B [status:pending]", ""].join(
          "\n",
        ),
        "utf8",
      )
      const syncer = new FileTaskGraphSyncer(tasksPath)
      const deps = await syncer.parseTaskDependencies()

      expect(deps.get("#1")).toEqual([])
      expect(deps.get("#2")).toEqual([])
    })
  })
})
