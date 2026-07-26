import { type App, Platform, type Plugin, PluginSettingTab } from "obsidian"
import type { MeridianUiHost } from "../ui/views"
import { renderSettings } from "../ui/views"

export { normalizeSettings, withoutMeridianIdentity } from "./settings-state"

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
