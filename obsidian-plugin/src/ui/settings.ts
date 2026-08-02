import {
  Modal,
  Notice,
  Setting,
  type SettingDefinition,
  type SettingDefinitionGroup,
  type SettingDefinitionItem,
} from "obsidian"
import { connectionControlState } from "../plugin/connection-control"
import {
  getMeridianControlValue,
  type MeridianSettingKey,
  setMeridianControlValue,
} from "../plugin/settings-controls"
import { ConnectionModal, RecoveryConnectModal } from "./connection-modals"
import type { MeridianUiHost } from "./host"
import { StorageModal } from "./storage-modal"

interface LegacySettingPresentation {
  description?: false
  button?: {
    label: string
    disabled?: boolean | (() => boolean)
    wait?: boolean
    warning?: boolean
  }
  visible?: boolean | (() => boolean)
}

type MeridianSettingSpec = SettingDefinition<MeridianSettingKey> & {
  legacy?: LegacySettingPresentation
}

type MeridianSettingGroupSpec = Omit<SettingDefinitionGroup<MeridianSettingKey>, "items"> & {
  items: MeridianSettingSpec[]
  legacy?: {
    description?: string
    heading?: boolean
  }
}

export function renderSettings(container: HTMLElement, host: MeridianUiHost): void {
  container.empty()
  const groups = createMeridianSettingGroups(host, () => renderSettings(container, host))
  for (const group of groups) renderLegacyGroup(container, host, group)
}

export function getMeridianSettingDefinitions(
  host: MeridianUiHost,
  refresh: () => void,
): SettingDefinitionItem<MeridianSettingKey>[] {
  return createMeridianSettingGroups(host, refresh)
}

function createMeridianSettingGroups(
  host: MeridianUiHost,
  refresh: () => void,
): MeridianSettingGroupSpec[] {
  const connection = connectionControlState(host.settings, host.getStatus().phase)
  const configured = connection.kind !== "unconfigured"
  return [
    {
      type: "group",
      heading: "Connection and device",
      legacy: { heading: false },
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
          desc: "The keys are stored locally, but server authorization still needs confirmation. Retry safely without creating another device identity.",
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
      legacy: {
        description:
          "Exclusions are local to this device. Excluded files remain in the vault and in remote history. Re-enabling a locally changed file creates a new revision instead of deleting prior versions.",
      },
      items: [
        {
          name: "Excluded folders",
          desc: "One vault-relative folder per line. Hidden folders and Obsidian configuration are managed separately.",
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
          desc: "Comma-separated extensions without a leading dot, for example mov, zip, or psd.",
          aliases: ["ignore file types", "attachments", "extensions"],
          control: {
            type: "text",
            key: "excludedExtensions",
            placeholder: "mov, zip",
          },
        },
        {
          name: "Apply selective sync",
          desc: "Scan now with the current exclusions. Changing exclusions never creates deletion records.",
          aliases: ["scan exclusions"],
          action: () => runSettingAction(host.syncNow(), "Selective sync settings applied"),
          legacy: { button: { label: "Apply now", wait: true } },
        },
      ],
    },
    {
      type: "group",
      heading: "Configuration sync",
      legacy: {
        description:
          "Selections are local to this device. Workspace layouts, caches, temporary files, plugin state, and secrets are always excluded.",
      },
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
          desc: "Periodic reconciliation recovers file events missed while iOS was suspended.",
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
          desc: "Whole-file mobile APIs require a conservative per-file memory limit in MiB.",
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
      heading: "Security",
      items: [
        {
          name: "Encryption epoch",
          desc: "Checking encryption key rotation state…",
          aliases: ["key rotation", "revocation", "epoch"],
          visible: () => configured,
          render: (setting) => configureEpochStatus(setting, host),
          legacy: { visible: true },
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
          legacy: {
            visible: true,
            button: { label: "View usage", disabled: () => !configured },
          },
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
          legacy: { button: { label: "Recover", warning: true } },
        },
        {
          name: "Rebuild local index",
          desc: "Deletes only rebuildable local scan state. Remote history and encrypted vault data remain intact.",
          aliases: ["repair", "rescan"],
          action: () => runSettingAction(host.repairLocalIndex(), "Meridian local index rebuilt"),
          legacy: { button: { label: "Rebuild", warning: true } },
        },
      ],
    },
  ]
}

function configToggle(
  name: string,
  key: MeridianSettingKey,
  aliases: string[],
): MeridianSettingSpec {
  return {
    name,
    desc: "Local to this device. Secrets, workspace state, caches, and temporary files stay excluded.",
    aliases,
    control: { type: "toggle", key },
    legacy: { description: false },
  }
}

function renderLegacyGroup(
  container: HTMLElement,
  host: MeridianUiHost,
  group: MeridianSettingGroupSpec,
): void {
  if (group.legacy?.heading !== false && group.heading) {
    new Setting(container).setName(group.heading).setHeading()
  }
  if (group.legacy?.description) {
    container.createDiv({
      cls: "setting-item-description meridian-section-description",
      text: group.legacy.description,
    })
  }
  group.items.forEach((item, index) => {
    const visible = item.legacy?.visible ?? item.visible
    if (!evaluate(visible, true)) return
    const setting = new Setting(container).setName(item.name)
    if (item.desc && item.legacy?.description !== false) setting.setDesc(item.desc)
    if (item.render) {
      item.render(setting, undefined as never)
    } else if (item.control) {
      renderLegacyControl(setting, host, item.control)
    } else if (item.action) {
      renderLegacyAction(setting, item, index)
    }
  })
}

function renderLegacyControl(
  setting: Setting,
  host: MeridianUiHost,
  control: NonNullable<Extract<MeridianSettingSpec, { control: object }>["control"]>,
): void {
  const value = getMeridianControlValue(host, control.key)
  const save = (next: unknown) => setMeridianControlValue(host, control.key, next)
  switch (control.type) {
    case "text":
      setting.addText((text) => {
        if (control.placeholder) text.setPlaceholder(control.placeholder)
        return text.setValue(String(value ?? "")).onChange(save)
      })
      break
    case "textarea":
      setting.addTextArea((text) => {
        if (control.rows) text.inputEl.rows = control.rows
        if (control.placeholder) text.setPlaceholder(control.placeholder)
        return text.setValue(String(value ?? "")).onChange(save)
      })
      break
    case "toggle":
      setting.addToggle((toggle) => toggle.setValue(Boolean(value)).onChange(save))
      break
    case "slider":
      setting.addSlider((slider) =>
        slider
          .setLimits(control.min, control.max, control.step)
          .setDynamicTooltip()
          .setValue(Number(value))
          .onChange(save),
      )
      break
    case "dropdown":
      setting.addDropdown((dropdown) =>
        dropdown
          .addOptions(control.options)
          .setValue(String(value ?? ""))
          .onChange(save),
      )
      break
    default:
      break
  }
}

function renderLegacyAction(setting: Setting, item: MeridianSettingSpec, index: number): void {
  if (!item.action || !item.legacy?.button) return
  const { button: presentation } = item.legacy
  setting.addButton((button) => {
    button.setButtonText(presentation.label).setDisabled(evaluate(presentation.disabled, false))
    if (presentation.warning) button.setWarning()
    return button.onClick(async () => {
      if (presentation.wait) button.setDisabled(true)
      try {
        await item.action?.(setting.settingEl, index)
      } finally {
        if (presentation.wait) button.setDisabled(false)
      }
    })
  })
}

function evaluate(value: boolean | (() => boolean) | undefined, fallback: boolean): boolean {
  if (typeof value === "function") return value()
  return value ?? fallback
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
    setting.setDesc(
      "A previous removal attempt is pending. Retry to confirm server revocation and finish local cleanup.",
    )
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
          "This identity may already be revoked. Remove its local Meridian connection to pair again.",
        )
        addRemovalButton("Remove")
      } else if (current.role === "owner") {
        setting.setDesc(
          "The owner device cannot remove itself. Use recovery from another device after owner loss.",
        )
      } else {
        setting.setDesc(
          "Permanently revoke this device and forget its local Meridian connection. Vault files are kept.",
        )
        addRemovalButton("Remove")
      }
    })
    .catch(() => {
      if (!active) return
      setting.setDesc(
        "Unable to verify this identity. Removal will proceed only if the server confirms it safely.",
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
