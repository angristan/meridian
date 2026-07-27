import { describe, expect, it } from "vitest"
import { VaultNotifications } from "../src/vault/notifications"

class FakeSocket {
  readonly sent: string[] = []

  constructor(private readonly deviceId: string | null) {}

  deserializeAttachment(): { deviceId: string } | null {
    return this.deviceId ? { deviceId: this.deviceId } : null
  }

  send(message: string): void {
    this.sent.push(message)
  }
}

describe("VaultNotifications", () => {
  it("broadcasts cursor hints to peers but not the operation author", () => {
    const author = new FakeSocket("author-device")
    const peer = new FakeSocket("peer-device")
    const untagged = new FakeSocket(null)
    const state = {
      getWebSockets: () => [author, peer, untagged],
    } as unknown as DurableObjectState
    const notifications = new VaultNotifications(state, {} as SqlStorage)

    notifications.notifyCursor(7, "author-device")

    expect(author.sent).toEqual([])
    expect(peer.sent).toEqual(['{"type":"cursor-advanced","cursor":7}'])
    expect(untagged.sent).toEqual(['{"type":"cursor-advanced","cursor":7}'])
  })
})
