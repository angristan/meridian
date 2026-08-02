import { describe, expect, it } from "vitest"
import {
  FILE_EVENT_MAX_WAIT_MS,
  FILE_EVENT_QUIET_MS,
  FILE_EVENT_RAPID_QUIET_MS,
  HEALTHY_SOCKET_POLL_INTERVAL_MS,
  MAX_CONNECTIVITY_BACKOFF_MS,
  fallbackPollDueAt,
  fallbackPollIntervalMs,
  fileEventDelayMs,
  isFallbackPollDue,
  notificationReconnectDelayMs,
} from "../src/plugin/scheduling-policy"

describe("sync scheduling policy", () => {
  it("syncs short event bursts quickly and bounds continuous bursts", () => {
    expect(fileEventDelayMs({ now: 1_000, burstStartedAt: 1_000, previousEventAt: null })).toBe(
      FILE_EVENT_QUIET_MS,
    )
    expect(fileEventDelayMs({ now: 1_500, burstStartedAt: 1_000, previousEventAt: 1_000 })).toBe(
      FILE_EVENT_RAPID_QUIET_MS,
    )
    expect(fileEventDelayMs({ now: 5_500, burstStartedAt: 1_000, previousEventAt: 5_000 })).toBe(
      FILE_EVENT_MAX_WAIT_MS - 4_500,
    )
    expect(fileEventDelayMs({ now: 6_000, burstStartedAt: 1_000, previousEventAt: 5_500 })).toBe(0)
  })

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

  it("backs off disconnected polling to five minutes", () => {
    expect(fallbackPollIntervalMs(false, 45_000, 0)).toBe(45_000)
    expect(fallbackPollIntervalMs(false, 45_000, 1)).toBe(90_000)
    expect(fallbackPollIntervalMs(false, 45_000, 10)).toBe(MAX_CONNECTIVITY_BACKOFF_MS)
  })

  it("stores exact poll deadlines from the latest successful baseline", () => {
    expect(
      fallbackPollDueAt({
        lastPollAt: 200_000,
        lastSyncedAt: 300_000,
        socketConnected: false,
        disconnectedPollIntervalMs: 45_000,
        consecutiveFailures: 1,
      }),
    ).toBe(390_000)
  })

  it("uses jittered reconnect backoff capped at five minutes", () => {
    const midpoint = () => 0.5
    expect([0, 1, 2, 3].map((attempt) => notificationReconnectDelayMs(attempt, midpoint))).toEqual([
      2_000, 4_000, 8_000, 16_000,
    ])
    expect(notificationReconnectDelayMs(20, () => 1)).toBe(MAX_CONNECTIVITY_BACKOFF_MS)
    expect(notificationReconnectDelayMs(2, () => 0)).toBe(6_400)
  })

  it("never moves the fallback deadline backward for an older sync timestamp", () => {
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
