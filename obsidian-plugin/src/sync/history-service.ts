import type {
  DeviceKeyMaterial,
  JournalEntry,
  LocalRevision,
  SyncActivity,
  VaultPort,
} from "../model"
import { fingerprint, randomId } from "../platform/bytes"
import type { JournalPort } from "../storage/journal"
import { revisionActivity } from "./activity"
import { revisionHeads } from "./revision-heads"
import type { RevisionLoader } from "./revision-loader"
import { snapshotFor } from "./snapshots"

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
    if (path === undefined) return this.journal.listRevisions()
    const snapshots = await this.journal.getSnapshots()
    const fileId =
      snapshots.get(path)?.fileId ?? (await this.journal.listRevisions(path))[0]?.fileId
    return fileId ? this.journal.listFileRevisions(fileId) : []
  }

  async activity(localDeviceId: string, limit = 200): Promise<SyncActivity[]> {
    return revisionActivity(await this.journal.listRevisions(), localDeviceId, limit)
  }

  async restore(device: DeviceKeyMaterial, revisionId: string): Promise<RestoreResult> {
    const source = await this.journal.getRevision(revisionId)
    if (!source) throw new Error("The selected revision is no longer in local history")
    if (source.tombstone) throw new Error("Select a content revision to restore")
    if ((await this.journal.listPending()).some((entry) => entry.fileId === source.fileId)) {
      throw new Error("Sync or resolve the pending change for this file before restoring history")
    }

    const decrypted = await this.revisions.load(device, source)
    if (!decrypted.bytes) throw new Error("The selected revision has no content")
    const heads = revisionHeads(await this.journal.listFileRevisions(source.fileId))
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

  private async readOptional(path: string): Promise<ArrayBuffer | null> {
    return (await this.vault.exists(path)) ? this.vault.read(path) : null
  }
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values)].sort()
}
