import { sign, signOperation, validateDeviceCertificate } from "@meridian/crypto"
import {
  bytesEqual,
  bytesToHex,
  CIPHER_SUITE,
  decodeDeviceCertificate,
  deviceId,
  ed25519PublicKey,
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
import { decodedDeviceSecret } from "./device-secret"
import {
  verifyWorkerOperation,
  type WorkerOperation,
  workerOperationSigningBytes,
} from "./worker-operation"

export async function createDeviceRevocation(
  device: DeviceKeyMaterial,
  target: RemoteDevice,
): Promise<DeviceRevocationMaterial> {
  const secret = decodedDeviceSecret(device)
  const { bundle } = secret
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
    if (!secret.stored.recoveryPublicKey) {
      throw new Error("The local key bundle has no recovery trust anchor")
    }
    const certificates = new Map([
      [bytesToHex(bundle.certificate.body.certificateId), bundle.certificate],
      [bytesToHex(targetCertificate.body.certificateId), targetCertificate],
    ])
    validateDeviceCertificate(targetCertificate, {
      recoveryPublicKey: ed25519PublicKey(fromBase64Url(secret.stored.recoveryPublicKey)),
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
  const verified = verifyWorkerOperation(device, operation, "device-revocation")
  const { wire, authorCertificate, signedOperation: lifecycleOperation } = verified
  const subjectDeviceId = wire.subjectDeviceId as string
  const selfRevocation = wire.authorDeviceId === subjectDeviceId
  const managesDevices = authorCertificate.body.permissions.includes(Permission.ManageDevices)
  if ((!selfRevocation && !managesDevices) || (selfRevocation && managesDevices)) {
    throw new Error(
      selfRevocation
        ? "The owner device cannot revoke itself"
        : "Revocation author is not an authorized device manager",
    )
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
    toBase64Url(targetCertificate.body.deviceId) !== subjectDeviceId
  ) {
    throw new Error("Device revocation envelope does not match its signed operation")
  }

  return { deviceId: subjectDeviceId, operationId: wire.operationId, cursor: operation.cursor }
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
