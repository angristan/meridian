import type { JournalEntry } from "../model"
import { randomId } from "../platform/bytes"

export type QueuedEntryInput = Pick<
  JournalEntry,
  | "action"
  | "fileId"
  | "path"
  | "previousPath"
  | "baseRevisionId"
  | "parentRevisionIds"
  | "restoreSourceRevisionId"
> & {
  id?: string
  revisionId?: string
  createdAt?: number
}

export function queuedEntry(input: QueuedEntryInput): JournalEntry {
  return {
    id: input.id ?? randomId(),
    action: input.action,
    fileId: input.fileId,
    path: input.path,
    previousPath: input.previousPath,
    baseRevisionId: input.baseRevisionId,
    parentRevisionIds: [...input.parentRevisionIds],
    restoreSourceRevisionId: input.restoreSourceRevisionId,
    revisionId: input.revisionId ?? randomId(),
    createdAt: input.createdAt ?? Date.now(),
    state: "queued",
    error: null,
    preparedRevision: null,
  }
}
