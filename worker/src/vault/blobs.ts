import { decodeOperation } from "@meridian/protocol"
import { assertIdentifier, base64UrlDecode, base64UrlEncode } from "../encoding"
import { assert, HttpError } from "../errors"
import { authenticate, json, type OperationRow, vaultState } from "./domain"

type RevisionEnvelopeRow = Pick<OperationRow, "cursor" | "envelope">

const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1_000
const BLOB_RESERVATION_MS = 24 * 60 * 60 * 1_000
const PRUNE_PAGE_SIZE = 1_000

export class VaultBlobs {
  constructor(
    private readonly sql: SqlStorage,
    private readonly bucket: R2Bucket,
  ) {}

  async claimBlob(request: Request, blobId: string): Promise<Response> {
    assertIdentifier(blobId, "blobId")
    const session = await authenticate(this.sql, request)
    const expectedSize = Number(new URL(request.url).searchParams.get("size"))
    assert(
      Number.isSafeInteger(expectedSize) && expectedSize > 0,
      new HttpError(400, "invalid_length", "Blob reservation size is invalid"),
    )
    const key = `vaults/${session.vaultId}/blobs/${blobId}`
    const existingObject = await this.headBlob(key)
    if (existingObject) {
      assert(
        existingObject.size === expectedSize,
        new HttpError(409, "blob_size_conflict", "Blob ID already exists with another size"),
      )
      this.rememberStoredBlob(blobId, existingObject.size)
      this.sql.exec("DELETE FROM blob_claims WHERE blob_id = ?", blobId)
      return json({ exists: true })
    }

    const existingClaim = this.sql
      .exec<{ expected_size: number }>(
        "SELECT expected_size FROM blob_claims WHERE blob_id = ?",
        blobId,
      )
      .toArray()[0]
    assert(
      !existingClaim ||
        existingClaim.expected_size === 0 ||
        existingClaim.expected_size === expectedSize,
      new HttpError(409, "blob_size_conflict", "Blob reservation size changed"),
    )
    this.sql.exec(
      `INSERT INTO blob_claims(blob_id, claimed_at, expected_size, device_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(blob_id) DO UPDATE SET
         claimed_at = excluded.claimed_at,
         expected_size = excluded.expected_size,
         device_id = excluded.device_id`,
      blobId,
      Date.now(),
      expectedSize,
      session.deviceId,
    )
    return json({ exists: false })
  }

  async finalizeBlob(request: Request, blobId: string): Promise<Response> {
    assertIdentifier(blobId, "blobId")
    const session = await authenticate(this.sql, request)
    const expectedSize = Number(new URL(request.url).searchParams.get("size"))
    const claim = this.sql
      .exec<{ expected_size: number }>(
        "SELECT expected_size FROM blob_claims WHERE blob_id = ?",
        blobId,
      )
      .toArray()[0]
    const object = await this.headBlob(`vaults/${session.vaultId}/blobs/${blobId}`)
    assert(
      object && object.size === expectedSize,
      new HttpError(409, "blob_not_stored", "Blob upload was not stored completely"),
    )
    if (!claim) {
      const catalogued = this.sql
        .exec<{ size: number }>("SELECT size FROM blob_catalog WHERE blob_id = ?", blobId)
        .toArray()[0]
      assert(
        catalogued?.size === expectedSize,
        new HttpError(409, "blob_reservation_missing", "Blob upload reservation is missing"),
      )
      return new Response(null, { status: 204 })
    }
    assert(
      claim.expected_size === expectedSize,
      new HttpError(409, "blob_reservation_missing", "Blob upload reservation is missing"),
    )
    this.rememberStoredBlob(blobId, expectedSize)
    this.sql.exec("DELETE FROM blob_claims WHERE blob_id = ?", blobId)
    return new Response(null, { status: 204 })
  }

  async ensureStoredRevisionBlobs(
    vaultId: string,
    chunks: readonly { readonly blobId: Uint8Array }[],
  ): Promise<void> {
    for (const chunk of chunks) {
      const blobId = base64UrlEncode(chunk.blobId)
      const object = await this.headBlob(`vaults/${vaultId}/blobs/${blobId}`)
      assert(
        object,
        new HttpError(409, "blob_not_stored", "Revision references a blob that is not stored"),
      )
      this.rememberStoredBlob(blobId, object.size)
      this.sql.exec("DELETE FROM blob_claims WHERE blob_id = ?", blobId)
    }
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
      const page = await this.bucket.list({
        prefix,
        ...(cursor ? { cursor } : {}),
        limit: PRUNE_PAGE_SIZE,
      })
      const candidates = page.objects.filter((object) => {
        const blobId = object.key.slice(prefix.length)
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(blobId)) return false
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
        await this.bucket.delete(candidates.map((object) => object.key))
        deletedBytes += candidates.reduce((total, object) => total + object.size, 0)
        deletedCount += candidates.length
        for (const object of candidates) {
          const blobId = object.key.slice(prefix.length)
          this.sql.exec("DELETE FROM blob_claims WHERE blob_id = ?", blobId)
          this.sql.exec("DELETE FROM blob_catalog WHERE blob_id = ?", blobId)
        }
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor !== undefined)

    return json({ deletedBytes, deletedCount, graceDays: ORPHAN_GRACE_MS / 86_400_000 })
  }

  async storageStats(request: Request): Promise<Response> {
    const session = await authenticate(this.sql, request)
    const blobs = await this.reconcileBlobCatalog(session.vaultId)
    const operationCount = this.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM operations")
      .one().count
    const checkpointCount = this.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM checkpoints")
      .one().count
    const snapshotCount = this.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM snapshots")
      .one().count
    const state = vaultState(this.sql)
    assert(state, new HttpError(409, "not_claimed", "This deployment has not been claimed"))
    const activeDeviceCount = this.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM devices WHERE revoked_at IS NULL")
      .one().count
    const reservedBlobBytes = this.sql
      .exec<{ total: number }>("SELECT COALESCE(SUM(expected_size), 0) AS total FROM blob_claims")
      .one().total
    const totalBytes = this.sql.databaseSize + blobs.blobBytes
    const acknowledged = this.sql
      .exec<{ count: number; minimum_cursor: number | null }>(
        `SELECT COUNT(*) AS count, MIN(a.cursor) AS minimum_cursor
         FROM retention_acknowledgements a
         JOIN devices d ON d.device_id = a.device_id
         WHERE d.revoked_at IS NULL AND (? IS NULL OR a.epoch_id = ?)`,
        state.current_epoch_id,
        state.current_epoch_id,
      )
      .one()
    return json({
      totalBytes,
      blobBytes: blobs.blobBytes,
      blobCount: blobs.blobCount,
      reservedBlobBytes,
      databaseBytes: this.sql.databaseSize,
      operationCount,
      checkpointCount,
      snapshotCount,
      retentionMode: "forever",
      activeDeviceCount,
      acknowledgedDeviceCount: acknowledged.count,
      minimumAcknowledgedCursor:
        acknowledged.count === activeDeviceCount ? acknowledged.minimum_cursor : null,
      canPrune: session.role === "owner",
    })
  }

  private async headBlob(key: string): Promise<R2Object | null> {
    try {
      return await this.bucket.head(key)
    } catch {
      throw new HttpError(503, "blob_store_unavailable", "Blob storage is unavailable")
    }
  }

  private rememberStoredBlob(blobId: string, size: number): void {
    this.sql.exec(
      `INSERT INTO blob_catalog(blob_id, size, observed_at) VALUES (?, ?, ?)
       ON CONFLICT(blob_id) DO UPDATE SET
         size = excluded.size,
         observed_at = excluded.observed_at`,
      blobId,
      size,
      Date.now(),
    )
  }

  private async reconcileBlobCatalog(
    vaultId: string,
  ): Promise<{ blobBytes: number; blobCount: number }> {
    try {
      return await this.scanBlobCatalog(vaultId)
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(503, "blob_store_unavailable", "Blob usage is unavailable")
    }
  }

  private async scanBlobCatalog(
    vaultId: string,
  ): Promise<{ blobBytes: number; blobCount: number }> {
    const prefix = `vaults/${vaultId}/blobs/`
    const scanStartedAt = Date.now()
    let cursor: string | undefined
    let blobBytes = 0
    let blobCount = 0
    do {
      const page = await this.bucket.list({
        prefix,
        ...(cursor ? { cursor } : {}),
        limit: PRUNE_PAGE_SIZE,
      })
      for (const object of page.objects) {
        const blobId = object.key.slice(prefix.length)
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(blobId)) continue
        blobBytes += object.size
        blobCount += 1
        this.sql.exec(
          `INSERT INTO blob_catalog(blob_id, size, observed_at) VALUES (?, ?, ?)
           ON CONFLICT(blob_id) DO UPDATE SET
             size = excluded.size,
             observed_at = excluded.observed_at`,
          blobId,
          object.size,
          scanStartedAt,
        )
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor !== undefined)
    this.sql.exec("DELETE FROM blob_catalog WHERE observed_at < ?", scanStartedAt)
    this.sql.exec("DELETE FROM blob_claims WHERE claimed_at <= ?", Date.now() - BLOB_RESERVATION_MS)
    return { blobBytes, blobCount }
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
}

export function isSafeOrphanCandidate(
  uploadedAt: number,
  claimedAt: number | undefined,
  cutoff: number,
  referenced: boolean,
): boolean {
  return !referenced && uploadedAt < cutoff && (claimedAt === undefined || claimedAt < cutoff)
}
