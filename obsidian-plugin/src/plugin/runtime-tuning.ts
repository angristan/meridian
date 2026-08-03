import type { MeridianSettings } from "../model"

export const AUTOMATIC_DISCONNECTED_POLL_MS = 45_000
export const AUTOMATIC_FULL_SCAN_MS = 5 * 60_000
export const AUTOMATIC_MAX_FILE_BYTES = 64 * 1024 * 1024

export interface RuntimeTuning {
  disconnectedPollMs: number
  fullScanMs: number
  maxFileBytes: number
}

/** Keeps existing devices at least as responsive and capable while removing user-facing knobs. */
export function runtimeTuning(
  settings: Pick<
    MeridianSettings,
    "maxFileSizeMiB" | "pollIntervalSeconds" | "scanIntervalMinutes"
  >,
): RuntimeTuning {
  return {
    disconnectedPollMs: Math.min(
      AUTOMATIC_DISCONNECTED_POLL_MS,
      settings.pollIntervalSeconds * 1_000,
    ),
    fullScanMs: Math.min(AUTOMATIC_FULL_SCAN_MS, settings.scanIntervalMinutes * 60_000),
    maxFileBytes: Math.max(AUTOMATIC_MAX_FILE_BYTES, settings.maxFileSizeMiB * 1024 * 1024),
  }
}
