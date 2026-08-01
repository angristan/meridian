import type { TransactionSync } from "./domain"

export function migrateVaultSchema(sql: SqlStorage, transactionSync: TransactionSync): void {
  const hasLegacyVaultState =
    sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vault_state'",
      )
      .toArray().length > 0

  sql.exec(`
    CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
      id INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)
  const row = sql
    .exec<{ version: number }>("SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations")
    .one()
  let version = row.version

  if (version < 1) {
    // Pre-migration builds created the same v1 tables without a migrations ledger. Adopt them
    // instead of attempting to recreate populated tables when upgrading an existing deployment.
    if (hasLegacyVaultState) {
      sql.exec("INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (1, ?)", Date.now())
    } else {
      transactionSync(() => {
        sql.exec(`
      CREATE TABLE vault_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        vault_id TEXT NOT NULL UNIQUE,
        claimed_at INTEGER NOT NULL,
        recovery_signing_public_key TEXT NOT NULL,
        recovery_package TEXT NOT NULL,
        cursor INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
        head_hash TEXT NOT NULL
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
        revoked_operation_id TEXT UNIQUE
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
        status TEXT NOT NULL CHECK (status IN ('pending', 'joined', 'approved')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        candidate_device_id TEXT,
        candidate_signing_public_key TEXT,
        candidate_hpke_public_key TEXT,
        candidate_proof TEXT,
        certificate TEXT,
        transcript_hash TEXT,
        approval_signature TEXT,
        hpke_transfer TEXT,
        approved_at INTEGER,
        result_consumed_at INTEGER
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
    `)
        sql.exec("INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (1, ?)", Date.now())
      })
    }
    version = 1
  }

  if (version < 2) {
    transactionSync(() => {
      const pairingsDefinition =
        sql
          .exec<{ sql: string | null }>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pairings'",
          )
          .one().sql ?? ""
      if (!pairingsDefinition.includes("candidate_request_proof")) {
        sql.exec("ALTER TABLE pairings ADD COLUMN candidate_request_proof TEXT")
      }
      sql.exec("INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (2, ?)", Date.now())
    })
    version = 2
  }

  if (version < 3) {
    transactionSync(() => {
      const devicesDefinition =
        sql
          .exec<{ sql: string | null }>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'devices'",
          )
          .one().sql ?? ""
      if (!devicesDefinition.includes("device_name")) {
        sql.exec("ALTER TABLE devices ADD COLUMN device_name TEXT")
      }
      if (!devicesDefinition.includes("platform")) {
        sql.exec("ALTER TABLE devices ADD COLUMN platform TEXT")
      }
      const pairingsDefinition =
        sql
          .exec<{ sql: string | null }>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pairings'",
          )
          .one().sql ?? ""
      if (pairingsDefinition.includes("verification_started_at")) {
        sql.exec("INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (3, ?)", Date.now())
        return
      }

      sql.exec(`
        CREATE TABLE pairings_v3 (
          pairing_id TEXT PRIMARY KEY,
          capability_hash TEXT NOT NULL UNIQUE,
          initiator_device_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN (
              'pending', 'joined', 'verifying', 'confirmed', 'released', 'completed', 'canceled'
            )
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
        INSERT INTO pairings_v3 (
          pairing_id, capability_hash, initiator_device_id, status, created_at, expires_at,
          candidate_device_id, candidate_signing_public_key, candidate_hpke_public_key,
          candidate_proof, candidate_request_proof, certificate, transcript_hash,
          approval_signature, hpke_transfer, verification_started_at, initiator_confirmed_at,
          candidate_confirmed_at, completed_at
        )
        SELECT pairing_id, capability_hash, initiator_device_id,
          CASE status WHEN 'approved' THEN 'completed' ELSE status END,
          created_at, expires_at, candidate_device_id, candidate_signing_public_key,
          candidate_hpke_public_key, candidate_proof, candidate_request_proof, certificate,
          transcript_hash, approval_signature, hpke_transfer, approved_at,
          CASE WHEN status = 'approved' THEN approved_at END,
          CASE WHEN status = 'approved' THEN approved_at END,
          CASE WHEN status = 'approved' THEN approved_at END
        FROM pairings;
        DROP TABLE pairings;
        ALTER TABLE pairings_v3 RENAME TO pairings;
        CREATE INDEX pairings_expiry ON pairings(expires_at);
      `)
      sql.exec("INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (3, ?)", Date.now())
    })
    version = 3
  }

  if (version < 4) {
    transactionSync(() => {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS blob_claims (
          blob_id TEXT PRIMARY KEY,
          claimed_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS blob_claims_age ON blob_claims(claimed_at);
      `)
      sql.exec("INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (4, ?)", Date.now())
    })
    version = 4
  }

  if (version < 5) {
    transactionSync(() => {
      const vaultDefinition =
        sql
          .exec<{ sql: string | null }>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vault_state'",
          )
          .one().sql ?? ""
      if (!vaultDefinition.includes("log_format")) {
        sql.exec(
          "ALTER TABLE vault_state ADD COLUMN log_format TEXT NOT NULL DEFAULT 'legacy-http-v1'",
        )
      }
      if (!vaultDefinition.includes("log_transition_cursor")) {
        sql.exec("ALTER TABLE vault_state ADD COLUMN log_transition_cursor INTEGER")
      }
      const sessionsDefinition =
        sql
          .exec<{ sql: string | null }>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
          )
          .one().sql ?? ""
      if (!sessionsDefinition.includes("supports_canonical_log")) {
        sql.exec(
          "ALTER TABLE sessions ADD COLUMN supports_canonical_log INTEGER NOT NULL DEFAULT 0",
        )
      }
      sql.exec("INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (5, ?)", Date.now())
    })
    version = 5
  }

  if (version < 6) {
    transactionSync(() => {
      const vaultDefinition =
        sql
          .exec<{ sql: string | null }>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vault_state'",
          )
          .one().sql ?? ""
      if (!vaultDefinition.includes("recovery_state_id")) {
        sql.exec("ALTER TABLE vault_state ADD COLUMN recovery_state_id TEXT")
      }
      sql.exec(`
        CREATE TABLE IF NOT EXISTS recovery_receipts (
          recovery_id TEXT PRIMARY KEY,
          request_hash TEXT NOT NULL,
          device_id TEXT NOT NULL,
          recovery_state_id TEXT NOT NULL,
          recovered_at INTEGER NOT NULL
        )
      `)
      sql.exec("INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (6, ?)", Date.now())
    })
    version = 6
  }

  if (version < 7) {
    transactionSync(() => {
      const devicesDefinition =
        sql
          .exec<{ sql: string | null }>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'devices'",
          )
          .one().sql ?? ""
      if (!devicesDefinition.includes("supports_canonical_log")) {
        sql.exec("ALTER TABLE devices ADD COLUMN supports_canonical_log INTEGER NOT NULL DEFAULT 0")
      }
      sql.exec("INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (7, ?)", Date.now())
    })
    version = 7
  }

  if (version < 8) {
    transactionSync(() => {
      const vaultDefinition =
        sql
          .exec<{ sql: string | null }>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vault_state'",
          )
          .one().sql ?? ""
      if (!vaultDefinition.includes("current_epoch_id")) {
        sql.exec("ALTER TABLE vault_state ADD COLUMN current_epoch_id TEXT")
      }
      if (!vaultDefinition.includes("epoch_sequence")) {
        sql.exec("ALTER TABLE vault_state ADD COLUMN epoch_sequence INTEGER")
      }
      if (!vaultDefinition.includes("epoch_transition_cursor")) {
        sql.exec("ALTER TABLE vault_state ADD COLUMN epoch_transition_cursor INTEGER")
      }
      const devicesDefinition =
        sql
          .exec<{ sql: string | null }>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'devices'",
          )
          .one().sql ?? ""
      if (!devicesDefinition.includes("supports_epoch_transitions")) {
        sql.exec(
          "ALTER TABLE devices ADD COLUMN supports_epoch_transitions INTEGER NOT NULL DEFAULT 0",
        )
      }
      const sessionsDefinition =
        sql
          .exec<{ sql: string | null }>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
          )
          .one().sql ?? ""
      if (!sessionsDefinition.includes("supports_epoch_transitions")) {
        sql.exec(
          "ALTER TABLE sessions ADD COLUMN supports_epoch_transitions INTEGER NOT NULL DEFAULT 0",
        )
      }
      sql.exec("INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (8, ?)", Date.now())
    })
    version = 8
  }

  if (version < 9) {
    transactionSync(() => {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS retention_acknowledgements (
          device_id TEXT PRIMARY KEY,
          cursor INTEGER NOT NULL CHECK (cursor >= 0),
          log_hash TEXT NOT NULL,
          epoch_id TEXT NOT NULL,
          history_retention TEXT NOT NULL CHECK (history_retention = 'forever'),
          signature TEXT NOT NULL,
          acknowledged_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS retention_acknowledgements_cursor
          ON retention_acknowledgements(cursor);
      `)
      sql.exec("INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (9, ?)", Date.now())
    })
  }
}
