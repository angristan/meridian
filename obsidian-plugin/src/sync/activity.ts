import type { LocalRevision, SyncActivity, SyncActivityKind } from "../model"

export function revisionActivity(
  revisions: readonly LocalRevision[],
  localDeviceId: string,
  limit = 200,
): SyncActivity[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Activity limit is invalid")
  return [...revisions]
    .sort(compareRevisionActivity)
    .slice(0, limit)
    .map((revision) => ({
      revisionId: revision.revisionId,
      fileId: revision.fileId,
      kind: activityKind(revision),
      path: revision.path,
      previousPath: revision.previousPath ?? null,
      deviceId: revision.deviceId,
      createdAt: revision.createdAt,
      cursor: revision.cursor,
      local: revision.deviceId === localDeviceId,
    }))
}

function activityKind(revision: LocalRevision): SyncActivityKind {
  if (revision.isConflict) return "conflict"
  const action = revision.action ?? (revision.tombstone ? "delete" : "upsert")
  if (action === "delete") return "deleted"
  if (action === "restore") return "restored"
  if (revision.previousPath) return "renamed"
  return revision.parents.length === 0 ? "created" : "modified"
}

function compareRevisionActivity(left: LocalRevision, right: LocalRevision): number {
  if (left.cursor !== null && right.cursor !== null && left.cursor !== right.cursor) {
    return right.cursor - left.cursor
  }
  return right.createdAt - left.createdAt || right.revisionId.localeCompare(left.revisionId)
}
