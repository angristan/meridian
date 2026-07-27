import { assert, HttpError } from "../errors"
import { activeDevice, type SessionContext, vaultState } from "./domain"

export class VaultNotifications {
  constructor(
    private readonly state: DurableObjectState,
    private readonly sql: SqlStorage,
  ) {}

  notifyCursor(cursor: number, authorDeviceId: string): void {
    const message = JSON.stringify({ type: "cursor-advanced", cursor })
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as { deviceId?: unknown } | null
      if (attachment?.deviceId === authorDeviceId) continue
      try {
        socket.send(message)
      } catch {
        // A reconnect followed by HTTP reconciliation restores correctness.
      }
    }
  }

  closeRevokedDevice(deviceId: string): void {
    for (const socket of this.state.getWebSockets(`device:${deviceId}`)) {
      try {
        socket.close(4003, "Device revoked")
      } catch {
        // The session is already revoked durably.
      }
    }
  }

  closeForRecovery(): void {
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.close(4003, "Vault ownership recovered")
      } catch {
        // Durable revocation is already committed.
      }
    }
  }

  websocket(request: Request, session: SessionContext): Response {
    assert(
      request.headers.get("upgrade")?.toLowerCase() === "websocket",
      new HttpError(426, "upgrade_required", "WebSocket upgrade required"),
    )
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.state.acceptWebSocket(server, [`device:${session.deviceId}`])
    server.serializeAttachment({ deviceId: session.deviceId, vaultId: session.vaultId })
    const state = vaultState(this.sql)
    server.send(JSON.stringify({ type: "cursor-advanced", cursor: state?.cursor ?? 0 }))
    const headers = new Headers()
    if (request.headers.get("sec-websocket-protocol") === "meridian.v1") {
      headers.set("sec-websocket-protocol", "meridian.v1")
    }
    return new Response(null, { status: 101, headers, webSocket: client })
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string" || message !== "ping") {
      socket.close(1008, "Only the ping message is supported")
      return
    }
    const attachment = socket.deserializeAttachment() as { deviceId?: unknown } | null
    if (
      !attachment ||
      typeof attachment.deviceId !== "string" ||
      !activeDevice(this.sql, attachment.deviceId)
    ) {
      socket.close(4003, "Device revoked")
      return
    }
    socket.send("pong")
  }

  webSocketError(socket: WebSocket): void {
    try {
      socket.close(1011, "WebSocket error")
    } catch {
      // The platform may already have closed the socket.
    }
  }
}
