export const DATABASE_VERSION = 6

export function upgradeJournalSchema(
  database: IDBDatabase,
  transaction?: IDBTransaction | null,
): void {
  if (!database.objectStoreNames.contains("entries")) {
    const store = database.createObjectStore("entries", { keyPath: "id" })
    store.createIndex("state", "state", { unique: false })
    store.createIndex("path", "path", { unique: false })
  }
  if (!database.objectStoreNames.contains("files")) {
    database.createObjectStore("files", { keyPath: "path" })
  }
  if (!database.objectStoreNames.contains("dirty-paths")) {
    const store = database.createObjectStore("dirty-paths", { keyPath: "path" })
    store.createIndex("observedAt", "observedAt", { unique: false })
  }
  if (!database.objectStoreNames.contains("meta")) {
    database.createObjectStore("meta", { keyPath: "key" })
  }
  if (!database.objectStoreNames.contains("revisions")) {
    const store = database.createObjectStore("revisions", { keyPath: "revisionId" })
    store.createIndex("path", "path", { unique: false })
    store.createIndex("createdAt", "createdAt", { unique: false })
  }
  if (!database.objectStoreNames.contains("history-revisions")) {
    const store = database.createObjectStore("history-revisions", { keyPath: "revisionId" })
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
  if (transaction) {
    for (const storeName of ["revisions", "history-revisions"]) {
      const store = transaction.objectStore(storeName)
      if (!store.indexNames.contains("fileId")) {
        store.createIndex("fileId", "fileId", { unique: false })
      }
    }
  }
}
