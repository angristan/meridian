import "fake-indexeddb/auto"
import { describe, expect, it } from "vitest"
import type {
  ConfigCategory,
  EncryptedBlob,
  FileSnapshot,
  JournalEntry,
  JournalState,
  LocalRevision,
  ScannedFileSnapshot,
  SelectiveSyncSettings,
  TrustedCheckpoint,
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

type PostCommitCrashBoundary = "revision" | "snapshot" | "completion" | "checkpoint"

class PostCommitCrashJournal extends IndexedDbJournal {
  private crashed = false

  constructor(
    name: string,
    private readonly boundary: PostCommitCrashBoundary,
  ) {
    super(name)
  }

  override async putRevision(revision: LocalRevision): Promise<void> {
    await super.putRevision(revision)
    if (this.boundary === "revision") this.crash()
  }

  override async putSnapshot(snapshot: FileSnapshot): Promise<void> {
    await super.putSnapshot(snapshot)
    if (this.boundary === "snapshot") this.crash()
  }

  override async putEntry(entry: JournalEntry): Promise<void> {
    await super.putEntry(entry)
    if (this.boundary === "completion" && entry.state === "complete") this.crash()
  }

  override async updateEntry(
    id: string,
    state: JournalState,
    error?: string | null,
  ): Promise<void> {
    if (this.crashed) this.crash()
    await super.updateEntry(id, state, error)
  }

  override async setCheckpoint(checkpoint: TrustedCheckpoint): Promise<void> {
    await super.setCheckpoint(checkpoint)
    if (this.boundary === "checkpoint") this.crash()
  }

  private crash(): never {
    this.crashed = true
    throw new Error(`Injected crash after ${this.boundary}`)
  }
}

class IdempotentCommitRemote extends FakeRemote {
  readonly attempts: { envelope: unknown; idempotencyKey: string }[] = []
  readonly blobAttempts: EncryptedBlob[] = []
  private readonly receipts = new Map<
    string,
    { envelope: unknown; receipt: { cursor: number; logHash: string } }
  >()
  private responseLossPending: boolean

  constructor(loseFirstResponse = false) {
    super()
    this.responseLossPending = loseFirstResponse
  }

  override async putBlob(blob: EncryptedBlob): Promise<void> {
    this.blobAttempts.push(structuredClone(blob))
    await super.putBlob(blob)
  }

  override async commit(
    envelope: unknown,
    idempotencyKey = "",
  ): Promise<{ cursor: number; logHash: string }> {
    const clonedEnvelope = structuredClone(envelope)
    this.attempts.push({ envelope: clonedEnvelope, idempotencyKey })
    const existing = this.receipts.get(idempotencyKey)
    if (existing) {
      expect(clonedEnvelope).toEqual(existing.envelope)
      return existing.receipt
    }
    const receipt = await super.commit(envelope)
    this.receipts.set(idempotencyKey, { envelope: clonedEnvelope, receipt })
    if (this.responseLossPending) {
      this.responseLossPending = false
      throw new Error("Injected response loss after commit")
    }
    return receipt
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
    const databaseName = `meridian-response-loss-${crypto.randomUUID()}`
    const vault = new FakeVault({ "note.md": "durable content" })
    const remote = new IdempotentCommitRemote(true)
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

  it.each<PostCommitCrashBoundary>(["revision", "snapshot", "completion", "checkpoint"])(
    "recovers after a crash following local %s persistence",
    async (boundary) => {
      const databaseName = `meridian-post-commit-${boundary}-${crypto.randomUUID()}`
      const vault = new FakeVault({ "note.md": "baseline content" })
      const remote = new IdempotentCommitRemote()
      const baselineJournal = new IndexedDbJournal(databaseName)
      const baseline = new SyncController(
        vault,
        baselineJournal,
        remote,
        new FakeCrypto(),
        () => ALL_CATEGORIES,
        () => {},
      )
      await baseline.start(TEST_DEVICE)
      expect(await baselineJournal.getCheckpoint()).toMatchObject({ cursor: 1 })
      await baseline.quiesce()

      const updatedBytes = new TextEncoder().encode("checkpoint-last content").buffer
      const updatedFingerprint = await fingerprintBytes(updatedBytes)
      vault.files.set("note.md", updatedBytes)
      const crashingJournal = new PostCommitCrashJournal(databaseName, boundary)
      const first = new SyncController(
        vault,
        crashingJournal,
        remote,
        new FakeCrypto(),
        () => ALL_CATEGORIES,
        () => {},
      )

      await first.start(TEST_DEVICE)
      expect(first.getStatus().error).toMatch(new RegExp(`Injected crash after ${boundary}`))
      expect(remote.operations).toHaveLength(2)
      expect(remote.attempts).toHaveLength(2)
      expect(await crashingJournal.listRevisions("note.md")).toHaveLength(
        boundary === "snapshot" ? 1 : 2,
      )
      expect((await crashingJournal.getSnapshots()).get("note.md")).toMatchObject({
        path: "note.md",
        fingerprint: updatedFingerprint,
      })
      expect(await crashingJournal.getCheckpoint()).toMatchObject(
        boundary === "checkpoint"
          ? { cursor: 2, logHash: "hash-2" }
          : { cursor: 1, logHash: "hash-1" },
      )
      const pendingBeforeRestart = await crashingJournal.listPending()
      if (boundary === "revision" || boundary === "snapshot") {
        expect(pendingBeforeRestart).toHaveLength(1)
        expect(pendingBeforeRestart[0]).toMatchObject({ state: "committing" })
      } else {
        expect(pendingBeforeRestart).toEqual([])
      }
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

      const expectedAttempts = boundary === "revision" || boundary === "snapshot" ? 3 : 2
      expect(remote.attempts).toHaveLength(expectedAttempts)
      if (expectedAttempts === 3) expect(remote.attempts[2]).toEqual(remote.attempts[1])
      expect(remote.operations).toHaveLength(2)
      expect(remote.blobs.size).toBe(2)
      expect(await restartedJournal.listPending()).toEqual([])
      expect(await restartedJournal.listConflicts(true)).toEqual([])
      expect(await restartedJournal.listRevisions("note.md")).toHaveLength(2)
      expect(await restartedJournal.getCheckpoint()).toMatchObject({
        cursor: 2,
        logHash: "hash-2",
      })
      expect((await restartedJournal.getSnapshots()).get("note.md")).toMatchObject({
        path: "note.md",
        fingerprint: updatedFingerprint,
      })
      await restarted.quiesce()

      const reopened = new IndexedDbJournal(databaseName)
      await reopened.open()
      expect(await reopened.listPending()).toEqual([])
      expect(await reopened.listRevisions("note.md")).toHaveLength(2)
      expect(await reopened.getCheckpoint()).toMatchObject({ cursor: 2, logHash: "hash-2" })
      reopened.close()
      await deleteDatabase(databaseName)
    },
  )

  it("does not conflict with a descendant of an interrupted committed revision", async () => {
    const databaseName = `meridian-committed-ancestor-${crypto.randomUUID()}`
    const vault = new FakeVault({ "note.md": "baseline content" })
    const remote = new IdempotentCommitRemote()
    const baselineJournal = new IndexedDbJournal(databaseName)
    const baseline = new SyncController(
      vault,
      baselineJournal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )
    await baseline.start(TEST_DEVICE)
    await baseline.quiesce()

    vault.files.set("note.md", new TextEncoder().encode("committed local update").buffer)
    const revisionCrashJournal = new PostCommitCrashJournal(databaseName, "revision")
    const revisionCrash = new SyncController(
      vault,
      revisionCrashJournal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )
    await revisionCrash.start(TEST_DEVICE)
    expect(revisionCrash.getStatus().error).toMatch(/Injected crash after revision/)
    const committedLocal = (await revisionCrashJournal.listRevisions("note.md")).find(
      (revision) => revision.cursor === 2,
    )
    expect(committedLocal).toMatchObject({ cursor: 2 })
    await revisionCrash.quiesce()

    remote.addRemoteRevision(
      {
        operationId: "remote-descendant-operation",
        revisionId: "remote-descendant-revision",
        fileId: committedLocal?.fileId ?? "missing-file-id",
        action: "upsert",
        path: "note.md",
        previousPath: null,
        parents: [committedLocal?.revisionId ?? "missing-revision-id"],
        authorDeviceId: "device-remote",
        blobId: "remote-descendant-blob",
        isText: true,
      },
      new TextEncoder().encode("remote descendant").buffer,
    )

    const recoveredJournal = new IndexedDbJournal(databaseName)
    const recovered = new SyncController(
      vault,
      recoveredJournal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )
    await recovered.start(TEST_DEVICE)

    expect(vault.text("note.md")).toBe("remote descendant")
    expect(remote.operations).toHaveLength(3)
    expect(remote.attempts).toHaveLength(2)
    expect(await recoveredJournal.listPending()).toEqual([])
    expect(await recoveredJournal.listConflicts(true)).toEqual([])
    expect(await recoveredJournal.listRevisions("note.md")).toHaveLength(3)
    expect(await recoveredJournal.getCheckpoint()).toMatchObject({ cursor: 3, logHash: "hash-3" })
    await recovered.quiesce()
    await deleteDatabase(databaseName)
  })

  it("does not checkpoint a committed delete before snapshot removal", async () => {
    const databaseName = `meridian-delete-checkpoint-${crypto.randomUUID()}`
    const vault = new FakeVault({ "note.md": "delete after baseline" })
    const remote = new IdempotentCommitRemote()
    const baselineJournal = new IndexedDbJournal(databaseName)
    const baseline = new SyncController(
      vault,
      baselineJournal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )
    await baseline.start(TEST_DEVICE)
    expect(await baselineJournal.getCheckpoint()).toMatchObject({ cursor: 1 })
    const baselineSnapshot = (await baselineJournal.getSnapshots()).get("note.md")
    expect(baselineSnapshot).toBeDefined()
    await baseline.quiesce()

    vault.files.delete("note.md")
    const revisionCrashJournal = new PostCommitCrashJournal(databaseName, "revision")
    const revisionCrash = new SyncController(
      vault,
      revisionCrashJournal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )
    await revisionCrash.start(TEST_DEVICE)
    expect(revisionCrash.getStatus().error).toMatch(/Injected crash after revision/)
    expect(await revisionCrashJournal.getCheckpoint()).toMatchObject({ cursor: 1 })
    // Older revision-first releases could stop with the committed marker but this stale snapshot.
    if (!baselineSnapshot) throw new Error("Baseline snapshot is missing")
    await revisionCrashJournal.putSnapshot(baselineSnapshot)
    expect((await revisionCrashJournal.getSnapshots()).has("note.md")).toBe(true)
    await revisionCrash.quiesce()

    const checkpointCrashJournal = new PostCommitCrashJournal(databaseName, "checkpoint")
    const checkpointCrash = new SyncController(
      vault,
      checkpointCrashJournal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )
    await checkpointCrash.start(TEST_DEVICE)
    expect(checkpointCrash.getStatus().error).toMatch(/Injected crash after checkpoint/)
    expect(await checkpointCrashJournal.getCheckpoint()).toMatchObject({ cursor: 2 })
    expect((await checkpointCrashJournal.getSnapshots()).has("note.md")).toBe(false)
    await checkpointCrash.quiesce()

    const recoveredJournal = new IndexedDbJournal(databaseName)
    const recovered = new SyncController(
      vault,
      recoveredJournal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )
    await recovered.start(TEST_DEVICE)
    expect(remote.operations).toHaveLength(2)
    expect(await recoveredJournal.listPending()).toEqual([])
    expect(await recoveredJournal.listConflicts(true)).toEqual([])
    expect(await recoveredJournal.listRevisions("note.md")).toHaveLength(2)
    expect(await recoveredJournal.getCheckpoint()).toMatchObject({ cursor: 2, logHash: "hash-2" })
    expect((await recoveredJournal.getSnapshots()).has("note.md")).toBe(false)
    await recovered.quiesce()
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
