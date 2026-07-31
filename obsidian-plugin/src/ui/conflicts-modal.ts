import { Modal, Notice, Setting } from "obsidian"
import type {
  ConflictDetails,
  ConflictFilePreview,
  ConflictRecord,
  ConflictResolutionAction,
  RevisionComparison,
} from "../model"
import { formatRelativeTime, formatTime } from "./format-time"
import type { MeridianUiHost } from "./host"

export class ConflictsModal extends Modal {
  private conflicts: ConflictRecord[] = []
  private selectedId: string | null = null
  private list: HTMLDivElement | null = null
  private detail: HTMLDivElement | null = null
  private generation = 0

  constructor(
    private readonly host: MeridianUiHost,
    private readonly onConflictsChanged?: () => void,
  ) {
    super(host.app)
  }

  override onOpen(): void {
    this.setTitle("Sync conflicts")
    const layout = this.contentEl.createDiv({ cls: "meridian-conflicts-layout" })
    this.list = layout.createDiv({ cls: "meridian-conflicts-list" })
    this.detail = layout.createDiv({ cls: "meridian-conflict-detail" })
    this.list.createDiv({ cls: "setting-item-description", text: "Loading conflicts…" })
    this.detail.createDiv({
      cls: "setting-item-description meridian-history-placeholder",
      text: "Select a conflict to review both versions.",
    })
    void this.load()
  }

  override onClose(): void {
    this.generation += 1
    this.conflicts = []
    this.list = null
    this.detail = null
    this.contentEl.empty()
  }

  private async load(): Promise<void> {
    const generation = ++this.generation
    try {
      const conflicts = await this.host.getConflicts()
      if (generation !== this.generation) return
      this.conflicts = conflicts
      if (!conflicts.some((conflict) => conflict.id === this.selectedId)) {
        this.selectedId = conflicts[0]?.id ?? null
      }
      this.renderList()
      void this.renderDetail()
      this.onConflictsChanged?.()
    } catch (error) {
      if (generation !== this.generation || !this.list) return
      this.list.empty()
      renderError(this.list, error, "Unable to load conflicts")
    }
  }

  private renderList(): void {
    if (!this.list) return
    this.list.empty()
    if (this.conflicts.length === 0) {
      this.list.createDiv({ cls: "empty-state", text: "No unresolved conflicts." })
      this.detail?.empty()
      this.detail?.createDiv({
        cls: "setting-item-description meridian-history-placeholder",
        text: "All conflicts are resolved.",
      })
      return
    }
    for (const conflict of this.conflicts) {
      const button = this.list.createEl("button", { cls: "meridian-history-item" })
      const selected = conflict.id === this.selectedId
      button.toggleClass("is-selected", selected)
      button.setAttribute("aria-pressed", String(selected))
      button.setAttribute("aria-label", `Review conflict for ${conflict.sourcePath}`)
      button.createEl("strong", { text: conflict.sourcePath })
      const meta = button.createDiv({
        cls: "setting-item-description",
        text: `${conflict.kind === "config" ? "Configuration" : `${capitalize(conflict.kind)} file`} · ${formatRelativeTime(conflict.createdAt)}`,
      })
      meta.title = formatTime(conflict.createdAt)
      button.addEventListener("click", () => {
        this.selectedId = conflict.id
        this.renderList()
        void this.renderDetail()
      })
    }
  }

  private async renderDetail(): Promise<void> {
    if (!this.detail || !this.selectedId) return
    const generation = ++this.generation
    this.detail.empty()
    this.detail.createDiv({ cls: "setting-item-description", text: "Loading both versions…" })
    try {
      const details = await this.host.getConflictDetails(this.selectedId)
      if (generation !== this.generation) return
      this.renderConflict(details)
    } catch (error) {
      if (generation !== this.generation || !this.detail) return
      this.detail.empty()
      renderError(this.detail, error, "Unable to inspect conflict")
    }
  }

  private renderConflict(details: ConflictDetails): void {
    if (!this.detail) return
    this.detail.empty()
    const header = this.detail.createDiv({ cls: "meridian-conflict-header" })
    header.createEl("strong", { text: details.conflict.sourcePath })
    header.createDiv({
      cls: "setting-item-description",
      text: details.incomingDeleted
        ? "Another device deleted this file. Meridian preserved your local version."
        : "Meridian preserved the incoming version because it could not safely replace the current file.",
    })

    const previews = this.detail.createDiv({ cls: "meridian-conflict-previews" })
    renderFilePreview(
      previews,
      details.incomingDeleted ? "Current path" : "Current version",
      details.current,
      details.conflict.sourcePath,
      this.host,
    )
    renderFilePreview(
      previews,
      details.incomingDeleted ? "Preserved local version" : "Incoming version",
      details.preserved,
      details.conflict.conflictPath,
      this.host,
    )
    renderComparison(this.detail, details.comparison)

    const choices = this.detail.createDiv({ cls: "meridian-conflict-choices" })
    this.addChoice(
      choices,
      details,
      "keep-current",
      details.incomingDeleted ? "Accept deletion" : "Keep current version",
      details.incomingDeleted
        ? "Remove the preserved local copy and keep the file deleted."
        : "Keep the current file and remove the preserved incoming copy.",
    )
    this.addChoice(
      choices,
      details,
      "use-incoming",
      details.incomingDeleted ? "Recover preserved version" : "Use incoming version",
      details.incomingDeleted
        ? "Restore the preserved local content at its original path and synchronize a new revision."
        : "Replace the current file with the incoming content and synchronize the decision.",
    )
    this.addChoice(
      choices,
      details,
      "keep-both",
      "Keep both files",
      "Keep the preserved copy at its conflict path and synchronize it as a separate file.",
    )
  }

  private addChoice(
    container: HTMLElement,
    details: ConflictDetails,
    action: ConflictResolutionAction,
    title: string,
    description: string,
  ): void {
    const choice = container.createDiv({ cls: "meridian-conflict-choice" })
    const copy = choice.createDiv()
    copy.createEl("strong", { text: title })
    copy.createDiv({ cls: "setting-item-description", text: description })
    const button = choice.createEl("button", {
      attr: { "aria-label": `${title} for ${details.conflict.sourcePath}` },
      text: title,
    })
    if (action === "use-incoming") button.addClass("mod-cta")
    if (action === "keep-current") button.addClass("mod-warning")
    button.addEventListener("click", () => {
      new ResolveConflictModal(this.host, details, action, title, () => void this.load()).open()
    })
  }
}

class ResolveConflictModal extends Modal {
  constructor(
    private readonly host: MeridianUiHost,
    private readonly details: ConflictDetails,
    private readonly action: ConflictResolutionAction,
    private readonly actionTitle: string,
    private readonly onResolved: () => void,
  ) {
    super(host.app)
  }

  override onOpen(): void {
    this.setTitle(`${this.actionTitle}?`)
    this.contentEl.createDiv({
      text: resolutionConfirmation(this.details, this.action),
    })
    const actions = new Setting(this.contentEl)
    actions.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
    actions.addButton((button) => {
      button.setButtonText(this.actionTitle)
      if (this.action === "keep-current") button.setWarning()
      else button.setCta()
      button.onClick(async () => {
        button.setDisabled(true)
        try {
          await this.host.resolveConflict(this.details.conflict.id, this.action)
          this.close()
          this.onResolved()
          new Notice(`Resolved conflict for ${this.details.conflict.sourcePath}`)
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Unable to resolve conflict", 10_000)
          button.setDisabled(false)
        }
      })
    })
  }
}

function renderFilePreview(
  container: HTMLElement,
  title: string,
  preview: ConflictFilePreview,
  path: string,
  host: MeridianUiHost,
): void {
  const panel = container.createDiv({ cls: "meridian-conflict-preview" })
  const header = panel.createDiv({ cls: "meridian-conflict-preview-header" })
  header.createEl("strong", { text: title })
  if (preview.kind !== "missing") {
    const open = header.createEl("button", {
      attr: { "aria-label": `Open ${title.toLowerCase()} at ${path}` },
      text: "Open",
    })
    open.addEventListener("click", () => void host.openPath(path))
  }
  if (preview.kind === "missing") {
    panel.createDiv({ cls: "setting-item-description", text: "File does not exist at this path." })
    return
  }
  if (preview.kind === "binary") {
    panel.createDiv({
      cls: "setting-item-description",
      text: `Binary file · ${formatBytes(preview.byteLength)}`,
    })
    return
  }
  const pre = panel.createEl("pre", { cls: "meridian-conflict-preview-content" })
  pre.createEl("code", { text: preview.text ?? "" })
  if (preview.truncated) {
    panel.createDiv({
      cls: "setting-item-description",
      text: `Preview truncated · ${formatBytes(preview.byteLength)} total`,
    })
  }
}

function renderComparison(container: HTMLElement, comparison: RevisionComparison): void {
  const section = container.createDiv({ cls: "meridian-conflict-comparison" })
  section.createEl("strong", { text: "Changes" })
  if (comparison.unavailableReason) {
    section.createDiv({ cls: "setting-item-description", text: comparison.unavailableReason })
    return
  }
  if (comparison.lines.every((line) => line.kind === "context")) {
    section.createDiv({ cls: "setting-item-description", text: "The two versions match." })
    return
  }
  const diff = section.createDiv({ cls: "meridian-history-diff" })
  for (const line of comparison.lines) {
    const row = diff.createDiv({ cls: `meridian-history-diff-line is-${line.kind}` })
    row.createSpan({
      cls: "meridian-history-diff-prefix",
      text: line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " ",
    })
    row.createSpan({ text: line.text || " " })
  }
  if (comparison.truncated) {
    section.createDiv({ cls: "setting-item-description", text: "Large comparison truncated." })
  }
}

function resolutionConfirmation(
  details: ConflictDetails,
  action: ConflictResolutionAction,
): string {
  if (action === "keep-both") {
    return `Keep ${details.conflict.sourcePath} and synchronize the preserved copy as ${details.conflict.conflictPath}.`
  }
  if (action === "use-incoming") {
    return details.incomingDeleted
      ? `Recover the preserved content at ${details.conflict.sourcePath}. Meridian will create a new synchronized revision.`
      : `Replace ${details.conflict.sourcePath} with the preserved incoming content. Changes made after this dialog opened are protected.`
  }
  return details.incomingDeleted
    ? `Keep ${details.conflict.sourcePath} deleted and remove the preserved local copy. This cannot be undone unless another history revision is available.`
    : `Keep the current content at ${details.conflict.sourcePath} and remove the preserved incoming copy. The incoming revision remains in history.`
}

function renderError(container: HTMLElement, error: unknown, fallback: string): void {
  const alert = container.createDiv({
    cls: "meridian-callout is-error",
    text: error instanceof Error ? error.message : fallback,
  })
  alert.setAttribute("role", "alert")
}

function capitalize(value: string): string {
  return value.charAt(0).toLocaleUpperCase() + value.slice(1)
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}
