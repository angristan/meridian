import {
  consumePairingEpochPackage,
  createPairingDeviceRequest,
  createPendingPairingDevice,
  deserializePairingPackage,
  preparePairingEpochPackage,
  serializePairingPackage,
  sha256,
  sign,
} from "@meridian/crypto"
import {
  bytesToHex,
  decodeDeviceCertificate,
  deviceId,
  ed25519PrivateKey,
  ed25519PublicKey,
  ed25519Signature,
  encodeDeviceCertificate,
  pairingApprovalRequestSigningBytes,
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
  PairingJoinMaterial,
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
  readonly requestProof: string
}

interface PendingPairingSecret extends CandidatePackage {
  readonly signingPrivateKey: string
  readonly hpkePrivateKey: string
}

export async function createPairingJoin(pairing: PairingCapability): Promise<PairingJoinMaterial> {
  const pending = await createPendingPairingDevice()
  const request = createPairingDeviceRequest(
    pairingId(fromBase64Url(pairing.pairingId)),
    vaultId(fromBase64Url(pairing.vaultId)),
    pending,
  )
  const candidate: CandidatePackage = {
    pairingId: pairing.pairingId,
    vaultId: pairing.vaultId,
    expiresAt: pairing.expiresAt,
    deviceId: toBase64Url(pending.deviceId),
    signingPublicKey: toBase64Url(pending.signingPublicKey),
    hpkePublicKey: toBase64Url(pending.hpkePublicKey),
    requestProof: toBase64Url(request.proofOfPossession),
  }
  const workerProof = sign(
    pairingJoinRequestSigningBytes({
      vaultId: pairing.vaultId,
      pairingId: pairing.pairingId,
      deviceId: candidate.deviceId,
      signingPublicKey: candidate.signingPublicKey,
      hpkePublicKey: candidate.hpkePublicKey,
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
      },
      proof: toBase64Url(workerProof),
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
    proofOfPossession: ed25519Signature(fromBase64Url(candidate.requestProof)),
  }
  const chain = certificates.map((value) => decodeDeviceCertificate(fromBase64Url(value)))
  const ownId = bytesToHex(bundle.certificate.body.certificateId)
  const authorizationChain = [
    bundle.certificate,
    ...chain.filter((certificate) => bytesToHex(certificate.body.certificateId) !== ownId),
  ]
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
  const certificate = encodeDeviceCertificate(prepared.package.context.certificate)
  const transcriptHash = toBase64Url(await sha256(transfer))
  const unsigned = {
    certificate: toBase64Url(certificate),
    transcriptHash,
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
    payload: { ...unsigned, approvalSignature: toBase64Url(approvalSignature) },
    verificationPhrase: prepared.verificationPhrase,
  }
}

export async function consumePairingResult(
  pendingSecret: string,
  hpkeTransfer: string,
  confirmedPhrase: string,
): Promise<PairedDeviceMaterial> {
  const pending = parsePendingSecret(pendingSecret)
  const packageValue = deserializePairingPackage(fromBase64Url(hpkeTransfer))
  const bundle = await consumePairingEpochPackage({
    pending: {
      deviceId: deviceId(fromBase64Url(pending.deviceId)),
      signingPrivateKey: ed25519PrivateKey(fromBase64Url(pending.signingPrivateKey)),
      signingPublicKey: ed25519PublicKey(fromBase64Url(pending.signingPublicKey)),
      hpkePrivateKey: x25519PrivateKey(fromBase64Url(pending.hpkePrivateKey)),
      hpkePublicKey: x25519PublicKey(fromBase64Url(pending.hpkePublicKey)),
    },
    package: packageValue,
    confirmedVerificationPhrase: confirmedPhrase,
    now: Date.now(),
  })
  return {
    vaultId: toBase64Url(bundle.vaultId),
    deviceId: toBase64Url(bundle.deviceId),
    keyBundle: serializeStoredDeviceSecret(bundle, packageValue.context.recoveryPublicKey),
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
