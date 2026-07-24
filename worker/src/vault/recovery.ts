import { recoveryClaimSigningBytes } from "@meridian/crypto"
import { deviceId, ed25519PublicKey, vaultId, x25519PublicKey } from "@meridian/protocol"
import { assertIdentifier, base64UrlDecode, randomToken, verifyEd25519 } from "../encoding"
import { assert, HttpError } from "../errors"
import { RecoveryClaimSchema } from "../schemas"
import {
  cleanupExpired,
  decode,
  json,
  MAX_CERTIFICATE_BYTES,
  MAX_RECOVERY_PACKAGE_BYTES,
  requestJson,
  type TransactionSync,
  validateOpaqueData,
  validatePublicKey,
  validateSignature,
  vaultState,
} from "./domain"
import { validateRecoveryRootedIdentity } from "./signing"

const RECOVERY_CHALLENGE_TTL_MS = 5 * 60 * 1_000

export class VaultRecovery {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transactionSync: TransactionSync,
    private readonly closeAllSockets: () => void,
  ) {}

  recoveryPackage(): Response {
    const vault = vaultState(this.sql)
    assert(vault, new HttpError(409, "not_claimed", "This deployment has not been claimed"))
    return json({
      vaultId: vault.vault_id,
      recoverySigningPublicKey: vault.recovery_signing_public_key,
      encryptedRecoveryPackage: vault.recovery_package,
    })
  }

  async createRecoveryChallenge(): Promise<Response> {
    const vault = vaultState(this.sql)
    assert(vault, new HttpError(409, "not_claimed", "This deployment has not been claimed"))
    const now = Date.now()
    cleanupExpired(this.sql, now)
    const outstanding = this.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM recovery_challenges WHERE consumed_at IS NULL",
      )
      .one().count
    assert(
      outstanding < 5,
      new HttpError(429, "too_many_recovery_challenges", "Try recovery again later"),
    )
    const challengeId = randomToken(18)
    const challenge = randomToken()
    const expiresAt = now + RECOVERY_CHALLENGE_TTL_MS
    this.sql.exec(
      `INSERT INTO recovery_challenges(challenge_id, challenge, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
      challengeId,
      challenge,
      now,
      expiresAt,
    )
    return json({ challengeId, challenge, expiresAt, vaultId: vault.vault_id })
  }

  async recover(request: Request): Promise<Response> {
    const input = decode(RecoveryClaimSchema, await requestJson(request))
    assertIdentifier(input.challengeId, "challengeId")
    assertIdentifier(input.newDevice.deviceId, "deviceId")
    validatePublicKey(input.newDevice.signingPublicKey, "signingPublicKey")
    validatePublicKey(input.newDevice.hpkePublicKey, "hpkePublicKey")
    validateOpaqueData(input.newDevice.certificate, MAX_CERTIFICATE_BYTES, "certificate")
    validateOpaqueData(
      input.encryptedRecoveryPackage,
      MAX_RECOVERY_PACKAGE_BYTES,
      "encryptedRecoveryPackage",
    )
    validateSignature(input.proof)

    const vault = vaultState(this.sql)
    assert(vault, new HttpError(409, "not_claimed", "This deployment has not been claimed"))
    validateRecoveryRootedIdentity(
      input.newDevice,
      vault.vault_id,
      vault.recovery_signing_public_key,
      vault.cursor,
    )
    const now = Date.now()
    const challenge = this.sql
      .exec<{ challenge: string }>(
        `SELECT challenge FROM recovery_challenges
         WHERE challenge_id = ? AND consumed_at IS NULL AND expires_at > ?`,
        input.challengeId,
        now,
      )
      .toArray()[0]
    assert(
      challenge,
      new HttpError(401, "invalid_recovery_challenge", "Recovery challenge is invalid or expired"),
    )

    const signingBytes = recoveryClaimSigningBytes({
      challengeId: input.challengeId,
      challenge: base64UrlDecode(challenge.challenge, 32),
      vaultId: vaultId(base64UrlDecode(vault.vault_id, 16)),
      deviceId: deviceId(base64UrlDecode(input.newDevice.deviceId, 16)),
      signingPublicKey: ed25519PublicKey(base64UrlDecode(input.newDevice.signingPublicKey, 32)),
      hpkePublicKey: x25519PublicKey(base64UrlDecode(input.newDevice.hpkePublicKey, 32)),
      certificate: base64UrlDecode(input.newDevice.certificate, MAX_CERTIFICATE_BYTES),
      encryptedRecoveryPackage: base64UrlDecode(
        input.encryptedRecoveryPackage,
        MAX_RECOVERY_PACKAGE_BYTES,
      ),
    })
    const proofValid = await verifyEd25519(
      vault.recovery_signing_public_key,
      input.proof,
      signingBytes,
    )
    assert(
      proofValid,
      new HttpError(401, "invalid_recovery_proof", "Recovery ownership proof is invalid"),
    )

    this.transactionSync(() => {
      const consumed = this.sql.exec(
        `UPDATE recovery_challenges SET consumed_at = ?
         WHERE challenge_id = ? AND consumed_at IS NULL AND expires_at > ?`,
        now,
        input.challengeId,
        now,
      )
      assert(
        consumed.rowsWritten === 1,
        new HttpError(401, "invalid_recovery_challenge", "Recovery challenge was already used"),
      )
      const existing = this.sql
        .exec<{ device_id: string }>(
          "SELECT device_id FROM devices WHERE device_id = ?",
          input.newDevice.deviceId,
        )
        .toArray()[0]
      assert(
        !existing,
        new HttpError(409, "device_exists", "Replacement device identifier already exists"),
      )
      this.sql.exec("UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL", now)
      this.sql.exec("DELETE FROM sessions")
      this.sql.exec("DELETE FROM auth_challenges")
      this.sql.exec("DELETE FROM pairings")
      this.sql.exec(
        `INSERT INTO devices(
          device_id, signing_public_key, hpke_public_key, certificate, role, authorized_at, authorized_by
        ) VALUES (?, ?, ?, ?, 'owner', ?, NULL)`,
        input.newDevice.deviceId,
        input.newDevice.signingPublicKey,
        input.newDevice.hpkePublicKey,
        input.newDevice.certificate,
        now,
      )
      this.sql.exec(
        "UPDATE vault_state SET recovery_package = ? WHERE singleton = 1",
        input.encryptedRecoveryPackage,
      )
    })

    this.closeAllSockets()
    return json(
      { vaultId: vault.vault_id, deviceId: input.newDevice.deviceId, recoveredAt: now },
      { status: 201 },
    )
  }
}
