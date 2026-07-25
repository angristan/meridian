import { describe, expect, it } from "vitest"
import { createPairingDeepLink, parsePairingLinkParameters } from "../src/plugin/pairing-link"

const pairing = {
  pairingId: "pairing-id",
  capability: "pairing-capability",
  vaultId: "meridian-vault-id",
  expiresAt: 1_000,
}

describe("pairing deep links", () => {
  it("does not use Obsidian's reserved vault parameter", () => {
    const link = createPairingDeepLink("https://example.test", pairing)
    const url = new URL(link)

    expect(url.protocol).toBe("obsidian:")
    expect(url.hostname).toBe("meridian-pair")
    expect(url.searchParams.has("vault")).toBe(false)
    expect(url.searchParams.get("vaultId")).toBe(pairing.vaultId)
    expect(parsePairingLinkParameters(Object.fromEntries(url.searchParams))).toEqual({
      endpoint: "https://example.test",
      pairingId: pairing.pairingId,
      capability: pairing.capability,
      vaultId: pairing.vaultId,
      expiresAt: pairing.expiresAt,
    })
  })

  it("rejects links that only provide the reserved vault parameter", () => {
    expect(
      parsePairingLinkParameters({
        endpoint: "https://example.test",
        pairing: pairing.pairingId,
        capability: pairing.capability,
        vault: pairing.vaultId,
        expires: String(pairing.expiresAt),
      }),
    ).toBeNull()
  })
})
