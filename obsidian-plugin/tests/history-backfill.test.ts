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
