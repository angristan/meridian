import { assertIdentifier, verifyEd25519 } from "../encoding"
import { assert, HttpError } from "../errors"
import { CheckpointSchema, RetentionAcknowledgementSchema, SnapshotSchema } from "../schemas"
import {
  activeDevice,
  authenticate,
  decode,
  json,
  MAX_ENVELOPE_BYTES,
  requestJson,
  validateOpaqueData,
  validateSignature,
  vaultState,
} from "./domain"
import { hashAtCursor } from "./operations"
import {
  checkpointSigningMessage,
  retentionAcknowledgementSigningMessage,
  snapshotSigningMessage,
} from "./signing"

export class VaultRecords {
  constructor(private readonly sql: SqlStorage) {}

  async putCheckpoint(request: Request): Promise<Response> {
    const session = await authenticate(this.sql, request)
    const checkpoint = decode(CheckpointSchema, await requestJson(request))
    assertIdentifier(checkpoint.checkpointId, "checkpointId")
    assertIdentifier(checkpoint.epochId, "epochId")
    assert(
      Number.isSafeInteger(checkpoint.cursor) && checkpoint.cursor >= 0,
      new HttpError(400, "invalid_cursor", "Checkpoint cursor is invalid"),
    )
    validateOpaqueData(checkpoint.envelope, MAX_ENVELOPE_BYTES, "envelope")
    validateSignature(checkpoint.signature)
    assert(
      hashAtCursor(this.sql, checkpoint.cursor) === checkpoint.logHash,
      new HttpError(409, "log_mismatch", "Checkpoint does not match the authoritative log"),
    )
    const device = activeDevice(this.sql, session.deviceId)
    assert(device, new HttpError(401, "device_revoked", "Device is no longer active"))
    const valid = await verifyEd25519(
      device.signing_public_key,
      checkpoint.signature,
      checkpointSigningMessage(checkpoint),
    )
    assert(valid, new HttpError(401, "invalid_signature", "Checkpoint signature is invalid"))
    assert(
      activeDevice(this.sql, session.deviceId),
      new HttpError(401, "device_revoked", "Device is no longer active"),
    )

    const existing = this.sql
      .exec<{
        device_id: string
        cursor: number
        log_hash: string
        epoch_id: string
        envelope: string
        signature: string
      }>(
        `SELECT device_id, cursor, log_hash, epoch_id, envelope, signature
         FROM checkpoints WHERE checkpoint_id = ?`,
        checkpoint.checkpointId,
      )
      .toArray()[0]
    if (existing) {
      assert(
        existing.device_id === session.deviceId &&
          existing.cursor === checkpoint.cursor &&
          existing.log_hash === checkpoint.logHash &&
          existing.epoch_id === checkpoint.epochId &&
          existing.envelope === checkpoint.envelope &&
          existing.signature === checkpoint.signature,
        new HttpError(409, "idempotency_conflict", "Checkpoint ID was used with different content"),
      )
      return json({ checkpointId: checkpoint.checkpointId, duplicate: true })
    }
    this.sql.exec(
      `INSERT INTO checkpoints(checkpoint_id, device_id, cursor, log_hash, epoch_id, envelope, signature, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      checkpoint.checkpointId,
      session.deviceId,
      checkpoint.cursor,
      checkpoint.logHash,
      checkpoint.epochId,
      checkpoint.envelope,
      checkpoint.signature,
      Date.now(),
    )
    return json({ checkpointId: checkpoint.checkpointId, duplicate: false }, { status: 201 })
  }

  async latestCheckpoint(request: Request): Promise<Response> {
    await authenticate(this.sql, request)
    const checkpoint = this.sql
      .exec<Record<string, string | number>>(
        "SELECT * FROM checkpoints ORDER BY cursor DESC, created_at DESC LIMIT 1",
      )
      .toArray()[0]
    return checkpoint ? json({ checkpoint }) : json({ checkpoint: null })
  }

  async acknowledgeRetention(request: Request): Promise<Response> {
    const session = await authenticate(this.sql, request)
    const acknowledgement = decode(RetentionAcknowledgementSchema, await requestJson(request))
    assertIdentifier(acknowledgement.deviceId, "deviceId")
    assertIdentifier(acknowledgement.epochId, "epochId")
    assert(
      Number.isSafeInteger(acknowledgement.cursor) && acknowledgement.cursor >= 0,
      new HttpError(400, "invalid_cursor", "Acknowledgement cursor is invalid"),
    )
    validateSignature(acknowledgement.signature)
    assert(
      acknowledgement.deviceId === session.deviceId,
      new HttpError(403, "device_mismatch", "Acknowledgement device does not match the session"),
    )
    const state = vaultState(this.sql)
    assert(state, new HttpError(409, "not_claimed", "This deployment has not been claimed"))
    assert(
      acknowledgement.cursor <= state.cursor &&
        hashAtCursor(this.sql, acknowledgement.cursor) === acknowledgement.logHash,
      new HttpError(409, "log_mismatch", "Acknowledgement does not match the authoritative log"),
    )
    assert(
      state.current_epoch_id === null || acknowledgement.epochId === state.current_epoch_id,
      new HttpError(409, "stale_epoch", "Acknowledgement uses a stale vault epoch"),
    )
    const device = activeDevice(this.sql, session.deviceId)
    assert(device, new HttpError(401, "device_revoked", "Device is no longer active"))
    const valid = await verifyEd25519(
      device.signing_public_key,
      acknowledgement.signature,
      retentionAcknowledgementSigningMessage(session.vaultId, acknowledgement),
    )
    assert(valid, new HttpError(401, "invalid_signature", "Acknowledgement signature is invalid"))
    assert(
      activeDevice(this.sql, session.deviceId),
      new HttpError(401, "device_revoked", "Device is no longer active"),
    )

    const existing = this.sql
      .exec<{
        cursor: number
        log_hash: string
        epoch_id: string
        history_retention: "forever"
        signature: string
      }>("SELECT * FROM retention_acknowledgements WHERE device_id = ?", session.deviceId)
      .toArray()[0]
    if (existing && existing.cursor >= acknowledgement.cursor) {
      assert(
        existing.cursor === acknowledgement.cursor &&
          existing.log_hash === acknowledgement.logHash &&
          existing.epoch_id === acknowledgement.epochId &&
          existing.history_retention === acknowledgement.historyRetention &&
          existing.signature === acknowledgement.signature,
        new HttpError(
          409,
          "acknowledgement_rollback",
          "Retention acknowledgement cannot move backward or fork",
        ),
      )
      return json({ acknowledged: true, duplicate: true, cursor: existing.cursor })
    }
    this.sql.exec(
      `INSERT INTO retention_acknowledgements(
         device_id, cursor, log_hash, epoch_id, history_retention, signature, acknowledged_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         cursor = excluded.cursor,
         log_hash = excluded.log_hash,
         epoch_id = excluded.epoch_id,
         history_retention = excluded.history_retention,
         signature = excluded.signature,
         acknowledged_at = excluded.acknowledged_at`,
      session.deviceId,
      acknowledgement.cursor,
      acknowledgement.logHash,
      acknowledgement.epochId,
      acknowledgement.historyRetention,
      acknowledgement.signature,
      Date.now(),
    )
    return json({ acknowledged: true, duplicate: false, cursor: acknowledgement.cursor })
  }

  async putSnapshot(request: Request): Promise<Response> {
    const session = await authenticate(this.sql, request)
    const snapshot = decode(SnapshotSchema, await requestJson(request))
    assertIdentifier(snapshot.snapshotId, "snapshotId")
    assertIdentifier(snapshot.epochId, "epochId")
    assert(
      Number.isSafeInteger(snapshot.cursor) && snapshot.cursor >= 0,
      new HttpError(400, "invalid_cursor", "Snapshot cursor is invalid"),
    )
    validateOpaqueData(snapshot.envelope, MAX_ENVELOPE_BYTES, "envelope")
    validateSignature(snapshot.signature)
    assert(
      hashAtCursor(this.sql, snapshot.cursor) === snapshot.logHash,
      new HttpError(409, "log_mismatch", "Snapshot does not match the authoritative log"),
    )
    const device = activeDevice(this.sql, session.deviceId)
    assert(device, new HttpError(401, "device_revoked", "Device is no longer active"))
    const valid = await verifyEd25519(
      device.signing_public_key,
      snapshot.signature,
      snapshotSigningMessage(snapshot),
    )
    assert(valid, new HttpError(401, "invalid_signature", "Snapshot signature is invalid"))
    assert(
      activeDevice(this.sql, session.deviceId),
      new HttpError(401, "device_revoked", "Device is no longer active"),
    )

    const existing = this.sql
      .exec<{
        author_device_id: string
        cursor: number
        log_hash: string
        epoch_id: string
        envelope: string
        signature: string
      }>(
        `SELECT author_device_id, cursor, log_hash, epoch_id, envelope, signature
         FROM snapshots WHERE snapshot_id = ?`,
        snapshot.snapshotId,
      )
      .toArray()[0]
    if (existing) {
      assert(
        existing.author_device_id === session.deviceId &&
          existing.cursor === snapshot.cursor &&
          existing.log_hash === snapshot.logHash &&
          existing.epoch_id === snapshot.epochId &&
          existing.envelope === snapshot.envelope &&
          existing.signature === snapshot.signature,
        new HttpError(409, "idempotency_conflict", "Snapshot ID was used with different content"),
      )
      return json({ snapshotId: snapshot.snapshotId, duplicate: true })
    }
    this.sql.exec(
      `INSERT INTO snapshots(snapshot_id, author_device_id, cursor, log_hash, epoch_id, envelope, signature, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      snapshot.snapshotId,
      session.deviceId,
      snapshot.cursor,
      snapshot.logHash,
      snapshot.epochId,
      snapshot.envelope,
      snapshot.signature,
      Date.now(),
    )
    return json({ snapshotId: snapshot.snapshotId, duplicate: false }, { status: 201 })
  }

  async getSnapshot(request: Request): Promise<Response> {
    await authenticate(this.sql, request)
    const requestedId = new URL(request.url).searchParams.get("id")
    if (requestedId !== null) assertIdentifier(requestedId, "snapshotId")
    const snapshot = requestedId
      ? this.sql
          .exec<Record<string, string | number>>(
            "SELECT * FROM snapshots WHERE snapshot_id = ?",
            requestedId,
          )
          .toArray()[0]
      : this.sql
          .exec<Record<string, string | number>>(
            "SELECT * FROM snapshots ORDER BY cursor DESC, created_at DESC LIMIT 1",
          )
          .toArray()[0]
    if (requestedId && !snapshot)
      throw new HttpError(404, "snapshot_not_found", "Snapshot was not found")
    return json({ snapshot: snapshot ?? null })
  }
}
