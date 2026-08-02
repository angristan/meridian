import { apiVersion, Notice, Platform, Plugin, TFile } from "obsidian"
import { createPackageCryptoPort } from "./crypto/package-adapter"
import {
  type ConflictDetails,
  type ConflictRecord,
  type ConflictResolutionAction,
  DEFAULT_SETTINGS,
  type DeletedFileRecord,
  INITIAL_STATUS,
  type LocalCompactionResult,
  type LocalRevision,
  type MeridianSettings,
  type PairingInvitation,
  type PairingStatus,
  type RemoteDevice,
  type RevisionComparison,
  type RevisionPreview,
  type StoragePruneResult,
  type StorageUsage,
  type SyncActivity,
  type SyncDiagnostic,
  type SyncStatus,
} from "./model"
import { ObsidianHttpTransport } from "./network/obsidian-transport"
import { MeridianRemoteClient, normalizeEndpoint } from "./network/remote-client"
import { BackgroundSyncCompute } from "./platform/background-sync"
import { connectionControlState } from "./plugin/connection-control"
import { createSanitizedDebugReport, SyncDiagnostics } from "./plugin/diagnostics"
import { PairingCoordinator } from "./plugin/pairing-coordinator"
import { hasConfiguredMeridianIdentity } from "./plugin/pairing-link"
import { registerProtocolHandlers } from "./plugin/protocol-handlers"
import { PluginScheduling } from "./plugin/scheduling"
import { MeridianSecretStorage } from "./plugin/secret-storage"
import {
  defaultDeviceName,
  defaultDevicePlatform,
  MeridianSettingsTab,
  normalizeSettings,
  withoutMeridianIdentity,
} from "./plugin/settings"
import { IndexedDbJournal } from "./storage/journal"
import { SyncController } from "./sync/controller"
import { showQuickStatusMenu, showQuickStatusMenuAtElement } from "./ui/quick-status-menu"
import {
  DeletedFilesModal,
  HistoryModal,
  MeridianStatusView,
  type MeridianUiHost,
  RecoveryConnectModal,
  RecoveryModal,
  STATUS_VIEW_TYPE,
} from "./ui/views"
import { ObsidianVaultPort } from "./vault/obsidian-vault"

export default class MeridianPlugin extends Plugin implements MeridianUiHost {
  override settings: MeridianSettings = structuredClone(DEFAULT_SETTINGS)
  private controller: SyncController | null = null
  private readonly cryptoPort = createPackageCryptoPort()
  private readonly secrets = new MeridianSecretStorage(this.app.secretStorage)
  private readonly pairing = new PairingCoordinator(
    () => this.controller,
    () => this.settings,
    (settings) => {
      this.settings = settings
    },
    () => this.saveSettings(),
    () => this.initializeExistingConnection(),
    this.cryptoPort,
    this.secrets,
  )
  private readonly scheduling = new PluginScheduling(
    this,
    () => this.controller,
    () => this.settings,
  )
  private status: SyncStatus = { ...INITIAL_STATUS }
  private readonly diagnostics = new SyncDiagnostics()
  private statusBar: HTMLElement | null = null
  private pausePromise: Promise<void> | null = null
  private initializationPromise: Promise<void> | null = null
  private initializationKey: string | null = null
  private pluginLoaded = false

  override async onload(): Promise<void> {
    this.pluginLoaded = true
    await this.loadSettings()
    if (!this.settings.deviceName) this.settings.deviceName = defaultDeviceName()

    this.registerView(STATUS_VIEW_TYPE, (leaf) => new MeridianStatusView(leaf, this))
    this.addSettingTab(new MeridianSettingsTab(this.app, this))
    this.addRibbonIcon("cloud-cog", "Open Meridian sync menu", (event) =>
      showQuickStatusMenu(this, event, () => void this.openStatus()),
    )
    if (!Platform.isMobileApp) {
      this.statusBar = this.addStatusBarItem()
      this.statusBar.addClass("meridian-status-bar")
      this.statusBar.setText("Meridian: starting")
      this.statusBar.setAttribute("role", "button")
      this.statusBar.tabIndex = 0
      this.statusBar.setAttribute("aria-label", "Open Meridian sync menu")
      this.registerDomEvent(this.statusBar, "click", (event) =>
        showQuickStatusMenu(this, event, () => void this.openStatus()),
      )
      this.registerDomEvent(this.statusBar, "keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        if (this.statusBar) {
          showQuickStatusMenuAtElement(this, this.statusBar, () => void this.openStatus())
        }
      })
    }

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow() })
    this.addCommand({
      id: "open-status",
      name: "Open sync status",
      callback: () => void this.openStatus(),
    })
    this.addCommand({
      id: "pause-sync",
      name: "Pause sync",
      checkCallback: (checking) => {
        const available =
          connectionControlState(this.settings, this.status.phase).action === "pause"
        if (available && !checking) this.runConnectionCommand("pause")
        return available
      },
    })
    this.addCommand({
      id: "resume-sync",
      name: "Resume sync",
      checkCallback: (checking) => {
        const available =
          connectionControlState(this.settings, this.status.phase).action === "resume"
        if (available && !checking) this.runConnectionCommand("resume")
        return available
      },
    })
    this.addCommand({
      id: "recover-vault",
      name: "Recover vault ownership",
      callback: () => new RecoveryConnectModal(this).open(),
    })
    this.addCommand({
      id: "show-deleted-files",
      name: "Show deleted files",
      checkCallback: (checking) => {
        const available = Boolean(this.settings.endpoint)
        if (available && !checking) new DeletedFilesModal(this).open()
        return available
      },
    })
    this.addCommand({
      id: "show-history",
      name: "Show history for current file",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile()
        if (!file) return false
        if (!checking) new HistoryModal(this, file.path).open()
        return true
      },
    })
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || !this.settings.endpoint) return
        menu.addItem((item) =>
          item
            .setTitle("View Meridian history")
            .setIcon("history")
            .setSection("meridian")
            .onClick(() => new HistoryModal(this, file.path).open()),
        )
      }),
    )

    registerProtocolHandlers(this, this)
    this.scheduling.register()

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.pendingPairingCompletion) {
        void this.completePendingPairing().catch((error) =>
          this.updateStatus({
            phase: "error",
            message: "Pairing completion needs attention",
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      } else if (this.settings.pendingDeviceRemoval) {
        void this.completePendingDeviceRemoval().catch((error) =>
          this.updateStatus({
            phase: "error",
            message: "Device removal needs attention",
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      } else if (this.settings.enabled) {
        void this.initializeExistingConnection()
      } else {
        this.updateStatus({ phase: "disconnected", message: "Sync is paused", progress: null })
      }
    })
  }

  override onunload(): void {
    this.pluginLoaded = false
    this.scheduling.stop()
    this.controller?.stop()
    this.controller = null
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
    this.scheduling.settingsChanged()
  }

  openSettings(): void {
    const setting = (
      this.app as typeof this.app & {
        setting?: { open(): void; openTabById(id: string): void }
      }
    ).setting
    if (!setting) {
      new Notice("Open Meridian from Community plugins settings")
      return
    }
    setting.open()
    setting.openTabById(this.manifest.id)
  }

  async syncNow(): Promise<void> {
    if (this.settings.pendingPairingCompletion) {
      throw new Error("Finish the pending device pairing before syncing")
    }
    if (this.settings.pendingDeviceRemoval) {
      throw new Error("Finish the pending device removal before syncing")
    }
    if (!this.controller) {
      if (this.settings.enabled && this.settings.endpoint) await this.initializeExistingConnection()
      if (!this.controller) {
        new Notice("Connect Meridian before syncing")
        return
      }
    }
    await this.scheduling.flushPendingFileEvents()
    await this.controller.sync("manual")
  }

  async repairLocalIndex(): Promise<void> {
    if (!this.controller) throw new Error("Meridian is not connected")
    await this.controller.repairLocalIndex()
  }

  async getEpochStatus(): Promise<{ sequence: number; pending: boolean } | null> {
    if (!this.settings.deviceId) return null
    const serialized = this.secrets.getDeviceKeyBundle(this.settings.deviceId)
    if (!serialized) return null
    const device = await this.cryptoPort.loadDevice(serialized)
    return {
      sequence: device.epochSequence,
      pending: this.settings.pendingEpochTransition !== null,
    }
  }

  async connectFromSetup(
    endpoint: string,
    setupSession: string,
    claimChallenge: string,
  ): Promise<void> {
    if (hasConfiguredMeridianIdentity(this.settings)) {
      throw new Error("Meridian is already set up and connected in this vault.")
    }
    if (!setupSession || !claimChallenge)
      throw new Error("Setup session and claim challenge are required")
    const normalizedEndpoint = normalizeEndpoint(endpoint)
    const claim = await this.cryptoPort.createFirstDevice(setupSession, claimChallenge)
    this.secrets.setDeviceKeyBundle(claim.deviceId, claim.keyBundle)

    const remote = new MeridianRemoteClient(normalizedEndpoint, new ObsidianHttpTransport())
    try {
      await remote.claim(setupSession, claim)
    } catch (error) {
      this.secrets.clearDeviceKeyBundle(claim.deviceId)
      throw error
    }
    this.settings = {
      ...this.settings,
      enabled: true,
      endpoint: normalizedEndpoint,
      vaultId: claim.vaultId,
      deviceId: claim.deviceId,
    }
    await this.saveSettings()
    await this.initializeExistingConnection()
    new RecoveryModal(this.app, claim.recoveryCode).open()
  }

  async recoverVault(endpoint: string, recoveryCode: string): Promise<void> {
    const normalizedEndpoint = normalizeEndpoint(endpoint)
    const remote = new MeridianRemoteClient(normalizedEndpoint, new ObsidianHttpTransport())
    const recoveryPackage = await remote.getRecoveryPackage()
    const challenge = await remote.createRecoveryChallenge()
    const recovered = await this.cryptoPort.recoverDevice(
      recoveryCode.trim(),
      recoveryPackage.encryptedRecoveryPackage,
      recoveryPackage.recoveryStateId,
      challenge,
    )
    this.secrets.setDeviceKeyBundle(recovered.deviceId, recovered.keyBundle)
    try {
      await remote.recover(recovered.publicClaim)
    } catch (error) {
      this.secrets.clearDeviceKeyBundle(recovered.deviceId)
      throw error
    }

    const previousDeviceId = this.settings.deviceId
    const previousController = this.controller
    this.controller = null
    await previousController?.quiesce()
    if (previousDeviceId && previousDeviceId !== recovered.deviceId) {
      this.secrets.clearDeviceKeyBundle(previousDeviceId)
    }
    this.settings = {
      ...this.settings,
      enabled: true,
      endpoint: normalizedEndpoint,
      vaultId: recovered.vaultId,
      deviceId: recovered.deviceId,
    }
    await this.saveSettings()
    await this.initializeExistingConnection()
    new Notice("Meridian ownership recovered. Previous devices were revoked.", 8_000)
  }

  async disconnect(): Promise<void> {
    if (this.pausePromise) return this.pausePromise
    const operation = this.pauseConnection()
    this.pausePromise = operation
    try {
      await operation
    } finally {
      if (this.pausePromise === operation) this.pausePromise = null
    }
  }

  async resumeConnection(): Promise<void> {
    await this.pausePromise
    if (this.settings.pendingPairingCompletion) {
      throw new Error("Finish the pending device pairing before resuming sync")
    }
    if (this.settings.pendingDeviceRemoval) {
      throw new Error("Finish the pending device removal before resuming sync")
    }
    this.settings.enabled = true
    await this.saveSettings()
    await this.initializeExistingConnection()
  }

  getStatus(): SyncStatus {
    return { ...this.status }
  }

  async getHistory(path?: string): Promise<LocalRevision[]> {
    return this.controller?.history(path) ?? []
  }

  async getActivity(limit = 200): Promise<SyncActivity[]> {
    return this.controller?.activity(limit) ?? []
  }

  async getDeletedFiles(): Promise<DeletedFileRecord[]> {
    return this.controller?.deletedFiles() ?? []
  }

  async recoverDeleted(revisionId: string): Promise<void> {
    if (!this.controller) throw new Error("Meridian is not connected")
    await this.controller.recoverDeleted(revisionId)
  }

  getDiagnostics(): SyncDiagnostic[] {
    return this.diagnostics.entries()
  }

  async getStorageUsage(): Promise<StorageUsage> {
    if (!this.controller) throw new Error("Meridian is not connected")
    return this.controller.storageUsage()
  }

  async compactLocalStorage(): Promise<LocalCompactionResult> {
    if (!this.controller) throw new Error("Meridian is not connected")
    return this.controller.compactLocalStorage()
  }

  async requestPersistentStorage(): Promise<boolean | null> {
    if (!this.controller) throw new Error("Meridian is not connected")
    return this.controller.requestPersistentStorage()
  }

  async pruneStorage(): Promise<StoragePruneResult> {
    if (!this.controller) throw new Error("Meridian is not connected")
    return this.controller.pruneStorage()
  }

  getDebugReport(): string {
    return createSanitizedDebugReport(
      {
        meridianVersion: this.manifest.version,
        obsidianVersion: apiVersion,
        platform: defaultDevicePlatform(),
        settings: this.settings,
      },
      this.status,
      this.diagnostics.entries(),
    )
  }

  async previewRevision(revisionId: string): Promise<RevisionPreview> {
    if (!this.controller) throw new Error("Connect Meridian before viewing revision content")
    return this.controller.previewRevision(revisionId)
  }

  async compareRevisionToCurrent(revisionId: string): Promise<RevisionComparison> {
    if (!this.controller) throw new Error("Connect Meridian before comparing revision content")
    return this.controller.compareRevisionToCurrent(revisionId)
  }

  async restoreRevision(revisionId: string): Promise<void> {
    if (!this.controller) throw new Error("Meridian is not connected")
    await this.controller.restoreRevision(revisionId)
  }

  async getConflicts(): Promise<ConflictRecord[]> {
    return this.controller?.conflicts() ?? []
  }

  async getConflictDetails(id: string): Promise<ConflictDetails> {
    if (!this.controller) throw new Error("Meridian is not connected")
    return this.controller.conflictDetails(id)
  }

  async resolveConflict(id: string, action: ConflictResolutionAction): Promise<void> {
    if (!this.controller) throw new Error("Meridian is not connected")
    await this.controller.resolveConflict(id, action)
  }

  async getDevices(): Promise<RemoteDevice[]> {
    if (this.controller) return this.controller.devices()
    if (!this.settings.endpoint || !this.settings.deviceId) return []
    const serialized = this.secrets.getDeviceKeyBundle(this.settings.deviceId)
    if (!serialized) throw new Error("Device keys are missing from Obsidian SecretStorage")
    const device = await this.cryptoPort.loadDevice(serialized)
    const remote = new MeridianRemoteClient(this.settings.endpoint, new ObsidianHttpTransport())
    await remote.authenticate(device, this.cryptoPort)
    return remote.listDevices()
  }

  async revokeDevice(device: RemoteDevice): Promise<void> {
    if (!this.controller) throw new Error("Meridian is not connected")
    await this.controller.revokeDevice(device)
  }

  async removeCurrentDevice(): Promise<void> {
    if (this.settings.pendingDeviceRemoval) {
      await this.completePendingDeviceRemoval()
      return
    }
    if (!this.settings.endpoint || !this.settings.vaultId || !this.settings.deviceId) {
      throw new Error("Meridian is not connected on this device")
    }

    const previousController = this.controller
    this.controller = null
    await previousController?.quiesce()
    try {
      const serialized = this.secrets.getDeviceKeyBundle(this.settings.deviceId)
      if (!serialized) throw new Error("Device keys are missing from Obsidian SecretStorage")
      const device = await this.cryptoPort.loadDevice(serialized)
      const remote = new MeridianRemoteClient(this.settings.endpoint, new ObsidianHttpTransport())
      let current: RemoteDevice
      try {
        await remote.authenticate(device, this.cryptoPort)
        const devices = await remote.listDevices()
        const found = devices.find((candidate) => candidate.deviceId === device.deviceId)
        if (!found || found.revokedAt !== null) {
          throw new Error("Current device is no longer authorized")
        }
        current = found
      } catch (error) {
        if (!(await remote.isDeviceAuthorized(device.deviceId))) {
          await this.clearRemovedDeviceIdentity(device.deviceId)
          return
        }
        throw error
      }
      if (current.role === "owner") {
        throw new Error("The owner device cannot remove itself; use recovery after owner loss")
      }

      const revocation = await this.cryptoPort.createDeviceRevocation(device, current)
      this.settings.pendingDeviceRemoval = {
        endpoint: this.settings.endpoint,
        vaultId: this.settings.vaultId,
        deviceId: this.settings.deviceId,
        envelope: revocation.envelope,
      }
      await this.saveSettings()
      await this.completePendingDeviceRemoval()
    } catch (error) {
      if (
        !this.settings.pendingDeviceRemoval &&
        this.settings.enabled &&
        this.settings.deviceId &&
        !this.controller
      ) {
        await this.initializeExistingConnection()
      }
      throw error
    }
  }

  createPairingLink(): Promise<PairingInvitation> {
    return this.pairing.createLink()
  }

  getPairingStatus(pairingId: string): Promise<PairingStatus> {
    return this.pairing.status(pairingId)
  }

  getPairingProgress(
    endpoint: string,
    pairingId: string,
    capability: string,
  ): Promise<PairingStatus> {
    return this.pairing.progress(endpoint, pairingId, capability)
  }

  approvePairing(pairingId: string): Promise<string> {
    return this.pairing.approve(pairingId)
  }

  confirmPairingOwner(pairingId: string): Promise<void> {
    return this.pairing.confirmOwner(pairingId)
  }

  completePairingOwner(pairingId: string): void {
    this.pairing.completeOwner(pairingId)
  }

  rejectPairing(pairingId: string): Promise<void> {
    return this.pairing.reject(pairingId)
  }

  joinPairing(
    endpoint: string,
    pairingId: string,
    capability: string,
    vaultId: string,
    expiresAt: number,
  ): Promise<void> {
    return this.pairing.join(endpoint, pairingId, capability, vaultId, expiresAt)
  }

  preparePairingVerification(
    endpoint: string,
    pairingId: string,
    capability: string,
  ): Promise<string> {
    return this.pairing.prepareVerification(endpoint, pairingId, capability)
  }

  finishPairing(endpoint: string, pairingId: string, capability: string): Promise<void> {
    return this.pairing.finish(endpoint, pairingId, capability)
  }

  completePendingPairing(): Promise<void> {
    return this.pairing.completePending()
  }

  cancelPairing(endpoint: string, pairingId: string, capability: string): Promise<void> {
    return this.pairing.cancel(endpoint, pairingId, capability)
  }

  async openPath(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path)
    if (!file) {
      new Notice(`Conflict copy is not available: ${path}`)
      return
    }
    await this.app.workspace.getLeaf(false).openFile(file)
  }

  private async completePendingDeviceRemoval(): Promise<void> {
    const pending = this.settings.pendingDeviceRemoval
    if (!pending) return
    const remote = new MeridianRemoteClient(pending.endpoint, new ObsidianHttpTransport())
    const authorized = await remote.isDeviceAuthorized(pending.deviceId)
    if (authorized) {
      const serialized = this.secrets.getDeviceKeyBundle(pending.deviceId)
      if (!serialized) throw new Error("Pending device removal is missing its signing keys")
      const device = await this.cryptoPort.loadDevice(serialized)
      await remote.authenticate(device, this.cryptoPort)
      try {
        await remote.revokeDevice(pending.deviceId, pending.envelope)
      } catch (error) {
        let stillAuthorized: boolean
        try {
          stillAuthorized = await remote.isDeviceAuthorized(pending.deviceId)
        } catch {
          throw error
        }
        if (stillAuthorized) throw error
      }
    }
    await this.clearRemovedDeviceIdentity(pending.deviceId)
  }

  private async clearRemovedDeviceIdentity(deviceId: string): Promise<void> {
    this.secrets.clearDeviceKeyBundle(deviceId)
    this.settings = withoutMeridianIdentity(this.settings)
    await this.saveSettings()
    this.updateStatus({
      phase: "disconnected",
      message: "Meridian was removed from this device",
      socketConnected: false,
      error: null,
      progress: null,
    })
    new Notice("This device was removed. Local vault files were kept.", 8_000)
  }

  private async loadSettings(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData())
  }

  private async pauseConnection(): Promise<void> {
    this.settings.enabled = false
    await this.saveSettings()
    const controller = this.controller
    this.controller = null
    if (controller) await controller.quiesce()
    this.updateStatus({
      phase: "disconnected",
      message: "Sync is paused",
      socketConnected: false,
      error: null,
      progress: null,
    })
  }

  private initializeExistingConnection(): Promise<void> {
    const key = this.connectionInitializationKey()
    if (this.initializationPromise && this.initializationKey === key) {
      return this.initializationPromise
    }

    const previous = this.initializationPromise?.catch(() => {}) ?? Promise.resolve()
    let operation: Promise<void>
    operation = previous
      .then(() => this.initializeExistingConnectionOnce(key))
      .finally(() => {
        if (this.initializationPromise === operation) {
          this.initializationPromise = null
          this.initializationKey = null
        }
      })
    this.initializationKey = key
    this.initializationPromise = operation
    return operation
  }

  private async initializeExistingConnectionOnce(expectedKey: string): Promise<void> {
    if (!this.pluginLoaded || this.connectionInitializationKey() !== expectedKey) return
    if (this.settings.pendingPairingCompletion) {
      this.updateStatus({
        phase: "error",
        message: "Pairing completion needs attention",
        error: "Retry pairing completion before syncing",
      })
      return
    }
    if (this.settings.pendingDeviceRemoval) {
      this.updateStatus({
        phase: "error",
        message: "Device removal needs attention",
        error: "Retry removal before syncing",
      })
      return
    }
    if (!this.settings.endpoint || !this.settings.deviceId || !this.settings.vaultId) {
      this.updateStatus({ phase: "disconnected", message: "Connect Meridian to begin syncing" })
      return
    }
    const previousController = this.controller
    this.controller = null
    await previousController?.quiesce()
    let nextController: SyncController | null = null
    try {
      if (!this.pluginLoaded || this.connectionInitializationKey() !== expectedKey) return
      const serialized = this.secrets.getDeviceKeyBundle(this.settings.deviceId)
      if (!serialized) throw new Error("Device keys are missing from Obsidian SecretStorage")
      const device = await this.cryptoPort.loadDevice(serialized)
      if (device.deviceId !== this.settings.deviceId || device.vaultId !== this.settings.vaultId) {
        throw new Error("Stored device keys do not match this vault")
      }
      const compute = new BackgroundSyncCompute()
      const vault = new ObsidianVaultPort(
        this.app.vault,
        () => this.settings.maxFileSizeMiB * 1024 * 1024,
        compute,
      )
      const journal = new IndexedDbJournal(`meridian-${this.settings.vaultId}`)
      const remote = new MeridianRemoteClient(this.settings.endpoint, new ObsidianHttpTransport())
      nextController = new SyncController(
        vault,
        journal,
        remote,
        this.cryptoPort,
        () => ({ ...this.settings.configCategories }),
        (status) => this.updateStatus(status),
        () => ({
          deviceName: this.settings.deviceName || defaultDeviceName(),
          platform: defaultDevicePlatform(),
        }),
        {
          selection: () => structuredClone(this.settings.selectiveSync),
          compute,
          persistDevice: async (updatedDevice) => {
            if (
              updatedDevice.deviceId !== this.settings.deviceId ||
              updatedDevice.vaultId !== this.settings.vaultId
            ) {
              throw new Error("Updated device secret belongs to another Meridian identity")
            }
            this.secrets.setDeviceKeyBundle(updatedDevice.deviceId, updatedDevice.serialized)
          },
          epochTransition: {
            load: () => {
              const pending = this.settings.pendingEpochTransition
              if (!pending) return null
              if (
                pending.endpoint !== this.settings.endpoint ||
                pending.vaultId !== this.settings.vaultId ||
                pending.deviceId !== this.settings.deviceId
              ) {
                throw new Error("Pending epoch transition belongs to another Meridian identity")
              }
              return {
                operationId: pending.operationId,
                nextEpochId: pending.nextEpochId,
                envelope: pending.envelope,
              }
            },
            save: async (material) => {
              this.settings.pendingEpochTransition = {
                endpoint: this.settings.endpoint,
                vaultId: this.settings.vaultId,
                deviceId: this.settings.deviceId,
                operationId: material.operationId,
                nextEpochId: material.nextEpochId,
                envelope: material.envelope,
              }
              await this.saveSettings()
            },
            clear: async () => {
              this.settings.pendingEpochTransition = null
              await this.saveSettings()
            },
          },
        },
      )
      await nextController.start(device)
      if (!this.pluginLoaded || this.connectionInitializationKey() !== expectedKey) {
        await nextController.quiesce()
        return
      }
      this.controller = nextController
      nextController = null
      this.scheduling.connectionStarted()
    } catch (error) {
      nextController?.stop()
      if (this.pluginLoaded && this.connectionInitializationKey() === expectedKey) {
        this.updateStatus({
          phase: "error",
          message: "Meridian could not start",
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  private connectionInitializationKey(): string {
    return JSON.stringify([
      this.settings.enabled,
      this.settings.endpoint,
      this.settings.vaultId,
      this.settings.deviceId,
      this.settings.pendingPairingCompletion?.pairingId ?? null,
      this.settings.pendingDeviceRemoval?.deviceId ?? null,
      this.settings.pendingEpochTransition?.operationId ?? null,
    ])
  }

  private runConnectionCommand(action: "pause" | "resume"): void {
    const operation = action === "pause" ? this.disconnect() : this.resumeConnection()
    void operation
      .then(() => new Notice(action === "pause" ? "Meridian sync paused" : "Meridian sync resumed"))
      .catch(
        (error) =>
          new Notice(error instanceof Error ? error.message : "Unable to change sync state"),
      )
  }

  private async openStatus(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(STATUS_VIEW_TYPE)[0]
    const leaf =
      existing ?? this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true)
    await leaf.setViewState({ type: STATUS_VIEW_TYPE, active: true })
    this.app.workspace.revealLeaf(leaf)
  }

  private updateStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch }
    this.scheduling.statusChanged(patch)
    this.diagnostics.record(this.status)
    if (this.statusBar) this.statusBar.setText(`Meridian: ${this.status.message}`)
    for (const leaf of this.app.workspace.getLeavesOfType(STATUS_VIEW_TYPE)) {
      if (leaf.view instanceof MeridianStatusView) leaf.view.render()
    }
  }
}
