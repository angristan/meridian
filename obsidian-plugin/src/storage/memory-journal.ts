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
import type {
  AppliedOperationCommit,
  JournalPort,
  LocalEffectsCommit,
  PushedRevisionCommit,
  ReconciliationCommit,
} from "./contracts"
import { sortRevisions } from "./types"

export class MemoryJournal implements JournalPort {
  private readonly entries = new Map<string, JournalEntry>()
  private snapshots = new Map<string, FileSnapshot>()
  private readonly dirtyPaths = new Map<string, DirtyPath>()
  private cursor = 0
  private lastSuccessfulSyncAt: number | null = null
  private lastFingerprintAuditAt: number | null = null
  private lastRetentionAcknowledgementKey: string | null = null
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
    this.entries.set(id, { ...entry, state, error })
  }

  async commitLocalEffects(commit: LocalEffectsCommit): Promise<void> {
    for (const entry of commit.entries) this.entries.set(entry.id, structuredClone(entry))
    for (const snapshot of commit.putSnapshots) {
      this.snapshots.set(snapshot.path, structuredClone(snapshot))
    }
    for (const path of commit.removeSnapshotPaths) this.snapshots.delete(path)
    for (const resolution of commit.resolvedConflicts) {
      const conflict = this.conflicts.get(resolution.id)
      if (conflict) {
        this.conflicts.set(resolution.id, {
          ...conflict,
          resolvedAt: resolution.resolvedAt,
        })
      }
    }
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

  async commitReconciliation(commit: ReconciliationCommit): Promise<void> {
    for (const entry of commit.entries) this.entries.set(entry.id, structuredClone(entry))
    for (const snapshot of commit.putSnapshots) {
      this.snapshots.set(snapshot.path, structuredClone(snapshot))
    }
    for (const path of commit.removeSnapshotPaths) this.snapshots.delete(path)
    if (commit.fingerprintAuditedAt !== undefined) {
      this.lastFingerprintAuditAt = commit.fingerprintAuditedAt
    }
    for (const change of commit.consumeDirtyPaths) {
      if (this.dirtyPaths.get(change.path)?.token === change.token) {
        this.dirtyPaths.delete(change.path)
      }
    }
  }

  async getSnapshots(): Promise<Map<string, FileSnapshot>> {
    return new Map([...this.snapshots].map(([path, snapshot]) => [path, structuredClone(snapshot)]))
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

  async getLastRetentionAcknowledgementKey(): Promise<string | null> {
    return this.lastRetentionAcknowledgementKey
  }

  async setLastRetentionAcknowledgementKey(key: string): Promise<void> {
    if (key.length === 0) throw new Error("Retention acknowledgement key is invalid")
    this.lastRetentionAcknowledgementKey = key
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

  async finishPushedRevision(commit: PushedRevisionCommit): Promise<void> {
    if (commit.snapshot) {
      this.snapshots.set(commit.snapshot.path, structuredClone(commit.snapshot))
    }
    for (const path of commit.removeSnapshotPaths) this.snapshots.delete(path)
    this.revisions.set(commit.revision.revisionId, structuredClone(commit.revision))
    this.entries.set(commit.entry.id, structuredClone(commit.entry))
  }

  async commitAppliedOperation(commit: AppliedOperationCommit): Promise<void> {
    for (const entry of commit.entries) this.entries.set(entry.id, structuredClone(entry))
    for (const snapshot of commit.putSnapshots) {
      this.snapshots.set(snapshot.path, structuredClone(snapshot))
    }
    for (const path of commit.removeSnapshotPaths) this.snapshots.delete(path)
    for (const conflict of commit.conflicts) {
      this.conflicts.set(conflict.id, structuredClone(conflict))
    }
    this.revisions.set(commit.revision.revisionId, structuredClone(commit.revision))
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

  async commitHistoryOperation(
    revision: LocalRevision | null,
    checkpoint: TrustedCheckpoint,
    revocation?: DeviceRevocationRecord,
  ): Promise<void> {
    const existing = revocation ? this.revocations.get(revocation.deviceId) : undefined
    if (existing && existing.cursor !== revocation?.cursor) {
      throw new Error("Device has conflicting revocation records")
    }
    if (revision) this.historyRevisions.set(revision.revisionId, structuredClone(revision))
    if (revocation) this.revocations.set(revocation.deviceId, structuredClone(revocation))
    this.historyCheckpoint = structuredClone(checkpoint)
  }

  async getRetainedRevision(revisionId: string): Promise<LocalRevision | null> {
    const revision = this.historyRevisions.get(revisionId) ?? this.revisions.get(revisionId)
    return revision ? structuredClone(revision) : null
  }

  async listRetainedRevisions(): Promise<LocalRevision[]> {
    return this.retainedRevisions()
  }

  async listRetainedFileRevisions(fileId: string): Promise<LocalRevision[]> {
    return this.retainedRevisions().filter((revision) => revision.fileId === fileId)
  }

  private retainedRevisions(): LocalRevision[] {
    const byId = new Map(this.revisions)
    for (const [revisionId, revision] of this.historyRevisions) byId.set(revisionId, revision)
    return sortRevisions([...byId.values()]).map((revision) => structuredClone(revision))
  }

  async listConflicts(unresolvedOnly = false): Promise<ConflictRecord[]> {
    return [...this.conflicts.values()]
      .filter((conflict) => !unresolvedOnly || conflict.resolvedAt === null)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((conflict) => structuredClone(conflict))
  }

  async clearSnapshots(): Promise<void> {
    this.snapshots.clear()
  }
}
