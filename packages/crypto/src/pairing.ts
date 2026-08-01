import {
  assertPairingDeviceMetadata,
  bytesEqual,
  bytesToHex,
  type CborValue,
  CIPHER_SUITE,
  certificateId,
  type DeviceCertificate,
  type DeviceId,
  decodeCanonical,
  decodePairingContextValue,
  deviceId,
  type Ed25519PrivateKey,
  type Ed25519PublicKey,
  type Ed25519Signature,
  ed25519Signature,
  encodeCanonical,
  epochId,
  epochSigningBytes,
  type Hash,
  hashBytes,
  type PairingContext,
  type PairingDeviceMetadata,
  type PairingId,
  type PairingVerificationPreview,
  Permission,
  pairingContextToCbor,
  pairingInfoBytes,
  type SignedPairingTransfer,
  vaultEpochKey,
  vaultId,
  type X25519PrivateKey,
  type X25519PublicKey,
} from "@meridian/protocol"
import {
  signDeviceCertificate,
  signPairingTransfer,
  signPairingVerificationPreview,
  validateDeviceCertificate,
  verifyCheckpoint,
  verifyPairingTransferSignature,
  verifyPairingVerificationPreviewSignature,
} from "./authorization.js"
import { AuthorizationError, CryptoError } from "./errors.js"
import { sha256 } from "./hash.js"
import { generateHpkeKeyPair, hpkeOpen, hpkeSeal } from "./hpke.js"
import type { DeviceKeyBundle } from "./lifecycle.js"
import { randomBytes } from "./runtime.js"
import { generateSigningKeyPair, sign, verify } from "./signatures.js"

const phrasePrefixes = [
  "amber",
  "brisk",
  "cedar",
  "dawn",
  "ember",
  "frost",
  "gold",
  "harbor",
  "indigo",
  "jade",
  "lunar",
  "maple",
  "navy",
  "opal",
  "pine",
  "quiet",
] as const
const phraseSuffixes = [
  "badger",
  "cloud",
  "drift",
  "finch",
  "grove",
  "heron",
  "island",
  "kestrel",
  "lantern",
  "meadow",
  "north",
  "otter",
  "pebble",
  "river",
  "stone",
  "willow",
] as const

export interface PendingPairingDevice {
  readonly deviceId: DeviceId
  readonly signingPrivateKey: Ed25519PrivateKey
  readonly signingPublicKey: Ed25519PublicKey
  readonly hpkePrivateKey: X25519PrivateKey
  readonly hpkePublicKey: X25519PublicKey
}

export interface PairingDeviceRequest extends PairingDeviceMetadata {
  readonly pairingId: PairingId
  readonly vaultId: ReturnType<typeof vaultId>
  readonly deviceId: DeviceId
  readonly signingPublicKey: Ed25519PublicKey
  readonly hpkePublicKey: X25519PublicKey
  readonly proofOfPossession: Ed25519Signature
}

export async function createPendingPairingDevice(): Promise<PendingPairingDevice> {
  const signing = generateSigningKeyPair()
  const hpke = await generateHpkeKeyPair()
  return {
    deviceId: deviceId(randomBytes(16)),
    signingPrivateKey: signing.privateKey,
    signingPublicKey: signing.publicKey,
    hpkePrivateKey: hpke.privateKey,
    hpkePublicKey: hpke.publicKey,
  }
}

function pairingRequestBytes(
  pairingIdentifier: PairingId,
  vault: ReturnType<typeof vaultId>,
  pending: PendingPairingDevice,
  metadata: PairingDeviceMetadata,
): Uint8Array {
  return encodeCanonical({
    domain: "meridian/v1/pairing-request",
    pairingId: pairingIdentifier,
    vaultId: vault,
    deviceId: pending.deviceId,
    signingPublicKey: pending.signingPublicKey,
    hpkePublicKey: pending.hpkePublicKey,
    deviceName: metadata.deviceName,
    platform: metadata.platform,
  })
}

export function createPairingDeviceRequest(
  pairingIdentifier: PairingId,
  vault: ReturnType<typeof vaultId>,
  pending: PendingPairingDevice,
  metadata: PairingDeviceMetadata,
): PairingDeviceRequest {
  assertPairingDeviceMetadata(metadata)
  return {
    pairingId: pairingIdentifier,
    vaultId: vault,
    deviceId: pending.deviceId,
    signingPublicKey: pending.signingPublicKey,
    hpkePublicKey: pending.hpkePublicKey,
    deviceName: metadata.deviceName,
    platform: metadata.platform,
    proofOfPossession: sign(
      pairingRequestBytes(pairingIdentifier, vault, pending, metadata),
      pending.signingPrivateKey,
    ),
  }
}

export function verifyPairingDeviceRequest(request: PairingDeviceRequest): boolean {
  try {
    assertPairingDeviceMetadata(request)
    return verify(
      encodeCanonical({
        domain: "meridian/v1/pairing-request",
        pairingId: request.pairingId,
        vaultId: request.vaultId,
        deviceId: request.deviceId,
        signingPublicKey: request.signingPublicKey,
        hpkePublicKey: request.hpkePublicKey,
        deviceName: request.deviceName,
        platform: request.platform,
      }),
      request.proofOfPossession,
      request.signingPublicKey,
    )
  } catch {
    return false
  }
}

export async function pairingVerificationPhrase(context: PairingContext): Promise<string> {
  const digest = await sha256(pairingInfoBytes(context))
  return [...digest.slice(0, 5)]
    .map((byte) => `${phrasePrefixes[byte >> 4]}-${phraseSuffixes[byte & 15]}`)
    .join(" ")
}

export interface PreparePairingInput {
  readonly approver: DeviceKeyBundle
  readonly request: PairingDeviceRequest
  readonly recoveryPublicKey: Ed25519PublicKey
  /** Starts with the approver certificate and ends at a recovery-signed certificate. */
  readonly authorizationChain: readonly DeviceCertificate[]
  readonly expiresAt: number
}

export interface PreparedPairingPackage {
  readonly package: SignedPairingTransfer
  readonly verificationPhrase: string
  readonly preview: PairingVerificationPreview
}

export async function preparePairingEpochPackage(
  input: PreparePairingInput,
): Promise<PreparedPairingPackage> {
  if (!verifyPairingDeviceRequest(input.request)) {
    throw new AuthorizationError("New device proof of possession is invalid")
  }
  if (!bytesEqual(input.request.vaultId, input.approver.vaultId)) {
    throw new AuthorizationError("Pairing request targets another vault")
  }
  if (!input.approver.certificate.body.permissions.includes(Permission.ManageDevices)) {
    throw new AuthorizationError("Approver cannot authorize devices")
  }
  if (
    input.authorizationChain.length === 0 ||
    !bytesEqual(
      input.authorizationChain[0]?.body.certificateId ?? new Uint8Array(),
      input.approver.certificate.body.certificateId,
    )
  ) {
    throw new AuthorizationError("Authorization chain must start with the approver")
  }

  const certificate = signDeviceCertificate(
    {
      certificateId: certificateId(randomBytes(16)),
      vaultId: input.approver.vaultId,
      deviceId: input.request.deviceId,
      signingPublicKey: input.request.signingPublicKey,
      hpkePublicKey: input.request.hpkePublicKey,
      permissions: [Permission.Read, Permission.Write],
      issuer: {
        kind: "device",
        certificateId: input.approver.certificate.body.certificateId,
      },
      epochId: input.approver.epoch.body.epochId,
      suite: CIPHER_SUITE,
      validFromCursor: input.approver.checkpoint.body.cursor,
      expiresAt: null,
    },
    input.approver.signingPrivateKey,
  )
  const context: PairingContext = {
    pairingId: input.request.pairingId,
    vaultId: input.approver.vaultId,
    newDeviceId: input.request.deviceId,
    newDeviceSigningPublicKey: input.request.signingPublicKey,
    newDeviceHpkePublicKey: input.request.hpkePublicKey,
    newDeviceName: input.request.deviceName,
    newDevicePlatform: input.request.platform,
    certificate,
    authorizationChain: input.authorizationChain,
    recoveryPublicKey: input.recoveryPublicKey,
    epoch: input.approver.epoch,
    checkpoint: input.approver.checkpoint,
    expiresAt: input.expiresAt,
    suite: CIPHER_SUITE,
  }
  const transfer = await hpkeSeal(
    input.request.hpkePublicKey,
    encodeCanonical({
      vaultId: input.approver.vaultId,
      epochId: input.approver.epoch.body.epochId,
      vaultEpochKey: input.approver.vaultEpochKey,
      epochKeys: input.approver.epochKeys.map((entry) => ({
        epochId: entry.epochId,
        vaultEpochKey: entry.vaultEpochKey,
      })),
      checkpointCursor: input.approver.checkpoint.body.cursor,
      checkpointHash: input.approver.checkpoint.body.logHash,
    }),
    pairingInfoBytes(context),
  )
  const signed: SignedPairingTransfer = {
    context,
    transfer,
    approverDeviceId: input.approver.deviceId,
    signature: signPairingTransfer(
      context,
      transfer,
      input.approver.deviceId,
      input.approver.signingPrivateKey,
    ),
  }
  const transferHash = await sha256(serializePairingPackage(signed))
  const preview: PairingVerificationPreview = {
    context,
    approverDeviceId: input.approver.deviceId,
    transferHash,
    signature: signPairingVerificationPreview(
      context,
      input.approver.deviceId,
      transferHash,
      input.approver.signingPrivateKey,
    ),
  }
  return {
    package: signed,
    verificationPhrase: await pairingVerificationPhrase(context),
    preview,
  }
}

export function serializePairingPackage(value: SignedPairingTransfer): Uint8Array {
  return encodeCanonical({
    context: pairingContextToCbor(value.context),
    transfer: {
      encapsulatedKey: value.transfer.encapsulatedKey,
      ciphertext: value.transfer.ciphertext,
    },
    approverDeviceId: value.approverDeviceId,
    signature: value.signature,
  })
}

export function serializePairingVerificationPreview(value: PairingVerificationPreview): Uint8Array {
  return encodeCanonical({
    context: pairingContextToCbor(value.context),
    approverDeviceId: value.approverDeviceId,
    transferHash: value.transferHash,
    signature: value.signature,
  })
}

function record(value: CborValue, label: string): Record<string, CborValue> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Uint8Array ||
    value instanceof Map
  ) {
    throw new CryptoError("INVALID_PAIRING_PACKAGE", `${label} must be a map`)
  }
  return value as Record<string, CborValue>
}

function fixed(value: CborValue | undefined, length: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new CryptoError("INVALID_PAIRING_PACKAGE", `${label} must contain ${length} bytes`)
  }
  return value
}

export function deserializePairingVerificationPreview(
  encoded: Uint8Array,
): PairingVerificationPreview {
  const envelope = record(decodeCanonical(encoded), "pairing verification preview")
  if (
    Object.keys(envelope).sort().join("\0") !==
    ["approverDeviceId", "context", "signature", "transferHash"].join("\0")
  ) {
    throw new CryptoError(
      "INVALID_PAIRING_PACKAGE",
      "Pairing verification preview has missing or unknown fields",
    )
  }
  return {
    context: decodePairingContextValue(envelope.context as CborValue),
    approverDeviceId: deviceId(fixed(envelope.approverDeviceId, 16, "approver device ID")),
    transferHash: hashBytes(fixed(envelope.transferHash, 32, "pairing transfer hash")),
    signature: ed25519Signature(fixed(envelope.signature, 64, "preview signature")),
  }
}

export function deserializePairingPackage(encoded: Uint8Array): SignedPairingTransfer {
  const envelope = record(decodeCanonical(encoded), "pairing package")
  if (
    Object.keys(envelope).sort().join("\0") !==
    ["approverDeviceId", "context", "signature", "transfer"].join("\0")
  ) {
    throw new CryptoError(
      "INVALID_PAIRING_PACKAGE",
      "Pairing package has missing or unknown fields",
    )
  }
  const transferValue = record(envelope.transfer as CborValue, "HPKE transfer")
  if (
    Object.keys(transferValue).sort().join("\0") !== ["ciphertext", "encapsulatedKey"].join("\0")
  ) {
    throw new CryptoError("INVALID_PAIRING_PACKAGE", "HPKE transfer has missing or unknown fields")
  }
  const encapsulatedKey = fixed(transferValue.encapsulatedKey, 32, "encapsulated key")
  if (
    !(transferValue.ciphertext instanceof Uint8Array) ||
    transferValue.ciphertext.byteLength < 16
  ) {
    throw new CryptoError("INVALID_PAIRING_PACKAGE", "HPKE ciphertext is invalid")
  }
  return {
    context: decodePairingContextValue(envelope.context as CborValue),
    transfer: { encapsulatedKey, ciphertext: transferValue.ciphertext },
    approverDeviceId: deviceId(fixed(envelope.approverDeviceId, 16, "approver device ID")),
    signature: ed25519Signature(fixed(envelope.signature, 64, "pairing signature")),
  }
}

function validatePairingContext(
  pending: PendingPairingDevice,
  context: PairingContext,
  approverDeviceId: DeviceId,
  now: number,
): DeviceCertificate {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new AuthorizationError("Pairing verification time is invalid")
  }
  if (context.expiresAt <= now) throw new AuthorizationError("Pairing package has expired")
  try {
    assertPairingDeviceMetadata({
      deviceName: context.newDeviceName,
      platform: context.newDevicePlatform,
    })
  } catch {
    throw new AuthorizationError("Pairing device metadata is invalid")
  }
  if (
    !bytesEqual(context.newDeviceId, pending.deviceId) ||
    !bytesEqual(context.newDeviceSigningPublicKey, pending.signingPublicKey) ||
    !bytesEqual(context.newDeviceHpkePublicKey, pending.hpkePublicKey)
  ) {
    throw new AuthorizationError("Pairing package substituted the new device identity")
  }
  if (
    !bytesEqual(context.certificate.body.vaultId, context.vaultId) ||
    !bytesEqual(context.certificate.body.deviceId, context.newDeviceId) ||
    !bytesEqual(context.certificate.body.signingPublicKey, context.newDeviceSigningPublicKey) ||
    !bytesEqual(context.certificate.body.hpkePublicKey, context.newDeviceHpkePublicKey) ||
    !bytesEqual(context.certificate.body.epochId, context.epoch.body.epochId)
  ) {
    throw new AuthorizationError("Pairing certificate does not match the candidate identity")
  }

  const byId = new Map<string, DeviceCertificate>()
  for (const certificate of context.authorizationChain) {
    const id = bytesToHex(certificate.body.certificateId)
    if (byId.has(id)) {
      throw new AuthorizationError("Pairing authorization chain contains duplicate certificates")
    }
    byId.set(id, certificate)
  }
  const approver = context.authorizationChain[0]
  if (
    approver === undefined ||
    !bytesEqual(approver.body.deviceId, approverDeviceId) ||
    context.certificate.body.issuer.kind !== "device" ||
    !bytesEqual(context.certificate.body.issuer.certificateId, approver.body.certificateId)
  ) {
    throw new AuthorizationError("Pairing approver certificate is absent")
  }
  const validatedChain = validateDeviceCertificate(context.certificate, {
    recoveryPublicKey: context.recoveryPublicKey,
    lookup: (id) => byId.get(bytesToHex(id)),
    atCursor: context.checkpoint.body.cursor,
    atTime: now,
  })
  if (
    validatedChain.length !== context.authorizationChain.length + 1 ||
    context.authorizationChain.some(
      (certificate, index) =>
        !bytesEqual(
          certificate.body.certificateId,
          validatedChain[index + 1]?.body.certificateId ?? new Uint8Array(),
        ),
    )
  ) {
    throw new AuthorizationError("Pairing authorization chain is not the exact certificate chain")
  }

  if (
    !bytesEqual(context.checkpoint.body.vaultId, context.vaultId) ||
    !bytesEqual(context.checkpoint.body.epochId, context.epoch.body.epochId)
  ) {
    throw new AuthorizationError("Pairing checkpoint does not match the vault epoch")
  }
  const checkpointSigner = context.authorizationChain.find((certificate) =>
    bytesEqual(certificate.body.deviceId, context.checkpoint.body.signerDeviceId),
  )
  if (checkpointSigner === undefined || !verifyCheckpoint(context.checkpoint, checkpointSigner)) {
    throw new AuthorizationError("Pairing checkpoint signature is invalid")
  }
  if (!bytesEqual(context.epoch.body.vaultId, context.vaultId)) {
    throw new AuthorizationError("Pairing epoch targets another vault")
  }
  let epochSigner: Ed25519PublicKey | undefined
  if (context.epoch.body.createdBy === "recovery") {
    epochSigner = context.recoveryPublicKey
  } else {
    const signerCertificate = context.authorizationChain.find((certificate) =>
      bytesEqual(certificate.body.deviceId, context.epoch.body.createdBy as DeviceId),
    )
    if (!signerCertificate?.body.permissions.includes(Permission.RotateEpoch)) {
      throw new AuthorizationError("Pairing epoch signer cannot rotate vault epochs")
    }
    epochSigner = signerCertificate.body.signingPublicKey
  }
  if (
    epochSigner === undefined ||
    !verify(epochSigningBytes(context.epoch.body), context.epoch.signature, epochSigner)
  ) {
    throw new AuthorizationError("Pairing epoch signature is invalid")
  }
  return approver
}

export interface InspectedPairingVerification {
  readonly verificationPhrase: string
  readonly transferHash: Hash
}

export async function inspectPairingVerificationPreview(
  pending: PendingPairingDevice,
  preview: PairingVerificationPreview,
  now: number,
): Promise<InspectedPairingVerification> {
  if (!(preview.transferHash instanceof Uint8Array) || preview.transferHash.byteLength !== 32) {
    throw new AuthorizationError("Pairing verification preview transfer hash is invalid")
  }
  const approver = validatePairingContext(pending, preview.context, preview.approverDeviceId, now)
  if (
    !verifyPairingVerificationPreviewSignature(
      preview.context,
      preview.approverDeviceId,
      preview.transferHash,
      preview.signature,
      approver.body.signingPublicKey,
    )
  ) {
    throw new AuthorizationError("Pairing verification preview signature is invalid")
  }
  return {
    verificationPhrase: await pairingVerificationPhrase(preview.context),
    transferHash: preview.transferHash,
  }
}

export interface ConsumePairingInput {
  readonly pending: PendingPairingDevice
  readonly package: SignedPairingTransfer
  readonly expectedTransferHash: Hash
  readonly confirmedVerificationPhrase: string
  readonly now: number
}

export async function consumePairingEpochPackage(
  input: ConsumePairingInput,
): Promise<DeviceKeyBundle> {
  const context = input.package.context
  const approver = validatePairingContext(
    input.pending,
    context,
    input.package.approverDeviceId,
    input.now,
  )
  const actualTransferHash = await sha256(serializePairingPackage(input.package))
  if (!bytesEqual(actualTransferHash, input.expectedTransferHash)) {
    throw new AuthorizationError("Pairing transfer does not match the verified preview")
  }
  if (
    !verifyPairingTransferSignature(
      context,
      input.package.transfer,
      input.package.approverDeviceId,
      input.package.signature,
      approver.body.signingPublicKey,
    )
  ) {
    throw new AuthorizationError("Pairing transcript signature is invalid")
  }
  const phrase = await pairingVerificationPhrase(context)
  if (phrase !== input.confirmedVerificationPhrase) {
    throw new AuthorizationError("Pairing verification phrase was not confirmed")
  }

  const plaintext = await hpkeOpen(
    input.pending.hpkePrivateKey,
    input.package.transfer,
    pairingInfoBytes(context),
  )
  const state = record(decodeCanonical(plaintext), "pairing epoch state")
  if (
    Object.keys(state).sort().join("\0") !==
    ["checkpointCursor", "checkpointHash", "epochId", "epochKeys", "vaultEpochKey", "vaultId"].join(
      "\0",
    )
  ) {
    throw new AuthorizationError("Pairing epoch state has missing or unknown fields")
  }
  if (
    !Array.isArray(state.epochKeys) ||
    state.epochKeys.length < 1 ||
    state.epochKeys.length > 1024
  ) {
    throw new AuthorizationError("Pairing epoch keyring is invalid")
  }
  const epochKeys = state.epochKeys.map((entry) => {
    const keyEntry = record(entry, "pairing epoch key")
    if (Object.keys(keyEntry).sort().join("\0") !== "epochId\0vaultEpochKey") {
      throw new AuthorizationError("Pairing epoch key entry is invalid")
    }
    return {
      epochId: epochId(fixed(keyEntry.epochId, 16, "epoch key ID")),
      vaultEpochKey: vaultEpochKey(fixed(keyEntry.vaultEpochKey, 32, "vault epoch key")),
    }
  })
  for (let index = 0; index < epochKeys.length; index += 1) {
    const current = epochKeys[index]
    if (
      current &&
      epochKeys.slice(index + 1).some((entry) => bytesEqual(entry.epochId, current.epochId))
    ) {
      throw new AuthorizationError("Pairing epoch keyring contains duplicates")
    }
  }
  const currentEpochKey = epochKeys.find((entry) =>
    bytesEqual(entry.epochId, context.epoch.body.epochId),
  )
  if (
    !(state.vaultEpochKey instanceof Uint8Array) ||
    !currentEpochKey ||
    !bytesEqual(currentEpochKey.vaultEpochKey, state.vaultEpochKey)
  ) {
    throw new AuthorizationError("Pairing current epoch key is inconsistent")
  }
  if (
    !(state.vaultId instanceof Uint8Array) ||
    !(state.epochId instanceof Uint8Array) ||
    !(state.checkpointHash instanceof Uint8Array) ||
    !bytesEqual(state.vaultId, context.vaultId) ||
    !bytesEqual(state.epochId, context.epoch.body.epochId) ||
    !bytesEqual(state.checkpointHash, context.checkpoint.body.logHash) ||
    state.checkpointCursor !== context.checkpoint.body.cursor
  ) {
    throw new AuthorizationError("Pairing epoch state does not match the signed transcript")
  }
  return {
    version: 2,
    vaultId: vaultId(state.vaultId),
    deviceId: input.pending.deviceId,
    signingPrivateKey: input.pending.signingPrivateKey,
    signingPublicKey: input.pending.signingPublicKey,
    hpkePrivateKey: input.pending.hpkePrivateKey,
    hpkePublicKey: input.pending.hpkePublicKey,
    certificate: context.certificate,
    epoch: context.epoch,
    vaultEpochKey: vaultEpochKey(fixed(state.vaultEpochKey, 32, "vault epoch key")),
    epochKeys,
    epochActivatedAtCursor: context.checkpoint.body.cursor,
    checkpoint: context.checkpoint,
  }
}
