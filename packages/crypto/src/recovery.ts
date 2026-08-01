import {
  bytesEqual,
  bytesToHex,
  type CborValue,
  CIPHER_SUITE,
  type DeviceCertificate,
  type DeviceId,
  Domain,
  decodeCanonical,
  decodeCheckpoint,
  decodeDeviceCertificate,
  decodeEpochDeclaration,
  deviceId,
  type Ed25519PrivateKey,
  type Ed25519PublicKey,
  type Ed25519Signature,
  type EncryptedRecoveryPackage,
  ed25519Signature,
  encodeCanonical,
  encodeCheckpoint,
  encodeDeviceCertificate,
  encodeEpochDeclaration,
  epochId,
  epochSigningBytes,
  type Hash,
  hashBytes,
  nonce,
  operationId,
  Permission,
  type RecoveryEncryptionKey,
  type RecoveryId,
  type RecoverySeed,
  type RecoveryState,
  recoverySeed,
  type VaultId,
  vaultEpochKey,
  vaultId,
  type X25519PublicKey,
  x25519PrivateKey,
  x25519PublicKey,
} from "@meridian/protocol"
import { ed25519 } from "@noble/curves/ed25519.js"
import { aesGcmDecrypt, aesGcmEncrypt } from "./aes.js"
import { validateDeviceCertificate, verifyCheckpoint } from "./authorization.js"
import { AuthenticationError } from "./errors.js"
import { sha256 } from "./hash.js"
import { hpkeOpen, hpkeSeal } from "./hpke.js"
import { deriveRecoveryKeys } from "./kdf.js"
import { randomBytes } from "./runtime.js"
import { sign, verify } from "./signatures.js"

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

function base64UrlEncode(value: Uint8Array): string {
  let output = ""
  let bits = 0
  let accumulator = 0
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 6) {
      bits -= 6
      output += BASE64URL_ALPHABET[(accumulator >> bits) & 63]
    }
  }
  if (bits > 0) output += BASE64URL_ALPHABET[(accumulator << (6 - bits)) & 63]
  return output
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("Recovery code is not base64url")
  const output: number[] = []
  let bits = 0
  let accumulator = 0
  for (const character of value) {
    const index = BASE64URL_ALPHABET.indexOf(character)
    if (index < 0) throw new TypeError("Recovery code contains an invalid character")
    accumulator = (accumulator << 6) | index
    bits += 6
    if (bits >= 8) {
      bits -= 8
      output.push((accumulator >> bits) & 0xff)
    }
  }
  if (bits > 0 && (accumulator & ((1 << bits) - 1)) !== 0) {
    throw new TypeError("Recovery code has non-canonical trailing bits")
  }
  return Uint8Array.from(output)
}

export async function formatRecoveryCode(seed: RecoverySeed): Promise<string> {
  const checksum = (
    await sha256(encodeCanonical({ domain: "meridian/v1/recovery-code", seed }))
  ).slice(0, 4)
  const encoded = base64UrlEncode(Uint8Array.from([...seed, ...checksum]))
  return `mdn1.${encoded.match(/.{1,8}/g)?.join(".") ?? encoded}`
}

export async function parseRecoveryCode(code: string): Promise<RecoverySeed> {
  const normalized = code.trim()
  if (!normalized.startsWith("mdn1.")) throw new TypeError("Unsupported recovery code version")
  const decoded = base64UrlDecode(normalized.slice(5).replaceAll(".", ""))
  if (decoded.byteLength !== 36) throw new TypeError("Recovery code has an invalid length")
  const seed = recoverySeed(decoded.slice(0, 32))
  const expected = await formatRecoveryCode(seed)
  if (expected !== normalized) throw new AuthenticationError("Recovery code checksum is invalid")
  return seed
}

export function generateRecoverySeed(): RecoverySeed {
  return recoverySeed(randomBytes(32))
}

export function serializeEncryptedRecoveryPackage(value: EncryptedRecoveryPackage): Uint8Array {
  if (value.packageVersion === 2) {
    return encodeCanonical({
      packageVersion: value.packageVersion,
      protocolGeneration: value.protocolGeneration,
      vaultId: value.vaultId,
      encapsulatedKey: value.encapsulatedKey,
      ciphertext: value.ciphertext,
      checkpoint: encodeCheckpoint(value.checkpoint),
    })
  }
  return encodeCanonical({
    protocolGeneration: value.protocolGeneration,
    vaultId: value.vaultId,
    nonce: value.nonce,
    ciphertext: value.ciphertext,
    checkpoint: encodeCheckpoint(value.checkpoint),
  })
}

export function deserializeEncryptedRecoveryPackage(encoded: Uint8Array): EncryptedRecoveryPackage {
  const value = asRecord(decodeCanonical(encoded))
  const publicKeyEncrypted = value.packageVersion === 2
  const expected = publicKeyEncrypted
    ? [
        "checkpoint",
        "ciphertext",
        "encapsulatedKey",
        "packageVersion",
        "protocolGeneration",
        "vaultId",
      ].sort()
    : ["checkpoint", "ciphertext", "nonce", "protocolGeneration", "vaultId"].sort()
  if (Object.keys(value).sort().join("\0") !== expected.join("\0")) {
    throw new AuthenticationError("Recovery package has missing or unknown fields")
  }
  if (
    value.protocolGeneration !== CIPHER_SUITE.protocolGeneration ||
    !(value.vaultId instanceof Uint8Array) ||
    value.vaultId.byteLength !== 16 ||
    !(value.ciphertext instanceof Uint8Array) ||
    value.ciphertext.byteLength < 16 ||
    !(value.checkpoint instanceof Uint8Array)
  ) {
    throw new AuthenticationError("Recovery package fields are invalid")
  }
  if (publicKeyEncrypted) {
    if (!(value.encapsulatedKey instanceof Uint8Array) || value.encapsulatedKey.byteLength !== 32) {
      throw new AuthenticationError("Recovery package encapsulated key is invalid")
    }
    return {
      packageVersion: 2,
      protocolGeneration: value.protocolGeneration,
      vaultId: vaultId(value.vaultId),
      encapsulatedKey: value.encapsulatedKey,
      ciphertext: value.ciphertext,
      checkpoint: decodeCheckpoint(value.checkpoint),
    }
  }
  if (!(value.nonce instanceof Uint8Array) || value.nonce.byteLength !== 12) {
    throw new AuthenticationError("Recovery package nonce is invalid")
  }
  return {
    protocolGeneration: value.protocolGeneration,
    vaultId: vaultId(value.vaultId),
    nonce: nonce(value.nonce),
    ciphertext: value.ciphertext,
    checkpoint: decodeCheckpoint(value.checkpoint),
  }
}

export async function computeRecoveryStateId(
  vault: VaultId,
  encryptedRecoveryPackage: Uint8Array,
): Promise<Hash> {
  return hashBytes(
    await sha256(
      encodeCanonical({
        domain: "meridian/v1/recovery-state-id",
        vaultId: vault,
        encryptedRecoveryPackage,
      }),
    ),
  )
}

export interface RecoveryClaimSigningInput {
  readonly claimVersion: 2
  readonly recoveryId: RecoveryId
  readonly previousRecoveryStateId: Hash
  readonly challengeId: string
  readonly challenge: Uint8Array
  readonly vaultId: VaultId
  readonly deviceId: DeviceId
  readonly signingPublicKey: Ed25519PublicKey
  readonly hpkePublicKey: X25519PublicKey
  readonly certificate: Uint8Array
  readonly encryptedRecoveryPackage: Uint8Array
}

export function recoveryClaimSigningBytes(input: RecoveryClaimSigningInput): Uint8Array {
  return encodeCanonical({
    domain: "meridian/v1/recovery-claim-v2",
    claimVersion: input.claimVersion,
    recoveryId: input.recoveryId,
    previousRecoveryStateId: input.previousRecoveryStateId,
    challengeId: input.challengeId,
    challenge: input.challenge,
    vaultId: input.vaultId,
    deviceId: input.deviceId,
    signingPublicKey: input.signingPublicKey,
    hpkePublicKey: input.hpkePublicKey,
    certificate: input.certificate,
    encryptedRecoveryPackage: input.encryptedRecoveryPackage,
  })
}

export async function signRecoveryClaim(
  recoveryCode: string,
  input: RecoveryClaimSigningInput,
): Promise<Ed25519Signature> {
  const seed = await parseRecoveryCode(recoveryCode)
  const keys = await deriveRecoveryKeys(seed)
  return sign(recoveryClaimSigningBytes(input), keys.signingPrivateKey)
}

function recoveryStateToCbor(state: RecoveryState): CborValue {
  return {
    vaultId: state.vaultId,
    epoch: encodeEpochDeclaration(state.epoch),
    vaultEpochKey: state.vaultEpochKey,
    epochKeys: state.epochKeys.map((entry) => ({
      epochId: entry.epochId,
      vaultEpochKey: entry.vaultEpochKey,
    })),
    checkpoint: encodeCheckpoint(state.checkpoint),
    recoverySequence: state.recoverySequence,
    ...(state.requiredTransitionOperationId === undefined
      ? {}
      : { requiredTransitionOperationId: state.requiredTransitionOperationId }),
  }
}

function recoveryAad(vault: VaultId): Uint8Array {
  return encodeCanonical({
    domain: Domain.RecoveryPackage,
    protocolGeneration: CIPHER_SUITE.protocolGeneration,
    vaultId: vault,
    suite: {
      protocolGeneration: CIPHER_SUITE.protocolGeneration,
      aead: CIPHER_SUITE.aead,
      kdf: CIPHER_SUITE.kdf,
    },
  })
}

export async function encryptRecoveryPackage(
  state: RecoveryState,
  encryptionKey: RecoveryEncryptionKey,
): Promise<EncryptedRecoveryPackage> {
  const nonceValue = nonce(randomBytes(12))
  return {
    protocolGeneration: CIPHER_SUITE.protocolGeneration,
    vaultId: state.vaultId,
    nonce: nonceValue,
    ciphertext: await aesGcmEncrypt(
      encryptionKey,
      encodeCanonical(recoveryStateToCbor(state)),
      recoveryAad(state.vaultId),
      nonceValue,
    ),
    checkpoint: state.checkpoint,
  }
}

export interface RecoveryStateSigner {
  readonly deviceId: DeviceId
  readonly signingPrivateKey: Ed25519PrivateKey
  readonly authorizationChain: readonly DeviceCertificate[]
}

export function recoveryStateUpdateSigningBytes(state: RecoveryState): Uint8Array {
  return encodeCanonical({
    domain: "meridian/v1/recovery-state-update",
    state: recoveryStateToCbor(state),
  })
}

export async function encryptRecoveryPackageForPublicKey(
  state: RecoveryState,
  recoverySigningPublicKey: Ed25519PublicKey,
  signer: RecoveryStateSigner,
): Promise<EncryptedRecoveryPackage> {
  if (signer.authorizationChain.length < 1 || signer.authorizationChain.length > 32) {
    throw new AuthenticationError("Recovery state authorization chain is invalid")
  }
  const transfer = await hpkeSeal(
    x25519PublicKey(ed25519.utils.toMontgomery(recoverySigningPublicKey)),
    encodeCanonical({
      state: recoveryStateToCbor(state),
      authorization: {
        signerDeviceId: signer.deviceId,
        authorizationChain: signer.authorizationChain.map(encodeDeviceCertificate),
        signature: sign(recoveryStateUpdateSigningBytes(state), signer.signingPrivateKey),
      },
    }),
    recoveryAad(state.vaultId),
  )
  return {
    packageVersion: 2,
    protocolGeneration: CIPHER_SUITE.protocolGeneration,
    vaultId: state.vaultId,
    encapsulatedKey: transfer.encapsulatedKey,
    ciphertext: transfer.ciphertext,
    checkpoint: state.checkpoint,
  }
}

function fixedBytes(value: CborValue | undefined, length: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new AuthenticationError(`Recovery package ${label} must contain ${length} bytes`)
  }
  return value
}

function asRecord(value: CborValue): Record<string, CborValue> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Uint8Array ||
    value instanceof Map
  ) {
    throw new AuthenticationError("Recovery package plaintext is not a map")
  }
  return value as Record<string, CborValue>
}

export async function decryptRecoveryPackage(
  encrypted: EncryptedRecoveryPackage,
  encryptionKey: RecoveryEncryptionKey,
  recoverySigningPrivateKey?: Ed25519PrivateKey,
  recoverySigningPublicKey?: Ed25519PublicKey,
): Promise<RecoveryState> {
  if (encrypted.protocolGeneration !== CIPHER_SUITE.protocolGeneration) {
    throw new AuthenticationError("Recovery package protocol generation is unsupported")
  }
  let value: Record<string, CborValue>
  let authorization: CborValue | undefined
  if (encrypted.packageVersion === 2) {
    if (!recoverySigningPrivateKey || !recoverySigningPublicKey) {
      throw new AuthenticationError("Recovery signing keys are required for this package version")
    }
    const plaintext = await hpkeOpen(
      x25519PrivateKey(ed25519.utils.toMontgomerySecret(recoverySigningPrivateKey)),
      {
        encapsulatedKey: encrypted.encapsulatedKey,
        ciphertext: encrypted.ciphertext,
      },
      recoveryAad(encrypted.vaultId),
    )
    const envelope = asRecord(decodeCanonical(plaintext))
    if (Object.keys(envelope).sort().join("\0") !== "authorization\0state") {
      throw new AuthenticationError("Recovery package update envelope is malformed")
    }
    value = asRecord(envelope.state as CborValue)
    authorization = envelope.authorization
  } else {
    const plaintext = await aesGcmDecrypt(
      encryptionKey,
      encrypted.ciphertext,
      recoveryAad(encrypted.vaultId),
      encrypted.nonce,
    )
    value = asRecord(decodeCanonical(plaintext))
  }
  const expectedKeys = [
    "vaultId",
    "epoch",
    "vaultEpochKey",
    "epochKeys",
    "checkpoint",
    "recoverySequence",
    ...(value.requiredTransitionOperationId === undefined ? [] : ["requiredTransitionOperationId"]),
  ].sort()
  if (Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")) {
    throw new AuthenticationError("Recovery package has missing or unknown fields")
  }
  if (!(value.vaultId instanceof Uint8Array) || !bytesEqual(value.vaultId, encrypted.vaultId)) {
    throw new AuthenticationError("Recovery package was substituted between vaults")
  }
  if (!(value.epoch instanceof Uint8Array) || !(value.checkpoint instanceof Uint8Array)) {
    throw new AuthenticationError("Recovery package contains invalid signed objects")
  }
  if (!(value.vaultEpochKey instanceof Uint8Array)) {
    throw new AuthenticationError("Recovery package contains an invalid vault key")
  }
  if (
    !Array.isArray(value.epochKeys) ||
    value.epochKeys.length < 1 ||
    value.epochKeys.length > 1024
  ) {
    throw new AuthenticationError("Recovery package contains an invalid epoch keyring")
  }
  const epochKeys = value.epochKeys.map((entry) => {
    const record = asRecord(entry)
    if (
      Object.keys(record).sort().join("\0") !== "epochId\0vaultEpochKey" ||
      !(record.epochId instanceof Uint8Array) ||
      !(record.vaultEpochKey instanceof Uint8Array)
    ) {
      throw new AuthenticationError("Recovery package contains an invalid epoch key entry")
    }
    return {
      epochId: epochId(record.epochId),
      vaultEpochKey: vaultEpochKey(record.vaultEpochKey),
    }
  })
  for (let index = 0; index < epochKeys.length; index += 1) {
    if (
      epochKeys
        .slice(index + 1)
        .some((entry) => bytesEqual(entry.epochId, epochKeys[index]?.epochId ?? new Uint8Array()))
    ) {
      throw new AuthenticationError("Recovery package contains duplicate epoch keys")
    }
  }
  const declaredEpoch = decodeEpochDeclaration(value.epoch)
  const currentKey = epochKeys.find((entry) =>
    bytesEqual(entry.epochId, declaredEpoch.body.epochId),
  )
  if (!currentKey || !bytesEqual(currentKey.vaultEpochKey, value.vaultEpochKey)) {
    throw new AuthenticationError("Recovery package current epoch key is inconsistent")
  }
  if (
    typeof value.recoverySequence !== "number" ||
    !Number.isSafeInteger(value.recoverySequence) ||
    value.recoverySequence < 0
  ) {
    throw new AuthenticationError("Recovery package contains an invalid sequence")
  }
  const checkpoint = decodeCheckpoint(value.checkpoint)
  if (!bytesEqual(encodeCheckpoint(checkpoint), encodeCheckpoint(encrypted.checkpoint))) {
    throw new AuthenticationError(
      "Recovery package checkpoint does not match its public commitment",
    )
  }
  const requiredTransitionOperationId =
    value.requiredTransitionOperationId === undefined
      ? undefined
      : operationId(fixedBytes(value.requiredTransitionOperationId, 16, "transition operation ID"))
  const checkpointMatchesCurrent = bytesEqual(checkpoint.body.epochId, declaredEpoch.body.epochId)
  const checkpointPrecedesRequiredTransition =
    requiredTransitionOperationId !== undefined &&
    declaredEpoch.body.previousEpochId !== null &&
    bytesEqual(checkpoint.body.epochId, declaredEpoch.body.previousEpochId)
  if (
    !bytesEqual(declaredEpoch.body.vaultId, encrypted.vaultId) ||
    !bytesEqual(checkpoint.body.vaultId, encrypted.vaultId) ||
    (!checkpointMatchesCurrent && !checkpointPrecedesRequiredTransition)
  ) {
    throw new AuthenticationError("Recovery package signed state is internally inconsistent")
  }
  const state: RecoveryState = {
    vaultId: vaultId(value.vaultId),
    epoch: declaredEpoch,
    vaultEpochKey: vaultEpochKey(value.vaultEpochKey),
    epochKeys,
    checkpoint,
    recoverySequence: value.recoverySequence,
    ...(requiredTransitionOperationId === undefined ? {} : { requiredTransitionOperationId }),
  }
  if (encrypted.packageVersion === 2) {
    validateRecoveryStateAuthorization(
      state,
      authorization,
      recoverySigningPublicKey as Ed25519PublicKey,
    )
  }
  return state
}

function validateRecoveryStateAuthorization(
  state: RecoveryState,
  value: CborValue | undefined,
  recoverySigningPublicKey: Ed25519PublicKey,
): void {
  if (state.requiredTransitionOperationId === undefined) {
    throw new AuthenticationError("Owner-updated recovery state lacks its required transition")
  }
  const authorization = asRecord(value as CborValue)
  if (
    Object.keys(authorization).sort().join("\0") !== "authorizationChain\0signature\0signerDeviceId"
  ) {
    throw new AuthenticationError("Recovery state authorization is malformed")
  }
  if (
    !Array.isArray(authorization.authorizationChain) ||
    authorization.authorizationChain.length < 1 ||
    authorization.authorizationChain.length > 32
  ) {
    throw new AuthenticationError("Recovery state authorization chain is invalid")
  }
  const certificates = authorization.authorizationChain.map((encoded) =>
    decodeDeviceCertificate(fixedRecoveryObject(encoded, "authorization certificate")),
  )
  const signerDeviceId = deviceId(
    fixedBytes(authorization.signerDeviceId, 16, "state signer device ID"),
  )
  const signer = certificates.find((certificate) =>
    bytesEqual(certificate.body.deviceId, signerDeviceId),
  )
  if (!signer?.body.permissions.includes(Permission.RotateEpoch)) {
    throw new AuthenticationError("Recovery state signer cannot rotate vault epochs")
  }
  const byId = new Map(
    certificates.map((certificate) => [bytesToHex(certificate.body.certificateId), certificate]),
  )
  validateDeviceCertificate(signer, {
    recoveryPublicKey: recoverySigningPublicKey,
    lookup: (certificateId) => byId.get(bytesToHex(certificateId)),
    atCursor: state.checkpoint.body.cursor,
    atTime: Date.now(),
  })
  const signature = ed25519Signature(
    fixedBytes(authorization.signature, 64, "state update signature"),
  )
  if (
    !verify(recoveryStateUpdateSigningBytes(state), signature, signer.body.signingPublicKey) ||
    state.epoch.body.createdBy === "recovery" ||
    !bytesEqual(state.epoch.body.createdBy, signerDeviceId) ||
    !verify(
      epochSigningBytes(state.epoch.body),
      state.epoch.signature,
      signer.body.signingPublicKey,
    )
  ) {
    throw new AuthenticationError("Recovery state update signature is invalid")
  }
  const checkpointSigner = certificates.find((certificate) =>
    bytesEqual(certificate.body.deviceId, state.checkpoint.body.signerDeviceId),
  )
  if (!checkpointSigner || !verifyCheckpoint(state.checkpoint, checkpointSigner)) {
    throw new AuthenticationError("Recovery state checkpoint signature is invalid")
  }
}

function fixedRecoveryObject(value: CborValue, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new AuthenticationError(`Recovery package ${label} is invalid`)
  }
  return value
}
