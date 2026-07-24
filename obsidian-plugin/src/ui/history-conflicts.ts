import { Modal, Notice, Setting } from "obsidian"
import { formatTime } from "./format-time"
import type { MeridianUiHost } from "./host"

export class HistoryModal extends Modal {
  constructor(
    private readonly host: MeridianUiHost,
    private readonly path?: string,
  ) {
    super(host.app)
  }

  override onOpen(): void {
    this.setTitle("Revision history")
    void this.render()
  }

  private async render(): Promise<void> {
    const revisions = await this.host.getHistory(this.path)
    if (revisions.length === 0) {
      this.contentEl.createDiv({ cls: "empty-state", text: "No synchronized revisions yet." })
      return
    }
    for (const revision of revisions.slice(0, 100)) {
      const row = this.contentEl.createDiv({ cls: "meridian-list-row" })
      row.createEl("strong", { text: revision.path })
      row.createDiv({
        cls: "setting-item-description",
        text: `${revision.tombstone ? "Deleted" : revision.isConflict ? "Conflict" : "Revision"} · ${formatTime(revision.createdAt)} · ${revision.revisionId.slice(0, 12)}`,
      })
      if (!revision.tombstone) {
        const restore = row.createEl("button", { text: "Restore this revision" })
        restore.addEventListener("click", () => {
          restore.disabled = true
          void this.host
            .restoreRevision(revision.revisionId)
            .then(() => {
              new Notice(`Restored ${revision.path}; the new revision is queued for sync`)
              this.close()
            })
            .catch((error: unknown) => {
              new Notice(error instanceof Error ? error.message : String(error), 10_000)
              restore.disabled = false
            })
        })
      }
    }
  }
}

export class ConflictsModal extends Modal {
  constructor(private readonly host: MeridianUiHost) {
    super(host.app)
  }

  override onOpen(): void {
    this.setTitle("Sync conflicts")
    void this.render()
  }

  private async render(): Promise<void> {
    this.contentEl.empty()
    const conflicts = await this.host.getConflicts()
    if (conflicts.length === 0) {
      this.contentEl.createDiv({ cls: "empty-state", text: "No unresolved conflicts." })
      return
    }
    for (const conflict of conflicts) {
      new Setting(this.contentEl)
        .setName(conflict.sourcePath)
        .setDesc(`Preserved as ${conflict.conflictPath}`)
        .addButton((button) =>
          button
            .setButtonText("Open copy")
            .onClick(() => this.host.openPath(conflict.conflictPath)),
        )
        .addButton((button) =>
          button.setButtonText("Mark resolved").onClick(async () => {
            await this.host.resolveConflict(conflict.id)
            await this.render()
          }),
        )
    }
  }
}
