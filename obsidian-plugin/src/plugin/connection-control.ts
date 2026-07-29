import type { MeridianSettings, SyncStatus } from "../model"

export type ConnectionAction = "connect" | "pause" | "resume"
export type ConnectionControlKind =
  | "unconfigured"
  | "active"
  | "paused"
  | "pairing-pending"
  | "removal-pending"

export interface ConnectionControlState {
  kind: ConnectionControlKind
  action: ConnectionAction | null
  label: string
  disabled: boolean
  canSync: boolean
}

export interface StatusPresentation {
  summary: string
  liveUpdates: string
  syncLabel: "Sync now" | "Retry"
}

type ConnectionSettings = Pick<
  MeridianSettings,
  "enabled" | "endpoint" | "pendingDeviceRemoval" | "pendingPairingCompletion"
>

export function connectionControlState(settings: ConnectionSettings): ConnectionControlState {
  if (!settings.endpoint) {
    return {
      kind: "unconfigured",
      action: "connect",
      label: "Connect",
      disabled: false,
      canSync: false,
    }
  }
  if (settings.pendingPairingCompletion) {
    return {
      kind: "pairing-pending",
      action: null,
      label: "Pairing pending",
      disabled: true,
      canSync: false,
    }
  }
  if (settings.pendingDeviceRemoval) {
    return {
      kind: "removal-pending",
      action: null,
      label: "Removal pending",
      disabled: true,
      canSync: false,
    }
  }
  if (settings.enabled) {
    return {
      kind: "active",
      action: "pause",
      label: "Pause",
      disabled: false,
      canSync: true,
    }
  }
  return {
    kind: "paused",
    action: "resume",
    label: "Resume",
    disabled: false,
    canSync: false,
  }
}

export function statusPresentation(
  status: SyncStatus,
  connection: ConnectionControlState,
): StatusPresentation {
  const syncLabel = status.phase === "error" || status.phase === "offline" ? "Retry" : "Sync now"

  switch (connection.kind) {
    case "unconfigured":
      return { summary: "Not connected", liveUpdates: "Unavailable", syncLabel }
    case "paused":
      return {
        summary:
          status.queued > 0
            ? `${status.queued} change${status.queued === 1 ? "" : "s"} queued locally`
            : "Changes stay local until sync resumes",
        liveUpdates: "Paused",
        syncLabel,
      }
    case "pairing-pending":
      return {
        summary: "Finish pairing before synchronization can resume",
        liveUpdates: "Paused",
        syncLabel,
      }
    case "removal-pending":
      return {
        summary: "Finish device removal before synchronization can resume",
        liveUpdates: "Paused",
        syncLabel,
      }
    case "active":
      return {
        summary:
          status.phase === "offline"
            ? `${status.queued} changes queued locally`
            : (status.error ?? `${status.queued} queued · cursor ${status.cursor}`),
        liveUpdates: status.socketConnected ? "Connected" : "Polling",
        syncLabel,
      }
  }
}
