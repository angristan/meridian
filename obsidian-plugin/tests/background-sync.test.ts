import { describe, expect, it, vi } from "vitest"
import {
  BackgroundSyncCompute,
  planIndexCooperatively,
  SYNC_WORKER_SOURCE,
  type SyncWorkerLike,
} from "../src/platform/background-sync"
import { fingerprint } from "../src/platform/bytes"

interface WorkerSourceScope {
  onmessage: ((event: MessageEvent<unknown>) => Promise<void>) | null
  postMessage(message: unknown): void
}

class FakeSyncWorker implements SyncWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  transfers: Transferable[] = []
  postCount = 0
  terminated = false

  postMessage(
    message: { id: number; kind: "fingerprint"; bytes: ArrayBuffer },
    transfer: Transferable[],
  ): void {
    this.postCount += 1
    this.transfers = transfer
    void fingerprint(message.bytes).then((value) => {
      this.onmessage?.({
        data: { id: message.id, kind: "fingerprint", fingerprint: value },
      } as MessageEvent<unknown>)
    })
  }

  terminate(): void {
    this.terminated = true
  }
}

describe("background sync compute", () => {
  it("transfers file buffers to a Worker and returns its digest", async () => {
    const worker = new FakeSyncWorker()
    const dispose = vi.fn()
    const compute = new BackgroundSyncCompute(() => ({ worker, dispose }))
    const bytes = new TextEncoder().encode("background content").buffer
    const expected = await fingerprint(bytes.slice(0))

    await expect(compute.fingerprint(bytes)).resolves.toBe(expected)
    expect(worker.transfers).toEqual([bytes])
    expect(worker.postCount).toBe(1)

    compute.close()
    expect(worker.terminated).toBe(true)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it("plans collision checks removals and renames cooperatively", async () => {
    const worker = new FakeSyncWorker()
    const compute = new BackgroundSyncCompute(() => ({ worker, dispose: vi.fn() }))

    await expect(
      compute.planIndex({
        current: [{ path: "new.md", fingerprint: "same" }],
        previous: [
          { path: "old.md", fingerprint: "same" },
          { path: "deleted.md", fingerprint: "other" },
        ],
        collisionPaths: ["new.md"],
      }),
    ).resolves.toEqual({
      removedPaths: ["old.md", "deleted.md"],
      renameSources: [{ path: "new.md", previousPath: "old.md" }],
    })
    expect(worker.transfers).toEqual([])
    expect(worker.postCount).toBe(0)
    compute.close()
  })

  it("executes the bundled Worker source", async () => {
    let response: unknown = null
    const scope: WorkerSourceScope = {
      onmessage: null,
      postMessage: (message) => {
        response = message
      },
    }
    const initializeWorker = new Function("self", SYNC_WORKER_SOURCE) as (
      workerScope: WorkerSourceScope,
    ) => void
    initializeWorker(scope)

    const bytes = new TextEncoder().encode("worker digest").buffer
    const expected = await fingerprint(bytes.slice(0))
    await scope.onmessage?.({
      data: { id: 1, kind: "fingerprint", bytes },
    } as MessageEvent<unknown>)

    expect(response).toEqual({ id: 1, kind: "fingerprint", fingerprint: expected })
  })

  it("uses cooperative fallbacks when Workers are unavailable", async () => {
    const fingerprintFallback = vi.fn(async () => "fallback-fingerprint")
    const planFallback = vi.fn(planIndexCooperatively)
    const compute = new BackgroundSyncCompute(() => null, fingerprintFallback, planFallback)
    const bytes = new ArrayBuffer(16)

    await expect(compute.fingerprint(bytes)).resolves.toBe("fallback-fingerprint")
    await expect(
      compute.planIndex({ current: [], previous: [], collisionPaths: [] }),
    ).resolves.toEqual({ removedPaths: [], renameSources: [] })
    expect(fingerprintFallback).toHaveBeenCalledWith(bytes)
    expect(planFallback).toHaveBeenCalledOnce()
  })

  it("rejects pending work and terminates the Worker on unload", async () => {
    const worker = new FakeSyncWorker()
    worker.postMessage = () => {}
    const compute = new BackgroundSyncCompute(() => ({ worker, dispose: vi.fn() }))
    const pending = compute.fingerprint(new ArrayBuffer(16))

    compute.close()

    await expect(pending).rejects.toThrow("stopped")
    expect(worker.terminated).toBe(true)
  })
})
