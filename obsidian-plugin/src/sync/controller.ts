import type {
  ConfigCategory,
  CryptoPort,
  DeviceKeyMaterial,
  LocalRevision,
  PairingApproval,
  PairingApprovalMaterial,
  PairingCapability,
  PairingDeviceDescriptor,
  PairingRelease,
  PairingStatus,
  RemoteDevice,
  RemotePort,
  ScanSyncProgress,
  SyncReason,
  SyncStatus,
  TrustedCheckpoint,
  VaultPort,
} from "../model"
import { INITIAL_STATUS } from "../model"
import { MeridianHttpError } from "../network/response-parsers"
import { BackgroundSyncCompute, type SyncComputePort } from "../platform/background-sync"
import { randomId } from "../platform/bytes"
import {
  estimateLocalStorage,
  isQuotaExceededError,
  requestLocalStoragePersistence,
} from "../platform/storage-estimate"
import type { JournalPort } from "../storage/contracts"
import { normalizeVaultPath } from "../vault/path-policy"
import { checkpointFormats } from "./checkpoints"
import { ConflictService } from "./conflict-service"
import {
  EpochTransitionCoordinator,
  type EpochTransitionStore,
} from "./epoch-transition-coordinator"
import { HistoryBackfillService } from "./history-backfill-service"
import { HistoryService } from "./history-service"
import { MissingRevisionAncestryError, OperationApplier } from "./operation-applier"
import { PullEngine } from "./pull-engine"
import { PushEngine } from "./push-engine"
import { Reconciler } from "./reconciler"
import { RevisionLoader } from "./revision-loader"

export interface SyncControllerDependencies {
  vault: VaultPort
  journal: JournalPort
  remote: RemotePort
  crypto: CryptoPort
  categories: () => Record<ConfigCategory, boolean>
  onStatus: (status: SyncStatus) => void
  deviceDescriptor?: () => PairingDeviceDescriptor
}

export interface SyncControllerOptions {
  progressThrottleMs?: number
  now?: () => number
  compute?: SyncComputePort
  persistDevice?: (device: DeviceKeyMaterial) => Promise<void>
  epochTransition?: EpochTransitionStore
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
  private notificationGeneration = 0
  private lastRetentionAcknowledgementKey: string | null | undefined
  private stopRequested = false
  private vaultEventWrites: Promise<void> = Promise.resolve()
  private vaultEventWriteFailed = false
  private lastProgressEmission = 0
  private readonly progressThrottleMs: number
  private readonly now: () => number
  private readonly compute: SyncComputePort
  private readonly epochTransitions: EpochTransitionCoordinator
  private readonly persistDevice: (device: DeviceKeyMaterial) => Promise<void>
  private readonly vault: VaultPort
  private readonly journal: JournalPort
  private readonly remote: RemotePort
  private readonly crypto: CryptoPort
  private readonly categories: () => Record<ConfigCategory, boolean>
  private readonly onStatus: (status: SyncStatus) => void
  private readonly deviceDescriptor: () => PairingDeviceDescriptor
  private status: SyncStatus = { ...INITIAL_STATUS }

  constructor(dependencies: SyncControllerDependencies, options: SyncControllerOptions = {}) {
    const { vault, journal, remote, crypto, categories, onStatus } = dependencies
    this.vault = vault
    this.journal = journal
    this.remote = remote
    this.crypto = crypto
    this.categories = categories
    this.onStatus = onStatus
    this.deviceDescriptor =
      dependencies.deviceDescriptor ??
      (() => ({ deviceName: "Meridian device", platform: "Unknown" }))
    this.progressThrottleMs = options.progressThrottleMs ?? 200
    this.now = options.now ?? Date.now
    this.compute = options.compute ?? new BackgroundSyncCompute()
    this.persistDevice = options.persistDevice ?? (async () => {})
    const revisionLoader = new RevisionLoader(remote, crypto, () => vault.maxFileBytes())
    const applier = new OperationApplier(vault, journal, remote, crypto, revisionLoader, categories)
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
      async (device) => {
        await this.persistDevice(device)
        this.device = device
      },
    )
    this.pushEngine = new PushEngine(vault, journal, remote, crypto)
    this.epochTransitions = new EpochTransitionCoordinator(
      journal,
      remote,
      crypto,
      options.epochTransition,
      this.persistDevice,
      (device) => {
        this.device = device
      },
      (patch) => this.updateStatus(patch),
    )
  }

  async start(device: DeviceKeyMaterial): Promise<void> {
    this.stopRequested = false
    this.device = device
    await this.journal.open()
    await this.journal.compactLocalStorage()
    const localCheckpoint = await this.journal.getCheckpoint()
    if (localCheckpoint?.cursor === device.trustedCheckpoint.cursor) {
      const localFormats = checkpointFormats(localCheckpoint)
      const trustedFormats = checkpointFormats(device.trustedCheckpoint)
      if (
        localCheckpoint.logHash !== device.trustedCheckpoint.logHash ||
        localFormats.initialLogFormat !== trustedFormats.initialLogFormat ||
        localFormats.logFormat !== trustedFormats.logFormat
      ) {
        throw new Error("Local checkpoint conflicts with the signed device checkpoint")
      }
    }
    this.updateStatus({
      phase: "idle",
      message: "Ready to sync",
      cursor: await this.journal.getCursor(),
      queued: (await this.journal.listPending()).length,
      lastSyncedAt: await this.journal.getLastSuccessfulSyncAt(),
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
    await this.vaultEventWrites
    await this.running
    await this.maintenance
    this.finishStop()
  }

  stop(): void {
    this.requestStop()
    void Promise.allSettled([this.vaultEventWrites, this.running, this.maintenance]).then(() =>
      this.finishStop(),
    )
  }

  resume(): Promise<void> {
    if (this.stopRequested) return Promise.resolve()
    this.authenticated = false
    this.startNotifications()
    return this.sync("resume")
  }

  reconnectNotifications(): void {
    if (this.stopRequested || !this.authenticated) return
    this.startNotifications()
  }

  async sync(reason: SyncReason): Promise<void> {
    if (!this.device || this.stopRequested) return
    const eventWriteFailed = await this.drainVaultEvents()
    if (!this.device || this.stopRequested) return
    const effectiveReason = eventWriteFailed ? "manual" : reason
    if (this.maintenance) {
      await this.maintenance.catch(() => undefined)
      return this.sync(effectiveReason)
    }
    if (this.running) {
      this.rerunReason = mergeSyncReasons(this.rerunReason, effectiveReason)
      return this.running
    }
    this.running = this.runLoop(effectiveReason).finally(() => {
      this.running = null
    })
    return this.running
  }

  getStatus(): SyncStatus {
    return { ...this.status }
  }

  async updateDeviceDescriptor(): Promise<void> {
    const device = this.requireDevice()
    if (!this.authenticated) {
      await this.authenticate(device)
      return
    }
    try {
      await this.remote.updateDeviceDescriptor(this.deviceDescriptor())
    } catch (error) {
      this.authenticated = false
      throw error
    }
  }

  recordVaultChange(path: string): Promise<void> {
    if (!this.device || this.stopRequested) return Promise.resolve()
    const write = this.vaultEventWrites.then(() =>
      this.journal.putDirtyPath({
        path: normalizeVaultPath(path),
        token: randomId(),
        observedAt: this.now(),
      }),
    )
    this.vaultEventWrites = write.catch(() => {
      this.vaultEventWriteFailed = true
    })
    return this.vaultEventWrites
  }

  private async drainVaultEvents(): Promise<boolean> {
    const writes = this.vaultEventWrites
    await writes
    const failed = this.vaultEventWriteFailed
    if (this.vaultEventWrites === writes) this.vaultEventWriteFailed = false
    return failed
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

  async storageUsage() {
    const device = this.requireDevice()
    await this.authenticate(device)
    const [remote, local] = await Promise.all([
      this.remote.getStorageUsage(),
      estimateLocalStorage(),
    ])
    return { ...remote, local }
  }

  async compactLocalStorage() {
    return this.runMaintenance(() => this.journal.compactLocalStorage())
  }

  requestPersistentStorage(): Promise<boolean | null> {
    return requestLocalStoragePersistence()
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

  async submitPairingApproval(pairingId: string, payload: PairingApproval): Promise<void> {
    await this.remote.approvePairing(pairingId, payload)
  }

  async confirmPairingOwner(pairingId: string): Promise<void> {
    await this.remote.confirmPairingOwner(pairingId)
  }

  async releasePairing(pairingId: string, payload: PairingRelease): Promise<void> {
    await this.remote.releasePairing(pairingId, payload)
  }

  async rejectPairing(pairingId: string): Promise<void> {
    await this.remote.rejectPairing(pairingId)
  }

  async repairLocalIndex(): Promise<void> {
    await this.runMaintenance(async () => {
      await this.journal.clearSnapshots()
      await this.runLoop("manual")
    })
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
    const previousFailure =
      this.status.phase === "error"
        ? { message: this.status.message, error: this.status.error }
        : null
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
      ? await this.reconciler.reconcile(this.categories(), reconcileOptions)
      : await this.reconciler.reconcileDirty(this.categories(), reconcileOptions)
    if (this.stopRequested) return
    const pending = await this.journal.listPending()
    this.updateStatus({
      queued: pending.length,
      message: `${result.files} files checked`,
      progress: null,
    })
    if (reason === "file-event" && result.queued === 0 && pending.length === 0) {
      if (previousFailure) {
        this.updateStatus({
          phase: "error",
          message: previousFailure.message,
          cursor: await this.journal.getCursor(),
          error: previousFailure.error,
          progress: null,
        })
      } else {
        this.updateStatus({
          phase: "idle",
          message: "Up to date",
          cursor: await this.journal.getCursor(),
          error: null,
        })
      }
      return
    }

    if (!(await this.pullChanges(this.requireDevice()))) return

    this.updateStatus({ phase: "pushing", message: "Uploading local changes", progress: null })
    const push = await this.pushEngine.push(
      this.requireDevice(),
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
    if (!push.committed && (await this.epochTransitions.prepareNext(this.requireDevice()))) {
      this.rerunReason = mergeSyncReasons(this.rerunReason, "notification")
      return
    }

    await this.acknowledgeRetention()
    const lastSyncedAt = this.now()
    await this.journal.setLastSuccessfulSyncAt(lastSyncedAt)
    this.updateStatus({
      phase: "idle",
      message: "Up to date",
      cursor: await this.journal.getCursor(),
      queued: (await this.journal.listPending()).length,
      lastSyncedAt,
      error: null,
      progress: null,
    })
  }

  private async pullChanges(device: DeviceKeyMaterial): Promise<boolean> {
    if (!networkAvailable()) throw new Error("No network connection")
    await this.authenticate(device)
    if (this.stopRequested) return false

    this.updateStatus({ phase: "pulling", message: "Downloading changes", progress: null })
    const pullOnce = () =>
      this.pullEngine.pull(
        this.requireDevice(),
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
    let pull: Awaited<ReturnType<typeof pullOnce>>
    try {
      pull = await pullOnce()
    } catch (error) {
      if (!(error instanceof MissingRevisionAncestryError)) throw error
      this.updateStatus({
        phase: "pulling",
        message: "Repairing local revision history",
        progress: null,
      })
      await this.historyBackfill.backfill(this.requireDevice())
      pull = await pullOnce()
    }
    this.device = pull.device
    if (pull.stopped || this.stopRequested) return false
    await this.conflictService.resolveEquivalent()
    if (await this.epochTransitions.resumePrepared(this.requireDevice())) {
      this.rerunReason = mergeSyncReasons(this.rerunReason, "notification")
      return false
    }
    return true
  }

  private async acknowledgeRetention(): Promise<void> {
    const device = this.requireDevice()
    const checkpoint = (await this.journal.getCheckpoint()) ?? device.trustedCheckpoint
    const acknowledgementKey = retentionAcknowledgementKey(device, checkpoint)
    if (this.lastRetentionAcknowledgementKey === undefined) {
      this.lastRetentionAcknowledgementKey = await this.journal.getLastRetentionAcknowledgementKey()
    }
    if (this.lastRetentionAcknowledgementKey === acknowledgementKey) return

    const acknowledgement = await this.crypto.createRetentionAcknowledgement(device, checkpoint)
    try {
      await this.remote.acknowledgeRetention(acknowledgement)
      await this.journal.setLastRetentionAcknowledgementKey(acknowledgementKey)
      this.lastRetentionAcknowledgementKey = acknowledgementKey
    } catch (error) {
      // A concurrent append or rotation can make an otherwise valid acknowledgement stale. The
      // next notification sync signs the new head; no cleanup boundary advances in the meantime.
      if (
        error instanceof MeridianHttpError &&
        (error.code === "log_mismatch" || error.code === "stale_epoch")
      ) {
        this.rerunReason = mergeSyncReasons(this.rerunReason, "notification")
        return
      }
      throw error
    }
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
    const generation = ++this.notificationGeneration
    this.stopNotifications?.()
    this.stopNotifications = null
    this.updateStatus({ socketConnected: false })
    if (!this.device || !this.authenticated) return
    void this.journal
      .getCursor()
      .then((cursor) => {
        if (
          generation !== this.notificationGeneration ||
          !this.device ||
          !this.authenticated ||
          this.stopRequested
        ) {
          return
        }
        this.stopNotifications = this.remote.connectNotifications(
          cursor,
          (hintedCursor) => {
            if (generation === this.notificationGeneration && hintedCursor > this.status.cursor) {
              void this.sync("notification")
            }
          },
          (connected) => {
            if (generation === this.notificationGeneration) {
              this.updateStatus({ socketConnected: connected })
            }
          },
        )
      })
      .catch(() => {
        if (generation === this.notificationGeneration) {
          this.updateStatus({ socketConnected: false })
        }
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
    this.notificationGeneration += 1
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

function retentionAcknowledgementKey(
  device: DeviceKeyMaterial,
  checkpoint: TrustedCheckpoint,
): string {
  const formats = checkpointFormats(checkpoint)
  return JSON.stringify([
    device.vaultId,
    device.deviceId,
    device.epochId,
    checkpoint.cursor,
    checkpoint.logHash,
    formats.initialLogFormat,
    formats.logFormat,
  ])
}

function networkAvailable(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false
}

function errorMessage(error: unknown): string {
  if (isQuotaExceededError(error)) {
    return "Local browser storage is full. Pending changes were preserved. Open Meridian storage to free disposable records."
  }
  return error instanceof Error ? error.message : String(error)
}
