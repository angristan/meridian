import {
  bytesToHex,
  type RevisionOperation as ProtocolRevisionOperation,
  type RevisionMetadata,
} from "@meridian/protocol"
import { ContentKind, type RevisionOperation } from "./model"

export interface ProtocolRevisionOptions {
  /** Configuration files never auto-merge, even when their wire content type is UTF-8. */
  readonly configuration?: boolean
}

/** Adapts a verified operation plus its authenticated, decrypted metadata and content. */
export function fromProtocolRevisionOperation(
  operation: ProtocolRevisionOperation,
  metadata: RevisionMetadata,
  content: Uint8Array,
  options: ProtocolRevisionOptions = {},
): RevisionOperation {
  const common = {
    id: bytesToHex(operation.revisionId),
    fileId: bytesToHex(operation.fileId),
    parents: metadata.parents.map(bytesToHex).sort(),
    path: metadata.normalizedPath,
    author: bytesToHex(operation.authorDeviceId),
  }
  if (metadata.tombstone) {
    if (content.byteLength !== 0) throw new TypeError("Tombstone plaintext must be empty")
    return {
      operationId: bytesToHex(operation.operationId),
      revision: { ...common, type: "tombstone" },
    }
  }
  return {
    operationId: bytesToHex(operation.operationId),
    revision: {
      ...common,
      type: "content",
      contentKind: options.configuration
        ? ContentKind.Config
        : metadata.contentType === "utf8-text"
          ? ContentKind.Text
          : ContentKind.Binary,
      content: new Uint8Array(content),
    },
  }
}

/**
 * Narrow boundary for the encrypted protocol package. The protocol package did not yet expose
 * decoded revision envelopes when this package was built. IDs should be converted to canonical
 * strings (normally lowercase hex) before crossing this boundary.
 */
export interface DecodedRevisionOperation {
  readonly operationId: string
  readonly revision: {
    readonly type: "content" | "tombstone"
    readonly id: string
    readonly fileId: string
    readonly parents: readonly string[]
    readonly path: string
    readonly author: string
    readonly contentKind?: "text" | "binary" | "config"
    readonly content?: Uint8Array
  }
}

export function fromDecodedRevisionOperation(input: DecodedRevisionOperation): RevisionOperation {
  const common = {
    id: input.revision.id,
    fileId: input.revision.fileId,
    parents: [...input.revision.parents].sort(),
    path: input.revision.path,
    author: input.revision.author,
  }
  if (input.revision.type === "tombstone") {
    return { operationId: input.operationId, revision: { ...common, type: "tombstone" } }
  }
  if (input.revision.content === undefined || input.revision.contentKind === undefined) {
    throw new TypeError("Content revision is missing decrypted content or its kind")
  }
  if (!Object.values(ContentKind).includes(input.revision.contentKind)) {
    throw new TypeError(`Unknown content kind ${input.revision.contentKind}`)
  }
  return {
    operationId: input.operationId,
    revision: {
      ...common,
      type: "content",
      contentKind: input.revision.contentKind,
      content: new Uint8Array(input.revision.content),
    },
  }
}
