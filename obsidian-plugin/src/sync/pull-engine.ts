import type { DeviceKeyMaterial, PullSyncProgress, RemoteOperation, RemotePort } from "../model"
import { toBase64Url } from "../platform/bytes"
import { yieldToEventLoop } from "../platform/scheduling"
import type { JournalPort } from "../storage/journal"
import type { OperationApplier } from "./operation-applier"

export interface PullResult {
  stopped: boolean
}

export class PullEngine {
  constructor(
    private readonly journal: JournalPort,
    private readonly remote: RemotePort,
    private readonly applier: OperationApplier,
    private readonly verifyLogLink: (
      operation: RemoteOperation,
      previousHash: string,
    ) => Promise<void>,
  ) {}

  async pull(
    device: DeviceKeyMaterial,
    onProgress: (progress: PullSyncProgress) => void = () => {},
    shouldStop: () => boolean = () => false,
  ): Promise<PullResult> {
    const startCursor = await this.journal.getCursor()
    const startingCheckpoint = await this.journal.getCheckpoint()
    if (startCursor > 0 && startingCheckpoint?.cursor !== startCursor) {
      throw new Error("Local operation log checkpoint is missing")
    }
    let previousHash = startingCheckpoint?.logHash ?? toBase64Url(new Uint8Array(32))
    let cursor = startCursor
    let targetCursor = startCursor
    let processedSinceYield = 0
    const trustedFloor = device.trustedCheckpoint
    while (true) {
      if (shouldStop()) return { stopped: true }
      const changes = await this.remote.getChanges(cursor, await this.journal.getCheckpoint())
      if (changes.latestCursor < cursor || changes.latestCursor < trustedFloor.cursor) {
        throw new Error("Server attempted to roll back the signed checkpoint")
      }
      targetCursor = Math.max(targetCursor, changes.latestCursor)
      if (shouldStop()) return { stopped: true }
      onProgress(pullProgress(startCursor, cursor, targetCursor))
      for (const operation of changes.operations) {
        if (shouldStop()) return { stopped: true }
        if (operation.cursor !== cursor + 1) {
          throw new Error(`Operation log is discontinuous at cursor ${operation.cursor}`)
        }
        await this.verifyLogLink(operation, previousHash)
        if (
          operation.cursor === trustedFloor.cursor &&
          operation.logHash !== trustedFloor.logHash
        ) {
          throw new Error("Server history conflicts with the signed checkpoint")
        }
        await this.applier.apply(device, operation, (blob) =>
          onProgress({
            ...pullProgress(startCursor, cursor, targetCursor),
            currentChunk: blob.completedChunks,
            totalChunks: blob.totalChunks,
            transferredBytes: blob.transferredBytes,
            totalBytes: blob.totalBytes,
          }),
        )
        cursor = operation.cursor
        previousHash = operation.logHash
        await this.journal.setCheckpoint({ cursor, logHash: operation.logHash })
        onProgress(pullProgress(startCursor, cursor, targetCursor))
        processedSinceYield += 1
        if (processedSinceYield >= 25) {
          processedSinceYield = 0
          await yieldToEventLoop()
        }
      }
      if (cursor >= targetCursor) return { stopped: false }
      if (changes.operations.length === 0) {
        throw new Error("Server omitted operations before its advertised latest cursor")
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
