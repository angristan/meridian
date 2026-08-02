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
  logEntryHashInput,
  type Operation,
  OperationSchema,
  operationSigningBytes,
  Permission,
  RevokeDeviceSchema,
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
import type { VaultBlobs } from "./blobs"
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
    private readonly blobs: VaultBlobs,
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
    if (operation.type === "key-epoch") {
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
    const revisionChunks =
      signedOperation.body.type === "revision" ? signedOperation.body.chunks : []
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

      if (revisionChunks.length > 0) {
        await this.blobs.ensureStoredRevisionBlobs(
          session.vaultId,
          session.deviceId,
          revisionChunks,
        )
      }

      const state = vaultState(this.sql)
      assert(state, new HttpError(409, "not_claimed", "This deployment has not been claimed"))
      assert(
        state.log_format === "canonical-cbor-v1",
        new HttpError(
          409,
          "protocol_upgrade_required",
          "Vault writes require the current protocol",
        ),
      )
      if (epochTransition) {
        const currentEpochId = state.current_epoch_id ?? operation.epochId
        const previousEpochId = epochTransition.declaration.body.previousEpochId
        assert(
          previousEpochId !== null &&
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
      const hashInput = logEntryHashInput(
        vaultId(base64UrlDecode(state.vault_id, 16)),
        cursor,
        hashBytes(previousHashBytes),
        signedOperation,
      )
      const chainHash = base64UrlEncode(await sha256(hashInput))
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
            freshState.current_epoch_id !== state.current_epoch_id ||
            freshState.epoch_sequence !== state.epoch_sequence ||
            freshState.recovery_state_id !== state.recovery_state_id
          ) {
            throw new RetryAppend()
          }

          if (revisionChunks.length > 0) {
            this.blobs.assertRevisionBlobsCommitReady(revisionChunks)
          }

          if (epochTransition) {
            assert(
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
             SET cursor = ?, head_hash = ?, current_epoch_id = ?, epoch_sequence = ?,
                 epoch_transition_cursor = ?, recovery_package = ?, recovery_state_id = ?
             WHERE singleton = 1`,
            cursor,
            chainHash,
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
          if (revisionChunks.length > 0) {
            this.blobs.releaseRevisionBlobClaims(revisionChunks)
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

function sameDeviceSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((value, index) => value === sortedRight[index])
}
