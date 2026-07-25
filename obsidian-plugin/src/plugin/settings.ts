import { type App, Platform, type Plugin, PluginSettingTab } from "obsidian"
import { DEFAULT_SETTINGS, type MeridianSettings } from "../model"
import type { MeridianUiHost } from "../ui/views"
import { renderSettings } from "../ui/views"

export function normalizeSettings(loaded: unknown): MeridianSettings {
  const value = isRecord(loaded) ? loaded : {}
  const loadedCategories = isRecord(value.configCategories) ? value.configCategories : {}
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...value,
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    endpoint: typeof value.endpoint === "string" ? value.endpoint : "",
    vaultId: typeof value.vaultId === "string" ? value.vaultId : "",
    deviceId: typeof value.deviceId === "string" ? value.deviceId : "",
    deviceName: typeof value.deviceName === "string" ? value.deviceName : "",
    pollIntervalSeconds: boundedNumber(value.pollIntervalSeconds, 15, 300, 45),
    scanIntervalMinutes: boundedNumber(value.scanIntervalMinutes, 1, 30, 5),
    maxFileSizeMiB: boundedNumber(value.maxFileSizeMiB, 16, 128, 64),
    configCategories: {
      ...DEFAULT_SETTINGS.configCategories,
      main: booleanValue(loadedCategories.main, true),
      appearance: booleanValue(loadedCategories.appearance, true),
      themes: booleanValue(loadedCategories.themes, true),
      hotkeys: booleanValue(loadedCategories.hotkeys, true),
      "core-plugins": booleanValue(loadedCategories["core-plugins"], true),
      "core-plugin-settings": booleanValue(loadedCategories["core-plugin-settings"], true),
    },
  }
}

export function defaultDeviceName(): string {
  if (Platform.isIosApp) return "iPhone or iPad"
  if (Platform.isAndroidApp) return "Android device"
  if (Platform.isMacOS) return "Mac"
  if (Platform.isWin) return "Windows PC"
  if (Platform.isLinux) return "Linux computer"
  return "Desktop device"
}

export function defaultDevicePlatform(): string {
  if (Platform.isIosApp) return "iOS"
  if (Platform.isAndroidApp) return "Android"
  if (Platform.isMacOS) return "macOS"
  if (Platform.isWin) return "Windows"
  if (Platform.isLinux) return "Linux"
  return "Desktop"
}

export class MeridianSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly host: Plugin & MeridianUiHost,
  ) {
    super(app, host)
  }

  override display(): void {
    renderSettings(this.containerEl, this.host)
  }
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
