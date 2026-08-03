import type {
  CryptoPort,
  DeviceKeyMaterial,
  JournalEntry,
  PushSyncProgress,
  RemotePort,
  TrustedCheckpoint,
  VaultPort,
} from "../model"
import type { JournalPort } from "../storage/journal"
import { uploadBlobsConcurrently } from "./blob-transfer"
import { snapshotFor } from "./snapshots"

const CHUNK_SIZE = 4 * 1024 * 1024

export interface PushResult {
  stopped: boolean
  committed: boolean
  error: Error | null
}

export class PushEngine {
  constructor(
    private readonly vault: VaultPort,
    private readonly journal: JournalPort,
    private readonly remote: RemotePort,
    private readonly crypto: CryptoPort,
  ) {}

  async push(
    device: DeviceKeyMaterial,
    onProgress: (progress: PushSyncProgress) => void = () => {},
    shouldStop: () => boolean = () => false,
  ): Promise<PushResult> {
    const entries = await this.journal.listPending()
    let firstError: Error | null = null
    let committed = false
    let progress: PushSyncProgress = {
      kind: "push",
      processed: 0,
      succeeded: 0,
      failed: 0,
      total: entries.length,
      currentPath: null,
      stage: null,
      currentChunk: null,
      totalChunks: null,
      transferredBytes: 0,
      totalBytes: null,
      currentCursor: await this.journal.getCursor(),
    }
    const emit = (patch: Partial<PushSyncProgress> = {}) => {
      progress = { ...progress, ...patch, kind: "push" }
      onProgress({ ...progress })
    }
    emit()

    for (const entry of entries) {
      if (shouldStop()) return { stopped: true, committed, error: firstError }
      emit({
        currentPath: entry.path,
        stage: "encrypting",
        currentChunk: null,
        totalChunks: null,
        transferredBytes: 0,
        totalBytes: null,
      })
      try {
        const result = await this.pushEntry(device, entry, emit, shouldStop)
        if (result.stopped) return { stopped: true, committed, error: firstError }
        committed = true
        emit({
          processed: progress.processed + 1,
          succeeded: progress.succeeded + 1,
          currentPath: null,
          stage: null,
          currentChunk: null,
          totalChunks: null,
          transferredBytes: 0,
          totalBytes: null,
          currentCursor: result.checkpoint.cursor,
        })
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        firstError ??= failure
        await this.journal.updateEntry(entry.id, "failed", failure.message)
        emit({
          processed: progress.processed + 1,
          failed: progress.failed + 1,
          currentPath: null,
          stage: null,
          currentChunk: null,
          totalChunks: null,
          transferredBytes: 0,
          totalBytes: null,
        })
      }
    }
    return { stopped: false, committed, error: firstError }
  }

  private async pushEntry(
    device: DeviceKeyMaterial,
    entry: JournalEntry,
    onProgress: (patch: Partial<PushSyncProgress>) => void,
    shouldStop: () => boolean,
  ): Promise<{ stopped: true } | { stopped: false; checkpoint: TrustedCheckpoint }> {
    let prepared = entry.preparedRevision
    if (!prepared || prepared.invalidatedByEpoch || prepared.operationIdBound !== true) {
      const rebuild = prepared ?? null
      const exists = rebuild ? rebuild.action !== "delete" : await this.vault.exists(entry.path)
      const action = rebuild
        ? rebuild.action
        : exists
          ? entry.action === "restore"
            ? "restore"
            : "upsert"
          : "delete"
      const bytes = rebuild
        ? rebuild.bytes
        : action === "delete"
          ? null
          : await this.vault.read(entry.path)
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
      prepared = { action, bytes, encrypted, operationIdBound: true }
      await this.journal.putEntry({
        ...entry,
        state: "uploading",
        error: null,
        preparedRevision: prepared,
      })
    } else {
      await this.journal.updateEntry(entry.id, "uploading")
    }
    if (shouldStop()) return { stopped: true }

    const { action, bytes, encrypted } = prepared
    const blobs = [...encrypted.blobs].sort((left, right) => left.chunkIndex - right.chunkIndex)
    const totalBytes = blobs.reduce((total, blob) => total + blob.bytes.byteLength, 0)
    let transferredBytes = 0
    onProgress({
      stage: "uploading",
      currentChunk: 0,
      totalChunks: blobs.length,
      transferredBytes,
      totalBytes,
    })
    await uploadBlobsConcurrently(
      blobs,
      (blob) => this.remote.putBlob(blob),
      (progress) => {
        transferredBytes = progress.transferredBytes
        onProgress({
          currentChunk: progress.completedChunks,
          transferredBytes,
        })
      },
    )

    await this.journal.updateEntry(entry.id, "committing")
    onProgress({ stage: "committing" })
    const committed = await this.remote.commit(encrypted.envelope, entry.id)
    if (bytes) {
      await this.journal.putSnapshot(
        await snapshotFor(entry.path, entry.fileId, bytes, this.vault.configDir),
      )
    } else {
      await this.journal.removeSnapshot(entry.path)
    }
    if (entry.previousPath) await this.journal.removeSnapshot(entry.previousPath)
    // Pull replay treats an existing revision as proof that its local index effects are durable.
    // Keep this marker after every snapshot update so a checkpoint cannot skip partial settlement.
    await this.journal.putRevision({
      revisionId: entry.revisionId,
      fileId: entry.fileId,
      path: entry.path,
      action,
      previousPath: entry.previousPath,
      parents: entry.parentRevisionIds,
      deviceId: device.deviceId,
      createdAt: entry.createdAt,
      cursor: committed.cursor,
      tombstone: action === "delete",
      isConflict: false,
      operation: { ...committed, envelope: encrypted.envelope },
    })
    await this.journal.putEntry({
      ...entry,
      state: "complete",
      error: null,
      preparedRevision: null,
    })
    return { stopped: false, checkpoint: committed }
  }
}
