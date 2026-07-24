import { type App, Modal, Notice, Setting } from "obsidian"
import { formatTime } from "./format-time"
import type { MeridianUiHost } from "./host"

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
      text: "Pairing uses a short-lived capability and a phrase that must match on both devices.",
    })
    new Setting(this.contentEl)
      .setName("Add device")
      .setDesc("Create a five-minute deep link for the new device.")
      .addButton((button) =>
        button
          .setButtonText("Create link")
          .setCta()
          .onClick(async () => {
            const link = await this.host.createPairingLink()
            new PairingLinkModal(this.host.app, link).open()
          }),
      )
    new Setting(this.contentEl)
      .setName("Approve joined device")
      .setDesc("Paste the candidate package shown on the new device.")
      .addButton((button) =>
        button
          .setButtonText("Review candidate")
          .onClick(() => new PairingApprovalModal(this.host).open()),
      )
  }
}

class PairingLinkModal extends Modal {
  constructor(
    app: App,
    private readonly link: string,
  ) {
    super(app)
  }

  override onOpen(): void {
    this.setTitle("Pair a device")
    this.contentEl.createEl("code", { cls: "meridian-recovery-code", text: this.link })
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Copy link")
        .setCta()
        .onClick(async () => {
          await navigator.clipboard.writeText(this.link)
          new Notice("Pairing link copied")
        }),
    )
  }
}

class PairingApprovalModal extends Modal {
  constructor(private readonly host: MeridianUiHost) {
    super(host.app)
  }

  override onOpen(): void {
    this.setTitle("Approve device")
    let pairingId = ""
    let candidatePackage = ""
    new Setting(this.contentEl).setName("Pairing ID").addText((text) =>
      text.onChange((value) => {
        pairingId = value.trim()
      }),
    )
    new Setting(this.contentEl).setName("Candidate package").addTextArea((text) =>
      text.onChange((value) => {
        candidatePackage = value.trim()
      }),
    )
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Approve")
        .setCta()
        .onClick(async () => {
          button.setDisabled(true)
          try {
            const phrase = await this.host.approvePairing(pairingId, candidatePackage)
            this.contentEl.createEl("code", { cls: "meridian-recovery-code", text: phrase })
            new Notice("Compare this phrase on both devices before finishing")
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error), 10_000)
            button.setDisabled(false)
          }
        }),
    )
  }
}

export class PairingJoinModal extends Modal {
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
      text: "Continue only if this link came from a device you control.",
    })
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Create device request")
        .setCta()
        .onClick(async () => {
          button.setDisabled(true)
          try {
            const candidatePackage = await this.host.joinPairing(
              this.endpoint,
              this.pairingId,
              this.capability,
              this.vaultId,
              this.expiresAt,
            )
            this.contentEl.createDiv({
              cls: "setting-item-description",
              text: "Copy this package to the existing device and approve it there.",
            })
            this.contentEl.createEl("code", {
              cls: "meridian-recovery-code",
              text: candidatePackage,
            })
            let phrase = ""
            new Setting(this.contentEl)
              .setName("Verification phrase")
              .setDesc("Enter the phrase shown by the approving device.")
              .addText((text) =>
                text.onChange((value) => {
                  phrase = value.trim()
                }),
              )
            new Setting(this.contentEl).addButton((finish) =>
              finish
                .setButtonText("Finish pairing")
                .setCta()
                .onClick(async () => {
                  await this.host.finishPairing(
                    this.endpoint,
                    this.pairingId,
                    this.capability,
                    phrase,
                  )
                  this.close()
                }),
            )
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error), 10_000)
            button.setDisabled(false)
          }
        }),
    )
  }
}
