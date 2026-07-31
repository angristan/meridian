import { httpOperationSigningBytes, logChainSigningBytes } from "@meridian/protocol"
import type { RemoteOperation } from "../model"
import { fromBase64Url, toBase64Url } from "../platform/bytes"

const MAX_ENVELOPE_BYTES = 256 * 1024

export async function assertRemoteLogLink(
  operation: RemoteOperation,
  expectedPreviousHash: string,
): Promise<void> {
  const wire = record(operation.envelope)
  const previousHash = requiredString(wire, "previousHash")
  const chainHash = requiredString(wire, "chainHash")
  if (previousHash !== expectedPreviousHash) {
    throw new Error(`Operation log hash is discontinuous at cursor ${operation.cursor}`)
  }
  if (chainHash !== operation.logHash) {
    throw new Error(`Operation log hash disagrees at cursor ${operation.cursor}`)
  }
  const subjectDeviceId = optionalString(wire, "subjectDeviceId")
  const operationMessage = httpOperationSigningBytes({
    operationId: requiredString(wire, "operationId"),
    authorDeviceId: requiredString(wire, "authorDeviceId"),
    epochId: requiredString(wire, "epochId"),
    type: requiredString(wire, "type"),
    ...(subjectDeviceId === undefined ? {} : { subjectDeviceId }),
    envelope: fromBase64Url(requiredString(wire, "envelope"), MAX_ENVELOPE_BYTES),
  })
  const hashInput = logChainSigningBytes(
    decodeExact(previousHash, 32, "previousHash"),
    operationMessage,
    decodeExact(requiredString(wire, "signature"), 64, "signature"),
  )
  const computed = toBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", copy(hashInput))),
  )
  if (computed !== chainHash) {
    throw new Error(`Operation log hash verification failed at cursor ${operation.cursor}`)
  }
}

function decodeExact(value: string, byteLength: number, field: string): Uint8Array {
  const decoded = fromBase64Url(value, byteLength)
  if (decoded.byteLength !== byteLength)
    throw new Error(`Server operation contains invalid ${field}`)
  return decoded
}

function copy(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copied = new Uint8Array(value.byteLength)
  copied.set(value)
  return copied
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Server returned an invalid operation log entry")
  }
  return value as Record<string, unknown>
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Server operation is missing ${key}`)
  }
  return field
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Server operation contains invalid ${key}`)
  }
  return field
}
