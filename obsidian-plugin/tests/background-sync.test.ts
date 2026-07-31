import { describe, expect, it, vi } from "vitest"
import {
  BackgroundSyncCompute,
  type IndexPlanningInput,
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
  terminated = false

  postMessage(
    message:
      | { id: number; kind: "fingerprint"; bytes: ArrayBuffer }
      | { id: number; kind: "plan-index"; input: IndexPlanningInput },
    transfer: Transferable[],
  ): void {
    this.transfers = transfer
    if (message.kind === "fingerprint") {
      void fingerprint(message.bytes).then((value) => {
        this.onmessage?.({
          data: { id: message.id, kind: "fingerprint", fingerprint: value },
        } as MessageEvent<unknown>)
      })
      return
    }
    void planIndexCooperatively(message.input).then((plan) => {
      this.onmessage?.({
        data: { id: message.id, kind: "plan-index", plan },
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

    compute.close()
    expect(worker.terminated).toBe(true)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it("plans collision checks removals and renames in a Worker", async () => {
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

    await scope.onmessage?.({
      data: {
        id: 1,
        kind: "plan-index",
        input: {
          current: [{ path: "new.md", fingerprint: "same" }],
          previous: [{ path: "old.md", fingerprint: "same" }],
          collisionPaths: ["new.md"],
        },
      },
    } as MessageEvent<unknown>)

    expect(response).toEqual({
      id: 1,
      kind: "plan-index",
      plan: {
        removedPaths: ["old.md"],
        renameSources: [{ path: "new.md", previousPath: "old.md" }],
      },
    })
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
