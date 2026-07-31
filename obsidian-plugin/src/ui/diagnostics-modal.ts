import { Modal, Notice, Setting } from "obsidian"
import type { SyncDiagnostic } from "../model"
import { formatTime } from "./format-time"
import type { MeridianUiHost } from "./host"

export class DiagnosticsModal extends Modal {
  private query = ""
  private errorsOnly = false
  private list: HTMLDivElement | null = null

  constructor(private readonly host: MeridianUiHost) {
    super(host.app)
  }

  override onOpen(): void {
    this.setTitle("Sync diagnostics")
    const actions = new Setting(this.contentEl)
    actions.addSearch((search) =>
      search.setPlaceholder("Search session events").onChange((value) => {
        this.query = value
        this.renderList()
      }),
    )
    actions.addDropdown((dropdown) =>
      dropdown.addOptions({ all: "All events", errors: "Errors" }).onChange((value) => {
        this.errorsOnly = value === "errors"
        this.renderList()
      }),
    )
    actions.addButton((button) =>
      button
        .setButtonText("Copy debug info")
        .setTooltip("Copies a sanitized report without paths, endpoints, identifiers, or secrets")
        .onClick(() => void this.copyReport()),
    )
    this.contentEl.createDiv({
      cls: "setting-item-description meridian-section-description",
      text: "Session errors remain local. Copied debug information excludes paths, endpoints, identifiers, and secrets.",
    })
    this.list = this.contentEl.createDiv({ cls: "meridian-diagnostic-list" })
    this.renderList()
  }

  override onClose(): void {
    this.list = null
    this.contentEl.empty()
  }

  private renderList(): void {
    if (!this.list) return
    const normalizedQuery = this.query.trim().toLocaleLowerCase()
    const entries = this.host
      .getDiagnostics()
      .filter((entry) => !this.errorsOnly || entry.error !== null)
      .filter((entry) => matches(entry, normalizedQuery))
    this.list.empty()
    if (entries.length === 0) {
      this.list.createDiv({
        cls: "setting-item-description meridian-activity-empty",
        text: "No session events match.",
      })
      return
    }
    for (const entry of entries) {
      const row = this.list.createDiv({ cls: "meridian-diagnostic-row" })
      const header = row.createDiv({ cls: "meridian-activity-header" })
      header.createEl("strong", { text: entry.message })
      header.createSpan({ cls: "setting-item-description", text: formatTime(entry.timestamp) })
      row.createDiv({ cls: "setting-item-description", text: entry.phase })
      if (entry.error) {
        const error = row.createDiv({ cls: "meridian-diagnostic-error", text: entry.error })
        error.setAttribute("role", "alert")
      }
    }
  }

  private async copyReport(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.host.getDebugReport())
      new Notice("Sanitized Meridian debug information copied")
    } catch {
      new Notice("Unable to copy Meridian debug information")
    }
  }
}

function matches(entry: SyncDiagnostic, query: string): boolean {
  if (!query) return true
  return [entry.phase, entry.message, entry.error ?? ""].some((value) =>
    value.toLocaleLowerCase().includes(query),
  )
}
