import { describe, expect, it } from "vitest"
import type { ConflictRecord, LocalRevision } from "../src/model"
import { fingerprint } from "../src/platform/bytes"
import { MemoryJournal } from "../src/storage/memory-journal"
import { ConflictService } from "../src/sync/conflict-service"
import { FakeVault } from "./fakes"

const SOURCE_PATH = "note.md"
const COPY_PATH = "note.conflict.md"

function revision(
  overrides: Partial<LocalRevision> & Pick<LocalRevision, "revisionId">,
): LocalRevision {
  return {
    fileId: "file-id",
    path: SOURCE_PATH,
    action: "upsert",
    previousPath: null,
    parents: [],
    deviceId: "remote-device",
    createdAt: 1,
    cursor: 1,
    tombstone: false,
    isConflict: false,
    operation: null,
    ...overrides,
  }
}

function conflict(overrides: Partial<ConflictRecord> = {}): ConflictRecord {
  return {
    id: "conflict-id",
    sourcePath: SOURCE_PATH,
    conflictPath: COPY_PATH,
    localRevisionId: "base",
    remoteRevisionId: "remote",
    createdAt: 3,
    kind: "text",
    resolvedAt: null,
    ...overrides,
  }
}

async function setup(remote: LocalRevision, source: string | null, copy: string) {
  const vault = new FakeVault({
    ...(source === null ? {} : { [SOURCE_PATH]: source }),
    [COPY_PATH]: copy,
  })
  const journal = new MemoryJournal()
  await journal.putRevision(revision({ revisionId: "base" }))
  await journal.putRevision(remote)
  await journal.putConflict(conflict())
  if (source !== null) {
    const sourceBytes = new TextEncoder().encode(source).buffer
    await journal.putSnapshot({
      path: SOURCE_PATH,
      fileId: "file-id",
      fingerprint: await fingerprint(sourceBytes),
      size: sourceBytes.byteLength,
      mtime: 1,
      kind: "vault",
    })
  }
  const copyBytes = new TextEncoder().encode(copy).buffer
  await journal.putSnapshot({
    path: COPY_PATH,
    fileId: "copy-file-id",
    fingerprint: await fingerprint(copyBytes),
    size: copyBytes.byteLength,
    mtime: 1,
    kind: "vault",
  })
  return { vault, journal, service: new ConflictService(vault, journal) }
}

describe("ConflictService", () => {
  it("automatically resolves preserved content that exactly matches the current file", async () => {
    const remote = revision({ revisionId: "remote", parents: ["base"], createdAt: 2, cursor: 2 })
    const { vault, journal, service } = await setup(remote, "same content", "same content")

    await expect(service.resolveEquivalent()).resolves.toBe(1)
    await expect(service.resolveEquivalent()).resolves.toBe(0)

    expect(vault.text(SOURCE_PATH)).toBe("same content")
    expect(vault.text(COPY_PATH)).toBeNull()
    expect(await journal.listConflicts(true)).toEqual([])
    await expect(journal.getRevision("remote")).resolves.toEqual(remote)
  })

  it("keeps an equivalent conflict when its preserved copy changes during cleanup", async () => {
    class RacingVault extends FakeVault {
      override async replaceIfUnchanged(
        path: string,
        expectedBytes: ArrayBuffer | null,
        replacementBytes: ArrayBuffer | null,
        isText: boolean,
      ): Promise<boolean> {
        if (path === COPY_PATH) {
          await this.write(path, new TextEncoder().encode("edited during cleanup").buffer)
        }
        return super.replaceIfUnchanged(path, expectedBytes, replacementBytes, isText)
      }
    }
    const remote = revision({ revisionId: "remote", parents: ["base"] })
    const vault = new RacingVault({ [SOURCE_PATH]: "same", [COPY_PATH]: "same" })
    const journal = new MemoryJournal()
    await journal.putRevision(revision({ revisionId: "base" }))
    await journal.putRevision(remote)
    await journal.putConflict(conflict())
    const service = new ConflictService(vault, journal)

    await expect(service.resolveEquivalent()).resolves.toBe(0)

    expect(vault.text(COPY_PATH)).toBe("edited during cleanup")
    expect(await journal.listConflicts(true)).toHaveLength(1)
  })

  it("previews both text versions and queues incoming content after local work", async () => {
    const remote = revision({ revisionId: "remote", parents: ["base"], createdAt: 2, cursor: 2 })
    const { vault, journal, service } = await setup(remote, "local\ntext", "incoming\ntext")
    await journal.putEntry({
      id: "local-entry",
      action: "upsert",
      fileId: "file-id",
      path: SOURCE_PATH,
      previousPath: null,
      fingerprint: "local-fingerprint",
      baseRevisionId: "base",
      parentRevisionIds: ["base"],
      restoreSourceRevisionId: null,
      revisionId: "local-pending",
      createdAt: 3,
      attempts: 0,
      state: "queued",
      error: null,
      preparedRevision: null,
    })

    await expect(service.details("conflict-id")).resolves.toMatchObject({
      incomingDeleted: false,
      current: { kind: "text", text: "local\ntext" },
      preserved: { kind: "text", text: "incoming\ntext" },
      comparison: {
        unavailableReason: null,
        lines: [
          { kind: "removed", text: "local" },
          { kind: "added", text: "incoming" },
          { kind: "context", text: "text" },
        ],
      },
    })

    await service.resolve("conflict-id", "use-incoming")

    expect(vault.text(SOURCE_PATH)).toBe("incoming\ntext")
    expect(vault.text(COPY_PATH)).toBeNull()
    const pending = await journal.listPending()
    expect(pending).toHaveLength(2)
    expect(pending[1]).toMatchObject({
      action: "upsert",
      fileId: "file-id",
      parentRevisionIds: ["local-pending", "remote"],
      restoreSourceRevisionId: "remote",
    })
    expect(await journal.listConflicts(true)).toEqual([])
  })

  it("recovers a local version preserved during an incoming deletion", async () => {
    const remote = revision({
      revisionId: "remote",
      action: "delete",
      parents: ["base"],
      createdAt: 2,
      cursor: 2,
      tombstone: true,
    })
    const { vault, journal, service } = await setup(remote, null, "local unsynced work")

    await service.resolve("conflict-id", "use-incoming")

    expect(vault.text(SOURCE_PATH)).toBe("local unsynced work")
    expect(vault.text(COPY_PATH)).toBeNull()
    expect(await journal.listPending()).toMatchObject([
      {
        action: "restore",
        fileId: "file-id",
        parentRevisionIds: ["remote"],
        restoreSourceRevisionId: "remote",
      },
    ])
  })

  it("queues a preserved copy before marking a keep-both conflict resolved", async () => {
    const remote = revision({ revisionId: "remote", parents: ["base"] })
    const { journal, service } = await setup(remote, "local", "incoming")

    await service.resolve("conflict-id", "keep-both")
    await service.resolve("conflict-id", "keep-both").catch((error) => {
      expect(error).toBeInstanceOf(Error)
    })

    expect(await journal.listPending()).toMatchObject([
      { action: "upsert", fileId: "copy-file-id", path: COPY_PATH, parentRevisionIds: [] },
    ])
    expect(await journal.listConflicts(true)).toEqual([])
  })

  it("does not replace an untracked file occupying the original path", async () => {
    const vault = new FakeVault({ [SOURCE_PATH]: "untracked", [COPY_PATH]: "incoming" })
    const journal = new MemoryJournal()
    await journal.putRevision(revision({ revisionId: "remote" }))
    await journal.putConflict(conflict())
    const service = new ConflictService(vault, journal)

    await expect(service.resolve("conflict-id", "use-incoming")).rejects.toThrow(/untracked/)
    expect(vault.text(SOURCE_PATH)).toBe("untracked")
    expect(vault.text(COPY_PATH)).toBe("incoming")
    expect(await journal.listPending()).toEqual([])
    expect(await journal.listConflicts(true)).toHaveLength(1)
  })

  it("does not remove a preserved copy that changes during resolution", async () => {
    class RacingVault extends FakeVault {
      override async replaceIfUnchanged(
        path: string,
        expectedBytes: ArrayBuffer | null,
        replacementBytes: ArrayBuffer | null,
        isText: boolean,
      ): Promise<boolean> {
        if (path === COPY_PATH) {
          await this.write(path, new TextEncoder().encode("edited during resolution").buffer)
        }
        return super.replaceIfUnchanged(path, expectedBytes, replacementBytes, isText)
      }
    }
    const vault = new RacingVault({ [SOURCE_PATH]: "local", [COPY_PATH]: "incoming" })
    const journal = new MemoryJournal()
    await journal.putRevision(revision({ revisionId: "remote" }))
    await journal.putConflict(conflict())
    const service = new ConflictService(vault, journal)

    await expect(service.resolve("conflict-id", "keep-current")).rejects.toThrow(/changed/)
    expect(vault.text(COPY_PATH)).toBe("edited during resolution")
    expect(await journal.listConflicts(true)).toHaveLength(1)
  })
})
