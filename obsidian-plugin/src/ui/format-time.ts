const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(timestamp),
  )
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < 45_000) return "just now"
  if (elapsed < 90_000) return "1 min ago"
  if (elapsed < HOUR_MS) return `${Math.round(elapsed / MINUTE_MS)} min ago`
  if (elapsed < 90 * MINUTE_MS) return "1 hr ago"
  if (elapsed < DAY_MS) return `${Math.round(elapsed / HOUR_MS)} hr ago`
  if (elapsed < 36 * HOUR_MS) return "1 day ago"
  if (elapsed < 30 * DAY_MS) return `${Math.round(elapsed / DAY_MS)} days ago`
  return formatTime(timestamp)
}
