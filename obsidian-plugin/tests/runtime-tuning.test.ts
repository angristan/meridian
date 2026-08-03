import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS } from "../src/model"
import {
  AUTOMATIC_DISCONNECTED_POLL_MS,
  AUTOMATIC_FULL_SCAN_MS,
  AUTOMATIC_MAX_FILE_BYTES,
  runtimeTuning,
} from "../src/plugin/runtime-tuning"

describe("automatic runtime tuning", () => {
  it("uses the automatic policy for new installations", () => {
    expect(runtimeTuning(DEFAULT_SETTINGS)).toEqual({
      disconnectedPollMs: AUTOMATIC_DISCONNECTED_POLL_MS,
      fullScanMs: AUTOMATIC_FULL_SCAN_MS,
      maxFileBytes: AUTOMATIC_MAX_FILE_BYTES,
    })
  })

  it("never makes an existing device slower or less file-capable", () => {
    expect(
      runtimeTuning({
        pollIntervalSeconds: 15,
        scanIntervalMinutes: 1,
        maxFileSizeMiB: 128,
      }),
    ).toEqual({
      disconnectedPollMs: 15_000,
      fullScanMs: 60_000,
      maxFileBytes: 128 * 1024 * 1024,
    })
    expect(
      runtimeTuning({
        pollIntervalSeconds: 300,
        scanIntervalMinutes: 30,
        maxFileSizeMiB: 16,
      }),
    ).toEqual({
      disconnectedPollMs: AUTOMATIC_DISCONNECTED_POLL_MS,
      fullScanMs: AUTOMATIC_FULL_SCAN_MS,
      maxFileBytes: AUTOMATIC_MAX_FILE_BYTES,
    })
  })
})
