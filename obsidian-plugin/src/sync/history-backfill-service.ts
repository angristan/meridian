import type {
  CryptoPort,
  DeviceKeyMaterial,
  DeviceRevocationRecord,
  LocalRevision,
  RemoteOperation,
  RemotePort,
} from "../model"
import type { JournalPort } from "../storage/contracts"
import { checkpointFormats, initialCheckpoint } from "./checkpoints"
import {
  acceptVerifiedLogPage,
  advanceVerifiedLogCursor,
  remoteOperationType,
  verifiedLogCursor,
} from "./verified-log"

interface HistoryBackfillResult {
  added: number
  throughCursor: number
}

export class HistoryBackfillService {
  private running: Promise<HistoryBackfillResult> | null = null

  constructor(
    private readonly journal: JournalPort,
    private readonly remote: RemotePort,
    private readonly crypto: CryptoPort,
  ) {}

  backfill(device: DeviceKeyMaterial): Promise<HistoryBackfillResult> {
    if (this.running) return this.running
    const running = this.runBackfill(device).finally(() => {
      if (this.running === running) this.running = null
    })
    this.running = running
    return running
  }

  private async runBackfill(device: DeviceKeyMaterial): Promise<HistoryBackfillResult> {
    if (!device.trustedCheckpointAuthorized) {
      throw new Error("Re-pair this legacy device before downloading complete history")
    }
    const trustedInitialFormat = checkpointFormats(device.trustedCheckpoint).initialLogFormat
    const liveCheckpoint = await this.journal.getCheckpoint()
    const maximumTargetCursor = liveCheckpoint?.cursor ?? Number.MAX_SAFE_INTEGER
    const revocations = new Map(
      (await this.journal.listDeviceRevocations()).map((record) => [record.deviceId, record]),
    )
    let currentDevice = device
    let log = verifiedLogCursor(
      (await this.journal.getHistoryCheckpoint()) ?? initialCheckpoint(trustedInitialFormat),
    )
    let added = 0
    while (log.targetCursor === null || log.checkpoint.cursor < log.targetCursor) {
      const page = acceptVerifiedLogPage(
        log,
        await this.remote.getChanges(log.checkpoint.cursor, log.checkpoint),
        device.trustedCheckpoint,
        true,
        maximumTargetCursor,
      )
      log = page.state
      for (const operation of page.operations) {
        const formats = checkpointFormats(log.checkpoint)
        await this.crypto.verifyOperationLogLink(
          currentDevice,
          operation,
          log.checkpoint.logHash,
          formats.logFormat,
        )
        const authorDeviceId = operationAuthorDeviceId(operation)
        const authorRevocation = authorDeviceId ? revocations.get(authorDeviceId) : undefined
        if (authorRevocation && operation.cursor > authorRevocation.cursor) {
          throw new Error("Historical operation was authored after its device was revoked")
        }
        const nextLog = advanceVerifiedLogCursor(log, operation, device.trustedCheckpoint)
        const type = remoteOperationType(operation)
        let revision: LocalRevision | null = null
        let revocation: DeviceRevocationRecord | undefined
        if (type === "device-revocation") {
          revocation = await this.crypto.verifyDeviceRevocation(currentDevice, operation)
          revocations.set(revocation.deviceId, revocation)
        } else if (type === "log-format-transition") {
          await this.crypto.verifyLogFormatUpgrade(currentDevice, operation)
        } else if (type === "key-epoch") {
          currentDevice = await this.crypto.applyEpochTransition(
            currentDevice,
            operation,
            log.checkpoint,
          )
        } else {
          revision = await this.inspectFileOperation(currentDevice, operation, type)
        }
        log = nextLog
        await this.journal.commitHistoryOperation(revision, log.checkpoint, revocation)
        if (revision) added += 1
      }
    }
    return { added, throughCursor: log.checkpoint.cursor }
  }

  private async inspectFileOperation(
    device: DeviceKeyMaterial,
    operation: RemoteOperation,
    type: string,
  ): Promise<LocalRevision> {
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

function operationAuthorDeviceId(operation: RemoteOperation): string | null {
  const envelope = operation.envelope
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return null
  const authorDeviceId = (envelope as Record<string, unknown>).authorDeviceId
  return typeof authorDeviceId === "string" ? authorDeviceId : null
}
