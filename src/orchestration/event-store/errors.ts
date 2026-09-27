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
