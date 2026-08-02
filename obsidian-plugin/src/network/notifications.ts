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

  const connect = async () => {
    if (stopped || navigator.onLine === false) return
    let token: string
    try {
      token = await sessionToken()
    } catch {
      if (!stopped) onState(false)
      return
    }
    if (stopped) return

    const url = new URL(`${endpoint}/v1/notifications`)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    url.searchParams.set("after", String(after))
    socket = new WebSocket(url, ["meridian.v1", `bearer.${token}`])
    socket.addEventListener("open", () => onState(true))
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
      socket = null
      if (!stopped) onState(false)
    })
    socket.addEventListener("error", () => socket?.close())
  }

  void connect()
  return () => {
    stopped = true
    socket?.close()
    onState(false)
  }
}
