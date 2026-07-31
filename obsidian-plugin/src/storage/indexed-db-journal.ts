import type {
  ConflictRecord,
  DeviceRevocationRecord,
  DirtyPath,
  FileSnapshot,
  JournalEntry,
  JournalState,
  LocalRevision,
  TrustedCheckpoint,
} from "../model"
import type { JournalPort, ReconciliationCommit } from "./contracts"
import { requestResult, transactionDone } from "./idb-helpers"
import { DATABASE_VERSION, migrateStableFileIds, upgradeJournalSchema } from "./migration"
import { type MetadataRecord, sortRevisions } from "./types"

export class IndexedDbJournal implements JournalPort {
  private database: IDBDatabase | null = null

  constructor(private readonly databaseName = "meridian") {}

  async open(): Promise<void> {
    if (this.database) return
    this.database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, DATABASE_VERSION)
      request.onerror = () => reject(request.error ?? new Error("Unable to open sync journal"))
      request.onblocked = () => reject(new Error("Sync journal upgrade is blocked"))
      request.onupgradeneeded = () => upgradeJournalSchema(request.result)
      request.onsuccess = () => {
        const database = request.result
        database.onversionchange = () => database.close()
        resolve(database)
      }
    })
    await migrateStableFileIds(this.requireDatabase())
  }

  close(): void {
    this.database?.close()
    this.database = null
  }

  async listPending(): Promise<JournalEntry[]> {
    const entries = await this.getAll<JournalEntry>("entries")
    return entries
      .filter((entry) => entry.state !== "complete")
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  }

  async putEntry(entry: JournalEntry): Promise<void> {
    await this.put("entries", entry)
  }

  async updateEntry(id: string, state: JournalState, error: string | null = null): Promise<void> {
    const database = this.requireDatabase()
    const transaction = database.transaction("entries", "readwrite")
    const done = transactionDone(transaction)
    const store = transaction.objectStore("entries")
    const entry = await requestResult<JournalEntry | undefined>(store.get(id))
    if (!entry) throw new Error(`Missing journal entry ${id}`)
    store.put({
      ...entry,
      state,
      error,
      attempts: state === "failed" ? entry.attempts + 1 : entry.attempts,
    })
    await done
  }

  async hasPendingPath(path: string): Promise<boolean> {
    const entries = await this.getAll<JournalEntry>("entries")
    return entries.some((entry) => entry.path === path && entry.state !== "complete")
  }

  async putDirtyPath(change: DirtyPath): Promise<void> {
    await this.put("dirty-paths", change)
  }

  async listDirtyPaths(): Promise<DirtyPath[]> {
    return (await this.getAll<DirtyPath>("dirty-paths")).sort(
      (left, right) => left.observedAt - right.observedAt || left.path.localeCompare(right.path),
    )
  }

  async consumeDirtyPaths(changes: readonly DirtyPath[]): Promise<void> {
    if (changes.length === 0) return
    const database = this.requireDatabase()
    const transaction = database.transaction("dirty-paths", "readwrite")
    const done = transactionDone(transaction)
    const store = transaction.objectStore("dirty-paths")
    for (const change of changes) {
      const current = await requestResult<DirtyPath | undefined>(store.get(change.path))
      if (current?.token === change.token) store.delete(change.path)
    }
    await done
  }

  async clearDirtyPaths(): Promise<void> {
    const database = this.requireDatabase()
    const transaction = database.transaction("dirty-paths", "readwrite")
    transaction.objectStore("dirty-paths").clear()
    await transactionDone(transaction)
  }

  async commitReconciliation(commit: ReconciliationCommit): Promise<void> {
    const database = this.requireDatabase()
    const transaction = database.transaction(["entries", "files", "dirty-paths"], "readwrite")
    const done = transactionDone(transaction)
    const entries = transaction.objectStore("entries")
    const files = transaction.objectStore("files")
    const dirtyPaths = transaction.objectStore("dirty-paths")
    for (const entry of commit.entries) entries.put(entry)
    for (const snapshot of commit.putSnapshots) files.put(snapshot)
    for (const path of commit.removeSnapshotPaths) files.delete(path)
    for (const change of commit.consumeDirtyPaths) {
      const current = await requestResult<DirtyPath | undefined>(dirtyPaths.get(change.path))
      if (current?.token === change.token) dirtyPaths.delete(change.path)
    }
    await done
  }

  async getSnapshots(): Promise<Map<string, FileSnapshot>> {
    const snapshots = await this.getAll<FileSnapshot>("files")
    return new Map(snapshots.map((snapshot) => [snapshot.path, snapshot]))
  }

  async replaceSnapshots(snapshots: FileSnapshot[]): Promise<void> {
    const database = this.requireDatabase()
    const transaction = database.transaction("files", "readwrite")
    const done = transactionDone(transaction)
    const store = transaction.objectStore("files")
    store.clear()
    for (const snapshot of snapshots) store.put(snapshot)
    await done
  }

  async putSnapshot(snapshot: FileSnapshot): Promise<void> {
    await this.put("files", snapshot)
  }

  async removeSnapshot(path: string): Promise<void> {
    const database = this.requireDatabase()
    const transaction = database.transaction("files", "readwrite")
    const done = transactionDone(transaction)
    transaction.objectStore("files").delete(path)
    await done
  }

  async getCursor(): Promise<number> {
    return (await this.getMetadata<number>("cursor")) ?? 0
  }

  async getCheckpoint(): Promise<TrustedCheckpoint | null> {
    return (await this.getMetadata<TrustedCheckpoint>("checkpoint")) ?? null
  }

  async setCheckpoint(checkpoint: TrustedCheckpoint): Promise<void> {
    const database = this.requireDatabase()
    const transaction = database.transaction("meta", "readwrite")
    const store = transaction.objectStore("meta")
    store.put({ key: "cursor", value: checkpoint.cursor } satisfies MetadataRecord)
    store.put({ key: "checkpoint", value: checkpoint } satisfies MetadataRecord)
    await transactionDone(transaction)
  }

  async getDeviceRevocation(deviceId: string): Promise<DeviceRevocationRecord | null> {
    const database = this.requireDatabase()
    const transaction = database.transaction("revocations", "readonly")
    const done = transactionDone(transaction)
    const revocation = await requestResult<DeviceRevocationRecord | undefined>(
      transaction.objectStore("revocations").get(deviceId),
    )
    await done
    return revocation ?? null
  }

  async putDeviceRevocation(revocation: DeviceRevocationRecord): Promise<void> {
    const existing = await this.getDeviceRevocation(revocation.deviceId)
    if (existing && existing.cursor !== revocation.cursor) {
      throw new Error("Device has conflicting revocation records")
    }
    await this.put("revocations", revocation)
  }

  async putRevision(revision: LocalRevision): Promise<void> {
    await this.put("revisions", revision)
  }

  async getRevision(revisionId: string): Promise<LocalRevision | null> {
    const database = this.requireDatabase()
    const transaction = database.transaction("revisions", "readonly")
    const done = transactionDone(transaction)
    const revision = await requestResult<LocalRevision | undefined>(
      transaction.objectStore("revisions").get(revisionId),
    )
    await done
    return revision ?? null
  }

  async listRevisions(path?: string): Promise<LocalRevision[]> {
    const revisions = await this.getAll<LocalRevision>("revisions")
    return sortRevisions(
      revisions.filter((revision) => path === undefined || revision.path === path),
    )
  }

  async listFileRevisions(fileId: string): Promise<LocalRevision[]> {
    return sortRevisions(
      (await this.getAll<LocalRevision>("revisions")).filter(
        (revision) => revision.fileId === fileId,
      ),
    )
  }

  async getHistoryCheckpoint(): Promise<TrustedCheckpoint | null> {
    return (await this.getMetadata<TrustedCheckpoint>("history-checkpoint")) ?? null
  }

  async setHistoryCheckpoint(checkpoint: TrustedCheckpoint): Promise<void> {
    await this.put("meta", {
      key: "history-checkpoint",
      value: checkpoint,
    } satisfies MetadataRecord)
  }

  async putHistoryRevision(revision: LocalRevision): Promise<void> {
    await this.put("history-revisions", revision)
  }

  async getHistoryRevision(revisionId: string): Promise<LocalRevision | null> {
    const database = this.requireDatabase()
    const transaction = database.transaction("history-revisions", "readonly")
    const done = transactionDone(transaction)
    const revision = await requestResult<LocalRevision | undefined>(
      transaction.objectStore("history-revisions").get(revisionId),
    )
    await done
    return revision ?? null
  }

  async listHistoryRevisions(): Promise<LocalRevision[]> {
    return sortRevisions(await this.getAll<LocalRevision>("history-revisions"))
  }

  async putConflict(conflict: ConflictRecord): Promise<void> {
    await this.put("conflicts", conflict)
  }

  async listConflicts(unresolvedOnly = false): Promise<ConflictRecord[]> {
    const conflicts = await this.getAll<ConflictRecord>("conflicts")
    return conflicts
      .filter((conflict) => !unresolvedOnly || conflict.resolvedAt === null)
      .sort((left, right) => right.createdAt - left.createdAt)
  }

  async resolveConflict(id: string): Promise<void> {
    const database = this.requireDatabase()
    const transaction = database.transaction("conflicts", "readwrite")
    const done = transactionDone(transaction)
    const store = transaction.objectStore("conflicts")
    const conflict = await requestResult<ConflictRecord | undefined>(store.get(id))
    if (conflict) store.put({ ...conflict, resolvedAt: Date.now() })
    await done
  }

  async clearSnapshots(): Promise<void> {
    const database = this.requireDatabase()
    const transaction = database.transaction("files", "readwrite")
    transaction.objectStore("files").clear()
    await transactionDone(transaction)
  }

  private async getMetadata<T>(key: string): Promise<T | null> {
    const database = this.requireDatabase()
    const transaction = database.transaction("meta", "readonly")
    const done = transactionDone(transaction)
    const result = await requestResult<MetadataRecord | undefined>(
      transaction.objectStore("meta").get(key),
    )
    await done
    return (result?.value as T | undefined) ?? null
  }

  private async getAll<T>(storeName: string): Promise<T[]> {
    const database = this.requireDatabase()
    const transaction = database.transaction(storeName, "readonly")
    const done = transactionDone(transaction)
    const result = await requestResult<T[]>(transaction.objectStore(storeName).getAll())
    await done
    return result
  }

  private async put(storeName: string, value: object): Promise<void> {
    const database = this.requireDatabase()
    const transaction = database.transaction(storeName, "readwrite")
    transaction.objectStore(storeName).put(value)
    await transactionDone(transaction)
  }

  private requireDatabase(): IDBDatabase {
    if (!this.database) throw new Error("Sync journal is not open")
    return this.database
  }
}
