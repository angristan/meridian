import type { ConflictRecord, FileSnapshot, LocalRevision } from "../src/model"
import type { JournalPort } from "../src/storage/contracts"

export async function seedRevision(
  journal: Pick<JournalPort, "commitAppliedOperation">,
  revision: LocalRevision,
): Promise<void> {
  await journal.commitAppliedOperation({
    revision,
    entries: [],
    putSnapshots: [],
    removeSnapshotPaths: [],
    conflicts: [],
  })
}

export async function seedConflict(
  journal: Pick<JournalPort, "commitAppliedOperation" | "getRevision">,
  conflict: ConflictRecord,
): Promise<void> {
  const revision = await journal.getRevision(conflict.remoteRevisionId)
  if (!revision) throw new Error("Conflict fixture requires its remote revision")
  await journal.commitAppliedOperation({
    revision,
    entries: [],
    putSnapshots: [],
    removeSnapshotPaths: [],
    conflicts: [conflict],
  })
}

export async function seedLegacyIndexedDbRevision(
  databaseName: string,
  revision: LocalRevision,
): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("Unable to open test journal"))
  })
  try {
    const transaction = database.transaction("revisions", "readwrite")
    transaction.objectStore("revisions").put(revision)
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error("Test seeding failed"))
      transaction.onabort = () => reject(transaction.error ?? new Error("Test seeding aborted"))
    })
  } finally {
    database.close()
  }
}

export async function seedSnapshots(
  journal: Pick<JournalPort, "clearSnapshots" | "commitReconciliation">,
  snapshots: FileSnapshot[],
): Promise<void> {
  await journal.clearSnapshots()
  await journal.commitReconciliation({
    entries: [],
    putSnapshots: snapshots,
    removeSnapshotPaths: [],
    consumeDirtyPaths: [],
  })
}
