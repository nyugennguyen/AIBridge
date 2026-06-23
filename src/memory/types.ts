export interface Decision {
  id: string
  timestamp: string
  agent: string
  content: string
}

export interface Handoff {
  id: string
  from: string
  to: string
  context: string
  status: "pending" | "accepted" | "completed"
  createdAt: string
}

export interface MemoryStore {
  getProjectId(): Promise<string>
  getDecisions(): Promise<Decision[]>
  addDecision(decision: Decision): Promise<void>
  getConstraints(): Promise<string[]>
  addConstraint(constraint: string): Promise<void>
  createHandoff(handoff: Omit<Handoff, "id" | "status" | "createdAt">): Promise<Handoff>
  getPendingHandoffs(agentId: string): Promise<Handoff[]>
}
