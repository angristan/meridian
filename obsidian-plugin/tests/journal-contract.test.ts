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

  it("ignores legacy fingerprint and attempt values", async () => {
    await withJournal(createHarness, async (journal) => {
      const legacy = {
        ...entry(),
        fingerprint: "legacy-fingerprint",
        attempts: 7,
      } as JournalEntry
      await journal.putEntry(legacy)

      await journal.updateEntry(legacy.id, "failed", "retry")

      expect(await journal.listPending()).toMatchObject([
        { id: legacy.id, state: "failed", error: "retry" },
      ])
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

  it("commits related local effects as one transition", async () => {
    await withJournal(createHarness, async (journal) => {
      const conflict = {
        id: "conflict",
        sourcePath: "note.md",
        conflictPath: "note.conflict.md",
        localRevisionId: null,
        remoteRevisionId: "remote-revision",
        createdAt: 1,
        kind: "text" as const,
        resolvedAt: null,
      }
      await journal.commitAppliedOperation({
        revision: {
          revisionId: "remote-revision",
          fileId: "file",
          path: "note.md",
          parents: [],
          deviceId: "remote",
          createdAt: 1,
          cursor: 1,
          tombstone: false,
          isConflict: true,
          operation: null,
        },
        entries: [],
        putSnapshots: [
          {
            fileId: "copy",
            path: "note.conflict.md",
            fingerprint: "old",
            size: 3,
            mtime: 1,
            kind: "vault",
          },
        ],
        removeSnapshotPaths: [],
        conflicts: [conflict],
      })
      const replacement = {
        fileId: "file",
        path: "note.md",
        fingerprint: "new",
        size: 3,
        mtime: 2,
        kind: "vault" as const,
      }

      await journal.commitLocalEffects({
        entries: [entry()],
        putSnapshots: [replacement],
        removeSnapshotPaths: ["note.conflict.md"],
        resolvedConflicts: [{ id: conflict.id, resolvedAt: 2 }],
      })

      expect(await journal.listPending()).toEqual([entry()])
      expect([...(await journal.getSnapshots()).values()]).toEqual([replacement])
      expect(await journal.listConflicts(true)).toEqual([])
      expect(await journal.listConflicts()).toEqual([{ ...conflict, resolvedAt: 2 }])
    })
  })

  it("settles a pushed revision with its index and entry effects", async () => {
    await withJournal(createHarness, async (journal) => {
      const snapshot = {
        fileId: "file",
        path: "renamed.md",
        fingerprint: "fingerprint",
        size: 4,
        mtime: 1,
        kind: "vault" as const,
      }
      const revision = {
        revisionId: "revision",
        fileId: "file",
        path: "renamed.md",
        action: "upsert" as const,
        previousPath: "note.md",
        parents: [],
        deviceId: "device",
        createdAt: 1,
        cursor: 1,
        tombstone: false,
        isConflict: false,
        operation: null,
      }
      await journal.commitReconciliation({
        entries: [entry()],
        putSnapshots: [{ ...snapshot, path: "note.md" }],
        removeSnapshotPaths: [],
        consumeDirtyPaths: [],
      })

      await journal.finishPushedRevision({
        entry: entry({ state: "complete" }),
        revision,
        snapshot,
        removeSnapshotPaths: ["note.md"],
      })

      expect(await journal.listPending()).toEqual([])
      expect([...(await journal.getSnapshots()).keys()]).toEqual(["renamed.md"])
      expect(await journal.getRevision("revision")).toEqual(revision)
    })
  })

  it("resets only stale history indexes once per version", async () => {
    await withJournal(createHarness, async (journal) => {
      const revision = {
        revisionId: "history-revision",
        fileId: "file",
        path: "note.md",
        parents: [],
        deviceId: "device",
        createdAt: 1,
        cursor: 1,
        tombstone: false,
        isConflict: false,
        operation: null,
      }
      const pending = entry()
      const snapshot = {
        fileId: "live-file",
        path: "live.md",
        fingerprint: "fingerprint",
        size: 4,
        mtime: 1,
        kind: "vault" as const,
      }
      const revocation = { deviceId: "revoked", operationId: "revocation", cursor: 8 }
      await journal.putEntry(pending)
      await journal.commitReconciliation({
        entries: [],
        putSnapshots: [snapshot],
        removeSnapshotPaths: [],
        consumeDirtyPaths: [],
      })
      await journal.putDeviceRevocation(revocation)
      await journal.setCheckpoint({ cursor: 9, logHash: "live-hash" })
      await journal.commitHistoryOperation(revision, { cursor: 1, logHash: "history-hash" })

      await journal.prepareHistoryBackfill(1)

      expect(await journal.getHistoryCheckpoint()).toBeNull()
      expect(await journal.listRetainedRevisions()).toEqual([])
      expect(await journal.getCheckpoint()).toMatchObject({ cursor: 9, logHash: "live-hash" })
      expect(await journal.listPending()).toEqual([pending])
      expect((await journal.getSnapshots()).get("live.md")).toEqual(snapshot)
      expect(await journal.getDeviceRevocation("revoked")).toEqual(revocation)

      await journal.commitHistoryOperation(revision, { cursor: 1, logHash: "history-hash" })
      await journal.prepareHistoryBackfill(1)
      expect(await journal.getHistoryCheckpoint()).toMatchObject({ cursor: 1 })
      expect(await journal.listRetainedRevisions()).toEqual([revision])

      await journal.prepareHistoryBackfill(2)
      expect(await journal.getHistoryCheckpoint()).toBeNull()
      expect(await journal.listRetainedRevisions()).toEqual([])
    })
  })

  it("commits history revocations with their checkpoint", async () => {
    await withJournal(createHarness, async (journal) => {
      const checkpoint = { cursor: 3, logHash: "hash-3" }
      const revocation = { deviceId: "revoked", operationId: "operation-3", cursor: 3 }

      await journal.commitHistoryOperation(null, checkpoint, revocation)

      expect(await journal.getHistoryCheckpoint()).toEqual(checkpoint)
      expect(await journal.getDeviceRevocation("revoked")).toEqual(revocation)
      await expect(
        journal.commitHistoryOperation(
          null,
          { cursor: 4, logHash: "hash-4" },
          {
            ...revocation,
            cursor: 4,
          },
        ),
      ).rejects.toThrow(/conflicting revocation/)
      expect(await journal.getHistoryCheckpoint()).toEqual(checkpoint)
    })
  })

  it("prefers verified history metadata without mutating the live revision", async () => {
    await withJournal(createHarness, async (journal) => {
      const liveRevision = {
        revisionId: "revision",
        fileId: "stale-file",
        path: "stale.md",
        parents: [],
        deviceId: "device",
        createdAt: 1,
        cursor: 1,
        tombstone: false,
        isConflict: false,
        operation: null,
      }
      const verifiedRevision = {
        ...liveRevision,
        fileId: "verified-file",
        path: "verified.md",
      }
      await journal.commitAppliedOperation({
        revision: liveRevision,
        entries: [],
        putSnapshots: [],
        removeSnapshotPaths: [],
        conflicts: [],
      })
      await journal.commitHistoryOperation(verifiedRevision, { cursor: 1, logHash: "hash-1" })

      expect(await journal.getRevision("revision")).toEqual(liveRevision)
      expect(await journal.getRetainedRevision("revision")).toEqual(verifiedRevision)
      expect(await journal.listRetainedRevisions()).toEqual([verifiedRevision])
      expect(await journal.listRetainedFileRevisions("verified-file")).toEqual([verifiedRevision])
      expect(await journal.listRetainedFileRevisions("stale-file")).toEqual([])
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
    baseRevisionId: null,
    parentRevisionIds: [],
    restoreSourceRevisionId: null,
    revisionId: "revision",
    createdAt: 1,
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
