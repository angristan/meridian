import { type ButtonComponent, Modal, Notice, Setting } from "obsidian"
import type { PairingInvitation, RemoteDevice } from "../model"
import { isPollingCanceled, pollUntil } from "../platform/polling"
import { formatTime } from "./format-time"
import type { MeridianUiHost } from "./host"
import { renderPairingQr } from "./pairing-qr"

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
    const current = devices.find((device) => device.deviceId === this.host.settings.deviceId)
    const canManageDevices = current?.role === "owner" && current.revokedAt === null
    for (const device of devices) {
      const isCurrent = device.deviceId === this.host.settings.deviceId
      const name = isCurrent ? this.host.settings.deviceName : device.deviceName
      const setting = new Setting(this.contentEl)
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
      if (canManageDevices && !isCurrent && device.revokedAt === null) {
        setting.addButton((button) =>
          button
            .setButtonText("Revoke")
            .setWarning()
            .onClick(() => {
              new RevokeDeviceModal(this.host, device, () => void this.render()).open()
            }),
        )
      }
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
          .setButtonText("Add device")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true)
            try {
              const invitation = await this.host.pairing.createLink()
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

class RevokeDeviceModal extends Modal {
  constructor(
    private readonly host: MeridianUiHost,
    private readonly device: RemoteDevice,
    private readonly onRevoked: () => void,
  ) {
    super(host.app)
  }

  override onOpen(): void {
    const name = this.device.deviceName || "Unnamed device"
    this.setTitle(`Revoke ${name}?`)
    this.contentEl.createDiv({
      cls: "meridian-callout is-warning",
      text: "This immediately ends the device’s Meridian sessions. Its local files are not deleted, but it must be paired again to resume syncing.",
    })
    this.contentEl.createDiv({
      cls: "setting-item-description",
      text: `${this.device.platform || "Unknown platform"} · ID ${shortDeviceId(this.device.deviceId)}`,
    })
    const actions = new Setting(this.contentEl)
    actions.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
    actions.addButton((button) =>
      button
        .setButtonText("Revoke device")
        .setWarning()
        .onClick(async () => {
          button.setDisabled(true)
          try {
            await this.host.revokeDevice(this.device)
            new Notice(`${name} revoked`)
            this.close()
            this.onRevoked()
          } catch (error) {
            showError(error)
            button.setDisabled(false)
          }
        }),
    )
  }

  override onClose(): void {
    this.contentEl.empty()
  }
}

class PairingLinkModal extends Modal {
  private readonly polling = new AbortController()
  private qrContainer: HTMLElement | null = null
  private copyLinkSetting: Setting | null = null
  private terminal = false
  private confirmationStarted = false

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
    if (!this.confirmationStarted) {
      this.polling.abort()
      if (!this.terminal) void this.host.pairing.reject(this.invitation.pairingId).catch(() => {})
    }
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
        read: () => this.host.pairing.status(this.invitation.pairingId),
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
        this.host.pairing.completeOwner(this.invitation.pairingId)
        setting.setName("Pairing canceled").setDesc("No device was authorized.")
        button.buttonEl.hide()
        this.addNewCodeRetry(setting)
        return
      }
      if (!status.candidate || !status.candidatePackage) {
        throw new Error("The new device did not provide a complete signed identity")
      }
      setting
        .setName("2 of 3 · Review new device")
        .setDesc(
          `${status.candidate.deviceName} · ${status.candidate.platform} · ID ${shortDeviceId(status.candidate.deviceId)}. The name and platform come from the new device. Continue, then compare the phrase on both devices.`,
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
      const phrase = await this.host.pairing.approve(this.invitation.pairingId)
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
            this.confirmationStarted = true
            try {
              code.style.display = "none"
              actions.settingEl.style.display = "none"
              setting
                .setName("Verification confirmed")
                .setDesc("Waiting for the new device confirmation before releasing encrypted keys.")
              await this.host.pairing.confirmOwner(this.invitation.pairingId)
              setting.setDesc("Encrypted keys released. Waiting for the new device to finish.")
              await this.waitForCompletion(setting)
            } catch (error) {
              this.confirmationStarted = false
              code.style.display = ""
              actions.settingEl.style.display = ""
              setting
                .setName("Could not finish pairing")
                .setDesc(`${errorMessage(error)} Retry while the code is still valid.`)
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
              await this.host.pairing.reject(this.invitation.pairingId)
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
      read: () => this.host.pairing.status(this.invitation.pairingId),
      isDone: (value) => value.status === "completed" || value.status === "canceled",
      expiresAt: Math.max(this.invitation.expiresAt, Date.now() + 5 * 60_000),
      signal: this.polling.signal,
    })
    if (status.status === "canceled") {
      this.terminal = true
      this.host.pairing.completeOwner(this.invitation.pairingId)
      setting.setName("Pairing canceled").setDesc("No device was authorized.")
      this.addNewCodeRetry(setting)
      return
    }
    this.host.pairing.completeOwner(this.invitation.pairingId)
    this.terminal = true
    new Notice("Device paired. Meridian is syncing on both devices.")
    this.close()
  }

  private addNewCodeRetry(setting: Setting): void {
    setting.addButton((retry) =>
      retry
        .setButtonText("Retry")
        .setCta()
        .onClick(async () => {
          retry.setDisabled(true)
          try {
            const invitation = await this.host.pairing.createLink()
            this.terminal = true
            this.close()
            new PairingLinkModal(this.host, invitation).open()
          } catch (error) {
            showError(error)
            retry.setDisabled(false)
          }
        }),
    )
  }
}

export class PairingJoinModal extends Modal {
  private readonly polling = new AbortController()
  private terminal = false
  private completionStarted = false

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
            await this.host.pairing.join(
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
    if (!this.terminal && !this.completionStarted) {
      void this.host.pairing.cancel(this.endpoint, this.pairingId, this.capability).catch(() => {})
    }
    this.contentEl.empty()
  }

  private async waitForVerification(setting: Setting): Promise<void> {
    try {
      const status = await pollUntil({
        read: () => this.host.pairing.progress(this.endpoint, this.pairingId, this.capability),
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
        await this.host.pairing
          .cancel(this.endpoint, this.pairingId, this.capability)
          .catch(() => {})
        setting
          .setName("Pairing canceled")
          .setDesc("No keys were shared and no device was authorized. Scan a new code to retry.")
        return
      }
      const phrase = await this.host.pairing.prepareVerification(
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
          this.completionStarted = true
          try {
            code.style.display = "none"
            actions.settingEl.style.display = "none"
            setting
              .setName("Finishing securely")
              .setDesc("Waiting for both confirmations, then decrypting the vault keys locally.")
            await this.host.pairing.finish(this.endpoint, this.pairingId, this.capability)
            this.terminal = true
            new Notice("Device paired. Meridian is synchronizing this vault.")
            this.close()
          } catch (error) {
            this.completionStarted = false
            code.style.display = ""
            actions.settingEl.style.display = ""
            setting
              .setName("Could not finish pairing")
              .setDesc(`${errorMessage(error)} Tap Phrases match to retry.`)
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
            await this.host.pairing.cancel(this.endpoint, this.pairingId, this.capability)
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
