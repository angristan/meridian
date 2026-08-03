import { bytesEqual, type CborValue, type EpochId, type EpochKeyMaterial } from "@meridian/protocol"

type Fail = () => never

export function strictRecord(value: CborValue, fail: Fail): Record<string, CborValue> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Uint8Array ||
    value instanceof Map
  ) {
    return fail()
  }
  return value as Record<string, CborValue>
}

export function hasExactFields(
  value: Record<string, CborValue>,
  fields: readonly string[],
): boolean {
  return Object.keys(value).sort().join("\0") === [...fields].sort().join("\0")
}

export function fixedBytes(value: CborValue | undefined, length: number, fail: Fail): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) return fail()
  return value
}

export function decodeEpochKeyring(
  value: CborValue | undefined,
  decodeEntry: (value: CborValue) => EpochKeyMaterial,
  invalidKeyring: Fail,
  duplicateEpoch: Fail,
): readonly EpochKeyMaterial[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1024) {
    return invalidKeyring()
  }
  const entries = value.map(decodeEntry)
  for (let index = 0; index < entries.length; index += 1) {
    const current = entries[index]
    if (
      current !== undefined &&
      entries.slice(index + 1).some((entry) => bytesEqual(entry.epochId, current.epochId))
    ) {
      return duplicateEpoch()
    }
  }
  return entries
}

export function currentEpochKeyMatches(
  entries: readonly EpochKeyMaterial[],
  currentEpochId: EpochId,
  currentKey: unknown,
): boolean {
  if (!(currentKey instanceof Uint8Array)) return false
  const entry = entries.find((candidate) => bytesEqual(candidate.epochId, currentEpochId))
  return entry !== undefined && bytesEqual(entry.vaultEpochKey, currentKey)
}
