import { logChainSigningBytes } from "@meridian/protocol"
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
  ) {}

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
    validateOpaqueData(operation.envelope, MAX_ENVELOPE_BYTES, "envelope")
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
      const previousHashBytes = base64UrlDecode(state.head_hash, 32)
      const chainHash = base64UrlEncode(
        await sha256(
          concatBytes(
            logChainSigningBytes(
              previousHashBytes,
              operationSigningMessage(operation),
              base64UrlDecode(operation.signature, 64),
            ),
          ),
        ),
      )
      const cursor = state.cursor + 1
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
            freshState.head_hash !== state.head_hash
          ) {
            throw new RetryAppend()
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
            "UPDATE vault_state SET cursor = ?, head_hash = ? WHERE singleton = 1",
            cursor,
            chainHash,
          )

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
