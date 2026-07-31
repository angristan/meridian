import type { RemoteDevice, SyncActivity, SyncActivityKind } from "../model"
import { formatRelativeTime } from "./format-time"

export type ActivityFilter = "all" | SyncActivityKind

export interface PresentedActivity {
  entry: SyncActivity
  title: string
  path: string
  source: string
  time: string
}

export function presentActivities(
  entries: readonly SyncActivity[],
  devices: readonly RemoteDevice[],
  filter: ActivityFilter = "all",
  query = "",
  now = Date.now(),
): PresentedActivity[] {
  const names = new Map(
    devices.map((device) => [
      device.deviceId,
      device.deviceName?.trim() || shortId(device.deviceId),
    ]),
  )
  const normalizedQuery = query.trim().toLocaleLowerCase()
  return entries
    .filter((entry) => filter === "all" || entry.kind === filter)
    .filter((entry) => {
      if (!normalizedQuery) return true
      const source = entry.local
        ? "this device"
        : (names.get(entry.deviceId) ?? shortId(entry.deviceId))
      return [entry.path, entry.previousPath ?? "", activityTitle(entry.kind), source].some(
        (value) => value.toLocaleLowerCase().includes(normalizedQuery),
      )
    })
    .map((entry) => ({
      entry,
      title: activityTitle(entry.kind),
      path: entry.previousPath ? `${entry.previousPath} → ${entry.path}` : entry.path,
      source: entry.local ? "This device" : (names.get(entry.deviceId) ?? shortId(entry.deviceId)),
      time: formatRelativeTime(entry.createdAt, now),
    }))
}

export function activityTitle(kind: SyncActivityKind): string {
  switch (kind) {
    case "created":
      return "Created"
    case "modified":
      return "Updated"
    case "renamed":
      return "Renamed"
    case "deleted":
      return "Deleted"
    case "restored":
      return "Restored"
    case "conflict":
      return "Conflict preserved"
  }
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value
}
