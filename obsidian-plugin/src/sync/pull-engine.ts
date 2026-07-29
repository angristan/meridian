import type { DeviceKeyMaterial, PullSyncProgress, RemotePort } from "../model"
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
  ) {}

  async pull(
    device: DeviceKeyMaterial,
    onProgress: (progress: PullSyncProgress) => void = () => {},
    shouldStop: () => boolean = () => false,
  ): Promise<PullResult> {
    const startCursor = await this.journal.getCursor()
    let cursor = startCursor
    let targetCursor = startCursor
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
        await this.journal.setCheckpoint({ cursor, logHash: operation.logHash })
        onProgress(pullProgress(startCursor, cursor, targetCursor))
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
