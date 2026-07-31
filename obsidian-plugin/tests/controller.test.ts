import { describe, expect, it } from "vitest"
import type {
  DeviceKeyMaterial,
  EncryptedBlob,
  EncryptedRevision,
  JournalEntry,
  RevisionDraft,
  SyncStatus,
} from "../src/model"
import { fingerprint, randomId } from "../src/platform/bytes"
import { MemoryJournal } from "../src/storage/journal"
import { SyncController } from "../src/sync/controller"
import { ALL_CATEGORIES, FakeCrypto, FakeRemote, FakeVault, TEST_DEVICE } from "./fakes"

async function seedTrackedText(
  journal: MemoryJournal,
  remote: FakeRemote,
  identity: string,
  baseBytes: ArrayBuffer,
): Promise<void> {
  await journal.replaceSnapshots([
    {
      path: "note.md",
      fileId: identity,
      fingerprint: await fingerprint(baseBytes),
      size: baseBytes.byteLength,
      mtime: 1,
      kind: "vault",
    },
  ])
  remote.blobs.set("base-blob", baseBytes)
  await journal.putRevision({
    revisionId: "common-base",
    fileId: identity,
    path: "note.md",
    parents: [],
    deviceId: TEST_DEVICE.deviceId,
    createdAt: 1,
    cursor: 0,
    tombstone: false,
    isConflict: false,
    operation: {
      cursor: 0,
      logHash: "hash-base",
      envelope: {
        operationId: "base-operation",
        revisionId: "common-base",
        fileId: identity,
        action: "upsert",
        path: "note.md",
        previousPath: null,
        parents: [],
        authorDeviceId: TEST_DEVICE.deviceId,
        blobId: "base-blob",
        isText: true,
      },
    },
  })
}

describe("SyncController", () => {
  it("uploads local content as raw encrypted blobs before committing", async () => {
    const vault = new FakeVault({ "note.md": "hello" })
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    const statuses: string[] = []
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      (status) => statuses.push(status.phase),
    )

    await controller.start(TEST_DEVICE)

    expect(remote.authenticateCount).toBe(1)
    expect(remote.operations).toHaveLength(1)
    expect([...remote.blobs.values()].map((bytes) => new TextDecoder().decode(bytes))).toEqual([
      "hello",
    ])
    expect(await journal.listPending()).toEqual([])
    expect((await journal.listRevisions("note.md"))[0]).toMatchObject({
      path: "note.md",
      action: "upsert",
      previousPath: null,
      tombstone: false,
      cursor: 1,
    })
    expect(statuses.at(-1)).toBe("idle")
    controller.stop()
  })

  it("preserves pending tombstones while repairing the local index", async () => {
    const identity = randomId()
    const vault = new FakeVault()
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    await controller.start(TEST_DEVICE)
    await journal.putEntry({
      id: "pending-delete",
      action: "delete",
      fileId: identity,
      path: "deleted.md",
      previousPath: null,
      fingerprint: null,
      baseRevisionId: null,
      parentRevisionIds: [],
      restoreSourceRevisionId: null,
      revisionId: "delete-revision",
      createdAt: 1,
      attempts: 0,
      state: "queued",
      error: null,
      preparedRevision: null,
    })

    await controller.repairLocalIndex()

    expect(remote.operations).toHaveLength(1)
    expect(remote.operations[0]?.envelope).toMatchObject({
      action: "delete",
      fileId: identity,
      path: "deleted.md",
    })
    expect(await journal.listPending()).toEqual([])
    controller.stop()
  })

  it("captures local edits before applying notification-triggered pulls", async () => {
    const vault = new FakeVault({ "note.bin": "base" })
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    await controller.start(TEST_DEVICE)
    const base = (await journal.listRevisions("note.bin"))[0]
    if (!base) throw new Error("Expected the initial revision")

    vault.files.set("note.bin", new TextEncoder().encode("unsynced local edit").buffer)
    remote.addRemoteRevision(
      {
        operationId: "remote-operation",
        revisionId: "remote-revision",
        fileId: base.fileId,
        action: "upsert",
        path: "note.bin",
        previousPath: null,
        parents: [base.revisionId],
        authorDeviceId: "device-remote",
        blobId: "remote-blob",
        isText: false,
      },
      new TextEncoder().encode("remote edit").buffer,
    )

    await controller.sync("notification")

    expect(vault.text("note.bin")).toBe("unsynced local edit")
    expect(await journal.listConflicts(true)).toEqual([
      expect.objectContaining({ sourcePath: "note.bin", remoteRevisionId: "remote-revision" }),
    ])
    controller.stop()
  })

  it("merges an edit made while a remote revision is downloading", async () => {
    const encoder = new TextEncoder()
    const baseBytes = encoder.encode("one\ntwo\n").buffer
    const localBytes = encoder.encode("ONE\ntwo\n").buffer
    const remoteBytes = encoder.encode("one\nTWO\n").buffer
    const identity = randomId()
    const vault = new FakeVault({ "note.md": "one\ntwo\n" })
    const journal = new MemoryJournal()
    class EditingDownloadRemote extends FakeRemote {
      private edited = false

      override async getBlob(blobId: string): Promise<ArrayBuffer> {
        if (blobId === "remote-blob" && !this.edited) {
          this.edited = true
          vault.files.set("note.md", localBytes.slice(0))
        }
        return super.getBlob(blobId)
      }
    }
    const remote = new EditingDownloadRemote()
    await seedTrackedText(journal, remote, identity, baseBytes)
    remote.addRemoteRevision(
      {
        operationId: "remote-operation",
        revisionId: "revision-remote",
        fileId: identity,
        action: "upsert",
        path: "note.md",
        previousPath: null,
        parents: ["common-base"],
        authorDeviceId: "device-remote",
        blobId: "remote-blob",
        isText: true,
      },
      remoteBytes,
    )
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    await controller.start(TEST_DEVICE)

    expect(vault.text("note.md")).toBe("ONE\nTWO\n")
    expect(await journal.listConflicts(true)).toEqual([])
    expect(remote.operations.at(-1)?.envelope).toMatchObject({
      fileId: identity,
      parents: ["revision-remote"],
    })
    controller.stop()
  })

  it("preserves a newer edit when the file changes during merge", async () => {
    const encoder = new TextEncoder()
    const baseBytes = encoder.encode("one\ntwo\n").buffer
    const firstLocalBytes = encoder.encode("ONE\ntwo\n").buffer
    const latestLocalBytes = encoder.encode("LATEST\ntwo\n").buffer
    const remoteBytes = encoder.encode("one\nTWO\n").buffer
    const identity = randomId()
    class RacingVault extends FakeVault {
      raceNextReplacement = true

      override async replaceIfUnchanged(
        path: string,
        expectedBytes: ArrayBuffer | null,
        replacementBytes: ArrayBuffer | null,
        isText: boolean,
      ): Promise<boolean> {
        if (
          this.raceNextReplacement &&
          path === "note.md" &&
          expectedBytes !== null &&
          replacementBytes !== null
        ) {
          this.raceNextReplacement = false
          this.files.set(path, latestLocalBytes.slice(0))
        }
        return super.replaceIfUnchanged(path, expectedBytes, replacementBytes, isText)
      }
    }
    const vault = new RacingVault({ "note.md": "one\ntwo\n" })
    const journal = new MemoryJournal()
    class EditingDownloadRemote extends FakeRemote {
      private edited = false

      override async getBlob(blobId: string): Promise<ArrayBuffer> {
        if (blobId === "remote-blob" && !this.edited) {
          this.edited = true
          vault.files.set("note.md", firstLocalBytes.slice(0))
        }
        return super.getBlob(blobId)
      }
    }
    const remote = new EditingDownloadRemote()
    await seedTrackedText(journal, remote, identity, baseBytes)
    remote.addRemoteRevision(
      {
        operationId: "remote-operation",
        revisionId: "revision-remote",
        fileId: identity,
        action: "upsert",
        path: "note.md",
        previousPath: null,
        parents: ["common-base"],
        authorDeviceId: "device-remote",
        blobId: "remote-blob",
        isText: true,
      },
      remoteBytes,
    )
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    await controller.start(TEST_DEVICE)

    expect(vault.text("note.md")).toBe("LATEST\ntwo\n")
    const conflicts = await journal.listConflicts(true)
    expect(conflicts).toHaveLength(1)
    expect(vault.text(conflicts[0]?.conflictPath ?? "")).toBe("one\nTWO\n")
    controller.stop()
  })

  it("preserves a local edit that races with a remote delete", async () => {
    const encoder = new TextEncoder()
    const baseBytes = encoder.encode("base content").buffer
    const lateLocalBytes = encoder.encode("late local edit").buffer
    const identity = randomId()
    class RacingDeleteVault extends FakeVault {
      raceNextDelete = true

      override async replaceIfUnchanged(
        path: string,
        expectedBytes: ArrayBuffer | null,
        replacementBytes: ArrayBuffer | null,
        isText: boolean,
      ): Promise<boolean> {
        if (this.raceNextDelete && path === "note.md" && replacementBytes === null) {
          this.raceNextDelete = false
          this.files.set(path, lateLocalBytes.slice(0))
        }
        return super.replaceIfUnchanged(path, expectedBytes, replacementBytes, isText)
      }
    }
    const vault = new RacingDeleteVault({ "note.md": "base content" })
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    await seedTrackedText(journal, remote, identity, baseBytes)
    remote.addRemoteRevision(
      {
        operationId: "remote-delete-operation",
        revisionId: "remote-delete-revision",
        fileId: identity,
        action: "delete",
        path: "note.md",
        previousPath: null,
        parents: ["common-base"],
        authorDeviceId: "device-remote",
        blobId: null,
        isText: true,
      },
      null,
    )
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    await controller.start(TEST_DEVICE)

    expect(vault.text("note.md")).toBeNull()
    const conflicts = await journal.listConflicts(true)
    expect(conflicts).toHaveLength(1)
    expect(vault.text(conflicts[0]?.conflictPath ?? "")).toBe("late local edit")
    expect(await journal.listPending()).toEqual([])
    controller.stop()
  })

  it("pulls concurrent operations committed immediately before its own", async () => {
    class ConcurrentCommitRemote extends FakeRemote {
      private injected = false

      override async commit(envelope: unknown): Promise<{ cursor: number; logHash: string }> {
        if (!this.injected) {
          this.injected = true
          this.addRemoteRevision(
            {
              operationId: "concurrent-operation",
              revisionId: "concurrent-revision",
              fileId: randomId(),
              action: "upsert",
              path: "concurrent.md",
              previousPath: null,
              parents: [],
              authorDeviceId: "device-remote",
              blobId: "concurrent-blob",
              isText: true,
            },
            new TextEncoder().encode("concurrent content").buffer,
          )
        }
        return super.commit(envelope)
      }
    }

    const vault = new FakeVault({ "local.md": "local content" })
    const journal = new MemoryJournal()
    const remote = new ConcurrentCommitRemote()
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    await controller.start(TEST_DEVICE)

    expect(vault.text("concurrent.md")).toBe("concurrent content")
    expect(await journal.getCursor()).toBe(2)
    expect(remote.getChangesCount).toBeGreaterThanOrEqual(2)
    controller.stop()
  })

  it("pulls successful commits before surfacing a later push failure", async () => {
    class PartiallyFailingRemote extends FakeRemote {
      private commitAttempts = 0

      override async commit(envelope: unknown): Promise<{ cursor: number; logHash: string }> {
        this.commitAttempts += 1
        if (this.commitAttempts >= 2) throw new Error("second commit remains unavailable")
        return super.commit(envelope)
      }
    }

    const vault = new FakeVault({ "first.md": "first", "second.md": "second" })
    const journal = new MemoryJournal()
    const remote = new PartiallyFailingRemote()
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    await controller.start(TEST_DEVICE)

    expect(remote.operations).toHaveLength(1)
    expect(remote.getChangesCount).toBeGreaterThanOrEqual(2)
    expect(await journal.getCursor()).toBe(1)
    expect(controller.getStatus().error).toMatch(/second commit remains unavailable/)
    controller.stop()
  })

  it("replays the exact prepared revision after an ambiguous commit", async () => {
    class AmbiguousCommitRemote extends FakeRemote {
      readonly attempts: unknown[] = []
      readonly blobAttempts: EncryptedBlob[] = []
      private committedResult: { cursor: number; logHash: string } | null = null

      override async putBlob(blob: EncryptedBlob): Promise<void> {
        this.blobAttempts.push(structuredClone(blob))
        await super.putBlob(blob)
      }

      override async commit(envelope: unknown): Promise<{ cursor: number; logHash: string }> {
        this.attempts.push(structuredClone(envelope))
        if (!this.committedResult) {
          this.committedResult = await super.commit(envelope)
          throw new Error("Connection closed after commit")
        }
        return this.committedResult
      }
    }

    class CountingCrypto extends FakeCrypto {
      encryptions = 0

      override async encryptRevision(
        device: DeviceKeyMaterial,
        draft: RevisionDraft,
      ): Promise<EncryptedRevision> {
        this.encryptions += 1
        return super.encryptRevision(device, draft)
      }
    }

    const vault = new FakeVault({ "note.md": "durable content" })
    const journal = new MemoryJournal()
    const remote = new AmbiguousCommitRemote()
    const crypto = new CountingCrypto()
    const controller = new SyncController(
      vault,
      journal,
      remote,
      crypto,
      () => ALL_CATEGORIES,
      () => {},
    )

    await controller.start(TEST_DEVICE)
    expect(await journal.listPending()).toHaveLength(1)

    await controller.sync("manual")

    expect(crypto.encryptions).toBe(1)
    expect(remote.attempts).toHaveLength(2)
    expect(remote.attempts[1]).toEqual(remote.attempts[0])
    expect(remote.blobAttempts).toHaveLength(2)
    expect(remote.blobAttempts[1]).toEqual(remote.blobAttempts[0])
    expect(await journal.listPending()).toEqual([])
    expect(await journal.getCursor()).toBe(1)
    controller.stop()
  })

  it("reports live pull cursor chunk and target progress", async () => {
    const vault = new FakeVault()
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    for (const [index, content] of ["first", "second"].entries()) {
      remote.addRemoteRevision(
        {
          operationId: `remote-operation-${index}`,
          revisionId: `remote-revision-${index}`,
          fileId: randomId(),
          action: "upsert",
          path: `remote-${index}.md`,
          previousPath: null,
          parents: [],
          authorDeviceId: "device-remote",
          blobId: `remote-blob-${index}`,
          isText: true,
        },
        new TextEncoder().encode(content).buffer,
      )
    }
    const statuses: SyncStatus[] = []
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      (status) => statuses.push(structuredClone(status)),
      () => ({ deviceName: "Test", platform: "Test" }),
      { progressThrottleMs: 0 },
    )

    await controller.start(TEST_DEVICE)

    const pull = statuses.flatMap((status) =>
      status.progress?.kind === "pull" ? [status.progress] : [],
    )
    expect(pull.map((progress) => progress.currentCursor)).toEqual([0, 0, 1, 1, 2])
    expect(pull.every((progress) => progress.targetCursor === 2)).toBe(true)
    expect(pull.filter((progress) => progress.currentChunk !== null)).toEqual([
      expect.objectContaining({
        currentCursor: 0,
        currentChunk: 1,
        totalChunks: 1,
        transferredBytes: 5,
        totalBytes: 5,
      }),
      expect.objectContaining({
        currentCursor: 1,
        currentChunk: 1,
        totalChunks: 1,
        transferredBytes: 6,
        totalBytes: 6,
      }),
    ])
    expect(controller.getStatus()).toMatchObject({
      phase: "idle",
      cursor: 2,
      progress: null,
    })
    controller.stop()
  })

  it("reports upload files chunks queue and committed cursor", async () => {
    const vault = new FakeVault({ "note.md": "hello" })
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    const statuses: SyncStatus[] = []
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      (status) => statuses.push(structuredClone(status)),
      () => ({ deviceName: "Test", platform: "Test" }),
      { progressThrottleMs: 0 },
    )

    await controller.start(TEST_DEVICE)

    const pushing = statuses.filter((status) => status.progress?.kind === "push")
    expect(pushing).toContainEqual(
      expect.objectContaining({
        phase: "pushing",
        queued: 1,
        progress: expect.objectContaining({
          currentPath: "note.md",
          stage: "uploading",
          currentChunk: 1,
          totalChunks: 1,
          transferredBytes: 5,
          totalBytes: 5,
        }),
      }),
    )
    expect(pushing).toContainEqual(
      expect.objectContaining({
        cursor: 1,
        queued: 0,
        progress: expect.objectContaining({
          processed: 1,
          succeeded: 1,
          failed: 0,
          total: 1,
          currentCursor: 1,
        }),
      }),
    )
    controller.stop()
  })

  it("pauses a pull before applying the next remote operation", async () => {
    const vault = new FakeVault()
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    remote.addRemoteRevision(
      {
        operationId: "remote-operation",
        revisionId: "remote-revision",
        fileId: randomId(),
        action: "upsert",
        path: "remote.md",
        previousPath: null,
        parents: [],
        authorDeviceId: "device-remote",
        blobId: "remote-blob",
        isText: true,
      },
      new TextEncoder().encode("remote content").buffer,
    )
    const barrier = remote.blockNextChangesAfterRead()
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    const starting = controller.start(TEST_DEVICE)
    await barrier.started
    const pausing = controller.quiesce()
    expect(controller.getStatus()).toMatchObject({
      phase: "pausing",
      message: "Pausing after the current safe boundary",
    })
    barrier.release()
    await Promise.all([starting, pausing])

    expect(vault.text("remote.md")).toBeNull()
    await expect(journal.getCursor()).resolves.toBe(0)
  })

  it("finishes an in-flight upload transaction before pausing the queue", async () => {
    const vault = new FakeVault({ "a.md": "first", "b.md": "second" })
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    const barrier = remote.blockNextBlobUploadAfterWrite()
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    const starting = controller.start(TEST_DEVICE)
    await barrier.started
    const pausing = controller.quiesce()
    barrier.release()
    await Promise.all([starting, pausing])

    expect(remote.operations).toHaveLength(1)
    expect(await journal.listPending()).toEqual([expect.objectContaining({ state: "queued" })])
  })

  it("skips network work for a file event caused by an applied remote revision", async () => {
    const vault = new FakeVault()
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )
    await controller.start(TEST_DEVICE)

    remote.addRemoteRevision(
      {
        operationId: "remote-operation",
        revisionId: "remote-revision",
        fileId: randomId(),
        action: "upsert",
        path: "remote.md",
        previousPath: null,
        parents: [],
        authorDeviceId: "device-remote",
        blobId: "remote-blob",
        isText: true,
      },
      new TextEncoder().encode("remote content").buffer,
    )
    await controller.sync("notification")
    expect(vault.text("remote.md")).toBe("remote content")
    expect(remote.getChangesCount).toBe(2)

    await controller.sync("file-event")

    expect(remote.getChangesCount).toBe(2)
    expect(remote.operations).toHaveLength(1)
    expect(controller.getStatus()).toMatchObject({ phase: "idle", message: "Up to date" })
    controller.stop()
  })

  it("preserves a notification received after an active pull read its page", async () => {
    const vault = new FakeVault()
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )
    await controller.start(TEST_DEVICE)

    const barrier = remote.blockNextChangesAfterRead()
    const activeSync = controller.sync("manual")
    await barrier.started
    remote.addRemoteRevision(
      {
        operationId: "late-remote-operation",
        revisionId: "late-remote-revision",
        fileId: randomId(),
        action: "upsert",
        path: "late-remote.md",
        previousPath: null,
        parents: [],
        authorDeviceId: "device-remote",
        blobId: "late-remote-blob",
        isText: true,
      },
      new TextEncoder().encode("arrived after pull").buffer,
    )
    void controller.sync("notification")
    barrier.release()
    await activeSync

    expect(vault.text("late-remote.md")).toBe("arrived after pull")
    expect(remote.getChangesCount).toBe(3)
    controller.stop()
  })

  it("rejects a server older than the signed pairing checkpoint", async () => {
    const vault = new FakeVault()
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    remote.addRemoteRevision(
      {
        operationId: "remote-operation",
        revisionId: "remote-revision",
        fileId: randomId(),
        action: "upsert",
        path: "remote.md",
        previousPath: null,
        parents: [],
        authorDeviceId: "device-remote",
        blobId: "remote-blob",
        isText: true,
      },
      new TextEncoder().encode("untrusted rollback").buffer,
    )
    const statuses: Array<{ phase: string; error: string | null }> = []
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      (status) => statuses.push(status),
    )

    await controller.start({
      ...TEST_DEVICE,
      trustedCheckpoint: { cursor: 2, logHash: "trusted-hash-2" },
    })

    expect(vault.text("remote.md")).toBeNull()
    expect(statuses.at(-1)).toMatchObject({
      phase: "error",
      error: "Server attempted to roll back the signed checkpoint",
    })
    controller.stop()
  })

  it("applies case-only remote renames on case-insensitive vaults", async () => {
    class CaseInsensitiveVault extends FakeVault {
      override async write(path: string, bytes: ArrayBuffer): Promise<void> {
        const collision = [...this.files.keys()].find(
          (existing) => existing !== path && existing.toLowerCase() === path.toLowerCase(),
        )
        if (collision) throw new Error(`Case-insensitive path collision: ${collision}`)
        await super.write(path, bytes)
      }
    }

    const identity = randomId()
    const baseBytes = new TextEncoder().encode("base content").buffer
    const vault = new CaseInsensitiveVault({ "Note.md": "base content" })
    const journal = new MemoryJournal()
    await journal.replaceSnapshots([
      {
        path: "Note.md",
        fileId: identity,
        fingerprint: await fingerprint(baseBytes),
        size: baseBytes.byteLength,
        mtime: 1,
        kind: "vault",
      },
    ])
    await journal.putRevision({
      revisionId: "base-revision",
      fileId: identity,
      path: "Note.md",
      parents: [],
      deviceId: TEST_DEVICE.deviceId,
      createdAt: 1,
      cursor: 0,
      tombstone: false,
      isConflict: false,
      operation: null,
    })
    const remote = new FakeRemote()
    remote.addRemoteRevision(
      {
        operationId: "rename-operation",
        revisionId: "rename-revision",
        fileId: identity,
        action: "upsert",
        path: "note.md",
        previousPath: null,
        parents: ["base-revision"],
        authorDeviceId: "device-remote",
        blobId: "rename-blob",
        isText: true,
      },
      new TextEncoder().encode("renamed content").buffer,
    )
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    await controller.start(TEST_DEVICE)

    expect(vault.text("Note.md")).toBeNull()
    expect(vault.text("note.md")).toBe("renamed content")
    expect(await journal.getCursor()).toBe(1)
    controller.stop()
  })

  it("rejects remote revisions with unknown parents before applying them", async () => {
    const vault = new FakeVault()
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    remote.addRemoteRevision(
      {
        operationId: "remote-operation",
        revisionId: "remote-revision",
        fileId: randomId(),
        action: "upsert",
        path: "remote.md",
        previousPath: null,
        parents: ["missing-parent"],
        authorDeviceId: "device-remote",
        blobId: "remote-blob",
        isText: true,
      },
      new TextEncoder().encode("remote content").buffer,
    )
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    await controller.start(TEST_DEVICE)

    expect(vault.text("remote.md")).toBeNull()
    expect(await journal.getCursor()).toBe(0)
    expect(controller.getStatus().error).toMatch(/parent missing-parent is unknown/)
    controller.stop()
  })

  it("rejects self-parented remote revisions", async () => {
    const vault = new FakeVault()
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    remote.addRemoteRevision(
      {
        operationId: "remote-operation",
        revisionId: "self-parented",
        fileId: randomId(),
        action: "upsert",
        path: "remote.md",
        previousPath: null,
        parents: ["self-parented"],
        authorDeviceId: "device-remote",
        blobId: "remote-blob",
        isText: true,
      },
      new TextEncoder().encode("remote content").buffer,
    )
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    await controller.start(TEST_DEVICE)

    expect(vault.text("remote.md")).toBeNull()
    expect(await journal.getCursor()).toBe(0)
    expect(controller.getStatus().error).toMatch(/cannot reference itself/)
    controller.stop()
  })

  it("rejects revision ID reuse with different content", async () => {
    const identity = randomId()
    const vault = new FakeVault()
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    remote.addRemoteRevision(
      {
        operationId: "operation-first",
        revisionId: "reused-revision",
        fileId: identity,
        action: "upsert",
        path: "first.md",
        previousPath: null,
        parents: [],
        authorDeviceId: "device-remote",
        blobId: "blob-first",
        isText: true,
      },
      new TextEncoder().encode("first content").buffer,
    )
    remote.addRemoteRevision(
      {
        operationId: "operation-second",
        revisionId: "reused-revision",
        fileId: identity,
        action: "upsert",
        path: "second.md",
        previousPath: null,
        parents: [],
        authorDeviceId: "device-remote",
        blobId: "blob-second",
        isText: true,
      },
      new TextEncoder().encode("second content").buffer,
    )
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    await controller.start(TEST_DEVICE)

    expect(vault.text("first.md")).toBe("first content")
    expect(vault.text("second.md")).toBeNull()
    expect(await journal.getCursor()).toBe(1)
    expect(controller.getStatus().error).toMatch(/reused with different content/)
    controller.stop()
  })

  it("rejects descendants of cyclic stored ancestry", async () => {
    const identity = randomId()
    const vault = new FakeVault()
    const journal = new MemoryJournal()
    for (const [revisionId, parent] of [
      ["cycle-a", "cycle-b"],
      ["cycle-b", "cycle-a"],
    ] as const) {
      await journal.putRevision({
        revisionId,
        fileId: identity,
        path: "cycle.md",
        parents: [parent],
        deviceId: "device-remote",
        createdAt: 1,
        cursor: null,
        tombstone: false,
        isConflict: false,
        operation: null,
      })
    }
    const remote = new FakeRemote()
    remote.addRemoteRevision(
      {
        operationId: "child-operation",
        revisionId: "child-revision",
        fileId: identity,
        action: "upsert",
        path: "child.md",
        previousPath: null,
        parents: ["cycle-a"],
        authorDeviceId: "device-remote",
        blobId: "child-blob",
        isText: true,
      },
      new TextEncoder().encode("child content").buffer,
    )
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    await controller.start(TEST_DEVICE)

    expect(vault.text("child.md")).toBeNull()
    expect(await journal.getCursor()).toBe(0)
    expect(controller.getStatus().error).toMatch(/stored revision ancestry contains a cycle/i)
    controller.stop()
  })

  it("merges disjoint concurrent text edits and queues the merged revision", async () => {
    const encoder = new TextEncoder()
    const baseBytes = encoder.encode("one\ntwo\n").buffer
    const remoteBytes = encoder.encode("one\nTWO\n").buffer
    const identity = randomId()
    const vault = new FakeVault({ "note.md": "ONE\ntwo\n" })
    const journal = new MemoryJournal()
    await journal.replaceSnapshots([
      {
        path: "note.md",
        fileId: identity,
        fingerprint: await fingerprint(baseBytes),
        size: baseBytes.byteLength,
        mtime: 1,
        kind: "vault",
      },
    ])
    const remote = new FakeRemote()
    remote.blobs.set("base-blob", baseBytes)
    await journal.putRevision({
      revisionId: "common-base",
      fileId: identity,
      path: "note.md",
      parents: [],
      deviceId: TEST_DEVICE.deviceId,
      createdAt: 1,
      cursor: 0,
      tombstone: false,
      isConflict: false,
      operation: {
        cursor: 0,
        logHash: "hash-base",
        envelope: {
          operationId: "base-operation",
          revisionId: "common-base",
          fileId: identity,
          action: "upsert",
          path: "note.md",
          previousPath: null,
          parents: [],
          authorDeviceId: TEST_DEVICE.deviceId,
          blobId: "base-blob",
          isText: true,
        },
      },
    })
    remote.addRemoteRevision(
      {
        operationId: "remote-operation",
        revisionId: "revision-remote",
        fileId: identity,
        action: "upsert",
        path: "note.md",
        previousPath: null,
        parents: ["common-base"],
        authorDeviceId: "device-remote",
        blobId: "remote-blob",
        isText: true,
      },
      remoteBytes,
    )
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    await controller.start(TEST_DEVICE)

    expect(vault.text("note.md")).toBe("ONE\nTWO\n")
    expect(await journal.listConflicts(true)).toEqual([])
    expect(await journal.listPending()).toEqual([])
    expect(remote.operations.at(-1)?.envelope).toMatchObject({
      fileId: identity,
      parents: ["revision-remote"],
    })
    controller.stop()
  })

  it("rejects remote content that reuses another file identity path", async () => {
    const occupiedIdentity = randomId()
    const incomingIdentity = randomId()
    const occupiedBytes = new TextEncoder().encode("occupied content").buffer
    const vault = new FakeVault({ "shared.md": "occupied content" })
    const journal = new MemoryJournal()
    await journal.replaceSnapshots([
      {
        path: "shared.md",
        fileId: occupiedIdentity,
        fingerprint: await fingerprint(occupiedBytes),
        size: occupiedBytes.byteLength,
        mtime: 1,
        kind: "vault",
      },
    ])
    await journal.putRevision({
      revisionId: "incoming-base",
      fileId: incomingIdentity,
      path: "old-name.md",
      parents: [],
      deviceId: "device-remote",
      createdAt: 1,
      cursor: 0,
      tombstone: false,
      isConflict: false,
      operation: null,
    })
    const remote = new FakeRemote()
    remote.addRemoteRevision(
      {
        operationId: "path-reuse-operation",
        revisionId: "path-reuse-revision",
        fileId: incomingIdentity,
        action: "upsert",
        path: "shared.md",
        previousPath: null,
        parents: ["incoming-base"],
        authorDeviceId: "device-remote",
        blobId: "path-reuse-blob",
        isText: true,
      },
      new TextEncoder().encode("incoming content").buffer,
    )
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    await controller.start(TEST_DEVICE)

    expect(vault.text("shared.md")).toBe("occupied content")
    expect(await journal.getCursor()).toBe(0)
    expect(controller.getStatus().error).toMatch(/belongs to another tracked file/)
    controller.stop()
  })

  it("restores retained history as a new revision", async () => {
    const encoder = new TextEncoder()
    const oldBytes = encoder.encode("old content").buffer
    const currentBytes = encoder.encode("current content").buffer
    const identity = randomId()
    const vault = new FakeVault({ "note.md": "current content" })
    const journal = new MemoryJournal()
    await journal.replaceSnapshots([
      {
        path: "note.md",
        fileId: identity,
        fingerprint: await fingerprint(currentBytes),
        size: currentBytes.byteLength,
        mtime: 2,
        kind: "vault",
      },
    ])
    const remote = new FakeRemote()
    remote.blobs.set("old-blob", oldBytes)
    await journal.putRevision({
      revisionId: "revision-old",
      fileId: identity,
      path: "note.md",
      parents: [],
      deviceId: TEST_DEVICE.deviceId,
      createdAt: 1,
      cursor: 1,
      tombstone: false,
      isConflict: false,
      operation: {
        cursor: 1,
        logHash: "hash-old",
        envelope: {
          operationId: "operation-old",
          revisionId: "revision-old",
          fileId: identity,
          action: "upsert",
          path: "note.md",
          previousPath: null,
          parents: [],
          authorDeviceId: TEST_DEVICE.deviceId,
          blobId: "old-blob",
          isText: true,
        },
      },
    })
    await journal.putRevision({
      revisionId: "revision-current",
      fileId: identity,
      path: "note.md",
      parents: ["revision-old"],
      deviceId: TEST_DEVICE.deviceId,
      createdAt: 2,
      cursor: 2,
      tombstone: false,
      isConflict: false,
      operation: null,
    })
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )
    await controller.start(TEST_DEVICE)

    await controller.restoreRevision("revision-old")
    expect(vault.text("note.md")).toBe("old content")
    expect(await journal.listPending()).toEqual([
      expect.objectContaining({
        action: "restore",
        fileId: identity,
        parentRevisionIds: ["revision-current"],
        restoreSourceRevisionId: "revision-old",
      }),
    ])

    await controller.sync("manual")
    expect(await journal.listPending()).toEqual([])
    expect(remote.operations.at(-1)?.envelope).toMatchObject({
      action: "restore",
      fileId: identity,
      parents: ["revision-current"],
    })
    controller.stop()
  })

  it("rejects history restores onto another file identity", async () => {
    const sourceIdentity = randomId()
    const occupiedIdentity = randomId()
    const sourceBytes = new TextEncoder().encode("historical content").buffer
    const occupiedBytes = new TextEncoder().encode("occupied content").buffer
    const vault = new FakeVault({ "shared.md": "occupied content" })
    const journal = new MemoryJournal()
    await journal.replaceSnapshots([
      {
        path: "shared.md",
        fileId: occupiedIdentity,
        fingerprint: await fingerprint(occupiedBytes),
        size: occupiedBytes.byteLength,
        mtime: 1,
        kind: "vault",
      },
    ])
    const remote = new FakeRemote()
    remote.blobs.set("source-blob", sourceBytes)
    await journal.putRevision({
      revisionId: "source-revision",
      fileId: sourceIdentity,
      path: "shared.md",
      parents: [],
      deviceId: TEST_DEVICE.deviceId,
      createdAt: 1,
      cursor: 0,
      tombstone: false,
      isConflict: false,
      operation: {
        cursor: 0,
        logHash: "hash-source",
        envelope: {
          operationId: "source-operation",
          revisionId: "source-revision",
          fileId: sourceIdentity,
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
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )
    await controller.start(TEST_DEVICE)

    await expect(controller.restoreRevision("source-revision")).rejects.toThrow(
      /belongs to another tracked file/,
    )
    expect(vault.text("shared.md")).toBe("occupied content")
    expect(await journal.listPending()).toEqual([])
    controller.stop()
  })

  it("preserves concurrent remote content as an explicit conflict copy", async () => {
    const localBytes = new TextEncoder().encode("local edit").buffer
    const remoteBytes = new TextEncoder().encode("remote edit").buffer
    const identity = randomId()
    const vault = new FakeVault({ "note.md": "local edit" })
    const journal = new MemoryJournal()
    await journal.replaceSnapshots([
      {
        path: "note.md",
        fileId: identity,
        fingerprint: await fingerprint(new TextEncoder().encode("common base").buffer),
        size: 11,
        mtime: 1,
        kind: "vault",
      },
    ])
    await journal.putRevision({
      revisionId: "common-base",
      fileId: identity,
      path: "note.md",
      parents: [],
      deviceId: TEST_DEVICE.deviceId,
      createdAt: 1,
      cursor: 0,
      tombstone: false,
      isConflict: false,
      operation: null,
    })
    const remote = new FakeRemote()
    remote.addRemoteRevision(
      {
        operationId: "remote-operation",
        revisionId: "revision-remote",
        fileId: identity,
        action: "upsert",
        path: "note.md",
        previousPath: null,
        parents: ["common-base"],
        authorDeviceId: "device-remote",
        blobId: "remote-blob",
        isText: true,
      },
      remoteBytes,
    )
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    await controller.start(TEST_DEVICE)

    expect(vault.text("note.md")).toBe(new TextDecoder().decode(localBytes))
    const conflicts = await journal.listConflicts(true)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.sourcePath).toBe("note.md")
    expect(conflicts[0]?.conflictPath).toContain(".conflict-")
    expect(vault.text(conflicts[0]?.conflictPath ?? "")).toBe("remote edit")
    expect((await journal.listRevisions("note.md")).some((revision) => revision.isConflict)).toBe(
      true,
    )
    controller.stop()
  })

  it("clears prepared plaintext when a remote delete completes a conflict", async () => {
    class InspectingJournal extends MemoryJournal {
      lastEntry: JournalEntry | null = null

      override async putEntry(entry: JournalEntry): Promise<void> {
        this.lastEntry = structuredClone(entry)
        await super.putEntry(entry)
      }
    }

    const identity = randomId()
    const localBytes = new TextEncoder().encode("local edit").buffer
    const vault = new FakeVault({ "note.md": "local edit" })
    const journal = new InspectingJournal()
    await journal.replaceSnapshots([
      {
        path: "note.md",
        fileId: identity,
        fingerprint: await fingerprint(localBytes),
        size: localBytes.byteLength,
        mtime: 1,
        kind: "vault",
      },
    ])
    await journal.putRevision({
      revisionId: "base-revision",
      fileId: identity,
      path: "note.md",
      parents: [],
      deviceId: TEST_DEVICE.deviceId,
      createdAt: 1,
      cursor: 0,
      tombstone: false,
      isConflict: false,
      operation: null,
    })
    await journal.putEntry({
      id: "pending-local-edit",
      action: "upsert",
      fileId: identity,
      path: "note.md",
      previousPath: null,
      fingerprint: await fingerprint(localBytes),
      baseRevisionId: "base-revision",
      parentRevisionIds: ["base-revision"],
      restoreSourceRevisionId: null,
      revisionId: "local-revision",
      createdAt: 2,
      attempts: 0,
      state: "uploading",
      error: null,
      preparedRevision: {
        action: "upsert",
        bytes: localBytes,
        encrypted: { blobs: [], envelope: { operationId: "prepared-operation" } },
      },
    })
    const remote = new FakeRemote()
    remote.addRemoteRevision(
      {
        operationId: "delete-operation",
        revisionId: "delete-revision",
        fileId: identity,
        action: "delete",
        path: "note.md",
        previousPath: null,
        parents: ["base-revision"],
        authorDeviceId: "device-remote",
        blobId: null,
        isText: true,
      },
      null,
    )
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    await controller.start(TEST_DEVICE)

    expect(journal.lastEntry).toMatchObject({
      id: "pending-local-edit",
      state: "complete",
      error: null,
      preparedRevision: null,
    })
    expect(await journal.listPending()).toEqual([])
    controller.stop()
  })

  it("persists revocations and rejects later operations from revoked devices", async () => {
    const vault = new FakeVault()
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )
    await controller.start(TEST_DEVICE)

    await controller.revokeDevice({
      deviceId: "old-device",
      signingPublicKey: "signing-key",
      hpkePublicKey: "hpke-key",
      certificate: "certificate",
      role: "member",
      authorizedAt: 1,
      revokedAt: null,
      deviceName: "Old phone",
      platform: "iOS",
    })
    await expect(journal.getDeviceRevocation("old-device")).resolves.toEqual({
      deviceId: "old-device",
      operationId: "revocation-operation",
      cursor: 1,
    })

    await remote.commit({
      operationId: "late-operation",
      revisionId: "late-revision",
      action: "delete",
      path: "late.md",
      previousPath: null,
      parents: [],
      authorDeviceId: "old-device",
      blobId: null,
      isText: true,
    })
    await controller.sync("manual")

    expect(controller.getStatus().error).toMatch(/authored after its device was revoked/)
    await expect(journal.getCursor()).resolves.toBe(1)
    controller.stop()
  })
})
