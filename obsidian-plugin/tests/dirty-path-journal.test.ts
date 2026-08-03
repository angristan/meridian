import { describe, expect, it } from "vitest"
import { MemoryJournal } from "../src/storage/memory-journal"

describe("durable dirty path journal", () => {
  it("coalesces repeated events to the newest path token", async () => {
    const journal = new MemoryJournal()

    await journal.putDirtyPath({ path: "note.md", token: "first", observedAt: 1 })
    await journal.putDirtyPath({ path: "note.md", token: "latest", observedAt: 2 })
    await journal.putDirtyPath({ path: "other.md", token: "other", observedAt: 3 })

    expect(await journal.listDirtyPaths()).toEqual([
      { path: "note.md", token: "latest", observedAt: 2 },
      { path: "other.md", token: "other", observedAt: 3 },
    ])
  })

  it("preserves plaintext while invalidating old-epoch prepared ciphertext", async () => {
    const journal = new MemoryJournal()
    const plaintext = new TextEncoder().encode("queued edit").buffer
    await journal.putEntry({
      id: "entry",
      action: "upsert",
      fileId: "file",
      path: "note.md",
      previousPath: null,
      fingerprint: "fingerprint",
      baseRevisionId: null,
      parentRevisionIds: [],
      restoreSourceRevisionId: null,
      revisionId: "revision",
      createdAt: 1,
      attempts: 1,
      state: "failed",
      error: "stale",
      preparedRevision: {
        action: "upsert",
        bytes: plaintext,
        encrypted: { blobs: [], envelope: { epochId: "old" } },
      },
    })

    await journal.invalidatePreparedRevisions()

    const [entry] = await journal.listPending()
    expect(entry).toMatchObject({
      state: "queued",
      error: null,
      preparedRevision: { invalidatedByEpoch: true, bytes: plaintext },
    })
  })

  it("does not consume an event replaced during reconciliation", async () => {
    const journal = new MemoryJournal()
    const observed = { path: "note.md", token: "observed", observedAt: 1 }
    await journal.putDirtyPath(observed)

    await journal.putDirtyPath({ path: "note.md", token: "new-edit", observedAt: 2 })
    await journal.consumeDirtyPaths([observed])

    expect(await journal.listDirtyPaths()).toEqual([
      { path: "note.md", token: "new-edit", observedAt: 2 },
    ])
  })
})
