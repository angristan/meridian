import { mergeUtf8Text } from "@meridian/sync-engine"
import type {
  BlobTransferProgress,
  ConfigCategory,
  CryptoPort,
  DecryptedRevision,
  DeviceKeyMaterial,
  JournalEntry,
  LocalRevision,
  RemoteOperation,
  RemotePort,
  VaultPort,
} from "../model"
import { fingerprint, randomId } from "../platform/bytes"
import type { JournalPort } from "../storage/journal"
import {
  configCategoryForPath,
  conflictPath,
  isConfigPath,
  isSyncablePath,
} from "../vault/path-policy"
import type { RevisionLoader } from "./revision-loader"
import { snapshotFor } from "./snapshots"

export class OperationApplier {
  constructor(
    private readonly vault: VaultPort,
    private readonly journal: JournalPort,
    private readonly remote: RemotePort,
    private readonly crypto: CryptoPort,
    private readonly revisions: RevisionLoader,
    private readonly categories: () => Record<ConfigCategory, boolean>,
  ) {}

  async apply(
    device: DeviceKeyMaterial,
    operation: RemoteOperation,
    onBlobProgress?: (progress: BlobTransferProgress) => void,
  ): Promise<void> {
    const wire = record(operation.envelope)
    const authorDeviceId = typeof wire?.authorDeviceId === "string" ? wire.authorDeviceId : null
    if (authorDeviceId) {
      const authorRevocation = await this.journal.getDeviceRevocation(authorDeviceId)
      if (authorRevocation && operation.cursor > authorRevocation.cursor) {
        throw new Error("Remote operation was authored after its device was revoked")
      }
    }
    if (wire?.type === "device-revocation") {
      const revocation = await this.crypto.verifyDeviceRevocation(device, operation)
      await this.journal.putDeviceRevocation(revocation)
      return
    }
    if (wire?.type === "key-epoch") {
      throw new Error("Remote epoch transition is not supported by this client")
    }

    const revision = await this.crypto.decryptRevision(
      device,
      operation,
      this.vault.maxFileBytes(),
      (blobId) => this.remote.getBlob(blobId),
      onBlobProgress,
    )
    if (await this.validateRevisionGraph(revision, operation)) return

    const category = configCategoryForPath(revision.path, this.vault.configDir)
    if (isConfigPath(revision.path, this.vault.configDir) && category === null) {
      throw new Error("Remote operation targets an excluded configuration path")
    }
    if (category && !this.categories()[category]) {
      await this.recordRevision(revision, operation, false)
      return
    }
    if (!isSyncablePath(revision.path, this.vault.configDir, this.categories())) {
      throw new Error("Remote operation targets an excluded path")
    }

    const snapshots = await this.journal.getSnapshots()
    const identitySnapshot = [...snapshots.values()].find(
      (snapshot) => snapshot.fileId === revision.fileId,
    )
    const effectiveRevision: DecryptedRevision = {
      ...revision,
      path:
        revision.action === "delete" ? (identitySnapshot?.path ?? revision.path) : revision.path,
      previousPath:
        revision.previousPath ??
        (identitySnapshot && identitySnapshot.path !== revision.path
          ? identitySnapshot.path
          : null),
    }
    const pending = (await this.journal.listPending()).find(
      (entry) => entry.path === effectiveRevision.path || entry.fileId === revision.fileId,
    )
    if (pending) {
      if (await this.tryMergeText(device, effectiveRevision, operation, pending)) return
      await this.materializeConflict(effectiveRevision)
      await this.recordRevision(effectiveRevision, operation, true)
      return
    }

    if (effectiveRevision.action === "delete") {
      await this.vault.remove(effectiveRevision.path)
      await this.journal.removeSnapshot(effectiveRevision.path)
    } else {
      if (!effectiveRevision.bytes) throw new Error("Content revision is missing decrypted bytes")
      await this.vault.write(effectiveRevision.path, effectiveRevision.bytes)
      await this.journal.putSnapshot(
        await snapshotFor(
          effectiveRevision.path,
          effectiveRevision.fileId,
          effectiveRevision.bytes,
          this.vault.configDir,
        ),
      )
      if (
        effectiveRevision.previousPath &&
        effectiveRevision.previousPath !== effectiveRevision.path
      ) {
        await this.vault.remove(effectiveRevision.previousPath)
        await this.journal.removeSnapshot(effectiveRevision.previousPath)
      }
    }
    await this.recordRevision(effectiveRevision, operation, false)
  }

  private async validateRevisionGraph(
    revision: DecryptedRevision,
    operation: RemoteOperation,
  ): Promise<boolean> {
    const existing = await this.journal.getRevision(revision.revisionId)
    if (existing) {
      if (!sameRevision(existing, revision, operation.cursor)) {
        throw new Error(`Revision ID ${revision.revisionId} was reused with different content`)
      }
      return true
    }

    if (new Set(revision.parents).size !== revision.parents.length) {
      throw new Error("Remote revision contains duplicate parents")
    }
    if (revision.parents.includes(revision.revisionId)) {
      throw new Error("Remote revision cannot reference itself as a parent")
    }

    const revisions = await this.journal.listFileRevisions(revision.fileId)
    const byId = new Map(revisions.map((candidate) => [candidate.revisionId, candidate]))
    for (const parentId of revision.parents) {
      const parent = await this.journal.getRevision(parentId)
      if (!parent) throw new Error(`Remote revision parent ${parentId} is unknown`)
      if (parent.fileId !== revision.fileId) {
        throw new Error("Remote revision parent belongs to another file")
      }
      byId.set(parent.revisionId, parent)
    }

    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (revisionId: string): void => {
      if (revisionId === revision.revisionId) {
        throw new Error("Remote revision would create an ancestry cycle")
      }
      if (visited.has(revisionId)) return
      if (visiting.has(revisionId)) throw new Error("Stored revision ancestry contains a cycle")
      const candidate = byId.get(revisionId)
      if (!candidate) throw new Error(`Stored revision parent ${revisionId} is unknown`)
      visiting.add(revisionId)
      for (const parentId of candidate.parents) visit(parentId)
      visiting.delete(revisionId)
      visited.add(revisionId)
    }
    for (const parentId of revision.parents) visit(parentId)
    return false
  }

  private async materializeConflict(revision: DecryptedRevision): Promise<void> {
    const target = conflictPath(
      revision.path,
      revision.authorDeviceId,
      revision.revisionId,
      this.vault.configDir,
    )
    if (revision.action === "delete") {
      if (await this.vault.exists(revision.path)) {
        const localBytes = await this.vault.read(revision.path)
        await this.vault.write(target, localBytes)
        await this.vault.remove(revision.path)
        await this.journal.removeSnapshot(revision.path)
        for (const pending of await this.journal.listPending()) {
          if (pending.path === revision.path) await this.journal.updateEntry(pending.id, "complete")
        }
      }
    } else {
      if (!revision.bytes) throw new Error("Conflict revision is missing decrypted bytes")
      await this.vault.write(target, revision.bytes)
      await this.journal.putSnapshot(
        await snapshotFor(target, randomId(), revision.bytes, this.vault.configDir),
      )
    }
    await this.journal.putConflict({
      id: randomId(),
      sourcePath: revision.path,
      conflictPath: target,
      localRevisionId: (await this.journal.listRevisions(revision.path))[0]?.revisionId ?? null,
      remoteRevisionId: revision.revisionId,
      createdAt: Date.now(),
      kind: isConfigPath(revision.path, this.vault.configDir)
        ? "config"
        : revision.isText
          ? "text"
          : "binary",
      resolvedAt: null,
    })
  }

  private async recordRevision(
    revision: DecryptedRevision,
    operation: RemoteOperation,
    isConflict: boolean,
  ): Promise<void> {
    await this.journal.putRevision({
      revisionId: revision.revisionId,
      fileId: revision.fileId,
      path: revision.path,
      parents: revision.parents,
      deviceId: revision.authorDeviceId,
      createdAt: revision.createdAt,
      cursor: operation.cursor,
      tombstone: revision.action === "delete",
      isConflict,
      operation,
    })
  }

  private async tryMergeText(
    device: DeviceKeyMaterial,
    remoteRevision: DecryptedRevision,
    operation: RemoteOperation,
    pending: JournalEntry,
  ): Promise<boolean> {
    if (
      pending.action !== "upsert" ||
      remoteRevision.action !== "upsert" ||
      !remoteRevision.isText ||
      isConfigPath(remoteRevision.path, this.vault.configDir) ||
      pending.fileId !== remoteRevision.fileId ||
      !pending.baseRevisionId ||
      !remoteRevision.parents.includes(pending.baseRevisionId) ||
      !(await this.vault.exists(pending.path))
    ) {
      return false
    }
    try {
      const baseRecord = await this.journal.getRevision(pending.baseRevisionId)
      if (!baseRecord || baseRecord.tombstone || baseRecord.fileId !== remoteRevision.fileId) {
        return false
      }
      const base = await this.revisions.load(device, baseRecord)
      if (!base.bytes || !remoteRevision.bytes) return false
      const localBytes = await this.vault.read(pending.path)
      const merged = mergeUtf8Text(
        new Uint8Array(base.bytes),
        new Uint8Array(localBytes),
        new Uint8Array(remoteRevision.bytes),
      )
      if (merged.status !== "merged") return false

      const mergedBytes = copyBuffer(merged.content)
      await this.vault.write(pending.path, mergedBytes)
      await this.journal.putEntry({
        ...pending,
        fingerprint: await fingerprint(mergedBytes),
        baseRevisionId: remoteRevision.revisionId,
        parentRevisionIds: [remoteRevision.revisionId],
        state: "queued",
        error: null,
        preparedRevision: null,
      })
      await this.recordRevision(remoteRevision, operation, false)
      return true
    } catch {
      // Missing retained base data or an unavailable old blob makes an automatic merge unsafe.
      return false
    }
  }
}

function sameRevision(
  existing: LocalRevision,
  revision: DecryptedRevision,
  cursor: number,
): boolean {
  return (
    existing.cursor === cursor &&
    existing.fileId === revision.fileId &&
    existing.deviceId === revision.authorDeviceId &&
    existing.tombstone === (revision.action === "delete") &&
    sameIds(existing.parents, revision.parents)
  )
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((value, index) => value === sortedRight[index])
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}
