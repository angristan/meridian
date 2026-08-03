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
import { requestResult, transactionDone } from "./idb-helpers"
import { DATABASE_VERSION, upgradeJournalSchema } from "./migration"
import { type MetadataRecord, sortRevisions } from "./types"

export class IndexedDbJournal implements JournalPort {
  private database: IDBDatabase | null = null
  private snapshotIndex: Map<string, FileSnapshot> | null = null
  private snapshotView: ReadonlyMap<string, FileSnapshot> | null = null

  constructor(private readonly databaseName = "meridian") {}

  async open(): Promise<void> {
    if (this.database) return
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, DATABASE_VERSION)
      request.onerror = () => reject(request.error ?? new Error("Unable to open sync journal"))
      request.onblocked = () => reject(new Error("Sync journal upgrade is blocked"))
      request.onupgradeneeded = () => upgradeJournalSchema(request.result, request.transaction)
      request.onsuccess = () => resolve(request.result)
    })
    this.database = database
    database.onversionchange = () => {
      database.close()
      if (this.database === database) {
        this.database = null
        this.snapshotIndex = null
        this.snapshotView = null
      }
    }
    try {
      const snapshots = await this.getAll<FileSnapshot>("files")
      this.setSnapshotIndex(
        new Map(snapshots.map((snapshot) => [snapshot.path, cachedSnapshot(snapshot)])),
      )
    } catch (error) {
      this.close()
      throw error
    }
  }

  close(): void {
    this.database?.close()
    this.database = null
    this.snapshotIndex = null
    this.snapshotView = null
  }

  async listPending(): Promise<JournalEntry[]> {
    const database = this.requireDatabase()
    const transaction = database.transaction("entries", "readonly")
    const done = transactionDone(transaction)
    const state = transaction.objectStore("entries").index("state")
    const entries = (
      await Promise.all(
        PENDING_STATES.map((value) => requestResult<JournalEntry[]>(state.getAll(value))),
      )
    ).flat()
    await done
    return entries.sort(
      (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    )
  }

  async invalidatePreparedRevisions(): Promise<void> {
    const database = this.requireDatabase()
    const transaction = database.transaction("entries", "readwrite")
    const done = transactionDone(transaction)
    const store = transaction.objectStore("entries")
    const entries = await requestResult<JournalEntry[]>(store.getAll())
    for (const entry of entries) {
      if (entry.state === "complete" || entry.preparedRevision === null) continue
      store.put({
        ...entry,
        state: "queued",
        error: null,
        preparedRevision: { ...entry.preparedRevision, invalidatedByEpoch: true },
      } satisfies JournalEntry)
    }
    await done
  }

  async compactLocalStorage(): Promise<LocalCompactionResult> {
    const result: LocalCompactionResult = {
      completedEntries: 0,
      duplicateHistoryRevisions: 0,
    }
    while (true) {
      const deleted = await this.deleteCompleteEntryBatch()
      result.completedEntries += deleted
      if (deleted < COMPACTION_BATCH_SIZE) break
    }
    while (true) {
      const deleted = await this.deleteDuplicateHistoryBatch()
      result.duplicateHistoryRevisions += deleted
      if (deleted < COMPACTION_BATCH_SIZE) break
    }
    return result
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
    store.put({ ...entry, state, error })
    await done
  }

  async commitLocalEffects(commit: LocalEffectsCommit): Promise<void> {
    const putSnapshots = commit.putSnapshots.map(cachedSnapshot)
    const removeSnapshotPaths = [...commit.removeSnapshotPaths]
    const database = this.requireDatabase()
    const transaction = database.transaction(["entries", "files", "conflicts"], "readwrite")
    const entries = transaction.objectStore("entries")
    const files = transaction.objectStore("files")
    const conflicts = transaction.objectStore("conflicts")
    for (const entry of commit.entries) entries.put(entry)
    for (const snapshot of putSnapshots) files.put(snapshot)
    for (const path of removeSnapshotPaths) files.delete(path)
    for (const resolution of commit.resolvedConflicts) {
      const conflict = await requestResult<ConflictRecord | undefined>(conflicts.get(resolution.id))
      if (conflict) conflicts.put({ ...conflict, resolvedAt: resolution.resolvedAt })
    }
    await transactionDone(transaction)

    const snapshotIndex = this.requireSnapshotIndex()
    for (const snapshot of putSnapshots) snapshotIndex.set(snapshot.path, snapshot)
    for (const path of removeSnapshotPaths) snapshotIndex.delete(path)
  }

  async putDirtyPath(change: DirtyPath): Promise<void> {
    await this.put("dirty-paths", change)
  }

  async listDirtyPaths(): Promise<DirtyPath[]> {
    return (await this.getAll<DirtyPath>("dirty-paths")).sort(
      (left, right) => left.observedAt - right.observedAt || left.path.localeCompare(right.path),
    )
  }

  async commitReconciliation(commit: ReconciliationCommit): Promise<void> {
    const putSnapshots = commit.putSnapshots.map(cachedSnapshot)
    const removeSnapshotPaths = [...commit.removeSnapshotPaths]
    const database = this.requireDatabase()
    const transaction = database.transaction(
      ["entries", "files", "dirty-paths", "meta"],
      "readwrite",
    )
    const done = transactionDone(transaction)
    const entries = transaction.objectStore("entries")
    const files = transaction.objectStore("files")
    const dirtyPaths = transaction.objectStore("dirty-paths")
    for (const entry of commit.entries) entries.put(entry)
    for (const snapshot of putSnapshots) files.put(snapshot)
    for (const path of removeSnapshotPaths) files.delete(path)
    const currentDirtyPaths = await requestResult<DirtyPath[]>(dirtyPaths.getAll())
    const tokenByPath = new Map(currentDirtyPaths.map((change) => [change.path, change.token]))
    for (const change of commit.consumeDirtyPaths) {
      if (tokenByPath.get(change.path) === change.token) dirtyPaths.delete(change.path)
    }
    if (commit.fingerprintAuditedAt !== undefined) {
      transaction.objectStore("meta").put({
        key: "last-fingerprint-audit-at",
        value: commit.fingerprintAuditedAt,
      } satisfies MetadataRecord)
    }
    await done

    const snapshotIndex = this.requireSnapshotIndex()
    for (const snapshot of putSnapshots) snapshotIndex.set(snapshot.path, snapshot)
    for (const path of removeSnapshotPaths) snapshotIndex.delete(path)
  }

  async getSnapshots(): Promise<ReadonlyMap<string, FileSnapshot>> {
    if (!this.snapshotView) throw new Error("Sync journal is not open")
    return this.snapshotView
  }

  async getCursor(): Promise<number> {
    return (await this.getMetadata<number>("cursor")) ?? 0
  }

  async getLastSuccessfulSyncAt(): Promise<number | null> {
    const timestamp = await this.getMetadata<unknown>("last-successful-sync-at")
    return isValidTimestamp(timestamp) ? timestamp : null
  }

  async setLastSuccessfulSyncAt(timestamp: number): Promise<void> {
    if (!isValidTimestamp(timestamp)) throw new Error("Last sync timestamp is invalid")
    await this.put("meta", {
      key: "last-successful-sync-at",
      value: timestamp,
    } satisfies MetadataRecord)
  }

  async getLastFingerprintAuditAt(): Promise<number | null> {
    const timestamp = await this.getMetadata<unknown>("last-fingerprint-audit-at")
    return isValidTimestamp(timestamp) ? timestamp : null
  }

  async getLastRetentionAcknowledgementKey(): Promise<string | null> {
    const key = await this.getMetadata<unknown>("last-retention-acknowledgement-key")
    return typeof key === "string" && key.length > 0 ? key : null
  }

  async setLastRetentionAcknowledgementKey(key: string): Promise<void> {
    if (key.length === 0) throw new Error("Retention acknowledgement key is invalid")
    await this.put("meta", {
      key: "last-retention-acknowledgement-key",
      value: key,
    } satisfies MetadataRecord)
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

  async listDeviceRevocations(): Promise<DeviceRevocationRecord[]> {
    return this.getAll<DeviceRevocationRecord>("revocations")
  }

  async putDeviceRevocation(revocation: DeviceRevocationRecord): Promise<void> {
    const database = this.requireDatabase()
    const transaction = database.transaction("revocations", "readwrite")
    const done = transactionDone(transaction)
    const store = transaction.objectStore("revocations")
    const existing = await requestResult<DeviceRevocationRecord | undefined>(
      store.get(revocation.deviceId),
    )
    if (existing && existing.cursor !== revocation.cursor) {
      transaction.abort()
      await done.catch(() => undefined)
      throw new Error("Device has conflicting revocation records")
    }
    store.put(revocation)
    await done
  }

  async finishPushedRevision(commit: PushedRevisionCommit): Promise<void> {
    const snapshot = commit.snapshot ? cachedSnapshot(commit.snapshot) : null
    const removeSnapshotPaths = [...commit.removeSnapshotPaths]
    const database = this.requireDatabase()
    const transaction = database.transaction(["entries", "files", "revisions"], "readwrite")
    const files = transaction.objectStore("files")
    transaction.objectStore("entries").put(commit.entry)
    transaction.objectStore("revisions").put(commit.revision)
    if (snapshot) files.put(snapshot)
    for (const path of removeSnapshotPaths) files.delete(path)
    await transactionDone(transaction)

    const snapshotIndex = this.requireSnapshotIndex()
    if (snapshot) snapshotIndex.set(snapshot.path, snapshot)
    for (const path of removeSnapshotPaths) snapshotIndex.delete(path)
  }

  async commitAppliedOperation(commit: AppliedOperationCommit): Promise<void> {
    const putSnapshots = commit.putSnapshots.map(cachedSnapshot)
    const removeSnapshotPaths = [...commit.removeSnapshotPaths]
    const database = this.requireDatabase()
    const transaction = database.transaction(
      ["entries", "files", "revisions", "conflicts"],
      "readwrite",
    )
    const files = transaction.objectStore("files")
    const entries = transaction.objectStore("entries")
    const conflicts = transaction.objectStore("conflicts")
    for (const entry of commit.entries) entries.put(entry)
    for (const snapshot of putSnapshots) files.put(snapshot)
    for (const path of removeSnapshotPaths) files.delete(path)
    for (const conflict of commit.conflicts) conflicts.put(conflict)
    transaction.objectStore("revisions").put(commit.revision)
    await transactionDone(transaction)

    const snapshotIndex = this.requireSnapshotIndex()
    for (const snapshot of putSnapshots) snapshotIndex.set(snapshot.path, snapshot)
    for (const path of removeSnapshotPaths) snapshotIndex.delete(path)
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
    if (path === undefined) return sortRevisions(await this.getAll<LocalRevision>("revisions"))
    const database = this.requireDatabase()
    const transaction = database.transaction("revisions", "readonly")
    const done = transactionDone(transaction)
    const revisions = await requestResult<LocalRevision[]>(
      transaction.objectStore("revisions").index("path").getAll(path),
    )
    await done
    return sortRevisions(revisions)
  }

  async listFileRevisions(fileId: string): Promise<LocalRevision[]> {
    const database = this.requireDatabase()
    const transaction = database.transaction("revisions", "readonly")
    const done = transactionDone(transaction)
    const revisions = await requestResult<LocalRevision[]>(
      transaction.objectStore("revisions").index("fileId").getAll(fileId),
    )
    await done
    return sortRevisions(revisions)
  }

  async getHistoryCheckpoint(): Promise<TrustedCheckpoint | null> {
    return (await this.getMetadata<TrustedCheckpoint>("history-checkpoint")) ?? null
  }

  async commitHistoryOperation(
    revision: LocalRevision | null,
    checkpoint: TrustedCheckpoint,
    revocation?: DeviceRevocationRecord,
  ): Promise<void> {
    const database = this.requireDatabase()
    const transaction = database.transaction(
      ["history-revisions", "meta", "revocations"],
      "readwrite",
    )
    const done = transactionDone(transaction)
    if (revocation) {
      const revocations = transaction.objectStore("revocations")
      const existing = await requestResult<DeviceRevocationRecord | undefined>(
        revocations.get(revocation.deviceId),
      )
      if (existing && existing.cursor !== revocation.cursor) {
        transaction.abort()
        await done.catch(() => undefined)
        throw new Error("Device has conflicting revocation records")
      }
      revocations.put(revocation)
    }
    if (revision) transaction.objectStore("history-revisions").put(revision)
    transaction.objectStore("meta").put({
      key: "history-checkpoint",
      value: checkpoint,
    } satisfies MetadataRecord)
    await done
  }

  async getRetainedRevision(revisionId: string): Promise<LocalRevision | null> {
    const database = this.requireDatabase()
    const transaction = database.transaction(["revisions", "history-revisions"], "readonly")
    const done = transactionDone(transaction)
    const current = await requestResult<LocalRevision | undefined>(
      transaction.objectStore("revisions").get(revisionId),
    )
    const history = current
      ? undefined
      : await requestResult<LocalRevision | undefined>(
          transaction.objectStore("history-revisions").get(revisionId),
        )
    await done
    return current ?? history ?? null
  }

  async listRetainedRevisions(): Promise<LocalRevision[]> {
    return this.listRetained()
  }

  async listRetainedFileRevisions(fileId: string): Promise<LocalRevision[]> {
    return this.listRetained(fileId)
  }

  private async listRetained(fileId?: string): Promise<LocalRevision[]> {
    const database = this.requireDatabase()
    const transaction = database.transaction(["revisions", "history-revisions"], "readonly")
    const done = transactionDone(transaction)
    const read = (storeName: "revisions" | "history-revisions") => {
      const store = transaction.objectStore(storeName)
      return requestResult<LocalRevision[]>(
        fileId === undefined ? store.getAll() : store.index("fileId").getAll(fileId),
      )
    }
    const [history, current] = await Promise.all([read("history-revisions"), read("revisions")])
    await done
    const byId = new Map(history.map((revision) => [revision.revisionId, revision]))
    for (const revision of current) byId.set(revision.revisionId, revision)
    return sortRevisions([...byId.values()])
  }

  async listConflicts(unresolvedOnly = false): Promise<ConflictRecord[]> {
    const conflicts = await this.getAll<ConflictRecord>("conflicts")
    return conflicts
      .filter((conflict) => !unresolvedOnly || conflict.resolvedAt === null)
      .sort((left, right) => right.createdAt - left.createdAt)
  }

  async clearSnapshots(): Promise<void> {
    const database = this.requireDatabase()
    const transaction = database.transaction("files", "readwrite")
    transaction.objectStore("files").clear()
    await transactionDone(transaction)
    this.requireSnapshotIndex().clear()
  }

  private async deleteCompleteEntryBatch(): Promise<number> {
    const database = this.requireDatabase()
    const transaction = database.transaction("entries", "readwrite")
    const done = transactionDone(transaction)
    const deleted = await deleteCursorMatches(
      transaction,
      transaction.objectStore("entries").index("state").openCursor("complete"),
      () => true,
    )
    await done
    return deleted
  }

  private async deleteDuplicateHistoryBatch(): Promise<number> {
    const database = this.requireDatabase()
    const transaction = database.transaction(["history-revisions", "revisions"], "readwrite")
    const done = transactionDone(transaction)
    const history = transaction.objectStore("history-revisions")
    const revisions = transaction.objectStore("revisions")
    const deleted = await deleteCursorMatches(transaction, history.openCursor(), async (cursor) => {
      const current = await requestResult<LocalRevision | undefined>(
        revisions.get(cursor.primaryKey),
      )
      return current !== undefined && sameRevision(current, cursor.value as LocalRevision)
    })
    await done
    return deleted
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

  private requireSnapshotIndex(): Map<string, FileSnapshot> {
    if (!this.snapshotIndex) throw new Error("Sync journal is not open")
    return this.snapshotIndex
  }

  private setSnapshotIndex(index: Map<string, FileSnapshot>): void {
    this.snapshotIndex = index
    this.snapshotView = new ReadonlyMapView(index)
  }
}

const COMPACTION_BATCH_SIZE = 500
const PENDING_STATES: readonly JournalState[] = ["queued", "uploading", "committing", "failed"]

class ReadonlyMapView<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly [Symbol.toStringTag] = "ReadonlyMap"

  constructor(private readonly source: ReadonlyMap<Key, Value>) {}

  get size(): number {
    return this.source.size
  }

  get(key: Key): Value | undefined {
    return this.source.get(key)
  }

  has(key: Key): boolean {
    return this.source.has(key)
  }

  entries(): MapIterator<[Key, Value]> {
    return this.source.entries()
  }

  keys(): MapIterator<Key> {
    return this.source.keys()
  }

  values(): MapIterator<Value> {
    return this.source.values()
  }

  forEach(
    callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
    thisArg?: unknown,
  ): void {
    this.source.forEach((value, key) => {
      callbackfn.call(thisArg, value, key, this)
    })
  }

  [Symbol.iterator](): MapIterator<[Key, Value]> {
    return this.entries()
  }
}

function cachedSnapshot(snapshot: FileSnapshot): FileSnapshot {
  return Object.freeze(structuredClone(snapshot))
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

async function deleteCursorMatches(
  transaction: IDBTransaction,
  request: IDBRequest<IDBCursorWithValue | null>,
  shouldDelete: (cursor: IDBCursorWithValue) => boolean | Promise<boolean>,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let deleted = 0
    request.onerror = () => reject(request.error ?? new Error("Local compaction cursor failed"))
    request.onsuccess = async () => {
      const cursor = request.result
      if (!cursor || deleted >= COMPACTION_BATCH_SIZE) {
        resolve(deleted)
        return
      }
      try {
        if (await shouldDelete(cursor)) {
          cursor.delete()
          deleted += 1
        }
        if (deleted >= COMPACTION_BATCH_SIZE) resolve(deleted)
        else cursor.continue()
      } catch (error) {
        transaction.abort()
        reject(error)
      }
    }
  })
}

function sameRevision(left: LocalRevision, right: LocalRevision): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
