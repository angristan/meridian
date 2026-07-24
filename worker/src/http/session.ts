import { Effect } from "effect"
import { HttpError } from "../errors"
import type { WorkerContext, WorkerEnv } from "./types"
import { callVaultEffect } from "./vault-proxy"

const SESSION_PROTOCOL_PREFIX = "bearer."

export function extractSessionToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? ""
  const authorizationMatch = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(authorization)
  const authorizationToken = authorizationMatch?.at(1)
  if (authorizationToken !== undefined) return authorizationToken

  const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((value) => value.trim())
  const bearerProtocol = protocols.find((value) => value.startsWith(SESSION_PROTOCOL_PREFIX))
  if (bearerProtocol) {
    const token = bearerProtocol.slice(SESSION_PROTOCOL_PREFIX.length)
    if (/^[A-Za-z0-9_-]{32,256}$/.test(token)) return token
  }
  throw new HttpError(401, "authentication_required", "A valid device session is required")
}

export function sessionToken(c: WorkerContext): string {
  const existing = c.get("sessionToken")
  if (existing) return existing
  const token = extractSessionToken(c.req.raw)
  c.set("sessionToken", token)
  return token
}

export function validateSessionEffect(env: WorkerEnv, token: string) {
  return Effect.gen(function* () {
    const response = yield* callVaultEffect(
      env,
      "/internal/auth/validate",
      "POST",
      undefined,
      token,
    )
    if (!response.ok) {
      return yield* Effect.fail(
        new HttpError(401, "invalid_session", "Device session is invalid or expired"),
      )
    }

    const value = (yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () =>
        new HttpError(
          503,
          "invalid_vault_response",
          "Vault coordinator returned an invalid response",
        ),
    })) as unknown
    if (
      typeof value !== "object" ||
      value === null ||
      !("deviceId" in value) ||
      typeof value.deviceId !== "string" ||
      !("vaultId" in value) ||
      typeof value.vaultId !== "string"
    ) {
      return yield* Effect.fail(
        new HttpError(
          503,
          "invalid_vault_response",
          "Vault coordinator returned an invalid response",
        ),
      )
    }
    return { deviceId: value.deviceId, vaultId: value.vaultId }
  })
}
