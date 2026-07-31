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
    this.contentEl.createDiv({ cls: "setting-item-description", text: "Calculating storage…" })
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
      text: "Encrypted history is retained indefinitely. Meridian does not prune server data until every active device can acknowledge a signed generation-aware snapshot and safely rebootstrap. This prevents history or blobs needed by another device from being deleted.",
    })
    new Setting(this.contentEl)
      .setName("Automatic pruning")
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
