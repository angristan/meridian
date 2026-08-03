import { type App, type Plugin, PluginSettingTab, type SettingDefinitionItem } from "obsidian"
import type { MeridianUiHost } from "../ui/views"
import { getMeridianSettingDefinitions, renderSettings } from "../ui/views"
import { getMeridianControlValue, setMeridianControlValue } from "./settings-controls"

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
