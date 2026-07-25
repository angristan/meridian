import { describe, expect, it } from "vitest"
import { createPairingDeepLink, parsePairingLinkParameters } from "../src/plugin/pairing-link"

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
