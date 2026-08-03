import type { MeridianSettings } from "../model"

export type MeridianSettingKey =
  | "config.main"
  | "config.appearance"
  | "config.themes"
  | "config.hotkeys"
  | "config.core-plugins"
  | "config.core-plugin-settings"

export interface SettingsControlHost {
  settings: MeridianSettings
  saveSettings(): Promise<void>
  syncNow(): Promise<void>
}

export function getMeridianControlValue(host: SettingsControlHost, key: string): unknown {
  switch (key as MeridianSettingKey) {
    case "config.main":
      return host.settings.configCategories.main
    case "config.appearance":
      return host.settings.configCategories.appearance
    case "config.themes":
      return host.settings.configCategories.themes
    case "config.hotkeys":
      return host.settings.configCategories.hotkeys
    case "config.core-plugins":
      return host.settings.configCategories["core-plugins"]
    case "config.core-plugin-settings":
      return host.settings.configCategories["core-plugin-settings"]
    default:
      return undefined
  }
}

export async function setMeridianControlValue(
  host: SettingsControlHost,
  key: string,
  value: unknown,
): Promise<void> {
  let rescan = false
  switch (key as MeridianSettingKey) {
    case "config.main":
    case "config.appearance":
    case "config.themes":
    case "config.hotkeys":
    case "config.core-plugins":
    case "config.core-plugin-settings": {
      if (typeof value !== "boolean") break
      const category = key.slice("config.".length) as keyof typeof host.settings.configCategories
      host.settings.configCategories[category] = value
      rescan = true
      break
    }
  }
  await host.saveSettings()
  if (rescan) await host.syncNow()
}
