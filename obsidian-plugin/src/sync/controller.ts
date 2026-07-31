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

export interface SyncControllerOptions {
  progressThrottleMs?: number
  now?: () => number
}

export class SyncController {
  private readonly reconciler: Reconciler
  private readonly historyService: HistoryService
  private readonly pullEngine: PullEngine
  private readonly pushEngine: PushEngine
  private device: DeviceKeyMaterial | null = null
  private running: Promise<void> | null = null
  private rerunReason: SyncReason | null = null
  private authenticated = false
  private stopNotifications: (() => void) | null = null
  private stopRequested = false
  private lastProgressEmission = 0
  private readonly progressThrottleMs: number
  private readonly now: () => number
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
    options: SyncControllerOptions = {},
  ) {
    this.progressThrottleMs = options.progressThrottleMs ?? 200
    this.now = options.now ?? Date.now
    const revisionLoader = new RevisionLoader(remote, crypto, () => vault.maxFileBytes())
    const applier = new OperationApplier(vault, journal, remote, crypto, revisionLoader, categories)
    this.reconciler = new Reconciler(vault, journal)
    this.historyService = new HistoryService(vault, journal, revisionLoader)
    this.pullEngine = new PullEngine(journal, remote, applier)
    this.pushEngine = new PushEngine(vault, journal, remote, crypto)
  }

  async start(device: DeviceKeyMaterial): Promise<void> {
    this.stopRequested = false
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
      progress: null,
    })
    this.startNotifications()
    await this.sync("startup")
  }

  async quiesce(): Promise<void> {
    this.requestStop()
    this.updateStatus({
      phase: "pausing",
      message: "Pausing after the current safe boundary",
      socketConnected: false,
      error: null,
    })
    await this.running
    this.finishStop()
  }

  stop(): void {
    this.requestStop()
    const running = this.running
    if (running) void running.finally(() => this.finishStop())
    else this.finishStop()
  }

  resume(): Promise<void> {
    if (this.stopRequested) return Promise.resolve()
    this.authenticated = false
    this.startNotifications()
    return this.sync("resume")
  }

  sync(reason: SyncReason): Promise<void> {
    if (!this.device || this.stopRequested) return Promise.resolve()
    if (this.running) {
      this.rerunReason = mergeSyncReasons(this.rerunReason, reason)
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

  activity(limit = 200) {
    return this.historyService.activity(this.requireDevice().deviceId, limit)
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

  async devices(): Promise<RemoteDevice[]> {
    const device = this.requireDevice()
    await this.authenticate(device)
    return this.remote.listDevices()
  }

  async revokeDevice(target: RemoteDevice): Promise<void> {
    const device = this.requireDevice()
    if (target.deviceId === device.deviceId) {
      throw new Error("Use Remove this device to revoke the current member identity")
    }
    await this.authenticate(device)
    const revocation = await this.crypto.createDeviceRevocation(device, target)
    await this.remote.revokeDevice(target.deviceId, revocation.envelope)
    await this.sync("device-revocation")
  }

  createPairing(): Promise<PairingCapability> {
    return this.remote.createPairing()
  }

  pairingStatus(pairingId: string): Promise<PairingStatus> {
    return this.remote.getPairingStatus(pairingId)
  }

  async preparePairingApproval(
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
    return { approval, candidatePackage: pairing.candidatePackage }
  }

  async submitPairingApproval(pairingId: string, payload: unknown): Promise<void> {
    await this.remote.approvePairing(pairingId, payload)
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
    await this.journal.clearSnapshots()
    await this.sync("manual")
  }

  private async runLoop(initialReason: SyncReason): Promise<void> {
    let reason: SyncReason | null = initialReason
    while (reason && !this.stopRequested) {
      this.rerunReason = null
      try {
        await this.runOnce(reason)
      } catch (error) {
        if (this.stopRequested) break
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
      reason = this.stopRequested ? null : this.rerunReason
    }
  }

  private async runOnce(reason: SyncReason): Promise<void> {
    const device = this.requireDevice()
    if (this.stopRequested) return
    this.updateStatus({
      phase: "scanning",
      message: "Checking local changes",
      error: null,
      progress: null,
    })
    const result = await this.reconciler.reconcile(this.categories())
    const pending = await this.journal.listPending()
    this.updateStatus({ queued: pending.length, message: `${result.files} files checked` })
    if (reason === "file-event" && result.queued === 0 && pending.length === 0) {
      this.updateStatus({
        phase: "idle",
        message: "Up to date",
        cursor: await this.journal.getCursor(),
        error: null,
      })
      return
    }

    if (!networkAvailable()) throw new Error("No network connection")
    await this.authenticate(device)
    if (this.stopRequested) return

    this.updateStatus({ phase: "pulling", message: "Downloading changes", progress: null })
    const pull = await this.pullEngine.pull(
      device,
      (progress) =>
        this.updateProgress({
          phase: this.stopRequested ? "pausing" : "pulling",
          message: this.stopRequested
            ? "Pausing after the current safe boundary"
            : "Downloading changes",
          cursor: progress.currentCursor,
          progress,
        }),
      () => this.stopRequested,
    )
    if (pull.stopped || this.stopRequested) return

    this.updateStatus({ phase: "pushing", message: "Uploading local changes", progress: null })
    const push = await this.pushEngine.push(
      device,
      (progress) =>
        this.updateProgress({
          phase: this.stopRequested ? "pausing" : "pushing",
          message: this.stopRequested
            ? "Pausing after the current safe boundary"
            : "Uploading local changes",
          cursor: progress.currentCursor,
          queued: Math.max(0, progress.total - progress.succeeded),
          progress,
        }),
      () => this.stopRequested,
    )
    if (push.stopped || this.stopRequested) return
    if (push.committed) {
      this.rerunReason = mergeSyncReasons(this.rerunReason, "notification")
    }
    if (push.error) throw push.error

    this.updateStatus({
      phase: "idle",
      message: "Up to date",
      cursor: await this.journal.getCursor(),
      queued: (await this.journal.listPending()).length,
      lastSyncedAt: Date.now(),
      error: null,
      progress: null,
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
      if (!this.device || !this.authenticated || this.stopRequested) return
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

  private requestStop(): void {
    this.stopRequested = true
    this.rerunReason = null
    this.stopNotifications?.()
    this.stopNotifications = null
  }

  private finishStop(): void {
    this.journal.close()
    this.device = null
    this.authenticated = false
  }

  private updateProgress(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch }
    const now = this.now()
    if (this.progressThrottleMs > 0 && now - this.lastProgressEmission < this.progressThrottleMs) {
      return
    }
    this.lastProgressEmission = now
    this.onStatus({ ...this.status })
  }

  private updateStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch }
    this.onStatus({ ...this.status })
  }
}

function mergeSyncReasons(current: SyncReason | null, incoming: SyncReason): SyncReason {
  if (!current) return incoming
  const requiresScan = current !== "notification" || incoming !== "notification"
  const requiresNetwork = current !== "file-event" || incoming !== "file-event"
  if (requiresScan && requiresNetwork) return "manual"
  return requiresScan ? "file-event" : "notification"
}

function networkAvailable(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
