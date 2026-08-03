import type {
  DeviceKeyMaterial,
  LogFormat,
  PullSyncProgress,
  RemoteOperation,
  RemotePort,
  TrustedCheckpoint,
} from "../model"
import { yieldToEventLoop } from "../platform/scheduling"
import type { JournalPort } from "../storage/contracts"
import { checkpointFormats, INITIAL_LOG_HASH } from "./checkpoints"
import type { OperationApplier } from "./operation-applier"

export interface PullResult {
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
    let previousHash = startingCheckpoint?.logHash ?? INITIAL_LOG_HASH
    const trustedFormats = checkpointFormats(device.trustedCheckpoint)
    const startingFormats = startingCheckpoint
      ? checkpointFormats(startingCheckpoint)
      : trustedFormats
    const initialLogFormat = startingFormats.initialLogFormat
    let logFormat = startCursor === 0 ? initialLogFormat : startingFormats.logFormat
    let cursor = startCursor
    let targetCursor = startCursor
    let processedSinceYield = 0
    const trustedFloor = device.trustedCheckpoint
    while (true) {
      if (shouldStop()) return { stopped: true, device: currentDevice }
      const changes = await this.remote.getChanges(cursor, await this.journal.getCheckpoint())
      if (changes.latestCursor < cursor || changes.latestCursor < trustedFloor.cursor) {
        throw new Error("Server attempted to roll back the signed checkpoint")
      }
      targetCursor = Math.max(targetCursor, changes.latestCursor)
      if (shouldStop()) return { stopped: true, device: currentDevice }
      onProgress(pullProgress(startCursor, cursor, targetCursor))
      for (const operation of changes.operations) {
        if (shouldStop()) return { stopped: true, device: currentDevice }
        if (operation.cursor !== cursor + 1) {
          throw new Error(`Operation log is discontinuous at cursor ${operation.cursor}`)
        }
        if (
          currentDevice.requiredTransitionOperationId !== null &&
          operationType(operation) !== "key-epoch"
        ) {
          throw new Error("Recovery state requires an epoch transition at the next log cursor")
        }
        await this.verifyLogLink(currentDevice, operation, previousHash, logFormat)
        if (
          operation.cursor === trustedFloor.cursor &&
          operation.logHash !== trustedFloor.logHash
        ) {
          throw new Error("Server history conflicts with the signed checkpoint")
        }
        const predecessor: TrustedCheckpoint = {
          cursor,
          logHash: previousHash,
          initialLogFormat,
          logFormat,
        }
        const nextDevice = await this.applier.apply(currentDevice, operation, predecessor, (blob) =>
          onProgress({
            ...pullProgress(startCursor, cursor, targetCursor),
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
        if (operationType(operation) === "log-format-transition") {
          logFormat = "canonical-cbor-v1"
        }
        cursor = operation.cursor
        previousHash = operation.logHash
        if (cursor === trustedFloor.cursor) {
          const floorFormats = checkpointFormats(trustedFloor)
          if (
            initialLogFormat !== floorFormats.initialLogFormat ||
            logFormat !== floorFormats.logFormat
          ) {
            throw new Error("Server log format conflicts with the signed checkpoint")
          }
        }
        await this.journal.setCheckpoint({
          cursor,
          logHash: operation.logHash,
          initialLogFormat,
          logFormat,
        })
        onProgress(pullProgress(startCursor, cursor, targetCursor))
        processedSinceYield += 1
        if (processedSinceYield >= 25) {
          processedSinceYield = 0
          await yieldToEventLoop()
        }
      }
      if (cursor >= targetCursor) return { stopped: false, device: currentDevice }
      if (changes.operations.length === 0) {
        throw new Error("Server omitted operations before its advertised latest cursor")
      }
    }
  }
}

function operationType(operation: RemoteOperation): string {
  const envelope = operation.envelope
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return ""
  const type = (envelope as Record<string, unknown>).type
  return typeof type === "string" ? type : ""
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
