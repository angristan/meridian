import "fake-indexeddb/auto"
import { describe, expect, it } from "vitest"
import type { JournalEntry } from "../src/model"
import type { JournalPort } from "../src/storage/contracts"
import { IndexedDbJournal } from "../src/storage/indexed-db-journal"
import { MemoryJournal } from "../src/storage/memory-journal"

interface JournalHarness {
  journal: JournalPort
  cleanup(): Promise<void>
}

let databaseSequence = 0
const implementations: readonly [string, () => JournalHarness][] = [
  ["memory", () => ({ journal: new MemoryJournal(), cleanup: async () => {} })],
  [
    "IndexedDB",
    () => {
      const databaseName = `journal-contract-${databaseSequence++}`
      return {
        journal: new IndexedDbJournal(databaseName),
        cleanup: () => deleteDatabase(databaseName),
      }
    },
  ],
]

describe.each(implementations)("$0 journal contract", (_name, createHarness) => {
  it("coalesces repeated events to the newest path token", async () => {
    await withJournal(createHarness, async (journal) => {
      await journal.putDirtyPath({ path: "note.md", token: "first", observedAt: 1 })
      await journal.putDirtyPath({ path: "note.md", token: "latest", observedAt: 2 })
      await journal.putDirtyPath({ path: "other.md", token: "other", observedAt: 3 })

      expect(await journal.listDirtyPaths()).toEqual([
        { path: "note.md", token: "latest", observedAt: 2 },
        { path: "other.md", token: "other", observedAt: 3 },
      ])
    })
  })

  it("preserves plaintext while invalidating old-epoch prepared ciphertext", async () => {
    await withJournal(createHarness, async (journal) => {
      const plaintext = new TextEncoder().encode("queued edit").buffer
      await journal.putEntry(
        entry({
          attempts: 1,
          state: "failed",
          error: "stale",
          preparedRevision: {
            action: "upsert",
            bytes: plaintext,
            encrypted: { blobs: [], envelope: { epochId: "old" } },
          },
        }),
      )

      await journal.invalidatePreparedRevisions()

      const [pending] = await journal.listPending()
      expect(pending).toMatchObject({
        state: "queued",
        error: null,
        preparedRevision: { invalidatedByEpoch: true, bytes: plaintext },
      })
    })
  })

  it("does not consume an event replaced during reconciliation", async () => {
    await withJournal(createHarness, async (journal) => {
      const observed = { path: "note.md", token: "observed", observedAt: 1 }
      await journal.putDirtyPath(observed)
      await journal.putDirtyPath({ path: "note.md", token: "new-edit", observedAt: 2 })

      await journal.commitReconciliation({
        entries: [],
        putSnapshots: [],
        removeSnapshotPaths: [],
        consumeDirtyPaths: [observed],
      })

      expect(await journal.listDirtyPaths()).toEqual([
        { path: "note.md", token: "new-edit", observedAt: 2 },
      ])
    })
  })

  it("commits reconciliation effects as one visible state", async () => {
    await withJournal(createHarness, async (journal) => {
      const dirty = { path: "note.md", token: "observed", observedAt: 1 }
      const snapshot = {
        fileId: "file",
        path: "note.md",
        fingerprint: "fingerprint",
        revisionId: "revision",
        mtime: 1,
        size: 4,
        kind: "vault" as const,
      }
      await journal.putDirtyPath(dirty)

      await journal.commitReconciliation({
        entries: [entry()],
        putSnapshots: [snapshot],
        removeSnapshotPaths: [],
        consumeDirtyPaths: [dirty],
        fingerprintAuditedAt: 123,
      })

      expect(await journal.listPending()).toEqual([entry()])
      expect((await journal.getSnapshots()).get("note.md")).toEqual(snapshot)
      expect(await journal.listDirtyPaths()).toEqual([])
      expect(await journal.getLastFingerprintAuditAt()).toBe(123)
    })
  })

  it("keeps cursor and checkpoint updates together", async () => {
    await withJournal(createHarness, async (journal) => {
      const checkpoint = {
        cursor: 7,
        logHash: "hash",
        logFormat: "canonical-cbor-v1" as const,
      }

      await journal.setCheckpoint(checkpoint)

      expect(await journal.getCursor()).toBe(7)
      expect(await journal.getCheckpoint()).toEqual(checkpoint)
    })
  })
})

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: "entry",
    action: "upsert",
    fileId: "file",
    path: "note.md",
    previousPath: null,
    fingerprint: "fingerprint",
    baseRevisionId: null,
    parentRevisionIds: [],
    restoreSourceRevisionId: null,
    revisionId: "revision",
    createdAt: 1,
    attempts: 0,
    state: "queued",
    error: null,
    preparedRevision: null,
    ...overrides,
  }
}

async function withJournal(
  createHarness: () => JournalHarness,
  run: (journal: JournalPort) => Promise<void>,
): Promise<void> {
  const { journal, cleanup } = createHarness()
  await journal.open()
  try {
    await run(journal)
  } finally {
    journal.close()
    await cleanup()
  }
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error("Unable to delete test journal"))
    request.onblocked = () => reject(new Error("Test journal deletion is blocked"))
  })
}
