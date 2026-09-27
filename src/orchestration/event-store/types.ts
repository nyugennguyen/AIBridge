import type {
  CommandId,
  CorrelationId,
  Digest,
  Epoch,
  EventId,
  ProjectId,
  RunId,
  SchemaVersion,
  Timestamp,
} from "../identifiers.js"
import type { Actor, OrchestrationCommand, OrchestrationEvent } from "../types.js"

export type Causation =
  | { kind: "command", commandId: CommandId }
  | { kind: "event", eventId: EventId }
  | null

export type CommandReceiptStatus = "accepted" | "in_progress" | "completed" | "rejected"

export type OutboxRecordStatus = "pending" | "sending" | "acknowledged" | "failed"

export interface StoredRunEvent {
  readonly globalPosition: number
  readonly eventId: EventId
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly sequence: number
  readonly type: OrchestrationEvent["type"]
  readonly schemaVersion: SchemaVersion
  readonly actor: Actor
  readonly occurredAt: Timestamp
  readonly correlationId: CorrelationId
  readonly causation: Causation
  readonly controllerEpoch: Epoch
  readonly commandId?: CommandId
  readonly payload: any
  readonly event: OrchestrationEvent
}

export function toDomainEvent(stored: StoredRunEvent): OrchestrationEvent {
  return stored.event
}

export interface StreamHead {
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly lastSequence: number
  readonly currentEpoch: Epoch
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

export interface CommandReceipt {
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly commandId: CommandId
  readonly commandFingerprint: Digest
  readonly commandType: string
  readonly issuerActor: Actor
  readonly status: CommandReceiptStatus
  readonly result?: unknown
  readonly error?: unknown
  readonly startSequence?: number
  readonly endSequence?: number
  readonly receivedAt: Timestamp
  readonly resolvedAt?: Timestamp
}

export interface OutboxRecord {
  readonly outboxId: string
  readonly destination: string
  readonly payloadJson: string
  readonly payloadDigest: Digest
  readonly status: OutboxRecordStatus
  readonly attempts: number
  readonly createdAt: Timestamp
  readonly lastAttemptedAt?: Timestamp
  readonly acknowledgedAt?: Timestamp
}

export interface OutboxRecordInput {
  readonly outboxId: string
  readonly destination: string
  readonly payload: unknown
  readonly payloadDigest?: Digest
  readonly status?: OutboxRecordStatus
  readonly attempts?: number
  readonly createdAt?: Timestamp
}

export interface SnapshotRecord {
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly aggregateType: string
  readonly aggregateId: string
  readonly sequence: number
  readonly state: unknown
  readonly digest: Digest
  readonly createdAt: Timestamp
}

export type EventInput = OrchestrationEvent | (Omit<OrchestrationEvent, "sequence"> & { sequence?: number })

export interface AppendCommandOptions {
  readonly command: OrchestrationCommand
  readonly events: readonly EventInput[]
  readonly expectedSequence?: number
  readonly commandResult?: unknown
  readonly commandError?: unknown
  readonly status?: CommandReceiptStatus
  readonly outboxRecords?: readonly OutboxRecordInput[]
}

export interface AppendResult {
  readonly duplicate: boolean
  readonly startSequence?: number
  readonly endSequence?: number
  readonly receipt: CommandReceipt
  readonly events: readonly StoredRunEvent[]
}

export interface ReadStreamOptions {
  readonly fromSequence?: number
  readonly toSequence?: number
  readonly limit?: number
}

export interface ReadGlobalOptions {
  readonly fromPosition?: number
  readonly limit?: number
}
