import type { CryptoPort } from "../model"
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
import { verifyLogFormatUpgrade } from "./log-format-transition"
import {
  approvePairing,
  consumePairingResult,
  createPairingConfirmation,
  createPairingJoin,
  inspectPairingVerification,
  verifyPairingConfirmation,
} from "./pairing-workflows"
import { createRetentionAcknowledgement } from "./retention-workflows"
import { decryptRevision, encryptRevision, inspectRevision } from "./revision-workflows"

export const packageCrypto: CryptoPort = {
  verifyOperationLogLink: (device, operation, previousHash, logFormat) =>
    assertRemoteLogLink(device.vaultId, operation, previousHash, logFormat),
  inspectRevision,
  refreshTrustedCheckpoint,
  createRetentionAcknowledgement,
  createFirstDevice,
  loadDevice,
  signChallenge,
  recoverDevice,
  encryptRevision,
  decryptRevision,
  createDeviceRevocation,
  verifyDeviceRevocation,
  verifyLogFormatUpgrade,
  createEpochTransition,
  applyEpochTransition,
  createPairingJoin,
  approvePairing,
  inspectPairingVerification,
  createPairingConfirmation,
  verifyPairingConfirmation,
  consumePairingResult,
}
