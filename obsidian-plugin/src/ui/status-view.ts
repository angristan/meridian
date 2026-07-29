import { ItemView, Notice, type WorkspaceLeaf } from "obsidian"
import { connectionControlState, statusPresentation } from "../plugin/connection-control"
import { DevicesModal } from "./devices-pairing"
import { formatTime } from "./format-time"
import { ConflictsModal, HistoryModal } from "./history-conflicts"
import type { MeridianUiHost } from "./host"

export const STATUS_VIEW_TYPE = "meridian-status"

export class MeridianStatusView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: MeridianUiHost,
  ) {
    super(leaf)
  }

  getViewType(): string {
    return STATUS_VIEW_TYPE
  }

  getDisplayText(): string {
    return "Meridian sync"
  }

  override getIcon(): string {
    return "cloud-cog"
  }

  override async onOpen(): Promise<void> {
    this.render()
  }

  render(): void {
    const status = this.host.getStatus()
    const connection = connectionControlState(this.host.settings)
    const presentation = statusPresentation(status, connection)
    const container = this.contentEl
    container.empty()
    container.addClass("meridian-status-view")
    const header = container.createDiv({ cls: "meridian-status-header" })
    header.createDiv({ cls: `meridian-status-dot is-${status.phase}` })
    const title = header.createDiv()
    title.createEl("strong", { text: status.message })
    title.createDiv({ cls: "setting-item-description", text: presentation.summary })

    const grid = container.createDiv({ cls: "meridian-metric-grid" })
    metric(grid, "Cursor", String(status.cursor))
    metric(grid, "Queued", String(status.queued))
    metric(grid, "Live updates", presentation.liveUpdates)
    metric(grid, "Last sync", status.lastSyncedAt ? formatTime(status.lastSyncedAt) : "Never")

    if (status.error) {
      container.createDiv({ cls: "meridian-callout is-error", text: status.error })
    }
    if (connection.kind === "unconfigured") {
      container.createDiv({
        cls: "meridian-callout",
        text: "Open the setup link from your Cloudflare deployment to connect this vault.",
      })
    }

    const actions = container.createDiv({ cls: "meridian-actions" })
    const syncButton = actions.createEl("button", { text: presentation.syncLabel })
    syncButton.disabled = !connection.canSync
    if (connection.canSync) syncButton.addClass("mod-cta")
    syncButton.addEventListener("click", () => void this.runSync(syncButton))

    if (connection.kind !== "unconfigured") {
      const connectionButton = actions.createEl("button", { text: connection.label })
      connectionButton.disabled = connection.disabled
      if (connection.action === "resume") connectionButton.addClass("mod-cta")
      connectionButton.addEventListener("click", () => void this.runConnectionAction())
    }

    const historyButton = actions.createEl("button", { text: "History" })
    historyButton.addEventListener("click", () => new HistoryModal(this.host).open())
    const conflictsButton = actions.createEl("button", { text: "Conflicts" })
    conflictsButton.addEventListener("click", () => new ConflictsModal(this.host).open())
    const devicesButton = actions.createEl("button", { text: "Devices" })
    devicesButton.addEventListener("click", () => new DevicesModal(this.host).open())
    const settingsButton = actions.createEl("button", { text: "Settings" })
    settingsButton.addEventListener("click", () => this.host.openSettings())
  }

  private async runSync(button: HTMLButtonElement): Promise<void> {
    button.disabled = true
    try {
      await this.host.syncNow()
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Unable to synchronize Meridian")
    } finally {
      this.render()
    }
  }

  private async runConnectionAction(): Promise<void> {
    const action = connectionControlState(this.host.settings).action
    if (action !== "pause" && action !== "resume") return
    try {
      if (action === "pause") await this.host.disconnect()
      else await this.host.resumeConnection()
      new Notice(action === "pause" ? "Meridian sync paused" : "Meridian sync resumed")
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Unable to change sync state")
    } finally {
      this.render()
    }
  }
}

function metric(container: HTMLElement, label: string, value: string): void {
  const element = container.createDiv({ cls: "meridian-metric" })
  element.createDiv({ cls: "meridian-metric-label", text: label })
  element.createEl("strong", { text: value })
}
