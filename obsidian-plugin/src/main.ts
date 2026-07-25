import { Notice, Platform, Plugin } from "obsidian"
import { createPackageCryptoPort } from "./crypto/package-adapter"
import {
  type ConflictRecord,
  DEFAULT_SETTINGS,
  INITIAL_STATUS,
  type LocalRevision,
  type MeridianSettings,
  type PairingInvitation,
  type PairingStatus,
  type SyncStatus,
} from "./model"
import { ObsidianHttpTransport } from "./network/obsidian-transport"
import { MeridianRemoteClient, normalizeEndpoint } from "./network/remote-client"
import { createPairingDeepLink } from "./plugin/pairing-link"
import { registerProtocolHandlers } from "./plugin/protocol-handlers"
import { PluginScheduling } from "./plugin/scheduling"
import { MeridianSecretStorage } from "./plugin/secret-storage"
import {
  defaultDeviceName,
  defaultDevicePlatform,
  MeridianSettingsTab,
  normalizeSettings,
} from "./plugin/settings"
import { IndexedDbJournal } from "./storage/journal"
import { SyncController } from "./sync/controller"
import {
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
  private statusBar: HTMLElement | null = null

  override async onload(): Promise<void> {
    await this.loadSettings()
    if (!this.settings.deviceName) this.settings.deviceName = defaultDeviceName()

    this.registerView(STATUS_VIEW_TYPE, (leaf) => new MeridianStatusView(leaf, this))
    this.addSettingTab(new MeridianSettingsTab(this.app, this))
    this.addRibbonIcon("cloud-cog", "Open Meridian sync", () => void this.openStatus())
    if (!Platform.isMobileApp) {
      this.statusBar = this.addStatusBarItem()
      this.statusBar.addClass("meridian-status-bar")
      this.statusBar.setText("Meridian: starting")
      this.statusBar.addEventListener("click", () => void this.openStatus())
    }

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow() })
    this.addCommand({
      id: "open-status",
      name: "Open sync status",
      callback: () => void this.openStatus(),
    })
    this.addCommand({
      id: "recover-vault",
      name: "Recover vault ownership",
      callback: () => new RecoveryConnectModal(this).open(),
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

    registerProtocolHandlers(this, this)
    this.scheduling.register()

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.enabled) void this.initializeExistingConnection()
      else this.updateStatus({ phase: "disconnected", message: "Sync is paused" })
    })
  }

  override onunload(): void {
    this.scheduling.stop()
    this.controller?.stop()
    this.controller = null
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  async syncNow(): Promise<void> {
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
    if (!setupSession || !claimChallenge)
      throw new Error("Setup session and claim challenge are required")
    const normalizedEndpoint = normalizeEndpoint(endpoint)
    const claim = await this.cryptoPort.createFirstDevice(setupSession, claimChallenge)
    this.secrets.setDeviceKeyBundle(claim.deviceId, claim.keyBundle)

    const remote = new MeridianRemoteClient(normalizedEndpoint, new ObsidianHttpTransport())
    await remote.claim(setupSession, claim)
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
    this.controller?.stop()
    this.controller = null
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
    this.settings.enabled = false
    await this.saveSettings()
    this.controller?.stop()
    this.controller = null
    this.updateStatus({
      phase: "disconnected",
      message: "Sync is paused",
      socketConnected: false,
      error: null,
    })
  }

  async resumeConnection(): Promise<void> {
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

  async restoreRevision(revisionId: string): Promise<void> {
    if (!this.controller) throw new Error("Meridian is not connected")
    await this.controller.restoreRevision(revisionId)
  }

  async getConflicts(): Promise<ConflictRecord[]> {
    return this.controller?.conflicts() ?? []
  }

  async resolveConflict(id: string): Promise<void> {
    await this.controller?.resolveConflict(id)
  }

  async getDevices() {
    return this.controller?.devices() ?? []
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
    const prepared = await this.controller.approvePairing(pairingId)
    this.secrets.setPendingPairingRelease(
      pairingId,
      JSON.stringify({
        candidatePackage: prepared.candidatePackage,
        releasePayload: prepared.approval.releasePayload,
        transferHash: prepared.approval.transferHash,
      }),
    )
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
    const normalizedEndpoint = normalizeEndpoint(endpoint)
    const remote = new MeridianRemoteClient(normalizedEndpoint, new ObsidianHttpTransport())
    const progress = await remote.getPairingProgress(pairingId, capability)
    if (progress.status !== "pending") {
      if (this.secrets.getPendingPairing(pairingId)) return
      throw new Error("This pairing request was joined by another local attempt")
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
    try {
      await remote.joinPairing(pairingId, joining.payload)
    } catch (error) {
      this.secrets.clearPendingPairing(pairingId)
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
    this.settings = {
      ...this.settings,
      enabled: false,
      endpoint: normalizedEndpoint,
      vaultId: paired.vaultId,
      deviceId: paired.deviceId,
    }
    await this.saveSettings()

    const completed = await remote.completePairing(pairingId, {
      capability,
      ...paired.completion,
    })
    if (completed.status !== "completed") throw new Error("Pairing completion was not accepted")

    this.settings.enabled = true
    await this.saveSettings()
    this.secrets.clearPendingPairing(pairingId)
    await this.initializeExistingConnection()
  }

  async cancelPairing(endpoint: string, pairingId: string, capability: string): Promise<void> {
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
    releasePayload: unknown
    transferHash: string
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
        "releasePayload" in value &&
        "transferHash" in value &&
        typeof value.transferHash === "string"
      ) {
        return {
          candidatePackage: value.candidatePackage,
          releasePayload: value.releasePayload,
          transferHash: value.transferHash,
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

  private async loadSettings(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData())
  }

  private async initializeExistingConnection(): Promise<void> {
    if (!this.settings.endpoint || !this.settings.deviceId || !this.settings.vaultId) {
      this.updateStatus({ phase: "disconnected", message: "Connect Meridian to begin syncing" })
      return
    }
    this.controller?.stop()
    this.controller = null
    try {
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
      this.controller = new SyncController(
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
      )
      await this.controller.start(device)
      this.scheduling.connectionStarted()
    } catch (error) {
      this.controller?.stop()
      this.controller = null
      this.updateStatus({
        phase: "error",
        message: "Meridian could not start",
        error: error instanceof Error ? error.message : String(error),
      })
    }
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
    if (this.statusBar) this.statusBar.setText(`Meridian: ${this.status.message}`)
    for (const leaf of this.app.workspace.getLeavesOfType(STATUS_VIEW_TYPE)) {
      if (leaf.view instanceof MeridianStatusView) leaf.view.render()
    }
  }
}
