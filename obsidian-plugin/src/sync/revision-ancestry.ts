import type { LocalRevision } from "../model"
import type { JournalPort } from "../storage/contracts"

export class MissingRevisionAncestryError extends Error {
  constructor() {
    super("Local revision history is incomplete")
    this.name = "MissingRevisionAncestryError"
  }
}

export async function assertRevisionAncestry(
  journal: JournalPort,
  revision: Pick<LocalRevision, "revisionId" | "fileId" | "parents">,
  operationCursor: number,
  missingError: () => Error = () => new MissingRevisionAncestryError(),
): Promise<void> {
  if (new Set(revision.parents).size !== revision.parents.length) {
    throw new Error("Remote revision contains duplicate parents")
  }
  if (revision.parents.includes(revision.revisionId)) {
    throw new Error("Remote revision cannot reference itself as a parent")
  }

  const revisions = await journal.listRetainedFileRevisions(revision.fileId)
  const byId = new Map(revisions.map((candidate) => [candidate.revisionId, candidate]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = async (revisionId: string, childCursor: number): Promise<void> => {
    if (revisionId === revision.revisionId) {
      throw new Error("Remote revision would create an ancestry cycle")
    }
    if (visiting.has(revisionId)) throw new Error("Stored revision ancestry contains a cycle")
    const candidate = byId.get(revisionId) ?? (await journal.getRetainedRevision(revisionId))
    if (!candidate) throw missingError()
    if (candidate.fileId !== revision.fileId) {
      throw new Error("Remote revision parent belongs to another file")
    }
    const assertOlder = () => {
      if (candidate.cursor === null || candidate.cursor >= childCursor) {
        throw new Error("Remote revision parent is not an older committed revision")
      }
    }
    if (visited.has(revisionId)) {
      assertOlder()
      return
    }
    byId.set(candidate.revisionId, candidate)
    visiting.add(revisionId)
    for (const parentId of candidate.parents) {
      await visit(parentId, candidate.cursor ?? childCursor)
    }
    visiting.delete(revisionId)
    assertOlder()
    visited.add(revisionId)
  }
  for (const parentId of revision.parents) await visit(parentId, operationCursor)
}

interface RevisionIdentity {
  revisionId: string
  fileId: string
  parents: readonly string[]
  deviceId: string
  cursor: number | null
  tombstone: boolean
}

export function sameRevisionIdentity(left: RevisionIdentity, right: RevisionIdentity): boolean {
  return (
    left.revisionId === right.revisionId &&
    left.cursor === right.cursor &&
    left.fileId === right.fileId &&
    left.deviceId === right.deviceId &&
    left.tombstone === right.tombstone &&
    sameIds(left.parents, right.parents)
  )
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((value, index) => value === sortedRight[index])
}
