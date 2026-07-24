import {
  type CborValue,
  type Ed25519PrivateKey,
  ed25519PrivateKey,
  encodeCanonical,
  KdfLabel,
  type RecoveryEncryptionKey,
  type RecoverySeed,
  recoveryEncryptionKey,
} from "@meridian/protocol"
import { asArrayBuffer, webCrypto } from "./runtime.js"

export async function hkdfSha256(
  inputKeyMaterial: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(length) || length < 1 || length > 255 * 32) {
    throw new RangeError("HKDF output length is outside RFC 5869 limits")
  }
  const key = await webCrypto().subtle.importKey(
    "raw",
    asArrayBuffer(inputKeyMaterial),
    "HKDF",
    false,
    ["deriveBits"],
  )
  const bits = await webCrypto().subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: asArrayBuffer(salt),
      info: asArrayBuffer(info),
    },
    key,
    length * 8,
  )
  return new Uint8Array(bits)
}

export async function deriveLabeledKey(
  inputKeyMaterial: Uint8Array,
  label: (typeof KdfLabel)[keyof typeof KdfLabel],
  context: CborValue,
  length = 32,
): Promise<Uint8Array> {
  const info = encodeCanonical({ label, context })
  return hkdfSha256(inputKeyMaterial, new Uint8Array(32), info, length)
}

export interface RecoveryDerivedKeys {
  readonly signingPrivateKey: Ed25519PrivateKey
  readonly encryptionKey: RecoveryEncryptionKey
}

export async function deriveRecoveryKeys(seed: RecoverySeed): Promise<RecoveryDerivedKeys> {
  const [signing, encryption] = await Promise.all([
    deriveLabeledKey(seed, KdfLabel.RecoverySigningSeed, { purpose: "trust-anchor" }),
    deriveLabeledKey(seed, KdfLabel.RecoveryEncryptionKey, { purpose: "recovery-package" }),
  ])
  return {
    signingPrivateKey: ed25519PrivateKey(signing),
    encryptionKey: recoveryEncryptionKey(encryption),
  }
}
