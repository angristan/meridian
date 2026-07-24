import {
  createFirstDeviceClaimBundle,
  deserializeEncryptedRecoveryPackage,
  recoverDeviceFromPackage,
  serializeEncryptedRecoveryPackage,
  sign,
  signRecoveryClaim,
} from "@meridian/crypto"
import {
  deviceAuthSigningBytes,
  encodeDeviceCertificate,
  setupClaimSigningBytes,
} from "@meridian/protocol"
import type {
  AuthChallengeProof,
  DeviceKeyMaterial,
  RecoveryDeviceMaterial,
  SetupClaim,
} from "../model"
import { fromBase64Url, toBase64Url } from "../platform/bytes"
import { deviceBundle, deviceBundleFromSecret, serializeStoredDeviceSecret } from "./device-secret"

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
  const bundle = deviceBundleFromSecret(serializedKeyBundle)
  return {
    vaultId: toBase64Url(bundle.vaultId),
    deviceId: toBase64Url(bundle.deviceId),
    serialized: serializedKeyBundle,
    trustedCheckpoint: {
      cursor: bundle.checkpoint.body.cursor,
      logHash: toBase64Url(bundle.checkpoint.body.logHash),
    },
  }
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
  challenge: { challengeId: string; challenge: string },
): Promise<RecoveryDeviceMaterial> {
  const recovered = await recoverDeviceFromPackage(
    recoveryCode,
    deserializeEncryptedRecoveryPackage(fromBase64Url(encryptedRecoveryPackage, 1024 * 1024)),
  )
  const device = recovered.device
  const certificate = encodeDeviceCertificate(device.certificate)
  const nextPackage = serializeEncryptedRecoveryPackage(recovered.encryptedRecoveryPackage)
  const proof = await signRecoveryClaim(recoveryCode, {
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
