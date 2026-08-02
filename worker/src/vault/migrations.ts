import type { TransactionSync } from "./domain"

const CURRENT_SCHEMA_VERSION = 10

const REQUIRED_COLUMNS = {
  vault_state: [
    "singleton",
    "vault_id",
    "claimed_at",
    "recovery_signing_public_key",
    "recovery_package",
    "cursor",
    "head_hash",
    "log_format",
    "log_transition_cursor",
    "recovery_state_id",
    "current_epoch_id",
    "epoch_sequence",
    "epoch_transition_cursor",
  ],
  setup_sessions: ["token_hash", "challenge", "created_at", "expires_at", "consumed_at"],
  devices: [
    "device_id",
    "signing_public_key",
    "hpke_public_key",
    "certificate",
    "role",
    "authorized_at",
    "authorized_by",
    "revoked_at",
    "revoked_operation_id",
    "device_name",
    "platform",
  ],
  auth_challenges: [
    "challenge_id",
    "device_id",
    "challenge",
    "created_at",
    "expires_at",
    "consumed_at",
  ],
  recovery_challenges: ["challenge_id", "challenge", "created_at", "expires_at", "consumed_at"],
  sessions: ["token_hash", "device_id", "created_at", "expires_at"],
  pairings: [
    "pairing_id",
    "capability_hash",
    "initiator_device_id",
    "status",
    "created_at",
    "expires_at",
    "candidate_device_id",
    "candidate_signing_public_key",
    "candidate_hpke_public_key",
    "candidate_device_name",
    "candidate_platform",
    "candidate_proof",
    "candidate_request_proof",
    "joined_at",
    "certificate",
    "transcript_hash",
    "verification_preview",
    "approval_signature",
    "hpke_transfer",
    "verification_started_at",
    "initiator_confirmed_at",
    "candidate_confirmed_at",
    "candidate_confirmation_signature",
    "completion_signature",
    "completed_at",
    "canceled_at",
    "canceled_by",
  ],
  operations: [
    "cursor",
    "operation_id",
    "author_device_id",
    "epoch_id",
    "operation_type",
    "subject_device_id",
    "envelope",
    "signature",
    "request_hash",
    "previous_hash",
    "chain_hash",
    "created_at",
  ],
  checkpoints: [
    "checkpoint_id",
    "device_id",
    "cursor",
    "log_hash",
    "epoch_id",
    "envelope",
    "signature",
    "created_at",
  ],
  snapshots: [
    "snapshot_id",
    "author_device_id",
    "cursor",
    "log_hash",
    "epoch_id",
    "envelope",
    "signature",
    "created_at",
  ],
  blob_claims: ["blob_id", "claimed_at", "expected_size", "device_id"],
  blob_catalog: ["blob_id", "size", "observed_at"],
  recovery_receipts: [
    "recovery_id",
    "request_hash",
    "device_id",
    "recovery_state_id",
    "recovered_at",
  ],
  retention_acknowledgements: [
    "device_id",
    "cursor",
    "log_hash",
    "epoch_id",
    "history_retention",
    "signature",
    "acknowledged_at",
  ],
} as const

export function migrateVaultSchema(sql: SqlStorage, transactionSync: TransactionSync): void {
  const migrationLedgerExists =
    sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'table' AND name = '_sql_schema_migrations'`,
      )
      .one().count === 1

  if (!migrationLedgerExists) {
    const existingApplicationTables = sql
      .exec<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .toArray()
    if (existingApplicationTables.length > 0) {
      throw new Error("Meridian database predates the supported schema baseline")
    }
    transactionSync(() => {
      sql.exec(`
        CREATE TABLE _sql_schema_migrations (
          id INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        )
      `)
      createCurrentSchema(sql)
    })
    return
  }

  const version = sql
    .exec<{ version: number }>("SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations")
    .one().version
  if (version === 0) {
    throw new Error("Meridian database has no supported schema marker")
  }
  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported Meridian database schema ${version}`)
  }
  assertCurrentSchema(sql)
}

function createCurrentSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE vault_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      vault_id TEXT NOT NULL UNIQUE,
      claimed_at INTEGER NOT NULL,
      recovery_signing_public_key TEXT NOT NULL,
      recovery_package TEXT NOT NULL,
      cursor INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
      head_hash TEXT NOT NULL,
      log_format TEXT NOT NULL DEFAULT 'canonical-cbor-v1',
      log_transition_cursor INTEGER,
      recovery_state_id TEXT,
      current_epoch_id TEXT,
      epoch_sequence INTEGER,
      epoch_transition_cursor INTEGER
    );
    CREATE TABLE setup_sessions (
      token_hash TEXT PRIMARY KEY,
      challenge TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
    CREATE INDEX setup_sessions_expiry ON setup_sessions(expires_at);
    CREATE TABLE devices (
      device_id TEXT PRIMARY KEY,
      signing_public_key TEXT NOT NULL UNIQUE,
      hpke_public_key TEXT NOT NULL UNIQUE,
      certificate TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
      authorized_at INTEGER NOT NULL,
      authorized_by TEXT,
      revoked_at INTEGER,
      revoked_operation_id TEXT UNIQUE,
      device_name TEXT,
      platform TEXT
    );
    CREATE INDEX devices_active ON devices(revoked_at, device_id);
    CREATE TABLE auth_challenges (
      challenge_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      challenge TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
    CREATE INDEX auth_challenges_device_expiry ON auth_challenges(device_id, expires_at);
    CREATE TABLE recovery_challenges (
      challenge_id TEXT PRIMARY KEY,
      challenge TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
    CREATE INDEX recovery_challenges_expiry ON recovery_challenges(expires_at);
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX sessions_device_expiry ON sessions(device_id, expires_at);
    CREATE TABLE pairings (
      pairing_id TEXT PRIMARY KEY,
      capability_hash TEXT NOT NULL UNIQUE,
      initiator_device_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'joined', 'verifying', 'confirmed', 'released', 'completed', 'canceled')
      ),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      candidate_device_id TEXT,
      candidate_signing_public_key TEXT,
      candidate_hpke_public_key TEXT,
      candidate_device_name TEXT,
      candidate_platform TEXT,
      candidate_proof TEXT,
      candidate_request_proof TEXT,
      joined_at INTEGER,
      certificate TEXT,
      transcript_hash TEXT,
      verification_preview TEXT,
      approval_signature TEXT,
      hpke_transfer TEXT,
      verification_started_at INTEGER,
      initiator_confirmed_at INTEGER,
      candidate_confirmed_at INTEGER,
      candidate_confirmation_signature TEXT,
      completion_signature TEXT,
      completed_at INTEGER,
      canceled_at INTEGER,
      canceled_by TEXT
    );
    CREATE INDEX pairings_expiry ON pairings(expires_at);
    CREATE TABLE operations (
      cursor INTEGER PRIMARY KEY CHECK (cursor > 0),
      operation_id TEXT NOT NULL UNIQUE,
      author_device_id TEXT NOT NULL,
      epoch_id TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      subject_device_id TEXT,
      envelope TEXT NOT NULL,
      signature TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      previous_hash TEXT NOT NULL,
      chain_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX operations_author ON operations(author_device_id, cursor);
    CREATE TABLE checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      cursor INTEGER NOT NULL,
      log_hash TEXT NOT NULL,
      epoch_id TEXT NOT NULL,
      envelope TEXT NOT NULL,
      signature TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(device_id, cursor)
    );
    CREATE INDEX checkpoints_cursor ON checkpoints(cursor DESC, created_at DESC);
    CREATE TABLE snapshots (
      snapshot_id TEXT PRIMARY KEY,
      author_device_id TEXT NOT NULL,
      cursor INTEGER NOT NULL,
      log_hash TEXT NOT NULL,
      epoch_id TEXT NOT NULL,
      envelope TEXT NOT NULL,
      signature TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX snapshots_cursor ON snapshots(cursor DESC, created_at DESC);
    CREATE TABLE blob_claims (
      blob_id TEXT PRIMARY KEY,
      claimed_at INTEGER NOT NULL,
      expected_size INTEGER NOT NULL DEFAULT 0,
      device_id TEXT
    );
    CREATE INDEX blob_claims_age ON blob_claims(claimed_at);
    CREATE TABLE recovery_receipts (
      recovery_id TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      device_id TEXT NOT NULL,
      recovery_state_id TEXT NOT NULL,
      recovered_at INTEGER NOT NULL
    );
    CREATE TABLE retention_acknowledgements (
      device_id TEXT PRIMARY KEY,
      cursor INTEGER NOT NULL CHECK (cursor >= 0),
      log_hash TEXT NOT NULL,
      epoch_id TEXT NOT NULL,
      history_retention TEXT NOT NULL CHECK (history_retention = 'forever'),
      signature TEXT NOT NULL,
      acknowledged_at INTEGER NOT NULL
    );
    CREATE INDEX retention_acknowledgements_cursor ON retention_acknowledgements(cursor);
    CREATE TABLE blob_catalog (
      blob_id TEXT PRIMARY KEY,
      size INTEGER NOT NULL CHECK (size > 0),
      observed_at INTEGER NOT NULL
    );
    CREATE INDEX blob_catalog_observed ON blob_catalog(observed_at);
  `)
  sql.exec(
    "INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (?, ?)",
    CURRENT_SCHEMA_VERSION,
    Date.now(),
  )
}

function assertCurrentSchema(sql: SqlStorage): void {
  for (const [table, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = new Set(
      sql
        .exec<{ name: string }>(`PRAGMA table_info(${table})`)
        .toArray()
        .map((column) => column.name),
    )
    for (const column of requiredColumns) {
      if (!columns.has(column)) {
        throw new Error(`Meridian database schema is missing ${table}.${column}`)
      }
    }
  }
}
