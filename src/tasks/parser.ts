// src/tasks/parser.ts
import type { TaskEntry, TaskStatus } from "./types.js"

const TASK_HEADING_RE =
  /^## #(\d+)\s+(.+?)(?:\s+\[agent:([^\]]+)\])?(?:\s+\[status:([^\]]+)\])?(?:\s+\[needs:\s*([^\]]+)\])?\s*$/

export function parseTasks(markdown: string): TaskEntry[] {
  const lines = markdown.split("\n")
  const tasks: TaskEntry[] = []
  let current: TaskEntry | null = null

  for (const line of lines) {
    const headingMatch = TASK_HEADING_RE.exec(line)
    if (headingMatch) {
      if (current) tasks.push(current)
      const [, id, title, agent, status, needsStr] = headingMatch
      const depends_on = needsStr
        ? needsStr
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : []
      current = {
        id: `#${id}`,
        title: title.trim(),
        agent: agent ?? undefined,
        status: (status as TaskStatus) ?? "pending",
        depends_on,
        metadata: {},
      }
      continue
    }

    if (current && line.startsWith("- ")) {
      const [key, ...valueParts] = line.slice(2).split(":")
      if (key && valueParts.length > 0) {
        current.metadata[key.trim()] = valueParts.join(":").trim()
      }
    }
  }

  if (current) tasks.push(current)
  return tasks
}
