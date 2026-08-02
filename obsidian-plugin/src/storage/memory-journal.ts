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
import type { JournalPort, ReconciliationCommit } from "./contracts"
import { sortRevisions } from "./types"

export class MemoryJournal implements JournalPort {
  private readonly entries = new Map<string, JournalEntry>()
  private snapshots = new Map<string, FileSnapshot>()
  private readonly dirtyPaths = new Map<string, DirtyPath>()
  private cursor = 0
  private lastSuccessfulSyncAt: number | null = null
  private lastFingerprintAuditAt: number | null = null
  private checkpoint: TrustedCheckpoint | null = null
  private readonly revocations = new Map<string, DeviceRevocationRecord>()
  private readonly revisions = new Map<string, LocalRevision>()
  private readonly historyRevisions = new Map<string, LocalRevision>()
  private historyCheckpoint: TrustedCheckpoint | null = null
  private readonly conflicts = new Map<string, ConflictRecord>()

  async open(): Promise<void> {}
  close(): void {}

  async listPending(): Promise<JournalEntry[]> {
    return [...this.entries.values()]
      .filter((entry) => entry.state !== "complete")
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  }

  async invalidatePreparedRevisions(): Promise<void> {
    for (const [id, entry] of this.entries) {
      if (entry.state === "complete" || entry.preparedRevision === null) continue
      this.entries.set(id, {
        ...entry,
        state: "queued",
        error: null,
        preparedRevision: { ...entry.preparedRevision, invalidatedByEpoch: true },
      })
    }
  }

  async compactLocalStorage(): Promise<LocalCompactionResult> {
    let completedEntries = 0
    for (const [id, entry] of this.entries) {
      if (entry.state !== "complete") continue
      this.entries.delete(id)
      completedEntries += 1
    }
    let duplicateHistoryRevisions = 0
    for (const [id, historyRevision] of this.historyRevisions) {
      const current = this.revisions.get(id)
      if (!current || JSON.stringify(current) !== JSON.stringify(historyRevision)) continue
      this.historyRevisions.delete(id)
      duplicateHistoryRevisions += 1
    }
    return { completedEntries, duplicateHistoryRevisions }
  }

  async putEntry(entry: JournalEntry): Promise<void> {
    this.entries.set(entry.id, structuredClone(entry))
  }

  async updateEntry(id: string, state: JournalState, error: string | null = null): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`Missing journal entry ${id}`)
    this.entries.set(id, {
      ...entry,
      state,
      error,
      attempts: state === "failed" ? entry.attempts + 1 : entry.attempts,
    })
  }

  async hasPendingPath(path: string): Promise<boolean> {
    return [...this.entries.values()].some(
      (entry) => entry.path === path && entry.state !== "complete",
    )
  }

  async putDirtyPath(change: DirtyPath): Promise<void> {
    this.dirtyPaths.set(change.path, structuredClone(change))
  }

  async listDirtyPaths(): Promise<DirtyPath[]> {
    return [...this.dirtyPaths.values()]
      .sort(
        (left, right) => left.observedAt - right.observedAt || left.path.localeCompare(right.path),
      )
      .map((change) => structuredClone(change))
  }

  async consumeDirtyPaths(changes: readonly DirtyPath[]): Promise<void> {
    for (const change of changes) {
      if (this.dirtyPaths.get(change.path)?.token === change.token) {
        this.dirtyPaths.delete(change.path)
      }
    }
  }

  async clearDirtyPaths(): Promise<void> {
    this.dirtyPaths.clear()
  }

  async commitReconciliation(commit: ReconciliationCommit): Promise<void> {
    for (const entry of commit.entries) this.entries.set(entry.id, structuredClone(entry))
    for (const snapshot of commit.putSnapshots) {
      this.snapshots.set(snapshot.path, structuredClone(snapshot))
    }
    for (const path of commit.removeSnapshotPaths) this.snapshots.delete(path)
    if (commit.fingerprintAuditedAt !== undefined) {
      this.lastFingerprintAuditAt = commit.fingerprintAuditedAt
    }
    await this.consumeDirtyPaths(commit.consumeDirtyPaths)
  }

  async getSnapshots(): Promise<Map<string, FileSnapshot>> {
    return new Map([...this.snapshots].map(([path, snapshot]) => [path, structuredClone(snapshot)]))
  }

  async replaceSnapshots(snapshots: FileSnapshot[]): Promise<void> {
    this.snapshots = new Map(
      snapshots.map((snapshot) => [snapshot.path, structuredClone(snapshot)]),
    )
  }

  async putSnapshot(snapshot: FileSnapshot): Promise<void> {
    this.snapshots.set(snapshot.path, structuredClone(snapshot))
  }

  async removeSnapshot(path: string): Promise<void> {
    this.snapshots.delete(path)
  }

  async getCursor(): Promise<number> {
    return this.cursor
  }

  async getLastSuccessfulSyncAt(): Promise<number | null> {
    return this.lastSuccessfulSyncAt
  }

  async setLastSuccessfulSyncAt(timestamp: number): Promise<void> {
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
      throw new Error("Last sync timestamp is invalid")
    }
    this.lastSuccessfulSyncAt = timestamp
  }

  async getLastFingerprintAuditAt(): Promise<number | null> {
    return this.lastFingerprintAuditAt
  }

  async getCheckpoint(): Promise<TrustedCheckpoint | null> {
    return this.checkpoint ? structuredClone(this.checkpoint) : null
  }

  async setCheckpoint(checkpoint: TrustedCheckpoint): Promise<void> {
    this.cursor = checkpoint.cursor
    this.checkpoint = structuredClone(checkpoint)
  }

  async getDeviceRevocation(deviceId: string): Promise<DeviceRevocationRecord | null> {
    const revocation = this.revocations.get(deviceId)
    return revocation ? structuredClone(revocation) : null
  }

  async listDeviceRevocations(): Promise<DeviceRevocationRecord[]> {
    return [...this.revocations.values()].map((revocation) => structuredClone(revocation))
  }

  async putDeviceRevocation(revocation: DeviceRevocationRecord): Promise<void> {
    const existing = this.revocations.get(revocation.deviceId)
    if (existing && existing.cursor !== revocation.cursor) {
      throw new Error("Device has conflicting revocation records")
    }
    this.revocations.set(revocation.deviceId, structuredClone(revocation))
  }

  async putRevision(revision: LocalRevision): Promise<void> {
    this.revisions.set(revision.revisionId, structuredClone(revision))
  }

  async getRevision(revisionId: string): Promise<LocalRevision | null> {
    const revision = this.revisions.get(revisionId)
    return revision ? structuredClone(revision) : null
  }

  async listRevisions(path?: string): Promise<LocalRevision[]> {
    return sortRevisions(
      [...this.revisions.values()].filter(
        (revision) => path === undefined || revision.path === path,
      ),
    ).map((revision) => structuredClone(revision))
  }

  async listFileRevisions(fileId: string): Promise<LocalRevision[]> {
    return sortRevisions(
      [...this.revisions.values()].filter((revision) => revision.fileId === fileId),
    ).map((revision) => structuredClone(revision))
  }

  async getHistoryCheckpoint(): Promise<TrustedCheckpoint | null> {
    return this.historyCheckpoint ? structuredClone(this.historyCheckpoint) : null
  }

  async setHistoryCheckpoint(checkpoint: TrustedCheckpoint): Promise<void> {
    this.historyCheckpoint = structuredClone(checkpoint)
  }

  async putHistoryRevision(revision: LocalRevision): Promise<void> {
    this.historyRevisions.set(revision.revisionId, structuredClone(revision))
  }

  async getHistoryRevision(revisionId: string): Promise<LocalRevision | null> {
    const revision = this.historyRevisions.get(revisionId)
    return revision ? structuredClone(revision) : null
  }

  async listHistoryRevisions(): Promise<LocalRevision[]> {
    return sortRevisions([...this.historyRevisions.values()]).map((revision) =>
      structuredClone(revision),
    )
  }

  async putConflict(conflict: ConflictRecord): Promise<void> {
    this.conflicts.set(conflict.id, structuredClone(conflict))
  }

  async listConflicts(unresolvedOnly = false): Promise<ConflictRecord[]> {
    return [...this.conflicts.values()]
      .filter((conflict) => !unresolvedOnly || conflict.resolvedAt === null)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((conflict) => structuredClone(conflict))
  }

  async resolveConflict(id: string): Promise<void> {
    const conflict = this.conflicts.get(id)
    if (conflict) this.conflicts.set(id, { ...conflict, resolvedAt: Date.now() })
  }

  async clearSnapshots(): Promise<void> {
    this.snapshots.clear()
  }
}
