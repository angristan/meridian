import { ContentKind, type ContentRevision, compareIds, type FileId } from "./model"
import type { RevisionGraph } from "./revision-graph"
import { mergeUtf8Text } from "./text-merge"

export const MaterializationKind = {
  Normal: "normal",
  TextConflict: "text-conflict",
  BinaryConflict: "binary-conflict",
  ConfigConflict: "config-conflict",
  Recovered: "recovered",
  RenameConflict: "rename-conflict",
  PathConflict: "path-conflict",
} as const

export type MaterializationKind = (typeof MaterializationKind)[keyof typeof MaterializationKind]

export interface MaterializedEntry {
  readonly fileId: FileId
  readonly path: string
  readonly content: Uint8Array
  readonly kind: MaterializationKind
  /** Heads whose user data contributed to this entry. */
  readonly sourceRevisionIds: readonly string[]
}

function splitExtension(path: string): readonly [string, string] {
  const slash = path.lastIndexOf("/")
  const dot = path.lastIndexOf(".")
  return dot > slash ? [path.slice(0, dot), path.slice(dot)] : [path, ""]
}

function safeIdentifier(identifier: string): string {
  if (/^[a-zA-Z0-9_-]+$/.test(identifier)) return identifier
  let encoded = ""
  for (const byte of new TextEncoder().encode(identifier)) {
    encoded += byte.toString(16).padStart(2, "0")
  }
  return encoded
}

function conflictPath(path: string, label: string, revisionId: string): string {
  const [stem, extension] = splitExtension(path)
  return `${stem}.meridian-${label}-${safeIdentifier(revisionId)}${extension}`
}

function configConflictPath(path: string, revisionId: string): string {
  return `.meridian/conflicts/config/${safeIdentifier(revisionId)}/${path}`
}

function canonicalPath(
  left: ContentRevision,
  right: ContentRevision,
  basePath: string | undefined,
): string {
  if (left.path === right.path) return left.path
  if (basePath !== undefined) {
    if (left.path === basePath) return right.path
    if (right.path === basePath) return left.path
  }
  return compareIds(left.path, right.path) <= 0 ? left.path : right.path
}

function entry(
  revision: ContentRevision,
  kind: MaterializationKind,
  path = revision.path,
): MaterializedEntry {
  return {
    fileId: revision.fileId,
    path,
    content: new Uint8Array(revision.content),
    kind,
    sourceRevisionIds: [revision.id],
  }
}

function preserveBranches(
  branches: readonly ContentRevision[],
  path: string,
  kind: MaterializationKind,
): readonly MaterializedEntry[] {
  return branches.map((branch, index) => {
    if (kind === MaterializationKind.ConfigConflict) {
      return entry(branch, kind, configConflictPath(branch.path, branch.id))
    }
    return entry(
      branch,
      kind,
      index === 0 ? path : conflictPath(branch.path, kind.replace("-conflict", ""), branch.id),
    )
  })
}

export function materializeFile(
  graph: RevisionGraph,
  fileId: FileId,
): readonly MaterializedEntry[] {
  const heads = graph.heads(fileId)
  if (heads.length === 0 || heads.every((head) => head.type === "tombstone")) return []

  const active = heads.filter((head): head is ContentRevision => head.type === "content")
  const hasDeletion = active.length !== heads.length
  if (hasDeletion) {
    return active.map((revision) =>
      entry(
        revision,
        MaterializationKind.Recovered,
        conflictPath(revision.path, "recovered", revision.id),
      ),
    )
  }

  const onlyActive = active[0]
  if (active.length === 1 && onlyActive !== undefined) {
    return [entry(onlyActive, MaterializationKind.Normal)]
  }
  const sorted = [...active].sort((left, right) => compareIds(left.id, right.id))
  if (sorted.length !== 2) {
    const kind = sorted.some((revision) => revision.contentKind === ContentKind.Config)
      ? MaterializationKind.ConfigConflict
      : sorted.every((revision) => revision.contentKind === ContentKind.Text)
        ? MaterializationKind.TextConflict
        : MaterializationKind.BinaryConflict
    const first = sorted[0]
    return first === undefined ? [] : preserveBranches(sorted, first.path, kind)
  }

  const [left, right] = sorted as [ContentRevision, ContentRevision]
  const base = graph.commonAncestor(left.id, right.id)
  const path = canonicalPath(left, right, base?.path)
  if (
    left.contentKind !== ContentKind.Text ||
    right.contentKind !== ContentKind.Text ||
    base?.type !== "content" ||
    base.contentKind !== ContentKind.Text
  ) {
    const kind =
      left.contentKind === ContentKind.Config || right.contentKind === ContentKind.Config
        ? MaterializationKind.ConfigConflict
        : MaterializationKind.BinaryConflict
    return preserveBranches(sorted, path, kind)
  }

  const merged = mergeUtf8Text(base.content, left.content, right.content)
  if (merged.status === "conflict") {
    return preserveBranches(sorted, path, MaterializationKind.TextConflict)
  }

  const sources = sorted.map((revision) => revision.id)
  const result: MaterializedEntry[] = [
    {
      fileId,
      path,
      content: merged.content,
      kind: MaterializationKind.Normal,
      sourceRevisionIds: sources,
    },
  ]
  const alternativePaths = [...new Set(sorted.map((revision) => revision.path))]
    .filter((candidate) => candidate !== path)
    .sort(compareIds)
  for (const alternativePath of alternativePaths) {
    result.push({
      fileId,
      path: conflictPath(alternativePath, "rename", sources.join("-")),
      content: new Uint8Array(merged.content),
      kind: MaterializationKind.RenameConflict,
      sourceRevisionIds: sources,
    })
  }
  return result
}

export interface MaterializeOptions {
  readonly caseSensitive?: boolean
}

/** Resolves cross-file Unicode/case collisions without dropping either file. */
export function materializeVault(
  graph: RevisionGraph,
  options: MaterializeOptions = {},
): readonly MaterializedEntry[] {
  const caseSensitive = options.caseSensitive ?? true
  const collisionKey = (path: string) =>
    caseSensitive ? path.normalize("NFC") : path.toLocaleLowerCase("en-US").normalize("NFC")
  const output: MaterializedEntry[] = []
  const occupied = new Set<string>()
  for (const fileId of graph.fileIds()) {
    for (const candidate of materializeFile(graph, fileId)) {
      const candidateKey = collisionKey(candidate.path)
      if (!occupied.has(candidateKey)) {
        occupied.add(candidateKey)
        output.push(candidate)
        continue
      }
      const baseConflictPath = conflictPath(candidate.path, "path", candidate.fileId)
      let path = baseConflictPath
      let sequence = 2
      while (occupied.has(collisionKey(path))) {
        path = conflictPath(baseConflictPath, "collision", String(sequence))
        sequence += 1
      }
      occupied.add(collisionKey(path))
      output.push({ ...candidate, path, kind: MaterializationKind.PathConflict })
    }
  }
  return output.sort(
    (left, right) => compareIds(left.path, right.path) || compareIds(left.fileId, right.fileId),
  )
}
