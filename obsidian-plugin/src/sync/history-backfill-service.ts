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
    const trustedInitialFormat = device.trustedCheckpoint.initialLogFormat ?? "legacy-http-v1"
    let checkpoint =
      (await this.journal.getHistoryCheckpoint()) ??
      ({
        cursor: 0,
        logHash: toBase64Url(new Uint8Array(32)),
        initialLogFormat: trustedInitialFormat,
        logFormat: trustedInitialFormat,
      } satisfies TrustedCheckpoint)
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
        await this.crypto.verifyOperationLogLink(
          device,
          operation,
          checkpoint.logHash,
          checkpoint.logFormat ?? "legacy-http-v1",
        )
        if (
          operation.cursor === device.trustedCheckpoint.cursor &&
          operation.logHash !== device.trustedCheckpoint.logHash
        ) {
          throw new Error("History conflicts with the signed device checkpoint")
        }
        const inspected = await this.inspectOperation(device, operation, checkpoint)
        if (inspected.revision) {
          await this.journal.putHistoryRevision(inspected.revision)
          added += 1
        }
        checkpoint = {
          cursor: operation.cursor,
          logHash: operation.logHash,
          initialLogFormat: checkpoint.initialLogFormat ?? "legacy-http-v1",
          logFormat: inspected.nextLogFormat ?? checkpoint.logFormat ?? "legacy-http-v1",
        }
        await this.journal.setHistoryCheckpoint(checkpoint)
      }
    }
    return { added, throughCursor: checkpoint.cursor }
  }

  private async inspectOperation(
    device: DeviceKeyMaterial,
    operation: RemoteOperation,
    predecessor: TrustedCheckpoint,
  ): Promise<{
    revision: LocalRevision | null
    nextLogFormat: "canonical-cbor-v1" | null
  }> {
    const type = operationType(operation)
    if (type === "device-revocation") {
      await this.crypto.verifyDeviceRevocation(device, operation)
      return { revision: null, nextLogFormat: null }
    }
    if (type === "log-format-transition") {
      const nextLogFormat = await this.crypto.verifyLogFormatUpgrade(device, operation)
      return { revision: null, nextLogFormat }
    }
    if (type === "key-epoch") {
      await this.crypto.applyEpochTransition(device, operation, predecessor)
      return { revision: null, nextLogFormat: null }
    }
    if (type !== "revision" && type !== "restore" && type !== "tombstone") {
      throw new Error("Complete history contains an unknown operation type")
    }
    const metadata = await this.crypto.inspectRevision(device, operation, Number.MAX_SAFE_INTEGER)
    return {
      revision: {
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
      },
      nextLogFormat: null,
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
