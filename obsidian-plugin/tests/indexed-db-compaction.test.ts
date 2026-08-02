import "fake-indexeddb/auto"
import { afterEach, describe, expect, it } from "vitest"
import type { JournalEntry, LocalRevision } from "../src/model"
import { IndexedDbJournal } from "../src/storage/journal"

const databaseNames: string[] = []

function databaseName(): string {
  const name = `meridian-compaction-${crypto.randomUUID()}`
  databaseNames.push(name)
  return name
}

function entry(id: string, state: JournalEntry["state"]): JournalEntry {
  return {
    id,
    action: "upsert",
    fileId: "file-1",
    path: "note.md",
    previousPath: null,
    fingerprint: "fingerprint",
    baseRevisionId: null,
    parentRevisionIds: [],
    restoreSourceRevisionId: null,
    revisionId: `revision-${id}`,
    createdAt: 1,
    attempts: 0,
    state,
    error: state === "failed" ? "retry" : null,
    preparedRevision:
      state === "complete"
        ? null
        : {
            action: "upsert",
            bytes: new TextEncoder().encode(id).buffer,
            encrypted: { blobs: [], envelope: { id } },
          },
  }
}

function revision(revisionId: string, cursor: number): LocalRevision {
  return {
    revisionId,
    fileId: "file-1",
    path: "note.md",
    action: "upsert",
    previousPath: null,
    parents: cursor === 1 ? [] : ["revision-1"],
    deviceId: "device-1",
    createdAt: cursor,
    cursor,
    tombstone: false,
    isConflict: false,
    operation: { cursor, logHash: `hash-${cursor}`, envelope: { revisionId } },
  }
}

afterEach(async () => {
  for (const name of databaseNames.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }
})

describe("IndexedDB lossless compaction", () => {
  it("removes only completed work and exact duplicate history", async () => {
    const journal = new IndexedDbJournal(databaseName())
    await journal.open()
    await journal.putEntry(entry("complete", "complete"))
    await journal.putEntry(entry("queued", "queued"))
    await journal.putEntry(entry("failed", "failed"))
    await journal.putDirtyPath({ path: "note.md", token: "token", observedAt: 1 })
    await journal.setCheckpoint({ cursor: 2, logHash: "hash-2" })
    await journal.putDeviceRevocation({ deviceId: "old-device", operationId: "revoke", cursor: 2 })

    const first = revision("revision-1", 1)
    const second = revision("revision-2", 2)
    await journal.putRevision(first)
    await journal.putRevision(second)
    await journal.putHistoryRevision(structuredClone(first))
    await journal.putHistoryRevision({ ...structuredClone(second), path: "historical-name.md" })
    await journal.putConflict({
      id: "conflict",
      sourcePath: "note.md",
      conflictPath: "note.conflict.md",
      localRevisionId: "revision-1",
      remoteRevisionId: "revision-2",
      createdAt: 2,
      kind: "text",
      resolvedAt: null,
    })

    await expect(journal.compactLocalStorage()).resolves.toEqual({
      completedEntries: 1,
      duplicateHistoryRevisions: 1,
    })
    expect((await journal.listPending()).map((item) => item.id)).toEqual(["failed", "queued"])
    expect((await journal.listPending()).every((item) => item.preparedRevision !== null)).toBe(true)
    expect(await journal.listDirtyPaths()).toHaveLength(1)
    expect(await journal.getCheckpoint()).toMatchObject({ cursor: 2, logHash: "hash-2" })
    expect(await journal.listDeviceRevocations()).toHaveLength(1)
    expect(await journal.listFileRevisions("file-1")).toHaveLength(2)
    expect((await journal.listHistoryRevisions()).map((item) => item.revisionId)).toEqual([
      "revision-2",
    ])
    expect(await journal.listConflicts(true)).toHaveLength(1)
    await expect(journal.compactLocalStorage()).resolves.toEqual({
      completedEntries: 0,
      duplicateHistoryRevisions: 0,
    })
    journal.close()
  })

  it("keeps the last successful sync time after reopening", async () => {
    const name = databaseName()
    const journal = new IndexedDbJournal(name)
    await journal.open()

    expect(await journal.getLastSuccessfulSyncAt()).toBeNull()
    await journal.setLastSuccessfulSyncAt(1_725_000_000_000)
    journal.close()

    const reopened = new IndexedDbJournal(name)
    await reopened.open()
    expect(await reopened.getLastSuccessfulSyncAt()).toBe(1_725_000_000_000)
    await expect(reopened.setLastSuccessfulSyncAt(0)).rejects.toThrow(/timestamp is invalid/)
    reopened.close()
  })

  it("persists the fingerprint audit time with reconciliation", async () => {
    const name = databaseName()
    const journal = new IndexedDbJournal(name)
    await journal.open()

    expect(await journal.getLastFingerprintAuditAt()).toBeNull()
    await journal.commitReconciliation({
      entries: [],
      putSnapshots: [],
      removeSnapshotPaths: [],
      consumeDirtyPaths: [],
      fingerprintAuditedAt: 1_725_000_000_000,
    })
    journal.close()

    const reopened = new IndexedDbJournal(name)
    await reopened.open()
    expect(await reopened.getLastFingerprintAuditAt()).toBe(1_725_000_000_000)
    reopened.close()
  })

  it("commits independent batches and resumes idempotently", async () => {
    const name = databaseName()
    const journal = new IndexedDbJournal(name)
    await journal.open()
    for (let index = 0; index < 501; index += 1) {
      await journal.putEntry(entry(`complete-${index}`, "complete"))
    }

    await expect(journal.compactLocalStorage()).resolves.toMatchObject({ completedEntries: 501 })
    journal.close()

    const reopened = new IndexedDbJournal(name)
    await reopened.open()
    await expect(reopened.compactLocalStorage()).resolves.toEqual({
      completedEntries: 0,
      duplicateHistoryRevisions: 0,
    })
    reopened.close()
  })
})
