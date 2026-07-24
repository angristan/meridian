import type { CryptoPort, DeviceKeyMaterial, JournalEntry, RemotePort, VaultPort } from "../model"
import type { JournalPort } from "../storage/journal"
import { snapshotFor } from "./snapshots"

const CHUNK_SIZE = 4 * 1024 * 1024

export class PushEngine {
  constructor(
    private readonly vault: VaultPort,
    private readonly journal: JournalPort,
    private readonly remote: RemotePort,
    private readonly crypto: CryptoPort,
  ) {}

  async push(device: DeviceKeyMaterial): Promise<void> {
    let firstError: Error | null = null
    for (const entry of await this.journal.listPending()) {
      try {
        await this.pushEntry(device, entry)
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        firstError ??= failure
        await this.journal.updateEntry(entry.id, "failed", failure.message)
      }
    }
    if (firstError) throw firstError
  }

  private async pushEntry(device: DeviceKeyMaterial, entry: JournalEntry): Promise<void> {
    const exists = await this.vault.exists(entry.path)
    const action = exists ? (entry.action === "restore" ? "restore" : "upsert") : "delete"
    const bytes = action === "delete" ? null : await this.vault.read(entry.path)
    await this.journal.updateEntry(entry.id, "uploading")
    const encrypted = await this.crypto.encryptRevision(device, {
      operationId: entry.id,
      revisionId: entry.revisionId,
      fileId: entry.fileId,
      action,
      path: entry.path,
      previousPath: entry.previousPath,
      parents: entry.parentRevisionIds,
      bytes,
      chunkSize: CHUNK_SIZE,
    })
    for (const blob of encrypted.blobs.sort((left, right) => left.chunkIndex - right.chunkIndex)) {
      await this.remote.putBlob(blob)
    }
    await this.journal.updateEntry(entry.id, "committing")
    const committed = await this.remote.commit(encrypted.envelope, entry.id)
    await this.journal.setCheckpoint(committed)
    await this.journal.putRevision({
      revisionId: entry.revisionId,
      fileId: entry.fileId,
      path: entry.path,
      parents: entry.parentRevisionIds,
      deviceId: device.deviceId,
      createdAt: entry.createdAt,
      cursor: committed.cursor,
      tombstone: action === "delete",
      isConflict: false,
      operation: { ...committed, envelope: encrypted.envelope },
    })
    if (bytes) {
      await this.journal.putSnapshot(
        await snapshotFor(entry.path, entry.fileId, bytes, this.vault.configDir),
      )
    } else {
      await this.journal.removeSnapshot(entry.path)
    }
    if (entry.previousPath) await this.journal.removeSnapshot(entry.previousPath)
    await this.journal.updateEntry(entry.id, "complete")
  }
}
