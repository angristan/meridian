import {
  DEFAULT_SETTINGS,
  type LegacySelectiveSyncRules,
  type MeridianSettings,
  type PendingDeviceRemoval,
  type PendingEpochTransition,
  type PendingPairingCompletion,
} from "../model"

export function normalizeSettings(loaded: unknown): MeridianSettings {
  const value = isRecord(loaded) ? loaded : {}
  const loadedCategories = isRecord(value.configCategories) ? value.configCategories : {}
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    endpoint: typeof value.endpoint === "string" ? value.endpoint : "",
    vaultId: typeof value.vaultId === "string" ? value.vaultId : "",
    deviceId: typeof value.deviceId === "string" ? value.deviceId : "",
    deviceName: typeof value.deviceName === "string" ? value.deviceName : "",
    pendingDeviceRemoval: pendingDeviceRemoval(value.pendingDeviceRemoval),
    pendingPairingCompletion: pendingPairingCompletion(value.pendingPairingCompletion),
    pendingEpochTransition: pendingEpochTransition(value.pendingEpochTransition),
    pollIntervalSeconds: boundedNumber(value.pollIntervalSeconds, 15, 300, 45),
    scanIntervalMinutes: boundedNumber(value.scanIntervalMinutes, 1, 30, 5),
    maxFileSizeMiB: boundedNumber(value.maxFileSizeMiB, 16, 128, 64),
    legacySelectiveSync: legacySelectiveSync(value.legacySelectiveSync ?? value.selectiveSync),
    configCategories: {
      ...DEFAULT_SETTINGS.configCategories,
      main: booleanValue(loadedCategories.main, true),
      appearance: booleanValue(loadedCategories.appearance, true),
      themes: booleanValue(loadedCategories.themes, true),
      hotkeys: booleanValue(loadedCategories.hotkeys, true),
      "core-plugins": booleanValue(loadedCategories["core-plugins"], true),
      "core-plugin-settings": booleanValue(loadedCategories["core-plugin-settings"], true),
    },
  }
}

export function withoutMeridianIdentity(settings: MeridianSettings): MeridianSettings {
  return {
    ...settings,
    enabled: false,
    endpoint: "",
    vaultId: "",
    deviceId: "",
    pendingDeviceRemoval: null,
    pendingPairingCompletion: null,
    pendingEpochTransition: null,
    legacySelectiveSync: null,
  }
}

export function settingsForStorage(settings: MeridianSettings): Record<string, unknown> {
  const { legacySelectiveSync, ...stored } = settings
  return legacySelectiveSync ? { ...stored, selectiveSync: legacySelectiveSync } : stored
}

export function assertSelectiveSyncRemoved(settings: MeridianSettings): void {
  if (!settings.legacySelectiveSync) return
  throw new Error(
    "Selective-sync rules must be cleared and fully synced with Meridian 1.11.13 before upgrading",
  )
}

function pendingEpochTransition(value: unknown): PendingEpochTransition | null {
  if (
    !isRecord(value) ||
    typeof value.endpoint !== "string" ||
    typeof value.vaultId !== "string" ||
    typeof value.deviceId !== "string" ||
    typeof value.operationId !== "string" ||
    typeof value.nextEpochId !== "string" ||
    !isRecord(value.envelope)
  ) {
    return null
  }
  return {
    endpoint: value.endpoint,
    vaultId: value.vaultId,
    deviceId: value.deviceId,
    operationId: value.operationId,
    nextEpochId: value.nextEpochId,
    envelope: value.envelope,
  }
}

function pendingPairingCompletion(value: unknown): PendingPairingCompletion | null {
  if (
    !isRecord(value) ||
    typeof value.endpoint !== "string" ||
    typeof value.pairingId !== "string" ||
    typeof value.vaultId !== "string" ||
    typeof value.deviceId !== "string" ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt < 0
  ) {
    return null
  }
  return {
    endpoint: value.endpoint,
    pairingId: value.pairingId,
    vaultId: value.vaultId,
    deviceId: value.deviceId,
    expiresAt: value.expiresAt,
  }
}

function pendingDeviceRemoval(value: unknown): PendingDeviceRemoval | null {
  if (
    !isRecord(value) ||
    typeof value.endpoint !== "string" ||
    typeof value.vaultId !== "string" ||
    typeof value.deviceId !== "string" ||
    !isRecord(value.envelope)
  ) {
    return null
  }
  return {
    endpoint: value.endpoint,
    vaultId: value.vaultId,
    deviceId: value.deviceId,
    envelope: value.envelope,
  }
}

function legacySelectiveSync(value: unknown): LegacySelectiveSyncRules | null {
  if (!isRecord(value)) return null
  const excludedFolders = boundedStrings(value.excludedFolders)
  const excludedExtensions = boundedStrings(value.excludedExtensions)
  return excludedFolders.length > 0 || excludedExtensions.length > 0
    ? { excludedFolders, excludedExtensions }
    : null
}

function boundedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ]
    .sort()
    .slice(0, 200)
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
