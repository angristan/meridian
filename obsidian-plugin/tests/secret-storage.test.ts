import type { SecretStorage } from "obsidian"
import { describe, expect, it } from "vitest"
import { MeridianSecretStorage } from "../src/plugin/secret-storage"

class FakeSecretStorage {
  private readonly values = new Map<string, string>()

  getSecret(id: string): string | null {
    return this.values.get(id) ?? null
  }

  setSecret(id: string, value: string): void {
    this.values.set(id, value)
  }
}

describe("pairing SecretStorage", () => {
  it("retains exact join and completion payloads until terminal cleanup", () => {
    const storage = new FakeSecretStorage()
    const secrets = new MeridianSecretStorage(storage as unknown as SecretStorage)
    const pairingId = "pairing-id"
    const join = JSON.stringify({ capability: "secret-capability", proof: "join-proof" })
    const completion = JSON.stringify({
      capability: "secret-capability",
      transferHash: "transfer-hash",
      proof: "completion-proof",
    })

    secrets.setPendingPairing(pairingId, "private-candidate-state")
    secrets.setPendingPairingJoin(pairingId, join)
    secrets.setPendingPairingCompletion(pairingId, completion)

    expect(secrets.getPendingPairing(pairingId)).toBe("private-candidate-state")
    expect(secrets.getPendingPairingJoin(pairingId)).toBe(join)
    expect(secrets.getPendingPairingCompletion(pairingId)).toBe(completion)

    secrets.clearPendingPairing(pairingId)

    expect(secrets.getPendingPairing(pairingId)).toBe("")
    expect(secrets.getPendingPairingJoin(pairingId)).toBe("")
    expect(secrets.getPendingPairingCompletion(pairingId)).toBe("")
  })
})
