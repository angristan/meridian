import { describe, expect, it } from "vitest"
import type { ConfigCategory, ScannedFileSnapshot, SelectiveSyncSettings } from "../src/model"
import { fingerprint, randomId } from "../src/platform/bytes"
import type { ReconciliationCommit } from "../src/storage/contracts"
import { MemoryJournal } from "../src/storage/memory-journal"
import { FINGERPRINT_AUDIT_INTERVAL_MS, Reconciler } from "../src/sync/reconciler"
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

  it("reuses fingerprints when size and modification time match", async () => {
    const bytes = new TextEncoder().encode("unchanged").buffer
    const vault = new FakeVault({ "note.md": "unchanged" })
    const journal = new MemoryJournal()
    await journal.replaceSnapshots([
      {
        path: "note.md",
        fileId: randomId(),
        fingerprint: await fingerprint(bytes),
        size: bytes.byteLength,
        mtime: 1,
        kind: "vault",
      },
    ])

    const result = await new Reconciler(vault, journal, undefined, () => 100).reconcile(
      ALL_CATEGORIES,
    )

    expect(result).toEqual({ queued: 0, files: 1 })
    expect(vault.fingerprintedPaths).toEqual([])
    expect(await journal.getLastFingerprintAuditAt()).toBe(100)
  })

  it("performs a full fingerprint audit after one day", async () => {
    const original = new TextEncoder().encode("old").buffer
    const vault = new FakeVault({ "note.md": "old" })
    const journal = new MemoryJournal()
    await journal.replaceSnapshots([
      {
        path: "note.md",
        fileId: randomId(),
        fingerprint: await fingerprint(original),
        size: original.byteLength,
        mtime: 1,
        kind: "vault",
      },
    ])
    let now = 100
    const reconciler = new Reconciler(vault, journal, undefined, () => now)
    await reconciler.reconcile(ALL_CATEGORIES)
    vault.files.set("note.md", new TextEncoder().encode("new").buffer)

    now += FINGERPRINT_AUDIT_INTERVAL_MS - 1
    await expect(reconciler.reconcile(ALL_CATEGORIES)).resolves.toEqual({ queued: 0, files: 1 })
    expect(vault.fingerprintedPaths).toEqual([])

    now += 1
    await expect(reconciler.reconcile(ALL_CATEGORIES)).resolves.toEqual({ queued: 1, files: 1 })
    expect(vault.fingerprintedPaths).toEqual(["note.md"])
    expect(await journal.getLastFingerprintAuditAt()).toBe(now)
  })

  it("uses the initial pending index instead of rescanning the journal per file", async () => {
    class IndexedPendingJournal extends MemoryJournal {
      override hasPendingPath(): Promise<boolean> {
        throw new Error("Reconciliation should not rescan all journal entries")
      }
    }

    const vault = new FakeVault({ "note.md": "pending content" })
    const journal = new IndexedPendingJournal()
    const fileId = randomId()
    await journal.putEntry({
      id: randomId(),
      action: "upsert",
      fileId,
      path: "note.md",
      previousPath: null,
      fingerprint: "pending-fingerprint",
      baseRevisionId: null,
      parentRevisionIds: [],
      restoreSourceRevisionId: null,
      revisionId: randomId(),
      createdAt: 1,
      attempts: 0,
      state: "queued",
      error: null,
      preparedRevision: null,
    })

    const result = await new Reconciler(vault, journal).reconcile(ALL_CATEGORIES)

    expect(result).toEqual({ queued: 0, files: 1 })
    expect(await journal.listPending()).toEqual([
      expect.objectContaining({ fileId, path: "note.md" }),
    ])
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
    const files = { "Notes/Example.md": "one", "notes/example.md": "two" }
    const vault = new FakeVault(files)
    const journal = new MemoryJournal()
    await journal.replaceSnapshots(
      await Promise.all(
        Object.entries(files).map(async ([path, content]) => ({
          path,
          fileId: randomId(),
          fingerprint: await fingerprint(new TextEncoder().encode(content).buffer),
          size: content.length,
          mtime: 1,
          kind: "vault" as const,
        })),
      ),
    )

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

  it("never tombstones files hidden by local selective sync", async () => {
    const identity = randomId()
    const bytes = new TextEncoder().encode("private content").buffer
    const vault = new FakeVault({ "Archive/private/note.md": "private content" })
    const journal = new MemoryJournal()
    await journal.replaceSnapshots([
      {
        path: "Archive/private/note.md",
        fileId: identity,
        fingerprint: await fingerprint(bytes),
        size: bytes.byteLength,
        mtime: 1,
        kind: "vault",
      },
    ])
    const excluded = {
      excludedFolders: ["Archive/private"],
      excludedExtensions: [] as string[],
    }

    await new Reconciler(vault, journal).reconcile(ALL_CATEGORIES, excluded)
    vault.files.delete("Archive/private/note.md")
    await new Reconciler(vault, journal).reconcile(ALL_CATEGORIES, excluded)

    expect(await journal.listPending()).toEqual([])
    expect((await journal.getSnapshots()).get("Archive/private/note.md")?.fileId).toBe(identity)

    await new Reconciler(vault, journal).reconcile(ALL_CATEGORIES)
    expect(await journal.listPending()).toEqual([
      expect.objectContaining({
        action: "delete",
        path: "Archive/private/note.md",
        fileId: identity,
      }),
    ])
  })

  it("reconciles only durable dirty paths during routine sync", async () => {
    class IncrementalOnlyVault extends FakeVault {
      readonly scannedPaths: string[][] = []

      override listFiles(): Promise<ScannedFileSnapshot[]> {
        throw new Error("Incremental reconciliation must not scan the full vault")
      }

      override scanFiles(
        paths: readonly string[],
        categories: Record<ConfigCategory, boolean>,
        selection?: SelectiveSyncSettings,
      ): Promise<ScannedFileSnapshot[]> {
        this.scannedPaths.push([...paths])
        return super.scanFiles(paths, categories, selection)
      }
    }

    const oldBytes = new TextEncoder().encode("old").buffer
    const vault = new IncrementalOnlyVault({ "changed.md": "new", "untouched.md": "same" })
    const journal = new MemoryJournal()
    await journal.replaceSnapshots([
      {
        path: "changed.md",
        fileId: "changed-id",
        fingerprint: await fingerprint(oldBytes),
        size: oldBytes.byteLength,
        mtime: 1,
        kind: "vault",
      },
      {
        path: "untouched.md",
        fileId: "untouched-id",
        fingerprint: await fingerprint(new TextEncoder().encode("same").buffer),
        size: 4,
        mtime: 1,
        kind: "vault",
      },
    ])
    await journal.putDirtyPath({ path: "changed.md", token: "event", observedAt: 1 })

    const result = await new Reconciler(vault, journal).reconcileDirty(ALL_CATEGORIES)

    expect(result).toEqual({ queued: 1, files: 1 })
    expect(vault.scannedPaths).toEqual([["changed.md"]])
    expect(await journal.listPending()).toEqual([
      expect.objectContaining({ action: "upsert", path: "changed.md", fileId: "changed-id" }),
    ])
    expect(await journal.listDirtyPaths()).toEqual([])
    expect((await journal.getSnapshots()).get("untouched.md")?.fileId).toBe("untouched-id")
  })

  it("preserves stable identity for an incrementally observed rename", async () => {
    const bytes = new TextEncoder().encode("same content").buffer
    const vault = new FakeVault({ "new/name.md": "same content" })
    const journal = new MemoryJournal()
    await journal.replaceSnapshots([
      {
        path: "old/name.md",
        fileId: "stable-id",
        fingerprint: await fingerprint(bytes),
        size: bytes.byteLength,
        mtime: 1,
        kind: "vault",
      },
    ])
    await journal.putDirtyPath({ path: "old/name.md", token: "old", observedAt: 1 })
    await journal.putDirtyPath({ path: "new/name.md", token: "new", observedAt: 2 })

    await new Reconciler(vault, journal).reconcileDirty(ALL_CATEGORIES)

    expect(await journal.listPending()).toEqual([
      expect.objectContaining({
        action: "upsert",
        path: "new/name.md",
        previousPath: "old/name.md",
        fileId: "stable-id",
      }),
    ])
    const snapshots = await journal.getSnapshots()
    expect(snapshots.has("old/name.md")).toBe(false)
    expect(snapshots.get("new/name.md")?.fileId).toBe("stable-id")
  })

  it("does not tombstone an incrementally observed excluded path", async () => {
    const bytes = new TextEncoder().encode("private").buffer
    const vault = new FakeVault()
    const journal = new MemoryJournal()
    await journal.replaceSnapshots([
      {
        path: "Archive/private.md",
        fileId: "private-id",
        fingerprint: await fingerprint(bytes),
        size: bytes.byteLength,
        mtime: 1,
        kind: "vault",
      },
    ])
    await journal.putDirtyPath({ path: "Archive/private.md", token: "deleted", observedAt: 1 })

    await new Reconciler(vault, journal).reconcileDirty(ALL_CATEGORIES, {
      excludedFolders: ["Archive"],
      excludedExtensions: [],
    })

    expect(await journal.listPending()).toEqual([])
    expect((await journal.getSnapshots()).get("Archive/private.md")?.fileId).toBe("private-id")
    expect(await journal.listDirtyPaths()).toEqual([])
  })

  it("retains dirty paths until an existing pending revision commits", async () => {
    const original = new TextEncoder().encode("original").buffer
    const vault = new FakeVault({ "note.md": "newer edit" })
    const journal = new MemoryJournal()
    await journal.replaceSnapshots([
      {
        path: "note.md",
        fileId: "stable-id",
        fingerprint: await fingerprint(original),
        size: original.byteLength,
        mtime: 1,
        kind: "vault",
      },
    ])
    await journal.putEntry({
      id: "pending",
      action: "upsert",
      fileId: "stable-id",
      path: "note.md",
      previousPath: null,
      fingerprint: "older-fingerprint",
      baseRevisionId: null,
      parentRevisionIds: [],
      restoreSourceRevisionId: null,
      revisionId: "pending-revision",
      createdAt: 1,
      attempts: 0,
      state: "uploading",
      error: null,
      preparedRevision: {
        action: "upsert",
        bytes: original,
        encrypted: { blobs: [], envelope: { prepared: true } },
      },
    })
    await journal.putDirtyPath({ path: "note.md", token: "newer-edit", observedAt: 2 })

    const result = await new Reconciler(vault, journal).reconcileDirty(ALL_CATEGORIES)

    expect(result).toEqual({ queued: 0, files: 1 })
    expect(await journal.listDirtyPaths()).toEqual([
      { path: "note.md", token: "newer-edit", observedAt: 2 },
    ])
  })

  it("retains a newer event that arrives while reconciliation commits", async () => {
    class RacingJournal extends MemoryJournal {
      override async commitReconciliation(commit: ReconciliationCommit): Promise<void> {
        await this.putDirtyPath({ path: "note.md", token: "newer", observedAt: 2 })
        await super.commitReconciliation(commit)
      }
    }

    const vault = new FakeVault({ "note.md": "content" })
    const journal = new RacingJournal()
    await journal.putDirtyPath({ path: "note.md", token: "observed", observedAt: 1 })

    await new Reconciler(vault, journal).reconcileDirty(ALL_CATEGORIES)

    expect(await journal.listDirtyPaths()).toEqual([
      { path: "note.md", token: "newer", observedAt: 2 },
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
