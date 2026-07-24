import { assertIdentifier, hashToken, randomToken, verifyEd25519 } from "../encoding"
import { assert, HttpError } from "../errors"
import {
  CreatePairingSchema,
  PairingApprovalSchema,
  PairingJoinSchema,
  PairingResultSchema,
} from "../schemas"
import {
  activeDevice,
  authenticate,
  cleanupExpired,
  type DeviceRow,
  decode,
  json,
  MAX_CERTIFICATE_BYTES,
  MAX_HPKE_TRANSFER_BYTES,
  requestJson,
  type TransactionSync,
  validateOpaqueData,
  validatePublicKey,
  validateSignature,
  vaultState,
} from "./domain"
import { pairingApprovalSigningMessage, pairingJoinSigningMessage } from "./signing"

const PAIRING_MIN_TTL_SECONDS = 60
const PAIRING_MAX_TTL_SECONDS = 15 * 60
const DEFAULT_PAIRING_TTL_SECONDS = 5 * 60

export class VaultPairing {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transactionSync: TransactionSync,
  ) {}

  async listDevices(request: Request): Promise<Response> {
    await authenticate(this.sql, request)
    const devices = this.sql
      .exec<DeviceRow>("SELECT * FROM devices ORDER BY authorized_at, device_id")
      .toArray()
      .map((device) => ({
        deviceId: device.device_id,
        signingPublicKey: device.signing_public_key,
        hpkePublicKey: device.hpke_public_key,
        certificate: device.certificate,
        role: device.role,
        authorizedAt: device.authorized_at,
        authorizedBy: device.authorized_by,
        revokedAt: device.revoked_at,
        revokedOperationId: device.revoked_operation_id,
      }))
    return json({ devices })
  }

  async createPairing(request: Request): Promise<Response> {
    const session = await authenticate(this.sql, request)
    assert(
      session.role === "owner",
      new HttpError(403, "owner_required", "Only an owner device can add devices"),
    )
    const input = decode(CreatePairingSchema, await requestJson(request))
    const ttl = input.expiresInSeconds ?? DEFAULT_PAIRING_TTL_SECONDS
    assert(
      Number.isInteger(ttl) && ttl >= PAIRING_MIN_TTL_SECONDS && ttl <= PAIRING_MAX_TTL_SECONDS,
      new HttpError(400, "invalid_expiry", "Pairing expiry is outside the allowed range"),
    )
    const now = Date.now()
    cleanupExpired(this.sql, now)
    const pairingId = randomToken(18)
    const capability = randomToken()
    const expiresAt = now + ttl * 1_000
    this.sql.exec(
      `INSERT INTO pairings(pairing_id, capability_hash, initiator_device_id, status, created_at, expires_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
      pairingId,
      await hashToken(capability),
      session.deviceId,
      now,
      expiresAt,
    )
    return json({ pairingId, capability, vaultId: session.vaultId, expiresAt }, { status: 201 })
  }

  async joinPairing(request: Request, pairingId: string): Promise<Response> {
    assertIdentifier(pairingId, "pairingId")
    const join = decode(PairingJoinSchema, await requestJson(request))
    assertIdentifier(join.device.deviceId, "deviceId")
    validatePublicKey(join.device.signingPublicKey, "signingPublicKey")
    validatePublicKey(join.device.hpkePublicKey, "hpkePublicKey")
    validateSignature(join.proof)
    const vault = vaultState(this.sql)
    assert(vault, new HttpError(409, "not_claimed", "This deployment has not been claimed"))

    const capabilityHash = await hashToken(join.capability)
    const now = Date.now()
    const pairing = this.sql
      .exec<{ status: string }>(
        `SELECT status FROM pairings
         WHERE pairing_id = ? AND capability_hash = ? AND expires_at > ?`,
        pairingId,
        capabilityHash,
        now,
      )
      .toArray()[0]
    assert(
      pairing,
      new HttpError(404, "pairing_not_found", "Pairing request is invalid or expired"),
    )
    assert(
      pairing.status === "pending",
      new HttpError(409, "pairing_already_joined", "Pairing already has a candidate"),
    )
    assert(
      !activeDevice(this.sql, join.device.deviceId),
      new HttpError(409, "device_exists", "Device is already registered"),
    )

    const validProof = await verifyEd25519(
      join.device.signingPublicKey,
      join.proof,
      pairingJoinSigningMessage(vault.vault_id, pairingId, join),
    )
    assert(
      validProof,
      new HttpError(401, "invalid_proof", "Candidate proof of possession is invalid"),
    )

    const updated = this.sql.exec(
      `UPDATE pairings SET
        status = 'joined', candidate_device_id = ?, candidate_signing_public_key = ?,
        candidate_hpke_public_key = ?, candidate_proof = ?
       WHERE pairing_id = ? AND capability_hash = ? AND status = 'pending' AND expires_at > ?`,
      join.device.deviceId,
      join.device.signingPublicKey,
      join.device.hpkePublicKey,
      join.proof,
      pairingId,
      capabilityHash,
      now,
    )
    assert(
      updated.rowsWritten === 1,
      new HttpError(409, "pairing_changed", "Pairing request changed"),
    )
    return json({ pairingId, status: "joined" })
  }

  async approvePairing(request: Request, pairingId: string): Promise<Response> {
    assertIdentifier(pairingId, "pairingId")
    const session = await authenticate(this.sql, request)
    assert(
      session.role === "owner",
      new HttpError(403, "owner_required", "Only an owner device can add devices"),
    )
    const approval = decode(PairingApprovalSchema, await requestJson(request))
    validateOpaqueData(approval.certificate, MAX_CERTIFICATE_BYTES, "certificate")
    validateOpaqueData(approval.transcriptHash, 64, "transcriptHash")
    validateSignature(approval.approvalSignature)
    validateOpaqueData(approval.hpkeTransfer, MAX_HPKE_TRANSFER_BYTES, "hpkeTransfer")

    const now = Date.now()
    const pairing = this.sql
      .exec<{
        initiator_device_id: string
        status: string
        candidate_device_id: string
        candidate_signing_public_key: string
        candidate_hpke_public_key: string
      }>(
        `SELECT initiator_device_id, status, candidate_device_id,
                candidate_signing_public_key, candidate_hpke_public_key
         FROM pairings WHERE pairing_id = ? AND expires_at > ?`,
        pairingId,
        now,
      )
      .toArray()[0]
    assert(
      pairing,
      new HttpError(404, "pairing_not_found", "Pairing request is invalid or expired"),
    )
    assert(
      pairing.initiator_device_id === session.deviceId,
      new HttpError(403, "wrong_initiator", "Pairing belongs to another device"),
    )
    assert(
      pairing.status === "joined",
      new HttpError(409, "pairing_not_joined", "Pairing has no candidate to approve"),
    )
    const signer = activeDevice(this.sql, session.deviceId)
    assert(signer, new HttpError(401, "device_revoked", "Approving device is no longer active"))
    const candidate = {
      device_id: pairing.candidate_device_id,
      signing_public_key: pairing.candidate_signing_public_key,
      hpke_public_key: pairing.candidate_hpke_public_key,
    }
    const validApproval = await verifyEd25519(
      signer.signing_public_key,
      approval.approvalSignature,
      pairingApprovalSigningMessage(session.vaultId, pairingId, candidate, approval),
    )
    assert(
      validApproval,
      new HttpError(401, "invalid_signature", "Pairing approval signature is invalid"),
    )

    this.transactionSync(() => {
      const fresh = this.sql
        .exec<{ status: string }>(
          "SELECT status FROM pairings WHERE pairing_id = ? AND expires_at > ?",
          pairingId,
          Date.now(),
        )
        .toArray()[0]
      assert(
        fresh?.status === "joined",
        new HttpError(409, "pairing_changed", "Pairing request changed"),
      )
      this.sql.exec(
        `INSERT INTO devices(
          device_id, signing_public_key, hpke_public_key, certificate, role, authorized_at, authorized_by
        ) VALUES (?, ?, ?, ?, 'member', ?, ?)`,
        candidate.device_id,
        candidate.signing_public_key,
        candidate.hpke_public_key,
        approval.certificate,
        now,
        session.deviceId,
      )
      this.sql.exec(
        `UPDATE pairings SET status = 'approved', certificate = ?, transcript_hash = ?,
          approval_signature = ?, hpke_transfer = ?, approved_at = ?
         WHERE pairing_id = ?`,
        approval.certificate,
        approval.transcriptHash,
        approval.approvalSignature,
        approval.hpkeTransfer,
        now,
        pairingId,
      )
    })
    return json({ pairingId, deviceId: candidate.device_id, status: "approved" })
  }

  async pairingResult(request: Request, pairingId: string): Promise<Response> {
    assertIdentifier(pairingId, "pairingId")
    const input = decode(PairingResultSchema, await requestJson(request))
    const capabilityHash = await hashToken(input.capability)
    const row = this.sql
      .exec<{
        status: string
        candidate_device_id: string | null
        certificate: string | null
        transcript_hash: string | null
        approval_signature: string | null
        hpke_transfer: string | null
        approved_at: number | null
        result_consumed_at: number | null
        expires_at: number
      }>(
        "SELECT * FROM pairings WHERE pairing_id = ? AND capability_hash = ?",
        pairingId,
        capabilityHash,
      )
      .toArray()[0]
    assert(row, new HttpError(404, "pairing_not_found", "Pairing capability is invalid"))
    const now = Date.now()
    assert(row.expires_at > now, new HttpError(410, "pairing_expired", "Pairing expired"))
    if (row.status !== "approved") return json({ pairingId, status: row.status })
    assert(
      row.result_consumed_at === null,
      new HttpError(410, "pairing_result_consumed", "Pairing result was already retrieved"),
    )
    const consumed = this.sql.exec(
      "UPDATE pairings SET result_consumed_at = ? WHERE pairing_id = ? AND result_consumed_at IS NULL",
      now,
      pairingId,
    )
    assert(
      consumed.rowsWritten === 1,
      new HttpError(410, "pairing_result_consumed", "Pairing result was already retrieved"),
    )
    return json({
      pairingId,
      status: row.status,
      deviceId: row.candidate_device_id,
      certificate: row.certificate,
      transcriptHash: row.transcript_hash,
      approvalSignature: row.approval_signature,
      hpkeTransfer: row.hpke_transfer,
      approvedAt: row.approved_at,
    })
  }
}
