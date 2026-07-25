import { type App, Modal, Notice, Setting } from "obsidian"
import type { MeridianUiHost } from "./host"
import { recoveryCodePresentation } from "./recovery-code"

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
    const code = this.contentEl.createEl("code", {
      cls: "meridian-recovery-code",
    })
    let revealed = false
    const actions = new Setting(this.contentEl)
    actions.settingEl.addClass("meridian-recovery-actions")
    actions
      .addButton((button) =>
        button.setButtonText("Copy recovery code").onClick(async () => {
          button.setDisabled(true)
          try {
            await navigator.clipboard.writeText(this.recoveryCode)
            new Notice("Recovery code copied. Clear your clipboard after storing it.")
          } catch {
            new Notice("Could not copy the recovery code. Reveal it and copy it manually.", 10_000)
          } finally {
            button.setDisabled(false)
          }
        }),
      )
      .addButton((button) => {
        const update = () => {
          const presentation = recoveryCodePresentation(this.recoveryCode, revealed)
          code.setText(presentation.text)
          code.setAttribute("aria-label", presentation.codeLabel)
          button.setButtonText(presentation.toggleLabel)
          button.buttonEl.setAttribute("aria-pressed", String(revealed))
        }
        button.onClick(() => {
          revealed = !revealed
          update()
        })
        update()
      })
      .addButton((button) =>
        button
          .setButtonText("I saved it")
          .setCta()
          .onClick(() => this.close()),
      )
  }

  override onClose(): void {
    this.contentEl.empty()
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
    let recoveryCodeInput: HTMLInputElement | null = null
    new Setting(this.contentEl)
      .setName("Recovery code")
      .setDesc("The mdn1 code saved outside this vault. It is used locally and never stored.")
      .addText((text) => {
        recoveryCodeInput = text.inputEl
        text.inputEl.type = "password"
        text.inputEl.autocomplete = "off"
        text.inputEl.spellcheck = false
        text.inputEl.setAttribute("autocapitalize", "none")
        text.setPlaceholder("mdn1...").onChange((value) => {
          recoveryCode = value.trim()
        })
      })
      .addButton((button) => {
        let revealed = false
        const update = () => {
          if (recoveryCodeInput) recoveryCodeInput.type = revealed ? "text" : "password"
          button.setButtonText(revealed ? "Hide" : "Show")
          button.buttonEl.setAttribute("aria-pressed", String(revealed))
          button.buttonEl.setAttribute(
            "aria-label",
            revealed ? "Hide recovery code" : "Show recovery code",
          )
        }
        button.onClick(() => {
          revealed = !revealed
          update()
        })
        update()
      })
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
