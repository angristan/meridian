import type {
  DeletedFileRecord,
  DeviceKeyMaterial,
  JournalEntry,
  LocalRevision,
  RevisionComparison,
  RevisionPreview,
  SyncActivity,
  VaultPort,
} from "../model"
import { fingerprint, randomId } from "../platform/bytes"
import type { JournalPort } from "../storage/contracts"
import { revisionActivity } from "./activity"
import { buildLineDiff } from "./revision-diff"
import { revisionHeads } from "./revision-heads"
import type { RevisionLoader } from "./revision-loader"
import { snapshotFor } from "./snapshots"

const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024

export interface RestoreResult {
  readonly message: string
  readonly queued: number
}

export class HistoryService {
  constructor(
    private readonly vault: VaultPort,
    private readonly journal: JournalPort,
    private readonly revisions: RevisionLoader,
  ) {}

  async history(path?: string): Promise<LocalRevision[]> {
    const revisions = await this.allRevisions()
    if (path === undefined) return revisions
    const snapshots = await this.journal.getSnapshots()
    const fileId =
      snapshots.get(path)?.fileId ?? revisions.find((item) => item.path === path)?.fileId
    return fileId ? revisions.filter((revision) => revision.fileId === fileId) : []
  }

  async activity(localDeviceId: string, limit = 200): Promise<SyncActivity[]> {
    return revisionActivity(await this.allRevisions(), localDeviceId, limit)
  }

  async deletedFiles(): Promise<DeletedFileRecord[]> {
    const pendingFileIds = new Set((await this.journal.listPending()).map((entry) => entry.fileId))
    const byFile = new Map<string, LocalRevision[]>()
    for (const revision of await this.allRevisions()) {
      const revisions = byFile.get(revision.fileId) ?? []
      revisions.push(revision)
      byFile.set(revision.fileId, revisions)
    }
    const deleted: DeletedFileRecord[] = []
    for (const [fileId, revisions] of byFile) {
      if (pendingFileIds.has(fileId)) continue
      const heads = revisionHeads(revisions)
      if (heads.length === 0 || heads.some((revision) => !revision.tombstone)) continue
      const latest = [...heads].sort(compareRevisionsDescending)[0]
      if (!latest) continue
      const source = nearestContentAncestor(
        heads,
        new Map(revisions.map((item) => [item.revisionId, item])),
      )
      deleted.push({
        fileId,
        path: latest.path,
        deletedRevisionId: latest.revisionId,
        deletedAt: latest.createdAt,
        deviceId: latest.deviceId,
        recoverableRevisionId: source?.revisionId ?? null,
      })
    }
    return deleted.sort((left, right) => right.deletedAt - left.deletedAt)
  }

  async recoverDeleted(device: DeviceKeyMaterial, revisionId: string): Promise<RestoreResult> {
    const deletion = await this.requireRevision(revisionId)
    if (!deletion.tombstone) throw new Error("The selected revision is not a deletion")
    const revisions = await this.fileRevisions(deletion.fileId)
    const heads = revisionHeads(revisions)
    if (heads.length === 0 || heads.some((revision) => !revision.tombstone)) {
      throw new Error("This file is no longer deleted")
    }
    const source = nearestContentAncestor(
      heads,
      new Map(revisions.map((revision) => [revision.revisionId, revision])),
    )
    if (!source) throw new Error("No recoverable content is available for this file")
    return this.restore(device, source.revisionId)
  }

  async preview(device: DeviceKeyMaterial, revisionId: string): Promise<RevisionPreview> {
    const revision = await this.requireRevision(revisionId)
    if (revision.tombstone) {
      return { revision, kind: "deleted", byteLength: 0, text: null, truncated: false }
    }
    const decrypted = await this.revisions.load(device, revision)
    if (!decrypted.bytes) {
      return { revision, kind: "deleted", byteLength: 0, text: null, truncated: false }
    }
    if (!decrypted.isText) {
      return {
        revision,
        kind: "binary",
        byteLength: decrypted.bytes.byteLength,
        text: null,
        truncated: false,
      }
    }
    const truncated = decrypted.bytes.byteLength > MAX_TEXT_PREVIEW_BYTES
    const visible = truncated ? decrypted.bytes.slice(0, MAX_TEXT_PREVIEW_BYTES) : decrypted.bytes
    return {
      revision,
      kind: "text",
      byteLength: decrypted.bytes.byteLength,
      text: new TextDecoder().decode(visible),
      truncated,
    }
  }

  async compareToCurrent(
    device: DeviceKeyMaterial,
    revisionId: string,
  ): Promise<RevisionComparison> {
    const preview = await this.preview(device, revisionId)
    const path = await this.currentPath(preview.revision)
    if (preview.kind !== "text") {
      return {
        path,
        lines: [],
        truncated: false,
        unavailableReason:
          preview.kind === "deleted"
            ? "Deleted revisions have no content."
            : "Binary files cannot be diffed.",
      }
    }
    if (preview.truncated || preview.text === null) {
      return {
        path,
        lines: [],
        truncated: true,
        unavailableReason: "This text file is too large for an in-app diff.",
      }
    }
    if (!(await this.vault.exists(path))) {
      return {
        path,
        lines: [],
        truncated: false,
        unavailableReason: "The file does not currently exist in this vault.",
      }
    }
    const current = await this.vault.read(path)
    if (current.byteLength > MAX_TEXT_PREVIEW_BYTES) {
      return {
        path,
        lines: [],
        truncated: true,
        unavailableReason: "The current file is too large for an in-app diff.",
      }
    }
    let currentText: string
    try {
      currentText = new TextDecoder("utf-8", { fatal: true }).decode(current)
    } catch {
      return {
        path,
        lines: [],
        truncated: false,
        unavailableReason: "The current file is not valid UTF-8 text.",
      }
    }
    const diff = buildLineDiff(preview.text, currentText)
    return { path, ...diff, unavailableReason: null }
  }

  async restore(device: DeviceKeyMaterial, revisionId: string): Promise<RestoreResult> {
    const source = await this.requireRevision(revisionId)
    if (source.tombstone) throw new Error("Select a content revision to restore")
    if ((await this.journal.listPending()).some((entry) => entry.fileId === source.fileId)) {
      throw new Error("Sync or resolve the pending change for this file before restoring history")
    }

    const decrypted = await this.revisions.load(device, source)
    if (!decrypted.bytes) throw new Error("The selected revision has no content")
    const heads = revisionHeads(await this.fileRevisions(source.fileId))
    const snapshots = await this.journal.getSnapshots()
    const currentSnapshot = [...snapshots.values()].find(
      (snapshot) => snapshot.fileId === source.fileId,
    )
    const path = currentSnapshot?.path ?? heads[0]?.path ?? source.path
    const occupant = snapshots.get(path)
    if (occupant && occupant.fileId !== source.fileId) {
      throw new Error(`Restore path ${path} belongs to another tracked file`)
    }
    if (!occupant && (await this.vault.exists(path))) {
      throw new Error(`Restore path ${path} is occupied by an untracked file`)
    }
    const currentBytes = await this.readOptional(path)
    const parents = uniqueIds(heads.map((revision) => revision.revisionId))
    const entry: JournalEntry = {
      id: randomId(),
      action: "restore",
      fileId: source.fileId,
      path,
      previousPath: null,
      fingerprint: await fingerprint(decrypted.bytes),
      baseRevisionId: heads.length === 1 ? (heads[0]?.revisionId ?? null) : null,
      parentRevisionIds: parents,
      restoreSourceRevisionId: source.revisionId,
      revisionId: randomId(),
      createdAt: Date.now(),
      attempts: 0,
      state: "queued",
      error: null,
      preparedRevision: null,
    }
    const replaced = await this.vault.replaceIfUnchanged(
      path,
      currentBytes,
      decrypted.bytes,
      decrypted.isText,
    )
    if (!replaced) throw new Error(`Restore path ${path} changed while preparing the restore`)
    await this.journal.putEntry(entry)
    await this.journal.putSnapshot(
      await snapshotFor(path, source.fileId, decrypted.bytes, this.vault.configDir),
    )
    return {
      message: "Restored revision queued for sync",
      queued: (await this.journal.listPending()).length,
    }
  }

  private async currentPath(source: LocalRevision): Promise<string> {
    const snapshots = await this.journal.getSnapshots()
    const currentSnapshot = [...snapshots.values()].find(
      (snapshot) => snapshot.fileId === source.fileId,
    )
    if (currentSnapshot) return currentSnapshot.path
    return (await this.fileRevisions(source.fileId))[0]?.path ?? source.path
  }

  private async readOptional(path: string): Promise<ArrayBuffer | null> {
    return (await this.vault.exists(path)) ? this.vault.read(path) : null
  }

  private allRevisions(): Promise<LocalRevision[]> {
    return this.journal.listRetainedRevisions()
  }

  private async fileRevisions(fileId: string): Promise<LocalRevision[]> {
    return (await this.allRevisions()).filter((revision) => revision.fileId === fileId)
  }

  private async requireRevision(revisionId: string): Promise<LocalRevision> {
    const revision = await this.journal.getRetainedRevision(revisionId)
    if (!revision) throw new Error("The selected revision is no longer in local history")
    return revision
  }
}

function nearestContentAncestor(
  starts: LocalRevision[],
  byId: ReadonlyMap<string, LocalRevision>,
): LocalRevision | null {
  const visited = new Set(starts.map((revision) => revision.revisionId))
  let frontier = uniqueIds(starts.flatMap((revision) => revision.parents))
  while (frontier.length > 0) {
    const revisions = frontier.flatMap((revisionId) => {
      const revision = byId.get(revisionId)
      return revision ? [revision] : []
    })
    const content = revisions.filter((revision) => !revision.tombstone)
    if (content.length > 0) return content.sort(compareRevisionsDescending)[0] ?? null
    const next: string[] = []
    for (const revision of revisions) {
      visited.add(revision.revisionId)
      for (const parentId of revision.parents) {
        if (!visited.has(parentId)) next.push(parentId)
      }
    }
    frontier = uniqueIds(next)
  }
  return null
}

function compareRevisionsDescending(left: LocalRevision, right: LocalRevision): number {
  return (
    right.createdAt - left.createdAt ||
    (right.cursor ?? -1) - (left.cursor ?? -1) ||
    right.revisionId.localeCompare(left.revisionId)
  )
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values)].sort()
}
