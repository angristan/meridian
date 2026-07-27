import { isRecord, optionalNumber } from "./response-parsers"

export function connectCursorNotifications(
  endpoint: string,
  sessionToken: () => Promise<string>,
  after: number,
  onCursor: (cursor: number) => void,
  onState: (connected: boolean) => void,
): () => void {
  let stopped = false
  let socket: WebSocket | null = null
  let retryTimer: number | null = null
  let retry = 0

  const scheduleReconnect = () => {
    if (stopped) return
    retry += 1
    retryTimer = window.setTimeout(() => void connect(), Math.min(30_000, 1_000 * 2 ** retry))
  }

  const connect = async () => {
    if (stopped || navigator.onLine === false) return
    let token: string
    try {
      token = await sessionToken()
    } catch {
      onState(false)
      scheduleReconnect()
      return
    }
    if (stopped) return

    const url = new URL(`${endpoint}/v1/notifications`)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    url.searchParams.set("after", String(after))
    socket = new WebSocket(url, ["meridian.v1", `bearer.${token}`])
    socket.addEventListener("open", () => {
      retry = 0
      onState(true)
    })
    socket.addEventListener("message", (event) => {
      try {
        const message: unknown = JSON.parse(String(event.data))
        if (isRecord(message) && message.type === "cursor-advanced") {
          const cursor = optionalNumber(message.cursor)
          if (cursor !== null) onCursor(cursor)
        }
      } catch {
        // Notifications are hints. Invalid hints are ignored and polling remains authoritative.
      }
    })
    socket.addEventListener("close", () => {
      onState(false)
      socket = null
      scheduleReconnect()
    })
    socket.addEventListener("error", () => socket?.close())
  }

  void connect()
  return () => {
    stopped = true
    if (retryTimer !== null) window.clearTimeout(retryTimer)
    socket?.close()
    onState(false)
  }
}
