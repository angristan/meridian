export type CborValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | readonly CborValue[]
  | { readonly [key: string]: CborValue }
  | ReadonlyMap<string, CborValue>

export interface CborDecodeLimits {
  readonly maxBytes?: number
  readonly maxDepth?: number
  readonly maxArrayLength?: number
  readonly maxMapEntries?: number
}

const DEFAULT_LIMITS = {
  maxBytes: 16 * 1024 * 1024,
  maxDepth: 64,
  maxArrayLength: 16_384,
  maxMapEntries: 4_096,
} as const

const textEncoder = new TextEncoder()
const fatalTextDecoder = new TextDecoder("utf-8", { fatal: true })

export class CanonicalCborError extends Error {
  readonly offset: number

  constructor(message: string, offset: number) {
    super(`${message} at byte ${offset}`)
    this.name = "CanonicalCborError"
    this.offset = offset
  }
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  if (left.byteLength !== right.byteLength) return left.byteLength - right.byteLength
  for (let index = 0; index < left.byteLength; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0)
  const output = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

function encodeArgument(major: number, argument: bigint): Uint8Array {
  if (argument < 0n || argument > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError("CBOR integer is outside the supported 64-bit range")
  }
  const initial = major << 5
  if (argument < 24n) return Uint8Array.of(initial | Number(argument))
  if (argument <= 0xffn) return Uint8Array.of(initial | 24, Number(argument))
  if (argument <= 0xffffn) {
    return Uint8Array.of(initial | 25, Number(argument >> 8n), Number(argument & 0xffn))
  }
  if (argument <= 0xffff_ffffn) {
    const output = new Uint8Array(5)
    output[0] = initial | 26
    new DataView(output.buffer).setUint32(1, Number(argument), false)
    return output
  }

  const output = new Uint8Array(9)
  output[0] = initial | 27
  const view = new DataView(output.buffer)
  view.setUint32(1, Number(argument >> 32n), false)
  view.setUint32(5, Number(argument & 0xffff_ffffn), false)
  return output
}

function encodeValue(value: CborValue, active: Set<object>): Uint8Array {
  if (value === null) return Uint8Array.of(0xf6)
  if (value === false) return Uint8Array.of(0xf4)
  if (value === true) return Uint8Array.of(0xf5)

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("Canonical protocol CBOR only permits safe integers")
    }
    return value >= 0 ? encodeArgument(0, BigInt(value)) : encodeArgument(1, BigInt(-1 - value))
  }

  if (typeof value === "bigint") {
    return value >= 0 ? encodeArgument(0, value) : encodeArgument(1, -1n - value)
  }

  if (typeof value === "string") {
    const bytes = textEncoder.encode(value)
    return concatenate([encodeArgument(3, BigInt(bytes.byteLength)), bytes])
  }

  if (value instanceof Uint8Array) {
    return concatenate([encodeArgument(2, BigInt(value.byteLength)), value])
  }

  if (typeof value !== "object") throw new TypeError("Unsupported CBOR value")
  if (active.has(value)) throw new TypeError("CBOR values must not contain cycles")
  active.add(value)

  try {
    if (Array.isArray(value)) {
      const entries = value.map((entry) => encodeValue(entry, active))
      return concatenate([encodeArgument(4, BigInt(entries.length)), ...entries])
    }

    let entries: readonly (readonly [string, CborValue])[]
    if (value instanceof Map) {
      entries = [...value.entries()]
      if (entries.some(([key]) => typeof key !== "string")) {
        throw new TypeError("Protocol CBOR map keys must be text strings")
      }
    } else {
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Protocol CBOR only encodes plain objects")
      }
      entries = Object.entries(value) as [string, CborValue][]
    }

    const encodedEntries = entries.map(([key, entryValue]) => ({
      key: encodeValue(key, active),
      value: encodeValue(entryValue, active),
    }))
    encodedEntries.sort((left, right) => compareBytes(left.key, right.key))
    for (let index = 1; index < encodedEntries.length; index += 1) {
      if (
        compareBytes(
          encodedEntries[index - 1]?.key ?? new Uint8Array(),
          encodedEntries[index]?.key ?? new Uint8Array(),
        ) === 0
      ) {
        throw new TypeError("Protocol CBOR maps must not contain duplicate keys")
      }
    }

    return concatenate([
      encodeArgument(5, BigInt(encodedEntries.length)),
      ...encodedEntries.flatMap(({ key, value: encodedValue }) => [key, encodedValue]),
    ])
  } finally {
    active.delete(value)
  }
}

/** Encodes the deterministic RFC 8949 subset used by Meridian. */
export function encodeCanonical(value: CborValue): Uint8Array {
  return encodeValue(value, new Set())
}

class Decoder {
  readonly bytes: Uint8Array
  readonly limits: Required<CborDecodeLimits>
  offset = 0

  constructor(bytes: Uint8Array, limits: CborDecodeLimits) {
    this.bytes = bytes
    this.limits = { ...DEFAULT_LIMITS, ...limits }
  }

  error(message: string, offset = this.offset): never {
    throw new CanonicalCborError(message, offset)
  }

  readByte(): number {
    const byte = this.bytes[this.offset]
    if (byte === undefined) this.error("Unexpected end of CBOR input")
    this.offset += 1
    return byte
  }

  readUnsigned(bytes: number): bigint {
    if (this.offset + bytes > this.bytes.byteLength) this.error("Truncated CBOR argument")
    let value = 0n
    for (let index = 0; index < bytes; index += 1) value = (value << 8n) | BigInt(this.readByte())
    return value
  }

  readArgument(additional: number, start: number): bigint {
    if (additional < 24) return BigInt(additional)
    if (additional === 24) {
      const value = this.readUnsigned(1)
      if (value < 24n) this.error("Non-canonical integer or length", start)
      return value
    }
    if (additional === 25) {
      const value = this.readUnsigned(2)
      if (value <= 0xffn) this.error("Non-canonical integer or length", start)
      return value
    }
    if (additional === 26) {
      const value = this.readUnsigned(4)
      if (value <= 0xffffn) this.error("Non-canonical integer or length", start)
      return value
    }
    if (additional === 27) {
      const value = this.readUnsigned(8)
      if (value <= 0xffff_ffffn) this.error("Non-canonical integer or length", start)
      return value
    }
    if (additional === 31) this.error("Indefinite-length CBOR is forbidden", start)
    this.error("Reserved CBOR additional information", start)
  }

  boundedLength(value: bigint, maximum: number, kind: string, start: number): number {
    if (value > BigInt(maximum)) this.error(`${kind} exceeds the configured limit`, start)
    return Number(value)
  }

  decode(depth: number): CborValue {
    const start = this.offset
    if (depth > this.limits.maxDepth) this.error("CBOR nesting exceeds the configured limit", start)
    const initial = this.readByte()
    const major = initial >> 5
    const additional = initial & 0x1f

    if (major === 0 || major === 1) {
      const argument = this.readArgument(additional, start)
      const value = major === 0 ? argument : -1n - argument
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : value
    }

    if (major === 2 || major === 3) {
      const length = this.boundedLength(
        this.readArgument(additional, start),
        this.limits.maxBytes,
        "Byte or text string",
        start,
      )
      if (this.offset + length > this.bytes.byteLength) this.error("Truncated CBOR string", start)
      const value = this.bytes.slice(this.offset, this.offset + length)
      this.offset += length
      if (major === 2) return value
      try {
        return fatalTextDecoder.decode(value)
      } catch {
        this.error("Invalid UTF-8 text string", start)
      }
    }

    if (major === 4) {
      const length = this.boundedLength(
        this.readArgument(additional, start),
        this.limits.maxArrayLength,
        "Array",
        start,
      )
      const result: CborValue[] = []
      for (let index = 0; index < length; index += 1) result.push(this.decode(depth + 1))
      return result
    }

    if (major === 5) {
      const length = this.boundedLength(
        this.readArgument(additional, start),
        this.limits.maxMapEntries,
        "Map",
        start,
      )
      const result: Record<string, CborValue> = Object.create(null) as Record<string, CborValue>
      let previousKey: Uint8Array | undefined
      for (let index = 0; index < length; index += 1) {
        const keyStart = this.offset
        const key = this.decode(depth + 1)
        const keyBytes = this.bytes.slice(keyStart, this.offset)
        if (typeof key !== "string")
          this.error("Protocol CBOR map keys must be text strings", keyStart)
        if (previousKey !== undefined && compareBytes(previousKey, keyBytes) >= 0) {
          this.error("Map keys are duplicate or not in canonical order", keyStart)
        }
        previousKey = keyBytes
        result[key] = this.decode(depth + 1)
      }
      return result
    }

    if (major === 6) this.error("CBOR tags are forbidden", start)
    if (additional === 20) return false
    if (additional === 21) return true
    if (additional === 22) return null
    if (additional === 25 || additional === 26 || additional === 27) {
      this.error("Floating-point values are forbidden", start)
    }
    this.error("Unsupported CBOR simple value", start)
  }
}

/** Decodes one exact canonical item and rejects non-canonical forms and trailing bytes. */
export function decodeCanonical(bytes: Uint8Array, limits: CborDecodeLimits = {}): CborValue {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("CBOR input must be a Uint8Array")
  const maxBytes = limits.maxBytes ?? DEFAULT_LIMITS.maxBytes
  if (bytes.byteLength > maxBytes) {
    throw new CanonicalCborError("CBOR input exceeds the configured limit", 0)
  }

  const decoder = new Decoder(bytes, limits)
  const value = decoder.decode(0)
  if (decoder.offset !== bytes.byteLength) {
    throw new CanonicalCborError("Trailing bytes after canonical CBOR item", decoder.offset)
  }
  return value
}

export function isCanonicalEncoding(bytes: Uint8Array, limits: CborDecodeLimits = {}): boolean {
  try {
    const decoded = decodeCanonical(bytes, limits)
    return compareBytes(bytes, encodeCanonical(decoded)) === 0
  } catch {
    return false
  }
}
