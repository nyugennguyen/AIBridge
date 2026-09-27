export const CURRENT_SCHEMA_VERSION = 1

export const SCHEMA_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  name TEXT NOT NULL
);
`

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
