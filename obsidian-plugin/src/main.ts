import { apiVersion, Notice, Platform, Plugin, TFile } from "obsidian"
import { createPackageCryptoPort } from "./crypto/package-adapter"
import {
  type ConflictDetails,
  type ConflictRecord,
  type ConflictResolutionAction,
  DEFAULT_SETTINGS,
  type DeletedFileRecord,
  INITIAL_STATUS,
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
import { MeridianHttpError } from "./network/response-parsers"
import { connectionControlState } from "./plugin/connection-control"
import { createSanitizedDebugReport, SyncDiagnostics } from "./plugin/diagnostics"
import { confirmRemotePairingCompletion } from "./plugin/pairing-completion"
import { createPairingDeepLink, hasConfiguredMeridianIdentity } from "./plugin/pairing-link"
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
    await this.controller.sync("manual")
  }

  async repairLocalIndex(): Promise<void> {
    if (!this.controller) throw new Error("Meridian is not connected")
    await this.controller.repairLocalIndex()
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
    const encryptedPackage = await remote.getRecoveryPackage()
    const challenge = await remote.createRecoveryChallenge()
    const recovered = await this.cryptoPort.recoverDevice(
      recoveryCode.trim(),
      encryptedPackage,
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

  async createPairingLink(): Promise<PairingInvitation> {
    if (!this.controller) throw new Error("Meridian is not connected")
    const pairing = await this.controller.createPairing()
    return { ...pairing, link: createPairingDeepLink(this.settings.endpoint, pairing) }
  }

  async getPairingStatus(pairingId: string): Promise<PairingStatus> {
    if (!this.controller) throw new Error("Meridian is not connected")
    return this.controller.pairingStatus(pairingId)
  }

  async getPairingProgress(
    endpoint: string,
    pairingId: string,
    capability: string,
  ): Promise<PairingStatus> {
    const normalizedEndpoint = normalizeEndpoint(endpoint)
    const remote = new MeridianRemoteClient(normalizedEndpoint, new ObsidianHttpTransport())
    return remote.getPairingProgress(pairingId, capability)
  }

  async approvePairing(pairingId: string): Promise<string> {
    if (!this.controller) throw new Error("Meridian is not connected")
    const existing = this.secrets.getPendingPairingRelease(pairingId)
    if (existing) {
      const withheld = this.pendingPairingRelease(pairingId)
      const status = await this.controller.pairingStatus(pairingId)
      if (status.candidatePackage !== withheld.candidatePackage) {
        throw new Error("Joining device identity changed during approval")
      }
      if (status.status === "joined") {
        await this.controller.submitPairingApproval(pairingId, withheld.approvalPayload)
      } else if (
        status.status !== "verifying" &&
        status.status !== "confirmed" &&
        status.status !== "released" &&
        status.status !== "completed"
      ) {
        throw new Error(status.status === "canceled" ? "Pairing was canceled" : "Pairing changed")
      }
      return withheld.verificationPhrase
    }

    const prepared = await this.controller.preparePairingApproval(pairingId)
    this.secrets.setDeviceKeyBundle(this.settings.deviceId, prepared.deviceKeyBundle)
    this.secrets.setPendingPairingRelease(
      pairingId,
      JSON.stringify({
        candidatePackage: prepared.candidatePackage,
        approvalPayload: prepared.approval.payload,
        releasePayload: prepared.approval.releasePayload,
        transferHash: prepared.approval.transferHash,
        verificationPhrase: prepared.approval.verificationPhrase,
      }),
    )
    await this.controller.submitPairingApproval(pairingId, prepared.approval.payload)
    return prepared.approval.verificationPhrase
  }

  async confirmPairingOwner(pairingId: string): Promise<void> {
    if (!this.controller) throw new Error("Meridian is not connected")
    await this.controller.confirmPairingOwner(pairingId)
    let status = await this.controller.pairingStatus(pairingId)
    while (status.status === "verifying") {
      if (Date.now() >= status.expiresAt) throw new Error("Pairing request expired")
      await new Promise((resolve) => globalThis.setTimeout(resolve, 1_000))
      status = await this.controller.pairingStatus(pairingId)
    }
    if (status.status === "released" || status.status === "completed") return
    if (
      status.status !== "confirmed" ||
      !status.candidateConfirmation ||
      !status.candidatePackage
    ) {
      throw new Error(status.status === "canceled" ? "Pairing was canceled" : "Pairing changed")
    }
    const withheld = this.pendingPairingRelease(pairingId)
    if (withheld.candidatePackage !== status.candidatePackage) {
      throw new Error("Joining device identity changed during verification")
    }
    if (status.candidateConfirmation.transferHash !== withheld.transferHash) {
      throw new Error("Joining device confirmed a different encrypted transfer")
    }
    const confirmationValid = await this.cryptoPort.verifyPairingConfirmation(
      withheld.candidatePackage,
      status.candidateConfirmation,
    )
    if (!confirmationValid) throw new Error("Joining device confirmation is invalid")
    await this.controller.releasePairing(pairingId, withheld.releasePayload)
  }

  completePairingOwner(pairingId: string): void {
    this.secrets.clearPendingPairing(pairingId)
  }

  async rejectPairing(pairingId: string): Promise<void> {
    if (!this.controller) throw new Error("Meridian is not connected")
    try {
      await this.controller.rejectPairing(pairingId)
    } finally {
      this.secrets.clearPendingPairing(pairingId)
    }
  }

  async joinPairing(
    endpoint: string,
    pairingId: string,
    capability: string,
    vaultId: string,
    expiresAt: number,
  ): Promise<void> {
    if (hasConfiguredMeridianIdentity(this.settings)) {
      throw new Error(
        "Meridian is already set up in this local vault. Remove this device before pairing again.",
      )
    }
    const normalizedEndpoint = normalizeEndpoint(endpoint)
    const remote = new MeridianRemoteClient(normalizedEndpoint, new ObsidianHttpTransport())
    const progress = await remote.getPairingProgress(pairingId, capability)
    if (progress.status !== "pending") {
      if (progress.status === "canceled") {
        this.secrets.clearPendingPairing(pairingId)
        throw new Error("Pairing was canceled. Scan a new code to retry")
      }
      if (this.secrets.getPendingPairing(pairingId)) return
      throw new Error("This pairing request was joined by another local attempt")
    }
    const existingJoin = this.secrets.getPendingPairingJoin(pairingId)
    if (this.secrets.getPendingPairing(pairingId) && existingJoin) {
      await this.submitPairingJoin(remote, pairingId, capability, JSON.parse(existingJoin))
      return
    }
    const joining = await this.cryptoPort.createPairingJoin(
      {
        pairingId,
        capability,
        vaultId,
        expiresAt,
      },
      {
        deviceName: this.settings.deviceName || defaultDeviceName(),
        platform: defaultDevicePlatform(),
      },
    )
    this.secrets.setPendingPairing(pairingId, joining.pendingSecret)
    this.secrets.setPendingPairingJoin(pairingId, JSON.stringify(joining.payload))
    await this.submitPairingJoin(remote, pairingId, capability, joining.payload)
  }

  private async submitPairingJoin(
    remote: MeridianRemoteClient,
    pairingId: string,
    capability: string,
    payload: unknown,
  ): Promise<void> {
    try {
      await remote.joinPairing(pairingId, payload)
    } catch (error) {
      try {
        const reconciled = await remote.getPairingProgress(pairingId, capability)
        if (reconciled.status !== "pending" && reconciled.status !== "canceled") return
        this.secrets.clearPendingPairing(pairingId)
      } catch {
        // Keep the exact candidate request so reopening the same link can reconcile and replay it.
      }
      throw error
    }
  }

  async preparePairingVerification(
    endpoint: string,
    pairingId: string,
    capability: string,
  ): Promise<string> {
    const pendingSecret = this.secrets.getPendingPairing(pairingId)
    if (!pendingSecret) throw new Error("Pending pairing keys are missing")
    const remote = new MeridianRemoteClient(
      normalizeEndpoint(endpoint),
      new ObsidianHttpTransport(),
    )
    const result = await remote.getPairingResult(pairingId, capability)
    if (
      (result.status !== "verifying" && result.status !== "confirmed") ||
      !result.verificationPreview ||
      !result.transcriptHash
    ) {
      throw new Error("The existing device has not prepared verification yet")
    }
    const verification = await this.cryptoPort.inspectPairingVerification(
      pendingSecret,
      result.verificationPreview,
    )
    if (verification.transferHash !== result.transcriptHash) {
      throw new Error("Pairing verification preview does not match the encrypted transfer")
    }
    return verification.verificationPhrase
  }

  async finishPairing(endpoint: string, pairingId: string, capability: string): Promise<void> {
    const normalizedEndpoint = normalizeEndpoint(endpoint)
    const pendingCompletion = this.settings.pendingPairingCompletion
    if (pendingCompletion) {
      if (
        pendingCompletion.endpoint !== normalizedEndpoint ||
        pendingCompletion.pairingId !== pairingId ||
        this.pendingPairingCompletionPayload(pendingCompletion.pairingId).capability !== capability
      ) {
        throw new Error("Another pairing completion is already pending in this vault")
      }
      await this.completePendingPairing()
      return
    }
    if (hasConfiguredMeridianIdentity(this.settings)) {
      throw new Error("Meridian is already set up and connected in this vault.")
    }
    const pendingSecret = this.secrets.getPendingPairing(pairingId)
    if (!pendingSecret) throw new Error("Pending pairing keys are missing")
    const remote = new MeridianRemoteClient(normalizedEndpoint, new ObsidianHttpTransport())
    let result = await remote.getPairingResult(pairingId, capability)
    if (!result.verificationPreview || !result.transcriptHash) {
      throw new Error("Pairing verification material is missing")
    }
    const verification = await this.cryptoPort.inspectPairingVerification(
      pendingSecret,
      result.verificationPreview,
    )
    if (verification.transferHash !== result.transcriptHash) {
      throw new Error("Pairing verification preview does not match the encrypted transfer")
    }
    const confirmation = await this.cryptoPort.createPairingConfirmation(
      pendingSecret,
      verification.transferHash,
    )
    result = await remote.confirmPairingCandidate(pairingId, {
      capability,
      ...confirmation,
    })
    while (result.status === "verifying" || result.status === "confirmed") {
      if (Date.now() >= this.pairingExpiry(pendingSecret))
        throw new Error("Pairing request expired")
      await new Promise((resolve) => globalThis.setTimeout(resolve, 1_000))
      result = await remote.getPairingResult(pairingId, capability)
    }
    if ((result.status === "released" || result.status === "completed") && !result.hpkeTransfer) {
      result = await remote.getPairingResult(pairingId, capability)
    }
    if (result.status !== "released" && result.status !== "completed") {
      throw new Error(
        result.status === "canceled" ? "Pairing was canceled" : "Pairing was not released",
      )
    }
    let hpkeTransfer = this.secrets.getPendingPairingResult(pairingId)
    if (!hpkeTransfer) {
      if (!result.hpkeTransfer) throw new Error("Encrypted pairing transfer is missing")
      hpkeTransfer = result.hpkeTransfer
      this.secrets.setPendingPairingResult(pairingId, hpkeTransfer)
    }
    const paired = await this.cryptoPort.consumePairingResult(
      pendingSecret,
      hpkeTransfer,
      verification.verificationPhrase,
      verification.transferHash,
    )
    this.secrets.setDeviceKeyBundle(paired.deviceId, paired.keyBundle)
    this.secrets.setPendingPairingCompletion(
      pairingId,
      JSON.stringify({ capability, ...paired.completion }),
    )
    this.settings = {
      ...this.settings,
      enabled: false,
      endpoint: normalizedEndpoint,
      vaultId: paired.vaultId,
      deviceId: paired.deviceId,
      pendingPairingCompletion: {
        endpoint: normalizedEndpoint,
        pairingId,
        vaultId: paired.vaultId,
        deviceId: paired.deviceId,
        expiresAt: this.pairingExpiry(pendingSecret),
      },
    }
    await this.saveSettings()
    await this.completePendingPairing()
  }

  async completePendingPairing(): Promise<void> {
    const pending = this.settings.pendingPairingCompletion
    if (!pending) return
    const completion = this.pendingPairingCompletionPayload(pending.pairingId)
    const remote = new MeridianRemoteClient(pending.endpoint, new ObsidianHttpTransport())
    try {
      await confirmRemotePairingCompletion({
        complete: async () => {
          const completed = await remote.completePairing(pending.pairingId, completion)
          if (completed.status !== "completed") {
            throw new Error("Pairing completion was not accepted")
          }
        },
        isDeviceAuthorized: () => remote.isDeviceAuthorized(pending.deviceId),
      })
    } catch (error) {
      if (
        Date.now() < pending.expiresAt ||
        !(error instanceof MeridianHttpError) ||
        (error.code !== "pairing_expired" && error.code !== "pairing_not_found")
      ) {
        throw error
      }
      let authorized: boolean
      try {
        authorized = await remote.isDeviceAuthorized(pending.deviceId)
      } catch {
        throw error
      }
      if (authorized) throw error

      const pendingSettings = this.settings
      this.settings = withoutMeridianIdentity(this.settings)
      try {
        await this.saveSettings()
      } catch (saveError) {
        this.settings = pendingSettings
        throw saveError
      }
      this.secrets.clearDeviceKeyBundle(pending.deviceId)
      this.secrets.clearPendingPairing(pending.pairingId)
      throw new Error("Pairing expired before authorization. Create a new code and try again")
    }
    const pendingSettings = this.settings
    this.settings = {
      ...this.settings,
      enabled: true,
      endpoint: pending.endpoint,
      vaultId: pending.vaultId,
      deviceId: pending.deviceId,
      pendingPairingCompletion: null,
    }
    try {
      await this.saveSettings()
    } catch (error) {
      this.settings = pendingSettings
      throw error
    }
    this.secrets.clearPendingPairing(pending.pairingId)
    await this.initializeExistingConnection()
  }

  private pendingPairingCompletionPayload(pairingId: string): Record<string, unknown> & {
    capability: string
  } {
    const serialized = this.secrets.getPendingPairingCompletion(pairingId)
    if (!serialized) throw new Error("Pending pairing completion is missing from SecretStorage")
    try {
      const value: unknown = JSON.parse(serialized)
      if (
        typeof value === "object" &&
        value !== null &&
        "capability" in value &&
        typeof value.capability === "string"
      ) {
        return { ...value, capability: value.capability }
      }
    } catch {
      // Fall through to the stable local-state error below.
    }
    throw new Error("Pending pairing completion in SecretStorage is invalid")
  }

  async cancelPairing(endpoint: string, pairingId: string, capability: string): Promise<void> {
    if (this.settings.pendingPairingCompletion?.pairingId === pairingId) {
      throw new Error("Pairing completion is already pending and cannot be canceled safely")
    }
    const remote = new MeridianRemoteClient(
      normalizeEndpoint(endpoint),
      new ObsidianHttpTransport(),
    )
    try {
      await remote.cancelPairing(pairingId, capability)
    } finally {
      this.secrets.clearPendingPairing(pairingId)
    }
  }

  private pendingPairingRelease(pairingId: string): {
    candidatePackage: string
    approvalPayload: unknown
    releasePayload: unknown
    transferHash: string
    verificationPhrase: string
  } {
    const serialized = this.secrets.getPendingPairingRelease(pairingId)
    if (!serialized) throw new Error("Locally withheld pairing transfer is missing")
    try {
      const value: unknown = JSON.parse(serialized)
      if (
        typeof value === "object" &&
        value !== null &&
        "candidatePackage" in value &&
        typeof value.candidatePackage === "string" &&
        "approvalPayload" in value &&
        "releasePayload" in value &&
        "transferHash" in value &&
        typeof value.transferHash === "string" &&
        "verificationPhrase" in value &&
        typeof value.verificationPhrase === "string"
      ) {
        return {
          candidatePackage: value.candidatePackage,
          approvalPayload: value.approvalPayload,
          releasePayload: value.releasePayload,
          transferHash: value.transferHash,
          verificationPhrase: value.verificationPhrase,
        }
      }
    } catch {
      // Fall through to the stable local-state error below.
    }
    throw new Error("Locally withheld pairing transfer is invalid")
  }

  private pairingExpiry(pendingSecret: string): number {
    try {
      const value: unknown = JSON.parse(pendingSecret)
      if (
        typeof value === "object" &&
        value !== null &&
        "expiresAt" in value &&
        typeof value.expiresAt === "number"
      ) {
        return value.expiresAt
      }
    } catch {
      // The crypto adapter will provide a more specific error when it parses the pending secret.
    }
    return Date.now()
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
      const vault = new ObsidianVaultPort(
        this.app.vault,
        () => this.settings.maxFileSizeMiB * 1024 * 1024,
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
        { selection: () => structuredClone(this.settings.selectiveSync) },
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
    this.diagnostics.record(this.status)
    if (this.statusBar) this.statusBar.setText(`Meridian: ${this.status.message}`)
    for (const leaf of this.app.workspace.getLeavesOfType(STATUS_VIEW_TYPE)) {
      if (leaf.view instanceof MeridianStatusView) leaf.view.render()
    }
  }
}
