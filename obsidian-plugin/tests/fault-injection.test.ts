import "fake-indexeddb/auto"
import { describe, expect, it } from "vitest"
import type {
  ConfigCategory,
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
