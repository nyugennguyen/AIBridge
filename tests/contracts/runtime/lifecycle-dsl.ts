import type { AgentRuntimeEvent, AgentResult, CompletionEvidence, ObservationConfidence, ObservationSource } from "../../../src/runtime/schemas.js"

export type LifecycleStep =
  | { type: "state"; state: "starting" | "idle" | "working" | "blocked" | "completed" | "failed" | "unknown"; detail?: string; source?: ObservationSource; confidence?: ObservationConfidence }
  | { type: "permission_request"; requestId: string; permission: string }
  | { type: "result"; result: AgentResult }
  | { type: "stdout"; line: string }
  | { type: "stderr"; line: string }
  | { type: "delay"; ms: number }
  | { type: "disconnect" }
  | { type: "exit"; code: number }

export interface LifecycleScript {
  readonly name: string
  readonly steps: LifecycleStep[]
}

export class LifecycleScriptBuilder {
  private readonly steps: LifecycleStep[] = []

  constructor(private readonly name: string = "test-scenario") {}

  starting(detail?: string): this {
    this.steps.push({ type: "state", state: "starting", detail, source: "hook", confidence: "authoritative" })
    return this
  }

  idle(detail?: string): this {
    this.steps.push({ type: "state", state: "idle", detail, source: "hook", confidence: "authoritative" })
    return this
  }

  working(detail?: string): this {
    this.steps.push({ type: "state", state: "working", detail, source: "hook", confidence: "authoritative" })
    return this
  }

  blocked(requestId: string, permission: string): this {
    this.steps.push({ type: "state", state: "blocked", detail: permission, source: "hook", confidence: "authoritative" })
    this.steps.push({ type: "permission_request", requestId, permission })
    return this
  }

  completed(summary: string, evidence?: CompletionEvidence): this {
    this.steps.push({
      type: "result",
      result: {
        schemaVersion: 1,
        outcome: "succeeded",
        summary,
        completionEvidence: evidence ?? { kind: "reliable_provider", mechanism: "script_completion" },
      },
    })
    this.steps.push({ type: "state", state: "completed", detail: summary, source: "hook", confidence: "authoritative" })
    return this
  }

  failed(summary: string): this {
    this.steps.push({
      type: "result",
      result: {
        schemaVersion: 1,
        outcome: "failed",
        summary,
      },
    })
    this.steps.push({ type: "state", state: "failed", detail: summary, source: "hook", confidence: "authoritative" })
    return this
  }

  unknown(detail = "Ambiguous state"): this {
    this.steps.push({ type: "state", state: "unknown", detail, source: "polling", confidence: "tentative" })
    return this
  }

  disconnect(): this {
    this.steps.push({ type: "disconnect" })
    return this
  }

  stdout(line: string): this {
    this.steps.push({ type: "stdout", line })
    return this
  }

  stderr(line: string): this {
    this.steps.push({ type: "stderr", line })
    return this
  }

  exit(code = 0): this {
    this.steps.push({ type: "exit", code })
    return this
  }

  delay(ms: number): this {
    this.steps.push({ type: "delay", ms })
    return this
  }

  build(): LifecycleScript {
    return {
      name: this.name,
      steps: [...this.steps],
    }
  }
}

export function createLifecycleScript(name: string): LifecycleScriptBuilder {
  return new LifecycleScriptBuilder(name)
}
