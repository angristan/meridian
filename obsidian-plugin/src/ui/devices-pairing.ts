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
      new Setting(this.contentEl)
        .setName(device.deviceId === this.host.settings.deviceId ? "This device" : device.deviceId)
        .setDesc(
          `${device.role === "owner" ? "Owner" : "Member"} · ${device.revokedAt ? "Revoked" : "Authorized"} · ${formatTime(device.authorizedAt)}`,
        )
    }
    this.contentEl.createDiv({
      cls: "meridian-callout",
      text: "Pairing uses a five-minute QR code and a phrase that must match on both devices.",
    })
    new Setting(this.contentEl)
      .setName("Add device")
      .setDesc("Scan a short-lived pairing code with the new device.")
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
      text: "Scan only with a device you control. This code grants a five-minute pairing capability.",
    })

    const qrContainer = this.contentEl.createDiv({ cls: "meridian-pairing-qr" })
    const canvas = qrContainer.createEl("canvas")
    void renderPairingQr(canvas, this.invitation.link).catch((error) => showError(error))

    new Setting(this.contentEl)
      .setName("Cannot scan?")
      .setDesc("Copy the short-lived link and open it on the new device.")
      .addButton((button) =>
        button.setButtonText("Copy link").onClick(async () => {
          await navigator.clipboard.writeText(this.invitation.link)
          new Notice("Pairing link copied")
        }),
      )

    const request = new Setting(this.contentEl)
      .setName("Waiting for the new device")
      .setDesc(`Code expires ${formatTime(this.invitation.expiresAt)}.`)
    request.addButton((button) => {
      button.setButtonText("Approve device").setCta().setDisabled(true)
      button.onClick(() => void this.approve(request, button))
      void this.waitForCandidate(request, button)
    })
  }

  override onClose(): void {
    this.polling.abort()
    this.contentEl.empty()
  }

  private async waitForCandidate(setting: Setting, button: ButtonComponent): Promise<void> {
    try {
      const status = await pollUntil({
        read: () => this.host.getPairingStatus(this.invitation.pairingId),
        isDone: (value) => value.status !== "pending",
        expiresAt: this.invitation.expiresAt,
        signal: this.polling.signal,
        onValue: (value) => {
          if (value.status === "pending") {
            setting.setDesc("Keep this window open while the new device scans the code.")
          }
        },
      })
      if (status.status === "approved") {
        setting
          .setName("Device already approved")
          .setDesc("If the verification phrase was lost, revoke the device and pair again.")
        return
      }
      if (!status.candidatePackage) {
        throw new Error("The new device must update Meridian before using QR pairing")
      }
      setting
        .setName("Device request received")
        .setDesc("Approve it, then compare the verification phrase on both devices.")
      button.setDisabled(false)
    } catch (error) {
      if (isPollingCanceled(error)) return
      setting.setName("Pairing stopped").setDesc(errorMessage(error))
      showError(error)
    }
  }

  private async approve(setting: Setting, button: ButtonComponent): Promise<void> {
    button.setDisabled(true)
    try {
      const phrase = await this.host.approvePairing(this.invitation.pairingId)
      setting
        .setName("Verification phrase")
        .setDesc("Enter this exact phrase on the new device, then finish pairing.")
      button.buttonEl.hide()
      this.contentEl.createEl("code", {
        cls: "meridian-recovery-code",
        text: phrase,
      })
    } catch (error) {
      showError(error)
      button.setDisabled(false)
    }
  }
}

export class PairingJoinModal extends Modal {
  private readonly polling = new AbortController()
  private finishRendered = false

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
    const progress = new Setting(this.contentEl)
      .setName("New device request")
      .setDesc(`Pairing expires ${formatTime(this.expiresAt)}.`)
    progress.addButton((button) =>
      button
        .setButtonText("Join vault")
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
              .setName("Waiting for approval")
              .setDesc("Approve this device on the existing device.")
            void this.waitForApproval(progress)
          } catch (error) {
            showError(error)
            button.setDisabled(false)
          }
        }),
    )
  }

  override onClose(): void {
    this.polling.abort()
    this.contentEl.empty()
  }

  private async waitForApproval(setting: Setting): Promise<void> {
    try {
      await pollUntil({
        read: () => this.host.getPairingProgress(this.endpoint, this.pairingId, this.capability),
        isDone: (value) => value.status === "approved",
        expiresAt: this.expiresAt,
        signal: this.polling.signal,
        onValue: (value) => {
          setting.setDesc(
            value.status === "joined"
              ? "Request received. Approve it on the existing device."
              : "Waiting for the existing device to receive the request.",
          )
        },
      })
      setting
        .setName("Device approved")
        .setDesc("Enter the verification phrase shown on the existing device.")
      this.renderFinish()
    } catch (error) {
      if (isPollingCanceled(error)) return
      setting.setName("Pairing stopped").setDesc(errorMessage(error))
      showError(error)
    }
  }

  private renderFinish(): void {
    if (this.finishRendered) return
    this.finishRendered = true
    let phrase = ""
    new Setting(this.contentEl)
      .setName("Verification phrase")
      .setDesc("The phrase must exactly match the existing device.")
      .addText((text) =>
        text.onChange((value) => {
          phrase = value.trim()
        }),
      )
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Finish pairing")
        .setCta()
        .onClick(async () => {
          button.setDisabled(true)
          try {
            await this.host.finishPairing(this.endpoint, this.pairingId, this.capability, phrase)
            new Notice("Device paired. Meridian is synchronizing this vault.")
            this.close()
          } catch (error) {
            showError(error)
            button.setDisabled(false)
          }
        }),
    )
  }
}

function showError(error: unknown): void {
  new Notice(errorMessage(error), 10_000)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
