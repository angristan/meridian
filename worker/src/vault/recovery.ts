import { computeRecoveryStateId, recoveryClaimSigningBytes } from "@meridian/crypto"
import {
  decodeDeviceCertificate,
  deviceId,
  ed25519PublicKey,
  encodeCanonical,
  hashBytes,
  type RecoveryClaim,
  recoveryId,
  vaultId,
  x25519PublicKey,
} from "@meridian/protocol"
import {
  assertIdentifier,
  base64UrlDecode,
  base64UrlEncode,
  randomToken,
  sha256,
  verifyEd25519,
} from "../encoding"
import { assert, HttpError } from "../errors"
import {
  cleanupExpired,
  MAX_CERTIFICATE_BYTES,
  MAX_RECOVERY_PACKAGE_BYTES,
  type TransactionSync,
  type VaultStateRow,
  validateOpaqueData,
  validatePublicKey,
  validateSignature,
  vaultState,
} from "./domain"
import { reply, type VaultReply } from "./rpc"
import { validateRecoveryRootedIdentity } from "./signing"

const RECOVERY_CHALLENGE_TTL_MS = 5 * 60 * 1_000

type RecoveryReceipt = {
  recovery_id: string
  request_hash: string
  device_id: string
  recovery_state_id: string
  recovered_at: number
}

export class VaultRecovery {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transactionSync: TransactionSync,
    private readonly closeAllSockets: () => void,
  ) {}

  async recoveryPackage() {
    const vault = vaultState(this.sql)
    assert(vault, new HttpError(409, "not_claimed", "This deployment has not been claimed"))
    const recoveryStateId = await this.ensureRecoveryStateId(vault)
    return reply({
      vaultId: vault.vault_id,
      recoverySigningPublicKey: vault.recovery_signing_public_key,
      encryptedRecoveryPackage: vault.recovery_package,
      recoveryStateId,
    })
  }

  async createRecoveryChallenge() {
    const vault = vaultState(this.sql)
    assert(vault, new HttpError(409, "not_claimed", "This deployment has not been claimed"))
    await this.ensureRecoveryStateId(vault)
    const now = Date.now()
    cleanupExpired(this.sql, now)
    const existing = this.sql
      .exec<{ challenge_id: string; challenge: string; expires_at: number }>(
        `SELECT challenge_id, challenge, expires_at FROM recovery_challenges
         WHERE consumed_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`,
        now,
      )
      .toArray()[0]
    if (existing) {
      return reply({
        challengeId: existing.challenge_id,
        challenge: existing.challenge,
        expiresAt: existing.expires_at,
        vaultId: vault.vault_id,
      })
    }
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
    return reply({ challengeId, challenge, expiresAt, vaultId: vault.vault_id })
  }

  async recover(input: RecoveryClaim) {
    const recoveryIdentifier = input.recoveryId
    assertIdentifier(recoveryIdentifier, "recoveryId")
    assertIdentifier(input.challengeId, "challengeId")
    assertIdentifier(input.newDevice.deviceId, "deviceId")
    assert(
      base64UrlDecode(input.previousRecoveryStateId, 32).byteLength === 32,
      new HttpError(400, "invalid_recovery_state", "Recovery predecessor must be 32 bytes"),
    )
    validatePublicKey(input.newDevice.signingPublicKey, "signingPublicKey")
    validatePublicKey(input.newDevice.hpkePublicKey, "hpkePublicKey")
    validateOpaqueData(input.newDevice.certificate, MAX_CERTIFICATE_BYTES, "certificate")
    validateOpaqueData(
      input.encryptedRecoveryPackage,
      MAX_RECOVERY_PACKAGE_BYTES,
      "encryptedRecoveryPackage",
    )
    validateSignature(input.proof)

    const requestHash = await recoveryRequestHash(input)
    const existingReceipt = this.receipt(input.recoveryId)
    if (existingReceipt) return this.duplicateResponse(existingReceipt, requestHash)

    const vault = vaultState(this.sql)
    assert(vault, new HttpError(409, "not_claimed", "This deployment has not been claimed"))
    await this.ensureRecoveryStateId(vault)
    validateRecoveryRootedIdentity(
      input.newDevice,
      vault.vault_id,
      vault.recovery_signing_public_key,
      vault.cursor,
    )
    const replacementCertificate = decodeDeviceCertificate(
      base64UrlDecode(input.newDevice.certificate, MAX_CERTIFICATE_BYTES),
    )
    const replacementEpochId = base64UrlEncode(replacementCertificate.body.epochId)
    const now = Date.now()
    const challenge = this.sql
      .exec<{ challenge: string; expires_at: number; consumed_at: number | null }>(
        `SELECT challenge, expires_at, consumed_at FROM recovery_challenges
         WHERE challenge_id = ?`,
        input.challengeId,
      )
      .toArray()[0]
    assert(
      challenge && challenge.consumed_at === null && challenge.expires_at > now,
      new HttpError(401, "invalid_recovery_challenge", "Recovery challenge is invalid or expired"),
    )

    const signingBytes = recoveryClaimSigningBytes({
      claimVersion: 2,
      recoveryId: recoveryId(base64UrlDecode(input.recoveryId, 16)),
      previousRecoveryStateId: hashBytes(base64UrlDecode(input.previousRecoveryStateId, 32)),
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
    const nextRecoveryStateId = base64UrlEncode(
      await computeRecoveryStateId(
        vaultId(base64UrlDecode(vault.vault_id, 16)),
        base64UrlDecode(input.encryptedRecoveryPackage, MAX_RECOVERY_PACKAGE_BYTES),
      ),
    )

    const recoveredAt = Date.now()
    const result = this.transactionSync(() => {
      const concurrentReceipt = this.receipt(recoveryIdentifier)
      if (concurrentReceipt) {
        assert(
          concurrentReceipt.request_hash === requestHash,
          new HttpError(409, "idempotency_conflict", "Recovery ID was used with different content"),
        )
        return { receipt: concurrentReceipt, duplicate: true }
      }

      const currentVault = vaultState(this.sql)
      assert(
        currentVault,
        new HttpError(409, "not_claimed", "This deployment has not been claimed"),
      )
      assert(
        currentVault.recovery_state_id === input.previousRecoveryStateId,
        new HttpError(
          409,
          "stale_recovery_state",
          "A newer recovery package already replaced this state",
        ),
      )
      validateRecoveryRootedIdentity(
        input.newDevice,
        currentVault.vault_id,
        currentVault.recovery_signing_public_key,
        currentVault.cursor,
      )
      const consumed = this.sql.exec(
        `UPDATE recovery_challenges SET consumed_at = ?
         WHERE challenge_id = ? AND consumed_at IS NULL AND expires_at > ?`,
        recoveredAt,
        input.challengeId,
        recoveredAt,
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
      this.sql.exec("UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL", recoveredAt)
      this.sql.exec("DELETE FROM sessions")
      this.sql.exec("DELETE FROM auth_challenges")
      this.sql.exec("DELETE FROM pairings")
      this.sql.exec(
        `INSERT INTO devices(
          device_id, signing_public_key, hpke_public_key, certificate, role, authorized_at,
          authorized_by
        ) VALUES (?, ?, ?, ?, 'owner', ?, NULL)`,
        input.newDevice.deviceId,
        input.newDevice.signingPublicKey,
        input.newDevice.hpkePublicKey,
        input.newDevice.certificate,
        recoveredAt,
      )
      this.sql.exec(
        `UPDATE vault_state
         SET recovery_package = ?, recovery_state_id = ?, current_epoch_id = ?, epoch_sequence = NULL
         WHERE singleton = 1`,
        input.encryptedRecoveryPackage,
        nextRecoveryStateId,
        replacementEpochId,
      )
      this.sql.exec(
        `INSERT INTO recovery_receipts(
          recovery_id, request_hash, device_id, recovery_state_id, recovered_at
         ) VALUES (?, ?, ?, ?, ?)`,
        input.recoveryId,
        requestHash,
        input.newDevice.deviceId,
        nextRecoveryStateId,
        recoveredAt,
      )
      // Once a newer recovery succeeds, older claims cannot be valid exact retries because their
      // predecessor state was replaced. Keep only the current receipt for response-loss recovery.
      this.sql.exec("DELETE FROM recovery_receipts WHERE recovery_id <> ?", input.recoveryId)
      return {
        receipt: {
          recovery_id: input.recoveryId,
          request_hash: requestHash,
          device_id: input.newDevice.deviceId,
          recovery_state_id: nextRecoveryStateId,
          recovered_at: recoveredAt,
        },
        duplicate: false,
      }
    })

    if (!result.duplicate) this.closeAllSockets()
    return reply(
      {
        vaultId: vault.vault_id,
        deviceId: result.receipt.device_id,
        recoveredAt: result.receipt.recovered_at,
        recoveryStateId: result.receipt.recovery_state_id,
        duplicate: result.duplicate,
      },
      result.duplicate ? 200 : 201,
    )
  }

  private receipt(recoveryIdValue: string): RecoveryReceipt | undefined {
    return this.sql
      .exec<RecoveryReceipt>(
        "SELECT * FROM recovery_receipts WHERE recovery_id = ?",
        recoveryIdValue,
      )
      .toArray()[0]
  }

  private duplicateResponse(
    receipt: RecoveryReceipt,
    requestHash: string,
  ): VaultReply<{
    vaultId: string
    deviceId: string
    recoveredAt: number
    recoveryStateId: string
    duplicate: boolean
  }> {
    assert(
      receipt.request_hash === requestHash,
      new HttpError(409, "idempotency_conflict", "Recovery ID was used with different content"),
    )
    const vault = vaultState(this.sql)
    assert(vault, new HttpError(409, "not_claimed", "This deployment has not been claimed"))
    return reply({
      vaultId: vault.vault_id,
      deviceId: receipt.device_id,
      recoveredAt: receipt.recovered_at,
      recoveryStateId: receipt.recovery_state_id,
      duplicate: true,
    })
  }

  private async ensureRecoveryStateId(vault: VaultStateRow): Promise<string> {
    if (vault.recovery_state_id) return vault.recovery_state_id
    const computed = base64UrlEncode(
      await computeRecoveryStateId(
        vaultId(base64UrlDecode(vault.vault_id, 16)),
        base64UrlDecode(vault.recovery_package, MAX_RECOVERY_PACKAGE_BYTES),
      ),
    )
    return this.transactionSync(() => {
      const current = vaultState(this.sql)
      assert(current, new HttpError(409, "not_claimed", "This deployment has not been claimed"))
      if (current.recovery_state_id) return current.recovery_state_id
      this.sql.exec(
        "UPDATE vault_state SET recovery_state_id = ? WHERE singleton = 1 AND recovery_state_id IS NULL",
        computed,
      )
      return computed
    })
  }
}

async function recoveryRequestHash(input: RecoveryClaim): Promise<string> {
  return base64UrlEncode(
    await sha256(
      encodeCanonical({
        domain: "meridian/v1/recovery-receipt",
        claimVersion: input.claimVersion ?? 0,
        recoveryId: input.recoveryId ?? "",
        previousRecoveryStateId: input.previousRecoveryStateId ?? "",
        challengeId: input.challengeId,
        newDevice: {
          deviceId: input.newDevice.deviceId,
          signingPublicKey: input.newDevice.signingPublicKey,
          hpkePublicKey: input.newDevice.hpkePublicKey,
          certificate: input.newDevice.certificate,
        },
        encryptedRecoveryPackage: input.encryptedRecoveryPackage,
        proof: input.proof,
      }),
    ),
  )
}
