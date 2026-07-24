import {
  type DeviceKeyBundle,
  deserializeDeviceKeyBundle,
  serializeDeviceKeyBundle,
  validateDeviceCertificate,
} from "@meridian/crypto"
import { bytesToHex, decodeDeviceCertificate, ed25519PublicKey } from "@meridian/protocol"
import type { DeviceKeyMaterial, RemoteOperation } from "../model"
import { fromBase64Url, toBase64Url } from "../platform/bytes"

export interface StoredDeviceSecret {
  readonly version: 1
  readonly deviceBundle: string
  readonly recoveryPublicKey: string
}

export function serializeStoredDeviceSecret(
  device: DeviceKeyBundle,
  recoveryPublicKey: Uint8Array,
): string {
  return JSON.stringify({
    version: 1,
    deviceBundle: toBase64Url(serializeDeviceKeyBundle(device)),
    recoveryPublicKey: toBase64Url(recoveryPublicKey),
  } satisfies StoredDeviceSecret)
}

export function deviceBundle(device: DeviceKeyMaterial): DeviceKeyBundle {
  const bundle = deviceBundleFromSecret(device.serialized)
  if (
    toBase64Url(bundle.deviceId) !== device.deviceId ||
    toBase64Url(bundle.vaultId) !== device.vaultId
  ) {
    throw new Error("Device key bundle scope does not match the connected vault")
  }
  return bundle
}

export function deviceBundleFromSecret(serialized: string): DeviceKeyBundle {
  return deserializeDeviceKeyBundle(fromBase64Url(parseStoredSecret(serialized).deviceBundle))
}

export function parseStoredSecret(serialized: string): StoredDeviceSecret {
  try {
    const value: unknown = JSON.parse(serialized)
    if (
      isRecord(value) &&
      value.version === 1 &&
      typeof value.deviceBundle === "string" &&
      typeof value.recoveryPublicKey === "string"
    ) {
      return value as unknown as StoredDeviceSecret
    }
  } catch {
    // Legacy development bundles contained only canonical device bytes.
  }
  return { version: 1, deviceBundle: serialized, recoveryPublicKey: "" }
}

export function trustedAuthorCertificate(
  device: DeviceKeyMaterial,
  operation: RemoteOperation,
): ReturnType<typeof decodeDeviceCertificate> {
  if (!operation.authorCertificate || !operation.certificateChain) {
    throw new Error("The operation author certificate is missing from the device registry")
  }
  const secret = parseStoredSecret(device.serialized)
  if (!secret.recoveryPublicKey) {
    throw new Error("The local key bundle has no recovery trust anchor")
  }
  const certificates = operation.certificateChain.map((encoded) =>
    decodeDeviceCertificate(fromBase64Url(encoded)),
  )
  const author = decodeDeviceCertificate(fromBase64Url(operation.authorCertificate))
  const byId = new Map(
    certificates.map((certificate) => [bytesToHex(certificate.body.certificateId), certificate]),
  )
  validateDeviceCertificate(author, {
    recoveryPublicKey: ed25519PublicKey(fromBase64Url(secret.recoveryPublicKey)),
    lookup: (certificateId) => byId.get(bytesToHex(certificateId)),
    atCursor: operation.cursor,
    atTime: Date.now(),
  })
  return author
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
