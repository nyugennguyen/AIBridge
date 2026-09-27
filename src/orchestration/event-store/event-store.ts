import { digestJson } from "../digest.js"
import type {
  CommandId,
  Digest,
  Epoch,
  EventId,
  ProjectId,
  RunId,
  Timestamp,
} from "../identifiers.js"
import { orchestrationCommandSchema, orchestrationEventSchema } from "../schemas.js"
import type { Actor, OrchestrationEvent } from "../types.js"
import {
  DuplicateEventError,
  FingerprintConflictError,
  SequenceMismatchError,
  SequenceOverflowError,
  StreamProjectMismatchError,
} from "./errors.js"
import { runMigrations } from "./migrations.js"
import type {
  CommandReceiptRow,
  OutboxRecordRow,
  RunEventRow,
  RunStreamRow,
  SnapshotRow,
} from "./schema.js"
import {
  createSqliteDriver,
  openInMemoryDriver,
  type SqliteDriver,
  type SqliteDriverOptions,
} from "./sqlite-driver.js"
import type {
  AppendCommandOptions,
  AppendResult,
  CommandReceipt,
  CommandReceiptStatus,
  OutboxRecord,
  OutboxRecordStatus,
  ReadGlobalOptions,
  ReadStreamOptions,
  SnapshotRecord,
  StoredRunEvent,
  StreamHead,
} from "./types.js"

export class SqliteEventStore {
  readonly driver: SqliteDriver

  constructor(driver: SqliteDriver, options?: { skipMigration?: boolean }) {
    this.driver = driver
    if (!options?.skipMigration) {
      runMigrations(this.driver)
    }
  }

  static open(options?: string | SqliteDriverOptions): SqliteEventStore {
    const driver = createSqliteDriver(options)
    return new SqliteEventStore(driver)
  }

  static createInMemory(): SqliteEventStore {
    return new SqliteEventStore(openInMemoryDriver())
  }

  append(options: AppendCommandOptions): AppendResult {
    return this.driver.transaction(() => {
      const command = orchestrationCommandSchema.parse(options.command)
      const commandFingerprint = digestJson(command)

      const existingReceiptRow = this.driver.get<CommandReceiptRow>(
        "SELECT * FROM command_receipts WHERE project_id = ? AND run_id = ? AND command_id = ?",
        command.projectId,
        command.runId,
        command.commandId
      )

      if (existingReceiptRow) {
        if (existingReceiptRow.command_fingerprint === commandFingerprint) {
          const receipt = this.mapCommandReceipt(existingReceiptRow)
          return {
            duplicate: true,
            startSequence: receipt.startSequence,
            endSequence: receipt.endSequence,
            receipt,
            events: [],
          }
        }

        throw new FingerprintConflictError(
          command.commandId,
          existingReceiptRow.command_fingerprint,
          commandFingerprint
        )
      }

      const streamRow = this.driver.get<RunStreamRow>(
        "SELECT * FROM run_streams WHERE run_id = ?",
        command.runId
      )

      if (streamRow && streamRow.project_id !== command.projectId) {
        throw new StreamProjectMismatchError(
          command.runId,
          streamRow.project_id,
          command.projectId
        )
      }

      const currentLastSequence = streamRow ? streamRow.last_sequence : 0

      if (options.expectedSequence !== undefined && options.expectedSequence !== currentLastSequence) {
        throw new SequenceMismatchError(
          command.runId,
          options.expectedSequence,
          currentLastSequence
        )
      }

      const eventCount = options.events.length
      if (eventCount > 0 && currentLastSequence + eventCount > Number.MAX_SAFE_INTEGER) {
        throw new SequenceOverflowError(currentLastSequence + eventCount)
      }

      const processedEvents: OrchestrationEvent[] = []
      for (let i = 0; i < eventCount; i++) {
        const rawEvent = options.events[i]
        const targetSequence = currentLastSequence + 1 + i

        if (rawEvent.sequence !== undefined && rawEvent.sequence > 0) {
          if (rawEvent.sequence !== targetSequence) {
            throw new SequenceMismatchError(
              command.runId,
              targetSequence,
              rawEvent.sequence,
              `Event sequence gap: event sequence ${rawEvent.sequence} does not match expected sequence ${targetSequence}`
            )
          }
        }

        const candidateEvent = {
          ...rawEvent,
          sequence: targetSequence,
          projectId: command.projectId,
          runId: command.runId,
          controllerEpoch: rawEvent.controllerEpoch ?? command.controllerEpoch,
          commandId: rawEvent.commandId ?? command.commandId,
        }

        const validatedEvent = orchestrationEventSchema.parse(candidateEvent)
        processedEvents.push(validatedEvent)
      }

      const storedEvents: StoredRunEvent[] = []
      for (const ev of processedEvents) {
        const metadata = { actor: ev.actor }
        try {
          const runRes = this.driver.run(
            `INSERT INTO run_events (
              event_id, project_id, run_id, sequence, type,
              schema_version, payload_json, metadata_json, occurred_at,
              controller_epoch, command_id, correlation_id, causation_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ev.eventId,
            ev.projectId,
            ev.runId,
            ev.sequence,
            ev.type,
            ev.schemaVersion,
            JSON.stringify(ev.payload),
            JSON.stringify(metadata),
            ev.occurredAt,
            ev.controllerEpoch,
            ev.commandId ?? null,
            ev.correlationId ?? null,
            ev.causation ? JSON.stringify(ev.causation) : null
          )
          const globalPos = Number(runRes.lastInsertRowid)
          storedEvents.push({
            ...ev,
            globalPosition: globalPos,
            event: ev,
          })
        } catch (err: any) {
          if (err?.message?.includes("UNIQUE constraint failed: run_events.event_id")) {
            throw new DuplicateEventError(ev.eventId)
          }
          if (err?.message?.includes("UNIQUE constraint failed: run_events.run_id, run_events.sequence")) {
            throw new SequenceMismatchError(
              ev.runId,
              ev.sequence,
              currentLastSequence,
              `Duplicate sequence ${ev.sequence} for run ${ev.runId}`
            )
          }
          throw err
        }
      }

      const newLastSequence = eventCount > 0 ? currentLastSequence + eventCount : currentLastSequence
      const now = new Date().toISOString()

      if (!streamRow) {
        this.driver.run(
          `INSERT INTO run_streams (
            project_id, run_id, last_sequence, current_epoch, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          command.projectId,
          command.runId,
          newLastSequence,
          command.controllerEpoch,
          now,
          now
        )
      } else {
        this.driver.run(
          `UPDATE run_streams SET
            last_sequence = ?,
            current_epoch = ?,
            updated_at = ?
          WHERE project_id = ? AND run_id = ?`,
          newLastSequence,
          Math.max(streamRow.current_epoch, command.controllerEpoch),
          now,
          command.projectId,
          command.runId
        )
      }

      let receiptStatus: CommandReceiptStatus = options.status ?? "completed"
      if (options.commandError !== undefined) {
        receiptStatus = "rejected"
      } else if (options.commandResult === undefined && !options.status) {
        receiptStatus = "accepted"
      }

      const startSequence = eventCount > 0 ? processedEvents[0].sequence : null
      const endSequence = eventCount > 0 ? processedEvents[eventCount - 1].sequence : null

      this.driver.run(
        `INSERT INTO command_receipts (
          project_id, run_id, command_id, command_fingerprint, command_type,
          issuer_actor_json, status, result_json, error_json,
          start_sequence, end_sequence, received_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        command.projectId,
        command.runId,
        command.commandId,
        commandFingerprint,
        command.type,
        JSON.stringify(command.actor),
        receiptStatus,
        options.commandResult !== undefined ? JSON.stringify(options.commandResult) : null,
        options.commandError !== undefined ? JSON.stringify(options.commandError) : null,
        startSequence,
        endSequence,
        now,
        now
      )

      const receipt: CommandReceipt = {
        projectId: command.projectId,
        runId: command.runId,
        commandId: command.commandId,
        commandFingerprint,
        commandType: command.type,
        issuerActor: command.actor,
        status: receiptStatus,
        result: options.commandResult,
        error: options.commandError,
        startSequence: startSequence ?? undefined,
        endSequence: endSequence ?? undefined,
        receivedAt: now as Timestamp,
        resolvedAt: now as Timestamp,
      }

      if (options.outboxRecords && options.outboxRecords.length > 0) {
        for (const outbox of options.outboxRecords) {
          const payloadJson = typeof outbox.payload === "string" ? outbox.payload : JSON.stringify(outbox.payload)
          const digest = outbox.payloadDigest ?? digestJson(outbox.payload)
          this.driver.run(
            `INSERT INTO outbox_records (
              outbox_id, destination, payload_json, payload_digest, status, attempts, created_at, last_attempted_at, acknowledged_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            outbox.outboxId,
            outbox.destination,
            payloadJson,
            digest,
            outbox.status ?? "pending",
            outbox.attempts ?? 0,
            outbox.createdAt ?? now,
            null,
            null
          )
        }
      }

      return {
        duplicate: false,
        startSequence: startSequence ?? undefined,
        endSequence: endSequence ?? undefined,
        receipt,
        events: storedEvents,
      }
    })
  }

  readStream(runId: string, options?: ReadStreamOptions): StoredRunEvent[] {
    let sql = `
      SELECT global_position, event_id, project_id, run_id, sequence, type,
             schema_version, payload_json, metadata_json, occurred_at,
             controller_epoch, command_id, correlation_id, causation_json
      FROM run_events
      WHERE run_id = ?
    `
    const params: unknown[] = [runId]

    if (options?.fromSequence !== undefined) {
      sql += " AND sequence >= ?"
      params.push(options.fromSequence)
    }
    if (options?.toSequence !== undefined) {
      sql += " AND sequence <= ?"
      params.push(options.toSequence)
    }

    sql += " ORDER BY sequence ASC"

    if (options?.limit !== undefined) {
      sql += " LIMIT ?"
      params.push(options.limit)
    }

    const rows = this.driver.all<RunEventRow>(sql, ...params)
    return rows.map((row) => this.mapRunEventRow(row))
  }

  readGlobal(options?: ReadGlobalOptions): StoredRunEvent[] {
    let sql = `
      SELECT global_position, event_id, project_id, run_id, sequence, type,
             schema_version, payload_json, metadata_json, occurred_at,
             controller_epoch, command_id, correlation_id, causation_json
      FROM run_events
    `
    const params: unknown[] = []

    if (options?.fromPosition !== undefined) {
      sql += " WHERE global_position >= ?"
      params.push(options.fromPosition)
    }

    sql += " ORDER BY global_position ASC"

    if (options?.limit !== undefined) {
      sql += " LIMIT ?"
      params.push(options.limit)
    }

    const rows = this.driver.all<RunEventRow>(sql, ...params)
    return rows.map((row) => this.mapRunEventRow(row))
  }

  getStreamHead(runId: string): StreamHead | undefined {
    const row = this.driver.get<RunStreamRow>(
      "SELECT project_id, run_id, last_sequence, current_epoch, created_at, updated_at FROM run_streams WHERE run_id = ?",
      runId
    )
    if (!row) return undefined
    return {
      projectId: row.project_id as ProjectId,
      runId: row.run_id as RunId,
      lastSequence: row.last_sequence,
      currentEpoch: row.current_epoch as Epoch,
      createdAt: row.created_at as Timestamp,
      updatedAt: row.updated_at as Timestamp,
    }
  }

  getCommandReceipt(projectId: string, runId: string, commandId: string): CommandReceipt | undefined {
    const row = this.driver.get<CommandReceiptRow>(
      "SELECT * FROM command_receipts WHERE project_id = ? AND run_id = ? AND command_id = ?",
      projectId,
      runId,
      commandId
    )
    if (!row) return undefined
    return this.mapCommandReceipt(row)
  }

  saveSnapshot(snapshot: SnapshotRecord): void {
    const stateJson = typeof snapshot.state === "string" ? snapshot.state : JSON.stringify(snapshot.state)
    this.driver.run(
      `INSERT INTO snapshots (
        project_id, run_id, aggregate_type, aggregate_id, sequence, state_json, digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id, run_id, aggregate_type, aggregate_id) DO UPDATE SET
        sequence = excluded.sequence,
        state_json = excluded.state_json,
        digest = excluded.digest,
        created_at = excluded.created_at`,
      snapshot.projectId,
      snapshot.runId,
      snapshot.aggregateType,
      snapshot.aggregateId,
      snapshot.sequence,
      stateJson,
      snapshot.digest,
      snapshot.createdAt
    )
  }

  getSnapshot(
    projectId: string,
    runId: string,
    aggregateType: string,
    aggregateId: string
  ): SnapshotRecord | undefined {
    const row = this.driver.get<SnapshotRow>(
      "SELECT * FROM snapshots WHERE project_id = ? AND run_id = ? AND aggregate_type = ? AND aggregate_id = ?",
      projectId,
      runId,
      aggregateType,
      aggregateId
    )
    if (!row) return undefined
    return {
      projectId: row.project_id as ProjectId,
      runId: row.run_id as RunId,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      sequence: row.sequence,
      state: JSON.parse(row.state_json),
      digest: row.digest as Digest,
      createdAt: row.created_at as Timestamp,
    }
  }

  getOutboxRecord(outboxId: string): OutboxRecord | undefined {
    const row = this.driver.get<OutboxRecordRow>(
      "SELECT * FROM outbox_records WHERE outbox_id = ?",
      outboxId
    )
    if (!row) return undefined
    return {
      outboxId: row.outbox_id,
      destination: row.destination,
      payloadJson: row.payload_json,
      payloadDigest: row.payload_digest as Digest,
      status: row.status as OutboxRecordStatus,
      attempts: row.attempts,
      createdAt: row.created_at as Timestamp,
      lastAttemptedAt: row.last_attempted_at ? (row.last_attempted_at as Timestamp) : undefined,
      acknowledgedAt: row.acknowledged_at ? (row.acknowledged_at as Timestamp) : undefined,
    }
  }

  listPendingOutbox(limit = 100): OutboxRecord[] {
    const rows = this.driver.all<OutboxRecordRow>(
      "SELECT * FROM outbox_records WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?",
      limit
    )
    return rows.map((row) => ({
      outboxId: row.outbox_id,
      destination: row.destination,
      payloadJson: row.payload_json,
      payloadDigest: row.payload_digest as Digest,
      status: row.status as OutboxRecordStatus,
      attempts: row.attempts,
      createdAt: row.created_at as Timestamp,
      lastAttemptedAt: row.last_attempted_at ? (row.last_attempted_at as Timestamp) : undefined,
      acknowledgedAt: row.acknowledged_at ? (row.acknowledged_at as Timestamp) : undefined,
    }))
  }

  markOutboxAcknowledged(outboxId: string): void {
    const now = new Date().toISOString()
    this.driver.run(
      "UPDATE outbox_records SET status = 'acknowledged', acknowledged_at = ? WHERE outbox_id = ?",
      now,
      outboxId
    )
  }

  async backup(destinationPath: string): Promise<void> {
    await this.driver.backup(destinationPath)
  }

  close(): void {
    this.driver.close()
  }

  private mapRunEventRow(row: RunEventRow): StoredRunEvent {
    const metadata = JSON.parse(row.metadata_json)
    const causation = row.causation_json ? JSON.parse(row.causation_json) : null
    const payload = JSON.parse(row.payload_json)

    const rawDomainEvent = {
      schemaVersion: 1 as const,
      eventId: row.event_id,
      sequence: row.sequence,
      projectId: row.project_id,
      runId: row.run_id,
      actor: metadata.actor,
      occurredAt: row.occurred_at,
      correlationId: row.correlation_id,
      causation,
      controllerEpoch: row.controller_epoch,
      commandId: row.command_id ?? undefined,
      type: row.type,
      payload,
    }

    const domainEvent = orchestrationEventSchema.parse(rawDomainEvent)

    return {
      ...domainEvent,
      globalPosition: row.global_position,
      event: domainEvent,
    }
  }

  private mapCommandReceipt(row: CommandReceiptRow): CommandReceipt {
    return {
      projectId: row.project_id as ProjectId,
      runId: row.run_id as RunId,
      commandId: row.command_id as CommandId,
      commandFingerprint: row.command_fingerprint as Digest,
      commandType: row.command_type,
      issuerActor: JSON.parse(row.issuer_actor_json) as Actor,
      status: row.status as CommandReceiptStatus,
      result: row.result_json ? JSON.parse(row.result_json) : undefined,
      error: row.error_json ? JSON.parse(row.error_json) : undefined,
      startSequence: row.start_sequence ?? undefined,
      endSequence: row.end_sequence ?? undefined,
      receivedAt: row.received_at as Timestamp,
      resolvedAt: row.resolved_at ? (row.resolved_at as Timestamp) : undefined,
    }
  }
}
