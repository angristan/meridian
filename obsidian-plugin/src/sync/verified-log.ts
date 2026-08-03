import type { RemoteChanges, RemoteOperation, TrustedCheckpoint } from "../model"
import { checkpointFormats } from "./checkpoints"

export interface VerifiedLogCursor {
  checkpoint: TrustedCheckpoint
  targetCursor: number | null
}

export function verifiedLogCursor(checkpoint: TrustedCheckpoint): VerifiedLogCursor {
  return { checkpoint, targetCursor: null }
}

export function acceptVerifiedLogPage(
  state: VerifiedLogCursor,
  page: RemoteChanges,
  trustedFloor: TrustedCheckpoint,
  freezeTarget: boolean,
  maximumTargetCursor = Number.MAX_SAFE_INTEGER,
): { state: VerifiedLogCursor; operations: RemoteOperation[] } {
  if (page.latestCursor < state.checkpoint.cursor || page.latestCursor < trustedFloor.cursor) {
    throw new Error("Server attempted to roll back the signed checkpoint")
  }
  const advertisedTarget = Math.min(page.latestCursor, maximumTargetCursor)
  const targetCursor = freezeTarget
    ? (state.targetCursor ?? advertisedTarget)
    : Math.max(state.targetCursor ?? state.checkpoint.cursor, advertisedTarget)
  const operations = page.operations.filter((operation) => operation.cursor <= targetCursor)
  if (operations.length === 0 && state.checkpoint.cursor < targetCursor) {
    throw new Error("Server omitted operations before its advertised latest cursor")
  }
  return { state: { ...state, targetCursor }, operations }
}

export function advanceVerifiedLogCursor(
  state: VerifiedLogCursor,
  operation: RemoteOperation,
  trustedFloor: TrustedCheckpoint,
): VerifiedLogCursor {
  const current = state.checkpoint
  if (operation.cursor !== current.cursor + 1) {
    throw new Error(`Operation log is discontinuous at cursor ${operation.cursor}`)
  }
  if (operation.cursor === trustedFloor.cursor && operation.logHash !== trustedFloor.logHash) {
    throw new Error("Server history conflicts with the signed device checkpoint")
  }

  const formats = checkpointFormats(current)
  const checkpoint: TrustedCheckpoint = {
    cursor: operation.cursor,
    logHash: operation.logHash,
    initialLogFormat: formats.initialLogFormat,
    logFormat:
      remoteOperationType(operation) === "log-format-transition"
        ? "canonical-cbor-v1"
        : formats.logFormat,
  }
  if (checkpoint.cursor === trustedFloor.cursor) {
    const trustedFormats = checkpointFormats(trustedFloor)
    if (
      checkpoint.initialLogFormat !== trustedFormats.initialLogFormat ||
      checkpoint.logFormat !== trustedFormats.logFormat
    ) {
      throw new Error("Server log format conflicts with the signed checkpoint")
    }
  }
  return { ...state, checkpoint }
}

export function remoteOperationType(operation: RemoteOperation): string {
  const envelope = operation.envelope
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return ""
  const type = (envelope as Record<string, unknown>).type
  return typeof type === "string" ? type : ""
}
