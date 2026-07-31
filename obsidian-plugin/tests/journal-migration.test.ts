import { describe, expect, it } from "vitest"
import { DATABASE_VERSION, migrateJournalRecords } from "../src/storage/journal"

describe("journal record migration", () => {
  it("uses an additive schema version for the isolated history cache", () => {
    expect(DATABASE_VERSION).toBe(4)
  })

  it("assigns one stable file identity across rename-linked legacy records", () => {
    const migrated = migrateJournalRecords(
      [
        {
          path: "renamed.md",
          fingerprint: "fingerprint",
          size: 1,
          mtime: 1,
          kind: "vault",
        },
      ],
      [
        {
          id: "entry",
          action: "upsert",
          path: "renamed.md",
          previousPath: "original.md",
          fingerprint: "fingerprint",
          baseRevisionId: "revision-original",
          revisionId: "revision-renamed",
          createdAt: 2,
          attempts: 0,
          state: "queued",
          error: null,
        },
      ],
      [
        {
          revisionId: "revision-original",
          path: "original.md",
          parents: [],
          deviceId: "device",
          createdAt: 1,
          cursor: 1,
          tombstone: false,
          isConflict: false,
        },
        {
          revisionId: "revision-renamed",
          path: "renamed.md",
          parents: ["revision-original"],
          deviceId: "device",
          createdAt: 2,
          cursor: 2,
          tombstone: false,
          isConflict: false,
        },
      ],
    )

    const ids = new Set([
      ...migrated.files.map((record) => record.fileId),
      ...migrated.entries.map((record) => record.fileId),
      ...migrated.revisions.map((record) => record.fileId),
    ])
    expect(ids.size).toBe(1)
    expect([...ids][0]).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(migrated.entries[0]).toMatchObject({
      parentRevisionIds: ["revision-original"],
      restoreSourceRevisionId: null,
      preparedRevision: null,
    })
    expect(migrated.revisions).toEqual([
      expect.objectContaining({
        revisionId: "revision-original",
        action: "upsert",
        previousPath: null,
        operation: null,
      }),
      expect.objectContaining({
        revisionId: "revision-renamed",
        action: "upsert",
        previousPath: null,
        operation: null,
      }),
    ])
  })
})
