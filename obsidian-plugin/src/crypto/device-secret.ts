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
  readonly version: 2
  readonly deviceBundle: string
  readonly recoveryPublicKey: string
  readonly checkpointAuthorizationChain: string[]
}

export interface DecodedStoredDeviceSecret {
  readonly stored: StoredDeviceSecret
  readonly bundle: DeviceKeyBundle
}

type CertificateChainPolicy = "stored-device" | "pairing-approver"

export function serializeStoredDeviceSecret(
  device: DeviceKeyBundle,
  recoveryPublicKey: Uint8Array,
  checkpointAuthorizationChain: readonly DeviceCertificate[] = [device.certificate],
): string {
  const completeChain = exactCertificateChain(
    device.certificate,
    checkpointAuthorizationChain,
    "stored-device",
  )
  const stored = {
    version: 2,
    deviceBundle: toBase64Url(serializeDeviceKeyBundle(device)),
    recoveryPublicKey: toBase64Url(recoveryPublicKey),
    checkpointAuthorizationChain: completeChain.map((certificate) =>
      toBase64Url(encodeDeviceCertificate(certificate)),
    ),
  } satisfies StoredDeviceSecret
  if (!hasAuthorizedCheckpoint(stored, device)) {
    throw new Error("Device checkpoint authorization chain is invalid")
  }
  return JSON.stringify(stored)
}

export function decodedDeviceSecret(device: DeviceKeyMaterial): DecodedStoredDeviceSecret {
  const decoded = decodeStoredDeviceSecret(device.serialized)
  if (
    toBase64Url(decoded.bundle.deviceId) !== device.deviceId ||
    toBase64Url(decoded.bundle.vaultId) !== device.vaultId
  ) {
    throw new Error("Device key bundle scope does not match the connected vault")
  }
  return decoded
}

export function deviceBundle(device: DeviceKeyMaterial): DeviceKeyBundle {
  return decodedDeviceSecret(device).bundle
}

export function decodeStoredDeviceSecret(serialized: string): DecodedStoredDeviceSecret {
  const stored = parseStoredSecret(serialized)
  return {
    stored,
    bundle: deserializeDeviceKeyBundle(fromBase64Url(stored.deviceBundle)),
  }
}

function parseStoredSecret(serialized: string): StoredDeviceSecret {
  try {
    const value: unknown = JSON.parse(serialized)
    if (
      isRecord(value) &&
      value.version === 2 &&
      typeof value.deviceBundle === "string" &&
      typeof value.recoveryPublicKey === "string" &&
      stringArray(value.checkpointAuthorizationChain)
    ) {
      return {
        version: 2,
        deviceBundle: value.deviceBundle,
        recoveryPublicKey: value.recoveryPublicKey,
        checkpointAuthorizationChain: value.checkpointAuthorizationChain,
      }
    }
  } catch {
    // Report the stable format error below.
  }
  throw new Error("Stored device secret is not a supported Meridian key bundle")
}

export function hasAuthorizedCheckpoint(
  secret: StoredDeviceSecret,
  decodedBundle?: DeviceKeyBundle,
): boolean {
  try {
    if (
      !secret.recoveryPublicKey ||
      secret.checkpointAuthorizationChain.length === 0 ||
      secret.checkpointAuthorizationChain.length > 32
    ) {
      return false
    }
    const bundle = decodedBundle ?? deserializeDeviceKeyBundle(fromBase64Url(secret.deviceBundle))
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
  secret: DecodedStoredDeviceSecret,
  operation: RemoteOperation,
): DeviceCertificate {
  if (!operation.authorCertificate || !operation.certificateChain) {
    throw new Error("The operation author certificate is missing from the device registry")
  }
  if (!secret.stored.recoveryPublicKey) {
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
    recoveryPublicKey: ed25519PublicKey(fromBase64Url(secret.stored.recoveryPublicKey)),
    lookup: (certificateId) => byId.get(bytesToHex(certificateId)),
    atCursor: operation.cursor,
    atTime: Date.now(),
  })
  return author
}

export function exactCertificateChain(
  leaf: DeviceCertificate,
  certificates: readonly DeviceCertificate[],
  policy: CertificateChainPolicy,
): DeviceCertificate[] {
  const storedDevice = policy === "stored-device"
  const label = storedDevice ? "Device authorization" : "Approver certificate"
  const registry = new Map<string, DeviceCertificate>()
  for (const certificate of certificates) {
    const id = bytesToHex(certificate.body.certificateId)
    const existing = registry.get(id)
    if (
      storedDevice &&
      existing &&
      !bytesEqual(encodeDeviceCertificate(existing), encodeDeviceCertificate(certificate))
    ) {
      throw new Error("Device authorization chain contains conflicting certificates")
    }
    registry.set(id, certificate)
  }

  const leafId = bytesToHex(leaf.body.certificateId)
  const storedLeaf = registry.get(leafId)
  if (
    storedDevice &&
    storedLeaf &&
    !bytesEqual(encodeDeviceCertificate(storedLeaf), encodeDeviceCertificate(leaf))
  ) {
    throw new Error("Stored device certificate conflicts with the key bundle")
  }
  registry.set(leafId, leaf)

  const chain: DeviceCertificate[] = []
  const visited = new Set<string>()
  let current = leaf
  const maximumDepth = storedDevice ? 32 : Number.MAX_SAFE_INTEGER
  for (let depth = 0; depth < maximumDepth; depth += 1) {
    const currentId = bytesToHex(current.body.certificateId)
    if (visited.has(currentId)) throw new Error(`${label} chain contains a cycle`)
    visited.add(currentId)
    chain.push(current)
    if (current.body.issuer.kind === "recovery") return chain

    const issuer = registry.get(bytesToHex(current.body.issuer.certificateId))
    if (!issuer) throw new Error(`${label} chain is incomplete`)
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
