import { describe, expect, it } from "vitest"
import type { LocalRevision } from "../src/model"
import { MemoryJournal } from "../src/storage/memory-journal"
import { assertRevisionAncestry } from "../src/sync/revision-ancestry"

describe("global revision ancestry", () => {
  it("accepts an older signed parent from another file identity", async () => {
    const journal = new MemoryJournal()
    await putHistory(
      journal,
      revision({
        revisionId: "parent",
        fileId: "parent-file",
        cursor: 1,
      }),
    )

    await expect(
      assertRevisionAncestry(
        journal,
        { revisionId: "child", fileId: "child-file", parents: ["parent"] },
        2,
      ),
    ).resolves.toBeUndefined()
  })

  it("rejects cycles that cross file identities", async () => {
    const journal = new MemoryJournal()
    await putHistory(
      journal,
      revision({
        revisionId: "first",
        fileId: "first-file",
        parents: ["second"],
        cursor: 1,
      }),
    )
    await putHistory(
      journal,
      revision({
        revisionId: "second",
        fileId: "second-file",
        parents: ["first"],
        cursor: 2,
      }),
    )

    await expect(
      assertRevisionAncestry(
        journal,
        { revisionId: "child", fileId: "third-file", parents: ["second"] },
        3,
      ),
    ).rejects.toThrow("Stored revision ancestry contains a cycle")
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
    deviceId: "device",
    createdAt: 1,
    cursor: 1,
    tombstone: false,
    isConflict: false,
    operation: null,
    ...overrides,
  }
}
