import { Effect } from "effect"
import { HttpError } from "../errors"
import { runResponse } from "./effect-boundary"
import { sessionToken, validateSessionEffect } from "./session"
import type { WorkerApp } from "./types"
import { callVaultEffect } from "./vault-proxy"

interface CoordinatorStorage {
  databaseBytes: number
  operationCount: number
  checkpointCount: number
  snapshotCount: number
  retentionMode: "forever"
  activeDeviceCount: number
  acknowledgedDeviceCount: number
  minimumAcknowledgedCursor: number | null
  canPrune: boolean
}

export function registerStorageRoutes(app: WorkerApp): void {
  app.get("/v1/storage", (c) =>
    runResponse(
      Effect.gen(function* () {
        const token = sessionToken(c)
        const auth = yield* validateSessionEffect(c.env, token)
        const response = yield* callVaultEffect(c.env, "/v1/storage", "GET", undefined, token)
        const coordinator = yield* Effect.tryPromise({
          try: () => parseCoordinatorStorage(response),
          catch: (error) =>
            error instanceof HttpError
              ? error
              : new HttpError(503, "vault_unavailable", "Storage statistics are unavailable"),
        })
        const blobs = yield* Effect.tryPromise({
          try: () => encryptedBlobUsage(c.env.BLOBS, auth.vaultId),
          catch: () => new HttpError(503, "blob_store_unavailable", "Blob usage is unavailable"),
        })
        return Response.json(
          { ...coordinator, ...blobs, totalBytes: coordinator.databaseBytes + blobs.blobBytes },
          { headers: { "cache-control": "private, no-store" } },
        )
      }),
    ),
  )

  app.post("/v1/storage/prune-orphans", (c) =>
    runResponse(
      Effect.gen(function* () {
        const token = sessionToken(c)
        yield* validateSessionEffect(c.env, token)
        return yield* callVaultEffect(c.env, "/v1/storage/prune-orphans", "POST", undefined, token)
      }),
    ),
  )
}

async function encryptedBlobUsage(
  bucket: R2Bucket,
  vaultId: string,
): Promise<{ blobBytes: number; blobCount: number }> {
  const prefix = `vaults/${vaultId}/blobs/`
  let cursor: string | undefined
  let blobBytes = 0
  let blobCount = 0
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1_000 })
    for (const object of page.objects) {
      blobBytes += object.size
      blobCount += 1
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor !== undefined)
  return { blobBytes, blobCount }
}

async function parseCoordinatorStorage(response: Response): Promise<CoordinatorStorage> {
  if (!response.ok) {
    throw new HttpError(response.status, "vault_unavailable", "Storage statistics are unavailable")
  }
  const value: unknown = await response.json()
  if (!isRecord(value)) throw new Error("Coordinator returned invalid storage statistics")
  return {
    databaseBytes: nonNegativeNumber(value.databaseBytes, "databaseBytes"),
    operationCount: nonNegativeNumber(value.operationCount, "operationCount"),
    checkpointCount: nonNegativeNumber(value.checkpointCount, "checkpointCount"),
    snapshotCount: nonNegativeNumber(value.snapshotCount, "snapshotCount"),
    retentionMode: literalForever(value.retentionMode),
    activeDeviceCount: nonNegativeNumber(value.activeDeviceCount, "activeDeviceCount"),
    acknowledgedDeviceCount: nonNegativeNumber(
      value.acknowledgedDeviceCount,
      "acknowledgedDeviceCount",
    ),
    minimumAcknowledgedCursor:
      value.minimumAcknowledgedCursor === null
        ? null
        : nonNegativeNumber(value.minimumAcknowledgedCursor, "minimumAcknowledgedCursor"),
    canPrune: boolean(value.canPrune, "canPrune"),
  }
}

function literalForever(value: unknown): "forever" {
  if (value !== "forever") throw new Error("Coordinator retention mode is invalid")
  return value
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Coordinator storage field ${field} is invalid`)
  return value
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Coordinator storage field ${field} is invalid`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
