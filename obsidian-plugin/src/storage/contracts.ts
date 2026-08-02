import type {
  ConflictRecord,
  DeviceRevocationRecord,
  DirtyPath,
  FileSnapshot,
  JournalEntry,
  JournalState,
  LocalCompactionResult,
  LocalRevision,
  TrustedCheckpoint,
} from "../model"

export interface ReconciliationCommit {
  entries: JournalEntry[]
  putSnapshots: FileSnapshot[]
  removeSnapshotPaths: string[]
  consumeDirtyPaths: DirtyPath[]
  fingerprintAuditedAt?: number
}

export interface JournalPort {
  open(): Promise<void>
  close(): void
  listPending(): Promise<JournalEntry[]>
  invalidatePreparedRevisions(): Promise<void>
  compactLocalStorage(): Promise<LocalCompactionResult>
  putEntry(entry: JournalEntry): Promise<void>
  updateEntry(id: string, state: JournalState, error?: string | null): Promise<void>
  hasPendingPath(path: string): Promise<boolean>
  putDirtyPath(change: DirtyPath): Promise<void>
  listDirtyPaths(): Promise<DirtyPath[]>
  consumeDirtyPaths(changes: readonly DirtyPath[]): Promise<void>
  clearDirtyPaths(): Promise<void>
  commitReconciliation(commit: ReconciliationCommit): Promise<void>
  getSnapshots(): Promise<Map<string, FileSnapshot>>
  replaceSnapshots(snapshots: FileSnapshot[]): Promise<void>
  putSnapshot(snapshot: FileSnapshot): Promise<void>
  removeSnapshot(path: string): Promise<void>
  getCursor(): Promise<number>
  getLastSuccessfulSyncAt(): Promise<number | null>
  setLastSuccessfulSyncAt(timestamp: number): Promise<void>
  getLastFingerprintAuditAt(): Promise<number | null>
  getCheckpoint(): Promise<TrustedCheckpoint | null>
  setCheckpoint(checkpoint: TrustedCheckpoint): Promise<void>
  getDeviceRevocation(deviceId: string): Promise<DeviceRevocationRecord | null>
  listDeviceRevocations(): Promise<DeviceRevocationRecord[]>
  putDeviceRevocation(revocation: DeviceRevocationRecord): Promise<void>
  putRevision(revision: LocalRevision): Promise<void>
  getRevision(revisionId: string): Promise<LocalRevision | null>
  listRevisions(path?: string): Promise<LocalRevision[]>
  listFileRevisions(fileId: string): Promise<LocalRevision[]>
  getHistoryCheckpoint(): Promise<TrustedCheckpoint | null>
  setHistoryCheckpoint(checkpoint: TrustedCheckpoint): Promise<void>
  putHistoryRevision(revision: LocalRevision): Promise<void>
  getHistoryRevision(revisionId: string): Promise<LocalRevision | null>
  listHistoryRevisions(): Promise<LocalRevision[]>
  putConflict(conflict: ConflictRecord): Promise<void>
  listConflicts(unresolvedOnly?: boolean): Promise<ConflictRecord[]>
  resolveConflict(id: string): Promise<void>
  clearSnapshots(): Promise<void>
}
