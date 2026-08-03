import { Modal, Setting } from "obsidian"
import type { RemoteDevice, SyncActivity } from "../model"
import {
  type ActivityFilter,
  type PresentedActivity,
  presentActivities,
} from "./activity-presentation"
import { ConflictsModal } from "./conflicts-modal"
import { DeletedFilesModal } from "./deleted-files-modal"
import { HistoryModal } from "./history-conflicts"
import type { MeridianUiHost } from "./host"

export class ActivityModal extends Modal {
  private entries: SyncActivity[] = []
  private devices: RemoteDevice[] = []
  private filter: ActivityFilter = "all"
  private query = ""
  private list: HTMLDivElement | null = null
  private generation = 0

  constructor(private readonly host: MeridianUiHost) {
    super(host.app)
  }

  override onOpen(): void {
    this.setTitle("Sync log")
    this.renderShell()
    void this.load()
  }

  override onClose(): void {
    this.generation += 1
    this.entries = []
    this.devices = []
    this.list = null
    this.contentEl.empty()
  }

  private renderShell(): void {
    this.contentEl.empty()
    this.contentEl.createDiv({
      cls: "setting-item-description meridian-section-description",
      text: "The latest 200 synchronized changes. Revision history remains complete and is available from History.",
    })
    const controls = new Setting(this.contentEl)
    controls.addSearch((search) =>
      search.setPlaceholder("Search paths or devices").onChange((value) => {
        this.query = value
        this.renderList()
      }),
    )
    controls.addDropdown((dropdown) =>
      dropdown
        .addOptions({
          all: "All changes",
          created: "Created",
          modified: "Updated",
          renamed: "Renamed",
          deleted: "Deleted",
          restored: "Restored",
          conflict: "Conflicts",
        })
        .setValue(this.filter)
        .onChange((value) => {
          this.filter = value as ActivityFilter
          this.renderList()
        }),
    )
    this.list = this.contentEl.createDiv({ cls: "meridian-activity-list" })
    this.list.setAttribute("aria-live", "polite")
    this.list.createDiv({ cls: "setting-item-description", text: "Loading sync log…" })
  }

  private async load(): Promise<void> {
    const generation = ++this.generation
    try {
      const [entries, devices] = await Promise.all([
        this.host.getActivity(200),
        this.host.getDevices().catch(() => []),
      ])
      if (generation !== this.generation) return
      this.entries = entries
      this.devices = devices
      this.renderList()
    } catch (error) {
      if (generation !== this.generation || !this.list) return
      this.list.empty()
      const message = error instanceof Error ? error.message : "Unable to load the sync log"
      const alert = this.list.createDiv({ cls: "meridian-callout is-error", text: message })
      alert.setAttribute("role", "alert")
    }
  }

  private renderList(): void {
    if (!this.list) return
    const entries = presentActivities(this.entries, this.devices, this.filter, this.query)
    this.list.empty()
    if (entries.length === 0) {
      this.list.createDiv({
        cls: "setting-item-description meridian-activity-empty",
        text: this.entries.length === 0 ? "No synchronized changes yet." : "No changes match.",
      })
      return
    }
    for (const entry of entries) this.renderEntry(entry)
  }

  private renderEntry(presentation: PresentedActivity): void {
    if (!this.list) return
    const row = this.list.createDiv({ cls: "meridian-activity-row" })
    const header = row.createDiv({ cls: "meridian-activity-header" })
    header.createEl("strong", { text: presentation.title })
    header.createSpan({ cls: "setting-item-description", text: presentation.time })
    const path = row.createDiv({ cls: "meridian-activity-path", text: presentation.path })
    path.title = presentation.path
    row.createDiv({
      cls: "setting-item-description meridian-activity-source",
      text: presentation.source,
    })
    const actions = row.createDiv({ cls: "meridian-activity-actions" })
    if (presentation.entry.kind !== "deleted") {
      const open = actions.createEl("button", {
        attr: { "aria-label": `Open ${presentation.entry.path}` },
        text: "Open",
      })
      open.addEventListener("click", () => void this.host.openPath(presentation.entry.path))
    }
    if (presentation.entry.kind === "deleted") {
      const recover = actions.createEl("button", { text: "Recover" })
      recover.addEventListener("click", () => new DeletedFilesModal(this.host).open())
    }
    if (presentation.entry.kind === "conflict") {
      const resolve = actions.createEl("button", { text: "Resolve" })
      resolve.addEventListener("click", () => new ConflictsModal(this.host).open())
    }
    const history = actions.createEl("button", {
      attr: { "aria-label": `View history for ${presentation.entry.path}` },
      text: "History",
    })
    history.addEventListener("click", () =>
      new HistoryModal(this.host, presentation.entry.path).open(),
    )
  }
}
