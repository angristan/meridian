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
  createPairingLink(): Promise<PairingInvitation>
  getPairingStatus(pairingId: string): Promise<PairingStatus>
  getPairingProgress(
    endpoint: string,
    pairingId: string,
    capability: string,
  ): Promise<PairingStatus>
  approvePairing(pairingId: string): Promise<string>
  joinPairing(
    endpoint: string,
    pairingId: string,
    capability: string,
    vaultId: string,
    expiresAt: number,
  ): Promise<void>
  finishPairing(
    endpoint: string,
    pairingId: string,
    capability: string,
    verificationPhrase: string,
  ): Promise<void>
}
