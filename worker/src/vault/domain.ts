import type { StoredOperation } from "@meridian/protocol"
import { base64UrlDecode, hashToken } from "../encoding"
import { assert, HttpError } from "../errors"

export const MAX_CHANGE_PAGE_SIZE = 500
export const MAX_ENVELOPE_BYTES = 256 * 1024
export const MAX_EPOCH_ENVELOPE_BYTES = 2 * 1024 * 1024
export const MAX_CERTIFICATE_BYTES = 64 * 1024
export const MAX_HPKE_TRANSFER_BYTES = 256 * 1024
export const MAX_RECOVERY_PACKAGE_BYTES = 1024 * 1024

export type VaultStateRow = {
  vault_id: string
  claimed_at: number
  recovery_signing_public_key: string
  recovery_package: string
  recovery_state_id: string | null
  cursor: number
  head_hash: string
  log_format: "legacy-http-v1" | "canonical-cbor-v1"
  log_transition_cursor: number | null
  current_epoch_id: string | null
  epoch_sequence: number | null
  epoch_transition_cursor: number | null
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
  device_name: string | null
  platform: string | null
}

export type SessionContext = {
  deviceId: string
  vaultId: string
  role: "owner" | "member"
  expiresAt: number
}

export type OperationRow = {
  cursor: number
  operation_id: string
  author_device_id: string
  epoch_id: string
  operation_type: StoredOperation["type"]
  subject_device_id: string | null
  envelope: string
  signature: string
  request_hash: string
  previous_hash: string
  chain_hash: string
  created_at: number
}

export type TransactionSync = <T>(callback: () => T) => T

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

export async function authenticate(sql: SqlStorage, token: string): Promise<SessionContext> {
  assert(
    /^[A-Za-z0-9_-]{32,256}$/.test(token),
    new HttpError(401, "authentication_required", "A valid device session is required"),
  )
  const tokenHash = await hashToken(token)
  const row = sql
    .exec<{
      device_id: string
      role: "owner" | "member"
      vault_id: string
      expires_at: number
    }>(
      `SELECT s.device_id, d.role, v.vault_id, s.expires_at
       FROM sessions s
       JOIN devices d ON d.device_id = s.device_id
       JOIN vault_state v ON v.singleton = 1
       WHERE s.token_hash = ? AND s.expires_at > ? AND d.revoked_at IS NULL`,
      tokenHash,
      Date.now(),
    )
    .toArray()[0]
  assert(row, new HttpError(401, "invalid_session", "Device session is invalid or expired"))
  return {
    deviceId: row.device_id,
    vaultId: row.vault_id,
    role: row.role,
    expiresAt: row.expires_at,
  }
}

export function cleanupExpired(sql: SqlStorage, now: number): void {
  sql.exec("DELETE FROM setup_sessions WHERE expires_at <= ?", now)
  sql.exec("DELETE FROM auth_challenges WHERE expires_at <= ?", now)
  sql.exec("DELETE FROM recovery_challenges WHERE expires_at <= ?", now)
  sql.exec("DELETE FROM sessions WHERE expires_at <= ?", now)
  // Pairing capabilities are invalid after expiry in every state. Terminal records are operational
  // receipts, not user history, and retaining them indefinitely leaks coordinator storage.
  sql.exec("DELETE FROM pairings WHERE expires_at <= ?", now)
}
