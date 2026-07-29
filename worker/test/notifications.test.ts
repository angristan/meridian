import { describe, expect, it, vi } from "vitest"
import { VaultNotifications } from "../src/vault/notifications"
import { VaultDurableObject } from "../src/vault-do"

class FakeSocket {
  readonly sent: string[] = []
  readonly closed: Array<{ code: number; reason: string }> = []

  constructor(private readonly attachment: { deviceId: string; expiresAt: number } | null) {}

  deserializeAttachment(): { deviceId: string; expiresAt: number } | null {
    return this.attachment
  }

  send(message: string): void {
    this.sent.push(message)
  }

  close(code: number, reason: string): void {
    this.closed.push({ code, reason })
  }
}

function sqlWithActiveDevices(...deviceIds: string[]): SqlStorage {
  const active = new Set(deviceIds)
  return {
    exec: (_query: string, deviceId: string) => ({
      toArray: () => (active.has(deviceId) ? [{ device_id: deviceId }] : []),
    }),
  } as unknown as SqlStorage
}

describe("VaultDurableObject WebSockets", () => {
  it("does not echo reserved abnormal close codes", async () => {
    const close = vi.fn()

    await VaultDurableObject.prototype.webSocketClose.call(
      {} as VaultDurableObject,
      { close } as unknown as WebSocket,
      1006,
      "",
      false,
    )

    expect(close).not.toHaveBeenCalled()
  })
})

describe("VaultNotifications", () => {
  it("broadcasts cursor hints only to authorized peers", () => {
    const expiresAt = Date.now() + 60_000
    const author = new FakeSocket({ deviceId: "author-device", expiresAt })
    const peer = new FakeSocket({ deviceId: "peer-device", expiresAt })
    const untagged = new FakeSocket(null)
    const state = {
      getWebSockets: () => [author, peer, untagged],
    } as unknown as DurableObjectState
    const notifications = new VaultNotifications(
      state,
      sqlWithActiveDevices("author-device", "peer-device"),
    )

    notifications.notifyCursor(7, "author-device")

    expect(author.sent).toEqual([])
    expect(peer.sent).toEqual(['{"type":"cursor-advanced","cursor":7}'])
    expect(untagged.sent).toEqual([])
    expect(untagged.closed).toEqual([{ code: 4003, reason: "Session expired or device revoked" }])
  })

  it("closes expired and revoked sockets before sending", () => {
    const expired = new FakeSocket({ deviceId: "active-device", expiresAt: Date.now() - 1 })
    const revoked = new FakeSocket({
      deviceId: "revoked-device",
      expiresAt: Date.now() + 60_000,
    })
    const state = {
      getWebSockets: () => [expired, revoked],
    } as unknown as DurableObjectState
    const notifications = new VaultNotifications(state, sqlWithActiveDevices("active-device"))

    notifications.notifyCursor(8, "another-device")

    expect(expired.sent).toEqual([])
    expect(revoked.sent).toEqual([])
    expect(expired.closed).toHaveLength(1)
    expect(revoked.closed).toHaveLength(1)
  })
})
