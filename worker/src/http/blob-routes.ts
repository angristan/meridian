import { tracing } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import { HttpError } from "../errors"
import { runHttpEffect } from "./effect-boundary"
import { requiredParam } from "./request"
import { extractSessionToken, validateSessionEffect } from "./session"
import { observeStreamOutcome, type StreamOutcome } from "./stream-lifecycle"
import type { WorkerApp } from "./types"
import { callVaultEffect } from "./vault-proxy"

const MAX_BLOB_BYTES = 10 * 1024 * 1024

function validateBlobId(blobId: string): void {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(blobId)) {
    throw new HttpError(400, "invalid_blob_id", "Blob identifier is invalid")
  }
}

export function registerBlobRoutes(app: WorkerApp): void {
  app.put("/v1/blobs/:blobId", (c) =>
    runHttpEffect(
      Effect.gen(function* () {
        const token = extractSessionToken(c.req.raw)
        const auth = yield* validateSessionEffect(c.env, token)
        const blobId = requiredParam(c, "blobId")
        validateBlobId(blobId)
        const contentType = c.req.header("content-type")?.toLowerCase() ?? ""
        if (contentType !== "application/octet-stream") {
          return yield* Effect.fail(
            new HttpError(
              415,
              "unsupported_media_type",
              "Encrypted blobs require application/octet-stream",
            ),
          )
        }
        const lengthHeader = c.req.header("content-length")
        if (lengthHeader === undefined) {
          return yield* Effect.fail(
            new HttpError(
              411,
              "length_required",
              "A Content-Length header is required for streaming uploads",
            ),
          )
        }
        const length = Number(lengthHeader)
        if (!Number.isSafeInteger(length) || length <= 0) {
          return yield* Effect.fail(
            new HttpError(400, "invalid_length", "Content-Length is invalid"),
          )
        }
        if (length > MAX_BLOB_BYTES) {
          return yield* Effect.fail(
            new HttpError(413, "blob_too_large", "Encrypted blob exceeds 10 MiB"),
          )
        }
        if (!c.req.raw.body) {
          return yield* Effect.fail(
            new HttpError(400, "empty_blob", "Encrypted blob body is required"),
          )
        }
        const claim = yield* callVaultEffect(
          c.env,
          `/internal/blobs/${encodeURIComponent(blobId)}/claim?size=${length}`,
          "POST",
          undefined,
          token,
        )
        if (!claim.ok) return claim
        const claimBody = yield* Effect.tryPromise({
          try: () => claim.json<unknown>(),
          catch: () => new HttpError(503, "vault_unavailable", "Blob reservation was invalid"),
        })
        if (!isRecord(claimBody) || typeof claimBody.exists !== "boolean") {
          return yield* Effect.fail(
            new HttpError(503, "vault_unavailable", "Blob reservation was invalid"),
          )
        }
        if (claimBody.exists) return new Response(null, { status: 204 })

        const key = `vaults/${auth.vaultId}/blobs/${blobId}`
        const stored = yield* Effect.tryPromise({
          try: () =>
            c.env.BLOBS.put(key, c.req.raw.body, {
              onlyIf: { etagDoesNotMatch: "*" },
              httpMetadata: { contentType: "application/octet-stream" },
            }),
          catch: (error) => {
            if (error instanceof HttpError) return error
            console.error("R2 blob upload failed", {
              error: error instanceof Error ? error.name : "unknown",
            })
            return new HttpError(503, "blob_store_unavailable", "Blob upload failed")
          },
        })
        const finalized = yield* callVaultEffect(
          c.env,
          `/internal/blobs/${encodeURIComponent(blobId)}/finalize?size=${length}`,
          "POST",
          undefined,
          token,
        )
        if (!finalized.ok) return finalized
        return new Response(null, {
          status: stored === null ? 204 : 201,
          headers: { "cache-control": "no-store" },
        })
      }),
    ),
  )

  app.get("/v1/blobs/:blobId", (c) =>
    runHttpEffect(
      Effect.gen(function* () {
        const auth = yield* validateSessionEffect(c.env, extractSessionToken(c.req.raw))
        const blobId = requiredParam(c, "blobId")
        validateBlobId(blobId)
        const key = `vaults/${auth.vaultId}/blobs/${blobId}`
        const object = yield* Effect.tryPromise({
          try: () => c.env.BLOBS.get(key),
          catch: () => new HttpError(503, "blob_store_unavailable", "Blob download failed"),
        })
        if (!object) {
          return yield* Effect.fail(new HttpError(404, "blob_not_found", "Blob was not found"))
        }
        const headers = new Headers({
          "cache-control": "private, no-store",
          "content-length": String(object.size),
          etag: object.httpEtag,
          "content-type": "application/octet-stream",
        })
        return tracing.startActiveSpan("app.blob.download.stream", (span) => {
          let ended = false
          const endSpan = (outcome: StreamOutcome) => {
            if (ended) return
            ended = true
            span.setAttribute("app.blob.download.outcome", outcome)
            span.end()
          }

          try {
            const body = observeStreamOutcome(object.body, endSpan)
            return new Response(body, { status: 200, headers })
          } catch (error) {
            endSpan("failed")
            throw error
          }
        })
      }),
    ),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
