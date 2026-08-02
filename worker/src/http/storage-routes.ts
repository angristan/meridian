import * as Effect from "effect/Effect"
import { HttpError } from "../errors"
import { runResponse } from "./effect-boundary"
import { sessionToken, validateSessionEffect } from "./session"
import type { WorkerApp } from "./types"
import { callVaultEffect } from "./vault-proxy"

interface CoordinatorStorage {
  totalBytes: number
  blobBytes: number
  blobCount: number
  reservedBlobBytes: number
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
        yield* validateSessionEffect(c.env, token)
        const response = yield* callVaultEffect(c.env, "/v1/storage", "GET", undefined, token)
        const coordinator = yield* Effect.tryPromise({
          try: () => parseCoordinatorStorage(response),
          catch: (error) =>
            error instanceof HttpError
              ? error
              : new HttpError(503, "vault_unavailable", "Storage statistics are unavailable"),
        })
        return Response.json(coordinator, {
          headers: { "cache-control": "private, no-store" },
        })
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

async function parseCoordinatorStorage(response: Response): Promise<CoordinatorStorage> {
  if (!response.ok) {
    throw new HttpError(response.status, "vault_unavailable", "Storage statistics are unavailable")
  }
  const value: unknown = await response.json()
  if (!isRecord(value)) throw new Error("Coordinator returned invalid storage statistics")
  return {
    totalBytes: nonNegativeNumber(value.totalBytes, "totalBytes"),
    blobBytes: nonNegativeNumber(value.blobBytes, "blobBytes"),
    blobCount: nonNegativeNumber(value.blobCount, "blobCount"),
    reservedBlobBytes: nonNegativeNumber(value.reservedBlobBytes, "reservedBlobBytes"),
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
