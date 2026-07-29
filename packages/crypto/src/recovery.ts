import {
  bytesEqual,
  type CborValue,
  CIPHER_SUITE,
  type DeviceId,
  Domain,
  decodeCanonical,
  decodeCheckpoint,
  decodeEpochDeclaration,
  type Ed25519PublicKey,
  type Ed25519Signature,
  type EncryptedRecoveryPackage,
  encodeCanonical,
  encodeCheckpoint,
  encodeEpochDeclaration,
  epochId,
  nonce,
  type RecoveryEncryptionKey,
  type RecoverySeed,
  type RecoveryState,
  recoverySeed,
  type VaultId,
  vaultEpochKey,
  vaultId,
  type X25519PublicKey,
} from "@meridian/protocol"
import { aesGcmDecrypt, aesGcmEncrypt } from "./aes.js"
import { AuthenticationError } from "./errors.js"
import { sha256 } from "./hash.js"
import { deriveRecoveryKeys } from "./kdf.js"
import { randomBytes } from "./runtime.js"
import { sign } from "./signatures.js"

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
  const expected = ["checkpoint", "ciphertext", "nonce", "protocolGeneration", "vaultId"].sort()
  if (Object.keys(value).sort().join("\0") !== expected.join("\0")) {
    throw new AuthenticationError("Recovery package has missing or unknown fields")
  }
  if (
    value.protocolGeneration !== CIPHER_SUITE.protocolGeneration ||
    !(value.vaultId instanceof Uint8Array) ||
    value.vaultId.byteLength !== 16 ||
    !(value.nonce instanceof Uint8Array) ||
    value.nonce.byteLength !== 12 ||
    !(value.ciphertext instanceof Uint8Array) ||
    value.ciphertext.byteLength < 16 ||
    !(value.checkpoint instanceof Uint8Array)
  ) {
    throw new AuthenticationError("Recovery package fields are invalid")
  }
  return {
    protocolGeneration: value.protocolGeneration,
    vaultId: vaultId(value.vaultId),
    nonce: nonce(value.nonce),
    ciphertext: value.ciphertext,
    checkpoint: decodeCheckpoint(value.checkpoint),
  }
}

export interface RecoveryClaimSigningInput {
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
    domain: "meridian/v1/recovery-claim",
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
): Promise<RecoveryState> {
  if (encrypted.protocolGeneration !== CIPHER_SUITE.protocolGeneration) {
    throw new AuthenticationError("Recovery package protocol generation is unsupported")
  }
  const plaintext = await aesGcmDecrypt(
    encryptionKey,
    encrypted.ciphertext,
    recoveryAad(encrypted.vaultId),
    encrypted.nonce,
  )
  const value = asRecord(decodeCanonical(plaintext))
  const expectedKeys = [
    "vaultId",
    "epoch",
    "vaultEpochKey",
    "epochKeys",
    "checkpoint",
    "recoverySequence",
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
  if (
    !bytesEqual(declaredEpoch.body.vaultId, encrypted.vaultId) ||
    !bytesEqual(checkpoint.body.vaultId, encrypted.vaultId) ||
    !bytesEqual(checkpoint.body.epochId, declaredEpoch.body.epochId)
  ) {
    throw new AuthenticationError("Recovery package signed state is internally inconsistent")
  }
  return {
    vaultId: vaultId(value.vaultId),
    epoch: declaredEpoch,
    vaultEpochKey: vaultEpochKey(value.vaultEpochKey),
    epochKeys,
    checkpoint,
    recoverySequence: value.recoverySequence,
  }
}
