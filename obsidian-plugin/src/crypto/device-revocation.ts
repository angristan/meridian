import {
  sign,
  signOperation,
  validateDeviceCertificate,
  verify,
  verifyOperation,
} from "@meridian/crypto"
import {
  bytesEqual,
  bytesToHex,
  CIPHER_SUITE,
  decodeDeviceCertificate,
  decodeOperation,
  deviceId,
  ed25519PublicKey,
  ed25519Signature,
  encodeDeviceCertificate,
  encodeOperation,
  operationId,
  Permission,
} from "@meridian/protocol"
import type {
  DeviceKeyMaterial,
  DeviceRevocationMaterial,
  DeviceRevocationRecord,
  RemoteDevice,
  RemoteOperation,
} from "../model"
import { fromBase64Url, randomId, toBase64Url } from "../platform/bytes"
import { deviceBundle, parseStoredSecret, trustedAuthorCertificate } from "./device-secret"
import {
  parseWorkerOperation,
  type WorkerOperation,
  workerOperationSigningBytes,
} from "./worker-operation"

export async function createDeviceRevocation(
  device: DeviceKeyMaterial,
  target: RemoteDevice,
): Promise<DeviceRevocationMaterial> {
  const bundle = deviceBundle(device)
  const targetDeviceId = deviceId(fromBase64Url(target.deviceId))
  const selfRevocation = bytesEqual(targetDeviceId, bundle.deviceId)
  const managesDevices = bundle.certificate.body.permissions.includes(Permission.ManageDevices)
  if (selfRevocation && managesDevices) {
    throw new Error("The owner device cannot remove itself; use recovery after owner loss")
  }
  if (!selfRevocation && !managesDevices) {
    throw new Error("A member device can remove only itself")
  }
  if (target.revokedAt !== null) throw new Error("The selected device is already revoked")

  const targetCertificate = decodeDeviceCertificate(fromBase64Url(target.certificate))
  if (
    !bytesEqual(targetCertificate.body.vaultId, bundle.vaultId) ||
    !bytesEqual(targetCertificate.body.deviceId, targetDeviceId)
  ) {
    throw new Error("The selected device certificate does not match the registry")
  }
  if (selfRevocation) {
    if (
      !bytesEqual(
        encodeDeviceCertificate(targetCertificate),
        encodeDeviceCertificate(bundle.certificate),
      )
    ) {
      throw new Error("The current device certificate does not match the registry")
    }
  } else {
    const stored = parseStoredSecret(device.serialized)
    if (!stored.recoveryPublicKey) {
      throw new Error("The local key bundle has no recovery trust anchor")
    }
    const certificates = new Map([
      [bytesToHex(bundle.certificate.body.certificateId), bundle.certificate],
      [bytesToHex(targetCertificate.body.certificateId), targetCertificate],
    ])
    validateDeviceCertificate(targetCertificate, {
      recoveryPublicKey: ed25519PublicKey(fromBase64Url(stored.recoveryPublicKey)),
      lookup: (certificateId) => certificates.get(bytesToHex(certificateId)),
      atCursor: bundle.checkpoint.body.cursor,
      atTime: Date.now(),
    })
  }

  const operationIdentifier = operationId(fromBase64Url(randomId()))
  const signedLifecycleOperation = signOperation(
    {
      type: "device-revocation",
      operationId: operationIdentifier,
      vaultId: bundle.vaultId,
      epochId: bundle.epoch.body.epochId,
      authorDeviceId: bundle.deviceId,
      certificateId: targetCertificate.body.certificateId,
      reason: "retired",
      suite: CIPHER_SUITE,
    },
    bundle.signingPrivateKey,
  )
  const unsigned: Omit<WorkerOperation, "signature"> = {
    operationId: toBase64Url(operationIdentifier),
    authorDeviceId: device.deviceId,
    epochId: toBase64Url(bundle.epoch.body.epochId),
    type: "device-revocation",
    subjectDeviceId: target.deviceId,
    envelope: toBase64Url(encodeOperation(signedLifecycleOperation)),
  }
  return {
    targetDeviceId: target.deviceId,
    operationId: unsigned.operationId,
    envelope: {
      ...unsigned,
      signature: toBase64Url(sign(workerOperationSigningBytes(unsigned), bundle.signingPrivateKey)),
    },
  }
}

export async function verifyDeviceRevocation(
  device: DeviceKeyMaterial,
  operation: RemoteOperation,
): Promise<DeviceRevocationRecord> {
  const wire = parseWorkerOperation(operation.envelope)
  if (wire.type !== "device-revocation" || !wire.subjectDeviceId) {
    throw new Error("Remote operation is not a device revocation")
  }

  const bundle = deviceBundle(device)
  const authorCertificate =
    wire.authorDeviceId === device.deviceId
      ? bundle.certificate
      : trustedAuthorCertificate(device, operation)
  const selfRevocation = wire.authorDeviceId === wire.subjectDeviceId
  const managesDevices = authorCertificate.body.permissions.includes(Permission.ManageDevices)
  if ((!selfRevocation && !managesDevices) || (selfRevocation && managesDevices)) {
    throw new Error(
      selfRevocation
        ? "The owner device cannot revoke itself"
        : "Revocation author is not an authorized device manager",
    )
  }
  const unsigned: Omit<WorkerOperation, "signature"> = {
    operationId: wire.operationId,
    authorDeviceId: wire.authorDeviceId,
    epochId: wire.epochId,
    type: wire.type,
    subjectDeviceId: wire.subjectDeviceId,
    envelope: wire.envelope,
  }
  if (
    !verify(
      workerOperationSigningBytes(unsigned),
      ed25519Signature(fromBase64Url(wire.signature)),
      authorCertificate.body.signingPublicKey,
    )
  ) {
    throw new Error("Device revocation signature is invalid")
  }

  const lifecycleOperation = decodeOperation(fromBase64Url(wire.envelope))
  if (lifecycleOperation.body.type !== "device-revocation") {
    throw new Error("Revocation envelope has the wrong operation type")
  }
  if (!verifyOperation(lifecycleOperation, authorCertificate)) {
    throw new Error("Canonical device revocation signature is invalid")
  }
  const targetCertificate = findTargetCertificate(
    lifecycleOperation.body.certificateId,
    operation.certificateChain,
  )
  if (lifecycleOperation.body.authorDeviceId === "recovery") {
    throw new Error("Interactive revocation must be authored by an owner device")
  }
  if (
    lifecycleOperation.body.reason !== "retired" ||
    toBase64Url(lifecycleOperation.body.operationId) !== wire.operationId ||
    toBase64Url(lifecycleOperation.body.vaultId) !== device.vaultId ||
    toBase64Url(lifecycleOperation.body.epochId) !== wire.epochId ||
    toBase64Url(lifecycleOperation.body.authorDeviceId) !== wire.authorDeviceId ||
    toBase64Url(targetCertificate.body.deviceId) !== wire.subjectDeviceId
  ) {
    throw new Error("Device revocation envelope does not match its signed operation")
  }

  return { deviceId: wire.subjectDeviceId, operationId: wire.operationId, cursor: operation.cursor }
}

function findTargetCertificate(
  targetCertificateId: Uint8Array,
  certificateChain: string[] | undefined,
): ReturnType<typeof decodeDeviceCertificate> {
  if (!certificateChain) throw new Error("Device registry is missing for revocation verification")
  const target = certificateChain
    .map((encoded) => decodeDeviceCertificate(fromBase64Url(encoded)))
    .find((certificate) => bytesEqual(certificate.body.certificateId, targetCertificateId))
  if (!target) throw new Error("Revoked device certificate is missing from the registry")
  return target
}
