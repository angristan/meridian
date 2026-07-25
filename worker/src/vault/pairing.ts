import {
  IDENTIFIER_BYTES,
  pairingCandidateConfirmationSigningBytes,
  pairingCompletionSigningBytes,
} from "@meridian/protocol"
import {
  assertIdentifier,
  base64UrlDecode,
  base64UrlEncode,
  hashToken,
  randomToken,
  sha256,
  verifyEd25519,
} from "../encoding"
import { assert, HttpError } from "../errors"
import {
  CreatePairingSchema,
  DeviceDescriptorSchema,
  PairingApprovalSchema,
  PairingCancelSchema,
  PairingCandidateConfirmationSchema,
  PairingJoinSchema,
  PairingReleaseSchema,
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
const MAX_DEVICE_NAME_LENGTH = 80
const MAX_PLATFORM_LENGTH = 32

type PairingState =
  | "pending"
  | "joined"
  | "verifying"
  | "confirmed"
  | "released"
  | "completed"
  | "canceled"

type PairingRow = {
  pairing_id: string
  capability_hash: string
  initiator_device_id: string
  status: PairingState
  created_at: number
  expires_at: number
  candidate_device_id: string | null
  candidate_signing_public_key: string | null
  candidate_hpke_public_key: string | null
  candidate_device_name: string | null
  candidate_platform: string | null
  candidate_proof: string | null
  candidate_request_proof: string | null
  joined_at: number | null
  certificate: string | null
  transcript_hash: string | null
  verification_preview: string | null
  approval_signature: string | null
  hpke_transfer: string | null
  verification_started_at: number | null
  initiator_confirmed_at: number | null
  candidate_confirmed_at: number | null
  candidate_confirmation_signature: string | null
  completion_signature: string | null
  completed_at: number | null
  canceled_at: number | null
  canceled_by: string | null
}

function validateDescriptor(value: string, maximum: number, field: string): string {
  const normalized = value.trim()
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
  assert(
    normalized.length > 0 && normalized.length <= maximum && !hasControlCharacter,
    new HttpError(400, "invalid_device_descriptor", `${field} is invalid`),
  )
  return normalized
}

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
        deviceName: device.device_name,
        platform: device.platform,
      }))
    return json({ devices })
  }

  async updateDeviceDescriptor(request: Request): Promise<Response> {
    const session = await authenticate(this.sql, request)
    const input = decode(DeviceDescriptorSchema, await requestJson(request))
    const deviceName = validateDescriptor(input.deviceName, MAX_DEVICE_NAME_LENGTH, "deviceName")
    const platform = validateDescriptor(input.platform, MAX_PLATFORM_LENGTH, "platform")
    const updated = this.sql.exec(
      `UPDATE devices SET device_name = ?, platform = ?
       WHERE device_id = ? AND revoked_at IS NULL`,
      deviceName,
      platform,
      session.deviceId,
    )
    assert(updated.rowsWritten === 1, new HttpError(404, "device_not_found", "Device not found"))
    return json({ deviceId: session.deviceId, deviceName, platform })
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
    const pairingId = randomToken(IDENTIFIER_BYTES)
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

  async pairingStatus(request: Request, pairingId: string): Promise<Response> {
    assertIdentifier(pairingId, "pairingId")
    const session = await authenticate(this.sql, request)
    const row = this.sql
      .exec<PairingRow>("SELECT * FROM pairings WHERE pairing_id = ?", pairingId)
      .toArray()[0]
    assert(row, new HttpError(404, "pairing_not_found", "Pairing request does not exist"))
    assert(
      row.initiator_device_id === session.deviceId,
      new HttpError(403, "wrong_initiator", "Pairing belongs to another device"),
    )
    this.assertCurrent(row)

    const candidate = this.candidatePackage(row, session.vaultId)
    return json({
      pairingId,
      status: row.status,
      expiresAt: row.expires_at,
      requestedAt: row.joined_at,
      ownerConfirmed: row.initiator_confirmed_at !== null,
      candidateConfirmed: row.candidate_confirmed_at !== null,
      candidateConfirmation:
        row.candidate_confirmation_signature && row.transcript_hash
          ? { transferHash: row.transcript_hash, proof: row.candidate_confirmation_signature }
          : undefined,
      relayAvailable: candidate !== undefined,
      ...(candidate === undefined ? {} : { candidate }),
    })
  }

  async pairingProgress(request: Request, pairingId: string): Promise<Response> {
    assertIdentifier(pairingId, "pairingId")
    const input = decode(PairingResultSchema, await requestJson(request))
    const capabilityHash = await hashToken(input.capability)
    const row = this.sql
      .exec<PairingRow>(
        "SELECT * FROM pairings WHERE pairing_id = ? AND capability_hash = ?",
        pairingId,
        capabilityHash,
      )
      .toArray()[0]
    assert(row, new HttpError(404, "pairing_not_found", "Pairing capability is invalid"))
    this.assertCurrent(row)
    return json({
      pairingId,
      status: row.status,
      expiresAt: row.expires_at,
      ownerConfirmed: row.initiator_confirmed_at !== null,
      candidateConfirmed: row.candidate_confirmed_at !== null,
    })
  }

  async joinPairing(request: Request, pairingId: string): Promise<Response> {
    assertIdentifier(pairingId, "pairingId")
    const join = decode(PairingJoinSchema, await requestJson(request))
    assertIdentifier(join.device.deviceId, "deviceId")
    validatePublicKey(join.device.signingPublicKey, "signingPublicKey")
    validatePublicKey(join.device.hpkePublicKey, "hpkePublicKey")
    validateSignature(join.proof)
    validateSignature(join.requestProof)
    const deviceName = validateDescriptor(
      join.device.deviceName,
      MAX_DEVICE_NAME_LENGTH,
      "deviceName",
    )
    const platform = validateDescriptor(join.device.platform, MAX_PLATFORM_LENGTH, "platform")
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
        candidate_hpke_public_key = ?, candidate_device_name = ?, candidate_platform = ?,
        candidate_proof = ?, candidate_request_proof = ?, joined_at = ?
       WHERE pairing_id = ? AND capability_hash = ? AND status = 'pending' AND expires_at > ?`,
      join.device.deviceId,
      join.device.signingPublicKey,
      join.device.hpkePublicKey,
      deviceName,
      platform,
      join.proof,
      join.requestProof,
      now,
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
    validateOpaqueData(approval.verificationPreview, MAX_HPKE_TRANSFER_BYTES, "verificationPreview")

    const now = Date.now()
    const pairing = this.sql
      .exec<PairingRow>(
        "SELECT * FROM pairings WHERE pairing_id = ? AND expires_at > ?",
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
    assert(
      pairing.candidate_device_id !== null &&
        pairing.candidate_signing_public_key !== null &&
        pairing.candidate_hpke_public_key !== null &&
        pairing.candidate_device_name !== null &&
        pairing.candidate_platform !== null,
      new HttpError(409, "candidate_incomplete", "Joining device identity is incomplete"),
    )
    assert(
      activeDevice(this.sql, session.deviceId),
      new HttpError(401, "device_revoked", "Approving device is no longer active"),
    )
    const updated = this.sql.exec(
      `UPDATE pairings SET status = 'verifying', certificate = ?, transcript_hash = ?,
        verification_preview = ?, verification_started_at = ?
       WHERE pairing_id = ? AND status = 'joined' AND expires_at > ?`,
      approval.certificate,
      approval.transcriptHash,
      approval.verificationPreview,
      now,
      pairingId,
      now,
    )
    assert(updated.rowsWritten === 1, new HttpError(409, "pairing_changed", "Pairing changed"))
    return json({ pairingId, deviceId: pairing.candidate_device_id, status: "verifying" })
  }

  async releasePairing(request: Request, pairingId: string): Promise<Response> {
    assertIdentifier(pairingId, "pairingId")
    const session = await authenticate(this.sql, request)
    const release = decode(PairingReleaseSchema, await requestJson(request))
    validateSignature(release.approvalSignature)
    validateOpaqueData(release.hpkeTransfer, MAX_HPKE_TRANSFER_BYTES, "hpkeTransfer")
    const row = this.pairingRow(pairingId)
    this.assertCurrent(row)
    if (row.status === "released" || row.status === "completed") {
      return json({ pairingId, status: row.status })
    }
    assert(
      row.initiator_device_id === session.deviceId && row.status === "confirmed",
      new HttpError(409, "pairing_not_confirmed", "Both devices must confirm before release"),
    )
    assert(
      row.certificate !== null &&
        row.transcript_hash !== null &&
        row.verification_preview !== null &&
        row.candidate_device_id !== null &&
        row.candidate_signing_public_key !== null &&
        row.candidate_hpke_public_key !== null,
      new HttpError(409, "pairing_incomplete", "Pairing verification material is incomplete"),
    )
    const computedTransferHash = base64UrlEncode(
      await sha256(base64UrlDecode(release.hpkeTransfer, MAX_HPKE_TRANSFER_BYTES)),
    )
    assert(
      computedTransferHash === row.transcript_hash,
      new HttpError(400, "invalid_transcript_hash", "Pairing transfer hash does not match"),
    )
    const signer = activeDevice(this.sql, session.deviceId)
    assert(signer, new HttpError(401, "device_revoked", "Approving device is no longer active"))
    const validApproval = await verifyEd25519(
      signer.signing_public_key,
      release.approvalSignature,
      pairingApprovalSigningMessage(
        session.vaultId,
        pairingId,
        {
          device_id: row.candidate_device_id,
          signing_public_key: row.candidate_signing_public_key,
          hpke_public_key: row.candidate_hpke_public_key,
        },
        {
          certificate: row.certificate,
          transcriptHash: row.transcript_hash,
          verificationPreview: row.verification_preview,
          ...release,
        },
      ),
    )
    assert(validApproval, new HttpError(401, "invalid_signature", "Transfer release is invalid"))
    const updated = this.sql.exec(
      `UPDATE pairings SET status = 'released', approval_signature = ?, hpke_transfer = ?
       WHERE pairing_id = ? AND status = 'confirmed'`,
      release.approvalSignature,
      release.hpkeTransfer,
      pairingId,
    )
    assert(updated.rowsWritten === 1, new HttpError(409, "pairing_changed", "Pairing changed"))
    return json({ pairingId, status: "released" })
  }

  async pairingResult(request: Request, pairingId: string): Promise<Response> {
    assertIdentifier(pairingId, "pairingId")
    const input = decode(PairingResultSchema, await requestJson(request))
    const capabilityHash = await hashToken(input.capability)
    const row = this.sql
      .exec<PairingRow>(
        "SELECT * FROM pairings WHERE pairing_id = ? AND capability_hash = ?",
        pairingId,
        capabilityHash,
      )
      .toArray()[0]
    assert(row, new HttpError(404, "pairing_not_found", "Pairing capability is invalid"))
    this.assertCurrent(row)
    if (row.status === "verifying" || row.status === "confirmed") {
      return json({
        pairingId,
        status: row.status,
        transcriptHash: row.transcript_hash,
        verificationPreview: row.verification_preview,
      })
    }
    if (row.status !== "released" && row.status !== "completed") {
      return json({ pairingId, status: row.status })
    }
    return json({
      pairingId,
      status: row.status,
      deviceId: row.candidate_device_id,
      certificate: row.certificate,
      transcriptHash: row.transcript_hash,
      verificationPreview: row.verification_preview,
      approvalSignature: row.approval_signature,
      hpkeTransfer: row.hpke_transfer,
      verificationStartedAt: row.verification_started_at,
    })
  }

  async confirmOwner(request: Request, pairingId: string): Promise<Response> {
    assertIdentifier(pairingId, "pairingId")
    await requestJson(request)
    const session = await authenticate(this.sql, request)
    const row = this.pairingRow(pairingId)
    this.assertCurrent(row)
    assert(
      row.initiator_device_id === session.deviceId,
      new HttpError(403, "wrong_initiator", "Pairing belongs to another device"),
    )
    assert(
      row.status === "verifying" ||
        row.status === "confirmed" ||
        row.status === "released" ||
        row.status === "completed",
      new HttpError(409, "pairing_not_verifying", "Pairing is not ready for verification"),
    )
    if (row.status === "released" || row.status === "completed") {
      return json({ pairingId, status: row.status })
    }
    const now = Date.now()
    this.sql.exec(
      "UPDATE pairings SET initiator_confirmed_at = COALESCE(initiator_confirmed_at, ?) WHERE pairing_id = ?",
      now,
      pairingId,
    )
    const status = this.promoteConfirmed(pairingId)
    return json({ pairingId, status })
  }

  async confirmCandidate(request: Request, pairingId: string): Promise<Response> {
    assertIdentifier(pairingId, "pairingId")
    const input = decode(PairingCandidateConfirmationSchema, await requestJson(request))
    const row = await this.capabilityRow(pairingId, input.capability)
    this.assertCurrent(row)
    assert(
      row.status === "verifying" ||
        row.status === "confirmed" ||
        row.status === "released" ||
        row.status === "completed",
      new HttpError(409, "pairing_not_verifying", "Pairing is not ready for verification"),
    )
    if (row.status === "released" || row.status === "completed") {
      return json({ pairingId, status: row.status })
    }
    this.assertCandidateConfirmation(row, input.transferHash)
    validateSignature(input.proof)
    const vault = vaultState(this.sql)
    assert(vault, new HttpError(409, "not_claimed", "This deployment has not been claimed"))
    const valid = await verifyEd25519(
      row.candidate_signing_public_key as string,
      input.proof,
      pairingCandidateConfirmationSigningBytes({
        vaultId: vault.vault_id,
        pairingId,
        candidateDeviceId: row.candidate_device_id as string,
        transferHash: input.transferHash,
      }),
    )
    assert(valid, new HttpError(401, "invalid_proof", "Candidate confirmation is invalid"))
    this.sql.exec(
      `UPDATE pairings SET candidate_confirmed_at = COALESCE(candidate_confirmed_at, ?),
        candidate_confirmation_signature = COALESCE(candidate_confirmation_signature, ?)
       WHERE pairing_id = ?`,
      Date.now(),
      input.proof,
      pairingId,
    )
    const status = this.promoteConfirmed(pairingId)
    return json({ pairingId, status })
  }

  async completePairing(request: Request, pairingId: string): Promise<Response> {
    assertIdentifier(pairingId, "pairingId")
    const input = decode(PairingCandidateConfirmationSchema, await requestJson(request))
    const row = await this.capabilityRow(pairingId, input.capability)
    this.assertCurrent(row)
    if (row.status === "completed") return json({ pairingId, status: row.status })
    assert(
      row.status === "released",
      new HttpError(409, "pairing_not_released", "Encrypted pairing transfer is not released"),
    )
    this.assertCandidateConfirmation(row, input.transferHash)
    validateSignature(input.proof)
    const vault = vaultState(this.sql)
    assert(vault, new HttpError(409, "not_claimed", "This deployment has not been claimed"))
    const valid = await verifyEd25519(
      row.candidate_signing_public_key as string,
      input.proof,
      pairingCompletionSigningBytes({
        vaultId: vault.vault_id,
        pairingId,
        candidateDeviceId: row.candidate_device_id as string,
        transferHash: input.transferHash,
      }),
    )
    assert(valid, new HttpError(401, "invalid_proof", "Pairing completion proof is invalid"))

    const now = Date.now()
    this.transactionSync(() => {
      const fresh = this.pairingRow(pairingId)
      assert(
        fresh.status === "released",
        new HttpError(409, "pairing_changed", "Pairing request changed"),
      )
      this.sql.exec(
        `INSERT INTO devices(
          device_id, signing_public_key, hpke_public_key, certificate, role, authorized_at,
          authorized_by, device_name, platform
        ) VALUES (?, ?, ?, ?, 'member', ?, ?, ?, ?)`,
        fresh.candidate_device_id,
        fresh.candidate_signing_public_key,
        fresh.candidate_hpke_public_key,
        fresh.certificate,
        now,
        fresh.initiator_device_id,
        fresh.candidate_device_name,
        fresh.candidate_platform,
      )
      this.sql.exec(
        `UPDATE pairings SET status = 'completed', completion_signature = ?, completed_at = ?
         WHERE pairing_id = ? AND status = 'released'`,
        input.proof,
        now,
        pairingId,
      )
    })
    return json({ pairingId, status: "completed", deviceId: row.candidate_device_id })
  }

  async cancelPairing(request: Request, pairingId: string): Promise<Response> {
    assertIdentifier(pairingId, "pairingId")
    const input = decode(PairingCancelSchema, await requestJson(request))
    const row = await this.capabilityRow(pairingId, input.capability)
    this.assertCurrent(row)
    this.cancel(row, "candidate")
    return json({ pairingId, status: "canceled" })
  }

  async rejectPairing(request: Request, pairingId: string): Promise<Response> {
    assertIdentifier(pairingId, "pairingId")
    await requestJson(request)
    const session = await authenticate(this.sql, request)
    const row = this.pairingRow(pairingId)
    this.assertCurrent(row)
    assert(
      row.initiator_device_id === session.deviceId,
      new HttpError(403, "wrong_initiator", "Pairing belongs to another device"),
    )
    this.cancel(row, "initiator")
    return json({ pairingId, status: "canceled" })
  }

  private cancel(row: PairingRow, canceledBy: "candidate" | "initiator"): void {
    if (row.status === "canceled") return
    assert(
      row.status === "pending" ||
        row.status === "joined" ||
        row.status === "verifying" ||
        row.status === "confirmed",
      new HttpError(
        409,
        "pairing_already_confirmed",
        "Pairing can no longer be canceled; revoke the device if needed",
      ),
    )
    this.sql.exec(
      `UPDATE pairings SET status = 'canceled', canceled_at = ?, canceled_by = ?,
        certificate = NULL, verification_preview = NULL, hpke_transfer = NULL
       WHERE pairing_id = ?`,
      Date.now(),
      canceledBy,
      row.pairing_id,
    )
  }

  private promoteConfirmed(pairingId: string): PairingState {
    const row = this.pairingRow(pairingId)
    if (
      row.status === "verifying" &&
      row.initiator_confirmed_at !== null &&
      row.candidate_confirmed_at !== null
    ) {
      this.sql.exec("UPDATE pairings SET status = 'confirmed' WHERE pairing_id = ?", pairingId)
      return "confirmed"
    }
    return row.status
  }

  private assertCandidateConfirmation(row: PairingRow, transferHash: string): void {
    validateOpaqueData(transferHash, 64, "transferHash")
    assert(
      row.transcript_hash === transferHash &&
        row.candidate_device_id !== null &&
        row.candidate_signing_public_key !== null,
      new HttpError(400, "pairing_context_mismatch", "Pairing confirmation does not match"),
    )
  }

  private pairingRow(pairingId: string): PairingRow {
    const row = this.sql
      .exec<PairingRow>("SELECT * FROM pairings WHERE pairing_id = ?", pairingId)
      .toArray()[0]
    assert(row, new HttpError(404, "pairing_not_found", "Pairing request does not exist"))
    return row
  }

  private async capabilityRow(pairingId: string, capability: string): Promise<PairingRow> {
    const row = this.sql
      .exec<PairingRow>(
        "SELECT * FROM pairings WHERE pairing_id = ? AND capability_hash = ?",
        pairingId,
        await hashToken(capability),
      )
      .toArray()[0]
    assert(row, new HttpError(404, "pairing_not_found", "Pairing capability is invalid"))
    return row
  }

  private assertCurrent(row: PairingRow): void {
    assert(
      row.expires_at > Date.now(),
      new HttpError(410, "pairing_expired", "Pairing request expired"),
    )
  }

  private candidatePackage(
    row: PairingRow,
    vaultIdValue: string,
  ): Record<string, unknown> | undefined {
    if (
      row.candidate_device_id === null ||
      row.candidate_signing_public_key === null ||
      row.candidate_hpke_public_key === null ||
      row.candidate_device_name === null ||
      row.candidate_platform === null ||
      row.candidate_request_proof === null
    ) {
      return undefined
    }
    return {
      pairingId: row.pairing_id,
      vaultId: vaultIdValue,
      expiresAt: row.expires_at,
      deviceId: row.candidate_device_id,
      signingPublicKey: row.candidate_signing_public_key,
      hpkePublicKey: row.candidate_hpke_public_key,
      deviceName: row.candidate_device_name,
      platform: row.candidate_platform,
      requestProof: row.candidate_request_proof,
    }
  }
}
