import type {
  AuthChallengeProof,
  CryptoPort,
  DecryptedRevision,
  DeviceKeyMaterial,
  EncryptedRevision,
  PairedDeviceMaterial,
  PairingApprovalMaterial,
  PairingCapability,
  PairingJoinMaterial,
  RecoveryDeviceMaterial,
  RemoteOperation,
  RevisionDraft,
  SetupClaim,
} from "../model"
import { createFirstDevice, loadDevice, recoverDevice, signChallenge } from "./device-workflows"
import { approvePairing, consumePairingResult, createPairingJoin } from "./pairing-workflows"
import { decryptRevision, encryptRevision } from "./revision-workflows"

/** Browser-only bridge from plugin workflows to the reviewed shared crypto package. */
export function createPackageCryptoPort(): CryptoPort {
  return new PackageCryptoPort()
}

class PackageCryptoPort implements CryptoPort {
  createFirstDevice(setupSession: string, claimChallenge: string): Promise<SetupClaim> {
    return createFirstDevice(setupSession, claimChallenge)
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
    challenge: { challengeId: string; challenge: string },
  ): Promise<RecoveryDeviceMaterial> {
    return recoverDevice(recoveryCode, encryptedRecoveryPackage, challenge)
  }

  encryptRevision(device: DeviceKeyMaterial, draft: RevisionDraft): Promise<EncryptedRevision> {
    return encryptRevision(device, draft)
  }

  decryptRevision(
    device: DeviceKeyMaterial,
    operation: RemoteOperation,
    loadBlob: (blobId: string) => Promise<ArrayBuffer>,
  ): Promise<DecryptedRevision> {
    return decryptRevision(device, operation, loadBlob)
  }

  createPairingJoin(pairing: PairingCapability): Promise<PairingJoinMaterial> {
    return createPairingJoin(pairing)
  }

  approvePairing(
    device: DeviceKeyMaterial,
    candidatePackage: string,
    certificates: string[],
  ): Promise<PairingApprovalMaterial> {
    return approvePairing(device, candidatePackage, certificates)
  }

  consumePairingResult(
    pendingSecret: string,
    hpkeTransfer: string,
    confirmedPhrase: string,
  ): Promise<PairedDeviceMaterial> {
    return consumePairingResult(pendingSecret, hpkeTransfer, confirmedPhrase)
  }
}
