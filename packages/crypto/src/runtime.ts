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

export function concatenateBytes(...values: readonly Uint8Array[]): Uint8Array {
  const length = values.reduce((total, value) => total + value.byteLength, 0)
  const output = new Uint8Array(length)
  let offset = 0
  for (const value of values) {
    output.set(value, offset)
    offset += value.byteLength
  }
  return output
}

export function zeroize(value: Uint8Array): void {
  value.fill(0)
}
