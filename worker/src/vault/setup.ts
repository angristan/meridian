import { assertIdentifier, hashToken, randomToken, verifyEd25519, ZERO_HASH } from "../encoding"
import { assert, HttpError } from "../errors"
import { SetupClaimSchema } from "../schemas"
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
import { setupClaimSigningMessage, validateRecoveryRootedIdentity } from "./signing"

const SETUP_SESSION_TTL_MS = 10 * 60 * 1_000

export class VaultSetup {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transactionSync: TransactionSync,
  ) {}

  async createSetupSession(): Promise<Response> {
    assert(
      !vaultState(this.sql),
      new HttpError(409, "already_claimed", "This deployment is already claimed"),
    )
    const now = Date.now()
    cleanupExpired(this.sql, now)
    const outstanding = this.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM setup_sessions WHERE consumed_at IS NULL",
      )
      .one().count
    assert(outstanding < 5, new HttpError(429, "too_many_setup_sessions", "Try setup again later"))

    const token = randomToken()
    const challenge = randomToken()
    this.sql.exec(
      "INSERT INTO setup_sessions(token_hash, challenge, created_at, expires_at) VALUES (?, ?, ?, ?)",
      await hashToken(token),
      challenge,
      now,
      now + SETUP_SESSION_TTL_MS,
    )
    return json({
      setupSession: token,
      claimChallenge: challenge,
      expiresAt: now + SETUP_SESSION_TTL_MS,
    })
  }

  async claim(request: Request): Promise<Response> {
    const claim = decode(SetupClaimSchema, await requestJson(request))
    assertIdentifier(claim.vaultId, "vaultId")
    assertIdentifier(claim.initialDevice.deviceId, "deviceId")
    validatePublicKey(claim.recoverySigningPublicKey, "recoverySigningPublicKey")
    validatePublicKey(claim.initialDevice.signingPublicKey, "signingPublicKey")
    validatePublicKey(claim.initialDevice.hpkePublicKey, "hpkePublicKey")
    validateOpaqueData(
      claim.encryptedRecoveryPackage,
      MAX_RECOVERY_PACKAGE_BYTES,
      "encryptedRecoveryPackage",
    )
    validateOpaqueData(claim.initialDevice.certificate, MAX_CERTIFICATE_BYTES, "certificate")
    validateSignature(claim.proof)
    validateRecoveryRootedIdentity(
      claim.initialDevice,
      claim.vaultId,
      claim.recoverySigningPublicKey,
      0,
    )

    const sessionHash = await hashToken(claim.setupSession)
    const now = Date.now()
    const setup = this.sql
      .exec<{ challenge: string }>(
        `SELECT challenge FROM setup_sessions
         WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
        sessionHash,
        now,
      )
      .toArray()[0]
    assert(
      setup,
      new HttpError(401, "invalid_setup_session", "Setup session is invalid or expired"),
    )
    const proofValid = await verifyEd25519(
      claim.initialDevice.signingPublicKey,
      claim.proof,
      setupClaimSigningMessage(claim, setup.challenge),
    )
    assert(
      proofValid,
      new HttpError(401, "invalid_proof", "First-device proof of possession is invalid"),
    )

    this.transactionSync(() => {
      assert(
        !vaultState(this.sql),
        new HttpError(409, "already_claimed", "This deployment is already claimed"),
      )
      const freshSetup = this.sql
        .exec<{ challenge: string }>(
          `SELECT challenge FROM setup_sessions
           WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
          sessionHash,
          Date.now(),
        )
        .toArray()[0]
      assert(
        freshSetup,
        new HttpError(401, "invalid_setup_session", "Setup session is invalid or expired"),
      )
      assert(
        freshSetup.challenge === setup.challenge,
        new HttpError(409, "setup_session_changed", "Setup session changed"),
      )

      this.sql.exec(
        `INSERT INTO vault_state(
          singleton, vault_id, claimed_at, recovery_signing_public_key, recovery_package, cursor, head_hash
         ) VALUES (1, ?, ?, ?, ?, 0, ?)`,
        claim.vaultId,
        now,
        claim.recoverySigningPublicKey,
        claim.encryptedRecoveryPackage,
        ZERO_HASH,
      )
      this.sql.exec(
        `INSERT INTO devices(
          device_id, signing_public_key, hpke_public_key, certificate, role, authorized_at, authorized_by
        ) VALUES (?, ?, ?, ?, 'owner', ?, NULL)`,
        claim.initialDevice.deviceId,
        claim.initialDevice.signingPublicKey,
        claim.initialDevice.hpkePublicKey,
        claim.initialDevice.certificate,
        now,
      )
      this.sql.exec(
        "UPDATE setup_sessions SET consumed_at = ? WHERE token_hash = ?",
        now,
        sessionHash,
      )
      this.sql.exec("DELETE FROM setup_sessions WHERE token_hash != ?", sessionHash)
    })

    return json(
      { vaultId: claim.vaultId, deviceId: claim.initialDevice.deviceId, claimedAt: now },
      { status: 201 },
    )
  }
}
