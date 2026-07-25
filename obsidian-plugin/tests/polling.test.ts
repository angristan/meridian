import { describe, expect, it } from "vitest"
import { isPollingCanceled, pairingPollDelay, pollUntil } from "../src/ui/polling"

describe("pairing polling", () => {
  it("uses a bounded backoff and stops at approval", async () => {
    let now = 0
    const waits: number[] = []
    const states: Array<"pending" | "joined" | "approved"> = ["pending", "joined", "approved"]

    const result = await pollUntil({
      read: async () => ({ status: states.shift() ?? "approved" }),
      isDone: (value) => value.status === "approved",
      expiresAt: 10_000,
      signal: new AbortController().signal,
      now: () => now,
      wait: async (milliseconds) => {
        waits.push(milliseconds)
        now += milliseconds
      },
    })

    expect(result.status).toBe("approved")
    expect(waits).toEqual([1_000, 1_000])
    expect([0, 2, 3, 5, 8].map(pairingPollDelay)).toEqual([1_000, 1_000, 2_000, 2_000, 3_000])
  })

  it("stops at the pairing expiry boundary", async () => {
    let now = 0
    await expect(
      pollUntil({
        read: async () => ({ status: "pending" }),
        isDone: () => false,
        expiresAt: 500,
        signal: new AbortController().signal,
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds
        },
      }),
    ).rejects.toThrow("Pairing request expired")
  })

  it("recognizes modal cancellation", async () => {
    const controller = new AbortController()
    controller.abort()

    let error: unknown
    try {
      await pollUntil({
        read: async () => "pending",
        isDone: () => false,
        expiresAt: Date.now() + 1_000,
        signal: controller.signal,
      })
    } catch (cause) {
      error = cause
    }
    expect(isPollingCanceled(error)).toBe(true)
  })
})
