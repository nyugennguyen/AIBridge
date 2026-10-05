/**
 * Structured logger with automatic redaction and correlation tracing (M8.3).
 */

import { redactLogAttributes, type RedactionOptions } from "./redaction.js"
import type {
  CorrelationFields,
  LogLevel,
  LogEventName,
  StructuredLogEntry,
} from "./types.js"

export interface LoggerOptions extends RedactionOptions {
  readonly minLevel?: LogLevel
  readonly writer?: (line: string) => void
  readonly bufferCapacity?: number
  readonly context?: CorrelationFields
}

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export class StructuredLogger {
  private readonly minLevel: LogLevel
  private readonly writer?: (line: string) => void
  private readonly buffer: StructuredLogEntry[] = []
  private readonly bufferCapacity: number
  private readonly redactionOptions: RedactionOptions
  private readonly baseContext: CorrelationFields

  constructor(options?: LoggerOptions) {
    this.minLevel = options?.minLevel ?? "info"
    this.writer = options?.writer
    this.bufferCapacity = options?.bufferCapacity ?? 1000
    this.baseContext = options?.context ?? {}
    this.redactionOptions = {
      customSecrets: options?.customSecrets,
      projectRoot: options?.projectRoot,
    }
  }

  child(context: CorrelationFields): StructuredLogger {
    return new StructuredLogger({
      minLevel: this.minLevel,
      writer: this.writer,
      bufferCapacity: this.bufferCapacity,
      customSecrets: this.redactionOptions.customSecrets,
      projectRoot: this.redactionOptions.projectRoot,
      context: { ...this.baseContext, ...context },
    })
  }

  log(
    entry: {
      readonly level: LogLevel
      readonly event: LogEventName | string
      readonly durationMs?: number
      readonly result?: "success" | "failure" | "denied" | "timeout"
      readonly errorCode?: string
      readonly attributes?: Readonly<Record<string, unknown>>
      readonly correlation?: CorrelationFields
    } & CorrelationFields,
  ): StructuredLogEntry {
    if (LEVEL_SEVERITY[entry.level] < LEVEL_SEVERITY[this.minLevel]) {
      return {
        timestamp: new Date().toISOString(),
        ...this.baseContext,
        ...entry.correlation,
        level: entry.level,
        event: entry.event,
      }
    }

    const cleanedAttrs = redactLogAttributes(entry.attributes, this.redactionOptions)

    const finalEntry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      ...this.baseContext,
      ...entry.correlation,
      ...(entry.jobId ? { jobId: entry.jobId } : {}),
      ...(entry.runId ? { runId: entry.runId } : {}),
      ...(entry.projectId ? { projectId: entry.projectId } : {}),
      ...(entry.taskId ? { taskId: entry.taskId } : {}),
      ...(entry.dispatchId ? { dispatchId: entry.dispatchId } : {}),
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      ...(entry.correlationId ? { correlationId: entry.correlationId } : {}),
      ...(entry.nodeId ? { nodeId: entry.nodeId } : {}),
      ...(entry.controllerEpoch !== undefined ? { controllerEpoch: entry.controllerEpoch } : {}),
      ...(entry.adapterKind ? { adapterKind: entry.adapterKind } : {}),
      ...(entry.backendKind ? { backendKind: entry.backendKind } : {}),
      level: entry.level,
      event: entry.event,
      ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
      ...(entry.result !== undefined ? { result: entry.result } : {}),
      ...(entry.errorCode !== undefined ? { errorCode: entry.errorCode } : {}),
      ...(cleanedAttrs !== undefined ? { attributes: cleanedAttrs } : {}),
    }

    // Store in ring buffer
    this.buffer.push(finalEntry)
    if (this.buffer.length > this.bufferCapacity) {
      this.buffer.shift()
    }

    // Emit to writer if configured
    if (this.writer) {
      this.writer(JSON.stringify(finalEntry))
    }

    return finalEntry
  }

  debug(event: LogEventName | string, fields?: Partial<StructuredLogEntry>): StructuredLogEntry {
    return this.log({ level: "debug", event, ...fields })
  }

  info(event: LogEventName | string, fields?: Partial<StructuredLogEntry>): StructuredLogEntry {
    return this.log({ level: "info", event, ...fields })
  }

  warn(event: LogEventName | string, fields?: Partial<StructuredLogEntry>): StructuredLogEntry {
    return this.log({ level: "warn", event, ...fields })
  }

  error(event: LogEventName | string, fields?: Partial<StructuredLogEntry>): StructuredLogEntry {
    return this.log({ level: "error", event, ...fields })
  }

  getRecentLogs(limit = 100): readonly StructuredLogEntry[] {
    return this.buffer.slice(-limit)
  }

  getRecentErrors(limit = 50): readonly StructuredLogEntry[] {
    return this.buffer.filter((e) => e.level === "error" || e.level === "warn").slice(-limit)
  }

  clearBuffer(): void {
    this.buffer.length = 0
  }
}
