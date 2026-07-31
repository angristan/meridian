import type { FileSnapshot, JournalEntry, LocalRevision } from "../model"
import { requestResult, transactionDone } from "./idb-helpers"
import type {
  LegacyFileSnapshot,
  LegacyJournalEntry,
  LegacyLocalRevision,
  MigratedJournalRecords,
} from "./types"

export const DATABASE_VERSION = 3

export function upgradeJournalSchema(database: IDBDatabase): void {
  if (!database.objectStoreNames.contains("entries")) {
    const store = database.createObjectStore("entries", { keyPath: "id" })
    store.createIndex("state", "state", { unique: false })
    store.createIndex("path", "path", { unique: false })
  }
  if (!database.objectStoreNames.contains("files")) {
    database.createObjectStore("files", { keyPath: "path" })
  }
  if (!database.objectStoreNames.contains("meta")) {
    database.createObjectStore("meta", { keyPath: "key" })
  }
  if (!database.objectStoreNames.contains("revisions")) {
    const store = database.createObjectStore("revisions", { keyPath: "revisionId" })
    store.createIndex("path", "path", { unique: false })
    store.createIndex("createdAt", "createdAt", { unique: false })
  }
  if (!database.objectStoreNames.contains("conflicts")) {
    const store = database.createObjectStore("conflicts", { keyPath: "id" })
    store.createIndex("resolvedAt", "resolvedAt", { unique: false })
  }
  if (!database.objectStoreNames.contains("revocations")) {
    database.createObjectStore("revocations", { keyPath: "deviceId" })
  }
}

/**
 * Version 1 records predate stable file IDs. This idempotent transaction upgrades every
 * related snapshot, pending entry, and revision together. If it aborts, no partial identity
 * assignment is committed and the next open retries it.
 */
export async function migrateStableFileIds(database: IDBDatabase): Promise<void> {
  const transaction = database.transaction(["files", "entries", "revisions"], "readwrite")
  const filesStore = transaction.objectStore("files")
  const entriesStore = transaction.objectStore("entries")
  const revisionsStore = transaction.objectStore("revisions")
  const [files, entries, revisions] = await Promise.all([
    requestResult<LegacyFileSnapshot[]>(filesStore.getAll()),
    requestResult<LegacyJournalEntry[]>(entriesStore.getAll()),
    requestResult<LegacyLocalRevision[]>(revisionsStore.getAll()),
  ])
  const migrated = migrateJournalRecords(files, entries, revisions)
  for (const file of migrated.files) filesStore.put(file)
  for (const entry of migrated.entries) entriesStore.put(entry)
  for (const revision of migrated.revisions) revisionsStore.put(revision)
  await transactionDone(transaction)
}

/** Exported through the compatibility barrel for focused migration tests. */
export function migrateJournalRecords(
  files: LegacyFileSnapshot[],
  entries: LegacyJournalEntry[],
  revisions: LegacyLocalRevision[],
): MigratedJournalRecords {
  const parent = new Map<string, string>()
  const find = (path: string): string => {
    const current = parent.get(path)
    if (!current) {
      parent.set(path, path)
      return path
    }
    if (current === path) return path
    const root = find(current)
    parent.set(path, root)
    return root
  }
  const union = (left: string, right: string) => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot)
  }
  for (const file of files) find(file.path)
  for (const entry of entries) {
    find(entry.path)
    if (entry.previousPath) union(entry.previousPath, entry.path)
  }
  const revisionById = new Map(revisions.map((revision) => [revision.revisionId, revision]))
  for (const revision of revisions) {
    find(revision.path)
    for (const parentId of revision.parents) {
      const ancestor = revisionById.get(parentId)
      if (ancestor) union(ancestor.path, revision.path)
    }
  }

  const idByRoot = new Map<string, string>()
  const rememberId = (path: string, fileId: string | undefined) => {
    if (fileId) idByRoot.set(find(path), fileId)
  }
  for (const file of files) rememberId(file.path, file.fileId)
  for (const entry of entries) rememberId(entry.path, entry.fileId)
  for (const revision of revisions) rememberId(revision.path, revision.fileId)
  const idFor = (path: string): string => {
    const root = find(path)
    const existing = idByRoot.get(root)
    if (existing) return existing
    const generated = randomFileId()
    idByRoot.set(root, generated)
    return generated
  }

  return {
    files: files.map((file): FileSnapshot => ({ ...file, fileId: idFor(file.path) })),
    entries: entries.map(
      (entry): JournalEntry => ({
        ...entry,
        fileId: idFor(entry.path),
        parentRevisionIds:
          entry.parentRevisionIds ?? (entry.baseRevisionId ? [entry.baseRevisionId] : []),
        restoreSourceRevisionId: entry.restoreSourceRevisionId ?? null,
        preparedRevision: entry.preparedRevision ?? null,
      }),
    ),
    revisions: revisions.map(
      (revision): LocalRevision => ({
        ...revision,
        fileId: idFor(revision.path),
        action: revision.action ?? (revision.tombstone ? "delete" : "upsert"),
        previousPath: revision.previousPath ?? null,
        operation: revision.operation ?? null,
      }),
    ),
  }
}

function randomFileId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}
