import type {
  ConfigCategory,
  FileSnapshot,
  JournalEntry,
  ScannedFileSnapshot,
  VaultPort,
} from "../model"
import { randomId } from "../platform/bytes"
import type { JournalPort } from "../storage/journal"
import { configCategoryForPath, pathsCollide } from "../vault/path-policy"
import { revisionHeads } from "./revision-heads"

export interface ReconcileResult {
  queued: number
  files: number
}

export class Reconciler {
  constructor(
    private readonly vault: VaultPort,
    private readonly journal: JournalPort,
  ) {}

  async reconcile(categories: Record<ConfigCategory, boolean>): Promise<ReconcileResult> {
    const current = await this.vault.listFiles(categories)
    assertNoCaseCollisions(current)

    const previous = await this.journal.getSnapshots()
    const pendingEntries = await this.journal.listPending()
    const pendingBefore = new Set(pendingEntries.map((entry) => entry.path))
    const pendingByPath = new Map(pendingEntries.map((entry) => [entry.path, entry]))
    const currentByPath = new Map(current.map((snapshot) => [snapshot.path, snapshot]))
    const ignoredPrevious = [...previous.values()].filter(
      (snapshot) => !categoryEnabled(snapshot, categories, this.vault.configDir),
    )
    const removed = [...previous.values()].filter(
      (snapshot) =>
        categoryEnabled(snapshot, categories, this.vault.configDir) &&
        !currentByPath.has(snapshot.path),
    )
    const removedByFingerprint = groupByFingerprint(removed)
    const consumedRemovals = new Set<string>()
    const identifiedCurrent = new Map<string, FileSnapshot>()
    let queued = 0

    for (const scanned of current) {
      const prior = previous.get(scanned.path)
      const renameSource = !prior
        ? uniqueUnconsumedMatch(removedByFingerprint.get(scanned.fingerprint), consumedRemovals)
        : null
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
      // Reserve a unique rename source even when an earlier run already queued the destination.
      // Otherwise a crash between journaling and snapshot replacement could queue a tombstone for
      // the old path and silently split one file identity into two operations.
      if (renameSource) consumedRemovals.add(renameSource.path)
      if (prior?.fingerprint === snapshot.fingerprint) continue
      if (await this.journal.hasPendingPath(snapshot.path)) continue

      await this.queueUpsert(snapshot, renameSource?.path ?? null)
      queued += 1
    }

    for (const snapshot of removed) {
      if (consumedRemovals.has(snapshot.path)) continue
      if (await this.journal.hasPendingPath(snapshot.path)) continue
      const { baseRevisionId, parentRevisionIds } = await this.revisionAncestry(snapshot.fileId)
      const entry: JournalEntry = {
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
      }
      await this.journal.putEntry(entry)
      queued += 1
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
      if (await this.journal.hasPendingPath(snapshot.path))
        nextSnapshots.set(snapshot.path, snapshot)
    }
    await this.journal.replaceSnapshots([...nextSnapshots.values()])
    return { queued, files: current.length }
  }

  private async queueUpsert(snapshot: FileSnapshot, previousPath: string | null): Promise<void> {
    const { baseRevisionId, parentRevisionIds } = await this.revisionAncestry(snapshot.fileId)
    const entry: JournalEntry = {
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
    await this.journal.putEntry(entry)
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

function categoryEnabled(
  snapshot: FileSnapshot,
  categories: Record<ConfigCategory, boolean>,
  configDir: string,
): boolean {
  if (snapshot.kind === "vault") return true
  const category = configCategoryForPath(snapshot.path, configDir)
  return category !== null && categories[category]
}

function groupByFingerprint(snapshots: FileSnapshot[]): Map<string, FileSnapshot[]> {
  const groups = new Map<string, FileSnapshot[]>()
  for (const snapshot of snapshots) {
    const group = groups.get(snapshot.fingerprint) ?? []
    group.push(snapshot)
    groups.set(snapshot.fingerprint, group)
  }
  return groups
}

function uniqueUnconsumedMatch(
  matches: FileSnapshot[] | undefined,
  consumed: ReadonlySet<string>,
): FileSnapshot | null {
  if (!matches) return null
  const available = matches.filter((snapshot) => !consumed.has(snapshot.path))
  return available.length === 1 ? (available[0] ?? null) : null
}

function assertNoCaseCollisions(snapshots: ScannedFileSnapshot[]): void {
  const sorted = [...snapshots].sort((left, right) => left.path.localeCompare(right.path))
  for (let left = 0; left < sorted.length; left += 1) {
    const candidate = sorted[left]
    if (!candidate) continue
    for (let right = left + 1; right < sorted.length; right += 1) {
      const other = sorted[right]
      if (!other) continue
      if (pathsCollide(candidate.path, other.path) && candidate.path !== other.path) {
        throw new Error(`Case or Unicode path collision: ${candidate.path} and ${other.path}`)
      }
    }
  }
}
