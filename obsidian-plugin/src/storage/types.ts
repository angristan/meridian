import type { FileSnapshot, JournalEntry, LocalRevision } from "../model"

export type MetadataRecord = { key: string; value: unknown }

export type LegacyFileSnapshot = Omit<FileSnapshot, "fileId"> & { fileId?: string }

export type LegacyJournalEntry = Omit<
  JournalEntry,
  "fileId" | "parentRevisionIds" | "restoreSourceRevisionId" | "preparedRevision"
> & {
  fileId?: string
  parentRevisionIds?: string[]
  restoreSourceRevisionId?: string | null
  preparedRevision?: JournalEntry["preparedRevision"]
}

export type LegacyLocalRevision = Omit<
  LocalRevision,
  "fileId" | "operation" | "action" | "previousPath"
> & {
  fileId?: string
  operation?: LocalRevision["operation"]
  action?: LocalRevision["action"]
  previousPath?: LocalRevision["previousPath"]
}

export interface MigratedJournalRecords {
  files: FileSnapshot[]
  entries: JournalEntry[]
  revisions: LocalRevision[]
}

export function sortRevisions(revisions: LocalRevision[]): LocalRevision[] {
  return revisions.sort(
    (left, right) =>
      right.createdAt - left.createdAt || right.revisionId.localeCompare(left.revisionId),
  )
}
