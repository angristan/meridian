import { describe, expect, it } from "vitest"
import { MemoryJournal } from "../src/storage/journal"
import { HistoryService } from "../src/sync/history-service"
import { RevisionLoader } from "../src/sync/revision-loader"
import { FakeCrypto, FakeRemote, FakeVault, TEST_DEVICE } from "./fakes"

function service(
  vault: FakeVault,
  journal: MemoryJournal,
  remote = new FakeRemote(),
): HistoryService {
  return new HistoryService(
    vault,
    journal,
    new RevisionLoader(remote, new FakeCrypto(), () => vault.maxFileBytes()),
  )
}

describe("HistoryService", () => {
  it("follows stable file identity across renames", async () => {
    const vault = new FakeVault({ "Archive/note.md": "current" })
    const journal = new MemoryJournal()
    await journal.replaceSnapshots([
      {
        path: "Archive/note.md",
        fileId: "file-id",
        fingerprint: "fingerprint",
        size: 7,
        mtime: 2,
        kind: "vault",
      },
    ])
    await journal.putRevision({
      revisionId: "old",
      fileId: "file-id",
      path: "Inbox/note.md",
      action: "upsert",
      previousPath: null,
      parents: [],
      deviceId: "device",
      createdAt: 1,
      cursor: 1,
      tombstone: false,
      isConflict: false,
      operation: null,
    })
    await journal.putRevision({
      revisionId: "renamed",
      fileId: "file-id",
      path: "Archive/note.md",
      action: "upsert",
      previousPath: "Inbox/note.md",
      parents: ["old"],
      deviceId: "device",
      createdAt: 2,
      cursor: 2,
      tombstone: false,
      isConflict: false,
      operation: null,
    })

    expect(
      (await service(vault, journal).history("Archive/note.md")).map((item) => item.revisionId),
    ).toEqual(["renamed", "old"])
    expect(
      (await service(vault, journal).history("Inbox/note.md")).map((item) => item.revisionId),
    ).toEqual(["renamed", "old"])
  })

  it("never restores over an untracked occupied path", async () => {
    const vault = new FakeVault({ "shared.md": "untracked content" })
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    const sourceBytes = new TextEncoder().encode("historical content").buffer
    remote.blobs.set("source-blob", sourceBytes)
    await journal.putRevision({
      revisionId: "source-revision",
      fileId: "source-file",
      path: "shared.md",
      action: "upsert",
      previousPath: null,
      parents: [],
      deviceId: TEST_DEVICE.deviceId,
      createdAt: 1,
      cursor: 1,
      tombstone: false,
      isConflict: false,
      operation: {
        cursor: 1,
        logHash: "hash-1",
        envelope: {
          operationId: "source-operation",
          revisionId: "source-revision",
          fileId: "source-file",
          action: "upsert",
          path: "shared.md",
          previousPath: null,
          parents: [],
          authorDeviceId: TEST_DEVICE.deviceId,
          blobId: "source-blob",
          isText: true,
        },
      },
    })

    await expect(
      service(vault, journal, remote).restore(TEST_DEVICE, "source-revision"),
    ).rejects.toThrow(/occupied by an untracked file/)
    expect(vault.text("shared.md")).toBe("untracked content")
    expect(await journal.listPending()).toEqual([])
  })
})
