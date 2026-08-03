import { describe, expect, it } from "vitest"
import { MemoryJournal } from "../src/storage/memory-journal"
import { HistoryService } from "../src/sync/history-service"
import { RevisionLoader } from "../src/sync/revision-loader"
import { FakeCrypto, FakeRemote, FakeVault, TEST_DEVICE } from "./fakes"
import { seedRevision, seedSnapshots } from "./journal-fixtures"

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
  it("keeps full revision history beyond the bounded sync log", async () => {
    const journal = new MemoryJournal()
    for (let cursor = 1; cursor <= 205; cursor += 1) {
      await seedRevision(journal, {
        revisionId: `revision-${cursor}`,
        fileId: "file-id",
        path: "note.md",
        action: "upsert",
        previousPath: null,
        parents: cursor === 1 ? [] : [`revision-${cursor - 1}`],
        deviceId: TEST_DEVICE.deviceId,
        createdAt: cursor,
        cursor,
        tombstone: false,
        isConflict: false,
        operation: null,
      })
    }
    const history = service(new FakeVault(), journal)

    await expect(history.history()).resolves.toHaveLength(205)
    await expect(history.activity(TEST_DEVICE.deviceId, 200)).resolves.toHaveLength(200)
  })

  it("follows stable file identity across renames", async () => {
    const vault = new FakeVault({ "Archive/note.md": "current" })
    const journal = new MemoryJournal()
    await seedSnapshots(journal, [
      {
        path: "Archive/note.md",
        fileId: "file-id",
        fingerprint: "fingerprint",
        size: 7,
        mtime: 2,
        kind: "vault",
      },
    ])
    await seedRevision(journal, {
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
    await seedRevision(journal, {
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

  it("previews text history and compares it with current content", async () => {
    const vault = new FakeVault({ "note.md": "one\ncurrent\nthree" })
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    const sourceBytes = new TextEncoder().encode("one\nold\nthree").buffer
    remote.blobs.set("source-blob", sourceBytes)
    await seedSnapshots(journal, [
      {
        path: "note.md",
        fileId: "file-id",
        fingerprint: "current",
        size: 17,
        mtime: 2,
        kind: "vault",
      },
    ])
    await seedRevision(journal, {
      revisionId: "source-revision",
      fileId: "file-id",
      path: "note.md",
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
          fileId: "file-id",
          action: "upsert",
          path: "note.md",
          previousPath: null,
          parents: [],
          authorDeviceId: TEST_DEVICE.deviceId,
          blobId: "source-blob",
          isText: true,
        },
      },
    })
    const history = service(vault, journal, remote)

    await expect(history.preview(TEST_DEVICE, "source-revision")).resolves.toMatchObject({
      kind: "text",
      byteLength: sourceBytes.byteLength,
      text: "one\nold\nthree",
      truncated: false,
    })
    await expect(history.compareToCurrent(TEST_DEVICE, "source-revision")).resolves.toMatchObject({
      path: "note.md",
      unavailableReason: null,
      lines: [
        { kind: "context", text: "one" },
        { kind: "removed", text: "old" },
        { kind: "added", text: "current" },
        { kind: "context", text: "three" },
      ],
    })
  })

  it("lists current deletions and recovers from the nearest content ancestor", async () => {
    const vault = new FakeVault()
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    const sourceBytes = new TextEncoder().encode("recover me").buffer
    remote.blobs.set("source-blob", sourceBytes)
    await seedRevision(journal, {
      revisionId: "source-revision",
      fileId: "deleted-file",
      path: "Archive/deleted.md",
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
          fileId: "deleted-file",
          action: "upsert",
          path: "Archive/deleted.md",
          previousPath: null,
          parents: [],
          authorDeviceId: TEST_DEVICE.deviceId,
          blobId: "source-blob",
          isText: true,
        },
      },
    })
    for (const [revisionId, createdAt] of [
      ["deletion-one", 2],
      ["deletion-two", 3],
    ] as const) {
      await seedRevision(journal, {
        revisionId,
        fileId: "deleted-file",
        path: "Archive/deleted.md",
        action: "delete",
        previousPath: null,
        parents: ["source-revision"],
        deviceId: TEST_DEVICE.deviceId,
        createdAt,
        cursor: createdAt,
        tombstone: true,
        isConflict: false,
        operation: null,
      })
    }
    const history = service(vault, journal, remote)

    await expect(history.deletedFiles()).resolves.toEqual([
      {
        fileId: "deleted-file",
        path: "Archive/deleted.md",
        deletedRevisionId: "deletion-two",
        deletedAt: 3,
        deviceId: TEST_DEVICE.deviceId,
        recoverableRevisionId: "source-revision",
      },
    ])
    await history.recoverDeleted(TEST_DEVICE, "deletion-two")

    expect(vault.text("Archive/deleted.md")).toBe("recover me")
    expect(await journal.listPending()).toMatchObject([
      {
        action: "restore",
        fileId: "deleted-file",
        parentRevisionIds: ["deletion-one", "deletion-two"],
        restoreSourceRevisionId: "source-revision",
      },
    ])
    await expect(history.deletedFiles()).resolves.toEqual([])
  })

  it("never restores over an untracked occupied path", async () => {
    const vault = new FakeVault({ "shared.md": "untracked content" })
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    const sourceBytes = new TextEncoder().encode("historical content").buffer
    remote.blobs.set("source-blob", sourceBytes)
    await seedRevision(journal, {
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
