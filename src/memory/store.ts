import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { Decision, Handoff, MemoryStore } from "./types.js"

interface MemoryData {
  projectId: string
  decisions: Decision[]
  constraints: string[]
  handoffs: Handoff[]
}

export class FileMemoryStore implements MemoryStore {
  private readonly dataPath: string
  private data: MemoryData | null = null

  constructor(private readonly directory: string, private readonly projectId: string) {
    this.dataPath = join(directory, "memory.json")
  }

  async getProjectId(): Promise<string> {
    return this.projectId
  }

  async getDecisions(): Promise<Decision[]> {
    await this.ensureLoaded()
    return this.data!.decisions
  }

  async addDecision(decision: Decision): Promise<void> {
    await this.ensureLoaded()
    this.data!.decisions.push(decision)
    await this.save()
  }

  async getConstraints(): Promise<string[]> {
    await this.ensureLoaded()
    return this.data!.constraints
  }

  async addConstraint(constraint: string): Promise<void> {
    await this.ensureLoaded()
    this.data!.constraints.push(constraint)
    await this.save()
  }

  async createHandoff(handoff: Omit<Handoff, "id" | "status" | "createdAt">): Promise<Handoff> {
    await this.ensureLoaded()
    const full: Handoff = {
      ...handoff,
      id: randomUUID(),
      status: "pending",
      createdAt: new Date().toISOString(),
    }
    this.data!.handoffs.push(full)
    await this.save()
    return full
  }

  async getPendingHandoffs(agentId: string): Promise<Handoff[]> {
    await this.ensureLoaded()
    return this.data!.handoffs.filter((h) => h.to === agentId && h.status === "pending")
  }

  private async ensureLoaded(): Promise<void> {
    if (this.data) return
    try {
      const raw = await readFile(this.dataPath, "utf8")
      this.data = JSON.parse(raw)
    } catch {
      this.data = { projectId: this.projectId, decisions: [], constraints: [], handoffs: [] }
    }
  }

  private async save(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    await writeFile(this.dataPath, JSON.stringify(this.data, null, 2), "utf8")
  }
}
