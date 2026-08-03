import type { MeridianSettings, SyncDiagnostic, SyncStatus } from "../model"

export interface DiagnosticContext {
  meridianVersion: string
  obsidianVersion: string
  platform: string
  settings: MeridianSettings
}

export class SyncDiagnostics {
  private readonly values: SyncDiagnostic[] = []
  private previousKey: string | null = null

  constructor(
    private readonly maximumEntries = 200,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new RangeError("Diagnostic entry limit is invalid")
    }
  }

  record(status: SyncStatus): void {
    const hasError = status.error !== null
    const key = `${status.phase}\0${status.message}\0${hasError}`
    if (key === this.previousKey) return
    this.previousKey = key
    this.values.push({
      timestamp: this.now(),
      phase: status.phase,
      message: status.message,
      error: hasError ? "Error recorded" : null,
    })
    if (this.values.length > this.maximumEntries) {
      this.values.splice(0, this.values.length - this.maximumEntries)
    }
  }

  entries(): SyncDiagnostic[] {
    return structuredClone(this.values).reverse()
  }
}

export function createSanitizedDebugReport(
  context: DiagnosticContext,
  status: SyncStatus,
  diagnostics: readonly SyncDiagnostic[],
): string {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      meridianVersion: context.meridianVersion,
      obsidianVersion: context.obsidianVersion,
      platform: context.platform,
      connection: {
        configured: context.settings.endpoint.length > 0,
        enabled: context.settings.enabled,
        pairingPending: context.settings.pendingPairingCompletion !== null,
        removalPending: context.settings.pendingDeviceRemoval !== null,
      },
      status: {
        phase: status.phase,
        cursor: status.cursor,
        queued: status.queued,
        lastSyncedAt: status.lastSyncedAt,
        socketConnected: status.socketConnected,
        hasError: status.error !== null,
      },
      configCategories: context.settings.configCategories,
      recentTransitions: diagnostics.slice(0, 50).map((entry) => ({
        timestamp: entry.timestamp,
        phase: entry.phase,
        hasError: entry.error !== null,
      })),
    },
    null,
    2,
  )
}
