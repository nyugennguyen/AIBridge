import { type ErrorCategory, type ContractError, createContractError } from "../errors.js"

export class EventStoreError extends Error {
  readonly code: string
  readonly category: ErrorCategory

  constructor(message: string, code: string, category: ErrorCategory = "conflict") {
    super(message)
    this.name = "EventStoreError"
    this.code = code
    this.category = category
  }

  toContractError(): ContractError {
    return createContractError(this.category, this.code, this.message)
  }
}

export class UnsupportedSchemaVersionError extends EventStoreError {
  readonly dbVersion: number
  readonly supportedVersion: number

  constructor(dbVersion: number, supportedVersion: number) {
    super(
      `Database schema version ${dbVersion} is newer than supported version ${supportedVersion}. Migration failed closed to prevent data corruption.`,
      "schema.unsupported_version",
      "internal_failure",
    )
    this.name = "UnsupportedSchemaVersionError"
    this.dbVersion = dbVersion
    this.supportedVersion = supportedVersion
  }
}

export class FingerprintConflictError extends EventStoreError {
  readonly commandId: string
  readonly expectedFingerprint: string
  readonly actualFingerprint: string

  constructor(commandId: string, expectedFingerprint: string, actualFingerprint: string) {
    super(
      `Command '${commandId}' was already submitted with fingerprint '${expectedFingerprint}', but received conflicting fingerprint '${actualFingerprint}'.`,
      "command.fingerprint_conflict",
      "conflict",
    )
    this.name = "FingerprintConflictError"
    this.commandId = commandId
    this.expectedFingerprint = expectedFingerprint
    this.actualFingerprint = actualFingerprint
  }
}

export class SequenceMismatchError extends EventStoreError {
  readonly expectedSequence: number
  readonly actualSequence: number
  readonly runId: string

  constructor(runId: string, expectedSequence: number, actualSequence: number, detail?: string) {
    super(
      detail ?? `Optimistic concurrency check failed for run '${runId}': expected sequence ${expectedSequence}, but current stream head is ${actualSequence}.`,
      "concurrency.sequence_mismatch",
      "conflict",
    )
    this.name = "SequenceMismatchError"
    this.runId = runId
    this.expectedSequence = expectedSequence
    this.actualSequence = actualSequence
  }
}

export class SequenceOverflowError extends EventStoreError {
  readonly currentSequence: number

  constructor(currentSequence: number) {
    super(
      `Sequence allocation for sequence ${currentSequence} would exceed MAX_SAFE_INTEGER. Aborting to prevent data corruption.`,
      "concurrency.sequence_overflow",
      "internal_failure",
    )
    this.name = "SequenceOverflowError"
    this.currentSequence = currentSequence
  }
}

export class DuplicateEventError extends EventStoreError {
  readonly eventId: string

  constructor(eventId: string) {
    super(
      `Event with ID '${eventId}' already exists in the event store.`,
      "event.duplicate_id",
      "conflict",
    )
    this.name = "DuplicateEventError"
    this.eventId = eventId
  }
}

export class FailedMigrationError extends EventStoreError {
  readonly version: number
  readonly migrationName: string
  override readonly cause?: unknown

  constructor(version: number, migrationName: string, cause: unknown) {
    super(
      `Schema migration ${version} ('${migrationName}') failed and was rolled back. ` +
        `The database is unchanged. Restore from a backup or fix the reported cause before retrying. ` +
        `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
      "schema.migration_failed",
      "internal_failure",
    )
    this.name = "FailedMigrationError"
    this.version = version
    this.migrationName = migrationName
    this.cause = cause
  }
}

export class IncompleteMigrationHistoryError extends EventStoreError {
  readonly dbVersion: number
  readonly missingVersions: readonly number[]

  constructor(dbVersion: number, missingVersions: readonly number[]) {
    super(
      `Schema migration history is inconsistent: the database is at version ${dbVersion} but migration(s) ` +
        `${missingVersions.join(", ")} are not recorded as applied. Refusing to run further migrations; ` +
        `restore a consistent database or re-apply the missing migrations under an operator procedure.`,
      "schema.incomplete_migration_history",
      "internal_failure",
    )
    this.name = "IncompleteMigrationHistoryError"
    this.dbVersion = dbVersion
    this.missingVersions = missingVersions
  }
}

export class DestructiveMigrationNotPermittedError extends EventStoreError {
  readonly version: number
  readonly migrationName: string

  constructor(version: number, migrationName: string) {
    super(
      `Schema migration ${version} ('${migrationName}') is marked destructive. ` +
        `Take a consistent backup with SqliteEventStore.backup() before applying it, ` +
        `then re-run with { allowDestructive: true }.`,
      "schema.destructive_migration_blocked",
      "internal_failure",
    )
    this.name = "DestructiveMigrationNotPermittedError"
    this.version = version
    this.migrationName = migrationName
  }
}

export class IncompleteSchemaError extends EventStoreError {
  readonly missingObjects: readonly { type: string, name: string }[]

  constructor(missingObjects: readonly { type: string, name: string }[]) {
    super(
      `Database is missing ${missingObjects.length} required schema object(s): ` +
        `${missingObjects.map((o) => `${o.type} ${o.name}`).join(", ")}. ` +
        `The event store is not safe to open; restore a consistent database or run migrations.`,
      "schema.incomplete",
      "internal_failure",
    )
    this.name = "IncompleteSchemaError"
    this.missingObjects = missingObjects
  }
}

export class DispatchAttemptConflictError extends EventStoreError {
  readonly runId: string
  readonly dispatchId: string
  readonly attempt: number
  readonly existingDigest: string
  readonly incomingDigest: string

  constructor(
    runId: string,
    dispatchId: string,
    attempt: number,
    existingDigest: string,
    incomingDigest: string
  ) {
    super(
      `Dispatch '${dispatchId}' attempt ${attempt} in run '${runId}' is already proposed with envelope digest ` +
        `'${existingDigest}'. A dispatch envelope is immutable after proposal; edits must create a new ` +
        `dispatchId/attempt (or an explicit revision) rather than reusing this one.`,
      "dispatch.envelope_immutable",
      "conflict",
    )
    this.name = "DispatchAttemptConflictError"
    this.runId = runId
    this.dispatchId = dispatchId
    this.attempt = attempt
    this.existingDigest = existingDigest
    this.incomingDigest = incomingDigest
  }
}

export class StreamProjectMismatchError extends EventStoreError {
  readonly runId: string
  readonly existingProjectId: string
  readonly incomingProjectId: string

  constructor(runId: string, existingProjectId: string, incomingProjectId: string) {
    super(
      `Run '${runId}' is bound to project '${existingProjectId}', but command has project '${incomingProjectId}'.`,
      "stream.project_mismatch",
      "conflict",
    )
    this.name = "StreamProjectMismatchError"
    this.runId = runId
    this.existingProjectId = existingProjectId
    this.incomingProjectId = incomingProjectId
  }
}
