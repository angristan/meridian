import { type Plugin, TFile } from "obsidian"
import type { MeridianSettings, SyncStatus } from "../model"
import type { SyncController } from "../sync/controller"
import { isSyncablePath } from "../vault/path-policy"
import { runtimeTuning } from "./runtime-tuning"
import {
  fallbackPollDueAt,
  fileEventDelayMs,
  notificationReconnectDelayMs,
} from "./scheduling-policy"

interface SchedulingDependencies {
  now?: () => number
  random?: () => number
}

export class PluginScheduling {
  private eventTimer: number | null = null
  private scheduleTimer: number | null = null
  private eventBurstStartedAt: number | null = null
  private lastFileEventAt: number | null = null
  private lastPollAt = 0
  private lastScanAt = 0
  private nextReconnectAt = Number.POSITIVE_INFINITY
  private reconnectAttempt = 0
  private pollFailures = 0
  private runningScheduledWork = false
  private resumeWork: Promise<void> | null = null
  private registered = false
  private readonly now: () => number
  private readonly random: () => number

  constructor(
    private readonly plugin: Plugin,
    private readonly controller: () => SyncController | null,
    private readonly settings: () => MeridianSettings,
    dependencies: SchedulingDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now
    this.random = dependencies.random ?? Math.random
  }

  register(): void {
    this.registered = true
    this.registerVaultEvents()
    this.registerResumeEvents()
    this.plugin.register(() => this.stop())
    this.scheduleNextWork()
  }

  connectionStarted(): void {
    const now = this.now()
    this.lastPollAt = now
    this.lastScanAt = now
    this.reconnectAttempt = 0
    this.nextReconnectAt = this.controller()?.getStatus().socketConnected
      ? Number.POSITIVE_INFINITY
      : now + notificationReconnectDelayMs(0, this.random)
    this.pollFailures = 0
    this.scheduleNextWork()
  }

  settingsChanged(): void {
    this.scheduleNextWork()
  }

  statusChanged(patch: Partial<SyncStatus>): void {
    if (patch.socketConnected === true) {
      this.reconnectAttempt = 0
      this.nextReconnectAt = Number.POSITIVE_INFINITY
    } else if (
      patch.socketConnected === false &&
      this.nextReconnectAt === Number.POSITIVE_INFINITY
    ) {
      this.nextReconnectAt =
        this.now() + notificationReconnectDelayMs(this.reconnectAttempt, this.random)
    }
    if (
      patch.socketConnected !== undefined ||
      patch.lastSyncedAt !== undefined ||
      patch.phase === "idle" ||
      patch.phase === "offline" ||
      patch.phase === "error"
    ) {
      this.scheduleNextWork()
    }
  }

  cancelPendingFileSync(): void {
    this.clearFileEventBatch()
  }

  stop(): void {
    this.registered = false
    this.clearEventTimer()
    this.clearScheduleTimer()
  }

  private registerVaultEvents(): void {
    const schedule = (path: string) => {
      const settings = this.settings()
      if (!isSyncablePath(path, this.plugin.app.vault.configDir, settings.configCategories)) return
      const controller = this.controller()
      if (controller) void controller.recordVaultChange(path)
      this.scheduleFileSync()
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
      if (document.visibilityState === "visible") this.resumeNow()
      else this.suspendNow()
    })
    this.plugin.registerDomEvent(window, "pageshow", () => this.resumeNow())
    this.plugin.registerDomEvent(window, "pagehide", () => this.suspendNow())
    this.plugin.registerDomEvent(window, "online", () => this.resumeNow())
  }

  private resumeNow(): void {
    if (this.resumeWork) return
    const controller = this.controller()
    if (!controller) return
    const now = this.now()
    this.lastPollAt = now
    this.lastScanAt = now
    this.reconnectAttempt = 0
    this.nextReconnectAt = now + notificationReconnectDelayMs(0, this.random)
    this.pollFailures = 0
    this.clearScheduleTimer()
    const work = controller.resume().finally(() => {
      if (this.resumeWork === work) this.resumeWork = null
      this.scheduleNextWork()
    })
    this.resumeWork = work
  }

  private suspendNow(): void {
    this.clearScheduleTimer()
    if (this.eventTimer !== null) void this.flushFileEvents()
  }

  private scheduleFileSync(): void {
    const now = this.now()
    const burstStartedAt = this.eventBurstStartedAt ?? now
    const delay = fileEventDelayMs({
      now,
      burstStartedAt,
      previousEventAt: this.lastFileEventAt,
    })
    this.eventBurstStartedAt = burstStartedAt
    this.lastFileEventAt = now
    this.clearEventTimer()
    this.eventTimer = window.setTimeout(() => {
      this.eventTimer = null
      void this.flushFileEvents()
    }, delay)
  }

  private async flushFileEvents(): Promise<void> {
    this.clearFileEventBatch()
    await this.controller()?.sync("file-event")
  }

  private clearFileEventBatch(): void {
    this.clearEventTimer()
    this.eventBurstStartedAt = null
    this.lastFileEventAt = null
  }

  private async runScheduledWork(): Promise<void> {
    if (this.runningScheduledWork) return
    this.runningScheduledWork = true
    this.scheduleTimer = null
    try {
      const controller = this.controller()
      if (!controller || document.visibilityState !== "visible") return
      const now = this.now()
      const tuning = runtimeTuning(this.settings())
      const status = controller.getStatus()
      const scanDueAt = this.lastScanAt + tuning.fullScanMs
      const pollDueAt = fallbackPollDueAt({
        lastPollAt: this.lastPollAt,
        lastSyncedAt: status.lastSyncedAt,
        socketConnected: status.socketConnected,
        disconnectedPollIntervalMs: tuning.disconnectedPollMs,
        consecutiveFailures: this.pollFailures,
      })
      const reconnectDue = !status.socketConnected && now >= this.nextReconnectAt
      if (reconnectDue) {
        this.reconnectAttempt += 1
        this.nextReconnectAt =
          now + notificationReconnectDelayMs(this.reconnectAttempt, this.random)
        controller.reconnectNotifications()
      }

      if (now >= scanDueAt) {
        this.lastScanAt = now
        this.lastPollAt = now
        await controller.sync("interval")
        this.recordPollOutcome(controller.getStatus())
      } else if (now >= pollDueAt) {
        this.lastPollAt = now
        await controller.sync("notification")
        this.recordPollOutcome(controller.getStatus())
      }
    } finally {
      this.runningScheduledWork = false
      this.scheduleNextWork()
    }
  }

  private recordPollOutcome(status: SyncStatus): void {
    if (status.phase === "error" || status.phase === "offline") this.pollFailures += 1
    else this.pollFailures = 0
  }

  private scheduleNextWork(): void {
    if (!this.registered || this.runningScheduledWork) return
    this.clearScheduleTimer()
    const controller = this.controller()
    if (
      !controller ||
      document.visibilityState !== "visible" ||
      (typeof navigator !== "undefined" && navigator.onLine === false)
    ) {
      return
    }

    const now = this.now()
    const tuning = runtimeTuning(this.settings())
    const status = controller.getStatus()
    const deadlines = [
      this.lastScanAt + tuning.fullScanMs,
      fallbackPollDueAt({
        lastPollAt: this.lastPollAt,
        lastSyncedAt: status.lastSyncedAt,
        socketConnected: status.socketConnected,
        disconnectedPollIntervalMs: tuning.disconnectedPollMs,
        consecutiveFailures: this.pollFailures,
      }),
    ]
    if (!status.socketConnected) deadlines.push(this.nextReconnectAt)
    const delay = Math.max(250, Math.min(...deadlines) - now)
    this.scheduleTimer = window.setTimeout(() => void this.runScheduledWork(), delay)
  }

  private clearEventTimer(): void {
    if (this.eventTimer !== null) window.clearTimeout(this.eventTimer)
    this.eventTimer = null
  }

  private clearScheduleTimer(): void {
    if (this.scheduleTimer !== null) window.clearTimeout(this.scheduleTimer)
    this.scheduleTimer = null
  }
}
