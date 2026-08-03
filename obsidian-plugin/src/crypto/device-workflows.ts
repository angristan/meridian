import {
  computeRecoveryStateId,
  createFirstDeviceClaimBundle,
  deserializeEncryptedRecoveryPackage,
  recoverDeviceFromPackage,
  serializeEncryptedRecoveryPackage,
  sign,
  signCheckpoint,
  signRecoveryClaim,
} from "@meridian/crypto"
import {
  checkpointLogFormats,
  type DeviceCertificate,
  decodeDeviceCertificate,
  deviceAuthSigningBytes,
  encodeDeviceCertificate,
  hashBytes,
  LogFormat,
  recoveryId,
  setupClaimSigningBytes,
} from "@meridian/protocol"
import type {
  AuthChallengeProof,
  DeviceKeyMaterial,
  RecoveryDeviceMaterial,
  SetupClaim,
  TrustedCheckpoint,
} from "../model"
import { fromBase64Url, randomId, toBase64Url } from "../platform/bytes"
import {
  deviceBundle,
  deviceBundleFromSecret,
  hasAuthorizedCheckpoint,
  parseStoredSecret,
  serializeStoredDeviceSecret,
} from "./device-secret"

export async function createFirstDevice(
  setupSession: string,
  claimChallenge: string,
): Promise<SetupClaim> {
  const created = await createFirstDeviceClaimBundle()
  const device = created.device
  const certificate = encodeDeviceCertificate(device.certificate)
  const recoveryPackage = serializeEncryptedRecoveryPackage(created.encryptedRecoveryPackage)
  const unsignedClaim = {
    setupSession,
    vaultId: toBase64Url(device.vaultId),
    recoverySigningPublicKey: toBase64Url(created.recoveryPublicKey),
    encryptedRecoveryPackage: toBase64Url(recoveryPackage),
    logFormat: LogFormat.CanonicalCborV1,
    initialDevice: {
      deviceId: toBase64Url(device.deviceId),
      signingPublicKey: toBase64Url(device.signingPublicKey),
      hpkePublicKey: toBase64Url(device.hpkePublicKey),
      certificate: toBase64Url(certificate),
    },
  }
  const proof = sign(
    setupClaimSigningBytes({
      vaultId: unsignedClaim.vaultId,
      deviceId: unsignedClaim.initialDevice.deviceId,
      signingPublicKey: unsignedClaim.initialDevice.signingPublicKey,
      hpkePublicKey: unsignedClaim.initialDevice.hpkePublicKey,
      certificate,
      recoverySigningPublicKey: unsignedClaim.recoverySigningPublicKey,
      encryptedRecoveryPackage: recoveryPackage,
      setupSession,
      challenge: claimChallenge,
      logFormat: unsignedClaim.logFormat,
    }),
    device.signingPrivateKey,
  )
  return {
    vaultId: unsignedClaim.vaultId,
    deviceId: unsignedClaim.initialDevice.deviceId,
    recoveryCode: created.recoveryCode,
    keyBundle: serializeStoredDeviceSecret(device, created.recoveryPublicKey),
    publicClaim: { ...unsignedClaim, proof: toBase64Url(proof) },
  }
}

export async function loadDevice(serializedKeyBundle: string): Promise<DeviceKeyMaterial> {
  const secret = parseStoredSecret(serializedKeyBundle)
  const bundle = deviceBundleFromSecret(serializedKeyBundle)
  return {
    vaultId: toBase64Url(bundle.vaultId),
    deviceId: toBase64Url(bundle.deviceId),
    serialized: serializedKeyBundle,
    epochId: toBase64Url(bundle.epoch.body.epochId),
    epochSequence: bundle.epoch.body.sequence,
    epochActivatedAtCursor: bundle.epochActivatedAtCursor,
    requiredTransitionOperationId:
      bundle.requiredTransitionOperationId === undefined
        ? null
        : toBase64Url(bundle.requiredTransitionOperationId),
    trustedCheckpoint: {
      cursor: bundle.checkpoint.body.cursor,
      logHash: toBase64Url(bundle.checkpoint.body.logHash),
      ...checkpointLogFormats(bundle.checkpoint.body),
    },
    trustedCheckpointAuthorized: hasAuthorizedCheckpoint(secret),
  }
}

export async function refreshTrustedCheckpoint(
  device: DeviceKeyMaterial,
  checkpoint: TrustedCheckpoint,
  registryCertificates: readonly DeviceCertificate[] = [],
): Promise<DeviceKeyMaterial> {
  const secret = parseStoredSecret(device.serialized)
  const bundle = deviceBundle(device)
  if (checkpoint.cursor < bundle.checkpoint.body.cursor) {
    throw new Error("Cannot replace a trusted checkpoint with an older cursor")
  }
  if (
    checkpoint.cursor === bundle.checkpoint.body.cursor &&
    checkpoint.logHash !== toBase64Url(bundle.checkpoint.body.logHash)
  ) {
    throw new Error("Trusted checkpoint hash conflicts at the same cursor")
  }
  const currentFormats = checkpointLogFormats(bundle.checkpoint.body)
  const nextFormats =
    checkpoint.initialLogFormat === undefined && checkpoint.logFormat === undefined
      ? currentFormats
      : checkpointLogFormats(checkpoint)
  if (
    currentFormats.logFormat === LogFormat.CanonicalCborV1 &&
    nextFormats.logFormat === LogFormat.LegacyHttpV1
  ) {
    throw new Error("Cannot replace a trusted checkpoint with an older log format")
  }
  const signed = signCheckpoint(
    {
      vaultId: bundle.vaultId,
      epochId: bundle.epoch.body.epochId,
      cursor: checkpoint.cursor,
      logHash: hashBytes(fromBase64Url(checkpoint.logHash, 32)),
      signerDeviceId: bundle.deviceId,
      protocolGeneration: bundle.checkpoint.body.protocolGeneration,
      ...nextFormats,
    },
    bundle.signingPrivateKey,
  )
  const chain = [
    ...secret.checkpointAuthorizationChain.map((encoded) =>
      decodeDeviceCertificate(fromBase64Url(encoded)),
    ),
    ...registryCertificates,
  ]
  const serialized = serializeStoredDeviceSecret(
    { ...bundle, checkpoint: signed },
    fromBase64Url(secret.recoveryPublicKey, 32),
    chain,
  )
  return loadDevice(serialized)
}

export async function signChallenge(
  device: DeviceKeyMaterial,
  challenge: { challengeId: string; challenge: string },
): Promise<AuthChallengeProof> {
  const bundle = deviceBundle(device)
  const signature = sign(
    deviceAuthSigningBytes({
      vaultId: device.vaultId,
      deviceId: device.deviceId,
      challengeId: challenge.challengeId,
      challenge: challenge.challenge,
    }),
    bundle.signingPrivateKey,
  )
  return {
    challengeId: challenge.challengeId,
    deviceId: device.deviceId,
    signature: toBase64Url(signature),
  }
}

export async function recoverDevice(
  recoveryCode: string,
  encryptedRecoveryPackage: string,
  recoveryStateId: string,
  challenge: { challengeId: string; challenge: string },
): Promise<RecoveryDeviceMaterial> {
  const serializedPackage = fromBase64Url(encryptedRecoveryPackage, 1024 * 1024)
  const encryptedPackage = deserializeEncryptedRecoveryPackage(serializedPackage)
  const computedStateId = toBase64Url(
    await computeRecoveryStateId(encryptedPackage.vaultId, serializedPackage),
  )
  if (computedStateId !== recoveryStateId) {
    throw new Error("Recovery state ID does not match the encrypted package")
  }
  const recovered = await recoverDeviceFromPackage(recoveryCode, encryptedPackage)
  const device = recovered.device
  const certificate = encodeDeviceCertificate(device.certificate)
  const nextPackage = serializeEncryptedRecoveryPackage(recovered.encryptedRecoveryPackage)
  const recoveryIdentifier = randomId()
  const proof = await signRecoveryClaim(recoveryCode, {
    claimVersion: 2,
    recoveryId: recoveryId(fromBase64Url(recoveryIdentifier, 16)),
    previousRecoveryStateId: hashBytes(fromBase64Url(recoveryStateId, 32)),
    challengeId: challenge.challengeId,
    challenge: fromBase64Url(challenge.challenge, 32),
    vaultId: device.vaultId,
    deviceId: device.deviceId,
    signingPublicKey: device.signingPublicKey,
    hpkePublicKey: device.hpkePublicKey,
    certificate,
    encryptedRecoveryPackage: nextPackage,
  })
  return {
    vaultId: toBase64Url(device.vaultId),
    deviceId: toBase64Url(device.deviceId),
    keyBundle: serializeStoredDeviceSecret(device, recovered.recoveryPublicKey),
    publicClaim: {
      claimVersion: 2,
      recoveryId: recoveryIdentifier,
      previousRecoveryStateId: recoveryStateId,
      challengeId: challenge.challengeId,
      newDevice: {
        deviceId: toBase64Url(device.deviceId),
        signingPublicKey: toBase64Url(device.signingPublicKey),
        hpkePublicKey: toBase64Url(device.hpkePublicKey),
        certificate: toBase64Url(certificate),
      },
      encryptedRecoveryPackage: toBase64Url(nextPackage),
      proof: toBase64Url(proof),
    },
  }
}
