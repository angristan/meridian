import {
  type AuthChallenge,
  type CborValue,
  CIPHER_SUITE,
  certificateId,
  checkpointLogFormats,
  type DeviceCertificate,
  type DeviceId,
  decodeCanonical,
  decodeCheckpoint,
  decodeDeviceCertificate,
  decodeEpochDeclaration,
  deviceId,
  type Ed25519PrivateKey,
  type Ed25519PublicKey,
  type EncryptedRecoveryPackage,
  type EpochDeclaration,
  type EpochId,
  type EpochKeyMaterial,
  ed25519PrivateKey,
  ed25519PublicKey,
  type ed25519Signature,
  encodeCanonical,
  encodeCheckpoint,
  encodeDeviceCertificate,
  encodeEpochDeclaration,
  epochId,
  hashBytes,
  LogFormat,
  Permission,
  type SignedCheckpoint,
  type VaultEpochKey,
  type VaultId,
  vaultEpochKey,
  vaultId,
  type X25519PrivateKey,
  type X25519PublicKey,
  x25519PrivateKey,
  x25519PublicKey,
  ZERO_HASH,
} from "@meridian/protocol"
import { x25519 } from "@noble/curves/ed25519.js"
import { signCheckpoint, signDeviceCertificate, signEpochDeclaration } from "./authorization.js"
import { CryptoError } from "./errors.js"
import { generateHpkeKeyPair } from "./hpke.js"
import { deriveRecoveryKeys } from "./kdf.js"
import {
  decryptRecoveryPackage,
  encryptRecoveryPackage,
  formatRecoveryCode,
  generateRecoverySeed,
  parseRecoveryCode,
} from "./recovery.js"
import { randomBytes } from "./runtime.js"
import { generateSigningKeyPair, sign, signingKeyPairFromSeed } from "./signatures.js"

export interface DeviceKeyBundle {
  readonly version: 1
  readonly vaultId: VaultId
  readonly deviceId: DeviceId
  readonly signingPrivateKey: Ed25519PrivateKey
  readonly signingPublicKey: Ed25519PublicKey
  readonly hpkePrivateKey: X25519PrivateKey
  readonly hpkePublicKey: X25519PublicKey
  readonly certificate: DeviceCertificate
  readonly epoch: EpochDeclaration
  readonly vaultEpochKey: VaultEpochKey
  readonly epochKeys: readonly EpochKeyMaterial[]
  readonly checkpoint: SignedCheckpoint
}

export interface FirstDeviceClaimBundle {
  readonly device: DeviceKeyBundle
  readonly recoveryCode: string
  readonly recoveryPublicKey: Ed25519PublicKey
  readonly encryptedRecoveryPackage: EncryptedRecoveryPackage
}

const randomId = () => randomBytes(16)

export async function createFirstDeviceClaimBundle(
  initialLogFormat: LogFormat = LogFormat.CanonicalCborV1,
): Promise<FirstDeviceClaimBundle> {
  const [signing, hpke] = await Promise.all([
    Promise.resolve(generateSigningKeyPair()),
    generateHpkeKeyPair(),
  ])
  const recoverySeed = generateRecoverySeed()
  const recoveryKeys = await deriveRecoveryKeys(recoverySeed)
  const recoverySigning = signingKeyPairFromSeed(recoveryKeys.signingPrivateKey)
  const vault = vaultId(randomId())
  const device = deviceId(randomId())
  const epochIdentifier = epochId(randomId())
  const epochKey = vaultEpochKey(randomBytes(32))

  const epoch = signEpochDeclaration(
    {
      vaultId: vault,
      epochId: epochIdentifier,
      sequence: 0,
      previousEpochId: null,
      suite: CIPHER_SUITE,
      createdBy: "recovery",
      reason: "initial",
    },
    recoveryKeys.signingPrivateKey,
  )
  const certificate = signDeviceCertificate(
    {
      certificateId: certificateId(randomId()),
      vaultId: vault,
      deviceId: device,
      signingPublicKey: signing.publicKey,
      hpkePublicKey: hpke.publicKey,
      permissions: [
        Permission.Read,
        Permission.Write,
        Permission.ManageDevices,
        Permission.RotateEpoch,
      ],
      issuer: { kind: "recovery" },
      epochId: epochIdentifier,
      suite: CIPHER_SUITE,
      validFromCursor: 0,
      expiresAt: null,
    },
    recoveryKeys.signingPrivateKey,
  )
  const checkpoint = signCheckpoint(
    {
      vaultId: vault,
      epochId: epochIdentifier,
      cursor: 0,
      logHash: hashBytes(ZERO_HASH),
      signerDeviceId: device,
      protocolGeneration: CIPHER_SUITE.protocolGeneration,
      initialLogFormat,
      logFormat: initialLogFormat,
    },
    signing.privateKey,
  )
  const bundle: DeviceKeyBundle = {
    version: 1,
    vaultId: vault,
    deviceId: device,
    signingPrivateKey: signing.privateKey,
    signingPublicKey: signing.publicKey,
    hpkePrivateKey: hpke.privateKey,
    hpkePublicKey: hpke.publicKey,
    certificate,
    epoch,
    vaultEpochKey: epochKey,
    epochKeys: [{ epochId: epochIdentifier, vaultEpochKey: epochKey }],
    checkpoint,
  }
  const encryptedRecoveryPackage = await encryptRecoveryPackage(
    {
      vaultId: vault,
      epoch,
      vaultEpochKey: epochKey,
      epochKeys: bundle.epochKeys,
      checkpoint,
      recoverySequence: 0,
    },
    recoveryKeys.encryptionKey,
  )
  return {
    device: bundle,
    recoveryCode: await formatRecoveryCode(recoverySeed),
    recoveryPublicKey: recoverySigning.publicKey,
    encryptedRecoveryPackage,
  }
}

export interface RecoveredDeviceBundle {
  readonly device: DeviceKeyBundle
  readonly recoveryPublicKey: Ed25519PublicKey
  readonly encryptedRecoveryPackage: EncryptedRecoveryPackage
}

/** Restores ownership into a fresh recovery-signed device and rotates the current epoch key. */
export async function recoverDeviceFromPackage(
  recoveryCode: string,
  encryptedPackage: EncryptedRecoveryPackage,
): Promise<RecoveredDeviceBundle> {
  const recoverySeed = await parseRecoveryCode(recoveryCode)
  const recoveryKeys = await deriveRecoveryKeys(recoverySeed)
  const recoverySigning = signingKeyPairFromSeed(recoveryKeys.signingPrivateKey)
  const state = await decryptRecoveryPackage(encryptedPackage, recoveryKeys.encryptionKey)
  const [signing, hpke] = await Promise.all([
    Promise.resolve(generateSigningKeyPair()),
    generateHpkeKeyPair(),
  ])
  const replacementDeviceId = deviceId(randomId())
  const nextEpochId = epochId(randomId())
  const nextEpochKey = vaultEpochKey(randomBytes(32))
  const nextEpoch = signEpochDeclaration(
    {
      vaultId: state.vaultId,
      epochId: nextEpochId,
      sequence: state.epoch.body.sequence + 1,
      previousEpochId: state.epoch.body.epochId,
      suite: CIPHER_SUITE,
      createdBy: "recovery",
      reason: "recovery",
    },
    recoveryKeys.signingPrivateKey,
  )
  const certificate = signDeviceCertificate(
    {
      certificateId: certificateId(randomId()),
      vaultId: state.vaultId,
      deviceId: replacementDeviceId,
      signingPublicKey: signing.publicKey,
      hpkePublicKey: hpke.publicKey,
      permissions: [
        Permission.Read,
        Permission.Write,
        Permission.ManageDevices,
        Permission.RotateEpoch,
      ],
      issuer: { kind: "recovery" },
      epochId: nextEpochId,
      suite: CIPHER_SUITE,
      validFromCursor: state.checkpoint.body.cursor,
      expiresAt: null,
    },
    recoveryKeys.signingPrivateKey,
  )
  const recoveryLogFormats = checkpointLogFormats(state.checkpoint.body)
  const checkpoint = signCheckpoint(
    {
      vaultId: state.vaultId,
      epochId: nextEpochId,
      cursor: state.checkpoint.body.cursor,
      logHash: state.checkpoint.body.logHash,
      signerDeviceId: replacementDeviceId,
      protocolGeneration: CIPHER_SUITE.protocolGeneration,
      ...recoveryLogFormats,
    },
    signing.privateKey,
  )
  const epochKeys = [...state.epochKeys, { epochId: nextEpochId, vaultEpochKey: nextEpochKey }]
  const device: DeviceKeyBundle = {
    version: 1,
    vaultId: state.vaultId,
    deviceId: replacementDeviceId,
    signingPrivateKey: signing.privateKey,
    signingPublicKey: signing.publicKey,
    hpkePrivateKey: hpke.privateKey,
    hpkePublicKey: hpke.publicKey,
    certificate,
    epoch: nextEpoch,
    vaultEpochKey: nextEpochKey,
    epochKeys,
    checkpoint,
  }
  const nextPackage = await encryptRecoveryPackage(
    {
      ...state,
      epoch: nextEpoch,
      vaultEpochKey: nextEpochKey,
      epochKeys,
      checkpoint,
      recoverySequence: state.recoverySequence + 1,
    },
    recoveryKeys.encryptionKey,
  )
  return {
    device,
    recoveryPublicKey: recoverySigning.publicKey,
    encryptedRecoveryPackage: nextPackage,
  }
}

export function serializeDeviceKeyBundle(bundle: DeviceKeyBundle): Uint8Array {
  return encodeCanonical({
    version: bundle.version,
    vaultId: bundle.vaultId,
    deviceId: bundle.deviceId,
    signingPrivateKey: bundle.signingPrivateKey,
    signingPublicKey: bundle.signingPublicKey,
    hpkePrivateKey: bundle.hpkePrivateKey,
    hpkePublicKey: bundle.hpkePublicKey,
    certificate: encodeDeviceCertificate(bundle.certificate),
    epoch: encodeEpochDeclaration(bundle.epoch),
    vaultEpochKey: bundle.vaultEpochKey,
    epochKeys: bundle.epochKeys.map((entry) => ({
      epochId: entry.epochId,
      vaultEpochKey: entry.vaultEpochKey,
    })),
    checkpoint: encodeCheckpoint(bundle.checkpoint),
  })
}

function record(value: CborValue): Record<string, CborValue> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Uint8Array ||
    value instanceof Map
  ) {
    throw new CryptoError("INVALID_DEVICE_BUNDLE", "Device key bundle must be a CBOR map")
  }
  return value as Record<string, CborValue>
}

function fixed(value: CborValue | undefined, length: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new CryptoError("INVALID_DEVICE_BUNDLE", `${label} must contain ${length} bytes`)
  }
  return value
}

export function deserializeDeviceKeyBundle(encoded: Uint8Array): DeviceKeyBundle {
  const value = record(decodeCanonical(encoded))
  const keys = [
    "version",
    "vaultId",
    "deviceId",
    "signingPrivateKey",
    "signingPublicKey",
    "hpkePrivateKey",
    "hpkePublicKey",
    "certificate",
    "epoch",
    "vaultEpochKey",
    "epochKeys",
    "checkpoint",
  ].sort()
  if (Object.keys(value).sort().join("\0") !== keys.join("\0") || value.version !== 1) {
    throw new CryptoError("INVALID_DEVICE_BUNDLE", "Device key bundle has an unsupported shape")
  }
  const signingPrivate = ed25519PrivateKey(
    fixed(value.signingPrivateKey, 32, "signing private key"),
  )
  const signingPublic = ed25519PublicKey(fixed(value.signingPublicKey, 32, "signing public key"))
  const expectedSigningPublic = signingKeyPairFromSeed(signingPrivate).publicKey
  if (expectedSigningPublic.some((byte, index) => byte !== signingPublic[index])) {
    throw new CryptoError("INVALID_DEVICE_BUNDLE", "Device signing keypair does not match")
  }
  if (
    !(value.certificate instanceof Uint8Array) ||
    !(value.epoch instanceof Uint8Array) ||
    !(value.checkpoint instanceof Uint8Array)
  ) {
    throw new CryptoError("INVALID_DEVICE_BUNDLE", "Device bundle signed objects are malformed")
  }
  if (
    !Array.isArray(value.epochKeys) ||
    value.epochKeys.length < 1 ||
    value.epochKeys.length > 1024
  ) {
    throw new CryptoError("INVALID_DEVICE_BUNDLE", "Device epoch keyring is malformed")
  }
  const epochKeys = value.epochKeys.map((entry) => {
    const keyEntry = record(entry)
    if (Object.keys(keyEntry).sort().join("\0") !== "epochId\0vaultEpochKey") {
      throw new CryptoError("INVALID_DEVICE_BUNDLE", "Device epoch key entry is malformed")
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
      epochKeys
        .slice(index + 1)
        .some((entry) =>
          entry.epochId.every((byte, byteIndex) => byte === current.epochId[byteIndex]),
        )
    ) {
      throw new CryptoError("INVALID_DEVICE_BUNDLE", "Device epoch keyring contains duplicates")
    }
  }
  const hpkePrivate = x25519PrivateKey(fixed(value.hpkePrivateKey, 32, "HPKE private key"))
  const hpkePublic = x25519PublicKey(fixed(value.hpkePublicKey, 32, "HPKE public key"))
  const expectedHpkePublic = x25519.getPublicKey(hpkePrivate)
  if (expectedHpkePublic.some((byte, index) => byte !== hpkePublic[index])) {
    throw new CryptoError("INVALID_DEVICE_BUNDLE", "Device HPKE keypair does not match")
  }
  const bundle: DeviceKeyBundle = {
    version: 1,
    vaultId: vaultId(fixed(value.vaultId, 16, "vault ID")),
    deviceId: deviceId(fixed(value.deviceId, 16, "device ID")),
    signingPrivateKey: signingPrivate,
    signingPublicKey: signingPublic,
    hpkePrivateKey: hpkePrivate,
    hpkePublicKey: hpkePublic,
    certificate: decodeDeviceCertificate(value.certificate),
    epoch: decodeEpochDeclaration(value.epoch),
    vaultEpochKey: vaultEpochKey(fixed(value.vaultEpochKey, 32, "vault epoch key")),
    epochKeys,
    checkpoint: decodeCheckpoint(value.checkpoint),
  }
  if (
    bundle.certificate.body.deviceId.some((byte, index) => byte !== bundle.deviceId[index]) ||
    bundle.certificate.body.vaultId.some((byte, index) => byte !== bundle.vaultId[index]) ||
    bundle.certificate.body.signingPublicKey.some(
      (byte, index) => byte !== bundle.signingPublicKey[index],
    ) ||
    bundle.certificate.body.hpkePublicKey.some(
      (byte, index) => byte !== bundle.hpkePublicKey[index],
    ) ||
    bundle.certificate.body.epochId.some(
      (byte, index) => byte !== bundle.epoch.body.epochId[index],
    ) ||
    bundle.checkpoint.body.epochId.some((byte, index) => byte !== bundle.epoch.body.epochId[index])
  ) {
    throw new CryptoError(
      "INVALID_DEVICE_BUNDLE",
      "Device certificate does not bind the bundle keys",
    )
  }
  const currentKey = bundle.epochKeys.find((entry) =>
    entry.epochId.every((byte, index) => byte === bundle.epoch.body.epochId[index]),
  )
  if (
    !currentKey ||
    currentKey.vaultEpochKey.some((byte, index) => byte !== bundle.vaultEpochKey[index])
  ) {
    throw new CryptoError("INVALID_DEVICE_BUNDLE", "Current epoch key is inconsistent")
  }
  return bundle
}

export function deviceEpochKey(bundle: DeviceKeyBundle, targetEpochId: EpochId): VaultEpochKey {
  const entry = bundle.epochKeys.find((candidate) =>
    candidate.epochId.every((byte, index) => byte === targetEpochId[index]),
  )
  if (!entry) throw new CryptoError("EPOCH_KEY_MISSING", "Device does not retain this epoch key")
  return entry.vaultEpochKey
}

export function authChallengeSigningBytes(challenge: AuthChallenge): Uint8Array {
  return encodeCanonical({
    domain: "meridian/v1/auth-challenge",
    challengeId: challenge.challengeId,
    vaultId: challenge.vaultId,
    deviceId: challenge.deviceId,
    challenge: challenge.challenge,
    expiresAt: challenge.expiresAt,
  })
}

export function signAuthChallenge(
  challenge: AuthChallenge,
  device: DeviceKeyBundle,
): ReturnType<typeof ed25519Signature> {
  if (
    challenge.vaultId.some((byte, index) => byte !== device.vaultId[index]) ||
    challenge.deviceId.some((byte, index) => byte !== device.deviceId[index])
  ) {
    throw new CryptoError("AUTH_CHALLENGE_SCOPE", "Authentication challenge targets another device")
  }
  return sign(authChallengeSigningBytes(challenge), device.signingPrivateKey)
}
