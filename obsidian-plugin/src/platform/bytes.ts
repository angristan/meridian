const textEncoder = new TextEncoder()

export function randomId(byteLength = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  return toBase64Url(bytes)
}

export async function fingerprint(bytes: ArrayBuffer): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
}

export async function equalBytes(left: ArrayBuffer, right: ArrayBuffer): Promise<boolean> {
  if (left.byteLength !== right.byteLength) return false
  const [leftFingerprint, rightFingerprint] = await Promise.all([
    fingerprint(left),
    fingerprint(right),
  ])
  return leftFingerprint === rightFingerprint
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

export function fromBase64Url(
  value: string,
  maximumBytes = 16 * 1024 * 1024,
): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new Error("Invalid base64url data")
  }
  const estimatedBytes = Math.floor((value.length * 3) / 4)
  if (estimatedBytes > maximumBytes) throw new Error("Base64url payload exceeds the size limit")
  const padding = "=".repeat((4 - (value.length % 4)) % 4)
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export function encodeUtf8(value: string): ArrayBuffer {
  return textEncoder.encode(value).buffer
}

export function decodeUtf8(bytes: ArrayBuffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}

export function cloneBuffer(bytes: ArrayBuffer): ArrayBuffer {
  return bytes.slice(0)
}
