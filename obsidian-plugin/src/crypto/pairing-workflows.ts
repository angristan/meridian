import {
  consumePairingEpochPackage,
  createPairingDeviceRequest,
  createPendingPairingDevice,
  deserializePairingPackage,
  deserializePairingVerificationPreview,
  inspectPairingVerificationPreview,
  preparePairingEpochPackage,
  serializePairingPackage,
  serializePairingVerificationPreview,
  sha256,
  sign,
  verify,
} from "@meridian/crypto"
import {
  bytesToHex,
  type DeviceCertificate,
  decodeDeviceCertificate,
  deviceId,
  ed25519PrivateKey,
  ed25519PublicKey,
  ed25519Signature,
  encodeDeviceCertificate,
  hashBytes,
  pairingApprovalRequestSigningBytes,
  pairingCandidateConfirmationSigningBytes,
  pairingCompletionSigningBytes,
  pairingId,
  pairingJoinRequestSigningBytes,
  vaultId,
  x25519PrivateKey,
  x25519PublicKey,
} from "@meridian/protocol"
import type {
  DeviceKeyMaterial,
  PairedDeviceMaterial,
  PairingApprovalMaterial,
  PairingCapability,
  PairingConfirmationMaterial,
  PairingDeviceDescriptor,
  PairingJoinMaterial,
  PairingVerificationMaterial,
} from "../model"
import { fromBase64Url, toBase64Url } from "../platform/bytes"
import { deviceBundle, parseStoredSecret, serializeStoredDeviceSecret } from "./device-secret"

interface CandidatePackage {
  readonly pairingId: string
  readonly vaultId: string
  readonly expiresAt: number
  readonly deviceId: string
  readonly signingPublicKey: string
  readonly hpkePublicKey: string
  readonly deviceName: string
  readonly platform: string
  readonly requestProof: string
}

interface PendingPairingSecret extends CandidatePackage {
  readonly signingPrivateKey: string
  readonly hpkePrivateKey: string
}

export async function createPairingJoin(
  pairing: PairingCapability,
  descriptor: PairingDeviceDescriptor,
): Promise<PairingJoinMaterial> {
  const pending = await createPendingPairingDevice()
  const request = createPairingDeviceRequest(
    pairingId(fromBase64Url(pairing.pairingId)),
    vaultId(fromBase64Url(pairing.vaultId)),
    pending,
    descriptor,
  )
  const candidate: CandidatePackage = {
    pairingId: pairing.pairingId,
    vaultId: pairing.vaultId,
    expiresAt: pairing.expiresAt,
    deviceId: toBase64Url(pending.deviceId),
    signingPublicKey: toBase64Url(pending.signingPublicKey),
    hpkePublicKey: toBase64Url(pending.hpkePublicKey),
    deviceName: request.deviceName,
    platform: request.platform,
    requestProof: toBase64Url(request.proofOfPossession),
  }
  const workerProof = sign(
    pairingJoinRequestSigningBytes({
      vaultId: pairing.vaultId,
      pairingId: pairing.pairingId,
      deviceId: candidate.deviceId,
      signingPublicKey: candidate.signingPublicKey,
      hpkePublicKey: candidate.hpkePublicKey,
      deviceName: candidate.deviceName,
      platform: candidate.platform,
    }),
    pending.signingPrivateKey,
  )
  const secret: PendingPairingSecret = {
    ...candidate,
    signingPrivateKey: toBase64Url(pending.signingPrivateKey),
    hpkePrivateKey: toBase64Url(pending.hpkePrivateKey),
  }
  return {
    payload: {
      capability: pairing.capability,
      device: {
        deviceId: candidate.deviceId,
        signingPublicKey: candidate.signingPublicKey,
        hpkePublicKey: candidate.hpkePublicKey,
        deviceName: candidate.deviceName,
        platform: candidate.platform,
      },
      proof: toBase64Url(workerProof),
      requestProof: candidate.requestProof,
    },
    candidatePackage: JSON.stringify(candidate),
    pendingSecret: JSON.stringify(secret),
  }
}

export async function approvePairing(
  device: DeviceKeyMaterial,
  candidatePackage: string,
  certificates: string[],
): Promise<PairingApprovalMaterial> {
  const candidate = parseCandidatePackage(candidatePackage)
  const bundle = deviceBundle(device)
  const request = {
    pairingId: pairingId(fromBase64Url(candidate.pairingId)),
    vaultId: vaultId(fromBase64Url(candidate.vaultId)),
    deviceId: deviceId(fromBase64Url(candidate.deviceId)),
    signingPublicKey: ed25519PublicKey(fromBase64Url(candidate.signingPublicKey)),
    hpkePublicKey: x25519PublicKey(fromBase64Url(candidate.hpkePublicKey)),
    deviceName: candidate.deviceName,
    platform: candidate.platform,
    proofOfPossession: ed25519Signature(fromBase64Url(candidate.requestProof)),
  }
  const authorizationChain = exactAuthorizationChain(bundle.certificate, certificates)
  const secret = parseStoredSecret(device.serialized)
  if (!secret.recoveryPublicKey) {
    throw new Error("The local key bundle has no recovery trust anchor")
  }
  const prepared = await preparePairingEpochPackage({
    approver: bundle,
    request,
    recoveryPublicKey: ed25519PublicKey(fromBase64Url(secret.recoveryPublicKey)),
    authorizationChain,
    expiresAt: candidate.expiresAt,
  })
  const transfer = serializePairingPackage(prepared.package)
  const verificationPreview = serializePairingVerificationPreview(prepared.preview)
  const certificate = encodeDeviceCertificate(prepared.package.context.certificate)
  const transcriptHash = toBase64Url(await sha256(transfer))
  const verificationPayload = {
    certificate: toBase64Url(certificate),
    transcriptHash,
    verificationPreview: toBase64Url(verificationPreview),
  }
  const releasePayload = {
    hpkeTransfer: toBase64Url(transfer),
  }
  const approvalSignature = sign(
    pairingApprovalRequestSigningBytes({
      vaultId: candidate.vaultId,
      pairingId: candidate.pairingId,
      candidateDeviceId: candidate.deviceId,
      candidateSigningPublicKey: candidate.signingPublicKey,
      candidateHpkePublicKey: candidate.hpkePublicKey,
      certificate,
      transcriptHash,
      hpkeTransfer: transfer,
    }),
    bundle.signingPrivateKey,
  )
  return {
    payload: verificationPayload,
    releasePayload: { ...releasePayload, approvalSignature: toBase64Url(approvalSignature) },
    verificationPhrase: prepared.verificationPhrase,
    transferHash: transcriptHash,
  }
}

function exactAuthorizationChain(
  approver: DeviceCertificate,
  encodedRegistry: string[],
): DeviceCertificate[] {
  if (approver.body.issuer.kind === "recovery") return [approver]

  const registry = new Map<string, DeviceCertificate>()
  for (const encoded of encodedRegistry) {
    try {
      const certificate = decodeDeviceCertificate(fromBase64Url(encoded))
      registry.set(bytesToHex(certificate.body.certificateId), certificate)
    } catch {
      // Unrelated malformed registry history is not part of the approver's issuer path.
    }
  }
  registry.set(bytesToHex(approver.body.certificateId), approver)

  const chain: DeviceCertificate[] = []
  const visited = new Set<string>()
  let current = approver
  while (true) {
    const currentId = bytesToHex(current.body.certificateId)
    if (visited.has(currentId)) throw new Error("Approver certificate chain contains a cycle")
    visited.add(currentId)
    chain.push(current)
    if (current.body.issuer.kind === "recovery") return chain

    const issuerId = bytesToHex(current.body.issuer.certificateId)
    const issuer = registry.get(issuerId)
    if (!issuer) throw new Error("Approver certificate chain is incomplete")
    current = issuer
  }
}

export async function inspectPairingVerification(
  pendingSecret: string,
  verificationPreview: string,
): Promise<PairingVerificationMaterial> {
  const pending = parsePendingSecret(pendingSecret)
  const inspected = await inspectPairingVerificationPreview(
    pendingDevice(pending),
    deserializePairingVerificationPreview(fromBase64Url(verificationPreview)),
    Date.now(),
  )
  return {
    verificationPhrase: inspected.verificationPhrase,
    transferHash: toBase64Url(inspected.transferHash),
  }
}

export async function createPairingConfirmation(
  pendingSecret: string,
  transferHash: string,
): Promise<PairingConfirmationMaterial> {
  const pending = parsePendingSecret(pendingSecret)
  return {
    transferHash,
    proof: toBase64Url(
      sign(
        pairingCandidateConfirmationSigningBytes({
          vaultId: pending.vaultId,
          pairingId: pending.pairingId,
          candidateDeviceId: pending.deviceId,
          transferHash,
        }),
        ed25519PrivateKey(fromBase64Url(pending.signingPrivateKey)),
      ),
    ),
  }
}

export async function verifyPairingConfirmation(
  candidatePackage: string,
  confirmation: PairingConfirmationMaterial,
): Promise<boolean> {
  const candidate = parseCandidatePackage(candidatePackage)
  return verify(
    pairingCandidateConfirmationSigningBytes({
      vaultId: candidate.vaultId,
      pairingId: candidate.pairingId,
      candidateDeviceId: candidate.deviceId,
      transferHash: confirmation.transferHash,
    }),
    ed25519Signature(fromBase64Url(confirmation.proof)),
    ed25519PublicKey(fromBase64Url(candidate.signingPublicKey)),
  )
}

export async function consumePairingResult(
  pendingSecret: string,
  hpkeTransfer: string,
  confirmedPhrase: string,
  expectedTransferHash: string,
): Promise<PairedDeviceMaterial> {
  const pending = parsePendingSecret(pendingSecret)
  const packageValue = deserializePairingPackage(fromBase64Url(hpkeTransfer))
  const bundle = await consumePairingEpochPackage({
    pending: pendingDevice(pending),
    package: packageValue,
    expectedTransferHash: hashBytes(fromBase64Url(expectedTransferHash)),
    confirmedVerificationPhrase: confirmedPhrase,
    now: Date.now(),
  })
  const completion = {
    transferHash: expectedTransferHash,
    proof: toBase64Url(
      sign(
        pairingCompletionSigningBytes({
          vaultId: pending.vaultId,
          pairingId: pending.pairingId,
          candidateDeviceId: pending.deviceId,
          transferHash: expectedTransferHash,
        }),
        ed25519PrivateKey(fromBase64Url(pending.signingPrivateKey)),
      ),
    ),
  }
  return {
    vaultId: toBase64Url(bundle.vaultId),
    deviceId: toBase64Url(bundle.deviceId),
    keyBundle: serializeStoredDeviceSecret(
      bundle,
      packageValue.context.recoveryPublicKey,
      packageValue.context.authorizationChain,
    ),
    completion,
  }
}

function pendingDevice(pending: PendingPairingSecret) {
  return {
    deviceId: deviceId(fromBase64Url(pending.deviceId)),
    signingPrivateKey: ed25519PrivateKey(fromBase64Url(pending.signingPrivateKey)),
    signingPublicKey: ed25519PublicKey(fromBase64Url(pending.signingPublicKey)),
    hpkePrivateKey: x25519PrivateKey(fromBase64Url(pending.hpkePrivateKey)),
    hpkePublicKey: x25519PublicKey(fromBase64Url(pending.hpkePublicKey)),
  }
}

function parseCandidatePackage(serialized: string): CandidatePackage {
  const value: unknown = JSON.parse(serialized)
  if (!isRecord(value)) throw new Error("Candidate package is invalid")
  return {
    pairingId: requireString(value, "pairingId"),
    vaultId: requireString(value, "vaultId"),
    expiresAt: requireNumber(value, "expiresAt"),
    deviceId: requireString(value, "deviceId"),
    signingPublicKey: requireString(value, "signingPublicKey"),
    hpkePublicKey: requireString(value, "hpkePublicKey"),
    deviceName: requireString(value, "deviceName"),
    platform: requireString(value, "platform"),
    requestProof: requireString(value, "requestProof"),
  }
}

function parsePendingSecret(serialized: string): PendingPairingSecret {
  const candidate = parseCandidatePackage(serialized)
  const value = JSON.parse(serialized) as Record<string, unknown>
  return {
    ...candidate,
    signingPrivateKey: requireString(value, "signingPrivateKey"),
    hpkePrivateKey: requireString(value, "hpkePrivateKey"),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireString(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== "string" || field.length === 0) throw new Error(`Value is missing ${key}`)
  return field
}

function requireNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key]
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    throw new Error(`Value is missing ${key}`)
  }
  return field
}
