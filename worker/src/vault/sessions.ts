import { assertIdentifier, hashToken, randomToken, verifyEd25519 } from "../encoding"
import { assert, HttpError } from "../errors"
import { AuthChallengeSchema, AuthSessionSchema } from "../schemas"
import {
  activeDevice,
  cleanupExpired,
  decode,
  json,
  requestJson,
  type TransactionSync,
  validateSignature,
  vaultState,
} from "./domain"
import { authSigningMessage } from "./signing"

const AUTH_CHALLENGE_TTL_MS = 5 * 60 * 1_000
const AUTH_SESSION_TTL_MS = 20 * 60 * 1_000

export class VaultSessions {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transactionSync: TransactionSync,
  ) {}

  async createAuthChallenge(request: Request): Promise<Response> {
    const input = decode(AuthChallengeSchema, await requestJson(request))
    assertIdentifier(input.deviceId, "deviceId")
    assert(
      vaultState(this.sql),
      new HttpError(409, "not_claimed", "This deployment has not been claimed"),
    )
    assert(
      activeDevice(this.sql, input.deviceId),
      new HttpError(404, "device_not_found", "Device is not authorized"),
    )

    const now = Date.now()
    cleanupExpired(this.sql, now)
    const existing = this.sql
      .exec<{ challenge_id: string; challenge: string; expires_at: number }>(
        `SELECT challenge_id, challenge, expires_at FROM auth_challenges
         WHERE device_id = ? AND consumed_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`,
        input.deviceId,
        now,
      )
      .toArray()[0]
    if (existing) {
      return json({
        challengeId: existing.challenge_id,
        challenge: existing.challenge,
        expiresAt: existing.expires_at,
      })
    }

    const challengeId = randomToken(18)
    const challenge = randomToken()
    this.sql.exec(
      `INSERT INTO auth_challenges(challenge_id, device_id, challenge, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      challengeId,
      input.deviceId,
      challenge,
      now,
      now + AUTH_CHALLENGE_TTL_MS,
    )
    return json({ challengeId, challenge, expiresAt: now + AUTH_CHALLENGE_TTL_MS })
  }

  async createAuthSession(request: Request): Promise<Response> {
    const input = decode(AuthSessionSchema, await requestJson(request))
    assertIdentifier(input.deviceId, "deviceId")
    assertIdentifier(input.challengeId, "challengeId")
    validateSignature(input.signature)
    const vault = vaultState(this.sql)
    assert(vault, new HttpError(409, "not_claimed", "This deployment has not been claimed"))
    const supportsCanonicalLog = input.supportedLogFormats?.includes("canonical-cbor-v1") === true
    const supportsEpochTransitions =
      input.supportedFeatures?.includes("epoch-transition-v1") === true
    assert(
      vault.log_format !== "canonical-cbor-v1" || supportsCanonicalLog,
      new HttpError(426, "protocol_upgrade_required", "Update Meridian to continue syncing"),
    )
    assert(
      vault.epoch_transition_cursor === null || supportsEpochTransitions,
      new HttpError(426, "protocol_upgrade_required", "Update Meridian to continue syncing"),
    )
    const device = activeDevice(this.sql, input.deviceId)
    assert(device, new HttpError(404, "device_not_found", "Device is not authorized"))

    const now = Date.now()
    const challenge = this.sql
      .exec<{ challenge: string }>(
        `SELECT challenge FROM auth_challenges
         WHERE challenge_id = ? AND device_id = ? AND consumed_at IS NULL AND expires_at > ?`,
        input.challengeId,
        input.deviceId,
        now,
      )
      .toArray()[0]
    assert(
      challenge,
      new HttpError(401, "invalid_challenge", "Authentication challenge is invalid or expired"),
    )
    const signatureValid = await verifyEd25519(
      device.signing_public_key,
      input.signature,
      authSigningMessage(vault.vault_id, input, challenge.challenge),
    )
    assert(
      signatureValid,
      new HttpError(401, "invalid_signature", "Challenge signature is invalid"),
    )

    const sessionToken = randomToken()
    const sessionHash = await hashToken(sessionToken)
    const committedAt = Date.now()
    this.transactionSync(() => {
      assert(
        activeDevice(this.sql, input.deviceId),
        new HttpError(404, "device_not_found", "Device is not authorized"),
      )
      const consumed = this.sql.exec(
        `UPDATE auth_challenges SET consumed_at = ?
         WHERE challenge_id = ? AND device_id = ? AND consumed_at IS NULL AND expires_at > ?`,
        committedAt,
        input.challengeId,
        input.deviceId,
        committedAt,
      )
      assert(
        consumed.rowsWritten === 1,
        new HttpError(401, "invalid_challenge", "Challenge was already used"),
      )
      if (supportsCanonicalLog || supportsEpochTransitions) {
        this.sql.exec(
          `UPDATE devices
           SET supports_canonical_log = CASE WHEN ? THEN 1 ELSE supports_canonical_log END,
               supports_epoch_transitions = CASE WHEN ? THEN 1 ELSE supports_epoch_transitions END
           WHERE device_id = ? AND revoked_at IS NULL`,
          supportsCanonicalLog ? 1 : 0,
          supportsEpochTransitions ? 1 : 0,
          input.deviceId,
        )
      }
      this.sql.exec(
        `INSERT INTO sessions(
          token_hash, device_id, created_at, expires_at,
          supports_canonical_log, supports_epoch_transitions
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        sessionHash,
        input.deviceId,
        committedAt,
        committedAt + AUTH_SESSION_TTL_MS,
        supportsCanonicalLog ? 1 : 0,
        supportsEpochTransitions ? 1 : 0,
      )
    })
    return json({
      sessionToken,
      deviceId: input.deviceId,
      expiresAt: committedAt + AUTH_SESSION_TTL_MS,
    })
  }
}
