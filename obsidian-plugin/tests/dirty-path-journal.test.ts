import { describe, expect, it } from "vitest"
import { MemoryJournal } from "../src/storage/journal"

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
