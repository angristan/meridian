import { describe, expect, it } from "vitest"
import {
  HEALTHY_SOCKET_POLL_INTERVAL_MS,
  fallbackPollIntervalMs,
  isFallbackPollDue,
} from "../src/plugin/scheduling-policy"

describe("sync scheduling policy", () => {
  it("uses a five-minute fallback while notifications are connected", () => {
    expect(fallbackPollIntervalMs(true, 45_000)).toBe(HEALTHY_SOCKET_POLL_INTERVAL_MS)
    expect(
      isFallbackPollDue({
        now: HEALTHY_SOCKET_POLL_INTERVAL_MS - 1,
        lastPollAt: 0,
        lastSyncedAt: null,
        socketConnected: true,
        disconnectedPollIntervalMs: 45_000,
      }),
    ).toBe(false)
    expect(
      isFallbackPollDue({
        now: HEALTHY_SOCKET_POLL_INTERVAL_MS,
        lastPollAt: 0,
        lastSyncedAt: null,
        socketConnected: true,
        disconnectedPollIntervalMs: 45_000,
      }),
    ).toBe(true)
  })

  it("uses the configured interval while notifications are disconnected", () => {
    expect(fallbackPollIntervalMs(false, 45_000)).toBe(45_000)
    expect(
      isFallbackPollDue({
        now: 45_000,
        lastPollAt: 0,
        lastSyncedAt: null,
        socketConnected: false,
        disconnectedPollIntervalMs: 45_000,
      }),
    ).toBe(true)
  })

  it("resets the fallback deadline after any later successful sync", () => {
    expect(
      isFallbackPollDue({
        now: 599_999,
        lastPollAt: 0,
        lastSyncedAt: 300_000,
        socketConnected: true,
        disconnectedPollIntervalMs: 45_000,
      }),
    ).toBe(false)
    expect(
      isFallbackPollDue({
        now: 600_000,
        lastPollAt: 0,
        lastSyncedAt: 300_000,
        socketConnected: true,
        disconnectedPollIntervalMs: 45_000,
      }),
    ).toBe(true)
  })

  it("never moves the deadline backward for an older sync timestamp", () => {
    expect(
      isFallbackPollDue({
        now: 499_999,
        lastPollAt: 200_000,
        lastSyncedAt: 100_000,
        socketConnected: true,
        disconnectedPollIntervalMs: 45_000,
      }),
    ).toBe(false)
  })
})
