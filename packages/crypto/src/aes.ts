import {
  bytesToHex,
  type EpochId,
  KdfLabel,
  type Nonce,
  nonce,
  type RevisionId,
  type RevisionKey,
  revisionKey,
  type VaultEpochKey,
  type VaultId,
  type WrappedRevisionKey,
  wrappedRevisionKey,
} from "@meridian/protocol"
import { AuthenticationError, NonceReuseError } from "./errors.js"
import { deriveLabeledKey } from "./kdf.js"
import { asArrayBuffer, randomBytes, webCrypto } from "./runtime.js"

export interface AesGcmCiphertext {
  readonly nonce: Nonce
  /** Ciphertext with the 128-bit authentication tag appended by WebCrypto. */
  readonly ciphertext: Uint8Array
}

export class NonceRegistry {
  readonly #seen = new Set<string>()

  add(value: Nonce): void {
    const encoded = bytesToHex(value)
    if (this.#seen.has(encoded)) throw new NonceReuseError()
    this.#seen.add(encoded)
  }

  has(value: Nonce): boolean {
    return this.#seen.has(bytesToHex(value))
  }

  get size(): number {
    return this.#seen.size
  }
}

async function importAesGcmKey(key: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  if (key.byteLength !== 32) throw new RangeError("AES-256-GCM keys must contain 32 bytes")
  return webCrypto().subtle.importKey("raw", asArrayBuffer(key), { name: "AES-GCM" }, false, usages)
}

export async function aesGcmEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  additionalData: Uint8Array,
  nonceValue: Nonce,
): Promise<Uint8Array> {
  const cryptoKey = await importAesGcmKey(key, ["encrypt"])
  const encrypted = await webCrypto().subtle.encrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(nonceValue),
      additionalData: asArrayBuffer(additionalData),
      tagLength: 128,
    },
    cryptoKey,
    asArrayBuffer(plaintext),
  )
  return new Uint8Array(encrypted)
}

export async function aesGcmDecrypt(
  key: Uint8Array,
  ciphertext: Uint8Array,
  additionalData: Uint8Array,
  nonceValue: Nonce,
): Promise<Uint8Array> {
  try {
    const cryptoKey = await importAesGcmKey(key, ["decrypt"])
    const decrypted = await webCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: asArrayBuffer(nonceValue),
        additionalData: asArrayBuffer(additionalData),
        tagLength: 128,
      },
      cryptoKey,
      asArrayBuffer(ciphertext),
    )
    return new Uint8Array(decrypted)
  } catch (error) {
    throw new AuthenticationError("AES-GCM authentication failed", error)
  }
}

export class RevisionCipher {
  readonly key: RevisionKey
  readonly nonces = new NonceRegistry()

  constructor(key: RevisionKey = revisionKey(randomBytes(32))) {
    this.key = key
  }

  async encrypt(plaintext: Uint8Array, additionalData: Uint8Array): Promise<AesGcmCiphertext> {
    let nonceValue: Nonce
    do nonceValue = nonce(randomBytes(12))
    while (this.nonces.has(nonceValue))
    this.nonces.add(nonceValue)
    return {
      nonce: nonceValue,
      ciphertext: await aesGcmEncrypt(this.key, plaintext, additionalData, nonceValue),
    }
  }

  async encryptWithNonce(
    plaintext: Uint8Array,
    additionalData: Uint8Array,
    nonceValue: Nonce,
  ): Promise<AesGcmCiphertext> {
    this.nonces.add(nonceValue)
    return {
      nonce: nonceValue,
      ciphertext: await aesGcmEncrypt(this.key, plaintext, additionalData, nonceValue),
    }
  }
}

export async function deriveRevisionKek(
  epochKey: VaultEpochKey,
  vaultId: VaultId,
  epochId: EpochId,
  revisionIdValue: RevisionId,
): Promise<Uint8Array> {
  return deriveLabeledKey(epochKey, KdfLabel.RevisionKek, {
    vaultId,
    epochId,
    revisionId: revisionIdValue,
  })
}

async function wrapAesKw(
  kekBytes: Uint8Array,
  keyBytes: Uint8Array,
  keyUsages: KeyUsage[],
): Promise<Uint8Array> {
  const subtle = webCrypto().subtle
  const [kek, keyToWrap] = await Promise.all([
    subtle.importKey("raw", asArrayBuffer(kekBytes), "AES-KW", false, ["wrapKey"]),
    subtle.importKey("raw", asArrayBuffer(keyBytes), "AES-GCM", true, keyUsages),
  ])
  return new Uint8Array(await subtle.wrapKey("raw", keyToWrap, kek, "AES-KW"))
}

async function unwrapAesKw(
  kekBytes: Uint8Array,
  wrapped: Uint8Array,
  keyUsages: KeyUsage[],
): Promise<Uint8Array> {
  const subtle = webCrypto().subtle
  const kek = await subtle.importKey("raw", asArrayBuffer(kekBytes), "AES-KW", false, ["unwrapKey"])
  const key = await subtle.unwrapKey(
    "raw",
    asArrayBuffer(wrapped),
    kek,
    "AES-KW",
    "AES-GCM",
    true,
    keyUsages,
  )
  return new Uint8Array(await subtle.exportKey("raw", key))
}

export async function aesKwWrap(kekBytes: Uint8Array, keyBytes: Uint8Array): Promise<Uint8Array> {
  if (kekBytes.byteLength !== 32 || keyBytes.byteLength !== 32) {
    throw new RangeError("AES-256-KW requires a 32-byte KEK and 32-byte wrapped key")
  }
  return wrapAesKw(kekBytes, keyBytes, ["encrypt"])
}

export async function aesKwUnwrap(kekBytes: Uint8Array, wrapped: Uint8Array): Promise<Uint8Array> {
  if (kekBytes.byteLength !== 32 || wrapped.byteLength !== 40) {
    throw new RangeError("AES-256-KW requires a 32-byte KEK and 40-byte wrapped value")
  }
  try {
    return await unwrapAesKw(kekBytes, wrapped, ["encrypt"])
  } catch (error) {
    throw new AuthenticationError("AES-KW integrity check failed", error)
  }
}

export async function wrapRevisionKey(
  epochKey: VaultEpochKey,
  vaultId: VaultId,
  epochId: EpochId,
  revisionIdValue: RevisionId,
  key: RevisionKey,
): Promise<WrappedRevisionKey> {
  const kekBytes = await deriveRevisionKek(epochKey, vaultId, epochId, revisionIdValue)
  return wrappedRevisionKey(await wrapAesKw(kekBytes, key, ["encrypt", "decrypt"]))
}

export async function unwrapRevisionKey(
  epochKey: VaultEpochKey,
  vaultId: VaultId,
  epochId: EpochId,
  revisionIdValue: RevisionId,
  wrapped: WrappedRevisionKey,
): Promise<RevisionKey> {
  try {
    const kekBytes = await deriveRevisionKek(epochKey, vaultId, epochId, revisionIdValue)
    return revisionKey(await unwrapAesKw(kekBytes, wrapped, ["encrypt", "decrypt"]))
  } catch (error) {
    throw new AuthenticationError("Revision key unwrap failed", error)
  }
}
