import type { MeridianSettings } from "../model"
import { normalizeExcludedExtension, normalizeExcludedFolder } from "../vault/path-policy"

export type MeridianSettingKey =
  | "deviceName"
  | "excludedFolders"
  | "excludedExtensions"
  | "config.main"
  | "config.appearance"
  | "config.themes"
  | "config.hotkeys"
  | "config.core-plugins"
  | "config.core-plugin-settings"
  | "pollIntervalSeconds"
  | "scanIntervalMinutes"
  | "maxFileSizeMiB"

export interface SettingsControlHost {
  settings: MeridianSettings
  saveSettings(): Promise<void>
  syncNow(): Promise<void>
}

export function getMeridianControlValue(host: SettingsControlHost, key: string): unknown {
  switch (key as MeridianSettingKey) {
    case "deviceName":
      return host.settings.deviceName
    case "excludedFolders":
      return host.settings.selectiveSync.excludedFolders.join("\n")
    case "excludedExtensions":
      return host.settings.selectiveSync.excludedExtensions.join(", ")
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
    case "pollIntervalSeconds":
      return host.settings.pollIntervalSeconds
    case "scanIntervalMinutes":
      return host.settings.scanIntervalMinutes
    case "maxFileSizeMiB":
      return String(host.settings.maxFileSizeMiB)
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
    case "deviceName":
      if (typeof value === "string") host.settings.deviceName = value.trim().slice(0, 80)
      break
    case "excludedFolders":
      if (typeof value === "string") {
        host.settings.selectiveSync.excludedFolders = normalizeList(
          value.split("\n"),
          normalizeExcludedFolder,
        )
      }
      break
    case "excludedExtensions":
      if (typeof value === "string") {
        host.settings.selectiveSync.excludedExtensions = normalizeList(
          value.split(/[\s,]+/),
          normalizeExcludedExtension,
        )
      }
      break
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
    case "pollIntervalSeconds":
      if (typeof value === "number") {
        host.settings.pollIntervalSeconds = Math.max(15, Math.min(300, value))
      }
      break
    case "scanIntervalMinutes":
      if (typeof value === "number") {
        host.settings.scanIntervalMinutes = Math.max(1, Math.min(30, value))
      }
      break
    case "maxFileSizeMiB": {
      const maximum = Number(value)
      if ([16, 32, 64, 128].includes(maximum)) host.settings.maxFileSizeMiB = maximum
      break
    }
  }
  await host.saveSettings()
  if (rescan) await host.syncNow()
}

function normalizeList(values: string[], normalize: (value: string) => string | null): string[] {
  const normalized = values.map(normalize).filter((value): value is string => value !== null)
  return [...new Set(normalized)].sort().slice(0, 200)
}
