import {
  type DeviceKeyBundle,
  deserializeDeviceKeyBundle,
  serializeDeviceKeyBundle,
  validateDeviceCertificate,
  verifyCheckpoint,
} from "@meridian/crypto"
import {
  bytesEqual,
  bytesToHex,
  type DeviceCertificate,
  decodeDeviceCertificate,
  ed25519PublicKey,
  encodeDeviceCertificate,
} from "@meridian/protocol"
import type { DeviceKeyMaterial, RemoteOperation } from "../model"
import { fromBase64Url, toBase64Url } from "../platform/bytes"

export interface StoredDeviceSecret {
  readonly version: 1 | 2
  readonly deviceBundle: string
  readonly recoveryPublicKey: string
  readonly checkpointAuthorizationChain: string[]
}

export function serializeStoredDeviceSecret(
  device: DeviceKeyBundle,
  recoveryPublicKey: Uint8Array,
  checkpointAuthorizationChain: readonly ReturnType<typeof decodeDeviceCertificate>[] = [
    device.certificate,
  ],
): string {
  const completeChain = exactDeviceAuthorizationChain(
    device.certificate,
    checkpointAuthorizationChain,
  )
  const stored = {
    version: 2,
    deviceBundle: toBase64Url(serializeDeviceKeyBundle(device)),
    recoveryPublicKey: toBase64Url(recoveryPublicKey),
    checkpointAuthorizationChain: completeChain.map((certificate) =>
      toBase64Url(encodeDeviceCertificate(certificate)),
    ),
  } satisfies StoredDeviceSecret
  if (!hasAuthorizedCheckpoint(stored)) {
    throw new Error("Device checkpoint authorization chain is invalid")
  }
  return JSON.stringify(stored)
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
      (value.version === 1 || value.version === 2) &&
      typeof value.deviceBundle === "string" &&
      typeof value.recoveryPublicKey === "string" &&
      (value.version === 1 || stringArray(value.checkpointAuthorizationChain))
    ) {
      return {
        version: value.version,
        deviceBundle: value.deviceBundle,
        recoveryPublicKey: value.recoveryPublicKey,
        checkpointAuthorizationChain:
          value.version === 2 && stringArray(value.checkpointAuthorizationChain)
            ? value.checkpointAuthorizationChain
            : [],
      }
    }
  } catch {
    // Legacy development bundles contained only canonical device bytes.
  }
  return {
    version: 1,
    deviceBundle: serialized,
    recoveryPublicKey: "",
    checkpointAuthorizationChain: [],
  }
}

export function hasAuthorizedCheckpoint(secret: StoredDeviceSecret): boolean {
  try {
    if (
      !secret.recoveryPublicKey ||
      secret.checkpointAuthorizationChain.length === 0 ||
      secret.checkpointAuthorizationChain.length > 32
    ) {
      return false
    }
    const bundle = deserializeDeviceKeyBundle(fromBase64Url(secret.deviceBundle))
    const certificates = secret.checkpointAuthorizationChain.map((encoded) =>
      decodeDeviceCertificate(fromBase64Url(encoded)),
    )
    const byId = new Map(
      certificates.map((certificate) => [bytesToHex(certificate.body.certificateId), certificate]),
    )
    const signer = certificates.find((certificate) =>
      bytesEqual(certificate.body.deviceId, bundle.checkpoint.body.signerDeviceId),
    )
    if (!signer || !bytesEqual(signer.body.vaultId, bundle.checkpoint.body.vaultId)) {
      return false
    }
    validateDeviceCertificate(signer, {
      recoveryPublicKey: ed25519PublicKey(fromBase64Url(secret.recoveryPublicKey)),
      lookup: (certificateId) => byId.get(bytesToHex(certificateId)),
      atCursor: bundle.checkpoint.body.cursor,
      atTime: Date.now(),
    })
    return verifyCheckpoint(bundle.checkpoint, signer)
  } catch {
    return false
  }
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

function exactDeviceAuthorizationChain(
  deviceCertificate: DeviceCertificate,
  certificates: readonly DeviceCertificate[],
): DeviceCertificate[] {
  const registry = new Map<string, DeviceCertificate>()
  for (const certificate of certificates) {
    const id = bytesToHex(certificate.body.certificateId)
    const existing = registry.get(id)
    if (
      existing &&
      !bytesEqual(encodeDeviceCertificate(existing), encodeDeviceCertificate(certificate))
    ) {
      throw new Error("Device authorization chain contains conflicting certificates")
    }
    registry.set(id, certificate)
  }

  const deviceId = bytesToHex(deviceCertificate.body.certificateId)
  const storedDevice = registry.get(deviceId)
  if (
    storedDevice &&
    !bytesEqual(encodeDeviceCertificate(storedDevice), encodeDeviceCertificate(deviceCertificate))
  ) {
    throw new Error("Stored device certificate conflicts with the key bundle")
  }
  registry.set(deviceId, deviceCertificate)

  const chain: DeviceCertificate[] = []
  const visited = new Set<string>()
  let current = deviceCertificate
  for (let depth = 0; depth < 32; depth += 1) {
    const currentId = bytesToHex(current.body.certificateId)
    if (visited.has(currentId)) throw new Error("Device authorization chain contains a cycle")
    visited.add(currentId)
    chain.push(current)
    if (current.body.issuer.kind === "recovery") return chain

    const issuer = registry.get(bytesToHex(current.body.issuer.certificateId))
    if (!issuer) throw new Error("Device authorization chain is incomplete")
    current = issuer
  }
  throw new Error("Device authorization chain exceeds the maximum depth")
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
