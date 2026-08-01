import {
  computeRecoveryStateId,
  deserializeEncryptedRecoveryPackage,
  verifyCheckpoint,
} from "@meridian/crypto"
import {
  bytesEqual,
  decodeDeviceCertificate,
  decodeOperation,
  epochSigningBytes,
  hashBytes,
  LogFormat,
  logChainSigningBytes,
  logEntryHashInput,
  operationSigningBytes,
  Permission,
  type SignedOperation,
  vaultId,
} from "@meridian/protocol"
import {
  assertIdentifier,
  base64UrlDecode,
  base64UrlEncode,
  concatBytes,
  sha256,
  verifyEd25519,
  ZERO_HASH,
} from "../encoding"
import { assert, HttpError } from "../errors"
import { type Operation, OperationSchema, RevokeDeviceSchema } from "../schemas"
import {
  activeDevice,
  authenticate,
  decode,
  json,
  MAX_CHANGE_PAGE_SIZE,
  MAX_ENVELOPE_BYTES,
  MAX_EPOCH_ENVELOPE_BYTES,
  MAX_RECOVERY_PACKAGE_BYTES,
  type OperationRow,
  requestJson,
  type SessionContext,
  type TransactionSync,
  validateOpaqueData,
  validateSignature,
  vaultState,
} from "./domain"
import { operationSigningMessage } from "./signing"

type AppendResult = { operation: OperationRow; inserted: boolean }
type RevisionEnvelopeRow = Pick<OperationRow, "cursor" | "envelope">

const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1_000
const PRUNE_PAGE_SIZE = 1_000

class RetryAppend extends Error {}

function serializeOperation(row: OperationRow): Record<string, unknown> {
  return {
    cursor: row.cursor,
    operationId: row.operation_id,
    authorDeviceId: row.author_device_id,
    epochId: row.epoch_id,
    type: row.operation_type,
    ...(row.subject_device_id === null ? {} : { subjectDeviceId: row.subject_device_id }),
    envelope: row.envelope,
    signature: row.signature,
    previousHash: row.previous_hash,
    chainHash: row.chain_hash,
    committedAt: row.created_at,
  }
}

export function hashAtCursor(sql: SqlStorage, cursor: number): string | undefined {
  if (cursor === 0) return ZERO_HASH
  return sql
    .exec<{ chain_hash: string }>("SELECT chain_hash FROM operations WHERE cursor = ?", cursor)
    .toArray()[0]?.chain_hash
}

export class VaultOperations {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transactionSync: TransactionSync,
    private readonly notifyCursor: (cursor: number, authorDeviceId: string) => void,
    private readonly closeRevokedDevice: (deviceId: string) => void,
    private readonly blobs: R2Bucket,
  ) {}

  private async canonicalOperation(
    operation: Operation,
    vault: string,
    signingPublicKey: string,
  ): Promise<SignedOperation> {
    let signed: SignedOperation
    try {
      signed = decodeOperation(
        base64UrlDecode(
          operation.envelope,
          operation.type === "key-epoch" ? MAX_EPOCH_ENVELOPE_BYTES : MAX_ENVELOPE_BYTES,
        ),
      )
    } catch {
      throw new HttpError(
        400,
        "invalid_operation_envelope",
        "Operation envelope is not canonical generation-1 data",
      )
    }
    const body = signed.body
    const expectedBodyType =
      operation.type === "device-revocation"
        ? "device-revocation"
        : operation.type === "key-epoch"
          ? "epoch-transition"
          : operation.type === "log-format-transition"
            ? "log-format-transition"
            : "revision"
    assert(
      body.type === expectedBodyType &&
        base64UrlEncode(body.operationId) === operation.operationId &&
        base64UrlEncode(body.vaultId) === vault &&
        base64UrlEncode(body.epochId) === operation.epochId &&
        body.authorDeviceId !== "recovery" &&
        base64UrlEncode(body.authorDeviceId) === operation.authorDeviceId,
      new HttpError(
        400,
        "operation_envelope_mismatch",
        "Operation wrapper does not match its canonical signed envelope",
      ),
    )
    assert(
      await verifyEd25519(
        signingPublicKey,
        base64UrlEncode(signed.signature),
        operationSigningBytes(body),
      ),
      new HttpError(401, "invalid_signature", "Canonical operation signature is invalid"),
    )
    return signed
  }

  private async operationRequestHash(operation: Operation): Promise<string> {
    return base64UrlEncode(
      await sha256(
        concatBytes(operationSigningMessage(operation), base64UrlDecode(operation.signature, 64)),
      ),
    )
  }

  private async appendOperation(
    operation: Operation,
    session: SessionContext,
  ): Promise<AppendResult> {
    assertIdentifier(operation.operationId, "operationId")
    assertIdentifier(operation.authorDeviceId, "authorDeviceId")
    assertIdentifier(operation.epochId, "epochId")
    if (operation.subjectDeviceId !== undefined)
      assertIdentifier(operation.subjectDeviceId, "subjectDeviceId")
    validateOpaqueData(
      operation.envelope,
      operation.type === "key-epoch" ? MAX_EPOCH_ENVELOPE_BYTES : MAX_ENVELOPE_BYTES,
      "envelope",
    )
    validateSignature(operation.signature)
    assert(
      operation.authorDeviceId === session.deviceId,
      new HttpError(403, "author_mismatch", "Operation author does not match the session"),
    )
    assert(
      operation.type === "device-revocation"
        ? operation.subjectDeviceId !== undefined
        : operation.subjectDeviceId === undefined,
      new HttpError(
        400,
        "invalid_subject",
        "A subject device is allowed only on revocation operations",
      ),
    )
    if (operation.type === "key-epoch" || operation.type === "log-format-transition") {
      assert(
        session.role === "owner",
        new HttpError(403, "owner_required", "This operation requires an owner device"),
      )
    }
    if (operation.type === "device-revocation") {
      const selfRevocation = operation.subjectDeviceId === session.deviceId
      assert(
        session.role === "owner" || selfRevocation,
        new HttpError(403, "owner_required", "A member device can revoke only its own identity"),
      )
      assert(
        !(session.role === "owner" && selfRevocation),
        new HttpError(
          409,
          "cannot_revoke_owner",
          "The owner device cannot remove itself; use recovery after owner loss",
        ),
      )
    }

    const author = activeDevice(this.sql, session.deviceId)
    assert(author, new HttpError(401, "device_revoked", "Author device is no longer active"))
    const signatureValid = await verifyEd25519(
      author.signing_public_key,
      operation.signature,
      operationSigningMessage(operation),
    )
    assert(
      signatureValid,
      new HttpError(401, "invalid_signature", "Operation signature is invalid"),
    )
    const signedOperation = await this.canonicalOperation(
      operation,
      session.vaultId,
      author.signing_public_key,
    )
    const epochTransition =
      signedOperation.body.type === "epoch-transition" ? signedOperation.body : null
    let nextRecoveryStateId: string | null = null
    if (epochTransition) {
      let certificate: ReturnType<typeof decodeDeviceCertificate>
      try {
        certificate = decodeDeviceCertificate(base64UrlDecode(author.certificate))
      } catch {
        throw new HttpError(
          409,
          "invalid_device_certificate",
          "Stored owner certificate is invalid",
        )
      }
      assert(
        certificate.body.permissions.includes(Permission.RotateEpoch) &&
          bytesEqual(certificate.body.deviceId, epochTransition.authorDeviceId) &&
          (await verifyEd25519(
            author.signing_public_key,
            base64UrlEncode(epochTransition.declaration.signature),
            epochSigningBytes(epochTransition.declaration.body),
          )),
        new HttpError(403, "epoch_rotation_forbidden", "Epoch rotation authorization is invalid"),
      )
      let recoveryPackage: ReturnType<typeof deserializeEncryptedRecoveryPackage>
      try {
        recoveryPackage = deserializeEncryptedRecoveryPackage(
          epochTransition.encryptedRecoveryPackage,
        )
      } catch {
        throw new HttpError(
          400,
          "invalid_recovery_package",
          "Epoch transition recovery package is invalid",
        )
      }
      assert(
        recoveryPackage.packageVersion === 2 &&
          base64UrlEncode(recoveryPackage.vaultId) === session.vaultId &&
          recoveryPackage.checkpoint.body.cursor === epochTransition.previousCursor &&
          base64UrlEncode(recoveryPackage.checkpoint.body.logHash) ===
            base64UrlEncode(epochTransition.previousLogHash) &&
          base64UrlEncode(recoveryPackage.checkpoint.body.epochId) === operation.epochId &&
          verifyCheckpoint(recoveryPackage.checkpoint, certificate),
        new HttpError(
          400,
          "invalid_recovery_package",
          "Recovery package does not match the epoch predecessor",
        ),
      )
      nextRecoveryStateId = base64UrlEncode(
        await computeRecoveryStateId(
          vaultId(base64UrlDecode(session.vaultId, 16)),
          epochTransition.encryptedRecoveryPackage,
        ),
      )
      const state = vaultState(this.sql)
      assert(state, new HttpError(409, "not_claimed", "This deployment has not been claimed"))
      if (state.recovery_state_id === null) {
        const currentRecoveryStateId = base64UrlEncode(
          await computeRecoveryStateId(
            vaultId(base64UrlDecode(state.vault_id, 16)),
            base64UrlDecode(state.recovery_package, MAX_RECOVERY_PACKAGE_BYTES),
          ),
        )
        this.sql.exec(
          `UPDATE vault_state SET recovery_state_id = ?
           WHERE singleton = 1 AND recovery_state_id IS NULL`,
          currentRecoveryStateId,
        )
      }
    }
    const requestHash = await this.operationRequestHash(operation)

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const duplicate = this.sql
        .exec<OperationRow>(
          "SELECT * FROM operations WHERE operation_id = ?",
          operation.operationId,
        )
        .toArray()[0]
      if (duplicate) {
        assert(
          duplicate.request_hash === requestHash,
          new HttpError(
            409,
            "idempotency_conflict",
            "Operation ID was used with different content",
          ),
        )
        return { operation: duplicate, inserted: false }
      }

      const state = vaultState(this.sql)
      assert(state, new HttpError(409, "not_claimed", "This deployment has not been claimed"))
      assert(
        state.log_format === LogFormat.LegacyHttpV1 ||
          state.log_format === LogFormat.CanonicalCborV1,
        new HttpError(500, "invalid_log_format", "Stored log format is invalid"),
      )
      const transition =
        signedOperation.body.type === "log-format-transition" ? signedOperation.body : null
      if (transition) {
        assert(
          state.log_format === LogFormat.LegacyHttpV1 &&
            transition.previousCursor === state.cursor &&
            base64UrlEncode(transition.previousLogHash) === state.head_hash,
          new HttpError(
            409,
            "log_transition_conflict",
            "Log transition does not match the current legacy head",
          ),
        )
      }
      if (epochTransition) {
        const currentEpochId = state.current_epoch_id ?? operation.epochId
        const previousEpochId = epochTransition.declaration.body.previousEpochId
        assert(
          previousEpochId !== null &&
            state.log_format === LogFormat.CanonicalCborV1 &&
            operation.epochId === currentEpochId &&
            epochTransition.previousCursor === state.cursor &&
            base64UrlEncode(epochTransition.previousLogHash) === state.head_hash &&
            base64UrlEncode(previousEpochId) === currentEpochId &&
            state.recovery_state_id === base64UrlEncode(epochTransition.previousRecoveryStateId) &&
            (state.epoch_sequence === null ||
              epochTransition.declaration.body.sequence === state.epoch_sequence + 1),
          new HttpError(
            409,
            "epoch_transition_conflict",
            "Epoch transition does not match current vault security state",
          ),
        )
        assert(
          unsupportedEpochDeviceIds(this.sql).length === 0 &&
            sameDeviceSet(
              epochTransition.keyPackages.map((entry) => base64UrlEncode(entry.recipientDeviceId)),
              activeDeviceIds(this.sql),
            ),
          new HttpError(
            409,
            "epoch_recipient_conflict",
            "Epoch transition recipients do not match active devices",
          ),
        )
      } else if (state.current_epoch_id !== null) {
        assert(
          operation.epochId === state.current_epoch_id,
          new HttpError(409, "stale_epoch", "Operation uses a stale vault epoch"),
        )
      }
      const previousHashBytes = base64UrlDecode(state.head_hash, 32)
      const cursor = state.cursor + 1
      const hashInput =
        state.log_format === LogFormat.CanonicalCborV1
          ? logEntryHashInput(
              vaultId(base64UrlDecode(state.vault_id, 16)),
              cursor,
              hashBytes(previousHashBytes),
              signedOperation,
            )
          : logChainSigningBytes(
              previousHashBytes,
              operationSigningMessage(operation),
              base64UrlDecode(operation.signature, 64),
            )
      const chainHash = base64UrlEncode(await sha256(hashInput))
      const nextLogFormat = transition?.nextLogFormat ?? state.log_format
      const transitionCursor = transition ? cursor : state.log_transition_cursor
      const createdAt = Date.now()

      try {
        return this.transactionSync(() => {
          assert(
            activeDevice(this.sql, session.deviceId),
            new HttpError(401, "device_revoked", "Author device is no longer active"),
          )
          const concurrentDuplicate = this.sql
            .exec<OperationRow>(
              "SELECT * FROM operations WHERE operation_id = ?",
              operation.operationId,
            )
            .toArray()[0]
          if (concurrentDuplicate) {
            assert(
              concurrentDuplicate.request_hash === requestHash,
              new HttpError(
                409,
                "idempotency_conflict",
                "Operation ID was used with different content",
              ),
            )
            return { operation: concurrentDuplicate, inserted: false }
          }
          const freshState = vaultState(this.sql)
          if (
            !freshState ||
            freshState.cursor !== state.cursor ||
            freshState.head_hash !== state.head_hash ||
            freshState.log_format !== state.log_format ||
            freshState.current_epoch_id !== state.current_epoch_id ||
            freshState.epoch_sequence !== state.epoch_sequence ||
            freshState.recovery_state_id !== state.recovery_state_id
          ) {
            throw new RetryAppend()
          }

          if (epochTransition) {
            assert(
              unsupportedEpochDeviceIds(this.sql).length === 0 &&
                sameDeviceSet(
                  epochTransition.keyPackages.map((entry) =>
                    base64UrlEncode(entry.recipientDeviceId),
                  ),
                  activeDeviceIds(this.sql),
                ) &&
                freshState.recovery_state_id ===
                  base64UrlEncode(epochTransition.previousRecoveryStateId),
              new HttpError(
                409,
                "epoch_transition_conflict",
                "Active devices or recovery state changed during epoch rotation",
              ),
            )
          }

          this.sql.exec(
            `INSERT INTO operations(
              cursor, operation_id, author_device_id, epoch_id, operation_type, subject_device_id,
              envelope, signature, request_hash, previous_hash, chain_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            cursor,
            operation.operationId,
            operation.authorDeviceId,
            operation.epochId,
            operation.type,
            operation.subjectDeviceId ?? null,
            operation.envelope,
            operation.signature,
            requestHash,
            state.head_hash,
            chainHash,
            createdAt,
          )
          this.sql.exec(
            `UPDATE vault_state
             SET cursor = ?, head_hash = ?, log_format = ?, log_transition_cursor = ?,
                 current_epoch_id = ?, epoch_sequence = ?, epoch_transition_cursor = ?,
                 recovery_package = ?, recovery_state_id = ?
             WHERE singleton = 1`,
            cursor,
            chainHash,
            nextLogFormat,
            transitionCursor,
            epochTransition
              ? base64UrlEncode(epochTransition.declaration.body.epochId)
              : (state.current_epoch_id ?? operation.epochId),
            epochTransition ? epochTransition.declaration.body.sequence : state.epoch_sequence,
            epochTransition ? cursor : state.epoch_transition_cursor,
            epochTransition
              ? base64UrlEncode(epochTransition.encryptedRecoveryPackage)
              : state.recovery_package,
            epochTransition ? nextRecoveryStateId : state.recovery_state_id,
          )
          if (epochTransition) {
            this.sql.exec("DELETE FROM pairings WHERE status NOT IN ('completed', 'canceled')")
          }

          if (operation.type === "device-revocation") {
            const target = activeDevice(this.sql, operation.subjectDeviceId as string)
            assert(
              target,
              new HttpError(404, "device_not_found", "Revocation target is not active"),
            )
            assert(
              target.device_id !== session.deviceId || session.role === "member",
              new HttpError(
                409,
                "cannot_revoke_owner",
                "The owner device cannot remove itself; use recovery after owner loss",
              ),
            )
            this.sql.exec(
              "UPDATE devices SET revoked_at = ?, revoked_operation_id = ? WHERE device_id = ? AND revoked_at IS NULL",
              createdAt,
              operation.operationId,
              target.device_id,
            )
            this.sql.exec("DELETE FROM sessions WHERE device_id = ?", target.device_id)
          }

          const row = this.sql
            .exec<OperationRow>("SELECT * FROM operations WHERE cursor = ?", cursor)
            .one()
          return { operation: row, inserted: true }
        })
      } catch (error) {
        if (error instanceof RetryAppend) continue
        throw error
      }
    }
    throw new HttpError(503, "append_contended", "Operation append was contended; retry safely")
  }

  async commitOperation(request: Request): Promise<Response> {
    const session = await authenticate(this.sql, request)
    const operation = decode(OperationSchema, await requestJson(request))
    const result = await this.appendOperation(operation, session)
    if (result.inserted) this.notifyCursor(result.operation.cursor, session.deviceId)
    if (operation.type === "device-revocation" && operation.subjectDeviceId) {
      this.closeRevokedDevice(operation.subjectDeviceId)
    }
    return json(
      {
        cursor: result.operation.cursor,
        previousHash: result.operation.previous_hash,
        chainHash: result.operation.chain_hash,
        duplicate: !result.inserted,
      },
      { status: result.inserted ? 201 : 200 },
    )
  }

  async revokeDevice(request: Request, targetDeviceId: string): Promise<Response> {
    assertIdentifier(targetDeviceId, "deviceId")
    const session = await authenticate(this.sql, request)
    const input = decode(RevokeDeviceSchema, await requestJson(request))
    assert(
      input.operation.type === "device-revocation" &&
        input.operation.subjectDeviceId === targetDeviceId,
      new HttpError(
        400,
        "invalid_revocation",
        "Revocation operation type and subject must match the route",
      ),
    )
    const result = await this.appendOperation(input.operation, session)
    if (result.inserted) this.notifyCursor(result.operation.cursor, session.deviceId)
    this.closeRevokedDevice(targetDeviceId)
    return json(
      {
        cursor: result.operation.cursor,
        previousHash: result.operation.previous_hash,
        chainHash: result.operation.chain_hash,
        duplicate: !result.inserted,
      },
      { status: result.inserted ? 201 : 200 },
    )
  }

  async claimBlob(request: Request, blobId: string): Promise<Response> {
    assertIdentifier(blobId, "blobId")
    await authenticate(this.sql, request)
    this.sql.exec(
      `INSERT INTO blob_claims(blob_id, claimed_at) VALUES (?, ?)
       ON CONFLICT(blob_id) DO UPDATE SET claimed_at = excluded.claimed_at`,
      blobId,
      Date.now(),
    )
    return new Response(null, { status: 204 })
  }

  async pruneOrphanBlobs(request: Request): Promise<Response> {
    const session = await authenticate(this.sql, request)
    assert(
      session.role === "owner",
      new HttpError(403, "owner_required", "Only the owner device can prune storage"),
    )

    const referenced = this.referencedBlobIds()
    const cutoff = Date.now() - ORPHAN_GRACE_MS
    const prefix = `vaults/${session.vaultId}/blobs/`
    let cursor: string | undefined
    let deletedBytes = 0
    let deletedCount = 0

    do {
      const page = await this.blobs.list({
        prefix,
        ...(cursor ? { cursor } : {}),
        limit: PRUNE_PAGE_SIZE,
      })
      const candidates = page.objects.filter((object) => {
        const blobId = object.key.slice(prefix.length)
        if (!/^[A-Za-z0-9_-]{22}$/.test(blobId)) return false
        const claimedAt = this.sql
          .exec<{ claimed_at: number }>(
            "SELECT claimed_at FROM blob_claims WHERE blob_id = ?",
            blobId,
          )
          .toArray()[0]?.claimed_at
        return isSafeOrphanCandidate(
          object.uploaded.getTime(),
          claimedAt,
          cutoff,
          referenced.has(blobId),
        )
      })
      if (candidates.length > 0) {
        await this.blobs.delete(candidates.map((object) => object.key))
        deletedBytes += candidates.reduce((total, object) => total + object.size, 0)
        deletedCount += candidates.length
        for (const object of candidates) {
          this.sql.exec(
            "DELETE FROM blob_claims WHERE blob_id = ?",
            object.key.slice(prefix.length),
          )
        }
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor !== undefined)

    return json({ deletedBytes, deletedCount, graceDays: ORPHAN_GRACE_MS / 86_400_000 })
  }

  private referencedBlobIds(): Set<string> {
    const result = new Set<string>()
    let after = 0
    while (true) {
      const rows = this.sql
        .exec<RevisionEnvelopeRow>(
          `SELECT cursor, envelope FROM operations
           WHERE operation_type IN ('revision', 'merge', 'tombstone', 'restore')
             AND cursor > ? ORDER BY cursor LIMIT ?`,
          after,
          PRUNE_PAGE_SIZE,
        )
        .toArray()
      for (const row of rows) {
        let operation: ReturnType<typeof decodeOperation>
        try {
          operation = decodeOperation(base64UrlDecode(row.envelope))
        } catch {
          throw new HttpError(
            409,
            "pruning_unavailable",
            "Encrypted history could not be indexed safely; no blobs were deleted",
          )
        }
        assert(
          operation.body.type === "revision",
          new HttpError(
            409,
            "pruning_unavailable",
            "Encrypted history could not be indexed safely; no blobs were deleted",
          ),
        )
        for (const chunk of operation.body.chunks) result.add(base64UrlEncode(chunk.blobId))
      }
      if (rows.length < PRUNE_PAGE_SIZE) break
      after = rows.at(-1)?.cursor ?? after
    }
    return result
  }

  async storageStats(request: Request): Promise<Response> {
    const session = await authenticate(this.sql, request)
    const operationCount = this.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM operations")
      .one().count
    const checkpointCount = this.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM checkpoints")
      .one().count
    const snapshotCount = this.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM snapshots")
      .one().count
    return json({
      databaseBytes: this.sql.databaseSize,
      operationCount,
      checkpointCount,
      snapshotCount,
      canPrune: session.role === "owner",
    })
  }

  async changes(request: Request): Promise<Response> {
    await authenticate(this.sql, request)
    const url = new URL(request.url)
    const after = Number(url.searchParams.get("after") ?? "0")
    const limit = Number(url.searchParams.get("limit") ?? "200")
    assert(
      Number.isSafeInteger(after) && after >= 0,
      new HttpError(400, "invalid_cursor", "after must be a non-negative integer"),
    )
    assert(
      Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_CHANGE_PAGE_SIZE,
      new HttpError(400, "invalid_limit", "limit is outside the allowed range"),
    )
    const afterHash = url.searchParams.get("afterHash")
    if (afterHash !== null) {
      assert(
        base64UrlDecode(afterHash, 32).length === 32,
        new HttpError(400, "invalid_hash", "afterHash must be 32 bytes"),
      )
      assert(
        hashAtCursor(this.sql, after) === afterHash,
        new HttpError(409, "log_mismatch", "Cursor hash does not match the authoritative log"),
      )
    }
    const state = vaultState(this.sql)
    assert(state, new HttpError(409, "not_claimed", "This deployment has not been claimed"))
    assert(
      after <= state.cursor,
      new HttpError(409, "cursor_ahead", "Cursor is ahead of the authoritative log"),
    )
    const operations = this.sql
      .exec<OperationRow>(
        "SELECT * FROM operations WHERE cursor > ? ORDER BY cursor LIMIT ?",
        after,
        limit,
      )
      .toArray()
      .map(serializeOperation)
    return json({
      operations,
      latestCursor: state.cursor,
      latestHash: state.head_hash,
      hasMore: operations.length === limit,
    })
  }
}

function activeDeviceIds(sql: SqlStorage): string[] {
  return sql
    .exec<{ device_id: string }>(
      "SELECT device_id FROM devices WHERE revoked_at IS NULL ORDER BY device_id",
    )
    .toArray()
    .map((row) => row.device_id)
}

function unsupportedEpochDeviceIds(sql: SqlStorage): string[] {
  return sql
    .exec<{ device_id: string }>(
      `SELECT device_id FROM devices
       WHERE revoked_at IS NULL AND supports_epoch_transitions = 0 ORDER BY device_id`,
    )
    .toArray()
    .map((row) => row.device_id)
}

function sameDeviceSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((value, index) => value === sortedRight[index])
}

export function isSafeOrphanCandidate(
  uploadedAt: number,
  claimedAt: number | undefined,
  cutoff: number,
  referenced: boolean,
): boolean {
  return !referenced && uploadedAt < cutoff && (claimedAt === undefined || claimedAt < cutoff)
}
