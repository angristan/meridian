import type {
  AuthChallengeProof,
  BlobTransferProgress,
  CryptoPort,
  DecryptedRevision,
  DeviceKeyMaterial,
  DeviceRevocationMaterial,
  DeviceRevocationRecord,
  EncryptedRevision,
  EpochTransitionMaterial,
  HistoryRevisionMetadata,
  LogFormat,
  LogFormatUpgradeMaterial,
  PairedDeviceMaterial,
  PairingApprovalMaterial,
  PairingCapability,
  PairingConfirmationMaterial,
  PairingDeviceDescriptor,
  PairingJoinMaterial,
  PairingVerificationMaterial,
  RecoveryDeviceMaterial,
  RemoteDevice,
  RemoteOperation,
  RevisionDraft,
  SetupClaim,
} from "../model"
import { assertRemoteLogLink } from "../sync/log-verifier"
import { createDeviceRevocation, verifyDeviceRevocation } from "./device-revocation"
import {
  createFirstDevice,
  loadDevice,
  recoverDevice,
  refreshTrustedCheckpoint,
  signChallenge,
} from "./device-workflows"
import { applyEpochTransition, createEpochTransition } from "./epoch-workflows"
import { createLogFormatUpgrade, verifyLogFormatUpgrade } from "./log-format-transition"
import {
  approvePairing,
  consumePairingResult,
  createPairingConfirmation,
  createPairingJoin,
  inspectPairingVerification,
  verifyPairingConfirmation,
} from "./pairing-workflows"
import { decryptRevision, encryptRevision, inspectRevision } from "./revision-workflows"

/** Browser-only bridge from plugin workflows to the reviewed shared crypto package. */
export function createPackageCryptoPort(): CryptoPort {
  return new PackageCryptoPort()
}

class PackageCryptoPort implements CryptoPort {
  verifyOperationLogLink(
    device: DeviceKeyMaterial,
    operation: RemoteOperation,
    previousHash: string,
    logFormat: LogFormat,
  ): Promise<void> {
    return assertRemoteLogLink(device.vaultId, operation, previousHash, logFormat)
  }

  inspectRevision(
    device: DeviceKeyMaterial,
    operation: RemoteOperation,
    maximumPlaintextBytes: number,
  ): Promise<HistoryRevisionMetadata> {
    return inspectRevision(device, operation, maximumPlaintextBytes)
  }

  refreshTrustedCheckpoint(
    device: DeviceKeyMaterial,
    checkpoint: DeviceKeyMaterial["trustedCheckpoint"],
  ): Promise<DeviceKeyMaterial> {
    return refreshTrustedCheckpoint(device, checkpoint)
  }

  createFirstDevice(
    setupSession: string,
    claimChallenge: string,
    logFormat: LogFormat = "canonical-cbor-v1",
  ): Promise<SetupClaim> {
    return createFirstDevice(setupSession, claimChallenge, logFormat)
  }

  loadDevice(serializedKeyBundle: string): Promise<DeviceKeyMaterial> {
    return loadDevice(serializedKeyBundle)
  }

  signChallenge(
    device: DeviceKeyMaterial,
    challenge: { challengeId: string; challenge: string },
  ): Promise<AuthChallengeProof> {
    return signChallenge(device, challenge)
  }

  recoverDevice(
    recoveryCode: string,
    encryptedRecoveryPackage: string,
    recoveryStateId: string,
    challenge: { challengeId: string; challenge: string },
  ): Promise<RecoveryDeviceMaterial> {
    return recoverDevice(recoveryCode, encryptedRecoveryPackage, recoveryStateId, challenge)
  }

  encryptRevision(device: DeviceKeyMaterial, draft: RevisionDraft): Promise<EncryptedRevision> {
    return encryptRevision(device, draft)
  }

  decryptRevision(
    device: DeviceKeyMaterial,
    operation: RemoteOperation,
    maximumPlaintextBytes: number,
    loadBlob: (blobId: string) => Promise<ArrayBuffer>,
    onBlobProgress?: (progress: BlobTransferProgress) => void,
  ): Promise<DecryptedRevision> {
    return decryptRevision(device, operation, maximumPlaintextBytes, loadBlob, onBlobProgress)
  }

  createDeviceRevocation(
    device: DeviceKeyMaterial,
    target: RemoteDevice,
  ): Promise<DeviceRevocationMaterial> {
    return createDeviceRevocation(device, target)
  }

  verifyDeviceRevocation(
    device: DeviceKeyMaterial,
    operation: RemoteOperation,
  ): Promise<DeviceRevocationRecord> {
    return verifyDeviceRevocation(device, operation)
  }

  createLogFormatUpgrade(
    device: DeviceKeyMaterial,
    checkpoint: DeviceKeyMaterial["trustedCheckpoint"],
  ): Promise<LogFormatUpgradeMaterial> {
    return createLogFormatUpgrade(device, checkpoint)
  }

  verifyLogFormatUpgrade(
    device: DeviceKeyMaterial,
    operation: RemoteOperation,
  ): Promise<"canonical-cbor-v1"> {
    return verifyLogFormatUpgrade(device, operation)
  }

  createEpochTransition(
    device: DeviceKeyMaterial,
    recipients: RemoteDevice[],
    recoveryStateId: string,
    reason: "scheduled" | "revocation" | "migration",
  ): Promise<EpochTransitionMaterial> {
    return createEpochTransition(device, recipients, recoveryStateId, reason)
  }

  applyEpochTransition(
    device: DeviceKeyMaterial,
    operation: RemoteOperation,
  ): Promise<DeviceKeyMaterial> {
    return applyEpochTransition(device, operation)
  }

  createPairingJoin(
    pairing: PairingCapability,
    descriptor: PairingDeviceDescriptor,
  ): Promise<PairingJoinMaterial> {
    return createPairingJoin(pairing, descriptor)
  }

  approvePairing(
    device: DeviceKeyMaterial,
    candidatePackage: string,
    certificates: string[],
  ): Promise<PairingApprovalMaterial> {
    return approvePairing(device, candidatePackage, certificates)
  }

  inspectPairingVerification(
    pendingSecret: string,
    verificationPreview: string,
  ): Promise<PairingVerificationMaterial> {
    return inspectPairingVerification(pendingSecret, verificationPreview)
  }

  createPairingConfirmation(
    pendingSecret: string,
    transferHash: string,
  ): Promise<PairingConfirmationMaterial> {
    return createPairingConfirmation(pendingSecret, transferHash)
  }

  verifyPairingConfirmation(
    candidatePackage: string,
    confirmation: PairingConfirmationMaterial,
  ): Promise<boolean> {
    return verifyPairingConfirmation(candidatePackage, confirmation)
  }

  consumePairingResult(
    pendingSecret: string,
    hpkeTransfer: string,
    confirmedPhrase: string,
    expectedTransferHash: string,
  ): Promise<PairedDeviceMaterial> {
    return consumePairingResult(pendingSecret, hpkeTransfer, confirmedPhrase, expectedTransferHash)
  }
}
