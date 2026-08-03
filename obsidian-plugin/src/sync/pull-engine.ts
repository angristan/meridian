import type {
  DeviceKeyMaterial,
  LogFormat,
  PullSyncProgress,
  RemoteOperation,
  RemotePort,
} from "../model"
import { yieldToEventLoop } from "../platform/scheduling"
import type { JournalPort } from "../storage/contracts"
import { checkpointFormats, INITIAL_LOG_HASH } from "./checkpoints"
import type { OperationApplier } from "./operation-applier"
import {
  acceptVerifiedLogPage,
  advanceVerifiedLogCursor,
  remoteOperationType,
  verifiedLogCursor,
} from "./verified-log"

interface PullResult {
  stopped: boolean
  device: DeviceKeyMaterial
}

export class PullEngine {
  constructor(
    private readonly journal: JournalPort,
    private readonly remote: RemotePort,
    private readonly applier: OperationApplier,
    private readonly verifyLogLink: (
      device: DeviceKeyMaterial,
      operation: RemoteOperation,
      previousHash: string,
      logFormat: LogFormat,
    ) => Promise<void>,
    private readonly persistDevice: (device: DeviceKeyMaterial) => Promise<void> = async () => {},
  ) {}

  async pull(
    device: DeviceKeyMaterial,
    onProgress: (progress: PullSyncProgress) => void = () => {},
    shouldStop: () => boolean = () => false,
  ): Promise<PullResult> {
    let currentDevice = device
    const startCursor = await this.journal.getCursor()
    const startingCheckpoint = await this.journal.getCheckpoint()
    if (startCursor > 0 && startingCheckpoint?.cursor !== startCursor) {
      throw new Error("Local operation log checkpoint is missing")
    }
    const trustedFormats = checkpointFormats(device.trustedCheckpoint)
    const startingFormats = startingCheckpoint
      ? checkpointFormats(startingCheckpoint)
      : trustedFormats
    let log = verifiedLogCursor({
      cursor: startCursor,
      logHash: startingCheckpoint?.logHash ?? INITIAL_LOG_HASH,
      initialLogFormat: startingFormats.initialLogFormat,
      logFormat: startCursor === 0 ? startingFormats.initialLogFormat : startingFormats.logFormat,
    })
    let processedSinceYield = 0
    const trustedFloor = device.trustedCheckpoint
    while (true) {
      if (shouldStop()) return { stopped: true, device: currentDevice }
      const page = acceptVerifiedLogPage(
        log,
        await this.remote.getChanges(log.checkpoint.cursor, await this.journal.getCheckpoint()),
        trustedFloor,
        false,
      )
      log = page.state
      const targetCursor = log.targetCursor ?? log.checkpoint.cursor
      if (shouldStop()) return { stopped: true, device: currentDevice }
      onProgress(pullProgress(startCursor, log.checkpoint.cursor, targetCursor))
      for (const operation of page.operations) {
        if (shouldStop()) return { stopped: true, device: currentDevice }
        if (
          currentDevice.requiredTransitionOperationId !== null &&
          remoteOperationType(operation) !== "key-epoch"
        ) {
          throw new Error("Recovery state requires an epoch transition at the next log cursor")
        }
        const predecessor = log.checkpoint
        const formats = checkpointFormats(predecessor)
        await this.verifyLogLink(currentDevice, operation, predecessor.logHash, formats.logFormat)
        const nextLog = advanceVerifiedLogCursor(log, operation, trustedFloor)
        const nextDevice = await this.applier.apply(currentDevice, operation, predecessor, (blob) =>
          onProgress({
            ...pullProgress(startCursor, log.checkpoint.cursor, targetCursor),
            currentChunk: blob.completedChunks,
            totalChunks: blob.totalChunks,
            transferredBytes: blob.transferredBytes,
            totalBytes: blob.totalBytes,
          }),
        )
        if (nextDevice.serialized !== currentDevice.serialized) {
          await this.persistDevice(nextDevice)
          currentDevice = nextDevice
        }
        log = nextLog
        await this.journal.setCheckpoint(log.checkpoint)
        onProgress(pullProgress(startCursor, log.checkpoint.cursor, targetCursor))
        processedSinceYield += 1
        if (processedSinceYield >= 25) {
          processedSinceYield = 0
          await yieldToEventLoop()
        }
      }
      if (log.checkpoint.cursor >= targetCursor) {
        return { stopped: false, device: currentDevice }
      }
    }
  }
}

function pullProgress(
  startCursor: number,
  currentCursor: number,
  targetCursor: number,
): PullSyncProgress {
  return {
    kind: "pull",
    startCursor,
    currentCursor,
    targetCursor,
    currentChunk: null,
    totalChunks: null,
    transferredBytes: 0,
    totalBytes: null,
  }
}
