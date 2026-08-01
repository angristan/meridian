import { sign, signOperation, verify, verifyOperation } from "@meridian/crypto"
import {
  CIPHER_SUITE,
  decodeOperation,
  ed25519Signature,
  encodeOperation,
  hashBytes,
  LogFormat,
  operationId,
  Permission,
} from "@meridian/protocol"
import type {
  DeviceKeyMaterial,
  LogFormatUpgradeMaterial,
  RemoteOperation,
  TrustedCheckpoint,
} from "../model"
import { fromBase64Url, randomId, toBase64Url } from "../platform/bytes"
import { deviceBundle, trustedAuthorCertificate } from "./device-secret"
import {
  parseWorkerOperation,
  type WorkerOperation,
  workerOperationSigningBytes,
} from "./worker-operation"

export async function createLogFormatUpgrade(
  device: DeviceKeyMaterial,
  checkpoint: TrustedCheckpoint,
): Promise<LogFormatUpgradeMaterial> {
  const bundle = deviceBundle(device)
  if (!bundle.certificate.body.permissions.includes(Permission.ManageDevices)) {
    throw new Error("Only the vault owner can upgrade the log format")
  }
  const formats = checkpointFormats(checkpoint)
  if (formats.logFormat !== LogFormat.LegacyHttpV1) {
    throw new Error("Vault log format is already upgraded")
  }
  if (formats.initialLogFormat !== LogFormat.LegacyHttpV1) {
    throw new Error("Vault log format state is invalid")
  }

  const operationIdentifier = operationId(fromBase64Url(randomId()))
  const signedTransition = signOperation(
    {
      type: "log-format-transition",
      operationId: operationIdentifier,
      vaultId: bundle.vaultId,
      epochId: bundle.epoch.body.epochId,
      authorDeviceId: bundle.deviceId,
      previousCursor: checkpoint.cursor,
      previousLogHash: hashBytes(fromBase64Url(checkpoint.logHash, 32)),
      nextLogFormat: LogFormat.CanonicalCborV1,
      suite: CIPHER_SUITE,
    },
    bundle.signingPrivateKey,
  )
  const unsigned: Omit<WorkerOperation, "signature"> = {
    operationId: toBase64Url(operationIdentifier),
    authorDeviceId: device.deviceId,
    epochId: toBase64Url(bundle.epoch.body.epochId),
    type: "log-format-transition",
    envelope: toBase64Url(encodeOperation(signedTransition)),
  }
  return {
    operationId: unsigned.operationId,
    envelope: {
      ...unsigned,
      signature: toBase64Url(sign(workerOperationSigningBytes(unsigned), bundle.signingPrivateKey)),
    },
  }
}

export async function verifyLogFormatUpgrade(
  device: DeviceKeyMaterial,
  operation: RemoteOperation,
): Promise<"canonical-cbor-v1"> {
  const wire = parseWorkerOperation(operation.envelope)
  if (wire.type !== "log-format-transition") {
    throw new Error("Remote operation is not a log format transition")
  }
  const bundle = deviceBundle(device)
  const authorCertificate =
    wire.authorDeviceId === device.deviceId
      ? bundle.certificate
      : trustedAuthorCertificate(device, operation)
  if (!authorCertificate.body.permissions.includes(Permission.ManageDevices)) {
    throw new Error("Log format transition author is not a device manager")
  }
  const unsigned: Omit<WorkerOperation, "signature"> = {
    operationId: wire.operationId,
    authorDeviceId: wire.authorDeviceId,
    epochId: wire.epochId,
    type: wire.type,
    envelope: wire.envelope,
  }
  if (
    !verify(
      workerOperationSigningBytes(unsigned),
      ed25519Signature(fromBase64Url(wire.signature, 64)),
      authorCertificate.body.signingPublicKey,
    )
  ) {
    throw new Error("Log format transition wrapper signature is invalid")
  }

  const transition = decodeOperation(fromBase64Url(wire.envelope))
  if (transition.body.type !== "log-format-transition") {
    throw new Error("Log format transition envelope has the wrong operation type")
  }
  if (!verifyOperation(transition, authorCertificate)) {
    throw new Error("Canonical log format transition signature is invalid")
  }
  const body = transition.body
  const previousHash = stringField(operation.envelope, "previousHash")
  if (
    toBase64Url(body.operationId) !== wire.operationId ||
    toBase64Url(body.vaultId) !== device.vaultId ||
    toBase64Url(body.epochId) !== wire.epochId ||
    toBase64Url(body.authorDeviceId) !== wire.authorDeviceId ||
    body.previousCursor + 1 !== operation.cursor ||
    toBase64Url(body.previousLogHash) !== previousHash ||
    body.nextLogFormat !== LogFormat.CanonicalCborV1
  ) {
    throw new Error("Log format transition does not match the legacy log head")
  }
  return body.nextLogFormat
}

function checkpointFormats(checkpoint: TrustedCheckpoint): {
  initialLogFormat: "legacy-http-v1" | "canonical-cbor-v1"
  logFormat: "legacy-http-v1" | "canonical-cbor-v1"
} {
  return {
    initialLogFormat: checkpoint.initialLogFormat ?? LogFormat.LegacyHttpV1,
    logFormat: checkpoint.logFormat ?? LogFormat.LegacyHttpV1,
  }
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Remote log format transition is invalid")
  }
  const result = (value as Record<string, unknown>)[field]
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`Remote log format transition is missing ${field}`)
  }
  return result
}
