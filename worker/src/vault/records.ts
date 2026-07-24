import { assertIdentifier, verifyEd25519 } from "../encoding"
import { assert, HttpError } from "../errors"
import { CheckpointSchema, SnapshotSchema } from "../schemas"
import {
  activeDevice,
  authenticate,
  decode,
  json,
  MAX_ENVELOPE_BYTES,
  requestJson,
  validateOpaqueData,
  validateSignature,
} from "./domain"
import { hashAtCursor } from "./operations"
import { checkpointSigningMessage, snapshotSigningMessage } from "./signing"

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

    const existing = this.sql
      .exec<{ device_id: string; cursor: number; log_hash: string }>(
        "SELECT device_id, cursor, log_hash FROM checkpoints WHERE checkpoint_id = ?",
        checkpoint.checkpointId,
      )
      .toArray()[0]
    if (existing) {
      assert(
        existing.device_id === session.deviceId &&
          existing.cursor === checkpoint.cursor &&
          existing.log_hash === checkpoint.logHash,
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

    const existing = this.sql
      .exec<{ author_device_id: string; cursor: number; log_hash: string }>(
        "SELECT author_device_id, cursor, log_hash FROM snapshots WHERE snapshot_id = ?",
        snapshot.snapshotId,
      )
      .toArray()[0]
    if (existing) {
      assert(
        existing.author_device_id === session.deviceId &&
          existing.cursor === snapshot.cursor &&
          existing.log_hash === snapshot.logHash,
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
