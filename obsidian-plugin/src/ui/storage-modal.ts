import { Modal, Setting } from "obsidian"
import type { StorageUsage } from "../model"
import type { MeridianUiHost } from "./host"

export class StorageModal extends Modal {
  private generation = 0

  constructor(private readonly host: MeridianUiHost) {
    super(host.app)
  }

  override onOpen(): void {
    this.setTitle("Meridian storage")
    void this.render()
  }

  override onClose(): void {
    this.generation += 1
    this.contentEl.empty()
  }

  private async render(): Promise<void> {
    const generation = ++this.generation
    this.contentEl.empty()
    const loading = this.contentEl.createDiv({
      cls: "setting-item-description",
      text: "Calculating storage…",
    })
    loading.setAttribute("role", "status")
    loading.setAttribute("aria-live", "polite")
    try {
      const usage = await this.host.getStorageUsage()
      if (generation !== this.generation) return
      this.renderUsage(usage)
    } catch (error) {
      if (generation !== this.generation) return
      this.contentEl.empty()
      const alert = this.contentEl.createDiv({
        cls: "meridian-callout is-error",
        text: error instanceof Error ? error.message : "Unable to load storage usage",
      })
      alert.setAttribute("role", "alert")
    }
  }

  private renderUsage(usage: StorageUsage): void {
    this.contentEl.empty()
    const total = this.contentEl.createDiv({ cls: "meridian-storage-total" })
    total.createEl("strong", { text: formatBytes(usage.totalBytes) })
    total.createDiv({ cls: "setting-item-description", text: "Total encrypted remote storage" })

    const grid = this.contentEl.createDiv({ cls: "meridian-storage-grid" })
    storageMetric(
      grid,
      "Encrypted file data",
      formatBytes(usage.blobBytes),
      `${usage.blobCount} blobs`,
    )
    storageMetric(
      grid,
      "Coordinator database",
      formatBytes(usage.databaseBytes),
      `${usage.operationCount} operations`,
    )
    storageMetric(grid, "Signed checkpoints", String(usage.checkpointCount), "Retained")
    storageMetric(grid, "Encrypted snapshots", String(usage.snapshotCount), "Retained")

    new Setting(this.contentEl).setName("Retention and pruning").setHeading()
    this.contentEl.createDiv({
      cls: "meridian-callout is-warning",
      text: "Encrypted history is retained indefinitely. Automatic history pruning stays disabled until every active device can acknowledge a signed generation-aware snapshot and safely rebootstrap. Manual cleanup below removes only old uploads that no retained revision uses.",
    })
    new Setting(this.contentEl)
      .setName("Clean up unused uploads")
      .setDesc(
        "Deletes only encrypted uploads older than seven days that no retained revision references. Recent uploads are protected so interrupted sync can resume safely.",
      )
      .addButton((button) =>
        button
          .setButtonText(usage.pruningAvailable ? "Clean up…" : "Owner only")
          .setDisabled(!usage.pruningAvailable)
          .onClick(() => new StoragePruneConfirmationModal(this.host, () => this.render()).open()),
      )
    new Setting(this.contentEl)
      .setName("Automatic history pruning")
      .setDesc(
        "Unavailable until safe device acknowledgements and snapshot rebootstrap are supported.",
      )
      .addButton((button) => button.setButtonText("Not available").setDisabled(true))
    new Setting(this.contentEl)
      .setName("Refresh usage")
      .setDesc("R2 usage is calculated on demand and can take longer for large vaults.")
      .addButton((button) => button.setButtonText("Refresh").onClick(() => void this.render()))
  }
}

class StoragePruneConfirmationModal extends Modal {
  constructor(
    private readonly host: MeridianUiHost,
    private readonly onComplete: () => Promise<void>,
  ) {
    super(host.app)
  }

  override onOpen(): void {
    this.setTitle("Clean up unused uploads?")
    this.contentEl.createDiv({
      text: "Meridian will delete only encrypted uploads older than seven days that are not referenced by any retained revision. Current files and version history are preserved.",
    })
    const actions = new Setting(this.contentEl)
    actions.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
    actions.addButton((button) =>
      button
        .setButtonText("Clean up")
        .setCta()
        .onClick(async () => {
          button.setDisabled(true).setButtonText("Cleaning up…")
          try {
            const result = await this.host.pruneStorage()
            this.contentEl.empty()
            this.setTitle("Cleanup complete")
            const resultMessage = this.contentEl.createDiv({
              text:
                result.deletedCount === 0
                  ? `No unused uploads older than ${result.graceDays} days were found.`
                  : `Deleted ${result.deletedCount} unused uploads (${formatBytes(result.deletedBytes)}).`,
            })
            resultMessage.setAttribute("role", "status")
            new Setting(this.contentEl).addButton((done) =>
              done
                .setButtonText("Done")
                .setCta()
                .onClick(async () => {
                  await this.onComplete()
                  this.close()
                }),
            )
          } catch (error) {
            button.setDisabled(false).setButtonText("Retry")
            const existing = this.contentEl.querySelector(".meridian-prune-error")
            existing?.remove()
            const alert = this.contentEl.createDiv({
              cls: "meridian-callout is-error meridian-prune-error",
              text: error instanceof Error ? error.message : "Storage cleanup failed",
            })
            alert.setAttribute("role", "alert")
          }
        }),
    )
  }

  override onClose(): void {
    this.contentEl.empty()
  }
}

function storageMetric(container: HTMLElement, label: string, value: string, detail: string): void {
  const metric = container.createDiv({ cls: "meridian-storage-metric" })
  metric.createDiv({ cls: "setting-item-description", text: label })
  metric.createEl("strong", { text: value })
  metric.createDiv({ cls: "setting-item-description", text: detail })
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}
