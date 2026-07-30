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

  it("parents local changes from every concurrent revision head", async () => {
    const identity = randomId()
    const baseBytes = new TextEncoder().encode("base").buffer
    const vault = new FakeVault({ "note.md": "local edit" })
    const journal = new MemoryJournal()
    await journal.replaceSnapshots([
      {
        path: "note.md",
        fileId: identity,
        fingerprint: await fingerprint(baseBytes),
        size: baseBytes.byteLength,
        mtime: 1,
        kind: "vault",
      },
    ])
    await journal.putRevision({
      revisionId: "base-revision",
      fileId: identity,
      path: "note.md",
      parents: [],
      deviceId: "device-a",
      createdAt: 1,
      cursor: 1,
      tombstone: false,
      isConflict: false,
      operation: null,
    })
    await journal.putRevision({
      revisionId: "head-b",
      fileId: identity,
      path: "note.md",
      parents: ["base-revision"],
      deviceId: "device-b",
      createdAt: 100,
      cursor: 2,
      tombstone: false,
      isConflict: false,
      operation: null,
    })
    await journal.putRevision({
      revisionId: "head-a",
      fileId: identity,
      path: "note.md",
      parents: ["base-revision"],
      deviceId: "device-a",
      createdAt: 2,
      cursor: 3,
      tombstone: false,
      isConflict: false,
      operation: null,
    })

    await new Reconciler(vault, journal).reconcile(ALL_CATEGORIES)

    expect(await journal.listPending()).toEqual([
      expect.objectContaining({
        path: "note.md",
        baseRevisionId: null,
        parentRevisionIds: ["head-a", "head-b"],
      }),
    ])
  })

  it("rejects case-insensitive path collisions before queuing changes", async () => {
    const vault = new FakeVault({ "Notes/Example.md": "one", "notes/example.md": "two" })
    const journal = new MemoryJournal()

    await expect(new Reconciler(vault, journal).reconcile(ALL_CATEGORIES)).rejects.toThrow(
      /Case or Unicode path collision/,
    )
    expect(await journal.listPending()).toEqual([])
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

  it("does not tombstone config files hidden by local category settings", async () => {
    const identity = randomId()
    const bytes = new TextEncoder().encode("settings").buffer
    const vault = new FakeVault({ ".config/app.json": "settings" })
    const journal = new MemoryJournal()
    await journal.replaceSnapshots([
      {
        path: ".config/app.json",
        fileId: identity,
        fingerprint: await fingerprint(bytes),
        size: bytes.byteLength,
        mtime: 1,
        kind: "config",
      },
    ])
    const disabled = { ...ALL_CATEGORIES, main: false }

    await new Reconciler(vault, journal).reconcile(disabled)
    vault.files.delete(".config/app.json")
    await new Reconciler(vault, journal).reconcile(disabled)

    expect(await journal.listPending()).toEqual([])
    expect((await journal.getSnapshots()).get(".config/app.json")?.fileId).toBe(identity)

    await new Reconciler(vault, journal).reconcile(ALL_CATEGORIES)
    expect(await journal.listPending()).toEqual([
      expect.objectContaining({ action: "delete", path: ".config/app.json", fileId: identity }),
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
