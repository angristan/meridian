import { type Plugin, TFile } from "obsidian"
import type { MeridianSettings } from "../model"
import type { SyncController } from "../sync/controller"
import { isSyncablePath } from "../vault/path-policy"
import { isFallbackPollDue } from "./scheduling-policy"

const FILE_EVENT_DEBOUNCE_MS = 1_200
const SCHEDULER_TICK_MS = 15_000

export class PluginScheduling {
  private eventTimer: number | null = null
  private lastPollAt = 0
  private lastScanAt = 0

  constructor(
    private readonly plugin: Plugin,
    private readonly controller: () => SyncController | null,
    private readonly settings: () => MeridianSettings,
  ) {}

  register(): void {
    this.registerVaultEvents()
    this.registerResumeEvents()
    this.plugin.registerInterval(
      window.setInterval(() => void this.runScheduledWork(), SCHEDULER_TICK_MS),
    )
  }

  connectionStarted(): void {
    this.lastPollAt = Date.now()
    this.lastScanAt = Date.now()
  }

  stop(): void {
    if (this.eventTimer !== null) window.clearTimeout(this.eventTimer)
    this.eventTimer = null
  }

  private registerVaultEvents(): void {
    const schedule = (path: string) => {
      const settings = this.settings()
      if (isSyncablePath(path, this.plugin.app.vault.configDir, settings.configCategories)) {
        this.scheduleFileSync()
      }
    }
    this.plugin.registerEvent(
      this.plugin.app.vault.on("create", (file) => {
        if (file instanceof TFile) schedule(file.path)
      }),
    )
    this.plugin.registerEvent(
      this.plugin.app.vault.on("modify", (file) => {
        if (file instanceof TFile) schedule(file.path)
      }),
    )
    this.plugin.registerEvent(
      this.plugin.app.vault.on("delete", (file) => {
        if (file instanceof TFile) schedule(file.path)
      }),
    )
    this.plugin.registerEvent(
      this.plugin.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          schedule(file.path)
          schedule(oldPath)
        }
      }),
    )
  }

  private registerResumeEvents(): void {
    this.plugin.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") void this.controller()?.resume()
    })
    this.plugin.registerDomEvent(window, "pageshow", () => void this.controller()?.resume())
    this.plugin.registerDomEvent(window, "online", () => void this.controller()?.resume())
  }

  private scheduleFileSync(): void {
    if (this.eventTimer !== null) window.clearTimeout(this.eventTimer)
    this.eventTimer = window.setTimeout(() => {
      this.eventTimer = null
      void this.controller()?.sync("file-event")
    }, FILE_EVENT_DEBOUNCE_MS)
  }

  private async runScheduledWork(): Promise<void> {
    const controller = this.controller()
    if (!controller || document.visibilityState !== "visible") return
    const now = Date.now()
    const settings = this.settings()
    if (now - this.lastScanAt >= settings.scanIntervalMinutes * 60_000) {
      this.lastScanAt = now
      this.lastPollAt = now
      await controller.sync("interval")
      return
    }
    const status = controller.getStatus()
    if (
      isFallbackPollDue({
        now,
        lastPollAt: this.lastPollAt,
        lastSyncedAt: status.lastSyncedAt,
        socketConnected: status.socketConnected,
        disconnectedPollIntervalMs: settings.pollIntervalSeconds * 1_000,
      })
    ) {
      this.lastPollAt = now
      await controller.sync("notification")
    }
  }
}
