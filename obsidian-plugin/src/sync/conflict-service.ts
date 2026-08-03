import type {
  ConflictDetails,
  ConflictFilePreview,
  ConflictRecord,
  ConflictResolutionAction,
  JournalEntry,
  LocalRevision,
  VaultPort,
} from "../model"
import { equalBytes, fingerprint, randomId } from "../platform/bytes"
import type { JournalPort, LocalEffectsCommit } from "../storage/contracts"
import { queuedEntry } from "./queued-entry"
import { buildLineDiff } from "./revision-diff"
import { revisionHeads } from "./revision-heads"
import { snapshotFor } from "./snapshots"

const MAX_CONFLICT_PREVIEW_BYTES = 1024 * 1024

export class ConflictService {
  constructor(
    private readonly vault: VaultPort,
    private readonly journal: JournalPort,
  ) {}

  async resolveEquivalent(): Promise<number> {
    const conflicts = await this.journal.listConflicts(true)
    let resolved = 0
    for (const conflict of conflicts) {
      if (await this.resolveEquivalentConflict(conflict)) resolved += 1
    }
    return resolved
  }

  async details(id: string): Promise<ConflictDetails> {
    const conflict = await this.requireConflict(id)
    const remoteRevision = await this.requireRemoteRevision(conflict)
    const current = await this.previewPath(conflict.sourcePath, conflict.kind !== "binary")
    const preserved = await this.previewPath(conflict.conflictPath, conflict.kind !== "binary")
    return {
      conflict,
      incomingDeleted: remoteRevision.tombstone,
      current,
      preserved,
      comparison: compareConflictFiles(conflict.sourcePath, current, preserved, remoteRevision),
    }
  }

  async resolve(id: string, action: ConflictResolutionAction): Promise<void> {
    const conflict = await this.requireConflict(id)
    const remoteRevision = await this.requireRemoteRevision(conflict)
    let effects: LocalEffectsCommit
    let cleanupBytes: ArrayBuffer | undefined
    switch (action) {
      case "keep-current":
        effects = emptyEffects()
        effects.removeSnapshotPaths = await this.removePreservedCopy(conflict)
        break
      case "keep-both":
        effects = await this.queuePreservedCopy(conflict)
        break
      case "use-incoming": {
        const incoming = await this.usePreservedCopy(conflict, remoteRevision)
        effects = incoming.effects
        cleanupBytes = incoming.preservedBytes
        break
      }
    }
    effects.resolvedConflicts.push({ id: conflict.id, resolvedAt: Date.now() })
    await this.journal.commitLocalEffects(effects)
    if (cleanupBytes !== undefined) {
      await this.journal.commitLocalEffects({
        ...emptyEffects(),
        removeSnapshotPaths: await this.removePreservedCopy(conflict, cleanupBytes),
      })
    }
  }

  private async resolveEquivalentConflict(conflict: ConflictRecord): Promise<boolean> {
    const remoteRevision = await this.journal.getRevision(conflict.remoteRevisionId)
    if (!remoteRevision || remoteRevision.tombstone) return false
    if (
      !(await this.vault.exists(conflict.sourcePath)) ||
      !(await this.vault.exists(conflict.conflictPath))
    ) {
      return false
    }

    let versions: [ArrayBuffer, ArrayBuffer]
    try {
      versions = await Promise.all([
        this.vault.read(conflict.sourcePath),
        this.vault.read(conflict.conflictPath),
      ])
    } catch {
      return false
    }
    const [current, preserved] = versions
    if (!(await equalBytes(current, preserved))) return false

    const removed = await this.vault.replaceIfUnchanged(
      conflict.conflictPath,
      preserved,
      null,
      conflict.kind !== "binary",
    )
    if (!removed) return false
    await this.journal.commitLocalEffects({
      entries: [],
      putSnapshots: [],
      removeSnapshotPaths: [conflict.conflictPath],
      resolvedConflicts: [{ id: conflict.id, resolvedAt: Date.now() }],
    })
    return true
  }

  private async queuePreservedCopy(conflict: ConflictRecord): Promise<LocalEffectsCommit> {
    const bytes = await this.readRequired(conflict.conflictPath)
    const pending = await this.journal.listPending()
    if (pending.some((entry) => entry.path === conflict.conflictPath)) return emptyEffects()
    const snapshots = await this.journal.getSnapshots()
    const existing = snapshots.get(conflict.conflictPath)
    const fileId = existing?.fileId ?? randomId()
    const heads = revisionHeads(await this.journal.listRetainedFileRevisions(fileId))
    const entry = queuedEntry({
      action: "upsert",
      fileId,
      path: conflict.conflictPath,
      previousPath: null,
      baseRevisionId: heads.length === 1 ? (heads[0]?.revisionId ?? null) : null,
      parentRevisionIds: heads.map((revision) => revision.revisionId),
      restoreSourceRevisionId: null,
      createdAt: nextCreatedAt(pending),
    })
    return {
      entries: [entry],
      putSnapshots: existing
        ? []
        : [await snapshotFor(conflict.conflictPath, fileId, bytes, this.vault.configDir)],
      removeSnapshotPaths: [],
      resolvedConflicts: [],
    }
  }

  private async usePreservedCopy(
    conflict: ConflictRecord,
    remoteRevision: LocalRevision,
  ): Promise<{ effects: LocalEffectsCommit; preservedBytes: ArrayBuffer }> {
    const bytes = await this.readRequired(conflict.conflictPath)
    const desiredFingerprint = await fingerprint(bytes)
    const pending = await this.journal.listPending()
    const existingResolution = pending.find(
      (entry) =>
        entry.fileId === remoteRevision.fileId &&
        entry.path === conflict.sourcePath &&
        entry.restoreSourceRevisionId === remoteRevision.revisionId,
    )
    if (pending.some((entry) => entry.path === conflict.conflictPath)) {
      throw new Error("The preserved copy is already queued as a separate synchronized file")
    }

    const current = await this.readOptional(conflict.sourcePath)
    const sourceOwner = (await this.journal.getSnapshots()).get(conflict.sourcePath)
    if (sourceOwner?.fileId !== undefined && sourceOwner.fileId !== remoteRevision.fileId) {
      throw new Error("The original path now belongs to another synchronized file")
    }
    if (current !== null && !sourceOwner && !existingResolution) {
      throw new Error(
        "Move the untracked file occupying the original path before using this version",
      )
    }
    if (existingResolution) {
      if (current === null || (await fingerprint(current)) !== desiredFingerprint) {
        throw new Error("The original path changed after conflict resolution was queued")
      }
    } else {
      const replaced = await this.vault.replaceIfUnchanged(
        conflict.sourcePath,
        current,
        bytes,
        conflict.kind !== "binary",
      )
      if (!replaced) throw new Error("The original path changed while resolving the conflict")

      const heads = revisionHeads(
        await this.journal.listRetainedFileRevisions(remoteRevision.fileId),
      )
      const relatedPending = pending.filter((entry) => entry.fileId === remoteRevision.fileId)
      const parents = uniqueIds([
        ...heads.map((revision) => revision.revisionId),
        ...relatedPending.map((entry) => entry.revisionId),
      ])
      const entry = queuedEntry({
        action: remoteRevision.tombstone ? "restore" : "upsert",
        fileId: remoteRevision.fileId,
        path: conflict.sourcePath,
        previousPath: null,
        baseRevisionId: parents.length === 1 ? (parents[0] ?? null) : null,
        parentRevisionIds: parents,
        restoreSourceRevisionId: remoteRevision.revisionId,
        createdAt: nextCreatedAt(pending),
      })
      return {
        effects: {
          entries: [entry],
          putSnapshots: [
            await snapshotFor(
              conflict.sourcePath,
              remoteRevision.fileId,
              bytes,
              this.vault.configDir,
            ),
          ],
          removeSnapshotPaths: [],
          resolvedConflicts: [],
        },
        preservedBytes: bytes,
      }
    }
    return { effects: emptyEffects(), preservedBytes: bytes }
  }

  private async removePreservedCopy(
    conflict: ConflictRecord,
    expectedBytes?: ArrayBuffer,
  ): Promise<string[]> {
    if (!(await this.vault.exists(conflict.conflictPath))) {
      return [conflict.conflictPath]
    }
    const bytes = expectedBytes ?? (await this.vault.read(conflict.conflictPath))
    const removed = await this.vault.replaceIfUnchanged(
      conflict.conflictPath,
      bytes,
      null,
      conflict.kind !== "binary",
    )
    if (!removed) throw new Error("The preserved copy changed while resolving the conflict")
    return [conflict.conflictPath]
  }

  private async previewPath(path: string, expectedText: boolean): Promise<ConflictFilePreview> {
    const bytes = await this.readOptional(path)
    if (bytes === null) {
      return { kind: "missing", byteLength: 0, text: null, truncated: false }
    }
    if (!expectedText) {
      return { kind: "binary", byteLength: bytes.byteLength, text: null, truncated: false }
    }
    const truncated = bytes.byteLength > MAX_CONFLICT_PREVIEW_BYTES
    const visible = truncated ? bytes.slice(0, MAX_CONFLICT_PREVIEW_BYTES) : bytes
    try {
      return {
        kind: "text",
        byteLength: bytes.byteLength,
        text: new TextDecoder("utf-8", { fatal: !truncated }).decode(visible),
        truncated,
      }
    } catch {
      return { kind: "binary", byteLength: bytes.byteLength, text: null, truncated: false }
    }
  }

  private async requireConflict(id: string): Promise<ConflictRecord> {
    const conflict = (await this.journal.listConflicts(true)).find((item) => item.id === id)
    if (!conflict) throw new Error("This conflict is no longer unresolved")
    return conflict
  }

  private async requireRemoteRevision(conflict: ConflictRecord): Promise<LocalRevision> {
    const revision = await this.journal.getRevision(conflict.remoteRevisionId)
    if (!revision) throw new Error("The incoming conflict revision is no longer available")
    return revision
  }

  private async readRequired(path: string): Promise<ArrayBuffer> {
    if (!(await this.vault.exists(path)))
      throw new Error(`The preserved copy at ${path} is missing`)
    return this.vault.read(path)
  }

  private async readOptional(path: string): Promise<ArrayBuffer | null> {
    return (await this.vault.exists(path)) ? this.vault.read(path) : null
  }
}

function compareConflictFiles(
  path: string,
  current: ConflictFilePreview,
  preserved: ConflictFilePreview,
  remoteRevision: LocalRevision,
) {
  if (remoteRevision.tombstone) {
    return {
      path,
      lines: [],
      truncated: false,
      unavailableReason: "The incoming revision deleted this file.",
    }
  }
  if (current.kind !== "text" || preserved.kind !== "text") {
    return {
      path,
      lines: [],
      truncated: current.truncated || preserved.truncated,
      unavailableReason: "A text comparison is not available for these files.",
    }
  }
  if (
    current.truncated ||
    preserved.truncated ||
    current.text === null ||
    preserved.text === null
  ) {
    return {
      path,
      lines: [],
      truncated: true,
      unavailableReason: "These files are too large for an in-app comparison.",
    }
  }
  return { path, ...buildLineDiff(current.text, preserved.text), unavailableReason: null }
}

function emptyEffects(): LocalEffectsCommit {
  return {
    entries: [],
    putSnapshots: [],
    removeSnapshotPaths: [],
    resolvedConflicts: [],
  }
}

function nextCreatedAt(entries: JournalEntry[]): number {
  return Math.max(Date.now(), ...entries.map((entry) => entry.createdAt + 1))
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values)].sort()
}
