import type { FileSnapshot, JournalEntry, LocalRevision } from "../model"

export type MetadataRecord = { key: string; value: unknown }

export type LegacyFileSnapshot = Omit<FileSnapshot, "fileId"> & { fileId?: string }

export type LegacyJournalEntry = Omit<
  JournalEntry,
  "fileId" | "parentRevisionIds" | "restoreSourceRevisionId"
> & {
  fileId?: string
  parentRevisionIds?: string[]
  restoreSourceRevisionId?: string | null
}

export type LegacyLocalRevision = Omit<LocalRevision, "fileId" | "operation"> & {
  fileId?: string
  operation?: LocalRevision["operation"]
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
