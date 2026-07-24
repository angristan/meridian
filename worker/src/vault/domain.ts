import { Schema } from "effect"
import { base64UrlDecode, hashToken } from "../encoding"
import { assert, HttpError } from "../errors"
import type { Operation } from "../schemas"

export const MAX_CHANGE_PAGE_SIZE = 500
export const MAX_ENVELOPE_BYTES = 256 * 1024
export const MAX_CERTIFICATE_BYTES = 64 * 1024
export const MAX_HPKE_TRANSFER_BYTES = 256 * 1024
export const MAX_RECOVERY_PACKAGE_BYTES = 1024 * 1024

export type VaultStateRow = {
  vault_id: string
  claimed_at: number
  recovery_signing_public_key: string
  recovery_package: string
  cursor: number
  head_hash: string
}

export type DeviceRow = {
  device_id: string
  signing_public_key: string
  hpke_public_key: string
  certificate: string
  role: "owner" | "member"
  authorized_at: number
  authorized_by: string | null
  revoked_at: number | null
  revoked_operation_id: string | null
}

export type SessionContext = {
  deviceId: string
  vaultId: string
  role: "owner" | "member"
}

export type OperationRow = {
  cursor: number
  operation_id: string
  author_device_id: string
  epoch_id: string
  operation_type: Operation["type"]
  subject_device_id: string | null
  envelope: string
  signature: string
  request_hash: string
  previous_hash: string
  chain_hash: string
  created_at: number
}

export type TransactionSync = <T>(callback: () => T) => T

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set("cache-control", "no-store")
  return Response.json(data, { ...init, headers })
}

export function decode<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  input: unknown,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input)
  } catch {
    throw new HttpError(400, "invalid_request", "Request body does not match the protocol schema")
  }
}

export async function requestJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Expected application/json")
  }
  try {
    return await request.json()
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON")
  }
}

export function validatePublicKey(value: string, field: string): void {
  const bytes = base64UrlDecode(value, 32)
  assert(bytes.length === 32, new HttpError(400, "invalid_public_key", `${field} must be 32 bytes`))
}

export function validateSignature(value: string): void {
  const bytes = base64UrlDecode(value, 64)
  assert(bytes.length === 64, new HttpError(400, "invalid_signature", "Signature must be 64 bytes"))
}

export function validateOpaqueData(value: string, maximumBytes: number, field: string): void {
  const bytes = base64UrlDecode(value, maximumBytes)
  assert(bytes.length > 0, new HttpError(400, "invalid_request", `${field} must not be empty`))
}

export function vaultState(sql: SqlStorage): VaultStateRow | undefined {
  return sql.exec<VaultStateRow>("SELECT * FROM vault_state WHERE singleton = 1").toArray()[0]
}

export function activeDevice(sql: SqlStorage, deviceId: string): DeviceRow | undefined {
  return sql
    .exec<DeviceRow>("SELECT * FROM devices WHERE device_id = ? AND revoked_at IS NULL", deviceId)
    .toArray()[0]
}

export async function authenticate(sql: SqlStorage, request: Request): Promise<SessionContext> {
  const authorization = request.headers.get("authorization") ?? ""
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(authorization)
  assert(match, new HttpError(401, "authentication_required", "A valid device session is required"))

  const token = match.at(1)
  assert(
    token !== undefined,
    new HttpError(401, "authentication_required", "Session token is missing"),
  )
  const tokenHash = await hashToken(token)
  const row = sql
    .exec<{ device_id: string; role: "owner" | "member"; vault_id: string }>(
      `SELECT s.device_id, d.role, v.vault_id
       FROM sessions s
       JOIN devices d ON d.device_id = s.device_id
       JOIN vault_state v ON v.singleton = 1
       WHERE s.token_hash = ? AND s.expires_at > ? AND d.revoked_at IS NULL`,
      tokenHash,
      Date.now(),
    )
    .toArray()[0]
  assert(row, new HttpError(401, "invalid_session", "Device session is invalid or expired"))
  return { deviceId: row.device_id, vaultId: row.vault_id, role: row.role }
}

export function cleanupExpired(sql: SqlStorage, now: number): void {
  sql.exec("DELETE FROM setup_sessions WHERE expires_at <= ?", now)
  sql.exec("DELETE FROM auth_challenges WHERE expires_at <= ?", now)
  sql.exec("DELETE FROM recovery_challenges WHERE expires_at <= ?", now)
  sql.exec("DELETE FROM sessions WHERE expires_at <= ?", now)
  sql.exec("DELETE FROM pairings WHERE expires_at <= ? AND status != 'approved'", now)
}
