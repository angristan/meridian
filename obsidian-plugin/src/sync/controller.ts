import type {
  ConfigCategory,
  CryptoPort,
  DeviceKeyMaterial,
  LocalRevision,
  LogFormat,
  LogFormatUpgradeMaterial,
  PairingApprovalMaterial,
  PairingCapability,
  PairingDeviceDescriptor,
  PairingStatus,
  RemoteDevice,
  RemotePort,
  ScanSyncProgress,
  SelectiveSyncSettings,
  SyncReason,
  SyncStatus,
  VaultPort,
} from "../model"
import { INITIAL_STATUS } from "../model"
import { BackgroundSyncCompute, type SyncComputePort } from "../platform/background-sync"
import { randomId } from "../platform/bytes"
import type { JournalPort } from "../storage/journal"
import { normalizeVaultPath } from "../vault/path-policy"
import { ConflictService } from "./conflict-service"
import { HistoryBackfillService } from "./history-backfill-service"
import { HistoryService } from "./history-service"
import { OperationApplier } from "./operation-applier"
import { PullEngine } from "./pull-engine"
import { PushEngine } from "./push-engine"
import { Reconciler } from "./reconciler"
import { RevisionLoader } from "./revision-loader"

export interface SyncControllerOptions {
  progressThrottleMs?: number
  now?: () => number
  selection?: () => SelectiveSyncSettings
  compute?: SyncComputePort
}

export class SyncController {
  private readonly reconciler: Reconciler
  private readonly historyService: HistoryService
  private readonly historyBackfill: HistoryBackfillService
  private readonly conflictService: ConflictService
  private readonly pullEngine: PullEngine
  private readonly pushEngine: PushEngine
  private device: DeviceKeyMaterial | null = null
  private running: Promise<void> | null = null
  private maintenance: Promise<void> | null = null
  private rerunReason: SyncReason | null = null
  private authenticated = false
  private stopNotifications: (() => void) | null = null
  private stopRequested = false
  private lastProgressEmission = 0
  private readonly progressThrottleMs: number
  private readonly now: () => number
  private readonly compute: SyncComputePort
  private readonly selection: () => SelectiveSyncSettings
  private status: SyncStatus = { ...INITIAL_STATUS }

  constructor(
    private readonly vault: VaultPort,
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
    this.selection = options.selection ?? (() => ({ excludedFolders: [], excludedExtensions: [] }))
    this.compute = options.compute ?? new BackgroundSyncCompute()
    const revisionLoader = new RevisionLoader(remote, crypto, () => vault.maxFileBytes())
    const applier = new OperationApplier(
      vault,
      journal,
      remote,
      crypto,
      revisionLoader,
      categories,
      this.selection,
    )
    this.reconciler = new Reconciler(vault, journal, this.compute)
    this.historyService = new HistoryService(vault, journal, revisionLoader)
    this.historyBackfill = new HistoryBackfillService(journal, remote, crypto)
    this.conflictService = new ConflictService(vault, journal)
    this.pullEngine = new PullEngine(
      journal,
      remote,
      applier,
      (device, operation, previousHash, logFormat) =>
        crypto.verifyOperationLogLink(device, operation, previousHash, logFormat),
    )
    this.pushEngine = new PushEngine(vault, journal, remote, crypto)
  }

  async start(device: DeviceKeyMaterial): Promise<void> {
    this.stopRequested = false
    this.device = device
    await this.journal.open()
    const localCheckpoint = await this.journal.getCheckpoint()
    if (localCheckpoint?.cursor === device.trustedCheckpoint.cursor) {
      const localFormats = {
        initial: localCheckpoint.initialLogFormat ?? "legacy-http-v1",
        current: localCheckpoint.logFormat ?? "legacy-http-v1",
      }
      const trustedFormats = {
        initial: device.trustedCheckpoint.initialLogFormat ?? "legacy-http-v1",
        current: device.trustedCheckpoint.logFormat ?? "legacy-http-v1",
      }
      if (
        localCheckpoint.logHash !== device.trustedCheckpoint.logHash ||
        localFormats.initial !== trustedFormats.initial ||
        localFormats.current !== trustedFormats.current
      ) {
        throw new Error("Local checkpoint conflicts with the signed device checkpoint")
      }
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
    await this.maintenance
    this.finishStop()
  }

  stop(): void {
    this.requestStop()
    const work = [this.running, this.maintenance].filter(
      (promise): promise is Promise<void> => promise !== null,
    )
    if (work.length > 0) void Promise.allSettled(work).then(() => this.finishStop())
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
    if (this.maintenance) {
      return this.maintenance.catch(() => undefined).then(() => this.sync(reason))
    }
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

  async recordVaultChange(path: string): Promise<void> {
    await this.journal.putDirtyPath({
      path: normalizeVaultPath(path),
      token: randomId(),
      observedAt: this.now(),
    })
  }

  async history(path?: string): Promise<LocalRevision[]> {
    await this.ensureCompleteHistory()
    return this.historyService.history(path)
  }

  async activity(limit = 200) {
    const device = this.requireDevice()
    await this.ensureCompleteHistory()
    return this.historyService.activity(device.deviceId, limit)
  }

  async deletedFiles() {
    await this.ensureCompleteHistory()
    return this.historyService.deletedFiles()
  }

  async recoverDeleted(revisionId: string): Promise<void> {
    const device = this.requireDevice()
    await this.authenticate(device)
    await this.runMaintenance(async () => {
      this.updateStatus(await this.historyService.recoverDeleted(device, revisionId))
    })
  }

  async previewRevision(revisionId: string) {
    const device = this.requireDevice()
    await this.authenticate(device)
    return this.historyService.preview(device, revisionId)
  }

  async compareRevisionToCurrent(revisionId: string) {
    const device = this.requireDevice()
    await this.authenticate(device)
    return this.historyService.compareToCurrent(device, revisionId)
  }

  async restoreRevision(revisionId: string): Promise<void> {
    const device = this.requireDevice()
    await this.authenticate(device)
    await this.runMaintenance(async () => {
      this.updateStatus(await this.historyService.restore(device, revisionId))
    })
  }

  conflicts() {
    return this.journal.listConflicts(true)
  }

  conflictDetails(id: string) {
    return this.conflictService.details(id)
  }

  async resolveConflict(
    id: string,
    action: Parameters<ConflictService["resolve"]>[1],
  ): Promise<void> {
    await this.runMaintenance(() => this.conflictService.resolve(id, action))
    this.updateStatus({
      message: "Conflict resolved",
      queued: (await this.journal.listPending()).length,
    })
  }

  async logFormat(): Promise<LogFormat> {
    const checkpoint =
      (await this.journal.getCheckpoint()) ?? this.requireDevice().trustedCheckpoint
    return checkpoint.logFormat ?? "legacy-http-v1"
  }

  async prepareLogFormatUpgrade(): Promise<LogFormatUpgradeMaterial> {
    return this.runMaintenance(async () => {
      const device = this.requireDevice()
      await this.authenticate(device)
      const pending = await this.journal.listPending()
      if (pending.length > 0) {
        throw new Error("Sync all queued changes before upgrading the vault protocol")
      }
      const current = (await this.remote.listDevices()).find(
        (candidate) => candidate.deviceId === device.deviceId,
      )
      if (!current || current.revokedAt !== null || current.role !== "owner") {
        throw new Error("Only the vault owner can upgrade the vault protocol")
      }
      const checkpoint = (await this.journal.getCheckpoint()) ?? device.trustedCheckpoint
      return this.crypto.createLogFormatUpgrade(device, checkpoint)
    })
  }

  async completeLogFormatUpgrade(material: LogFormatUpgradeMaterial): Promise<void> {
    await this.runMaintenance(async () => {
      const device = this.requireDevice()
      await this.authenticate(device)
      await this.remote.commit(material.envelope, material.operationId)
    })
    await this.sync("notification")
    if ((await this.logFormat()) !== "canonical-cbor-v1") {
      throw new Error("Vault protocol upgrade was not confirmed by the operation log")
    }
  }

  async storageUsage() {
    const device = this.requireDevice()
    await this.authenticate(device)
    return this.remote.getStorageUsage()
  }

  async pruneStorage() {
    return this.runMaintenance(async () => {
      const device = this.requireDevice()
      await this.authenticate(device)
      return this.remote.pruneStorage()
    })
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

  async preparePairingApproval(pairingId: string): Promise<{
    approval: PairingApprovalMaterial
    candidatePackage: string
    deviceKeyBundle: string
  }> {
    let prepared:
      | {
          approval: PairingApprovalMaterial
          candidatePackage: string
          deviceKeyBundle: string
        }
      | undefined
    await this.runMaintenance(async () => {
      const current = this.requireDevice()
      const localCheckpoint = (await this.journal.getCheckpoint()) ?? current.trustedCheckpoint
      const device = await this.crypto.refreshTrustedCheckpoint(current, localCheckpoint)
      this.device = device
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
      prepared = {
        approval,
        candidatePackage: pairing.candidatePackage,
        deviceKeyBundle: device.serialized,
      }
    })
    if (!prepared) throw new Error("Pairing approval did not complete")
    return prepared
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

  private async ensureCompleteHistory(): Promise<void> {
    const device = this.requireDevice()
    if (!device.trustedCheckpointAuthorized || !networkAvailable()) return
    await this.authenticate(device)
    await this.historyBackfill.backfill(device)
  }

  private runMaintenance<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopRequested) return Promise.reject(new Error("Meridian sync is paused"))
    const predecessor = this.maintenance ?? this.running ?? Promise.resolve()
    const work = predecessor.then(operation)
    let settled: Promise<void>
    settled = work.then(
      () => undefined,
      () => undefined,
    )
    settled = settled.finally(() => {
      if (this.maintenance === settled) this.maintenance = null
    })
    this.maintenance = settled
    return work
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
          progress: null,
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
    const reconcileOptions = {
      shouldStop: () => this.stopRequested,
      onProgress: (progress: ScanSyncProgress) =>
        this.updateProgress({
          phase: this.stopRequested ? "pausing" : "scanning",
          message: this.stopRequested
            ? "Pausing after the current safe boundary"
            : "Checking local changes",
          progress,
        }),
    }
    const result = requiresFullScan(reason)
      ? await this.reconciler.reconcile(this.categories(), this.selection(), reconcileOptions)
      : await this.reconciler.reconcileDirty(this.categories(), this.selection(), reconcileOptions)
    if (this.stopRequested) return
    const pending = await this.journal.listPending()
    this.updateStatus({
      queued: pending.length,
      message: `${result.files} files checked`,
      progress: null,
    })
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
    this.compute.close()
    this.rerunReason = null
    this.stopNotifications?.()
    this.stopNotifications = null
  }

  private finishStop(): void {
    this.compute.close()
    this.vault.close?.()
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
  if (requiresFullScan(current) || requiresFullScan(incoming)) return "manual"
  if (current === "file-event" && incoming === "file-event") return "file-event"
  return "notification"
}

function requiresFullScan(reason: SyncReason): boolean {
  return reason === "startup" || reason === "resume" || reason === "interval" || reason === "manual"
}

function networkAvailable(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
