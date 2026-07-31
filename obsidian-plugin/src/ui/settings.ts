import { Modal, Notice, Setting } from "obsidian"
import { connectionControlState } from "../plugin/connection-control"
import { normalizeExcludedExtension, normalizeExcludedFolder } from "../vault/path-policy"
import { ConnectionModal, RecoveryConnectModal } from "./connection-modals"
import type { MeridianUiHost } from "./host"

export function renderSettings(container: HTMLElement, host: MeridianUiHost): void {
  container.empty()
  const connection = connectionControlState(host.settings, host.getStatus().phase)
  const configured = connection.kind !== "unconfigured"
  const removalPending = host.settings.pendingDeviceRemoval !== null
  const pairingPending = host.settings.pendingPairingCompletion !== null

  new Setting(container)
    .setName("Connection")
    .setDesc(configured ? host.settings.endpoint : "Not connected")
    .addButton((button) =>
      button
        .setButtonText(connection.label)
        .setDisabled(connection.disabled)
        .onClick(async () => {
          const action = connection.action
          if (action === "connect") {
            new ConnectionModal(host).open()
            return
          }
          if (action === null) return
          button.setDisabled(true)
          try {
            if (action === "pause") await host.disconnect()
            else await host.resumeConnection()
            renderSettings(container, host)
            new Notice(action === "pause" ? "Meridian sync paused" : "Meridian sync resumed")
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Unable to change sync state")
            button.setDisabled(false)
          }
        }),
    )

  new Setting(container)
    .setName("Device name")
    .setDesc("A local label shown when managing authorized devices.")
    .addText((text) =>
      text.setValue(host.settings.deviceName).onChange(async (value) => {
        host.settings.deviceName = value.trim().slice(0, 80)
        await host.saveSettings()
      }),
    )

  if (pairingPending) {
    new Setting(container)
      .setName("Finish pairing")
      .setDesc(
        "The keys are stored locally, but server authorization still needs confirmation. Retry safely without creating another device identity.",
      )
      .addButton((button) =>
        button
          .setButtonText("Retry pairing")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true)
            try {
              await host.completePendingPairing()
              renderSettings(container, host)
              new Notice("Device pairing completed")
            } catch (error) {
              new Notice(error instanceof Error ? error.message : "Unable to finish pairing")
              button.setDisabled(false)
            }
          }),
      )
  } else if (configured) {
    const removal = new Setting(container)
      .setName("Remove this device")
      .setDesc("Checking whether this device can remove its Meridian identity…")
    let hasButton = false
    const addRemovalButton = () => {
      if (hasButton) return
      hasButton = true
      removal.addButton((button) =>
        button
          .setButtonText("Remove")
          .setWarning()
          .onClick(() =>
            new RemoveCurrentDeviceModal(host, () => renderSettings(container, host)).open(),
          ),
      )
    }
    if (removalPending) {
      removal.setDesc(
        "A previous removal attempt is pending. Retry to confirm server revocation and finish local cleanup.",
      )
      removal.addButton((button) =>
        button
          .setButtonText("Retry removal")
          .setWarning()
          .onClick(() =>
            new RemoveCurrentDeviceModal(host, () => renderSettings(container, host)).open(),
          ),
      )
    } else {
      void host
        .getDevices()
        .then((devices) => {
          const current = devices.find((device) => device.deviceId === host.settings.deviceId)
          if (!current || current.revokedAt !== null) {
            removal.setDesc(
              "This identity may already be revoked. Remove its local Meridian connection to pair again.",
            )
            addRemovalButton()
            return
          }
          if (current.role === "owner") {
            removal.setDesc(
              "The owner device cannot remove itself. Use recovery from another device after owner loss.",
            )
            return
          }
          removal.setDesc(
            "Permanently revoke this device and forget its local Meridian connection. Vault files are kept.",
          )
          addRemovalButton()
        })
        .catch(() => {
          removal.setDesc(
            "Unable to verify this identity. Removal will proceed only if the server confirms it safely.",
          )
          addRemovalButton()
        })
    }
  }

  new Setting(container).setName("Selective sync").setHeading()
  container.createDiv({
    cls: "setting-item-description meridian-section-description",
    text: "Exclusions are local to this device. Excluded files remain in the vault and in remote history. Re-enabling a locally changed file creates a new revision instead of deleting prior versions.",
  })
  new Setting(container)
    .setName("Excluded folders")
    .setDesc(
      "One vault-relative folder per line. Hidden folders and Obsidian configuration are managed separately.",
    )
    .addTextArea((text) => {
      text.inputEl.rows = 3
      return text
        .setPlaceholder("Archive\nAttachments/private")
        .setValue(host.settings.selectiveSync.excludedFolders.join("\n"))
        .onChange(async (value) => {
          host.settings.selectiveSync.excludedFolders = normalizeList(
            value.split("\n"),
            normalizeExcludedFolder,
          )
          await host.saveSettings()
        })
    })
  new Setting(container)
    .setName("Excluded file extensions")
    .setDesc("Comma-separated extensions without a leading dot, for example mov, zip, or psd.")
    .addText((text) =>
      text
        .setPlaceholder("mov, zip")
        .setValue(host.settings.selectiveSync.excludedExtensions.join(", "))
        .onChange(async (value) => {
          host.settings.selectiveSync.excludedExtensions = normalizeList(
            value.split(/[\s,]+/),
            normalizeExcludedExtension,
          )
          await host.saveSettings()
        }),
    )
  new Setting(container)
    .setName("Apply selective sync")
    .setDesc(
      "Scan now with the current exclusions. Changing exclusions never creates deletion records.",
    )
    .addButton((button) =>
      button.setButtonText("Apply now").onClick(async () => {
        button.setDisabled(true)
        try {
          await host.syncNow()
          new Notice("Selective sync settings applied")
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Unable to apply selective sync")
        } finally {
          button.setDisabled(false)
        }
      }),
    )

  new Setting(container).setName("Configuration sync").setHeading()
  container.createDiv({
    cls: "setting-item-description meridian-section-description",
    text: "Selections are local to this device. Workspace layouts, caches, temporary files, plugin state, and secrets are always excluded.",
  })
  const categories = [
    ["main", "Main settings"],
    ["appearance", "Appearance"],
    ["themes", "Themes and CSS snippets"],
    ["hotkeys", "Hotkeys"],
    ["core-plugins", "Active core plugin list"],
    ["core-plugin-settings", "Core plugin settings"],
  ] as const
  for (const [category, label] of categories) {
    new Setting(container).setName(label).addToggle((toggle) =>
      toggle.setValue(host.settings.configCategories[category]).onChange(async (value) => {
        host.settings.configCategories[category] = value
        await host.saveSettings()
        await host.syncNow()
      }),
    )
  }

  new Setting(container).setName("Network and mobile").setHeading()
  new Setting(container)
    .setName("Polling interval")
    .setDesc("Fallback interval in seconds when live notifications are unavailable.")
    .addSlider((slider) =>
      slider
        .setLimits(15, 300, 15)
        .setDynamicTooltip()
        .setValue(host.settings.pollIntervalSeconds)
        .onChange(async (value) => {
          host.settings.pollIntervalSeconds = value
          await host.saveSettings()
        }),
    )
  new Setting(container)
    .setName("Full scan interval")
    .setDesc("Periodic reconciliation recovers file events missed while iOS was suspended.")
    .addSlider((slider) =>
      slider
        .setLimits(1, 30, 1)
        .setDynamicTooltip()
        .setValue(host.settings.scanIntervalMinutes)
        .onChange(async (value) => {
          host.settings.scanIntervalMinutes = value
          await host.saveSettings()
        }),
    )
  new Setting(container)
    .setName("Attachment size limit")
    .setDesc("Whole-file mobile APIs require a conservative per-file memory limit in MiB.")
    .addDropdown((dropdown) =>
      dropdown
        .addOptions({ "16": "16 MiB", "32": "32 MiB", "64": "64 MiB", "128": "128 MiB" })
        .setValue(String(host.settings.maxFileSizeMiB))
        .onChange(async (value) => {
          host.settings.maxFileSizeMiB = Number(value)
          await host.saveSettings()
        }),
    )

  new Setting(container).setName("Recovery and repair").setHeading()
  new Setting(container)
    .setName("Recover vault ownership")
    .setDesc("Use the offline recovery code after losing every authorized device.")
    .addButton((button) =>
      button
        .setButtonText("Recover")
        .setWarning()
        .onClick(() => new RecoveryConnectModal(host).open()),
    )
  new Setting(container)
    .setName("Rebuild local index")
    .setDesc(
      "Deletes only rebuildable local scan state. Remote history and encrypted vault data remain intact.",
    )
    .addButton((button) =>
      button
        .setButtonText("Rebuild")
        .setWarning()
        .onClick(async () => {
          await host.repairLocalIndex()
          new Notice("Meridian local index rebuilt")
        }),
    )
}

function normalizeList(values: string[], normalize: (value: string) => string | null): string[] {
  const normalized = values.map(normalize).filter((value): value is string => value !== null)
  return [...new Set(normalized)].sort().slice(0, 200)
}

class RemoveCurrentDeviceModal extends Modal {
  constructor(
    private readonly host: MeridianUiHost,
    private readonly onRemoved: () => void,
  ) {
    super(host.app)
  }

  override onOpen(): void {
    this.setTitle("Remove this device?")
    this.contentEl.createDiv({
      cls: "meridian-callout is-warning",
      text: "This permanently revokes this device’s Meridian identity and ends synchronization. Local vault files are not deleted. Pairing is required to connect again.",
    })
    const queued = this.host.getStatus().queued
    if (queued > 0) {
      this.contentEl.createDiv({
        cls: "meridian-callout is-warning",
        text: `${queued} local change${queued === 1 ? " is" : "s are"} still queued. Sync first unless you intentionally want to keep those changes only on this device.`,
      })
    }
    const actions = new Setting(this.contentEl)
    actions.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
    actions.addButton((button) =>
      button
        .setButtonText("Remove this device")
        .setWarning()
        .onClick(async () => {
          button.setDisabled(true)
          try {
            await this.host.removeCurrentDevice()
            this.close()
            this.onRemoved()
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Unable to remove this device")
            button.setDisabled(false)
          }
        }),
    )
  }

  override onClose(): void {
    this.contentEl.empty()
  }
}
