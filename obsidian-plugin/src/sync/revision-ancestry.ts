import { LogFormat, type LogFormat as LogFormatName } from "@meridian/protocol"
import type { LocalRevision, RemoteOperation } from "../model"
import type { JournalPort } from "../storage/contracts"
import { revisionHeads } from "./revision-heads"

export class MissingRevisionAncestryError extends Error {
  constructor() {
    super("Local revision history is incomplete")
    this.name = "MissingRevisionAncestryError"
  }
}

interface RevisionParentContext {
  revisionId: string
  action: "upsert" | "delete" | "restore"
  fileId: string
  path: string
  parents: readonly string[]
  authorDeviceId: string
}

// An early writer could select a same-path parent from stale local identity metadata for deletes.
// Reconstruct only that legacy shape from older verified heads of the tombstone's own file.
export async function repairLegacyTombstoneParents(
  journal: JournalPort,
  revision: RevisionParentContext,
  operation: RemoteOperation,
  logFormat: LogFormatName,
): Promise<string[]> {
  if (
    logFormat !== LogFormat.LegacyHttpV1 ||
    revision.action !== "delete" ||
    revision.parents.length !== 1
  ) {
    return [...revision.parents]
  }

  const existing = await journal.getRetainedRevision(revision.revisionId)
  const sameExistingRevision =
    existing?.fileId === revision.fileId && sameSignedFileRevision(existing.operation, operation)
  const repairCursor =
    existing && sameExistingRevision && existing.cursor !== null
      ? Math.min(existing.cursor, operation.cursor)
      : operation.cursor
  if (
    existing &&
    sameExistingRevision &&
    (await allParentsBelongToFile(journal, existing, repairCursor))
  ) {
    return [...existing.parents]
  }

  const declaredParent = await journal.getRetainedRevision(revision.parents[0] ?? "")
  if (
    !declaredParent ||
    declaredParent.fileId === revision.fileId ||
    declaredParent.cursor === null ||
    declaredParent.cursor >= repairCursor ||
    declaredParent.path !== revision.path ||
    declaredParent.tombstone ||
    declaredParent.deviceId === revision.authorDeviceId
  ) {
    return [...revision.parents]
  }

  const ownHistory = (await journal.listRetainedFileRevisions(revision.fileId)).filter(
    (candidate) => candidate.cursor !== null && candidate.cursor < repairCursor,
  )
  if (ownHistory.length === 0) return [...revision.parents]
  const ownHeads = revisionHeads(ownHistory)
  if (
    ownHeads.length === 0 ||
    ownHeads.some(
      (head) =>
        head.cursor === null ||
        head.cursor >= repairCursor ||
        head.path !== revision.path ||
        head.tombstone,
    )
  ) {
    return [...revision.parents]
  }
  return ownHeads.map((head) => head.revisionId)
}

async function allParentsBelongToFile(
  journal: JournalPort,
  revision: Pick<LocalRevision, "fileId" | "parents">,
  childCursor: number,
): Promise<boolean> {
  if (revision.parents.length === 0) return false
  const parents = await Promise.all(
    revision.parents.map((parentId) => journal.getRetainedRevision(parentId)),
  )
  return parents.every(
    (parent) =>
      parent !== null &&
      parent.fileId === revision.fileId &&
      parent.cursor !== null &&
      parent.cursor < childCursor,
  )
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
  operation: RemoteOperation | null
}

export function sameRevisionIdentity(left: RevisionIdentity, right: RevisionIdentity): boolean {
  return (
    left.revisionId === right.revisionId &&
    sameSignedFileRevision(left.operation, right.operation) &&
    left.fileId === right.fileId &&
    left.deviceId === right.deviceId &&
    left.tombstone === right.tombstone &&
    sameIds(left.parents, right.parents)
  )
}

export function sameRemoteLogEntry(
  left: RemoteOperation | null,
  right: RemoteOperation | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.cursor === right.cursor &&
    left.logHash === right.logHash
  )
}

function sameSignedFileRevision(
  left: RemoteOperation | null,
  right: RemoteOperation | null,
): boolean {
  if (!left || !right) return false
  const leftEnvelope = record(left.envelope)
  const rightEnvelope = record(right.envelope)
  if (!leftEnvelope || !rightEnvelope) return false
  const leftSignedEnvelope = stringField(leftEnvelope, "envelope")
  const rightSignedEnvelope = stringField(rightEnvelope, "envelope")
  if (leftSignedEnvelope === null || rightSignedEnvelope === null) {
    return JSON.stringify(left.envelope) === JSON.stringify(right.envelope)
  }
  return (
    leftSignedEnvelope === rightSignedEnvelope &&
    stringField(leftEnvelope, "authorDeviceId") === stringField(rightEnvelope, "authorDeviceId") &&
    stringField(leftEnvelope, "epochId") === stringField(rightEnvelope, "epochId") &&
    stringField(leftEnvelope, "type") === stringField(rightEnvelope, "type")
  )
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((value, index) => value === sortedRight[index])
}
