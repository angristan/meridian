import {
  CIPHER_SUITE,
  deviceId,
  epochId,
  fileId,
  nonce,
  operationId,
  type RevisionOperation as ProtocolRevisionOperation,
  type RevisionMetadata,
  revisionId,
  vaultId,
  wrappedRevisionKey,
} from "@meridian/protocol"
import { describe, expect, it } from "vitest"
import { ContentKind, fromProtocolRevisionOperation } from "../src/index"

function bytes(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill)
}

function protocolOperation(): ProtocolRevisionOperation {
  return {
    type: "revision",
    operationId: operationId(bytes(16, 1)),
    vaultId: vaultId(bytes(16, 2)),
    epochId: epochId(bytes(16, 3)),
    authorDeviceId: deviceId(bytes(16, 4)),
    fileId: fileId(bytes(16, 5)),
    revisionId: revisionId(bytes(16, 6)),
    wrappedRevisionKey: wrappedRevisionKey(bytes(40, 7)),
    metadataNonce: nonce(bytes(12, 8)),
    encryptedMetadata: bytes(1, 9),
    chunks: [],
    suite: CIPHER_SUITE,
  }
}

describe("protocol adapter", () => {
  it("maps authenticated protocol metadata into the runtime model", () => {
    const metadata: RevisionMetadata = {
      normalizedPath: "settings.json",
      parents: [revisionId(bytes(16, 10))],
      tombstone: false,
      contentType: "utf8-text",
      totalPlaintextLength: 2,
      createdAt: 0,
    }
    const adapted = fromProtocolRevisionOperation(
      protocolOperation(),
      metadata,
      new TextEncoder().encode("{}"),
      { configuration: true },
    )

    expect(adapted.operationId).toBe("01".repeat(16))
    expect(adapted.revision.id).toBe("06".repeat(16))
    expect(adapted.revision.parents).toEqual(["0a".repeat(16)])
    expect(adapted.revision.type).toBe("content")
    if (adapted.revision.type === "content") {
      expect(adapted.revision.contentKind).toBe(ContentKind.Config)
    }
  })

  it("rejects plaintext attached to tombstones", () => {
    const metadata: RevisionMetadata = {
      normalizedPath: "deleted.md",
      parents: [],
      tombstone: true,
      contentType: "utf8-text",
      totalPlaintextLength: 0,
      createdAt: 0,
    }
    expect(() =>
      fromProtocolRevisionOperation(protocolOperation(), metadata, new Uint8Array([1])),
    ).toThrow(/empty/)
  })
})
