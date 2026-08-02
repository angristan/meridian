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
  SelectiveSyncSettings,
  TrustedCheckpoint,
  VaultPort,
} from "../model"
import { fingerprint, randomId } from "../platform/bytes"
import type { JournalPort } from "../storage/journal"
import {
  configCategoryForPath,
  conflictPath,
  isConfigPath,
  isSelectedForSync,
  isSyncablePath,
  pathsCollide,
} from "../vault/path-policy"
import { revisionHeads } from "./revision-heads"
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
    private readonly selection: () => SelectiveSyncSettings = () => ({
      excludedFolders: [],
      excludedExtensions: [],
    }),
  ) {}

  async apply(
    device: DeviceKeyMaterial,
    operation: RemoteOperation,
    predecessor: TrustedCheckpoint,
    onBlobProgress?: (progress: BlobTransferProgress) => void,
  ): Promise<DeviceKeyMaterial> {
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
      return device
    }
    if (wire?.type === "log-format-transition") {
      await this.crypto.verifyLogFormatUpgrade(device, operation)
      return device
    }
    if (wire?.type === "key-epoch") {
      const updated = await this.crypto.applyEpochTransition(device, operation, predecessor)
      if (updated.epochId !== device.epochId) await this.journal.invalidatePreparedRevisions()
      return updated
    }

    const revision = await this.crypto.decryptRevision(
      device,
      operation,
      this.vault.maxFileBytes(),
      (blobId) => this.remote.getBlob(blobId),
      onBlobProgress,
    )
    if (await this.validateRevisionGraph(revision, operation)) return device

    const category = configCategoryForPath(revision.path, this.vault.configDir)
    if (isConfigPath(revision.path, this.vault.configDir) && category === null) {
      throw new Error("Remote operation targets an excluded configuration path")
    }
    if (category && !this.categories()[category]) {
      await this.recordRevision(revision, operation, false)
      return device
    }
    if (!isSelectedForSync(revision.path, this.vault.configDir, this.selection())) {
      await this.recordRevision(revision, operation, false)
      return device
    }
    if (!isSyncablePath(revision.path, this.vault.configDir, this.categories())) {
      throw new Error("Remote operation targets an excluded path")
    }

    await this.applyFileRevision(device, revision, operation, 1)
    return device
  }

  private async applyFileRevision(
    device: DeviceKeyMaterial,
    revision: DecryptedRevision,
    operation: RemoteOperation,
    retriesRemaining: number,
  ): Promise<void> {
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
    const targetSnapshot = snapshots.get(effectiveRevision.path)
    if (targetSnapshot && targetSnapshot.fileId !== revision.fileId) {
      if (effectiveRevision.action === "delete") {
        await this.recordRevision(effectiveRevision, operation, false)
        return
      }
      throw new Error(
        `Remote path ${effectiveRevision.path} belongs to another tracked file; rename it locally and retry`,
      )
    }

    let pending: JournalEntry | null =
      (await this.journal.listPending()).find(
        (entry) => entry.path === effectiveRevision.path || entry.fileId === revision.fileId,
      ) ?? null
    let expectedBytes: ArrayBuffer | null = null
    if (!pending && identitySnapshot) {
      const inspected = await this.inspectTrackedFile(identitySnapshot)
      pending = inspected.pending
      expectedBytes = inspected.bytes
    }
    if (pending) {
      if (pending.action === "delete" && effectiveRevision.action === "delete") {
        await this.journal.putEntry({
          ...pending,
          state: "complete",
          error: null,
          preparedRevision: null,
        })
        await this.journal.removeSnapshot(pending.path)
        await this.recordRevision(effectiveRevision, operation, false)
        return
      }
      if (await this.tryMergeText(device, effectiveRevision, operation, pending)) return
      await this.materializeConflict(effectiveRevision)
      await this.recordRevision(effectiveRevision, operation, true)
      return
    }

    if (
      effectiveRevision.action !== "delete" &&
      effectiveRevision.path !== identitySnapshot?.path &&
      !(
        effectiveRevision.previousPath &&
        pathsCollide(effectiveRevision.previousPath, effectiveRevision.path)
      ) &&
      (await this.vault.exists(effectiveRevision.path))
    ) {
      await this.materializeConflict(effectiveRevision)
      await this.recordRevision(effectiveRevision, operation, true)
      return
    }

    let applied = false
    if (effectiveRevision.action === "delete") {
      applied = await this.vault.replaceIfUnchanged(
        effectiveRevision.path,
        expectedBytes,
        null,
        effectiveRevision.isText,
      )
      if (applied) await this.journal.removeSnapshot(effectiveRevision.path)
    } else {
      if (!effectiveRevision.bytes) throw new Error("Content revision is missing decrypted bytes")
      const previousPath = effectiveRevision.previousPath
      if (previousPath && previousPath !== effectiveRevision.path) {
        applied =
          expectedBytes !== null &&
          (await this.vault.renameIfUnchanged(previousPath, effectiveRevision.path, expectedBytes))
        if (applied) {
          applied = await this.vault.replaceIfUnchanged(
            effectiveRevision.path,
            expectedBytes,
            effectiveRevision.bytes,
            effectiveRevision.isText,
          )
        }
      } else {
        applied = await this.vault.replaceIfUnchanged(
          effectiveRevision.path,
          expectedBytes,
          effectiveRevision.bytes,
          effectiveRevision.isText,
        )
      }
      if (applied) {
        await this.journal.putSnapshot(
          await snapshotFor(
            effectiveRevision.path,
            effectiveRevision.fileId,
            effectiveRevision.bytes,
            this.vault.configDir,
          ),
        )
        if (previousPath && previousPath !== effectiveRevision.path) {
          await this.journal.removeSnapshot(previousPath)
        }
      }
    }

    if (!applied) {
      if (retriesRemaining > 0) {
        await this.applyFileRevision(device, revision, operation, retriesRemaining - 1)
        return
      }
      await this.materializeConflict(effectiveRevision)
      await this.recordRevision(effectiveRevision, operation, true)
      return
    }
    await this.recordRevision(effectiveRevision, operation, false)
  }

  private async inspectTrackedFile(snapshot: {
    path: string
    fileId: string
    fingerprint: string
  }): Promise<{ pending: JournalEntry | null; bytes: ArrayBuffer | null }> {
    let bytes: ArrayBuffer | null = null
    if (await this.vault.exists(snapshot.path)) {
      try {
        bytes = await this.vault.read(snapshot.path)
      } catch (error) {
        if (await this.vault.exists(snapshot.path)) throw error
      }
    }
    if (bytes && (await fingerprint(bytes)) === snapshot.fingerprint) {
      return { pending: null, bytes }
    }

    const heads = revisionHeads(await this.journal.listFileRevisions(snapshot.fileId))
    const entry: JournalEntry = {
      id: randomId(),
      action: bytes ? "upsert" : "delete",
      fileId: snapshot.fileId,
      path: snapshot.path,
      previousPath: null,
      fingerprint: bytes ? await fingerprint(bytes) : null,
      baseRevisionId: heads.length === 1 ? (heads[0]?.revisionId ?? null) : null,
      parentRevisionIds: heads.map((head) => head.revisionId),
      restoreSourceRevisionId: null,
      revisionId: randomId(),
      createdAt: Date.now(),
      attempts: 0,
      state: "queued",
      error: null,
      preparedRevision: null,
    }
    await this.journal.putEntry(entry)
    return { pending: entry, bytes }
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
        const removed = await this.vault.replaceIfUnchanged(
          revision.path,
          localBytes,
          null,
          revision.isText,
        )
        if (removed) {
          await this.journal.removeSnapshot(revision.path)
          for (const pending of await this.journal.listPending()) {
            if (pending.path !== revision.path) continue
            await this.journal.putEntry({
              ...pending,
              state: "complete",
              error: null,
              preparedRevision: null,
            })
          }
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
      action: revision.action,
      previousPath: revision.previousPath,
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
      if (!(await this.vault.replaceIfUnchanged(pending.path, localBytes, mergedBytes, true))) {
        return false
      }
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
