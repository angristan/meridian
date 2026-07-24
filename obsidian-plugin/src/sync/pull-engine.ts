import type { DeviceKeyMaterial, RemotePort } from "../model"
import type { JournalPort } from "../storage/journal"
import type { OperationApplier } from "./operation-applier"

export class PullEngine {
  constructor(
    private readonly journal: JournalPort,
    private readonly remote: RemotePort,
    private readonly applier: OperationApplier,
  ) {}

  async pull(device: DeviceKeyMaterial): Promise<void> {
    let cursor = await this.journal.getCursor()
    const trustedFloor = device.trustedCheckpoint
    while (true) {
      const changes = await this.remote.getChanges(cursor, await this.journal.getCheckpoint())
      if (changes.latestCursor < cursor || changes.latestCursor < trustedFloor.cursor) {
        throw new Error("Server attempted to roll back the signed checkpoint")
      }
      for (const operation of changes.operations) {
        if (operation.cursor !== cursor + 1) {
          throw new Error(`Operation log is discontinuous at cursor ${operation.cursor}`)
        }
        if (
          operation.cursor === trustedFloor.cursor &&
          operation.logHash !== trustedFloor.logHash
        ) {
          throw new Error("Server history conflicts with the signed checkpoint")
        }
        await this.applier.apply(device, operation)
        cursor = operation.cursor
        await this.journal.setCheckpoint({ cursor, logHash: operation.logHash })
      }
      if (cursor >= changes.latestCursor) return
      if (changes.operations.length === 0) {
        throw new Error("Server omitted operations before its advertised latest cursor")
      }
    }
  }
}
