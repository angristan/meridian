import { describe, expect, it } from "vitest"
import { fingerprint, randomId } from "../src/platform/bytes"
import { MemoryJournal } from "../src/storage/journal"
import { SyncController } from "../src/sync/controller"
import { ALL_CATEGORIES, FakeCrypto, FakeRemote, FakeVault, TEST_DEVICE } from "./fakes"

describe("SyncController", () => {
  it("uploads local content as raw encrypted blobs before committing", async () => {
    const vault = new FakeVault({ "note.md": "hello" })
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    const statuses: string[] = []
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      (status) => statuses.push(status.phase),
    )

    await controller.start(TEST_DEVICE)

    expect(remote.authenticateCount).toBe(1)
    expect(remote.operations).toHaveLength(1)
    expect([...remote.blobs.values()].map((bytes) => new TextDecoder().decode(bytes))).toEqual([
      "hello",
    ])
    expect(await journal.listPending()).toEqual([])
    expect((await journal.listRevisions("note.md"))[0]).toMatchObject({
      path: "note.md",
      tombstone: false,
      cursor: 1,
    })
    expect(statuses.at(-1)).toBe("idle")
    controller.stop()
  })

  it("rejects a server older than the signed pairing checkpoint", async () => {
    const vault = new FakeVault()
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    remote.addRemoteRevision(
      {
        operationId: "remote-operation",
        revisionId: "remote-revision",
        fileId: randomId(),
        action: "upsert",
        path: "remote.md",
        previousPath: null,
        parents: [],
        authorDeviceId: "device-remote",
        blobId: "remote-blob",
        isText: true,
      },
      new TextEncoder().encode("untrusted rollback").buffer,
    )
    const statuses: Array<{ phase: string; error: string | null }> = []
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      (status) => statuses.push(status),
    )

    await controller.start({
      ...TEST_DEVICE,
      trustedCheckpoint: { cursor: 2, logHash: "trusted-hash-2" },
    })

    expect(vault.text("remote.md")).toBeNull()
    expect(statuses.at(-1)).toMatchObject({
      phase: "error",
      error: "Server attempted to roll back the signed checkpoint",
    })
    controller.stop()
  })

  it("merges disjoint concurrent text edits and queues the merged revision", async () => {
    const encoder = new TextEncoder()
    const baseBytes = encoder.encode("one\ntwo\n").buffer
    const remoteBytes = encoder.encode("one\nTWO\n").buffer
    const identity = randomId()
    const vault = new FakeVault({ "note.md": "ONE\ntwo\n" })
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
    const remote = new FakeRemote()
    remote.blobs.set("base-blob", baseBytes)
    await journal.putRevision({
      revisionId: "common-base",
      fileId: identity,
      path: "note.md",
      parents: [],
      deviceId: TEST_DEVICE.deviceId,
      createdAt: 1,
      cursor: 0,
      tombstone: false,
      isConflict: false,
      operation: {
        cursor: 0,
        logHash: "hash-base",
        envelope: {
          operationId: "base-operation",
          revisionId: "common-base",
          fileId: identity,
          action: "upsert",
          path: "note.md",
          previousPath: null,
          parents: [],
          authorDeviceId: TEST_DEVICE.deviceId,
          blobId: "base-blob",
          isText: true,
        },
      },
    })
    remote.addRemoteRevision(
      {
        operationId: "remote-operation",
        revisionId: "revision-remote",
        fileId: identity,
        action: "upsert",
        path: "note.md",
        previousPath: null,
        parents: ["common-base"],
        authorDeviceId: "device-remote",
        blobId: "remote-blob",
        isText: true,
      },
      remoteBytes,
    )
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    await controller.start(TEST_DEVICE)

    expect(vault.text("note.md")).toBe("ONE\nTWO\n")
    expect(await journal.listConflicts(true)).toEqual([])
    expect(await journal.listPending()).toEqual([])
    expect(remote.operations.at(-1)?.envelope).toMatchObject({
      fileId: identity,
      parents: ["revision-remote"],
    })
    controller.stop()
  })

  it("restores retained history as a new revision", async () => {
    const encoder = new TextEncoder()
    const oldBytes = encoder.encode("old content").buffer
    const currentBytes = encoder.encode("current content").buffer
    const identity = randomId()
    const vault = new FakeVault({ "note.md": "current content" })
    const journal = new MemoryJournal()
    await journal.replaceSnapshots([
      {
        path: "note.md",
        fileId: identity,
        fingerprint: await fingerprint(currentBytes),
        size: currentBytes.byteLength,
        mtime: 2,
        kind: "vault",
      },
    ])
    const remote = new FakeRemote()
    remote.blobs.set("old-blob", oldBytes)
    await journal.putRevision({
      revisionId: "revision-old",
      fileId: identity,
      path: "note.md",
      parents: [],
      deviceId: TEST_DEVICE.deviceId,
      createdAt: 1,
      cursor: 1,
      tombstone: false,
      isConflict: false,
      operation: {
        cursor: 1,
        logHash: "hash-old",
        envelope: {
          operationId: "operation-old",
          revisionId: "revision-old",
          fileId: identity,
          action: "upsert",
          path: "note.md",
          previousPath: null,
          parents: [],
          authorDeviceId: TEST_DEVICE.deviceId,
          blobId: "old-blob",
          isText: true,
        },
      },
    })
    await journal.putRevision({
      revisionId: "revision-current",
      fileId: identity,
      path: "note.md",
      parents: ["revision-old"],
      deviceId: TEST_DEVICE.deviceId,
      createdAt: 2,
      cursor: 2,
      tombstone: false,
      isConflict: false,
      operation: null,
    })
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )
    await controller.start(TEST_DEVICE)

    await controller.restoreRevision("revision-old")
    expect(vault.text("note.md")).toBe("old content")
    expect(await journal.listPending()).toEqual([
      expect.objectContaining({
        action: "restore",
        fileId: identity,
        parentRevisionIds: ["revision-current", "revision-old"],
        restoreSourceRevisionId: "revision-old",
      }),
    ])

    await controller.sync("manual")
    expect(await journal.listPending()).toEqual([])
    expect(remote.operations.at(-1)?.envelope).toMatchObject({
      action: "restore",
      fileId: identity,
      parents: ["revision-current", "revision-old"],
    })
    controller.stop()
  })

  it("preserves concurrent remote content as an explicit conflict copy", async () => {
    const localBytes = new TextEncoder().encode("local edit").buffer
    const remoteBytes = new TextEncoder().encode("remote edit").buffer
    const vault = new FakeVault({ "note.md": "local edit" })
    const journal = new MemoryJournal()
    await journal.replaceSnapshots([
      {
        path: "note.md",
        fileId: randomId(),
        fingerprint: await fingerprint(new TextEncoder().encode("common base").buffer),
        size: 11,
        mtime: 1,
        kind: "vault",
      },
    ])
    const remote = new FakeRemote()
    remote.addRemoteRevision(
      {
        operationId: "remote-operation",
        revisionId: "revision-remote",
        action: "upsert",
        path: "note.md",
        previousPath: null,
        parents: ["common-base"],
        authorDeviceId: "device-remote",
        blobId: "remote-blob",
        isText: true,
      },
      remoteBytes,
    )
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )

    await controller.start(TEST_DEVICE)

    expect(vault.text("note.md")).toBe(new TextDecoder().decode(localBytes))
    const conflicts = await journal.listConflicts(true)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.sourcePath).toBe("note.md")
    expect(conflicts[0]?.conflictPath).toContain(".conflict-")
    expect(vault.text(conflicts[0]?.conflictPath ?? "")).toBe("remote edit")
    expect((await journal.listRevisions("note.md")).some((revision) => revision.isConflict)).toBe(
      true,
    )
    controller.stop()
  })

  it("persists revocations and rejects later operations from revoked devices", async () => {
    const vault = new FakeVault()
    const journal = new MemoryJournal()
    const remote = new FakeRemote()
    const controller = new SyncController(
      vault,
      journal,
      remote,
      new FakeCrypto(),
      () => ALL_CATEGORIES,
      () => {},
    )
    await controller.start(TEST_DEVICE)

    await controller.revokeDevice({
      deviceId: "old-device",
      signingPublicKey: "signing-key",
      hpkePublicKey: "hpke-key",
      certificate: "certificate",
      role: "member",
      authorizedAt: 1,
      revokedAt: null,
      deviceName: "Old phone",
      platform: "iOS",
    })
    await expect(journal.getDeviceRevocation("old-device")).resolves.toEqual({
      deviceId: "old-device",
      operationId: "revocation-operation",
      cursor: 1,
    })

    await remote.commit({
      operationId: "late-operation",
      revisionId: "late-revision",
      action: "delete",
      path: "late.md",
      previousPath: null,
      parents: [],
      authorDeviceId: "old-device",
      blobId: null,
      isText: true,
    })
    await controller.sync("manual")

    expect(controller.getStatus().error).toMatch(/authored after its device was revoked/)
    await expect(journal.getCursor()).resolves.toBe(1)
    controller.stop()
  })
})
