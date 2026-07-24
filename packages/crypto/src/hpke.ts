import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core"
import {
  type HpkeTransfer,
  type X25519PrivateKey,
  type X25519PublicKey,
  x25519PrivateKey,
  x25519PublicKey,
} from "@meridian/protocol"
import { AuthenticationError, CryptoError } from "./errors.js"
import { sha256 } from "./hash.js"
import { asArrayBuffer } from "./runtime.js"

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
})

export interface HpkeKeyPair {
  readonly privateKey: X25519PrivateKey
  readonly publicKey: X25519PublicKey
}

export async function generateHpkeKeyPair(): Promise<HpkeKeyPair> {
  try {
    const pair = await suite.kem.generateKeyPair()
    const [privateKey, publicKey] = await Promise.all([
      suite.kem.serializePrivateKey(pair.privateKey),
      suite.kem.serializePublicKey(pair.publicKey),
    ])
    return {
      privateKey: x25519PrivateKey(new Uint8Array(privateKey)),
      publicKey: x25519PublicKey(new Uint8Array(publicKey)),
    }
  } catch (error) {
    throw new CryptoError("HPKE_KEY_GENERATION_FAILED", "HPKE key generation failed", error)
  }
}

/**
 * HPKE info is SHA-256(transcript), respecting the library's 128-byte info cap.
 * The complete transcript is also supplied as AEAD associated data.
 */
export async function hpkeSeal(
  recipientPublicKey: X25519PublicKey,
  plaintext: Uint8Array,
  transcript: Uint8Array,
): Promise<HpkeTransfer> {
  try {
    const [publicKey, info] = await Promise.all([
      suite.kem.deserializePublicKey(asArrayBuffer(recipientPublicKey)),
      sha256(transcript),
    ])
    const sealed = await suite.seal(
      { recipientPublicKey: publicKey, info: asArrayBuffer(info) },
      asArrayBuffer(plaintext),
      asArrayBuffer(transcript),
    )
    return {
      encapsulatedKey: new Uint8Array(sealed.enc),
      ciphertext: new Uint8Array(sealed.ct),
    }
  } catch (error) {
    throw new CryptoError("HPKE_SEAL_FAILED", "HPKE pairing encryption failed", error)
  }
}

export async function hpkeOpen(
  recipientPrivateKey: X25519PrivateKey,
  transfer: HpkeTransfer,
  transcript: Uint8Array,
): Promise<Uint8Array> {
  try {
    const [privateKey, info] = await Promise.all([
      suite.kem.deserializePrivateKey(asArrayBuffer(recipientPrivateKey)),
      sha256(transcript),
    ])
    const plaintext = await suite.open(
      {
        recipientKey: privateKey,
        enc: asArrayBuffer(transfer.encapsulatedKey),
        info: asArrayBuffer(info),
      },
      asArrayBuffer(transfer.ciphertext),
      asArrayBuffer(transcript),
    )
    return new Uint8Array(plaintext)
  } catch (error) {
    throw new AuthenticationError("HPKE pairing package authentication failed", error)
  }
}
