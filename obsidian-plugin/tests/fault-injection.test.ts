import "fake-indexeddb/auto"
import { describe, expect, it } from "vitest"
import type {
  ConfigCategory,
  EncryptedBlob,
  ScannedFileSnapshot,
  SelectiveSyncSettings,
  VaultScanOptions,
} from "../src/model"
import { fingerprint as fingerprintBytes } from "../src/platform/bytes"
import {
  planIndexCooperatively,
  type IndexPlan,
  type IndexPlanningInput,
  type SyncComputePort,
} from "../src/platform/background-sync"
import { IndexedDbJournal, MemoryJournal } from "../src/storage/journal"
import { SyncController } from "../src/sync/controller"
import { ALL_CATEGORIES, FakeCrypto, FakeRemote, FakeVault, TEST_DEVICE } from "./fakes"

class BlockingVault extends FakeVault {
  private gate: { entered: () => void; wait: Promise<void> } | null = null

  blockNextFullScan(): { entered: Promise<void>; release: () => void } {
    let markEntered: (() => void) | undefined
    let release: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    this.gate = { entered: () => markEntered?.(), wait }
    return { entered, release: () => release?.() }
  }

  override async listFiles(
    categories: Record<ConfigCategory, boolean>,
    selection: SelectiveSyncSettings = { excludedFolders: [], excludedExtensions: [] },
    options: VaultScanOptions = {},
  ): Promise<ScannedFileSnapshot[]> {
    const gate = this.gate
    if (gate) {
      this.gate = null
      gate.entered()
      await gate.wait
    }
    return super.listFiles(categories, selection, options)
  }
}

class PausedPlanCompute implements SyncComputePort {
  private gate: { reached: (plan: IndexPlan) => void; wait: Promise<void> } | undefined

  pauseNextPlan(): { reached: Promise<IndexPlan>; release: () => void } {
    let markReached: ((plan: IndexPlan) => void) | undefined
    let release: (() => void) | undefined
    const reached = new Promise<IndexPlan>((resolve) => {
      markReached = resolve
    })
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    this.gate = { reached: (plan) => markReached?.(plan), wait }
    return { reached, release: () => release?.() }
  }

  fingerprint(bytes: ArrayBuffer): Promise<string> {
    return fingerprintBytes(bytes)
  }

  async planIndex(input: IndexPlanningInput, shouldStop?: () => boolean): Promise<IndexPlan> {
    const plan = await planIndexCooperatively(input, shouldStop)
    const gate = this.gate
    if (gate) {
      this.gate = undefined
      gate.reached(plan)
      await gate.wait
    }
    return plan
  }

  close(): void {}
}

class ObservedJournal extends MemoryJournal {
  clearSnapshotsCount = 0

  override async clearSnapshots(): Promise<void> {
    this.clearSnapshotsCount += 1
    await super.clearSnapshots()
  }
}

class ObservedIndexedDbJournal extends IndexedDbJournal {
  clearSnapshotsCount = 0

  override async clearSnapshots(): Promise<void> {
    this.clearSnapshotsCount += 1
    await super.clearSnapshots()
  }
}

async function deleteDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

describe("deterministic local fault injection", () => {
  it("does not clear the snapshot index during an active sync", async () => {
    const vault = new BlockingVault({ "note.md": "safe content" })
    const journal = new ObservedJournal()
    const controller = new SyncController(
      vault,
      journal,
      new FakeRemote(),
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )
    await controller.start(TEST_DEVICE)

    const gate = vault.blockNextFullScan()
    const syncing = controller.sync("manual")
    await gate.entered
    const repairing = controller.repairLocalIndex()
    for (let index = 0; index < 5; index += 1) await Promise.resolve()

    expect(journal.clearSnapshotsCount).toBe(0)
    gate.release()
    await Promise.all([syncing, repairing])

    expect(journal.clearSnapshotsCount).toBe(1)
    expect((await journal.getSnapshots()).get("note.md")).toMatchObject({
      path: "note.md",
    })
    expect(await journal.listPending()).toEqual([])
    controller.stop()
  })

  it("drains an exact committed retry after restart", async () => {
    class LostCommitResponseRemote extends FakeRemote {
      readonly attempts: { envelope: unknown; idempotencyKey: string }[] = []
      readonly blobAttempts: EncryptedBlob[] = []
      private committed: { cursor: number; logHash: string } | null = null

      override async putBlob(blob: EncryptedBlob): Promise<void> {
        this.blobAttempts.push(structuredClone(blob))
        await super.putBlob(blob)
      }

      override async commit(
        envelope: unknown,
        idempotencyKey = "",
      ): Promise<{ cursor: number; logHash: string }> {
        this.attempts.push({ envelope: structuredClone(envelope), idempotencyKey })
        if (this.committed) return this.committed
        this.committed = await super.commit(envelope)
        throw new Error("Injected response loss after commit")
      }
    }

    const databaseName = `meridian-response-loss-${crypto.randomUUID()}`
    const vault = new FakeVault({ "note.md": "durable content" })
    const remote = new LostCommitResponseRemote()
    const firstJournal = new IndexedDbJournal(databaseName)
    const first = new SyncController(
      vault,
      firstJournal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    await first.start(TEST_DEVICE)
    expect(first.getStatus().error).toMatch(/Injected response loss after commit/)
    expect(remote.operations).toHaveLength(1)
    const stranded = await firstJournal.listPending()
    expect(stranded).toHaveLength(1)
    expect(stranded[0]).toMatchObject({ state: "failed" })
    expect(stranded[0]?.preparedRevision).not.toBeNull()
    expect(await firstJournal.getCheckpoint()).toBeNull()
    await first.quiesce()

    const restartedJournal = new IndexedDbJournal(databaseName)
    const restarted = new SyncController(
      vault,
      restartedJournal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )
    await restarted.start(TEST_DEVICE)

    expect(remote.attempts).toHaveLength(2)
    expect(remote.attempts[1]).toEqual(remote.attempts[0])
    expect(remote.attempts[0]?.idempotencyKey).not.toBe("")
    expect(remote.blobAttempts).toHaveLength(2)
    expect(remote.blobAttempts[1]).toEqual(remote.blobAttempts[0])
    expect(remote.blobs.size).toBe(1)
    expect(remote.operations).toHaveLength(1)
    expect(await restartedJournal.listPending()).toEqual([])
    expect(await restartedJournal.listConflicts(true)).toEqual([])
    expect(await restartedJournal.getCheckpoint()).toMatchObject({ cursor: 1, logHash: "hash-1" })
    expect(await restartedJournal.listRevisions("note.md")).toHaveLength(1)
    expect((await restartedJournal.getSnapshots()).get("note.md")).toMatchObject({
      path: "note.md",
    })
    await restarted.quiesce()

    const reopened = new IndexedDbJournal(databaseName)
    await reopened.open()
    expect(await reopened.listPending()).toEqual([])
    expect(await reopened.getCheckpoint()).toMatchObject({ cursor: 1, logHash: "hash-1" })
    expect(await reopened.listRevisions("note.md")).toHaveLength(1)
    reopened.close()
    await deleteDatabase(databaseName)
  })

  it("preserves a deletion when repair starts after planning", async () => {
    const databaseName = `meridian-fault-${crypto.randomUUID()}`
    const vault = new FakeVault({ "keep.md": "keep", "delete.md": "delete" })
    const journal = new ObservedIndexedDbJournal(databaseName)
    const remote = new FakeRemote()
    const compute = new PausedPlanCompute()
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
      undefined,
      { compute },
    )
    await controller.start(TEST_DEVICE)
    vault.files.delete("delete.md")

    const gate = compute.pauseNextPlan()
    const syncing = controller.sync("manual")
    const planned = await gate.reached
    expect(planned.removedPaths).toContain("delete.md")
    const repairing = controller.repairLocalIndex()
    for (let index = 0; index < 5; index += 1) await Promise.resolve()
    expect(journal.clearSnapshotsCount).toBe(0)

    gate.release()
    await Promise.all([syncing, repairing])
    const deletionCount = remote.operations.filter((operation) => {
      const envelope = operation.envelope as Record<string, unknown>
      return envelope.type === "tombstone" && envelope.path === "delete.md"
    }).length
    expect(deletionCount).toBe(1)
    expect((await journal.getSnapshots()).has("delete.md")).toBe(false)
    expect((await journal.getSnapshots()).has("keep.md")).toBe(true)
    expect(await journal.listPending()).toEqual([])

    const committedCount = remote.operations.length
    await controller.sync("manual")
    expect(remote.operations).toHaveLength(committedCount)
    await controller.quiesce()

    const reopened = new IndexedDbJournal(databaseName)
    await reopened.open()
    expect((await reopened.getSnapshots()).has("delete.md")).toBe(false)
    expect((await reopened.getSnapshots()).has("keep.md")).toBe(true)
    reopened.close()
    await deleteDatabase(databaseName)
  })
})
