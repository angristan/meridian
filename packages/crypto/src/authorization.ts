import {
  bytesEqual,
  bytesToHex,
  type CertificateLookup,
  type CheckpointBody,
  certificateSigningBytes,
  checkpointSigningBytes,
  type DeviceCertificate,
  type DeviceCertificateBody,
  type DeviceId,
  type Ed25519PrivateKey,
  type Ed25519PublicKey,
  type EpochDeclaration,
  type EpochDeclarationBody,
  epochSigningBytes,
  type HpkeTransfer,
  operationSigningBytes,
  type PairingContext,
  Permission,
  pairingTransferSigningBytes,
  type SignedCheckpoint,
  type SignedOperation,
} from "@meridian/protocol"
import { AuthorizationError } from "./errors.js"
import { sign, verify } from "./signatures.js"

export function signDeviceCertificate(
  body: DeviceCertificateBody,
  issuerPrivateKey: Ed25519PrivateKey,
): DeviceCertificate {
  return { body, signature: sign(certificateSigningBytes(body), issuerPrivateKey) }
}

export function signEpochDeclaration(
  body: EpochDeclarationBody,
  issuerPrivateKey: Ed25519PrivateKey,
): EpochDeclaration {
  return { body, signature: sign(epochSigningBytes(body), issuerPrivateKey) }
}

export function signCheckpoint(
  body: CheckpointBody,
  devicePrivateKey: Ed25519PrivateKey,
): SignedCheckpoint {
  return { body, signature: sign(checkpointSigningBytes(body), devicePrivateKey) }
}

export function signOperation(
  body: SignedOperation["body"],
  devicePrivateKey: Ed25519PrivateKey,
): SignedOperation {
  return { body, signature: sign(operationSigningBytes(body), devicePrivateKey) }
}

export function verifyOperation(operation: SignedOperation, author: DeviceCertificate): boolean {
  return (
    bytesEqual(operation.body.vaultId, author.body.vaultId) &&
    operation.body.authorDeviceId !== "recovery" &&
    bytesEqual(operation.body.authorDeviceId, author.body.deviceId) &&
    verify(operationSigningBytes(operation.body), operation.signature, author.body.signingPublicKey)
  )
}

export function verifyCheckpoint(checkpoint: SignedCheckpoint, signer: DeviceCertificate): boolean {
  return (
    bytesEqual(checkpoint.body.vaultId, signer.body.vaultId) &&
    bytesEqual(checkpoint.body.signerDeviceId, signer.body.deviceId) &&
    verify(
      checkpointSigningBytes(checkpoint.body),
      checkpoint.signature,
      signer.body.signingPublicKey,
    )
  )
}

export interface CertificateValidationOptions {
  readonly recoveryPublicKey: Ed25519PublicKey
  readonly lookup: CertificateLookup
  readonly atCursor: number
  readonly atTime: number
  /** Map certificate hex ID to its effective revocation cursor. */
  readonly revokedAt?: ReadonlyMap<string, number>
}

export function validateDeviceCertificate(
  certificate: DeviceCertificate,
  options: CertificateValidationOptions,
): readonly DeviceCertificate[] {
  const chain: DeviceCertificate[] = []
  const visited = new Set<string>()
  let current = certificate

  for (let depth = 0; depth < 32; depth += 1) {
    const id = bytesToHex(current.body.certificateId)
    if (visited.has(id)) throw new AuthorizationError("Device certificate chain contains a cycle")
    visited.add(id)
    chain.push(current)

    if (current.body.validFromCursor > options.atCursor) {
      throw new AuthorizationError("Device certificate is not valid at this cursor")
    }
    if (current.body.expiresAt !== null && current.body.expiresAt <= options.atTime) {
      throw new AuthorizationError("Device certificate has expired")
    }
    const revokedAt = options.revokedAt?.get(id)
    if (revokedAt !== undefined && options.atCursor >= revokedAt) {
      throw new AuthorizationError("Device certificate was revoked at this cursor")
    }

    if (current.body.issuer.kind === "recovery") {
      if (
        !verify(certificateSigningBytes(current.body), current.signature, options.recoveryPublicKey)
      ) {
        throw new AuthorizationError("Recovery signature on device certificate is invalid")
      }
      return chain
    }

    const issuer = options.lookup(current.body.issuer.certificateId)
    if (issuer === undefined) throw new AuthorizationError("Device certificate issuer is missing")
    if (!bytesEqual(issuer.body.vaultId, current.body.vaultId)) {
      throw new AuthorizationError("Device certificate chain crosses vault boundaries")
    }
    if (!issuer.body.permissions.includes(Permission.ManageDevices)) {
      throw new AuthorizationError("Device certificate issuer cannot manage devices")
    }
    if (
      !verify(
        certificateSigningBytes(current.body),
        current.signature,
        issuer.body.signingPublicKey,
      )
    ) {
      throw new AuthorizationError("Device certificate issuer signature is invalid")
    }
    current = issuer
  }

  throw new AuthorizationError("Device certificate chain exceeds the maximum depth")
}

export function signPairingTransfer(
  context: PairingContext,
  transfer: HpkeTransfer,
  approverDeviceId: DeviceId,
  approverPrivateKey: Ed25519PrivateKey,
) {
  return sign(pairingTransferSigningBytes(context, transfer, approverDeviceId), approverPrivateKey)
}

export function verifyPairingTransferSignature(
  context: PairingContext,
  transfer: HpkeTransfer,
  approverDeviceId: DeviceId,
  signature: ReturnType<typeof signPairingTransfer>,
  approverPublicKey: Ed25519PublicKey,
): boolean {
  return verify(
    pairingTransferSigningBytes(context, transfer, approverDeviceId),
    signature,
    approverPublicKey,
  )
}
