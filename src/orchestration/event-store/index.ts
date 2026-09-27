export {
  createSqliteDriver,
  openSqliteDriver,
  openInMemoryDriver,
  type SqliteDriver,
  type SqliteStatement,
  type SqliteDriverOptions,
} from "./sqlite-driver.js"

export {
  CURRENT_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS_TABLE_SQL,
  INITIAL_SCHEMA_SQL,
  type SchemaMigrationRow,
  type RunStreamRow,
  type RunEventRow,
  type CommandReceiptRow,
  type OutboxRecordRow,
  type SnapshotRow,
} from "./schema.js"

export {
  type Migration,
  type MigrationResult,
  MIGRATIONS,
  ensureMigrationsTable,
  getSchemaVersion,
  runMigrations,
  verifySchemaVersion,
} from "./migrations.js"

export {
  EventStoreError,
  UnsupportedSchemaVersionError,
  FingerprintConflictError,
  SequenceMismatchError,
  SequenceOverflowError,
  DuplicateEventError,
  StreamProjectMismatchError,
} from "./errors.js"

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
  type SnapshotRecord,
  type AppendCommandOptions,
  type AppendResult,
  type ReadStreamOptions,
  type ReadGlobalOptions,
} from "./types.js"

export { SqliteEventStore } from "./event-store.js"
