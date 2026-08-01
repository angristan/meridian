import type { LocalStoragePressure, LocalStorageUsage } from "../model"

export interface BrowserStorageManager {
  estimate?: () => Promise<{ usage?: number; quota?: number }>
  persisted?: () => Promise<boolean>
  persist?: () => Promise<boolean>
}

export async function estimateLocalStorage(
  storage: BrowserStorageManager | null = browserStorageManager(),
): Promise<LocalStorageUsage> {
  if (!storage?.estimate) {
    return { usageBytes: null, quotaBytes: null, persisted: null, pressure: "unavailable" }
  }
  const [estimate, persisted] = await Promise.all([
    storage.estimate(),
    storage.persisted ? storage.persisted().catch(() => null) : Promise.resolve(null),
  ])
  const usageBytes = validEstimate(estimate.usage)
  const quotaBytes = validEstimate(estimate.quota)
  return {
    usageBytes,
    quotaBytes,
    persisted,
    pressure: localStoragePressure(usageBytes, quotaBytes),
  }
}

export async function requestLocalStoragePersistence(
  storage: BrowserStorageManager | null = browserStorageManager(),
): Promise<boolean | null> {
  if (!storage?.persist) return null
  return storage.persist()
}

export function localStoragePressure(
  usageBytes: number | null,
  quotaBytes: number | null,
): LocalStoragePressure {
  if (usageBytes === null || quotaBytes === null || quotaBytes === 0) return "unavailable"
  const ratio = usageBytes / quotaBytes
  if (ratio >= 0.9) return "critical"
  if (ratio >= 0.8) return "warning"
  return "normal"
}

export function isQuotaExceededError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED"
}

function browserStorageManager(): BrowserStorageManager | null {
  return typeof navigator === "undefined" ? null : (navigator.storage ?? null)
}

function validEstimate(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null
}
