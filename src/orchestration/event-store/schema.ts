/**
 * The DATABASE schema version — the physical storage layout only.
 *
 * This is deliberately a different axis from the RECORD schema version in
 * `../identifiers.ts` (`CURRENT_SCHEMA_VERSION`). The Milestone 3 re-approval
 * recorded that the documented "a v1 binary can still read a v2 database"
 * rollback boundary did not account for event-payload compatibility, because a
 * payload shape changed while the record version stayed a literal. A payload
 * shape change is therefore answered by a RECORD version bump, never by a
 * migration here, and the two constants must not be conflated.
 */
export const CURRENT_DATABASE_VERSION = 2

export const SCHEMA_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  name TEXT NOT NULL
);
`

/**
 * v1 shipped the original tables. It is intentionally left byte-for-byte stable:
 * a database that already recorded migration 1 must keep validating against the
 * exact DDL that was applied, so v2 is expressed only as additive changes.
 */
export const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS run_streams (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  last_sequence INTEGER NOT NULL,
  current_epoch INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, run_id)
);

CREATE INDEX IF NOT EXISTS idx_run_streams_run_id ON run_streams(run_id);

CREATE TABLE IF NOT EXISTS run_events (
  global_position INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  controller_epoch INTEGER NOT NULL,
  command_id TEXT,
  correlation_id TEXT,
  causation_json TEXT,
  UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_run_events_project_run ON run_events(project_id, run_id);
CREATE INDEX IF NOT EXISTS idx_run_events_correlation ON run_events(correlation_id);
CREATE INDEX IF NOT EXISTS idx_run_events_command ON run_events(command_id);
CREATE INDEX IF NOT EXISTS idx_run_events_type ON run_events(type);

CREATE TABLE IF NOT EXISTS command_receipts (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL,
  command_type TEXT NOT NULL,
  issuer_actor_json TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  start_sequence INTEGER,
  end_sequence INTEGER,
  received_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (project_id, run_id, command_id)
);

CREATE INDEX IF NOT EXISTS idx_command_receipts_run_cmd ON command_receipts(run_id, command_id);

CREATE TABLE IF NOT EXISTS outbox_records (
  outbox_id TEXT PRIMARY KEY,
  destination TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_attempted_at TEXT,
  acknowledged_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON outbox_records(status, created_at);

CREATE TABLE IF NOT EXISTS snapshots (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, run_id, aggregate_type, aggregate_id)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_run_seq ON snapshots(run_id, sequence);
`

/**
 * v2 — additive only. No column or table is dropped, renamed, or retyped, so a
 * database migrated to v2 remains readable by v1 code paths and can be rolled
 * back by running v1 code against the same file. The rollback boundary is
 * documented on the v2 migration in ./migrations.ts.
 *
 * Adds:
 *  - outbox claim/lease/retry columns (storage primitives for the M3.7
 *    coordinator; no delivery loop lives here),
 *  - outbox run/project/destination indexes for single-run workers,
 *  - a partial unique index so the same command cannot enqueue the same
 *    destination payload twice,
 *  - `command_receipts.fingerprint_version` so semantic (v2) and legacy
 *    whole-command (v1) receipts can coexist without either side corrupting,
 *  - `dispatch_attempt_tombstones`, the storage-level guarantee that a
 *    `(runId, dispatchId, attempt)` envelope is proposed exactly once.
 */
export const DISPATCH_ENVELOPE_TOMBSTONE_SQL = `
CREATE TABLE IF NOT EXISTS dispatch_attempt_tombstones (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  envelope_digest TEXT NOT NULL,
  event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  proposed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, run_id, dispatch_id, attempt)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_tombstone_event
  ON dispatch_attempt_tombstones(event_id);
`

export const OUTBOX_LEASE_COLUMNS_SQL = `
ALTER TABLE outbox_records ADD COLUMN project_id TEXT;
ALTER TABLE outbox_records ADD COLUMN run_id TEXT;
ALTER TABLE outbox_records ADD COLUMN command_id TEXT;
ALTER TABLE outbox_records ADD COLUMN sequence_start INTEGER;
ALTER TABLE outbox_records ADD COLUMN sequence_end INTEGER;
ALTER TABLE outbox_records ADD COLUMN claim_token TEXT;
ALTER TABLE outbox_records ADD COLUMN lease_expires_at TEXT;
ALTER TABLE outbox_records ADD COLUMN next_attempt_at TEXT;
ALTER TABLE outbox_records ADD COLUMN last_error TEXT;
ALTER TABLE outbox_records ADD COLUMN failed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_outbox_claim
  ON outbox_records(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_run
  ON outbox_records(run_id, status);
CREATE INDEX IF NOT EXISTS idx_outbox_destination
  ON outbox_records(destination, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_command_destination
  ON outbox_records(command_id, destination, payload_digest)
  WHERE command_id IS NOT NULL;
`

export const RECEIPT_FINGERPRINT_VERSION_COLUMN_SQL = `
ALTER TABLE command_receipts ADD COLUMN fingerprint_version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_command_receipts_fingerprint
  ON command_receipts(project_id, run_id, command_fingerprint)
  WHERE fingerprint_version = 2;
`

/**
 * Physical table/index set that a fully migrated v2 database must expose.
 * Used by the startup integrity check so a database that is only partially
 * migrated fails closed instead of silently losing idempotency or dispatch
 * immutability guarantees.
 */
export const REQUIRED_V2_OBJECTS: readonly { type: string, name: string }[] = [
  { type: "table", name: "dispatch_attempt_tombstones" },
  { type: "index", name: "idx_dispatch_tombstone_event" },
  { type: "index", name: "idx_outbox_claim" },
  { type: "index", name: "idx_outbox_run" },
  { type: "index", name: "idx_outbox_destination" },
  { type: "index", name: "idx_outbox_command_destination" },
  { type: "index", name: "idx_command_receipts_fingerprint" },
]

export interface SchemaMigrationRow {
  version: number
  applied_at: string
  name: string
}

export interface RunStreamRow {
  project_id: string
  run_id: string
  last_sequence: number
  current_epoch: number
  created_at: string
  updated_at: string
}

export interface RunEventRow {
  global_position: number
  event_id: string
  project_id: string
  run_id: string
  sequence: number
  type: string
  schema_version: number
  payload_json: string
  metadata_json: string
  occurred_at: string
  controller_epoch: number
  command_id: string | null
  correlation_id: string | null
  causation_json: string | null
}

export interface CommandReceiptRow {
  project_id: string
  run_id: string
  command_id: string
  command_fingerprint: string
  command_type: string
  issuer_actor_json: string
  status: string
  result_json: string | null
  error_json: string | null
  start_sequence: number | null
  end_sequence: number | null
  received_at: string
  resolved_at: string | null
  /** Absent on a database that has not run migration 2. */
  fingerprint_version?: number | null
}

export interface OutboxRecordRow {
  outbox_id: string
  destination: string
  payload_json: string
  payload_digest: string
  status: string
  attempts: number
  created_at: string
  last_attempted_at: string | null
  acknowledged_at: string | null
  /** v2 columns; null on rows written before migration 2 ran. */
  project_id?: string | null
  run_id?: string | null
  command_id?: string | null
  sequence_start?: number | null
  sequence_end?: number | null
  claim_token?: string | null
  lease_expires_at?: string | null
  next_attempt_at?: string | null
  last_error?: string | null
  failed_at?: string | null
}

export interface DispatchAttemptTombstoneRow {
  project_id: string
  run_id: string
  dispatch_id: string
  attempt: number
  envelope_digest: string
  event_id: string
  sequence: number
  proposed_at: string
}

export interface SnapshotRow {
  project_id: string
  run_id: string
  aggregate_type: string
  aggregate_id: string
  sequence: number
  state_json: string
  digest: string
  created_at: string
}
