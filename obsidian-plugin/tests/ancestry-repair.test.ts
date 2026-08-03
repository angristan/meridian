import "fake-indexeddb/auto"
import { afterEach, describe, expect, it } from "vitest"
import type { FakeEnvelope } from "./fakes"
import { fingerprint } from "../src/platform/bytes"
import { HISTORY_INDEX_VERSION } from "../src/storage/contracts"
import { IndexedDbJournal } from "../src/storage/indexed-db-journal"
import { MemoryJournal } from "../src/storage/memory-journal"
import { SyncController } from "../src/sync/controller"
import { PushEngine } from "../src/sync/push-engine"
import { queuedEntry } from "../src/sync/queued-entry"
import { ALL_CATEGORIES, FakeCrypto, FakeRemote, FakeVault, TEST_DEVICE } from "./fakes"
import { seedSnapshots } from "./journal-fixtures"

const databaseNames: string[] = []
const encoder = new TextEncoder()

function databaseName(): string {
  const name = `meridian-ancestry-repair-${crypto.randomUUID()}`
  databaseNames.push(name)
  return name
}

function envelope(
  revisionId: string,
  parents: string[],
  blobId: string,
  path = "note.md",
): FakeEnvelope {
  return {
    operationId: `operation-${revisionId}`,
    revisionId,
    fileId: path,
    action: "upsert",
    path,
    previousPath: null,
    parents,
    authorDeviceId: TEST_DEVICE.deviceId,
    blobId,
    isText: true,
  }
}

async function seedCheckpointWithoutRevision(
  journal: IndexedDbJournal,
  vault: FakeVault,
): Promise<void> {
  const bytes = vault.files.get("note.md") as ArrayBuffer
  await journal.open()
  await seedSnapshots(journal, [
    {
      path: "note.md",
      fileId: "note.md",
      fingerprint: await fingerprint(bytes),
      size: bytes.byteLength,
      mtime: 1,
      kind: "vault",
    },
  ])
  await journal.setCheckpoint({ cursor: 1, logHash: "hash-1" })
}

function controller(journal: IndexedDbJournal, vault: FakeVault, remote: FakeRemote) {
  return new SyncController(
    {
      vault,
      journal,
      remote,
      crypto: new FakeCrypto(),
      categories: () => ALL_CATEGORIES,
      onStatus: () => {},
    },
    { progressThrottleMs: 0 },
  )
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

describe("revision ancestry repair", () => {
  it("replays verified metadata and resumes without uploading or resetting files", async () => {
    const vault = new FakeVault({ "note.md": "base" })
    const journal = new IndexedDbJournal(databaseName())
    await seedCheckpointWithoutRevision(journal, vault)
    const remote = new FakeRemote()
    remote.addRemoteRevision(envelope("parent", [], "parent-blob"), encoder.encode("base").buffer)
    remote.addRemoteRevision(
      envelope("child", ["parent"], "child-blob"),
      encoder.encode("updated").buffer,
    )

    const sync = controller(journal, vault, remote)
    await sync.start(TEST_DEVICE)

    expect(sync.getStatus()).toMatchObject({ phase: "idle", cursor: 2, error: null })
    expect(vault.text("note.md")).toBe("updated")
    expect(remote.operations).toHaveLength(2)
    expect(await journal.getRevision("parent")).toBeNull()
    expect(await journal.getRetainedRevision("parent")).toMatchObject({ cursor: 1 })
    expect(await journal.getRevision("child")).toMatchObject({ cursor: 2 })
    expect(await journal.getHistoryCheckpoint()).toMatchObject({ cursor: 1 })
    await sync.quiesce()
  })

  it("rejects forward references already present in retained history", async () => {
    const vault = new FakeVault()
    const journal = new IndexedDbJournal(databaseName())
    await journal.open()
    await journal.prepareHistoryBackfill(HISTORY_INDEX_VERSION)
    await journal.completeHistoryBackfill(HISTORY_INDEX_VERSION)
    await journal.setCheckpoint({ cursor: 2, logHash: "hash-2" })
    const remote = new FakeRemote()
    remote.addRemoteRevision(
      envelope("child", ["future-parent"], "child-blob"),
      encoder.encode("child").buffer,
    )
    remote.addRemoteRevision(
      envelope("future-parent", [], "parent-blob"),
      encoder.encode("parent").buffer,
    )
    remote.addRemoteRevision(
      envelope("incoming", ["child"], "incoming-blob"),
      encoder.encode("incoming").buffer,
    )
    await journal.commitHistoryOperation(
      {
        revisionId: "child",
        fileId: "note.md",
        path: "note.md",
        action: "upsert",
        previousPath: null,
        parents: ["future-parent"],
        deviceId: TEST_DEVICE.deviceId,
        createdAt: 1,
        cursor: 1,
        tombstone: false,
        isConflict: false,
        operation: remote.operations[0] ?? null,
      },
      { cursor: 1, logHash: "hash-1" },
    )
    await journal.commitHistoryOperation(
      {
        revisionId: "future-parent",
        fileId: "note.md",
        path: "note.md",
        action: "upsert",
        previousPath: null,
        parents: [],
        deviceId: TEST_DEVICE.deviceId,
        createdAt: 2,
        cursor: 2,
        tombstone: false,
        isConflict: false,
        operation: remote.operations[1] ?? null,
      },
      { cursor: 2, logHash: "hash-2" },
    )

    const sync = controller(journal, vault, remote)
    await sync.start(TEST_DEVICE)

    expect(sync.getStatus()).toMatchObject({ phase: "error", cursor: 2 })
    expect(sync.getStatus().error).toMatch(/parent is not an older committed revision/i)
    expect(vault.text("note.md")).toBeNull()
    expect(await journal.getCheckpoint()).toMatchObject({ cursor: 2 })
    await sync.quiesce()
  })

  it("rejects revision ID reuse when the original exists only in repaired history", async () => {
    const vault = new FakeVault({ "note.md": "base" })
    const journal = new IndexedDbJournal(databaseName())
    await seedCheckpointWithoutRevision(journal, vault)
    const remote = new FakeRemote()
    remote.addRemoteRevision(envelope("reused", [], "original-blob"), encoder.encode("base").buffer)
    remote.addRemoteRevision(
      envelope("reused", [], "reused-blob", "attacker.md"),
      encoder.encode("changed").buffer,
    )
    await journal.commitHistoryOperation(
      {
        revisionId: "reused",
        fileId: "note.md",
        path: "note.md",
        action: "upsert",
        previousPath: null,
        parents: [],
        deviceId: TEST_DEVICE.deviceId,
        createdAt: 1,
        cursor: 1,
        tombstone: false,
        isConflict: false,
        operation: remote.operations[0] ?? null,
      },
      { cursor: 1, logHash: "hash-1" },
    )

    const sync = controller(journal, vault, remote)
    await sync.start(TEST_DEVICE)

    expect(sync.getStatus()).toMatchObject({ phase: "error", cursor: 1 })
    expect(sync.getStatus().error).toMatch(/reused a revision ID/i)
    expect(vault.text("note.md")).toBe("base")
    expect(vault.text("attacker.md")).toBeNull()
    expect(await journal.getCheckpoint()).toMatchObject({ cursor: 1 })
    await sync.quiesce()
  })

  it("resumes after a crash immediately after the repaired metadata commits", async () => {
    class CrashAfterRepairJournal extends IndexedDbJournal {
      crashed = false

      override async commitHistoryOperation(
        ...parameters: Parameters<IndexedDbJournal["commitHistoryOperation"]>
      ): Promise<void> {
        await super.commitHistoryOperation(...parameters)
        if (this.crashed) return
        this.crashed = true
        throw new Error("Injected repair crash")
      }
    }

    const name = databaseName()
    const vault = new FakeVault({ "note.md": "base" })
    const crashingJournal = new CrashAfterRepairJournal(name)
    await seedCheckpointWithoutRevision(crashingJournal, vault)
    const remote = new FakeRemote()
    remote.addRemoteRevision(envelope("parent", [], "parent-blob"), encoder.encode("base").buffer)
    remote.addRemoteRevision(
      envelope("child", ["parent"], "child-blob"),
      encoder.encode("updated").buffer,
    )

    const interrupted = controller(crashingJournal, vault, remote)
    await interrupted.start(TEST_DEVICE)

    expect(interrupted.getStatus()).toMatchObject({
      phase: "error",
      cursor: 1,
      error: "Injected repair crash",
    })
    expect(vault.text("note.md")).toBe("base")
    expect(await crashingJournal.getCheckpoint()).toMatchObject({ cursor: 1 })
    expect(await crashingJournal.getRetainedRevision("parent")).toMatchObject({ cursor: 1 })
    await interrupted.quiesce()

    const restartedJournal = new IndexedDbJournal(name)
    const restarted = controller(restartedJournal, vault, remote)
    await restarted.start(TEST_DEVICE)

    expect(restarted.getStatus()).toMatchObject({ phase: "idle", cursor: 2, error: null })
    expect(vault.text("note.md")).toBe("updated")
    expect(remote.operations).toHaveLength(2)
    await restarted.quiesce()
  })

  it("still fails closed when verified remote history does not contain the parent", async () => {
    const vault = new FakeVault({ "note.md": "base" })
    const journal = new IndexedDbJournal(databaseName())
    await seedCheckpointWithoutRevision(journal, vault)
    const remote = new FakeRemote()
    remote.addRemoteRevision(
      envelope("unrelated", [], "unrelated-blob", "other.md"),
      encoder.encode("other").buffer,
    )
    remote.addRemoteRevision(
      envelope("child", ["absent-parent"], "child-blob"),
      encoder.encode("updated").buffer,
    )

    const sync = controller(journal, vault, remote)
    await sync.start(TEST_DEVICE)

    expect(sync.getStatus()).toMatchObject({
      phase: "error",
      cursor: 1,
      error: "Local revision history is incomplete",
    })
    expect(vault.text("note.md")).toBe("base")
    expect(remote.operations).toHaveLength(2)
    expect(await journal.getCheckpoint()).toMatchObject({ cursor: 1 })
    expect(await journal.getHistoryCheckpoint()).toMatchObject({ cursor: 1 })
    await sync.quiesce()
  })
})

describe("queued revision dependencies", () => {
  it("does not upload a child until its failed parent commits", async () => {
    class FailingParentRemote extends FakeRemote {
      failParent = true

      override async commit(payload: unknown): Promise<{ cursor: number; logHash: string }> {
        const revisionId = (payload as { revisionId?: string }).revisionId
        if (revisionId === "parent" && this.failParent) throw new Error("Injected parent failure")
        return super.commit(payload)
      }
    }

    const vault = new FakeVault({ "note.md": "content" })
    const journal = new MemoryJournal()
    const remote = new FailingParentRemote()
    await journal.open()
    await journal.putEntry(
      queuedEntry({
        id: "parent-operation",
        revisionId: "parent",
        action: "upsert",
        fileId: "note.md",
        path: "note.md",
        previousPath: null,
        baseRevisionId: null,
        parentRevisionIds: [],
        restoreSourceRevisionId: null,
        createdAt: 1,
      }),
    )
    await journal.putEntry(
      queuedEntry({
        id: "child-operation",
        revisionId: "child",
        action: "upsert",
        fileId: "note.md",
        path: "note.md",
        previousPath: null,
        baseRevisionId: "parent",
        parentRevisionIds: ["parent"],
        restoreSourceRevisionId: null,
        createdAt: 2,
      }),
    )
    const push = new PushEngine(vault, journal, remote, new FakeCrypto())

    const failed = await push.push(TEST_DEVICE)

    expect(failed.error?.message).toBe("Injected parent failure")
    expect(remote.operations).toHaveLength(0)
    expect(await journal.listPending()).toMatchObject([
      { revisionId: "parent", state: "failed" },
      {
        revisionId: "child",
        state: "failed",
        error: "Queued revision is waiting for a parent revision to upload",
      },
    ])

    remote.failParent = false
    const retried = await push.push(TEST_DEVICE)

    expect(retried.error).toBeNull()
    expect(
      remote.operations.map((operation) => (operation.envelope as FakeEnvelope).revisionId),
    ).toEqual(["parent", "child"])
    expect(await journal.listPending()).toEqual([])
  })
})
