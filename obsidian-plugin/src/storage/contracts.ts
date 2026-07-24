import type {
  ConflictRecord,
  FileSnapshot,
  JournalEntry,
  JournalState,
  LocalRevision,
  TrustedCheckpoint,
} from "../model"

export interface JournalPort {
  open(): Promise<void>
  close(): void
  listPending(): Promise<JournalEntry[]>
  putEntry(entry: JournalEntry): Promise<void>
  updateEntry(id: string, state: JournalState, error?: string | null): Promise<void>
  hasPendingPath(path: string): Promise<boolean>
  getSnapshots(): Promise<Map<string, FileSnapshot>>
  replaceSnapshots(snapshots: FileSnapshot[]): Promise<void>
  putSnapshot(snapshot: FileSnapshot): Promise<void>
  removeSnapshot(path: string): Promise<void>
  getCursor(): Promise<number>
  getCheckpoint(): Promise<TrustedCheckpoint | null>
  setCheckpoint(checkpoint: TrustedCheckpoint): Promise<void>
  putRevision(revision: LocalRevision): Promise<void>
  getRevision(revisionId: string): Promise<LocalRevision | null>
  listRevisions(path?: string): Promise<LocalRevision[]>
  listFileRevisions(fileId: string): Promise<LocalRevision[]>
  putConflict(conflict: ConflictRecord): Promise<void>
  listConflicts(unresolvedOnly?: boolean): Promise<ConflictRecord[]>
  resolveConflict(id: string): Promise<void>
  clearRebuildableState(): Promise<void>
}
