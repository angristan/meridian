import { type App, Modal, Notice, Setting } from "obsidian"
import type { MeridianUiHost } from "./host"

export class ConnectionModal extends Modal {
  constructor(private readonly host: MeridianUiHost) {
    super(host.app)
  }

  override onOpen(): void {
    this.setTitle("Connect Meridian")
    let endpoint = ""
    let setupSession = ""
    let claimChallenge = ""
    new Setting(this.contentEl)
      .setName("Worker URL")
      .setDesc("The HTTPS URL shown by your Cloudflare deployment.")
      .addText((text) =>
        text.setPlaceholder("https://meridian.example.workers.dev").onChange((value) => {
          endpoint = value
        }),
      )
    new Setting(this.contentEl)
      .setName("Claim challenge")
      .setDesc("Copy the short-lived challenge from the setup link.")
      .addText((text) =>
        text.onChange((value) => {
          claimChallenge = value.trim()
        }),
      )
    new Setting(this.contentEl)
      .setName("Setup session")
      .setDesc("A short-lived capability from the setup page. It is never saved.")
      .addText((text) => {
        text.inputEl.type = "password"
        text.onChange((value) => {
          setupSession = value.trim()
        })
      })
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Connect")
        .setCta()
        .onClick(async () => {
          button.setDisabled(true)
          try {
            await this.host.connectFromSetup(endpoint, setupSession, claimChallenge)
            this.close()
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error), 10_000)
            button.setDisabled(false)
          }
        }),
    )
  }

  override onClose(): void {
    this.contentEl.empty()
  }
}

export class SetupLinkModal extends Modal {
  constructor(
    private readonly host: MeridianUiHost,
    private readonly endpoint: string,
    private readonly setupSession: string,
    private readonly claimChallenge: string,
  ) {
    super(host.app)
  }

  override onOpen(): void {
    this.setTitle("Connect this vault to Meridian?")
    this.contentEl.createDiv({
      cls: "meridian-callout is-warning",
      text: "Only continue if you just opened the link from your own Cloudflare setup page. Claiming is permanent for this deployment.",
    })
    new Setting(this.contentEl).setName("Deployment").setDesc(this.endpoint)
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Connect vault")
        .setCta()
        .onClick(async () => {
          button.setDisabled(true)
          try {
            await this.host.connectFromSetup(this.endpoint, this.setupSession, this.claimChallenge)
            this.close()
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error), 10_000)
            button.setDisabled(false)
          }
        }),
    )
  }
}

export class RecoveryModal extends Modal {
  constructor(
    app: App,
    private readonly recoveryCode: string,
  ) {
    super(app)
  }

  override onOpen(): void {
    this.setTitle("Save your recovery code")
    this.contentEl.createDiv({
      cls: "meridian-callout is-warning",
      text: "Store this code outside the vault. Meridian cannot recover it, and sync is not a backup.",
    })
    this.contentEl.createEl("code", {
      cls: "meridian-recovery-code",
      text: this.recoveryCode,
    })
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("I saved it")
        .setCta()
        .onClick(() => this.close()),
    )
  }
}

export class RecoveryConnectModal extends Modal {
  constructor(private readonly host: MeridianUiHost) {
    super(host.app)
  }

  override onOpen(): void {
    this.setTitle("Recover Meridian ownership")
    let endpoint = this.host.settings.endpoint
    let recoveryCode = ""
    this.contentEl.createDiv({
      cls: "meridian-callout is-warning",
      text: "Recovery revokes every existing device and session. Continue only if you lost access to all authorized devices.",
    })
    new Setting(this.contentEl)
      .setName("Worker URL")
      .setDesc("The HTTPS URL of the Meridian deployment to recover.")
      .addText((text) =>
        text.setValue(endpoint).onChange((value) => {
          endpoint = value
        }),
      )
    new Setting(this.contentEl)
      .setName("Recovery code")
      .setDesc("The mdn1 code saved outside this vault. It is used locally and never stored.")
      .addTextArea((text) =>
        text.setPlaceholder("mdn1...").onChange((value) => {
          recoveryCode = value.trim()
        }),
      )
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Recover and revoke devices")
        .setWarning()
        .onClick(async () => {
          button.setDisabled(true)
          try {
            await this.host.recoverVault(endpoint, recoveryCode)
            this.close()
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error), 10_000)
            button.setDisabled(false)
          }
        }),
    )
  }

  override onClose(): void {
    this.contentEl.empty()
  }
}
