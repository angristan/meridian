import { CryptoError } from "./errors.js"

export function webCrypto(): Crypto {
  const runtime = globalThis.crypto
  if (runtime?.subtle === undefined || runtime.getRandomValues === undefined) {
    throw new CryptoError("WEBCRYPTO_UNAVAILABLE", "This runtime does not provide WebCrypto")
  }
  return runtime
}

export function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return new Uint8Array(value).buffer
}

export function randomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 1 || length > 65_536) {
    throw new RangeError("Random byte length must be between 1 and 65536")
  }
  return webCrypto().getRandomValues(new Uint8Array(length))
}
