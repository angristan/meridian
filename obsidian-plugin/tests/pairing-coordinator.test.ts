import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("obsidian", () => ({
  Platform: {
    isIosApp: false,
    isAndroidApp: false,
    isMacOS: true,
    isWin: false,
    isLinux: false,
  },
  requestUrl: vi.fn(),
}))

import type { CryptoPort, MeridianSettings } from "../src/model"
import { DEFAULT_SETTINGS } from "../src/model"
import { PairingCoordinator } from "../src/plugin/pairing-coordinator"
import type { MeridianSecretStorage } from "../src/plugin/secret-storage"
import type { SyncController } from "../src/sync/controller"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("PairingCoordinator", () => {
  it("cancels polling without releasing secrets after unload", async () => {
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    })
    const releasePairing = vi.fn(async () => {})
    const pairingStatus = vi.fn(async () => ({
      pairingId: "pairing-id",
      status: "verifying" as const,
      expiresAt: Date.now() + 60_000,
      ownerConfirmed: true,
      candidateConfirmed: false,
    }))
    const controller = {
      confirmPairingOwner: vi.fn(async () => {}),
      pairingStatus,
      releasePairing,
    } as unknown as SyncController
    let settings: MeridianSettings = structuredClone(DEFAULT_SETTINGS)
    const coordinator = new PairingCoordinator(
      () => controller,
      () => settings,
      (next) => {
        settings = next
      },
      async () => {},
      async () => {},
      {} as CryptoPort,
      {} as MeridianSecretStorage,
    )

    const confirming = coordinator.confirmOwner("pairing-id")
    while (pairingStatus.mock.calls.length < 2) await Promise.resolve()
    coordinator.stop()

    await expect(confirming).rejects.toMatchObject({ name: "AbortError" })
    expect(releasePairing).not.toHaveBeenCalled()
  })
})
