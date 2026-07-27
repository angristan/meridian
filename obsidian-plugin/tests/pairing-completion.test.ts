import { describe, expect, it, vi } from "vitest"
import { confirmRemotePairingCompletion } from "../src/plugin/pairing-completion"

describe("pairing completion confirmation", () => {
  it("accepts a confirmed completion response without probing", async () => {
    const isDeviceAuthorized = vi.fn(async () => false)
    await expect(
      confirmRemotePairingCompletion({
        complete: async () => {},
        isDeviceAuthorized,
      }),
    ).resolves.toBeUndefined()
    expect(isDeviceAuthorized).not.toHaveBeenCalled()
  })

  it("accepts a lost response only when the device is authorized", async () => {
    await expect(
      confirmRemotePairingCompletion({
        complete: async () => {
          throw new Error("Connection closed before response")
        },
        isDeviceAuthorized: async () => true,
      }),
    ).resolves.toBeUndefined()
  })

  it("preserves the completion failure when authorization is absent or uncertain", async () => {
    const completionError = new Error("Connection closed before response")
    for (const isDeviceAuthorized of [
      async () => false,
      async () => {
        throw new Error("Malformed probe response")
      },
    ]) {
      await expect(
        confirmRemotePairingCompletion({
          complete: async () => {
            throw completionError
          },
          isDeviceAuthorized,
        }),
      ).rejects.toBe(completionError)
    }
  })
})
