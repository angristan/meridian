import {
  compareIds,
  copyRevision,
  type FileId,
  operationEqual,
  type Revision,
  type RevisionId,
  type RevisionOperation,
  revisionsEqual,
} from "./model"

export class RevisionGraph {
  readonly #revisions = new Map<RevisionId, Revision>()
  readonly #operations = new Map<string, RevisionOperation>()

  addOperation(operation: RevisionOperation): "added" | "duplicate" {
    const normalized: RevisionOperation = {
      operationId: operation.operationId,
      revision: copyRevision(operation.revision),
    }
    const previousOperation = this.#operations.get(normalized.operationId)
    if (previousOperation !== undefined) {
      if (!operationEqual(previousOperation, normalized)) {
        throw new Error(`Operation id ${normalized.operationId} was reused with different content`)
      }
      return "duplicate"
    }

    this.#validateRevision(normalized.revision)
    const previousRevision = this.#revisions.get(normalized.revision.id)
    if (previousRevision !== undefined && !revisionsEqual(previousRevision, normalized.revision)) {
      throw new Error(`Revision id ${normalized.revision.id} was reused with different content`)
    }

    this.#operations.set(normalized.operationId, normalized)
    if (previousRevision === undefined)
      this.#revisions.set(normalized.revision.id, normalized.revision)
    return "added"
  }

  addRevision(revision: Revision): "added" | "duplicate" {
    return this.addOperation({ operationId: `revision:${revision.id}`, revision })
  }

  get(revisionId: RevisionId): Revision | undefined {
    const revision = this.#revisions.get(revisionId)
    return revision === undefined ? undefined : copyRevision(revision)
  }

  has(revisionId: RevisionId): boolean {
    return this.#revisions.has(revisionId)
  }

  revisions(fileId?: FileId): readonly Revision[] {
    return [...this.#revisions.values()]
      .filter((revision) => fileId === undefined || revision.fileId === fileId)
      .sort((left, right) => compareIds(left.id, right.id))
      .map(copyRevision)
  }

  fileIds(): readonly FileId[] {
    return [...new Set([...this.#revisions.values()].map((revision) => revision.fileId))].sort(
      compareIds,
    )
  }

  heads(fileId: FileId): readonly Revision[] {
    const candidates = new Map(
      this.revisions(fileId).map((revision) => [revision.id, revision] as const),
    )
    for (const revision of candidates.values()) {
      for (const parent of revision.parents) candidates.delete(parent)
    }
    return [...candidates.values()].sort((left, right) => compareIds(left.id, right.id))
  }

  isAncestor(ancestorId: RevisionId, descendantId: RevisionId): boolean {
    if (ancestorId === descendantId) return true
    const visited = new Set<RevisionId>()
    const pending = [descendantId]
    while (pending.length > 0) {
      const currentId = pending.pop()
      if (currentId === undefined || visited.has(currentId)) continue
      visited.add(currentId)
      const current = this.#revisions.get(currentId)
      if (current === undefined) continue
      for (const parent of current.parents) {
        if (parent === ancestorId) return true
        pending.push(parent)
      }
    }
    return false
  }

  commonAncestor(leftId: RevisionId, rightId: RevisionId): Revision | undefined {
    const leftDistances = this.#ancestorDistances(leftId)
    const rightDistances = this.#ancestorDistances(rightId)
    const candidates = [...leftDistances.keys()].filter((id) => rightDistances.has(id))
    candidates.sort((left, right) => {
      const leftA = leftDistances.get(left) ?? Number.MAX_SAFE_INTEGER
      const leftB = rightDistances.get(left) ?? Number.MAX_SAFE_INTEGER
      const rightA = leftDistances.get(right) ?? Number.MAX_SAFE_INTEGER
      const rightB = rightDistances.get(right) ?? Number.MAX_SAFE_INTEGER
      return (
        Math.max(leftA, leftB) - Math.max(rightA, rightB) ||
        leftA + leftB - (rightA + rightB) ||
        compareIds(left, right)
      )
    })
    const winner = candidates[0]
    return winner === undefined ? undefined : this.get(winner)
  }

  #ancestorDistances(startId: RevisionId): Map<RevisionId, number> {
    const distances = new Map<RevisionId, number>()
    const pending: Array<readonly [RevisionId, number]> = [[startId, 0]]
    while (pending.length > 0) {
      const next = pending.shift()
      if (next === undefined) continue
      const [id, distance] = next
      const known = distances.get(id)
      if (known !== undefined && known <= distance) continue
      distances.set(id, distance)
      const revision = this.#revisions.get(id)
      if (revision === undefined) continue
      for (const parent of revision.parents) pending.push([parent, distance + 1])
    }
    return distances
  }

  #validateRevision(revision: Revision): void {
    if (revision.id.length === 0 || revision.fileId.length === 0 || revision.author.length === 0) {
      throw new TypeError("Revision, file, and author ids must be non-empty")
    }
    const parents = new Set(revision.parents)
    if (parents.size !== revision.parents.length || parents.has(revision.id)) {
      throw new TypeError(`Revision ${revision.id} has duplicate or self parents`)
    }
    if (
      revision.parents.some((parent, index) => {
        const previous = revision.parents[index - 1]
        return previous !== undefined && parent <= previous
      })
    ) {
      throw new TypeError(`Revision ${revision.id} parents must be sorted canonically`)
    }
    for (const parent of revision.parents) {
      const known = this.#revisions.get(parent)
      if (known !== undefined && known.fileId !== revision.fileId) {
        throw new TypeError(`Revision ${revision.id} references a parent from another file`)
      }
    }
    for (const child of this.#revisions.values()) {
      if (child.parents.includes(revision.id) && child.fileId !== revision.fileId) {
        throw new TypeError(`Revision ${revision.id} is a parent of a different file`)
      }
    }
  }
}
