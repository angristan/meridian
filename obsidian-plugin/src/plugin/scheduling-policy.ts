export const FILE_EVENT_QUIET_MS = 1_500
export const FILE_EVENT_RAPID_QUIET_MS = 3_000
export const FILE_EVENT_MAX_WAIT_MS = 5_000
export const FILE_EVENT_RAPID_WINDOW_MS = 750
export const HEALTHY_SOCKET_POLL_INTERVAL_MS = 5 * 60_000
export const MAX_CONNECTIVITY_BACKOFF_MS = 5 * 60_000
export const NOTIFICATION_RECONNECT_BASE_MS = 2_000

export interface FileEventDelayState {
  now: number
  burstStartedAt: number
  previousEventAt: number | null
}

export function fileEventDelayMs(state: FileEventDelayState): number {
  const rapid =
    state.previousEventAt !== null && state.now - state.previousEventAt < FILE_EVENT_RAPID_WINDOW_MS
  const quietDelay = rapid ? FILE_EVENT_RAPID_QUIET_MS : FILE_EVENT_QUIET_MS
  const maximumRemaining = Math.max(0, FILE_EVENT_MAX_WAIT_MS - (state.now - state.burstStartedAt))
  return Math.min(quietDelay, maximumRemaining)
}

export interface FallbackPollState {
  now: number
  lastPollAt: number
  lastSyncedAt: number | null
  socketConnected: boolean
  disconnectedPollIntervalMs: number
  consecutiveFailures?: number
}

export function fallbackPollIntervalMs(
  socketConnected: boolean,
  disconnectedPollIntervalMs: number,
  consecutiveFailures = 0,
): number {
  if (socketConnected) return HEALTHY_SOCKET_POLL_INTERVAL_MS
  return Math.min(
    MAX_CONNECTIVITY_BACKOFF_MS,
    disconnectedPollIntervalMs * 2 ** Math.max(0, consecutiveFailures),
  )
}

export function fallbackPollDueAt(state: Omit<FallbackPollState, "now">): number {
  const baseline = Math.max(state.lastPollAt, state.lastSyncedAt ?? 0)
  return (
    baseline +
    fallbackPollIntervalMs(
      state.socketConnected,
      state.disconnectedPollIntervalMs,
      state.consecutiveFailures,
    )
  )
}

export function isFallbackPollDue(state: FallbackPollState): boolean {
  return state.now >= fallbackPollDueAt(state)
}

export function notificationReconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(
    MAX_CONNECTIVITY_BACKOFF_MS,
    NOTIFICATION_RECONNECT_BASE_MS * 2 ** Math.max(0, attempt),
  )
  const jitter = 0.8 + 0.4 * Math.min(1, Math.max(0, random()))
  return Math.min(MAX_CONNECTIVITY_BACKOFF_MS, Math.round(exponential * jitter))
}
