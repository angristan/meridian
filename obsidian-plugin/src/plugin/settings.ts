import {
  type App,
  Platform,
  type Plugin,
  PluginSettingTab,
  type SettingDefinitionItem,
} from "obsidian"
import type { MeridianUiHost } from "../ui/views"
import { getMeridianSettingDefinitions, renderSettings } from "../ui/views"
import { getMeridianControlValue, setMeridianControlValue } from "./settings-controls"

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

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return getMeridianSettingDefinitions(this.host, () => this.update())
  }

  override getControlValue(key: string): unknown {
    return getMeridianControlValue(this.host, key)
  }

  override setControlValue(key: string, value: unknown): Promise<void> {
    return setMeridianControlValue(this.host, key, value)
  }

  override display(): void {
    renderSettings(this.containerEl, this.host)
  }
}
