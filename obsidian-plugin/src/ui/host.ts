import type { App } from "obsidian"
import type {
  ConflictDetails,
  ConflictRecord,
  ConflictResolutionAction,
  DeletedFileRecord,
  LocalCompactionResult,
  LocalRevision,
  MeridianSettings,
  RemoteDevice,
  RevisionComparison,
  RevisionPreview,
  StoragePruneResult,
  StorageUsage,
  SyncActivity,
  SyncDiagnostic,
  SyncStatus,
} from "../model"
import type { PairingUiCapability } from "../plugin/pairing-coordinator"

export interface MeridianUiHost {
  app: App
  settings: MeridianSettings
  pairing: PairingUiCapability
  saveSettings(): Promise<void>
  openSettings(): void
  syncNow(): Promise<void>
  repairLocalIndex(): Promise<void>
  getEpochStatus(): Promise<{ sequence: number; pending: boolean } | null>
  connectFromSetup(endpoint: string, setupSession: string, claimChallenge: string): Promise<void>
  recoverVault(endpoint: string, recoveryCode: string): Promise<void>
  disconnect(): Promise<void>
  resumeConnection(): Promise<void>
  getStatus(): SyncStatus
  getHistory(path?: string): Promise<LocalRevision[]>
  getActivity(limit?: number): Promise<SyncActivity[]>
  getDeletedFiles(): Promise<DeletedFileRecord[]>
  recoverDeleted(revisionId: string): Promise<void>
  getDiagnostics(): SyncDiagnostic[]
  getDebugReport(): string
  getStorageUsage(): Promise<StorageUsage>
  compactLocalStorage(): Promise<LocalCompactionResult>
  requestPersistentStorage(): Promise<boolean | null>
  pruneStorage(): Promise<StoragePruneResult>
  previewRevision(revisionId: string): Promise<RevisionPreview>
  compareRevisionToCurrent(revisionId: string): Promise<RevisionComparison>
  restoreRevision(revisionId: string): Promise<void>
  getConflicts(): Promise<ConflictRecord[]>
  getConflictDetails(id: string): Promise<ConflictDetails>
  resolveConflict(id: string, action: ConflictResolutionAction): Promise<void>
  openPath(path: string): Promise<void>
  getDevices(): Promise<RemoteDevice[]>
  revokeDevice(device: RemoteDevice): Promise<void>
  removeCurrentDevice(): Promise<void>
}
