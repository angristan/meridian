import {
  Modal,
  Notice,
  Setting,
  type SettingDefinition,
  type SettingDefinitionItem,
} from "obsidian"
import { connectionControlState } from "../plugin/connection-control"
import type { MeridianSettingKey } from "../plugin/settings-controls"
import { normalizeExcludedExtension, normalizeExcludedFolder } from "../vault/path-policy"
import { ConnectionModal, RecoveryConnectModal } from "./connection-modals"
import type { MeridianUiHost } from "./host"
import { StorageModal } from "./storage-modal"

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

  new Setting(container).setName("Security and protocol").setHeading()
  const protocolUpgrade = new Setting(container)
    .setName("Vault protocol")
    .setDesc("Checking the signed operation log format…")
  configureProtocolUpgrade(protocolUpgrade, host)
  const epochStatus = new Setting(container)
    .setName("Encryption epoch")
    .setDesc("Checking encryption key rotation state…")
  configureEpochStatus(epochStatus, host)

  new Setting(container).setName("Storage and retention").setHeading()
  new Setting(container)
    .setName("Storage usage")
    .setDesc("Review encrypted blob, operation, checkpoint, and snapshot storage.")
    .addButton((button) =>
      button
        .setButtonText("View usage")
        .setDisabled(!configured)
        .onClick(() => new StorageModal(host).open()),
    )
  new Setting(container)
    .setName("Automatic pruning")
    .setDesc(
      "Unavailable until every active device can acknowledge and rebootstrap from a signed generation-aware snapshot.",
    )
    .addButton((button) => button.setButtonText("Not available").setDisabled(true))

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

export function getMeridianSettingDefinitions(
  host: MeridianUiHost,
  refresh: () => void,
): SettingDefinitionItem<MeridianSettingKey>[] {
  const connection = connectionControlState(host.settings, host.getStatus().phase)
  const configured = connection.kind !== "unconfigured"
  return [
    {
      type: "group",
      heading: "Connection and device",
      items: [
        {
          name: "Connection",
          desc: configured ? host.settings.endpoint : "Not connected",
          aliases: ["connect", "pause", "resume", "endpoint"],
          render: (setting) => configureConnection(setting, host, refresh),
        },
        {
          name: "Device name",
          desc: "A local label shown when managing authorized devices.",
          aliases: ["computer", "phone", "identity"],
          control: { type: "text", key: "deviceName" },
        },
        {
          name: "Finish pairing",
          desc: "Retry a safely stored pairing completion without creating another identity.",
          visible: () => host.settings.pendingPairingCompletion !== null,
          render: (setting) => configurePairingRetry(setting, host, refresh),
        },
        {
          name: "Remove this device",
          desc: "Revoke this device and forget its local Meridian connection. Vault files are kept.",
          aliases: ["revoke", "disconnect", "forget identity"],
          visible: () => configured && host.settings.pendingPairingCompletion === null,
          render: (setting) => configureDeviceRemoval(setting, host, refresh),
        },
      ],
    },
    {
      type: "group",
      heading: "Selective sync",
      items: [
        {
          name: "Excluded folders",
          desc: "Device-local vault folders that Meridian leaves untouched. One folder per line.",
          aliases: ["ignore folders", "select folders", "files"],
          control: {
            type: "textarea",
            key: "excludedFolders",
            rows: 3,
            placeholder: "Archive\nAttachments/private",
          },
        },
        {
          name: "Excluded file extensions",
          desc: "Device-local file types that Meridian leaves untouched, separated by commas.",
          aliases: ["ignore file types", "attachments", "extensions"],
          control: {
            type: "text",
            key: "excludedExtensions",
            placeholder: "mov, zip",
          },
        },
        {
          name: "Apply selective sync",
          desc: "Scan now. Changing exclusions never creates remote deletion records.",
          aliases: ["scan exclusions"],
          action: () => void runSettingAction(host.syncNow(), "Selective sync settings applied"),
        },
      ],
    },
    {
      type: "group",
      heading: "Configuration sync",
      items: [
        configToggle("Main settings", "config.main", ["app settings"]),
        configToggle("Appearance", "config.appearance", ["theme settings"]),
        configToggle("Themes and CSS snippets", "config.themes", ["snippets"]),
        configToggle("Hotkeys", "config.hotkeys", ["keyboard shortcuts"]),
        configToggle("Active core plugin list", "config.core-plugins", ["core plugins"]),
        configToggle("Core plugin settings", "config.core-plugin-settings", ["plugin options"]),
      ],
    },
    {
      type: "group",
      heading: "Network and mobile",
      items: [
        {
          name: "Polling interval",
          desc: "Fallback interval in seconds when live notifications are unavailable.",
          aliases: ["network refresh"],
          control: {
            type: "slider",
            key: "pollIntervalSeconds",
            min: 15,
            max: 300,
            step: 15,
            displayFormat: (value) => `${value} s`,
          },
        },
        {
          name: "Full scan interval",
          desc: "Periodic reconciliation recovers events missed while a mobile device was suspended.",
          aliases: ["iOS background scan"],
          control: {
            type: "slider",
            key: "scanIntervalMinutes",
            min: 1,
            max: 30,
            step: 1,
            displayFormat: (value) => `${value} min`,
          },
        },
        {
          name: "Attachment size limit",
          desc: "Conservative per-file memory limit for whole-file mobile APIs.",
          aliases: ["maximum file size", "MiB"],
          control: {
            type: "dropdown",
            key: "maxFileSizeMiB",
            options: { "16": "16 MiB", "32": "32 MiB", "64": "64 MiB", "128": "128 MiB" },
          },
        },
      ],
    },
    {
      type: "group",
      heading: "Security and protocol",
      items: [
        {
          name: "Vault protocol",
          desc: "Track the automatic upgrade to canonical generation-1 log hashes.",
          aliases: ["log hash", "security migration", "canonical log"],
          visible: () => configured,
          render: (setting) => configureProtocolUpgrade(setting, host),
        },
        {
          name: "Encryption epoch",
          desc: "Track automatic vault encryption key rotation.",
          aliases: ["key rotation", "revocation", "epoch"],
          visible: () => configured,
          render: (setting) => configureEpochStatus(setting, host),
        },
      ],
    },
    {
      type: "group",
      heading: "Storage and retention",
      items: [
        {
          name: "Storage usage",
          desc: "Review encrypted blob, operation, checkpoint, and snapshot storage.",
          aliases: ["space", "R2", "database"],
          visible: () => configured,
          action: () => new StorageModal(host).open(),
        },
        {
          name: "Automatic pruning",
          desc: "Unavailable until every active device can acknowledge and rebootstrap from a signed generation-aware snapshot.",
          aliases: ["retention", "delete old history", "cleanup"],
          render: (setting) =>
            void setting.addButton((button) =>
              button.setButtonText("Not available").setDisabled(true),
            ),
        },
      ],
    },
    {
      type: "group",
      heading: "Recovery and repair",
      items: [
        {
          name: "Recover vault ownership",
          desc: "Use the offline recovery code after losing every authorized device.",
          aliases: ["recovery code", "lost devices"],
          action: () => new RecoveryConnectModal(host).open(),
        },
        {
          name: "Rebuild local index",
          desc: "Delete only rebuildable local scan state. Remote history and vault data remain intact.",
          aliases: ["repair", "rescan"],
          action: () =>
            void runSettingAction(host.repairLocalIndex(), "Meridian local index rebuilt"),
        },
      ],
    },
  ]
}

function configToggle(
  name: string,
  key: MeridianSettingKey,
  aliases: string[],
): SettingDefinition<MeridianSettingKey> {
  return {
    name,
    desc: "Local to this device. Secrets, workspace state, caches, and temporary files stay excluded.",
    aliases,
    control: { type: "toggle", key },
  }
}

function configureEpochStatus(setting: Setting, host: MeridianUiHost): void {
  void host
    .getEpochStatus()
    .then((status) => {
      if (!status) {
        setting.setDesc("Connect Meridian to inspect encryption key rotation.")
        return
      }
      if (status.pending) {
        setting.setDesc(
          `Epoch ${status.sequence}. A signed key rotation is stored and will retry automatically.`,
        )
        return
      }
      setting.setDesc(
        `Epoch ${status.sequence}. Keys rotate automatically after migration, recovery, or device revocation.`,
      )
    })
    .catch((error) => {
      setting.setDesc(error instanceof Error ? error.message : "Unable to inspect encryption epoch")
    })
}

function configureProtocolUpgrade(setting: Setting, host: MeridianUiHost): void {
  if (host.settings.pendingProtocolUpgrade) {
    setting.setDesc(
      "The signed automatic upgrade is safely stored and will retry during the next sync.",
    )
    return
  }
  void host
    .getLogFormat()
    .then((format) => {
      if (format === "canonical-cbor-v1") {
        setting.setDesc("This vault uses verified canonical generation-1 operation log hashes.")
        return
      }
      if (format === "legacy-http-v1") {
        setting.setDesc(
          "Waiting for every active device to update and check in. Meridian will then upgrade the vault automatically.",
        )
        return
      }
      setting.setDesc("Connect Meridian to inspect the vault protocol.")
    })
    .catch((error) => {
      setting.setDesc(error instanceof Error ? error.message : "Unable to inspect vault protocol")
    })
}

function configureConnection(setting: Setting, host: MeridianUiHost, refresh: () => void): void {
  const connection = connectionControlState(host.settings, host.getStatus().phase)
  setting.addButton((button) =>
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
          refresh()
          new Notice(action === "pause" ? "Meridian sync paused" : "Meridian sync resumed")
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Unable to change sync state")
          button.setDisabled(false)
        }
      }),
  )
}

function configurePairingRetry(setting: Setting, host: MeridianUiHost, refresh: () => void): void {
  setting.addButton((button) =>
    button
      .setButtonText("Retry pairing")
      .setCta()
      .onClick(async () => {
        button.setDisabled(true)
        try {
          await host.completePendingPairing()
          refresh()
          new Notice("Device pairing completed")
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Unable to finish pairing")
          button.setDisabled(false)
        }
      }),
  )
}

function configureDeviceRemoval(
  setting: Setting,
  host: MeridianUiHost,
  refresh: () => void,
): () => void {
  let active = true
  const addRemovalButton = (label: string) => {
    if (!active || setting.controlEl.childElementCount > 0) return
    setting.addButton((button) =>
      button
        .setButtonText(label)
        .setWarning()
        .onClick(() => new RemoveCurrentDeviceModal(host, refresh).open()),
    )
  }
  if (host.settings.pendingDeviceRemoval) {
    setting.setDesc("A previous removal is pending. Retry server revocation and local cleanup.")
    addRemovalButton("Retry removal")
    return () => {
      active = false
    }
  }
  setting.setDesc("Checking whether this device can remove its Meridian identity…")
  void host
    .getDevices()
    .then((devices) => {
      if (!active) return
      const current = devices.find((device) => device.deviceId === host.settings.deviceId)
      if (!current || current.revokedAt !== null) {
        setting.setDesc(
          "This identity may already be revoked. Remove the local connection to pair again.",
        )
        addRemovalButton("Remove")
      } else if (current.role === "owner") {
        setting.setDesc("The owner device cannot remove itself. Use recovery after owner loss.")
      } else {
        setting.setDesc("Permanently revoke this device. Local vault files are kept.")
        addRemovalButton("Remove")
      }
    })
    .catch(() => {
      if (!active) return
      setting.setDesc(
        "Unable to verify this identity. Removal proceeds only after server confirmation.",
      )
      addRemovalButton("Remove")
    })
  return () => {
    active = false
  }
}

async function runSettingAction(action: Promise<void>, success: string): Promise<void> {
  try {
    await action
    new Notice(success)
  } catch (error) {
    new Notice(error instanceof Error ? error.message : "Unable to update Meridian settings")
  }
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
