import { HttpError } from "./errors"

const encoder = new TextEncoder()
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

export const ZERO_HASH = base64UrlEncode(new Uint8Array(32))

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

export function base64UrlDecode(value: string, maximumBytes = 256 * 1024): Uint8Array {
  if (!BASE64URL_PATTERN.test(value)) {
    throw new HttpError(400, "invalid_encoding", "Expected unpadded base64url data")
  }

  const padding = "=".repeat((4 - (value.length % 4)) % 4)
  let binary: string
  try {
    binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding)
  } catch {
    throw new HttpError(400, "invalid_encoding", "Expected valid base64url data")
  }

  if (binary.length > maximumBytes) {
    throw new HttpError(413, "value_too_large", "Encoded value exceeds its size limit")
  }

  const output = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index)
  if (base64UrlEncode(output) !== value) {
    throw new HttpError(400, "invalid_encoding", "Expected canonical unpadded base64url data")
  }
  return output
}

export function assertIdentifier(value: string, field = "identifier"): void {
  try {
    if (!IDENTIFIER_PATTERN.test(value)) throw new Error("invalid identifier characters")
    base64UrlDecode(value, 96)
  } catch {
    throw new HttpError(400, "invalid_identifier", `${field} is invalid`)
  }
}

export function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes)
  crypto.getRandomValues(value)
  return base64UrlEncode(value)
}

function webCryptoBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", webCryptoBytes(bytes)))
}

export async function hashToken(token: string): Promise<string> {
  return base64UrlEncode(await sha256(encoder.encode(token)))
}

export async function constantTimeSecretEquals(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    sha256(encoder.encode(left)),
    sha256(encoder.encode(right)),
  ])
  let difference = 0
  for (let index = 0; index < leftHash.length; index += 1) {
    difference |= (leftHash.at(index) ?? 0) ^ (rightHash.at(index) ?? 0)
  }
  return difference === 0
}

export function concatBytes(...values: ReadonlyArray<Uint8Array>): Uint8Array {
  const output = new Uint8Array(values.reduce((total, value) => total + value.length, 0))
  let offset = 0
  for (const value of values) {
    output.set(value, offset)
    offset += value.length
  }
  return output
}

export async function verifyEd25519(
  publicKey: string,
  signature: string,
  message: Uint8Array,
): Promise<boolean> {
  const keyBytes = base64UrlDecode(publicKey, 32)
  const signatureBytes = base64UrlDecode(signature, 64)
  if (keyBytes.length !== 32 || signatureBytes.length !== 64) return false

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      webCryptoBytes(keyBytes),
      { name: "Ed25519" },
      false,
      ["verify"],
    )
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      webCryptoBytes(signatureBytes),
      webCryptoBytes(message),
    )
  } catch {
    return false
  }
}
