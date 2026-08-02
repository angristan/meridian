import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { connectCursorNotifications } from "../src/network/notifications"

class FakeWebSocket {
  static readonly instances: FakeWebSocket[] = []
  private readonly listeners = new Map<string, Array<(event: Event | MessageEvent) => void>>()

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: Event | MessageEvent) => void): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  close(): void {
    this.emit("close", new Event("close"))
  }

  emit(type: string, event: Event | MessageEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0
  vi.stubGlobal("navigator", { onLine: true })
  vi.stubGlobal("WebSocket", FakeWebSocket)
})

afterEach(() => vi.unstubAllGlobals())

describe("cursor notifications", () => {
  it("connects once and leaves reconnect timing to the scheduler", async () => {
    const states: boolean[] = []
    const stop = connectCursorNotifications(
      "https://sync.example",
      async () => "token",
      7,
      () => {},
      (connected) => states.push(connected),
    )
    await Promise.resolve()

    const socket = FakeWebSocket.instances[0]
    expect(String(socket?.url)).toBe("wss://sync.example/v1/notifications?after=7")
    socket?.emit("open", new Event("open"))
    socket?.emit("close", new Event("close"))
    await Promise.resolve()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(states).toEqual([true, false])
    stop()
  })

  it("ignores late token completion after cancellation", async () => {
    let resolveToken: ((token: string) => void) | undefined
    const token = new Promise<string>((resolve) => {
      resolveToken = resolve
    })
    const states: boolean[] = []
    const stop = connectCursorNotifications(
      "https://sync.example",
      async () => token,
      0,
      () => {},
      (connected) => states.push(connected),
    )

    stop()
    resolveToken?.("token")
    await Promise.resolve()
    expect(FakeWebSocket.instances).toEqual([])
    expect(states).toEqual([false])
  })

  it("accepts only valid cursor hints", async () => {
    const cursors: number[] = []
    connectCursorNotifications(
      "https://sync.example",
      async () => "token",
      0,
      (cursor) => cursors.push(cursor),
      () => {},
    )
    await Promise.resolve()
    const socket = FakeWebSocket.instances[0]
    socket?.emit(
      "message",
      new MessageEvent("message", { data: JSON.stringify({ type: "cursor-advanced", cursor: 9 }) }),
    )
    socket?.emit("message", new MessageEvent("message", { data: "invalid" }))
    expect(cursors).toEqual([9])
  })
})
