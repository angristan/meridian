import "fake-indexeddb/auto"
import { describe, expect, it } from "vitest"
import type {
  ConfigCategory,
  EncryptedBlob,
  JournalState,
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
import type { AppliedOperationCommit, PushedRevisionCommit } from "../src/storage/contracts"
import { IndexedDbJournal } from "../src/storage/indexed-db-journal"
import { MemoryJournal } from "../src/storage/memory-journal"
import { SyncController } from "../src/sync/controller"
import {
  campaignConfiguration,
  clearFailureTrace,
  createTrace,
  DeterministicRandom,
  persistFailureTrace,
  traceEvent,
} from "./fault-campaign"
import { ALL_CATEGORIES, FakeCrypto, FakeRemote, FakeVault, TEST_DEVICE } from "./fakes"
import { seedLegacyIndexedDbRevision } from "./journal-fixtures"

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
    private readonly legacyDatabaseName: string,
    private readonly boundary: PostCommitCrashBoundary,
  ) {
    super(legacyDatabaseName)
  }

  override async finishPushedRevision(commit: PushedRevisionCommit): Promise<void> {
    if (this.boundary === "completion" || this.boundary === "checkpoint") {
      await super.finishPushedRevision(commit)
      if (this.boundary === "completion") this.crash()
      return
    }

    // Recreate partial states written by older releases so restart compatibility remains covered.
    if (commit.snapshot) await super.putSnapshot(commit.snapshot)
    for (const path of commit.removeSnapshotPaths) await super.removeSnapshot(path)
    if (this.boundary === "snapshot") this.crash()
    await seedLegacyIndexedDbRevision(this.legacyDatabaseName, commit.revision)
    this.crash()
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

class PostApplyCrashJournal extends IndexedDbJournal {
  private crashed = false

  override async commitAppliedOperation(commit: AppliedOperationCommit): Promise<void> {
    await super.commitAppliedOperation(commit)
    if (this.crashed) return
    this.crashed = true
    throw new Error("Injected crash after applied operation")
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

  loseNextResponse(): void {
    this.responseLossPending = true
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
    request.onblocked = () => reject(new Error(`IndexedDB deletion is blocked for ${name}`))
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

  it("restarts after applied state commits before its checkpoint", async () => {
    const databaseName = `meridian-post-apply-${crypto.randomUUID()}`
    const vault = new FakeVault()
    const remote = new FakeRemote()
    remote.addRemoteRevision(
      {
        operationId: "remote-operation",
        revisionId: "remote-revision",
        fileId: "remote-file",
        action: "upsert",
        path: "remote.md",
        previousPath: null,
        parents: [],
        authorDeviceId: "remote-device",
        blobId: "remote-blob",
        isText: true,
      },
      new TextEncoder().encode("remote content").buffer,
    )
    const crashingJournal = new PostApplyCrashJournal(databaseName)
    const first = new SyncController(
      vault,
      crashingJournal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    await first.start(TEST_DEVICE)

    expect(first.getStatus().error).toMatch(/Injected crash after applied operation/)
    expect(await crashingJournal.getCheckpoint()).toBeNull()
    expect(await crashingJournal.getRevision("remote-revision")).toMatchObject({ cursor: 1 })
    expect((await crashingJournal.getSnapshots()).get("remote.md")).toMatchObject({
      fileId: "remote-file",
    })
    expect(vault.text("remote.md")).toBe("remote content")
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

    expect(await restartedJournal.getCheckpoint()).toMatchObject({ cursor: 1 })
    expect(await restartedJournal.listRevisions("remote.md")).toHaveLength(1)
    expect(await restartedJournal.listPending()).toEqual([])
    expect(await restartedJournal.listConflicts(true)).toEqual([])
    expect(vault.text("remote.md")).toBe("remote content")
    await restarted.quiesce()
    await deleteDatabase(databaseName)
  })

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

type SeededFault = "none" | "response" | PostCommitCrashBoundary

const SEEDED_FAULTS: readonly SeededFault[] = [
  "none",
  "response",
  "snapshot",
  "revision",
  "completion",
  "checkpoint",
]
const seededCampaign = campaignConfiguration()

describe("seeded local fault campaign", () => {
  it(
    "converges after deterministic commit faults and restarts",
    async () => {
      for (const seed of seededCampaign.seeds) {
        await runSeededRestartCampaign(seed, seededCampaign.steps)
      }
    },
    seededCampaign.timeout,
  )
})

async function runSeededRestartCampaign(seed: number, steps: number): Promise<void> {
  const databaseName = `meridian-seeded-${seed}`
  const random = new DeterministicRandom(seed)
  const trace = createTrace(seed, steps)
  const vault = new FakeVault()
  const remote = new IdempotentCommitRemote()
  let activeController: SyncController | null = null
  let faultDeck = random.shuffle(SEEDED_FAULTS)

  await deleteDatabase(databaseName)
  await clearFailureTrace(seed, steps)
  try {
    for (let step = 0; step < steps; step += 1) {
      if (step > 0 && step % SEEDED_FAULTS.length === 0) {
        faultDeck = random.shuffle(SEEDED_FAULTS)
      }
      const fault = faultDeck[step % SEEDED_FAULTS.length] as SeededFault
      const deletesFile = vault.files.has("note.md") && random.chance(1, 3)
      const content = deletesFile ? null : `seed-${seed}-step-${step}-${"x".repeat(step + 1)}`
      if (content === null) vault.files.delete("note.md")
      else vault.files.set("note.md", new TextEncoder().encode(content).buffer)
      if (fault === "response") remote.loseNextResponse()
      traceEvent(trace, "planned", {
        step,
        fault,
        action: content === null ? "delete" : "upsert",
        contentLength: content?.length ?? 0,
      })

      const faultJournal = isPostCommitBoundary(fault)
        ? new PostCommitCrashJournal(databaseName, fault)
        : new IndexedDbJournal(databaseName)
      const faulted = new SyncController(
        vault,
        faultJournal,
        remote,
        new FakeCrypto(),
        () => ALL_CATEGORIES,
        () => {},
      )
      activeController = faulted
      await faulted.start(TEST_DEVICE)
      const faultStatus = faulted.getStatus()
      const pendingAfterFault = (await faultJournal.listPending()).length
      const checkpointAfterFault = (await faultJournal.getCheckpoint())?.cursor ?? 0
      await faulted.quiesce()
      activeController = null

      if (fault === "none") {
        campaignAssert(faultStatus.error === null, `step ${step} unexpectedly failed`)
      } else {
        campaignAssert(
          faultStatus.error?.includes(expectedFaultMessage(fault)) === true,
          `step ${step} did not expose ${fault}`,
        )
      }
      const expectedCursor = step + 1
      campaignAssert(
        remote.operations.length === expectedCursor,
        `step ${step} appended ${remote.operations.length} operations instead of ${expectedCursor}`,
      )
      traceEvent(trace, "fault-settled", {
        step,
        fault,
        checkpoint: checkpointAfterFault,
        pending: pendingAfterFault,
        remoteCursor: remote.operations.length,
      })

      const recoveredJournal = new IndexedDbJournal(databaseName)
      const recovered = new SyncController(
        vault,
        recoveredJournal,
        remote,
        new FakeCrypto(),
        () => ALL_CATEGORIES,
        () => {},
      )
      activeController = recovered
      await recovered.start(TEST_DEVICE)
      const operationsBeforeNoop = remote.operations.length
      await recovered.sync("manual")
      campaignAssert(
        remote.operations.length === operationsBeforeNoop,
        `step ${step} appended work during a no-op sync`,
      )
      const pending = await recoveredJournal.listPending()
      const conflicts = await recoveredJournal.listConflicts(true)
      const revisions = await recoveredJournal.listRevisions("note.md")
      const checkpoint = await recoveredJournal.getCheckpoint()
      const snapshot = (await recoveredJournal.getSnapshots()).get("note.md")
      const actualContent = vault.text("note.md")
      await recovered.quiesce()
      activeController = null

      campaignAssert(pending.length === 0, `step ${step} left ${pending.length} pending entries`)
      campaignAssert(conflicts.length === 0, `step ${step} created ${conflicts.length} conflicts`)
      campaignAssert(
        remote.operations.length === expectedCursor,
        `step ${step} duplicated a remote operation during recovery`,
      )
      campaignAssert(
        revisions.length === expectedCursor,
        `step ${step} retained ${revisions.length} revisions instead of ${expectedCursor}`,
      )
      campaignAssert(
        checkpoint?.cursor === expectedCursor && checkpoint.logHash === `hash-${expectedCursor}`,
        `step ${step} recovered checkpoint ${checkpoint?.cursor ?? 0} incorrectly`,
      )
      campaignAssert(
        actualContent === content,
        `step ${step} changed the vault content during replay`,
      )
      for (const [operationIndex, operation] of remote.operations.entries()) {
        campaignAssert(
          operation.cursor === operationIndex + 1 &&
            operation.logHash === `hash-${operationIndex + 1}`,
          `step ${step} found a discontinuous remote log at ${operationIndex + 1}`,
        )
        const envelope = operation.envelope as Record<string, unknown>
        if (typeof envelope.blobId === "string") {
          campaignAssert(
            remote.blobs.has(envelope.blobId),
            `step ${step} found a committed operation with a missing blob`,
          )
        }
      }
      if (content === null) {
        campaignAssert(snapshot === undefined, `step ${step} retained a deleted snapshot`)
      } else {
        const expectedFingerprint = await fingerprintBytes(new TextEncoder().encode(content).buffer)
        campaignAssert(
          snapshot?.fingerprint === expectedFingerprint,
          `step ${step} recovered a stale snapshot`,
        )
      }
      const audit = new IndexedDbJournal(databaseName)
      await audit.open()
      const auditPending = await audit.listPending()
      const auditCheckpoint = await audit.getCheckpoint()
      const auditSnapshots = await audit.getSnapshots()
      audit.close()
      campaignAssert(auditPending.length === 0, `step ${step} reopened with pending work`)
      campaignAssert(
        auditCheckpoint?.cursor === expectedCursor &&
          auditCheckpoint.logHash === `hash-${expectedCursor}`,
        `step ${step} did not retain its checkpoint after reopen`,
      )
      campaignAssert(
        auditSnapshots.has("note.md") === (content !== null),
        `step ${step} changed snapshot paths after reopen`,
      )
      traceEvent(trace, "recovered", {
        step,
        checkpoint: checkpoint.cursor,
        revisions: revisions.length,
        pending: pending.length,
        conflicts: conflicts.length,
        snapshot: snapshot !== undefined,
      })
    }
  } catch (error) {
    if (activeController) {
      await activeController.quiesce().catch(() => undefined)
      activeController = null
    }
    const tracePath = await persistFailureTrace(trace, error).catch(() => "trace-write-failed")
    const failure = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Seeded fault campaign failed for seed ${seed}: ${failure}. Trace: ${tracePath}. Replay with: bun run fault:test --seed ${seed} --steps ${steps}`,
    )
  } finally {
    if (activeController) await activeController.quiesce()
    await deleteDatabase(databaseName)
  }
}

function isPostCommitBoundary(fault: SeededFault): fault is PostCommitCrashBoundary {
  return fault !== "none" && fault !== "response"
}

function expectedFaultMessage(fault: Exclude<SeededFault, "none">): string {
  return fault === "response"
    ? "Injected response loss after commit"
    : `Injected crash after ${fault}`
}

function campaignAssert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
