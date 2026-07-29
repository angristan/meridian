import type { App } from "obsidian"
import type {
  ConflictRecord,
  LocalRevision,
  MeridianSettings,
  PairingInvitation,
  PairingStatus,
  RemoteDevice,
  SyncStatus,
} from "../model"

export interface MeridianUiHost {
  app: App
  settings: MeridianSettings
  saveSettings(): Promise<void>
  openSettings(): void
  syncNow(): Promise<void>
  repairLocalIndex(): Promise<void>
  connectFromSetup(endpoint: string, setupSession: string, claimChallenge: string): Promise<void>
  recoverVault(endpoint: string, recoveryCode: string): Promise<void>
  disconnect(): Promise<void>
  resumeConnection(): Promise<void>
  getStatus(): SyncStatus
  getHistory(path?: string): Promise<LocalRevision[]>
  restoreRevision(revisionId: string): Promise<void>
  getConflicts(): Promise<ConflictRecord[]>
  resolveConflict(id: string): Promise<void>
  openPath(path: string): Promise<void>
  getDevices(): Promise<RemoteDevice[]>
  revokeDevice(device: RemoteDevice): Promise<void>
  removeCurrentDevice(): Promise<void>
  createPairingLink(): Promise<PairingInvitation>
  getPairingStatus(pairingId: string): Promise<PairingStatus>
  getPairingProgress(
    endpoint: string,
    pairingId: string,
    capability: string,
  ): Promise<PairingStatus>
  approvePairing(pairingId: string): Promise<string>
  confirmPairingOwner(pairingId: string): Promise<void>
  completePairingOwner(pairingId: string): void
  rejectPairing(pairingId: string): Promise<void>
  joinPairing(
    endpoint: string,
    pairingId: string,
    capability: string,
    vaultId: string,
    expiresAt: number,
  ): Promise<void>
  preparePairingVerification(
    endpoint: string,
    pairingId: string,
    capability: string,
  ): Promise<string>
  finishPairing(endpoint: string, pairingId: string, capability: string): Promise<void>
  completePendingPairing(): Promise<void>
  cancelPairing(endpoint: string, pairingId: string, capability: string): Promise<void>
}
