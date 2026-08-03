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
import { ConnectionModal } from "./connection-modals"
import { DevicesModal } from "./devices-pairing"
import type { MeridianUiHost } from "./host"
import { TroubleshootingModal } from "./troubleshooting-modal"

interface LegacySettingPresentation {
  visible?: boolean | (() => boolean)
}

type MeridianSettingSpec = SettingDefinition<MeridianSettingKey> & {
  legacy?: LegacySettingPresentation
}

type MeridianSettingGroupSpec = Omit<SettingDefinitionGroup<MeridianSettingKey>, "items"> & {
  items: MeridianSettingSpec[]
  legacy?: { heading?: boolean }
}

const CONFIGURATION_CATEGORIES: Array<{
  key: MeridianSettingKey
  name: string
  description: string
}> = [
  {
    key: "config.main",
    name: "Main settings",
    description: "Editor and application settings.",
  },
  {
    key: "config.appearance",
    name: "Appearance",
    description: "Theme choice and appearance options.",
  },
  {
    key: "config.themes",
    name: "Themes and CSS snippets",
    description: "Installed themes and custom CSS snippets.",
  },
  {
    key: "config.hotkeys",
    name: "Hotkeys",
    description: "Custom keyboard shortcuts.",
  },
  {
    key: "config.core-plugins",
    name: "Core plugins",
    description: "The active core plugin list.",
  },
  {
    key: "config.core-plugin-settings",
    name: "Core plugin settings",
    description: "Settings for supported core plugins.",
  },
]

export function renderSettings(container: HTMLElement, host: MeridianUiHost): void {
  container.empty()
  const groups = createMeridianSettingGroups(host, () => renderSettings(container, host))
  for (const group of groups) renderLegacyGroup(container, group)
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
      heading: "Meridian",
      legacy: { heading: false },
      items: [
        {
          name: "Connection",
          desc: configured ? host.settings.endpoint : "Not connected",
          aliases: ["connect", "pause", "resume", "endpoint"],
          render: (setting) => configureConnection(setting, host, refresh),
        },
        {
          name: "Devices and recovery",
          desc: "Add, rename, or revoke devices. Recovery is available here too.",
          aliases: ["pair", "revoke", "remove device", "recovery code"],
          visible: configured,
          render: (setting) =>
            void setting.addButton((button) =>
              button.setButtonText("Manage").onClick(() => new DevicesModal(host).open()),
            ),
          legacy: { visible: configured },
        },
      ],
    },
    {
      type: "group",
      heading: "Configuration sync",
      items: [
        {
          name: "Obsidian configuration",
          desc: configurationSummary(host),
          aliases: [
            "app settings",
            "appearance",
            "themes",
            "CSS snippets",
            "hotkeys",
            "core plugins",
          ],
          render: (setting) =>
            void setting.addButton((button) =>
              button
                .setButtonText("Customize")
                .onClick(() => new ConfigurationSyncModal(host, refresh).open()),
            ),
        },
      ],
    },
    {
      type: "group",
      heading: "Advanced",
      items: [
        {
          name: "Troubleshooting",
          desc: "Technical status, storage details, privacy-safe logs, and repair tools.",
          aliases: ["diagnostics", "log", "storage", "encryption epoch", "repair"],
          render: (setting) =>
            void setting.addButton((button) =>
              button.setButtonText("Open").onClick(() => new TroubleshootingModal(host).open()),
            ),
        },
      ],
    },
  ]
}

class ConfigurationSyncModal extends Modal {
  constructor(
    private readonly host: MeridianUiHost,
    private readonly refreshSettings: () => void,
  ) {
    super(host.app)
  }

  override onOpen(): void {
    this.setTitle("Obsidian configuration")
    this.contentEl.createDiv({
      cls: "setting-item-description meridian-section-description",
      text: "Choose which supported Obsidian settings appear on this device. Workspace layouts, plugin data, caches, temporary files, and secrets never sync.",
    })
    for (const item of CONFIGURATION_CATEGORIES) {
      new Setting(this.contentEl)
        .setName(item.name)
        .setDesc(item.description)
        .addToggle((toggle) =>
          toggle
            .setValue(Boolean(getMeridianControlValue(this.host, item.key)))
            .onChange(async (value) => {
              try {
                await setMeridianControlValue(this.host, item.key, value)
                this.refreshSettings()
              } catch (error) {
                new Notice(
                  error instanceof Error ? error.message : "Unable to update configuration sync",
                )
                toggle.setValue(!value)
              }
            }),
        )
    }
  }

  override onClose(): void {
    this.contentEl.empty()
  }
}

function configurationSummary(host: MeridianUiHost): string {
  const enabled = Object.values(host.settings.configCategories).filter(Boolean).length
  if (enabled === 0) return "Off on this device. Secrets and temporary state never sync."
  if (enabled === CONFIGURATION_CATEGORIES.length) {
    return "All supported settings. Secrets and temporary state never sync."
  }
  return `${enabled} of ${CONFIGURATION_CATEGORIES.length} categories on this device.`
}

function renderLegacyGroup(container: HTMLElement, group: MeridianSettingGroupSpec): void {
  if (group.legacy?.heading !== false && group.heading) {
    new Setting(container).setName(group.heading).setHeading()
  }
  group.items.forEach((item) => {
    const visible = item.legacy?.visible ?? item.visible
    if (!evaluate(visible, true)) return
    const setting = new Setting(container).setName(item.name)
    if (item.desc) setting.setDesc(item.desc)
    if (item.render) item.render(setting, undefined as never)
  })
}

function evaluate(value: boolean | (() => boolean) | undefined, fallback: boolean): boolean {
  if (typeof value === "function") return value()
  return value ?? fallback
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
