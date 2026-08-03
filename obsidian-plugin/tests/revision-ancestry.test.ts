import { describe, expect, it } from "vitest"
import type { LocalRevision, RemoteOperation } from "../src/model"
import { MemoryJournal } from "../src/storage/memory-journal"
import { repairLegacyTombstoneParents } from "../src/sync/revision-ancestry"

const AUTHOR = "author-device"
const SIGNED_DELETE = "same-signed-delete"

describe("legacy revision ancestry repair", () => {
  it("rebuilds retry parents against the earliest signed occurrence", async () => {
    const journal = new MemoryJournal()
    await journal.prepareHistoryBackfill(1)
    await putHistory(
      journal,
      revision({
        revisionId: "foreign-parent",
        fileId: "foreign-file",
        path: "note.md",
        deviceId: "other-device",
        cursor: 1,
      }),
    )
    await putHistory(
      journal,
      revision({
        revisionId: "own-root",
        fileId: "own-file",
        path: "note.md",
        cursor: 2,
      }),
    )
    await putHistory(
      journal,
      revision({
        revisionId: "legacy-delete",
        fileId: "own-file",
        path: "note.md",
        parents: ["future-parent"],
        cursor: 4,
        tombstone: true,
        operation: signedDelete(4, "first-wrapper"),
      }),
    )
    await putHistory(
      journal,
      revision({
        revisionId: "future-parent",
        fileId: "own-file",
        path: "note.md",
        parents: ["own-root"],
        cursor: 6,
      }),
    )

    await expect(
      repairLegacyTombstoneParents(
        journal,
        {
          revisionId: "legacy-delete",
          action: "delete",
          fileId: "own-file",
          path: "note.md",
          parents: ["foreign-parent"],
          authorDeviceId: AUTHOR,
        },
        signedDelete(10, "retry-wrapper"),
        "legacy-http-v1",
      ),
    ).resolves.toEqual(["own-root"])
  })
})

async function putHistory(journal: MemoryJournal, value: LocalRevision): Promise<void> {
  const cursor = value.cursor ?? 0
  await journal.commitHistoryOperation(value, { cursor, logHash: `hash-${cursor}` })
}

function revision(overrides: Partial<LocalRevision>): LocalRevision {
  return {
    revisionId: "revision",
    fileId: "file",
    path: "note.md",
    parents: [],
    deviceId: AUTHOR,
    createdAt: 1,
    cursor: 1,
    tombstone: false,
    isConflict: false,
    operation: null,
    ...overrides,
  }
}

function signedDelete(cursor: number, operationId: string): RemoteOperation {
  return {
    cursor,
    logHash: `hash-${cursor}`,
    envelope: {
      operationId,
      authorDeviceId: AUTHOR,
      epochId: "epoch-id",
      type: "tombstone",
      envelope: SIGNED_DELETE,
      signature: "wrapper-signature",
    },
  }
}
