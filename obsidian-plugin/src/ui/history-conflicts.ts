import { Modal, Notice, Setting } from "obsidian"
import type {
  LocalRevision,
  RemoteDevice,
  RevisionComparison,
  RevisionPreview,
  SyncActivityKind,
} from "../model"
import { activityTitle } from "./activity-presentation"
import { formatRelativeTime, formatTime } from "./format-time"
import type { MeridianUiHost } from "./host"

export class HistoryModal extends Modal {
  private revisions: LocalRevision[] = []
  private devices: RemoteDevice[] = []
  private query = ""
  private selectedRevisionId: string | null = null
  private mode: "preview" | "changes" = "preview"
  private list: HTMLDivElement | null = null
  private detail: HTMLDivElement | null = null
  private generation = 0

  constructor(
    private readonly host: MeridianUiHost,
    private readonly path?: string,
  ) {
    super(host.app)
  }

  override onOpen(): void {
    this.setTitle(this.path ? `History · ${this.path}` : "Revision history")
    this.renderShell()
    void this.load()
  }

  override onClose(): void {
    this.generation += 1
    this.revisions = []
    this.devices = []
    this.list = null
    this.detail = null
    this.contentEl.empty()
  }

  private renderShell(): void {
    const search = new Setting(this.contentEl)
    search.addSearch((component) =>
      component.setPlaceholder("Search file history").onChange((value) => {
        this.query = value
        this.renderRevisionList()
      }),
    )
    const layout = this.contentEl.createDiv({ cls: "meridian-history-layout" })
    this.list = layout.createDiv({ cls: "meridian-history-list" })
    this.detail = layout.createDiv({ cls: "meridian-history-detail" })
    this.list.createDiv({ cls: "setting-item-description", text: "Loading history…" })
    this.detail.createDiv({
      cls: "setting-item-description meridian-history-placeholder",
      text: "Select a revision to preview it.",
    })
  }

  private async load(): Promise<void> {
    const generation = ++this.generation
    try {
      const [revisions, devices] = await Promise.all([
        this.host.getHistory(this.path),
        this.host.getDevices().catch(() => []),
      ])
      if (generation !== this.generation) return
      this.revisions = revisions
      this.devices = devices
      this.selectedRevisionId ??= revisions[0]?.revisionId ?? null
      this.renderRevisionList()
      void this.renderDetail()
    } catch (error) {
      if (generation !== this.generation) return
      this.renderError(error)
    }
  }

  private renderRevisionList(): void {
    if (!this.list) return
    const query = this.query.trim().toLocaleLowerCase()
    const revisions = this.revisions.filter((revision) => {
      if (!query) return true
      return [revision.path, revision.previousPath ?? "", revisionLabel(revision)].some((value) =>
        value.toLocaleLowerCase().includes(query),
      )
    })
    this.list.empty()
    if (revisions.length === 0) {
      this.list.createDiv({
        cls: "setting-item-description meridian-history-placeholder",
        text:
          this.revisions.length === 0 ? "No synchronized revisions yet." : "No revisions match.",
      })
      return
    }
    const names = new Map(
      this.devices.map((device) => [
        device.deviceId,
        device.deviceName?.trim() || shortId(device.deviceId),
      ]),
    )
    for (const revision of revisions) {
      const button = this.list.createEl("button", { cls: "meridian-history-item" })
      const selected = revision.revisionId === this.selectedRevisionId
      button.toggleClass("is-selected", selected)
      button.setAttribute("aria-pressed", String(selected))
      button.setAttribute(
        "aria-label",
        `${revisionLabel(revision)} ${revision.path}, ${formatTime(revision.createdAt)}`,
      )
      button.createEl("strong", { text: revisionLabel(revision) })
      button.createDiv({ cls: "meridian-history-path", text: revision.path })
      button.createDiv({
        cls: "setting-item-description",
        text: `${revision.deviceId === this.host.settings.deviceId ? "This device" : (names.get(revision.deviceId) ?? shortId(revision.deviceId))} · ${formatRelativeTime(revision.createdAt)}`,
      })
      button.addEventListener("click", () => {
        this.selectedRevisionId = revision.revisionId
        this.renderRevisionList()
        void this.renderDetail()
      })
    }
  }

  private async renderDetail(): Promise<void> {
    if (!this.detail || !this.selectedRevisionId) return
    const revision = this.revisions.find((item) => item.revisionId === this.selectedRevisionId)
    if (!revision) return
    const generation = ++this.generation
    this.detail.empty()
    this.renderDetailToolbar(revision)
    const content = this.detail.createDiv({ cls: "meridian-history-content" })
    content.createDiv({ cls: "setting-item-description", text: "Loading revision…" })
    try {
      if (this.mode === "preview") {
        const preview = await this.host.previewRevision(revision.revisionId)
        if (generation !== this.generation) return
        this.renderPreview(content, preview)
      } else {
        const comparison = await this.host.compareRevisionToCurrent(revision.revisionId)
        if (generation !== this.generation) return
        this.renderComparison(content, comparison)
      }
    } catch (error) {
      if (generation !== this.generation) return
      content.empty()
      const alert = content.createDiv({
        cls: "meridian-callout is-error",
        text: error instanceof Error ? error.message : "Unable to load revision content",
      })
      alert.setAttribute("role", "alert")
    }
  }

  private renderDetailToolbar(revision: LocalRevision): void {
    if (!this.detail) return
    const header = this.detail.createDiv({ cls: "meridian-history-detail-header" })
    const title = header.createDiv()
    title.createEl("strong", { text: revision.path })
    title.createDiv({
      cls: "setting-item-description",
      text: `${revisionLabel(revision)} · ${formatTime(revision.createdAt)}`,
    })
    const actions = header.createDiv({ cls: "meridian-history-detail-actions" })
    const preview = actions.createEl("button", { text: "Preview" })
    preview.toggleClass("mod-cta", this.mode === "preview")
    preview.setAttribute("aria-pressed", String(this.mode === "preview"))
    preview.addEventListener("click", () => {
      this.mode = "preview"
      void this.renderDetail()
    })
    const changes = actions.createEl("button", { text: "Changes" })
    changes.toggleClass("mod-cta", this.mode === "changes")
    changes.setAttribute("aria-pressed", String(this.mode === "changes"))
    changes.addEventListener("click", () => {
      this.mode = "changes"
      void this.renderDetail()
    })
    if (!revision.tombstone) {
      const restore = actions.createEl("button", { text: "Restore" })
      restore.addClass("mod-warning")
      restore.addEventListener("click", () => {
        new RestoreRevisionModal(this.host, revision, () => this.close()).open()
      })
    }
  }

  private renderPreview(container: HTMLElement, preview: RevisionPreview): void {
    container.empty()
    if (preview.kind === "deleted") {
      container.createDiv({
        cls: "setting-item-description meridian-history-placeholder",
        text: "This revision records a deletion and has no content.",
      })
      return
    }
    if (preview.kind === "binary") {
      container.createDiv({
        cls: "setting-item-description meridian-history-placeholder",
        text: `Binary file · ${formatBytes(preview.byteLength)}`,
      })
      return
    }
    const pre = container.createEl("pre", { cls: "meridian-history-preview" })
    pre.createEl("code", { text: preview.text ?? "" })
    if (preview.truncated) {
      container.createDiv({
        cls: "setting-item-description",
        text: `Preview truncated · ${formatBytes(preview.byteLength)} total`,
      })
    }
  }

  private renderComparison(container: HTMLElement, comparison: RevisionComparison): void {
    container.empty()
    if (comparison.unavailableReason) {
      container.createDiv({
        cls: "setting-item-description meridian-history-placeholder",
        text: comparison.unavailableReason,
      })
      return
    }
    if (comparison.lines.every((line) => line.kind === "context")) {
      container.createDiv({
        cls: "setting-item-description meridian-history-placeholder",
        text: "This revision matches the current file.",
      })
      return
    }
    const diff = container.createDiv({ cls: "meridian-history-diff" })
    for (const line of comparison.lines) {
      const row = diff.createDiv({ cls: `meridian-history-diff-line is-${line.kind}` })
      row.createSpan({
        cls: "meridian-history-diff-prefix",
        text: line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " ",
      })
      row.createSpan({ text: line.text || " " })
    }
    if (comparison.truncated) {
      container.createDiv({ cls: "setting-item-description", text: "Large diff truncated." })
    }
  }

  private renderError(error: unknown): void {
    if (!this.list) return
    this.list.empty()
    const alert = this.list.createDiv({
      cls: "meridian-callout is-error",
      text: error instanceof Error ? error.message : "Unable to load revision history",
    })
    alert.setAttribute("role", "alert")
  }
}

class RestoreRevisionModal extends Modal {
  constructor(
    private readonly host: MeridianUiHost,
    private readonly revision: LocalRevision,
    private readonly onRestored: () => void,
  ) {
    super(host.app)
  }

  override onOpen(): void {
    this.setTitle("Restore this revision?")
    this.contentEl.createDiv({
      text: `Restore ${this.revision.path} from ${formatTime(this.revision.createdAt)}. Meridian will create a new synchronized revision; existing history remains available.`,
    })
    const actions = new Setting(this.contentEl)
    actions.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
    actions.addButton((button) =>
      button
        .setButtonText("Restore")
        .setWarning()
        .onClick(async () => {
          button.setDisabled(true)
          try {
            await this.host.restoreRevision(this.revision.revisionId)
            this.close()
            this.onRestored()
            new Notice(`Restored ${this.revision.path}; the new revision is queued for sync`)
          } catch (error) {
            new Notice(
              error instanceof Error ? error.message : "Unable to restore revision",
              10_000,
            )
            button.setDisabled(false)
          }
        }),
    )
  }
}

function revisionLabel(revision: LocalRevision): string {
  return activityTitle(revisionKind(revision))
}

function revisionKind(revision: LocalRevision): SyncActivityKind {
  if (revision.isConflict) return "conflict"
  const action = revision.action ?? (revision.tombstone ? "delete" : "upsert")
  if (action === "delete") return "deleted"
  if (action === "restore") return "restored"
  if (revision.previousPath) return "renamed"
  return revision.parents.length === 0 ? "created" : "modified"
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}
