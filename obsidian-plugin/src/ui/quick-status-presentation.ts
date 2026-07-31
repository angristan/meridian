import type { MeridianSettings, SyncPhase, SyncStatus } from "../model"
import { connectionControlState, statusPresentation } from "../plugin/connection-control"

export type QuickStatusActionId =
  | "sync"
  | "pause"
  | "resume"
  | "activity"
  | "history"
  | "deleted"
  | "diagnostics"
  | "conflicts"
  | "devices"
  | "status"
  | "settings"

export interface QuickStatusAction {
  id: QuickStatusActionId
  title: string
  icon: string
  disabled: boolean
  section: "sync" | "inspect" | "manage"
}

export interface QuickStatusPresentation {
  title: string
  detail: string
  icon: string
  actions: QuickStatusAction[]
}

export function presentQuickStatus(
  settings: MeridianSettings,
  status: SyncStatus,
  hasActiveFile: boolean,
): QuickStatusPresentation {
  const connection = connectionControlState(settings, status.phase)
  const statusView = statusPresentation(status, connection)
  const busy = isBusy(status.phase)
  const actions: QuickStatusAction[] = []

  if (connection.kind !== "unconfigured") {
    actions.push({
      id: "sync",
      title: statusView.syncLabel,
      icon: statusView.syncLabel === "Retry" ? "rotate-ccw" : "refresh-cw",
      disabled: !connection.canSync || busy,
      section: "sync",
    })
  }
  if (connection.action === "pause" || connection.action === "resume") {
    actions.push({
      id: connection.action,
      title: connection.action === "pause" ? "Pause automatic sync" : "Resume sync",
      icon: connection.action === "pause" ? "pause" : "play",
      disabled: connection.disabled,
      section: "sync",
    })
  }
  actions.push({
    id: "activity",
    title: "Synchronized changes",
    icon: "list-tree",
    disabled: connection.kind === "unconfigured",
    section: "inspect",
  })
  if (hasActiveFile) {
    actions.push({
      id: "history",
      title: "History for current file",
      icon: "history",
      disabled: false,
      section: "inspect",
    })
  }
  actions.push(
    {
      id: "deleted",
      title: "Deleted files",
      icon: "trash-2",
      disabled: connection.kind === "unconfigured",
      section: "inspect",
    },
    {
      id: "conflicts",
      title: "Conflicts",
      icon: "git-compare-arrows",
      disabled: connection.kind === "unconfigured",
      section: "inspect",
    },
    {
      id: "diagnostics",
      title: "Sync diagnostics",
      icon: "list-filter",
      disabled: false,
      section: "manage",
    },
    {
      id: "devices",
      title: "Devices",
      icon: "monitor-smartphone",
      disabled: connection.kind === "unconfigured",
      section: "manage",
    },
    {
      id: "status",
      title: "Open sync status",
      icon: "cloud-cog",
      disabled: false,
      section: "manage",
    },
    {
      id: "settings",
      title: connection.kind === "unconfigured" ? "Connect Meridian" : "Settings",
      icon: connection.kind === "unconfigured" ? "plug" : "settings",
      disabled: false,
      section: "manage",
    },
  )

  return {
    title: status.message,
    detail: statusView.summary || statusView.liveUpdates,
    icon: statusIcon(status.phase),
    actions,
  }
}

function isBusy(phase: SyncPhase): boolean {
  return phase === "scanning" || phase === "pulling" || phase === "pushing" || phase === "pausing"
}

function statusIcon(phase: SyncPhase): string {
  switch (phase) {
    case "idle":
      return "cloud-check"
    case "scanning":
    case "pulling":
    case "pushing":
      return "refresh-cw"
    case "offline":
      return "cloud-off"
    case "error":
      return "triangle-alert"
    case "pausing":
      return "pause"
    case "disconnected":
      return "cloud"
  }
}
