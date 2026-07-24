import { validateDeviceCertificate } from "@meridian/crypto"
import {
  bytesEqual,
  checkpointUploadSigningBytes,
  decodeDeviceCertificate,
  deviceAuthSigningBytes,
  deviceId,
  ed25519PublicKey,
  httpOperationSigningBytes,
  pairingApprovalRequestSigningBytes,
  pairingJoinRequestSigningBytes,
  Permission,
  setupClaimSigningBytes,
  snapshotUploadSigningBytes,
  vaultId,
  x25519PublicKey,
} from "@meridian/protocol"
import { base64UrlDecode } from "../encoding"
import { assert, HttpError } from "../errors"
import type {
  AuthSession,
  Checkpoint,
  Operation,
  PairingApproval,
  PairingJoin,
  SetupClaim,
  Snapshot,
} from "../schemas"
import {
  type DeviceRow,
  MAX_CERTIFICATE_BYTES,
  MAX_ENVELOPE_BYTES,
  MAX_HPKE_TRANSFER_BYTES,
  MAX_RECOVERY_PACKAGE_BYTES,
} from "./domain"

export function validateRecoveryRootedIdentity(
  identity: SetupClaim["initialDevice"],
  expectedVaultId: string,
  recoverySigningPublicKey: string,
  atCursor: number,
): void {
  try {
    const certificate = decodeDeviceCertificate(
      base64UrlDecode(identity.certificate, MAX_CERTIFICATE_BYTES),
    )
    const expectedPermissions = [
      Permission.Read,
      Permission.Write,
      Permission.ManageDevices,
      Permission.RotateEpoch,
    ]
    assert(
      bytesEqual(certificate.body.vaultId, vaultId(base64UrlDecode(expectedVaultId, 16))) &&
        bytesEqual(certificate.body.deviceId, deviceId(base64UrlDecode(identity.deviceId, 16))) &&
        bytesEqual(
          certificate.body.signingPublicKey,
          ed25519PublicKey(base64UrlDecode(identity.signingPublicKey, 32)),
        ) &&
        bytesEqual(
          certificate.body.hpkePublicKey,
          x25519PublicKey(base64UrlDecode(identity.hpkePublicKey, 32)),
        ) &&
        certificate.body.issuer.kind === "recovery" &&
        expectedPermissions.every((permission) =>
          certificate.body.permissions.includes(permission),
        ),
      new HttpError(400, "invalid_device_certificate", "Device certificate does not match claim"),
    )
    validateDeviceCertificate(certificate, {
      recoveryPublicKey: ed25519PublicKey(base64UrlDecode(recoverySigningPublicKey, 32)),
      lookup: () => undefined,
      atCursor,
      atTime: Date.now(),
    })
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, "invalid_device_certificate", "Device certificate is invalid")
  }
}

export function setupClaimSigningMessage(claim: SetupClaim, challenge: string): Uint8Array {
  return setupClaimSigningBytes({
    vaultId: claim.vaultId,
    deviceId: claim.initialDevice.deviceId,
    signingPublicKey: claim.initialDevice.signingPublicKey,
    hpkePublicKey: claim.initialDevice.hpkePublicKey,
    certificate: base64UrlDecode(claim.initialDevice.certificate, MAX_CERTIFICATE_BYTES),
    recoverySigningPublicKey: claim.recoverySigningPublicKey,
    encryptedRecoveryPackage: base64UrlDecode(
      claim.encryptedRecoveryPackage,
      MAX_RECOVERY_PACKAGE_BYTES,
    ),
    setupSession: claim.setupSession,
    challenge,
  })
}

export function authSigningMessage(
  vaultId: string,
  request: AuthSession,
  challenge: string,
): Uint8Array {
  return deviceAuthSigningBytes({
    vaultId,
    deviceId: request.deviceId,
    challengeId: request.challengeId,
    challenge,
  })
}

export function pairingJoinSigningMessage(
  vaultId: string,
  pairingId: string,
  join: PairingJoin,
): Uint8Array {
  return pairingJoinRequestSigningBytes({
    vaultId,
    pairingId,
    deviceId: join.device.deviceId,
    signingPublicKey: join.device.signingPublicKey,
    hpkePublicKey: join.device.hpkePublicKey,
  })
}

export function pairingApprovalSigningMessage(
  vaultId: string,
  pairingId: string,
  candidate: Pick<DeviceRow, "device_id" | "signing_public_key" | "hpke_public_key">,
  approval: PairingApproval,
): Uint8Array {
  return pairingApprovalRequestSigningBytes({
    vaultId,
    pairingId,
    candidateDeviceId: candidate.device_id,
    candidateSigningPublicKey: candidate.signing_public_key,
    candidateHpkePublicKey: candidate.hpke_public_key,
    certificate: base64UrlDecode(approval.certificate, MAX_CERTIFICATE_BYTES),
    transcriptHash: approval.transcriptHash,
    hpkeTransfer: base64UrlDecode(approval.hpkeTransfer, MAX_HPKE_TRANSFER_BYTES),
  })
}

export function operationSigningMessage(operation: Operation): Uint8Array {
  return httpOperationSigningBytes({
    operationId: operation.operationId,
    authorDeviceId: operation.authorDeviceId,
    epochId: operation.epochId,
    type: operation.type,
    ...(operation.subjectDeviceId === undefined
      ? {}
      : { subjectDeviceId: operation.subjectDeviceId }),
    envelope: base64UrlDecode(operation.envelope, MAX_ENVELOPE_BYTES),
  })
}

export function checkpointSigningMessage(checkpoint: Checkpoint): Uint8Array {
  return checkpointUploadSigningBytes({
    id: checkpoint.checkpointId,
    cursor: checkpoint.cursor,
    logHash: checkpoint.logHash,
    epochId: checkpoint.epochId,
    envelope: base64UrlDecode(checkpoint.envelope, MAX_ENVELOPE_BYTES),
  })
}

export function snapshotSigningMessage(snapshot: Snapshot): Uint8Array {
  return snapshotUploadSigningBytes({
    id: snapshot.snapshotId,
    cursor: snapshot.cursor,
    logHash: snapshot.logHash,
    epochId: snapshot.epochId,
    envelope: base64UrlDecode(snapshot.envelope, MAX_ENVELOPE_BYTES),
  })
}
