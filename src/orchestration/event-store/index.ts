export {
  createSqliteDriver,
  openSqliteDriver,
  openInMemoryDriver,
  type SqliteDriver,
  type SqliteStatement,
  type SqliteDriverOptions,
} from "./sqlite-driver.js"

export {
  CURRENT_DATABASE_VERSION,
  SCHEMA_MIGRATIONS_TABLE_SQL,
  INITIAL_SCHEMA_SQL,
  DISPATCH_ENVELOPE_TOMBSTONE_SQL,
  OUTBOX_LEASE_COLUMNS_SQL,
  RECEIPT_FINGERPRINT_VERSION_COLUMN_SQL,
  REQUIRED_V2_OBJECTS,
  type SchemaMigrationRow,
  type RunStreamRow,
  type RunEventRow,
  type CommandReceiptRow,
  type OutboxRecordRow,
  type DispatchAttemptTombstoneRow,
  type SnapshotRow,
} from "./schema.js"

export {
  type Migration,
  type MigrationResult,
  type RunMigrationsOptions,
  MIGRATIONS,
  ensureMigrationsTable,
  getSchemaVersion,
  runMigrations,
  verifySchemaVersion,
  assertSchemaVersionSupported,
  assertMigrationHistoryIsContiguous,
  assertSchemaObjectsPresent,
} from "./migrations.js"

export {
  EventStoreError,
  UnsupportedDatabaseVersionError,
  FailedMigrationError,
  IncompleteMigrationHistoryError,
  DestructiveMigrationNotPermittedError,
  IncompleteSchemaError,
  FingerprintConflictError,
  SequenceMismatchError,
  SequenceOverflowError,
  DuplicateEventError,
  DispatchAttemptConflictError,
  StreamProjectMismatchError,
} from "./errors.js"

export {
  NON_SEMANTIC_COMMAND_FIELDS,
  CURRENT_COMMAND_FINGERPRINT_VERSION,
  type CommandFingerprintVersion,
  type CommandFingerprints,
  fingerprintCommand,
  commandFingerprintMatches,
} from "./fingerprint.js"

export {
  OutboxStore,
  mapOutboxRow,
} from "./outbox-store.js"

export {
  type Causation,
  type CommandReceiptStatus,
  type OutboxRecordStatus,
  type StoredRunEvent,
  type EventInput,
  toDomainEvent,
  type StreamHead,
  type CommandReceipt,
  type OutboxRecord,
  type OutboxRecordInput,
  type OutboxFilter,
  type ClaimOutboxOptions,
  type OutboxClaim,
  type OutboxWriteResult,
  type OutboxRecoveryResult,
  type DispatchAttemptTombstone,
  type SnapshotRecord,
  type AppendCommandOptions,
  type AppendResult,
  type ReadStreamOptions,
  type ReadGlobalOptions,
} from "./types.js"

export { SqliteEventStore } from "./event-store.js"
