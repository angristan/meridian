import { verify, verifyOperation } from "@meridian/crypto"
import {
  decodeOperation,
  ed25519Signature,
  type Operation as HttpOperation,
  httpOperationSigningBytes,
  type SignedOperation,
  type StoredOperation,
} from "@meridian/protocol"
import type { DeviceKeyMaterial, RemoteOperation } from "../model"
import { fromBase64Url, toBase64Url } from "../platform/bytes"
import {
  type DecodedStoredDeviceSecret,
  decodedDeviceSecret,
  trustedAuthorCertificate,
} from "./device-secret"

export type WorkerOperationType = Exclude<StoredOperation["type"], "merge">

export interface WorkerOperation extends Omit<HttpOperation, "type"> {
  readonly type: WorkerOperationType
}

type ExpectedWorkerOperation =
  | "file"
  | Exclude<WorkerOperationType, "revision" | "tombstone" | "restore">

type SignedOperationFor<T extends ExpectedWorkerOperation> = {
  readonly body: Extract<
    SignedOperation["body"],
    {
      readonly type: T extends "file" ? "revision" : T extends "key-epoch" ? "epoch-transition" : T
    }
  >
  readonly signature: SignedOperation["signature"]
}

export type VerifiedWorkerOperation<T extends ExpectedWorkerOperation> = {
  readonly secret: DecodedStoredDeviceSecret
  readonly wire: WorkerOperation
  readonly authorCertificate: ReturnType<typeof trustedAuthorCertificate>
  readonly signedOperation: SignedOperationFor<T>
}

export function workerOperationSigningBytes(
  operation: Omit<WorkerOperation, "signature">,
): Uint8Array {
  return httpOperationSigningBytes({
    ...operation,
    envelope: fromBase64Url(operation.envelope),
  })
}

export function verifyWorkerOperation<T extends ExpectedWorkerOperation>(
  device: DeviceKeyMaterial,
  operation: RemoteOperation,
  expected: T,
): VerifiedWorkerOperation<T> {
  const wire = parseWorkerOperation(operation.envelope)
  if (
    !acceptsExpectedType(expected, wire) ||
    (expected === "device-revocation" && !wire.subjectDeviceId)
  ) {
    throw new Error(`Remote operation is not a valid ${expected} operation`)
  }

  const secret = decodedDeviceSecret(device)
  const authorCertificate =
    wire.authorDeviceId === device.deviceId
      ? secret.bundle.certificate
      : trustedAuthorCertificate(secret, operation)
  const unsigned: Omit<WorkerOperation, "signature"> = {
    operationId: wire.operationId,
    authorDeviceId: wire.authorDeviceId,
    epochId: wire.epochId,
    type: wire.type,
    ...(wire.subjectDeviceId === undefined ? {} : { subjectDeviceId: wire.subjectDeviceId }),
    envelope: wire.envelope,
  }
  if (
    !verify(
      workerOperationSigningBytes(unsigned),
      ed25519Signature(fromBase64Url(wire.signature, 64)),
      authorCertificate.body.signingPublicKey,
    )
  ) {
    throw new Error(`Worker ${expected} signature is invalid`)
  }

  const maximumBytes = expected === "key-epoch" ? 2 * 1024 * 1024 : undefined
  const signedOperation = decodeOperation(fromBase64Url(wire.envelope, maximumBytes))
  if (signedOperation.body.type !== expectedSignedType(expected)) {
    throw new Error(`Canonical ${expected} operation has the wrong type`)
  }
  if (!verifyOperation(signedOperation, authorCertificate)) {
    throw new Error(`Canonical ${expected} signature is invalid`)
  }
  const operationIdMatches = toBase64Url(signedOperation.body.operationId) === wire.operationId
  if (
    // Early file revisions used separate signed IDs in the Worker wrapper and canonical envelope.
    // Both signatures still bind the complete envelope. Current writers always use one ID.
    (expected !== "file" && !operationIdMatches) ||
    toBase64Url(signedOperation.body.vaultId) !== device.vaultId ||
    toBase64Url(signedOperation.body.epochId) !== wire.epochId ||
    signedOperation.body.authorDeviceId === "recovery" ||
    toBase64Url(signedOperation.body.authorDeviceId) !== wire.authorDeviceId
  ) {
    throw new Error(`Worker ${expected} operation does not match its canonical signature`)
  }

  return { secret, wire, authorCertificate, signedOperation } as VerifiedWorkerOperation<T>
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

function acceptsExpectedType(expected: ExpectedWorkerOperation, wire: WorkerOperation): boolean {
  return expected === "file"
    ? wire.type === "revision" || wire.type === "tombstone" || wire.type === "restore"
    : wire.type === expected
}

function expectedSignedType(expected: ExpectedWorkerOperation): SignedOperation["body"]["type"] {
  if (expected === "file") return "revision"
  return expected === "key-epoch" ? "epoch-transition" : expected
}

function operationType(value: unknown): WorkerOperationType {
  if (
    value !== "revision" &&
    value !== "tombstone" &&
    value !== "restore" &&
    value !== "device-revocation" &&
    value !== "key-epoch" &&
    value !== "log-format-transition"
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
