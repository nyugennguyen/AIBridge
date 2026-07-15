import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { TaskEntry, TaskGraphSyncer } from "./types.js"
import { parseTasks } from "./parser.js"

export class FileTaskGraphSyncer implements TaskGraphSyncer {
  constructor(private readonly filePath: string) {}

  async getTasks(): Promise<TaskEntry[]> {
    try {
      const content = await readFile(this.filePath, "utf8")
      return parseTasks(content)
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return []
      }
      throw error
    }
  }

  async syncJobToTask(
    taskId: string,
    status: string,
    metadata: Record<string, string> = {},
  ): Promise<void> {
    const tasks = await this.getTasks()
    const existing = tasks.find((t) => t.id === taskId)

    if (existing) {
      existing.status = status as TaskEntry["status"]
      Object.assign(existing.metadata, metadata)
    } else {
      tasks.push({
        id: taskId,
        title: `Task ${taskId}`,
        status: status as TaskEntry["status"],
        depends_on: [],
        metadata,
      })
    }

    const content = this.serializeTasks(tasks)
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, content, "utf8")
  }

  async parseTaskDependencies(): Promise<Map<string, string[]>> {
    const tasks = await this.getTasks()
    const deps = new Map<string, string[]>()
    for (const task of tasks) {
      deps.set(task.id, task.depends_on)
    }
    return deps
  }

  startWatching(): void {
    // POC: no-op, future: chokidar watch
  }

  stopWatching(): void {
    // POC: no-op
  }

  private serializeTasks(tasks: TaskEntry[]): string {
    const lines: string[] = ["# Project Tasks", ""]
    for (const task of tasks) {
      const agentPart = task.agent ? ` [agent:${task.agent}]` : ""
      const needsPart =
        task.depends_on.length > 0
          ? ` [needs: ${task.depends_on.join(", ")}]`
          : ""
      lines.push(
        `## ${task.id} ${task.title}${agentPart} [status:${task.status}]${needsPart}`,
      )
      for (const [key, value] of Object.entries(task.metadata)) {
        lines.push(`- ${key}: ${value}`)
      }
      lines.push("")
    }
    return lines.join("\n")
  }
}
