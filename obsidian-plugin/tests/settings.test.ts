import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS } from "../src/model"
import { getMeridianControlValue, setMeridianControlValue } from "../src/plugin/settings-controls"
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

  it("restores only non-secret well-formed pairing completion markers", () => {
    const pendingPairingCompletion = {
      endpoint: "https://example.test",
      pairingId: "pairing-id",
      vaultId: "vault-id",
      deviceId: "device-id",
      expiresAt: 1_000,
    }
    expect(normalizeSettings({ pendingPairingCompletion }).pendingPairingCompletion).toEqual(
      pendingPairingCompletion,
    )
    expect(
      normalizeSettings({
        pendingPairingCompletion: { ...pendingPairingCompletion, expiresAt: "invalid" },
      }).pendingPairingCompletion,
    ).toBeNull()
  })

  it("restores only well-formed pending protocol upgrades", () => {
    const pendingProtocolUpgrade = {
      endpoint: "https://example.test",
      vaultId: "vault-id",
      deviceId: "device-id",
      operationId: "operation-id",
      envelope: { type: "log-format-transition", signature: "signature" },
    }
    expect(normalizeSettings({ pendingProtocolUpgrade }).pendingProtocolUpgrade).toEqual(
      pendingProtocolUpgrade,
    )
    expect(
      normalizeSettings({ pendingProtocolUpgrade: { operationId: "partial" } })
        .pendingProtocolUpgrade,
    ).toBeNull()
  })

  it("migrates and bounds normalized selective sync lists", () => {
    expect(
      normalizeSettings({
        selectiveSync: {
          excludedFolders: ["Archive\\private", "Archive/private", "../unsafe", 42],
          excludedExtensions: [".MOV", "mov", "bad/path", "tar.gz"],
        },
      }).selectiveSync,
    ).toEqual({
      excludedFolders: ["Archive/private"],
      excludedExtensions: ["mov", "tar.gz"],
    })
    expect(normalizeSettings({}).selectiveSync).toEqual({
      excludedFolders: [],
      excludedExtensions: [],
    })
  })

  it("binds declarative settings to normalized storage and safe rescans", async () => {
    let saves = 0
    let syncs = 0
    const host = {
      settings: structuredClone(DEFAULT_SETTINGS),
      async saveSettings() {
        saves += 1
      },
      async syncNow() {
        syncs += 1
      },
    }

    await setMeridianControlValue(host, "excludedFolders", "Archive\\private\n../unsafe")
    await setMeridianControlValue(host, "excludedExtensions", ".MOV, tar.gz, bad/path")
    expect(getMeridianControlValue(host, "excludedFolders")).toBe("Archive/private")
    expect(getMeridianControlValue(host, "excludedExtensions")).toBe("mov, tar.gz")
    expect(syncs).toBe(0)

    await setMeridianControlValue(host, "config.themes", false)
    expect(host.settings.configCategories.themes).toBe(false)
    expect(syncs).toBe(1)
    expect(saves).toBe(3)
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
      pendingPairingCompletion: {
        endpoint: "https://example.test",
        pairingId: "pairing-id",
        vaultId: "vault-id",
        deviceId: "device-id",
        expiresAt: 1_000,
      },
      pendingProtocolUpgrade: {
        endpoint: "https://example.test",
        vaultId: "vault-id",
        deviceId: "device-id",
        operationId: "operation-id",
        envelope: { signature: "signature" },
      },
    }

    expect(withoutMeridianIdentity(settings)).toMatchObject({
      enabled: false,
      endpoint: "",
      vaultId: "",
      deviceId: "",
      pendingDeviceRemoval: null,
      pendingPairingCompletion: null,
      pendingProtocolUpgrade: null,
      deviceName: "My iPhone",
      pollIntervalSeconds: 90,
    })
  })
})
