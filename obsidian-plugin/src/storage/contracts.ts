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

export interface PushedRevisionCommit {
  entry: JournalEntry
  revision: LocalRevision
  snapshot: FileSnapshot | null
  removeSnapshotPaths: string[]
}

export interface AppliedOperationCommit {
  revision: LocalRevision
  entries: JournalEntry[]
  putSnapshots: FileSnapshot[]
  removeSnapshotPaths: string[]
  conflicts: ConflictRecord[]
}

export interface JournalPort {
  open(): Promise<void>
  close(): void
  listPending(): Promise<JournalEntry[]>
  invalidatePreparedRevisions(): Promise<void>
  compactLocalStorage(): Promise<LocalCompactionResult>
  putEntry(entry: JournalEntry): Promise<void>
  updateEntry(id: string, state: JournalState, error?: string | null): Promise<void>
  putDirtyPath(change: DirtyPath): Promise<void>
  listDirtyPaths(): Promise<DirtyPath[]>
  commitReconciliation(commit: ReconciliationCommit): Promise<void>
  getSnapshots(): Promise<ReadonlyMap<string, FileSnapshot>>
  putSnapshot(snapshot: FileSnapshot): Promise<void>
  removeSnapshot(path: string): Promise<void>
  getCursor(): Promise<number>
  getLastSuccessfulSyncAt(): Promise<number | null>
  setLastSuccessfulSyncAt(timestamp: number): Promise<void>
  getLastFingerprintAuditAt(): Promise<number | null>
  getLastRetentionAcknowledgementKey(): Promise<string | null>
  setLastRetentionAcknowledgementKey(key: string): Promise<void>
  getCheckpoint(): Promise<TrustedCheckpoint | null>
  setCheckpoint(checkpoint: TrustedCheckpoint): Promise<void>
  getDeviceRevocation(deviceId: string): Promise<DeviceRevocationRecord | null>
  listDeviceRevocations(): Promise<DeviceRevocationRecord[]>
  putDeviceRevocation(revocation: DeviceRevocationRecord): Promise<void>
  putRevision(revision: LocalRevision): Promise<void>
  finishPushedRevision(commit: PushedRevisionCommit): Promise<void>
  commitAppliedOperation(commit: AppliedOperationCommit): Promise<void>
  getRevision(revisionId: string): Promise<LocalRevision | null>
  listRevisions(path?: string): Promise<LocalRevision[]>
  listFileRevisions(fileId: string): Promise<LocalRevision[]>
  getHistoryCheckpoint(): Promise<TrustedCheckpoint | null>
  commitHistoryOperation(
    revision: LocalRevision | null,
    checkpoint: TrustedCheckpoint,
  ): Promise<void>
  getHistoryRevision(revisionId: string): Promise<LocalRevision | null>
  listHistoryRevisions(): Promise<LocalRevision[]>
  putConflict(conflict: ConflictRecord): Promise<void>
  listConflicts(unresolvedOnly?: boolean): Promise<ConflictRecord[]>
  resolveConflict(id: string): Promise<void>
  clearSnapshots(): Promise<void>
}
