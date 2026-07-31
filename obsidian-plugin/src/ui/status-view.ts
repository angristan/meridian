import { ItemView, Notice, type WorkspaceLeaf } from "obsidian"
import type { SyncPhase, SyncProgress } from "../model"
import { connectionControlState, statusPresentation } from "../plugin/connection-control"
import { DevicesModal } from "./devices-pairing"
import { formatTime } from "./format-time"
import { ConflictsModal, HistoryModal } from "./history-conflicts"
import type { MeridianUiHost } from "./host"
import { presentSyncProgressSlot } from "./sync-progress"

export const STATUS_VIEW_TYPE = "meridian-status"

interface ProgressElements {
  panel: HTMLDivElement
  label: HTMLElement
  percent: HTMLSpanElement
  bar: HTMLProgressElement
  detail: HTMLDivElement
}

interface StatusElements {
  dot: HTMLDivElement
  message: HTMLElement
  summary: HTMLDivElement
  progress: ProgressElements
  cursor: HTMLElement
  queued: HTMLElement
  liveUpdates: HTMLElement
  lastSync: HTMLElement
  error: HTMLDivElement
  setup: HTMLDivElement
  syncButton: HTMLButtonElement
  connectionButton: HTMLButtonElement
}

export class MeridianStatusView extends ItemView {
  private elements: StatusElements | null = null

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
    this.elements = this.build()
    this.render()
  }

  render(): void {
    if (!this.elements) this.elements = this.build()
    const elements = this.elements
    const status = this.host.getStatus()
    const connection = connectionControlState(this.host.settings, status.phase)
    const presentation = statusPresentation(status, connection)

    elements.dot.className = `meridian-status-dot is-${status.phase}`
    elements.message.setText(status.message)
    elements.summary.setText(presentation.summary)
    updateProgress(elements.progress, status.progress, status.phase)
    elements.cursor.setText(String(status.cursor))
    elements.queued.setText(String(status.queued))
    elements.liveUpdates.setText(presentation.liveUpdates)
    elements.lastSync.setText(status.lastSyncedAt ? formatTime(status.lastSyncedAt) : "Never")

    elements.error.hidden = status.error === null
    elements.error.setText(status.error ?? "")
    elements.setup.hidden = connection.kind !== "unconfigured"

    const busy = ["scanning", "pulling", "pushing", "pausing"].includes(status.phase)
    elements.syncButton.setText(presentation.syncLabel)
    elements.syncButton.disabled = !connection.canSync || busy
    elements.syncButton.toggleClass("mod-cta", connection.canSync && !busy)

    elements.connectionButton.hidden = connection.kind === "unconfigured"
    elements.connectionButton.setText(connection.label)
    elements.connectionButton.disabled = connection.disabled
    elements.connectionButton.toggleClass("mod-cta", connection.action === "resume")
  }

  private build(): StatusElements {
    const container = this.contentEl
    container.empty()
    container.addClass("meridian-status-view")

    const header = container.createDiv({ cls: "meridian-status-header" })
    const dot = header.createDiv({ cls: "meridian-status-dot" })
    const title = header.createDiv({ cls: "meridian-status-copy" })
    const message = title.createEl("strong")
    const summary = title.createDiv({ cls: "setting-item-description" })
    const progress = createProgress(container)

    const grid = container.createDiv({ cls: "meridian-metric-grid" })
    const cursor = metric(grid, "Cursor")
    const queued = metric(grid, "Queued")
    const liveUpdates = metric(grid, "Live updates")
    const lastSync = metric(grid, "Last sync")

    const error = container.createDiv({ cls: "meridian-callout is-error" })
    error.hidden = true
    const setup = container.createDiv({
      cls: "meridian-callout",
      text: "Open the setup link from your Cloudflare deployment to connect this vault.",
    })
    setup.hidden = true

    const actions = container.createDiv({ cls: "meridian-actions" })
    const syncButton = actions.createEl("button")
    syncButton.addEventListener("click", () => void this.runSync(syncButton))

    const connectionButton = actions.createEl("button")
    connectionButton.addEventListener("click", () => void this.runConnectionAction())

    const historyButton = actions.createEl("button", { text: "History" })
    historyButton.addEventListener("click", () => new HistoryModal(this.host).open())
    const conflictsButton = actions.createEl("button", { text: "Conflicts" })
    conflictsButton.addEventListener("click", () => new ConflictsModal(this.host).open())
    const devicesButton = actions.createEl("button", { text: "Devices" })
    devicesButton.addEventListener("click", () => new DevicesModal(this.host).open())
    const settingsButton = actions.createEl("button", { text: "Settings" })
    settingsButton.addEventListener("click", () => this.host.openSettings())

    return {
      dot,
      message,
      summary,
      progress,
      cursor,
      queued,
      liveUpdates,
      lastSync,
      error,
      setup,
      syncButton,
      connectionButton,
    }
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
    const action = connectionControlState(this.host.settings, this.host.getStatus().phase).action
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

function createProgress(container: HTMLElement): ProgressElements {
  const panel = container.createDiv({ cls: "meridian-progress is-idle" })
  const header = panel.createDiv({ cls: "meridian-progress-header" })
  const label = header.createEl("strong")
  const percent = header.createSpan({ cls: "meridian-progress-percent" })
  const bar = panel.createEl("progress", { cls: "meridian-progress-bar" })
  const detail = panel.createDiv({
    cls: "setting-item-description meridian-progress-detail",
  })
  return { panel, label, percent, bar, detail }
}

function updateProgress(
  elements: ProgressElements,
  progress: SyncProgress | null,
  phase: SyncPhase,
): void {
  const presentation = presentSyncProgressSlot(progress, phase)
  elements.panel.toggleClass("is-idle", progress === null)
  elements.label.setText(presentation.label)
  elements.percent.setText(presentation.percent ?? "")
  elements.detail.setText(presentation.detail)
  elements.detail.title = presentation.detail
  elements.bar.max = presentation.max
  if (presentation.indeterminate) elements.bar.removeAttribute("value")
  else elements.bar.value = presentation.value
  elements.bar.setAttribute("aria-label", presentation.label)
}

function metric(container: HTMLElement, label: string): HTMLElement {
  const element = container.createDiv({ cls: "meridian-metric" })
  element.createDiv({ cls: "meridian-metric-label", text: label })
  return element.createEl("strong")
}
