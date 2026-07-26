import { DEFAULT_SETTINGS, type MeridianSettings, type PendingDeviceRemoval } from "../model"

export function normalizeSettings(loaded: unknown): MeridianSettings {
  const value = isRecord(loaded) ? loaded : {}
  const loadedCategories = isRecord(value.configCategories) ? value.configCategories : {}
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...value,
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    endpoint: typeof value.endpoint === "string" ? value.endpoint : "",
    vaultId: typeof value.vaultId === "string" ? value.vaultId : "",
    deviceId: typeof value.deviceId === "string" ? value.deviceId : "",
    deviceName: typeof value.deviceName === "string" ? value.deviceName : "",
    pendingDeviceRemoval: pendingDeviceRemoval(value.pendingDeviceRemoval),
    pollIntervalSeconds: boundedNumber(value.pollIntervalSeconds, 15, 300, 45),
    scanIntervalMinutes: boundedNumber(value.scanIntervalMinutes, 1, 30, 5),
    maxFileSizeMiB: boundedNumber(value.maxFileSizeMiB, 16, 128, 64),
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
