import { type Hash, hashBytes } from "@meridian/protocol"
import { asArrayBuffer, webCrypto } from "./runtime.js"

export async function sha256(value: Uint8Array): Promise<Hash> {
  const digest = await webCrypto().subtle.digest("SHA-256", asArrayBuffer(value))
  return hashBytes(new Uint8Array(digest))
}
