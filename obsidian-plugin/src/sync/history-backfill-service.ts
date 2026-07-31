import type {
  CryptoPort,
  DeviceKeyMaterial,
  LocalRevision,
  RemoteOperation,
  RemotePort,
  TrustedCheckpoint,
} from "../model"
import { toBase64Url } from "../platform/bytes"
import type { JournalPort } from "../storage/journal"

export interface HistoryBackfillResult {
  added: number
  throughCursor: number
}

export class HistoryBackfillService {
  constructor(
    private readonly journal: JournalPort,
    private readonly remote: RemotePort,
    private readonly crypto: CryptoPort,
  ) {}

  async backfill(device: DeviceKeyMaterial): Promise<HistoryBackfillResult> {
    if (!device.trustedCheckpointAuthorized) {
      throw new Error("Re-pair this legacy device before downloading complete history")
    }
    let checkpoint =
      (await this.journal.getHistoryCheckpoint()) ??
      ({ cursor: 0, logHash: toBase64Url(new Uint8Array(32)) } satisfies TrustedCheckpoint)
    let targetCursor: number | null = null
    let added = 0
    while (targetCursor === null || checkpoint.cursor < targetCursor) {
      const page = await this.remote.getChanges(checkpoint.cursor, checkpoint)
      const throughCursor: number = targetCursor === null ? page.latestCursor : targetCursor
      targetCursor = throughCursor
      if (throughCursor < device.trustedCheckpoint.cursor) {
        throw new Error("Server omitted history protected by the signed checkpoint")
      }
      const operations = page.operations.filter((operation) => operation.cursor <= throughCursor)
      if (operations.length === 0 && checkpoint.cursor < throughCursor) {
        throw new Error("Server omitted operations from the history backfill")
      }
      for (const operation of operations) {
        if (operation.cursor !== checkpoint.cursor + 1) {
          throw new Error(`History is discontinuous at cursor ${operation.cursor}`)
        }
        await this.crypto.verifyOperationLogLink(operation, checkpoint.logHash)
        if (
          operation.cursor === device.trustedCheckpoint.cursor &&
          operation.logHash !== device.trustedCheckpoint.logHash
        ) {
          throw new Error("History conflicts with the signed device checkpoint")
        }
        const revision = await this.inspectOperation(device, operation)
        if (revision) {
          await this.journal.putHistoryRevision(revision)
          added += 1
        }
        checkpoint = { cursor: operation.cursor, logHash: operation.logHash }
        await this.journal.setHistoryCheckpoint(checkpoint)
      }
    }
    return { added, throughCursor: checkpoint.cursor }
  }

  private async inspectOperation(
    device: DeviceKeyMaterial,
    operation: RemoteOperation,
  ): Promise<LocalRevision | null> {
    const type = operationType(operation)
    if (type === "device-revocation") {
      await this.crypto.verifyDeviceRevocation(device, operation)
      return null
    }
    if (type === "key-epoch") {
      throw new Error("Complete history contains a key epoch unsupported by this client")
    }
    if (type !== "revision" && type !== "restore" && type !== "tombstone") {
      throw new Error("Complete history contains an unknown operation type")
    }
    const metadata = await this.crypto.inspectRevision(device, operation, Number.MAX_SAFE_INTEGER)
    return {
      revisionId: metadata.revisionId,
      fileId: metadata.fileId,
      path: metadata.path,
      action: metadata.action,
      previousPath: metadata.previousPath,
      parents: metadata.parents,
      deviceId: metadata.authorDeviceId,
      createdAt: metadata.createdAt,
      cursor: operation.cursor,
      tombstone: metadata.action === "delete",
      isConflict: false,
      operation,
    }
  }
}

function operationType(operation: RemoteOperation): string {
  const wire = operation.envelope
  if (typeof wire !== "object" || wire === null || Array.isArray(wire)) {
    throw new Error("History operation is invalid")
  }
  const type = (wire as Record<string, unknown>).type
  if (typeof type !== "string") throw new Error("History operation type is missing")
  return type
}
