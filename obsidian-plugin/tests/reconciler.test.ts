import { describe, expect, it } from "vitest"
import { fingerprint, randomId } from "../src/platform/bytes"
import { MemoryJournal } from "../src/storage/journal"
import { Reconciler } from "../src/sync/reconciler"
import { ALL_CATEGORIES, FakeVault } from "./fakes"

describe("Reconciler", () => {
  it("queues initial content without storing plaintext in the journal", async () => {
    const vault = new FakeVault({ "note.md": "private text" })
    const journal = new MemoryJournal()
    const result = await new Reconciler(vault, journal).reconcile(ALL_CATEGORIES)

    expect(result).toEqual({ queued: 1, files: 1 })
    const pending = await journal.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ action: "upsert", path: "note.md" })
    expect(JSON.stringify(pending)).not.toContain("private text")
  })

  it("recovers a stable file identity from exact-path revision history", async () => {
    const identity = randomId()
    const vault = new FakeVault({ "note.md": "existing content" })
    const journal = new MemoryJournal()
    await journal.putRevision({
      revisionId: "existing-revision",
      fileId: identity,
      path: "note.md",
      parents: [],
      deviceId: "device",
      createdAt: 1,
      cursor: 1,
      tombstone: false,
      isConflict: false,
      operation: null,
    })

    await new Reconciler(vault, journal).reconcile(ALL_CATEGORIES)

    expect(await journal.listPending()).toEqual([
      expect.objectContaining({ path: "note.md", fileId: identity }),
    ])
  })

  it("recognizes a unique same-content move as a rename", async () => {
    const vault = new FakeVault({ "new/name.md": "same content" })
    const journal = new MemoryJournal()
    const bytes = new TextEncoder().encode("same content").buffer
    await journal.replaceSnapshots([
      {
        path: "old/name.md",
        fileId: randomId(),
        fingerprint: await fingerprint(bytes),
        size: bytes.byteLength,
        mtime: 1,
        kind: "vault",
      },
    ])

    await new Reconciler(vault, journal).reconcile(ALL_CATEGORIES)

    expect(await journal.listPending()).toEqual([
      expect.objectContaining({
        action: "upsert",
        path: "new/name.md",
        previousPath: "old/name.md",
      }),
    ])
  })

  it("queues tombstones for disappeared files", async () => {
    const journal = new MemoryJournal()
    await journal.replaceSnapshots([
      {
        path: "gone.pdf",
        fileId: randomId(),
        fingerprint: "fingerprint",
        size: 42,
        mtime: 1,
        kind: "vault",
      },
    ])

    await new Reconciler(new FakeVault(), journal).reconcile(ALL_CATEGORIES)

    expect(await journal.listPending()).toEqual([
      expect.objectContaining({ action: "delete", path: "gone.pdf" }),
    ])
  })
})
