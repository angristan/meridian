import { describe, expect, it } from "vitest"
import { MemoryJournal } from "../src/storage/journal"
import { HistoryBackfillService } from "../src/sync/history-backfill-service"
import { FakeCrypto, FakeRemote, TEST_DEVICE } from "./fakes"

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

    await expect(service.backfill(TEST_DEVICE)).resolves.toEqual({ added: 2, throughCursor: 2 })

    expect(await journal.listRevisions()).toEqual([])
    expect(await journal.getCheckpoint()).toEqual({ cursor: 7, logHash: "live-sync-hash" })
    expect((await journal.listHistoryRevisions()).map((revision) => revision.revisionId)).toEqual([
      "revision-two",
      "revision-one",
    ])
    expect(await journal.getHistoryCheckpoint()).toEqual({ cursor: 2, logHash: "hash-2" })
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
    expect(await journal.getHistoryCheckpoint()).toEqual({ cursor: 1, logHash: "hash-1" })
    crypto.interrupted = false
    await expect(service.backfill(TEST_DEVICE)).resolves.toEqual({ added: 1, throughCursor: 2 })
    expect(await journal.listHistoryRevisions()).toHaveLength(2)
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
    expect(await journal.listHistoryRevisions()).toEqual([])
  })
})
