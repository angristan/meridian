import { httpOperationSigningBytes } from "@meridian/protocol"
import { fromBase64Url } from "../platform/bytes"

export type WorkerOperationType =
  | "revision"
  | "tombstone"
  | "restore"
  | "device-revocation"
  | "key-epoch"

export interface WorkerOperation {
  readonly operationId: string
  readonly authorDeviceId: string
  readonly epochId: string
  readonly type: WorkerOperationType
  readonly subjectDeviceId?: string
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
  const type = operationType(value.type)
  const subjectDeviceId = value.subjectDeviceId
  if (subjectDeviceId !== undefined && typeof subjectDeviceId !== "string") {
    throw new Error("Remote operation has an invalid subject device")
  }
  return {
    operationId: requireString(value, "operationId"),
    authorDeviceId: requireString(value, "authorDeviceId"),
    epochId: requireString(value, "epochId"),
    type,
    ...(subjectDeviceId === undefined ? {} : { subjectDeviceId }),
    envelope: requireString(value, "envelope"),
    signature: requireString(value, "signature"),
  }
}

export function parseFileWorkerOperation(value: unknown): WorkerOperation & {
  type: "revision" | "tombstone" | "restore"
} {
  const operation = parseWorkerOperation(value)
  if (
    operation.type !== "revision" &&
    operation.type !== "tombstone" &&
    operation.type !== "restore"
  ) {
    throw new Error("Remote operation is not a file revision")
  }
  return operation as WorkerOperation & { type: "revision" | "tombstone" | "restore" }
}

function operationType(value: unknown): WorkerOperationType {
  if (
    value !== "revision" &&
    value !== "tombstone" &&
    value !== "restore" &&
    value !== "device-revocation" &&
    value !== "key-epoch"
  ) {
    throw new Error("Remote operation has an invalid type")
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireString(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== "string" || field.length === 0) throw new Error(`Value is missing ${key}`)
  return field
}
