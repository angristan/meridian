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
    storageMetric(
      grid,
      "Device retention status",
      `${usage.acknowledgedDeviceCount}/${usage.activeDeviceCount}`,
      usage.minimumAcknowledgedCursor === null
        ? "Waiting for active devices"
        : `Observed through cursor ${usage.minimumAcknowledgedCursor}`,
    )
    if (usage.reservedBlobBytes > 0) {
      storageMetric(
        grid,
        "Uploads in progress",
        formatBytes(usage.reservedBlobBytes),
        "Reserved against the quota",
      )
    }

    new Setting(this.contentEl).setName("Remote storage limit").setHeading()
    if (
      usage.storagePressure === "warning" ||
      usage.storagePressure === "critical" ||
      usage.storagePressure === "exceeded"
    ) {
      const pressure = this.contentEl.createDiv({
        cls: `meridian-callout ${usage.storagePressure === "warning" ? "is-warning" : "is-error"}`,
        text:
          usage.storagePressure === "warning"
            ? "Remote storage is above 80% of your configured limit."
            : "Remote storage is near or above its limit. New content will stop safely without deleting history.",
      })
      pressure.setAttribute("role", "status")
    }
    let quotaInput =
      usage.storageQuotaBytes === null
        ? ""
        : String(Math.round((usage.storageQuotaBytes / (1024 * 1024)) * 10) / 10)
    new Setting(this.contentEl)
      .setName("Maximum remote storage")
      .setDesc(
        "Optional MiB limit. Leave blank for unlimited retention. Security operations keep reserved emergency space.",
      )
      .addText((text) =>
        text
          .setPlaceholder("Unlimited")
          .setValue(quotaInput)
          .onChange((value) => {
            quotaInput = value
          }),
      )
      .addButton((button) =>
        button
          .setButtonText(usage.pruningAvailable ? "Apply" : "Owner only")
          .setDisabled(!usage.pruningAvailable)
          .onClick(async () => {
            const trimmed = quotaInput.trim()
            const mebibytes = trimmed === "" ? null : Number(trimmed)
            if (mebibytes !== null && (!Number.isFinite(mebibytes) || mebibytes <= 0)) {
              this.showActionError("Enter a positive storage limit in MiB, or leave it blank.")
              return
            }
            button.setDisabled(true).setButtonText("Applying…")
            try {
              await this.host.setStorageQuota(
                mebibytes === null ? null : Math.floor(mebibytes * 1024 * 1024),
              )
              await this.render()
            } catch (error) {
              button.setDisabled(false).setButtonText("Retry")
              this.showActionError(
                error instanceof Error ? error.message : "Unable to update storage limit",
              )
            }
          }),
      )

    new Setting(this.contentEl).setName("Local browser storage").setHeading()
    if (usage.local.usageBytes === null || usage.local.quotaBytes === null) {
      this.contentEl.createDiv({
        cls: "setting-item-description",
        text: "This Obsidian version does not expose local storage estimates.",
      })
    } else {
      const percentage =
        usage.local.quotaBytes === 0
          ? 0
          : Math.round((usage.local.usageBytes / usage.local.quotaBytes) * 100)
      storageMetric(
        this.contentEl,
        "Meridian and Obsidian origin",
        formatBytes(usage.local.usageBytes),
        `${percentage}% of the browser quota`,
      )
      if (usage.local.pressure === "warning" || usage.local.pressure === "critical") {
        const warning = this.contentEl.createDiv({
          cls: `meridian-callout ${usage.local.pressure === "critical" ? "is-error" : "is-warning"}`,
          text:
            usage.local.pressure === "critical"
              ? "Local browser storage is nearly full. Sync will stop safely if IndexedDB cannot commit more data."
              : "Local browser storage is above 80%. Consider compacting disposable sync records.",
        })
        warning.setAttribute("role", "status")
      }
    }
    new Setting(this.contentEl)
      .setName("Compact local sync records")
      .setDesc(
        "Removes completed upload records and exact duplicate history metadata. Pending work, file history, conflicts, checkpoints, and encryption keys are preserved.",
      )
      .addButton((button) =>
        button.setButtonText("Compact").onClick(async () => {
          button.setDisabled(true).setButtonText("Compacting…")
          try {
            await this.host.compactLocalStorage()
            await this.render()
          } catch (error) {
            button.setDisabled(false).setButtonText("Retry")
            this.showActionError(
              error instanceof Error ? error.message : "Unable to compact local storage",
            )
          }
        }),
      )
    new Setting(this.contentEl)
      .setName("Persistent local storage")
      .setDesc(
        usage.local.persisted === true
          ? "The browser reports that local Meridian data is protected from automatic eviction."
          : "Ask the browser to protect local Meridian data from automatic eviction when supported.",
      )
      .addButton((button) =>
        button
          .setButtonText(
            usage.local.persisted === true
              ? "Granted"
              : usage.local.persisted === null
                ? "Unavailable"
                : "Request",
          )
          .setDisabled(usage.local.persisted !== false)
          .onClick(async () => {
            button.setDisabled(true).setButtonText("Requesting…")
            try {
              await this.host.requestPersistentStorage()
              await this.render()
            } catch (error) {
              button.setDisabled(false).setButtonText("Retry")
              this.showActionError(
                error instanceof Error ? error.message : "Unable to request persistent storage",
              )
            }
          }),
      )

    new Setting(this.contentEl).setName("Retention and pruning").setHeading()
    this.contentEl.createDiv({
      cls: "meridian-callout is-warning",
      text: "Committed history and every required epoch key are retained forever. Device acknowledgements report sync progress but do not authorize log deletion: no generation-aware rebootstrap archive exists yet. Manual cleanup below removes only old uploads that no retained revision uses.",
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
      .setDesc("Disabled by the keep-history-forever policy.")
      .addButton((button) => button.setButtonText("Not available").setDisabled(true))
    new Setting(this.contentEl)
      .setName("Refresh usage")
      .setDesc("R2 usage is calculated on demand and can take longer for large vaults.")
      .addButton((button) => button.setButtonText("Refresh").onClick(() => void this.render()))
  }

  private showActionError(message: string): void {
    this.contentEl.querySelector(".meridian-storage-action-error")?.remove()
    const alert = this.contentEl.createDiv({
      cls: "meridian-callout is-error meridian-storage-action-error",
      text: message,
    })
    alert.setAttribute("role", "alert")
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
