export type FileId = string
export type RevisionId = string
export type OperationId = string
export type DeviceId = string

export const ContentKind = {
  Text: "text",
  Binary: "binary",
  Config: "config",
} as const

export type ContentKind = (typeof ContentKind)[keyof typeof ContentKind]

export interface ContentRevision {
  readonly type: "content"
  readonly id: RevisionId
  readonly fileId: FileId
  readonly parents: readonly RevisionId[]
  readonly path: string
  readonly contentKind: ContentKind
  readonly content: Uint8Array
  readonly author: DeviceId
}

export interface TombstoneRevision {
  readonly type: "tombstone"
  readonly id: RevisionId
  readonly fileId: FileId
  readonly parents: readonly RevisionId[]
  /** Last known path. It is metadata for history, not a live filesystem entry. */
  readonly path: string
  readonly author: DeviceId
}

export type Revision = ContentRevision | TombstoneRevision

export interface RevisionOperation {
  readonly operationId: OperationId
  readonly revision: Revision
}

export interface CursorOperation extends RevisionOperation {
  readonly cursor: number
}

export function normalizeVaultPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").normalize("NFC")
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("//")
  ) {
    throw new TypeError(`Invalid vault-relative path: ${path}`)
  }

  for (const segment of normalized.split("/")) {
    if (segment === "." || segment === ".." || segment.includes("\0")) {
      throw new TypeError(`Invalid vault-relative path: ${path}`)
    }
  }
  return normalized
}

export function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export function copyRevision(revision: Revision): Revision {
  const common = {
    id: revision.id,
    fileId: revision.fileId,
    parents: [...revision.parents],
    path: normalizeVaultPath(revision.path),
    author: revision.author,
  }
  if (revision.type === "tombstone") return { ...common, type: "tombstone" }
  return {
    ...common,
    type: "content",
    contentKind: revision.contentKind,
    content: new Uint8Array(revision.content),
  }
}

export function revisionsEqual(left: Revision, right: Revision): boolean {
  if (
    left.type !== right.type ||
    left.id !== right.id ||
    left.fileId !== right.fileId ||
    left.path !== right.path ||
    left.author !== right.author ||
    left.parents.length !== right.parents.length ||
    left.parents.some((parent, index) => parent !== right.parents[index])
  ) {
    return false
  }
  if (left.type === "tombstone" || right.type === "tombstone") return true
  return left.contentKind === right.contentKind && bytesEqual(left.content, right.content)
}

export function operationEqual(left: RevisionOperation, right: RevisionOperation): boolean {
  return left.operationId === right.operationId && revisionsEqual(left.revision, right.revision)
}
