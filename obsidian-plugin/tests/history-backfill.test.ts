import "fake-indexeddb/auto"
import { describe, expect, it } from "vitest"
import { IndexedDbJournal } from "../src/storage/indexed-db-journal"
import { MemoryJournal } from "../src/storage/memory-journal"
import { SyncController } from "../src/sync/controller"
import { HistoryBackfillService } from "../src/sync/history-backfill-service"
import { ALL_CATEGORIES, FakeCrypto, FakeRemote, FakeVault, TEST_DEVICE } from "./fakes"

function addHistory(remote: FakeRemote): void {
  remote.addRemoteRevision(
    {
      operationId: "operation-one",
      revisionId: "revision-one",
      fileId: "file-id",
      action: "upsert",
      path: "old.md",
      previousPath: null,
      parents: [],
      authorDeviceId: TEST_DEVICE.deviceId,
      blobId: "blob-one",
      isText: true,
      createdAt: 1,
    },
    new TextEncoder().encode("old content").buffer,
  )
  remote.addRemoteRevision(
    {
      operationId: "operation-two",
      revisionId: "revision-two",
      fileId: "file-id",
      action: "upsert",
      path: "current.md",
      previousPath: "old.md",
      parents: ["revision-one"],
      authorDeviceId: TEST_DEVICE.deviceId,
      blobId: "blob-two",
      isText: true,
      createdAt: 2,
    },
    new TextEncoder().encode("current content").buffer,
  )
}

describe("HistoryBackfillService", () => {
  it("stages complete metadata without blobs or live sync mutations", async () => {
    class MetadataOnlyRemote extends FakeRemote {
      override getBlob(): Promise<ArrayBuffer> {
        throw new Error("History metadata must not download content blobs")
      }
    }
    const remote = new MetadataOnlyRemote()
    addHistory(remote)
    const journal = new MemoryJournal()
    await journal.setCheckpoint({ cursor: 7, logHash: "live-sync-hash" })
    const service = new HistoryBackfillService(journal, remote, new FakeCrypto())

    await expect(service.backfill(TEST_DEVICE)).resolves.toBeUndefined()

    expect(await journal.listRevisions()).toEqual([])
    expect(await journal.getCheckpoint()).toEqual({ cursor: 7, logHash: "live-sync-hash" })
    expect((await journal.listRetainedRevisions()).map((revision) => revision.revisionId)).toEqual([
      "revision-two",
      "revision-one",
    ])
    expect(await journal.getHistoryCheckpoint()).toEqual({
      cursor: 2,
      logHash: "hash-2",
      initialLogFormat: "legacy-http-v1",
      logFormat: "legacy-http-v1",
    })
  })

  it("shares one in-flight complete-history download", async () => {
    const remote = new FakeRemote()
    addHistory(remote)
    const barrier = remote.blockNextChangesAfterRead()
    const service = new HistoryBackfillService(new MemoryJournal(), remote, new FakeCrypto())

    const first = service.backfill(TEST_DEVICE)
    const second = service.backfill(TEST_DEVICE)
    await barrier.started

    expect(remote.getChangesCount).toBe(1)
    barrier.release()
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(remote.getChangesCount).toBe(1)
  })

  it("matches live traversal across legacy-to-canonical history", async () => {
    const remote = new FakeRemote()
    remote.addLogFormatTransition()
    remote.addRemoteRevision(
      {
        operationId: "canonical-operation",
        revisionId: "canonical-revision",
        fileId: "canonical-file",
        action: "upsert",
        path: "canonical.md",
        previousPath: null,
        parents: [],
        authorDeviceId: TEST_DEVICE.deviceId,
        blobId: "canonical-blob",
        isText: true,
      },
      new TextEncoder().encode("canonical content").buffer,
    )
    const liveJournal = new MemoryJournal()
    const controller = new SyncController({
      vault: new FakeVault(),
      journal: liveJournal,
      remote,
      crypto: new FakeCrypto(),
      categories: () => ALL_CATEGORIES,
      onStatus: () => {},
    })
    await controller.start(TEST_DEVICE)

    const historyJournal = new MemoryJournal()
    await new HistoryBackfillService(historyJournal, remote, new FakeCrypto()).backfill(TEST_DEVICE)

    expect(await historyJournal.getHistoryCheckpoint()).toEqual(await liveJournal.getCheckpoint())
    expect(await liveJournal.getCheckpoint()).toMatchObject({
      cursor: 2,
      initialLogFormat: "legacy-http-v1",
      logFormat: "canonical-cbor-v1",
    })
    controller.stop()
  })

  it("repairs the observed legacy cross-file tombstone parent", async () => {
    const remote = new FakeRemote()
    remote.addRemoteRevision(
      {
        operationId: "foreign-operation",
        revisionId: "foreign-revision",
        fileId: "foreign-file",
        action: "upsert",
        path: "note.md",
        previousPath: null,
        parents: [],
        authorDeviceId: "other-device",
        blobId: "foreign-blob",
        isText: true,
      },
      new TextEncoder().encode("foreign").buffer,
    )
    remote.addRemoteRevision(
      {
        operationId: "root-operation",
        revisionId: "own-root",
        fileId: "own-file",
        action: "upsert",
        path: "note.md",
        previousPath: null,
        parents: [],
        authorDeviceId: TEST_DEVICE.deviceId,
        blobId: "root-blob",
        isText: true,
      },
      new TextEncoder().encode("root").buffer,
    )
    remote.addRemoteRevision(
      {
        operationId: "head-operation",
        revisionId: "own-head",
        fileId: "own-file",
        action: "upsert",
        path: "note.md",
        previousPath: null,
        parents: ["own-root"],
        authorDeviceId: TEST_DEVICE.deviceId,
        blobId: "head-blob",
        isText: true,
      },
      new TextEncoder().encode("head").buffer,
    )
    const legacyDelete = {
      revisionId: "legacy-delete",
      fileId: "own-file",
      action: "delete" as const,
      path: "note.md",
      previousPath: null,
      parents: ["foreign-revision"],
      authorDeviceId: TEST_DEVICE.deviceId,
      epochId: "epoch-id",
      envelope: "same-signed-legacy-delete",
      blobId: null,
      isText: true,
    }
    remote.addRemoteRevision({ ...legacyDelete, operationId: "delete-operation" }, null)
    remote.addRemoteRevision({ ...legacyDelete, operationId: "delete-retry-operation" }, null)
    const journal = new MemoryJournal()
    await journal.setCheckpoint({ cursor: 5, logHash: "hash-5" })

    await new HistoryBackfillService(journal, remote, new FakeCrypto()).backfill(TEST_DEVICE)

    expect(await journal.getHistoryCheckpoint()).toMatchObject({ cursor: 5 })
    expect(await journal.getRetainedRevision("legacy-delete")).toMatchObject({
      cursor: 4,
      fileId: "own-file",
      parents: ["own-head"],
      tombstone: true,
    })
  })

  it("rejects the same cross-file tombstone in canonical history", async () => {
    const remote = new FakeRemote()
    remote.addRemoteRevision(
      {
        operationId: "foreign-operation",
        revisionId: "foreign-revision",
        fileId: "foreign-file",
        action: "upsert",
        path: "note.md",
        previousPath: null,
        parents: [],
        authorDeviceId: "other-device",
        blobId: "foreign-blob",
        isText: true,
      },
      new TextEncoder().encode("foreign").buffer,
    )
    remote.addRemoteRevision(
      {
        operationId: "root-operation",
        revisionId: "own-root",
        fileId: "own-file",
        action: "upsert",
        path: "note.md",
        previousPath: null,
        parents: [],
        authorDeviceId: TEST_DEVICE.deviceId,
        blobId: "root-blob",
        isText: true,
      },
      new TextEncoder().encode("root").buffer,
    )
    remote.addLogFormatTransition()
    remote.addRemoteRevision(
      {
        operationId: "delete-operation",
        revisionId: "canonical-delete",
        fileId: "own-file",
        action: "delete",
        path: "note.md",
        previousPath: null,
        parents: ["foreign-revision"],
        authorDeviceId: TEST_DEVICE.deviceId,
        blobId: null,
        isText: true,
      },
      null,
    )
    const journal = new MemoryJournal()
    await journal.setCheckpoint({
      cursor: 4,
      logHash: "hash-4",
      initialLogFormat: "legacy-http-v1",
      logFormat: "canonical-cbor-v1",
    })

    await expect(
      new HistoryBackfillService(journal, remote, new FakeCrypto()).backfill(TEST_DEVICE),
    ).rejects.toThrow("Remote revision parent belongs to another file")
    expect(await journal.getHistoryCheckpoint()).toMatchObject({ cursor: 3 })
  })

  it("does not backfill operations beyond the live checkpoint", async () => {
    const remote = new FakeRemote()
    addHistory(remote)
    const journal = new MemoryJournal()
    await journal.setCheckpoint({ cursor: 1, logHash: "hash-1" })

    await expect(
      new HistoryBackfillService(journal, remote, new FakeCrypto()).backfill(TEST_DEVICE),
    ).resolves.toBeUndefined()
    expect((await journal.listRetainedRevisions()).map((revision) => revision.revisionId)).toEqual([
      "revision-one",
    ])
  })

  it("rejects a parent that appears later in remote history", async () => {
    const remote = new FakeRemote()
    remote.addRemoteRevision(
      {
        operationId: "child-operation",
        revisionId: "child",
        fileId: "file-id",
        action: "upsert",
        path: "note.md",
        previousPath: null,
        parents: ["future-parent"],
        authorDeviceId: TEST_DEVICE.deviceId,
        blobId: "child-blob",
        isText: true,
      },
      new TextEncoder().encode("child").buffer,
    )
    remote.addRemoteRevision(
      {
        operationId: "parent-operation",
        revisionId: "future-parent",
        fileId: "file-id",
        action: "upsert",
        path: "note.md",
        previousPath: null,
        parents: [],
        authorDeviceId: TEST_DEVICE.deviceId,
        blobId: "parent-blob",
        isText: true,
      },
      new TextEncoder().encode("parent").buffer,
    )
    const journal = new MemoryJournal()
    await journal.setCheckpoint({ cursor: 2, logHash: "hash-2" })

    await expect(
      new HistoryBackfillService(journal, remote, new FakeCrypto()).backfill(TEST_DEVICE),
    ).rejects.toThrow("Remote revision history is incomplete")
    expect(await journal.getHistoryCheckpoint()).toBeNull()
    expect(await journal.listRetainedRevisions()).toEqual([])
  })

  it("rejects revision ID reuse while replaying retained history", async () => {
    const remote = new FakeRemote()
    remote.addRemoteRevision(
      {
        operationId: "first-operation",
        revisionId: "reused",
        fileId: "first-file",
        action: "upsert",
        path: "first.md",
        previousPath: null,
        parents: [],
        authorDeviceId: TEST_DEVICE.deviceId,
        blobId: "first-blob",
        isText: true,
      },
      new TextEncoder().encode("first").buffer,
    )
    remote.addRemoteRevision(
      {
        operationId: "second-operation",
        revisionId: "reused",
        fileId: "second-file",
        action: "upsert",
        path: "second.md",
        previousPath: null,
        parents: [],
        authorDeviceId: TEST_DEVICE.deviceId,
        blobId: "second-blob",
        isText: true,
      },
      new TextEncoder().encode("second").buffer,
    )
    const journal = new MemoryJournal()
    await journal.setCheckpoint({ cursor: 2, logHash: "hash-2" })

    await expect(
      new HistoryBackfillService(journal, remote, new FakeCrypto()).backfill(TEST_DEVICE),
    ).rejects.toThrow("Remote history reused a revision ID")
    expect(await journal.getHistoryCheckpoint()).toMatchObject({ cursor: 1 })
    expect(await journal.getRetainedRevision("reused")).toMatchObject({
      fileId: "first-file",
      cursor: 1,
    })
  })

  it("accepts an exact signed revision retried under another wrapper ID", async () => {
    const remote = new FakeRemote()
    for (const operationId of ["first-operation", "retry-operation"]) {
      remote.addRemoteRevision(
        {
          operationId,
          revisionId: "retried-revision",
          fileId: "file-id",
          action: "upsert",
          path: "note.md",
          previousPath: null,
          parents: [],
          authorDeviceId: TEST_DEVICE.deviceId,
          epochId: "epoch-id",
          envelope: "same-canonical-signed-envelope",
          blobId: "blob-id",
          isText: true,
        },
        new TextEncoder().encode("same content").buffer,
      )
    }
    const journal = new MemoryJournal()
    await journal.setCheckpoint({ cursor: 2, logHash: "hash-2" })

    await new HistoryBackfillService(journal, remote, new FakeCrypto()).backfill(TEST_DEVICE)

    expect(await journal.getHistoryCheckpoint()).toMatchObject({ cursor: 2 })
    expect(await journal.getRetainedRevision("retried-revision")).toMatchObject({
      cursor: 1,
      fileId: "file-id",
    })
  })

  it("retains an exact retry's earliest cursor for intervening descendants", async () => {
    const remote = new FakeRemote()
    const revision = {
      revisionId: "retried-revision",
      fileId: "file-id",
      action: "upsert" as const,
      path: "note.md",
      previousPath: null,
      parents: [],
      authorDeviceId: TEST_DEVICE.deviceId,
      epochId: "epoch-id",
      envelope: "same-canonical-signed-envelope",
      blobId: "blob-id",
      isText: true,
    }
    remote.addRemoteRevision(
      { ...revision, operationId: "first-operation" },
      new TextEncoder().encode("base").buffer,
    )
    remote.addRemoteRevision(
      {
        ...revision,
        operationId: "child-operation",
        revisionId: "child-revision",
        parents: ["retried-revision"],
        envelope: "child-canonical-signed-envelope",
      },
      new TextEncoder().encode("child").buffer,
    )
    remote.addRemoteRevision(
      { ...revision, operationId: "retry-operation" },
      new TextEncoder().encode("base").buffer,
    )
    const retriedOperation = remote.operations[2]
    if (!retriedOperation) throw new Error("Missing retried test operation")
    const journal = new MemoryJournal()
    await journal.commitAppliedOperation({
      revision: {
        revisionId: revision.revisionId,
        fileId: revision.fileId,
        path: revision.path,
        parents: [],
        deviceId: revision.authorDeviceId,
        createdAt: 1,
        cursor: 3,
        tombstone: false,
        isConflict: false,
        operation: structuredClone(retriedOperation),
      },
      entries: [],
      putSnapshots: [],
      removeSnapshotPaths: [],
      conflicts: [],
    })
    await journal.setCheckpoint({ cursor: 3, logHash: "hash-3" })

    await new HistoryBackfillService(journal, remote, new FakeCrypto()).backfill(TEST_DEVICE)

    expect(await journal.getHistoryCheckpoint()).toMatchObject({ cursor: 3 })
    expect(await journal.getRetainedRevision("retried-revision")).toMatchObject({ cursor: 1 })
    expect(await journal.getRetainedRevision("child-revision")).toMatchObject({
      cursor: 2,
      parents: ["retried-revision"],
    })
  })

  it("rejects different signed content at a reused local cursor", async () => {
    const remote = new FakeRemote()
    remote.addRemoteRevision(
      {
        operationId: "operation-id",
        revisionId: "revision-id",
        fileId: "file-id",
        action: "upsert",
        path: "note.md",
        previousPath: null,
        parents: [],
        authorDeviceId: TEST_DEVICE.deviceId,
        blobId: "verified-blob",
        isText: true,
      },
      new TextEncoder().encode("content").buffer,
    )
    const operation = remote.operations[0]
    if (!operation) throw new Error("Missing test operation")
    const journal = new MemoryJournal()
    await journal.commitAppliedOperation({
      revision: {
        revisionId: "revision-id",
        fileId: "file-id",
        path: "note.md",
        parents: [],
        deviceId: TEST_DEVICE.deviceId,
        createdAt: 1,
        cursor: 1,
        tombstone: false,
        isConflict: false,
        operation: {
          ...structuredClone(operation),
          logHash: "different-hash",
          envelope: { ...(operation.envelope as object), blobId: "different-signed-content" },
        },
      },
      entries: [],
      putSnapshots: [],
      removeSnapshotPaths: [],
      conflicts: [],
    })
    await journal.setCheckpoint({ cursor: 1, logHash: "hash-1" })

    await expect(
      new HistoryBackfillService(journal, remote, new FakeCrypto()).backfill(TEST_DEVICE),
    ).rejects.toThrow("Remote history reused a revision ID")
    expect(await journal.getHistoryCheckpoint()).toBeNull()
  })

  it("restarts a partial old index before repairing a cross-file parent", async () => {
    const remote = new FakeRemote()
    remote.addRemoteRevision(
      {
        operationId: "parent-operation",
        revisionId: "parent-revision",
        fileId: "verified-file",
        action: "upsert",
        path: "note.md",
        previousPath: null,
        parents: [],
        authorDeviceId: TEST_DEVICE.deviceId,
        blobId: "parent-blob",
        isText: true,
      },
      new TextEncoder().encode("parent").buffer,
    )
    remote.addRemoteRevision(
      {
        operationId: "child-operation",
        revisionId: "child-revision",
        fileId: "verified-file",
        action: "upsert",
        path: "note.md",
        previousPath: null,
        parents: ["parent-revision"],
        authorDeviceId: TEST_DEVICE.deviceId,
        blobId: "child-blob",
        isText: true,
      },
      new TextEncoder().encode("child").buffer,
    )
    const operation = remote.operations[0]
    if (!operation) throw new Error("Missing test operation")
    const journal = new MemoryJournal()
    await journal.commitAppliedOperation({
      revision: {
        revisionId: "parent-revision",
        fileId: "stale-file",
        path: "stale.md",
        parents: [],
        deviceId: TEST_DEVICE.deviceId,
        createdAt: 1,
        cursor: 1,
        tombstone: false,
        isConflict: false,
        operation: structuredClone(operation),
      },
      entries: [],
      putSnapshots: [],
      removeSnapshotPaths: [],
      conflicts: [],
    })
    await journal.setCheckpoint({ cursor: 2, logHash: "hash-2" })
    await journal.commitHistoryOperation(null, { cursor: 1, logHash: "hash-1" })

    await new HistoryBackfillService(journal, remote, new FakeCrypto()).backfill(TEST_DEVICE)

    expect(await journal.getHistoryCheckpoint()).toMatchObject({ cursor: 2 })
    expect(await journal.getRetainedRevision("parent-revision")).toMatchObject({
      fileId: "verified-file",
      cursor: 1,
    })
    expect(await journal.getRetainedRevision("child-revision")).toMatchObject({
      fileId: "verified-file",
      parents: ["parent-revision"],
      cursor: 2,
    })
    expect(await journal.getRevision("parent-revision")).toMatchObject({ fileId: "stale-file" })
  })

  it("carries epoch state through one history traversal", async () => {
    class EpochTrackingCrypto extends FakeCrypto {
      inspectedEpochSequences: number[] = []

      override async inspectRevision(...args: Parameters<FakeCrypto["inspectRevision"]>) {
        this.inspectedEpochSequences.push(args[0].epochSequence)
        return super.inspectRevision(...args)
      }
    }
    const remote = new FakeRemote()
    await remote.commit({
      type: "key-epoch",
      operationId: "epoch-operation",
      authorDeviceId: TEST_DEVICE.deviceId,
    })
    remote.addRemoteRevision(
      {
        operationId: "new-epoch-operation",
        revisionId: "new-epoch-revision",
        fileId: "new-epoch-file",
        action: "upsert",
        path: "new-epoch.md",
        previousPath: null,
        parents: [],
        authorDeviceId: TEST_DEVICE.deviceId,
        blobId: "new-epoch-blob",
        isText: true,
      },
      new TextEncoder().encode("new epoch").buffer,
    )
    const journal = new MemoryJournal()
    await journal.setCheckpoint({ cursor: 2, logHash: "hash-2" })
    const crypto = new EpochTrackingCrypto()

    await new HistoryBackfillService(journal, remote, crypto).backfill(TEST_DEVICE)

    expect(crypto.inspectedEpochSequences).toEqual([1])
  })

  it("persists revocations and rejects later history from that author", async () => {
    const remote = new FakeRemote()
    await remote.commit({
      type: "device-revocation",
      operationId: "revoke-device",
      authorDeviceId: TEST_DEVICE.deviceId,
      subjectDeviceId: "revoked-device",
    })
    remote.addRemoteRevision(
      {
        operationId: "revoked-operation",
        revisionId: "revoked-revision",
        fileId: "revoked-file",
        action: "upsert",
        path: "revoked.md",
        previousPath: null,
        parents: [],
        authorDeviceId: "revoked-device",
        blobId: "revoked-blob",
        isText: true,
      },
      new TextEncoder().encode("invalid").buffer,
    )
    const journal = new MemoryJournal()
    await journal.setCheckpoint({ cursor: 2, logHash: "hash-2" })
    const service = new HistoryBackfillService(journal, remote, new FakeCrypto())

    await expect(service.backfill(TEST_DEVICE)).rejects.toThrow(/after its device was revoked/)
    expect(await journal.getHistoryCheckpoint()).toMatchObject({ cursor: 1 })
    expect(await journal.getDeviceRevocation("revoked-device")).toMatchObject({ cursor: 1 })
    await expect(service.backfill(TEST_DEVICE)).rejects.toThrow(/after its device was revoked/)
  })

  it("resumes after an interrupted metadata inspection", async () => {
    class InterruptingCrypto extends FakeCrypto {
      inspections = 0
      interrupted = true

      override async inspectRevision(...args: Parameters<FakeCrypto["inspectRevision"]>) {
        this.inspections += 1
        if (this.interrupted && this.inspections === 2) throw new Error("suspended")
        return super.inspectRevision(...args)
      }
    }
    const remote = new FakeRemote()
    addHistory(remote)
    const journal = new MemoryJournal()
    const crypto = new InterruptingCrypto()
    const service = new HistoryBackfillService(journal, remote, crypto)

    await expect(service.backfill(TEST_DEVICE)).rejects.toThrow("suspended")
    expect(await journal.getHistoryCheckpoint()).toEqual({
      cursor: 1,
      logHash: "hash-1",
      initialLogFormat: "legacy-http-v1",
      logFormat: "legacy-http-v1",
    })
    crypto.interrupted = false
    await expect(service.backfill(TEST_DEVICE)).resolves.toBeUndefined()
    expect(await journal.listRetainedRevisions()).toHaveLength(2)
  })

  it("resumes after history state commits before the caller continues", async () => {
    class CrashAfterHistoryCommitJournal extends IndexedDbJournal {
      private crashed = false

      override async commitHistoryOperation(
        ...args: Parameters<IndexedDbJournal["commitHistoryOperation"]>
      ): Promise<void> {
        await super.commitHistoryOperation(...args)
        if (this.crashed) return
        this.crashed = true
        throw new Error("Injected crash after history commit")
      }
    }

    const databaseName = `history-backfill-${crypto.randomUUID()}`
    const remote = new FakeRemote()
    addHistory(remote)
    const journal = new CrashAfterHistoryCommitJournal(databaseName)
    await journal.open()
    const service = new HistoryBackfillService(journal, remote, new FakeCrypto())

    await expect(service.backfill(TEST_DEVICE)).rejects.toThrow(
      "Injected crash after history commit",
    )
    expect(await journal.getHistoryCheckpoint()).toMatchObject({ cursor: 1, logHash: "hash-1" })
    expect(await journal.listRetainedRevisions()).toHaveLength(1)
    journal.close()

    const restartedJournal = new IndexedDbJournal(databaseName)
    await restartedJournal.open()
    const restarted = new HistoryBackfillService(restartedJournal, remote, new FakeCrypto())
    await expect(restarted.backfill(TEST_DEVICE)).resolves.toBeUndefined()
    expect(await restartedJournal.getHistoryCheckpoint()).toMatchObject({
      cursor: 2,
      logHash: "hash-2",
    })
    expect(await restartedJournal.listRetainedRevisions()).toHaveLength(2)
    restartedJournal.close()
    await deleteDatabase(databaseName)
  })

  it("refuses legacy trust and signed checkpoint forks", async () => {
    const remote = new FakeRemote()
    addHistory(remote)
    const journal = new MemoryJournal()
    const service = new HistoryBackfillService(journal, remote, new FakeCrypto())

    await expect(
      service.backfill({ ...TEST_DEVICE, trustedCheckpointAuthorized: false }),
    ).rejects.toThrow(/Re-pair/)
    await expect(
      service.backfill({
        ...TEST_DEVICE,
        trustedCheckpoint: { cursor: 1, logHash: "different-signed-hash" },
      }),
    ).rejects.toThrow(/signed device checkpoint/)
    expect(await journal.listRetainedRevisions()).toEqual([])
  })
})

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error("Unable to delete test journal"))
    request.onblocked = () => reject(new Error("Test journal deletion is blocked"))
  })
}
