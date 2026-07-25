import type {
  ConfigCategory,
  CryptoPort,
  DeviceKeyMaterial,
  LocalRevision,
  PairingApprovalMaterial,
  PairingCapability,
  PairingDeviceDescriptor,
  PairingStatus,
  RemoteDevice,
  RemotePort,
  SyncReason,
  SyncStatus,
  VaultPort,
} from "../model"
import { INITIAL_STATUS } from "../model"
import type { JournalPort } from "../storage/journal"
import { HistoryService } from "./history-service"
import { OperationApplier } from "./operation-applier"
import { PullEngine } from "./pull-engine"
import { PushEngine } from "./push-engine"
import { Reconciler } from "./reconciler"
import { RevisionLoader } from "./revision-loader"

export class SyncController {
  private readonly reconciler: Reconciler
  private readonly historyService: HistoryService
  private readonly pullEngine: PullEngine
  private readonly pushEngine: PushEngine
  private device: DeviceKeyMaterial | null = null
  private running: Promise<void> | null = null
  private rerun = false
  private authenticated = false
  private stopNotifications: (() => void) | null = null
  private status: SyncStatus = { ...INITIAL_STATUS }

  constructor(
    vault: VaultPort,
    private readonly journal: JournalPort,
    private readonly remote: RemotePort,
    private readonly crypto: CryptoPort,
    private readonly categories: () => Record<ConfigCategory, boolean>,
    private readonly onStatus: (status: SyncStatus) => void,
    private readonly deviceDescriptor: () => PairingDeviceDescriptor = () => ({
      deviceName: "Meridian device",
      platform: "Unknown",
    }),
  ) {
    const revisionLoader = new RevisionLoader(remote, crypto)
    const applier = new OperationApplier(vault, journal, remote, crypto, revisionLoader, categories)
    this.reconciler = new Reconciler(vault, journal)
    this.historyService = new HistoryService(vault, journal, revisionLoader)
    this.pullEngine = new PullEngine(journal, remote, applier)
    this.pushEngine = new PushEngine(vault, journal, remote, crypto)
  }

  async start(device: DeviceKeyMaterial): Promise<void> {
    this.device = device
    await this.journal.open()
    const localCheckpoint = await this.journal.getCheckpoint()
    if (
      localCheckpoint?.cursor === device.trustedCheckpoint.cursor &&
      localCheckpoint.logHash !== device.trustedCheckpoint.logHash
    ) {
      throw new Error("Local checkpoint conflicts with the signed device checkpoint")
    }
    this.updateStatus({
      phase: "idle",
      message: "Ready to sync",
      cursor: await this.journal.getCursor(),
      queued: (await this.journal.listPending()).length,
      error: null,
    })
    this.startNotifications()
    await this.sync("startup")
  }

  stop(): void {
    this.stopNotifications?.()
    this.stopNotifications = null
    this.journal.close()
    this.device = null
    this.authenticated = false
  }

  resume(): Promise<void> {
    this.authenticated = false
    this.startNotifications()
    return this.sync("resume")
  }

  sync(reason: SyncReason): Promise<void> {
    if (!this.device) return Promise.resolve()
    if (this.running) {
      this.rerun = true
      return this.running
    }
    this.running = this.runLoop(reason).finally(() => {
      this.running = null
    })
    return this.running
  }

  getStatus(): SyncStatus {
    return { ...this.status }
  }

  history(path?: string): Promise<LocalRevision[]> {
    return this.historyService.history(path)
  }

  async restoreRevision(revisionId: string): Promise<void> {
    const device = this.requireDevice()
    await this.authenticate(device)
    this.updateStatus(await this.historyService.restore(device, revisionId))
  }

  conflicts() {
    return this.journal.listConflicts(true)
  }

  async resolveConflict(id: string): Promise<void> {
    await this.journal.resolveConflict(id)
  }

  devices(): Promise<RemoteDevice[]> {
    return this.remote.listDevices()
  }

  createPairing(): Promise<PairingCapability> {
    return this.remote.createPairing()
  }

  pairingStatus(pairingId: string): Promise<PairingStatus> {
    return this.remote.getPairingStatus(pairingId)
  }

  async approvePairing(
    pairingId: string,
  ): Promise<{ approval: PairingApprovalMaterial; candidatePackage: string }> {
    const device = this.requireDevice()
    const pairing = await this.remote.getPairingStatus(pairingId)
    if (!pairing.candidatePackage) {
      throw new Error("The joining device has not provided a relayed pairing request")
    }
    const devices = await this.remote.listDevices()
    const approval = await this.crypto.approvePairing(
      device,
      pairing.candidatePackage,
      devices.map((entry) => entry.certificate),
    )
    await this.remote.approvePairing(pairingId, approval.payload)
    return { approval, candidatePackage: pairing.candidatePackage }
  }

  async confirmPairingOwner(pairingId: string): Promise<void> {
    await this.remote.confirmPairingOwner(pairingId)
  }

  async releasePairing(pairingId: string, payload: unknown): Promise<void> {
    await this.remote.releasePairing(pairingId, payload)
  }

  async rejectPairing(pairingId: string): Promise<void> {
    await this.remote.rejectPairing(pairingId)
  }

  async repairLocalIndex(): Promise<void> {
    await this.journal.clearRebuildableState()
    await this.sync("manual")
  }

  private async runLoop(initialReason: SyncReason): Promise<void> {
    let reason = initialReason
    do {
      this.rerun = false
      try {
        await this.runOnce(reason)
      } catch (error) {
        const message = errorMessage(error)
        this.updateStatus({
          phase: networkAvailable() ? "error" : "offline",
          message: networkAvailable()
            ? "Sync needs attention"
            : "Offline — changes are safely queued",
          error: message,
          queued: (await this.journal.listPending()).length,
        })
      }
      reason = "file-event"
    } while (this.rerun)
  }

  private async runOnce(reason: SyncReason): Promise<void> {
    const device = this.requireDevice()
    if (reason !== "notification") {
      this.updateStatus({ phase: "scanning", message: "Checking local changes", error: null })
      const result = await this.reconciler.reconcile(this.categories())
      this.updateStatus({
        queued: (await this.journal.listPending()).length,
        message: `${result.files} files checked`,
      })
    }

    if (!networkAvailable()) throw new Error("No network connection")
    await this.authenticate(device)

    this.updateStatus({ phase: "pulling", message: "Downloading changes" })
    await this.pullEngine.pull(device)
    this.updateStatus({ phase: "pushing", message: "Uploading local changes" })
    await this.pushEngine.push(device)
    this.updateStatus({
      phase: "idle",
      message: "Up to date",
      cursor: await this.journal.getCursor(),
      queued: (await this.journal.listPending()).length,
      lastSyncedAt: Date.now(),
      error: null,
    })
  }

  private async authenticate(device: DeviceKeyMaterial): Promise<void> {
    if (this.authenticated) return
    if (!networkAvailable()) throw new Error("No network connection")
    await this.remote.authenticate(device, this.crypto)
    await this.remote.updateDeviceDescriptor(this.deviceDescriptor())
    this.authenticated = true
    this.startNotifications()
  }

  private startNotifications(): void {
    this.stopNotifications?.()
    this.stopNotifications = null
    if (!this.device || !this.authenticated) return
    void this.journal.getCursor().then((cursor) => {
      if (!this.device || !this.authenticated) return
      this.stopNotifications = this.remote.connectNotifications(
        cursor,
        (hintedCursor) => {
          if (hintedCursor > this.status.cursor) void this.sync("notification")
        },
        (connected) => this.updateStatus({ socketConnected: connected }),
      )
    })
  }

  private requireDevice(): DeviceKeyMaterial {
    if (!this.device) throw new Error("No Meridian device keys are loaded")
    return this.device
  }

  private updateStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch }
    this.onStatus({ ...this.status })
  }
}

function networkAvailable(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
