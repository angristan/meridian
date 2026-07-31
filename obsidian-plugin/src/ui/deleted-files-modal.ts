import { Modal, Notice, Setting } from "obsidian"
import type { DeletedFileRecord, RemoteDevice } from "../model"
import { formatRelativeTime, formatTime } from "./format-time"
import { HistoryModal } from "./history-conflicts"
import type { MeridianUiHost } from "./host"

export class DeletedFilesModal extends Modal {
  private records: DeletedFileRecord[] = []
  private devices: RemoteDevice[] = []
  private selected = new Set<string>()
  private query = ""
  private list: HTMLDivElement | null = null
  private recoverButton: HTMLButtonElement | null = null
  private generation = 0

  constructor(private readonly host: MeridianUiHost) {
    super(host.app)
  }

  override onOpen(): void {
    this.setTitle("Deleted files")
    this.renderShell()
    void this.load()
  }

  override onClose(): void {
    this.generation += 1
    this.records = []
    this.devices = []
    this.selected.clear()
    this.contentEl.empty()
  }

  private renderShell(): void {
    const controls = new Setting(this.contentEl)
    controls.addSearch((search) =>
      search.setPlaceholder("Search deleted files").onChange((value) => {
        this.query = value
        this.renderList()
      }),
    )
    controls.addButton((button) => {
      button.setButtonText("Recover selected").setCta().setDisabled(true)
      this.recoverButton = button.buttonEl
      button.onClick(() => void this.recoverSelected())
    })
    this.list = this.contentEl.createDiv({ cls: "meridian-deleted-list" })
    this.list.createDiv({ cls: "setting-item-description", text: "Loading deleted files…" })
  }

  private async load(): Promise<void> {
    const generation = ++this.generation
    try {
      const [records, devices] = await Promise.all([
        this.host.getDeletedFiles(),
        this.host.getDevices().catch(() => []),
      ])
      if (generation !== this.generation) return
      this.records = records
      this.devices = devices
      const available = new Set(records.map((record) => record.deletedRevisionId))
      this.selected = new Set([...this.selected].filter((revisionId) => available.has(revisionId)))
      this.renderList()
    } catch (error) {
      if (generation !== this.generation || !this.list) return
      this.list.empty()
      const alert = this.list.createDiv({
        cls: "meridian-callout is-error",
        text: error instanceof Error ? error.message : "Unable to load deleted files",
      })
      alert.setAttribute("role", "alert")
    }
  }

  private renderList(): void {
    if (!this.list) return
    const query = this.query.trim().toLocaleLowerCase()
    const records = this.records.filter((record) => record.path.toLocaleLowerCase().includes(query))
    const names = new Map(
      this.devices.map((device) => [
        device.deviceId,
        device.deviceName?.trim() || shortId(device.deviceId),
      ]),
    )
    this.list.empty()
    if (records.length === 0) {
      this.list.createDiv({
        cls: "empty-state",
        text: this.records.length === 0 ? "No recoverable deleted files." : "No files match.",
      })
      this.updateRecoverButton()
      return
    }
    for (const record of records) {
      const row = this.list.createDiv({ cls: "meridian-deleted-item" })
      const check = row.createEl("input", { type: "checkbox" })
      check.checked = this.selected.has(record.deletedRevisionId)
      check.disabled = record.recoverableRevisionId === null
      const labelId = `meridian-deleted-${record.deletedRevisionId}`
      check.setAttribute("aria-labelledby", labelId)
      check.addEventListener("change", () => {
        if (check.checked) this.selected.add(record.deletedRevisionId)
        else this.selected.delete(record.deletedRevisionId)
        this.updateRecoverButton()
      })
      const details = row.createDiv({ cls: "meridian-deleted-details" })
      details.createEl("strong", { attr: { id: labelId }, text: record.path })
      const device =
        record.deviceId === this.host.settings.deviceId
          ? "This device"
          : (names.get(record.deviceId) ?? shortId(record.deviceId))
      const meta = details.createDiv({
        cls: "setting-item-description",
        text: `Deleted ${formatRelativeTime(record.deletedAt)} · ${device}`,
      })
      meta.title = `Deleted ${formatTime(record.deletedAt)}`
      if (record.recoverableRevisionId === null) {
        details.createDiv({
          cls: "setting-item-description",
          text: "Content is not available in local history.",
        })
      }
      const history = row.createEl("button", { text: "History" })
      history.addEventListener("click", () => new HistoryModal(this.host, record.path).open())
    }
    this.updateRecoverButton()
  }

  private updateRecoverButton(): void {
    if (!this.recoverButton) return
    this.recoverButton.disabled = this.selected.size === 0
    this.recoverButton.setText(
      this.selected.size > 0 ? `Recover selected (${this.selected.size})` : "Recover selected",
    )
  }

  private async recoverSelected(): Promise<void> {
    if (!this.recoverButton || this.selected.size === 0) return
    const revisionIds = [...this.selected]
    this.recoverButton.disabled = true
    this.recoverButton.setText("Recovering…")
    let recovered = 0
    const failures: string[] = []
    for (const revisionId of revisionIds) {
      try {
        await this.host.recoverDeleted(revisionId)
        recovered += 1
        this.selected.delete(revisionId)
      } catch (error) {
        failures.push(error instanceof Error ? error.message : "Recovery failed")
      }
    }
    await this.load()
    if (recovered > 0) {
      new Notice(`${recovered} ${recovered === 1 ? "file" : "files"} recovered and queued for sync`)
    }
    if (failures.length > 0) {
      new Notice(`${failures.length} recovery failed: ${failures[0]}`, 10_000)
    }
  }
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value
}
