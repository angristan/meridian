import type {
  CryptoPort,
  DeviceKeyMaterial,
  EpochTransitionMaterial,
  RemotePort,
  SyncStatus,
} from "../model"
import { MeridianHttpError } from "../network/response-parsers"
import type { JournalPort } from "../storage/contracts"

export interface EpochTransitionStore {
  load(): EpochTransitionMaterial | null
  save(material: EpochTransitionMaterial): Promise<void>
  clear(): Promise<void>
}

export class EpochTransitionCoordinator {
  constructor(
    private readonly journal: JournalPort,
    private readonly remote: RemotePort,
    private readonly crypto: CryptoPort,
    private readonly store: EpochTransitionStore | undefined,
    private readonly persistDevice: (device: DeviceKeyMaterial) => Promise<void>,
    private readonly replaceDevice: (device: DeviceKeyMaterial) => void,
    private readonly updateStatus: (patch: Partial<SyncStatus>) => void,
  ) {}

  async resumePrepared(device: DeviceKeyMaterial): Promise<boolean> {
    const pending = this.store?.load()
    if (!pending) return false
    if (device.epochId === pending.nextEpochId) {
      await this.store?.clear()
      return false
    }
    return this.commit(pending)
  }

  async prepareNext(device: DeviceKeyMaterial): Promise<boolean> {
    if (
      !this.store ||
      device.requiredTransitionOperationId !== null ||
      (await this.logFormat(device)) !== "canonical-cbor-v1" ||
      (await this.journal.listPending()).length > 0
    ) {
      return false
    }

    const devices = await this.remote.listDevices()
    const current = devices.find((candidate) => candidate.deviceId === device.deviceId)
    const active = devices.filter((candidate) => candidate.revokedAt === null)
    if (current?.role !== "owner" || active.length === 0) return false

    const revocations = await this.journal.listDeviceRevocations()
    const newestRevocation = revocations.reduce(
      (latest, revocation) => Math.max(latest, revocation.cursor),
      0,
    )
    const reason =
      device.epochSequence === 0
        ? "migration"
        : newestRevocation > device.epochActivatedAtCursor
          ? "revocation"
          : null
    if (reason === null) return false

    const localCheckpoint = (await this.journal.getCheckpoint()) ?? device.trustedCheckpoint
    const refreshed = await this.crypto.refreshTrustedCheckpoint(device, localCheckpoint)
    await this.persistDevice(refreshed)
    this.replaceDevice(refreshed)
    const recovery = await this.remote.getRecoveryPackage()
    const material = await this.crypto.createEpochTransition(
      refreshed,
      active,
      recovery.recoveryStateId,
      reason,
    )
    await this.store.save(material)
    return this.commit(material)
  }

  private async commit(material: EpochTransitionMaterial): Promise<boolean> {
    this.updateStatus({
      phase: "pushing",
      message: "Rotating vault encryption keys",
      error: null,
      progress: null,
    })
    try {
      await this.remote.commit(material.envelope, material.operationId)
    } catch (error) {
      if (
        error instanceof MeridianHttpError &&
        (error.code === "epoch_transition_conflict" || error.code === "epoch_recipient_conflict")
      ) {
        await this.store?.clear()
        return true
      }
      throw error
    }
    return true
  }

  private async logFormat(
    device: DeviceKeyMaterial,
  ): Promise<"legacy-http-v1" | "canonical-cbor-v1"> {
    const checkpoint = (await this.journal.getCheckpoint()) ?? device.trustedCheckpoint
    return checkpoint.logFormat ?? "legacy-http-v1"
  }
}
