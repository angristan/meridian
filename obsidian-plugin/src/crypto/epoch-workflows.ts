import {
  applyEpochTransition as applyPackageEpochTransition,
  prepareEpochTransition as preparePackageEpochTransition,
  sign,
  verify,
} from "@meridian/crypto"
import {
  decodeDeviceCertificate,
  decodeOperation,
  deviceId,
  ed25519PublicKey,
  ed25519Signature,
  encodeOperation,
  hashBytes,
  x25519PublicKey,
} from "@meridian/protocol"
import type {
  DeviceKeyMaterial,
  EpochTransitionMaterial,
  RemoteDevice,
  RemoteOperation,
} from "../model"
import { fromBase64Url, toBase64Url } from "../platform/bytes"
import {
  deviceBundle,
  parseStoredSecret,
  serializeStoredDeviceSecret,
  trustedAuthorCertificate,
} from "./device-secret"
import { loadDevice } from "./device-workflows"
import {
  parseWorkerOperation,
  type WorkerOperation,
  workerOperationSigningBytes,
} from "./worker-operation"

export async function createEpochTransition(
  device: DeviceKeyMaterial,
  recipients: RemoteDevice[],
  recoveryStateId: string,
  reason: "scheduled" | "revocation" | "migration",
): Promise<EpochTransitionMaterial> {
  const bundle = deviceBundle(device)
  const stored = parseStoredSecret(device.serialized)
  if (!stored.recoveryPublicKey || stored.checkpointAuthorizationChain.length === 0) {
    throw new Error("Device secret lacks recovery authorization for epoch rotation")
  }
  const prepared = await preparePackageEpochTransition({
    device: bundle,
    recipients: recipients.map((recipient) => ({
      deviceId: deviceId(fromBase64Url(recipient.deviceId, 16)),
      hpkePublicKey: x25519PublicKey(fromBase64Url(recipient.hpkePublicKey, 32)),
    })),
    recoverySigningPublicKey: ed25519PublicKey(fromBase64Url(stored.recoveryPublicKey, 32)),
    recoveryStateId: hashBytes(fromBase64Url(recoveryStateId, 32)),
    checkpointAuthorizationChain: stored.checkpointAuthorizationChain.map((certificate) =>
      decodeDeviceCertificate(fromBase64Url(certificate)),
    ),
    reason,
  })
  const unsigned: Omit<WorkerOperation, "signature"> = {
    operationId: toBase64Url(prepared.operation.body.operationId),
    authorDeviceId: device.deviceId,
    epochId: device.epochId,
    type: "key-epoch",
    envelope: toBase64Url(encodeOperation(prepared.operation)),
  }
  return {
    operationId: unsigned.operationId,
    nextEpochId: toBase64Url(prepared.nextEpochId),
    envelope: {
      ...unsigned,
      signature: toBase64Url(sign(workerOperationSigningBytes(unsigned), bundle.signingPrivateKey)),
    },
  }
}

export async function applyEpochTransition(
  device: DeviceKeyMaterial,
  operation: RemoteOperation,
): Promise<DeviceKeyMaterial> {
  const wire = parseWorkerOperation(operation.envelope)
  if (wire.type !== "key-epoch") throw new Error("Remote operation is not an epoch transition")
  const bundle = deviceBundle(device)
  const authorCertificate =
    wire.authorDeviceId === device.deviceId
      ? bundle.certificate
      : trustedAuthorCertificate(device, operation)
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
    throw new Error("Epoch transition wrapper signature is invalid")
  }
  const signed = decodeOperation(fromBase64Url(wire.envelope, 2 * 1024 * 1024))
  if (
    signed.body.type !== "epoch-transition" ||
    toBase64Url(signed.body.operationId) !== wire.operationId ||
    toBase64Url(signed.body.vaultId) !== device.vaultId ||
    toBase64Url(signed.body.epochId) !== wire.epochId ||
    toBase64Url(signed.body.authorDeviceId) !== wire.authorDeviceId ||
    signed.body.previousCursor + 1 !== operation.cursor
  ) {
    throw new Error("Epoch transition does not match its operation-log entry")
  }
  const updated = await applyPackageEpochTransition({
    device: bundle,
    operation: signed,
    authorCertificate,
    cursor: operation.cursor,
    logHash: hashBytes(fromBase64Url(operation.logHash, 32)),
  })
  const stored = parseStoredSecret(device.serialized)
  const serialized = serializeStoredDeviceSecret(
    updated,
    ed25519PublicKey(fromBase64Url(stored.recoveryPublicKey, 32)),
    stored.checkpointAuthorizationChain.map((certificate) =>
      decodeDeviceCertificate(fromBase64Url(certificate)),
    ),
  )
  return loadDevice(serialized)
}
