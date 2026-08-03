import { HttpError } from "../errors"
import type { WorkerContext } from "./types"
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

export function authenticatedVaultEffect(
  context: WorkerContext,
  path: string,
  method: "GET" | "POST" = "GET",
  source?: Request,
) {
  return callVaultEffect(
    context.env,
    path,
    method,
    undefined,
    extractSessionToken(context.req.raw),
    source,
  )
}
