import { httpOperationSigningBytes } from "@meridian/protocol"
import { fromBase64Url } from "../platform/bytes"

export interface WorkerOperation {
  readonly operationId: string
  readonly authorDeviceId: string
  readonly epochId: string
  readonly type: "revision" | "tombstone" | "restore"
  readonly envelope: string
  readonly signature: string
}

export function workerOperationSigningBytes(
  operation: Omit<WorkerOperation, "signature">,
): Uint8Array {
  return httpOperationSigningBytes({
    ...operation,
    envelope: fromBase64Url(operation.envelope),
  })
}

export function parseWorkerOperation(value: unknown): WorkerOperation {
  if (!isRecord(value)) throw new Error("Remote operation has an invalid envelope")
  const type = value.type
  if (type !== "revision" && type !== "tombstone" && type !== "restore") {
    throw new Error("Remote operation is not a file revision")
  }
  return {
    operationId: requireString(value, "operationId"),
    authorDeviceId: requireString(value, "authorDeviceId"),
    epochId: requireString(value, "epochId"),
    type,
    envelope: requireString(value, "envelope"),
    signature: requireString(value, "signature"),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireString(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== "string" || field.length === 0) throw new Error(`Value is missing ${key}`)
  return field
}
