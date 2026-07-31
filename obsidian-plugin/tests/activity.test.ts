import { describe, expect, it } from "vitest"
import type { LocalRevision, RemoteDevice } from "../src/model"
import { revisionActivity } from "../src/sync/activity"
import { presentActivities } from "../src/ui/activity-presentation"

function revision(
  overrides: Partial<LocalRevision> & Pick<LocalRevision, "revisionId">,
): LocalRevision {
  const { revisionId, ...rest } = overrides
  return {
    revisionId,
    fileId: "file-1",
    path: "note.md",
    parents: ["parent"],
    deviceId: "device-local",
    createdAt: 1,
    cursor: 1,
    tombstone: false,
    isConflict: false,
    operation: null,
    ...rest,
  }
}

const devices: RemoteDevice[] = [
  {
    deviceId: "device-remote-long",
    signingPublicKey: "signing",
    hpkePublicKey: "hpke",
    certificate: "certificate",
    role: "member",
    authorizedAt: 1,
    revokedAt: null,
    deviceName: "iPhone",
    platform: "iOS",
  },
]

describe("synchronized activity", () => {
  it("classifies immutable revisions and orders them by committed cursor", () => {
    const entries = revisionActivity(
      [
        revision({ revisionId: "create", parents: [], cursor: 1 }),
        revision({
          revisionId: "rename",
          path: "renamed.md",
          action: "upsert",
          previousPath: "note.md",
          cursor: 3,
          deviceId: "device-remote-long",
        }),
        revision({ revisionId: "delete", action: "delete", tombstone: true, cursor: 2 }),
        revision({ revisionId: "restore", action: "restore", cursor: 4 }),
      ],
      "device-local",
    )

    expect(entries.map((entry) => [entry.revisionId, entry.kind, entry.local])).toEqual([
      ["restore", "restored", true],
      ["rename", "renamed", false],
      ["delete", "deleted", true],
      ["create", "created", true],
    ])
  })

  it("searches paths and friendly device names without exposing internal IDs", () => {
    const entries = revisionActivity(
      [
        revision({
          revisionId: "rename",
          path: "Archive/note.md",
          previousPath: "Inbox/note.md",
          deviceId: "device-remote-long",
        }),
      ],
      "device-local",
    )

    expect(presentActivities(entries, devices, "all", "iphone", 60_001)).toEqual([
      expect.objectContaining({
        title: "Renamed",
        path: "Inbox/note.md → Archive/note.md",
        source: "iPhone",
        time: "1 min ago",
      }),
    ])
    expect(presentActivities(entries, devices, "deleted", "", 60_001)).toEqual([])
  })

  it("rejects invalid activity query limits", () => {
    expect(() => revisionActivity([], "device", -1)).toThrow(/limit/)
  })
})
