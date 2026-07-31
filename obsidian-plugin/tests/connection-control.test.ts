import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS, INITIAL_STATUS } from "../src/model"
import { connectionControlState, statusPresentation } from "../src/plugin/connection-control"

const configuredSettings = {
  ...structuredClone(DEFAULT_SETTINGS),
  endpoint: "https://example.test",
  vaultId: "vault-id",
  deviceId: "device-id",
}

describe("Meridian connection controls", () => {
  it("distinguishes setup, active, and paused actions", () => {
    expect(connectionControlState(DEFAULT_SETTINGS)).toEqual({
      kind: "unconfigured",
      action: "connect",
      label: "Connect",
      disabled: false,
      canSync: false,
    })
    expect(connectionControlState(configuredSettings)).toEqual({
      kind: "active",
      action: "pause",
      label: "Pause",
      disabled: false,
      canSync: true,
    })
    expect(connectionControlState({ ...configuredSettings, enabled: false })).toEqual({
      kind: "paused",
      action: "resume",
      label: "Resume",
      disabled: false,
      canSync: false,
    })
  })

  it("blocks ordinary sync controls during pending lifecycle operations", () => {
    const pendingPairingCompletion = {
      endpoint: "https://example.test",
      pairingId: "pairing-id",
      vaultId: "vault-id",
      deviceId: "device-id",
      expiresAt: 1_000,
    }
    const pendingDeviceRemoval = {
      endpoint: "https://example.test",
      vaultId: "vault-id",
      deviceId: "device-id",
      envelope: { signature: "signature" },
    }

    expect(
      connectionControlState({ ...configuredSettings, pendingPairingCompletion }),
    ).toMatchObject({
      kind: "pairing-pending",
      action: null,
      label: "Pairing pending",
      disabled: true,
      canSync: false,
    })
    expect(connectionControlState({ ...configuredSettings, pendingDeviceRemoval })).toMatchObject({
      kind: "removal-pending",
      action: null,
      label: "Removal pending",
      disabled: true,
      canSync: false,
    })
  })

  it("disables conflicting actions while pausing at a safe boundary", () => {
    const connection = connectionControlState({ ...configuredSettings, enabled: false }, "pausing")

    expect(connection).toEqual({
      kind: "pausing",
      action: null,
      label: "Pausing…",
      disabled: true,
      canSync: false,
    })
    expect(statusPresentation(INITIAL_STATUS, connection)).toMatchObject({
      summary: "Finishing the current operation at a safe boundary",
      liveUpdates: "Pausing",
    })
  })

  it("presents paused state without claiming live polling", () => {
    const connection = connectionControlState({ ...configuredSettings, enabled: false })

    expect(statusPresentation({ ...INITIAL_STATUS, queued: 1 }, connection)).toEqual({
      summary: "1 change queued locally",
      liveUpdates: "Paused",
      syncLabel: "Sync now",
    })
    expect(statusPresentation({ ...INITIAL_STATUS, queued: 0 }, connection).summary).toBe(
      "Changes stay local until sync resumes",
    )
  })

  it("turns manual sync into retry for active failures", () => {
    const connection = connectionControlState(configuredSettings)

    expect(
      statusPresentation(
        {
          ...INITIAL_STATUS,
          phase: "error",
          error: "Network unavailable",
          socketConnected: false,
        },
        connection,
      ),
    ).toEqual({
      summary: "",
      liveUpdates: "Polling",
      syncLabel: "Retry",
    })
    expect(
      statusPresentation({ ...INITIAL_STATUS, phase: "idle", socketConnected: true }, connection),
    ).toMatchObject({ summary: "", liveUpdates: "Connected" })
    expect(statusPresentation({ ...INITIAL_STATUS, queued: 2 }, connection).summary).toBe(
      "2 changes queued locally",
    )
  })
})
