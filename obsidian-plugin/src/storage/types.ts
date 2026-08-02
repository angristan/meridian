import type { LocalRevision } from "../model"

export type MetadataRecord = { key: string; value: unknown }

export function sortRevisions(revisions: LocalRevision[]): LocalRevision[] {
  return revisions.sort(
    (left, right) =>
      right.createdAt - left.createdAt || right.revisionId.localeCompare(left.revisionId),
  )
}
