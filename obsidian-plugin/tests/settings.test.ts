import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS } from "../src/model"
import { normalizeSettings, withoutMeridianIdentity } from "../src/plugin/settings-state"

describe("Meridian settings lifecycle", () => {
  it("restores only well-formed pending device removals", () => {
    const pendingDeviceRemoval = {
      endpoint: "https://example.test",
      vaultId: "vault-id",
      deviceId: "device-id",
      envelope: { type: "device-revocation", signature: "signature" },
    }
    expect(normalizeSettings({ pendingDeviceRemoval }).pendingDeviceRemoval).toEqual(
      pendingDeviceRemoval,
    )
    expect(
      normalizeSettings({ pendingDeviceRemoval: { deviceId: "partial" } }).pendingDeviceRemoval,
    ).toBeNull()
  })

  it("forgets identity while preserving local preferences", () => {
    const settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      enabled: true,
      endpoint: "https://example.test",
      vaultId: "vault-id",
      deviceId: "device-id",
      deviceName: "My iPhone",
      pollIntervalSeconds: 90,
      pendingDeviceRemoval: {
        endpoint: "https://example.test",
        vaultId: "vault-id",
        deviceId: "device-id",
        envelope: { signature: "signature" },
      },
    }

    expect(withoutMeridianIdentity(settings)).toMatchObject({
      enabled: false,
      endpoint: "",
      vaultId: "",
      deviceId: "",
      pendingDeviceRemoval: null,
      deviceName: "My iPhone",
      pollIntervalSeconds: 90,
    })
  })
})
