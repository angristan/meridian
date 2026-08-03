import * as Effect from "effect/Effect"
import { HttpError } from "../errors"
import { runHttpEffect } from "./effect-boundary"
import { authenticatedVaultEffect } from "./session"
import type { WorkerApp } from "./types"

export function registerWebSocketRoutes(app: WorkerApp): void {
  app.get("/v1/notifications", (c) =>
    runHttpEffect(
      Effect.gen(function* () {
        if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
          return yield* Effect.fail(
            new HttpError(426, "upgrade_required", "WebSocket upgrade required"),
          )
        }
        return yield* authenticatedVaultEffect(c, "/v1/notifications", "GET", c.req.raw)
      }),
    ),
  )
}
