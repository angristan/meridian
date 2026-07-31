import type {
  ConfigCategory,
  DirtyPath,
  FileSnapshot,
  JournalEntry,
  ScannedFileSnapshot,
  SelectiveSyncSettings,
  VaultPort,
} from "../model"
import { BackgroundSyncCompute, type SyncComputePort } from "../platform/background-sync"
import { randomId } from "../platform/bytes"
import { yieldToEventLoop } from "../platform/scheduling"
import type { JournalPort } from "../storage/journal"
import { configCategoryForPath, isSelectedForSync } from "../vault/path-policy"
import { revisionHeads } from "./revision-heads"

export interface ReconcileResult {
  queued: number
  files: number
}

export class Reconciler {
  constructor(
    private readonly vault: VaultPort,
    private readonly journal: JournalPort,
    private readonly compute: SyncComputePort = new BackgroundSyncCompute(),
  ) {}

  async reconcile(
    categories: Record<ConfigCategory, boolean>,
    selection: SelectiveSyncSettings = { excludedFolders: [], excludedExtensions: [] },
  ): Promise<ReconcileResult> {
    const dirtyPaths = await this.journal.listDirtyPaths()
    const current = await this.vault.listFiles(categories, selection)
    return this.reconcileScanned(
      current,
      await this.journal.getSnapshots(),
      categories,
      selection,
      null,
      dirtyPaths,
    )
  }

  async reconcileDirty(
    categories: Record<ConfigCategory, boolean>,
    selection: SelectiveSyncSettings = { excludedFolders: [], excludedExtensions: [] },
  ): Promise<ReconcileResult> {
    const dirtyPaths = await this.journal.listDirtyPaths()
    if (dirtyPaths.length === 0) return { queued: 0, files: 0 }

    const scope = new Set(dirtyPaths.map((change) => change.path))
    const [current, previous] = await Promise.all([
      this.vault.scanFiles([...scope], categories, selection),
      this.journal.getSnapshots(),
    ])
    return this.reconcileScanned(current, previous, categories, selection, scope, dirtyPaths)
  }

  private async reconcileScanned(
    current: ScannedFileSnapshot[],
    previous: Map<string, FileSnapshot>,
    categories: Record<ConfigCategory, boolean>,
    selection: SelectiveSyncSettings,
    scope: ReadonlySet<string> | null,
    dirtyPaths: DirtyPath[],
  ): Promise<ReconcileResult> {
    const pendingEntries = await this.journal.listPending()
    const pendingBefore = new Set(pendingEntries.map((entry) => entry.path))
    const pendingPaths = new Set(pendingBefore)
    const pendingByPath = new Map(pendingEntries.map((entry) => [entry.path, entry]))
    const inScope = (path: string) => scope === null || scope.has(path)
    const enabledScopedPrevious = [...previous.values()].filter(
      (snapshot) =>
        inScope(snapshot.path) &&
        snapshotEnabled(snapshot, categories, selection, this.vault.configDir),
    )
    const indexPlan = await this.compute.planIndex({
      current: current.map(({ path, fingerprint }) => ({ path, fingerprint })),
      previous: enabledScopedPrevious.map(({ path, fingerprint }) => ({ path, fingerprint })),
      collisionPaths: [
        ...[...previous.values()]
          .filter(
            (snapshot) =>
              !inScope(snapshot.path) &&
              snapshotEnabled(snapshot, categories, selection, this.vault.configDir),
          )
          .map((snapshot) => snapshot.path),
        ...current.map((snapshot) => snapshot.path),
      ],
    })
    const renameSourceByPath = new Map(
      indexPlan.renameSources.map((rename) => [rename.path, rename.previousPath]),
    )
    const consumedRemovals = new Set(indexPlan.renameSources.map((rename) => rename.previousPath))
    const ignoredPrevious = [...previous.values()].filter(
      (snapshot) =>
        !inScope(snapshot.path) ||
        !snapshotEnabled(snapshot, categories, selection, this.vault.configDir),
    )
    const removed = indexPlan.removedPaths
      .map((path) => previous.get(path))
      .filter((snapshot): snapshot is FileSnapshot => snapshot !== undefined)
    const identifiedCurrent = new Map<string, FileSnapshot>()
    const entries: JournalEntry[] = []
    let processed = 0

    for (const scanned of current) {
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
      processed += 1
      if (processed % 100 === 0) await yieldToEventLoop()
      if (consumedRemovals.has(snapshot.path)) continue
      if (pendingPaths.has(snapshot.path)) continue
      const { baseRevisionId, parentRevisionIds } = await this.revisionAncestry(snapshot.fileId)
      entries.push({
        id: randomId(),
        action: "delete",
        fileId: snapshot.fileId,
        path: snapshot.path,
        previousPath: null,
        fingerprint: null,
        baseRevisionId,
        parentRevisionIds,
        restoreSourceRevisionId: null,
        revisionId: randomId(),
        createdAt: Date.now(),
        attempts: 0,
        state: "queued",
        error: null,
        preparedRevision: null,
      })
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

    await this.journal.commitReconciliation({
      entries,
      putSnapshots: [...nextSnapshots.values()].filter(
        (snapshot) => !sameSnapshot(previous.get(snapshot.path), snapshot),
      ),
      removeSnapshotPaths: [...previous.keys()].filter((path) => !nextSnapshots.has(path)),
      consumeDirtyPaths: dirtyPaths,
    })
    return { queued: entries.length, files: scope?.size ?? current.length }
  }

  private async createUpsert(
    snapshot: FileSnapshot,
    previousPath: string | null,
  ): Promise<JournalEntry> {
    const { baseRevisionId, parentRevisionIds } = await this.revisionAncestry(snapshot.fileId)
    return {
      id: randomId(),
      action: "upsert",
      fileId: snapshot.fileId,
      path: snapshot.path,
      previousPath,
      fingerprint: snapshot.fingerprint,
      baseRevisionId,
      parentRevisionIds,
      restoreSourceRevisionId: null,
      revisionId: randomId(),
      createdAt: Date.now(),
      attempts: 0,
      state: "queued",
      error: null,
      preparedRevision: null,
    }
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
  selection: SelectiveSyncSettings,
  configDir: string,
): boolean {
  if (snapshot.kind === "vault") return isSelectedForSync(snapshot.path, configDir, selection)
  const category = configCategoryForPath(snapshot.path, configDir)
  return category !== null && categories[category]
}
