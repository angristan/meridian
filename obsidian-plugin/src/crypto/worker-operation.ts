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

interface VerificationMessages {
  readonly accepts: readonly WorkerOperationType[]
  readonly signedType: SignedOperation["body"]["type"]
  readonly wrongWrapper: string
  readonly invalidWrapperSignature: string
  readonly wrongSignedType: string
  readonly invalidSignedSignature: string
  readonly bindingMismatch: string
  readonly maximumEnvelopeBytes?: number
  readonly requiresSubjectDeviceId?: boolean
}

const VERIFICATION: Record<ExpectedWorkerOperation, VerificationMessages> = {
  file: {
    accepts: ["revision", "tombstone", "restore"],
    signedType: "revision",
    wrongWrapper: "Remote operation is not a file revision",
    invalidWrapperSignature: "Worker file operation signature is invalid",
    wrongSignedType: "Worker file operation does not contain an encrypted revision",
    invalidSignedSignature: "Revision operation signature is invalid",
    bindingMismatch: "Worker file operation does not match its signed revision",
  },
  "device-revocation": {
    accepts: ["device-revocation"],
    signedType: "device-revocation",
    wrongWrapper: "Remote operation is not a device revocation",
    invalidWrapperSignature: "Device revocation signature is invalid",
    wrongSignedType: "Revocation envelope has the wrong operation type",
    invalidSignedSignature: "Canonical device revocation signature is invalid",
    bindingMismatch: "Device revocation envelope does not match its signed operation",
    requiresSubjectDeviceId: true,
  },
  "key-epoch": {
    accepts: ["key-epoch"],
    signedType: "epoch-transition",
    wrongWrapper: "Remote operation is not an epoch transition",
    invalidWrapperSignature: "Epoch transition wrapper signature is invalid",
    wrongSignedType: "Epoch transition envelope has the wrong operation type",
    invalidSignedSignature: "Epoch transition operation signature is invalid",
    bindingMismatch: "Epoch transition does not match its operation-log entry",
    maximumEnvelopeBytes: 2 * 1024 * 1024,
  },
  "log-format-transition": {
    accepts: ["log-format-transition"],
    signedType: "log-format-transition",
    wrongWrapper: "Remote operation is not a log format transition",
    invalidWrapperSignature: "Log format transition wrapper signature is invalid",
    wrongSignedType: "Log format transition envelope has the wrong operation type",
    invalidSignedSignature: "Canonical log format transition signature is invalid",
    bindingMismatch: "Log format transition does not match the legacy log head",
  },
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
  const messages = VERIFICATION[expected]
  const wire = parseWorkerOperation(operation.envelope)
  if (
    !messages.accepts.includes(wire.type) ||
    (messages.requiresSubjectDeviceId && !wire.subjectDeviceId)
  ) {
    throw new Error(messages.wrongWrapper)
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
    throw new Error(messages.invalidWrapperSignature)
  }

  const signedOperation = decodeOperation(
    fromBase64Url(wire.envelope, messages.maximumEnvelopeBytes),
  )
  if (signedOperation.body.type !== messages.signedType) {
    throw new Error(messages.wrongSignedType)
  }
  if (!verifyOperation(signedOperation, authorCertificate)) {
    throw new Error(messages.invalidSignedSignature)
  }
  if (
    toBase64Url(signedOperation.body.operationId) !== wire.operationId ||
    toBase64Url(signedOperation.body.vaultId) !== device.vaultId ||
    toBase64Url(signedOperation.body.epochId) !== wire.epochId ||
    signedOperation.body.authorDeviceId === "recovery" ||
    toBase64Url(signedOperation.body.authorDeviceId) !== wire.authorDeviceId
  ) {
    throw new Error(messages.bindingMismatch)
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
