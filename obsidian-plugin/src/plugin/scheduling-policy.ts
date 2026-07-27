export const HEALTHY_SOCKET_POLL_INTERVAL_MS = 5 * 60_000

export interface FallbackPollState {
  now: number
  lastPollAt: number
  lastSyncedAt: number | null
  socketConnected: boolean
  disconnectedPollIntervalMs: number
}

export function fallbackPollIntervalMs(
  socketConnected: boolean,
  disconnectedPollIntervalMs: number,
): number {
  return socketConnected ? HEALTHY_SOCKET_POLL_INTERVAL_MS : disconnectedPollIntervalMs
}

export function isFallbackPollDue(state: FallbackPollState): boolean {
  const baseline = Math.max(state.lastPollAt, state.lastSyncedAt ?? 0)
  return (
    state.now - baseline >=
    fallbackPollIntervalMs(state.socketConnected, state.disconnectedPollIntervalMs)
  )
}
