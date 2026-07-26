import { describe, expect, it } from "vitest"
import {
  createPairingDeepLink,
  hasConfiguredMeridianIdentity,
  parsePairingLinkParameters,
} from "../src/plugin/pairing-link"

const pairing = {
  pairingId: "pairing-id",
  capability: "pairing-capability",
  vaultId: "meridian-vault-id",
  expiresAt: 1_000,
}

describe("pairing deep links", () => {
  it("namespaces every custom parameter away from Obsidian routing", () => {
    const link = createPairingDeepLink("https://example.test", pairing)
    const url = new URL(link)

    expect(url.protocol).toBe("obsidian:")
    expect(url.hostname).toBe("meridian-pair")
    expect([...url.searchParams.keys()].sort()).toEqual([
      "meridianCapability",
      "meridianEndpoint",
      "meridianExpiresAt",
      "meridianPairingId",
      "meridianVaultId",
    ])
    expect(url.searchParams.get("meridianVaultId")).toBe(pairing.vaultId)
    expect(parsePairingLinkParameters(Object.fromEntries(url.searchParams))).toEqual({
      endpoint: "https://example.test",
      pairingId: pairing.pairingId,
      capability: pairing.capability,
      vaultId: pairing.vaultId,
      expiresAt: pairing.expiresAt,
    })
  })

  it("blocks pairing for connected, partial, paused, or removal-pending identities", () => {
    const empty = { endpoint: "", vaultId: "", deviceId: "", pendingDeviceRemoval: null }
    expect(hasConfiguredMeridianIdentity(empty)).toBe(false)
    expect(hasConfiguredMeridianIdentity({ ...empty, endpoint: "https://example.test" })).toBe(true)
    expect(hasConfiguredMeridianIdentity({ ...empty, vaultId: "vault-id" })).toBe(true)
    expect(hasConfiguredMeridianIdentity({ ...empty, deviceId: "device-id" })).toBe(true)
    expect(
      hasConfiguredMeridianIdentity({
        ...empty,
        pendingDeviceRemoval: {
          endpoint: "https://example.test",
          vaultId: "vault-id",
          deviceId: "device-id",
          envelope: {},
        },
      }),
    ).toBe(true)
  })

  it("rejects the old unnamespaced parameter contract", () => {
    expect(
      parsePairingLinkParameters({
        endpoint: "https://example.test",
        pairing: pairing.pairingId,
        capability: pairing.capability,
        vaultId: pairing.vaultId,
        expires: String(pairing.expiresAt),
      }),
    ).toBeNull()
  })
})
