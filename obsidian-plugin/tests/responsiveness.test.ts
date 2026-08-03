import { describe, expect, it } from "vitest"
import type { RemoteOperation, RemotePort, ScannedFileSnapshot } from "../src/model"
import {
  BackgroundSyncCompute,
  planIndexCooperatively,
  type SyncComputePort,
} from "../src/platform/background-sync"
import { MemoryJournal } from "../src/storage/memory-journal"
import type { OperationApplier } from "../src/sync/operation-applier"
import { PullEngine } from "../src/sync/pull-engine"
import { Reconciler } from "../src/sync/reconciler"
import { ALL_CATEGORIES, FakeVault, TEST_DEVICE } from "./fakes"

const RESPONSIVENESS_BUDGET_MS = 10_000

describe("sync responsiveness budgets", () => {
  it("plans a 10k-file index cooperatively", async () => {
    const snapshots = Array.from({ length: 10_000 }, (_, index) => ({
      path: `Notes/file-${index}.md`,
      fingerprint: `fingerprint-${index}`,
    }))
    const heartbeat = startHeartbeat()
    const startedAt = performance.now()

    const plan = await planIndexCooperatively({
      current: snapshots,
      previous: snapshots,
      collisionPaths: snapshots.map((snapshot) => snapshot.path),
    })
    const elapsed = performance.now() - startedAt
    const heartbeatTicks = heartbeat.stop()

    expect(plan).toEqual({ removedPaths: [], renameSources: [] })
    expect(elapsed).toBeLessThan(RESPONSIVENESS_BUDGET_MS)
    expect(heartbeatTicks).toBeGreaterThan(0)
  }, 15_000)

  it("reuses cached fingerprints across a 10k-file vault", async () => {
    const fileCount = 10_000
    const vault = new FakeVault(
      Object.fromEntries(
        Array.from({ length: fileCount }, (_, index) => [`Notes/file-${index}.md`, "x"]),
      ),
    )
    const journal = new MemoryJournal()
    await journal.replaceSnapshots(
      Array.from({ length: fileCount }, (_, index) => ({
        path: `Notes/file-${index}.md`,
        fileId: `file-id-${index}`,
        fingerprint: `fingerprint-${index}`,
        size: 1,
        mtime: 1,
        kind: "vault" as const,
      })),
    )
    const compute: SyncComputePort = {
      fingerprint: async () => {
        throw new Error("Unchanged files must not be fingerprinted")
      },
      planIndex: async () => {
        throw new Error("Unchanged indexes must bypass full planning")
      },
      close: () => {},
    }
    const heartbeat = startHeartbeat()
    const startedAt = performance.now()

    const result = await new Reconciler(vault, journal, compute).reconcile(ALL_CATEGORIES)
    const elapsed = performance.now() - startedAt
    const heartbeatTicks = heartbeat.stop()

    expect(result).toEqual({ queued: 0, files: fileCount })
    expect(vault.fingerprintedPaths).toEqual([])
    expect(elapsed).toBeLessThan(RESPONSIVENESS_BUDGET_MS)
    expect(heartbeatTicks).toBeGreaterThan(0)
  }, 15_000)

  it("reconciles one dirty file without reading a 10k-file vault", async () => {
    class OneFileVault extends FakeVault {
      readonly scannedPaths: string[][] = []

      override listFiles(): Promise<ScannedFileSnapshot[]> {
        throw new Error("Routine reconciliation must not enumerate the full vault")
      }

      override scanFiles(...args: Parameters<FakeVault["scanFiles"]>) {
        this.scannedPaths.push([...args[0]])
        return super.scanFiles(...args)
      }
    }

    const dirtyPath = "Notes/file-5000.md"
    const vault = new OneFileVault({ [dirtyPath]: "edited" })
    const journal = new MemoryJournal()
    await journal.replaceSnapshots(
      Array.from({ length: 10_000 }, (_, index) => ({
        path: `Notes/file-${index}.md`,
        fileId: `file-id-${index}`,
        fingerprint: `fingerprint-${index}`,
        size: 1,
        mtime: 1,
        kind: "vault" as const,
      })),
    )
    await journal.putDirtyPath({ path: dirtyPath, token: "dirty", observedAt: 1 })
    const heartbeat = startHeartbeat()
    const startedAt = performance.now()

    const result = await new Reconciler(vault, journal).reconcileDirty(ALL_CATEGORIES)
    const elapsed = performance.now() - startedAt
    const heartbeatTicks = heartbeat.stop()

    expect(result).toEqual({ queued: 1, files: 1 })
    expect(vault.scannedPaths).toEqual([[dirtyPath]])
    expect(elapsed).toBeLessThan(RESPONSIVENESS_BUDGET_MS)
    expect(heartbeatTicks).toBeGreaterThan(0)
  }, 15_000)

  it("hashes a maximum-size encrypted chunk within the fallback budget", async () => {
    const compute = new BackgroundSyncCompute(() => null)
    const bytes = new ArrayBuffer(8 * 1024 * 1024)
    const startedAt = performance.now()

    const result = await compute.fingerprint(bytes)

    expect(result).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(performance.now() - startedAt).toBeLessThan(RESPONSIVENESS_BUDGET_MS)
    compute.close()
  }, 15_000)

  it("yields while consuming a 500-operation pull batch", async () => {
    const operations: RemoteOperation[] = Array.from({ length: 500 }, (_, index) => ({
      cursor: index + 1,
      logHash: `hash-${index + 1}`,
      envelope: { operationId: `operation-${index + 1}` },
    }))
    const remote = {
      getChanges: async (after: number) => ({
        operations: operations.filter((operation) => operation.cursor > after),
        latestCursor: operations.length,
      }),
    } as unknown as RemotePort
    const applier = {
      apply: async () => TEST_DEVICE,
    } as unknown as OperationApplier
    const journal = new MemoryJournal()
    const heartbeat = startHeartbeat()
    const startedAt = performance.now()

    const result = await new PullEngine(journal, remote, applier, async () => {}).pull(TEST_DEVICE)
    const elapsed = performance.now() - startedAt
    const heartbeatTicks = heartbeat.stop()

    expect(result).toEqual({ stopped: false, device: TEST_DEVICE })
    expect(await journal.getCursor()).toBe(500)
    expect(elapsed).toBeLessThan(RESPONSIVENESS_BUDGET_MS)
    expect(heartbeatTicks).toBeGreaterThan(0)
  }, 15_000)
})

function startHeartbeat(): { stop(): number } {
  let ticks = 0
  const interval = setInterval(() => {
    ticks += 1
  }, 0)
  return {
    stop: () => {
      clearInterval(interval)
      return ticks
    },
  }
}
