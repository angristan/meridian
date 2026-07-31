import { ItemView, Notice, type WorkspaceLeaf } from "obsidian"
import type { SyncPhase, SyncProgress } from "../model"
import { connectionControlState, statusPresentation } from "../plugin/connection-control"
import { ActivityModal } from "./activity-modal"
import { DevicesModal } from "./devices-pairing"
import { formatRelativeTime, formatTime } from "./format-time"
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
  liveUpdates: HTMLElement
  lastSync: HTMLElement
  error: HTMLDivElement
  setup: HTMLDivElement
  syncButton: HTMLButtonElement
  connectionButton: HTMLButtonElement
  conflictsButton: HTMLButtonElement
  conflictBadge: HTMLSpanElement
}

export class MeridianStatusView extends ItemView {
  private elements: StatusElements | null = null
  private relativeTimeInterval: number | null = null
  private conflictRefresh: Promise<void> | null = null
  private lastPhase: SyncPhase | null = null

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
    if (this.relativeTimeInterval !== null) window.clearInterval(this.relativeTimeInterval)
    this.elements = this.build()
    this.render()
    this.relativeTimeInterval = window.setInterval(() => this.updateLastSync(), 30_000)
  }

  override async onClose(): Promise<void> {
    if (this.relativeTimeInterval !== null) window.clearInterval(this.relativeTimeInterval)
    this.relativeTimeInterval = null
    this.elements = null
    this.lastPhase = null
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
    elements.liveUpdates.setText(presentation.liveUpdates)
    this.updateLastSync()

    elements.error.hidden = status.error === null
    elements.error.setText(status.error ?? "")
    elements.setup.hidden = connection.kind !== "unconfigured"

    const busy = ["scanning", "pulling", "pushing", "pausing"].includes(status.phase)
    elements.syncButton.setText(presentation.syncLabel)
    elements.syncButton.disabled = !connection.canSync || busy
    elements.syncButton.toggleClass(
      "mod-cta",
      presentation.syncLabel === "Retry" && connection.canSync && !busy,
    )

    elements.connectionButton.hidden = connection.kind === "unconfigured"
    elements.connectionButton.setText(
      connection.action === "pause" ? "Pause automatic sync" : connection.label,
    )
    elements.connectionButton.disabled = connection.disabled
    elements.connectionButton.toggleClass("mod-cta", connection.action === "resume")
    elements.connectionButton.toggleClass(
      "meridian-connection-secondary",
      connection.action === "pause",
    )

    const phaseChanged = this.lastPhase !== status.phase
    this.lastPhase = status.phase
    if (phaseChanged && ["idle", "offline", "error"].includes(status.phase)) {
      void this.refreshConflictCount()
    }
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

    const meta = container.createDiv({ cls: "meridian-status-meta" })
    const liveUpdates = meta.createEl("strong")
    meta.createSpan({ cls: "meridian-status-meta-separator", text: "·" })
    const lastSync = meta.createSpan()

    const error = container.createDiv({ cls: "meridian-callout is-error" })
    error.hidden = true
    const setup = container.createDiv({
      cls: "meridian-callout",
      text: "Open the setup link from your Cloudflare deployment to connect this vault.",
    })
    setup.hidden = true

    const actions = container.createDiv({ cls: "meridian-actions" })
    const actionGrid = actions.createDiv({ cls: "meridian-action-grid" })
    const syncButton = actionGrid.createEl("button")
    syncButton.addEventListener("click", () => void this.runSync(syncButton))

    const activityButton = actionGrid.createEl("button", { text: "Activity" })
    activityButton.addEventListener("click", () => new ActivityModal(this.host).open())

    const historyButton = actionGrid.createEl("button", { text: "History" })
    historyButton.addEventListener("click", () => new HistoryModal(this.host).open())

    const conflictsButton = actionGrid.createEl("button")
    conflictsButton.createSpan({ text: "Conflicts" })
    const conflictBadge = conflictsButton.createSpan({ cls: "meridian-conflict-badge" })
    conflictBadge.hidden = true
    conflictsButton.addEventListener("click", () => {
      new ConflictsModal(this.host, () => void this.refreshConflictCount()).open()
    })

    const devicesButton = actionGrid.createEl("button", { text: "Devices" })
    devicesButton.addEventListener("click", () => new DevicesModal(this.host).open())
    const settingsButton = actionGrid.createEl("button", { text: "Settings" })
    settingsButton.addEventListener("click", () => this.host.openSettings())

    const connectionButton = actions.createEl("button", { cls: "meridian-connection-control" })
    connectionButton.addEventListener("click", () => void this.runConnectionAction())

    return {
      dot,
      message,
      summary,
      progress,
      liveUpdates,
      lastSync,
      error,
      setup,
      syncButton,
      connectionButton,
      conflictsButton,
      conflictBadge,
    }
  }

  private updateLastSync(): void {
    if (!this.elements) return
    const lastSyncedAt = this.host.getStatus().lastSyncedAt
    this.elements.lastSync.setText(
      lastSyncedAt ? `Synced ${formatRelativeTime(lastSyncedAt)}` : "Never synced",
    )
    this.elements.lastSync.title = lastSyncedAt ? `Last synced ${formatTime(lastSyncedAt)}` : ""
  }

  private async refreshConflictCount(): Promise<void> {
    if (this.conflictRefresh) return this.conflictRefresh
    this.conflictRefresh = this.host
      .getConflicts()
      .then((conflicts) => {
        if (!this.elements) return
        const count = conflicts.length
        this.elements.conflictBadge.hidden = count === 0
        this.elements.conflictBadge.setText(count > 99 ? "99+" : String(count))
        const label = count === 0 ? "Conflicts" : `Conflicts, ${count} unresolved`
        this.elements.conflictsButton.setAttribute("aria-label", label)
        this.elements.conflictsButton.title = count === 0 ? "" : `${count} unresolved conflicts`
      })
      .catch(() => undefined)
      .finally(() => {
        this.conflictRefresh = null
      })
    return this.conflictRefresh
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
  const panel = container.createDiv({ cls: "meridian-progress" })
  panel.setAttribute("role", "status")
  panel.setAttribute("aria-live", "polite")
  panel.setAttribute("aria-atomic", "true")
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
  const visible = progress !== null || presentation.indeterminate
  elements.panel.toggleClass("is-visible", visible)
  elements.panel.setAttribute("aria-hidden", String(!visible))
  elements.label.setText(presentation.label)
  elements.percent.setText(presentation.percent ?? "")
  elements.detail.setText(presentation.detail)
  elements.detail.title = presentation.detail
  elements.bar.max = presentation.max
  if (presentation.indeterminate) elements.bar.removeAttribute("value")
  else elements.bar.value = presentation.value
  elements.bar.setAttribute("aria-label", presentation.label)
}
