import { fingerprint as fingerprintOnMainThread } from "./bytes"
import { yieldToEventLoop } from "./scheduling"

export interface IndexPlanningSnapshot {
  path: string
  fingerprint: string
}

export interface IndexPlanningInput {
  current: IndexPlanningSnapshot[]
  previous: IndexPlanningSnapshot[]
  collisionPaths: string[]
}

export interface IndexPlan {
  removedPaths: string[]
  renameSources: Array<{ path: string; previousPath: string }>
}

interface FingerprintRequest {
  id: number
  kind: "fingerprint"
  bytes: ArrayBuffer
}

interface PlanIndexRequest {
  id: number
  kind: "plan-index"
  input: IndexPlanningInput
}

type SyncWorkerRequest = FingerprintRequest | PlanIndexRequest

type SyncWorkerSuccess =
  | { id: number; kind: "fingerprint"; fingerprint: string }
  | { id: number; kind: "plan-index"; plan: IndexPlan }

type SyncWorkerResponse = SyncWorkerSuccess | { id: number; kind: "error"; error: string }

export interface SyncWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage(message: SyncWorkerRequest, transfer: Transferable[]): void
  terminate(): void
}

export interface SyncWorkerHandle {
  worker: SyncWorkerLike
  dispose(): void
}

export type SyncWorkerFactory = () => SyncWorkerHandle | null

export interface SyncComputePort {
  fingerprint(bytes: ArrayBuffer): Promise<string>
  planIndex(input: IndexPlanningInput): Promise<IndexPlan>
  close(): void
}

type PendingResolve = (value: SyncWorkerSuccess) => void

interface PendingRequest {
  resolve: PendingResolve
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 30_000

export class BackgroundSyncCompute implements SyncComputePort {
  private handle: SyncWorkerHandle | null | undefined
  private disabled = false
  private closed = false
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()

  constructor(
    private readonly createWorker: SyncWorkerFactory = createBrowserSyncWorker,
    private readonly fingerprintFallback: (
      bytes: ArrayBuffer,
    ) => Promise<string> = fingerprintOnMainThread,
    private readonly planFallback: (
      input: IndexPlanningInput,
    ) => Promise<IndexPlan> = planIndexCooperatively,
  ) {}

  fingerprint(bytes: ArrayBuffer): Promise<string> {
    if (this.closed) return Promise.reject(new Error("Background sync service is closed"))
    const handle = this.workerHandle()
    if (!handle) return this.fingerprintFallback(bytes)
    return this.request(
      { id: this.nextRequestId(), kind: "fingerprint", bytes },
      [bytes],
      (response) => {
        if (response.kind !== "fingerprint") {
          throw new Error("Background sync worker returned the wrong response")
        }
        return response.fingerprint
      },
    )
  }

  planIndex(input: IndexPlanningInput): Promise<IndexPlan> {
    if (this.closed) return Promise.reject(new Error("Background sync service is closed"))
    const handle = this.workerHandle()
    if (!handle) return this.planFallback(input)
    return this.request({ id: this.nextRequestId(), kind: "plan-index", input }, [], (response) => {
      if (response.kind !== "plan-index") {
        throw new Error("Background sync worker returned the wrong response")
      }
      return response.plan
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.failWorker(new Error("Background sync service stopped"))
  }

  private request<T>(
    request: SyncWorkerRequest,
    transfer: Transferable[],
    select: (response: SyncWorkerSuccess) => T,
  ): Promise<T> {
    const handle = this.handle
    if (!handle) return Promise.reject(new Error("Background sync worker is unavailable"))
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.failWorker(new Error("Background sync worker timed out"))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(request.id, {
        resolve: (response) => {
          try {
            resolve(select(response))
          } catch (error) {
            reject(error instanceof Error ? error : new Error("Invalid background sync result"))
          }
        },
        reject,
        timeout,
      })
      try {
        handle.worker.postMessage(request, transfer)
      } catch (error) {
        const pending = this.pending.get(request.id)
        if (pending) clearTimeout(pending.timeout)
        this.pending.delete(request.id)
        this.disableWorker()
        reject(error instanceof Error ? error : new Error("Unable to start background sync work"))
      }
    })
  }

  private nextRequestId(): number {
    const id = this.nextId
    this.nextId += 1
    return id
  }

  private workerHandle(): SyncWorkerHandle | null {
    if (this.disabled) return null
    if (this.handle !== undefined) return this.handle
    try {
      this.handle = this.createWorker()
    } catch {
      this.handle = null
    }
    if (!this.handle) this.disabled = true
    else {
      this.handle.worker.onmessage = (event) => this.handleMessage(event.data)
      this.handle.worker.onerror = (event) => {
        event.preventDefault()
        this.failWorker(new Error(event.message || "Background sync worker failed"))
      }
    }
    return this.handle
  }

  private handleMessage(value: unknown): void {
    if (!isSyncWorkerResponse(value)) {
      this.failWorker(new Error("Background sync worker returned an invalid response"))
      return
    }
    const pending = this.pending.get(value.id)
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pending.delete(value.id)
    if (value.kind === "error") pending.reject(new Error(value.error))
    else pending.resolve(value)
  }

  private failWorker(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
    this.disableWorker()
  }

  private disableWorker(): void {
    if (this.handle) {
      this.handle.worker.terminate()
      this.handle.dispose()
    }
    this.handle = null
    this.disabled = true
  }
}

export async function planIndexCooperatively(input: IndexPlanningInput): Promise<IndexPlan> {
  const pathByCollisionKey = new Map<string, string>()
  let processed = 0
  for (const path of input.collisionPaths) {
    processed += 1
    if (processed % 100 === 0) await yieldToEventLoop()
    const collisionKey = path.toLocaleLowerCase("en-US")
    const existing = pathByCollisionKey.get(collisionKey)
    if (existing !== undefined && existing !== path) {
      throw new Error(`Case or Unicode path collision: ${existing} and ${path}`)
    }
    pathByCollisionKey.set(collisionKey, path)
  }

  const currentPaths = new Set<string>()
  for (const snapshot of input.current) {
    processed += 1
    if (processed % 100 === 0) await yieldToEventLoop()
    currentPaths.add(snapshot.path)
  }
  const previousPaths = new Set<string>()
  const removed: IndexPlanningSnapshot[] = []
  const removedByFingerprint = new Map<string, IndexPlanningSnapshot[]>()
  for (const snapshot of input.previous) {
    processed += 1
    if (processed % 100 === 0) await yieldToEventLoop()
    previousPaths.add(snapshot.path)
    if (currentPaths.has(snapshot.path)) continue
    removed.push(snapshot)
    const group = removedByFingerprint.get(snapshot.fingerprint) ?? []
    group.push(snapshot)
    removedByFingerprint.set(snapshot.fingerprint, group)
  }

  const consumedRemovals = new Set<string>()
  const renameSources: IndexPlan["renameSources"] = []
  for (const snapshot of input.current) {
    processed += 1
    if (processed % 100 === 0) await yieldToEventLoop()
    if (previousPaths.has(snapshot.path)) continue
    const matches = (removedByFingerprint.get(snapshot.fingerprint) ?? []).filter(
      (candidate) => !consumedRemovals.has(candidate.path),
    )
    if (matches.length !== 1) continue
    const previousPath = matches[0]?.path
    if (!previousPath) continue
    consumedRemovals.add(previousPath)
    renameSources.push({ path: snapshot.path, previousPath })
  }

  return {
    removedPaths: removed.map((snapshot) => snapshot.path),
    renameSources,
  }
}

function createBrowserSyncWorker(): SyncWorkerHandle | null {
  if (
    typeof Worker === "undefined" ||
    typeof Blob === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return null
  }
  const url = URL.createObjectURL(new Blob([SYNC_WORKER_SOURCE], { type: "text/javascript" }))
  try {
    const worker = new Worker(url, { name: "meridian-sync" })
    return {
      worker,
      dispose: () => URL.revokeObjectURL(url),
    }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

function isSyncWorkerResponse(value: unknown): value is SyncWorkerResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  if (typeof response.id !== "number" || !Number.isSafeInteger(response.id)) return false
  if (response.kind === "error") return typeof response.error === "string"
  if (response.kind === "fingerprint") return typeof response.fingerprint === "string"
  if (response.kind !== "plan-index" || !isIndexPlan(response.plan)) return false
  return true
}

function isIndexPlan(value: unknown): value is IndexPlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const plan = value as Record<string, unknown>
  return (
    Array.isArray(plan.removedPaths) &&
    plan.removedPaths.every((path) => typeof path === "string") &&
    Array.isArray(plan.renameSources) &&
    plan.renameSources.every(
      (rename) =>
        typeof rename === "object" &&
        rename !== null &&
        !Array.isArray(rename) &&
        typeof (rename as Record<string, unknown>).path === "string" &&
        typeof (rename as Record<string, unknown>).previousPath === "string",
    )
  )
}

const SYNC_WORKER_SOURCE = `
const planIndex = (input) => {
  const pathByCollisionKey = new Map();
  for (const path of input.collisionPaths) {
    const collisionKey = path.toLocaleLowerCase("en-US");
    const existing = pathByCollisionKey.get(collisionKey);
    if (existing !== undefined && existing !== path) {
      throw new Error(\`Case or Unicode path collision: \${existing} and \${path}\`);
    }
    pathByCollisionKey.set(collisionKey, path);
  }
  const currentPaths = new Set(input.current.map((snapshot) => snapshot.path));
  const previousPaths = new Set(input.previous.map((snapshot) => snapshot.path));
  const removed = input.previous.filter((snapshot) => !currentPaths.has(snapshot.path));
  const removedByFingerprint = new Map();
  for (const snapshot of removed) {
    const group = removedByFingerprint.get(snapshot.fingerprint) ?? [];
    group.push(snapshot);
    removedByFingerprint.set(snapshot.fingerprint, group);
  }
  const consumedRemovals = new Set();
  const renameSources = [];
  for (const snapshot of input.current) {
    if (previousPaths.has(snapshot.path)) continue;
    const matches = (removedByFingerprint.get(snapshot.fingerprint) ?? [])
      .filter((candidate) => !consumedRemovals.has(candidate.path));
    if (matches.length !== 1) continue;
    const previousPath = matches[0].path;
    consumedRemovals.add(previousPath);
    renameSources.push({ path: snapshot.path, previousPath });
  }
  return {
    removedPaths: removed.map((snapshot) => snapshot.path),
    renameSources,
  };
};

self.onmessage = async (event) => {
  const value = event.data;
  if (!value || !Number.isSafeInteger(value.id)) return;
  try {
    if (value.kind === "fingerprint" && value.bytes instanceof ArrayBuffer) {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value.bytes));
      let binary = "";
      for (const byte of digest) binary += String.fromCharCode(byte);
      const fingerprint = btoa(binary)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
      self.postMessage({ id: value.id, kind: "fingerprint", fingerprint });
      return;
    }
    if (value.kind === "plan-index") {
      self.postMessage({ id: value.id, kind: "plan-index", plan: planIndex(value.input) });
      return;
    }
    throw new Error("Unknown background sync request");
  } catch (error) {
    self.postMessage({
      id: value.id,
      kind: "error",
      error: error instanceof Error ? error.message : "Background sync failed",
    });
  }
};
`
