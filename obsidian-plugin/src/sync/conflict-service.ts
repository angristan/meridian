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
import type { JournalPort } from "../storage/contracts"
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
    switch (action) {
      case "keep-current":
        await this.removePreservedCopy(conflict)
        await this.journal.resolveConflict(conflict.id)
        return
      case "keep-both":
        await this.queuePreservedCopy(conflict)
        await this.journal.resolveConflict(conflict.id)
        return
      case "use-incoming":
        await this.usePreservedCopy(conflict, remoteRevision)
        await this.journal.resolveConflict(conflict.id)
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
    await this.journal.removeSnapshot(conflict.conflictPath)
    await this.journal.resolveConflict(conflict.id)
    return true
  }

  private async queuePreservedCopy(conflict: ConflictRecord): Promise<void> {
    const bytes = await this.readRequired(conflict.conflictPath)
    const pending = await this.journal.listPending()
    if (pending.some((entry) => entry.path === conflict.conflictPath)) return
    const snapshots = await this.journal.getSnapshots()
    const existing = snapshots.get(conflict.conflictPath)
    const fileId = existing?.fileId ?? randomId()
    const heads = revisionHeads(await this.journal.listFileRevisions(fileId))
    const entry: JournalEntry = {
      id: randomId(),
      action: "upsert",
      fileId,
      path: conflict.conflictPath,
      previousPath: null,
      fingerprint: await fingerprint(bytes),
      baseRevisionId: heads.length === 1 ? (heads[0]?.revisionId ?? null) : null,
      parentRevisionIds: heads.map((revision) => revision.revisionId),
      restoreSourceRevisionId: null,
      revisionId: randomId(),
      createdAt: nextCreatedAt(pending),
      attempts: 0,
      state: "queued",
      error: null,
      preparedRevision: null,
    }
    await this.journal.putEntry(entry)
    if (!existing) {
      await this.journal.putSnapshot(
        await snapshotFor(conflict.conflictPath, fileId, bytes, this.vault.configDir),
      )
    }
  }

  private async usePreservedCopy(
    conflict: ConflictRecord,
    remoteRevision: LocalRevision,
  ): Promise<void> {
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

      const heads = revisionHeads(await this.journal.listFileRevisions(remoteRevision.fileId))
      const relatedPending = pending.filter((entry) => entry.fileId === remoteRevision.fileId)
      const parents = uniqueIds([
        ...heads.map((revision) => revision.revisionId),
        ...relatedPending.map((entry) => entry.revisionId),
      ])
      const entry: JournalEntry = {
        id: randomId(),
        action: remoteRevision.tombstone ? "restore" : "upsert",
        fileId: remoteRevision.fileId,
        path: conflict.sourcePath,
        previousPath: null,
        fingerprint: desiredFingerprint,
        baseRevisionId: parents.length === 1 ? (parents[0] ?? null) : null,
        parentRevisionIds: parents,
        restoreSourceRevisionId: remoteRevision.revisionId,
        revisionId: randomId(),
        createdAt: nextCreatedAt(pending),
        attempts: 0,
        state: "queued",
        error: null,
        preparedRevision: null,
      }
      await this.journal.putEntry(entry)
      await this.journal.putSnapshot(
        await snapshotFor(conflict.sourcePath, remoteRevision.fileId, bytes, this.vault.configDir),
      )
    }
    await this.removePreservedCopy(conflict, bytes)
  }

  private async removePreservedCopy(
    conflict: ConflictRecord,
    expectedBytes?: ArrayBuffer,
  ): Promise<void> {
    if (!(await this.vault.exists(conflict.conflictPath))) {
      await this.journal.removeSnapshot(conflict.conflictPath)
      return
    }
    const bytes = expectedBytes ?? (await this.vault.read(conflict.conflictPath))
    const removed = await this.vault.replaceIfUnchanged(
      conflict.conflictPath,
      bytes,
      null,
      conflict.kind !== "binary",
    )
    if (!removed) throw new Error("The preserved copy changed while resolving the conflict")
    await this.journal.removeSnapshot(conflict.conflictPath)
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

function nextCreatedAt(entries: JournalEntry[]): number {
  return Math.max(Date.now(), ...entries.map((entry) => entry.createdAt + 1))
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values)].sort()
}
