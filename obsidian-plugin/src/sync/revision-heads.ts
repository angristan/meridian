import type { LocalRevision } from "../model"

export function revisionHeads(revisions: readonly LocalRevision[]): LocalRevision[] {
  const referencedParents = new Set(revisions.flatMap((revision) => revision.parents))
  return revisions
    .filter((revision) => !referencedParents.has(revision.revisionId))
    .sort((left, right) => left.revisionId.localeCompare(right.revisionId))
}
