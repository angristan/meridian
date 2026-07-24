import type {
  ConflictRecord,
  FileSnapshot,
  JournalEntry,
  JournalState,
  LocalRevision,
  TrustedCheckpoint,
} from "../model"
import type { JournalPort } from "./contracts"
import { sortRevisions } from "./types"

export class MemoryJournal implements JournalPort {
  private readonly entries = new Map<string, JournalEntry>()
  private snapshots = new Map<string, FileSnapshot>()
  private cursor = 0
  private checkpoint: TrustedCheckpoint | null = null
  private readonly revisions = new Map<string, LocalRevision>()
  private readonly conflicts = new Map<string, ConflictRecord>()

  async open(): Promise<void> {}
  close(): void {}

  async listPending(): Promise<JournalEntry[]> {
    return [...this.entries.values()]
      .filter((entry) => entry.state !== "complete")
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
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

  async getCheckpoint(): Promise<TrustedCheckpoint | null> {
    return this.checkpoint ? structuredClone(this.checkpoint) : null
  }

  async setCheckpoint(checkpoint: TrustedCheckpoint): Promise<void> {
    this.cursor = checkpoint.cursor
    this.checkpoint = structuredClone(checkpoint)
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

  async clearRebuildableState(): Promise<void> {
    this.entries.clear()
    this.snapshots.clear()
  }
}
