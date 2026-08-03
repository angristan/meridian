import {
  applyEpochTransition as applyPackageEpochTransition,
  prepareEpochTransition as preparePackageEpochTransition,
  sign,
} from "@meridian/crypto"
import {
  decodeDeviceCertificate,
  deviceId,
  ed25519PublicKey,
  encodeOperation,
  hashBytes,
  x25519PublicKey,
} from "@meridian/protocol"
import type {
  DeviceKeyMaterial,
  EpochTransitionMaterial,
  RemoteDevice,
  RemoteOperation,
  TrustedCheckpoint,
} from "../model"
import { fromBase64Url, toBase64Url } from "../platform/bytes"
import {
  decodedDeviceSecret,
  hasAuthorizedCheckpoint,
  serializeStoredDeviceSecret,
} from "./device-secret"
import { loadDevice, refreshTrustedCheckpoint } from "./device-workflows"
import {
  verifyWorkerOperation,
  type WorkerOperation,
  workerOperationSigningBytes,
} from "./worker-operation"

export async function createEpochTransition(
  device: DeviceKeyMaterial,
  recipients: RemoteDevice[],
  recoveryStateId: string,
  reason: "scheduled" | "revocation" | "migration",
): Promise<EpochTransitionMaterial> {
  const secret = decodedDeviceSecret(device)
  const { bundle, stored } = secret
  if (
    !stored.recoveryPublicKey ||
    stored.checkpointAuthorizationChain.length === 0 ||
    !hasAuthorizedCheckpoint(stored, bundle)
  ) {
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
  predecessor: TrustedCheckpoint,
): Promise<DeviceKeyMaterial> {
  const verified = verifyWorkerOperation(device, operation, "key-epoch")
  const { authorCertificate, signedOperation: signed } = verified
  if (signed.body.previousCursor + 1 !== operation.cursor) {
    throw new Error("Epoch transition does not match its operation-log entry")
  }
  if (
    predecessor.cursor !== signed.body.previousCursor ||
    predecessor.logHash !== toBase64Url(signed.body.previousLogHash)
  ) {
    throw new Error("Epoch transition does not match the verified predecessor")
  }
  const registryCertificates = (operation.certificateChain ?? []).map((certificate) =>
    decodeDeviceCertificate(fromBase64Url(certificate)),
  )
  const applyingDevice =
    signed.body.declaration.body.sequence > device.epochSequence
      ? await refreshTrustedCheckpoint(device, predecessor, registryCertificates)
      : device
  const applyingSecret =
    applyingDevice === device ? verified.secret : decodedDeviceSecret(applyingDevice)
  const updated = await applyPackageEpochTransition({
    device: applyingSecret.bundle,
    operation: signed,
    authorCertificate,
    cursor: operation.cursor,
    logHash: hashBytes(fromBase64Url(operation.logHash, 32)),
  })
  const serialized = serializeStoredDeviceSecret(
    updated,
    ed25519PublicKey(fromBase64Url(applyingSecret.stored.recoveryPublicKey, 32)),
    applyingSecret.stored.checkpointAuthorizationChain.map((certificate) =>
      decodeDeviceCertificate(fromBase64Url(certificate)),
    ),
  )
  return loadDevice(serialized)
}
