import {
  type Ed25519PrivateKey,
  type Ed25519PublicKey,
  type Ed25519Signature,
  ed25519PrivateKey,
  ed25519PublicKey,
  ed25519Signature,
} from "@meridian/protocol"
import { ed25519 } from "@noble/curves/ed25519.js"
import { randomBytes } from "./runtime.js"

export interface SigningKeyPair {
  readonly privateKey: Ed25519PrivateKey
  readonly publicKey: Ed25519PublicKey
}

export function signingKeyPairFromSeed(seed: Uint8Array): SigningKeyPair {
  const privateKey = ed25519PrivateKey(seed)
  const publicKey = ed25519PublicKey(ed25519.getPublicKey(privateKey))
  return { privateKey, publicKey }
}

export function generateSigningKeyPair(): SigningKeyPair {
  return signingKeyPairFromSeed(randomBytes(32))
}

export function sign(message: Uint8Array, privateKey: Ed25519PrivateKey): Ed25519Signature {
  return ed25519Signature(ed25519.sign(message, privateKey))
}

/** RFC 8032 verification: ZIP-215's relaxed point acceptance is intentionally disabled. */
export function verify(
  message: Uint8Array,
  signature: Ed25519Signature,
  publicKey: Ed25519PublicKey,
): boolean {
  try {
    if (!ed25519.utils.isValidPublicKey(publicKey, false)) return false
    return ed25519.verify(signature, message, publicKey, { zip215: false })
  } catch {
    return false
  }
}
