import { Modal, Notice, Setting } from "obsidian"
import { runtimeTuning } from "../plugin/runtime-tuning"
import { DiagnosticsModal } from "./diagnostics-modal"
import { formatTime } from "./format-time"
import type { MeridianUiHost } from "./host"
import { StorageModal } from "./storage-modal"

export class TroubleshootingModal extends Modal {
  private generation = 0

  constructor(private readonly host: MeridianUiHost) {
    super(host.app)
  }

  override onOpen(): void {
    this.setTitle("Troubleshooting")
    void this.render()
  }

  override onClose(): void {
    this.generation += 1
    this.contentEl.empty()
  }

  private async render(): Promise<void> {
    const generation = ++this.generation
    this.contentEl.empty()
    const status = this.host.getStatus()
    const tuning = runtimeTuning(this.host.settings)

    new Setting(this.contentEl).setName("Technical status").setHeading()
    detail(this.contentEl, "State", status.phase)
    detail(this.contentEl, "Remote cursor", String(status.cursor))
    detail(this.contentEl, "Queued changes", String(status.queued))
    detail(this.contentEl, "Live notifications", status.socketConnected ? "Connected" : "Offline")
    detail(
      this.contentEl,
      "Last successful sync",
      status.lastSyncedAt === null ? "Never" : formatTime(status.lastSyncedAt),
    )
    detail(
      this.contentEl,
      "Automatic policy",
      `${tuning.disconnectedPollMs / 1_000}s fallback · ${tuning.fullScanMs / 60_000}m full scan · ${Math.round(tuning.maxFileBytes / (1024 * 1024))} MiB files`,
    )

    const epoch = await this.host.getEpochStatus().catch(() => null)
    if (generation !== this.generation) return
    detail(
      this.contentEl,
      "Encryption",
      epoch
        ? `Epoch ${epoch.sequence}${epoch.pending ? " · rotation pending" : ""}`
        : "Unavailable while disconnected",
    )

    new Setting(this.contentEl).setName("Tools").setHeading()
    new Setting(this.contentEl)
      .setName("Technical log")
      .setDesc("View this session's privacy-safe sync transitions and error states.")
      .addButton((button) =>
        button.setButtonText("Open").onClick(() => new DiagnosticsModal(this.host).open()),
      )
    new Setting(this.contentEl)
      .setName("Storage details")
      .setDesc("Inspect encrypted remote storage, local browser storage, and safe cleanup.")
      .addButton((button) =>
        button
          .setButtonText("Open")
          .setDisabled(!this.host.settings.endpoint)
          .onClick(() => new StorageModal(this.host).open()),
      )
    new Setting(this.contentEl)
      .setName("Rebuild local index")
      .setDesc("Deletes only rebuildable scan state. Vault files and remote history are preserved.")
      .addButton((button) =>
        button
          .setButtonText("Rebuild")
          .setWarning()
          .setDisabled(!this.host.settings.endpoint)
          .onClick(async () => {
            button.setDisabled(true)
            try {
              await this.host.repairLocalIndex()
              new Notice("Meridian local index rebuilt")
            } catch (error) {
              new Notice(error instanceof Error ? error.message : "Unable to rebuild local index")
              button.setDisabled(false)
            }
          }),
      )
  }
}

function detail(container: HTMLElement, label: string, value: string): void {
  new Setting(container).setName(label).setDesc(value)
}
