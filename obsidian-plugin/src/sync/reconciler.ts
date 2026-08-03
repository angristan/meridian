import type {
  ConfigCategory,
  DirtyPath,
  FileSnapshot,
  JournalEntry,
  ScannedFileSnapshot,
  ScanSyncProgress,
  VaultPort,
} from "../model"
import { BackgroundSyncCompute, type SyncComputePort } from "../platform/background-sync"
import { randomId } from "../platform/bytes"
import { yieldToEventLoop } from "../platform/scheduling"
import type { JournalPort } from "../storage/contracts"
import { configCategoryForPath } from "../vault/path-policy"
import { queuedEntry } from "./queued-entry"
import { revisionHeads } from "./revision-heads"

export const FINGERPRINT_AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1_000

interface ReconcileResult {
  queued: number
  files: number
}

export interface ReconcileOptions {
  shouldStop?: () => boolean
  onProgress?: (progress: ScanSyncProgress) => void
}

export class Reconciler {
  constructor(
    private readonly vault: VaultPort,
    private readonly journal: JournalPort,
    private readonly compute: SyncComputePort = new BackgroundSyncCompute(),
    private readonly now: () => number = Date.now,
  ) {}

  async reconcile(
    categories: Record<ConfigCategory, boolean>,
    options: ReconcileOptions = {},
  ): Promise<ReconcileResult> {
    const [dirtyPaths, previous, lastFingerprintAuditAt] = await Promise.all([
      this.journal.listDirtyPaths(),
      this.journal.getSnapshots(),
      this.journal.getLastFingerprintAuditAt(),
    ])
    const now = this.now()
    const forceFingerprint =
      lastFingerprintAuditAt !== null &&
      now - lastFingerprintAuditAt >= FINGERPRINT_AUDIT_INTERVAL_MS
    const current = await this.vault.listFiles(categories, {
      ...options,
      fingerprintCache: previous,
      forceFingerprint,
    })
    return this.reconcileScanned(
      current,
      previous,
      categories,
      null,
      dirtyPaths,
      options,
      lastFingerprintAuditAt === null || forceFingerprint ? now : undefined,
    )
  }

  async reconcileDirty(
    categories: Record<ConfigCategory, boolean>,
    options: ReconcileOptions = {},
  ): Promise<ReconcileResult> {
    const dirtyPaths = await this.journal.listDirtyPaths()
    if (dirtyPaths.length === 0) return { queued: 0, files: 0 }

    const scope = new Set(dirtyPaths.map((change) => change.path))
    const [current, previous] = await Promise.all([
      this.vault.scanFiles([...scope], categories, options),
      this.journal.getSnapshots(),
    ])
    return this.reconcileScanned(current, previous, categories, scope, dirtyPaths, options)
  }

  private async reconcileScanned(
    current: ScannedFileSnapshot[],
    previous: ReadonlyMap<string, FileSnapshot>,
    categories: Record<ConfigCategory, boolean>,
    scope: ReadonlySet<string> | null,
    dirtyPaths: DirtyPath[],
    options: ReconcileOptions,
    fingerprintAuditedAt?: number,
  ): Promise<ReconcileResult> {
    if (options.shouldStop?.()) throw new Error("Vault reconciliation canceled")
    const pendingEntries = await this.journal.listPending()
    const pendingBefore = new Set(pendingEntries.map((entry) => entry.path))
    const preparedPendingPaths = new Set(
      pendingEntries.filter((entry) => entry.preparedRevision !== null).map((entry) => entry.path),
    )
    const pendingPaths = new Set(pendingBefore)
    const pendingByPath = new Map(pendingEntries.map((entry) => [entry.path, entry]))
    const inScope = (path: string) => scope === null || scope.has(path)
    const enabledScopedPrevious = [...previous.values()].filter(
      (snapshot) =>
        inScope(snapshot.path) && snapshotEnabled(snapshot, categories, this.vault.configDir),
    )
    const unchangedSnapshots =
      scope === null
        ? await unchangedFullIndex(current, enabledScopedPrevious, options.shouldStop)
        : null
    if (unchangedSnapshots) {
      await this.journal.commitReconciliation({
        entries: [],
        putSnapshots: unchangedSnapshots.filter(
          (snapshot) => !sameSnapshot(previous.get(snapshot.path), snapshot),
        ),
        removeSnapshotPaths: [],
        consumeDirtyPaths: dirtyPaths.filter((change) => !preparedPendingPaths.has(change.path)),
        ...(fingerprintAuditedAt === undefined ? {} : { fingerprintAuditedAt }),
      })
      return { queued: 0, files: current.length }
    }

    const indexPlan = await this.compute.planIndex(
      {
        current: current.map(({ path, fingerprint }) => ({ path, fingerprint })),
        previous: enabledScopedPrevious.map(({ path, fingerprint }) => ({ path, fingerprint })),
        collisionPaths: [
          ...[...previous.values()]
            .filter(
              (snapshot) =>
                !inScope(snapshot.path) &&
                snapshotEnabled(snapshot, categories, this.vault.configDir),
            )
            .map((snapshot) => snapshot.path),
          ...current.map((snapshot) => snapshot.path),
        ],
      },
      options.shouldStop,
    )
    const renameSourceByPath = new Map(
      indexPlan.renameSources.map((rename) => [rename.path, rename.previousPath]),
    )
    const consumedRemovals = new Set(indexPlan.renameSources.map((rename) => rename.previousPath))
    const ignoredPrevious = [...previous.values()].filter(
      (snapshot) =>
        !inScope(snapshot.path) || !snapshotEnabled(snapshot, categories, this.vault.configDir),
    )
    const removed = indexPlan.removedPaths
      .map((path) => previous.get(path))
      .filter((snapshot): snapshot is FileSnapshot => snapshot !== undefined)
    const identifiedCurrent = new Map<string, FileSnapshot>()
    const entries: JournalEntry[] = []
    let processed = 0

    for (const scanned of current) {
      if (options.shouldStop?.()) throw new Error("Vault reconciliation canceled")
      processed += 1
      if (processed % 100 === 0) await yieldToEventLoop()
      const prior = previous.get(scanned.path)
      const renameSourcePath = renameSourceByPath.get(scanned.path)
      const renameSource =
        !prior && renameSourcePath ? (previous.get(renameSourcePath) ?? null) : null
      const exactPathRevision =
        !prior && !renameSource ? (await this.journal.listRevisions(scanned.path))[0] : undefined
      const snapshot: FileSnapshot = {
        ...scanned,
        fileId:
          prior?.fileId ??
          renameSource?.fileId ??
          pendingByPath.get(scanned.path)?.fileId ??
          exactPathRevision?.fileId ??
          randomId(),
      }
      identifiedCurrent.set(snapshot.path, snapshot)
      // The planner reserves each unique rename source once. This remains true when an earlier
      // run already queued the destination, preventing a crash retry from splitting file identity.
      if (prior?.fingerprint === snapshot.fingerprint) continue
      if (pendingPaths.has(snapshot.path)) continue

      entries.push(await this.createUpsert(snapshot, renameSource?.path ?? null))
      pendingPaths.add(snapshot.path)
    }

    for (const snapshot of removed) {
      if (options.shouldStop?.()) throw new Error("Vault reconciliation canceled")
      processed += 1
      if (processed % 100 === 0) await yieldToEventLoop()
      if (consumedRemovals.has(snapshot.path)) continue
      if (pendingPaths.has(snapshot.path)) continue
      const { baseRevisionId, parentRevisionIds } = await this.revisionAncestry(snapshot.fileId)
      entries.push(
        queuedEntry({
          action: "delete",
          fileId: snapshot.fileId,
          path: snapshot.path,
          previousPath: null,
          baseRevisionId,
          parentRevisionIds,
          restoreSourceRevisionId: null,
        }),
      )
      pendingPaths.add(snapshot.path)
    }

    const nextSnapshots = new Map(
      ignoredPrevious.map((snapshot) => [snapshot.path, snapshot] as const),
    )
    for (const [path, snapshot] of identifiedCurrent) nextSnapshots.set(path, snapshot)
    for (const path of pendingBefore) {
      const baseline = previous.get(path)
      if (baseline) nextSnapshots.set(path, baseline)
      else nextSnapshots.delete(path)
    }
    for (const snapshot of removed) {
      if (pendingPaths.has(snapshot.path)) nextSnapshots.set(snapshot.path, snapshot)
    }

    if (options.shouldStop?.()) throw new Error("Vault reconciliation canceled")
    await this.journal.commitReconciliation({
      entries,
      putSnapshots: [...nextSnapshots.values()].filter(
        (snapshot) => !sameSnapshot(previous.get(snapshot.path), snapshot),
      ),
      removeSnapshotPaths: [...previous.keys()].filter((path) => !nextSnapshots.has(path)),
      // A prepared retry may contain older bytes than the current file. Keep its event durable until
      // the pending revision commits, then the mandatory rerun compares the resulting snapshot.
      consumeDirtyPaths: dirtyPaths.filter((change) => !preparedPendingPaths.has(change.path)),
      ...(fingerprintAuditedAt === undefined ? {} : { fingerprintAuditedAt }),
    })
    return { queued: entries.length, files: scope?.size ?? current.length }
  }

  private async createUpsert(
    snapshot: FileSnapshot,
    previousPath: string | null,
  ): Promise<JournalEntry> {
    const { baseRevisionId, parentRevisionIds } = await this.revisionAncestry(snapshot.fileId)
    return queuedEntry({
      action: "upsert",
      fileId: snapshot.fileId,
      path: snapshot.path,
      previousPath,
      baseRevisionId,
      parentRevisionIds,
      restoreSourceRevisionId: null,
    })
  }

  private async revisionAncestry(
    fileId: string,
  ): Promise<{ baseRevisionId: string | null; parentRevisionIds: string[] }> {
    const heads = revisionHeads(await this.journal.listFileRevisions(fileId))
    return {
      baseRevisionId: heads.length === 1 ? (heads[0]?.revisionId ?? null) : null,
      parentRevisionIds: heads.map((revision) => revision.revisionId),
    }
  }
}

async function unchangedFullIndex(
  current: readonly ScannedFileSnapshot[],
  previous: readonly FileSnapshot[],
  shouldStop: () => boolean = () => false,
): Promise<FileSnapshot[] | null> {
  if (current.length !== previous.length) return null
  const previousByPath = new Map(previous.map((snapshot) => [snapshot.path, snapshot]))
  const pathByCollisionKey = new Map<string, string>()
  const snapshots: FileSnapshot[] = []

  for (const [index, snapshot] of current.entries()) {
    if (shouldStop()) throw new Error("Vault reconciliation canceled")
    if (index > 0 && index % 100 === 0) await yieldToEventLoop()
    const collisionKey = snapshot.path.toLocaleLowerCase("en-US")
    const collision = pathByCollisionKey.get(collisionKey)
    if (collision !== undefined && collision !== snapshot.path) {
      throw new Error(`Case or Unicode path collision: ${collision} and ${snapshot.path}`)
    }
    pathByCollisionKey.set(collisionKey, snapshot.path)

    const prior = previousByPath.get(snapshot.path)
    if (!prior || prior.fingerprint !== snapshot.fingerprint) return null
    snapshots.push({ ...snapshot, fileId: prior.fileId })
  }
  return snapshots
}

function sameSnapshot(left: FileSnapshot | undefined, right: FileSnapshot): boolean {
  return (
    left !== undefined &&
    left.fileId === right.fileId &&
    left.fingerprint === right.fingerprint &&
    left.size === right.size &&
    left.mtime === right.mtime &&
    left.kind === right.kind
  )
}

function snapshotEnabled(
  snapshot: FileSnapshot,
  categories: Record<ConfigCategory, boolean>,
  configDir: string,
): boolean {
  if (snapshot.kind === "vault") return true
  const category = configCategoryForPath(snapshot.path, configDir)
  return category !== null && categories[category]
}
