import * as Effect from "effect/Effect"
import { HttpError } from "../errors"
import { runHttpEffect } from "./effect-boundary"
import { extractSessionToken } from "./session"
import type { WorkerApp } from "./types"
import { callVaultWebSocketEffect } from "./vault-proxy"

export function registerWebSocketRoutes(app: WorkerApp): void {
  app.get("/v1/notifications", (c) =>
    runHttpEffect(
      Effect.gen(function* () {
        if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
          return yield* Effect.fail(
            new HttpError(426, "upgrade_required", "WebSocket upgrade required"),
          )
        }
        return yield* callVaultWebSocketEffect(c.env, extractSessionToken(c.req.raw), c.req.raw)
      }),
    ),
  )
}
