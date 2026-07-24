import { Notice, Setting } from "obsidian"
import { ConnectionModal, RecoveryConnectModal } from "./connection-modals"
import type { MeridianUiHost } from "./host"

export function renderSettings(container: HTMLElement, host: MeridianUiHost): void {
  container.empty()
  const configured = host.settings.endpoint.length > 0
  const connected = configured && host.settings.enabled

  new Setting(container)
    .setName("Connection")
    .setDesc(configured ? host.settings.endpoint : "Not connected")
    .addButton((button) =>
      button
        .setButtonText(connected ? "Pause" : configured ? "Resume" : "Connect")
        .onClick(async () => {
          if (connected) await host.disconnect()
          else if (configured) await host.resumeConnection()
          else new ConnectionModal(host).open()
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
