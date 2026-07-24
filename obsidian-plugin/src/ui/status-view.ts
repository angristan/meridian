import { ItemView, type WorkspaceLeaf } from "obsidian"
import type { SyncStatus } from "../model"
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
    const container = this.contentEl
    container.empty()
    container.addClass("meridian-status-view")
    const header = container.createDiv({ cls: "meridian-status-header" })
    header.createDiv({ cls: `meridian-status-dot is-${status.phase}` })
    const title = header.createDiv()
    title.createEl("strong", { text: status.message })
    title.createDiv({ cls: "setting-item-description", text: statusSummary(status) })

    const grid = container.createDiv({ cls: "meridian-metric-grid" })
    metric(grid, "Cursor", String(status.cursor))
    metric(grid, "Queued", String(status.queued))
    metric(grid, "Live updates", status.socketConnected ? "Connected" : "Polling")
    metric(grid, "Last sync", status.lastSyncedAt ? formatTime(status.lastSyncedAt) : "Never")

    if (status.error) {
      container.createDiv({ cls: "meridian-callout is-error", text: status.error })
    }
    if (!this.host.settings.endpoint) {
      container.createDiv({
        cls: "meridian-callout",
        text: "Open the setup link from your Cloudflare deployment to connect this vault.",
      })
    }

    const actions = container.createDiv({ cls: "meridian-actions" })
    const syncButton = actions.createEl("button", { text: "Sync now", cls: "mod-cta" })
    syncButton.disabled = !this.host.settings.endpoint
    syncButton.addEventListener("click", () => void this.host.syncNow())
    const historyButton = actions.createEl("button", { text: "History" })
    historyButton.addEventListener("click", () => new HistoryModal(this.host).open())
    const conflictsButton = actions.createEl("button", { text: "Conflicts" })
    conflictsButton.addEventListener("click", () => new ConflictsModal(this.host).open())
    const devicesButton = actions.createEl("button", { text: "Devices" })
    devicesButton.addEventListener("click", () => new DevicesModal(this.host).open())
  }
}

function metric(container: HTMLElement, label: string, value: string): void {
  const element = container.createDiv({ cls: "meridian-metric" })
  element.createDiv({ cls: "meridian-metric-label", text: label })
  element.createEl("strong", { text: value })
}

function statusSummary(status: SyncStatus): string {
  if (status.phase === "offline") return `${status.queued} changes queued locally`
  return status.error ?? `${status.queued} queued · cursor ${status.cursor}`
}
