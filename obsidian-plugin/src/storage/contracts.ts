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

export interface LocalEffectsCommit {
  entries: JournalEntry[]
  putSnapshots: FileSnapshot[]
  removeSnapshotPaths: string[]
  resolvedConflicts: Array<{ id: string; resolvedAt: number }>
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
  commitLocalEffects(commit: LocalEffectsCommit): Promise<void>
  putDirtyPath(change: DirtyPath): Promise<void>
  listDirtyPaths(): Promise<DirtyPath[]>
  commitReconciliation(commit: ReconciliationCommit): Promise<void>
  getSnapshots(): Promise<ReadonlyMap<string, FileSnapshot>>
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
  finishPushedRevision(commit: PushedRevisionCommit): Promise<void>
  commitAppliedOperation(commit: AppliedOperationCommit): Promise<void>
  getRevision(revisionId: string): Promise<LocalRevision | null>
  listRevisions(path?: string): Promise<LocalRevision[]>
  listFileRevisions(fileId: string): Promise<LocalRevision[]>
  getHistoryCheckpoint(): Promise<TrustedCheckpoint | null>
  commitHistoryOperation(
    revision: LocalRevision | null,
    checkpoint: TrustedCheckpoint,
    revocation?: DeviceRevocationRecord,
  ): Promise<void>
  getRetainedRevision(revisionId: string): Promise<LocalRevision | null>
  listRetainedRevisions(): Promise<LocalRevision[]>
  listRetainedFileRevisions(fileId: string): Promise<LocalRevision[]>
  listConflicts(unresolvedOnly?: boolean): Promise<ConflictRecord[]>
  clearSnapshots(): Promise<void>
}
