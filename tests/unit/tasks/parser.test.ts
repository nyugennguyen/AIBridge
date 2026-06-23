// tests/unit/tasks/parser.test.ts
import { describe, it, expect } from "vitest"
import { parseTasks } from "../../../src/tasks/parser.js"

describe("parseTasks", () => {
  it("parses task with status and agent", () => {
    const md = `## #1 Implement auth [agent:mac-dev] [status:done]
- Completed: 2026-06-23`
    const tasks = parseTasks(md)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toEqual(
      expect.objectContaining({
        id: "#1",
        title: "Implement auth",
        agent: "mac-dev",
        status: "done",
        depends_on: [],
      })
    )
  })

  it("parses task with dependencies", () => {
    const md = `## #2 Deploy [agent:vps] [status:running] [needs: #1]
- Started: 2026-06-23`
    const tasks = parseTasks(md)
    expect(tasks[0].depends_on).toEqual(["#1"])
  })

  it("parses multiple tasks", () => {
    const md = `## #1 Task A [status:done]
## #2 Task B [status:running] [needs: #1]
## #3 Task C [status:blocked] [needs: #1, #2]`
    const tasks = parseTasks(md)
    expect(tasks).toHaveLength(3)
    expect(tasks[2].depends_on).toEqual(["#1", "#2"])
  })

  it("returns empty array for empty input", () => {
    expect(parseTasks("")).toEqual([])
    expect(parseTasks("# Title\nNo tasks here")).toEqual([])
  })

  it("parses metadata from bullet points", () => {
    const md = `## #1 Task [status:done]
- Started: 2026-06-23
- Completed: 2026-06-24`
    const tasks = parseTasks(md)
    expect(tasks[0].metadata).toEqual({
      Started: "2026-06-23",
      Completed: "2026-06-24",
    })
  })

  it("handles task with no brackets", () => {
    const md = `## #1 Simple Task`
    const tasks = parseTasks(md)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toEqual(
      expect.objectContaining({
        id: "#1",
        title: "Simple Task",
        status: "pending",
        depends_on: [],
      })
    )
  })
})
