import { type ButtonComponent, Modal, Notice, Setting } from "obsidian"
import type { PairingInvitation } from "../model"
import { formatTime } from "./format-time"
import type { MeridianUiHost } from "./host"
import { renderPairingQr } from "./pairing-qr"
import { isPollingCanceled, pollUntil } from "./polling"

export class DevicesModal extends Modal {
  constructor(private readonly host: MeridianUiHost) {
    super(host.app)
  }

  override onOpen(): void {
    this.setTitle("Devices")
    void this.render()
  }

  private async render(): Promise<void> {
    this.contentEl.empty()
    const devices = await this.host.getDevices()
    for (const device of devices) {
      const isCurrent = device.deviceId === this.host.settings.deviceId
      const name = isCurrent ? this.host.settings.deviceName : device.deviceName
      new Setting(this.contentEl)
        .setName(name || (isCurrent ? "This device" : "Unnamed device"))
        .setDesc(
          [
            device.platform,
            `${device.role === "owner" ? "Owner" : "Member"}`,
            device.revokedAt ? "Revoked" : "Authorized",
            `ID ${shortDeviceId(device.deviceId)}`,
            formatTime(device.authorizedAt),
          ]
            .filter(Boolean)
            .join(" · "),
        )
    }
    this.contentEl.createDiv({
      cls: "meridian-callout",
      text: "Pairing uses a short-lived code and a phrase derived from both devices’ cryptographic identities.",
    })
    new Setting(this.contentEl)
      .setName("Add device")
      .setDesc("Scan a single-use code with the new device, then compare both screens.")
      .addButton((button) =>
        button
          .setButtonText("Create code")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true)
            try {
              const invitation = await this.host.createPairingLink()
              new PairingLinkModal(this.host, invitation).open()
              this.close()
            } catch (error) {
              showError(error)
              button.setDisabled(false)
            }
          }),
      )
  }
}

class PairingLinkModal extends Modal {
  private readonly polling = new AbortController()
  private qrContainer: HTMLElement | null = null
  private copyLinkSetting: Setting | null = null
  private terminal = false

  constructor(
    private readonly host: MeridianUiHost,
    private readonly invitation: PairingInvitation,
  ) {
    super(host.app)
  }

  override onOpen(): void {
    this.setTitle("Pair a device")
    this.contentEl.createDiv({
      cls: "meridian-callout is-warning",
      text: "Scan only with a device you control. This single-use code expires after five minutes.",
    })
    renderSecurityExplanation(this.contentEl)

    this.qrContainer = this.contentEl.createDiv({ cls: "meridian-pairing-qr" })
    const canvas = this.qrContainer.createEl("canvas")
    void renderPairingQr(canvas, this.invitation.link).catch((error) => showError(error))

    this.copyLinkSetting = new Setting(this.contentEl)
      .setName("Cannot scan?")
      .setDesc("Copy the short-lived link and open it on the new device.")
      .addButton((button) =>
        button.setButtonText("Copy link").onClick(async () => {
          await navigator.clipboard.writeText(this.invitation.link)
          new Notice("Pairing link copied")
        }),
      )

    const request = new Setting(this.contentEl)
      .setName("1 of 3 · Waiting for scan")
      .setDesc(`Code expires ${formatTime(this.invitation.expiresAt)}.`)
    request.addButton((button) => {
      button.setButtonText("Continue to verification").setCta().setDisabled(true)
      button.onClick(() => void this.startVerification(request, button))
      void this.waitForCandidate(request, button)
    })
  }

  override onClose(): void {
    this.polling.abort()
    if (!this.terminal) void this.host.rejectPairing(this.invitation.pairingId).catch(() => {})
    this.contentEl.empty()
  }

  private hideInvitation(): void {
    if (this.qrContainer) this.qrContainer.style.display = "none"
    this.copyLinkSetting?.settingEl.remove()
    this.copyLinkSetting = null
  }

  private async waitForCandidate(setting: Setting, button: ButtonComponent): Promise<void> {
    try {
      const status = await pollUntil({
        read: () => this.host.getPairingStatus(this.invitation.pairingId),
        isDone: (value) => value.status !== "pending",
        expiresAt: this.invitation.expiresAt,
        signal: this.polling.signal,
        onValue: (value) => {
          if (value.status === "pending") setting.setDesc("Keep this window open while scanning.")
        },
      })
      this.hideInvitation()
      if (status.status === "canceled") {
        this.terminal = true
        setting.setName("Pairing canceled").setDesc("No device was authorized.")
        return
      }
      if (!status.candidate || !status.candidatePackage) {
        throw new Error("The new device did not provide a complete signed identity")
      }
      setting
        .setName(`2 of 3 · Review ${status.candidate.deviceName}`)
        .setDesc(
          `${status.candidate.platform} · ID ${shortDeviceId(status.candidate.deviceId)} · requested ${
            status.requestedAt ? formatTime(status.requestedAt) : "just now"
          }. The name and platform are signed self-declarations; the phrase verifies the keys.`,
        )
      button.setDisabled(false)
    } catch (error) {
      if (isPollingCanceled(error)) return
      setting.setName("Pairing stopped").setDesc(errorMessage(error))
      showError(error)
    }
  }

  private async startVerification(setting: Setting, button: ButtonComponent): Promise<void> {
    button.setDisabled(true)
    try {
      const phrase = await this.host.approvePairing(this.invitation.pairingId)
      setting
        .setName("3 of 3 · Compare verification phrases")
        .setDesc("The same phrase must be visible on the new device. Repeated words are normal.")
      button.buttonEl.hide()
      const code = this.contentEl.createEl("code", {
        cls: "meridian-recovery-code",
        text: phrase,
      })
      const actions = new Setting(this.contentEl)
      actions.addButton((match) =>
        match
          .setButtonText("Phrases match")
          .setCta()
          .onClick(async () => {
            match.setDisabled(true)
            try {
              code.style.display = "none"
              actions.settingEl.style.display = "none"
              setting
                .setName("Verification confirmed")
                .setDesc("Waiting for the new device confirmation before releasing encrypted keys.")
              await this.host.confirmPairingOwner(this.invitation.pairingId)
              setting.setDesc("Encrypted keys released. Waiting for the new device to finish.")
              await this.waitForCompletion(setting)
            } catch (error) {
              code.style.display = ""
              actions.settingEl.style.display = ""
              showError(error)
              match.setDisabled(false)
            }
          }),
      )
      actions.addButton((reject) =>
        reject
          .setButtonText("They don’t match")
          .setWarning()
          .onClick(async () => {
            reject.setDisabled(true)
            try {
              await this.host.rejectPairing(this.invitation.pairingId)
              this.terminal = true
              new Notice("Pairing canceled. No device was authorized.")
              this.close()
            } catch (error) {
              showError(error)
              reject.setDisabled(false)
            }
          }),
      )
    } catch (error) {
      showError(error)
      button.setDisabled(false)
    }
  }

  private async waitForCompletion(setting: Setting): Promise<void> {
    const status = await pollUntil({
      read: () => this.host.getPairingStatus(this.invitation.pairingId),
      isDone: (value) => value.status === "completed" || value.status === "canceled",
      expiresAt: this.invitation.expiresAt,
      signal: this.polling.signal,
    })
    if (status.status === "canceled") {
      this.terminal = true
      setting.setName("Pairing canceled").setDesc("No device was authorized.")
      return
    }
    this.host.completePairingOwner(this.invitation.pairingId)
    this.terminal = true
    new Notice("Device paired. Meridian is syncing on both devices.")
    this.close()
  }
}

export class PairingJoinModal extends Modal {
  private readonly polling = new AbortController()
  private terminal = false

  constructor(
    private readonly host: MeridianUiHost,
    private readonly endpoint: string,
    private readonly pairingId: string,
    private readonly capability: string,
    private readonly vaultId: string,
    private readonly expiresAt: number,
  ) {
    super(host.app)
  }

  override onOpen(): void {
    this.setTitle("Join Meridian vault")
    this.contentEl.createDiv({
      cls: "meridian-callout is-warning",
      text: "Continue only if you just scanned this code from a device you control.",
    })
    renderSecurityExplanation(this.contentEl)
    const progress = new Setting(this.contentEl)
      .setName("1 of 3 · Send device identity")
      .setDesc(
        `Your private keys stay on this device. Pairing expires ${formatTime(this.expiresAt)}.`,
      )
    progress.addButton((button) =>
      button
        .setButtonText("Continue")
        .setCta()
        .onClick(async () => {
          button.setDisabled(true)
          try {
            await this.host.joinPairing(
              this.endpoint,
              this.pairingId,
              this.capability,
              this.vaultId,
              this.expiresAt,
            )
            button.buttonEl.hide()
            progress
              .setName("2 of 3 · Waiting for existing device")
              .setDesc("Review this device on the existing device to prepare verification.")
            void this.waitForVerification(progress)
          } catch (error) {
            showError(error)
            button.setDisabled(false)
          }
        }),
    )
  }

  override onClose(): void {
    this.polling.abort()
    if (!this.terminal) {
      void this.host.cancelPairing(this.endpoint, this.pairingId, this.capability).catch(() => {})
    }
    this.contentEl.empty()
  }

  private async waitForVerification(setting: Setting): Promise<void> {
    try {
      const status = await pollUntil({
        read: () => this.host.getPairingProgress(this.endpoint, this.pairingId, this.capability),
        isDone: (value) =>
          value.status === "verifying" ||
          value.status === "confirmed" ||
          value.status === "released" ||
          value.status === "completed" ||
          value.status === "canceled",
        expiresAt: this.expiresAt,
        signal: this.polling.signal,
        onValue: (value) => {
          if (value.status === "joined") {
            setting.setDesc("Request received. Continue on the existing device.")
          }
        },
      })
      if (status.status === "canceled") {
        this.terminal = true
        setting
          .setName("Pairing canceled")
          .setDesc("No keys were shared and no device was authorized.")
        return
      }
      const phrase = await this.host.preparePairingVerification(
        this.endpoint,
        this.pairingId,
        this.capability,
      )
      this.renderVerification(setting, phrase)
    } catch (error) {
      if (isPollingCanceled(error)) return
      setting.setName("Pairing stopped").setDesc(errorMessage(error))
      showError(error)
    }
  }

  private renderVerification(setting: Setting, phrase: string): void {
    setting
      .setName("3 of 3 · Compare verification phrases")
      .setDesc("Check the existing device. Repeated words are normal; every item must match.")
    const code = this.contentEl.createEl("code", {
      cls: "meridian-recovery-code",
      text: phrase,
    })
    const actions = new Setting(this.contentEl)
    actions.addButton((match) =>
      match
        .setButtonText("Phrases match")
        .setCta()
        .onClick(async () => {
          match.setDisabled(true)
          try {
            code.style.display = "none"
            actions.settingEl.style.display = "none"
            setting
              .setName("Finishing securely")
              .setDesc("Waiting for both confirmations, then decrypting the vault keys locally.")
            await this.host.finishPairing(this.endpoint, this.pairingId, this.capability)
            this.terminal = true
            new Notice("Device paired. Meridian is synchronizing this vault.")
            this.close()
          } catch (error) {
            code.style.display = ""
            actions.settingEl.style.display = ""
            showError(error)
            match.setDisabled(false)
          }
        }),
    )
    actions.addButton((reject) =>
      reject
        .setButtonText("They don’t match")
        .setWarning()
        .onClick(async () => {
          reject.setDisabled(true)
          try {
            await this.host.cancelPairing(this.endpoint, this.pairingId, this.capability)
            this.terminal = true
            new Notice("Pairing canceled. No vault keys were released.")
            this.close()
          } catch (error) {
            showError(error)
            reject.setDisabled(false)
          }
        }),
    )
  }
}

function renderSecurityExplanation(container: HTMLElement): void {
  const details = container.createEl("details")
  details.createEl("summary", { text: "Why this is secure" })
  const list = details.createEl("ul")
  list.createEl("li", { text: "The QR capability is single-use and expires after five minutes." })
  list.createEl("li", {
    text: "Each device creates private keys locally; they never leave that device.",
  })
  list.createEl("li", {
    text: "The phrase is derived from both signed device identities and the pairing transcript.",
  })
  list.createEl("li", {
    text: "Encrypted vault keys are released only after both devices confirm the same phrase.",
  })
}

function shortDeviceId(deviceId: string): string {
  return `${deviceId.slice(0, 6)}…${deviceId.slice(-6)}`
}

function showError(error: unknown): void {
  new Notice(errorMessage(error))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected Meridian error"
}
